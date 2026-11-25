import { Mark, mergeAttributes } from '@tiptap/core';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import type { Node as PMNode, Mark as PMMark } from '@tiptap/pm/model';
import { TableMap } from '@tiptap/pm/tables';
import { evaluateFormula, formatResult } from '../../formats/formula';

/**
 * 표 계산식 (한글의 계산식 필드): 칸 안의 결과 글에 다는 표시. formula 는 '=SUM(LEFT)' 같은 계산식, fmt 는 결과 형식("%g,").
 * 표의 칸 글이 바뀌면 그 표의 계산식들을 다시 셈해 결과 글을 바꾼다 (formats/formula.ts)
 */
declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    formula: {
      /** 커서가 든 칸에 계산식을 넣는다 (그 칸의 첫 문단 글을 결과로 바꾼다) */
      insertFormula: (formula: string, fmt?: string) => ReturnType;
    };
  }
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
const key = new PluginKey('formulaRecalc');

/** 표 node(문서 자리 tPos) 의 계산식들을 다시 셈한 바꿈 (뒤에서부터). 바꿀 것이 없으면 빈 목록 */
function recalcTable(table: PMNode, tPos: number): { from: number; to: number; text: string; marks: readonly PMMark[] }[] {
  let map: TableMap;
  try {
    map = TableMap.get(table);
  } catch {
    return [];
  }
  const cellText = new Map<number, string>();
  const textOf = (p: number) => {
    let t = cellText.get(p);
    if (t == null) {
      t = table.nodeAt(p)?.textContent ?? '';
      cellText.set(p, t);
    }
    return t;
  };
  const get = (r: number, c: number) => (r < map.height && c < map.width ? textOf(map.map[r * map.width + c]) : null);
  // 칸마다 계산식 덩어리
  const jobs: { r: number; c: number; cellP: number; from: number; to: number; formula: string; fmt: string; marks: readonly PMMark[] }[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < map.map.length; i++) {
    const p = map.map[i];
    if (seen.has(p)) continue;
    seen.add(p);
    const cell = table.nodeAt(p);
    if (!cell) continue;
    const rect = map.findCell(p);
    const base = tPos + 1 + p + 1;
    cell.descendants((n, off) => {
      // 칸 안의 안쪽 표는 그 표대로 (바깥 표의 칸 주소로 셈하지 않는다)
      if (n.type.name === 'table') return false;
      if (!n.isText) return true;
      const m = n.marks.find((x) => x.type.name === 'formula');
      if (!m) return false;
      const from = base + off;
      const last = jobs[jobs.length - 1];
      if (last && last.cellP === p && last.to === from && last.formula === m.attrs.formula) last.to = from + n.nodeSize;
      else jobs.push({ r: rect.top, c: rect.left, cellP: p, from, to: from + n.nodeSize, formula: m.attrs.formula, fmt: m.attrs.fmt, marks: n.marks });
      return false;
    });
  }
  if (!jobs.length) return [];
  // 계산식 결과를 다른 계산식이 쓸 수 있으므로 두 번 돈다 (합계의 합계)
  const out = new Map<number, string>();
  for (let pass = 0; pass < 2; pass++)
    for (const j of jobs) {
      const v = evaluateFormula(j.formula, { r: j.r, c: j.c }, { rows: map.height, cols: map.width }, get);
      if (v == null) continue;
      const text = formatResult(v, j.fmt);
      out.set(j.from, text);
      // 그 칸의 글(다른 계산식이 읽는 값)도 결과로
      cellText.set(j.cellP, text);
    }
  const changes: { from: number; to: number; text: string; marks: readonly PMMark[] }[] = [];
  for (const j of jobs) {
    const text = out.get(j.from);
    if (text == null) continue;
    const cur = table.textBetween(j.from - tPos - 1, j.to - tPos - 1);
    if (cur !== text) changes.push({ from: j.from, to: j.to, text, marks: j.marks });
  }
  return changes.sort((a, b) => b.from - a.from);
}

