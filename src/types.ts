import type { JSONContent } from '@tiptap/core';

/** 편집 용지 설정 (단위: mm). 한글과 동일하게 본문 시작 = 위쪽 + 머리말, 본문 끝 = 아래쪽 + 꼬리말 */
export interface PageSetup {
  width: number;
  height: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  marginHeader: number;
  marginFooter: number;
  gutter: number;
  landscape: boolean;
  /** 다단 (없으면 한 단) */
  columns?: Columns | null;
}

/** 다단: 본문을 여러 단으로 나눈다 (한글의 쪽 → 다단 설정) */
export interface Columns {
  /** 단 수 (2 이상. 1 은 '다단 설정 나누기'로 한 단으로 되돌릴 때만) */
  count: number;
  /** 단 사이 간격 mm (너비가 같은 단) */
  gap: number;
  /** 너비가 다른 단: 단마다의 너비 mm 와 그 뒤 간격 mm (없으면 같은 너비) */
  widths?: number[];
  gaps?: number[];
  /** 단 구분선: 굵기(mm)·색·종류. 없으면 긋지 않는다 */
  line?: { w: number; c: string; s: 'solid' | 'dashed' | 'dotted' | 'double' } | null;
}

export type HFAlign = 'left' | 'center' | 'right';

export interface HeaderFooter {
  /** 텍스트. {{PAGE}} = 현재 쪽, {{PAGES}} = 전체 쪽 수 */
  text: string;
  align: HFAlign;
  /** 영역 안 세로 맞춤 (content 를 그릴 때. 한글의 머리말·꼬리말 세로 정렬). 없으면 위 */
  valign?: 'top' | 'middle' | 'bottom';
  /** 짝수 쪽에 쓰는 머리말/꼬리말 (한글의 '짝수 쪽'). 없으면 짝수 쪽도 이것을 쓴다 (oddOnly 면 비운다) */
  even?: HeaderFooter;
  /** 첫 쪽에만 쓰는 머리말/꼬리말 (Word 의 '첫 페이지를 다르게'). 없으면 첫 쪽도 이것을 쓴다 */
  first?: HeaderFooter;
  /** 홀수 쪽에만 (한글의 '홀수 쪽'만 있는 문서) */
  oddOnly?: boolean;
  /** 이 쪽(0부터)부터 쓴다: 머리말이 뒤 구역에서 시작하는 문서 (앞 쪽들에는 없다) */
  from?: number;
  /**
   * 표·그림이 든 머리말/꼬리말 (HWP 에서 읽은 문서 블록 JSON). 있으면 text 대신 이것을 그린다.
   * 글자 '{{PAGE}}' 는 쪽 번호로 바뀐다. 대화상자에서 text 를 고치면 지워진다.
   */
  content?: JSONContent[];
}

export type PageNumPos =
  | 'none'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export type PageNumFormat = 'digit' | 'dash' | 'roman' | 'ROMAN' | 'paren';

export interface PageNumbering {
  pos: PageNumPos;
  format: PageNumFormat;
  start: number;
  /** start 가 매겨지는 쪽(0부터). 한글의 '새 번호로 시작'이 뒤쪽에 있는 문서 (없으면 첫 쪽) */
  base?: number;
  /** 이 쪽(0부터)부터 쪽 번호를 찍는다 (없으면 첫 쪽부터) */
  from?: number;
}

