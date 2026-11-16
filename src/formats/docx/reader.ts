import JSZip from 'jszip';
import type { DocMeta, LoadedDoc } from '../../types';
import {
  type JMark,
  type JNode,
  attr,
  bytesToDataUrl,
  defaultSettings,
  descendant,
  descendants,
  docNode,
  isBrowserImage,
  kid,
  kids,
  localName,
  mimeFromExt,
  normColor,
  paragraph,
  parseXml,
  placeholderImage,
  normCrop,
  round,
  textNode,
  twipToMm,
  assertZipBudget,
  readZipEntry,
} from '../common';
import { assembleTable } from '../hwp/reader';

/** DOCX(Office Open XML) 읽기 */

interface RProps {
  font?: string;
  size?: number;
  color?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sup?: boolean;
  sub?: boolean;
  highlight?: string | null;
  spacingTw?: number;
  width?: number;
  effect?: string | null;
  hidden?: boolean;
}

interface PProps {
  align?: string | null;
  left?: number; // twips
  right?: number;
  firstLine?: number;
  hanging?: number;
  before?: number;
  after?: number;
  line?: number;
  lineRule?: string;
  bg?: string | null;
  pageBreakBefore?: boolean;
  numId?: string;
  ilvl?: number;
  outlineLvl?: number;
}

interface StyleDef {
  type: string;
  name: string;
  basedOn?: string;
  pPr?: Element | null;
  rPr?: Element | null;
  tblPr?: Element | null;
}

const HIGHLIGHT: Record<string, string> = {
  yellow: '#FFFF00',
  green: '#00FF00',
  cyan: '#00FFFF',
  magenta: '#FF00FF',
  blue: '#0000FF',
  red: '#FF0000',
  darkBlue: '#000080',
  darkCyan: '#008080',
  darkGreen: '#008000',
  darkMagenta: '#800080',
  darkRed: '#800000',
  darkYellow: '#808000',
  darkGray: '#808080',
  lightGray: '#C0C0C0',
  black: '#000000',
  white: '#FFFFFF',
};

const onOff = (el: Element | null): boolean | undefined => {
  if (!el) return undefined;
  const v = attr(el, 'val');
  return !(v === '0' || v === 'false' || v === 'off' || v === 'none');
};

const twipToPt = (v: number) => v / 20;

const SYMBOL_MAP: Record<number, string> = {
  0xf0b7: '•',
  0xf0a7: '▪',
  0xf06f: 'o',
  0xf0d8: '➢',
  0xf0fc: '✓',
  0xf076: '❖',
  0xf0a8: '◆',
  0xf0e0: '→',
  0xf0e8: '➔',
  0xf06e: '■',
  0xf071: '❑',
  0xf0b2: '◊',
};

class DocxReader {
  rels = new Map<string, { target: string; type: string; external: boolean }>();
  styles = new Map<string, StyleDef>();
  defaultPStyle: string | null = null;
  docDefaultsR: Element | null = null;
  docDefaultsP: Element | null = null;
  numbering = new Map<string, { abs: string; overrides: Map<number, number> }>();
  abstractNums = new Map<string, { fmt: string; text: string; start: number }[]>();
  footnotes = new Map<string, string>();
  endnotes = new Map<string, string>();
  theme = { minorLatin: '', minorEa: '', majorLatin: '', majorEa: '' };
  images = new Map<string, string>();
  warnings: string[] = [];
  settings = defaultSettings();
  // 필드 상태
  private fieldInstr: string | null = null;
  private fieldStage: 'none' | 'instr' | 'result' = 'none';
  private fieldLink: string | null = null;
  private fieldIsPage: 0 | 1 | 2 = 0;
  private headerMode = false;
  listCounters = new Map<string, number>();
  /** 지금 읽는 변경 내용 (w:ins / w:del 안) */
  private review: JMark[] = [];
  /** 지금 열려 있는 메모 범위 */
  private activeComments = new Set<string>();

  constructor(private zip: JSZip) {}

  async text(path: string): Promise<string | null> {
    const f = this.zip.file(path);
    return f ? readZipEntry(f, 'string') : null;
  }

  async loadRels(path: string): Promise<Map<string, { target: string; type: string; external: boolean }>> {
    const map = new Map();
    const xml = await this.text(path);
    if (!xml) return map;
    for (const r of descendants(parseXml(xml), 'Relationship')) {
      map.set(attr(r, 'Id') || '', {
        target: attr(r, 'Target') || '',
        type: (attr(r, 'Type') || '').split('/').pop() || '',
        external: attr(r, 'TargetMode') === 'External',
      });
    }
    return map;
  }

