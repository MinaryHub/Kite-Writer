// 개체 속성: 본문과의 배치(글자처럼·어울림·자리 차지·글 앞·글 뒤) 값 만들기와, HWPX·HWP·DOCX 로 저장한 뒤 다시 읽어도 배치가 남는지
//   node tests/test-object-place.mjs
import { load } from './harness.mjs';
const op = await load('src/editor/objectPlace.ts');
const { defaultSettings } = await load('src/formats/common.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};

{
  ok(op.makeFloat('inline', 'left', 10, 10, 4) === null, '글자처럼 취급은 떠 있지 않음');
  const sq = op.makeFloat('square', 'right', 300, 12, 4);
  ok(sq.wrap.s === 'l' && sq.x === 300 && sq.wrap.d.every((v) => v === 4), '어울림·개체 오른쪽 → 글은 왼쪽으로 흐름 (s=l), 바깥 여백');
  ok(op.makeFloat('square', 'left', 0, 0, 0).wrap.s === 'r', '어울림·개체 왼쪽 → 글은 오른쪽 (s=r)');
  ok(op.makeFloat('tb', 'left', 0, 0, 2).wrap.s === 'tb', '자리 차지');
  ok(op.makeFloat('behind', 'left', 5, 5, 0).behind === true && !op.makeFloat('front', 'left', 5, 5, 0).wrap, '글 뒤로 / 글 앞으로');
  for (const m of ['inline', 'square', 'tb', 'front', 'behind'])
    for (const s of ['left', 'right']) {
      const back = op.placementOf(op.makeFloat(m, s, 1, 2, 3));
      if (back.mode !== m || (m === 'square' && back.side !== s)) ok(false, `되읽기 ${m}/${s}`, JSON.stringify(back));
    }
  ok(true, '만든 값을 되읽으면 같은 배치');
}

// 저장 → 다시 읽기
const png =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQDAH/9Af+Gq2dVAAAAAElFTkSuQmCC';
const text = '가나다라마바사 아자차카타파하 '.repeat(30);
const doc = (float) => ({
  // 문단이 여럿인 문서 (Kite 가 저장한 HWP·HWPX 는 줄 정보가 형식뿐이라 다시 읽을 때 자연 배치로 흐른다)
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'image', attrs: { src: png, width: 120, height: 80, float } }, { type: 'text', text }] }, { type: 'paragraph', content: [{ type: 'text', text }] }] },
  settings: defaultSettings(),
  meta: {},
});
const findImg = (n) => (n.type === 'image' ? n : (n.content || []).map(findImg).find(Boolean));
for (const [fmt, w, r] of [
  ['hwpx', 'writeHwpx', 'readHwpx'],
  ['hwp', 'writeHwp', 'readHwp'],
  ['docx', 'writeDocx', 'readDocx'],
]) {
  const W = await load(`src/formats/${fmt}/writer.ts`);
  const R = await load(`src/formats/${fmt}/reader.ts`);
  for (const [m, s] of [
    ['square', 'right'],
    ['tb', 'left'],
    ['behind', 'left'],
    ['front', 'left'],
    ['inline', 'left'],
  ]) {
    const back = await R[r](await W[w](doc(op.makeFloat(m, s, m === 'square' ? 300 : 20, 10, 4))));
    const img = findImg(back.content);
    const got = op.placementOf(img?.attrs.float);
    ok(got.mode === m && (m !== 'square' || got.side === s), `${fmt.toUpperCase()} 저장 후 배치 ${m}${m === 'square' ? '·' + s : ''}`, JSON.stringify(img?.attrs.float));
  }
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
