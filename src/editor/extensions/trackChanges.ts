import { Extension, Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Fragment, Slice, type Mark as PMMark, type Node as PMNode, type Schema } from '@tiptap/pm/model';
import { ReplaceStep } from '@tiptap/pm/transform';

/**
 * 변경 내용 추적 (Word 의 "변경 내용 추적", 한글의 "변경 내용 기록").
 *  - 켜 두면 넣은 글자에는 '삽입' 표시, 지운 글자는 실제로 지우지 않고 '삭제' 표시를 단다.
 *  - 각 변경은 사람·시각을 가지고, 하나씩 또는 모두 받아들이거나(반영) 거부(되돌림)할 수 있다.
 *  - AI 가 고친 내용도 이 표시로 넣어 사람이 검토한 뒤 받아들이게 한다.
 *
 * 한글 입력(조합 중인 글자)을 깨지 않도록, 넣는 글자에는 입력 전에 '삽입' 표시를 미리 걸어 둔다
 * (입력한 뒤에 표시를 바꾸면 화면의 글자가 다시 그려져 조합이 끊긴다).
 */

export interface ChangeAttrs {
  id: string;
  author: string;
  time: number;
}

/** 이 트랜잭션은 추적하지 않는다 (받아들이기/거부, AI 제안 넣기 등) */
export const TRACK_SKIP = 'trackChanges:skip';

let seq = 0;
export const newChangeId = () => `c${Date.now().toString(36)}${(++seq).toString(36)}`;

/** 사람마다 다른 색 (이름에서 정한다) */
export function authorHue(name: string): number {
  let h = 0;
  for (const ch of name || '') h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 360;
}

const changeAttrs = {
  id: { default: null },
  author: { default: '' },
  time: { default: 0 },
  /** 문서가 정한 사람 색 (한글의 변경 추적 사용자 색). 없으면 이름으로 정한 색 */
  color: { default: null },
};

const HEX = /^#[0-9A-Fa-f]{6}$/;

const renderChange = (tag: string, cls: string) => (props: { HTMLAttributes: Record<string, any>; mark: any }) => {
  const a = props.mark.attrs as ChangeAttrs;
  const when = a.time ? new Date(a.time).toLocaleString('ko-KR') : '';
  return [
    tag,
    mergeAttributes({
      class: cls,
      'data-change-id': a.id,
      'data-author': a.author,
      'data-time': String(a.time || ''),
      title: `${cls === 'tc-ins' ? '넣음' : '지움'}: ${a.author || '알 수 없음'}${when ? ' · ' + when : ''}`,
      ...(typeof (a as any).color === 'string' && HEX.test((a as any).color) ? { 'data-color': (a as any).color } : {}),
      style: `--tc-hue: ${authorHue(a.author)}` + (typeof (a as any).color === 'string' && HEX.test((a as any).color) ? `; --tc-c: ${(a as any).color}` : ''),
    }),
    0,
  ] as any;
};

const parseChange = (el: HTMLElement) => ({
  id: el.getAttribute('data-change-id') || newChangeId(),
  author: el.getAttribute('data-author') || '',
  time: Number(el.getAttribute('data-time')) || 0,
  color: HEX.test(el.getAttribute('data-color') || '') ? el.getAttribute('data-color') : null,
});

export const Insertion = Mark.create({
  name: 'insertion',
  // 이어서 치는 글자도 같은 삽입으로
  inclusive: true,
  excludes: 'deletion',
  addAttributes: () => changeAttrs,
  parseHTML: () => [{ tag: 'ins[data-change-id]', getAttrs: (el) => parseChange(el as HTMLElement) }],
  renderHTML: renderChange('ins', 'tc-ins'),
});

export const Deletion = Mark.create({
  name: 'deletion',
  inclusive: false,
  excludes: 'insertion',
  addAttributes: () => changeAttrs,
  parseHTML: () => [{ tag: 'del[data-change-id]', getAttrs: (el) => parseChange(el as HTMLElement) }],
  renderHTML: renderChange('del', 'tc-del'),
});

// ---------------- 상태 ----------------
export interface TrackState {
  enabled: boolean;
  author: string;
}

export const trackKey = new PluginKey<TrackState>('trackChanges');

export function isTracking(state: EditorState): boolean {
  return !!trackKey.getState(state)?.enabled;
}

/** 슬라이스의 글자들에 표시를 더하거나 뺀다 */
function mapSliceText(frag: Fragment, fn: (node: PMNode) => PMNode | null): Fragment {
  const out: PMNode[] = [];
  frag.forEach((node) => {
    if (node.isText) {
      const n = fn(node);
      if (n) out.push(n);
    } else out.push(node.copy(mapSliceText(node.content, fn)));
  });
  return Fragment.from(out);
}

