import { Mark, mergeAttributes, getMarkRange } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state';
import type { Node as PMNode, MarkType } from '@tiptap/pm/model';

/**
 * 누름틀 (한글의 입력 칸): 서식 문서에서 "여기에 입력하세요" 처럼 안내문을 보이다가, 누르면 안내문이 통째로 골라져
 * 치는 글로 바뀐다. 글에 다는 표시(mark)로 둔다.
 *  - guide: 안내문 (비었을 때 보이는 글), memo: 도움말(메모), name: 필드 이름
 *  - empty: 지금 글이 안내문 자리 표시인가 (저장할 때 글을 쓰지 않는다)
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    clickHere: {
      /** 커서 자리에 빈 누름틀(안내문)을 넣거나, 고른 글을 누름틀로 만든다 */
      insertClickHere: (attrs: { guide: string; memo?: string; name?: string }) => ReturnType;
      /** 커서가 든 누름틀의 안내문·메모·이름을 바꾼다 */
      updateClickHere: (attrs: { guide: string; memo?: string; name?: string }) => ReturnType;
      /** 커서가 든 누름틀을 없앤다 (입력한 글은 남기고, 비어 있으면 안내문도 지운다) */
      removeClickHere: () => ReturnType;
    };
  }
}

const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');

export const ClickHere = Mark.create({
  name: 'clickHere',
  // 누름틀 끝에서 이어 치는 글도 누름틀 안 (한글과 같게)
  inclusive: true,
  addAttributes() {
    return {
      guide: { default: '', parseHTML: (el: HTMLElement) => str(el.getAttribute('data-guide')), renderHTML: (a: Record<string, any>) => ({ 'data-guide': str(a.guide) }) },
      memo: { default: '', parseHTML: (el: HTMLElement) => str(el.getAttribute('data-memo')), renderHTML: (a: Record<string, any>) => (a.memo ? { title: str(a.memo), 'data-memo': str(a.memo) } : {}) },
      name: { default: '', parseHTML: (el: HTMLElement) => str(el.getAttribute('data-name'), 100), renderHTML: (a: Record<string, any>) => (a.name ? { 'data-name': str(a.name, 100) } : {}) },
      empty: { default: false, parseHTML: (el: HTMLElement) => el.hasAttribute('data-empty'), renderHTML: (a: Record<string, any>) => (a.empty ? { 'data-empty': '' } : {}) },
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-field[data-guide]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-field' }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      insertClickHere:
        (attrs) =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.marks.clickHere;
          const a = { guide: str(attrs.guide) || '이곳을 눌러 내용을 입력하세요.', memo: str(attrs.memo), name: str(attrs.name, 100) };
          const { from, to, empty } = state.selection;
          if (!dispatch) return true;
          if (!empty) {
            tr.addMark(from, to, type.create({ ...a, empty: false }));
          } else {
            const marks = state.selection.$from.marks().filter((m) => m.type !== type);
            tr.insert(from, state.schema.text(a.guide, [...marks, type.create({ ...a, empty: true })]));
            tr.setSelection(TextSelection.create(tr.doc, from, from + a.guide.length));
          }
          dispatch(tr);
          return true;
        },
      updateClickHere:
        (attrs) =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.marks.clickHere;
          const r = fieldRange(state.doc, state.selection.from, type);
          if (!r) return false;
          if (!dispatch) return true;
          const a = { guide: str(attrs.guide) || r.mark.attrs.guide, memo: str(attrs.memo), name: str(attrs.name, 100) };
          if (r.mark.attrs.empty) {
            // 비어 있는 누름틀: 보이는 안내문도 새 것으로
            const marks = state.doc.resolve(r.from + 1).marks().filter((m) => m.type !== type);
            tr.replaceWith(r.from, r.to, state.schema.text(a.guide, [...marks, type.create({ ...a, empty: true })]));
          } else {
            tr.removeMark(r.from, r.to, type);
            tr.addMark(r.from, r.to, type.create({ ...a, empty: false }));
          }
          dispatch(tr);
          return true;
        },
      removeClickHere:
        () =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.marks.clickHere;
          const r = fieldRange(state.doc, state.selection.from, type);
          if (!r) return false;
          if (!dispatch) return true;
          if (r.mark.attrs.empty) tr.delete(r.from, r.to);
          else tr.removeMark(r.from, r.to, type);
          dispatch(tr);
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    const type = () => this.editor.schema.marks.clickHere;
    return [
      new Plugin({
        key: new PluginKey('clickHere'),
        props: {
          // 빈 누름틀(안내문)을 누르면 안내문을 통째로 고른다
          handleClick: (view, pos) => {
            const t = type();
            if (!t) return false;
            const r = fieldRange(view.state.doc, pos, t);
            if (!r || !r.mark.attrs.empty) return false;
            view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, r.from, r.to)));
            return true;
          },
          // 빈 누름틀(안내문)의 앞·뒤 끝에서 치는 글은 누름틀 밖에 넣는다 (안내문에 붙어 안내문이 내용이 되지 않게)
          handleTextInput: (view, from, to, text) => {
            const t = type();
            if (!t || from !== to) return false;
            const r = fieldRange(view.state.doc, from, t);
            if (!r || !r.mark.attrs.empty || (from !== r.from && from !== r.to)) return false;
            const marks = view.state.doc.resolve(from).marks().filter((m) => m.type !== t);
            view.dispatch(view.state.tr.insert(from, view.state.schema.text(text, marks)).scrollIntoView());
            return true;
          },
        },
        appendTransaction: (trs, _old, state) => {
          const t = type();
          if (!t) return null;
          let tr = null as ReturnType<typeof state.tr.setMeta> | null;
          // 1) 안내문 자리 표시에 글을 치면 '입력됨' 으로 (안내문과 다른 글이 되었을 때)
          if (trs.some((x) => x.docChanged)) {
            const fix: { from: number; to: number; attrs: Record<string, unknown> }[] = [];
            state.doc.descendants((n, pos) => {
              if (!n.isText) return true;
              const m = n.marks.find((k) => k.type === t && k.attrs.empty);
              if (!m) return false;
              const r = fieldRange(state.doc, pos + 1, t);
              if (r && state.doc.textBetween(r.from, r.to) !== m.attrs.guide) fix.push({ from: r.from, to: r.to, attrs: { ...m.attrs, empty: false } });
              return false;
            });
            if (fix.length) {
              tr = state.tr;
              for (const f of fix) {
                tr.removeMark(f.from, f.to, t);
                tr.addMark(f.from, f.to, t.create(f.attrs));
              }
            }
          }
          // 2) 빈 누름틀 안(안내문 글자 사이)에 커서가 들어오면 안내문을 통째로 고른다 (치면 안내문이 바뀐다)
          const sel = (tr || state).selection;
          if (sel.empty && trs.some((x) => x.selectionSet)) {
            const doc = (tr || state).doc;
            const r = fieldRange(doc, sel.from, t);
            if (r && r.mark.attrs.empty && r.from < sel.from && sel.from < r.to) {
              tr = tr || state.tr;
              tr.setSelection(TextSelection.create(doc, r.from, r.to));
            }
          }
          return tr;
        },
      }),
    ];
  },
});

/** pos 자리(앞 글자 또는 뒤 글자)의 누름틀 범위 */
export function fieldRange(doc: PMNode, pos: number, type: MarkType): { from: number; to: number; mark: import('@tiptap/pm/model').Mark } | null {
  const $p = doc.resolve(Math.max(0, Math.min(doc.content.size, pos)));
  const cand = [$p.nodeAfter, $p.nodeBefore];
  for (const n of cand) {
    const m = n?.marks.find((k) => k.type === type);
    if (!m) continue;
    const r = getMarkRange($p, type, m.attrs);
    if (r) return { ...r, mark: m };
  }
  return null;
}