  async init() {
    this.rels = await this.loadRels('word/_rels/document.xml.rels');
    const themeXml = await this.text('word/theme/theme1.xml');
    if (themeXml) {
      const th = parseXml(themeXml);
      const pick = (tag: string) => {
        const f = descendant(th, tag);
        const latin = attr(kid(f, 'latin'), 'typeface') || '';
        const hang = kids(f, 'font').find((x) => attr(x, 'script') === 'Hang');
        const ea = (hang && attr(hang, 'typeface')) || attr(kid(f, 'ea'), 'typeface') || '';
        return { latin, ea };
      };
      const mi = pick('minorFont');
      const ma = pick('majorFont');
      this.theme = { minorLatin: mi.latin, minorEa: mi.ea, majorLatin: ma.latin, majorEa: ma.ea };
    }
    const stylesXml = await this.text('word/styles.xml');
    if (stylesXml) {
      const sd = parseXml(stylesXml);
      const dd = descendant(sd, 'docDefaults');
      this.docDefaultsR = descendant(kid(dd, 'rPrDefault'), 'rPr');
      this.docDefaultsP = descendant(kid(dd, 'pPrDefault'), 'pPr');
      for (const s of descendants(sd, 'style')) {
        const id = attr(s, 'styleId') || '';
        this.styles.set(id, {
          type: attr(s, 'type') || '',
          name: (attr(kid(s, 'name'), 'val') || '').toLowerCase(),
          basedOn: attr(kid(s, 'basedOn'), 'val') || undefined,
          pPr: kid(s, 'pPr'),
          rPr: kid(s, 'rPr'),
          tblPr: kid(s, 'tblPr'),
        });
        if (attr(s, 'type') === 'paragraph' && attr(s, 'default') === '1') this.defaultPStyle = id;
      }
    }
    const numXml = await this.text('word/numbering.xml');
    if (numXml) {
      const nd = parseXml(numXml);
      for (const an of descendants(nd, 'abstractNum')) {
        const levels: { fmt: string; text: string; start: number }[] = [];
        for (const lvl of kids(an, 'lvl')) {
          const i = parseInt(attr(lvl, 'ilvl') || '0', 10);
          levels[i] = {
            fmt: attr(kid(lvl, 'numFmt'), 'val') || 'decimal',
            text: attr(kid(lvl, 'lvlText'), 'val') || '',
            start: parseInt(attr(kid(lvl, 'start'), 'val') || '1', 10),
          };
        }
        this.abstractNums.set(attr(an, 'abstractNumId') || '', levels);
      }
      for (const n of descendants(nd, 'num')) {
        const overrides = new Map<number, number>();
        for (const o of kids(n, 'lvlOverride')) {
          const so = kid(o, 'startOverride');
          if (so) overrides.set(parseInt(attr(o, 'ilvl') || '0', 10), parseInt(attr(so, 'val') || '1', 10));
        }
        this.numbering.set(attr(n, 'numId') || '', { abs: attr(kid(n, 'abstractNumId'), 'val') || '', overrides });
      }
    }
    // 메모
    const commentsXml = await this.text('word/comments.xml');
    if (commentsXml) {
      const store: NonNullable<typeof this.settings.comments> = {};
      for (const c of descendants(parseXml(commentsXml), 'comment')) {
        const id = attr(c, 'id');
        if (id == null) continue;
        const text = descendants(c, 'p')
          .map((p) =>
            descendants(p, 't')
              .map((t) => t.textContent || '')
              .join(''),
          )
          .join('\n')
          .trim();
        const time = Date.parse(attr(c, 'date') || '') || 0;
        store['w' + id] = { author: attr(c, 'author') || '', time, text, replies: [] };
      }
      if (Object.keys(store).length) this.settings.comments = store;
    }
    for (const [file, map] of [
      ['word/footnotes.xml', this.footnotes],
      ['word/endnotes.xml', this.endnotes],
    ] as const) {
      const xml = await this.text(file);
      if (!xml) continue;
      for (const fn of descendants(parseXml(xml), file.includes('foot') ? 'footnote' : 'endnote')) {
        const id = attr(fn, 'id') || '';
        const type = attr(fn, 'type');
        if (type === 'separator' || type === 'continuationSeparator') continue;
        const text = descendants(fn, 'p')
          .map((p) =>
            descendants(p, 't')
              .map((t) => t.textContent || '')
              .join(''),
          )
          .join(' ')
          .trim();
        map.set(id, text);
      }
    }
    // 그림
    for (const [id, r] of this.rels) {
      if (r.type !== 'image' || r.external) continue;
      const path = normalizePath('word/' + r.target);
      const f = this.zip.file(path);
      if (!f) continue;
      const ext = path.split('.').pop() || '';
      const mime = mimeFromExt(ext);
      this.images.set(id, isBrowserImage(mime) ? bytesToDataUrl(await readZipEntry(f, 'uint8array'), mime) : placeholderImage(`그림(${ext.toUpperCase()})`));
    }
  }

  // ----- 스타일 해석 -----
  private styleChain(id: string | null | undefined): StyleDef[] {
    const chain: StyleDef[] = [];
    let cur = id ? this.styles.get(id) : undefined;
    let guard = 0;
    while (cur && guard++ < 20) {
      chain.unshift(cur);
      cur = cur.basedOn ? this.styles.get(cur.basedOn) : undefined;
    }
    return chain;
  }

  private themeFont(name: string | null): string | undefined {
    if (!name) return undefined;
    if (name.startsWith('minorEastAsia')) return this.theme.minorEa || this.theme.minorLatin;
    if (name.startsWith('majorEastAsia')) return this.theme.majorEa || this.theme.majorLatin;
    if (name.startsWith('minor')) return this.theme.minorLatin;
    if (name.startsWith('major')) return this.theme.majorLatin;
    return undefined;
  }

  applyR(p: RProps, rPr: Element | null | undefined) {
    if (!rPr) return;
    for (const c of kids(rPr)) {
      switch (localName(c)) {
        case 'rFonts': {
          const ea = attr(c, 'eastAsia') || this.themeFont(attr(c, 'eastAsiaTheme'));
          const ascii = attr(c, 'ascii') || attr(c, 'hAnsi') || this.themeFont(attr(c, 'asciiTheme') || attr(c, 'hAnsiTheme'));
          if (ea || ascii) p.font = ea || ascii;
          break;
        }
        case 'b':
          p.bold = onOff(c);
          break;
        case 'i':
          p.italic = onOff(c);
          break;
        case 'u': {
          const v = attr(c, 'val');
          p.underline = !!v && v !== 'none';
          break;
        }
        case 'strike':
        case 'dstrike':
          p.strike = onOff(c);
          break;
        case 'color':
          p.color = normColor(attr(c, 'val'));
          break;
        case 'sz':
          p.size = parseFloat(attr(c, 'val') || '20') / 2;
          break;
        case 'highlight':
          p.highlight = HIGHLIGHT[attr(c, 'val') || ''] || null;
          break;
        case 'shd': {
          const f = normColor(attr(c, 'fill'));
          if (f && f !== '#FFFFFF') p.highlight = f;
          break;
        }
        case 'vertAlign': {
          const v = attr(c, 'val');
          p.sup = v === 'superscript';
          p.sub = v === 'subscript';
          break;
        }
        case 'spacing':
          p.spacingTw = parseFloat(attr(c, 'val') || '0');
          break;
        case 'w':
          p.width = parseFloat(attr(c, 'val') || '100');
          break;
        case 'outline':
          if (onOff(c)) p.effect = 'outline';
          break;
        case 'shadow':
          if (onOff(c)) p.effect = 'shadow';
          break;
        case 'emboss':
          if (onOff(c)) p.effect = 'emboss';
          break;
        case 'imprint':
          if (onOff(c)) p.effect = 'engrave';
          break;
        case 'vanish':
          p.hidden = onOff(c);
          break;
      }
    }
  }

