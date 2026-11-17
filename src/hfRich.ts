import type { DocSettings, HeaderFooter } from './types';
import { layoutTabsHtml } from './editor/tabLayout';
import { getDocSchema } from './editor/extensions';
import { renderBlocks } from './editor/hwpStatic';

const cache = new WeakMap<object, string>();

/** 블록 JSON(머리말·꼬리말·바탕쪽의 내용)의 HTML. 같은 내용은 한 번만 만든다. 없으면 null */
export function blocksHtml(c: unknown): string | null {
  if (!Array.isArray(c) || !c.length || typeof document === 'undefined') return null;
  let html = cache.get(c);
  if (html == null) {
    try {
      html = renderBlocks(getDocSchema(), c as any).innerHTML;
    } catch {
      html = '';
    }
    cache.set(c, html);
  }
  return html || null;
}

/**
 * 표·그림이 든 머리말/꼬리말(HeaderFooter.content)의 HTML. 없으면 null.
 * 문서 스키마로 그리므로 본문과 같은 모양이다. 쪽 번호 글자({{PAGE}})는 부르는 쪽에서 바꾼다.
 */
export function hfRichHtml(def: HeaderFooter): string | null {
  return blocksHtml(def.content);
}

/**
 * Word 문서의 머리말·꼬리말이 차지하는 높이에 맞춰 본문 영역을 줄인다.
 * Word 는 머리말이 '위 여백 − 머리말 거리'보다 길면 본문을 그만큼 아래에서 시작하고, 꼬리말도 같은 식으로 본문 끝을 올린다.
 * 화면에 그려서 재므로 브라우저에서만 한다 (잴 수 없으면 그대로 둔다). 쪽마다 다른 머리말(첫 쪽·짝수 쪽)은 가장 긴 것에 맞춘다.
 */
export function fitHeaderFooter(s: DocSettings): void {
  if (typeof document === 'undefined' || !document.body) return;
  if (/jsdom|Node\.js/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js')) return;
  const pg = s.page;
  const MM = 96 / 25.4;
  const pageW = pg.landscape ? Math.max(pg.width, pg.height) : Math.min(pg.width, pg.height);
  const width = (pageW - pg.marginLeft - pg.marginRight - (pg.gutter || 0)) * MM;
  if (!(width > 20)) return;
  const heightOf = (def: HeaderFooter | undefined): number => {
    const html = def ? hfRichHtml(def) : null;
    if (!html) return 0;
    const host = document.createElement('div');
    host.className = 'kdoc-content hf-rich';
    host.style.cssText = `position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:${width}px`;
    // 쪽 번호 자리는 숫자 한두 글자다 (자리 표시 글자 그대로 재면 줄이 넘칠 수 있다)
    host.innerHTML = layoutTabsHtml(html.replace(/\{\{PAGES?\}\}/g, '1'), width);
    document.body.appendChild(host);
    try {
      return host.getBoundingClientRect().height;
    } finally {
      host.remove();
    }
  };
  const pageH = pg.landscape ? Math.min(pg.width, pg.height) : Math.max(pg.width, pg.height);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const grow = (which: 'header' | 'footer', key: 'marginHeader' | 'marginFooter') => {
    const def = s[which];
    const orig = pg[key];
    // 종이의 절반을 넘는 머리말은 잘못 잰 것으로 보고 따르지 않는다
    const fit = (h: number) => (h > orig + 0.05 && h < pageH / 2 ? r1(h) : orig);
    const rest = fit(Math.max(heightOf(def), heightOf(def.even)) / MM);
    // 첫 쪽의 머리말이 다르면(다른 머리말을 쓰거나 비운다) 첫 쪽의 본문 영역만 따로 맞춘다
    const firstDiffers = !!def.first || !!s.hideFirst?.[which];
    const first = firstDiffers ? fit(heightOf(def.first) / MM) : rest;
    pg[key] = rest;
    if (Math.abs(first - rest) > 0.05) s.firstPage = { ...s.firstPage, [key]: first };
  };
  grow('header', 'marginHeader');
  grow('footer', 'marginFooter');
}
