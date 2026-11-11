import { indentByBlanks } from '../hwpLayout';
import { hwpToLatex } from '../../math/hwpEq';
import JSZip from 'jszip';
import { CELL_VMARGIN_HWP, FLOATING, HwpPageMarks, assembleTable, fitTableLines, placeCaptions, takeFloating, type Caption, type Captions } from '../hwp/reader';
import type { DocMeta, DocSettings, LoadedDoc, PageSetup } from '../../types';
import {
  type JMark,
  type JNode,
  attr,
  bytesToDataUrl,
  defaultSettings,
  descendant,
  descendants,
  docNode,
  hwpToMm,
  hwpToPt,
  hwpToPx,
  isBrowserImage,
  kid,
  kids,
  localName,
  mimeFromExt,
  normColor,
  numAttr,
  paragraph,
  parseXml,
  placeholderImage,
  round,
  textNode,
  NumberingCounter,
  borderCss,
  hwpxBorderStyle,
  normCrop,
  type BorderSide,
  applyNumFormat,
  assertZipBudget,
  readZipEntry,
  FIXED_SPACE,
} from '../common';

// ---------------- 헤더(스타일 정의) ----------------
export interface CharPr {
  fontFamily?: string;
  fontSize: number;
  color?: string | null;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sup?: boolean;
  sub?: boolean;
  highlight?: string | null;
  letterSpacing?: number;
  fontWidth?: number;
  textEffect?: string | null;
  /** 한글 글꼴과 다른 언어별 글꼴 (영문·한자·기호) */
  langFonts?: LangFonts;
}

export type LangFonts = { en?: string; hanja?: string; sym?: string };

/** 한글 글꼴과 다른 것만 담은 언어별 글꼴 (없으면 undefined) */
export function langFontsOf(base: string | undefined, en?: string, hanja?: string, sym?: string): LangFonts | undefined {
  const out: LangFonts = {};
  if (en && en !== base) out.en = en;
  if (hanja && hanja !== base) out.hanja = hanja;
  if (sym && sym !== base) out.sym = sym;
  return Object.keys(out).length ? out : undefined;
}

export interface ParaPr {
  align?: string | null;
  indentLeft: number;
  indentRight: number;
  textIndent: number;
  spaceBefore: number;
  spaceAfter: number;
  lineHeight: string | null;
  headingType: string;
  headingIdRef: string;
  headingLevel: number;
  pageBreakBefore: boolean;
  bg?: string | null;
  /** 한글 줄 나눔 단위가 글자 (기본은 어절) */
  breakChar?: boolean;
}

export interface BorderFill {
  bg: string | null;
  /** 선이 없는 쪽: l, r, t, b */
  noBorders: string[];
  /** 기본과 다른 선 (굵기/색/종류) */
  css?: string | null;
  /** 그림 채우기: 그림 id (HWP 는 BinData 번호, HWPX 는 binaryItemIDRef) 와 채우는 방식 (TOTAL, TILE, CENTER …) */
  img?: { id: string; mode: string } | null;
  /** 그러데이션 채우기 (CSS background-image 값). bg 는 첫 색으로 두어 그러데이션을 모르는 형식에도 바탕색이 남는다 */
  gradient?: string | null;
  /** 대각선: slash 는 ／(왼쪽 아래→오른쪽 위), back 은 ＼(왼쪽 위→오른쪽 아래), c 는 선 색 */
  diag?: { slash?: boolean; back?: boolean; c: string } | null;
}

/**
 * 한글 그러데이션 → CSS. 한글의 기울임은 0 이 위→아래, 90 이 왼쪽→오른쪽 (CSS 는 0 이 아래→위, 90 이 왼쪽→오른쪽).
 * 종류: 줄무늬(선형)·원형·원뿔·사각형 (사각형은 원형으로 대신).
 */
export function gradientCss(type: 'LINEAR' | 'RADIAL' | 'CONICAL' | 'SQUARE', angle: number, cx: number, cy: number, colors: string[]): string | null {
  const cs = colors.map((c) => normColor(c)).filter((c): c is string => !!c);
  if (cs.length < 2) return null;
  const stops = cs.join(', ');
  const at = `${Math.max(0, Math.min(100, cx))}% ${Math.max(0, Math.min(100, cy))}%`;
  if (type === 'RADIAL' || type === 'SQUARE') return `radial-gradient(circle at ${at}, ${stops})`;
  if (type === 'CONICAL') return `conic-gradient(from ${Math.round(angle)}deg at ${at}, ${stops})`;
  return `linear-gradient(${Math.round(180 - angle)}deg, ${stops})`;
}

/** 그림 채우기 방식 → 칸 배경 그림의 맞춤 */
export function imgFillFit(mode: string): 'stretch' | 'tile' | 'center' {
  if (mode === 'TOTAL' || mode === 'ZOOM') return 'stretch';
  if (mode.startsWith('TILE')) return 'tile';
  return 'center';
}

export interface Numbering {
  levels: { text: string; format: string; start: number }[];
}

export interface HeaderInfo {
  fonts: Map<string, string>; // HANGUL 글꼴 id → 이름
  charPrs: Map<string, CharPr>;
  paraPrs: Map<string, ParaPr>;
  borderFills: Map<string, BorderFill>;
  numberings: Map<string, Numbering>;
  bullets: Map<string, string>;
  styles: Map<string, { name: string; paraPr: string; charPr: string }>;
}

const DEFAULT_CHAR: CharPr = { fontSize: 10 };
const DEFAULT_PARA: ParaPr = {
  indentLeft: 0,
  indentRight: 0,
  textIndent: 0,
  spaceBefore: 0,
  spaceAfter: 0,
  lineHeight: null,
  headingType: 'NONE',
  headingIdRef: '0',
  headingLevel: 0,
  pageBreakBefore: false,
};

/**
 * hp:switch 처리: 직접 요소 → case → default 순서. 길이 값은 case(HwpUnitChar) 안의 것만 제값이고, default 와
 * switch 없이 바로 적힌 것(예전 방식)은 2배로 적혀 있다 (한글이 놓은 줄 자리로 확인: 문단 위 간격 600 이 실제 300)
 */
function pickSwitched(el: Element, name: string): { el: Element | null; factor: number } {
  const direct = kid(el, name);
  if (direct) return { el: direct, factor: 0.5 };
  for (const sw of kids(el, 'switch')) {
    const c = kid(kid(sw, 'case'), name);
    if (c) return { el: c, factor: 1 };
    const d = kid(kid(sw, 'default'), name);
    if (d) return { el: d, factor: 0.5 };
  }
  return { el: null, factor: 1 };
}