  applyP(p: PProps, pPr: Element | null | undefined) {
    if (!pPr) return;
    for (const c of kids(pPr)) {
      switch (localName(c)) {
        case 'jc': {
          const v = attr(c, 'val') || '';
          p.align =
            v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'right' : v === 'both' ? 'justify' : v === 'distribute' ? 'distribute' : 'left';
          break;
        }
        case 'ind': {
          const n = (k: string) => {
            const v = attr(c, k);
            return v != null ? parseFloat(v) : undefined;
          };
          const l = n('left') ?? n('start');
          const r = n('right') ?? n('end');
          if (l !== undefined) p.left = l;
          if (r !== undefined) p.right = r;
          const fl = n('firstLine');
          const hg = n('hanging');
          if (fl !== undefined) {
            p.firstLine = fl;
            p.hanging = 0;
          }
          if (hg !== undefined) {
            p.hanging = hg;
            p.firstLine = 0;
          }
          break;
        }
        case 'spacing': {
          const b = attr(c, 'before');
          const a = attr(c, 'after');
          const l = attr(c, 'line');
          if (b != null && attr(c, 'beforeAutospacing') !== '1') p.before = parseFloat(b);
          if (a != null && attr(c, 'afterAutospacing') !== '1') p.after = parseFloat(a);
          if (l != null) {
            p.line = parseFloat(l);
            p.lineRule = attr(c, 'lineRule') || 'auto';
          }
          break;
        }
        case 'shd': {
          const f = normColor(attr(c, 'fill'));
          p.bg = f && f !== '#FFFFFF' ? f : null;
          break;
        }
        case 'pageBreakBefore':
          p.pageBreakBefore = onOff(c);
          break;
        case 'numPr': {
          const id = attr(kid(c, 'numId'), 'val');
          if (id != null) p.numId = id;
          const il = attr(kid(c, 'ilvl'), 'val');
          if (il != null) p.ilvl = parseInt(il, 10);
          break;
        }
        case 'outlineLvl':
          p.outlineLvl = parseInt(attr(c, 'val') || '9', 10);
          break;
      }
    }
  }

  resolveP(pPr: Element | null): { p: PProps; r: RProps; styleId: string | null; heading: number } {
    const styleId = attr(kid(pPr, 'pStyle'), 'val') || this.defaultPStyle;
    const p: PProps = {};
    const r: RProps = {};
    this.applyP(p, this.docDefaultsP);
    this.applyR(r, this.docDefaultsR);
    let heading = 0;
    for (const s of this.styleChain(styleId)) {
      this.applyP(p, s.pPr);
      this.applyR(r, s.rPr);
      const m = /^(heading|제목)\s*(\d)$/.exec(s.name);
      if (m) heading = parseInt(m[2], 10);
      else if (s.name === 'title') heading = 1;
    }
    this.applyP(p, pPr);
    if (!heading && p.outlineLvl !== undefined && p.outlineLvl < 6 && styleId && styleId !== this.defaultPStyle) heading = p.outlineLvl + 1;
    return { p, r, styleId, heading: Math.min(heading, 6) };
  }

  marksFrom(r: RProps, link: string | null): JMark[] {
    const marks: JMark[] = [];
    const ts: Record<string, any> = {};
    if (r.font) ts.fontFamily = r.font;
    if (r.size) ts.fontSize = r.size;
    if (r.color && r.color !== '#000000') ts.color = r.color;
    if (r.spacingTw && r.size) ts.letterSpacing = Math.round((twipToPt(r.spacingTw) / r.size) * 100) || null;
    if (r.width && r.width !== 100) ts.fontWidth = r.width;
    if (r.effect) ts.textEffect = r.effect;
    for (const k of Object.keys(ts)) if (ts[k] == null) delete ts[k];
    if (Object.keys(ts).length) marks.push({ type: 'textStyle', attrs: ts });
    if (r.bold) marks.push({ type: 'bold' });
    if (r.italic) marks.push({ type: 'italic' });
    if (r.underline && !link) marks.push({ type: 'underline' });
    if (r.strike) marks.push({ type: 'strike' });
    if (r.sup) marks.push({ type: 'superscript' });
    else if (r.sub) marks.push({ type: 'subscript' });
    if (r.highlight) marks.push({ type: 'highlight', attrs: { color: r.highlight } });
    if (link) marks.push({ type: 'link', attrs: { href: link } });
    return marks;
  }

