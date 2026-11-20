import { DOMSerializer } from '@tiptap/pm/model';
import type { HeaderFooter } from './types';
import { getDocSchema } from './editor/extensions';
import { sanitizeDoc } from './editor/sanitize';
import { hwpTextStyles } from './editor/extensions/hwpMetrics';

/**
 * 한글 문서의 문단: 글자 묶음마다 한글 방식의 폭(자간·장평·빈칸 폭·언어별 글꼴)을 입힌다 (편집기에서는 hwpMetrics 의 꾸밈).
 * 문단의 글자 묶음과 DOM 의 글자 노드는 차례가 같다. 어긋나면 그만둔다
 */
function applyHwpWidths(para: any, el: HTMLElement) {
  const texts: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  let i = 0;
  para.forEach((child: any) => {
    if (!child.isText) return;
    const dom = texts[i++];
    if (!dom || dom.data !== child.text) return;
    const styles = hwpTextStyles(child, para);
    if (!styles.length) return;
    // 뒤에서부터 잘라 감싼다 (앞쪽 자리가 밀리지 않게)
    for (const st of [...styles].sort((a, b) => b.from - a.from)) {
      if (st.from < 0 || st.to > dom.data.length || st.to <= st.from) continue;
      const tail = dom.splitText(st.from);
      if (st.to - st.from < tail.data.length) tail.splitText(st.to - st.from);
      const span = document.createElement('span');
      span.setAttribute('style', st.style);
      tail.parentNode!.replaceChild(span, tail);
      span.appendChild(tail);
    }
  });
  // 줄 끝 빈칸은 폭 0 (한글은 줄 끝 빈칸을 줄 폭에 넣지 않는다: 오른쪽·가운데 정렬이 글자 끝에 맞는다)
  const all: Text[] = [];
  const w2 = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w2.nextNode(); n; n = w2.nextNode()) all.push(n as Text);
  const lastText = all[all.length - 1];
  const trail = lastText ? lastText.data.length - lastText.data.replace(/[ \u00a0]+$/, '').length : 0;
  if (lastText && trail > 0) {
    const sp = trail < lastText.data.length ? lastText.splitText(lastText.data.length - trail) : lastText;
    const span = document.createElement('span');
    span.setAttribute('style', 'font-size: 0; letter-spacing: 0; word-spacing: 0');
    sp.parentNode!.replaceChild(span, sp);
    span.appendChild(sp);
  }
}

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
    if (Array.isArray(vs)) {
      try {
        applyHwpWidths(n, el);
      } catch {
        /* 폭 보정 없이 그린다 */
      }
    }
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