export function parseHeader(doc: Document): HeaderInfo {
  const info: HeaderInfo = {
    fonts: new Map(),
    charPrs: new Map(),
    paraPrs: new Map(),
    borderFills: new Map(),
    numberings: new Map(),
    bullets: new Map(),
    styles: new Map(),
  };
  // 글꼴 (한글 글꼴 목록 사용)
  const faces = descendants(doc, 'fontface');
  const hangul = faces.find((f) => attr(f, 'lang') === 'HANGUL') || faces[0];
  const latin = faces.find((f) => attr(f, 'lang') === 'LATIN');
  for (const f of kids(hangul, 'font')) info.fonts.set(attr(f, 'id') || '0', attr(f, 'face') || '');
  const latinFonts = new Map<string, string>();
  for (const f of kids(latin, 'font')) latinFonts.set(attr(f, 'id') || '0', attr(f, 'face') || '');
  const langMap = (lang: string) => {
    const m = new Map<string, string>();
    for (const f of kids(faces.find((x) => attr(x, 'lang') === lang) || null, 'font')) m.set(attr(f, 'id') || '0', attr(f, 'face') || '');
    return m;
  };
  const hanjaFonts = langMap('HANJA');
  const symbolFonts = langMap('SYMBOL');

  for (const bf of descendants(doc, 'borderFill')) {
    const id = attr(bf, 'id') || '';
    let bg: string | null = null;
    const wb = descendant(bf, 'winBrush');
    if (wb) {
      const fc = attr(wb, 'faceColor');
      bg = normColor(fc);
    }
    const grad = descendant(bf, 'gradation');
    let gradient: string | null = null;
    if (grad) {
      const colors = kids(grad, 'color').map((c) => attr(c, 'value') || '');
      const gt = (attr(grad, 'type') || 'LINEAR').toUpperCase() as 'LINEAR' | 'RADIAL' | 'CONICAL' | 'SQUARE';
      gradient = gradientCss(gt, numAttr(grad, 'angle', 0), numAttr(grad, 'centerX', 50), numAttr(grad, 'centerY', 50), colors);
      if (!bg) bg = normColor(colors[0]);
    }
    if (bg === '#FFFFFF') bg = null;
    const noBorders: string[] = [];
    const det: Record<string, BorderSide> = {};
    const sides: [string, string][] = [
      ['leftBorder', 'l'],
      ['rightBorder', 'r'],
      ['topBorder', 't'],
      ['bottomBorder', 'b'],
    ];
    for (const [tag, s] of sides) {
      const b = kid(bf, tag);
      if (!b || attr(b, 'type') === 'NONE') noBorders.push(s);
      else det[s] = { w: parseFloat(attr(b, 'width') || '0.12') || 0.12, c: normColor(attr(b, 'color')) || '#000000', s: hwpxBorderStyle(attr(b, 'type') || 'SOLID') };
    }
    const ib = descendant(bf, 'imgBrush');
    const imgRef = ib ? attr(kid(ib, 'img'), 'binaryItemIDRef') : null;
    const slash = !!kid(bf, 'slash') && (attr(kid(bf, 'slash'), 'type') || 'NONE') !== 'NONE';
    const back = !!kid(bf, 'backSlash') && (attr(kid(bf, 'backSlash'), 'type') || 'NONE') !== 'NONE';
    const diag = slash || back ? { ...(slash ? { slash: true } : {}), ...(back ? { back: true } : {}), c: normColor(attr(kid(bf, 'diagonal'), 'color')) || '#000000' } : null;
    info.borderFills.set(id, { bg, noBorders, css: borderCss(det), img: ib && imgRef ? { id: imgRef, mode: attr(ib, 'mode') || 'TOTAL' } : null, gradient, diag });
  }

  for (const cp of descendants(doc, 'charPr')) {
    const id = attr(cp, 'id') || '0';
    const fontRef = kid(cp, 'fontRef');
    const hangulId = attr(fontRef, 'hangul') || '0';
    const latinId = attr(fontRef, 'latin');
    const ul = kid(cp, 'underline');
    const st = kid(cp, 'strikeout');
    const outline = kid(cp, 'outline');
    const shadow = kid(cp, 'shadow');
    const ratio = numAttr(kid(cp, 'ratio'), 'hangul', 100);
    const spacing = numAttr(kid(cp, 'spacing'), 'hangul', 0);
    const relSz = numAttr(kid(cp, 'relSz'), 'hangul', 100);
    const shade = normColor(attr(cp, 'shadeColor'));
    let effect: string | null = null;
    if (outline && attr(outline, 'type') && attr(outline, 'type') !== 'NONE') effect = 'outline';
    if (shadow && attr(shadow, 'type') && attr(shadow, 'type') !== 'NONE') effect = 'shadow';
    if (kid(cp, 'emboss')) effect = 'emboss';
    if (kid(cp, 'engrave')) effect = 'engrave';
    const stShape = attr(st, 'shape');
    const fontFamily = info.fonts.get(hangulId) || (latinId ? latinFonts.get(latinId) : undefined);
    const ref = (k: string, m: Map<string, string>) => {
      const v = attr(fontRef, k);
      return v != null ? m.get(v) || undefined : undefined;
    };
    info.charPrs.set(id, {
      fontFamily,
      langFonts: langFontsOf(fontFamily, ref('latin', latinFonts), ref('hanja', hanjaFonts), ref('symbol', symbolFonts)),
      fontSize: round((numAttr(cp, 'height', 1000) / 100) * (relSz / 100), 1),
      color: normColor(attr(cp, 'textColor')),
      bold: !!kid(cp, 'bold'),
      italic: !!kid(cp, 'italic'),
      underline: !!ul && !!attr(ul, 'type') && attr(ul, 'type') !== 'NONE',
      strike: !!st && !!stShape && stShape !== 'NONE' && stShape !== '3D',
      sup: !!kid(cp, 'supscript'),
      sub: !!kid(cp, 'subscript'),
      highlight: shade && shade !== '#FFFFFF' ? shade : null,
      letterSpacing: spacing || undefined,
      fontWidth: ratio !== 100 ? ratio : undefined,
      textEffect: effect,
    });
  }

  for (const pp of descendants(doc, 'paraPr')) {
    const id = attr(pp, 'id') || '0';
    const align = attr(kid(pp, 'align'), 'horizontal');
    const { el: margin, factor } = pickSwitched(pp, 'margin');
    const mv = (name: string) => {
      const e = kid(margin, name);
      if (!e) return 0;
      const v = numAttr(e, 'value', 0) * factor;
      return attr(e, 'unit') === 'CHAR' ? v * 10 : hwpToPt(v);
    };
    const { el: ls, factor: lsf } = pickSwitched(pp, 'lineSpacing');
    let lineHeight: string | null = null;
    if (ls) {
      const t = attr(ls, 'type') || 'PERCENT';
      const v = numAttr(ls, 'value', 160);
      if (t === 'PERCENT') lineHeight = v === 160 ? null : String(round(v / 100, 2));
      else if (t === 'FIXED' || t === 'AT_LEAST') lineHeight = `${round(hwpToPt(v * lsf), 1)}pt`;
      else if (t === 'BETWEEN_LINES') lineHeight = String(round(1.2 + hwpToPt(v * lsf) / 10, 2));
    }
    const heading = kid(pp, 'heading');
    const brk = kid(pp, 'breakSetting');
    const border = kid(pp, 'border');
    const bfId = attr(border, 'borderFillIDRef');
    const ALIGN: Record<string, string> = {
      LEFT: 'left',
      RIGHT: 'right',
      CENTER: 'center',
      JUSTIFY: 'justify',
      DISTRIBUTE: 'distribute',
      DISTRIBUTE_SPACE: 'distribute',
    };
    info.paraPrs.set(id, {
      align: align ? ALIGN[align] || null : null,
      indentLeft: mv('left'),
      indentRight: mv('right'),
      textIndent: mv('intent'),
      spaceBefore: mv('prev'),
      spaceAfter: mv('next'),
      lineHeight,
      headingType: attr(heading, 'type') || 'NONE',
      headingIdRef: attr(heading, 'idRef') || '0',
      headingLevel: numAttr(heading, 'level', 0),
      pageBreakBefore: attr(brk, 'pageBreakBefore') === '1',
      bg: bfId ? info.borderFills.get(bfId)?.bg || null : null,
      // 이름과 달리 한글은 KEEP_WORD 를 '글자' 단위(한글 기본값), BREAK_WORD 를 '어절' 단위로 쓴다
      // (한글이 저장한 줄 위치 lineseg 로 확인: KEEP_WORD 문단은 낱말 중간에서 줄이 바뀐다)
      breakChar: (attr(brk, 'breakNonLatinWord') || 'KEEP_WORD') === 'KEEP_WORD',
    });
  }

  for (const nb of descendants(doc, 'numbering')) {
    const id = attr(nb, 'id') || '';
    const levels: Numbering['levels'] = [];
    for (const ph of kids(nb, 'paraHead')) {
      const lv = numAttr(ph, 'level', levels.length + 1) - 1;
      levels[lv] = { text: ph.textContent || '', format: attr(ph, 'numFormat') || 'DIGIT', start: numAttr(ph, 'start', 1) };
    }
    info.numberings.set(id, { levels });
  }
  for (const b of descendants(doc, 'bullet')) info.bullets.set(attr(b, 'id') || '', attr(b, 'char') || '•');
  for (const st of descendants(doc, 'style')) {
    info.styles.set(attr(st, 'id') || '', {
      name: attr(st, 'name') || '',
      paraPr: attr(st, 'paraPrIDRef') || '0',
      charPr: attr(st, 'charPrIDRef') || '0',
    });
  }
  return info;
}

export function charMarks(cp: CharPr | undefined, link?: string | null, highlightOverride?: string | null): JMark[] {
  const marks: JMark[] = [];
  if (!cp) cp = DEFAULT_CHAR;
  const ts: Record<string, any> = {};
  if (cp.fontFamily) ts.fontFamily = cp.fontFamily;
  if (cp.fontSize) ts.fontSize = cp.fontSize;
  if (cp.color && cp.color !== '#000000') ts.color = cp.color;
  if (cp.letterSpacing) ts.letterSpacing = cp.letterSpacing;
  if (cp.fontWidth) ts.fontWidth = cp.fontWidth;
  if (cp.textEffect) ts.textEffect = cp.textEffect;
  if (cp.langFonts) ts.langFonts = cp.langFonts;
  if (Object.keys(ts).length) marks.push({ type: 'textStyle', attrs: ts });
  if (cp.bold) marks.push({ type: 'bold' });
  if (cp.italic) marks.push({ type: 'italic' });
  if (cp.underline) marks.push({ type: 'underline' });
  if (cp.strike) marks.push({ type: 'strike' });
  if (cp.sup) marks.push({ type: 'superscript' });
  else if (cp.sub) marks.push({ type: 'subscript' });
  const hl = highlightOverride || cp.highlight;
  if (hl) marks.push({ type: 'highlight', attrs: { color: hl } });
  if (link) marks.push({ type: 'link', attrs: { href: link } });
  return marks;
}

export function paraAttrs(pp: ParaPr | undefined): Record<string, any> {
  if (!pp) return {};
  const a: Record<string, any> = {};
  if (pp.align && pp.align !== 'justify') a.textAlign = pp.align;
  if (pp.lineHeight) a.lineHeight = pp.lineHeight;
  if (pp.indentLeft) a.indentLeft = round(pp.indentLeft);
  if (pp.indentRight) a.indentRight = round(pp.indentRight);
  if (pp.textIndent) a.textIndent = round(pp.textIndent);
  if (pp.spaceBefore) a.spaceBefore = round(pp.spaceBefore);
  if (pp.spaceAfter) a.spaceAfter = round(pp.spaceAfter);
  if (pp.bg) a.paraBg = pp.bg;
  if (pp.breakChar) a.breakChar = true;
  return a;
}

// ---------------- 본문 변환 ----------------
interface Ctx {
  inSub: boolean;
  bg?: string | null;
  /** 글이 놓이는 폭(px): 칸·글상자 안 폭 (떠 있는 개체의 가운데·오른쪽 맞춤에 쓴다) */
  width?: number;
}

const PT2PX = 96 / 72;
const MM2PX = 96 / 25.4;

/** 크기·오프셋 값: 음수가 부호 없는 32비트로 적힌 것(4294966911 = -385)을 되돌린다 */
function i32Attr(el: Element | null, name: string, def = 0): number {
  let v = numAttr(el, name, def);
  if (v > 0x7fffffff) v -= 0x100000000;
  return v;
}

/** 개체 크기(HWPUNIT): hp:sz(문서에 놓인 크기)부터, 없으면 curSz. 뒤집힌 개체의 음수 크기는 절댓값으로 */
function objSize(el: Element): { w: number; h: number } {
  for (const tag of ['sz', 'curSz', 'orgSz']) {
    const e = kid(el, tag);
    const w = Math.abs(i32Attr(e, 'width', 0));
    const h = Math.abs(i32Attr(e, 'height', 0));
    if (w > 0 && h > 0 && w < 4000000 && h < 4000000) return { w, h };
  }
  return { w: 0, h: 0 };
}

