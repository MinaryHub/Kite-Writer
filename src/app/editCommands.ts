import type { Editor } from '@tiptap/react';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Fragment } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';
import { CellSelection, TableMap } from '@tiptap/pm/tables';
import { app } from './controller';
import { viewState } from '../editor/viewState';
import { PX_PER_MM } from '../formats/common';

/**
 * 한글에 있는 편집 기능들: 표의 쉬운 계산식(가로·세로 합계/평균/곱), 셀 높이를 같게, 표 ↔ 문자열, 대소문자 바꾸기, 문단 정렬, 글상자 넣기
 */

/** 커서가 놓인 칸: 표 노드, 표 안쪽 시작 위치, 칸의 위치(문서 기준). 표 안이 아니면 null */
function cellAt(editor: Editor): { table: PMNode; tableStart: number; tablePos: number; cellPos: number } | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 1; d--) {
    const n = $from.node(d);
    if (n.type.name !== 'tableCell' && n.type.name !== 'tableHeader') continue;
    const table = $from.node(d - 2);
    if (table.type.name !== 'table') return null;
    return { table, tableStart: $from.start(d - 2), tablePos: $from.before(d - 2), cellPos: $from.before(d) };
  }
  return null;
}

/** 칸의 글에서 수를 읽는다: 천 단위 쉼표, 앞뒤의 단위 글자(원, %, ₩ …)는 허용. 수가 아니면 null */
export function parseCellNumber(text: string): { v: number; decimals: number; comma: boolean } | null {
  const t = text.replace(/\s+/g, '');
  const m = /^[^\d\-+.(]{0,2}(\(?[-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?)[^\d]{0,3}$/.exec(t);
  if (!m) return null;
  let s = m[1];
  // (123) 은 음수 (회계 표기)
  const neg = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, '');
  const comma = s.includes(',');
  const v = parseFloat(s.replace(/,/g, ''));
  if (!Number.isFinite(v)) return null;
  const dot = s.indexOf('.');
  return { v: neg ? -v : v, decimals: dot < 0 ? 0 : s.length - dot - 1, comma };
}

function formatNumber(v: number, decimals: number, comma: boolean): string {
  const s = v.toFixed(Math.max(0, Math.min(6, decimals)));
  if (!comma) return s;
  const [int, frac] = s.split('.');
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac ? '.' + frac : '');
}

/** 쉬운 계산식: 커서가 있는 칸에 그 왼쪽(가로) 또는 위쪽(세로) 칸들의 합계·평균·곱을 넣는다 */
export function tableCalc(editor: Editor, dir: 'row' | 'col', op: 'sum' | 'avg' | 'prod') {
  const at = cellAt(editor);
  if (!at) return;
  const map = TableMap.get(at.table);
  const rect = map.findCell(at.cellPos - at.tableStart);
  const seen = new Set<number>();
  const nums: { v: number; decimals: number; comma: boolean }[] = [];
  const take = (r: number, c: number) => {
    const p = map.map[r * map.width + c];
    if (seen.has(p)) return;
    seen.add(p);
    const cell = at.table.nodeAt(p);
    const n = cell ? parseCellNumber(cell.textContent) : null;
    if (n) nums.push(n);
  };
  if (dir === 'row') for (let c = 0; c < rect.left; c++) take(rect.top, c);
  else for (let r = 0; r < rect.top; r++) take(r, rect.left);
  if (!nums.length) {
    app.toast(dir === 'row' ? '왼쪽 칸에 계산할 숫자가 없습니다.' : '위쪽 칸에 계산할 숫자가 없습니다.', 'error');
    return;
  }
  let v = op === 'prod' ? 1 : 0;
  for (const n of nums) v = op === 'prod' ? v * n.v : v + n.v;
  let decimals = Math.max(...nums.map((n) => n.decimals));
  if (op === 'avg') {
    v /= nums.length;
    // 평균은 나누어떨어지지 않으면 소수 둘째 자리까지
    if (Math.abs(v * 10 ** decimals - Math.round(v * 10 ** decimals)) > 1e-9) decimals = Math.max(decimals, 2);
  } else if (op === 'prod') decimals = Math.min(6, nums.reduce((a, n) => a + n.decimals, 0));
  const text = formatNumber(v, decimals, nums.some((n) => n.comma));
  // 칸의 첫 문단 글을 결과로 바꾼다
  const cell = at.table.nodeAt(at.cellPos - at.tableStart);
  if (!cell) return;
  let tb: { pos: number; size: number } | null = null;
  cell.descendants((n, p) => {
    if (!tb && n.isTextblock) tb = { pos: at.cellPos + 1 + p, size: n.content.size };
    return !tb;
  });
  if (!tb) return;
  const t: { pos: number; size: number } = tb;
  const tr = editor.state.tr.insertText(text, t.pos + 1, t.pos + 1 + t.size);
  tr.setSelection(TextSelection.create(tr.doc, t.pos + 1 + text.length));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

/** 셀 높이를 같게: 고른 줄들(블록이 없으면 표의 모든 줄)의 높이를 그 평균으로 맞춘다 */
export function tableEqualHeight(editor: Editor) {
  const at = cellAt(editor);
  if (!at) return;
  const sel = editor.state.selection;
  const map = TableMap.get(at.table);
  let top = 0;
  let bottom = map.height;
  if (sel instanceof CellSelection) {
    const r = map.rectBetween(sel.$anchorCell.pos - at.tableStart, sel.$headCell.pos - at.tableStart);
    top = r.top;
    bottom = r.bottom;
  }
  const z = viewState.zoom || 1;
  const rows: { pos: number; node: PMNode; h: number }[] = [];
  let i = 0;
  at.table.forEach((row, off) => {
    if (i >= top && i < bottom) {
      const dom = editor.view.nodeDOM(at.tableStart + off) as HTMLElement | null;
      const h = dom instanceof HTMLElement ? dom.getBoundingClientRect().height / z : +row.attrs.height || 0;
      rows.push({ pos: at.tableStart + off, node: row, h });
    }
    i++;
  });
  if (rows.length < 2) {
    app.toast('높이를 맞출 줄을 둘 이상 고르세요.', 'error');
    return;
  }
  const h = Math.round((rows.reduce((a, r) => a + r.h, 0) / rows.length) * 10) / 10;
  const tr = editor.state.tr;
  for (const r of rows) tr.setNodeMarkup(r.pos, undefined, { ...r.node.attrs, height: h });
  editor.view.dispatch(tr);
}

/** 표 → 문자열: 표를 줄마다 한 문단으로 바꾼다 (칸은 탭으로 나눈다) */
export function tableToText(editor: Editor) {
  const at = cellAt(editor);
  if (!at) return;
  const schema = editor.schema;
  const paras: PMNode[] = [];
  at.table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell) => {
      const parts: string[] = [];
      cell.forEach((b) => parts.push(b.textContent));
      cells.push(parts.join(' ').replace(/\t/g, ' '));
    });
    const text = cells.join('\t');
    paras.push(schema.nodes.paragraph.create(null, text ? schema.text(text) : undefined));
  });
  if (!paras.length) return;
  const tr = editor.state.tr.replaceWith(at.tablePos, at.tablePos + at.table.nodeSize, Fragment.fromArray(paras));
  tr.setSelection(TextSelection.near(tr.doc.resolve(at.tablePos + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

/** 문자열 → 표: 고른 문단들을 줄로, 탭(없으면 쉼표)으로 나뉜 조각을 칸으로 하는 표로 바꾼다 */
export function textToTable(editor: Editor) {
  const { $from, $to } = editor.state.selection;
  const range = $from.blockRange($to);
  if (!range) return;
  const parent = range.parent;
  const lines: string[] = [];
  for (let i = range.startIndex; i < range.endIndex; i++) {
    const n = parent.child(i);
    if (!n.isTextblock) {
      app.toast('표로 바꿀 문단들만 블록으로 지정하세요.', 'error');
      return;
    }
    lines.push(n.textContent);
  }
  if (!lines.length || !parent.type.contentMatch.matchType(editor.schema.nodes.table)) {
    app.toast('여기에는 표를 넣을 수 없습니다.', 'error');
    return;
  }
  const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines.some((l) => l.includes(',')) ? ',' : null;
  const rows = lines.map((l) => (sep ? l.split(sep).map((x) => x.trim()) : [l]));
  const cols = Math.min(64, Math.max(1, ...rows.map((r) => r.length)));
  const schema = editor.schema;
  // 본문 폭에 맞춘 같은 너비의 칸
  const pg = app.active!.settings.page;
  const bodyPx = ((pg.landscape ? Math.max(pg.width, pg.height) : pg.width) - pg.marginLeft - pg.marginRight - pg.gutter) * PX_PER_MM;
  const w = Math.max(20, Math.floor(bodyPx / cols));
  const table = schema.nodes.table.create(
    null,
    rows.map((r) =>
      schema.nodes.tableRow.create(
        null,
        Array.from({ length: cols }, (_x, c) => schema.nodes.tableCell.create({ colwidth: [w] }, schema.nodes.paragraph.create(null, r[c] ? schema.text(r[c]) : undefined))),
      ),
    ),
  );
  const tr = editor.state.tr.replaceWith(range.start, range.end, table);
  tr.setSelection(TextSelection.near(tr.doc.resolve(range.start + 3)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}

/** 대소문자 바꾸기: 블록으로 지정한 글의 영문자를 대문자·소문자·낱말 첫 글자만 대문자로 (글자 모양은 그대로) */
export function changeCase(editor: Editor, mode: 'upper' | 'lower' | 'title') {
  const { from, to, empty } = editor.state.selection;
  if (empty) {
    app.toast('바꿀 글자를 블록으로 지정하세요.', 'error');
    return;
  }
  const conv = (s: string) => (mode === 'upper' ? s.toUpperCase() : mode === 'lower' ? s.toLowerCase() : s.toLowerCase().replace(/(^|[^A-Za-zÀ-ɏ'’])([a-zà-ɏ])/g, (_m, a, b) => a + b.toUpperCase()));
  const tr = editor.state.tr;
  editor.state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isText) return true;
    const a = Math.max(from, pos);
    const b = Math.min(to, pos + node.nodeSize);
    const text = node.text!.slice(a - pos, b - pos);
    const next = conv(text);
    // 글자 수가 달라지는 변환(ß → SS 등)은 자리 계산이 어긋나므로 건너뛴다
    if (next !== text && next.length === text.length) tr.replaceWith(a, b, editor.schema.text(next, node.marks));
    return false;
  });
  if (tr.docChanged) editor.view.dispatch(tr.setSelection(TextSelection.create(tr.doc, from, to)));
  editor.view.focus();
}

/** 정렬(소트): 블록으로 지정한 문단들을 글 순서로 (가나다·숫자 순, desc 면 거꾸로) */
export function sortParagraphs(editor: Editor, desc: boolean) {
  const { $from, $to } = editor.state.selection;
  const range = $from.blockRange($to);
  if (!range || range.endIndex - range.startIndex < 2) {
    app.toast('정렬할 문단을 둘 이상 블록으로 지정하세요.', 'error');
    return;
  }
  const nodes: PMNode[] = [];
  for (let i = range.startIndex; i < range.endIndex; i++) nodes.push(range.parent.child(i));
  if (nodes.some((n) => !n.isTextblock)) {
    app.toast('문단만 정렬할 수 있습니다 (표·그림이 든 블록은 빼고 지정하세요).', 'error');
    return;
  }
  const coll = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' });
  const sorted = nodes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => coll.compare(a.n.textContent.trim(), b.n.textContent.trim()) * (desc ? -1 : 1) || a.i - b.i)
    .map((x) => x.n);
  const tr = editor.state.tr.replaceWith(range.start, range.end, Fragment.fromArray(sorted));
  tr.setSelection(TextSelection.create(tr.doc, range.start + 1, range.end - 1));
  editor.view.dispatch(tr);
  editor.view.focus();
}

/** 글상자 넣기: 테두리가 있는 빈 글상자를 커서 자리의 블록 뒤에 넣고 커서를 그 안에 둔다 */
export function insertTextBox(editor: Editor) {
  const schema = editor.schema;
  const box = schema.nodes.textBox.create({ width: Math.round(70 * PX_PER_MM), height: Math.round(25 * PX_PER_MM), borderColor: '#000000', borderWidth: 0.5, padding: [4, 6, 4, 6] }, schema.nodes.paragraph.create());
  const { $from } = editor.state.selection;
  // 본문 최상위(또는 글상자를 담을 수 있는 가장 가까운 곳)에 넣는다
  let depth = $from.depth;
  while (depth > 0 && !$from.node(depth - 1).type.contentMatch.matchType(schema.nodes.textBox)) depth--;
  const pos = depth > 0 ? $from.after(depth) : $from.pos;
  const tr = editor.state.tr.insert(pos, box);
  tr.setSelection(TextSelection.near(tr.doc.resolve(pos + 2)));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
}
