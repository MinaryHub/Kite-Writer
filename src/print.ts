import type { Node as PMNode } from '@tiptap/pm/model';
import type { DocSettings, HeaderFooter, PageSetup } from './types';
import { hfRichHtml } from './hfRich';
import type { DocTab } from './doc/docTab';
import { PX_PER_MM, formatPageNumber, xmlEscape } from './formats/common';
import { FN_FONT_PX, FN_LINE, FN_SEP } from './editor/extensions/pagination';

export const PAGE_GAP = 18;

export interface PageGeom {
  wMm: number;
  hMm: number;
  W: number;
  H: number;
  /** 본문 시작(위쪽 + 머리말) */
  mt: number;
  /** 본문 끝 아래(아래쪽 + 꼬리말) */
  mb: number;
  ml: number;
  mr: number;
  contentW: number;
  contentH: number;
  gap: number;
  P: number;
}

export function computeGeom(s: DocSettings, gap = PAGE_GAP): PageGeom {
  const p = s.page;
  const wMm = p.landscape ? Math.max(p.width, p.height) : p.width;
  const hMm = p.landscape ? Math.min(p.width, p.height) : p.height;
  const W = wMm * PX_PER_MM;
  const H = hMm * PX_PER_MM;
  const mt = (p.marginTop + p.marginHeader) * PX_PER_MM;
  const mb = (p.marginBottom + p.marginFooter) * PX_PER_MM;
  const ml = (p.marginLeft + p.gutter) * PX_PER_MM;
  const mr = p.marginRight * PX_PER_MM;
  return {
    wMm,
    hMm,
    W,
    H,
    mt,
    mb,
    ml,
    mr,
    contentW: Math.max(40, W - ml - mr),
    contentH: Math.max(40, H - mt - mb),
    gap,
    P: H + gap,
  };
}

/** 구역 용지(없으면 문서 용지)로 본 쪽 기하 */
export function geomFor(s: DocSettings, setup: PageSetup | null, gap = PAGE_GAP): PageGeom {
  return computeGeom(setup ? { ...s, page: setup } : s, gap);
}

/** 문서의 구역 용지들 (구역 나누기에 담긴 것) */
export function sectionSetups(doc: PMNode | null): PageSetup[] {
  const out: PageSetup[] = [];
  doc?.forEach((n) => {
    if (n.type.name === 'pageBreak' && n.attrs?.sectionPage) out.push(n.attrs.sectionPage as PageSetup);
  });
  return out;
}

/**
 * 쪽을 늘어놓는 무대의 폭: 구역마다 용지가 다르면 가장 넓은 용지. 쪽은 무대 가운데에 놓는다.
 * 문서 내용으로만 정해지므로 화면(PageView)과 구역 블록 위치(sections 확장)가 같은 값을 쓴다
 */
export function stageWidth(s: DocSettings, doc: PMNode | null): number {
  let w = computeGeom(s).W;
  for (const p of sectionSetups(doc)) w = Math.max(w, geomFor(s, p).W);
  return w;
}

export interface PagePlan {
  g: PageGeom;
  /** 이 쪽의 용지가 문서 용지와 다르면 그 용지 (머리말 자리 등을 그 용지로 잰다) */
  settings: DocSettings;
  /** 무대에서 용지 왼쪽·위 */
  left: number;
  top: number;
  /** 편집기 좌표(첫 쪽 본문 맨 위 = 0)에서 이 쪽 본문 맨 위 */
  contentTop: number;
  /** 문서 용지 본문 왼쪽에서 이 쪽 본문 왼쪽까지 (구역 블록이 옮겨진 만큼) */
  dx: number;
}

/** 쪽마다의 자리. 쪽 나누기 엔진(pagination)의 쪽 위치 계산과 같은 식이다 */
export function planPages(s: DocSettings, pageCount: number, pageSetups: (PageSetup | null)[] | undefined, W: number, gap = PAGE_GAP): PagePlan[] {
  const base = computeGeom(s, gap);
  const hostLeft = (W - base.W) / 2 + base.ml;
  const out: PagePlan[] = [];
  let top = 0;
  for (let k = 0; k < Math.max(1, pageCount); k++) {
    const setup = pageSetups?.[k] ?? null;
    const g = setup ? geomFor(s, setup, gap) : base;
    const left = (W - g.W) / 2;
    out.push({ g, settings: setup ? { ...s, page: setup } : s, left, top, contentTop: top + g.mt - base.mt, dx: left + g.ml - hostLeft });
    top += g.H + gap;
  }
  return out;
}

