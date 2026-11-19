// 구역마다 다른 머리말·꼬리말: 쪽마다의 설정(planPages)이 그 구역의 머리말·첫 쪽·쪽 번호를 고른다
//   node tests/test-section-hf.mjs
import { load } from './harness.mjs';
const m = await load('src/print.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};
const page = { width: 210, height: 297, marginTop: 20, marginBottom: 15, marginLeft: 30, marginRight: 30, marginHeader: 15, marginFooter: 15, gutter: 0, landscape: false };
const H = (text) => ({ text, align: 'center' });
const s = { page, header: H('표지'), footer: H(''), pageNumber: { pos: 'none', format: 'digit', start: 1 } };
// 쪽 0·1: 첫 구역, 쪽 2~4: 둘째 구역(첫 쪽 비움, i 부터), 쪽 5~6: 셋째 구역(쪽 번호 이어서)
const sec2 = { header: { ...H('본문'), first: H('') }, footer: H('꼬리'), start: 1, fmt: 'roman' };
const sec3 = { header: H('부록'), footer: H('꼬리'), start: null, fmt: null };
const pageHfs = [null, null, { hf: sec2, start: 2 }, { hf: sec2, start: 2 }, { hf: sec2, start: 2 }, { hf: sec3, start: 5 }, { hf: sec3, start: 5 }];
const setups = [null, null, page, page, page, page, page];
const plans = m.planPages(s, 7, setups, 1000, 20, pageHfs);
const hd = (k) => m.hfAt(plans[k].settings, 'header', k)?.text ?? null;
ok(hd(0) === '표지' && hd(1) === '표지', '첫 구역은 문서의 머리말');
ok(hd(2) === '' && hd(3) === '본문' && hd(4) === '본문', '둘째 구역: 구역의 첫 쪽은 첫 쪽 머리말(빈 것), 그 뒤는 기본', JSON.stringify([hd(2), hd(3), hd(4)]));
ok(hd(5) === '부록' && hd(6) === '부록', '셋째 구역의 머리말');
const num = (k) => m.pageNumAt(plans[k].settings, k);
ok(num(0) === 1 && num(1) === 2 && num(2) === 1 && num(4) === 3 && num(5) === 4 && num(6) === 5, '쪽 번호: 둘째 구역에서 1 부터 다시, 셋째 구역은 이어서', JSON.stringify([0, 1, 2, 3, 4, 5, 6].map(num)));
ok(plans[2].settings.pageNumber.format === 'roman' && plans[6].settings.pageNumber.format === 'roman' && plans[0].settings.pageNumber.format === 'digit', '쪽 번호 모양도 구역에서 바뀌어 이어진다');
// 구역마다 다른 머리말이 없는 문서는 그대로
const plain = m.planPages(s, 3, undefined, 1000, 20, undefined);
ok(plain.every((p) => p.settings === s), '구역 머리말이 없으면 문서 설정 그대로');

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
