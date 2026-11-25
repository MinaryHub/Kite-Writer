import type { Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import { cleanBookmarkName } from '../editor/extensions/nodes';

/** 문서의 책갈피들 (문서 차례대로): 이름과 자리 */
export function listBookmarks(editor: Editor): { name: string; pos: number }[] {
  const out: { name: string; pos: number }[] = [];
  editor.state.doc.descendants((n, pos) => {
    if (n.type.name === 'bookmark') {
      const name = cleanBookmarkName(n.attrs.name);
      if (name) out.push({ name, pos });
    }
    return true;
  });
  return out;
}

/** 이름이 name 인 책갈피로 커서를 옮긴다. 없으면 false */
export function gotoBookmark(editor: Editor, name: string): boolean {
  const bm = listBookmarks(editor).find((b) => b.name === cleanBookmarkName(name));
  if (!bm) return false;
  const { state, view } = editor;
  view.dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(Math.min(state.doc.content.size, bm.pos + 1)))).scrollIntoView());
  view.focus();
  return true;
}

/** 커서 자리에 책갈피를 넣는다. 같은 이름이 있으면 그 책갈피를 지우고 여기로 옮긴다 (한글과 같게) */
export function insertBookmark(editor: Editor, name: string): boolean {
  const nm = cleanBookmarkName(name);
  if (!nm) return false;
  const old = listBookmarks(editor).filter((b) => b.name === nm);
  let tr = editor.state.tr;
  // 뒤에서부터 지운다 (앞 자리가 밀리지 않게)
  for (const b of [...old].reverse()) tr = tr.delete(b.pos, b.pos + 1);
  const at = tr.mapping.map(editor.state.selection.from);
  tr = tr.insert(at, editor.schema.nodes.bookmark.create({ name: nm }));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** 이름이 name 인 책갈피를 지운다 */
export function removeBookmark(editor: Editor, name: string): boolean {
  const old = listBookmarks(editor).filter((b) => b.name === cleanBookmarkName(name));
  if (!old.length) return false;
  let tr = editor.state.tr;
  for (const b of [...old].reverse()) tr = tr.delete(b.pos, b.pos + 1);
  editor.view.dispatch(tr);
  return true;
}