  paraAttrs(p: PProps, baseSize?: number): Record<string, any> {
    const a: Record<string, any> = {};
    if (p.align && p.align !== 'justify') a.textAlign = p.align === 'left' ? 'left' : p.align;
    const left = p.left || 0;
    const hanging = p.hanging || 0;
    const first = p.firstLine || 0;
    if (hanging) {
      a.indentLeft = round(twipToPt(left - hanging)) || null;
      a.textIndent = -round(twipToPt(hanging));
    } else {
      if (left) a.indentLeft = round(twipToPt(left));
      if (first) a.textIndent = round(twipToPt(first));
    }
    if (a.indentLeft !== undefined && a.indentLeft <= 0) delete a.indentLeft;
    if (p.right) a.indentRight = round(twipToPt(p.right));
    if (p.before) a.spaceBefore = round(twipToPt(p.before));
    if (p.after) a.spaceAfter = round(twipToPt(p.after));
    if (p.line) {
      if (p.lineRule === 'exact' || p.lineRule === 'atLeast') a.lineHeight = `${round(twipToPt(p.line), 1)}pt`;
      else {
        const f = round((p.line / 240) * 1.2, 2);
        if (Math.abs(f - 1.6) > 0.01) a.lineHeight = String(f);
      }
    }
    if (p.bg) a.paraBg = p.bg;
    if (baseSize && baseSize !== 10) a.fontSize = baseSize;
    return a;
  }

  // ----- 본문 -----
  convertBody(container: Element): JNode[] {
    const out: JNode[] = [];
    let stack: { list: JNode; level: number; numId: string }[] = [];
    const counters = this.listCounters;
    const closeLists = () => (stack = []);
    const walk = (els: Element[]) => {
      for (const el of els) {
        const name = localName(el);
        if (name === 'p') {
          const res = this.convertP(el);
          for (const item of res.blocks) {
            if (item.list && item.node.type !== 'pageBreak') {
              const { numId, ilvl, fmt, listStyle, start } = item.list;
              const type = fmt === 'bullet' ? 'bulletList' : 'orderedList';
              while (stack.length && stack[stack.length - 1].level > ilvl) stack.pop();
              const top = stack[stack.length - 1];
              if (top && top.level === ilvl && (top.list.type !== type || top.numId !== numId)) stack.pop();
              const cur = stack[stack.length - 1];
              if (!cur || cur.level < ilvl) {
                const attrs: Record<string, any> = {};
                if (listStyle) attrs.listStyle = listStyle;
                if (type === 'orderedList' && start !== 1) attrs.start = start;
                const list: JNode = { type, attrs, content: [] };
                if (cur && cur.list.content!.length) {
                  const li = cur.list.content![cur.list.content!.length - 1];
                  li.content!.push(list);
                } else out.push(list);
                stack.push({ list, level: ilvl, numId });
              }
              // 번호 이어 매기기 (같은 numId는 문단이 끼어 있어도 계속)
              const ckey = numId + ':' + ilvl;
              const prevCount = counters.get(ckey) ?? start - 1;
              counters.set(ckey, prevCount + 1);
              for (const k of [...counters.keys()]) {
                const [nid, lv] = k.split(':');
                if (nid === numId && +lv > ilvl) counters.delete(k);
              }
              const listNode = stack[stack.length - 1].list;
              if (type === 'orderedList' && listNode.content!.length === 0 && prevCount + 1 !== 1) listNode.attrs = { ...listNode.attrs, start: prevCount + 1 };
              const node = item.node;
              if (node.attrs) {
                delete node.attrs.indentLeft;
                delete node.attrs.textIndent;
              }
              stack[stack.length - 1].list.content!.push({ type: 'listItem', content: [node] });
            } else {
              closeLists();
              out.push(item.node);
            }
          }
          out.push(...res.after);
        } else if (name === 'tbl') {
          closeLists();
          out.push(this.convertTable(el));
        } else if (name === 'sdt') {
          walk(kids(kid(el, 'sdtContent')));
        } else if (name === 'customXml' || name === 'ins' || name === 'smartTag') {
          walk(kids(el));
        } else if (name === 'AlternateContent') {
          walk(kids(kid(el, 'Choice') || kid(el, 'Fallback')));
        }
      }
    };
    walk(kids(container));
    return out;
  }

  convertP(pEl: Element): {
    blocks: { node: JNode; list?: { numId: string; ilvl: number; fmt: string; listStyle: string | null; start: number } }[];
    after: JNode[];
  } {
    const pPr = kid(pEl, 'pPr');
    const { p, r: baseR, heading } = this.resolveP(pPr);
    const pAttrs = this.paraAttrs(p, heading ? undefined : baseR.size);
    const inline: JNode[] = [];
    const after: JNode[] = [];
    this.collectInline(kids(pEl), baseR, null, inline, after);
    // 쪽 나누기로 분할
    const segments: JNode[][] = [[]];
    /** 조각 앞의 나누기가 단 나누기인가 (아니면 쪽 나누기) */
    const colBreak: boolean[] = [false];
    for (const n of inline) {
      if (n.type === '__pagebreak') {
        segments.push([]);
        colBreak.push(!!n.attrs?.column);
      } else segments[segments.length - 1].push(n);
    }
    const blocks: { node: JNode; list?: any }[] = [];
    if (p.pageBreakBefore) blocks.push({ node: { type: 'pageBreak' } });
    let listInfo: any;
    if (p.numId && p.numId !== '0') {
      const num = this.numbering.get(p.numId);
      const levels = num ? this.abstractNums.get(num.abs) : undefined;
      const ilvl = p.ilvl || 0;
      const lv = levels?.[ilvl];
      if (lv && lv.fmt !== 'none') {
        listInfo = {
          numId: p.numId,
          ilvl,
          fmt: lv.fmt,
          listStyle: listStyleFor(lv.fmt, lv.text),
          start: num?.overrides.get(ilvl) ?? lv.start ?? 1,
        };
      }
    }
    segments.forEach((seg, i) => {
      if (i > 0) blocks.push({ node: { type: colBreak[i] ? 'columnBreak' : 'pageBreak' } });
      if (i > 0 && !seg.length) return;
      let node: JNode;
      if (heading) {
        const hAttrs: Record<string, any> = { level: heading, ...pAttrs };
        delete hAttrs.fontSize;
        node = { type: 'heading', attrs: hAttrs };
        if (seg.length) node.content = seg;
      } else node = paragraph(pAttrs, seg);
      blocks.push({ node, list: i === 0 ? listInfo : undefined });
    });
    return { blocks, after };
  }

