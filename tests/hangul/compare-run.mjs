// 한글 PDF 와 Kite PDF 견주기: (저장소 폴더에서, vite 를 5183 에 띄우고 dist-electron 을 만든 뒤)
//   CMP_DIR=작업폴더 node tests/hangul/compare-run.mjs s1 s2 ...   → 그 뒤 node tests/hangul/compare-diff.mjs 작업폴더/out s1 [-v]
//   — env CMP_* 는 그대로 넘어간다
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = process.cwd();
const require = createRequire(path.join(repo, 'package.json'));
const here = path.dirname(fileURLToPath(import.meta.url));
// 작업 폴더(CMP_DIR): samples/*.hwpx 와 ref/*.hwpx.pdf(한글이 만든 PDF: hwpcheck.ps1)를 두면 out/ 에 결과가 나온다
const S = process.env.CMP_DIR || path.dirname(here);
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.CMP_ARGS = JSON.stringify(['http://localhost:5183/', path.join(S, 'samples'), path.join(S, 'ref'), path.join(S, 'out'), repo, ...process.argv.slice(2)]);
// 소스를 고친 직후에는 개발 서버가 화면을 다시 불러와 첫 실행이 멈출 수 있다: 한 번 더 해 본다
let r;
for (let attempt = 0; attempt < 2; attempt++) {
  r = spawnSync(require('electron'), [path.join(here, 'compare.cjs')], { env, encoding: 'utf8', maxBuffer: 1 << 26, timeout: +(process.env.RUN_TIMEOUT || 540000) });
  if (r.status !== 2) break;
}
console.log((r.stdout || '').trim());
if (r.status) console.log('status', r.status, (r.stderr || '').slice(-1500));
