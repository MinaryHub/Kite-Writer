/**
 * 줄 번호 (한글의 구역 설정 → 줄 번호): 본문 줄마다 왼쪽 여백에 번호를 찍는다.
 *
 * 줄 자리는 편집 화면에 그려진 문단에서 잰다 — 한글 문서는 줄 첫머리 버팀대(hwp-strut)가 줄마다 한글의 기준선 자리를
 * 갖고, 그 밖의 문단은 글자 조각들의 상자를 줄로 묶어 기준선을 어림한다. 표·글상자·떠 있는 개체 안의 글은 세지 않는다.
 * 번호의 오른쪽 끝은 본문 왼쪽에서 distance(mm) 만큼 왼쪽, 글자는 줄의 기준선에 놓인다.
 */
import type { DocTab } from './doc/docTab';
import type { LineNumbering } from './types';
import { pageAtY, printPlans, type PageGeom, type PagePlan } from './print';

/** 줄 번호 하나: 쪽(0부터), 그 쪽 본문 맨 위에서 줄의 기준선까지(px), 번호 */
export interface LineMark {
  page: number;
  base: number;
  n: number;
}

/** 번호 글자: 한글 기본 글꼴 10pt */
export const LINE_NUM_FONT = "'함초롬바탕','HCR Batang','바탕',serif";
export const LINE_NUM_PX = 10 * (96 / 72);
const PX_PER_MM = 96 / 25.4;
/** 번호 칸의 폭 (오른쪽 맞춤) */
const NUM_BOX_W = 80;

let cx: CanvasRenderingContext2D | null | undefined;
const boxCache = new Map<string, { a: number; d: number } | null>();
/** 글꼴의 글자 상자: 기준선 위(a)·아래(d) 높이 (px). 잴 수 없으면 null */
function fontBox(font: string): { a: number; d: number } | null {
  let v = boxCache.get(font);
  if (v !== undefined) return v;
  v = null;
  if (cx === undefined) cx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  if (cx) {
    cx.font = font;
    const m = cx.measureText('가');
    if (m.fontBoundingBoxAscent > 0 && m.fontBoundingBoxDescent >= 0) v = { a: m.fontBoundingBoxAscent, d: m.fontBoundingBoxDescent };
  }
  boxCache.set(font, v);
  return v;
}

/** 글꼴의 글자 상자에서 기준선 위 높이의 비율 */
function ascentRatio(font: string): number {
  const b = fontBox(font);
  return b ? b.a / (b.a + b.d) : 0.8;
}

/** 번호 글꼴의 기준선 위·아래 높이 (px): 줄 높이를 이 합으로 두면 글자의 기준선이 상자 위에서 a 만큼 아래에 온다 */
function numBox(): { a: number; d: number } {
  return fontBox(`${LINE_NUM_PX}px ${LINE_NUM_FONT}`) || { a: LINE_NUM_PX * 0.96, d: LINE_NUM_PX * 0.24 };
}

const TEXT_BLOCK = /^(P|H[1-6])$/;
const CONTAINER = /^(UL|OL|LI|BLOCKQUOTE)$/;

/** 본문 문단들: 최상위 문단과 목록·인용 안의 문단 (표·글상자·떠 있는 개체 안은 빼고) */
function bodyParas(el: Element, out: HTMLElement[]) {
  for (const c of Array.from(el.children)) {
    if (TEXT_BLOCK.test(c.tagName)) out.push(c as HTMLElement);
    else if (CONTAINER.test(c.tagName)) bodyParas(c, out);
  }
}

/** 문단의 줄마다 기준선 자리 (화면 좌표). z: 화면 배율 */
function lineBases(p: HTMLElement, z: number): number[] {
  // 한글 줄 상자: 버팀대의 위 + (높이 + 세로 맞춤) 이 기준선이다 (hwpMetrics 의 lineStartWidget)
  const struts = Array.from(p.querySelectorAll<HTMLElement>('.hwp-strut')).filter((s) => s.closest('p, h1, h2, h3, h4, h5, h6') === p);
  if (struts.length) {
    return struts.map((s) => {
      const r = s.getBoundingClientRect();
      const h = parseFloat(s.style.height);
      const va = parseFloat(s.style.verticalAlign);
      return Number.isFinite(h) && Number.isFinite(va) ? r.top + (h + va) * z : r.bottom;
    });
  }
  // 글자 조각들: 겹치는 세로 범위끼리 한 줄로 묶는다
  const frags: { top: number; bottom: number; base: number }[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!(n.nodeValue || '').length) continue;
      const parent = n.parentElement;
      if (!parent || parent.closest('.k-float, .k-textbox, table') !== p.closest('.k-float, .k-textbox, table')) continue;
      const cs = getComputedStyle(parent);
      const ratio = ascentRatio(`${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`);
      range.selectNodeContents(n);
      for (const r of Array.from(range.getClientRects())) if (r.height > 0.5) frags.push({ top: r.top, bottom: r.bottom, base: r.top + r.height * ratio });
    } else if ((n as Element).tagName === 'IMG' && !(n as Element).closest('.k-float')) {
      const r = (n as Element).getBoundingClientRect();
      if (r.height > 0.5) frags.push({ top: r.top, bottom: r.bottom, base: r.bottom });
    }
  }
  if (!frags.length) {
    // 빈 문단: 문단 상자의 첫 줄 (줄 높이 안에서 글자 크기만 한 글자의 기준선)
    const r = p.getBoundingClientRect();
    const cs = getComputedStyle(p);
    const fs = parseFloat(cs.fontSize) || 13.33;
    const lh = parseFloat(cs.lineHeight) || fs * 1.2;
    const pt = parseFloat(cs.paddingTop) || 0;
    return [r.top + (pt + (lh - fs * 1.2) / 2 + fs * 1.2 * ascentRatio(`${cs.fontSize} ${cs.fontFamily}`)) * z];
  }
  frags.sort((a, b) => a.top - b.top);
  const lines: { top: number; bottom: number; base: number }[] = [];
  for (const f of frags) {
    const l = lines[lines.length - 1];
    const ov = l ? Math.min(l.bottom, f.bottom) - Math.max(l.top, f.top) : -1;
    if (l && ov > 0.5 * Math.min(l.bottom - l.top, f.bottom - f.top)) {
      l.top = Math.min(l.top, f.top);
      l.bottom = Math.max(l.bottom, f.bottom);
      l.base = Math.max(l.base, f.base);
    } else lines.push({ ...f });
  }
  return lines.map((l) => l.base);
}

