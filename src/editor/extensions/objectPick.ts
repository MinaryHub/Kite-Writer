import { Extension } from '@tiptap/core';
import { NodeSelection, Plugin, PluginKey } from '@tiptap/pm/state';

/**
 * Alt+누르기: 그 자리의 떠 있는 그림·도형·글상자를 고른다 (글 뒤로 보낸 개체는 글에 가려 그냥 눌러서는 고를 수 없다)
 */
export const ObjectPick = Extension.create({
  name: 'objectPick',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('objectPick'),
        props: {
          handleDOMEvents: {
            mousedown: (view, e) => {
              // 오른쪽 단추: 골라 둔 개체 위에서 누르면 선택을 그대로 둔다 (글 뒤 개체에서 차림표가 글 자리로 옮기지 않게)
              if (e.button === 2) {
                const sel = view.state.selection;
                if (!(sel instanceof NodeSelection) || !/^(image|shape|textBox)$/.test(sel.node.type.name)) return false;
                const dom = view.nodeDOM(sel.from) as HTMLElement | null;
                const r = dom?.getBoundingClientRect?.();
                if (!r || e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return false;
                e.preventDefault();
                return true;
              }
              if (!e.altKey || e.button !== 0) return false;
              const els = document.elementsFromPoint(e.clientX, e.clientY);
              const hit = els.find((el) => view.dom.contains(el) && el.matches('.k-image, .k-shape, .k-textbox')) as HTMLElement | undefined;
              if (!hit) return false;
              let pos: number;
              try {
                pos = view.posAtDOM(hit, 0);
              } catch {
                return false;
              }
              // 글상자(문단을 가진 블록)는 안쪽 자리가 나오므로 감싼 노드까지 거슬러 오른다
              const $p = view.state.doc.resolve(pos);
              for (let d = $p.depth; d >= 0; d--) {
                const n = d === $p.depth ? view.state.doc.nodeAt(pos) : $p.node(d);
                const at = d === $p.depth ? pos : $p.before(d);
                if (n && /^(image|shape|textBox)$/.test(n.type.name)) {
                  e.preventDefault();
                  view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)));
                  view.focus();
                  return true;
                }
                if (d === 0) break;
              }
              return false;
            },
          },
        },
      }),
    ];
  },
});
