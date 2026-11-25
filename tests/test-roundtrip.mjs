import { load, readSample } from './harness.mjs';
import fs from 'node:fs';
import JSZip from 'jszip';
const m = await load('tests/formats.entry.ts');
const file = process.argv[2];
const reader = file.endsWith('.hwp') ? m.readHwp : m.readHwpx;
const doc = await reader(readSample(file));
const count = (d) => { const c = {}; const walk = (n) => { c[n.type] = (c[n.type] || 0) + 1; (n.content || []).forEach(walk); }; walk(d.content); return c; };
const t0 = Date.now();
const out = await m.writeHwpx(doc);
console.log('write ms', Date.now() - t0, 'bytes', out.length);
fs.writeFileSync('tests/.build/out-' + file.replace(/\.\w+$/, '') + '.hwpx', out);
// XML 유효성
const zip = await JSZip.loadAsync(out);
for (const name of Object.keys(zip.files)) {
  if (!/\.(xml|hpf|rdf)$/.test(name)) continue;
  const xml = await zip.file(name).async('string');
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  if (d.getElementsByTagName('parsererror').length) console.log('XML ERROR in', name, d.getElementsByTagName('parsererror')[0].textContent.slice(0, 300));
}
console.log('order', Object.keys(zip.files).slice(0, 3));
const back = await m.readHwpx(out);
const a = count(doc), b = count(back);
console.log('orig ', JSON.stringify(a));
console.log('back ', JSON.stringify(b));
// 원본 보존형 저장의 원본 정보(hwpBase: 원본 머리부 등)는 읽은 파일마다 다르므로 빼고 견준다
const settingsOf = (s) => JSON.stringify({ ...s, hwpBase: undefined });
console.log('settings same:', settingsOf(doc.settings) === settingsOf(back.settings), JSON.stringify(back.settings.page));
const txt = (n) => n.type === 'text' ? n.text : (n.content || []).map(txt).join('');
console.log('text same:', txt(doc.content) === txt(back.content), txt(doc.content).length, txt(back.content).length);