const INLINE_LEAVES = new Set(['image', 'hardBreak', 'footnote', 'math']);
const LEAF_BLOCKS = new Set(['pageBreak', 'horizontalRule']);
/** 문서 노드(JSON)가 ProseMirror 에서 차지하는 크기 (nodeSize) */
function jsonSize(n: JNode): number {
  if (n.type === 'text') return (n.text || '').length;
  if (INLINE_LEAVES.has(n.type) || LEAF_BLOCKS.has(n.type)) return 1;
  return 2 + (n.content || []).reduce((a, c) => a + jsonSize(c), 0);
}
/** 내용 크기 (ProseMirror 의 node.content.size) */
export function jsonContentSize(n: JNode): number {
  return (n.content || []).reduce((a, c) => a + jsonSize(c), 0);
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * 편집기 밖에서 그리는 블록(머리말·꼬리말)용 사본: 편집기의 쪽 나누기·줄 바꿈이 쓰는 배치 정보는 빼고,
 * 줄 높이·기준선(hwpVs)과 문단 사이 간격(hwpGap)만 남긴다 (hfRich 가 한 줄 문단의 줄 상자를 그 값으로 만든다)
 */
function stripLayout(n: JNode): JNode {
  const out: JNode = { ...n };
  if (n.attrs) {
    const a: Record<string, any> = {};
    for (const k of Object.keys(n.attrs)) if (!/^hwp(Lines|Len|Top|Seq|Page)$/.test(k) && k !== 'float') a[k] = n.attrs[k];
    out.attrs = a;
  }
  if (n.content) out.content = n.content.map(stripLayout);
  return out;
}

/** 떠 있는 개체(글자처럼 취급하지 않는 개체)의 자리: 문단 상자의 왼쪽 위 기준 px */
export interface FloatPos {
  x: number;
  y: number;
  /** 글 뒤로 */
  behind?: boolean;
}

const SHAPES = new Set(['rect', 'ellipse', 'arc', 'polygon', 'curve', 'connectLine', 'line', 'textart']);

/**
 * hp:t 안 요소가 차지하는 한글 글자 수 (lineseg textpos 의 셈. HWP 와 같다: 탭은 컨트롤이라 8, 나머지 글자는 1).
 * 형광펜 시작·끝은 글자가 아니다. run 직속 개체(표·그림·컨트롤 등)는 8
 */
const T_WIDTH: Record<string, number> = { tab: 8, lineBreak: 1, nbSpace: 1, fwSpace: 1, hyphen: 1, markpenBegin: 0, markpenEnd: 0 };

/** 한글 글자 위치(textpos) → 문단 내용 안 위치. 한글이 저장한 줄 첫 자리(lineseg)를 찾아 둔다 */
class LineTrack {
  pos = 0;
  readonly at = new Map<number, number>();
  constructor(
    private want: Set<number>,
    private size: () => number,
  ) {}
  /** 글자 n 개를 지나간다. text 를 주면 그 글자들이 그대로 내용이 되므로 사이의 줄 첫 자리도 찾는다 */
  step(n: number, text?: string) {
    if (this.want.size) {
      const base = this.size();
      if (text != null && text.length === n) {
        for (let k = 0; k < n; k++) if (this.want.has(this.pos + k)) this.at.set(this.pos + k, base + k);
      } else if (this.want.has(this.pos)) this.at.set(this.pos, base);
    }
    this.pos += n;
  }
  /** 문단 끝 (끝의 줄 바꿈 뒤 빈 줄) */
  end() {
    if (this.want.has(this.pos)) this.at.set(this.pos, this.size());
  }
}

export class HwpxConverter {
  settingsSet = false;
  outlineNumId = '1';
  counter = new NumberingCounter();
  private linkHref: string | null = null;
  private markpen: string | null = null;
  /** 한글이 배치해 둔 직전 문단 첫 줄의 세로 위치. 되돌아가면 한글이 새 쪽에 놓은 문단이다 */
  private lastVpos = 0;
  private topParas = 0;
  private pageMarks = new HwpPageMarks();

  /** 지금 구역의 용지 (없으면 문서 용지). 떠 있는 개체의 쪽·종이 기준 자리를 셈한다 */
  private secPage: PageSetup | null = null;
  /** 최상위 블록의 차례 (쪽 나누기가 한글 배치를 따를 수 있는지 — 중간에 지우거나 끼운 블록이 없는지 — 본다) */
  private seq = 0;
  /** 머리말·꼬리말을 읽는 중 (쪽 번호 필드를 {{PAGE}} 로) */
  private inHF = 0;
  /** 지금 문단이 놓인 쪽 (0부터; 쪽 나누기·한글의 새 쪽 표시로 센 어림값) */
  private pageNo = 0;
  /** 앞 본문 문단의 마지막 줄이 끝난 자리 (px, 쪽 본문 기준) */
  private prevEndV = 0;

  /** 구역이 바뀌면 쪽 세기를 새로 */
  startSection(page: PageSetup | null = null, newPage = false) {
    if (newPage) this.pageNo++;
    this.lastVpos = 0;
    this.topParas = 0;
    this.pageMarks.reset();
    this.secPage = page;
    this.prevEndV = 0;
  }

  /** 지금 구역 용지의 크기와 본문 자리 (px) */
  private pageGeom() {
    const p = this.secPage || this.settings.page;
    const W = (p.landscape ? Math.max(p.width, p.height) : p.width) * MM2PX;
    const H = (p.landscape ? Math.min(p.width, p.height) : p.height) * MM2PX;
    const ml = (p.marginLeft + p.gutter) * MM2PX;
    const mt = (p.marginTop + p.marginHeader) * MM2PX;
    return { W, H, ml, mt, bodyW: W - ml - p.marginRight * MM2PX, bodyH: H - mt - (p.marginBottom + p.marginFooter) * MM2PX };
  }

  /**
   * 떠 있는 개체(글자처럼 취급하지 않는 개체)의 자리: x 는 본문(칸) 왼쪽, y 는 문단 상자 위쪽 기준 px.
   * 글자처럼 취급하는 개체이거나 자리를 셈할 수 없으면 null (그러면 글 흐름 안에 놓는다)
   */
  private floatPos(el: Element, pp: ParaPr, segV: number[][], ctx: Ctx, pushed: (h: number, omB: number, vOff: number) => boolean): FloatPos | null {
    const pos = kid(el, 'pos');
    if (!pos || attr(pos, 'treatAsChar') === '1') return null;
    const sz = objSize(el);
    if (!sz.w || !sz.h) return null;
    const w = hwpToPx(sz.w);
    const h = hwpToPx(sz.h);
    const omB = hwpToPx(numAttr(kid(el, 'outMargin'), 'bottom', 0));
    const wrap = attr(el, 'textWrap') || 'SQUARE';
    // 칸·글상자 안에서 자리를 차지하는 개체는 칸의 내용 높이에 든다 (칸의 세로 맞춤이 그 높이로 정해진다): 흐름 안에 둔다
    if (ctx.inSub && wrap === 'TOP_AND_BOTTOM') return null;
    const vRel = ctx.inSub ? 'PARA' : attr(pos, 'vertRelTo') || 'PARA';
    const hRel = attr(pos, 'horzRelTo') || 'COLUMN';
    const vAl = attr(pos, 'vertAlign') || 'TOP';
    const hAl = attr(pos, 'horzAlign') || 'LEFT';
    const vOff = hwpToPx(i32Attr(pos, 'vertOffset', 0));
    const hOff = hwpToPx(i32Attr(pos, 'horzOffset', 0));
    const sb = pp.spaceBefore * PT2PX;
    const v0 = segV.length ? segV[0][0] : null;
    const g = this.pageGeom();
    let y: number;
    if (vRel === 'PARA') {
      // 자리를 차지하는 개체가 문단 첫 줄 자리에 걸치면 한글은 글을 개체 아래로 민다: 개체는 밀린 첫 줄 바로 위에 있다
      y = wrap === 'TOP_AND_BOTTOM' && pushed(h, omB, vOff) ? sb - omB - h : sb + vOff;
    } else {
      // 쪽(본문)·종이 기준: 문단 첫 줄의 쪽 안 위치를 알아야 한다
      if (v0 == null) return null;
      const refH = vRel === 'PAPER' ? g.H : g.bodyH;
      const top = vRel === 'PAPER' ? -g.mt : 0;
      const Y = top + (vAl === 'CENTER' ? (refH - h) / 2 + vOff : vAl === 'BOTTOM' || vAl === 'OUTSIDE' ? refH - h - vOff : vOff);
      y = Y - (v0 - sb);
    }
    const colW = ctx.inSub ? ctx.width ?? 0 : g.bodyW;
    let base = 0;
    let refW = colW;
    if (hRel === 'PARA') {
      base = pp.indentLeft * PT2PX;
      refW = colW - (pp.indentLeft + pp.indentRight) * PT2PX;
    } else if (hRel === 'PAPER' && !ctx.inSub) {
      base = -g.ml;
      refW = g.W;
    }
    // 폭을 모르면(칸 안) 왼쪽 맞춤으로
    const x = base + (!(refW > 0) ? hOff : hAl === 'CENTER' ? (refW - w) / 2 + hOff : hAl === 'RIGHT' || hAl === 'OUTSIDE' ? refW - w - hOff : hOff);
    return { x: r2(x), y: r2(y), ...(wrap === 'BEHIND_TEXT' ? { behind: true } : {}) };
  }

  constructor(
    private h: HeaderInfo,
    private images: Map<string, string>,
    public settings: DocSettings,
    public warnings: string[],
  ) {}

  convertParagraphs(ps: Element[], ctx: Ctx): JNode[] {
    const out: JNode[] = [];
    // 칸·글상자 안: 한글이 놓은 문단 사이가 줄 높이·문단 간격으로 셈한 것보다 벌어져 있으면(개체가 글을 밀어낸 자리 등)
    // 그만큼 문단 위를 띄운다. 본문(최상위)은 쪽 나누기가 한글의 세로 위치에 직접 맞춘다 (hwpTop)
    let prevEnd: number | null = 0;
    for (const p of ps) {
      const blocks = this.convertP(p, ctx);
      if (ctx.inSub) {
        const paras = blocks.filter((b) => b.type !== 'pageBreak' && !b.attrs?.float);
        const one = paras.length === 1 && paras[0].type === 'paragraph' ? paras[0] : null;
        const vs = one?.attrs?.hwpVs as number[][] | undefined;
        if (one && vs && vs.length) {
          const sb = (+one.attrs!.spaceBefore || 0) * PT2PX;
          const gap = prevEnd == null ? 0 : vs[0][0] - sb - prevEnd;
          if (gap > 0.5 && gap < 4000) one.attrs!.hwpGap = r2(gap);
          const last = vs[vs.length - 1];
          prevEnd = last[0] + last[1] + last[2] + (+one.attrs!.spaceAfter || 0) * PT2PX;
        } else prevEnd = null;
      }
      out.push(...blocks);
    }
    return out;
  }

  private numberPrefix(pp: ParaPr): string | null {
    if (pp.headingType === 'NONE') return null;
    if (pp.headingType === 'BULLET') return (this.h.bullets.get(pp.headingIdRef) || '•') + ' ';
    const numId = pp.headingType === 'OUTLINE' ? this.outlineNumId : pp.headingIdRef;
    const nb = this.h.numberings.get(numId);
    if (!nb) return null;
    const lvl = Math.max(0, Math.min(9, pp.headingLevel));
    const def = nb.levels[lvl];
    if (!def || !def.text) return null;
    const vals = this.counter.next(numId, lvl, def.start || 1);
    const fmts = nb.levels.map((l) => (l ? l.format : 'DIGIT'));
    return applyNumFormat(def.text, vals, fmts) + ' ';
  }

  convertP(p: Element, ctx: Ctx): JNode[] {
    const pp = this.h.paraPrs.get(attr(p, 'paraPrIDRef') || '0') || DEFAULT_PARA;
    const pAttrs = paraAttrs(pp);
    // 개요 문단: 차례 만들기가 제목으로 쓴다
    if (pp.headingType === 'OUTLINE') pAttrs.outlineLevel = Math.max(0, Math.min(9, pp.headingLevel)) + 1;
    if (ctx.bg && !pAttrs.paraBg) pAttrs.paraBg = ctx.bg;
    const blocks: JNode[] = [];
    const pageBreak = attr(p, 'pageBreak') === '1' || pp.pageBreakBefore;
    // 한글이 배치해 둔 줄: [줄 첫 글자 위치(textpos), 줄 폭(px)]. 화면에서 같은 자리에서 줄을 바꾸도록 문단에 넘긴다 (hwpMetrics)
    const segEls = kids(kid(p, 'linesegarray'), 'lineseg');
    const lineSegs: [number, number][] = segEls.map((s) => [numAttr(s, 'textpos', 0), hwpToPx(numAttr(s, 'horzsize', 0))]);
    /** 한글이 놓은 줄마다의 세로 자리 (px): [줄 위쪽(쪽 본문·칸 안), 줄 높이, 줄 아래 간격, 기준선] */
    const segV: number[][] = segEls.map((s) => ['vertpos', 'vertsize', 'spacing', 'baseline'].map((k) => r2(hwpToPx(i32Attr(s, k, 0)))));
    /** 떠 있는 개체: 문단 앞에 놓는 블록(글상자·표)과 문단 뒤에 놓는 표 */
    const before: JNode[] = [];
    const after: JNode[] = [];
    /** 글을 아래로 밀어낸 떠 있는 표 (문단 앞에 놓는다) */
    const leadTables: { node: JNode; h: number; omB: number; omT: number }[] = [];
    /** 문단에 보이는 글이 있는가. 자리를 차지하는 개체는 글 줄을 아래로 밀지만, 빈 문단의 줄은 그 자리에 둔 채 개체가 덮는다 */
    const hasText = kids(p, 'run').some((run) => kids(run, 't').some((t) => !!(t.textContent || '').trim()));
    /** 문단 뒤에 놓는 떠 있는 표의 쪽 안 위쪽 (문단 첫 줄 기준으로 셈한 것) */
    const tableTops = new Map<JNode, number>();
    /** 쪽 나누기 없이 한글이 새 쪽에 놓은 문단 (첫 줄의 세로 위치가 되돌아감) */
    let hwpPage = false;
    let vpos: number | null = null;
    if (!ctx.inSub) {
      vpos = segEls.length ? numAttr(segEls[0], 'vertpos', 0) : null;
      hwpPage = this.topParas++ > 0 && !pageBreak && vpos != null && vpos < this.lastVpos;
      // 다음 문단과는 이 문단 마지막 줄의 세로 위치로 견준다 (여러 줄 문단은 줄 사이에서 쪽이 바뀔 수 있다)
      if (segEls.length) this.lastVpos = numAttr(segEls[segEls.length - 1], 'vertpos', 0);
      if (pageBreak) blocks.push({ type: 'pageBreak' });
      if ((pageBreak || hwpPage) && this.seq > 0) this.pageNo++;
    }
    /** 앞 문단이 끝난 자리 (새 쪽이면 쪽 맨 위) */
    const prevEnd = hwpPage || pageBreak ? 0 : this.prevEndV;
    if (!ctx.inSub && segV.length) {
      const l = segV[segV.length - 1];
      this.prevEndV = l[0] + l[1] + l[2];
    }
    /**
     * 자리를 차지하는 개체(높이 h, 아래 바깥 여백 omB, 세로 오프셋 vOff)가 이 문단의 첫 줄을 아래로 밀어냈는가.
     * 한글 판에 따라 빈 문단의 줄을 개체 아래로 밀기도 하고(2018) 제자리에 둔 채 개체가 덮기도 하므로(2014),
     * 첫 줄이 앞 문단 끝에서 개체 높이만큼 떨어져 있는지로 가린다
     */
    const pushed = (h: number, omB: number, vOff: number): boolean => {
      if (!segV.length || vOff >= Math.max(4, segV[0][1])) return false;
      const v0 = segV[0][0];
      if (ctx.inSub) return v0 >= h + omB - 1;
      // 새 쪽으로 넘어온 문단: 쪽 맨 위가 아니면 앞 쪽에서 시작한 개체에 밀려 내려온 것
      if (hwpPage) return v0 > 4;
      return h > 4 && v0 - prevEnd >= 0.9 * h - 1;
    };
    let inline: JNode[] = [];
    let firstSize: number | null = null;
    let produced = false;
    const captions: Captions = { before: [], after: [] };
    this.markpen = null;
    const inlineSize = () => inline.reduce((s, nd) => s + (nd.type === 'text' ? (nd.text || '').length : 1), 0);
    const track = new LineTrack(new Set(lineSegs.map((s) => s[0])), inlineSize);

    const prefix = this.numberPrefix(pp);
    const flush = () => {
      if (!inline.length) return;
      blocks.push(paragraph({ ...pAttrs, fontSize: firstSize && firstSize !== 10 ? firstSize : null }, inline));
      inline = [];
      produced = true;
    };

    let prefixDone = !prefix;
    for (const run of kids(p, 'run')) {
      const cp = this.h.charPrs.get(attr(run, 'charPrIDRef') || '0');
      if (firstSize == null && cp) firstSize = cp.fontSize;
      if (!prefixDone) {
        const t = textNode(prefix!, charMarks(cp));
        if (t) inline.push(t);
        prefixDone = true;
      }
      for (const child of kids(run)) {
        const name = localName(child);
        if (name !== 't') track.step(8 * (name === 'ctrl' ? kids(child).length : 1));
        switch (name) {
          case 't':
            this.handleT(child, cp, inline, track);
            break;
          case 'tbl': {
            const t = this.convertTable(child);
            if (pAttrs.textAlign === 'center' || pAttrs.textAlign === 'right') t.attrs = { ...t.attrs, align: pAttrs.textAlign };
            const cap = this.caption(child);
            const tb = cap ? (cap.top ? [...cap.blocks, t] : [t, ...cap.blocks]) : [t];
            const tpos = kid(child, 'pos');
            if (segV.length && tpos && attr(tpos, 'treatAsChar') !== '1') {
              // 떠 있는 표는 문단의 글을 쪼개지 않는다. 글이 있는 문단의 첫 줄 자리에 걸친 표는 글을 아래로 밀어내므로 글보다 먼저 온다
              const tOff = hwpToPx(i32Attr(tpos, 'vertOffset', 0));
              const omT = hwpToPx(numAttr(kid(child, 'outMargin'), 'top', 0));
              const tH = hwpToPx(objSize(child).h);
              const tOmB = hwpToPx(numAttr(kid(child, 'outMargin'), 'bottom', 0));
              if (pushed(tH, tOmB, tOff)) {
                before.push(...tb);
                leadTables.push({ node: t, h: tH, omB: tOmB, omT });
              } else {
                // 빈 문단(줄은 제자리)이나 첫 줄 아래에 놓인 표: 문단 뒤에 두고, 한글이 놓은 자리(문단 첫 줄 + 세로 오프셋)를 적어 둔다
                after.push(...tb);
                const rel = ctx.inSub ? 'PARA' : attr(tpos, 'vertRelTo') || 'PARA';
                if (attr(tpos, 'vertAlign') === 'TOP' || !attr(tpos, 'vertAlign'))
                  tableTops.set(t, rel === 'PARA' ? segV[0][0] + tOff + omT : rel === 'PAPER' ? tOff + omT - this.pageGeom().mt : tOff + omT);
              }
            } else {
              flush();
              blocks.push(...tb);
              produced = true;
            }
            break;
          }
          case 'pic':
            {
              const pic = this.convertPic(child);
              const fp = this.floatPos(child, pp, segV, ctx, pushed);
              // 떠 있는 그림은 그 자리에 띄운다 (줄에 끼지 않는다). x 는 문단 상자 왼쪽 기준으로
              if (fp) pic.attrs = { ...pic.attrs, float: { ...fp, x: r2(fp.x - (pp.indentLeft + Math.max(0, -pp.textIndent)) * PT2PX) } };
              else if (attr(kid(child, 'pos'), 'treatAsChar') !== '1') pic.attrs = { ...pic.attrs, [FLOATING]: true };
              inline.push(pic);
            }
            this.addCaption(child, captions);
            break;
          case 'ole':
            inline.push(this.sizedPlaceholder(child, 'OLE 개체'));
            break;
          case 'equation': {
            const script = kid(child, 'script')?.textContent || '';
            if (script.trim()) inline.push({ type: 'math', attrs: { latex: hwpToLatex(script), hwp: script }, marks: charMarks(cp) });
            break;
          }
          case 'ctrl':
            this.handleCtrl(child, cp, inline);
            break;
          case 'secPr':
            this.handleSecPr(child);
            break;
          case 'container':
          case 'chart':
            flush();
            blocks.push(...this.convertContainer(child));
            this.addCaption(child, captions);
            produced = true;
            break;
          default:
            if (SHAPES.has(name)) {
              const fp = this.floatPos(child, pp, segV, ctx, pushed);
              const sub = this.convertShape(child, !!fp);
              if (sub.length && fp) {
                // 떠 있는 글상자·도형: 문단 앞에 높이 없는 블록으로 두고 그 자리에 띄운다
                sub[0].attrs = { ...sub[0].attrs, float: fp };
                before.push(...sub);
              } else if (sub.length) {
                flush();
                blocks.push(...sub);
                produced = true;
              }
              this.addCaption(child, captions);
            } else if (name === 'fieldBegin' || name === 'fieldEnd') {
              this.handleField(child);
            } else if (name === 'compose' || name === 'dutmal') {
              const t = textNode(child.textContent || '', charMarks(cp, this.linkHref));
              if (t) inline.push(t);
            }
        }
      }
    }
    track.end();
    const lineSize = inline.length && !produced ? inlineSize() : 0;
    if (inline.length) flush();
    else if (!produced) blocks.push(paragraph({ ...pAttrs, fontSize: firstSize && firstSize !== 10 ? firstSize : null }));
    // 문단이 표 등으로 쪼개지지 않고 줄 위치를 모두 찾았을 때만 (HWP 와 같게). 첫 줄은 문단 번호(머리 글자)부터
    track.at.set(0, 0);
    // 떠 있는 개체 표시는 늘 지운다 (문서 노드에는 없는 속성)
    const floating = blocks.map(takeFloating).some(Boolean);
    let paras = blocks.filter((b) => b.type !== 'pageBreak');
    // 글자처럼 취급하는 표·글상자 하나와 빈칸뿐인 글: 한글에서는 한 줄(개체 높이)이다. 빈칸 문단을 따로 세우면 줄이 하나 더 생긴다
    if (segV.length === 1 && paras.length > 1) {
      const objs = paras.filter((b) => b.type !== 'paragraph');
      const blank = (b: JNode) => b.type === 'paragraph' && (b.content || []).every((n) => n.type === 'text' && !(n.text || '').trim());
      if (objs.length === 1 && paras.every((b) => b === objs[0] || blank(b))) {
        // 표 앞의 빈칸은 표를 그만큼 오른쪽으로 민다
        indentByBlanks(objs[0], paras.slice(0, paras.indexOf(objs[0])));
        paras = objs;
      }
    }
    /** 한글의 줄 정보가 가리키는 블록: 글 문단 하나이거나, 글자처럼 취급하는 표·글상자 하나 */
    const one = paras.length === 1 ? paras[0] : null;
    if (one && one.type === 'paragraph' && segV.length && !floating) {
      const a: Record<string, any> = { ...one.attrs, hwpLen: jsonContentSize(one) };
      if (lineSize && lineSegs.every((s) => track.at.has(s[0]))) a.hwpLines = lineSegs.map((s) => [track.at.get(s[0])!, r2(s[1])]);
      // 줄 높이·기준선: 줄 자리를 모두 알거나 한 줄뿐인 문단 (빈 문단 포함)
      if (a.hwpLines || segV.length === 1) a.hwpVs = segV;
      one.attrs = a;
    }
    if (!ctx.inSub) {
      // 본문: 블록의 쪽 안 세로 위치(테두리 상자의 위쪽). 쪽 나누기가 그 자리에 맞춘다
      const v0 = segV.length ? segV[0][0] : null;
      let lead: JNode | null = null;
      if (one && v0 != null) {
        const sb = one.type === 'paragraph' ? pp.spaceBefore * PT2PX : 0;
        const omT = one.type === 'table' ? +(one.attrs?.outMargin?.[2] || 0) : 0;
        one.attrs = { ...one.attrs, hwpTop: r2(v0 - sb + omT) };
        lead = one;
        // 떠 있는 글상자·도형은 문단 상자와 같은 자리에서 시작한다
        for (const b of before) if (b.attrs?.float) b.attrs = { ...b.attrs, hwpTop: r2(v0 - sb) };
        // 글을 밀어낸 표는 앞 블록 바로 뒤로 흐른다: 한글이 적어 둔 표 높이(sz)는 여러 쪽에 걸친 표에서 실제 높이와 달라
        // 표의 위쪽을 거꾸로 셈할 수 없다. 새 쪽 표시도 글 문단이 갖는다 (표는 앞 쪽에서 시작했을 수 있다)
        if (leadTables.length && one.type === 'paragraph' && !hwpPage) {
          // 밀린 첫 줄 바로 위에서부터 거꾸로 쌓아 올린다 (표가 여럿이면 차례로 위에)
          let y = v0 - sb;
          const tops: number[] = [];
          for (let k = leadTables.length - 1; k >= 0; k--) {
            y -= leadTables[k].omB + leadTables[k].h;
            tops[k] = y;
            y -= leadTables[k].omT;
          }
          if (y >= prevEnd - 2) leadTables.forEach((t, k) => (t.node.attrs = { ...t.node.attrs, hwpTop: r2(Math.max(0, tops[k])) }));
        }
        lead = [...before.filter((x) => x.attrs?.float), one].find((x) => x.attrs?.hwpTop != null) || one;
      }
      for (const [t, top] of tableTops) if (top > -1) t.attrs = { ...t.attrs, hwpTop: r2(Math.max(0, top)) };
      const group = placeCaptions([...blocks.filter((b) => b.type === 'pageBreak'), ...before, ...paras, ...after], captions);
      for (const b of group) {
        if (b.type === 'pageBreak') continue;
        b.attrs = { ...b.attrs, hwpSeq: ++this.seq };
        if (b.attrs.hwpLen == null) b.attrs.hwpLen = jsonContentSize(b);
      }
      this.pageMarks.mark(lead || group.find((b) => b.type !== 'pageBreak'), vpos, hwpPage);
      return group;
    }
    return placeCaptions([...before, ...paras, ...after], captions);
  }

  /** 개체의 캡션 (hp:caption, side 가 TOP 이면 개체 위) */
  private caption(el: Element): Caption | null {
    const cap = kid(el, 'caption');
    const ps = kids(kid(cap, 'subList'), 'p');
    if (!cap || !ps.length) return null;
    return { top: attr(cap, 'side') === 'TOP', blocks: this.convertParagraphs(ps, { inSub: true }) };
  }

  /** 문단 안 개체의 캡션을 문단 앞뒤에 놓도록 모은다 */
  private addCaption(el: Element, captions: Captions) {
    const cap = this.caption(el);
    if (cap) (cap.top ? captions.before : captions.after).push(...cap.blocks);
  }

  private handleT(t: Element, cp: CharPr | undefined, inline: JNode[], track: LineTrack) {
    const push = (s: string) => {
      const n = textNode(s, charMarks(cp, this.linkHref, this.markpen));
      if (n) inline.push(n);
    };
    for (let n = t.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 3 || n.nodeType === 4) {
        track.step((n.nodeValue || '').length, n.nodeValue || '');
        push(n.nodeValue || '');
        continue;
      }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      const ln = localName(el);
      track.step(T_WIDTH[ln] ?? (el.textContent || '').length, ln in T_WIDTH ? undefined : el.textContent || '');
      switch (ln) {
        case 'tab': {
          // 탭은 폭(HWPUNIT)·채움·종류를 가진다 → 탭 글자 하나에 마크로 붙인다
          const tw = numAttr(el, 'width', 0);
          const n = textNode('\t', [
            ...charMarks(cp, this.linkHref, this.markpen),
            { type: 'tab', attrs: { width: tw > 0 ? Math.round(hwpToPx(tw) * 100) / 100 : null, leader: numAttr(el, 'leader', 0), type: numAttr(el, 'type', 0) } },
          ]);
          if (n) inline.push(n);
          break;
        }
        case 'lineBreak':
          inline.push({ type: 'hardBreak' });
          break;
        case 'nbSpace':
          push(' ');
          break;
        case 'fwSpace':
          push(String.fromCharCode(FIXED_SPACE));
          break;
        case 'hyphen':
          push('-');
          break;
        case 'markpenBegin':
          this.markpen = normColor(attr(el, 'color')) || '#FFFF00';
          break;
        case 'markpenEnd':
          this.markpen = null;
          break;
        default:
          if (el.textContent) push(el.textContent);
      }
    }
  }

  private handleField(el: Element) {
    if (localName(el) === 'fieldEnd') {
      this.linkHref = null;
      return;
    }
    if (attr(el, 'type') !== 'HYPERLINK') return;
    let href: string | null = null;
    for (const sp of descendants(el, 'stringParam')) {
      const nm = attr(sp, 'name');
      if (nm === 'Path' && sp.textContent) href = sp.textContent;
      else if (nm === 'Command' && !href && sp.textContent) href = sp.textContent.split(';')[0].replace(/\\:/g, ':');
    }
    this.linkHref = href;
  }

  private handleCtrl(ctrl: Element, cp: CharPr | undefined, inline: JNode[]) {
    for (const c of kids(ctrl)) {
      const name = localName(c);
      switch (name) {
        case 'header':
        case 'footer': {
          // 쪽 종류: 양쪽(BOTH)·홀수(ODD)는 기본 자리에, 짝수(EVEN)는 even 에. 같은 종류가 또 나오면(뒤 구역) 먼저 것을 둔다
          const type = attr(c, 'applyPageType') || 'BOTH';
          const main = name === 'header' ? this.settings.header : this.settings.footer;
          const mainSet = !!(main.text || main.content);
          let target: typeof main;
          if (type === 'EVEN') {
            if (main.even) break;
            target = main.even = { text: '', align: 'center' };
            // 짝수 쪽 것만 있는 문서: 홀수 쪽에는 없다 → 기본 자리를 비워 둔 채 둔다
          } else {
            if (mainSet) break;
            target = main;
            if (type === 'ODD') main.oddOnly = true;
          }
          // 머리말이 시작하는 쪽 (첫 구역이 아니면 앞 쪽들에는 없다)
          if (main.from == null || this.pageNo < main.from) main.from = this.pageNo;
          const sub = kid(c, 'subList');
          const ps = kids(sub, 'p');
          const text = ps.map((p) => this.plainText(p, true)).join(' ').trim();
          if (text) {
            target.text = text;
            const pp = this.h.paraPrs.get(attr(ps[0], 'paraPrIDRef') || '0');
            target.align = pp?.align === 'right' ? 'right' : pp?.align === 'left' ? 'left' : 'center';
          }
          // 글자 모양·정렬·표·그림까지 한글 그대로 그리도록 문단 블록도 담는다 (쪽 번호는 {{PAGE}})
          this.inHF++;
          let rich: JNode[] = [];
          try {
            rich = this.convertParagraphs(ps, { inSub: true, width: this.pageGeom().bodyW }).map(stripLayout);
          } finally {
            this.inHF--;
          }
          const hasObj = (n: JNode): boolean => n.type === 'table' || n.type === 'image' || n.type === 'textBox' || (n.content || []).some(hasObj);
          if (text || rich.some(hasObj)) target.content = rich as any;
          else delete target.content;
          const hva = attr(sub, 'vertAlign');
          if (hva === 'BOTTOM') target.valign = 'bottom';
          else if (hva === 'CENTER') target.valign = 'middle';
          else delete target.valign;
          break;
        }
        case 'newNum': {
          // 새 번호로 시작 (쪽 번호): 이 문단이 있는 쪽이 그 번호가 된다
          if ((attr(c, 'numType') || 'PAGE') === 'PAGE') {
            this.settings.pageNumber.start = Math.max(1, numAttr(c, 'num', 1));
            if (this.pageNo > 0) this.settings.pageNumber.base = this.pageNo;
          }
          break;
        }
        case 'pageHiding': {
          // 감추기: 이 문단이 있는 쪽에서만 머리말·꼬리말·쪽 번호를 감춘다. 첫 쪽(표지)의 것만 따른다
          if (this.pageNo === 0) {
            const h = { header: attr(c, 'hideHeader') === '1', footer: attr(c, 'hideFooter') === '1', pageNum: attr(c, 'hidePageNum') === '1' };
            if (h.header || h.footer || h.pageNum) this.settings.hideFirst = { ...this.settings.hideFirst, ...Object.fromEntries(Object.entries(h).filter(([, v]) => v)) };
          }
          break;
        }
        case 'pageNum': {
          const pos = (attr(c, 'pos') || 'BOTTOM_CENTER').toLowerCase().replace('_', '-');
          const valid = ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'];
          const ft = attr(c, 'formatType') || 'DIGIT';
          const side = attr(c, 'sideChar') || '';
          // 위치 '없음'(NONE)은 쪽 번호를 찍지 않는다
          this.settings.pageNumber.pos = (pos === 'none' ? 'none' : valid.includes(pos) ? pos : pos.startsWith('top') ? 'top-center' : 'bottom-center') as any;
          this.settings.pageNumber.format =
            ft === 'ROMAN_SMALL' ? 'roman' : ft === 'ROMAN_CAPITAL' ? 'ROMAN' : side === '-' ? 'dash' : 'digit';
          // 쪽 번호 매기기가 뒤 구역에서 시작하면 앞 쪽들에는 찍지 않는다
          if (this.pageNo > 0 && pos !== 'none') this.settings.pageNumber.from = this.pageNo;
          break;
        }
        case 'footNote':
        case 'endNote': {
          const ps = kids(kid(c, 'subList'), 'p');
          const text = ps
            .map((p) => this.plainText(p, false))
            .join(' ')
            .trim();
          inline.push({ type: 'footnote', attrs: { text } });
          break;
        }
        case 'fieldBegin':
        case 'fieldEnd':
          this.handleField(c);
          break;
        case 'autoNum': {
          const t = attr(c, 'numType') === 'PAGE' ? (this.inHF ? '{{PAGE}}' : '') : attr(c, 'num') || '';
          const n = textNode(t, charMarks(cp, this.linkHref));
          if (n) inline.push(n);
          break;
        }
      }
    }
  }

  /** 머리말/각주 등의 순수 텍스트 */
  plainText(p: Element, pageToken: boolean): string {
    let s = '';
    for (const run of kids(p, 'run')) {
      for (const c of kids(run)) {
        const name = localName(c);
        if (name === 't') {
          for (let n = c.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 3) s += n.nodeValue;
            else if (n.nodeType === 1) {
              const ln = localName(n);
              if (ln === 'tab') s += '\t';
              else if (ln === 'lineBreak') s += ' ';
              else s += n.textContent || '';
            }
          }
        } else if (name === 'ctrl') {
          for (const cc of kids(c)) {
            if (localName(cc) === 'autoNum' && attr(cc, 'numType') === 'PAGE' && pageToken) s += '{{PAGE}}';
          }
        }
      }
    }
    return s;
  }

  private handleSecPr(sec: Element) {
    const ol = attr(sec, 'outlineShapeIDRef');
    if (ol) this.outlineNumId = ol;
    if (this.settingsSet) return;
    const pg = pageOfSecPr(sec, this.settings.page);
    if (!pg) return;
    this.settingsSet = true;
    this.settings.page = pg;
  }

  private sizedPlaceholder(el: Element, label: string): JNode {
    const sz = objSize(el);
    const w = Math.max(40, Math.round(hwpToPx(sz.w || 12000)));
    const h = Math.max(20, Math.round(hwpToPx(sz.h || 6000)));
    return { type: 'image', attrs: { src: placeholderImage(label, w, h), width: w, height: h, alt: label } };
  }

  convertPic(pic: Element): JNode {
    const img = descendant(pic, 'img');
    const ref = attr(img, 'binaryItemIDRef') || '';
    const sz = objSize(pic);
    const w = Math.max(1, Math.round(hwpToPx(sz.w || 7500)));
    const h = Math.max(1, Math.round(hwpToPx(sz.h || 7500)));
    let src = this.images.get(ref);
    if (!src) {
      this.warnings.push(`그림을 찾을 수 없음: ${ref}`);
      src = placeholderImage('그림 없음', w || 100, h || 60);
    }
    // 자르기: imgClip은 원본(imgDim) 좌표
    const dim = kid(pic, 'imgDim');
    const org = kid(pic, 'orgSz');
    const dw = numAttr(dim, 'dimwidth', 0) || numAttr(org, 'width', 0);
    const dh = numAttr(dim, 'dimheight', 0) || numAttr(org, 'height', 0);
    const clip = kid(pic, 'imgClip');
    let crop = null;
    if (clip && dw && dh) {
      crop = normCrop(numAttr(clip, 'top', 0) / dh, 1 - numAttr(clip, 'right', dw) / dw, 1 - numAttr(clip, 'bottom', dh) / dh, numAttr(clip, 'left', 0) / dw);
    }
    // 돌린 그림 (한글은 사진의 방향 정보를 따르지 않고 개체를 돌려 둔다)
    const angle = ((Math.round(numAttr(kid(pic, 'rotationInfo'), 'angle', 0)) % 360) + 360) % 360;
    return { type: 'image', attrs: { src, width: w || null, height: h || null, crop, ...(angle ? { rotate: angle } : {}) } };
  }

  /** 글상자 등 도형 → 글상자 노드 (크기·테두리·배경을 가진 상자 안의 문단) */
  convertShape(shape: Element, floating = false): JNode[] {
    const dt = kid(shape, 'drawText');
    const name = localName(shape);
    // 글이 없는 도형은 떠 있는 사각형·타원만 그린다 (흐름 안에서는 자리만 차지하므로 뺀다)
    if (!dt && !(floating && (name === 'rect' || name === 'ellipse'))) return [];
    const fill = kid(shape, 'fillBrush');
    const wb = kid(fill, 'winBrush');
    let bg = normColor(attr(wb, 'faceColor'));
    if (bg === '#FFFFFF' && !floating) bg = null;
    const sz = objSize(shape);
    const w = Math.round(hwpToPx(sz.w)) || null;
    const h = Math.round(hwpToPx(sz.h)) || null;
    const tm0 = kid(dt, 'textMargin');
    const innerW = w ? w - hwpToPx(numAttr(tm0, 'left', 283) + numAttr(tm0, 'right', 283)) : undefined;
    const ps = dt ? kids(kid(dt, 'subList'), 'p') : [];
    const content = this.convertParagraphs(ps, { inSub: true, width: innerW });
    const va = attr(kid(dt, 'subList'), 'vertAlign');
    const ls = kid(shape, 'lineShape');
    const lineStyle = attr(ls, 'style');
    const borderColor = ls && lineStyle !== 'NONE' && numAttr(ls, 'width', 1) > 0 ? normColor(attr(ls, 'color')) || '#000000' : null;
    // 선 굵기 단위는 0.01mm
    const borderWidth = borderColor ? Math.max(0.75, Math.min(8, numAttr(ls, 'width', 12) * 0.0378)) : null;
    const tm = kid(dt, 'textMargin');
    const padding = tm ? ['top', 'right', 'bottom', 'left'].map((k) => Math.round(hwpToPx(numAttr(tm, k, 283)))) : null;
    let radius: string | null = null;
    if (name === 'ellipse') radius = '50%';
    else {
      const ratio = numAttr(shape, 'ratio', 0);
      if (ratio > 0 && w && h) radius = `${Math.round((Math.min(w, h) * Math.min(50, ratio)) / 200)}px`;
    }
    const ib = kid(fill, 'imgBrush');
    const bgImage = ib ? this.images.get(attr(kid(ib, 'img'), 'binaryItemIDRef') || '') || null : null;
    const attrs: Record<string, any> = { width: w, height: h, bg, bgImage, borderColor, borderWidth, radius, padding };
    if (va === 'CENTER') attrs.valign = 'middle';
    else if (va === 'BOTTOM') attrs.valign = 'bottom';
    return [{ type: 'textBox', attrs, content: content.length ? content : [paragraph()] }];
  }

  convertContainer(c: Element): JNode[] {
    const out: JNode[] = [];
    for (const ch of kids(c)) {
      const name = localName(ch);
      if (name === 'pic') out.push(paragraph({ textAlign: 'center' }, [this.convertPic(ch)]));
      else if (name === 'container') out.push(...this.convertContainer(ch));
      else if (SHAPES.has(name)) out.push(...this.convertShape(ch));
    }
    return out;
  }

  convertTable(tbl: Element): JNode {
    type Cell = { row: number; col: number; cs: number; rs: number; w: number; node: JNode };
    const cells: Cell[] = [];
    const rowCnt = numAttr(tbl, 'rowCnt', 0);
    const rowH: number[] = [];
    /** 여러 줄을 합친 칸: 첫 줄, 줄 수, 칸 높이(HWPUNIT). 낱칸이 없는 줄의 높이를 여기서 거꾸로 셈한다 */
    const spans: { row: number; rs: number; h: number; need: number; last: JNode | null }[] = [];
    kids(tbl, 'tr').forEach((tr, ri) => {
      kids(tr, 'tc').forEach((tc, ci) => {
        const addr = kid(tc, 'cellAddr');
        const span = kid(tc, 'cellSpan');
        const sz = kid(tc, 'cellSz');
        const sub = kid(tc, 'subList');
        const row = addr ? numAttr(addr, 'rowAddr', ri) : ri;
        const col = addr ? numAttr(addr, 'colAddr', ci) : ci;
        const cs = Math.max(1, Math.min(512, numAttr(span, 'colSpan', 1)));
        const rs = Math.max(1, Math.min(4096, numAttr(span, 'rowSpan', 1)));
        const w = hwpToPx(numAttr(sz, 'width', 0));
        if (rs === 1) rowH[row] = Math.max(rowH[row] || 0, hwpToPx(numAttr(sz, 'height', 0) - CELL_VMARGIN_HWP));
        else spans.push({ row, rs, h: numAttr(sz, 'height', 0), need: 0, last: null });
        const bf = this.h.borderFills.get(attr(tc, 'borderFillIDRef') || '');
        const cmw = kid(tc, 'cellMargin');
        let content = this.convertParagraphs(kids(sub, 'p'), { inSub: true, width: w - hwpToPx(numAttr(cmw, 'left', 510) + numAttr(cmw, 'right', 510)) });
        content = content.filter((n) => n.type !== 'pageBreak');
        if (!content.length) content = [paragraph()];
        // 적힌 칸 높이가 글(마지막 줄의 글자 높이까지)보다 작으면 한글은 칸 높이를 내용으로 새로 셈하고, 그때는 마지막 줄 간격과
        // 문단 아래 간격까지 넣는다. 칸 높이가 유효하면 그 높이를 지키고 마지막 줄 뒤 간격은 세지 않는다
        {
          const lastP = content[content.length - 1];
          const vs = lastP.type === 'paragraph' ? (lastP.attrs?.hwpVs as number[][] | undefined) : undefined;
          if (vs && vs.length) {
            const l = vs[vs.length - 1];
            const vm = hwpToPx(numAttr(cmw, 'top', 141) + numAttr(cmw, 'bottom', 141));
            const textOnly = l[0] + l[1] + vm;
            if (hwpToPx(numAttr(sz, 'height', 0)) < textOnly - 1) {
              lastP.attrs = { ...lastP.attrs, hwpTrail: true };
              // 여러 줄을 합친 칸: 내용이 요구하는 높이 (마지막 줄 간격·문단 아래 간격 포함). 모자란 만큼은 합친 마지막 줄이 늘어난다
              if (rs > 1) {
                const sp = spans[spans.length - 1];
                sp.need = textOnly + l[2] + (+lastP.attrs.spaceAfter || 0) * PT2PX;
                sp.last = lastP;
              }
            }
          }
        }
        const va = attr(sub, 'vertAlign');
        const attrs: Record<string, any> = { colspan: cs, rowspan: rs, colwidth: null };
        if (bf?.bg) attrs.backgroundColor = bf.bg;
        if (bf?.gradient) attrs.bgGradient = bf.gradient;
        const fillSrc = bf?.img ? this.images.get(bf.img.id) : null;
        if (fillSrc && bf?.img) attrs.bgImages = [{ src: fillSrc, fit: imgFillFit(bf.img.mode) }];
        if (bf && bf.noBorders.length) attrs.borderStyle = bf.noBorders.join(' ');
        if (bf?.diag) attrs.diag = bf.diag;
        if (bf?.css) attrs.borderCss = bf.css;
        if (va === 'TOP') attrs.verticalAlign = 'top';
        else if (va === 'BOTTOM') attrs.verticalAlign = 'bottom';
        const cm = kid(tc, 'cellMargin');
        if (attr(tc, 'hasMargin') === '1' && cm) attrs.margins = ['left', 'right', 'top', 'bottom'].map((k) => Math.round(hwpToPx(numAttr(cm, k, 0)) * 10) / 10);
        // 제목 칸이고 표가 제목 줄을 되풀이하면 제목 칸으로 (쪽이 바뀌면 되풀이된다)
        const head = attr(tbl, 'repeatHeader') === '1' && attr(tc, 'header') === '1';
        cells.push({ row, col, cs, rs, w, node: { type: head ? 'tableHeader' : 'tableCell', attrs, content } });
      });
    });
    // 셀 영역(여러 칸에 걸친 테두리·대각선): 영역 전체를 가로지르는 대각선을 칸마다 제 몫만큼 그리고, 영역 안쪽 경계선은 없앤다
    for (const z of kids(kid(tbl, 'cellzoneList'), 'cellzone')) {
      const zbf = this.h.borderFills.get(attr(z, 'borderFillIDRef') || '');
      if (!zbf?.diag) continue;
      const r0 = numAttr(z, 'startRowAddr', 0);
      const r1 = numAttr(z, 'endRowAddr', r0);
      const c0 = numAttr(z, 'startColAddr', 0);
      const c1 = numAttr(z, 'endColAddr', c0);
      const inZ = cells.filter((c) => c.row >= r0 && c.row <= r1 && c.col >= c0 && c.col <= c1);
      if (!inZ.length || inZ.length > 400) continue;
      const rowHt = (r: number) => (rowH[r] ?? 16) + hwpToPx(CELL_VMARGIN_HWP);
      const span = (from: number, n: number) => { let t = 0; for (let r = from; r < from + n; r++) t += rowHt(r); return t; };
      const zoneH = span(r0, r1 - r0 + 1);
      const zoneW = Math.max(...[...new Set(inZ.map((c) => c.row))].map((r) => inZ.filter((c) => c.row === r).reduce((a, c) => a + c.w, 0)));
      for (const c of inZ) {
        const x = inZ.filter((k) => k.row === c.row && k.col < c.col).reduce((a, k) => a + k.w, 0);
        const y = span(r0, c.row - r0);
        const ch = span(c.row, c.rs);
        const pct = (v: number) => Math.round(v * 100) / 100;
        c.node.attrs!.diag = {
          ...zbf.diag,
          zw: pct((zoneW / Math.max(1, c.w)) * 100),
          zh: pct((zoneH / Math.max(1, ch)) * 100),
          px: zoneW - c.w > 0.5 ? pct((x / (zoneW - c.w)) * 100) : 0,
          py: zoneH - ch > 0.5 ? pct((y / (zoneH - ch)) * 100) : 0,
        };
        const hide = new Set(String(c.node.attrs!.borderStyle || '').split(' ').filter(Boolean));
        if (c.col > c0) hide.add('l');
        if (c.col + c.cs - 1 < c1) hide.add('r');
        if (c.row > r0) hide.add('t');
        if (c.row + c.rs - 1 < r1) hide.add('b');
        if (hide.size) c.node.attrs!.borderStyle = [...hide].join(' ');
      }
    }
    // 낱칸이 없는 줄(합친 칸으로만 덮인 줄): 합친 칸의 높이에서 아는 줄들의 높이를 빼 구한다 (모르는 줄이 하나 남을 때마다)
    for (let pass = 0; pass < spans.length + 1; pass++) {
      let found = false;
      for (const sp of spans) {
        const unknown: number[] = [];
        let known = 0;
        for (let r = sp.row; r < sp.row + sp.rs; r++) {
          if (rowH[r] == null) unknown.push(r);
          else known += rowH[r] + hwpToPx(CELL_VMARGIN_HWP);
        }
        if (unknown.length !== 1) continue;
        const h = hwpToPx(sp.h) - known;
        if (h > 0) {
          rowH[unknown[0]] = Math.max(0.1, h - hwpToPx(CELL_VMARGIN_HWP));
          found = true;
        }
      }
      if (!found) break;
    }
    // 합친 칸의 내용이 덮은 줄들의 높이보다 크면 한글은 합친 마지막 줄을 늘린다 (브라우저는 줄마다 나눠 늘려 다른 칸이 커진다)
    for (const sp of spans) {
      if (!(sp.need > 0)) continue;
      let sum = 0;
      let all = true;
      for (let r = sp.row; r < sp.row + sp.rs; r++) {
        if (rowH[r] == null) all = false;
        else sum += rowH[r] + hwpToPx(CELL_VMARGIN_HWP);
      }
      const lastRow = sp.row + sp.rs - 1;
      if (all && sp.need > sum + 1) rowH[lastRow] += sp.need - sum;
    }
    const t = assembleTable(cells, rowCnt, numAttr(tbl, 'colCnt', 0), hwpToPx(numAttr(kid(tbl, 'sz'), 'width', 0)), rowH);
    const rows = t.content!;
    const inM = kid(tbl, 'inMargin');
    const tAttrs: Record<string, any> = {};
    if (inM) tAttrs.cellPadding = Math.round(hwpToPx((numAttr(inM, 'left', 510) + numAttr(inM, 'right', 510)) / 2) * 10) / 10;
    const pos = kid(tbl, 'pos');
    if (attr(pos, 'treatAsChar') === '1') tAttrs.inline = true;
    const outM = kid(tbl, 'outMargin');
    if (outM) tAttrs.outMargin = ['left', 'right', 'top', 'bottom'].map((k) => Math.round(hwpToPx(numAttr(outM, k, 283)) * 10) / 10);
    // 떠 있는 표(글자처럼 취급 아님)가 문단 기준으로 아래로 떨어져 있으면 그만큼 위 여백으로 (Kite 에는 떠 있는 개체가 없다)
    if (!tAttrs.inline && pos && attr(pos, 'vertRelTo') === 'PARA') {
      const vOff = hwpToPx(numAttr(pos, 'vertOffset', 0));
      if (vOff > 0.5) {
        const m = tAttrs.outMargin || [0, 0, 0, 0];
        tAttrs.outMargin = [m[0], m[1], Math.round((m[2] + vOff) * 10) / 10, m[3]];
      }
    }
    const out: JNode = { type: 'table', attrs: tAttrs, content: rows };
    fitTableLines(out);
    return out;
  }
}