/** 편집 화면에 그려진 본문 줄을 재어 번호를 매긴다 */
export function measureLineNumbers(root: HTMLElement, plans: PagePlan[], ln: LineNumbering): LineMark[] {
  const rootRect = root.getBoundingClientRect();
  const z = root.offsetHeight > 0 ? rootRect.height / root.offsetHeight || 1 : 1;
  const paras: HTMLElement[] = [];
  bodyParas(root, paras);
  const ys: number[] = [];
  for (const p of paras) for (const b of lineBases(p, z)) ys.push((b - rootRect.top) / z);
  ys.sort((a, b) => a - b);
  const every = Math.max(1, Math.round(+ln.countBy || 1));
  const start = Math.max(1, Math.round(+ln.start || 1));
  const out: LineMark[] = [];
  let n = start - 1;
  let lastPage = -1;
  for (const y of ys) {
    const page = pageAtY(plans, y);
    const pl = plans[page];
    // 본문 영역 밖(쪽 사이 공간)에 걸린 줄은 세지 않는다
    if (!pl || y < pl.contentTop - 1 || y > pl.contentTop + pl.g.contentH + 1) continue;
    if (ln.restart === 'page' && page !== lastPage) n = start - 1;
    lastPage = page;
    n++;
    if (n % every === 0 || every === 1) out.push({ page, base: Math.round((y - pl.contentTop) * 100) / 100, n });
  }
  return out;
}

const cache = new WeakMap<object, LineMark[]>();

/** 탭의 줄 번호들 (쪽 나누기 결과가 바뀔 때마다 다시 잰다) */
export function lineMarksOf(tab: DocTab): LineMark[] {
  const ln = tab.settings.lineNumbers;
  if (!ln || typeof document === 'undefined') return [];
  let v = cache.get(tab.layout);
  if (!v) {
    try {
      v = measureLineNumbers(tab.editor.view.dom as HTMLElement, printPlans(tab), ln);
    } catch {
      v = [];
    }
    cache.set(tab.layout, v);
  }
  return v;
}

/** k 번째 쪽의 줄 번호들: 쪽(용지) 왼쪽 위 기준 자리 [왼쪽, 위, 폭, 높이]와 번호 */
export function lineNumberBoxes(marks: LineMark[], g: PageGeom, k: number, ln: LineNumbering): { left: number; top: number; width: number; height: number; n: number }[] {
  const { a, d } = numBox();
  const right = g.ml - Math.max(0, +ln.distance || 0) * PX_PER_MM;
  return marks
    .filter((m) => m.page === k)
    .map((m) => ({ left: Math.round((right - NUM_BOX_W) * 100) / 100, top: Math.round((g.mt + m.base - a) * 100) / 100, width: NUM_BOX_W, height: Math.round((a + d) * 100) / 100, n: m.n }));
}

/** 인쇄용: 한 쪽의 줄 번호 HTML (쪽 상자 기준 절대 자리) */
export function lineNumbersHtml(tab: DocTab, g: PageGeom, k: number): string {
  const ln = tab.settings.lineNumbers;
  if (!ln) return '';
  return lineNumberBoxes(lineMarksOf(tab), g, k, ln)
    .map((b) => `<div class="line-num" style="position:absolute;left:${b.left}px;top:${b.top}px;width:${b.width}px;height:${b.height}px;line-height:${b.height}px;text-align:right;font-family:${LINE_NUM_FONT.replace(/"/g, '')};font-size:${LINE_NUM_PX}px;white-space:nowrap">${b.n}</div>`)
    .join('');
}
