import { DOMSerializer, type Schema } from '@tiptap/pm/model';
import { sanitizeDoc } from './sanitize';
import type { JNode } from '../formats/common';

/**
 * 한글이 놓은 줄 자리(hwpVs: [줄 위쪽, 줄 높이, 줄 간격, 기준선] px)가 있는 한 줄 문단의 줄 상자를 그 값으로 만든다
 * (편집기에서는 hwpMetrics 가 하는 일). 줄 첫머리의 버팀대가 줄 높이와 기준선을 정하고, 앞 문단과 벌어진 만큼 위를 띄운다
 */
export function applyHwpLines(frag: { forEach(f: (n: any, offset: number, index: number) => void): void }, parent: Element) {
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
    const strut = el.ownerDocument.createElement('span');
    strut.setAttribute('style', `display:inline-block;width:0;height:${pitch.toFixed(2)}px;vertical-align:${(-(pitch - base)).toFixed(2)}px`);
    el.insertBefore(strut, el.firstChild);
    el.style.lineHeight = '0';
    el.style.whiteSpace = 'pre';
    const gap = +n.attrs.hwpGap;
    if (gap > 0) el.style.marginTop = gap.toFixed(2) + 'px';
  });
}

/**
 * 블록 JSON 을 편집기 밖에서 그린다 (머리말·꼬리말·바탕쪽·도형 안의 글). 문서 스키마로 그리므로 본문과 같은 모양이다.
 * 스키마에 맞지 않는 내용은 보정하고, 그릴 수 없으면 빈 조각을 돌려준다
 */
export function renderBlocks(schema: Schema, content: JNode[], doc: Document = document): HTMLElement {
  const div = doc.createElement('div');
  try {
    const node = sanitizeDoc({ type: 'doc', content } as any, schema);
    div.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(node.content, { document: doc }));
    applyHwpLines(node.content, div);
    // 빈 문단도 한 줄을 차지한다 (편집기는 빈 문단에 줄 바꿈을 넣어 그린다. 여기서도 같게)
    for (const el of Array.from(div.querySelectorAll('p, h1, h2, h3, h4, h5, h6'))) if (!el.firstChild) el.appendChild(doc.createElement('br'));
  } catch {
    /* 그릴 수 없는 내용 */
  }
  return div;
}
