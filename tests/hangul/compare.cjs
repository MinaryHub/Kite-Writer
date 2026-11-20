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
    // CMP_CROP="x,y,w,h"(pt): 쪽의 그 부분만 크게 그린다 (CMP_SCALE 과 함께)
    window.__crop = ${JSON.stringify(process.env.CMP_CROP ? process.env.CMP_CROP.split(',').map(Number) : null)};
    window.__canvas = async (page, scale) => {
      const cr = window.__crop;
      const vp = cr ? page.getViewport({ scale, offsetX: -cr[0] * scale, offsetY: -cr[1] * scale }) : page.getViewport({ scale });
      const c = document.createElement('canvas'); c.width = Math.ceil(cr ? cr[2] * scale : vp.width); c.height = Math.ceil(cr ? cr[3] * scale : vp.height);
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
      // CMP_EXT 를 주지 않으면 samples 에 있는 쪽 (name.hwpx, 없으면 name.hwp)
      const ext = process.env.CMP_EXT || (fs.existsSync(path.join(samples, name + '.hwpx')) ? '.hwpx' : '.hwp');
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
      // 기준 PDF: hwpcheck.ps1 이 만든 이름(name.hwp.pdf / name.hwpx.pdf)
      const refFile = [name + ext + '.pdf', name + '.hwpx.pdf'].map((f) => path.join(refDir, f)).find((f) => fs.existsSync(f));
      if (!refFile) { log(name, 'ERROR', '기준 PDF 없음'); continue; }
      const ref = fs.readFileSync(refFile).toString('base64');
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
            // 겹쳐 보기: 한글에만 있는 것은 빨강, Kite 에만 있는 것은 청록, 둘 다 있으면 검정
            const lum = (cv) => {
              const t = document.createElement('canvas'); t.width = w; t.height = h;
              const x = t.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
              if (cv) x.drawImage(cv, 0, 0);
              const d = x.getImageData(0, 0, w, h).data; const o = new Uint8Array(w * h);
              for (let i = 0; i < o.length; i++) o[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
              return o;
            };
            const la = lum(ca), lb = lum(cb);
            const oc = document.createElement('canvas'); oc.width = w; oc.height = h;
            const ox = oc.getContext('2d'); const od = ox.createImageData(w, h);
            for (let i = 0; i < la.length; i++) { od.data[i * 4] = lb[i]; od.data[i * 4 + 1] = la[i]; od.data[i * 4 + 2] = la[i]; od.data[i * 4 + 3] = 255; }
            ox.putImageData(od, 0, 0);
            out.overlay = oc.toDataURL('image/png').split(',')[1];
            // 어긋남 점수: 한쪽에만 있는 어두운 점(2px 안에 짝이 없는 것)의 비율
            const mask = (l) => { const m = new Uint8Array(l.length); for (let i = 0; i < l.length; i++) m[i] = l[i] < 212 ? 1 : 0; return m; };
            const dil = (m, r) => {
              const t = new Uint8Array(m.length), o = new Uint8Array(m.length);
              for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r) && !v; k++) v = m[y * w + k]; t[y * w + x] = v; }
              for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let v = 0; for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r) && !v; k++) v = t[k * w + x]; o[y * w + x] = v; }
              return o;
            };
            const ma = mask(la), mb = mask(lb), dma = dil(ma, 2), dmb = dil(mb, 2);
            let na = 0, nb = 0, ua = 0, ub = 0;
            for (let i = 0; i < ma.length; i++) { if (ma[i]) { na++; if (!dmb[i]) ua++; } if (mb[i]) { nb++; if (!dma[i]) ub++; } }
            out.mis = [na, nb, ua, ub];
          }
          return out;
        })()`);
        lines.ref.push(r.ref); lines.kite.push(r.kite);
        if (r.png) fs.writeFileSync(path.join(outDir, `${name}-p${String(p).padStart(2, '0')}.png`), Buffer.from(r.png, 'base64'));
        if (r.overlay) fs.writeFileSync(path.join(outDir, `${name}-o${String(p).padStart(2, '0')}.png`), Buffer.from(r.overlay, 'base64'));
        if (r.mis) (lines.mis = lines.mis || [])[p - 1] = r.mis;
      }
      fs.writeFileSync(path.join(outDir, name + '.lines.json'), JSON.stringify(lines));
      log(name, 'hangul pages', counts[0], 'kite pages', counts[1], 'warnings', JSON.stringify(info.warnings), 'fonts', JSON.stringify(info.fonts), ((Date.now() - t0) / 1000).toFixed(1) + 's');
    } catch (e) {
      log(name, 'FAILED', (e && e.message) || e);
    }
  }
  app.exit(0);
});
