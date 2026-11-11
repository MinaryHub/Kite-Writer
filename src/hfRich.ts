import { DOMSerializer } from '@tiptap/pm/model';
import type { HeaderFooter } from './types';
import { getDocSchema } from './editor/extensions';
import { sanitizeDoc } from './editor/sanitize';

const cache = new WeakMap<object, string>();

/**
 * 한글이 놓은 줄 자리(hwpVs: [줄 위쪽, 줄 높이, 줄 간격, 기준선] px)가 있는 한 줄 문단의 줄 상자를 그 값으로 만든다
 * (편집기에서는 hwpMetrics 가 하는 일). 줄 첫머리의 버팀대가 줄 높이와 기준선을 정하고, 앞 문단과 벌어진 만큼 위를 띄운다
 */
function applyHwpLines(frag: { forEach(f: (n: any, offset: number, index: number) => void): void }, parent: Element) {
  frag.forEach((n, _o, i) => {
    const el = parent.children[i] as HTMLElement | undefined;
    if (!el) return;
    if (n.type.name !== 'paragraph') {
      // 표의 칸·글상자 안으로
      if (n.type.name === 'table') {
        const cells = el.querySelectorAll(':scope > tbody > tr > td, :scope > tbody > tr > th, :scope > tr > td, :scope > tr > th');
        let k = 0;
        n.forEach((row: any) => row.forEach((cell: any) => { const c = cells[k++]; if (c) applyHwpLines(cell.content, c); }));
      }
      return;
    }
    const vs = n.attrs.hwpVs as number[][] | null;
    if (!Array.isArray(vs) || vs.length !== 1 || !(vs[0][1] > 0)) return;
    const v = vs[0];
    const last = i === (parent.children.length - 1);
    const pitch = Math.max(1, last ? v[1] : v[1] + (+v[2] || 0));
    const base = v[3] >= v[1] * 0.6 ? v[3] : v[1] * 0.85;
    const strut = document.createElement('span');
    strut.setAttribute('style', `display:inline-block;width:0;height:${pitch.toFixed(2)}px;vertical-align:${(-(pitch - base)).toFixed(2)}px`);
    el.insertBefore(strut, el.firstChild);
    el.style.lineHeight = '0';
    el.style.whiteSpace = 'pre';
    const gap = +n.attrs.hwpGap;
    if (gap > 0) el.style.marginTop = gap.toFixed(2) + 'px';
  });
}

/**
 * 표·그림이 든 머리말/꼬리말(HeaderFooter.content)의 HTML. 없으면 null.
 * 문서 스키마로 그리므로 본문과 같은 모양이다. 쪽 번호 글자({{PAGE}})는 부르는 쪽에서 바꾼다.
 */
export function hfRichHtml(def: HeaderFooter): string | null {
  const c = def.content;
  if (!Array.isArray(c) || !c.length || typeof document === 'undefined') return null;
  let html = cache.get(c);
  if (html == null) {
    try {
      const schema = getDocSchema();
      const node = sanitizeDoc({ type: 'doc', content: c } as any, schema);
      const div = document.createElement('div');
      div.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(node.content));
      applyHwpLines(node.content, div);
      html = div.innerHTML;
    } catch {
      html = '';
    }
    cache.set(c, html);
  }
  return html || null;
}
