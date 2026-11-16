import type { HeaderFooter } from './types';
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
