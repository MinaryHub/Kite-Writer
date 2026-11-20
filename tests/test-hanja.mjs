// 한자 사전: 글자·낱말 후보, 커서 앞 낱말 찾기, 한자 → 한글, 넣는 꼴
//   node tests/test-hanja.mjs
import { load } from './harness.mjs';
import fs from 'node:fs';
const m = await load('src/hanja.ts');
const d = m.parseHanja(fs.readFileSync('src/data/hanja/chars.txt', 'utf8'), fs.readFileSync('src/data/hanja/words.txt', 'utf8'));

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};

const ga = m.candidates(d, '가');
ok(ga[0].h === '可' && ga[0].m === '옳을 가' && ga.length > 50, '글자 하나: 자주 쓰는 차례, 뜻', JSON.stringify(ga.slice(0, 3)));
const gj = m.candidates(d, '가정').map((x) => x.h);
ok(gj.includes('家庭') && gj.includes('假定') && gj.every((h) => [...h].length === 2), '낱말: 家庭·假定 …', JSON.stringify(gj.slice(0, 5)));
ok(m.candidates(d, '대한민국').some((x) => x.h === '大韓民國'), '네 글자 낱말');
ok(m.wordBeforeCursor(d, '우리 가정') === '가정' && m.wordBeforeCursor(d, '오늘은대한민국') === '대한민국', '커서 앞에서 사전에 있는 가장 긴 낱말');
ok(m.wordBeforeCursor(d, '쀍') === null && m.wordBeforeCursor(d, 'abc') === null, '바꿀 한글이 없으면 null');
ok(m.wordBeforeCursor(d, '갃가') === '가', '낱말이 없으면 마지막 한 글자');
ok(m.hanjaToHangul(d, '大韓民國 憲法 第1條') === '대한민국 헌법 제1조', '한자 → 한글', m.hanjaToHangul(d, '大韓民國 憲法 第1條'));
ok(m.hanjaToHangul(d, '音樂') === '음악' || m.hanjaToHangul(d, '音樂') === '음락', '읽기가 여럿인 한자는 그 한자가 더 앞에 나오는 읽기', m.hanjaToHangul(d, '音樂'));
ok(m.formatHanja('hanja', '家庭', '가정') === '家庭' && m.formatHanja('hanjaHangul', '家庭', '가정') === '家庭(가정)' && m.formatHanja('hangulHanja', '家庭', '가정') === '가정(家庭)', '넣는 꼴 3가지');

const seg = await load('src/ui/dialogs/HanjaDialog.tsx').catch(() => null);
if (seg?.segmentsOf) {
  const s1 = seg.segmentsOf(d, 10, '가정');
  ok(s1.length === 1 && s1[0].to === 12, '사전에 있는 낱말은 한 번에');
  const s2 = seg.segmentsOf(d, 10, '갃나 다');
  ok(s2.map((x) => x.reading).join('') === '나다' && s2[1].from === 13, '사전에 없는 여러 글자는 한 글자씩 (자리 유지)', JSON.stringify(s2));
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
