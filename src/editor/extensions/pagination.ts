import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Mapping } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { viewState } from '../viewState';
import type { PageSetup } from '../../types';

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
  /** 구역 나누기(쪽 나누기의 sectionPage)의 용지 → 그 구역의 쪽 기하 */
  resolve?: (p: PageSetup) => PageGeometry;
}

function sameGeometry(a: PageGeometry | null, b: PageGeometry | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.pageHeight === b.pageHeight && a.gap === b.gap && a.contentHeight === b.contentHeight && a.contentWidth === b.contentWidth && a.mt === b.mt;
}

export interface PageBreakInfo {
  pos: number;
  height: number;
  kind: 'block' | 'row' | 'line';
  /** 표가 이어지는 쪽의 맨 위에 되풀이할 제목 줄: 표 위치, 그 쪽 번호(0부터), 제목 줄 높이(px). 높이만큼 공간에 더해 둔다 */
  head?: RepeatHead;
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

export interface LayoutResult {
  pageCount: number;
  footnotes: FootnoteInfo[];
  /** 각 쪽의 시작 문서 위치 (쪽 이동용) */
  pageStarts: number[];
  /** 쪽 맨 위에 되풀이해 그릴 표 제목 줄 */
  repeats?: RepeatHead[];
  /** 쪽마다의 편집 용지 (구역마다 용지가 다른 문서만. null 은 문서 용지) */
  pageSetups?: (PageSetup | null)[];
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
    if (b.kind === 'row') {
      const node = doc.nodeAt(b.pos);
      if (!node || node.type.name !== 'tableRow') continue;
      decos.push(Decoration.node(b.pos, b.pos + node.nodeSize, { class: 'pg-push-row', style: `--pg-push: ${b.height}px` }));
      continue;
    }
    const block = b.kind === 'block';
    decos.push(
      Decoration.widget(
        b.pos,
        () => {
          const el = document.createElement(block ? 'div' : 'span');
          el.className = block ? 'pg-spacer' : 'pg-spacer pg-line-spacer';
          el.style.height = b.height + 'px';
          el.contentEditable = 'false';
          return el;
        },
        { side: -1, key: `pg-${b.kind}-${i++}-${b.height}`, ignoreSelection: true, marks: [] },
      ),
    );
  }
  return DecorationSet.create(doc, decos);
}