/** 편집기 좌표 y 가 놓인 쪽 (0부터) */
export function pageAtY(plans: PagePlan[], y: number): number {
  let k = 0;
  while (k + 1 < plans.length && plans[k + 1].contentTop <= y) k++;
  return k;
}

export function hfText(text: string, page: number, pages: number, fmt: string): string {
  return text.replace(/\{\{PAGE\}\}/g, formatPageNumber(page, fmt === 'dash' ? 'digit' : fmt)).replace(/\{\{PAGES\}\}/g, String(pages));
}

/** 머리말/꼬리말 영역 위치 (px) */
export function hfZones(s: DocSettings, g: PageGeom) {
  const p = s.page;
  const minH = 6 * PX_PER_MM;
  let hTop = p.marginTop * PX_PER_MM;
  let hH = p.marginHeader * PX_PER_MM;
  if (hH < minH) {
    hH = minH;
    hTop = Math.max(2 * PX_PER_MM, g.mt - minH);
  }
  let fTop = g.H - g.mb;
  let fH = p.marginFooter * PX_PER_MM;
  if (fH < minH) {
    fH = minH;
    fTop = Math.min(g.H - minH - 2 * PX_PER_MM, g.H - g.mb);
  }
  return { header: { top: hTop, height: hH }, footer: { top: fTop, height: fH } };
}

/** k 번째 쪽의 배경 그림 스타일 (PDF 에서 온 쪽 바탕 그림) — 없거나 이상하면 null */
export function pageBackgroundStyle(s: DocSettings, k: number, dy = 0): Record<string, string> | null {
  const b = s.pageBackgrounds?.[k];
  if (!b || typeof b.src !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(b.src)) return null;
  const n = (v: any) => (typeof v === 'number' && isFinite(v) ? v : null);
  const x = n(b.x), y = n(b.y), w = n(b.w), h = n(b.h);
  if (x == null || y == null || w == null || h == null || w <= 0 || h <= 0) return null;
  const px = 96 / 72;
  return {
    backgroundImage: `url("${b.src}")`,
    // dy: 이 요소가 쪽 위끝에서 떨어진 거리(px) — 쪽 경계 가리개에도 같은 배경을 이어 그린다
    backgroundPosition: `${x * px}px ${y * px - dy}px`,
    backgroundSize: `${w * px}px ${h * px}px`,
    backgroundRepeat: 'no-repeat',
  };
}

/**
 * k 번째 쪽 맨 위에 되풀이할 표 제목 줄의 HTML. 쪽 나누기가 그 자리를 비워 두었으므로(LayoutResult.repeats)
 * 편집 화면의 표에서 제목 줄만 복제해 본문 맨 위에 놓는다. 편집 대상은 아니다.
 */
export function repeatHeadsHtml(tab: DocTab, g: PageGeom, k: number): string {
  const reps = (tab.layout.repeats || []).filter((r) => r.page === k);
  if (!reps.length) return '';
  const cls = 'kdoc-content' + (tab.settings.hwpMetrics ? ' hwp-metrics' : '') + (tab.settings.fixedLines ? ' fixed-lines' : '');
  let html = '';
  for (const r of reps) {
    let dom: Node | null = null;
    try {
      dom = tab.editor.view.nodeDOM(r.table);
    } catch {
      continue;
    }
    const table = dom instanceof HTMLElement ? (dom.tagName === 'TABLE' ? dom : dom.querySelector(':scope > table')) : null;
    if (!table) continue;
    const clone = table.cloneNode(true) as HTMLElement;
    let head = true;
    clone.querySelectorAll(':scope > tbody > tr').forEach((tr) => {
      if (head && tr.children.length && Array.from(tr.children).every((c) => c.tagName === 'TH')) return;
      head = false;
      tr.remove();
    });
    clone.querySelectorAll('.pg-spacer, .table-handle, .column-resize-handle, .ProseMirror-separator, .ProseMirror-trailingBreak').forEach((e) => e.remove());
    clone.querySelectorAll('.pg-push-row, .selectedCell').forEach((e) => e.classList.remove('pg-push-row', 'selectedCell'));
    html += `<div class="${cls} pg-repeat-head" style="position:absolute;left:${g.ml}px;top:${g.mt}px;width:${g.contentW}px;pointer-events:none">${clone.outerHTML}</div>`;
  }
  return html;
}

