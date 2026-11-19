import type { Node as PMNode } from '@tiptap/pm/model';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * 아주 긴 문서(최상위 블록 수만 개)에서 ProseMirror 꾸밈(decoration)이 블록 수의 제곱만큼 느려지는 두 곳을 고친다.
 * 결과는 ProseMirror 가 만드는 것과 같다 (같은 모양의 꾸밈 묶음, 같은 forChild 결과).
 *
 * 1) DecorationSet.create(doc, decos): 최상위 블록마다 꾸밈 목록 전체를 훑는다(takeSpansForNode) → decorationSet()
 * 2) DecorationSet#forChild: 그리기·갱신 때 블록마다 하위 묶음 목록과 최상위 꾸밈 목록을 처음부터 훑는다 → 이분 탐색
 *
 * 16만 블록 문서(같은 그림이 쪽마다 든 1만 6천 쪽)는 이 둘 때문에 여는 데 수십 분이 걸렸다.
 */

type Ctor = new (local: Decoration[], children: (number | DecorationSet)[]) => DecorationSet;
const byPos = (a: Decoration, b: Decoration) => a.from - b.from || a.to - b.to;

/** DecorationSet.create 와 같은 꾸밈 묶음을 블록 수에 비례하는 시간에 만든다 */
export function decorationSet(doc: PMNode, decos: Decoration[]): DecorationSet {
  if (!decos.length) return DecorationSet.empty;
  const d0 = decos[0] as any;
  // 작은 문서이거나 ProseMirror 내부가 다르면(copy·type.valid 가 없으면) 원래 방법으로
  if (decos.length < 1000 || doc.childCount < 100 || typeof d0.copy !== 'function' || typeof d0.type?.valid !== 'function') return DecorationSet.create(doc, decos);
  const sorted = decos.slice().sort(byPos);
  const locals: Decoration[] = [];
  const children: (number | DecorationSet)[] = [];
  /** 최상위 블록의 시작 → 끝 (블록 꾸밈의 유효성 검사: ProseMirror 의 findIndex 는 블록 수만큼 훑는다) */
  const ends = new Map<number, number>();
  const n = sorted.length;
  let i = 0;
  doc.forEach((child, offset) => {
    const end = offset + child.nodeSize;
    if (!child.isText) ends.set(offset, end);
    // 이 블록보다 앞(또는 블록 경계)에서 시작한 것은 어느 블록에도 들지 않는다: 최상위
    while (i < n && sorted[i].from <= offset) locals.push(sorted[i++]);
    if (child.isLeaf) return;
    // 블록 안에서 시작한 것 가운데 블록 안에서 끝나는 것만 이 블록의 것 (ProseMirror 의 takeSpansForNode 와 같은 조건)
    let inside: Decoration[] | null = null;
    const base = offset + 1;
    while (i < n && sorted[i].from < end) {
      const d = sorted[i++];
      if (d.to < end) (inside || (inside = [])).push((d as any).copy(d.from - base, d.to - base));
      else locals.push(d);
    }
    if (inside) {
      const sub = DecorationSet.create(child, inside);
      if (sub !== DecorationSet.empty) children.push(offset, end, sub);
    }
  });
  while (i < n) locals.push(sorted[i++]);
  locals.sort(byPos);
  // ProseMirror 의 유효성과 같다: 위젯은 늘, 줄 안 꾸밈은 길이가 있을 때, 블록 꾸밈은 그 자리의 블록을 꼭 덮을 때
  const valid = locals.filter((d) => {
    const x = d as any;
    if (x.widget === true) return true;
    if (x.inline === true) return d.from < d.to;
    if (x.widget === false && x.inline === false) return ends.get(d.from) === d.to;
    return x.type.valid(doc, d);
  });
  return valid.length || children.length ? new (DecorationSet as unknown as Ctor)(valid, children) : DecorationSet.empty;
}

let installed = false;
const inlineLocals = new WeakMap<object, Decoration[]>();

/** DecorationSet#forChild 를 이분 탐색으로 (한 번만) */
export function installFastForChild() {
  if (installed) return;
  installed = true;
  const proto = DecorationSet.prototype as any;
  const orig = proto.forChild;
  if (typeof orig !== 'function') return;
  proto.forChild = function (this: any, offset: number, node: PMNode) {
    const empty = DecorationSet.empty;
    if (this === empty) return this;
    if (node.isLeaf) return empty;
    const ch = this.children;
    const local = this.local;
    // 내부 모양이 다르면 원래 것으로
    if (!Array.isArray(ch) || !Array.isArray(local)) return orig.call(this, offset, node);
    // 하위 묶음: [시작, 끝, 묶음, …] 이 시작 순으로 놓여 있다
    let lo = 0;
    let hi = ch.length / 3;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ch[mid * 3] < offset) lo = mid + 1;
      else hi = mid;
    }
    const child = lo * 3 < ch.length && ch[lo * 3] === offset ? ch[lo * 3 + 2] : undefined;
    // 이 블록에 걸친 줄 안 꾸밈(inline)이 있을 때만 원래 셈으로 (보통 최상위에는 없다)
    let inl = inlineLocals.get(this);
    if (!inl) {
      inl = local.filter((d: Decoration) => (d as any).inline === true);
      inlineLocals.set(this, inl);
    }
    if (inl.length) {
      const start = offset + 1;
      const end = start + node.content.size;
      for (const d of inl) if (d.from < end && d.to > start) return orig.call(this, offset, node);
    }
    return child || empty;
  };
}
