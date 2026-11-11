// 실제 Kite 앱(dist-electron/main.js + vite dev)을 띄워 각 문서를 PDF 로 내보내고,
// 한글 PDF(ref)와 쪽마다 나란히 그린 PNG + 줄 위치 JSON 을 만든다. 인자는 CMP_ARGS(JSON): [url, samples, ref, out, repo, ...names]
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const [url, samples, refDir, outDir, repo, ...names] = JSON.parse(process.env.CMP_ARGS);
const SCALE = +(process.env.CMP_SCALE || 1.1);
const ONLY_PAGES = process.env.CMP_PAGES ? process.env.CMP_PAGES.split(',').map(Number) : null;
const NO_PNG = !!process.env.CMP_NOPNG;

const LOGF = path.join(__dirname, 'cmp.log');
fs.writeFileSync(LOGF, '');
const log = (...a) => { fs.appendFileSync(LOGF, a.join(' ') + '\n'); console.log(...a); };
process.on('uncaughtException', (e) => { log('UNCAUGHT', e && e.stack); app.exit(1); });
process.on('unhandledRejection', (e) => { log('UNHANDLED', (e && e.stack) || e); app.exit(1); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

process.env.VITE_DEV_SERVER_URL = url;
process.env.KITE_USER_DATA = path.join(outDir, '..', 'userdata');
require(path.join(repo, 'dist-electron', 'main.js'));

app.whenReady().then(async () => {
  let win = null;
  for (let i = 0; i < 150 && !(win = BrowserWindow.getAllWindows()[0]); i++) await sleep(200);
  win.webContents.setBackgroundThrottling(false);
  if (!process.env.CMP_SHOW) win.hide();
  let pdfData = null;
  ipcMain.removeHandler('print:pdf');
  ipcMain.handle('print:pdf', async (_e, opts) => {
    pdfData = await win.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true, margins: { top: 0, bottom: 0, left: 0, right: 0 }, pageSize: { width: opts.widthMm / 25.4, height: opts.heightMm / 25.4 } });
    return 'x.pdf';
  });
  const raw = (code) => win.webContents.executeJavaScript(code, true);
  // 멈췄을 때: 디버거로 세워 호출 스택을 적는다
  const dbg = win.webContents.debugger;
  let onPaused = null;
  if (process.env.CMP_DEBUG) {
    dbg.attach('1.3');
    dbg.on('message', (_e, method, params) => { if (method === 'Debugger.paused' && onPaused) onPaused(params.callFrames[0].callFrameId + '' + params.callFrames.slice(0, 16).map((f) => `${f.functionName || '(anon)'} ${String(f.url).split('/').slice(-2).join('/').split('?')[0]}:${f.location.lineNumber + 1}`).join('\n   ')); });
    await dbg.sendCommand('Debugger.enable');
  }
  const stackOnHang = async () => {
    if (!process.env.CMP_DEBUG) return '(CMP_DEBUG=1 로 스택을 볼 수 있다)';
    try {
      const out = [];
      for (let k = 0; k < 3; k++) {
        const got = new Promise((res) => { onPaused = res; });
        dbg.sendCommand('Debugger.pause').catch(() => {});
        const got1 = await Promise.race([got, sleep(8000).then(() => 'no pause')]);
        const [fid, st] = got1.includes('') ? got1.split('') : [null, got1];
        let ev = '';
        if (fid) { try { const r = await dbg.sendCommand('Debugger.evaluateOnCallFrame', { callFrameId: fid, expression: process.env.CMP_EVAL || 'JSON.stringify((window.__pgTrace||[]).slice(-4))', returnByValue: true }); ev = '\n   EVAL: ' + JSON.stringify(r.result.value).slice(0, 3000); } catch (e) { ev = ' eval failed ' + e.message; } }
        out.push(st + ev);
        dbg.sendCommand('Debugger.resume').catch(() => {});
        await sleep(700);
      }
      return out.join('\n  --\n   ');
    } catch (e) { return 'stack failed: ' + e.message; }
  };
  const js = (code) => Promise.race([raw(code), sleep(+(process.env.CMP_TIMEOUT || 240000)).then(async () => { const st = await stackOnHang(); log('HANG STACK:\n   ' + st); app.exit(2); throw new Error('timeout'); })]);
  for (let i = 0; i < 150 && !(await raw('!!window.__app').catch(() => false)); i++) await sleep(200);
  await js(`(async () => {
    const pdfjs = await import('/node_modules/pdfjs-dist/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';
    window.__b64 = (b) => { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; };
    window.__load = async (b64) => pdfjs.getDocument({ data: __b64(b64), cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/' }).promise;
    window.__lines = async (page) => {
      const vp = page.getViewport({ scale: 1 });
      const tc = await page.getTextContent();
      const rows = [];
      for (const it of tc.items) {
        if (!it.str || !it.str.trim()) continue;
        const x = it.transform[4], y = vp.height - it.transform[5];
        let r = rows.find((q) => Math.abs(q.y - y) < 2.5);
        if (!r) rows.push((r = { y, parts: [] }));
        r.parts.push([x, it.str, it.width]);
      }
      return rows.sort((a, b) => a.y - b.y).map((r) => { r.parts.sort((a, b) => a[0] - b[0]); const last = r.parts[r.parts.length - 1]; return { y: Math.round(r.y * 10) / 10, x: Math.round(r.parts[0][0] * 10) / 10, x2: Math.round((last[0] + last[2]) * 10) / 10, t: r.parts.map((p) => p[1]).join('') }; });
    };
    window.__canvas = async (page, scale) => {
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
      return c;
    };
  })()`);

  fs.mkdirSync(outDir, { recursive: true });
  for (const name of names) {
    const t0 = Date.now();
    try {
      // 문서 확장자 (CMP_EXT=.hwp 면 HWP 문서. 기준 PDF 이름은 그대로 name.hwpx.pdf)
      const ext = process.env.CMP_EXT || '.hwpx';
      const b64 = fs.readFileSync(path.join(samples, name + ext)).toString('base64');
      pdfData = null;
      const info = await js(`(async () => {
        const app = window.__app;
        window.__step = 'close';
        for (const d of [...app.docs]) await app.closeTab(d.id, true);
        window.__step = 'open'; window.__pgTrace = [];
        await app.openData(${JSON.stringify(name + ext)}, __b64(${JSON.stringify(b64)}), null);
        const tab = app.active;
        if (!tab) return { error: 'no tab' };
        window.__step = 'settle';
        let last = -1, stable = 0;
        for (let i = 0; i < 200 && stable < 6; i++) {
          await new Promise((r) => setTimeout(r, 300));
          const n = tab.layout.pageCount;
          if (n === last) stable++; else { stable = 0; last = n; }
        }
        window.__step = 'export';
        await app.exportPdf(tab);
        window.__step = 'done';
        return { pages: tab.layout.pageCount, warnings: tab.warnings || [], fonts: window.__kiteFontLog ? { loaded: window.__kiteFontLog.loaded, failed: window.__kiteFontLog.failed } : null };
      })()`);
      if (info.error || !pdfData) { log(name, 'ERROR', info.error || 'no pdf'); continue; }
      // 살펴볼 것: CMP_JS 파일의 식을 화면에서 돌려 결과를 적는다
      if (process.env.CMP_JS) log('JS:', JSON.stringify(await js(fs.readFileSync(process.env.CMP_JS, 'utf8'))));
      // 화면 그대로 찍기 (CMP_SHOT=1, CMP_SHOW=1 과 함께)
      if (process.env.CMP_SHOT) { await sleep(500); fs.writeFileSync(path.join(outDir, name + '-screen.png'), (await win.webContents.capturePage()).toPNG()); }
      const pdf = pdfData;
      fs.writeFileSync(path.join(outDir, name + '.kite.pdf'), pdf);
      const ref = fs.readFileSync(path.join(refDir, name + '.hwpx.pdf')).toString('base64');
      const counts = await js(`(async () => { window.__step = 'pdfload'; window.__ref = await __load(${JSON.stringify(ref)}); window.__kite = await __load(${JSON.stringify(pdf.toString('base64'))}); return [__ref.numPages, __kite.numPages]; })()`);
      const lines = { ref: [], kite: [] };
      const n = Math.max(counts[0], counts[1]);
      for (let p = 1; p <= n; p++) {
        const wantPng = !NO_PNG && (!ONLY_PAGES || ONLY_PAGES.includes(p));
        const r = await js(`(async () => {
          const p = ${p};
          window.__step = 'page ' + p;
          const a = p <= __ref.numPages ? await __ref.getPage(p) : null;
          const b = p <= __kite.numPages ? await __kite.getPage(p) : null;
          const out = { ref: a ? await __lines(a) : null, kite: b ? await __lines(b) : null, png: null };
          if (${wantPng}) {
            const ca = a ? await __canvas(a, ${SCALE}) : null, cb = b ? await __canvas(b, ${SCALE}) : null;
            const w = Math.max(ca ? ca.width : 0, cb ? cb.width : 0), h = Math.max(ca ? ca.height : 0, cb ? cb.height : 0);
            const c = document.createElement('canvas'); c.width = w * 2 + 6; c.height = h;
            const ctx = c.getContext('2d'); ctx.fillStyle = '#c33'; ctx.fillRect(0, 0, c.width, c.height);
            if (ca) ctx.drawImage(ca, 0, 0); else { ctx.fillStyle = '#888'; ctx.fillRect(0, 0, w, h); }
            if (cb) ctx.drawImage(cb, w + 6, 0); else { ctx.fillStyle = '#888'; ctx.fillRect(w + 6, 0, w, h); }
            out.png = c.toDataURL('image/png').split(',')[1];
          }
          return out;
        })()`);
        lines.ref.push(r.ref); lines.kite.push(r.kite);
        if (r.png) fs.writeFileSync(path.join(outDir, `${name}-p${String(p).padStart(2, '0')}.png`), Buffer.from(r.png, 'base64'));
      }
      fs.writeFileSync(path.join(outDir, name + '.lines.json'), JSON.stringify(lines));
      log(name, 'hangul pages', counts[0], 'kite pages', counts[1], 'warnings', JSON.stringify(info.warnings), 'fonts', JSON.stringify(info.fonts), ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (e) {
      log(name, 'FAILED', (e && e.message) || e);
    }
  }
  app.exit(0);
});