  private collectInline(els: Element[], baseR: RProps, link: string | null, out: JNode[], after: JNode[]) {
    for (const el of els) {
      const name = localName(el);
      switch (name) {
        case 'r':
          this.convertRun(el, baseR, link, out, after);
          break;
        case 'hyperlink': {
          const rid = attr(el, 'id');
          const anchor = attr(el, 'anchor');
          const href = rid ? this.rels.get(rid)?.target || null : anchor ? '#' + anchor : null;
          this.collectInline(kids(el), baseR, href, out, after);
          break;
        }
        case 'fldSimple': {
          const instr = (attr(el, 'instr') || '').trim();
          const m = /^HYPERLINK\s+"([^"]+)"/i.exec(instr);
          if (/^PAGE\b/i.test(instr) && this.headerMode) {
            out.push({ type: 'text', text: '{{PAGE}}' });
            break;
          }
          if (/^NUMPAGES\b/i.test(instr) && this.headerMode) {
            out.push({ type: 'text', text: '{{PAGES}}' });
            break;
          }
          this.collectInline(kids(el), baseR, m ? m[1] : link, out, after);
          break;
        }
        case 'ins':
        case 'del':
        case 'moveTo':
        case 'moveFrom': {
          // 변경 내용: 넣음/지움 표시를 단 채로 읽는다
          const author = attr(el, 'author') || '';
          const time = Date.parse(attr(el, 'date') || '') || 0;
          const type = name === 'ins' || name === 'moveTo' ? 'insertion' : 'deletion';
          this.review.push({ type, attrs: { id: `w${type[0]}${attr(el, 'id') || Math.random().toString(36).slice(2, 7)}`, author, time } });
          this.collectInline(kids(el), baseR, link, out, after);
          this.review.pop();
          break;
        }
        case 'commentRangeStart': {
          const id = 'w' + (attr(el, 'id') || '');
          if (this.settings.comments?.[id]) this.activeComments.add(id);
          break;
        }
        case 'commentRangeEnd':
          this.activeComments.delete('w' + (attr(el, 'id') || ''));
          break;
        case 'smartTag':
        case 'customXml':
        case 'dir':
        case 'bdo':
          this.collectInline(kids(el), baseR, link, out, after);
          break;
        case 'sdt':
          this.collectInline(kids(kid(el, 'sdtContent')), baseR, link, out, after);
          break;
        case 'oMath':
        case 'oMathPara': {
          const t = descendants(el, 't')
            .map((x) => x.textContent || '')
            .join('');
          const n = textNode(t, [...this.marksFrom(baseR, link), { type: 'italic' }]);
          if (n) out.push(n);
          break;
        }
        case 'AlternateContent':
          this.collectInline(kids(kid(el, 'Choice') || kid(el, 'Fallback')), baseR, link, out, after);
          break;
      }
    }
  }

  private convertRun(rEl: Element, baseR: RProps, link: string | null, out: JNode[], after: JNode[]) {
    const r: RProps = { ...baseR };
    const rPr = kid(rEl, 'rPr');
    const rStyle = attr(kid(rPr, 'rStyle'), 'val');
    if (rStyle) for (const s of this.styleChain(rStyle)) this.applyR(r, s.rPr);
    this.applyR(r, rPr);
    if (r.hidden) return;
    const marks = () => {
      const m = this.marksFrom(r, this.fieldLink || link);
      if (this.review.length) m.push(this.review[this.review.length - 1]);
      for (const id of this.activeComments) m.push({ type: 'comment', attrs: { id } });
      return m;
    };
    for (const c of kids(rEl)) {
      const name = localName(c);
      if (this.fieldStage === 'instr' && name !== 'instrText' && name !== 'fldChar') continue;
      switch (name) {
        case 'delText':
        case 't': {
          if (this.fieldIsPage === 2) break;
          const n = textNode(c.textContent || '', marks());
          if (n) out.push(n);
          break;
        }
        case 'tab': {
          const n = textNode('\t', marks());
          if (n) out.push(n);
          break;
        }
        case 'br':
          if (attr(c, 'type') === 'page') out.push({ type: '__pagebreak' });
          else if (attr(c, 'type') === 'column') out.push({ type: '__pagebreak', attrs: { column: true } });
          else out.push({ type: 'hardBreak' });
          break;
        case 'cr':
          out.push({ type: 'hardBreak' });
          break;
        case 'noBreakHyphen': {
          const n = textNode('-', marks());
          if (n) out.push(n);
          break;
        }
        case 'sym': {
          const code = parseInt(attr(c, 'char') || '0', 16);
          const ch = SYMBOL_MAP[code] || (code >= 0xf000 ? String.fromCharCode(code - 0xf000) : String.fromCharCode(code));
          const n = textNode(ch, marks());
          if (n) out.push(n);
          break;
        }
        case 'drawing':
          this.convertDrawing(c, out, after);
          break;
        case 'pict':
        case 'object': {
          const imd = descendant(c, 'imagedata');
          const rid = attr(imd, 'id');
          const shape = descendant(c, 'shape');
          const style = attr(shape, 'style') || '';
          const wm = /width:([\d.]+)pt/.exec(style);
          const hm = /height:([\d.]+)pt/.exec(style);
          const w = wm ? Math.round((parseFloat(wm[1]) * 96) / 72) : null;
          const h = hm ? Math.round((parseFloat(hm[1]) * 96) / 72) : null;
          if (rid && this.images.get(rid)) out.push({ type: 'image', attrs: { src: this.images.get(rid), width: w, height: h } });
          else if (name === 'object') out.push({ type: 'image', attrs: { src: placeholderImage('OLE 개체', w || 160, h || 90), width: w || 160, height: h || 90 } });
          const txbx = descendant(c, 'txbxContent');
          if (txbx) after.push(...this.convertBody(txbx));
          break;
        }
        case 'footnoteReference':
        case 'endnoteReference': {
          const id = attr(c, 'id') || '';
          const text = (name === 'footnoteReference' ? this.footnotes : this.endnotes).get(id) || '';
          out.push({ type: 'footnote', attrs: { text } });
          break;
        }
        case 'fldChar': {
          const t = attr(c, 'fldCharType');
          if (t === 'begin') {
            this.fieldStage = 'instr';
            this.fieldInstr = '';
          } else if (t === 'separate') {
            this.fieldStage = 'result';
            const instr = (this.fieldInstr || '').trim();
            const m = /^HYPERLINK\s+(?:\\l\s+)?"([^"]+)"/i.exec(instr);
            if (m) this.fieldLink = m[1];
            if (this.headerMode && /^(PAGE|NUMPAGES)\b/i.test(instr)) {
              out.push({ type: 'text', text: /^PAGE/i.test(instr) ? '{{PAGE}}' : '{{PAGES}}' });
              this.fieldIsPage = 2;
            }
          } else if (t === 'end') {
            if (this.fieldStage === 'instr' && this.headerMode && /^\s*(PAGE|NUMPAGES)\b/i.test(this.fieldInstr || '')) {
              out.push({ type: 'text', text: /^\s*PAGE\b/i.test(this.fieldInstr || '') ? '{{PAGE}}' : '{{PAGES}}' });
            }
            this.fieldStage = 'none';
            this.fieldInstr = null;
            this.fieldLink = null;
            this.fieldIsPage = 0;
          }
          break;
        }
        case 'instrText':
          if (this.fieldInstr !== null) this.fieldInstr += c.textContent || '';
          break;
        case 'AlternateContent': {
          const choice = kid(c, 'Choice');
          const target = choice && descendant(choice, 'drawing') ? choice : kid(c, 'Fallback') || choice;
          if (target) {
            for (const cc of kids(target)) {
              if (localName(cc) === 'drawing') this.convertDrawing(cc, out, after);
              else if (localName(cc) === 'pict') {
                const imd = descendant(cc, 'imagedata');
                const rid = attr(imd, 'id');
                if (rid && this.images.get(rid)) out.push({ type: 'image', attrs: { src: this.images.get(rid) } });
                const txbx = descendant(cc, 'txbxContent');
                if (txbx) after.push(...this.convertBody(txbx));
              }
            }
          }
          break;
        }
      }
    }
  }

  private convertDrawing(d: Element, out: JNode[], after: JNode[]) {
    const container = kid(d, 'inline') || kid(d, 'anchor');
    const ext = kid(container, 'extent');
    const w = ext ? Math.round(parseFloat(attr(ext, 'cx') || '0') / 9525) : null;
    const h = ext ? Math.round(parseFloat(attr(ext, 'cy') || '0') / 9525) : null;
    const blips = descendants(d, 'blip');
    if (blips.length) {
      for (const blip of blips) {
        const rid = attr(blip, 'embed') || attr(blip, 'link');
        const src = rid ? this.images.get(rid) : undefined;
        const sr = descendant(d, 'srcRect');
        const pv = (k: string) => (parseFloat(attr(sr, k) || '0') || 0) / 100000;
        const crop = sr ? normCrop(pv('t'), pv('r'), pv('b'), pv('l')) : null;
        if (src) out.push({ type: 'image', attrs: { src, width: w || null, height: h || null, crop } });
        else out.push({ type: 'image', attrs: { src: placeholderImage('그림', w || 120, h || 80), width: w || 120, height: h || 80 } });
        if (blips.length === 1) break;
      }
    } else if (descendant(d, 'chart')) {
      out.push({ type: 'image', attrs: { src: placeholderImage('차트', w || 300, h || 180), width: w || 300, height: h || 180 } });
    }
    const txbx = descendant(d, 'txbxContent');
    if (txbx) after.push(...this.convertBody(txbx));
  }

  convertTable(tbl: Element): JNode {
    const tblPr = kid(tbl, 'tblPr');
    const styleId = attr(kid(tblPr, 'tblStyle'), 'val');
    let tableNoBorders: string[] | null = null;
    const bordersEl = kid(tblPr, 'tblBorders') || (styleId ? kid(this.styles.get(styleId)?.tblPr, 'tblBorders') : null);
    if (bordersEl) {
      const none = (tag: string) => {
        const b = kid(bordersEl, tag) || kid(bordersEl, tag === 'left' ? 'start' : tag === 'right' ? 'end' : tag);
        const v = attr(b, 'val');
        return !b || v === 'none' || v === 'nil';
      };
      if (['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].every(none)) tableNoBorders = ['l', 'r', 't', 'b'];
    } else if (!styleId) tableNoBorders = ['l', 'r', 't', 'b'];
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => Math.round(parseFloat(attr(g, 'w') || '0') / 15));
    type Cell = { row: number; col: number; cs: number; rs: number; w: number; node: JNode };
    const cells: Cell[] = [];
    const origin = new Map<number, Cell>();
    let rowIdx = 0;
    const rowH: number[] = [];
    for (const tr of kids(tbl, 'tr')) {
      let col = 0;
      const trPr = kid(tr, 'trPr');
      const trH = kid(trPr, 'trHeight');
      // 정확한 높이(exact)와 최소 높이(atLeast) 모두 최소 높이로 쓴다
      if (trH && attr(trH, 'hRule') !== 'auto') rowH[rowIdx] = parseFloat(attr(trH, 'val') || '0') / 15 || 0;
      const gridBefore = Math.max(0, Math.min(512, parseInt(attr(kid(trPr, 'gridBefore'), 'val') || '0', 10) || 0));
      col += gridBefore;
      for (const tc of kids(tr).filter((e) => localName(e) === 'tc' || localName(e) === 'sdt')) {
        const tcEl = localName(tc) === 'sdt' ? kid(kid(tc, 'sdtContent'), 'tc') : tc;
        if (!tcEl) continue;
        const tcPr = kid(tcEl, 'tcPr');
        const span = Math.max(1, Math.min(512, parseInt(attr(kid(tcPr, 'gridSpan'), 'val') || '1', 10) || 1));
        const vm = kid(tcPr, 'vMerge');
        const vmVal = vm ? attr(vm, 'val') || 'continue' : null;
        if (vmVal === 'continue') {
          const o = origin.get(col);
          if (o) {
            o.rs++;
            o.node.attrs!.rowspan = o.rs;
          }
          col += span;
          continue;
        }
        let content = this.convertBody(tcEl).filter((n) => n.type !== 'pageBreak');
        if (!content.length) content = [paragraph()];
        const attrs: Record<string, any> = { colspan: span, rowspan: 1, colwidth: null };
        const shd = normColor(attr(kid(tcPr, 'shd'), 'fill'));
        if (shd && shd !== '#FFFFFF') attrs.backgroundColor = shd;
        const va = attr(kid(tcPr, 'vAlign'), 'val');
        if (va === 'center') attrs.verticalAlign = null;
        else if (va === 'bottom') attrs.verticalAlign = 'bottom';
        else attrs.verticalAlign = 'top';
        const tcb = kid(tcPr, 'tcBorders');
        let noB = tableNoBorders ? [...tableNoBorders] : [];
        if (tcb) {
          const sides: [string, string, string][] = [
            ['left', 'start', 'l'],
            ['right', 'end', 'r'],
            ['top', 'top', 't'],
            ['bottom', 'bottom', 'b'],
          ];
          for (const [a, b, s] of sides) {
            const e = kid(tcb, a) || kid(tcb, b);
            if (!e) continue;
            const v = attr(e, 'val');
            const isNone = v === 'none' || v === 'nil';
            noB = noB.filter((x) => x !== s);
            if (isNone) noB.push(s);
          }
        }
        if (noB.length) attrs.borderStyle = noB.join(' ');
        const wPx = grid.slice(col, col + span).reduce((a, b) => a + b, 0) || Math.round(parseFloat(attr(kid(tcPr, 'tcW'), 'w') || '0') / 15);
        const cell: Cell = { row: rowIdx, col, cs: span, rs: 1, w: wPx, node: { type: 'tableCell', attrs, content } };
        cells.push(cell);
        if (vmVal === 'restart') for (let i = 0; i < span; i++) origin.set(col + i, cell);
        else for (let i = 0; i < span; i++) origin.delete(col + i);
        col += span;
      }
      rowIdx++;
    }
    // 그리드 기반 열 너비를 우선 사용
    const t = assembleTable(cells, rowIdx, 0, 0, rowH);
    if (grid.length && grid.every((g) => g > 0)) {
      for (const c of cells) c.node.attrs!.colwidth = grid.slice(c.col, c.col + c.cs);
    }
    return t;
  }

  async convertHeaderFooter(rid: string | null): Promise<{ text: string; align: 'left' | 'center' | 'right' } | null> {
    if (!rid) return null;
    const rel = this.rels.get(rid);
    if (!rel) return null;
    const xml = await this.text(normalizePath('word/' + rel.target));
    if (!xml) return null;
    this.headerMode = true;
    const blocks = this.convertBody(parseXml(xml).documentElement);
    this.headerMode = false;
    const flat: string[] = [];
    let align: 'left' | 'center' | 'right' = 'center';
    let alignSet = false;
    const walk = (n: JNode) => {
      if (n.type === 'paragraph' || n.type === 'heading') {
        const t = (n.content || []).map((c) => (c.type === 'text' ? c.text : c.type === 'hardBreak' ? ' ' : '')).join('');
        if (t.trim()) {
          flat.push(t.trim());
          if (!alignSet) {
            const a = n.attrs?.textAlign;
            align = a === 'right' ? 'right' : a === 'center' ? 'center' : 'left';
            alignSet = true;
          }
        }
      } else (n.content || []).forEach(walk);
    };
    blocks.forEach(walk);
    const text = flat.join(' ');
    return text ? { text, align } : null;
  }

  async applySection(sectPr: Element | null) {
    if (!sectPr) return;
    const pg = this.settings.page;
    const sz = kid(sectPr, 'pgSz');
    if (sz) {
      const w = twipToMm(parseFloat(attr(sz, 'w') || '11906'));
      const h = twipToMm(parseFloat(attr(sz, 'h') || '16838'));
      pg.landscape = attr(sz, 'orient') === 'landscape' || w > h;
      pg.width = round(Math.min(w, h), 1);
      pg.height = round(Math.max(w, h), 1);
    }
    const mar = kid(sectPr, 'pgMar');
    if (mar) {
      const v = (k: string, d: number) => twipToMm(Math.abs(parseFloat(attr(mar, k) || String(d))));
      const top = v('top', 1440);
      const bottom = v('bottom', 1440);
      const header = v('header', 720);
      const footer = v('footer', 720);
      pg.marginLeft = round(v('left', 1440), 1);
      pg.marginRight = round(v('right', 1440), 1);
      pg.gutter = round(v('gutter', 0), 1);
      pg.marginTop = round(Math.min(header, top), 1);
      pg.marginHeader = round(Math.max(0, top - header), 1);
      pg.marginBottom = round(Math.min(footer, bottom), 1);
      pg.marginFooter = round(Math.max(0, bottom - footer), 1);
    }
    // 다단: 단 수·간격·구분선, 너비가 다른 단
    const cols = kid(sectPr, 'cols');
    const n = cols ? Math.round(parseFloat(attr(cols, 'num') || '1')) : 1;
    if (cols && n > 1) {
      const c: NonNullable<typeof pg.columns> = { count: Math.min(20, n), gap: round(twipToMm(parseFloat(attr(cols, 'space') || '720')), 2) };
      const each = kids(cols, 'col');
      if (attr(cols, 'equalWidth') === '0' && each.length === c.count) {
        c.widths = each.map((e) => round(twipToMm(parseFloat(attr(e, 'w') || '0')), 2));
        c.gaps = each.map((e, i) => (i < c.count - 1 ? round(twipToMm(parseFloat(attr(e, 'space') || '0')), 2) : 0));
        c.gap = 0;
        if (c.widths.some((w) => !(w > 0))) {
          delete c.widths;
          delete c.gaps;
        }
      }
      if (attr(cols, 'sep') === '1' || attr(cols, 'sep') === 'true') c.line = { w: 0.12, c: '#000000', s: 'solid' };
      pg.columns = c;
    }
    const ref = (tag: string) => {
      const refs = kids(sectPr, tag);
      const def = refs.find((r) => attr(r, 'type') === 'default') || refs[0];
      return def ? attr(def, 'id') : null;
    };
    const h = await this.convertHeaderFooter(ref('headerReference'));
    if (h) this.settings.header = h;
    const f = await this.convertHeaderFooter(ref('footerReference'));
    if (f) {
      if (f.text === '{{PAGE}}' || /^-?\s*\{\{PAGE\}\}\s*-?$/.test(f.text)) {
        this.settings.pageNumber.pos = (`bottom-${f.align}` as any);
        this.settings.pageNumber.format = f.text.includes('-') ? 'dash' : 'digit';
      } else this.settings.footer = f;
    }
  }
}

