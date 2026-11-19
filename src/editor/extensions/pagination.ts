import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { viewState } from '../viewState';
import type { Columns, PageSetup, SectionHf } from '../../types';
import { columnGeom, type ColGeom } from '../../formats/common';
import { hwpLineBoxes } from './hwpMetrics';
import { ownMargins } from './sections';
import { decorationSet } from '../decoSet';

/**
 * 쪽 나누기(페이지네이션) 엔진.
 *
 * 편집기는 하나의 연속된 ProseMirror 문서이고, 쪽 경계에 걸리는 블록/표 줄/문단 줄 앞에
 * 빈 공간(위젯 데코레이션)을 끼워 넣어 다음 쪽 본문 시작 위치로 밀어낸다.
 * 측정은 항상 "공간을 뺀 자연 배치" 상태에서 수행하므로 결과가 안정적이다.
 */

export interface PageGeometry {
  /** 용지 높이(px) */
  pageHeight: number;
  /** 쪽 사이 간격(px) */
  gap: number;
  /** 본문 높이(px) = 용지 높이 - (위쪽+머리말) - (아래쪽+꼬리말) */
  contentHeight: number;
  /** 본문 폭(px) */
  contentWidth: number;
  /** 본문 위 여백(px) = 위쪽 + 머리말 (구역마다 용지가 다를 때 쪽 위치를 잇는 데 쓴다) */
  mt?: number;
  /** 다단 (문서 용지의 것. 구역마다의 다단은 resolve 가 돌려준다) */
  columns?: Columns | null;
  /** 구역 나누기(쪽 나누기의 sectionPage)의 용지 → 그 구역의 쪽 기하 */
  resolve?: (p: PageSetup) => PageGeometry;
  /** 첫 쪽만 본문 영역이 다른 문서: 둘째 쪽부터의 용지 (이 기하는 첫 쪽의 것) */
  rest?: PageSetup | null;
}

function sameGeometry(a: PageGeometry | null, b: PageGeometry | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.pageHeight === b.pageHeight && a.gap === b.gap && a.contentHeight === b.contentHeight && a.contentWidth === b.contentWidth && a.mt === b.mt && JSON.stringify(a.columns || null) === JSON.stringify(b.columns || null) && JSON.stringify(a.rest || null) === JSON.stringify(b.rest || null);
}

export interface PageBreakInfo {
  pos: number;
  height: number;
  /**
   * grow: 칸 안에서 나뉜 표 줄의 높이를 그 값으로 (자연 높이 + 끼운 공간: 칸 아래 남는 자리를 지킨다)
   * col: 다단에서 블록이 놓인 단 (x 만큼 오른쪽으로, 오른쪽 여백을 r 로). seg: 다른 단·쪽으로 넘어간 문단 안 줄들(pos~end)을
   * 제자리에서 (dx, height) 만큼 옮겨 그린다
   */
  kind: 'block' | 'row' | 'line' | 'grow' | 'col' | 'seg';
  x?: number;
  r?: number;
  /** col: 목록 등 안쪽 블록 (가로로만 옮긴다) */
  inner?: boolean;
  end?: number;
  dx?: number;
  /** 표가 이어지는 쪽의 맨 위에 되풀이할 제목 줄: 표 위치, 그 쪽 번호(0부터), 제목 줄 높이(px). 높이만큼 공간에 더해 둔다 */
  head?: RepeatHead;
  /** 표의 줄이 칸 안에서 나뉜 자리: 그 쪽에서 표가 끝나는 곳에 닫는 선을 긋는다 (한글처럼) */
  cut?: TableCut;
}

/** 쪽 경계에서 나뉜 표: 표 위치, 표가 끊긴 쪽(0부터), 그 쪽 본문 맨 위에서 끊긴 자리까지(px) */
export interface TableCut {
  table: number;
  page: number;
  y: number;
  /**
   * 닫는 선 (Word 등 한글 문서가 아닌 것): CSS 선 값. 'none' 이면 긋지 않는다 (줄이 통째로 넘어간 곳: 표 자신의 선이 그 자리에 있다).
   * off: 덮개를 그만큼 아래에서 시작한다 (그 자리의 표 선을 가리지 않게). 없으면 1px 검은 선 (한글)
   */
  line?: string;
  off?: number;
}

/** 표 칸의 한 변의 선 (CSS 값·굵기 px). 선이 없으면 null */
function cellLine(td: Element | null | undefined, side: 'Top' | 'Bottom'): { css: string; w: number } | null {
  if (!(td instanceof HTMLElement)) return null;
  const cs = getComputedStyle(td);
  const w = parseFloat(side === 'Top' ? cs.borderTopWidth : cs.borderBottomWidth) || 0;
  const st = side === 'Top' ? cs.borderTopStyle : cs.borderBottomStyle;
  if (!(w > 0) || st === 'none' || st === 'hidden') return null;
  return { css: `${w}px ${st} ${side === 'Top' ? cs.borderTopColor : cs.borderBottomColor}`, w };
}

export interface RepeatHead {
  table: number;
  page: number;
  h: number;
}

export interface FootnoteInfo {
  num: number;
  page: number;
  text: string;
  pos: number;
}

/** 단 구분선: 쪽(0부터), 본문 왼쪽에서의 가로 자리, 본문 맨 위에서의 세로 범위(px), 굵기(mm)·색·종류 */
export interface ColLine {
  page: number;
  x: number;
  y1: number;
  y2: number;
  w: number;
  c: string;
  s: string;
}

export interface LayoutResult {
  pageCount: number;
  footnotes: FootnoteInfo[];
  /** 각 쪽의 시작 문서 위치 (쪽 이동용) */
  pageStarts: number[];
  /** 쪽 맨 위에 되풀이해 그릴 표 제목 줄 */
  repeats?: RepeatHead[];
  /** 쪽 경계에서 칸이 나뉜 표의 닫는 선 */
  cuts?: TableCut[];
  /** 쪽마다의 편집 용지 (구역마다 용지가 다른 문서만. null 은 문서 용지) */
  pageSetups?: (PageSetup | null)[];
  /** 쪽마다 그 쪽이 든 구역의 머리말·꼬리말(구역 나누기의 sectionHf)과 그 구역이 시작한 쪽. 구역마다 다른 머리말이 있는 문서에만 */
  pageHfs?: ({ hf: SectionHf; start: number } | null)[];
  /** 다단의 단 구분선 */
  colLines?: ColLine[];
}

interface PState {
  breaks: PageBreakInfo[];
  decos: DecorationSet;
}

export const paginationKey = new PluginKey<PState>('pagination');

export const FN_FONT_PX = 12; // 9pt
export const FN_LINE = 1.5;
export const FN_SEP = 14;

export function estimateFootnoteHeight(text: string, width: number): number {
  let w = 0;
  for (const ch of text) w += /[ᄀ-ᇿ　-鿿가-힯＀-￯]/.test(ch) ? FN_FONT_PX : FN_FONT_PX * 0.55;
  const lines = Math.max(1, Math.ceil((w + 28) / Math.max(50, width)));
  return Math.ceil(lines * FN_FONT_PX * FN_LINE + 2);
}

/**
 * 칸의 높이 중 내용이 차지하는 몫 (위아래 안 여백·선 포함, 세로 가운데 정렬로 남는 공간 제외). 배치 값(offset)으로
 * 재므로 글자 위치를 옮기는 transform 의 영향을 받지 않는다. 잴 수 없으면 null
 */
function cellContentHeight(td: HTMLElement | null): number | null {
  if (!(td instanceof HTMLElement)) return null;
  const kids = Array.from(td.children).filter((c) => c instanceof HTMLElement && !c.classList.contains('pg-spacer') && getComputedStyle(c).display !== 'none') as HTMLElement[];
  if (!kids.length) return null;
  const first = kids[0];
  const last = kids[kids.length - 1];
  const cs = getComputedStyle(td);
  const px = (v: string) => parseFloat(v) || 0;
  const top = first.offsetTop - px(getComputedStyle(first).marginTop);
  const bottom = last.offsetTop + last.offsetHeight + px(getComputedStyle(last).marginBottom);
  return px(cs.paddingTop) + px(cs.borderTopWidth) + (bottom - top) + px(cs.paddingBottom) + px(cs.borderBottomWidth);
}

function buildDecos(doc: PMNode, breaks: PageBreakInfo[]): DecorationSet {
  const decos: Decoration[] = [];
  // 위젯 key 에 위치를 넣으면 한 글자만 쳐도 뒤쪽 모든 나누기의 위치가 밀려 수백 개 위젯이 다시 그려진다.
  // 몇 번째 나누기인지와 높이만 넣어, 같은 자리의 같은 높이면 ProseMirror 가 기존 DOM 을 그대로 쓰게 한다.
  let i = 0;
  for (const b of breaks) {
    if (b.kind === 'grow') {
      const node = doc.nodeAt(b.pos);
      if (!node || node.type.name !== 'tableRow') continue;
      decos.push(Decoration.node(b.pos, b.pos + node.nodeSize, { class: 'pg-grow-row', style: `--pg-grow: ${b.height}px` }));
      continue;
    }
    if (b.kind === 'row') {
      const node = doc.nodeAt(b.pos);
      if (!node || node.type.name !== 'tableRow') continue;
      decos.push(Decoration.node(b.pos, b.pos + node.nodeSize, { class: 'pg-push-row', style: `--pg-push: ${b.height}px` }));
      continue;
    }
    if (b.kind === 'col') {
      const node = doc.nodeAt(b.pos);
      if (!node || !node.isBlock) continue;
      decos.push(Decoration.node(b.pos, b.pos + node.nodeSize, b.inner ? { class: 'pg-col-in', style: `--col-dx: ${b.x || 0}px` } : { class: 'pg-col', style: `--col-x: ${b.x || 0}px; --col-r: ${b.r || 0}px` }));
      continue;
    }
    if (b.kind === 'seg') {
      const end = Math.min(b.end ?? b.pos, doc.content.size);
      if (end > b.pos) decos.push(Decoration.inline(b.pos, end, { class: 'pg-seg', style: `left: ${b.dx || 0}px; top: ${b.height}px` }));
      continue;
    }
    const block = b.kind === 'block';
    decos.push(
      Decoration.widget(
        b.pos,
        () => {
          const el = document.createElement(block ? 'div' : 'span');
          el.className = block ? 'pg-spacer' : 'pg-spacer pg-line-spacer';
          if (b.height >= 0) el.style.height = b.height + 'px';
          else {
            // 음수: 뒤 블록을 그만큼 끌어올린다 (한글이 놓은 자리가 자연 배치보다 위)
            el.style.height = '0';
            el.style.marginBottom = b.height + 'px';
          }
          el.contentEditable = 'false';
          return el;
        },
        // 줄 사이 공간은 한글 줄 바꿈(-3) 뒤, 줄 버팀대(-1) 앞에 온다 (hwpMetrics)
        { side: block ? -1 : -2, key: `pg-${b.kind}-${i++}-${b.height}`, ignoreSelection: true, marks: [] },
      ),
    );
  }
  return decorationSet(doc, decos);
}

/** 제목 칸으로만 된 줄인가 */
export function isHeaderRow(row: PMNode): boolean {
  if (row.attrs?.repeat === true) return true;
  let all = true;
  row.forEach((c) => {
    if (c.type.name !== 'tableHeader') all = false;
  });
  return all;
}

const CONTAINERS = new Set(['bulletList', 'orderedList', 'listItem', 'blockquote', 'taskList', 'taskItem']);

