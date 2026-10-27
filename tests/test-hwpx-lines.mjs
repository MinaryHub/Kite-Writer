// 같은 문서의 HWP·HWPX 를 읽어 한글이 배치한 줄(hwpLines)·쪽(hwpPage) 정보가 같은지 본다
// node tests/test-hwpx-lines.mjs a.hwp a.hwpx [b.hwp b.hwpx ...]
import fs from 'node:fs';
import { load } from './harness.mjs';
const m = await load('tests/formats.entry.ts');
const read = (f) => (f.toLowerCase().endsWith('.hwp') ? m.readHwp : m.readHwpx)(new Uint8Array(fs.readFileSync(f)));
const text = (n) => (n.type === 'text' ? n.text : (n.content || []).map(text).join(''));
const collect = (doc) => {
  const out = [];
  const walk = (n) => {
    if (n.type === 'paragraph' || n.type === 'table') out.push({ type: n.type, lines: n.attrs?.hwpLines || null, len: n.attrs?.hwpLen ?? null, page: !!n.attrs?.hwpPage, text: text(n).slice(0, 40) });
    (n.content || []).forEach(walk);
  };
  walk(doc.content);
  return out;
};
let fail = 0;
for (let i = 2; i + 1 < process.argv.length; i += 2) {
  const [a, b] = [collect(await read(process.argv[i])), collect(await read(process.argv[i + 1]))];
  const k = (p) => JSON.stringify([p.type, p.lines?.map((l) => [l[0], Math.round(l[1])]), p.len, p.page]);
  let same = 0, diff = 0, withLines = [0, 0], pages = [0, 0];
  for (const p of a) { if (p.lines) withLines[0]++; if (p.page) pages[0]++; }
  for (const p of b) { if (p.lines) withLines[1]++; if (p.page) pages[1]++; }
  const n = Math.min(a.length, b.length);
  for (let j = 0; j < n; j++) {
    if (k(a[j]) === k(b[j])) same++;
    else if (diff++ < 5) console.log('  DIFF', j, '\n    hwp ', k(a[j]), a[j].text, '\n    hwpx', k(b[j]), b[j].text);
  }
  console.log(process.argv[i], { blocks: [a.length, b.length], same, diff, withLines, hwpPage: pages });
  if (diff || a.length !== b.length) fail++;
}
process.exit(fail ? 1 : 0);
