// 배포 파일에 들어가는 오픈소스 라이브러리의 라이선스를 모아 public/THIRD_PARTY_NOTICES.txt 로 쓴다.
// (빌드 도구·타입 정의는 빼고, 실행할 때 쓰이는 패키지와 그 하위 의존성만)
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const BUILD_ONLY = /^(@types\/|typescript$|vite$|esbuild$|electron-builder$|jsdom$|@vitejs\/)/;
const roots = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {})].filter((n) => !BUILD_ONLY.test(n));

const seen = new Map();
function find(name, from) {
  let dir = from;
  for (;;) {
    const p = path.join(dir, 'node_modules', name, 'package.json');
    if (fs.existsSync(p)) return p;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}
function walk(name, from) {
  const pj = find(name, from);
  if (!pj) return;
  const dir = path.dirname(pj);
  if (seen.has(dir)) return;
  const meta = JSON.parse(fs.readFileSync(pj, 'utf8'));
  seen.set(dir, meta);
  // electron 자체(Chromium 등)의 라이선스는 electron 이 앱과 함께 LICENSES.chromium.html 로 넣는다
  for (const d of Object.keys(meta.dependencies || {})) walk(d, dir);
}
for (const r of roots) walk(r, root);

const lic = (m) => (typeof m.license === 'string' ? m.license : m.license?.type || (Array.isArray(m.licenses) ? m.licenses.map((l) => l.type || l).join(' OR ') : 'UNKNOWN'));
const entries = [...seen.entries()]
  .map(([dir, m]) => ({ dir, name: m.name, version: m.version, license: lic(m), home: m.homepage || (typeof m.repository === 'string' ? m.repository : m.repository?.url) || '' }))
  .filter((e) => e.name && e.name !== pkg.name)
  .sort((a, b) => a.name.localeCompare(b.name));

let out = `Kite Writer — 오픈소스 라이선스 고지\n\n이 프로그램은 아래 오픈소스 소프트웨어를 포함합니다. 각 소프트웨어는 해당 라이선스를 따릅니다.\n\n`;
const counts = {};
for (const e of entries) counts[e.license] = (counts[e.license] || 0) + 1;
out += Object.entries(counts).map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n';
for (const e of entries) {
  out += `${'='.repeat(72)}\n${e.name} ${e.version}  (${e.license})\n${e.home}\n${'-'.repeat(72)}\n`;
  const f = fs.readdirSync(e.dir).find((x) => /^(licen[sc]e|copying)(\.|$)/i.test(x));
  if (f) out += fs.readFileSync(path.join(e.dir, f), 'utf8').trim() + '\n';
  const n = fs.readdirSync(e.dir).find((x) => /^notice(\.|$)/i.test(x));
  if (n) out += '\n[NOTICE]\n' + fs.readFileSync(path.join(e.dir, n), 'utf8').trim() + '\n';
  out += '\n';
}
// 함께 넣는 자료 (한자 사전 등)
for (const [name, file] of [['libhangul 한자 사전 (BSD-3-Clause)', path.join(root, 'src', 'data', 'hanja', 'LICENSE')]]) {
  if (fs.existsSync(file)) out += `${'='.repeat(72)}\n${name}\n${'-'.repeat(72)}\n${fs.readFileSync(file, 'utf8').trim()}\n\n`;
}
fs.writeFileSync(path.join(root, 'src', 'legal', 'THIRD_PARTY_NOTICES.txt'), out);
const strong = entries.filter((e) => /GPL|AGPL|SSPL|CC-BY-NC/i.test(e.license) && !/LGPL/i.test(e.license));
console.log(`패키지 ${entries.length}개`, counts);
if (strong.length) console.log('주의(강한 copyleft):', strong.map((e) => `${e.name} ${e.license}`).join(', '));
