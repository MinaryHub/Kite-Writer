import JSZip from 'jszip';
import type { DocMeta, HeaderFooter, LoadedDoc, PageBorder, PageBorderSide, PageSetup } from '../../types';
import {
  type FloatWrap,
  type JMark,
  type JNode,
  attr,
  formatNumber,
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
import { anchorPlace, adjustValues, arrowOfEnd, colorOf, customGeometry, dashOf, emuPx, presetGeometry, themeColors, type AnchorPlace, type PageGeo } from './drawing';
import { isVmlShape, vmlArrow, vmlColor, vmlDash, vmlLen, vmlOff, vmlPair, vmlPath, vmlStyle, vmlWrap } from './vml';
import type { Mat, ShapeItem } from '../shape';
import { isMetafileExt, metafileToSvg } from '../metafile';
import { naturalLineRatio } from '../fontMetrics';

/** DOCX(Office Open XML) 읽기 */

interface RProps {
  font?: string;
  size?: number;
  color?: string | null;
  /** 한글·한자 글꼴 (rFonts 의 eastAsia). font 는 영문 글꼴 (ascii) */
  eaFont?: string;
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
  /** 모두 대문자로 보인다 (w:caps) */
  caps?: boolean;
}

interface PProps {
  align?: string | null;
  left?: number; // twips
  right?: number;
  firstLine?: number;
  hanging?: number;
  before?: number;
  after?: number;
  /** 자동 간격 (HTML 문단의 위·아래 간격 14pt). 켜져 있으면 before·after 값 대신 쓴다 */
  beforeAuto?: boolean;
  afterAuto?: boolean;
  line?: number;
  lineRule?: string;
  /** 줄 격자에 맞춤 (기본 켬) */
  snapToGrid?: boolean;
  /** 같은 스타일의 문단 사이에는 문단 위·아래 간격을 두지 않는다 */
  contextual?: boolean;
  bg?: string | null;
  pageBreakBefore?: boolean;
  numId?: string;
  ilvl?: number;
  outlineLvl?: number;
  /** 쪽 나눔 규칙: 외톨이줄 방지(기본 켬), 다음 문단과 함께, 문단을 나누지 않음 */
  widow?: boolean;
  keepNext?: boolean;
  keepLines?: boolean;
  /** 탭 자리: 자리(twips) → [맞춤(l·c·r·d), 채움]. 스타일에서 내려오며 쌓이고 clear 로 지운다 */
  tabs?: Map<number, [string, number]>;
}

/** 번호 매기기의 한 수준: 번호 모양, 번호 글(%1 … %9 가 수준마다의 번호), 시작 번호, 수준의 문단·글자 모양, 번호 뒤(탭·빈칸·없음) */
interface NumLevel {
  fmt: string;
  text: string;
  start: number;
  pPr: Element | null;
  rPr: Element | null;
  suff: string;
  /** 앞 수준의 번호도 모두 아라비아 숫자로 (법률식 번호) */
  legal: boolean;
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
/** Word 의 자동 문단 간격 (HTML 문단의 위·아래 간격): 14pt */
const AUTO_SPACE_TW = 280;
/** 떠 있는 그림·도형의 x 가 아직 본문 왼쪽 기준이라는 표시 (문단 속성을 안 뒤 문단 상자 기준으로 고치고 지운다) */
const BODY_X = '__bodyX';
/** 글이 든 블록이 있는가 (빈 문단만 있는 글상자는 글 없는 도형으로) */
const hasBodyText = (blocks: JNode[]) => blocks.some((n) => n.type !== 'paragraph' || (n.content || []).some((c) => c.type !== 'text' || !!(c.text || '').trim()));

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
  numbering = new Map<string, { abs: string; overrides: Map<number, number>; levels: Map<number, NumLevel> }>();
  abstractNums = new Map<string, NumLevel[]>();
  /** 번호 매기기의 지금 번호: 번호 정의(abstractNum) → 수준마다의 값. 같은 정의를 쓰는 목록은 이어서 센다 */
  private numState = new Map<string, number[]>();
  /** 시작 번호를 새로 준 목록(numId:수준)을 이미 시작했는가 */
  private numStarted = new Set<string>();
  footnotes = new Map<string, string>();
  endnotes = new Map<string, string>();
  theme = { minorLatin: '', minorEa: '', majorLatin: '', majorEa: '' };
  /** 테마 색 (dk1·lt1·accent1 …) */
  themeClr = new Map<string, string>();
  /** 테마의 선 굵기 목록 (fmtScheme 의 lnStyleLst, px): 도형 스타일의 lnRef 번호가 가리킨다 */
  themeLines: number[] = [0.67, 1.33, 2];
  /** 쪽 크기·여백 (px): 떠 있는 개체의 자리를 셈한다 (본문의 마지막 구역 설정) */
  geo: PageGeo = { W: 816, H: 1056, ml: 96, mr: 96, mt: 96, mb: 96 };
  /** 머리말 영역의 위쪽 (종이 위에서, px) */
  hdrTop = 48;
  /** 쪽 배경을 보인다 (settings 의 displayBackgroundShape) */
  showBackground = false;
  /** 자동 간격(위 b·아래 a)인 문단 (표 칸의 첫 문단 위·마지막 문단 아래의 자동 간격은 Word 가 두지 않는다) */
  private autoSpaced = new WeakMap<JNode, { b: boolean; a: boolean; list: boolean }>();
  /** 본문의 구역 설정들 (문서 순서: 문단 안의 것들과 본문 끝의 것). 구역이 둘 이상이면 구역 사이에 쪽 나누기를 넣는다 */
  sections: Element[] = [];
  /** 본문 요소 (구역 나누기는 본문의 문단에만 있다) */
  bodyEl: Element | null = null;
  /** 지금 구역의 용지 (다음 구역 용지의 바탕) */
  private secPage: PageSetup | null = null;
  /** 지금 읽는 머리말·꼬리말 */
  private hfKind: 'header' | 'footer' | null = null;
  /** 줄 격자 간격 (pt). 구역의 docGrid 가 type=lines·linesAndChars 일 때만 */
  gridPt = 0;
  /** 호환 모드 (settings.xml 의 compatibilityMode: 15 = Word 2013 이후). 표의 왼쪽 자리 등이 달라진다 */
  compatMode = 12;
  /** 기본 탭 간격 (pt). settings.xml 의 defaultTabStop */
  defaultTab = 36;
  /** 짝수 쪽·홀수 쪽의 머리말/꼬리말을 따로 쓴다 (settings.xml 의 evenAndOddHeaders) */
  evenOdd = false;
  /**
   * 문단 사이 간격을 더한다 (settings.xml 의 doNotUseHTMLParagraphAutoSpacing).
   * 이 설정이 없는 문서(대부분)에서 Word 는 앞 문단의 아래 간격과 뒤 문단의 위 간격 가운데 큰 쪽만 둔다
   */
  addSpacing = false;
  /** Kite 가 쓴 문서 (docProps/app.xml). 머리말·쪽 번호를 Kite 의 설정으로 되돌린다 */
  fromKite = false;
  /** 탭마다 번갈아 주는 구분 값 (이웃한 탭이 한 글자 조각으로 합쳐지지 않게) */
  private tabSeq = 0;
  /** 표 스타일을 고르지 않은 표가 쓰는 기본 표 스타일 */
  defaultTableStyle: string | null = null;
  /** 지금 읽는 표의 표 스타일 (안쪽 표가 뒤): 표 스타일의 문단·글자 모양이 칸 안 문단에 깔린다 */
  private tableStyles: StyleDef[][] = [];
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
      this.themeClr = themeColors(th);
      const lws = kids(descendant(th, 'lnStyleLst'), 'ln').map((l) => emuPx(attr(l, 'w'), 0));
      if (lws.length) this.themeLines = lws;
    }
    const settingsXml = await this.text('word/settings.xml');
    if (settingsXml) {
      const sx = parseXml(settingsXml);
      const cm = descendants(sx, 'compatSetting').find((e) => attr(e, 'name') === 'compatibilityMode');
      const v = cm ? parseInt(attr(cm, 'val') || '', 10) : NaN;
      if (Number.isFinite(v)) this.compatMode = v;
      const dt = parseFloat(attr(descendant(sx, 'defaultTabStop'), 'val') || '');
      if (dt >= 20 && dt <= 31680) this.defaultTab = round(twipToPt(dt), 2);
      const eo = descendant(sx, 'evenAndOddHeaders');
      this.evenOdd = !!eo && onOff(eo) !== false;
      const as = descendant(sx, 'doNotUseHTMLParagraphAutoSpacing');
      this.addSpacing = !!as && onOff(as) !== false;
      // 쪽 배경(w:background)은 이것이 있어야 쪽 보기에 나온다
      const db = descendant(sx, 'displayBackgroundShape');
      this.showBackground = !!db && onOff(db) !== false;
    }
    const appXml = await this.text('docProps/app.xml');
    this.fromKite = !!appXml && /<Application>Kite<\/Application>/.test(appXml);
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
        if (attr(s, 'type') === 'table' && attr(s, 'default') === '1') this.defaultTableStyle = id;
      }
    }
    const numXml = await this.text('word/numbering.xml');
    if (numXml) {
      const nd = parseXml(numXml);
      const lvlOf = (lvl: Element): NumLevel => ({
        fmt: attr(kid(lvl, 'numFmt'), 'val') || 'decimal',
        text: attr(kid(lvl, 'lvlText'), 'val') || '',
        start: parseInt(attr(kid(lvl, 'start'), 'val') || '1', 10) || 1,
        pPr: kid(lvl, 'pPr'),
        rPr: kid(lvl, 'rPr'),
        suff: attr(kid(lvl, 'suff'), 'val') || 'tab',
        legal: !!kid(lvl, 'isLgl') && attr(kid(lvl, 'isLgl'), 'val') !== '0' && attr(kid(lvl, 'isLgl'), 'val') !== 'false',
      });
      /** 번호 스타일을 가리키기만 하는 정의 (numStyleLink): 그 스타일의 목록 정의를 따라간다 */
      const links = new Map<string, string>();
      const styleDefs = new Map<string, string>();
      for (const an of descendants(nd, 'abstractNum')) {
        const id = attr(an, 'abstractNumId') || '';
        const levels: NumLevel[] = [];
        for (const lvl of kids(an, 'lvl')) {
          const i = parseInt(attr(lvl, 'ilvl') || '0', 10);
          if (i >= 0 && i < 9) levels[i] = lvlOf(lvl);
        }
        this.abstractNums.set(id, levels);
        const link = attr(kid(an, 'numStyleLink'), 'val');
        if (link) links.set(id, link);
        const def = attr(kid(an, 'styleLink'), 'val');
        if (def) styleDefs.set(def, id);
      }
      for (const [id, link] of links) {
        const target = styleDefs.get(link);
        if (target && !this.abstractNums.get(id)?.length) this.abstractNums.set(id, this.abstractNums.get(target) || []);
      }
      for (const n of descendants(nd, 'num')) {
        const overrides = new Map<number, number>();
        const levels = new Map<number, NumLevel>();
        for (const o of kids(n, 'lvlOverride')) {
          const i = parseInt(attr(o, 'ilvl') || '0', 10);
          const so = kid(o, 'startOverride');
          if (so) overrides.set(i, parseInt(attr(so, 'val') || '1', 10) || 1);
          const lvl = kid(o, 'lvl');
          if (lvl) levels.set(i, lvlOf(lvl));
        }
        this.numbering.set(attr(n, 'numId') || '', { abs: attr(kid(n, 'abstractNumId'), 'val') || '', overrides, levels });
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
    await this.loadImages(this.rels, this.images);
  }

  /** 관계 파일이 가리키는 그림을 읽어 둔다 (관계 id → data URL) */
  private async loadImages(rels: Map<string, { target: string; type: string; external: boolean }>, into: Map<string, string>) {
    for (const [id, r] of rels) {
      if (r.type !== 'image' || r.external) continue;
      const path = normalizePath('word/' + r.target);
      const f = this.zip.file(path);
      if (!f) continue;
      const ext = path.split('.').pop() || '';
      const mime = mimeFromExt(ext);
      if (isBrowserImage(mime)) into.set(id, bytesToDataUrl(await readZipEntry(f, 'uint8array'), mime));
      // 윈도 메타파일(WMF·EMF): 그려서 SVG 로
      else if (isMetafileExt(ext)) into.set(id, metafileToSvg(await readZipEntry(f, 'uint8array')) || placeholderImage(`그림(${ext.toUpperCase()})`));
      else into.set(id, placeholderImage(`그림(${ext.toUpperCase()})`));
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
          // 영문 글꼴(ascii)과 한글 글꼴(eastAsia)은 따로 물려받는다. 테마 글꼴 지정이 있으면 이름보다 그것이 먼저다.
          // Word 는 글자마다 영문 글자는 영문 글꼴로, 한글·한자는 한글 글꼴로 그린다
          const ea = this.themeFont(attr(c, 'eastAsiaTheme')) || attr(c, 'eastAsia');
          const ascii = this.themeFont(attr(c, 'asciiTheme')) || attr(c, 'ascii') || this.themeFont(attr(c, 'hAnsiTheme')) || attr(c, 'hAnsi');
          if (ascii) p.font = ascii;
          if (ea) p.eaFont = ea;
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
        case 'caps':
          p.caps = onOff(c);
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
          if (b != null) p.before = parseFloat(b);
          if (a != null) p.after = parseFloat(a);
          // 자동 간격: 적힌 쪽(스타일·문단)의 것이 이긴다. 끄면 그 층까지의 before·after 값으로 돌아간다
          const ba = attr(c, 'beforeAutospacing');
          const aa = attr(c, 'afterAutospacing');
          if (ba != null) p.beforeAuto = ba === '1' || ba === 'true' || ba === 'on';
          if (aa != null) p.afterAuto = aa === '1' || aa === 'true' || aa === 'on';
          if (l != null) {
            p.line = parseFloat(l);
            p.lineRule = attr(c, 'lineRule') || 'auto';
          }
          break;
        }
        case 'snapToGrid':
          p.snapToGrid = onOff(c);
          break;
        case 'contextualSpacing':
          p.contextual = onOff(c);
          break;
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
        case 'widowControl':
          p.widow = onOff(c);
          break;
        case 'keepNext':
          p.keepNext = onOff(c);
          break;
        case 'keepLines':
          p.keepLines = onOff(c);
          break;
        case 'tabs': {
          const tabs = (p.tabs = p.tabs || new Map());
          for (const t of kids(c, 'tab')) {
            const pos = parseFloat(attr(t, 'pos') || '');
            if (!Number.isFinite(pos)) continue;
            const v = attr(t, 'val') || 'left';
            if (v === 'clear') tabs.delete(pos);
            // 세로 줄 탭(bar)은 탭 자리가 아니다
            else if (v !== 'bar') tabs.set(pos, [v === 'center' ? 'c' : v === 'right' || v === 'end' ? 'r' : v === 'decimal' ? 'd' : 'l', leaderOf(attr(t, 'leader'))]);
          }
          break;
        }
      }
    }
  }

  /** 탭 글자 하나. 탭 마크를 달아 폭을 화면에서 재서 맞추게 한다 (tabLayout) */
  private tabNode(marks: JMark[], extra?: Record<string, any>): JNode {
    return { type: 'text', text: '\t', marks: [...marks, { type: 'tab', attrs: { ...extra, k: this.tabSeq++ & 1 } }] };
  }

  resolveP(pPr: Element | null): { p: PProps; r: RProps; mark: RProps; styleId: string | null; heading: number } {
    const styleId = attr(kid(pPr, 'pStyle'), 'val') || this.defaultPStyle;
    const p: PProps = {};
    const r: RProps = {};
    this.applyP(p, this.docDefaultsP);
    this.applyR(r, this.docDefaultsR);
    // 표 안의 문단: 표 스타일의 문단·글자 모양이 문서 기본값 위에, 문단 스타일 아래에 깔린다
    const ts = this.tableStyles[this.tableStyles.length - 1];
    if (ts)
      for (const st of ts) {
        this.applyP(p, st.pPr);
        this.applyR(r, st.rPr);
      }
    let heading = 0;
    for (const s of this.styleChain(styleId)) {
      this.applyP(p, s.pPr);
      this.applyR(r, s.rPr);
      const m = /^(heading|제목)\s*(\d)$/.exec(s.name);
      if (m) heading = parseInt(m[2], 10);
      else if (s.name === 'title') heading = 1;
    }
    // 번호 매기기 수준의 문단 모양(들여쓰기 등)은 스타일 위에, 문단에 직접 준 모양 아래에 깔린다
    const np = kid(pPr, 'numPr');
    const numId = np ? attr(kid(np, 'numId'), 'val') ?? p.numId : p.numId;
    const ilvl = np && kid(np, 'ilvl') ? parseInt(attr(kid(np, 'ilvl'), 'val') || '0', 10) || 0 : p.ilvl || 0;
    const level = this.numLevel(numId, ilvl);
    if (level) this.applyP(p, level.pPr);
    this.applyP(p, pPr);
    if (!heading && p.outlineLvl !== undefined && p.outlineLvl < 6 && styleId && styleId !== this.defaultPStyle) heading = p.outlineLvl + 1;
    // 문단 부호의 글자 모양 (pPr 의 rPr): 빈 문단의 높이는 이것으로 정해진다
    const mark: RProps = { ...r };
    this.applyR(mark, kid(pPr, 'rPr'));
    return { p, r, mark, styleId, heading: Math.min(heading, 6) };
  }

  /** 번호 매기기 수준의 정의 (목록마다 덮어쓴 것이 먼저) */
  private numLevel(numId: string | undefined, ilvl: number): NumLevel | null {
    if (!numId || numId === '0') return null;
    const num = this.numbering.get(numId);
    if (!num) return null;
    return num.levels.get(ilvl) || this.abstractNums.get(num.abs)?.[ilvl] || null;
  }

  /**
   * 번호 매기기 문단의 번호 글. 번호를 하나 세고(아래 수준은 다시 처음부터), 번호 글의 %1 … %9 를 수준마다의 번호로 바꾼다.
   * 글머리표는 기호 글꼴(Symbol·Wingdings)의 글자를 같은 모양의 유니코드 글자로 바꾼다. 번호가 없으면 null
   */
  private numLabel(numId: string, ilvl: number): { text: string; level: NumLevel; bullet: boolean } | null {
    const num = this.numbering.get(numId);
    const level = this.numLevel(numId, ilvl);
    if (!num || !level) return null;
    const levelAt = (i: number) => num.levels.get(i) || this.abstractNums.get(num.abs)?.[i] || null;
    let st = this.numState.get(num.abs);
    if (!st) this.numState.set(num.abs, (st = []));
    // 시작 번호를 새로 준 목록은 처음 나올 때 그 번호부터
    const sk = numId + ':' + ilvl;
    if (num.overrides.has(ilvl) && !this.numStarted.has(sk)) {
      this.numStarted.add(sk);
      st[ilvl] = num.overrides.get(ilvl)! - 1;
    }
    st[ilvl] = (st[ilvl] ?? level.start - 1) + 1;
    for (let i = ilvl + 1; i < 9; i++) delete st[i];
    // 건너뛴 위 수준은 시작 번호로 본다
    for (let i = 0; i < ilvl; i++) if (st[i] == null) st[i] = levelAt(i)?.start ?? 1;
    if (level.fmt === 'bullet') {
      const font = attr(kid(level.rPr, 'rFonts'), 'ascii') || attr(kid(level.rPr, 'rFonts'), 'hAnsi') || '';
      return { text: bulletChar(level.text, font), level, bullet: true };
    }
    const text = level.text.replace(/%(\d)/g, (_m, d) => {
      const i = +d - 1;
      const lv = levelAt(i);
      if (!lv || st![i] == null) return '';
      return wordNumber(st![i], level.legal && i < ilvl ? 'decimal' : lv.fmt);
    });
    return text ? { text, level, bullet: false } : null;
  }

  marksFrom(r: RProps, link: string | null): JMark[] {
    const marks: JMark[] = [];
    const ts: Record<string, any> = {};
    // 글꼴이 어디에도 적혀 있지 않으면 Word 의 기본 글꼴
    ts.fontFamily = r.font || r.eaFont || 'Times New Roman';
    if (r.eaFont && r.eaFont !== ts.fontFamily) ts.eaFont = r.eaFont;
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

  /**
   * 문단 속성. font·size: 이 문단의 글(없으면 문단 부호)의 글꼴과 글자 크기(pt) — 줄 높이를 셈한다.
   * Word 의 줄 간격은 글꼴의 고유 줄 높이에 대한 배수(1줄 = 1배)이고, '고정'은 그 값 그대로, '최소'는 고유 줄 높이보다 클 때만 그 값이다
   */
  paraAttrs(p: PProps, font?: string, size?: number): Record<string, any> {
    const a: Record<string, any> = {};
    // Word 의 기본 정렬은 왼쪽이다 (Kite 문단의 기본은 양쪽 정렬)
    if (p.align !== 'justify') a.textAlign = p.align || 'left';
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
    // Word 의 자동 간격(HTML 문단)은 위·아래 14pt (표 칸의 첫 문단 위·마지막 문단 아래는 두지 않는다: convertTable)
    const before = p.beforeAuto ? AUTO_SPACE_TW : p.before;
    const after = p.afterAuto ? AUTO_SPACE_TW : p.after;
    if (before) a.spaceBefore = round(twipToPt(before));
    if (after) a.spaceAfter = round(twipToPt(after));
    const ratio = naturalLineRatio(font || 'Times New Roman');
    const pt = size || 10;
    const natural = ratio * pt;
    let lh: string;
    if (p.line && p.lineRule === 'exact') lh = `${round(twipToPt(p.line), 2)}pt`;
    else if (p.line && p.lineRule === 'atLeast') lh = twipToPt(p.line) > natural + 0.05 ? `${round(twipToPt(p.line), 2)}pt` : String(ratio);
    else {
      const mult = (p.line || 240) / 240;
      // 줄 격자(구역의 docGrid type=lines): 줄 높이를 격자 간격의 배수로 올린다
      const grid = this.gridPt > 0 && p.snapToGrid !== false ? this.gridPt : 0;
      lh = grid ? `${round(Math.max(1, Math.ceil((natural * mult) / grid - 0.02)) * grid, 2)}pt` : String(round(mult * ratio, 3));
    }
    // Kite 의 기본 줄 간격(160%)과 같으면 적지 않는다 (Kite 가 쓴 문서를 다시 읽을 때 반올림으로 값이 달라지지 않게)
    if (!(/^[\d.]+$/.test(lh) && Math.abs(parseFloat(lh) - 1.6) < 0.006)) a.lineHeight = lh;
    if (p.bg) a.paraBg = p.bg;
    if (size && size !== 10) a.fontSize = size;
    // 쪽 나눔 규칙. Word 는 외톨이줄 방지가 기본이다 (끈 문서만 widowControl=0 을 적는다)
    const keep = (p.widow !== false ? 'w' : '') + (p.keepNext ? 'n' : '') + (p.keepLines ? 'l' : '');
    if (keep && !this.headerMode) a.pageKeep = keep;
    return a;
  }

  // ----- 본문 -----
  convertBody(container: Element): JNode[] {
    const out: JNode[] = [];
    /** 바로 앞 문단 (같은 스타일 사이의 간격을 뺄 때 본다) */
    let prev: { node: JNode; style: string | null; contextual: boolean } | null = null;
    const walk = (els: Element[]) => {
      for (const el of els) {
        const name = localName(el);
        if (name === 'p') {
          const res = this.convertP(el);
          // '같은 스타일의 문단 사이에 간격 없음': 앞 문단의 아래 간격과 이 문단의 위 간격을 뺀다
          const first = res.blocks.find((b) => b.node.type === 'paragraph')?.node;
          if (prev && first && prev.style === res.style) {
            if (prev.contextual && prev.node.attrs) delete prev.node.attrs.spaceAfter;
            if (res.contextual && first.attrs) delete first.attrs.spaceBefore;
          }
          // 목록 항목끼리는 자동 간격을 두지 않는다 (Word 의 HTML 문단 간격: 목록의 처음 위와 끝 아래에만)
          const fa = first ? this.autoSpaced.get(first) : undefined;
          const pa = prev ? this.autoSpaced.get(prev.node) : undefined;
          if (prev && first && fa?.list && pa?.list) {
            if (fa.b && first.attrs) delete first.attrs.spaceBefore;
            if (pa.a && prev.node.attrs) delete prev.node.attrs.spaceAfter;
          }
          // 문단 사이 간격은 앞 문단의 아래 간격과 이 문단의 위 간격 가운데 큰 쪽: 위 간격에서 앞 문단의 아래 간격만큼 뺀다
          if (prev && first && !this.addSpacing) {
            const a = +prev.node.attrs?.spaceAfter || 0;
            const b = +first.attrs?.spaceBefore || 0;
            if (a > 0 && b > 0) {
              if (b - a > 0.05) first.attrs!.spaceBefore = round(b - a);
              else delete first.attrs!.spaceBefore;
            }
          }
          for (const item of res.blocks) out.push(item.node);
          out.push(...res.after);
          const last = [...res.blocks].reverse().find((b) => b.node.type === 'paragraph')?.node;
          prev = last && !res.after.length ? { node: last, style: res.style, contextual: res.contextual } : null;
          // 구역 나누기: 이 문단으로 구역이 끝난다. 다음 구역이 새 쪽에서 시작하면(이어지는 구역이 아니면) 그 구역의 용지를 담은 쪽 나누기
          const sp = container === this.bodyEl && this.sections.length > 1 ? kid(kid(el, 'pPr'), 'sectPr') : null;
          if (sp) {
            const k = this.sections.indexOf(sp);
            const next = k >= 0 ? this.sections[k + 1] : undefined;
            if (next) {
              const base = this.secPage || this.settings.page;
              const page = this.pageSetupOf(next, base);
              this.secPage = page;
              this.setGeo(next);
              if ((attr(kid(next, 'type'), 'val') || 'nextPage') !== 'continuous') {
                out.push({ type: 'pageBreak', attrs: { sectionPage: page } });
                prev = null;
              }
            }
          }
        } else if (name === 'tbl') {
          prev = null;
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

  convertP(pEl: Element): { blocks: { node: JNode }[]; after: JNode[]; style: string | null; contextual: boolean } {
    const pPr = kid(pEl, 'pPr');
    const { p, r: baseR, mark, heading, styleId } = this.resolveP(pPr);
    const inline: JNode[] = [];
    const after: JNode[] = [];
    this.collectInline(kids(pEl), baseR, null, inline, after);
    // 줄 높이를 정하는 글꼴·크기: 글이 있으면 글자 수가 가장 많은 글꼴과 그 크기, 빈 문단이면 문단 부호의 것
    const use = new Map<string, number>();
    for (const n of inline) {
      if (n.type !== 'text' || !(n.text || '').trim()) continue;
      const ts = n.marks?.find((m) => m.type === 'textStyle')?.attrs || {};
      const k = `${ts.fontFamily || ''}\u0000${ts.fontSize || 10}`;
      use.set(k, (use.get(k) || 0) + (n.text || '').length);
    }
    let font = mark.font || mark.eaFont;
    let size = mark.size;
    if (use.size) {
      const top = [...use.entries()].sort((x, y) => y[1] - x[1])[0][0].split('\u0000');
      font = top[0] || font;
      size = +top[1] || size;
    }
    const pAttrs = this.paraAttrs(p, font, size);
    // 제목: 제목 문단의 모양은 Word 의 스타일 그대로 두고(글자 모양은 글자마다 적혀 있다) 개요 수준만 단다 (차례 만들기가 쓴다)
    if (heading) pAttrs.outlineLevel = heading;
    // 떠 있는 글상자는 문단 앞의 높이 없는 자리 표시로, 떠 있는 그림·도형의 x 는 문단 상자 왼쪽(왼쪽 여백 + 내어쓰기) 기준으로
    const floatBoxes: JNode[] = [];
    const paraLeft = ((+pAttrs.indentLeft || 0) + Math.max(0, -(+pAttrs.textIndent || 0))) * (96 / 72);
    for (let i = 0; i < inline.length; i++) {
      const n = inline[i];
      if (n.type === '__floatbox') {
        floatBoxes.push(n.attrs!.node);
        inline.splice(i--, 1);
        continue;
      }
      const fl = n.attrs?.float;
      if (fl && fl[BODY_X]) {
        const { [BODY_X]: _drop, ...rest } = fl;
        n.attrs = { ...n.attrs, float: { ...rest, x: round(rest.x - paraLeft, 2) } };
      }
    }
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
    const blocks: { node: JNode }[] = [];
    if (p.pageBreakBefore) blocks.push({ node: { type: 'pageBreak' } });
    for (const fb of floatBoxes) blocks.push({ node: fb });
    // 번호 매기기: Word 가 그리는 번호 글을 문단 맨 앞에 글자로 넣는다 (번호 모양·다단계 번호·수준별 들여쓰기를 그대로 보이게).
    // 번호 뒤의 탭은 내어쓰기 자리(문단 왼쪽)까지 건너뛴다
    if (p.numId && p.numId !== '0' && !this.headerMode) {
      const label = this.numLabel(p.numId, p.ilvl || 0);
      if (label) {
        const lr: RProps = { ...mark };
        this.applyR(lr, label.level.rPr);
        // 글머리표는 유니코드 글자로 바꿨으므로 기호 글꼴 대신 문단의 글꼴로 그린다
        if (label.bullet) {
          lr.font = mark.font;
          lr.eaFont = mark.eaFont;
        }
        lr.underline = false;
        const lm = this.marksFrom(lr, null);
        const pre: JNode[] = [];
        const tn = textNode(label.text, lm);
        if (tn) pre.push(tn);
        if (label.level.suff === 'space') {
          const sn = textNode(' ', lm);
          if (sn) pre.push(sn);
        } else if (label.level.suff !== 'nothing') pre.push(this.tabNode(lm));
        segments[0].unshift(...pre);
      }
    }
    // 탭이 든 문단: 탭 자리(문단·스타일·번호 수준에서 정한 자리와 기본 탭 간격)를 적어 둔다
    if (segments.some((seg) => seg.some((n) => n.type === 'text' && n.marks?.some((m) => m.type === 'tab')))) {
      const stops = [...(p.tabs || new Map<number, [string, number]>()).entries()].sort((x, y) => x[0] - y[0]).map(([pos, [al, leader]]) => [round(twipToPt(pos), 2), al, leader]);
      pAttrs.tabs = { d: this.defaultTab, ...(stops.length ? { s: stops } : {}) };
    }
    segments.forEach((seg, i) => {
      if (i > 0) blocks.push({ node: { type: colBreak[i] ? 'columnBreak' : 'pageBreak' } });
      if (i > 0 && !seg.length) return;
      const node = paragraph(pAttrs, seg);
      if (p.beforeAuto || p.afterAuto) this.autoSpaced.set(node, { b: !!p.beforeAuto, a: !!p.afterAuto, list: !!p.numId && p.numId !== '0' });
      blocks.push({ node });
    });
    return { blocks, after, style: styleId, contextual: !!p.contextual };
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
          // '모두 대문자': 보이는 대로 대문자로 옮긴다
          const n = textNode(r.caps ? (c.textContent || '').toUpperCase() : c.textContent || '', marks());
          if (n) out.push(n);
          break;
        }
        case 'tab':
          out.push(this.tabNode(marks()));
          break;
        case 'ptab': {
          // 절대 위치 탭: 글 영역의 왼쪽 끝·가운데·오른쪽 끝에 뒤 글을 맞춘다 (머리말·꼬리말의 세 칸 배치)
          const al = attr(c, 'alignment');
          const leader = leaderOf(attr(c, 'leader'));
          out.push(this.tabNode(marks(), { ptab: al === 'center' ? 'c' : al === 'right' ? 'r' : 'l', ...(leader ? { leader } : {}) }));
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
          // 예전 방식(VML)의 그리기 개체: 선·도형·묶음, 떠 있는 그림·글상자, 워드아트를 자리째
          if (name === 'pict' && this.vmlDrawing(c, out, after)) break;
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
            // 양식 확인란(FORMCHECKBOX): 상자 글자로 (켜져 있으면 ☒)
            const cb = kid(kid(c, 'ffData'), 'checkBox');
            if (cb) {
              const on = kid(cb, 'checked') ? onOff(kid(cb, 'checked')) !== false : attr(kid(cb, 'default'), 'val') === '1';
              const n = textNode(on ? '☒' : '☐', marks());
              if (n) out.push(n);
            }
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
                if (this.vmlDrawing(cc, out, after)) continue;
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
    // 떠 있는 개체(wp:anchor): 종이·여백·문단 기준 자리에 띄운다
    let place = container && localName(container) === 'anchor' ? anchorPlace(container, this.geo) : null;
    const ext = kid(container, 'extent');
    // 크기: 떠 있는 개체는 쪽·여백에 대한 상대 크기까지 셈한 것
    const w = place ? Math.round(place.w) : ext ? Math.round(parseFloat(attr(ext, 'cx') || '0') / 9525) : null;
    const h = place ? Math.round(place.h) : ext ? Math.round(parseFloat(attr(ext, 'cy') || '0') / 9525) : null;
    // 머리말·꼬리말 안: 종이·여백 기준 세로 자리를 그 영역 위쪽(영역의 첫 문단) 기준으로 바꾼다 (쪽마다 같은 자리라 쪽 나누기 뒤 맞출 것이 없다)
    if (place && this.headerMode && place.py != null) {
      const zoneTop = this.hfKind === 'footer' ? this.geo.H - this.geo.mb : this.hdrTop;
      place = { ...place, y: round(place.py + this.geo.mt - zoneTop, 2), py: null };
    }
    const floatAt = (pl: AnchorPlace, bodyX: boolean) => {
      const wrap = this.wrapOf(pl);
      return { x: pl.x, y: pl.y, ...(pl.py != null ? { py: pl.py } : {}), ...(pl.behind ? { behind: true } : {}), ...(wrap ? { wrap } : {}), ...(bodyX ? { [BODY_X]: true } : {}) };
    };
    // 도형·글상자·묶음 (wps:wsp, wpg:wgp): 글이 든 사각형·타원은 고칠 수 있는 글상자, 그 밖에는 그린 도형으로
    const gd = descendant(container, 'graphicData');
    const shapeEl = gd ? kids(gd).find((k) => localName(k) === 'wsp' || localName(k) === 'wgp') || null : null;
    if (shapeEl && w && h) {
      const node = this.drawingShape(shapeEl, w, h);
      if (node) {
        if (node.type === 'textBox') {
          if (place) {
            node.attrs = { ...node.attrs, float: floatAt(place, false) };
            out.push({ type: '__floatbox', attrs: { node } });
          } else after.push(node);
        } else {
          if (place) node.attrs = { ...node.attrs, float: floatAt(place, true) };
          out.push(node);
        }
        return;
      }
    }
    // 같은 그림을 형식만 달리 두 번 담은 것(AlternateContent 의 Choice·Fallback)은 하나만 쓴다: 널리 읽히는 Fallback 쪽
    const blips = descendants(d, 'blip').filter((b) => {
      for (let e: Element | null = b.parentElement; e && e !== d; e = e.parentElement) {
        const ln = localName(e);
        if (ln !== 'Choice' && ln !== 'Fallback') continue;
        const ac = e.parentElement;
        const other = ac ? kid(ac, ln === 'Choice' ? 'Fallback' : 'Choice') : null;
        if (ln === 'Choice' && other && descendant(other, 'blip')) return false;
      }
      return true;
    });
    if (blips.length) {
      for (const blip of blips) {
        const rid = attr(blip, 'embed') || attr(blip, 'link');
        const src = rid ? this.images.get(rid) : undefined;
        const sr = descendant(d, 'srcRect');
        const pv = (k: string) => (parseFloat(attr(sr, k) || '0') || 0) / 100000;
        const crop = sr ? normCrop(pv('t'), pv('r'), pv('b'), pv('l')) : null;
        if (src) out.push({ type: 'image', attrs: { src, width: w || null, height: h || null, crop, ...(place ? { float: floatAt(place, true) } : {}) } });
        else out.push({ type: 'image', attrs: { src: placeholderImage('그림', w || 120, h || 80), width: w || 120, height: h || 80 } });
        if (blips.length === 1) break;
      }
    } else if (descendant(d, 'chart')) {
      out.push({ type: 'image', attrs: { src: placeholderImage('차트', w || 300, h || 180), width: w || 300, height: h || 180 } });
    }
    const txbx = descendant(d, 'txbxContent');
    if (txbx) after.push(...this.convertBody(txbx));
  }

  /**
   * VML 그리기 개체(w:pict 안의 v:shape·v:rect·v:roundrect·v:oval·v:line·v:group). 다룬 것이 있으면 true.
   * 글상자는 고칠 수 있는 글상자로, 그림은 그림으로, 그 밖의 모양은 그린 도형으로. 떠 있으면(position:absolute) 그 자리에
   */
  private vmlDrawing(pict: Element, out: JNode[], after: JNode[]): boolean {
    const shapes = kids(pict).filter(isVmlShape);
    if (!shapes.length) return false;
    let done = false;
    for (const el of shapes) {
      const st = vmlStyle(el);
      if (st.get('visibility') === 'hidden') continue;
      const name = localName(el);
      // 크기·자리 (선은 시작·끝 점에서)
      let left = vmlLen(st.get('margin-left') ?? st.get('left'));
      let top = vmlLen(st.get('margin-top') ?? st.get('top'));
      let w = vmlLen(st.get('width'));
      let h = vmlLen(st.get('height'));
      let line: number[] | null = null;
      if (name === 'line') {
        const [x1, y1] = (attr(el, 'from') || '0,0').split(',').map((v) => vmlLen(v));
        const [x2, y2] = (attr(el, 'to') || '0,0').split(',').map((v) => vmlLen(v));
        left = Math.min(x1, x2);
        top = Math.min(y1, y2);
        w = Math.abs(x2 - x1);
        h = Math.abs(y2 - y1);
        line = [x1 - left, y1 - top, x2 - left, y2 - top];
      }
      if (!(w > 0.01 || h > 0.01)) continue;
      const place = st.get('position') === 'absolute' ? this.vmlPlace(el, st, left, top, w, h) : null;
      const floatOf = (bodyX: boolean) => {
        if (!place) return null;
        const wrap = this.wrapOf(place);
        return { x: place.x, y: place.y, ...(place.py != null ? { py: place.py } : {}), ...(place.behind ? { behind: true } : {}), ...(wrap ? { wrap } : {}), ...(bodyX ? { [BODY_X]: true } : {}) };
      };
      // 그림
      const imd = kid(el, 'imagedata');
      const src = imd ? this.images.get(attr(imd, 'id') || '') : undefined;
      if (src) {
        out.push({ type: 'image', attrs: { src, width: Math.round(w) || null, height: Math.round(h) || null, ...(place ? { float: floatOf(true) } : {}) } });
        done = true;
        continue;
      }
      const fill = this.vmlFill(el);
      const stroke = this.vmlStroke(el);
      // 글상자
      const tb = kid(el, 'textbox');
      const txbx = tb ? kid(tb, 'txbxContent') : null;
      if (txbx && (name === 'shape' || name === 'rect' || name === 'roundrect' || name === 'oval')) {
        const content = this.convertBody(txbx);
        const ins = (attr(tb, 'inset') || '').split(',');
        const pad = [vmlLen(ins[1], 4.8), vmlLen(ins[2], 9.6), vmlLen(ins[3], 4.8), vmlLen(ins[0], 9.6)].map((v) => round(v, 2));
        const attrs: Record<string, any> = { width: Math.round(w), height: Math.round(h), padding: pad };
        if (fill.c && fill.a >= 0.5) attrs.bg = fill.c;
        if (stroke.c) {
          attrs.borderColor = stroke.c;
          attrs.borderWidth = round(stroke.w, 2);
          if (stroke.d) attrs.borderDash = stroke.d;
        }
        if (name === 'oval') attrs.radius = '50%';
        const node: JNode = { type: 'textBox', attrs, content: content.length ? content : [paragraph()] };
        if (place) {
          node.attrs = { ...node.attrs, float: floatOf(false) };
          out.push({ type: '__floatbox', attrs: { node } });
        } else after.push(node);
        done = true;
        continue;
      }
      // 그린 도형 (선·사각형·타원·경로·워드아트·묶음)
      const items = this.vmlItems(el, { x: 0, y: 0, w, h }, line, 0);
      if (!items.length) continue;
      const node: JNode = { type: 'shape', attrs: { width: Math.round(w * 100) / 100, height: Math.round(h * 100) / 100, d: { items, ...(items.length > 1 ? { group: true } : {}) } } };
      if (place) node.attrs = { ...node.attrs, float: floatOf(true) };
      out.push(node);
      done = true;
    }
    return done;
  }

  /** VML 의 떠 있는 자리 → AnchorPlace (DrawingML 과 같은 기준 상자) */
  private vmlPlace(el: Element, st: Map<string, string>, left: number, top: number, w: number, h: number): AnchorPlace {
    const g = this.geo;
    const bodyW = Math.max(1, g.W - g.ml - g.mr);
    const bodyH = Math.max(1, g.H - g.mt - g.mb);
    const hRel = st.get('mso-position-horizontal-relative') || 'text';
    const hBox: Record<string, [number, number]> = { page: [-g.ml, g.W], margin: [0, bodyW], text: [0, bodyW], char: [0, bodyW], 'left-margin-area': [-g.ml, g.ml], 'right-margin-area': [bodyW, g.mr] };
    const [hx, hw] = hBox[hRel] || hBox.text;
    const ha = st.get('mso-position-horizontal') || 'absolute';
    const x = ha === 'center' ? hx + (hw - w) / 2 : ha === 'right' || ha === 'outside' ? hx + hw - w : ha === 'left' || ha === 'inside' ? hx : hx + left;
    const vRel = st.get('mso-position-vertical-relative') || 'text';
    const va = st.get('mso-position-vertical') || 'absolute';
    let y = 0;
    let py: number | null = null;
    if (vRel === 'text' || vRel === 'line') y = top;
    else {
      const vBox: Record<string, [number, number]> = { page: [-g.mt, g.H], margin: [0, bodyH], 'top-margin-area': [-g.mt, g.mt], 'bottom-margin-area': [bodyH, g.mb] };
      const [vy, vh] = vBox[vRel] || vBox.margin;
      py = va === 'center' ? vy + (vh - h) / 2 : va === 'bottom' || va === 'outside' ? vy + vh - h : va === 'top' || va === 'inside' ? vy : vy + top;
    }
    // 머리말·꼬리말 안: 종이·여백 기준 세로 자리를 그 영역 위쪽 기준으로
    if (py != null && this.headerMode) {
      const zoneTop = this.hfKind === 'footer' ? g.H - g.mb : this.hdrTop;
      y = py + g.mt - zoneTop;
      py = null;
    }
    const wt = vmlWrap(el);
    const wrap = wt === 'square' ? 'square' : wt === 'tight' ? 'tight' : wt === 'through' ? 'through' : wt === 'topAndBottom' ? 'topBottom' : 'none';
    const z = parseFloat(st.get('z-index') || '0');
    const dl = vmlLen(st.get('mso-wrap-distance-left'), 12);
    const dr = vmlLen(st.get('mso-wrap-distance-right'), 12);
    const dt = vmlLen(st.get('mso-wrap-distance-top'), 0);
    const db = vmlLen(st.get('mso-wrap-distance-bottom'), 0);
    const r2 = (v: number) => Math.round(v * 100) / 100;
    return { x: r2(x), y: r2(y), py: py == null ? null : r2(py), behind: z < 0, wrap, w: r2(w), h: r2(h), side: 'bothSides', dist: [r2(dt), r2(dr), r2(db), r2(dl)] };
  }

  /** VML 채우기 (fillcolor·filled·v:fill) */
  private vmlFill(el: Element): { c: string | null; a: number; c2: string | null } {
    const f = kid(el, 'fill');
    if (vmlOff(attr(el, 'filled')) || vmlOff(attr(f, 'on'))) return { c: null, a: 1, c2: null };
    const c = vmlColor(attr(f, 'color')) || vmlColor(attr(el, 'fillcolor')) || '#FFFFFF';
    const op = parseFloat(attr(f, 'opacity') || '1');
    const t = attr(f, 'type') || '';
    return { c, a: Number.isFinite(op) ? Math.max(0, Math.min(1, op > 1 ? op / 65536 : op)) : 1, c2: /gradient/.test(t) ? vmlColor(attr(f, 'color2')) : null };
  }

  /** VML 선 (strokecolor·strokeweight·stroked·v:stroke) */
  private vmlStroke(el: Element): { c: string | null; w: number; d: string | null; head: string | null; tail: string | null } {
    const s = kid(el, 'stroke');
    if (vmlOff(attr(el, 'stroked')) || vmlOff(attr(s, 'on'))) return { c: null, w: 0, d: null, head: null, tail: null };
    return {
      c: vmlColor(attr(s, 'color')) || vmlColor(attr(el, 'strokecolor')) || '#000000',
      w: Math.max(0.5, vmlLen(attr(s, 'weight') || attr(el, 'strokeweight') || '0.75pt', 1)),
      d: vmlDash(attr(s, 'dashstyle')),
      head: vmlArrow(attr(s, 'startarrow')),
      tail: vmlArrow(attr(s, 'endarrow')),
    };
  }

  /** VML 개체 하나(묶음이면 안의 것들까지) → 도형 조각들. frame: 틀 안 자리 px */
  private vmlItems(el: Element, frame: { x: number; y: number; w: number; h: number }, line: number[] | null, depth: number): ShapeItem[] {
    if (depth > 6) return [];
    const name = localName(el);
    const m: Mat = [1, 0, 0, 1, frame.x, frame.y];
    const fill = this.vmlFill(el);
    const stroke = this.vmlStroke(el);
    const look = (closed: boolean): Partial<ShapeItem> => ({
      fc: closed ? fill.c : null,
      ...(closed && fill.c && fill.a < 1 ? { al: Math.round((1 - fill.a) * 100) / 100 } : {}),
      ...(closed && fill.c && fill.c2 ? { fg: { t: 'LINEAR', a: 0, cx: 50, cy: 50, c: [fill.c, fill.c2] } } : {}),
      sc: stroke.c,
      ...(stroke.c ? { sw: Math.round(stroke.w * 100) / 100 } : {}),
      ...(stroke.d ? { sd: stroke.d } : {}),
      ...(stroke.head ? { hs: stroke.head, hf: true } : {}),
      ...(stroke.tail ? { ts: stroke.tail, tf: true } : {}),
    });
    const { w, h } = frame;
    if (name === 'line' && line) return [{ k: 'line', m, w: Math.max(w, 0.01), h: Math.max(h, 0.01), p: line, ...look(false) } as ShapeItem];
    if (name === 'rect') return [{ k: 'rect', m, w, h, ...look(true) } as ShapeItem];
    if (name === 'roundrect') {
      const a = parseFloat(attr(el, 'arcsize') || '0.2');
      const frac = /f$/i.test(attr(el, 'arcsize') || '') ? a / 65536 : a;
      return [{ k: 'rect', m, w, h, r: Math.round(Math.max(0, Math.min(0.5, frac)) * 100), ...look(true) } as ShapeItem];
    }
    if (name === 'oval') return [{ k: 'ellipse', m, w, h, ...look(true) } as ShapeItem];
    if (name === 'group') {
      // 묶음: 자식의 left·top·width·height 는 coordorigin·coordsize 좌표
      const [ox, oy] = vmlPair(attr(el, 'coordorigin'), [0, 0]);
      const [cw, ch] = vmlPair(attr(el, 'coordsize'), [1000, 1000]);
      const sx = cw ? w / cw : 1;
      const sy = ch ? h / ch : 1;
      const out: ShapeItem[] = [];
      for (const c of kids(el).filter(isVmlShape)) {
        const cs = vmlStyle(c);
        const num = (k: string) => parseFloat(cs.get(k) || '0') || 0;
        let cl = num('left');
        let ct = num('top');
        let cww = num('width');
        let chh = num('height');
        let ln: number[] | null = null;
        if (localName(c) === 'line') {
          const [x1, y1] = (attr(c, 'from') || '0,0').split(',').map((v) => parseFloat(v) || 0);
          const [x2, y2] = (attr(c, 'to') || '0,0').split(',').map((v) => parseFloat(v) || 0);
          cl = Math.min(x1, x2);
          ct = Math.min(y1, y2);
          cww = Math.abs(x2 - x1);
          chh = Math.abs(y2 - y1);
          ln = [(x1 - cl) * sx, (y1 - ct) * sy, (x2 - cl) * sx, (y2 - ct) * sy];
        }
        const box = { x: frame.x + (cl - ox) * sx, y: frame.y + (ct - oy) * sy, w: cww * sx, h: chh * sy };
        // 묶음 안의 그림·글상자
        const imd = kid(c, 'imagedata');
        const src = imd ? this.images.get(attr(imd, 'id') || '') : undefined;
        if (src) {
          out.push({ k: 'img', m: [1, 0, 0, 1, box.x, box.y], w: box.w, h: box.h, src } as ShapeItem);
          continue;
        }
        out.push(...this.vmlItems(c, box, ln, depth + 1));
        const tb = kid(c, 'textbox');
        const tx = tb ? kid(tb, 'txbxContent') : null;
        if (tx) {
          const content = this.convertBody(tx);
          if (hasBodyText(content)) out.push({ k: 'text', m: [1, 0, 0, 1, box.x, box.y], w: box.w, h: box.h, content, pad: [4.8, 9.6, 4.8, 9.6] } as ShapeItem);
        }
      }
      return out;
    }
    if (name === 'shape' || name === 'polyline') {
      // 워드아트: 글자를 틀에 맞춰 늘인다 (흰색에서 시작하는 그러데이션은 끝 색으로: 흰 바탕에 보이게)
      const tp = kid(el, 'textpath');
      if (tp && attr(tp, 'string')) {
        const ts = vmlStyle(tp);
        const fc = fill.c2 && fill.c === '#FFFFFF' ? fill.c2 : fill.c || '#000000';
        return [{ k: 'art', m, w, h, text: (attr(tp, 'string') || '').trim(), font: (ts.get('font-family') || '').replace(/["']/g, '') || undefined, fc, sc: stroke.c } as ShapeItem];
      }
      // 그림 틀(t75)에 그림이 없으면 그리기 판의 바탕일 뿐이다
      if (/_x0000_t75$/.test(attr(el, 'type') || '') && !kid(el, 'imagedata')) return [];
      // 경로: 도형 자신의 것, 없으면 가리키는 모양 틀(v:shapetype)의 것
      let path = attr(el, 'path') || attr(el, 'points');
      let coord = attr(el, 'coordsize');
      const type = (attr(el, 'type') || '').replace(/^#/, '');
      if (!path && type) {
        const tdef = descendants(el.ownerDocument.documentElement, 'shapetype').find((t) => attr(t, 'id') === type);
        path = attr(tdef, 'path');
        coord = coord || attr(tdef, 'coordsize');
      }
      if (!path) return [];
      const [cw, ch] = vmlPair(coord, [21600, 21600]);
      const sx = cw ? w / cw : 1;
      const sy = ch ? h / ch : 1;
      // polyline 의 points 는 "x1,y1 x2,y2 …" (길이 단위)
      const subs = name === 'polyline' ? [{ p: path.split(/[\s,]+/).filter(Boolean).map((v) => vmlLen(v)), z: false }] : vmlPath(path).map((s) => ({ p: s.p.map((v, i) => v * (i % 2 ? sy : sx)), z: s.z }));
      return subs.filter((s) => s.p.length >= 4).map((s) => ({ k: 'poly', m, w, h, p: s.p.map((v) => Math.round(v * 100) / 100), z: s.z, ...look(true) }) as ShapeItem);
    }
    return [];
  }

  /**
   * 떠 있는 개체 둘레의 글 흐름 (정사각형·빽빽하게·통과 → 한쪽, 위아래 → 옆을 비움).
   * 문단 기준으로 놓인 것만: 쪽·여백 기준(py)은 쪽 나누기 뒤에야 자리가 정해지고, 머리말·꼬리말 안의 것은 본문 글과 따로 그린다.
   * 화면(CSS)은 글을 한쪽으로만 흐르게 할 수 있어 양쪽·넓은 쪽은 남는 자리가 넓은 쪽으로 정한다
   */
  private wrapOf(pl: AnchorPlace): FloatWrap | null {
    if (this.headerMode || pl.behind || pl.py != null || pl.wrap === 'none') return null;
    const d = pl.dist;
    if (pl.wrap === 'topBottom') return { s: 'tb', d };
    const o = pl.side;
    const bodyW = this.geo.W - this.geo.ml - this.geo.mr;
    const roomL = pl.x - d[3];
    const roomR = bodyW - (pl.x + pl.w + d[1]);
    // 이보다 좁은 틈에는 글을 넣지 않는다 (0.5 인치)
    const MIN = 48;
    if (pl.side === 'left') return { s: roomL >= MIN ? 'l' : 'tb', d, o };
    if (pl.side === 'right') return { s: roomR >= MIN ? 'r' : 'tb', d, o };
    if (Math.max(roomL, roomR) < MIN) return { s: 'tb', d, o };
    return { s: roomR >= roomL ? 'r' : 'l', d, o };
  }

  /** 그리기 개체(wps:wsp 도형, wpg:wgp 묶음, 크기 w×h px) → 글상자(글이 든 돌리지 않은 사각형·타원) 또는 도형 노드 */
  private drawingShape(el: Element, w: number, h: number): JNode | null {
    if (localName(el) === 'wsp') {
      const sp = this.wspParts(el);
      const txbx = descendant(el, 'txbxContent');
      const content = txbx ? this.convertBody(txbx) : [];
      const boxGeom = ['rect', 'roundRect', 'ellipse', 'flowChartProcess', 'flowChartAlternateProcess'].includes(sp.prst);
      if (hasBodyText(content) && boxGeom && !sp.rot) {
        const attrs: Record<string, any> = { width: w, height: h, padding: sp.pad };
        // 반쯤 넘게 투명한 채우기는 글상자 바탕으로 쓰지 않는다 (글이 비쳐 보이게)
        if (sp.fill && sp.fill.a >= 0.5) attrs.bg = sp.fill.c;
        if (sp.line) {
          attrs.borderColor = sp.line.c;
          attrs.borderWidth = Math.round(sp.line.w * 100) / 100;
          if (sp.line.d !== 'SOLID') attrs.borderDash = sp.line.d;
        }
        if (sp.prst === 'ellipse') {
          attrs.radius = '50%';
          // 타원의 글 영역은 타원 안에 든 사각형 (Word 의 ellipse 꼴의 글 상자: 가로·세로 양쪽에서 (1 - 1/√2)/2 씩 안쪽)
          const k = (1 - Math.SQRT1_2) / 2;
          attrs.padding = [h * k, w * k, h * k, w * k].map((v, i) => Math.round((v + sp.pad[i]) * 100) / 100);
        }
        else if (sp.prst === 'roundRect' || sp.prst === 'flowChartAlternateProcess') attrs.radius = `${round((Math.min(w, h) * (sp.av.get('adj') ?? 16667)) / 100000, 1)}px`;
        if (sp.va) attrs.valign = sp.va;
        return { type: 'textBox', attrs, content: content.length ? content : [paragraph()] };
      }
      const items = this.wspItems(sp, 0, 0, w, h, content);
      return items.length ? { type: 'shape', attrs: { width: w, height: h, d: { items } } } : null;
    }
    const items: ShapeItem[] = [];
    this.groupItems(el, { x: 0, y: 0, w, h }, items, 0);
    return items.length ? { type: 'shape', attrs: { width: w, height: h, d: { items, group: true } } } : null;
  }

  /** 도형(wps:wsp)의 꼴·돌림·채우기·선·글 안 여백 (도형 스타일 wps:style 의 테마 색·선 굵기까지) */
  private wspParts(el: Element) {
    const spPr = kid(el, 'spPr');
    const xfrm = kid(spPr, 'xfrm');
    const rot = ((parseFloat(attr(xfrm, 'rot') || '0') || 0) / 60000) % 360;
    const flipH = attr(xfrm, 'flipH') === '1';
    const flipV = attr(xfrm, 'flipV') === '1';
    const pg = kid(spPr, 'prstGeom');
    const prst = attr(pg, 'prst') || (kid(spPr, 'custGeom') ? 'custom' : 'rect');
    const av = adjustValues(pg);
    const style = kid(el, 'style');
    let fill: { c: string; a: number } | null = null;
    const solid = kid(spPr, 'solidFill');
    const grad = kid(spPr, 'gradFill');
    if (solid) fill = colorOf(solid, this.themeClr);
    else if (grad) fill = colorOf(descendant(grad, 'gs'), this.themeClr);
    else if (!kid(spPr, 'noFill') && !kid(spPr, 'blipFill')) {
      const fr = kid(style, 'fillRef');
      if ((parseInt(attr(fr, 'idx') || '0', 10) || 0) > 0) fill = colorOf(fr, this.themeClr);
    }
    const ln = kid(spPr, 'ln');
    let line: { c: string; w: number; d: string; head: string | null; tail: string | null } | null = null;
    if (!(ln && kid(ln, 'noFill'))) {
      const lnRef = kid(style, 'lnRef');
      const idx = parseInt(attr(lnRef, 'idx') || '0', 10) || 0;
      const c = (ln && colorOf(kid(ln, 'solidFill'), this.themeClr)) || (idx > 0 ? colorOf(lnRef, this.themeClr) : null);
      const lw = ln && attr(ln, 'w') ? emuPx(attr(ln, 'w')) : idx > 0 ? this.themeLines[Math.min(idx, this.themeLines.length) - 1] : 0.75;
      if (c) line = { c: c.c, w: Math.max(0.5, Math.min(40, lw)), d: dashOf(attr(kid(ln, 'prstDash'), 'val')), head: arrowOfEnd(kid(ln, 'headEnd')), tail: arrowOfEnd(kid(ln, 'tailEnd')) };
    }
    const bp = kid(el, 'bodyPr');
    const ins = (k: string, d: number) => (attr(bp, k) != null ? Math.max(0, emuPx(attr(bp, k))) : d);
    const pad = [ins('tIns', 4.8), ins('rIns', 9.6), ins('bIns', 4.8), ins('lIns', 9.6)].map((v) => Math.round(v * 100) / 100);
    const anc = attr(bp, 'anchor');
    const va: 'middle' | 'bottom' | null = anc === 'ctr' ? 'middle' : anc === 'b' ? 'bottom' : null;
    return { rot, flipH, flipV, prst, av, fill, line, pad, va, cust: kid(spPr, 'custGeom') };
  }

  /** 도형 하나 → 도형 조각들 (꼴 + 안의 글). (fx, fy, fw, fh): 틀 안 자리 px */
  private wspItems(sp: ReturnType<DocxReader['wspParts']>, fx: number, fy: number, fw: number, fh: number, content: JNode[]): ShapeItem[] {
    // 사용자 지정 도형: 경로마다 다각형 조각으로 (곡선·호는 펴서)
    const cust = sp.prst === 'custom' && sp.cust ? customGeometry(sp.cust, fw, fh) : [];
    const geom = cust.length ? { k: 'poly' as const, p: cust[0].p, z: cust[0].z } : presetGeometry(sp.prst === 'custom' ? 'rect' : sp.prst, fw, fh, sp.av);
    // 가운데를 축으로 돌리고 뒤집은 뒤 틀 안 자리로
    const t = (sp.rot * Math.PI) / 180;
    const cos = Math.cos(t);
    const sin = Math.sin(t);
    const sx = sp.flipH ? -1 : 1;
    const sy = sp.flipV ? -1 : 1;
    const a = cos * sx;
    const b = sin * sx;
    const c = -sin * sy;
    const d = cos * sy;
    const cx = fw / 2;
    const cy = fh / 2;
    const r4 = (v: number) => Math.round(v * 10000) / 10000;
    const m = [a, b, c, d, cx - (a * cx + c * cy) + fx, cy - (b * cx + d * cy) + fy].map(r4) as Mat;
    const it: ShapeItem = { ...geom, m, w: fw, h: fh, fc: geom.k === 'line' ? null : sp.fill?.c ?? null, sc: sp.line?.c ?? null };
    if (sp.fill && sp.fill.a < 1 && geom.k !== 'line') it.al = Math.round((1 - sp.fill.a) * 100) / 100;
    if (sp.line) {
      it.sw = Math.round(sp.line.w * 100) / 100;
      if (sp.line.d !== 'SOLID') it.sd = sp.line.d;
      if (sp.line.head) Object.assign(it, { hs: sp.line.head, hf: true });
      if (sp.line.tail) Object.assign(it, { ts: sp.line.tail, tf: true });
    }
    const out: ShapeItem[] = [it];
    // 경로가 여럿이면 같은 자리·모양으로 조각을 더한다 (열린 경로는 칠하지 않는다)
    if (cust.length) {
      if (!cust[0].fill) it.fc = null;
      if (!cust[0].stroke) it.sc = null;
      for (const c of cust.slice(1)) out.push({ ...it, p: c.p, z: c.z, fc: c.fill ? it.fc ?? sp.fill?.c ?? null : null, sc: c.stroke ? sp.line?.c ?? null : null });
    }
    if (hasBodyText(content)) out.push({ k: 'text', m: [1, 0, 0, 1, r4(fx), r4(fy)], w: fw, h: fh, content, pad: sp.pad, ...(sp.va ? { va: sp.va } : {}) });
    return out;
  }

  /** 묶음(wpg:wgp·grpSp)의 조각들: 묶음 틀(frame, px) 안에 자식 좌표(chOff·chExt)를 맞춰 놓는다 */
  private groupItems(g: Element, frame: { x: number; y: number; w: number; h: number }, items: ShapeItem[], depth: number) {
    if (depth > 8 || items.length > 1000) return;
    const xfrm = kid(kid(g, 'grpSpPr'), 'xfrm');
    const num = (el: Element | null, k: string) => {
      const v = parseFloat(attr(el, k) || '0');
      return Number.isFinite(v) ? v : 0;
    };
    const chOff = kid(xfrm, 'chOff');
    const chExt = kid(xfrm, 'chExt');
    const cox = num(chOff, 'x');
    const coy = num(chOff, 'y');
    const cew = num(chExt, 'cx');
    const ceh = num(chExt, 'cy');
    const sx = cew > 0 ? frame.w / cew : 1 / 9525;
    const sy = ceh > 0 ? frame.h / ceh : 1 / 9525;
    for (const ch of kids(g)) {
      const n = localName(ch);
      if (n !== 'wsp' && n !== 'pic' && n !== 'grpSp') continue;
      const xf = kid(kid(ch, n === 'grpSp' ? 'grpSpPr' : 'spPr'), 'xfrm');
      const off = kid(xf, 'off');
      const ext = kid(xf, 'ext');
      const r = { x: frame.x + (num(off, 'x') - cox) * sx, y: frame.y + (num(off, 'y') - coy) * sy, w: Math.abs(num(ext, 'cx') * sx), h: Math.abs(num(ext, 'cy') * sy) };
      if (n === 'grpSp') this.groupItems(ch, r, items, depth + 1);
      else if (n === 'wsp') {
        const txbx = descendant(ch, 'txbxContent');
        items.push(...this.wspItems(this.wspParts(ch), r.x, r.y, r.w, r.h, txbx ? this.convertBody(txbx) : []));
      } else {
        const rid = attr(descendant(ch, 'blip'), 'embed');
        const src = rid ? this.images.get(rid) : undefined;
        if (src) items.push({ k: 'img', m: [1, 0, 0, 1, r.x, r.y], w: r.w, h: r.h, src });
      }
    }
  }

  /** 쪽 배경 (w:background): 색, 또는 VML 채우기의 그림(바둑판·늘이기). settings 의 displayBackgroundShape 가 있을 때만 보인다 */
  applyBackground(doc: Document) {
    const bg = kid(doc.documentElement, 'background');
    if (!bg || !this.showBackground) return;
    const v = attr(bg, 'color');
    const color = v && /^[0-9A-Fa-f]{6}$/.test(v) ? '#' + v.toUpperCase() : null;
    const fill = descendant(bg, 'fill');
    const rid = attr(fill, 'id');
    const src = rid ? this.images.get(rid) : undefined;
    const type = attr(fill, 'type') || 'solid';
    const image = src && /^data:image\/(png|jpeg|gif|webp|bmp);base64,/.test(src) && (type === 'tile' || type === 'frame') ? src : null;
    // 흰 바탕은 그리지 않는다 (종이 색과 같다)
    if (!image && (!color || color === '#FFFFFF')) return;
    const pb: PageBorder = this.settings.pageBorder || { body: true, offset: [0, 0, 0, 0] };
    pb.bg = color;
    pb.fillArea = 'paper';
    if (image) {
      pb.image = image;
      pb.imageMode = type === 'tile' ? 'TILE' : 'TOTAL';
    }
    this.settings.pageBorder = pb;
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
    const grid = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => Math.round((parseFloat(attr(g, 'w') || '0') / 15) * 100) / 100);
    // 칸의 안 여백 (twip → px): 표 스타일 → 표 → 줄(tblPrEx) → 칸(tcMar) 순서로 덮어쓴다. Word 의 기본은 왼쪽·오른쪽 0.19cm, 위·아래 0
    const styleChain = styleId ? this.styleChain(styleId) : this.defaultTableStyle ? this.styleChain(this.defaultTableStyle) : [];
    const marOf = (el: Element | null | undefined, base: number[]): number[] => {
      if (!el) return base;
      const out = [...base];
      const pick = (i: number, ...names: string[]) => {
        for (const n of names) {
          const e = kid(el, n);
          const t = attr(e, 'type');
          if (e && t !== 'nil' && t !== 'auto' && attr(e, 'w') != null) out[i] = Math.max(0, Math.min(200, (parseFloat(attr(e, 'w') || '0') || 0) / 15));
        }
      };
      pick(0, 'left', 'start');
      pick(1, 'right', 'end');
      pick(2, 'top');
      pick(3, 'bottom');
      return out;
    };
    let tblMar = [7.2, 7.2, 0, 0];
    for (const st of styleChain) tblMar = marOf(kid(st.tblPr, 'tblCellMar'), tblMar);
    tblMar = marOf(kid(tblPr, 'tblCellMar'), tblMar);
    // 표의 가로 자리: 정렬(표 또는 첫 줄의 jc)과 왼쪽 들여쓰기(tblInd)
    const jcOf = (el: Element | null | undefined) => {
      const v = attr(kid(el, 'jc'), 'val');
      return v === 'center' ? 'center' : v === 'right' || v === 'end' ? 'right' : v ? 'left' : null;
    };
    let tblAlign = jcOf(tblPr) || jcOf(kid(kids(tbl, 'tr')[0] || null, 'trPr'));
    if (!tblAlign) for (const st of styleChain) tblAlign = jcOf(st.tblPr) || tblAlign;
    const indEl = kid(tblPr, 'tblInd') || [...styleChain].reverse().map((st) => kid(st.tblPr, 'tblInd')).find(Boolean) || null;
    const tblInd = indEl && (attr(indEl, 'type') || 'dxa') === 'dxa' ? (parseFloat(attr(indEl, 'w') || '0') || 0) / 20 : 0;
    type Cell = { row: number; col: number; cs: number; rs: number; w: number; node: JNode };
    const cells: Cell[] = [];
    const origin = new Map<number, Cell>();
    this.tableStyles.push(styleChain);
    let rowIdx = 0;
    const rowH: number[] = [];
    /** 맨 앞에서부터 이어진 제목 줄(tblHeader) 수: 쪽마다 되풀이한다 */
    let headRows = 0;
    for (const tr of kids(tbl, 'tr')) {
      let col = 0;
      const trPr = kid(tr, 'trPr');
      if (headRows === rowIdx && onOff(kid(trPr, 'tblHeader')) === true) headRows++;
      const trH = kid(trPr, 'trHeight');
      // 정확한 높이(exact)와 최소 높이(atLeast) 모두 최소 높이로 쓴다
      if (trH && attr(trH, 'hRule') !== 'auto') rowH[rowIdx] = parseFloat(attr(trH, 'val') || '0') / 15 || 0;
      const gridBefore = Math.max(0, Math.min(512, parseInt(attr(kid(trPr, 'gridBefore'), 'val') || '0', 10) || 0));
      col += gridBefore;
      const rowMar = marOf(kid(kid(tr, 'tblPrEx'), 'tblCellMar'), tblMar);
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
        // 자동 간격은 칸의 첫 문단 위와 마지막 문단 아래에는 두지 않는다 (Word 의 HTML 문단 간격)
        const head = content[0];
        const foot = content[content.length - 1];
        if (head.type === 'paragraph' && this.autoSpaced.get(head)?.b && head.attrs) delete head.attrs.spaceBefore;
        if (foot.type === 'paragraph' && this.autoSpaced.get(foot)?.a && foot.attrs) delete foot.attrs.spaceAfter;
        // 안쪽 표 바로 뒤의 마지막 빈 문단: 칸이 문단으로 끝나야 해서 있는 것으로, Word 는 그리지 않는다 (커서가 들어가면 나타난다 — editor.css)
        const tail = content[content.length - 1];
        if (content.length > 1 && content[content.length - 2].type === 'table' && tail.type === 'paragraph' && (tail.content || []).every((c) => c.type === 'text' && !c.text)) {
          tail.attrs = { ...tail.attrs, cellTail: true };
        }
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
        attrs.margins = marOf(kid(tcPr, 'tcMar'), rowMar).map((v) => Math.round(v * 10) / 10);
        const wPx = grid.slice(col, col + span).reduce((a, b) => a + b, 0) || Math.round(parseFloat(attr(kid(tcPr, 'tcW'), 'w') || '0') / 15);
        const cell: Cell = { row: rowIdx, col, cs: span, rs: 1, w: wPx, node: { type: 'tableCell', attrs, content } };
        cells.push(cell);
        if (vmVal === 'restart') for (let i = 0; i < span; i++) origin.set(col + i, cell);
        else for (let i = 0; i < span; i++) origin.delete(col + i);
        col += span;
      }
      rowIdx++;
    }
    this.tableStyles.pop();
    // 그리드 기반 열 너비를 우선 사용
    const t = assembleTable(cells, rowIdx, 0, 0, rowH);
    // 제목 줄: 표가 다음 쪽으로 이어지면 그 쪽 맨 위에 되풀이한다 (칸 모양은 그대로)
    if (headRows && headRows < (t.content || []).length) for (const r of (t.content || []).slice(0, headRows)) r.attrs = { ...r.attrs, repeat: true };
    // 격자 폭을 그대로 쓴다. 단 아주 좁은 격자 열을 이웃에 합쳤으면(열 번호가 바뀐다) 합친 폭(assembleTable 이 정한 것)을 둔다
    const nColsOut = cells.reduce((m, c) => Math.max(m, c.col + c.cs), 0);
    if (grid.length && grid.every((g) => g > 0) && nColsOut === grid.length) {
      for (const c of cells) c.node.attrs!.colwidth = grid.slice(c.col, c.col + c.cs);
    }
    // 셀 간격: Word 는 적힌 값의 두 배를 칸 사이에 둔다 (HTML 표의 cellspacing="2" 가 15 twip 으로 적힌다)
    const csp = kid(tblPr, 'tblCellSpacing');
    const cspTw = csp && attr(csp, 'type') !== 'nil' ? parseFloat(attr(csp, 'w') || '0') : 0;
    if (cspTw > 0) t.attrs = { ...t.attrs, cellSpacing: Math.min(50, Math.round(((cspTw * 2) / 15) * 100) / 100) };
    if (tblAlign === 'center' || tblAlign === 'right') t.attrs = { ...t.attrs, align: tblAlign };
    else {
      // 예전 호환 모드의 Word 는 칸 안의 글이 본문 왼쪽 끝(+ 들여쓰기)에 맞도록 표를 왼쪽 안 여백만큼 본문 밖으로 내어 놓는다.
      // Word 2013 이후(호환 모드 15)는 표의 왼쪽 끝을 그 자리에 맞춘다
      const ind = Math.round((tblInd - (this.compatMode >= 15 ? 0 : (tblMar[0] * 72) / 96)) * 100) / 100;
      if (Math.abs(ind) > 0.05) t.attrs = { ...t.attrs, indent: ind };
    }
    return t;
  }

  /**
   * 머리말/꼬리말 하나. Word 가 그리는 모양 그대로(글꼴·탭 자리·표·그림) 블록으로 담고, 글자만 추린 것도 함께 둔다 (대화상자에서 고칠 때 쓴다).
   * Kite 가 쓴 문서의 글자뿐인 머리말은 Kite 의 설정(글자·정렬)으로 되돌린다. 쪽 번호만 든 문단은 pageNums 로 돌려준다
   */
  async convertHeaderFooter(rid: string | null, which: 'header' | 'footer'): Promise<{ hf: HeaderFooter | null; pageNums: { align: 'left' | 'center' | 'right'; text: string }[] }> {
    const none = { hf: null, pageNums: [] };
    if (!rid) return none;
    const rel = this.rels.get(rid);
    if (!rel) return none;
    const path = normalizePath('word/' + rel.target);
    const xml = await this.text(path);
    if (!xml) return none;
    // 머리말 안의 그림·링크는 그 부분의 관계 파일에서 찾는다 (관계 id 가 본문의 것과 겹친다)
    const bodyRels = this.rels;
    const bodyImages = this.images;
    this.rels = await this.loadRels(path.replace(/([^/]+)$/, '_rels/$1.rels'));
    this.images = new Map();
    await this.loadImages(this.rels, this.images);
    this.headerMode = true;
    this.hfKind = which;
    let blocks: JNode[];
    const rootEl = parseXml(xml).documentElement;
    // Kite 가 쓴 글자뿐인 머리말: 문단마다 Header·Footer 스타일이 달려 있다 (모양을 갖춘 머리말에는 없다)
    const kitePlain = this.fromKite && kids(rootEl).every((e) => localName(e) === 'p' && /^(Header|Footer)$/.test(attr(kid(kid(e, 'pPr'), 'pStyle'), 'val') || ''));
    try {
      blocks = this.convertBody(rootEl);
    } finally {
      this.headerMode = false;
      this.hfKind = null;
      this.rels = bodyRels;
      this.images = bodyImages;
    }
    const alignOf = (n: JNode): 'left' | 'center' | 'right' => (n.attrs?.textAlign === 'right' ? 'right' : n.attrs?.textAlign === 'center' ? 'center' : 'left');
    const textOf = (n: JNode): string => (n.content || []).map((c) => (c.type === 'text' ? (c.text === '\t' ? ' ' : c.text) : c.type === 'hardBreak' ? ' ' : '')).join('');
    const flat: string[] = [];
    const pageNums: { align: 'left' | 'center' | 'right'; text: string }[] = [];
    let align: 'left' | 'center' | 'right' = 'center';
    let alignSet = false;
    let plain = true;
    /** 쪽 번호 설정으로 옮긴 문단 (내용에서 뺀다) */
    const numParas = new Set<JNode>();
    const walk = (n: JNode, top: boolean) => {
      if (n.type === 'paragraph' || n.type === 'heading') {
        const t = textOf(n).trim();
        if ((n.content || []).some((c) => c.type !== 'text' && c.type !== 'hardBreak')) plain = false;
        if (!t) return;
        // Kite 가 쓴 쪽 번호 문단
        if (this.fromKite && top && /^(- \{\{PAGE\}\} -|\(\{\{PAGE\}\}\)|\{\{PAGE\}\})$/.test(t)) {
          pageNums.push({ align: alignOf(n), text: t });
          numParas.add(n);
          return;
        }
        flat.push(t);
        if (!alignSet) {
          align = alignOf(n);
          alignSet = true;
        }
      } else {
        plain = false;
        (n.content || []).forEach((c) => walk(c, false));
      }
    };
    blocks.forEach((b) => walk(b, true));
    const text = flat.join(' ');
    if (kitePlain && plain) return { hf: text ? { text, align } : null, pageNums };
    if (!text && plain) return { hf: null, pageNums };
    const hf: HeaderFooter = { text, align, content: blocks.filter((b) => !numParas.has(b)) };
    // 꼬리말은 아래쪽 끝(종이 아래에서 꼬리말 거리)에 맞춰 위로 자란다
    if (which === 'footer') hf.valign = 'bottom';
    return { hf, pageNums };
  }

  /** 떠 있는 개체의 자리를 셈할 쪽 크기·여백 (본문의 구역 설정에서, 본문을 읽기 전에) */
  setGeo(sectPr: Element | null) {
    const sz = kid(sectPr, 'pgSz');
    const mar = kid(sectPr, 'pgMar');
    const tw = (el: Element | null, k: string, d: number) => {
      const v = Math.abs(parseFloat(attr(el, k) || String(d)));
      return Number.isFinite(v) ? Math.min(v, 100000) / 15 : d / 15;
    };
    this.geo = { W: tw(sz, 'w', 12240), H: tw(sz, 'h', 15840), ml: tw(mar, 'left', 1440), mr: tw(mar, 'right', 1440), mt: tw(mar, 'top', 1440), mb: tw(mar, 'bottom', 1440) };
    this.hdrTop = Math.min(tw(mar, 'header', 720), this.geo.mt);
  }

  /**
   * 구역 설정(w:sectPr)의 용지: 크기·방향·여백(Word 의 위·아래 여백과 머리말·꼬리말 거리를 Kite 의 여백으로)·다단.
   * 적히지 않은 값은 base 의 것
   */
  pageSetupOf(sectPr: Element, base: PageSetup): PageSetup {
    const pg: PageSetup = { ...base };
    delete pg.columns;
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
      const c: NonNullable<PageSetup['columns']> = { count: Math.min(20, n), gap: round(twipToMm(parseFloat(attr(cols, 'space') || '720')), 2) };
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
    return pg;
  }

  async applySection(sectPr: Element | null) {
    if (!sectPr) return;
    const keepCols = this.settings.page.columns;
    Object.assign(this.settings.page, this.pageSetupOf(sectPr, this.settings.page));
    if (!this.settings.page.columns) {
      if (keepCols) this.settings.page.columns = keepCols;
      else delete this.settings.page.columns;
    }
    // 쪽 테두리 (w:pgBorders): 선으로 된 것만 (그림 테두리 — mapleMuffins 같은 — 는 그릴 수 없어 뺀다)
    const pgb = kid(sectPr, 'pgBorders');
    if (pgb) {
      const LINE: Record<string, PageBorderSide['s']> = { single: 'solid', thick: 'solid', double: 'double', dotted: 'dotted', dashed: 'dashed', dashSmallGap: 'dashed', dotDash: 'dashed', dotDotDash: 'dashed', triple: 'double', thinThickSmallGap: 'double', thickThinSmallGap: 'double', thinThickMediumGap: 'double', thickThinMediumGap: 'double', thinThickLargeGap: 'double', thickThinLargeGap: 'double', thinThickThinSmallGap: 'double', thinThickThinMediumGap: 'double', thinThickThinLargeGap: 'double', threeDEmboss: 'solid', threeDEngrave: 'solid', outset: 'solid', inset: 'solid', wave: 'solid', doubleWave: 'double', dashDotStroked: 'dashed' };
      const PT_MM = 25.4 / 72;
      const sides: NonNullable<PageBorder['sides']> = {};
      const offset = [0, 0, 0, 0];
      const names = [['left', 'l', 0], ['right', 'r', 1], ['top', 't', 2], ['bottom', 'b', 3]] as const;
      for (const [name, k, i] of names) {
        const e = kid(pgb, name);
        const s = LINE[attr(e, 'val') || ''];
        if (!e || !s) continue;
        const sz = parseFloat(attr(e, 'sz') || '4');
        const c = attr(e, 'color');
        sides[k] = { s, w: round(Math.max(0.1, Math.min(10, ((Number.isFinite(sz) ? sz : 4) / 8) * PT_MM)), 3), c: c && /^[0-9A-Fa-f]{6}$/.test(c) ? '#' + c.toUpperCase() : '#000000' };
        const sp = parseFloat(attr(e, 'space') || '0');
        offset[i] = round(Math.max(0, Math.min(31, Number.isFinite(sp) ? sp : 0)) * PT_MM, 2);
      }
      if (Object.keys(sides).length) {
        const disp = attr(pgb, 'display');
        const pb: PageBorder = { ...(this.settings.pageBorder || {}), sides, body: attr(pgb, 'offsetFrom') !== 'page', offset };
        pb.borderOn = disp === 'firstPage' ? 'first' : disp === 'notFirstPage' ? 'notFirst' : null;
        this.settings.pageBorder = pb;
      }
    }
    // 줄 번호 (w:lnNumType): countBy 가 있어야 켜진 것. start 는 0부터 센 값, 간격 기본은 0.25 인치
    const lnt = kid(sectPr, 'lnNumType');
    const lnBy = lnt ? Math.round(parseFloat(attr(lnt, 'countBy') || '0')) : 0;
    if (lnt && lnBy >= 1) {
      const rs = attr(lnt, 'restart');
      const dist = parseFloat(attr(lnt, 'distance') || '360');
      this.settings.lineNumbers = {
        restart: rs === 'continuous' ? 'continue' : rs === 'newSection' ? 'section' : 'page',
        countBy: Math.min(100, lnBy),
        distance: round(twipToMm(Number.isFinite(dist) && dist >= 0 ? Math.min(dist, 28800) : 360), 2),
        start: Math.max(1, Math.min(100000, Math.round(parseFloat(attr(lnt, 'start') || '0') || 0) + 1)),
      };
    }
    // 머리말/꼬리말: 기본(홀수 쪽), 첫 쪽(titlePg 일 때), 짝수 쪽(evenAndOddHeaders 일 때)
    const tp = kid(sectPr, 'titlePg');
    const titlePg = !!tp && onOff(tp) !== false;
    const ref = (tag: string, type: string) => {
      const r = kids(sectPr, tag).find((x) => (attr(x, 'type') || 'default') === type);
      return r ? attr(r, 'id') : null;
    };
    for (const which of ['header', 'footer'] as const) {
      const tag = which + 'Reference';
      const def = await this.convertHeaderFooter(ref(tag, 'default'), which);
      let hf: HeaderFooter | null = def.hf;
      // Kite 가 쓴 쪽 번호 문단은 쪽 번호 설정으로
      for (const pn of def.pageNums) {
        this.settings.pageNumber.pos = `${which === 'header' ? 'top' : 'bottom'}-${pn.align}` as any;
        this.settings.pageNumber.format = pn.text.startsWith('-') ? 'dash' : pn.text.startsWith('(') ? 'paren' : this.settings.pageNumber.format;
      }
      if (titlePg) {
        const first = (await this.convertHeaderFooter(ref(tag, 'first'), which)).hf;
        if (first) hf = { ...(hf || { text: '', align: 'center' }), first };
        else if (hf) this.settings.hideFirst = { ...this.settings.hideFirst, [which]: true };
      }
      if (this.evenOdd) {
        const even = (await this.convertHeaderFooter(ref(tag, 'even'), which)).hf;
        if (even) hf = { ...(hf || { text: '', align: 'center' }), even };
        else if (hf) hf.oddOnly = true;
      }
      if (hf) this.settings[which] = hf;
    }
  }
}

/** Word 의 탭 채움 → 탭 마크의 채움 값 (1 실선, 2 긴 점선, 3 점선, 6 원점선) */
function leaderOf(v: string | null): number {
  return v === 'dot' ? 3 : v === 'hyphen' ? 2 : v === 'underscore' || v === 'heavy' ? 1 : v === 'middleDot' ? 6 : 0;
}

/** 기호 글꼴(Symbol·Wingdings)의 글머리표 글자 → 같은 모양의 유니코드 글자 */
function bulletChar(text: string, font: string): string {
  const WING: Record<number, string> = { 0xa7: '▪', 0x6e: '■', 0x6c: '●', 0x71: '❑', 0x76: '❖', 0xd8: '➢', 0xfc: '✓', 0xa8: '◻', 0xe0: '→', 0x9f: '•', 0x77: '◆', 0x75: '◆', 0xb7: '•', 0xf0: '⇨', 0x6f: '□', 0x70: '◻' };
  const SYM: Record<number, string> = { 0xb7: '•', 0xa7: '♣', 0xa8: '♦', 0xde: '⇒', 0xae: '→', 0x2d: '−', 0xb0: '°' };
  let out = '';
  for (const ch of text || '•') {
    const cp = ch.codePointAt(0)!;
    // 기호 글꼴의 글자는 사용자 영역(U+F000~F0FF)이나 그 아래 바이트 값으로 적힌다
    const low = cp >= 0xf000 && cp <= 0xf0ff ? cp - 0xf000 : /wingdings|symbol/i.test(font) && cp < 0x100 ? cp : -1;
    if (low < 0) out += ch;
    else out += (/wingdings/i.test(font) ? WING[low] : SYM[low]) || WING[low] || SYM[low] || '•';
  }
  return out;
}

const KO_DIGIT = ['영', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구'];
const KO_COUNT = ['', '하나', '둘', '셋', '넷', '다섯', '여섯', '일곱', '여덟', '아홉', '열'];
const HANJA_DIGIT = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 십·백·천 자리로 읽는 수 (일, 십일, 이십 …) */
function sinoNumber(n: number, digit: string[], units: string[]): string {
  if (n <= 0 || n > 9999) return String(n);
  let out = '';
  const ds = String(n).split('').map(Number);
  ds.forEach((d, i) => {
    const u = units[ds.length - 1 - i];
    if (!d) return;
    out += (d === 1 && u ? '' : digit[d]) + u;
  });
  return out;
}

/** Word 의 번호 모양(numFmt)으로 쓴 수 */
function wordNumber(n: number, fmt: string): string {
  const letters = (base: number) => String.fromCharCode(base + ((n - 1) % 26)).repeat(Math.floor((n - 1) / 26) + 1);
  switch (fmt) {
    case 'none':
      return '';
    case 'decimalZero':
      return n < 10 ? '0' + n : String(n);
    case 'upperRoman':
      return formatNumber(n, 'ROMAN_CAPITAL');
    case 'lowerRoman':
      return formatNumber(n, 'ROMAN_SMALL');
    case 'upperLetter':
      return n > 0 ? letters(65) : String(n);
    case 'lowerLetter':
      return n > 0 ? letters(97) : String(n);
    case 'ordinal': {
      const t = n % 100;
      return n + (t >= 11 && t <= 13 ? 'th' : ['th', 'st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'th', 'th'][n % 10]);
    }
    case 'decimalEnclosedCircle':
    case 'decimalEnclosedCircleChinese':
      return formatNumber(n, 'CIRCLED_DIGIT');
    case 'decimalFullWidth':
    case 'decimalFullWidth2':
      return String(n).replace(/\d/g, (d) => String.fromCharCode(0xff10 + +d));
    case 'decimalEnclosedFullstop':
      return n >= 1 && n <= 20 ? String.fromCharCode(0x2488 + n - 1) : n + '.';
    case 'decimalEnclosedParen':
      return n >= 1 && n <= 20 ? String.fromCharCode(0x2474 + n - 1) : `(${n})`;
    case 'ganada':
      return formatNumber(n, 'HANGUL_SYLLABLE');
    case 'chosung':
      return formatNumber(n, 'HANGUL_JAMO');
    case 'koreanDigital':
      return String(n).replace(/\d/g, (d) => KO_DIGIT[+d]);
    case 'koreanCounting':
      return sinoNumber(n, KO_DIGIT, ['', '십', '백', '천']);
    case 'koreanLegal':
      return n >= 1 && n <= 10 ? KO_COUNT[n] : String(n);
    case 'koreanDigital2':
    case 'ideographDigital':
    case 'japaneseDigitalTenThousand':
      return String(n).replace(/\d/g, (d) => HANJA_DIGIT[+d]);
    case 'chineseCounting':
    case 'chineseCountingThousand':
    case 'japaneseCounting':
    case 'ideographTraditional':
    case 'taiwaneseCounting':
      return sinoNumber(n, HANJA_DIGIT, ['', '十', '百', '千']);
    case 'hex':
      return n.toString(16).toUpperCase();
    case 'chicago':
      return ['*', '†', '‡', '§'][(n - 1) % 4].repeat(Math.floor((n - 1) / 4) + 1);
    default:
      return String(n);
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
  const sectPr = body ? kid(body, 'sectPr') || descendants(body, 'sectPr').pop() || null : null;
  // 줄 격자: 문단의 줄 높이를 셈할 때 쓰므로 본문보다 먼저 읽는다
  const grid = kid(sectPr, 'docGrid');
  if (grid && /^(lines|linesAndChars|snapToChars)$/.test(attr(grid, 'type') || '')) reader.gridPt = Math.max(0, Math.min(200, parseFloat(attr(grid, 'linePitch') || '0') / 20)) || 0;
  // 구역들: 문단 안의 구역 설정(본문의 문단에만 있다)과 본문 끝의 것
  const sections = body
    ? [...kids(body, 'p').map((p) => kid(kid(p, 'pPr'), 'sectPr')).filter((x): x is Element => !!x), ...(sectPr && kid(body, 'sectPr') === sectPr ? [sectPr] : [])]
    : [];
  reader.sections = sections;
  reader.bodyEl = body;
  reader.setGeo(sections[0] || sectPr);
  const blocks = body ? reader.convertBody(body) : [];
  await reader.applySection(sectPr);
  // 구역이 여럿이면 문서의 용지는 첫 구역의 것 (뒤 구역들의 용지는 구역 나누기에 담았다). 머리말·꼬리말은 끝 구역의 것
  if (sections.length > 1) {
    const first = reader.pageSetupOf(sections[0], reader.settings.page);
    reader.settings.page = first;
  }
  reader.applyBackground(doc);
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