export interface DocSettings {
  page: PageSetup;
  header: HeaderFooter;
  footer: HeaderFooter;
  pageNumber: PageNumbering;
  /**
   * 첫 쪽만의 본문 영역 (Word 의 '첫 페이지를 다르게': 첫 쪽의 머리말·꼬리말 길이가 달라 본문 시작·끝이 다르다).
   * 적힌 값이 첫 쪽에서 page 의 같은 값을 갈음한다
   */
  firstPage?: { marginHeader?: number; marginFooter?: number };
  /** 첫 쪽에서 감추는 것 (한글의 '감추기': 표지 쪽의 머리말·꼬리말·쪽 번호) */
  hideFirst?: { header?: boolean; footer?: boolean; pageNum?: boolean; masterPage?: boolean };
  /**
   * 줄 높이를 문단 줄 간격으로만 정한다 (PDF 처럼). 글꼴이 섞인 줄이 글꼴마다 다른 위아래 높이 때문에
   * 줄 간격보다 높아지지 않게 한다. PDF 에서 불러온 문서에 켠다.
   */
  fixedLines?: boolean;
  /**
   * 글자 폭을 한글(HWP) 방식으로 그린다: 자간·장평은 그 글자 폭에 대한 비율, 빈칸은 글자 크기의 절반.
   * HWP/HWPX 에서 불러온 문서에 켠다.
   */
  hwpMetrics?: boolean;
  /**
   * PDF 에서 꺼낸 글꼴 (시스템에 없는 글꼴의 일부 글자). 문서와 함께 다녀서 자동 저장에서 복구해도
   * 같은 글꼴로 그린다. data 는 base64 OpenType.
   */
  pdfFonts?: PdfFontFace[];
  /** 메모 내용: 메모 id → 작성자·시각·내용·답글 (본문에는 id 표시만) */
  comments?: Record<string, { author: string; time: number; text: string; resolved?: boolean; replies?: { author: string; time: number; text: string }[] }>;
  /** 쪽 배경 그림 (PDF 의 쪽 전체 바탕 그림): 쪽 번호(0부터) → 그림과 위치·크기(pt) */
  pageBackgrounds?: (PageBackground | null)[];
  /** 쪽 테두리/배경 */
  pageBorder?: PageBorder | null;
  /** 바탕쪽 */
  masterPages?: MasterPage[];
}

/** 쪽 테두리의 한 변: 굵기(mm)·색·종류 */
export interface PageBorderSide {
  w: number;
  c: string;
  s: 'solid' | 'dashed' | 'dotted' | 'double';
}

/** 쪽 테두리/배경 (한글의 쪽 → 쪽 테두리/배경) */
export interface PageBorder {
  /** 그릴 변 (없는 변은 그리지 않는다) */
  sides?: Partial<Record<'l' | 'r' | 't' | 'b', PageBorderSide>>;
  /** 테두리 위치의 기준: 본문 영역에서 바깥으로(true) 또는 종이 끝에서 안으로(false) */
  body: boolean;
  /** 기준에서 떨어진 거리 mm [왼, 오른, 위, 아래] */
  offset: number[];
  /** 본문 기준일 때 머리말·꼬리말 영역까지 테두리 안에 넣는다 */
  headerInside?: boolean;
  footerInside?: boolean;
  /** 채우기: 바탕색, 그러데이션(CSS), 그림(data URL)과 그림 채우는 방식(TOTAL 크기에 맞춤, TILE 바둑판, CENTER 가운데 …) */
  bg?: string | null;
  gradient?: string | null;
  image?: string | null;
  imageMode?: string | null;
  /** 채울 영역: 종이 전체, 쪽(본문 영역), 테두리 안 */
  fillArea?: 'paper' | 'page' | 'border';
  /** 첫 쪽에만(first) 또는 첫 쪽 빼고(notFirst). 없으면 모든 쪽 */
  borderOn?: 'first' | 'notFirst' | null;
  fillOn?: 'first' | 'notFirst' | null;
}

/** 바탕쪽: 쪽마다 본문 뒤에 깔리는 내용 (한글의 쪽 → 바탕쪽) */
export interface MasterPage {
  /** 문서 블록 JSON (본문 영역의 왼쪽 위를 기준으로 그린다) */
  content: JSONContent[];
  /** 적용할 쪽: 양쪽, 짝수 쪽, 홀수 쪽 */
  type: 'both' | 'even' | 'odd';
}

export interface PageBackground {
  src: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PdfFontFace {
  family: string;
  alias?: boolean;
  weight: string;
  style: string;
  unicodeRange: string;
  data: string;
}

export interface DocMeta {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  created?: string;
  modified?: string;
}

export interface KDocument {
  content: JSONContent;
  settings: DocSettings;
  meta: DocMeta;
}

export interface LoadedDoc extends KDocument {
  warnings: string[];
}

export type FormatId = 'hwpx' | 'hwp' | 'docx' | 'doc' | 'pdf' | 'md' | 'html' | 'txt';
export type SaveFormatId = 'hwpx' | 'hwp' | 'docx' | 'md' | 'html' | 'txt' | 'pdf';
