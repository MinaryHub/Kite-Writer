import type { Node as PMNode, Mark as PMMark } from '@tiptap/pm/model';
import type { DocTab } from '../doc/docTab';
import { XREF_BOOKMARK, crossRefCommand, parseCrossRef, type CrossRef } from '../formats/crossRef';
import { cleanBookmarkName } from '../editor/extensions/nodes';
import { listBookmarks } from './bookmarks';
import { pageNumAt, printPlans } from '../print';

/** 문서 자리 pos 가 든 쪽 (0부터): 쪽 나누기가 적어 둔 쪽마다의 시작 자리로 */
function pageOfPos(tab: DocTab, pos: number): number {
  const starts = tab.layout.pageStarts?.length ? tab.layout.pageStarts : [0];
  let k = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= pos) k = i;
  return k;
}

/**
 * 상호 참조의 결과 글. 책갈피만 셈한다: 쪽 번호(그 쪽에 찍히는 번호), 이름, 위/아래(상호 참조 자리에서 본 책갈피의 자리).
 * 대상이 없으면 한글처럼 '?'. 셈할 수 없는 종류(표·그림 번호, 내용)는 null — 적힌 글을 그대로 둔다
 */
export function crossRefResult(tab: DocTab, r: CrossRef, at: number): string | null {
  if (r.type !== XREF_BOOKMARK) return null;
  const bm = listBookmarks(tab.editor).find((b) => b.name === cleanBookmarkName(r.target));
  if (!bm) return '?';
  if (r.content === 0) {
    const k = pageOfPos(tab, bm.pos);
    const plan = printPlans(tab)[k];
    return String(plan ? pageNumAt(plan.settings, k) : k + 1);
  }
  if (r.content === 1) return bm.name;
  if (r.content === 3) return bm.pos < at ? '위' : '아래';
  return null;
}

/** 문서의 상호 참조 글 덩어리들 (같은 명령 글이 이어진 글 조각을 하나로) */
function crossRefRanges(doc: PMNode): { from: number; to: number; cmd: string; marks: readonly PMMark[] }[] {
  const out: { from: number; to: number; cmd: string; marks: readonly PMMark[] }[] = [];
  doc.descendants((n, pos) => {
    if (!n.isText) return true;
    const m = n.marks.find((x) => x.type.name === 'crossRef');
    if (!m) return false;
    const cmd = String(m.attrs.cmd || '');
    const last = out[out.length - 1];
    if (last && last.to === pos && last.cmd === cmd) last.to = pos + n.nodeSize;
    else out.push({ from: pos, to: pos + n.nodeSize, cmd, marks: n.marks });
    return false;
  });
  return out;
}

/** 모든 상호 참조의 결과 글을 다시 셈해 바꾼다. 바꾼 개수 */
export function updateCrossRefs(tab: DocTab): number {
  const { state, view } = tab.editor;
  const ranges = crossRefRanges(state.doc);
  let tr = state.tr;
  let n = 0;
  // 뒤에서부터 (앞 자리가 밀리지 않게)
  for (const g of [...ranges].reverse()) {
    const r = parseCrossRef(g.cmd);
    if (!r) continue;
    const text = crossRefResult(tab, r, g.from);
    if (text == null || text === state.doc.textBetween(g.from, g.to)) continue;
    tr = tr.replaceWith(g.from, g.to, state.schema.text(text, g.marks));
    n++;
  }
  if (n) view.dispatch(tr);
  return n;
}

/** 커서 자리에 책갈피를 가리키는 상호 참조를 넣는다 (content: 0 쪽 번호, 1 이름, 3 위/아래) */
export function insertCrossRef(tab: DocTab, target: string, content: number, link: boolean): boolean {
  const name = cleanBookmarkName(target);
  if (!name) return false;
  const cmd = crossRefCommand(name, content, link);
  const r = parseCrossRef(cmd)!;
  const { state, view } = tab.editor;
  const at = state.selection.from;
  const text = crossRefResult(tab, r, at) || '?';
  const marks = state.selection.$from.marks().filter((m) => m.type.name !== 'crossRef' && m.type.name !== 'clickHere');
  const tr = state.tr.replaceSelectionWith(state.schema.text(text, [...marks, state.schema.marks.crossRef.create({ cmd })]), false);
  view.dispatch(tr.scrollIntoView());
  view.focus();
  return true;
}

/** 커서가 든 상호 참조 (없으면 null) */
export function crossRefAtCursor(tab: DocTab): CrossRef | null {
  const { $from } = tab.editor.state.selection;
  const m = [...$from.marks(), ...($from.nodeAfter?.marks || [])].find((x) => x.type.name === 'crossRef');
  return m ? parseCrossRef(m.attrs.cmd) : null;
}