/** 이 조각에 글자가 있는가 */
function hasText(frag: Fragment): boolean {
  let found = false;
  frag.descendants((n) => {
    if (n.isText && n.text) found = true;
    return !found;
  });
  return found;
}

/**
 * 추적: 방금 일어난 변경을 '삽입/삭제 표시' 로 바꾸는 트랜잭션을 만든다.
 * 넣은 글자에는 삽입 표시를, 지운 글자는 삭제 표시를 단 채로 제자리에 되돌려 놓는다.
 */
function trackTransaction(tr: Transaction, oldState: EditorState, newState: EditorState, author: string): Transaction | null {
  const schema: Schema = newState.schema;
  const insType = schema.marks.insertion;
  const delType = schema.marks.deletion;
  const out = newState.tr;
  let changed = false;
  const time = Date.now();
  const id = newChangeId();
  const insMark = insType.create({ id, author, time });
  let cursor: number | null = null;
  // 원래 커서가 지운 범위의 끝에 있었으면(Backspace) 되돌린 글자 앞에, 앞에 있었으면(Delete) 뒤에 둔다
  const oldHead = oldState.selection.head;

  tr.steps.forEach((step, i) => {
    if (!(step instanceof ReplaceStep)) return;
    const before = tr.docs[i];
    const { from, to } = step as any;
    const slice: Slice = (step as any).slice;
    // 이 단계 뒤의 위치 → 최종 문서 위치 → 우리 트랜잭션 위치
    const rest = tr.mapping.slice(i + 1);
    const toOut = (pos: number, assoc: number) => out.mapping.map(rest.map(pos, assoc), assoc);

    // 1) 넣은 글자: 삽입 표시 (이미 같은 사람의 삽입 표시가 있으면 건드리지 않는다)
    if (slice.size) {
      const a = toOut(from, 1);
      const b = toOut(from + slice.size, -1);
      if (b > a) {
        let need = false;
        out.doc.nodesBetween(a, b, (n) => {
          if (n.isText && (!insType.isInSet(n.marks) || delType.isInSet(n.marks))) need = true;
        });
        if (need) {
          out.removeMark(a, b, delType);
          out.addMark(a, b, insMark);
          changed = true;
        }
      }
    }

    // 2) 지운 글자: 삭제 표시를 달아 제자리에 되돌린다
    if (to > from) {
      const del = before.slice(from, to);
      // 내가(같은 사람이) 넣은 글자를 지운 것은 정말로 지운다 (아직 제안 중이던 내용)
      const content = mapSliceText(del.content, (n) => {
        const ins = insType.isInSet(n.marks);
        if (ins && ins.attrs.author === author) return null;
        if (delType.isInSet(n.marks)) return n;
        return n.mark(delType.create({ id, author, time }).addToSet(n.marks.filter((m) => m.type !== insType)));
      });
      if (hasText(content)) {
        const at = toOut(from, -1);
        const restored = new Slice(content, del.openStart, del.openEnd);
        try {
          out.replace(at, at, restored);
          changed = true;
          const len = out.mapping.maps[out.mapping.maps.length - 1];
          let end = at;
          len.forEach((_os, _oe, _ns, ne) => (end = ne));
          if (oldHead === to || (oldHead > from && oldHead <= to)) cursor = at;
          else cursor = end;
        } catch {
          /* 구조가 맞지 않으면 되돌리지 않는다 (지운 대로) */
        }
      }
    }
  });
  if (!changed) return null;
  if (cursor != null && tr.selection.empty) {
    try {
      out.setSelection(TextSelection.create(out.doc, cursor));
    } catch {
      /* 무시 */
    }
  }
  // 앞으로 칠 글자도 삽입 표시로
  out.setStoredMarks(null);
  out.setMeta(TRACK_SKIP, true);
  return out;
}