/** 한 쪽의 머리말/꼬리말/쪽 번호/각주 HTML */
export function pageChromeHtml(tab: DocTab, g: PageGeom, k: number, pageCount: number, s: DocSettings = tab.settings): string {
  const z = hfZones(s, g);
  const num = s.pageNumber.start + k;
  const total = pageCount + s.pageNumber.start - 1;
  let html = '';
  const zone = (def: HeaderFooter, top: number, height: number, valign: string) => {
    const rich = hfRichHtml(def);
    if (rich) return `<div class="kdoc-content hf-rich" style="position:absolute;left:${g.ml}px;width:${g.contentW}px;top:${top}px">${hfText(rich, num, total, s.pageNumber.format)}</div>`;
    if (!def.text.trim()) return '';
    return `<div style="position:absolute;left:${g.ml}px;width:${g.contentW}px;top:${top}px;height:${height}px;display:flex;align-items:${valign};justify-content:${def.align === 'left' ? 'flex-start' : def.align === 'right' ? 'flex-end' : 'center'};font-family:'함초롬바탕','HCR Batang','바탕',serif;font-size:9pt;white-space:pre;overflow:hidden">${xmlEscape(hfText(def.text, num, total, s.pageNumber.format))}</div>`;
  };
  html += repeatHeadsHtml(tab, g, k);
  html += zone(s.header, z.header.top, z.header.height, 'flex-start');
  html += zone(s.footer, z.footer.top, z.footer.height, 'flex-end');
  if (s.pageNumber.pos !== 'none') {
    const [v, h] = s.pageNumber.pos.split('-');
    const zz = v === 'top' ? z.header : z.footer;
    html += `<div style="position:absolute;left:${g.ml}px;width:${g.contentW}px;top:${zz.top}px;height:${zz.height}px;display:flex;align-items:${v === 'top' ? 'flex-start' : 'flex-end'};justify-content:${h === 'left' ? 'flex-start' : h === 'right' ? 'flex-end' : 'center'};font-family:'함초롬바탕','HCR Batang','바탕',serif;font-size:9pt">${xmlEscape(formatPageNumber(num, s.pageNumber.format))}</div>`;
  }
  const fns = tab.layout.footnotes.filter((f) => f.page === k);
  if (fns.length) {
    html += `<div style="position:absolute;left:${g.ml}px;width:${g.contentW}px;bottom:${g.mb}px;font-family:'함초롬바탕','HCR Batang','바탕',serif;font-size:${FN_FONT_PX}px;line-height:${FN_LINE}">`;
    html += `<div style="width:35%;border-top:1px solid #000;height:${FN_SEP}px"></div>`;
    for (const f of fns) html += `<div style="padding-left:1.6em;text-indent:-1.6em;word-break:keep-all">${f.num}) ${xmlEscape(f.text)}</div>`;
    html += '</div>';
  }
  return html;
}

export interface PageBox {
  el: HTMLElement;
  top: number;
  bottom: number;
  /** 편집기 본문 왼쪽에서 블록 왼쪽(여백 포함 자리)까지와 블록 폭 */
  left: number;
  width: number;
}

/** 편집기 최상위 블록들의 자리 (쪽 나누기 공간은 제외) */
export function collectPageBoxes(root: HTMLElement): PageBox[] {
  const children = Array.from(root.children) as HTMLElement[];
  return children
    .filter((el) => !el.classList.contains('pg-spacer') && !el.classList.contains('ProseMirror-gapcursor'))
    .map((el) => ({ el, top: el.offsetTop, bottom: el.offsetTop + el.offsetHeight, left: el.offsetLeft, width: el.offsetWidth }));
}

/** 편집 화면의 쪽 배치 (구역마다 용지가 다르면 쪽마다 다르다) */
export function printPlans(tab: DocTab): PagePlan[] {
  const pageCount = Math.max(1, tab.layout.pageCount);
  return planPages(tab.settings, pageCount, tab.layout.pageSetups, stageWidth(tab.settings, tab.editor.state.doc), PAGE_GAP);
}

