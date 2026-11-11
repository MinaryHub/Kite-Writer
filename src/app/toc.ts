import type { Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import type { DocTab } from '../doc/docTab';
import { pageNumAt } from '../print';
import { LEADER_DOTS, TAB_TYPE_RIGHT } from '../editor/extensions/tabFill';
import { formatPageNumber } from '../formats/common';

/**
 * 차례 만들기 (한글의 '차례 만들기'): 제목 문단(제목 1~ 스타일, 한글의 개요 문단)을 모아
 * "제목 ··········· 쪽" 문단들을 넣는다. 제목과 쪽 번호 사이는 오른쪽 맞춤 점선 채움 탭이다 (tabFill 이 폭을 맞춘다).
 */

export interface TocHeading {
  pos: number;
  level: number;
  text: string;
}

/** 차례에 넣을 제목들 (표 안·차례 문단은 뺀다) */
export function collectHeadings(doc: PMNode, maxLevel: number): TocHeading[] {
  const out: TocHeading[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === 'table' || n.type.name === 'textBox') return false;
    if (!n.isTextblock) return true;
    if (n.attrs?.toc) return false;
    const level = n.type.name === 'heading' ? +n.attrs.level : +n.attrs?.outlineLevel || 0;
    if (level >= 1 && level <= maxLevel) {
      const text = n.textContent.replace(/[\t ]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (text) out.push({ pos, level, text });
    }
    return false;
  });
  return out;
}

/** 문서 위치가 놓인 쪽(0부터) */
function pageIndexOf(tab: DocTab, pos: number): number {
  const starts = tab.layout.pageStarts || [0];
  let k = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= pos) k = i;
  return k;
}

/** 제목이 놓인 쪽 번호 글자 */
function pageLabel(tab: DocTab, pos: number): string {
  const s = tab.settings;
  const n = pageNumAt(s, pageIndexOf(tab, pos));
  return formatPageNumber(n, s.pageNumber.format === 'dash' ? 'digit' : s.pageNumber.format);
}

/** 차례 문단들 (JSON) */
function tocNodes(tab: DocTab, heads: TocHeading[], withTitle: boolean) {
  const nodes: any[] = [];
  if (withTitle) nodes.push({ type: 'paragraph', attrs: { toc: 'title', textAlign: 'center', fontSize: 16, spaceAfter: 10 }, content: [{ type: 'text', text: '차  례', marks: [{ type: 'bold' }, { type: 'textStyle', attrs: { fontSize: 16 } }] }] });
  const minLevel = Math.min(...heads.map((h) => h.level));
  for (const h of heads) {
    const depth = h.level - minLevel;
    const bold = depth === 0 ? [{ type: 'bold' }] : [];
    nodes.push({
      type: 'paragraph',
      attrs: { toc: 'entry', textAlign: 'left', indentLeft: depth * 10 || null, spaceBefore: depth === 0 && nodes.length > (withTitle ? 1 : 0) ? 4 : null },
      content: [
        { type: 'text', text: h.text, marks: bold },
        { type: 'text', text: '\t', marks: [...bold, { type: 'tab', attrs: { right: true, leader: LEADER_DOTS, type: TAB_TYPE_RIGHT, width: null } }] },
        { type: 'text', text: pageLabel(tab, h.pos), marks: bold },
      ],
    });
  }
  return nodes;
}

/** 문서의 차례 문단 범위들 (이어진 차례 문단 묶음마다 [시작, 끝]) */
function tocRanges(doc: PMNode): [number, number][] {
  const out: [number, number][] = [];
  let cur: [number, number] | null = null;
  doc.forEach((n, pos) => {
    if (n.attrs?.toc) {
      if (cur && cur[1] === pos) cur[1] = pos + n.nodeSize;
      else out.push((cur = [pos, pos + n.nodeSize]));
    } else cur = null;
  });
  return out;
}

/** 쪽 나누기가 다시 돌 때까지 기다린다 (차례가 들어가며 제목들의 쪽이 바뀐다) */
function waitLayout(tab: DocTab, ms = 1500): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    let t: any = null;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      off();
      // 한 번 더 바뀔 수 있다: 잠깐 더 기다린다
      setTimeout(resolve, 150);
    };
    const off = tab.subscribe(finish);
    t = setTimeout(finish, ms);
  });
}

/** 차례 항목의 쪽 번호만 다시 맞춘다 (제목 수가 그대로일 때). 바뀐 것이 있으면 true */
function refreshPageNumbers(tab: DocTab, maxLevel: number): boolean {
  const view = tab.editor.view;
  const heads = collectHeadings(view.state.doc, maxLevel);
  const entries: { pos: number; node: PMNode }[] = [];
  view.state.doc.forEach((n, pos) => {
    if (n.attrs?.toc === 'entry') entries.push({ pos, node: n });
  });
  if (entries.length !== heads.length) return false;
  const tr = view.state.tr;
  let changed = false;
  // 뒤에서부터 고쳐 위치가 밀리지 않게
  for (let i = entries.length - 1; i >= 0; i--) {
    const { pos, node } = entries[i];
    const label = pageLabel(tab, heads[i].pos);
    // 마지막 탭 뒤의 글이 쪽 번호
    let tabEnd = -1;
    node.forEach((c, off) => {
      if (c.isText && c.marks.some((m) => m.type.name === 'tab')) tabEnd = off + (c.text || '').length;
    });
    if (tabEnd < 0) continue;
    const from = pos + 1 + tabEnd;
    const to = pos + 1 + node.content.size;
    if (node.textBetween(tabEnd, node.content.size) === label) continue;
    const marks = node.childAfter(tabEnd).node?.marks || node.lastChild?.marks.filter((m) => m.type.name !== 'tab') || [];
    tr.replaceWith(from, to, view.state.schema.text(label, marks));
    changed = true;
  }
  if (changed) view.dispatch(tr.setMeta('addToHistory', false));
  return changed;
}

