import { Node } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { cleanShape, shapeToSvg, type ShapeData } from '../../formats/shape';
import { renderBlocks } from '../hwpStatic';
import { floatOf } from './nodes';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    shape: { insertShape: (attrs: { width: number; height: number; d: ShapeData; float?: any }) => ReturnType };
  }
}

const num = (v: any) => (Number.isFinite(+v) && +v > 0 ? Math.min(20000, +v) : 0);

/**
 * 그리기 개체의 화면 요소: 틀(폭×높이) 안의 SVG 와, 도형 안의 글(문서 스키마로 그린 것).
 * withData 면 다시 읽을 수 있게 도형 값을 data-shape 에 싣는다 (복사·HTML 저장용. 편집 화면에서는 싣지 않는다)
 */
export function shapeElement(node: PMNode, withData: boolean, doc: Document = document): HTMLElement {
  const a = node.attrs;
  const w = num(a.width);
  const h = num(a.height);
  const wrap = doc.createElement('span');
  wrap.className = 'k-shape';
  wrap.setAttribute('contenteditable', 'false');
  wrap.style.width = w + 'px';
  wrap.style.height = h + 'px';
  // 글줄 안에서의 세로 자리 (한글 문서: 개체 높이에 따라 기준선 아래로 내린다 — editor.css)
  wrap.style.setProperty('--kh', h + 'px');
  const fl = floatOf(a.float);
  if (fl) {
    wrap.classList.add('k-float');
    if (fl.behind) wrap.classList.add('behind');
    wrap.style.left = fl.x + 'px';
    wrap.style.top = fl.y + 'px';
    if (fl.py != null) wrap.setAttribute('data-py', String(fl.py));
  }
  const d = cleanShape(a.d);
  if (d) {
    const { svg, texts } = shapeToSvg(doc, d, w, h);
    wrap.appendChild(svg);
    for (const t of texts) {
      const box = doc.createElement('span');
      box.className = 'k-shape-text kdoc-content';
      const st = [`width:${t.w}px`, `height:${t.h}px`, `transform:matrix(${t.m.map((v) => Math.round(v * 1000) / 1000).join(',')})`];
      if (t.pad) st.push(`padding:${t.pad.map((v) => v + 'px').join(' ')}`);
      if (t.va === 'middle' || t.va === 'bottom') st.push(`justify-content:${t.va === 'middle' ? 'center' : 'flex-end'}`);
      box.setAttribute('style', st.join(';'));
      const inner = renderBlocks(node.type.schema, t.content || [], doc);
      inner.className = 'k-shape-text-in';
      box.appendChild(inner);
      wrap.appendChild(box);
    }
    if (withData) {
      wrap.setAttribute('data-shape', JSON.stringify(d));
      wrap.setAttribute('data-w', String(w));
      wrap.setAttribute('data-h', String(h));
    }
  }
  return wrap;
}

/** 한글의 그리기 개체 (선·사각형·타원·호·다각형·곡선·묶음). 그림처럼 글줄 안에 놓이거나(글자처럼 취급) 제자리에 뜬다 */
export const Shape = Node.create({
  name: 'shape',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    const plain = { default: null, rendered: false };
    return {
      width: { ...plain, parseHTML: (el: HTMLElement) => num(el.getAttribute('data-w')) || null },
      height: { ...plain, parseHTML: (el: HTMLElement) => num(el.getAttribute('data-h')) || null },
      /** 도형 값 (ShapeData) */
      d: {
        ...plain,
        parseHTML: (el: HTMLElement) => {
          try {
            return cleanShape(JSON.parse(el.getAttribute('data-shape') || 'null'));
          } catch {
            return null;
          }
        },
      },
      /** 떠 있는 자리 { x, y, behind? } (px, 문단 상자의 왼쪽 위 기준). 없으면 글줄 안에 놓인다 */
      float: { ...plain, parseHTML: () => null },
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-shape[data-shape]' }];
  },
  renderHTML({ node }) {
    if (typeof document === 'undefined') return ['span', { class: 'k-shape' }];
    return shapeElement(node, true) as any;
  },
  addNodeView() {
    return ({ node }) => ({ dom: shapeElement(node, false), ignoreMutation: () => true });
  },
  addCommands() {
    return {
      insertShape:
        (attrs) =>
        ({ chain }) =>
          chain().insertContent({ type: 'shape', attrs }).run(),
    };
  },
});