/** k 번째 쪽: 편집 화면의 블록 사본을 쪽 안 자리에 놓고 머리말·꼬리말·쪽 번호·각주를 붙인다 */
export function buildPrintPage(tab: DocTab, plan: PagePlan, k: number, boxes: PageBox[], pageCount: number): HTMLElement {
  const g = plan.g;
  const page = document.createElement('div');
  page.className = 'print-page';
  page.style.width = `${g.wMm}mm`;
  page.style.height = `${g.hMm}mm`;
  // 인쇄 용지 크기: 쪽마다 이름 붙은 @page (withPrintRoot)
  (page.style as any).page = pageName(g);
  const bg = pageBackgroundStyle(tab.settings, k);
  if (bg) Object.assign(page.style, bg);
  const body = document.createElement('div');
  body.className = 'print-body';
  Object.assign(body.style, { left: `${g.ml}px`, top: `${g.mt}px`, width: `${g.contentW}px`, height: `${g.contentH}px` });
  const content = document.createElement('div');
  content.className = 'kdoc-content' + (tab.settings.hwpMetrics ? ' hwp-metrics' : '') + (tab.settings.fixedLines ? ' fixed-lines' : '');
  Object.assign(content.style, { position: 'relative', width: `${g.contentW}px`, height: `${g.contentH}px` });
  const y0 = plan.contentTop;
  const y1 = y0 + g.contentH;
  for (const b of boxes) {
    if (b.bottom <= y0 || b.top >= y1) continue;
    const clone = b.el.cloneNode(true) as HTMLElement;
    clone.style.position = 'absolute';
    clone.style.top = `${b.top - y0}px`;
    // 화면에서의 자리 그대로 (구역 블록은 이 쪽 본문 왼쪽 기준으로 옮긴다)
    clone.style.left = `${b.left - plan.dx}px`;
    clone.style.width = `${b.width}px`;
    clone.style.marginLeft = '0';
    clone.style.marginRight = '0';
    clone.classList.remove('pg-measuring');
    clone.querySelectorAll('.selectedCell').forEach((e) => e.classList.remove('selectedCell'));
    clone.querySelectorAll('.search-match').forEach((e) => e.classList.remove('search-match', 'current'));
    content.appendChild(clone);
  }
  body.appendChild(content);
  page.appendChild(body);
  const chrome = document.createElement('div');
  chrome.innerHTML = pageChromeHtml(tab, g, k, pageCount, plan.settings);
  while (chrome.firstChild) page.appendChild(chrome.firstChild);
  return page;
}

/** 용지 크기별 @page 이름 */
function pageName(g: PageGeom): string {
  return `kp-${Math.round(g.wMm * 10)}-${Math.round(g.hMm * 10)}`;
}

/** 편집 화면의 배치를 그대로 쪽 단위로 잘라 인쇄용 DOM을 만든다 */
export function buildPrintPages(tab: DocTab): HTMLElement[] {
  const boxes = collectPageBoxes(tab.editor.view.dom as HTMLElement);
  const pageCount = Math.max(1, tab.layout.pageCount);
  const plans = printPlans(tab);
  const pages: HTMLElement[] = [];
  for (let k = 0; k < pageCount; k++) pages.push(buildPrintPage(tab, plans[k], k, boxes, pageCount));
  return pages;
}

async function waitImages(el: HTMLElement) {
  const imgs = Array.from(el.querySelectorAll('img'));
  await Promise.all(imgs.map((i) => (i.complete ? Promise.resolve() : i.decode().catch(() => {}))));
}

export async function withPrintRoot<T>(tab: DocTab, fn: (g: PageGeom) => Promise<T>): Promise<T> {
  const g = computeGeom(tab.settings);
  document.getElementById('print-root')?.remove();
  document.getElementById('print-style')?.remove();
  const root = document.createElement('div');
  root.id = 'print-root';
  for (const p of buildPrintPages(tab)) root.appendChild(p);
  const style = document.createElement('style');
  style.id = 'print-style';
  // 구역마다 용지가 다르면 쪽마다 그 크기로 (이름 붙은 @page)
  const sizes = new Map<string, PageGeom>();
  for (const p of printPlans(tab)) sizes.set(pageName(p.g), p.g);
  style.textContent = `@page { size: ${g.wMm}mm ${g.hMm}mm; margin: 0; }` + [...sizes].map(([n, x]) => `@page ${n} { size: ${x.wMm}mm ${x.hMm}mm; margin: 0; }`).join('');
  document.head.appendChild(style);
  document.body.appendChild(root);
  await waitImages(root);
  try {
    return await fn(g);
  } finally {
    root.remove();
    style.remove();
  }
}
