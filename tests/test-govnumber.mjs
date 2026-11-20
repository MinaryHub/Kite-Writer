// 공문서 항목 번호: 맨 바깥 목록이 k-gov 이면 수준별로 1. 가. 1) 가) (1) (가) ① ㉮, 저장(HWP·HWPX·DOCX)해도 그 번호
//   node tests/test-govnumber.mjs
import { load } from './harness.mjs';
const flat = await load('src/formats/flatten.ts');
const fm = await load('src/formats/index.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};

const P = (t) => ({ type: 'paragraph', content: [{ type: 'text', text: t }] });
// 8단계로 들여 쓴 목록: 수준마다 항목 둘
function nest(level, style) {
  const attrs = level === 0 ? { listStyle: style } : {};
  const items = [0, 1].map((i) => ({ type: 'listItem', content: [P(`수준${level + 1}-${i + 1}`), ...(i === 1 && level < 7 ? [nest(level + 1)] : [])] }));
  return { type: 'orderedList', attrs, content: items };
}
const doc = { type: 'doc', content: [nest(0, 'k-gov')] };

const labels = () =>
  flat
    .flattenDoc(doc)
    .filter((b) => b.kind === 'para')
    .map((b) => b.inlines.map((i) => i.text || '').join(''));
{
  const got = labels().map((t) => t.split(' ')[0]);
  const want = ['1.', '2.', '가.', '나.', '1)', '2)', '가)', '나)', '(1)', '(2)', '(가)', '(나)', '①', '②', '㉮', '㉯'];
  ok(JSON.stringify(got) === JSON.stringify(want), '수준별 번호: 1. 가. 1) 가) (1) (가) ① ㉮', JSON.stringify(got));
}
{
  // 안쪽 목록에 모양을 따로 주면 그 모양
  const d2 = JSON.parse(JSON.stringify(doc));
  d2.content[0].content[1].content[1].attrs = { listStyle: 'upper-roman' };
  const got = flat
    .flattenDoc(d2)
    .filter((b) => b.kind === 'para')
    .map((b) => b.inlines.map((i) => i.text || '').join('').split(' ')[0]);
  ok(got[2] === 'I.' && got[4] === '1)', '따로 정한 안쪽 모양은 그대로, 그 아래 수준은 계속 공문서 차례', JSON.stringify(got.slice(0, 6)));
  ok(flat.orderedLabel(3, 'k-rparen-hangul') === '다)' && flat.orderedLabel(2, 'k-circled-hangul') === '㉯' && flat.orderedLabel(4, 'k-rparen') === '4)', '새 번호 모양 1) 가) ㉮');
}
// 저장한 뒤 다시 읽으면 번호 글이 남는다
const settings = (await load('src/formats/common.ts')).defaultSettings();
for (const [fmt, w, r] of [
  ['hwpx', 'writeHwpx', 'readHwpx'],
  ['hwp', 'writeHwp', 'readHwp'],
  ['docx', 'writeDocx', 'readDocx'],
]) {
  const mod = await load(`src/formats/${fmt}/writer.ts`);
  const rd = await load(`src/formats/${fmt}/reader.ts`);
  const bytes = await mod[w]({ content: doc, settings, meta: {} });
  const back = await rd[r](bytes);
  const text = JSON.stringify(back.content);
  ok(['가.', '1)', '가)', '(가)', '①', '㉮'].every((l) => text.includes(l)), `${fmt.toUpperCase()} 로 저장해도 공문서 번호`, text.slice(0, 120));
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