function sameBreaks(a: PageBreakInfo[], b: PageBreakInfo[]) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].pos !== b[i].pos || a[i].kind !== b[i].kind || Math.abs(a[i].height - b[i].height) > 0.6) return false;
    if (a[i].head?.table !== b[i].head?.table || a[i].head?.page !== b[i].head?.page) return false;
    if (Math.abs((a[i].x || 0) - (b[i].x || 0)) > 0.1 || Math.abs((a[i].r || 0) - (b[i].r || 0)) > 0.1 || Math.abs((a[i].dx || 0) - (b[i].dx || 0)) > 0.1 || (a[i].end ?? -1) !== (b[i].end ?? -1)) return false;
  }
  return true;
}

interface Line {
  top: number;
  bottom: number;
}

/** 최상위 블록 하나를 배치하기 직전의 상태 (증분 배치용) */
interface Snap {
  /** 블록의 자연 배치 위쪽 (문서 기준 px, 공간 제외) */
  top: number;
  page: number;
  shift: number;
  fnUsed: number;
  forceNext: boolean;
  lastBottom: number;
  nBreaks: number;
  nFn: number;
  nStarts: number;
  /** 한글 배치를 따르는 중인가, 앞 블록의 차례, 앞 블록이 시작한 쪽 */
  chain: boolean;
  lastSeq: number;
  prevStartPage: number;
}

/** 한글 자리에 맞춘 블록: 문서 위치, 차례, 놓여야 할 자리(편집기 좌표 px) */
export interface FixedBlock {
  pos: number;
  seq: number;
  y: number;
}

export interface LayoutCache {
  doc: PMNode;
  snaps: Snap[];
  breaksLen: number;
  footnotes: FootnoteInfo[];
  pageStarts: number[];
  pageCount: number;
  lastBottom: number;
}

/** 지난 배치 뒤로 문서가 바뀐 범위 (현재 문서 좌표) 와 그동안의 위치 변환 */
export interface DirtyRange {
  from: number;
  to: number;
  mapping: Mapping;
}

/**
 * @param cache 지난 배치 결과. dirty 와 함께 주면 바뀐 최상위 블록부터만 다시 재고,
 *              그 뒤 블록의 절대 위치·쪽 상태가 지난번과 같아지는 순간 멈추고 지난 결과를 이어 쓴다.
 * @param curBreaks 플러그인 상태의 현재 나눔 목록 (지난 결과를 문서 변경에 맞춰 옮겨 둔 것)
 */
/** 최상위 블록들의 그리기 정보(ProseMirror 의 ViewDesc)와 문서 안 시작 자리 */
interface TopDescs {
  offsets: number[];
  descs: any[];
}

/** 편집기의 최상위 블록 ViewDesc 들을 문서 차례로 (내부 구조가 다르거나 문서와 맞지 않으면 null) */
function topLevelDescs(view: EditorView): TopDescs | null {
  const children = (view as any).docView?.children;
  if (!Array.isArray(children)) return null;
  const offsets: number[] = [];
  const descs: any[] = [];
  let off = 0;
  for (const c of children) {
    const size = c?.size;
    if (typeof size !== 'number') return null;
    if (c.node && size > 0) {
      offsets.push(off);
      descs.push(c);
    }
    off += size;
  }
  return off === view.state.doc.content.size ? { offsets, descs } : null;
}

/** pos 에 있는 노드의 DOM (view.nodeDOM 과 같은 것): pos 를 품은 최상위 블록을 이분 탐색으로 찾고 그 안에서 찾는다 */
function domIn(t: TopDescs, pos: number): Node | null {
  const { offsets, descs } = t;
  if (!offsets.length) return null;
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  const d = descs[lo];
  const off = offsets[lo];
  if (!d || pos < off || pos >= off + d.size) return null;
  try {
    if (pos === off) return d.nodeDOM ?? d.dom ?? null;
    const inner = typeof d.descAt === 'function' ? d.descAt(pos - off - (d.border ?? 1)) : null;
    return inner ? inner.nodeDOM ?? null : null;
  } catch {
    return null;
  }
}

