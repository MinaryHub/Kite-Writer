// 표 계산식: 셈(함수·방향·칸 주소·사칙연산), 결과 형식, 한글 명령 글, HWP·HWPX 읽고 쓰기
//   node tests/test-formula.mjs
import { load } from './harness.mjs';
import JSZip from 'jszip';
const f = await load('src/formats/formula.ts');
const m = await load('tests/formats.entry.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};
// 3×4 표: 10 20 1,000.5 [r0c3] / 1 2 3 [r1c3] / [r2c0] 글 ...
const grid = [
  ['10', '20', '1,000.5', ''],
  ['1', '2', '3', ''],
  ['', '가', '7', ''],
];
const get = (r, c) => grid[r]?.[c] ?? null;
const size = { rows: 3, cols: 4 };
const ev = (s, r, c) => f.evaluateFormula(s, { r, c }, size, get);
ok(ev('=SUM(LEFT)', 0, 3) === 1030.5, 'SUM(LEFT): 쉼표가 든 숫자도');
ok(ev('=AVG(LEFT)', 1, 3) === 2, 'AVG(LEFT)');
ok(ev('=SUM(ABOVE)', 2, 0) === 11, 'SUM(ABOVE): 빈칸·글은 건너뛴다');
ok(ev('=SUM(A1:B2)', 2, 3) === 33, '칸 범위 A1:B2');
ok(ev('=A1*2+C3/7', 2, 3) === 21, '칸 주소와 사칙연산');
ok(ev('=PRODUCT(A2:C2)', 2, 3) === 6 && ev('=MAX(A1:C2)', 2, 3) === 1000.5 && ev('=MIN(A1:C2)', 2, 3) === 1 && ev('=COUNT(A1:D3)', 2, 3) === 7, 'PRODUCT·MAX·MIN·COUNT');
ok(ev('=ROUND(C1/3, 1)', 2, 3) === 333.5, 'ROUND');
ok(ev('=SUM(?1:?2)', 2, 2) === 1003.5 && ev('=SUM(A?:B?)', 1, 3) === 3, "'?' 주소: 이 칸과 같은 열·줄 (한글의 =SUM(?11:?12))");
ok(ev('=FOO(LEFT)', 0, 3) === null && ev('=SUM(LEFT', 0, 3) === null, '모르는 함수·잘못된 꼴은 null');
{
  // 악의적인 범위: 표 밖까지 걸친 아주 큰 범위도 표 안만 보고 곧바로 끝난다
  const t0 = Date.now();
  ok(ev('=SUM(A1:ZZZ99999)', 2, 3) === 1043.5 && Date.now() - t0 < 500, '표 밖까지 걸친 큰 범위는 표 안으로 잘라 셈 (멈추지 않음)');
  // 큰 표 + 같은 범위를 여러 번: 볼 칸 수 한도를 넘으면 셈하지 않는다 (null)
  const big = { rows: 4000, cols: 500 };
  const t1 = Date.now();
  const v = f.evaluateFormula('=SUM(A1:SS4000,A1:SS4000,A1:SS4000)', { r: 0, c: 0 }, big, () => '1');
  ok(v === null && Date.now() - t1 < 2000, '볼 칸 수 한도를 넘는 계산식은 셈하지 않는다', String(v));
}
ok(f.formatResult(1030.5, '%g,') === '1,030.5' && f.formatResult(2, '%.2f,') === '2.00' && f.formatResult(1234567, '%g') === '1234567' && f.formatResult(-1234.5, '%.1f,') === '-1,234.5', '결과 형식 (한글: 합계 %g, 평균 %.2f,)');
const pc = f.parseFormulaCommand('=SUM(LEFT)??%g,;;1,030.5');
ok(pc && pc.formula === '=SUM(LEFT)' && pc.fmt === '%g,', '한글 명령 글 읽기');
ok(f.formulaCommand({ formula: '=AVG(LEFT)', fmt: '%.2f,' }, '2.00') === '=AVG(LEFT)??%.2f,;;2.00', '한글 명령 글 쓰기');

// 읽고 쓰기
const P = (c) => ({ type: 'paragraph', content: c });
const cell = (c) => ({ type: 'tableCell', attrs: { colspan: 1, rowspan: 1 }, content: [P(c)] });
const fx = (text, formula, fmt) => ({ type: 'text', text, marks: [{ type: 'formula', attrs: { formula, fmt } }] });
const nd = {
  content: { type: 'doc', content: [{ type: 'table', content: [{ type: 'tableRow', content: [cell([{ type: 'text', text: '10' }]), cell([{ type: 'text', text: '20' }]), cell([fx('30', '=SUM(LEFT)', '%g,')])] }] }] },
  settings: { page: { width: 210, height: 297, marginTop: 20, marginBottom: 15, marginLeft: 30, marginRight: 30, marginHeader: 15, marginFooter: 15, gutter: 0, landscape: false }, header: { text: '', align: 'center' }, footer: { text: '', align: 'center' }, pageNumber: { pos: 'bottom-center', format: 'digit', start: 1 } },
  meta: {},
};
const fms = (d) => {
  const out = [];
  const walk = (n) => {
    const mk = (n.marks || []).find((x) => x.type === 'formula');
    if (mk) out.push(`${n.text}=${mk.attrs.formula}|${mk.attrs.fmt}`);
    (n.content || []).forEach(walk);
  };
  walk(d);
  return out.join(' ');
};
for (const [fmt, w, r] of [
  ['HWPX', m.writeHwpx, m.readHwpx],
  ['HWP', m.writeHwp, m.readHwp],
]) {
  const got = fms((await r(await w(nd))).content);
  ok(got === '30==SUM(LEFT)|%g,', `${fmt}: 계산식 필드`, got);
}
const sec = await (await JSZip.loadAsync(await m.writeHwpx(nd))).file('Contents/section0.xml').async('string');
ok(/type="FORMULA"[\s\S]*?name="Command">=SUM\(LEFT\)\?\?%g,;;30<[\s\S]*?name="LastResult">30</.test(sec), 'HWPX: 한글과 같은 매개 변수');
console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