/** 제목 칸으로만 된 줄인가 */
export function isHeaderRow(row: PMNode): boolean {
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
function computeLayout(
  view: EditorView,
  g: PageGeometry,
  cache: LayoutCache | null = null,
  dirty: DirtyRange | null = null,
  curBreaks: PageBreakInfo[] = [],
): { breaks: PageBreakInfo[]; result: LayoutResult; cache: LayoutCache; incremental: boolean } | null {
  const root = view.dom as HTMLElement;
  const s = viewState.zoom || 1;
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
  if (multi) cache = null;
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
  let lastBottom = 0;
  /** 지금 배치하는 표의 되풀이할 제목 줄 (제목 줄 다음 줄들을 배치하는 동안만) */
  let tableHead: { table: number; h: number } | null = null;
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
      const si = $f.index(0);
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
    normalize(top);
    const pageTop = T(page);
    const overflow = bottom > limitFor(fnH) + 0.5 || top > pageTop + CHof(page);
    if ((forceNext || softNext || overflow) && (forceNext || top > pageTop + 0.5)) {
      const pos = getPos();
      if (pos != null) {
        const h = Math.round((T(page + 1) - top) * 100) / 100;
        if (h > 0) {
          breaks.push({ pos, height: h, kind });
          shift += h;
          top += h;
          bottom += h;
        }
        page++;
        fnUsed = 0;
        commit();
        normalize(top);
      }
    }
    forceNext = false;
    softNext = false;
    markPageStart(docPos);
    if (fnH > 0) fnUsed += fnH + (fnUsed === 0 ? FN_SEP : 0);
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

  const handleTextblock = (node: PMNode, pos: number) => {
    const el = view.nodeDOM(pos) as HTMLElement | null;
    if (!el || !(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    const top = rel(r.top);
    const bottom = rel(r.bottom);
    const fns = collectFootnotes(el, pos);
    const fnTotal = fns.reduce((a, f) => a + f.h, 0);

    // 그대로 들어가는지 확인
    const sTop = top + shift;
    const sBottom = bottom + shift;
    const p = pageAtY(sTop + 0.5, page);
    const fnUsedHere = p === page ? fnUsed : 0;
    const limit = T(p) + CHof(p) - fnUsedHere - (fnTotal > 0 && fnUsedHere === 0 ? FN_SEP : 0) - fnTotal;
    if (forceNext || sBottom <= limit + 0.5) {
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
    for (let i = 0; i < n; i++) {
      const uTop = i === 0 ? top : (lines[i - 1].bottom + lines[i].top) / 2;
      const uBottom = i === n - 1 ? bottom : (lines[i].bottom + lines[i + 1].top) / 2;
      const lineFns = fns.filter((f) => f.top >= uTop - 1 && f.top < uBottom);
      const fnH = lineFns.reduce((a, f) => a + f.h, 0);
      if (i === 0) {
        place(uTop, uBottom, fnH, () => pos, 'block', pos);
      } else {
        const line = lines[i];
        place(uTop, uBottom, fnH, () => posAtLineStart(el, line, pos, pos + node.nodeSize), 'line', pos);
      }
      pushFootnotes(lineFns);
    }
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
    // 나뉜 줄의 높이 = max(줄 최소 높이, 칸마다 '내용 높이 + 끼운 공간'). 자연 배치의 아래 끝(uBottom)을 기준으로 하면
    // 최소 높이 안에서 가운데 정렬된 칸의 남는 공간까지 늘어난다고 보게 되어 뒤 내용의 자리가 어긋난다
    const rowEl = view.nodeDOM(rowPos) as HTMLElement | null;
    const minH = rowEl ? parseFloat(getComputedStyle(rowEl).getPropertyValue('--row-h')) || 0 : 0;
    let rowBottom = uTop + minH; // 자연 배치 기준 (shift 미포함)
    rowNode.forEach((cell, off) => {
      const cellPos = rowPos + 1 + off;
      let cs = 0;
      let pc = startPage;
      let last = -Infinity;
      for (const lf of collectLeaves(cell, cellPos + 1)) {
        const el = view.nodeDOM(lf.pos) as HTMLElement | null;
        if (!(el instanceof HTMLElement)) continue;
        const r = el.getBoundingClientRect();
        const top = rel(r.top);
        const bottom = rel(r.bottom);
        const sT = top + shift + cs;
        pc = pageAtY(sT + 0.5, pc);
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
                  cs += h;
                  pc++;
                }
              }
            }
          } else if (sT > T(pc) + 0.5) {
            const h = Math.round((T(pc + 1) - sT + (tableHead?.h || 0)) * 100) / 100;
            breaks.push({ pos: lf.pos, height: h, kind: 'block', ...headFor(pc + 1) });
            cs += h;
            pc++;
          }
        }
        last = Math.max(last, bottom + cs);
      }
      // 여러 줄을 합친 칸은 끼운 공간이 합친 줄들에 나뉘어 들어가므로 이 줄의 높이로 치지 않는다
      if ((cell.attrs.rowspan || 1) > 1) return;
      const h = cellContentHeight(view.nodeDOM(cellPos) as HTMLElement | null);
      if (h != null) rowBottom = Math.max(rowBottom, uTop + h + cs);
      else if (last > -Infinity) rowBottom = Math.max(rowBottom, last + PAD);
    });
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
    const el = view.nodeDOM(pos) as HTMLElement | null;
    if (!el || !(el instanceof HTMLElement)) return;
    const r = el.getBoundingClientRect();
    const top = rel(r.top);
    const bottom = rel(r.bottom);
    const fns = collectFootnotes(el, pos);
    const fnTotal = fns.reduce((a, f) => a + f.h, 0);
    const sBottom = bottom + shift;
    const p = pageAtY(top + shift + 0.5, page);
    const fnUsedHere = p === page ? fnUsed : 0;
    if (forceNext || sBottom <= T(p) + CHof(p) - fnUsedHere - fnTotal - (fnTotal ? FN_SEP : 0) + 0.5) {
      place(top, bottom, fnTotal, () => pos, 'block', pos);
      pushFootnotes(fns);
      return;
    }
    const rows: { pos: number; el: HTMLElement }[] = [];
    node.forEach((row, offset) => {
      const rp = pos + 1 + offset;
      const re = view.nodeDOM(rp) as HTMLElement | null;
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
      const pp = pageAtY(uTop + shift + 0.5, page);
      if (uBottom + shift > T(pp) + CHof(pp) + 0.5 && uBottom - uTop > 60) {
        const rowNode = node.child(i);
        splitRow(rowNode, row.pos, uTop, uBottom);
        return;
      }
      const rowFns = collectFootnotes(row.el, pos);
      const fnH = rowFns.reduce((a, f) => a + f.h, 0);
      const nb = breaks.length;
      const pg0 = page;
      if (i === 0) place(uTop, uBottom, fnH, () => pos, 'block', pos);
      else place(uTop, uBottom, fnH, () => row.pos, 'row', row.pos);
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
    const el = view.nodeDOM(pos) as HTMLElement | null;
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
      // 구역 나누기: 다음 쪽부터 그 구역의 용지
      const sp = child.attrs?.sectionPage as PageSetup | null;
      if (sp && g.resolve) {
        const sg = g.resolve(sp);
        curPg = { H: sg.pageHeight, CH: sg.contentHeight, mt: sg.mt ?? 0, setup: sp };
      }
      return;
    }
    softNext = !!child.attrs?.hwpPage;
    if (child.isTextblock) handleTextblock(child, pos);
    else if (name === 'table') handleTable(child, pos);
    else if (CONTAINERS.has(name)) walk(child, pos + 1);
    else handleOther(pos);
  };
  const walk = (parent: PMNode, base: number) => {
    parent.forEach((child, offset) => handleChild(child, base + offset));
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
    const el = view.nodeDOM(pos) as HTMLElement | null;
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
        if (Math.abs(shift + delta - (ps.shift + dp * (g.pageHeight + g.gap))) < 0.5 && Math.abs(fnUsed - ps.fnUsed) < 0.5 && forceNext === ps.forceNext) {
          early = { j, pj, delta, dp };
          break;
        }
      }
    }
    snaps[j] = { top, page, shift, fnUsed, forceNext, lastBottom, nBreaks: breaks.length, nFn: footnotes.length, nStarts: pageStarts.length };
    handleChild(child, pos);
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
      snaps[j + (i - pj)] = { ...o, top: o.top + delta, page: o.page + dp, shift: o.shift + dp * (g.pageHeight + g.gap) - delta, lastBottom: o.lastBottom + dp * (g.pageHeight + g.gap), nBreaks: o.nBreaks + dB, nFn: o.nFn + dF, nStarts: o.nStarts + dS };
    }
  } else {
    pageCount = Math.max(page + 1, pageAtY(Math.max(0, lastBottom - 0.5), page) + 1);
    if (forceNext) pageCount = Math.max(pageCount, page + 2);
    pageCount = Math.min(pageCount, MAX_PAGES);
  }
  while (pageStarts.length < pageCount) pageStarts.push(doc.content.size);
  if (pageStarts.length > pageCount) pageStarts = pageStarts.slice(0, pageCount);
  const repeats = breaks.filter((b) => b.head).map((b) => b.head!);
  const result: LayoutResult = { pageCount, footnotes, pageStarts, ...(repeats.length ? { repeats } : {}) };
  // 구역마다 용지가 다른 문서: 쪽마다의 용지 (끝 쪽까지 채운다)
  if (multi) {
    page = pageCount - 1;
    commit();
    result.pageSetups = pgs.slice(0, pageCount).map((x) => x.setup);
  }
  return { breaks, result, cache: { doc, snaps, breaksLen: breaks.length, footnotes, pageStarts, pageCount, lastBottom }, incremental: useCache };
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
                breaks: value.breaks.map((b) => ({ ...b, pos: tr.mapping.map(b.pos, b.kind === 'line' ? 1 : -1), ...(b.head ? { head: { ...b.head, table: tr.mapping.map(b.head.table, -1) } } : {}) })),
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

          const run = () => {
            raf = 0;
            if (view.state.doc !== lastDoc) {
              lastDoc = view.state.doc;
              runsSinceDocChange = 0;
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
              if (canIncremental) out = computeLayout(view, storage.geometry, cache, dirty ?? { from: 0, to: 0, mapping: new Mapping() }, cur.breaks);
              if (!out) out = computeLayout(view, storage.geometry);
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
            const key = JSON.stringify(out.result);
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
