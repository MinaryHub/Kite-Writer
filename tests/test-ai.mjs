import { build } from 'esbuild';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
await build({ entryPoints: ['electron/ai.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'tests/.build/ai.mjs', logLevel: 'error',
  alias: { electron: path.resolve('tests/ai-electron-stub.mjs') }, banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
const ai = await import(pathToFileURL(path.resolve('tests/.build/ai.mjs')).href);
const run = (req) => new Promise((res) => { const evs = []; ai.startChat(req, (e) => { evs.push(e); if (e.type !== 'delta') res(evs); }); });
const msg = [{ role: 'user', content: '안녕' }];
for (const p of ['claude', 'openai', 'gemini']) ai.setKey(p, null);
console.log('no key  :', JSON.stringify((await run({ id: '1', provider: 'claude', model: 'claude-opus-5-5', system: 's', messages: msg })).pop()));
ai.setKey('claude', 'sk-ant-invalid'); ai.setKey('openai', 'sk-invalid'); ai.setKey('gemini', 'AIza-invalid');
console.log('status  :', JSON.stringify(ai.keyStatus()));
for (const [p, m] of [['claude', 'claude-opus-5-5'], ['openai', 'gpt-5.5'], ['gemini', 'gemini-flash-latest']]) {
  const t0 = Date.now();
  const last = (await run({ id: p, provider: p, model: m, system: 's', messages: msg })).pop();
  console.log(p.padEnd(8), ':', JSON.stringify(last).slice(0, 200), (Date.now() - t0) + 'ms');
}
// abort
ai.setKey('claude', 'sk-ant-invalid');
const p = run({ id: 'ab', provider: 'claude', model: 'claude-opus-5-5', system: 's', messages: msg }); ai.abortChat('ab');
console.log('abort   :', JSON.stringify((await p).pop()));
for (const p of ['claude', 'openai', 'gemini']) ai.setKey(p, null);

// 로그인해 둔 계정 (ant auth login 프로필): 키가 없어도 Claude 를 쓸 수 있다고 알리고, 그 로그인 정보로 요청한다
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kite-ant-'));
  fs.mkdirSync(path.join(dir, 'configs'));
  fs.mkdirSync(path.join(dir, 'credentials'));
  fs.writeFileSync(path.join(dir, 'configs', 'default.json'), JSON.stringify({ version: '1.0', authentication: { type: 'user_oauth' } }));
  fs.writeFileSync(path.join(dir, 'credentials', 'default.json'), JSON.stringify({ version: '1.0', type: 'oauth_token', access_token: 'invalid-token-for-test' }), { mode: 0o600 });
  const saved = { dir: process.env.ANTHROPIC_CONFIG_DIR, key: process.env.ANTHROPIC_API_KEY, tok: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  console.log('no login:', await ai.refreshClaudeLogin(), ai.keyStatus().claude);
  process.env.ANTHROPIC_CONFIG_DIR = dir;
  console.log('login   :', await ai.refreshClaudeLogin(), ai.keyStatus().claude);
  const last = (await run({ id: 'lg', provider: 'claude', model: 'claude-opus-5-5', system: 's', messages: msg })).pop();
  console.log('login req:', JSON.stringify(last).slice(0, 220));
  for (const [k, v] of [['ANTHROPIC_CONFIG_DIR', saved.dir], ['ANTHROPIC_API_KEY', saved.key], ['ANTHROPIC_AUTH_TOKEN', saved.tok]]) v == null ? delete process.env[k] : (process.env[k] = v);
  fs.rmSync(dir, { recursive: true, force: true });
}