/** 추적을 끈 채 입력한 글자가 앞뒤 표시(삽입)를 물려받지 않게 지운다 */
function untrackTransaction(tr: Transaction, newState: EditorState): Transaction | null {
  const insType = newState.schema.marks.insertion;
  const delType = newState.schema.marks.deletion;
  const out = newState.tr;
  let changed = false;
  tr.steps.forEach((step, i) => {
    if (!(step instanceof ReplaceStep)) return;
    const slice: Slice = (step as any).slice;
    if (!slice.size) return;
    // 붙여넣기 등으로 들어온 표시는 그대로 둔다 (원래 문서에 있던 변경)
    if (tr.getMeta('paste') || tr.getMeta('uiEvent') === 'paste') return;
    const rest = tr.mapping.slice(i + 1);
    const a = rest.map((step as any).from, 1);
    const b = rest.map((step as any).from + slice.size, -1);
    if (b <= a) return;
    let has = false;
    newState.doc.nodesBetween(a, b, (n) => {
      if (n.isText && (insType.isInSet(n.marks) || delType.isInSet(n.marks))) has = true;
    });
    // 입력한 글자 한두 개만 (문서 조각을 통째로 옮기는 것은 건드리지 않는다)
    if (has && b - a <= 4 && slice.content.childCount === 1 && slice.content.firstChild?.isText) {
      out.removeMark(a, b, insType);
      out.removeMark(a, b, delType);
      changed = true;
    }
  });
  if (!changed) return null;
  out.setMeta(TRACK_SKIP, true);
  out.setMeta('addToHistory', true);
  return out;
}

export const TrackChanges = Extension.create<{ author: string }>({
  name: 'trackChanges',
  addOptions: () => ({ author: '사용자' }),
  addProseMirrorPlugins() {
    const ext = this;
    return [
      new Plugin<TrackState>({
        key: trackKey,
        state: {
          init: () => ({ enabled: false, author: ext.options.author }),
          apply(tr, v) {
            const meta = tr.getMeta(trackKey) as Partial<TrackState> | undefined;
            return meta ? { ...v, ...meta } : v;
          },
        },
        appendTransaction(trs, oldState, newState) {
          const st = trackKey.getState(newState)!;
          for (const tr of trs) {
            if (!tr.docChanged || tr.getMeta(TRACK_SKIP) || tr.getMeta('history$')) continue;
            // 협업·불러오기 등 문서를 통째로 바꾸는 것은 추적하지 않는다
            if (tr.getMeta('preventUpdate') || tr.getMeta('y-sync$')) continue;
            const r = st.enabled ? trackTransaction(tr, oldState, newState, st.author) : untrackTransaction(tr, newState);
            if (r) return r;
          }
          return syncStoredMarks(newState, st);
        },
      }),
    ];
  },
});

/**
 * 다음에 칠 글자의 표시를 미리 맞춘다: 추적 중이면 '삽입' 을 걸고, 아니면 앞뒤의 삽입·삭제 표시를 물려받지 않게 뺀다.
 * (입력한 뒤에 표시를 바꾸면 한글 조합 중인 글자가 다시 그려져 조합이 끊긴다)
 */
function syncStoredMarks(state: EditorState, st: TrackState): Transaction | null {
  const sel = state.selection;
  if (!sel.empty || !(sel instanceof TextSelection)) return null;
  const insType = state.schema.marks.insertion;
  const delType = state.schema.marks.deletion;
  if (!insType || !sel.$from.parent.inlineContent) return null;
  const marks = state.storedMarks || sel.$from.marks();
  const ins = insType.isInSet(marks);
  let next: readonly PMMark[] | null = null;
  if (st.enabled) {
    if (!ins || ins.attrs.author !== st.author || delType.isInSet(marks)) next = insType.create({ id: newChangeId(), author: st.author, time: Date.now() }).addToSet(marks.filter((m) => m.type !== delType && m.type !== insType));
  } else if (ins || delType.isInSet(marks)) next = marks.filter((m) => m.type !== insType && m.type !== delType);
  if (!next) return null;
  return state.tr.setStoredMarks(next as PMMark[]).setMeta(TRACK_SKIP, true).setMeta('addToHistory', false);
}

// ---------------- 변경 목록 · 받아들이기/거부 ----------------
export interface ChangeItem {
  id: string;
  /** 이 묶음에 든 변경 id 들 (같은 사람이 이어서 고친 것은 한 묶음) */
  ids: string[];
  type: 'insertion' | 'deletion';
  author: string;
  time: number;
  from: number;
  to: number;
  text: string;
}

/** 문서의 변경들: 같은 사람이 같은 종류로 이어서 고친 범위(10분 안)는 한 묶음으로 */
export function listChanges(doc: PMNode): ChangeItem[] {
  const out: ChangeItem[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if (m.type.name !== 'insertion' && m.type.name !== 'deletion') continue;
      const last = out[out.length - 1];
      const a = m.attrs as ChangeAttrs;
      if (last && last.type === m.type.name && last.author === a.author && last.to === pos && (last.ids.includes(a.id) || Math.abs(a.time - last.time) < 600000)) {
        last.to = pos + node.nodeSize;
        last.text += node.text;
        if (!last.ids.includes(a.id)) last.ids.push(a.id);
      } else out.push({ id: a.id, ids: [a.id], type: m.type.name as any, author: a.author, time: a.time, from: pos, to: pos + node.nodeSize, text: node.text || '' });
    }
    return false;
  });
  return out;
}