/** 구역 정의(hp:secPr)의 편집 용지. 없으면 null (base 의 값을 기본으로) */
function pageOfSecPr(sec: Element, base: PageSetup): PageSetup | null {
  const pagePr = kid(sec, 'pagePr');
  if (!pagePr) return null;
  const m = kid(pagePr, 'margin');
  const pg: PageSetup = { ...base };
  pg.width = round(hwpToMm(numAttr(pagePr, 'width', 59528)), 1);
  pg.height = round(hwpToMm(numAttr(pagePr, 'height', 84188)), 1);
  pg.landscape = attr(pagePr, 'landscape') === 'NARROWLY';
  if (m) {
    pg.marginLeft = round(hwpToMm(numAttr(m, 'left', 8504)), 1);
    pg.marginRight = round(hwpToMm(numAttr(m, 'right', 8504)), 1);
    pg.marginTop = round(hwpToMm(numAttr(m, 'top', 5668)), 1);
    pg.marginBottom = round(hwpToMm(numAttr(m, 'bottom', 4252)), 1);
    pg.marginHeader = round(hwpToMm(numAttr(m, 'header', 4252)), 1);
    pg.marginFooter = round(hwpToMm(numAttr(m, 'footer', 4252)), 1);
    pg.gutter = round(hwpToMm(numAttr(m, 'gutter', 0)), 1);
  }
  return pg;
}

