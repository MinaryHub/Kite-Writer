import { cleanLook, type PicLook } from './picLook';
import { latexToHwp } from '../math/hwpEq';
import { cleanTabs, type TabDefs } from '../editor/tabLayout';
import { DEFAULT_FONT, DEFAULT_FONT_SIZE, type FloatWrap, type JMark, type JNode, type ParaBorder, cleanColumns, cleanFloatWrap, cleanPageHide, cleanPageNumStart, cleanParaBorder, formatNumber, normColor, toRoman } from './common';
import type { Columns, PageSetup, SectionHf } from '../types';
import { cleanShape, type ShapeData } from './shape';
import type { FloatHw } from './hwpLayout';
import { keptCellBf, keptCharRef, keptObjCharRef, keptParaRef, keptSecRaw, keptSegs, rawRefOf, type KeptSegs, type RawRef } from './hwpBase';

/** 떠 있는 개체의 자리 (px). hw 는 한글 문서에서 읽은 자리 값 (저장할 때 그대로 쓴다) */
/** 누름틀 (한글의 입력 칸). empty: 글이 안내문 자리 표시 (저장할 때 글은 쓰지 않는다) */
export interface FlatField {
  guide: string;
  memo: string;
  name: string;
  empty: boolean;
  /** 상호 참조 필드 (명령 글: formats/crossRef.ts). 있으면 누름틀이 아니라 상호 참조 */
  xref?: string;
  /** 표 계산식 필드 (formats/formula.ts). 있으면 누름틀이 아니라 계산식 */
  frm?: { formula: string; fmt: string };
}

/** 누름틀 비교 열쇠 (이어진 글이 같은 누름틀인가) */
export const fieldKey = (f: FlatField | null | undefined) => (f ? JSON.stringify([f.guide, f.memo, f.name, f.empty, f.xref || '', f.frm || '']) : '');

function fieldOf(marks: JMark[] | undefined): FlatField | undefined {
  const fm = (marks || []).find((mk) => mk.type === 'formula');
  if (fm && typeof fm.attrs?.formula === 'string' && fm.attrs.formula.startsWith('=')) return { guide: '', memo: '', name: '', empty: false, frm: { formula: fm.attrs.formula.slice(0, 500), fmt: typeof fm.attrs.fmt === 'string' && fm.attrs.fmt ? fm.attrs.fmt.slice(0, 40) : '%g,' } };
  const x = (marks || []).find((mk) => mk.type === 'crossRef');
  if (x && typeof x.attrs?.cmd === 'string' && x.attrs.cmd) return { guide: '', memo: '', name: '', empty: false, xref: x.attrs.cmd.slice(0, 1000) };
  const m = (marks || []).find((x) => x.type === 'clickHere');
  if (!m) return undefined;
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.slice(0, n) : '');
  return { guide: s(m.attrs?.guide, 500), memo: s(m.attrs?.memo, 500), name: s(m.attrs?.name, 100), empty: m.attrs?.empty === true };
}

export interface FlatFloat {
  x: number;
  y: number;
  /** 쪽 본문 맨 위 기준 세로 자리 (종이·여백 기준으로 놓인 개체) */
  py?: number | null;
  behind?: boolean;
  hw?: FloatHw | null;
  /** 둘레 글 흐름 (Word 문서에서 읽은 것) */
  wrap?: FloatWrap | null;
  /** 폭이 내용대로인 글상자(Word 의 틀)의 가로 기준: r 오른쪽 끝·c 가운데에서 잰 x */
  ax?: 'r' | 'c' | null;
  /** 왼쪽(l)·오른쪽(r) 끝에 붙어 글이 옆으로 흐르는 틀 (x 는 붙은 끝에서 민 거리) */
  cf?: 'l' | 'r' | null;
  /** 크기를 정하지 않은 상자의 어림 폭 (px) */
  zw?: number | null;
}