/** 변경들을 받아들이거나 거부하는 트랜잭션 (추적하지 않음) */
export function resolveChanges(state: EditorState, accept: boolean, filter?: (c: ChangeItem) => boolean, range?: { from: number; to: number }): Transaction | null {
  const list = listChanges(state.doc).filter((c) => (!filter || filter(c)) && (!range || (c.from < range.to && c.to > range.from)));
  if (!list.length) return null;
  const tr = state.tr;
  const insType = state.schema.marks.insertion;
  const delType = state.schema.marks.deletion;
  // 뒤에서부터 (앞의 위치가 바뀌지 않게)
  for (const c of [...list].sort((a, b) => b.from - a.from)) {
    const from = range ? Math.max(c.from, range.from) : c.from;
    const to = range ? Math.min(c.to, range.to) : c.to;
    const removeText = (c.type === 'insertion') !== accept; // 거부한 삽입, 받아들인 삭제는 글자를 지운다
    if (removeText) {
      // 해당 표시가 달린 글자만 지운다
      const pieces: [number, number][] = [];
      tr.doc.nodesBetween(from, to, (n, pos) => {
        if (!n.isText) return true;
        const m = (c.type === 'insertion' ? insType : delType).isInSet(n.marks);
        if (m && c.ids.includes(m.attrs.id)) pieces.push([Math.max(pos, from), Math.min(pos + n.nodeSize, to)]);
        return false;
      });
      for (const [a, b] of pieces.reverse()) tr.delete(a, b);
    } else {
      const type = c.type === 'insertion' ? insType : delType;
      tr.doc.nodesBetween(from, to, (n, pos) => {
        if (!n.isText) return true;
        const m = type.isInSet(n.marks);
        if (m && c.ids.includes(m.attrs.id)) tr.removeMark(Math.max(pos, from), Math.min(pos + n.nodeSize, to), m);
        return false;
      });
    }
  }
  tr.setMeta(TRACK_SKIP, true);
  return tr;
}

/**
 * 제안 넣기: from..to 를 지움 표시로 두고 그 뒤에 새 내용을 넣음 표시로 넣는다 (AI 교정 등).
 * @returns 넣은 내용의 범위
 */
export function suggestReplace(state: EditorState, from: number, to: number, content: Fragment | PMNode | string, author: string): Transaction {
  const schema = state.schema;
  const time = Date.now();
  const id = newChangeId();
  const tr = state.tr;
  const delMark = schema.marks.deletion.create({ id, author, time });
  const insMark = schema.marks.insertion.create({ id, author, time });
  if (to > from) {
    tr.doc.nodesBetween(from, to, (n, pos) => {
      if (!n.isText) return true;
      const a = Math.max(pos, from);
      const b = Math.min(pos + n.nodeSize, to);
      // 이미 누군가 넣은 제안이면 그것은 지운다
      if (schema.marks.insertion.isInSet(n.marks)) return false;
      tr.addMark(a, b, delMark);
      return false;
    });
    // 넣은 제안 글자는 실제로 지운다 (위 루프에서 표시하지 않은 것)
    const kill: [number, number][] = [];
    tr.doc.nodesBetween(from, to, (n, pos) => {
      if (n.isText && schema.marks.insertion.isInSet(n.marks)) kill.push([Math.max(pos, from), Math.min(pos + n.nodeSize, to)]);
      return !n.isText;
    });
    for (const [a, b] of kill.reverse()) tr.delete(a, b);
  }
  const at = tr.mapping.map(to, 1);
  const marks = state.doc.resolve(from).marks().filter((m) => m.type.name !== 'deletion' && m.type.name !== 'insertion');
  let frag: Fragment;
  if (typeof content === 'string') frag = content ? Fragment.from(schema.text(content, [...marks, insMark])) : Fragment.empty;
  else frag = mapSliceText(content instanceof Fragment ? content : Fragment.from(content), (n) => n.mark(insMark.addToSet(n.marks)));
  if (frag.size) tr.insert(at, frag);
  tr.setMeta(TRACK_SKIP, true);
  return tr;
}

export { acceptAllJson, hasReviewMarks } from '../../formats/review';