// ---------------- 패키지 ----------------
async function zipText(zip: JSZip, path: string): Promise<string | null> {
  let f = zip.file(path);
  if (!f) {
    const lower = path.toLowerCase();
    const name = Object.keys(zip.files).find((n) => n.toLowerCase() === lower);
    if (name) f = zip.file(name);
  }
  return f ? readZipEntry(f, 'string') : null;
}

export async function readHwpx(data: Uint8Array): Promise<LoadedDoc> {
  const zip = await JSZip.loadAsync(data);
  assertZipBudget(zip);
  const warnings: string[] = [];
  let hpfPath = 'Contents/content.hpf';
  const containerXml = await zipText(zip, 'META-INF/container.xml');
  if (containerXml) {
    const rf = descendants(parseXml(containerXml), 'rootfile').find((r) => /\.hpf$/i.test(attr(r, 'full-path') || ''));
    if (rf) hpfPath = attr(rf, 'full-path')!;
  }
  const hpfXml = await zipText(zip, hpfPath);
  const items = new Map<string, { href: string; type: string }>();
  const spine: string[] = [];
  const meta: DocMeta = {};
  if (hpfXml) {
    const hpf = parseXml(hpfXml);
    for (const it of descendants(hpf, 'item')) items.set(attr(it, 'id') || '', { href: attr(it, 'href') || '', type: attr(it, 'media-type') || '' });
    for (const ir of descendants(hpf, 'itemref')) spine.push(attr(ir, 'idref') || '');
    meta.title = descendant(hpf, 'title')?.textContent || undefined;
    for (const m of descendants(hpf, 'meta')) {
      const nm = attr(m, 'name');
      if (nm === 'creator') meta.author = m.textContent || undefined;
      else if (nm === 'subject') meta.subject = m.textContent || undefined;
      else if (nm === 'keyword') meta.keywords = m.textContent || undefined;
      else if (nm === 'CreatedDate') meta.created = m.textContent || undefined;
      else if (nm === 'ModifiedDate') meta.modified = m.textContent || undefined;
    }
  }
  const hpfDir = hpfPath.includes('/') ? hpfPath.slice(0, hpfPath.lastIndexOf('/') + 1) : '';
  const resolve = (href: string) => (zip.file(href) ? href : zip.file(hpfDir + href) ? hpfDir + href : href);

  // 그림
  const images = new Map<string, string>();
  for (const [id, it] of items) {
    const path = resolve(it.href);
    if (!/^BinData\//i.test(path) && !it.type.startsWith('image')) continue;
    const f = zip.file(path);
    if (!f) continue;
    const ext = path.split('.').pop() || '';
    const mime = it.type && it.type.startsWith('image/') && it.type !== 'image/jpg' ? it.type : mimeFromExt(ext);
    if (isBrowserImage(mime)) images.set(id, bytesToDataUrl(await readZipEntry(f, 'uint8array'), mime));
    else images.set(id, placeholderImage(`그림(${ext.toUpperCase()})`));
  }

  // 헤더
  const headerItem = items.get('header') || [...items.values()].find((i) => /header\.xml$/i.test(i.href));
  const headerXml = await zipText(zip, headerItem ? resolve(headerItem.href) : 'Contents/header.xml');
  const header = headerXml
    ? parseHeader(parseXml(headerXml))
    : { fonts: new Map(), charPrs: new Map(), paraPrs: new Map(), borderFills: new Map(), numberings: new Map(), bullets: new Map(), styles: new Map() };

  // 구역
  let sectionPaths = spine
    .map((id) => items.get(id))
    .filter((i): i is { href: string; type: string } => !!i && /section\d+\.xml$/i.test(i.href))
    .map((i) => resolve(i.href));
  if (!sectionPaths.length) {
    sectionPaths = Object.keys(zip.files)
      .filter((n) => /Contents\/section\d+\.xml$/i.test(n))
      .sort((a, b) => parseInt(a.replace(/\D/g, ''), 10) - parseInt(b.replace(/\D/g, ''), 10));
  }
  const settings = defaultSettings();
  settings.hwpMetrics = true;
  const conv = new HwpxConverter(header, images, settings, warnings);
  const blocks: JNode[] = [];
  for (let i = 0; i < sectionPaths.length; i++) {
    const xml = await zipText(zip, sectionPaths[i]);
    if (!xml) continue;
    const sec = parseXml(xml).documentElement;
    // 구역 나누기: 구역마다 용지가 다를 수 있으므로 쪽 나누기에 이 구역의 용지를 담는다
    const secPr = descendant(sec, 'secPr');
    const secPage = i > 0 && secPr ? pageOfSecPr(secPr, settings.page) : null;
    if (i > 0 && blocks.length) blocks.push(secPage ? { type: 'pageBreak', attrs: { sectionPage: secPage } } : { type: 'pageBreak' });
    conv.startSection(secPage, i > 0);
    blocks.push(...conv.convertParagraphs(kids(sec, 'p'), { inSub: false }));
  }
  while (blocks.length && blocks[0].type === 'pageBreak') blocks.shift();
  return { content: docNode(blocks), settings, meta, warnings: dedupe(warnings) };
}

function dedupe(a: string[]) {
  return [...new Set(a)].slice(0, 20);
}