/** 쪽 번호가 더 바뀌지 않을 때까지 몇 번 맞춘다 */
async function settlePages(tab: DocTab, maxLevel: number) {
  for (let i = 0; i < 4; i++) {
    await waitLayout(tab);
    if (tab.editor.isDestroyed || !refreshPageNumbers(tab, maxLevel)) break;
  }
}

/** 차례 만들기: 커서 자리에 차례를 넣는다. 제목이 없으면 false */
export async function insertToc(tab: DocTab, maxLevel = 3): Promise<boolean> {
  const view = tab.editor.view;
  const heads = collectHeadings(view.state.doc, maxLevel);
  if (!heads.length) return false;
  const { $from } = view.state.selection;
  // 커서가 있는 최상위 블록 자리에 (빈 문단이면 그 문단을 바꾸고, 아니면 그 블록 앞에) 넣는다
  const top = $from.depth >= 1 ? $from.before(1) : 0;
  const block = view.state.doc.nodeAt(top);
  const empty = !!block && block.type.name === 'paragraph' && block.content.size === 0;
  const nodes = tocNodes(tab, heads, true).map((j) => view.state.schema.nodeFromJSON(j));
  const tr = view.state.tr;
  if (empty) tr.replaceWith(top, top + block!.nodeSize, nodes);
  else tr.insert(top, nodes);
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tr.doc.content.size, top + nodes.reduce((a, n) => a + n.nodeSize, 0)))));
  view.dispatch(tr.scrollIntoView());
  await settlePages(tab, maxLevel);
  return true;
}

/** 차례 새로 고침: 문서의 차례를 지금 제목·쪽으로 다시 만든다. 차례가 없으면 false */
export async function updateToc(tab: DocTab, maxLevel = 3): Promise<boolean> {
  const view = tab.editor.view;
  const ranges = tocRanges(view.state.doc);
  if (!ranges.length) return false;
  const heads = collectHeadings(view.state.doc, maxLevel);
  const tr = view.state.tr;
  // 차례가 여럿이면 모두 (뒤에서부터)
  for (let i = ranges.length - 1; i >= 0; i--) {
    const [from, to] = ranges[i];
    const hadTitle = view.state.doc.nodeAt(from)?.attrs.toc === 'title';
    const nodes = tocNodes(tab, heads, hadTitle).map((j) => view.state.schema.nodeFromJSON(j));
    tr.replaceWith(from, to, nodes.length ? nodes : [view.state.schema.nodes.paragraph.create()]);
  }
  view.dispatch(tr);
  await settlePages(tab, maxLevel);
  return true;
}

/**
 * 고른 문단들의 "제목 … 쪽" 사이를 점선 채움 탭으로: 탭이 있으면 마지막 탭을, 없으면 끝의 쪽 번호(숫자·로마 숫자) 앞
 * 빈칸·점(.·…)을 오른쪽 맞춤 점선 탭 하나로 바꾼다. 바꾼 문단 수
 */
export function applyLeaderTab(tab: DocTab): number {
  const view = tab.editor.view;
  const { state } = view;
  const tabType = state.schema.marks.tab;
  if (!tabType) return 0;
  const tr = state.tr;
  let n = 0;
  const paras: { pos: number; node: PMNode }[] = [];
  for (const r of state.selection.ranges) {
    state.doc.nodesBetween(r.$from.pos, r.$to.pos, (node, pos) => {
      if (node.isTextblock) {
        if (!paras.some((p) => p.pos === pos)) paras.push({ pos, node });
        return false;
      }
      return true;
    });
  }
  const attrs = { right: true, leader: LEADER_DOTS, type: TAB_TYPE_RIGHT, width: null };
  // 뒤 문단부터 (위치가 밀리지 않게)
  for (const { pos, node } of paras.sort((a, b) => b.pos - a.pos)) {
    // 글자 하나 = 위치 하나가 되도록 (그림 등은 대신 글자 하나)
    const text = node.textBetween(0, node.content.size, '', '￼');
    if (text.length !== node.content.size) continue;
    const base = pos + 1;
    const lastTab = text.lastIndexOf('\t');
    if (lastTab >= 0) {
      const m = node.childAfter(lastTab).node?.marks.find((mk) => mk.type === tabType);
      tr.removeMark(base + lastTab, base + lastTab + 1, tabType).addMark(base + lastTab, base + lastTab + 1, tabType.create({ ...(m?.attrs || {}), ...attrs }));
      n++;
      continue;
    }
    // 제목 끝(빈칸·점이 아닌 글자) 뒤의 빈칸·점 줄 + 쪽 번호
    const m = /^(.*?[^\s.\u00b7\u2026\u318d\u2025])([\s.\u00b7\u2026\u318d\u2025]+)([0-9]+|[ivxlcdm]+|[IVXLCDM]+|- ?[0-9]+ ?-)\s*$/.exec(text);
    if (!m || !m[1].trim()) continue;
    const from = base + m[1].length;
    const to = from + m[2].length;
    const marks = (node.childAfter(m[1].length - 1).node?.marks || []).filter((mk) => mk.type !== tabType);
    tr.replaceWith(from, to, state.schema.text('\t', [...marks, tabType.create(attrs)]));
    n++;
  }
  if (n) view.dispatch(tr);
  return n;
}