/** 문서의 [from, to] 와 겹치는 (가장 바깥) 표들 */
function tablesIn(doc: PMNode, from: number, to: number): { node: PMNode; pos: number }[] {
  const out: { node: PMNode; pos: number }[] = [];
  doc.nodesBetween(Math.max(0, from), Math.min(doc.content.size, to), (n, pos) => {
    if (n.type.name === 'table') {
      out.push({ node: n, pos });
      return false;
    }
    return true;
  });
  return out;
}

export const Formula = Mark.create({
  name: 'formula',
  inclusive: false,
  addAttributes() {
    return {
      formula: { default: '', parseHTML: (el: HTMLElement) => str(el.getAttribute('data-formula'), 500), renderHTML: (a: Record<string, any>) => ({ 'data-formula': str(a.formula, 500), title: '계산식 ' + str(a.formula, 500) }) },
      fmt: { default: '%g,', parseHTML: (el: HTMLElement) => str(el.getAttribute('data-fmt'), 40) || '%g,', renderHTML: (a: Record<string, any>) => ({ 'data-fmt': str(a.fmt, 40) }) },
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-formula[data-formula]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-formula' }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      insertFormula:
        (formula, fmt = '%g,') =>
        ({ state, tr, dispatch }) => {
          const $p = state.selection.$from;
          let cellDepth = -1;
          for (let d = $p.depth; d > 0; d--)
            if (/^table(Cell|Header)$/.test($p.node(d).type.name)) {
              cellDepth = d;
              break;
            }
          if (cellDepth < 0) return false;
          const cell = $p.node(cellDepth);
          const cellPos = $p.before(cellDepth);
          let tb: { pos: number; node: PMNode } | null = null;
          cell.descendants((n, off) => {
            if (!tb && n.isTextblock) tb = { pos: cellPos + 1 + off, node: n };
            return !tb;
          });
          if (!tb) return false;
          const t: { pos: number; node: PMNode } = tb;
          if (!dispatch) return true;
          const marks = (t.node.firstChild?.marks || $p.marks()).filter((m) => m.type.name !== 'formula');
          const f = { formula: str(formula, 500).trim(), fmt: str(fmt, 40) || '%g,' };
          // 처음엔 자리 표시 '0': 다시 셈하는 플러그인이 같은 거래 뒤에 결과로 바꾼다
          tr.replaceWith(t.pos + 1, t.pos + 1 + t.node.content.size, state.schema.text('0', [...marks, state.schema.marks.formula.create(f)]));
          dispatch(tr.scrollIntoView());
          return true;
        },
    };
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key,
        appendTransaction(trs: readonly Transaction[], oldState, newState) {
          // 사용자가 고친 거래가 있을 때만 (문서를 통째로 넣는 불러오기와, 원본 표시를 지우는 hwpKeep 의 덧붙인 거래는 'hwpKeep' 표시)
          if (!trs.some((t) => t.docChanged && !t.getMeta(key) && !t.getMeta('hwpKeep'))) return null;
          if (!newState.schema.marks.formula) return null;
          const start = newState.doc.content.findDiffStart(oldState.doc.content);
          if (start == null) return null;
          const end = newState.doc.content.findDiffEnd(oldState.doc.content);
          const to = end ? Math.max(start, end.a) : newState.doc.content.size;
          // 모든 표의 바꿈을 모아 뒤에서부터 (앞 자리가 밀리지 않게)
          const all = tablesIn(newState.doc, start, to).flatMap((t) => recalcTable(t.node, t.pos));
          if (!all.length) return null;
          const tr = newState.tr;
          for (const c of all.sort((a, b) => b.from - a.from)) tr.replaceWith(c.from, c.to, newState.schema.text(c.text, c.marks));
          tr.setMeta(key, true);
          return tr;
        },
      }),
    ];
  },
});