function computeLayout(
  view: EditorView,
  g: PageGeometry,
  cache: LayoutCache | null = null,
  dirty: DirtyRange | null = null,
  curBreaks: PageBreakInfo[] = [],
  /** 한글 자리에 맞춘 블록의 보정값 (블록 차례 → px): 셈한 배치와 실제 화면의 차이 (run 이 잰다) */
  corr: Map<number, number> | null = null,
): { breaks: PageBreakInfo[]; result: LayoutResult; cache: LayoutCache; incremental: boolean; fixed: FixedBlock[]; tops: number[] } | null {
  const root = view.dom as HTMLElement;
  const s = viewState.zoom || 1;
  // 블록의 DOM: view.nodeDOM(pos) 는 부를 때마다 문서 처음부터 블록을 세므로(블록 수만큼) 블록 수만 개 문서에서
  // 배치가 블록 수의 제곱만큼 걸렸다. 최상위 블록들의 자리를 한 번 모아 두고 그 안에서만 찾는다
  let topDescs: TopDescs | null | undefined;
  const nodeDom = (pos: number): Node | null => {
    if (topDescs === undefined) topDescs = topLevelDescs(view);
    return (topDescs && domIn(topDescs, pos)) || view.nodeDOM(pos);
  };
  // 공간을 숨기면 스크롤이 조정되어 편집기 자체가 움직일 수 있으므로, 전환할 때마다 기준점을 다시 읽는다
  let rootTop = root.getBoundingClientRect().top;
  const refreshRootTop = () => {
    rootTop = root.getBoundingClientRect().top;
  };
  const relRaw = (y: number) => (y - rootTop) / s;
  // 증분 배치: 바뀐 블록들과 그 사이 스페이서만 자연 상태로 바꾸고(부분 숨김), 바뀐 첫 블록의 자연 위치는
  // 지난 스냅샷에서 가져와 그 차이(offset)로 나머지를 환산한다. 문서 전체를 숨겼다 되돌리면
  // 큰 문서에서 다시 배치하는 데만 100ms 넘게 걸렸다.
  let offset = 0;
  const rel = (y: number) => relRaw(y) - offset;
  // 쪽마다의 기하: 높이·본문 높이·본문 위 여백. 구역마다 용지가 다를 수 있어 쪽 위치는 누적으로 구한다.
  // 편집기 좌표 0 = 첫 쪽 본문 맨 위. k 쪽 본문 맨 위 T(k) = T(k-1) - mt(k-1) + H(k-1) + 간격 + mt(k)
  interface Pg {
    H: number;
    CH: number;
    mt: number;
    setup: PageSetup | null;
    /** 이 구역의 머리말·꼬리말 (구역 나누기에 담긴 것) */
    hf?: SectionHf | null;
  }
  const basePg: Pg = { H: g.pageHeight, CH: g.contentHeight, mt: g.mt ?? 0, setup: null };
  /** 확정된 쪽(지금 쪽까지)의 기하와 본문 맨 위 */
  const pgs: Pg[] = [basePg];
  const tops: number[] = [0];
  /** 앞으로 생길 쪽의 기하 (구역 나누기를 지나면 바뀐다) */
  let curPg: Pg = basePg;
  /** 구역마다 용지가 다른 문서 (쪽 크기가 같다고 보는 증분 배치를 쓰지 않는다) */
  let multi = false;
  view.state.doc.forEach((n) => {
    if (n.type.name === 'pageBreak' && n.attrs?.sectionPage) multi = true;
  });
  // 첫 쪽만 본문 영역이 다른 문서: 둘째 쪽부터는 문서 용지 그대로
  if (g.rest && g.resolve) {
    const sg = g.resolve(g.rest);
    curPg = { H: sg.pageHeight, CH: sg.contentHeight, mt: sg.mt ?? 0, setup: g.rest };
    multi = true;
  }
  if (multi) cache = null;
  // ---- 다단 ----
  /** 지금 다단 (없으면 한 단), 지금 구역의 본문 폭, 지금 단 */
  let cols: ColGeom | null = columnGeom(g.columns, g.contentWidth);
  let colW = g.contentWidth;
  let col = 0;
  /** 다단 문서: 블록마다의 단 상태까지 이어 가야 하므로 증분 배치를 쓰지 않는다 */
  let hasCols = !!cols;
  view.state.doc.forEach((n) => {
    if (n.type.name === 'columnBreak' || (n.type.name === 'pageBreak' && n.attrs?.sectionPage?.columns)) hasCols = true;
  });
  if (hasCols) cache = null;
  /** 지금 다단이 시작한 쪽과 그 쪽 본문 안 세로 자리 (다른 쪽에서는 맨 위부터) */
  let zonePage = 0;
  let zoneTop = 0;
  let zoneId = 0;
  /** 단 나누기를 지났다: 다음 블록은 다음 단으로 */
  let forceCol = false;
  /** 다단 설정 나누기·구역 나누기를 지났다: 다음 블록부터 그 다단으로 (w: 그 구역의 본문 폭) */
  let pendingZone: { cols: ColGeom | null; w?: number } | null = null;
  /** 지금 최상위 블록이 시작한 단과 그때의 다단·본문 폭, 지금 말단 블록이 시작한 단 */
  let blockCol = -1;
  let blockCols: ColGeom | null = null;
  let blockCW = 0;
  let leafCol = -1;
  /** 쪽마다 다단이 차지한 세로 범위 (단 구분선을 긋는다) */
  const zones = new Map<string, { page: number; id: number; top: number; bottom: number; cols: ColGeom }>();
  /** 줄 단위로 놓는 중인 문단: 끝 위치, 시작한 단, 다른 단·쪽으로 넘긴 줄들을 옮겨 그린 만큼 */
  let curPara: { end: number; startCol: number; rel: boolean; dy: number; seg: PageBreakInfo | null } | null = null;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const MAX_PAGES = 20000;
  /** k 쪽 본문 맨 위 (아직 없는 쪽은 앞으로 생길 쪽의 기하로) */
  const T = (k: number): number => {
    if (k < tops.length) return tops[k];
    let t = tops[tops.length - 1];
    let prev = pgs[pgs.length - 1];
    for (let i = tops.length; i <= k; i++) {
      // 쪽이 늘 아래로 나아가게 (이상한 용지 값에도 멈추지 않도록)
      t += Math.max(1, prev.H - prev.mt + g.gap + curPg.mt);
      prev = curPg;
    }
    return t;
  };
  const CHof = (k: number) => (k < pgs.length ? pgs[k] : curPg).CH;
  /** y 가 놓인 쪽: T(k) <= y 인 가장 큰 k (from 부터 센다) */
  const pageAtY = (y: number, from = 0) => {
    let k = Math.max(0, from);
    while (k < MAX_PAGES && T(k + 1) <= y) k++;
    return k;
  };
  /** 지금 쪽까지 기하를 확정한다 */
  const commit = () => {
    while (tops.length <= page && tops.length < MAX_PAGES) {
      tops.push(T(tops.length));
      pgs.push(curPg);
    }
  };

  let page = 0;
  let shift = 0;
  let fnUsed = 0;
  let forceNext = false;
  /** 한글이 새 쪽에서 시작한 블록(hwpPage): 쪽 맨 위가 아니면 넘긴다 */
  let softNext = false;
  /**
   * 한글이 놓은 자리(hwpTop)를 따르는 중인가: 이 쪽에서 지금까지의 최상위 블록이 모두 한글 문서 그대로일 때
   * (차례가 이어지고 내용 크기가 그대로). 고치거나 끼우거나 지운 블록을 만나면 그 쪽 끝까지는 자연 배치로 흐른다
   */
  let chain = false;
  let lastSeq = 0;
  /** 한글 줄 정보를 가진 앞 블록이 끝난 쪽, 지금 블록이 시작한 쪽 */
  let prevStartPage = -1;
  let blockStart = -1;
  let lastBottom = 0;
  /** 지금 배치하는 표의 되풀이할 제목 줄 (제목 줄 다음 줄들을 배치하는 동안만) */
  let tableHead: { table: number; h: number } | null = null;
  /** 지금 배치하는 표의 위치 */
  let curTable = -1;
  let breaks: PageBreakInfo[] = [];
  let footnotes: FootnoteInfo[] = [];
  let pageStarts: number[] = [0];
  const doc = view.state.doc;
  const clampPos = (p: number) => Math.max(0, Math.min(doc.content.size, p));

  // ---- 증분 배치 준비 ----
  // startIndex: 다시 재기 시작할 최상위 블록, resumeNew/resumePrev: 바뀐 범위 뒤의 첫 블록(현재/지난 문서)
  let startIndex = 0;
  let resumeNew = Infinity;
  let resumePrev = Infinity;
  let useCache = false;
  if (cache && dirty && curBreaks.length === cache.breaksLen && cache.snaps.length === cache.doc.childCount) {
    try {
      const $f = doc.resolve(clampPos(dirty.from));
      const $t = doc.resolve(clampPos(dirty.to));
      let si = $f.index(0);
      // '다음 문단과 함께'인 문단은 뒤 문단에 따라 놓이는 쪽이 달라진다: 바뀐 블록 앞의 그런 문단부터 다시 잰다
      while (si > 0 && si <= doc.childCount && String(doc.child(si - 1).attrs?.pageKeep || '').includes('n')) si--;
      const rn = $t.depth === 0 ? $t.index(0) : $t.index(0) + 1;
      const oldTo = dirty.mapping.invert().map(clampPos(dirty.to), 1);
      const $ot = cache.doc.resolve(Math.max(0, Math.min(cache.doc.content.size, oldTo)));
      const rp = $ot.depth === 0 ? $ot.index(0) : $ot.index(0) + 1;
      // 바뀐 범위가 넓으면(되돌리기 여러 단계 등) 블록마다 전환하는 증분보다 전체가 싸다
      if (rn - si > 60) return null;
      // 바뀐 범위 앞뒤의 블록 수가 맞아야 지난 스냅샷과 대응한다
      if (si < cache.snaps.length && rn >= si && rp >= si && cache.doc.childCount - rp === doc.childCount - rn) {
        const snap = cache.snaps[si];
        startIndex = si;
        resumeNew = rn;
        resumePrev = rp;
        useCache = true;
        page = snap.page;
        shift = snap.shift;
        fnUsed = snap.fnUsed;
        forceNext = snap.forceNext;
        chain = snap.chain;
        lastSeq = snap.lastSeq;
        prevStartPage = snap.prevStartPage;
        lastBottom = snap.lastBottom;
        breaks = curBreaks.slice(0, snap.nBreaks);
        footnotes = cache.footnotes.slice(0, snap.nFn).map((f) => ({ ...f, pos: dirty.mapping.map(f.pos) }));
        pageStarts = cache.pageStarts.slice(0, snap.nStarts).map((x) => dirty.mapping.map(x));
        if (!pageStarts.length) pageStarts = [0];
      }
    } catch {
      useCache = false;
    }
  }

  // 각주 번호 매기기 (문서 순서)
  const refEls = Array.from(root.querySelectorAll('sup.footnote-ref')) as HTMLElement[];
  const refNum = new Map<HTMLElement, number>();
  refEls.forEach((el, i) => {
    refNum.set(el, i + 1);
    if (el.textContent !== String(i + 1)) el.textContent = String(i + 1);
  });

  const zTop = () => (page === zonePage ? zoneTop : 0);
  const noteZone = (bottom: number) => {
    if (!cols) return;
    const key = page + ':' + zoneId;
    const z = zones.get(key);
    const b = bottom - T(page);
    if (z) z.bottom = Math.max(z.bottom, b);
    else zones.set(key, { page, id: zoneId, top: zTop(), bottom: b, cols });
  };
  /** 다단 설정 나누기·구역 나누기 뒤의 첫 블록에서 새 다단으로 바꾼다 */
  const startZone = () => {
    if (!pendingZone) return false;
    cols = pendingZone.cols;
    if (pendingZone.w != null) colW = pendingZone.w;
    col = 0;
    zoneId++;
    pendingZone = null;
    return true;
  };
  const noteBlockCol = () => {
    if (blockCol < 0) {
      blockCol = col;
      blockCols = cols;
      blockCW = colW;
    }
    if (leafCol < 0) leafCol = col;
  };
  /**
   * 단위를 h 만큼 옮긴다: 블록·줄 앞에 공간을 끼운다 (음수면 끌어올린다). 다른 단으로 가는 문단 안 줄은 공간으로는 옮길 수 없으므로
   * 그 줄부터 문단 끝까지를 제자리에서 옮겨 그리고(seg), 문단이 끝난 뒤에 그만큼의 공간을 끼운다 (endPara)
   */
  const moveBy = (h: number, pos: number, kind: PageBreakInfo['kind'], newCol: number) => {
    const para = curPara;
    if (kind === 'line' && para && (para.rel || newCol !== para.startCol || h < 0)) {
      para.rel = true;
      para.dy += h;
      if (para.seg) para.seg.end = pos;
      const seg: PageBreakInfo = { pos, end: para.end, kind: 'seg', height: r2(para.dy), dx: r2((cols ? cols.x[newCol] : 0) - (cols ? cols.x[para.startCol] : 0)) };
      breaks.push(seg);
      para.seg = seg;
    } else if (Math.abs(h) > 0.004) breaks.push({ pos, height: h, kind });
    shift += h;
  };
  const endPara = (after: number) => {
    const p = curPara;
    curPara = null;
    if (p && p.rel && Math.abs(p.dy) > 0.004) breaks.push({ pos: after, height: r2(p.dy), kind: 'block' });
  };

  const normalize = (top: number) => {
    if (!isFinite(top)) return;
    const target = pageAtY(top + 0.5, page);
    if (target > page) {
      page = Math.min(target, MAX_PAGES);
      fnUsed = 0;
      commit();
    }
  };
  const limitFor = (fnH: number) => T(page) + CHof(page) - fnUsed - (fnH > 0 && fnUsed === 0 ? FN_SEP : 0) - fnH;

  const markPageStart = (docPos: number) => {
    while (pageStarts.length <= page && pageStarts.length < MAX_PAGES) pageStarts.push(docPos);
  };

  /** 단위(블록/줄/표 줄) 배치. 넘치면 다음 쪽으로 민다. */
  const place = (
    top: number,
    bottom: number,
    fnH: number,
    getPos: () => number | null,
    kind: PageBreakInfo['kind'],
    docPos: number,
  ) => {
    if (!isFinite(top) || !isFinite(bottom)) return;
    top += shift;
    bottom += shift;
    let newZone = false;
    if (pendingZone && kind === 'block') {
      // 다단 설정 나누기: 앞 다단의 가장 긴 단 아래에서 새 다단을 시작한다
      const z = zones.get(page + ':' + zoneId);
      const target = z ? T(page) + z.bottom : -Infinity;
      if (col > 0 && !forceNext && target > top + 0.5) {
        const pos = getPos();
        if (pos != null) {
          const h = r2(target - top);
          breaks.push({ pos, height: h, kind });
          shift += h;
          top += h;
          bottom += h;
        }
      }
      newZone = startZone();
    }
    // 다단: 넘치는 블록·줄은 다음 단으로 (마지막 단이면 다음 쪽으로). 표의 줄은 단을 넘기지 못한다
    const mayCol = !!cols && col < cols.n - 1 && (kind === 'block' || kind === 'line');
    if (!cols) normalize(top);
    const pageTop = T(page);
    const colTop = pageTop + zTop();
    const overflow = bottom > limitFor(fnH) + 0.5 || top > pageTop + CHof(page);
    if (!forceNext && !softNext && (forceCol || overflow) && mayCol) {
      if (forceCol || top > colTop + 0.5) {
        const pos = getPos();
        if (pos != null) {
          const h = r2(colTop - top);
          moveBy(h, pos, kind, col + 1);
          top += h;
          bottom += h;
          col++;
        }
      }
    } else if ((forceNext || softNext || forceCol || overflow) && (forceNext || forceCol || top > pageTop + 0.5)) {
      const pos = getPos();
      if (pos != null) {
        const h = Math.round((T(page + 1) - top) * 100) / 100;
        if (h > 0) {
          moveBy(h, pos, kind, 0);
          top += h;
          bottom += h;
        }
        page++;
        fnUsed = 0;
        // 표의 줄이 넘어간 쪽에서는 표가 놓인 단에서 이어 간다
        if (kind === 'block' || kind === 'line') col = 0;
        commit();
        normalize(top);
      }
    }
    forceNext = false;
    softNext = false;
    forceCol = false;
    if (newZone) {
      zonePage = page;
      zoneTop = Math.max(0, r2(top - T(page)));
    }
    markPageStart(docPos);
    if (blockStart < 0) blockStart = page;
    noteBlockCol();
    if (fnH > 0) fnUsed += fnH + (fnUsed === 0 ? FN_SEP : 0);
    noteZone(Math.min(bottom, T(page) + CHof(page)));
    if (bottom > T(page) + CHof(page) + 0.5) {
      const endPage = Math.min(MAX_PAGES, pageAtY(bottom - 0.5, page));
      if (endPage > page) {
        page = endPage;
        fnUsed = 0;
        commit();
        markPageStart(docPos);
      }
    }
    lastBottom = Math.max(lastBottom, bottom);
  };

  const pxOf = (v: string) => parseFloat(v) || 0;
  /**
   * 한글이 놓은 자리에 블록을 맞춘다: want = 쪽 본문 맨 위에서 블록 위쪽까지(px). 자연 배치와의 차이만큼 블록 앞에
   * 공간을 끼운다 (위로 올려야 하면 음수). 쪽 나누기·한글의 새 쪽 표시가 있으면 다음 쪽의 그 자리로
   */
  const fixed: FixedBlock[] = [];
  const snapTo = (el: HTMLElement, pos: number, want: number, seq = 0, hwpCol = 0) => {
    // 표는 감싼 상자가 아니라 표 자체(테두리 상자)의 위쪽을 맞춘다: 표의 위 바깥 여백은 감싼 상자 안에 있다
    const box = (el.matches('table') ? el : el.querySelector(':scope > table')) || el;
    const top = rel(box.getBoundingClientRect().top) + shift;
    const newZone = startZone();
    if (forceNext || (softNext && top > T(page) + 0.5)) {
      page = Math.min(page + 1, MAX_PAGES);
      fnUsed = 0;
      commit();
    }
    // 단은 한글이 놓은 대로 (리더가 줄 자리로 세어 둔 것)
    col = cols ? Math.max(0, Math.min(cols.n - 1, hwpCol)) : 0;
    forceCol = false;
    if (newZone) {
      zonePage = page;
      zoneTop = Math.max(0, want);
    }
    noteBlockCol();
    // 셈한 밀림(shift)은 칸 안에서 나뉜 표 줄 뒤에서 실제 화면과 1px 남짓 어긋날 수 있다. 지난번에 잰 차이만큼 보정한다
    const d = Math.round((T(page) + want - top) * 100) / 100;
    // 보정값은 끼우는 공간에만 더한다: 셈한 밀림은 그대로 두어야 이 블록부터 셈과 화면이 다시 맞는다
    const dc = Math.round((d + (corr?.get(seq) || 0)) * 100) / 100;
    fixed.push({ pos, seq, y: T(page) + want });
    if (Math.abs(dc) >= 0.25 || Math.abs(d) >= 0.25) {
      let h = dc;
      if (dc > 0) {
        // 바깥 여백끼리 맞닿아 겹치던 자리(표와 표 사이)에 공간을 끼우면 두 여백이 따로 서므로 그만큼 뺀다
        const mt = pxOf(getComputedStyle(el).marginTop);
        let prev = el.previousElementSibling;
        while (prev && prev.classList.contains('pg-spacer')) prev = prev.previousElementSibling;
        const mb = prev && mt > 0 ? pxOf(getComputedStyle(prev).marginBottom) : 0;
        if (mt > 0 && mb > 0) h = Math.max(0.01, dc - Math.min(mt, mb));
      }
      breaks.push({ pos, height: Math.round(h * 100) / 100, kind: 'block' });
      shift += d;
    }
    forceNext = false;
    softNext = false;
    markPageStart(pos);
    if (blockStart < 0) blockStart = page;
  };

  /** 한글 자리를 따르는 단위: 넘치는지 보지 않고 그대로 둔다 (쪽은 한글이 정했다) */
  const placeFixed = (top: number, bottom: number, fnH: number, docPos: number, trail = 0) => {
    if (!isFinite(top) || !isFinite(bottom)) return;
    markPageStart(docPos);
    if (blockStart < 0) blockStart = page;
    if (fnH > 0) fnUsed += fnH + (fnUsed === 0 ? FN_SEP : 0);
    lastBottom = Math.max(lastBottom, bottom + shift);
    // 단 구분선은 마지막 줄의 글자 아래까지 (줄 아래 간격 trail 은 뺀다)
    noteZone(Math.min(bottom + shift - trail, T(page) + CHof(page)));
  };

  const collectFootnotes = (el: HTMLElement, pos: number) => {
    const out: { top: number; h: number; num: number; text: string }[] = [];
    el.querySelectorAll('sup.footnote-ref').forEach((ref) => {
      const r = (ref as HTMLElement).getBoundingClientRect();
      const text = ref.getAttribute('data-footnote') || '';
      out.push({ top: rel(r.top), h: estimateFootnoteHeight(text, g.contentWidth), num: refNum.get(ref as HTMLElement) || 0, text });
    });
    return out.map((f) => ({ ...f, pos }));
  };

  const pushFootnotes = (fns: { num: number; text: string; pos: number }[]) => {
    for (const f of fns) footnotes.push({ num: f.num, text: f.text, page, pos: f.pos });
  };

  const getLines = (el: HTMLElement): Line[] => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.height > 0.5)
      .map((r) => ({ top: rel(r.top), bottom: rel(r.bottom) }))
      .sort((a, b) => a.top - b.top);
    const lines: Line[] = [];
    for (const r of rects) {
      const cur = lines[lines.length - 1];
      if (cur) {
        const overlap = Math.min(cur.bottom, r.bottom) - Math.max(cur.top, r.top);
        const minH = Math.min(cur.bottom - cur.top, r.bottom - r.top);
        if (overlap > minH * 0.5) {
          cur.top = Math.min(cur.top, r.top);
          cur.bottom = Math.max(cur.bottom, r.bottom);
          continue;
        }
      }
      lines.push({ ...r });
    }
    return lines;
  };

  /**
   * 줄의 첫 글자 위치. 화면 밖에서도 동작하도록 좌표 대신 글자별 사각형을 이분 탐색한다.
   * (posAtCoords는 보이는 영역에서만 동작해 화면 밖 문단을 나누지 못했다)
   */
  const posAtLineStart = (el: HTMLElement, line: Line, from: number, to: number): number | null => {
    const nodes: Text[] = [];
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      // 쪽 나누기 공간(위젯) 안의 글자는 제외
      if ((n.parentElement as HTMLElement | null)?.closest('.pg-spacer')) continue;
      if ((n as Text).length) nodes.push(n as Text);
    }
    const starts: number[] = [];
    let total = 0;
    for (const t of nodes) {
      starts.push(total);
      total += t.length;
    }
    if (!total) return null;
    const range = document.createRange();
    const locate = (i: number): [Text, number] => {
      let lo = 0;
      let hi = nodes.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= i) lo = mid;
        else hi = mid - 1;
      }
      return [nodes[lo], i - starts[lo]];
    };
    const topOf = (i: number) => {
      const [t, o] = locate(i);
      range.setStart(t, o);
      range.setEnd(t, Math.min(t.length, o + 1));
      const rects = range.getClientRects();
      const r = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
      return rel(r.top);
    };
    // line.top 이상에 놓인 첫 글자
    let lo = 0;
    let hi = total - 1;
    if (topOf(hi) < line.top - 2) return null;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (topOf(mid) >= line.top - 2) hi = mid;
      else lo = mid + 1;
    }
    const [t, o] = locate(lo);
    try {
      const p = view.posAtDOM(t, o);
      return p > from && p < to ? p : null;
    } catch {
      return null;
    }
  };

  /**
   * '다음 문단과 함께'인 문단(제목 등): 이어지는 그런 문단들과 그 뒤 문단의 첫 줄(외톨이줄 방지면 두 줄, 세 줄 이하면 모두)까지
   * 이 쪽에 들어가야 한다. 들어가지 않으면 이 문단부터 다음 쪽으로 넘긴다.
   * Word 는 그런 문단이 이어진 사슬 전체(사슬의 첫 문단부터)가 한 쪽에 들어갈 때만 이 규칙을 지킨다:
   * 한 쪽보다 긴 사슬은 보통 문단처럼 흐르고(문단 보호는 문단마다 따로 지킨다), 사슬 중간의 남은 꼬리만 따로 넘기지 않는다
   */
  const keepWithNext = (pos: number, top: number) => {
    const sTop = top + shift;
    const p = pageAtY(sTop + 0.5, page);
    // 쪽 맨 위에 있으면 넘길 곳이 없다
    if (sTop <= T(p) + 0.5) return;
    let need = NaN;
    /** 사슬의 첫 문단의 위 (자연 배치) */
    let chainTop = top;
    try {
      const $p = doc.resolve(pos);
      const parent = $p.parent;
      const idx = $p.index();
      let first = idx;
      let firstPos = pos;
      while (first > 0 && idx - first < 400) {
        const pv = parent.child(first - 1);
        if (!pv.isTextblock || !String(pv.attrs?.pageKeep || '').includes('n')) break;
        first--;
        firstPos -= pv.nodeSize;
      }
      if (first < idx) {
        const fel = nodeDom(firstPos) as HTMLElement | null;
        if (fel instanceof HTMLElement) chainTop = rel(fel.getBoundingClientRect().top);
      }
      const room = CHof(p + 1);
      let npos = pos + parent.child(idx).nodeSize;
      for (let i = idx + 1; i < parent.childCount && i <= idx + 400; i++) {
        const nx = parent.child(i);
        if (nx.type.name === 'pageBreak' || nx.type.name === 'columnBreak') return;
        const flags = String(nx.attrs?.pageKeep || '');
        if (nx.isTextblock && flags.includes('n')) {
          // 사슬이 한 쪽보다 길어지면 지킬 수 없다
          const cel = nodeDom(npos) as HTMLElement | null;
          if (cel instanceof HTMLElement && rel(cel.getBoundingClientRect().bottom) - chainTop > room + 0.5) return;
          npos += nx.nodeSize;
          continue;
        }
        const nel = nodeDom(npos) as HTMLElement | null;
        if (!(nel instanceof HTMLElement)) return;
        need = rel(nel.getBoundingClientRect().bottom);
        if (nx.isTextblock) {
          const ls = getLines(nel);
          const k = flags.includes('l') || !ls.length ? ls.length : flags.includes('w') ? (ls.length <= 3 ? ls.length : 2) : 1;
          if (k > 0 && k < ls.length) need = ls[k - 1].bottom;
        } else if (nx.type.name === 'table') {
          const row = nel.querySelector('tr');
          if (row) need = rel(row.getBoundingClientRect().bottom);
        }
        break;
      }
    } catch {
      return;
    }
    if (!isFinite(need)) return;
    const limit = T(p) + CHof(p) - (p === page ? fnUsed : 0);
    // 사슬 전체가 다음 쪽에서도 다 들어가지 않을 만큼 길면 넘겨도 소용없다
    if (need + shift > limit + 0.5 && need - chainTop <= CHof(p + 1)) forceNext = true;
  };

  const handleTextblock = (node: PMNode, pos: number) => {
    const el = nodeDom(pos) as HTMLElement | null;
    if (!el || !(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    const top = rel(r.top);
    const bottom = rel(r.bottom);
    const fns = collectFootnotes(el, pos);
    const fnTotal = fns.reduce((a, f) => a + f.h, 0);
    /** 쪽 나눔 규칙 (Word 문서): w 외톨이줄 방지, n 다음 문단과 함께, l 문단을 나누지 않음. 다단에서는 따지지 않는다 */
    const keep = !cols && typeof node.attrs.pageKeep === 'string' ? (node.attrs.pageKeep as string) : '';
    if (keep.includes('n') && !forceNext && !softNext && !forceCol) keepWithNext(pos, top);

    // 그대로 들어가는지 확인
    const sTop = top + shift;
    const sBottom = bottom + shift;
    const p = cols ? page : pageAtY(sTop + 0.5, page);
    const fnUsedHere = p === page ? fnUsed : 0;
    const limit = T(p) + CHof(p) - fnUsedHere - (fnTotal > 0 && fnUsedHere === 0 ? FN_SEP : 0) - fnTotal;
    if (forceNext || forceCol || sBottom <= limit + 0.5) {
      place(top, bottom, fnTotal, () => pos, 'block', pos);
      pushFootnotes(fns);
      return;
    }
    const lines = getLines(el);
    if (lines.length < 2) {
      place(top, bottom, fnTotal, () => pos, 'block', pos);
      pushFootnotes(fns);
      return;
    }
    const n = lines.length;
    // 외톨이줄 방지·문단 보호: 쪽 끝에 한 줄만 남거나 다음 쪽으로 한 줄만 넘어가지 않게, 나눌 줄을 앞당긴다 (0 이면 문단째 넘긴다)
    let breakAt = -1;
    if (keep.includes('w') || keep.includes('l')) {
      const unitBottom = (i: number) => (i === n - 1 ? bottom : (lines[i].bottom + lines[i + 1].top) / 2) + shift;
      let fit = 0;
      while (fit < n && unitBottom(fit) <= limit + 0.5) fit++;
      if (fit < n) {
        let want = fit;
        if (keep.includes('l') || want < 2) want = 0;
        else if (n - want < 2) want = n - 2 < 2 ? 0 : n - 2;
        // 쪽 맨 위에서 시작한 문단은 통째로 넘길 곳이 없다
        if (want === 0 ? sTop > T(p) + 0.5 : want < fit) breakAt = want;
      }
    }
    curPara = { end: pos + node.nodeSize - 1, startCol: col, rel: false, dy: 0, seg: null };
    for (let i = 0; i < n; i++) {
      const uTop = i === 0 ? top : (lines[i - 1].bottom + lines[i].top) / 2;
      const uBottom = i === n - 1 ? bottom : (lines[i].bottom + lines[i + 1].top) / 2;
      const lineFns = fns.filter((f) => f.top >= uTop - 1 && f.top < uBottom);
      const fnH = lineFns.reduce((a, f) => a + f.h, 0);
      if (i === breakAt) forceNext = true;
      if (i === 0) {
        place(uTop, uBottom, fnH, () => pos, 'block', pos);
        // 문단 상자는 첫 줄이 놓인 단에 선다
        curPara.startCol = col;
      } else {
        const line = lines[i];
        place(uTop, uBottom, fnH, () => posAtLineStart(el, line, pos, pos + node.nodeSize), 'line', pos);
      }
      pushFootnotes(lineFns);
    }
    endPara(pos + node.nodeSize);
  };

  /**
   * 한글 자리를 따르는 문단: 줄마다의 세로 자리(hwpVs)가 되돌아가는 줄에서만 다음 쪽으로 넘긴다
   * (한글이 그 줄부터 새 쪽에 놓았다). 그 밖에는 넘치는지 따지지 않는다
   */
  const handleFixedTextblock = (node: PMNode, pos: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const top = rel(r.top);
    const bottom = rel(r.bottom);
    const fns = collectFootnotes(el, pos);
    const fnTotal = fns.reduce((a, f) => a + f.h, 0);
    const vs = node.attrs.hwpVs as number[][] | null;
    const lines = node.attrs.hwpLines as [number, number][] | null;
    const boxes = hwpLineBoxes(node, false);
    let jump = false;
    if (boxes && vs && lines && lines.length === vs.length) for (let i = 1; i < vs.length; i++) if (vs[i][0] < vs[i - 1][0] - 0.5) jump = true;
    /** 마지막 줄 아래의 줄 간격 (단 구분선의 길이에서 뺀다) */
    const trail = vs && vs.length ? Math.max(0, +vs[vs.length - 1][2] || 0) : 0;
    if (!jump || !boxes || !vs || !lines) {
      placeFixed(top, bottom, fnTotal, pos, trail);
      pushFootnotes(fns);
      return;
    }
    let y = top + pxOf(getComputedStyle(el).paddingTop);
    let segTop = top;
    curPara = { end: pos + node.nodeSize - 1, startCol: col, rel: false, dy: 0, seg: null };
    for (let i = 0; i < vs.length; i++) {
      if (i > 0 && vs[i][0] < vs[i - 1][0] - 0.5) {
        const segFns = fns.filter((f) => f.top >= segTop - 1 && f.top < y);
        placeFixed(segTop, y, segFns.reduce((a, f) => a + f.h, 0), pos);
        pushFootnotes(segFns);
        // 다단: 마지막 단이 아니면 다음 단으로, 마지막 단이면 다음 쪽의 첫 단으로
        const toCol = !!cols && col < cols.n - 1;
        if (toCol) col++;
        else {
          page = Math.min(page + 1, MAX_PAGES);
          fnUsed = 0;
          col = 0;
          commit();
        }
        const h = Math.round((T(page) + vs[i][0] - (y + shift)) * 100) / 100;
        if (toCol || curPara.rel || col !== curPara.startCol || h > 0) moveBy(h, pos + 1 + lines[i][0], 'line', col);
        markPageStart(pos);
        segTop = y;
      }
      y += boxes[i].pitch;
    }
    const restFns = fns.filter((f) => f.top >= segTop - 1);
    placeFixed(segTop, bottom, restFns.reduce((a, f) => a + f.h, 0), pos, trail);
    pushFootnotes(restFns);
    endPara(pos + node.nodeSize);
  };

  /** 셀 안의 말단 블록(문단·중첩 표 등)을 문서 순서로 */
  const collectLeaves = (parent: PMNode, base: number, out: { node: PMNode; pos: number }[] = []) => {
    parent.forEach((child, offset) => {
      const p = base + offset;
      if (child.isTextblock || child.type.name === 'table') out.push({ node: child, pos: p });
      else if (CONTAINERS.has(child.type.name)) collectLeaves(child, p + 1, out);
      else if (child.isBlock) out.push({ node: child, pos: p });
    });
    return out;
  };

  /** 한 쪽보다 긴 표 줄: 각 셀의 내용을 같은 쪽 경계에서 따로 나눈다 */
  const splitRow = (rowNode: PMNode, rowPos: number, uTop: number, uBottom: number) => {
    const startTop = uTop + shift;
    normalize(startTop);
    markPageStart(rowPos);
    const startPage = page;
    const PAD = 3;
    // 칸마다 같은 쪽으로 넘어가므로 제목 줄은 쪽마다 한 번만 적어 둔다
    const headPages = new Set<number>();
    const headFor = (pg: number): { head?: RepeatHead } => {
      if (!tableHead || headPages.has(pg)) return {};
      headPages.add(pg);
      return { head: { table: tableHead.table, page: pg, h: tableHead.h } };
    };
    // 칸마다 끊긴 자리 가운데 가장 아래: 그 쪽에서 표가 끝나는 곳 (닫는 선을 긋는다)
    const cutRef = new Map<number, PageBreakInfo>();
    // 나뉜 줄의 앞 조각을 닫는 선: 그 줄 칸의 아래 선 (Word 는 나뉜 칸을 쪽마다 선으로 닫는다)
    let splitLine: string | null = null;
    const noteCut = (pg: number, y: number) => {
      const b = breaks[breaks.length - 1];
      const ref = cutRef.get(pg);
      if (ref && ref.cut) ref.cut.y = Math.max(ref.cut.y, y);
      else if (b && curTable >= 0) {
        if (splitLine === null) {
          const el = nodeDom(rowPos) as HTMLElement | null;
          splitLine = cellLine(el?.firstElementChild, 'Bottom')?.css || 'none';
        }
        b.cut = { table: curTable, page: pg, y, line: splitLine };
        cutRef.set(pg, b);
      }
    };
    // 나뉜 줄의 높이 = max(줄 최소 높이, 칸마다 '내용 높이 + 끼운 공간'). 자연 배치의 아래 끝(uBottom)을 기준으로 하면
    // 최소 높이 안에서 가운데 정렬된 칸의 남는 공간까지 늘어난다고 보게 되어 뒤 내용의 자리가 어긋난다
    const rowEl = nodeDom(rowPos) as HTMLElement | null;
    const minH = rowEl ? parseFloat(getComputedStyle(rowEl).getPropertyValue('--row-h')) || 0 : 0;
    let rowBottom = uTop + minH; // 자연 배치 기준 (shift 미포함)
    /** 내용이 가장 꽉 찬 칸에서 내용 아래로 남는 자리 (자연 배치의 줄 높이 - 칸 내용 높이의 최솟값): 나뉜 뒤에도 지킨다 */
    let minSlack = Infinity;
    let grew = false;
    /**
     * 칸 하나의 내용을 쪽 경계에서 나눈다: 문단은 줄 사이에서, 그 밖의 블록은 통째로 다음 쪽으로.
     * 쪽 경계에 걸친 안쪽 표는 줄마다, 그 줄의 칸마다 따로 나눈다 (Word 처럼 안쪽 표의 줄도 쪽에 걸쳐 나뉜다).
     * cs0: 이 칸 앞에서 이미 끼운 공간, pc0: 칸이 시작하는 쪽. 끝난 뒤의 끼운 공간·쪽·내용 아래 끝을 돌려준다
     */
    const walkCell = (cell: PMNode, cellPos: number, cs0: number, pc0: number, depth: number): { cs: number; pc: number; last: number } => {
      let cs = cs0;
      let pc = pc0;
      let last = -Infinity;
      for (const lf of collectLeaves(cell, cellPos + 1)) {
        const el = nodeDom(lf.pos) as HTMLElement | null;
        if (!(el instanceof HTMLElement)) continue;
        const r = el.getBoundingClientRect();
        const top = rel(r.top);
        const bottom = rel(r.bottom);
        const sT = top + shift + cs;
        pc = pageAtY(sT + 0.5, pc);
        if (lf.node.type.name === 'table' && depth < 6 && bottom + shift + cs > T(pc) + CHof(pc) + 0.5) {
          // 안쪽 표: 줄마다 그 줄의 칸들을 같은 출발점에서 따로 나누고, 가장 많이 밀린 칸만큼 다음 줄을 민다
          let rowCs = cs;
          let rowPc = pc;
          lf.node.forEach((nrow, roff) => {
            const nrowPos = lf.pos + 1 + roff;
            let maxCs = rowCs;
            let maxPc = rowPc;
            nrow.forEach((ncell, coff) => {
              const w = walkCell(ncell, nrowPos + 1 + coff, rowCs, rowPc, depth + 1);
              maxCs = Math.max(maxCs, w.cs);
              maxPc = Math.max(maxPc, w.pc);
              last = Math.max(last, w.last);
            });
            rowCs = maxCs;
            rowPc = maxPc;
          });
          cs = rowCs;
          pc = rowPc;
          last = Math.max(last, bottom + cs);
          continue;
        }
        if (bottom + shift + cs > T(pc) + CHof(pc) + 0.5) {
          const lines = lf.node.isTextblock ? getLines(el) : [];
          if (lines.length >= 2) {
            for (let li = 0; li < lines.length; li++) {
              const lt = (li === 0 ? top : (lines[li - 1].bottom + lines[li].top) / 2) + shift + cs;
              const lb = (li === lines.length - 1 ? bottom : (lines[li].bottom + lines[li + 1].top) / 2) + shift + cs;
              pc = pageAtY(lt + 0.5, pc);
              if (lb > T(pc) + CHof(pc) + 0.5 && lt > T(pc) + 0.5) {
                const p = li === 0 ? lf.pos : posAtLineStart(el, lines[li], lf.pos, lf.pos + lf.node.nodeSize);
                if (p != null) {
                  const h = Math.round((T(pc + 1) - lt + (tableHead?.h || 0)) * 100) / 100;
                  breaks.push({ pos: p, height: h, kind: li === 0 ? 'block' : 'line', ...headFor(pc + 1) });
                  noteCut(pc, lt - T(pc));
                  cs += h;
                  pc++;
                }
              }
            }
          } else if (sT > T(pc) + 0.5) {
            const h = Math.round((T(pc + 1) - sT + (tableHead?.h || 0)) * 100) / 100;
            breaks.push({ pos: lf.pos, height: h, kind: 'block', ...headFor(pc + 1) });
            noteCut(pc, sT - T(pc));
            cs += h;
            pc++;
          }
        }
        last = Math.max(last, bottom + cs);
      }
      return { cs, pc, last };
    };
    rowNode.forEach((cell, off) => {
      const cellPos = rowPos + 1 + off;
      const { cs, last } = walkCell(cell, cellPos, 0, startPage, 0);
      // 여러 줄을 합친 칸은 끼운 공간이 합친 줄들에 나뉘어 들어가므로 이 줄의 높이로 치지 않는다
      if ((cell.attrs.rowspan || 1) > 1) return;
      const h = cellContentHeight(nodeDom(cellPos) as HTMLElement | null);
      if (h != null) {
        rowBottom = Math.max(rowBottom, uTop + h + cs);
        minSlack = Math.min(minSlack, Math.max(0, uBottom - uTop - h));
        if (cs > 0) grew = true;
      } else if (last > -Infinity) rowBottom = Math.max(rowBottom, last + PAD);
    });
    // 한글은 나뉜 줄에서도 글 아래의 자리(마지막 줄 간격·문단 아래 간격)를 지킨다: 그만큼 줄을 늘리고, 닫는 선도 그만큼 아래에
    if (grew && isFinite(minSlack) && minSlack > 0.5) {
      // 한글이 이미 쪽에 걸쳐 나눠 둔 줄(칸 안 줄 자리가 되돌아간다)은 적힌 줄 높이에 조각마다의 아래 자리가 모두 들어 있다:
      // 조각 수로 나눈 몫만 마지막 조각 아래에 둔다 (앞 조각들의 몫은 쪽 끝의 빈 자리에 들어간다)
      let jumped = false;
      rowNode.descendants((n) => {
        const vs = n.attrs?.hwpVs as number[][] | null;
        if (Array.isArray(vs)) for (let i = 1; i < vs.length; i++) if (vs[i][0] <= vs[i - 1][0]) jumped = true;
        return !jumped;
      });
      const slack = jumped ? minSlack / (cutRef.size + 1) : minSlack;
      rowBottom += slack;
      for (const ref of cutRef.values()) if (ref.cut) ref.cut.y += slack;
    }
    for (const ref of cutRef.values()) if (ref.cut) ref.cut.y += 1;
    if (grew && rowBottom - uBottom > 0.5) breaks.push({ pos: rowPos, height: Math.round((rowBottom - uTop) * 100) / 100, kind: 'grow' });
    // 이 줄이 늘어난 만큼 뒤 내용도 밀린다
    const extra = rowBottom - uBottom;
    shift += extra;
    const endS = uBottom + shift; // = 늘어난 줄의 아래 끝
    const endPage = Math.min(MAX_PAGES, pageAtY(endS - 0.5, page));
    if (endPage > page) {
      page = endPage;
      fnUsed = 0;
      commit();
      markPageStart(rowPos);
    }
    lastBottom = Math.max(lastBottom, endS);
  };

  const handleTable = (node: PMNode, pos: number) => {
    const el = nodeDom(pos) as HTMLElement | null;
    if (!el || !(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    const top = rel(r.top);
    const bottom = rel(r.bottom);
    const fns = collectFootnotes(el, pos);
    const fnTotal = fns.reduce((a, f) => a + f.h, 0);
    curTable = pos;
    const sBottom = bottom + shift;
    const p = cols ? page : pageAtY(top + shift + 0.5, page);
    const fnUsedHere = p === page ? fnUsed : 0;
    if (forceNext || forceCol || sBottom <= T(p) + CHof(p) - fnUsedHere - fnTotal - (fnTotal ? FN_SEP : 0) + 0.5) {
      place(top, bottom, fnTotal, () => pos, 'block', pos);
      pushFootnotes(fns);
      return;
    }
    // 다단: 표는 단에 걸쳐 나누지 못한다. 한 단에 들어가는 표는 통째로 다음 단(쪽)으로 넘긴다
    if (cols && bottom - top <= CHof(p) - fnTotal - (fnTotal ? FN_SEP : 0)) {
      place(top, bottom, fnTotal, () => pos, 'block', pos);
      pushFootnotes(fns);
      return;
    }
    // '나누지 않음'인 표: 한 쪽에 들어가는 크기면 통째로 다음 쪽으로 넘긴다
    const split = node.attrs?.pageSplit;
    if (split === 'none' && bottom - top <= CHof(p) - fnTotal - (fnTotal ? FN_SEP : 0)) {
      place(top, bottom, fnTotal, () => pos, 'block', pos);
      pushFootnotes(fns);
      return;
    }
    const rows: { pos: number; el: HTMLElement }[] = [];
    node.forEach((row, offset) => {
      const rp = pos + 1 + offset;
      const re = nodeDom(rp) as HTMLElement | null;
      if (re instanceof HTMLElement) rows.push({ pos: rp, el: re });
    });
    if (!rows.length) {
      place(top, bottom, fnTotal, () => pos, 'block', pos);
      return;
    }
    // 제목 줄(맨 앞의 제목 칸으로만 된 줄들): 표가 다음 쪽으로 이어지면 그 쪽 맨 위에 되풀이한다
    let headN = 0;
    while (headN < node.childCount - 1 && node.child(headN).childCount > 0 && isHeaderRow(node.child(headN))) headN++;
    const headH = headN ? rel(rows[Math.min(headN, rows.length) - 1].el.getBoundingClientRect().bottom) - top : 0;
    rows.forEach((row, i) => {
      const rr = row.el.getBoundingClientRect();
      const uTop = i === 0 ? top : rel(rr.top);
      tableHead = headN && i >= headN && headH > 0 && headH < CHof(page) / 3 ? { table: pos, h: headH } : null;
      const uBottom = i === rows.length - 1 ? bottom : rel(rr.bottom);
      // 한글 기본(셀 단위 나눔)처럼, 넘치는 줄은 셀 내용을 쪽 경계에서 나눈다 (짧은 줄은 통째로 넘김)
      // '셀 단위로 나눔'인 표는 줄을 쪼개지 않고 통째로 넘긴다 (한 쪽보다 긴 줄만 어쩔 수 없이 나눈다)
      const pp = pageAtY(uTop + shift + 0.5, page);
      const whole = (split === 'row' || split === 'none') && uBottom - uTop <= CHof(pp) - (tableHead ? tableHead.h : 0);
      if (!whole && uBottom + shift > T(pp) + CHof(pp) + 0.5 && uBottom - uTop > 60) {
        const rowNode = node.child(i);
        splitRow(rowNode, row.pos, uTop, uBottom);
        return;
      }
      const rowFns = collectFootnotes(row.el, pos);
      const fnH = rowFns.reduce((a, f) => a + f.h, 0);
      const nb = breaks.length;
      const pg0 = page;
      const shift0 = shift;
      if (i === 0) place(uTop, uBottom, fnH, () => pos, 'block', pos);
      else place(uTop, uBottom, fnH, () => row.pos, 'row', row.pos);
      // 줄이 통째로 다음 쪽으로 넘어갔으면 앞 쪽에서는 표를 그 자리에서 닫는다 (넘긴 줄의 세로선이 빈자리까지 이어지지 않게)
      if (i > 0 && breaks.length > nb && page > pg0) {
        // 그 자리에는 앞 줄의 아래 선과 넘긴 줄의 위 선이 겹친 표 선이 있다: 덮개는 그 선 아래에서 시작한다 (한글 문서는 닫는 선을 따로 긋는다)
        const a = cellLine(row.el.previousElementSibling?.firstElementChild, 'Bottom');
        const c = cellLine(row.el.firstElementChild, 'Top');
        const off = Math.round((Math.max(a?.w || 0, c?.w || 0) / 2) * 100) / 100;
        breaks[breaks.length - 1].cut = { table: pos, page: pg0, y: Math.round((uTop + shift0 - T(pg0)) * 100) / 100, line: 'none', ...(off ? { off } : {}) };
      }
      // 이 줄이 다음 쪽으로 넘어갔으면 그 쪽 맨 위에 제목 줄 자리를 비운다
      if (tableHead && breaks.length > nb && page > pg0) {
        const b = breaks[breaks.length - 1];
        b.height = Math.round((b.height + tableHead.h) * 100) / 100;
        b.head = { table: tableHead.table, page, h: tableHead.h };
        shift += tableHead.h;
        lastBottom += tableHead.h;
      }
      pushFootnotes(rowFns);
    });
    tableHead = null;
  };

  const handleOther = (pos: number) => {
    const el = nodeDom(pos) as HTMLElement | null;
    if (!el || !(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    const fns = collectFootnotes(el, pos);
    place(rel(r.top), rel(r.bottom), fns.reduce((a, f) => a + f.h, 0), () => pos, 'block', pos);
    pushFootnotes(fns);
  };

  const handleChild = (child: PMNode, pos: number) => {
    const name = child.type.name;
    if (name === 'pageBreak') {
      forceNext = true;
      // 구역 나누기: 다음 쪽부터 그 구역의 용지와 다단
      const sp = child.attrs?.sectionPage as PageSetup | null;
      if (sp && g.resolve) {
        const sg = g.resolve(sp);
        curPg = { H: sg.pageHeight, CH: sg.contentHeight, mt: sg.mt ?? 0, setup: sp, hf: (child.attrs?.sectionHf as SectionHf | null) || null };
        pendingZone = { cols: columnGeom(sp.columns, sg.contentWidth), w: sg.contentWidth };
      }
      return;
    }
    if (name === 'columnBreak') {
      // 다단 설정 나누기: 다음 블록부터 새 다단. 단 나누기: 다음 블록을 다음 단으로
      const pz: { cols: ColGeom | null; w?: number } | null = pendingZone;
      if (child.attrs?.columns) pendingZone = { cols: columnGeom(child.attrs.columns, pz?.w ?? colW), w: pz?.w };
      else forceCol = true;
      return;
    }
    // 한글이 새 쪽에서 시작한 블록. 앞 블록(여러 쪽에 걸친 표 등)이 이미 쪽을 넘겼으면 다시 넘기지 않는다
    softNext = !!child.attrs?.hwpPage && page === prevStartPage;
    if (CONTAINERS.has(name)) {
      // 최상위 상자 안의 상자(목록 항목 등): 첫 내용이 놓인 단을 적어 둔다
      if (depth > 0) boxStack.push({ pos, col: -1 });
      walk(child, pos + 1);
      if (depth > 0) boxStack.pop();
      return;
    }
    leafCol = -1;
    if (child.isTextblock) handleTextblock(child, pos);
    else if (name === 'table') handleTable(child, pos);
    else handleOther(pos);
    // 목록 등의 안쪽 블록이 다음 단으로 넘어갔으면 가로로 옮긴다 (바깥 상자는 시작한 단에 있다).
    // 이 블록으로 시작하는 상자(목록 항목: 글머리표도 함께 가야 한다)가 있으면 그 상자를, 아니면 이 블록을 옮긴다
    if (depth > 0 && cols && leafCol >= 0 && blockCol >= 0) {
      let ref = blockCol;
      let target = pos;
      let found = false;
      for (const f of boxStack) {
        if (f.col >= 0) ref = f.col;
        else {
          if (!found) {
            target = f.pos;
            found = true;
          }
          f.col = leafCol;
        }
      }
      if (leafCol !== ref) breaks.push({ pos: target, kind: 'col', height: 0, inner: true, x: r2(cols.x[leafCol] - cols.x[ref]) });
    }
  };
  let depth = 0;
  const boxStack: { pos: number; col: number }[] = [];
  const walk = (parent: PMNode, base: number) => {
    depth++;
    parent.forEach((child, offset) => handleChild(child, base + offset));
    depth--;
  };

  // 최상위 블록을 돌며 블록마다 상태 스냅샷을 남긴다
  const snaps: Snap[] = useCache ? cache!.snaps.slice(0, startIndex) : [];
  let early: { j: number; pj: number; delta: number; dp: number } | null = null;
  const toggled: Element[] = [];
  /** 이 블록(과 바로 앞의 쪽 나누기 공간)을 자연 상태로 */
  const naturalize = (el: HTMLElement) => {
    for (let sib = el.previousElementSibling; sib && sib.classList.contains('pg-spacer'); sib = sib.previousElementSibling) {
      sib.classList.add('pg-measuring');
      toggled.push(sib);
    }
    el.classList.add('pg-measuring');
    toggled.push(el);
  };
  // 측정용 클래스 전환을 ProseMirror 의 DOM 감시자가 보면 그 블록(큰 표면 수십 ms) 전체를 다시 읽으므로, 재는 동안은 감시를 멈춘다
  const obs = (view as any).domObserver as { stop(): void; start(): void } | undefined;
  obs?.stop();
  if (!useCache) root.classList.add('pg-measuring');
  refreshRootTop();
  /** 증분인데 이만큼 지나도 지난 결과와 맞물리지 않으면 전체 배치가 더 싸다 */
  const INCREMENTAL_LIMIT = 60;
  let pos = 0;
  try {
  for (let j = 0; j < doc.childCount; j++) {
    const child = doc.child(j);
    if (j < startIndex) {
      pos += child.nodeSize;
      continue;
    }
    const el = nodeDom(pos) as HTMLElement | null;
    if (useCache && el instanceof HTMLElement) {
      if (j >= resumeNew + INCREMENTAL_LIMIT) return null;
      naturalize(el);
      refreshRootTop();
      // 바뀐 첫 블록: 자연 위치는 지난번과 같으므로 그 차이가 전체 offset
      if (j === startIndex) offset = relRaw(el.getBoundingClientRect().top) - cache!.snaps[startIndex].top;
    }
    const top = el instanceof HTMLElement ? rel(el.getBoundingClientRect().top) : NaN;
    if (useCache && j >= resumeNew && isFinite(top)) {
      const pj = j - resumeNew + resumePrev;
      const ps = cache!.snaps[pj];
      if (ps && isFinite(ps.top)) {
        const delta = top - ps.top;
        const dp = page - ps.page;
        // 이 블록의 쪽 안 위치와 각주 상태가 지난번과 같으면(쪽 번호는 dp 만큼 밀려도) 뒤는 모두 같다
        if (Math.abs(shift + delta - (ps.shift + dp * (g.pageHeight + g.gap))) < 0.5 && Math.abs(fnUsed - ps.fnUsed) < 0.5 && forceNext === ps.forceNext && chain === ps.chain && lastSeq === ps.lastSeq && prevStartPage === ps.prevStartPage + dp) {
          early = { j, pj, delta, dp };
          break;
        }
      }
    }
    snaps[j] = { top, page, shift, fnUsed, forceNext, lastBottom, nBreaks: breaks.length, nFn: footnotes.length, nStarts: pageStarts.length, chain, lastSeq, prevStartPage };
    if (child.type.name === 'columnBreak') {
      handleChild(child, pos);
      // 한글 문서에 있던 단 나누기는 한글 배치(블록마다 적힌 단)를 끊지 않는다. 새로 넣은 것은 그 쪽 끝까지 자연 배치로 흐르게 한다
      if (!child.attrs?.hwp) {
        chain = false;
        lastSeq = 0;
      }
      pos += child.nodeSize;
      continue;
    }
    blockStart = -1;
    blockCol = -1;
    leafCol = -1;
    // 한글 자리를 따를 수 있는가: 한글 문서 그대로인 블록(차례·내용 크기)이 쪽 시작부터 이어져 왔을 때
    const a = child.attrs;
    const intact = child.type.name !== 'pageBreak' && a?.hwpSeq != null && a.hwpLen === child.content.size;
    const restart = forceNext || !!a?.hwpPage || a?.hwpSeq === 1;
    chain = intact && ((chain && a!.hwpSeq === lastSeq + 1) || restart);
    lastSeq = intact ? a!.hwpSeq : 0;
    if (chain && typeof a!.hwpTop === 'number' && el instanceof HTMLElement) {
      softNext = !!a!.hwpPage && page === prevStartPage;
      snapTo(el, pos, a!.hwpTop, a!.hwpSeq, +a!.hwpCol || 0);
      if (child.isTextblock) handleFixedTextblock(child, pos, el);
      else if (child.type.name === 'table') handleTable(child, pos);
      else handleOther(pos);
    } else handleChild(child, pos);
    // 다단: 이 블록을 제 단의 자리와 폭으로 (자리는 가로로 옮기기만 하므로, 오른쪽 여백 = 블록 자신의 것 + 본문 폭에서 단 폭을 뺀 나머지)
    if (blockCols && blockCol >= 0 && child.type.name !== 'pageBreak') {
      const bc: ColGeom = blockCols;
      const k = Math.min(blockCol, bc.n - 1);
      breaks.push({ pos, kind: 'col', height: 0, x: r2(bc.x[k]), r: r2(blockCW - bc.w[k] + ownMargins(child)[1]) });
    }
    // 한글의 새 쪽 표시는 '줄 정보를 가진 앞 문단의 마지막 줄보다 뒤 쪽'이라는 뜻이다. 그 사이에 낀 표(글을 밀어낸 표: 자리 정보 없음)가
    // 쪽을 넘겼거나 통째로 다음 쪽으로 갔으면 이미 넘어온 것이므로, 기준 쪽은 줄 정보를 가진 블록이 끝난 쪽으로 둔다
    // (한글 문서의 표: 글자처럼 취급하는 표는 표가 곧 그 줄이므로 표가 시작한 쪽, 떠 있는 표는 줄이 아니므로 기준을 바꾸지 않는다)
    // 줄 정보가 없는 블록(한글이 줄 정보를 적지 않은 문단)도 기준을 바꾸지 않는다
    if (a?.hwpSeq != null) {
      if (child.type.name === 'table') {
        if (a.inline && blockStart >= 0) prevStartPage = blockStart;
      } else if (typeof a.hwpTop === 'number') prevStartPage = page;
    } else prevStartPage = page;
    pos += child.nodeSize;
  }
  } finally {
    if (!useCache) root.classList.remove('pg-measuring');
    for (const el of toggled) el.classList.remove('pg-measuring');
    obs?.start();
  }

  let pageCount: number;
  if (early) {
    const { j, pj, delta, dp } = early;
    const ps = cache!.snaps[pj];
    // 지난 pageStarts 는 쪽 번호 순서이므로 현재 쪽까지 채운 뒤 이어 붙인다
    while (pageStarts.length < page + 1 && pageStarts.length < MAX_PAGES) pageStarts.push(pos);
    const dB = breaks.length - ps.nBreaks;
    const dF = footnotes.length - ps.nFn;
    const dS = pageStarts.length - ps.nStarts;
    breaks = breaks.concat(curBreaks.slice(ps.nBreaks));
    footnotes = footnotes.concat(cache!.footnotes.slice(ps.nFn).map((f) => ({ ...f, pos: dirty!.mapping.map(f.pos), page: f.page + dp })));
    pageStarts = pageStarts.concat(cache!.pageStarts.slice(ps.nStarts).map((x) => dirty!.mapping.map(x)));
    pageCount = Math.min(MAX_PAGES, cache!.pageCount + dp);
    lastBottom = cache!.lastBottom + dp * (g.pageHeight + g.gap);
    // 지난 스냅샷을 새 문서에 맞춰 옮긴다 (자연 위치는 delta 만큼, 쪽은 dp 만큼, 밀림은 그에 맞게)
    for (let i = pj; i < cache!.snaps.length; i++) {
      const o = cache!.snaps[i];
      snaps[j + (i - pj)] = { ...o, prevStartPage: o.prevStartPage + dp, top: o.top + delta, page: o.page + dp, shift: o.shift + dp * (g.pageHeight + g.gap) - delta, lastBottom: o.lastBottom + dp * (g.pageHeight + g.gap), nBreaks: o.nBreaks + dB, nFn: o.nFn + dF, nStarts: o.nStarts + dS };
    }
  } else {
    pageCount = Math.max(page + 1, pageAtY(Math.max(0, lastBottom - 0.5), page) + 1);
    if (forceNext) pageCount = Math.max(pageCount, page + 2);
    pageCount = Math.min(pageCount, MAX_PAGES);
  }
  while (pageStarts.length < pageCount) pageStarts.push(doc.content.size);
  if (pageStarts.length > pageCount) pageStarts = pageStarts.slice(0, pageCount);
  const repeats = breaks.filter((b) => b.head).map((b) => b.head!);
  const cuts = breaks.filter((b) => b.cut).map((b) => b.cut!);
  const result: LayoutResult = { pageCount, footnotes, pageStarts, ...(repeats.length ? { repeats } : {}), ...(cuts.length ? { cuts } : {}) };
  // 단 구분선: 단 사이 한가운데에, 그 쪽에서 다단이 차지한 높이만큼 (다음 쪽으로 이어지는 다단은 본문 끝까지)
  const colLines: ColLine[] = [];
  for (const z of zones.values()) {
    const ln = z.cols.line;
    if (!ln || !(ln.w > 0)) continue;
    const y2 = zones.has(z.page + 1 + ':' + z.id) ? CHof(z.page) : Math.min(CHof(z.page), z.bottom);
    if (y2 - z.top < 1) continue;
    for (let i = 0; i + 1 < z.cols.n; i++) {
      const x = (z.cols.x[i] + z.cols.w[i] + z.cols.x[i + 1]) / 2;
      colLines.push({ page: z.page, x: r2(x), y1: r2(z.top), y2: r2(y2), w: ln.w, c: ln.c, s: ln.s });
    }
  }
  if (colLines.length) result.colLines = colLines;
  // 구역마다 용지가 다른 문서: 쪽마다의 용지 (끝 쪽까지 채운다)
  if (multi) {
    page = pageCount - 1;
    commit();
    result.pageSetups = pgs.slice(0, pageCount).map((x) => x.setup);
    // 구역의 머리말·꼬리말: 같은 구역의 쪽은 같은 기하 객체를 나눠 가진다 (구역이 시작한 쪽 = 처음 나온 쪽)
    if (pgs.some((x) => x.hf)) {
      const startOf = new Map<Pg, number>();
      result.pageHfs = pgs.slice(0, pageCount).map((x, k) => {
        if (!startOf.has(x)) startOf.set(x, k);
        return x.hf ? { hf: x.hf, start: startOf.get(x)! } : null;
      });
    }
  }
  // 쪽마다 본문 맨 위 (편집기 좌표): 쪽·종이 기준으로 놓인 개체를 놓는 데 쓴다
  const topsOut: number[] = [];
  for (let k = 0; k < pageCount; k++) topsOut.push(T(k));
  return { breaks, result, cache: { doc, snaps, breaksLen: breaks.length, footnotes, pageStarts, pageCount, lastBottom }, incremental: useCache, fixed, tops: topsOut };
}

/**
 * 쪽·종이 기준으로 놓인 떠 있는 개체(data-py: 쪽 본문 맨 위에서의 세로 자리)를 그 자리에 놓는다. 개체가 달린 문단이 놓인 쪽을
 * 찾아, 그 쪽 본문 맨 위에서 py 만큼 내려온 곳이 되도록 개체의 top(달린 상자 기준)을 정한다.
 * 쪽 나누기가 끝난 뒤마다 부른다 (문단이 다른 쪽으로 넘어가면 개체도 그 쪽의 같은 자리로 간다)
 */
function placePageFloats(view: EditorView, tops: number[]) {
  const root = view.dom as HTMLElement;
  const els = root.querySelectorAll<HTMLElement>('[data-py]');
  if (!els.length || !tops.length) return;
  const z = viewState.zoom || 1;
  const rootTop = root.getBoundingClientRect().top;
  const obs = (view as any).domObserver;
  const jobs: [HTMLElement, string][] = [];
  for (const el of Array.from(els)) {
    const py = parseFloat(el.getAttribute('data-py') || '');
    const box = el.offsetParent as HTMLElement | null;
    if (!Number.isFinite(py) || !box || !root.contains(box)) continue;
    const boxTop = (box.getBoundingClientRect().top - rootTop) / z;
    // 높이 없는 자리 표시(떠 있는 글상자)는 뒤따르는 문단의 쪽을 따른다 (쪽 끝에 걸리면 문단은 다음 쪽에 있다)
    let ref: Element | null = box;
    if (box.classList.contains('k-float-anchor')) {
      ref = box.nextElementSibling;
      while (ref && (ref.classList.contains('pg-spacer') || ref.classList.contains('k-float-anchor'))) ref = ref.nextElementSibling;
      if (!ref) ref = box;
    }
    const refTop = (ref.getBoundingClientRect().top - rootTop) / z;
    let k = 0;
    while (k + 1 < tops.length && tops[k + 1] <= refTop + 0.5) k++;
    const top = (tops[k] + py - boxTop).toFixed(2) + 'px';
    if (el.style.top !== top) jobs.push([el, top]);
  }
  if (!jobs.length) return;
  // 편집기가 이 스타일 변경을 문서 변경으로 읽지 않게 지켜보기를 잠시 멈춘다
  obs?.stop();
  try {
    for (const [el, top] of jobs) el.style.top = top;
  } finally {
    obs?.start();
  }
}

export interface PaginationStorage {
  geometry: PageGeometry | null;
  result: LayoutResult;
  listeners: Set<(r: LayoutResult) => void>;
  /** 전체 다시 배치 (쪽 설정·너비 등 문서 밖 조건이 바뀌었을 때) */
  schedule: () => void;
  /** 필요한 만큼만 다시 배치 (탭 전환·배율 변경처럼 문서와 쪽 조건은 그대로일 때) */
  refresh: () => void;
  enabled: boolean;
}

export const Pagination = Extension.create<{}, PaginationStorage>({
  name: 'pagination',

  addStorage() {
    return {
      geometry: null,
      result: { pageCount: 1, footnotes: [], pageStarts: [0] },
      listeners: new Set(),
      schedule: () => {},
      refresh: () => {},
      enabled: true,
    };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    // 지난 배치 뒤로 바뀐 범위 (state.apply 에서 모으고 view.run 에서 쓴다)
    const dirtyRef: { from: number | null; to: number; mapping: Mapping } = { from: null, to: 0, mapping: new Mapping() };
    const noteDirty = (tr: { mapping: Mapping }) => {
      let f = Infinity;
      let t = -Infinity;
      tr.mapping.maps.forEach((m, i) => {
        const rest = tr.mapping.slice(i + 1);
        m.forEach((_os, _oe, ns, ne) => {
          f = Math.min(f, rest.map(ns, -1));
          t = Math.max(t, rest.map(ne, 1));
        });
      });
      if (dirtyRef.from == null) {
        dirtyRef.from = f;
        dirtyRef.to = t;
      } else {
        dirtyRef.from = Math.min(tr.mapping.map(dirtyRef.from, -1), f);
        dirtyRef.to = Math.max(tr.mapping.map(dirtyRef.to, 1), t);
      }
      dirtyRef.mapping.appendMapping(tr.mapping);
    };
    return [
      new Plugin<PState>({
        key: paginationKey,
        state: {
          init: () => ({ breaks: [], decos: DecorationSet.empty }),
          apply(tr, value) {
            const meta = tr.getMeta(paginationKey) as PageBreakInfo[] | undefined;
            if (meta) return { breaks: meta, decos: buildDecos(tr.doc, meta) };
            if (tr.docChanged) {
              noteDirty(tr);
              return {
                breaks: value.breaks.map((b) => ({ ...b, pos: tr.mapping.map(b.pos, b.kind === 'line' ? 1 : -1), ...(b.end != null ? { end: tr.mapping.map(b.end, 1) } : {}), ...(b.head ? { head: { ...b.head, table: tr.mapping.map(b.head.table, -1) } } : {}), ...(b.cut ? { cut: { ...b.cut, table: tr.mapping.map(b.cut.table, -1) } } : {}) })),
                decos: value.decos.map(tr.mapping, tr.doc),
              };
            }
            return value;
          },
        },
        props: {
          decorations(state) {
            return paginationKey.getState(state)?.decos;
          },
        },
        view(view) {
          let raf = 0;
          let destroyed = false;
          let lastResultKey = '';
          let runsSinceDocChange = 0;
          let lastDoc: PMNode | null = null;
          let cache: LayoutCache | null = null;
          let needFull = true;
          let lastGeometry: PageGeometry | null = null;
          let lastWidth = 0;
          /** 한글 자리에 맞춘 블록의 보정값과, 같은 문서에서 보정을 되풀이한 횟수 */
          const corr = new Map<number, number>();
          let corrRuns = 0;

          const run = () => {
            raf = 0;
            if (view.state.doc !== lastDoc) {
              lastDoc = view.state.doc;
              runsSinceDocChange = 0;
              corrRuns = 0;
            }
            // 같은 문서에서 결과가 계속 달라지면(이론상 없어야 함) 경고만 남긴다.
            // (전에는 중단했는데, 그림이 수십 장 로드되며 배치가 정당하게 여러 번 바뀌는 경우까지 막아 버렸다)
            if (runsSinceDocChange > 50) {
              console.warn('[pagination] 배치가 수렴하지 않습니다.');
              runsSinceDocChange = 0;
            }
            if (destroyed || !storage.geometry || !storage.enabled) return;
            const root = view.dom as HTMLElement;
            if (!root.isConnected || root.offsetParent === null) return;
            if (view.composing) return;
            // 쪽 크기가 바뀌었으면 처음부터 (배율은 CSS 변환이라 문서 px 좌표가 그대로이므로 다시 잴 필요 없다)
            // 값이 같은 새 객체가 들어와도(탭 전환·다시 그리기) 전체 재배치를 반복하지 않도록 값으로 비교한다
            if (!sameGeometry(storage.geometry, lastGeometry)) {
              needFull = true;
              fullReason = 'geometry';
              lastGeometry = storage.geometry;
            }
            const cur = paginationKey.getState(view.state)!;
            const dirty: DirtyRange | null = !needFull && cache && dirtyRef.from != null ? { from: dirtyRef.from, to: dirtyRef.to, mapping: dirtyRef.mapping } : null;
            const canIncremental = !needFull && !!cache && (dirty != null || cache.doc === view.state.doc);
            let out: ReturnType<typeof computeLayout> = null;
            const t0 = performance.now();
            try {
              if (canIncremental) out = computeLayout(view, storage.geometry, cache, dirty ?? { from: 0, to: 0, mapping: new Mapping() }, cur.breaks, corr);
              if (!out) out = computeLayout(view, storage.geometry, null, null, [], corr);
            } catch (e) {
              console.error('pagination error', e);
            }
            if (!out) return;
            cache = out.cache;
            needFull = false;
            dirtyRef.from = null;
            dirtyRef.to = 0;
            dirtyRef.mapping = new Mapping();
            const dt = performance.now() - t0;
            lastCost = dt;
            if (dt > 200) console.debug(`[pagination] ${Math.round(dt)}ms${out.incremental ? ' (증분)' : ''}, ${out.result.pageCount}쪽, 나눔 ${out.breaks.length}`);
            // 시험용 추적 (tests/helpers 에서 window.__pgTrace 배열을 두면 기록한다)
            if ((window as any).__pgTrace) (window as any).__pgTrace.push({ ms: Math.round(dt * 10) / 10, incremental: out.incremental, pages: out.result.pageCount, breaks: out.breaks.length, reason: out.incremental ? '' : fullReason, t: Math.round(performance.now()), size: view.state.doc.content.size });
            fullReason = '';
            if (sameBreaks(cur.breaks, out.breaks)) runsSinceDocChange = 0;
            else {
              runsSinceDocChange++;
              const tr = view.state.tr.setMeta(paginationKey, out.breaks).setMeta('addToHistory', false);
              view.dispatch(tr);
            }
            // 한글 자리에 맞춘 블록이 실제로 그 자리에 왔는지 잰다. 어긋났으면 보정값을 고쳐 한 번 더 배치한다
            // 아주 긴 문서(최상위 블록 2만 개 넘게)는 전체 배치 한 번이 수 초라 보정 배치를 한 번만 한다
            if (out.fixed.length && !out.incremental && corrRuns < (view.state.doc.childCount > 20000 ? 1 : 6)) {
              const z = viewState.zoom || 1;
              const rootTop = root.getBoundingClientRect().top;
              let off = false;
              // 앞 블록을 바로잡으면 뒤 블록도 그만큼 따라 움직인다: 앞에서 바로잡은 몫(carry)을 빼고 남은 차이만 보정한다
              let carry = 0;
              // 블록 DOM 은 한 번 모은 최상위 블록 자리에서 찾는다 (view.nodeDOM 은 블록 수만큼 센다)
              const td = topLevelDescs(view);
              for (const fb of out.fixed) {
                const el = ((td && domIn(td, fb.pos)) || view.nodeDOM(fb.pos)) as HTMLElement | null;
                if (!(el instanceof HTMLElement)) continue;
                const box = (el.matches('table') ? el : el.querySelector(':scope > table')) || el;
                const err = (box.getBoundingClientRect().top - rootTop) / z - fb.y - carry;
                if (Math.abs(err) > 0.3 && Math.abs(err) < 40) {
                  corr.set(fb.seq, (corr.get(fb.seq) || 0) - err);
                  carry += err;
                  off = true;
                }
              }
              if (off) {
                corrRuns++;
                scheduleFull('snap');
              }
            }
            // 쪽·종이 기준으로 놓인 개체를 제 쪽의 제자리에
            try {
              placePageFloats(view, out.tops);
            } catch {
              /* 화면 배치 보정일 뿐이다 */
            }
            // 쪽 시작 위치·각주 위치는 앞쪽에서 글자를 칠 때마다 바뀐다: 그것만 바뀐 것으로는 알리지 않는다
            // (화면을 다시 그릴 일이 아니고, 읽는 쪽은 늘 storage.result 의 최신 값을 본다)
            const key = JSON.stringify(out.result, (k, v) => (k === 'pageStarts' || k === 'pos' ? undefined : v));
            storage.result = out.result;
            if (key !== lastResultKey) {
              lastResultKey = key;
              storage.listeners.forEach((fn) => fn(out!.result));
            }
          };
          // 큰 문서는 입력이 멈춘 뒤에 다시 배치 (타자 지연 방지)
          let lastCost = 0;
          let timer: any = null;
          let pendingSince = 0;
          const schedule = () => {
            if (destroyed) return;
            if (lastCost > 60) {
              // 입력이 이어지는 동안은 미루되, 요청이 계속 들어와도(그림 수백 장 로드 등) 1.5초 안에는 한 번 돈다
              const now = performance.now();
              if (!pendingSince) pendingSince = now;
              const wait = Math.min(800, 150 + lastCost * 2);
              const maxWait = Math.max(0, pendingSince + 1500 - now);
              clearTimeout(timer);
              timer = setTimeout(
                () => {
                  pendingSince = 0;
                  if (!raf) raf = requestAnimationFrame(run);
                },
                Math.min(wait, maxWait),
              );
              return;
            }
            pendingSince = 0;
            if (!raf) raf = requestAnimationFrame(run);
          };
          /** 전체 다시 배치 (글꼴 로드·너비 변경처럼 문서는 그대로인데 높이가 달라질 때) */
          let fullReason = '';
          const scheduleFull = (reason = '?') => {
            needFull = true;
            fullReason = reason;
            schedule();
          };
          storage.schedule = () => scheduleFull('schedule');
          storage.refresh = () => schedule();
          const onCompEnd = () => setTimeout(schedule, 0);
          view.dom.addEventListener('compositionend', onCompEnd);
          // kite:relayout: detail.pos 가 있으면(그림 로드 등) 그 블록만 다시 재고, 없으면 전체
          const onRelayout = (e: Event) => {
            const pos = (e as CustomEvent).detail?.pos;
            if (typeof pos === 'number' && cache && !needFull) {
              const size = view.state.doc.content.size;
              const p = Math.max(0, Math.min(size, pos));
              dirtyRef.from = dirtyRef.from == null ? p : Math.min(dirtyRef.from, p);
              dirtyRef.to = Math.max(dirtyRef.to, Math.min(size, p + 1));
              schedule();
            } else scheduleFull('relayout');
          };
          window.addEventListener('kite:relayout', onRelayout);
          // 쪽 나누기 공간을 끼우면 편집기 높이가 바뀌어 다시 불리므로, 너비가 바뀔 때만 전체 재배치
          lastWidth = view.dom.clientWidth;
          const ro = new ResizeObserver((entries) => {
            const w = entries[0]?.contentRect.width ?? view.dom.clientWidth;
            if (Math.abs(w - lastWidth) < 0.5) return;
            // 처음 화면에 붙을 때(0 → 실제 너비)는 이미 그 너비로 배치했으므로 다시 하지 않는다
            const first = lastWidth === 0;
            lastWidth = w;
            if (!first) scheduleFull('width');
          });
          ro.observe(view.dom);
          // 글꼴이 실제로 새로 로드됐을 때만 전체 재배치 (fonts.ready 는 문서를 열 때마다 한 번 더 돌게 했다)
          const fonts: FontFaceSet | undefined = (document as any).fonts;
          const onFonts = () => scheduleFull('fonts');
          fonts?.addEventListener('loadingdone', onFonts);
          schedule();
          return {
            update(v, prev) {
              if (v.state.doc !== prev.doc) schedule();
            },
            destroy() {
              destroyed = true;
              if (raf) cancelAnimationFrame(raf);
              clearTimeout(timer);
              ro.disconnect();
              fonts?.removeEventListener('loadingdone', onFonts);
              view.dom.removeEventListener('compositionend', onCompEnd);
              window.removeEventListener('kite:relayout', onRelayout);
            },
          };
        },
      }),
    ];
  },
});