function listStyleFor(fmt: string, text: string): string | null {
  switch (fmt) {
    case 'bullet': {
      const ch = text.charCodeAt(0);
      if (text === 'o' || text === '○' || text === '◦') return 'circle';
      if (ch === 0xf0a7 || text === '▪' || text === '■' || ch === 0xf06e) return 'square';
      if (text === '-' || text === '–' || text === '−') return 'k-dash';
      if (text === '✓' || ch === 0xf0fc) return 'k-check';
      if (text === '◆' || ch === 0xf0a8 || text === '❖' || ch === 0xf076) return 'k-diamond';
      if (text === '➢' || ch === 0xf0d8) return 'k-arrow';
      if (text === '※') return 'k-ref';
      if (text === '●') return 'k-filled-circle';
      if (text === '□' || ch === 0xf071) return 'k-hollow-square';
      return null;
    }
    case 'lowerLetter':
      return 'lower-alpha';
    case 'upperLetter':
      return 'upper-alpha';
    case 'lowerRoman':
      return 'lower-roman';
    case 'upperRoman':
      return 'upper-roman';
    case 'ganada':
      return /^\(/.test(text) ? 'k-paren-hangul' : 'hangul';
    case 'chosung':
      return 'hangul-consonant';
    case 'decimalEnclosedCircle':
    case 'decimalEnclosedCircleChinese':
      return 'k-circled';
    default:
      return /^\(%\d\)$/.test(text) ? 'k-paren' : null;
  }
}

function normalizePath(p: string): string {
  const parts: string[] = [];
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  let out = parts.join('/');
  if (out.startsWith('word/word/')) out = out.slice(5);
  if (out.startsWith('word//')) out = out.replace('word//', '');
  return out;
}

export async function readDocx(data: Uint8Array): Promise<LoadedDoc> {
  const zip = await JSZip.loadAsync(data);
  assertZipBudget(zip);
  let docPath = 'word/document.xml';
  const rootRels = await readZipEntry(zip.file('_rels/.rels'), 'string');
  if (rootRels) {
    const r = descendants(parseXml(rootRels), 'Relationship').find((x) => /officeDocument$/.test(attr(x, 'Type') || ''));
    if (r) docPath = (attr(r, 'Target') || docPath).replace(/^\//, '');
  }
  const xml = await readZipEntry(zip.file(docPath), 'string');
  if (!xml) throw new Error('DOCX 본문(document.xml)을 찾을 수 없습니다.');
  const reader = new DocxReader(zip);
  await reader.init();
  const doc = parseXml(xml);
  const body = descendant(doc, 'body');
  const blocks = body ? reader.convertBody(body) : [];
  const sectPr = body ? kid(body, 'sectPr') : null;
  await reader.applySection(sectPr || (body ? descendants(body, 'sectPr').pop() || null : null));
  const meta: DocMeta = {};
  const core = await readZipEntry(zip.file('docProps/core.xml'), 'string');
  if (core) {
    const c = parseXml(core);
    meta.title = descendant(c, 'title')?.textContent || undefined;
    meta.author = descendant(c, 'creator')?.textContent || undefined;
    meta.subject = descendant(c, 'subject')?.textContent || undefined;
    meta.keywords = descendant(c, 'keywords')?.textContent || undefined;
    meta.created = descendant(c, 'created')?.textContent || undefined;
    meta.modified = descendant(c, 'modified')?.textContent || undefined;
  }
  while (blocks.length && blocks[0].type === 'pageBreak') blocks.shift();
  return { content: docNode(blocks), settings: reader.settings, meta, warnings: [...new Set(reader.warnings)] };
}
