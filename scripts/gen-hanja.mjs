// libhangul 의 한자 사전(data/hanja/hanja.txt, BSD-3-Clause)을 Kite 가 쓰는 작은 꼴로 바꾼다.
//   node scripts/gen-hanja.mjs <hanja.txt 경로>
// 만드는 것 (src/data/hanja/):
//   chars.txt  글자 단위: "가\t可옳을 가|家집 가|…" (사전 차례 = 자주 쓰는 차례)
//   words.txt  낱말 단위 (2~4글자, 한자로만 된 것): "가정\t家庭假定…" (읽기와 같은 길이로 끊어 읽는다)
import fs from 'node:fs';
import path from 'node:path';

const src = process.argv[2];
if (!src) {
  console.error('hanja.txt 경로를 주세요.');
  process.exit(1);
}
const out = path.resolve(import.meta.dirname, '..', 'src', 'data', 'hanja');
const HAN = /^[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2fa1f}]+$/u;
const HANGUL = /^[가-힣]+$/;
const chars = new Map();
const words = new Map();
for (const line of fs.readFileSync(src, 'utf8').split('\n')) {
  if (!line || line.startsWith('#')) continue;
  const [r, h, ...rest] = line.split(':');
  if (!r || !h || !HANGUL.test(r) || !HAN.test(h)) continue;
  const n = [...r].length;
  if ([...h].length !== n) continue;
  if (n === 1) {
    const list = chars.get(r) || [];
    if (!list.some((e) => e.startsWith(h))) list.push(h + (rest.join(':').trim().replace(/[|\t\n]/g, ' ') || ''));
    chars.set(r, list);
  } else if (n <= 4) {
    const list = words.get(r) || [];
    if (!list.includes(h)) list.push(h);
    words.set(r, list);
  }
}
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'chars.txt'), [...chars].map(([r, l]) => `${r}\t${l.join('|')}`).join('\n') + '\n');
fs.writeFileSync(path.join(out, 'words.txt'), [...words].map(([r, l]) => `${r}\t${l.join('')}`).join('\n') + '\n');
console.log(`글자 ${chars.size}개 읽기, 낱말 ${words.size}개 읽기`);