/** 문서 노드의 float 속성 → FlatFloat (이상한 값은 null) */
export function flatFloatOf(v: any): FlatFloat | null {
  if (!v || typeof v !== 'object') return null;
  const x = Number(v.x);
  const y = Number(v.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const out: FlatFloat = { x, y };
  if (v.py != null && Number.isFinite(+v.py)) out.py = +v.py;
  if (v.behind === true) out.behind = true;
  const wrap = cleanFloatWrap(v.wrap);
  if (wrap) out.wrap = wrap;
  if (v.ax === 'r' || v.ax === 'c') out.ax = v.ax;
  if (v.cf === 'l' || v.cf === 'r') out.cf = v.cf;
  if (Number.isFinite(+v.zw) && +v.zw > 0 && +v.zw < 5000) out.zw = +v.zw;
  const h = v.hw;
  if (h && typeof h === 'object' && [h.vo, h.ho].every((n: any) => Number.isFinite(+n))) {
    const pick = (val: any, list: string[], def: string) => (list.includes(val) ? val : def);
    out.hw = {
      wrap: pick(h.wrap, ['SQUARE', 'TOP_AND_BOTTOM', 'BEHIND_TEXT', 'IN_FRONT_OF_TEXT'], 'IN_FRONT_OF_TEXT'),
      vr: pick(h.vr, ['PAPER', 'PAGE', 'PARA'], 'PARA'),
      hr: pick(h.hr, ['PAPER', 'PAGE', 'COLUMN', 'PARA'], 'COLUMN'),
      va: pick(h.va, ['TOP', 'CENTER', 'BOTTOM', 'INSIDE', 'OUTSIDE'], 'TOP'),
      ha: pick(h.ha, ['LEFT', 'CENTER', 'RIGHT', 'INSIDE', 'OUTSIDE'], 'LEFT'),
      vo: Math.round(+h.vo),
      ho: Math.round(+h.ho),
      om: Array.isArray(h.om) && h.om.length === 4 ? h.om.map((n: any) => Math.max(0, Math.min(60000, Math.round(+n) || 0))) : [0, 0, 0, 0],
    };
  }
  return out;
}

/**
 * 편집기 문서(JSON)를 한글/워드식 "문단 + 표" 구조로 평탄화한다.
 * 목록·제목·인용 등은 들여쓰기와 글머리 문자열로 변환된다.
 */

export interface CharStyle {
  font: string;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  sup: boolean;
  sub: boolean;
  highlight: string | null;
  letterSpacing: number;
  fontWidth: number;
  effect: string | null;
  /** 한글 글꼴과 다른 언어별 글꼴 (한글 문서에서 온 것): 영문·한자·기호 */
  langFonts?: { en?: string; hanja?: string; sym?: string } | null;
  /** 한글·한자 글꼴 (Word 문서에서 온 것): font 는 영문 글꼴이고, 한글·한자는 이 글꼴로 그린다 */
  eaFont?: string | null;
  /** 밑줄의 선 종류(한글 이름)·색·위치(top: 글자 위), 취소선의 선 종류·색 */
  ulShape?: string | null;
  ulColor?: string | null;
  ulPos?: 'top' | null;
  stShape?: string | null;
  stColor?: string | null;
  /** 강조점 (한글 이름), 글자 위치 (%) */
  emphasis?: string | null;
  offset?: number | null;
}

/** 언어 7개(한글·영문·한자·일어·기타·기호·사용자)의 글꼴 번호. font 는 글꼴 이름 → 번호 */
export function langFontIds(c: CharStyle, font: (name: string, lang: number) => number): number[] {
  // Word 문서에서 온 글자: 한글 글꼴(eaFont)이 따로 있으면 그것이 한글·한자 글꼴이고 font 는 영문 글꼴이다
  const b = c.eaFont || c.font;
  const lf = c.langFonts || {};
  const en = lf.en || (c.eaFont ? c.font : undefined);
  // 언어별 글꼴 목록 차례: 한글, 영문, 한자, 일어, 외국어, 기호, 사용자 (원본 보존형 저장은 언어마다 목록이 다르다)
  return [font(b, 0), font(en || b, 1), font(lf.hanja || b, 2), font(b, 3), font(b, 4), font(lf.sym || b, 5), font(b, 6)];
}

export interface ParaStyle {
  align: 'left' | 'center' | 'right' | 'justify' | 'distribute';
  indentLeft: number; // pt
  indentRight: number;
  textIndent: number;
  spaceBefore: number;
  spaceAfter: number;
  /** 배수(예: 1.6) 또는 "20pt" */
  lineHeight: string;
  bg: string | null;
  borderBottom: boolean;
  heading: number; // 0 = 본문
  /** 개요 수준 (1~9). 제목 스타일이 아닌 문단이 차례에 들어가는 수준 (Word 문서에서 온 제목 문단 등) */
  outline?: number | null;
  /** 한글 줄 나눔 단위가 글자 */
  breakChar: boolean;
  /** 문단 테두리 */
  border?: ParaBorder | null;
  /** 쪽 나눔 규칙: w 외톨이줄 방지, n 다음 문단과 함께, l 문단을 나누지 않음 */
  keep?: string | null;
  /** 탭 자리 (Word 문서): 기본 탭 간격과 정한 자리 */
  tabs?: TabDefs | null;
}

/** 탭 하나의 정보 (한글 문서의 탭은 폭·채움·종류를 가진다) */
export interface TabInfo {
  /** 탭이 차지하는 폭(px). 모르면 null → 기본 탭 간격 */
  width: number | null;
  /** 채움 종류 (0 없음, 1 실선, 2 긴 점선, 3 점선, 4 -.-, 5 -..-, 6 원점선, 7 이중선) */
  leader: number;
  /** 탭 종류 (한글 값 그대로) */
  type: number;
  /** 절대 위치 탭 (Word 의 ptab): 글 영역의 왼쪽 끝(l)·가운데(c)·오른쪽 끝(r) */
  ptab?: 'l' | 'c' | 'r' | null;
}

/** 검토 정보 (변경 내용·메모) — 지원하는 형식(DOCX)만 쓴다 */
export interface ReviewInfo {
  change?: { type: 'ins' | 'del'; author: string; time: number };
  comments?: string[];
}

/** cp: 원본 보존형 저장 (formats/hwpBase.ts). 글자 모양을 고치지 않은 한글 글자·개체의 원본 글자 모양 번호 */
export type FlatInline =
  | { type: 'text'; text: string; style: CharStyle; link: string | null; head?: boolean; tab?: TabInfo | null; review?: ReviewInfo; math?: { latex: string; hwp: string }; ruby?: { text: string; pos: string } | null; compose?: string | null; field?: FlatField; cp?: number; autoNum?: string }
  | { type: 'break' }
  | { type: 'image'; src: string; width: number | null; height: number | null; style: CharStyle; crop: { t: number; r: number; b: number; l: number } | null; float?: FlatFloat | null; rotate?: number | null; look?: PicLook | null; cp?: number; hwpPos?: HwpRawPos }
  | { type: 'shape'; width: number; height: number; d: ShapeData; float: FlatFloat | null; style: CharStyle; cp?: number }
  | { type: 'footnote'; text: string; style: CharStyle; end?: boolean }
  /** 책갈피 (이름 붙은 자리) */
  | { type: 'bookmark'; name: string };

/** 블록 앞의 단 나누기 (다음 단으로), 다단 설정 나누기 (여기서부터 그 다단으로. count 1 은 한 단) */
export interface FlatColumnBreak {
  columnBreakBefore?: boolean;
  columnsBefore?: Columns | null;
  /** 이 블록에서 새 구역이 시작한다: 그 구역의 용지 (구역 나누기의 sectionPage) */
  sectionPageBefore?: PageSetup | null;
  /** 그 구역의 머리말·꼬리말·쪽 번호 (구역 나누기의 sectionHf: 구역마다 다른 머리말) */
  sectionHfBefore?: SectionHf | null;
  /** 원본 보존형 저장 (formats/hwpBase.ts): 용지를 고치지 않은 한글 구역의 원본 구역 정의 (hp:secPr 원문) */
  sectionRawBefore?: string | null;
  /** 원본 보존형 저장: 고치지 않은 본문 블록의 원문 묶음 (최상위 블록만) */
  raw?: RawRef;
  /** 한글의 감추기: 이 블록이 놓인 쪽에서 감출 것 (h 머리말, f 꼬리말, m 바탕쪽, b 쪽 테두리, x 쪽 배경, n 쪽 번호) */
  pageHide?: string | null;
  /** 한글의 새 번호로 시작 (쪽 번호): 이 블록이 놓인 쪽부터 이 번호 */
  pageNumStart?: number | null;
}

export interface FlatPara extends FlatColumnBreak {
  kind: 'para';
  style: ParaStyle;
  /** 빈 문단의 글자 모양 */
  baseChar: CharStyle;
  inlines: FlatInline[];
  pageBreakBefore: boolean;
  /** 원본 보존형 저장 (formats/hwpBase.ts): 문단 모양을 고치지 않은 한글 문단의 원본 [문단 모양 번호, 스타일 번호] */
  pr?: [number, number];
  /** 원본 보존형 저장: 고치지 않은 한글 문단의 원본 줄 정보와 그때의 문단 차례 */
  segs?: KeptSegs;
  /** 원본 보존형 저장: 문단 모양을 고치지 않은 한글 문단의 끝(마지막 글자 묶음) 글자 모양 번호 */
  endCp?: number;
  /** 캡션 문단: 바로 뒤('top')·앞('bottom')의 표의 캡션 */
  caption?: 'top' | 'bottom';
  /** HWP 에서 읽은, 떠 있는 표가 든 원본 문단의 빈 줄 (뒤 표 문단 자신의 줄) */
  lead?: boolean;
}

export interface FlatCell {
  row: number;
  col: number;
  colspan: number;
  rowspan: number;
  widthPx: number;
  bg: string | null;
  vAlign: 'top' | 'middle' | 'bottom';
  noBorders: string[];
  /** 굵기/색/종류가 기본과 다른 선 */
  borderCss: string | null;
  blocks: FlatBlock[];
  header: boolean;
  /** 칸 자체 안 여백 [왼, 오른, 위, 아래] (px). 없으면 표 기본 */
  marginsPx?: number[] | null;
  /** 원본 보존형 저장 (formats/hwpBase.ts): 고치지 않은 한글 칸의 원본 크기 [폭, 높이] (HWPUNIT) */
  hwpSz?: [number, number];
  /** 원본 보존형 저장: 테두리/배경을 고치지 않은 한글 칸의 원본 테두리/배경 번호 */
  bf?: number;
  /** 칸 배경 그림 (그림 값과 채우는 방식) */
  bgImage?: { src: string; fit: string } | null;
  /** 세로쓰기 칸 */
  vertical?: boolean;
}

export interface FlatTable extends FlatColumnBreak {
  kind: 'table';
  rows: number;
  cols: number;
  colWidthsPx: number[];
  cells: FlatCell[][];
  pageBreakBefore: boolean;
  align: 'left' | 'center' | 'right';
  /** 셀 좌우 안 여백 (px) */
  cellPadPx: number;
  /** 표 바깥 여백 [왼, 오른, 위, 아래] (px). 없으면 형식의 기본값 */
  outMarginPx?: number[] | null;
  /** 글자처럼 취급 (한글 문서에서 읽은 값) */
  inline?: boolean;
  /** 줄 높이 (px, 최소 높이). 없으면 null */
  rowHeightsPx: (number | null)[];
  /** 쪽 경계에서 나누는 방식: 없으면 나눔, row 셀 단위로 나눔, none 나누지 않음 */
  pageSplit?: 'row' | 'none' | null;
  /** 칸 사이 간격 (px) */
  cellSpacingPx?: number | null;
  /** 원본 보존형 저장 (formats/hwpBase.ts): 표가 놓인 한글 문단의 원본 줄 정보와 그때의 문단 차례 */
  segs?: KeptSegs;
  /** 원본 보존형 저장: 떠 있는 표가 딸린 한글 문단 (prev 앞 문단, next 뒤 문단)과 원본 자리 (hp:pos·hp:outMargin 원문) */
  anchor?: 'prev' | 'next';
  hwpPos?: { wrap: string; pos: string; om: string };
  /** 원본 보존형 저장: 글자처럼 놓인 이 표와 뒤 문단이 원래 한 한글 문단 (저장할 때 뒤 문단 글 앞의 개체로) */
  join?: 'next';
  /** 원본 보존형 저장: 표를 고치지 않았으면 표가 든 한글 문단의 원본 [문단 모양 번호, 스타일 번호] */
  pr?: [number, number];
  /** 원본 보존형 저장: 고치지 않은 한글 표의 원본 크기 [폭, 높이] (HWPUNIT) */
  hwpSz?: [number, number];
  /** 원본 보존형 저장: 표가 든 한글 글자 묶음의 원본 글자 모양 번호 */
  cp?: number;
  /** 원본 보존형 저장: 한글 표 자체의 원본 테두리/배경 번호 */
  bf?: number;
  /** 캡션 모양 (한글에서 읽은 값): 자리·폭·간격 (HWPUNIT) */
  capGeo?: { side: string; w: number; gap: number; full: boolean };
}

/** 글상자 (도형 안의 문단들) */
export interface FlatBox extends FlatColumnBreak {
  kind: 'box';
  /** 원본 보존형 저장 (formats/hwpBase.ts): 글자처럼 놓인 글상자가 든 한글 문단의 원본 줄 정보와 문단 차례 */
  segs?: KeptSegs;
  /** 원본 보존형 저장: 글상자가 든 한글 문단의 원본 [문단 모양 번호, 스타일 번호] */
  pr?: [number, number];
  /** 원본 보존형 저장: 글상자(떠 있는 표를 담은 상자)가 든 한글 글자 묶음의 원본 글자 모양 번호 */
  cp?: number;
  width: number | null;
  height: number | null;
  bg: string | null;
  bgImage: string | null;
  borderColor: string | null;
  borderWidth: number | null;
  /** CSS border-radius 값 ('12px', '50%') */
  radius: string | null;
  /** 안쪽 여백 px [위, 오른쪽, 아래, 왼쪽] */
  padding: number[] | null;
  blocks: FlatBlock[];
  pageBreakBefore: boolean;
  /** 떠 있는 자리 (x 는 본문 왼쪽, y 는 뒤따르는 문단 상자 위쪽 기준) */
  float?: FlatFloat | null;
  /** 테두리 선 종류 (한글 값: DASH, DOT …) */
  borderDash?: string | null;
  /** 글의 세로 맞춤 */
  valign?: 'middle' | 'bottom' | null;
  /** 세로쓰기 글상자 */
  vertical?: boolean;
}

export type FlatBlock = FlatPara | FlatTable | FlatBox;

/** 글상자를 지원하지 않는 형식을 위해 상자를 풀어 안의 블록만 남긴다 (표 안까지) */
export function unwrapBoxes(blocks: FlatBlock[]): FlatBlock[] {
  const out: FlatBlock[] = [];
  // 상자에 달린 감추기는 안의 첫 블록으로 (빈 상자면 다음 블록으로)
  let carry = '';
  for (const b of blocks) {
    if (b.kind === 'box') {
      const inner = unwrapBoxes(b.blocks);
      if (inner.length && b.pageBreakBefore) inner[0].pageBreakBefore = true;
      if (inner.length && b.columnBreakBefore) inner[0].columnBreakBefore = true;
      if (inner.length && b.columnsBefore) inner[0].columnsBefore = b.columnsBefore;
      const hide = (b.pageHide || '') + carry;
      if (inner.length) {
        if (hide) inner[0].pageHide = (inner[0].pageHide || '') + hide;
        carry = '';
      } else carry = hide;
      out.push(...inner);
      continue;
    }
    if (carry) {
      b.pageHide = (b.pageHide || '') + carry;
      carry = '';
    }
    if (b.kind === 'table') {
      for (const row of b.cells) for (const c of row) c.blocks = unwrapBoxes(c.blocks);
      out.push(b);
    } else out.push(b);
  }
  return out;
}

export const HEADING_SIZES = [0, 20, 16, 14, 12, 11, 10];

export function defaultChar(): CharStyle {
  return {
    font: DEFAULT_FONT,
    size: DEFAULT_FONT_SIZE,
    color: '#000000',
    bold: false,
    italic: false,
    underline: false,
    strike: false,
    sup: false,
    sub: false,
    highlight: null,
    letterSpacing: 0,
    fontWidth: 100,
    effect: null,
  };
}

export function defaultPara(): ParaStyle {
  return {
    align: 'justify',
    indentLeft: 0,
    indentRight: 0,
    textIndent: 0,
    spaceBefore: 0,
    spaceAfter: 0,
    lineHeight: '1.6',
    bg: null,
    borderBottom: false,
    heading: 0,
    breakChar: false,
  };
}

/** 칸 안 여백 값 정리: 유한한 0 이상 수 4개 */
export function cleanMargins(v: any): number[] | null {
  if (!Array.isArray(v) || v.length !== 4) return null;
  const n = v.map((x) => +x);
  return n.every((x) => isFinite(x) && x >= 0 && x < 500) ? n : null;
}

export function charKey(c: CharStyle): string {
  return [c.font, c.size, c.color, +c.bold, +c.italic, +c.underline, +c.strike, +c.sup, +c.sub, c.highlight, c.letterSpacing, c.fontWidth, c.effect, c.langFonts ? JSON.stringify(c.langFonts) : '', c.eaFont || '', c.ulShape || '', c.ulColor || '', c.ulPos || '', c.stShape || '', c.stColor || '', c.emphasis || '', c.offset || ''].join('|');
}

export function paraKey(p: ParaStyle): string {
  return [p.align, p.indentLeft, p.indentRight, p.textIndent, p.spaceBefore, p.spaceAfter, p.lineHeight, p.bg, +p.borderBottom, +p.breakChar, p.border ? JSON.stringify(p.border) : '', p.outline || '', p.keep || '', p.tabs ? JSON.stringify(p.tabs) : ''].join('|');
}

function applyMarks(base: CharStyle, marks: JMark[] | undefined): { style: CharStyle; link: string | null; tab: TabInfo | null; ruby: { text: string; pos: string } | null; compose: string | null } {
  const s = { ...base };
  let link: string | null = null;
  let tab: TabInfo | null = null;
  let ruby: { text: string; pos: string } | null = null;
  let compose: string | null = null;
  const shapeOf = (v: unknown) => (typeof v === 'string' && /^[A-Z_]{3,20}$/.test(v) && v !== 'SOLID' ? v : null);
  for (const m of marks || []) {
    switch (m.type) {
      case 'ruby':
        if (m.attrs?.text) ruby = { text: String(m.attrs.text).slice(0, 200), pos: m.attrs.pos === 'bottom' ? 'bottom' : 'top' };
        break;
      case 'compose':
        compose = typeof m.attrs?.shape === 'string' && /^[A-Z_]{3,40}$/.test(m.attrs.shape) ? m.attrs.shape : 'SHAPE_CIRCLE';
        break;
      case 'tab':
        tab = { width: m.attrs?.width ? +m.attrs.width : null, leader: +(m.attrs?.leader || 0), type: +(m.attrs?.type || 0), ptab: m.attrs?.ptab === 'l' || m.attrs?.ptab === 'c' || m.attrs?.ptab === 'r' ? m.attrs.ptab : null };
        break;
      case 'bold':
        s.bold = true;
        break;
      case 'italic':
        s.italic = true;
        break;
      case 'underline':
        s.underline = true;
        s.ulShape = shapeOf(m.attrs?.shape);
        s.ulColor = normColor(m.attrs?.color);
        s.ulPos = m.attrs?.pos === 'top' ? 'top' : null;
        break;
      case 'strike':
        s.strike = true;
        s.stShape = shapeOf(m.attrs?.shape);
        s.stColor = normColor(m.attrs?.color);
        break;
      case 'superscript':
        s.sup = true;
        break;
      case 'subscript':
        s.sub = true;
        break;
      case 'code':
        s.font = 'D2Coding';
        break;
      case 'highlight':
        s.highlight = normColor(m.attrs?.color) || '#FFFF00';
        break;
      case 'link':
        link = m.attrs?.href || null;
        s.underline = true;
        if (s.color === '#000000') s.color = '#0563C1';
        break;
      case 'textStyle': {
        const a = m.attrs || {};
        if (a.fontFamily) {
          s.font = String(a.fontFamily).split(',')[0].replace(/['"]/g, '').trim();
          s.langFonts = null;
          s.eaFont = null;
        }
        if (typeof a.eaFont === 'string' && a.eaFont.trim()) s.eaFont = a.eaFont.trim().slice(0, 80);
        if (a.langFonts && typeof a.langFonts === 'object') {
          const lf: Record<string, string> = {};
          for (const k of ['en', 'hanja', 'sym']) if (typeof a.langFonts[k] === 'string' && a.langFonts[k].trim()) lf[k] = a.langFonts[k].trim();
          s.langFonts = Object.keys(lf).length ? lf : null;
        }
        if (a.fontSize) s.size = +a.fontSize;
        if (a.color) s.color = normalizeHex(a.color) || s.color;
        if (a.letterSpacing) s.letterSpacing = +a.letterSpacing;
        if (a.fontWidth) s.fontWidth = +a.fontWidth;
        if (a.textEffect) s.effect = a.textEffect;
        if (typeof a.emphasis === 'string' && /^[A-Z_]{3,20}$/.test(a.emphasis)) s.emphasis = a.emphasis;
        if (Number.isFinite(+a.offset) && +a.offset) s.offset = Math.max(-100, Math.min(100, Math.round(+a.offset)));
        break;
      }
    }
  }
  return { style: s, link, tab, ruby, compose };
}

/** 글자의 변경 내용·메모 표시 */
function reviewOf(marks: JMark[] | undefined): ReviewInfo | undefined {
  let r: ReviewInfo | undefined;
  for (const m of marks || []) {
    if (m.type === 'insertion' || m.type === 'deletion') (r ||= {}).change = { type: m.type === 'insertion' ? 'ins' : 'del', author: String(m.attrs?.author || ''), time: +m.attrs?.time || 0 };
    else if (m.type === 'comment' && m.attrs?.id) ((r ||= {}).comments ||= []).push(String(m.attrs.id));
  }
  return r;
}
const reviewKey = (r?: ReviewInfo) => (r ? JSON.stringify([r.change?.type, r.change?.author, r.change?.time, r.comments]) : '');

function normalizeHex(c: string): string | null {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return ('#' + c[1] + c[1] + c[2] + c[2] + c[3] + c[3]).toUpperCase();
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(c);
  if (m) return '#' + [m[1], m[2], m[3]].map((x) => (+x).toString(16).padStart(2, '0')).join('').toUpperCase();
  return null;
}

const BULLETS: Record<string, string> = {
  disc: '•',
  circle: '○',
  square: '■',
  'k-dash': '-',
  'k-arrow': '➢',
  'k-check': '✓',
  'k-diamond': '◆',
  'k-ref': '※',
  'k-filled-circle': '●',
  'k-hollow-square': '□',
};

const CIRCLED_HANGUL = [...'㉮㉯㉰㉱㉲㉳㉴㉵㉶㉷㉸㉹㉺㉻'];

export function bulletChar(listStyle: string | null | undefined, depth: number): string {
  if (listStyle && BULLETS[listStyle]) return BULLETS[listStyle];
  return ['•', '◦', '▪'][depth % 3];
}

/**
 * 공문서 항목 기호 (행정업무규정 시행규칙): 첫째 1. 둘째 가. 셋째 1) 넷째 가) 다섯째 (1) 여섯째 (가) 일곱째 ① 여덟째 ㉮.
 * 맨 바깥 목록에 'k-gov' 를 주면 안쪽 목록은 모양을 따로 정하지 않은 한 수준에 따라 이 차례로 붙는다
 */
export const GOV_LEVELS = ['k-gov', 'hangul', 'k-rparen', 'k-rparen-hangul', 'k-paren', 'k-paren-hangul', 'k-circled', 'k-circled-hangul'];

export function orderedLabel(n: number, listStyle: string | null | undefined): string {
  switch (listStyle) {
    case 'k-rparen':
      return `${n})`;
    case 'k-rparen-hangul':
      return `${formatNumber(n, 'HANGUL_SYLLABLE')})`;
    case 'k-circled-hangul':
      return CIRCLED_HANGUL[n - 1] || `(${formatNumber(n, 'HANGUL_SYLLABLE')})`;
    case 'lower-alpha':
    case 'lower-latin':
      return formatNumber(n, 'LATIN_SMALL') + '.';
    case 'upper-alpha':
    case 'upper-latin':
      return formatNumber(n, 'LATIN_CAPITAL') + '.';
    case 'lower-roman':
      return toRoman(n).toLowerCase() + '.';
    case 'upper-roman':
      return toRoman(n) + '.';
    case 'hangul':
    case 'korean-hangul-formal':
      return formatNumber(n, 'HANGUL_SYLLABLE') + '.';
    case 'hangul-consonant':
      return formatNumber(n, 'HANGUL_JAMO') + '.';
    case 'k-circled':
      return formatNumber(n, 'CIRCLED_DIGIT');
    case 'k-paren':
      return `(${n})`;
    case 'k-paren-hangul':
      return `(${formatNumber(n, 'HANGUL_SYLLABLE')})`;
    default:
      return n + '.';
  }
}

interface Ctx {
  indent: number;
  /** 공문서 항목 번호 목록 안이면 지금 수준 (맨 바깥 0) */
  gov?: number;
  baseChar: CharStyle;
  quote: boolean;
  mono: boolean;
}

export function flattenDoc(doc: JNode): FlatBlock[] {
  return flattenBlocks(doc.content || [], { indent: 0, baseChar: defaultChar(), quote: false, mono: false });
}

export function flattenBlocks(nodes: JNode[], ctx: Ctx): FlatBlock[] {
  const out: FlatBlock[] = [];
  let pendingBreak = false;
  let pendingCol = false;
  let pendingCols: Columns | null = null;
  let pendingSection: PageSetup | null = null;
  let pendingHf: SectionHf | null = null;
  let pendingRaw: string | null = null;
  const push = (b: FlatBlock) => {
    if (pendingBreak) {
      b.pageBreakBefore = true;
      pendingBreak = false;
    }
    if (pendingSection) {
      b.sectionPageBefore = pendingSection;
      if (pendingHf) b.sectionHfBefore = pendingHf;
      if (pendingRaw) b.sectionRawBefore = pendingRaw;
      pendingSection = null;
      pendingHf = null;
      pendingRaw = null;
    }
    if (pendingCol) {
      b.columnBreakBefore = true;
      pendingCol = false;
    }
    if (pendingCols) {
      b.columnsBefore = pendingCols;
      pendingCols = null;
    }
    out.push(b);
  };
  for (const n of nodes) {
    // 감추기 표시는 이 노드에서 나온 첫 블록에 단다
    const hide = cleanPageHide(n.attrs?.pageHide);
    const pns = cleanPageNumStart(n.attrs?.pageNumStart);
    const at = out.length;
    flattenOne(n);
    if (hide && out.length > at) out[at].pageHide = hide;
    if (pns != null && out.length > at) out[at].pageNumStart = pns;
    // 원문 묶음: 노드 하나가 블록 하나로 온 것만 (최상위 문단·표·글상자)
    const raw = ctx.indent === 0 && !ctx.quote && out.length === at + 1 ? rawRefOf(n.attrs?.hwpRaw) : null;
    if (raw) out[at].raw = raw;
  }
  if (pendingBreak || pendingCol || pendingCols) push(flattenPara({ type: 'paragraph' }, ctx, 0));
  return out;

  function flattenOne(n: JNode) {
    switch (n.type) {
      case 'pageBreak':
        pendingBreak = true;
        // 구역 나누기: 그 구역의 다단으로 바꾼다 (쓰는 쪽이 앞 다단과 같으면 건너뛴다)
        if (n.attrs?.sectionPage) {
          pendingCols = cleanColumns(n.attrs.sectionPage.columns) || { count: 1, gap: 0 };
          pendingSection = n.attrs.sectionPage as PageSetup;
          pendingHf = n.attrs.sectionHf && typeof n.attrs.sectionHf === 'object' ? (n.attrs.sectionHf as SectionHf) : null;
          pendingRaw = keptSecRaw(n.attrs);
        }
        break;
      case 'columnBreak':
        if (n.attrs?.columns) pendingCols = cleanColumns(n.attrs.columns) || pendingCols;
        else pendingCol = true;
        break;
      case 'paragraph':
        push(flattenPara(n, ctx, 0));
        break;
      case 'heading':
        push(flattenPara(n, ctx, n.attrs?.level || 1));
        break;
      case 'codeBlock': {
        const p = flattenPara({ type: 'paragraph', content: codeContent(n) }, { ...ctx, mono: true }, 0);
        p.style.bg = p.style.bg || '#F4F4F4';
        p.style.align = 'left';
        push(p);
        break;
      }
      case 'blockquote':
        for (const b of flattenBlocks(n.content || [], { ...ctx, indent: ctx.indent + 20, quote: true })) push(b);
        break;
      case 'horizontalRule': {
        const p = flattenPara({ type: 'paragraph' }, ctx, 0);
        p.style.borderBottom = true;
        push(p);
        break;
      }
      case 'bulletList':
      case 'orderedList':
      case 'taskList': {
        let num = n.attrs?.start || 1;
        const depth = Math.round(ctx.indent / 20);
        // 공문서 항목 번호: 맨 바깥이 k-gov 이면 안쪽 번호 목록은 수준에 따라 모양이 정해진다
        const own = n.attrs?.listStyle;
        const gov = n.type === 'orderedList' ? (own === 'k-gov' ? 0 : ctx.gov != null ? ctx.gov + 1 : undefined) : ctx.gov;
        const numStyle = own && own !== 'k-gov' ? own : gov != null ? GOV_LEVELS[Math.min(gov, GOV_LEVELS.length - 1)] : own;
        for (const li of n.content || []) {
          let label: string;
          if (n.type === 'bulletList') label = bulletChar(n.attrs?.listStyle, depth);
          else if (n.type === 'orderedList') label = orderedLabel(num, numStyle === 'k-gov' ? null : numStyle);
          else label = li.attrs?.checked ? '☑' : '☐';
          num++;
          const childCtx: Ctx = { ...ctx, indent: ctx.indent + 20, gov };
          const blocks = flattenBlocks(li.content || [], childCtx);
          const first = blocks.find((b) => b.kind === 'para') as FlatPara | undefined;
          if (first) {
            const st = first.inlines.find((i) => i.type === 'text') as any;
            const style = st ? st.style : first.baseChar;
            first.inlines.unshift({ type: 'text', text: label + ' ', style, link: null });
            // 내어쓰기: 첫 줄은 목록 들여쓰기 위치, 둘째 줄부터는 글머리 너비만큼 안쪽
            const hang = Math.round(Math.max(10, style.size * (label.length * 0.6 + 0.6)));
            first.style.indentLeft = first.style.indentLeft - 20 + hang;
            first.style.textIndent = -hang;
          }
          for (const b of blocks) push(b);
        }
        break;
      }
      case 'table':
        push(flattenTable(n, ctx));
        break;
      case 'textBox':
        push(flattenBox(n, ctx));
        break;
      default:
        if (n.content) for (const b of flattenBlocks(n.content, ctx)) push(b);
    }
  }
}

function codeContent(n: JNode): JNode[] {
  const text = (n.content || []).map((c) => c.text || '').join('');
  const out: JNode[] = [];
  text.split('\n').forEach((line, i) => {
    if (i) out.push({ type: 'hardBreak' });
    if (line) out.push({ type: 'text', text: line });
  });
  return out;
}

function flattenPara(n: JNode, ctx: Ctx, level: number): FlatPara {
  const a = n.attrs || {};
  const style = defaultPara();
  if (a.textAlign) style.align = a.textAlign;
  if (a.lineHeight) style.lineHeight = String(a.lineHeight);
  style.indentLeft = (a.indentLeft || 0) + ctx.indent;
  style.indentRight = a.indentRight || 0;
  style.textIndent = a.textIndent || 0;
  style.spaceBefore = a.spaceBefore || 0;
  style.spaceAfter = a.spaceAfter || 0;
  style.bg = normColor(a.paraBg);
  style.border = cleanParaBorder(a.paraBorder);
  style.heading = level;
  style.outline = !level && +a.outlineLevel >= 1 && +a.outlineLevel <= 9 ? Math.round(+a.outlineLevel) : null;
  style.breakChar = !!a.breakChar;
  style.keep = typeof a.pageKeep === 'string' ? ['w', 'n', 'l'].filter((c) => a.pageKeep.includes(c)).join('') || null : null;
  style.tabs = cleanTabs(a.tabs);
  const base: CharStyle = { ...ctx.baseChar };
  if (level) {
    base.size = HEADING_SIZES[level] || 10;
    base.bold = true;
    if (!a.spaceBefore) style.spaceBefore = level <= 2 ? 12 : 6;
    if (!a.spaceAfter) style.spaceAfter = level <= 2 ? 6 : 3;
  }
  if (ctx.mono) base.font = 'D2Coding';
  if (ctx.quote) base.color = base.color === '#000000' ? '#444444' : base.color;
  if (a.fontSize) base.size = a.fontSize;
  const inlines: FlatInline[] = [];
  for (const c of n.content || []) {
    if (c.type === 'text') {
      const { style: cs, link, tab, ruby, compose } = applyMarks(base, c.marks);
      const review = reviewOf(c.marks);
      const field = fieldOf(c.marks);
      const prev = inlines[inlines.length - 1];
      // 탭 정보가 붙은 글자는 따로 둔다 (탭 하나짜리 텍스트). 덧말·글자 겹침이 붙은 글자도 따로
      const head = (c.marks || []).some((m) => m.type === 'paraHead');
      const cp = keptCharRef(c.marks) ?? undefined;
      const an = (c.marks || []).find((m) => m.type === 'autoNum')?.attrs?.kind;
      const cpo = { ...(cp != null ? { cp } : {}), ...(typeof an === 'string' && /^[A-Z]{3,10}$/.test(an) ? { autoNum: an } : {}) };
      if (head) inlines.push({ type: 'text', text: c.text || '', style: cs, link, head: true, ...cpo });
      else if (!tab && !ruby && !compose && !an && prev && prev.type === 'text' && !prev.head && !prev.tab && !prev.math && !prev.ruby && !prev.compose && !prev.autoNum && prev.cp === cp && charKey(prev.style) === charKey(cs) && prev.link === link && reviewKey(prev.review) === reviewKey(review) && fieldKey(prev.field) === fieldKey(field)) prev.text += c.text || '';
      else inlines.push({ type: 'text', text: c.text || '', style: cs, link, tab, ...(review ? { review } : {}), ...(ruby ? { ruby } : {}), ...(compose ? { compose } : {}), ...(field ? { field } : {}), ...cpo });
    } else if (c.type === 'hardBreak') inlines.push({ type: 'break' });
    else if (c.type === 'bookmark') {
      const name = typeof c.attrs?.name === 'string' ? c.attrs.name.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 64) : '';
      if (name) inlines.push({ type: 'bookmark', name });
    }
    else if (c.type === 'image') {
      const { style: cs } = applyMarks(base, c.marks);
      const rot = Number(c.attrs?.rotate);
      const cp = keptObjCharRef(c);
      const float = flatFloatOf(c.attrs?.float);
      const hwpPos = float ? null : rawPosOf(c.attrs?.hwpPos);
      inlines.push({ type: 'image', src: c.attrs?.src, width: c.attrs?.width || null, height: c.attrs?.height || null, style: cs, crop: c.attrs?.crop || null, float, rotate: Number.isFinite(rot) && rot % 360 ? rot : null, look: cleanLook(c.attrs?.look), ...(cp != null ? { cp } : {}), ...(hwpPos ? { hwpPos } : {}) });
    } else if (c.type === 'shape') {
      const d = cleanShape(c.attrs?.d);
      const cp = keptObjCharRef(c);
      if (d) inlines.push({ type: 'shape', width: +c.attrs?.width || 1, height: +c.attrs?.height || 1, d, float: flatFloatOf(c.attrs?.float), style: applyMarks(base, c.marks).style, ...(cp != null ? { cp } : {}) });
    } else if (c.type === 'footnote') {
      inlines.push({ type: 'footnote', text: c.attrs?.text || '', style: applyMarks(base, c.marks).style, ...(c.attrs?.kind === 'end' ? { end: true } : {}) });
    } else if (c.type === 'math') {
      // 수식: 수식을 아는 형식(HWPX)은 math 를 쓰고, 나머지는 한글 수식 글자로 남는다
      const { style: cs, link } = applyMarks(base, c.marks);
      const math = { latex: c.attrs?.latex || '', hwp: c.attrs?.hwp || latexToHwp(c.attrs?.latex || '') };
      const cp = keptCharRef(c.marks);
      inlines.push({ type: 'text', text: math.hwp || math.latex, style: { ...cs, italic: true }, link, math, ...(cp != null ? { cp } : {}) });
    }
  }
  const firstText = inlines.find((i) => i.type === 'text') as any;
  const pr = keptParaRef(a);
  const segs = keptSegs(a);
  // 문단 끝 글자 모양: 문단 모양(빈 문단의 글자 크기 포함)을 고치지 않았을 때만
  const endCp = pr && Number.isInteger(a.hwpEnd) && a.hwpEnd >= 0 ? (a.hwpEnd as number) : null;
  const caption = a.caption === 'top' || a.caption === 'bottom' ? (a.caption as 'top' | 'bottom') : null;
  return { kind: 'para', style, baseChar: firstText ? firstText.style : base, inlines, pageBreakBefore: false, ...(pr ? { pr } : {}), ...(segs ? { segs } : {}), ...(endCp != null ? { endCp } : {}), ...(caption ? { caption } : {}), ...(a.hwpLead === true ? { lead: true } : {}) };
}

function flattenBox(n: JNode, ctx: Ctx): FlatBox {
  const a = n.attrs || {};
  const num = (v: any) => (Number.isFinite(+v) && +v > 0 ? +v : null);
  const pad = Array.isArray(a.padding) && a.padding.length === 4 ? a.padding.map((v: any) => Math.max(0, +v || 0)) : null;
  const segs = keptSegs(a);
  const pr = keptParaRef(a);
  const cp = keptObjCharRef(n);
  return {
    ...(segs && !a.float ? { segs } : {}),
    ...(pr && !a.float ? { pr } : {}),
    ...(cp != null ? { cp } : {}),
    kind: 'box',
    width: num(a.width),
    height: num(a.height),
    bg: normColor(a.bg),
    bgImage: typeof a.bgImage === 'string' && a.bgImage ? a.bgImage : null,
    borderColor: normColor(a.borderColor),
    borderWidth: num(a.borderWidth),
    radius: typeof a.radius === 'string' && /^[\d.]+(px|%)$/.test(a.radius) ? a.radius : null,
    padding: pad,
    blocks: flattenBlocks(n.content || [], ctx),
    pageBreakBefore: false,
    float: flatFloatOf(a.float),
    borderDash: typeof a.borderDash === 'string' && /^[A-Z_]{3,20}$/.test(a.borderDash) ? a.borderDash : null,
    valign: a.valign === 'middle' || a.valign === 'bottom' ? a.valign : null,
    ...(a.vertical === true ? { vertical: true } : {}),
  };
}

/** 블록 JSON(도형 안의 글 등)을 평탄화한다 */
export function flattenContent(nodes: JNode[]): FlatBlock[] {
  return flattenBlocks(nodes, { indent: 0, baseChar: defaultChar(), quote: false, mono: false });
}

/** 칸 사이 간격 값 검사 (px, 없으면 null) */
const cellSpacingOf = (v: unknown): number | null => {
  const n = Number(v);
  return n > 0 && n <= 50 ? n : null;
};

/**
 * 표 캡션 찾기: blocks[k] 가 캡션 'top' 문단이면 이어진 캡션 문단들 뒤의 표 자리와 그 문단들, 표면 바로 뒤의 캡션 'bottom' 문단들.
 * 캡션이 없으면 null (쓰는 쪽이 캡션 문단을 표 안의 캡션으로 되돌린다)
 */
export function tableCaptionAt(blocks: FlatBlock[], k: number): { table: number; side: 'top' | 'bottom'; paras: FlatPara[]; next: number } | null {
  const b = blocks[k];
  if (b?.kind === 'para' && b.caption === 'top') {
    let j = k;
    while (blocks[j]?.kind === 'para' && (blocks[j] as FlatPara).caption === 'top') j++;
    if (blocks[j]?.kind !== 'table') return null;
    return { table: j, side: 'top', paras: blocks.slice(k, j) as FlatPara[], next: j + 1 };
  }
  if (b?.kind === 'table') {
    let j = k + 1;
    while (blocks[j]?.kind === 'para' && (blocks[j] as FlatPara).caption === 'bottom') j++;
    if (j === k + 1) return null;
    return { table: k, side: 'bottom', paras: blocks.slice(k + 1, j) as FlatPara[], next: j };
  }
  return null;
}

/** 칸 배경 그림 목록의 첫 그림 (그림 값이 있을 때) */
function cellBgImage(v: unknown): { src: string; fit: string } | null {
  const f = Array.isArray(v) ? v[0] : null;
  return f && typeof f.src === 'string' && f.src ? { src: f.src, fit: typeof f.fit === 'string' ? f.fit : 'stretch' } : null;
}

/** 원본 보존형 저장: 한글 개체의 원본 자리 (textWrap 값, hp:pos·hp:outMargin 원문) */
export interface HwpRawPos {
  wrap: string;
  pos: string;
  om: string;
}

/** 원본 자리 값 검사: 모양이 맞으면 그대로, 아니면 null (원문을 XML 에 그대로 넣으므로 꼴을 엄격히 본다) */
function rawPosOf(hp: any): HwpRawPos | null {
  return hp && typeof hp.wrap === 'string' && /^[A-Z_]{3,30}$/.test(hp.wrap) && typeof hp.pos === 'string' && /^<hp:pos [^<>]*\/>$/.test(hp.pos) && typeof hp.om === 'string' && (hp.om === '' || /^<hp:outMargin [^<>]*\/>$/.test(hp.om))
    ? { wrap: hp.wrap, pos: hp.pos, om: hp.om }
    : null;
}

/** 원본 보존형 저장: [폭, 높이] (HWPUNIT, 양의 정수) 이면 그대로 */
function sizePair(v: unknown): [number, number] | null {
  return Array.isArray(v) && v.length === 2 && v.every((x) => Number.isInteger(x) && x > 0 && x < 10_000_000) ? [v[0], v[1]] : null;
}

function flattenTable(n: JNode, ctx: Ctx): FlatTable {
  const rowsJ = n.content || [];
  const occupied: boolean[][] = [];
  const cells: FlatCell[][] = [];
  const cellWidths = new Map<FlatCell, number[] | null>();
  let maxCols = 0;
  rowsJ.forEach((row, r) => {
    occupied[r] = occupied[r] || [];
    const list: FlatCell[] = [];
    let c = 0;
    for (const cell of row.content || []) {
      while (occupied[r][c]) c++;
      const cs = cell.attrs?.colspan || 1;
      const rs = cell.attrs?.rowspan || 1;
      for (let i = 0; i < rs; i++) {
        occupied[r + i] = occupied[r + i] || [];
        for (let j = 0; j < cs; j++) occupied[r + i][c + j] = true;
      }
      const cw: number[] | null = cell.attrs?.colwidth || null;
      const va = cell.attrs?.verticalAlign;
      const fc: FlatCell = {
        row: r,
        col: c,
        colspan: cs,
        rowspan: rs,
        widthPx: cw ? cw.reduce((x: number, y: number) => x + (y || 0), 0) : 0,
        bg: normColor(cell.attrs?.backgroundColor),
        vAlign: va === 'top' ? 'top' : va === 'bottom' ? 'bottom' : 'middle',
        noBorders: cell.attrs?.borderStyle ? String(cell.attrs.borderStyle).split(/\s+/).filter(Boolean) : [],
        borderCss: cell.attrs?.borderCss || null,
        blocks: flattenBlocks(cell.content || [], { ...ctx, indent: 0 }),
        header: cell.type === 'tableHeader' || row.attrs?.repeat === true,
        marginsPx: cleanMargins(cell.attrs?.margins),
        ...(sizePair(cell.attrs?.hwpSz) ? { hwpSz: sizePair(cell.attrs?.hwpSz)! } : {}),
        ...(keptCellBf(cell.attrs) != null ? { bf: keptCellBf(cell.attrs)! } : {}),
        ...(cellBgImage(cell.attrs?.bgImages) ? { bgImage: cellBgImage(cell.attrs?.bgImages) } : {}),
        ...(cell.attrs?.vertical === true ? { vertical: true } : {}),
      };
      cellWidths.set(fc, cw);
      list.push(fc);
      c += cs;
      maxCols = Math.max(maxCols, c);
    }
    cells.push(list);
  });
  for (const o of occupied) if (o) maxCols = Math.max(maxCols, o.length);
  // 열 너비
  const widths: (number | null)[] = new Array(maxCols).fill(null);
  for (const row of cells)
    for (const cell of row) {
      const cw = cellWidths.get(cell);
      if (cw && cw.length === cell.colspan) cw.forEach((w, i) => {
        if (w && widths[cell.col + i] == null) widths[cell.col + i] = w;
      });
    }
  const known = widths.filter((w) => w != null) as number[];
  const DEFAULT_TOTAL = 567; // A4 본문 폭 약 150mm (px)
  const rest = widths.length - known.length;
  const each = rest ? Math.max(40, (DEFAULT_TOTAL - known.reduce((a, b) => a + b, 0)) / rest) : 0;
  const colWidthsPx = widths.map((w) => (w == null ? each : w));
  for (const row of cells) for (const cell of row) if (!cell.widthPx) cell.widthPx = colWidthsPx.slice(cell.col, cell.col + cell.colspan).reduce((a, b) => a + b, 0);
  const cellPadPx = n.attrs?.cellPadding != null ? +n.attrs.cellPadding : 6.8;
  const rowHeightsPx = rowsJ.map((r) => ((r.attrs?.height ?? 0) > 0 ? +r.attrs!.height : null));
  const segs = keptSegs(n.attrs);
  const hwpPos = rawPosOf(n.attrs?.hwpPos);
  // 딸린 표·합칠 표는 고치지 않았을 때만 (고치면 편집기가 hwpSeg 표시를 지운다: hwpKeep)
  const intact = Array.isArray(n.attrs?.hwpSeg);
  const anchor = intact && (n.attrs?.hwpAnchor === 'prev' || n.attrs?.hwpAnchor === 'next') ? n.attrs!.hwpAnchor : null;
  const join = intact && n.attrs?.inline && n.attrs?.hwpJoin === 'next' ? 'next' : null;
  const pr = keptParaRef(n.attrs);
  const hwpSz = sizePair(n.attrs?.hwpSz);
  const cp = keptObjCharRef(n);
  const tbf = Number.isInteger(n.attrs?.hwpBf) && n.attrs!.hwpBf >= 1 ? (n.attrs!.hwpBf as number) : null;
  const hc = n.attrs?.hwpCap;
  const capGeo = hc && typeof hc.side === 'string' && /^(LEFT|RIGHT|TOP|BOTTOM)$/.test(hc.side) ? { side: hc.side, w: Math.max(0, Math.min(1_000_000, +hc.w || 8504)), gap: Math.max(0, Math.min(100_000, +hc.gap || 850)), full: !!hc.full } : null;
  return { ...(cp != null ? { cp } : {}), ...(tbf != null ? { bf: tbf } : {}), ...(capGeo ? { capGeo } : {}), ...(hwpPos ? { hwpPos } : {}), ...(hwpPos && anchor ? { anchor } : {}), ...(join ? { join } : {}), ...(pr ? { pr } : {}), ...(hwpSz ? { hwpSz } : {}), kind: 'table', rows: rowsJ.length, cols: maxCols, colWidthsPx, cells, pageBreakBefore: false, align: n.attrs?.align || 'left', cellPadPx, rowHeightsPx, outMarginPx: cleanMargins(n.attrs?.outMargin), inline: n.attrs?.inline === true, pageSplit: n.attrs?.pageSplit === 'row' || n.attrs?.pageSplit === 'none' ? n.attrs.pageSplit : null, cellSpacingPx: cellSpacingOf(n.attrs?.cellSpacing) , ...(segs ? { segs } : {}) };
}
