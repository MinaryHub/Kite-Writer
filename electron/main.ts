import { app, BrowserWindow, dialog, ipcMain, shell, Menu, session } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { initMcpHost, isMcpBridge, runMcpBridge } from './mcp';
import { setupCollab } from './collab';
import { STORE_BUILD } from './flags';
import { setupSupport } from './support';
import { listPrivateFonts, readPrivateFont } from './fonts';

/** AI 앱이 실행한 MCP 다리(Kite.exe --mcp): 창 없이 표준 입출력으로만 동작한다 */
const MCP_BRIDGE = isMcpBridge();
if (MCP_BRIDGE) {
  // 다리는 화면을 그리지 않는다: GPU·캐시를 끄고, 브라우저 캐시는 임시 폴더로 보낸다
  // (실행 중인 Kite 와 같은 데이터 폴더의 캐시를 두고 다투지 않게. 토큰·파이프 기록은 userData 에 그대로 둔다)
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
  app.commandLine.appendSwitch('disk-cache-size', '1');
  app.setPath('sessionData', path.join(os.tmpdir(), 'kite-mcp-bridge'));
}

const isDev = !!process.env.VITE_DEV_SERVER_URL;
let mainWindow: BrowserWindow | null = null;
let forceClose = false;
const pendingFiles: string[] = [];

const DOC_EXT = /\.(hwp|hwpx|docx|doc|pdf|md|markdown|txt|html?)$/i;

/** 로컬 절대 경로만 (네트워크 공유 \\server\share 는 열지 않는다: 접속/인증 시도를 막기 위해) */
function isLocalAbsolute(p: unknown): p is string {
  return typeof p === 'string' && p.length > 0 && p.length < 4096 && path.isAbsolute(p) && !/^[\\/]{2}/.test(p) && !p.includes('\0');
}

function filesFromArgv(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') || !DOC_EXT.test(a)) continue;
    const abs = path.resolve(a);
    if (!isLocalAbsolute(abs) || !fs.existsSync(abs)) continue;
    allowPath(abs);
    out.push(abs);
  }
  return out;
}

// ---------------- 경로 허용 목록 ----------------
// 렌더러(문서 파서가 도는 곳)가 임의 경로를 읽고 쓰지 못하도록, 주 프로세스가 직접 알게 된 경로만 허용한다:
// 열기/저장 대화상자 결과, 실행 인자, 최근 문서 목록, 자동 저장에 기록된 문서 경로.
const allowedPaths = new Set<string>();
const pathKey = (p: string) => path.resolve(p).toLowerCase();
/**
 * 주 프로세스가 허용했던 경로의 영구 목록 (userData/known-paths.json).
 * 자동 저장 파일은 렌더러가 내용을 쓰므로, 거기 적힌 경로는 이 목록에 있을 때만 다시 허용한다.
 */
let knownPaths: Set<string> | null = null;
const knownPathsFile = () => path.join(app.getPath('userData'), 'known-paths.json');
function loadKnownPaths(): Set<string> {
  if (knownPaths) return knownPaths;
  try {
    const raw = JSON.parse(fs.readFileSync(knownPathsFile(), 'utf8'));
    knownPaths = new Set(Array.isArray(raw) ? raw.filter((x: unknown) => typeof x === 'string').slice(-500) : []);
  } catch {
    knownPaths = new Set();
  }
  return knownPaths;
}
let knownSaveTimer: NodeJS.Timeout | null = null;
function rememberPath(key: string) {
  const set = loadKnownPaths();
  if (set.has(key)) return;
  set.add(key);
  if (knownSaveTimer) clearTimeout(knownSaveTimer);
  knownSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(knownPathsFile()), { recursive: true });
      fs.writeFileSync(knownPathsFile(), JSON.stringify([...set].slice(-500)));
    } catch {
      /* 무시 */
    }
  }, 300);
}
function allowPath(p: string) {
  if (!isLocalAbsolute(p)) return;
  const key = pathKey(p);
  allowedPaths.add(key);
  rememberPath(key);
}
/** 저장할 수 있는 문서 확장자 */
const SAVE_EXT = /\.(hwp|hwpx|docx|md|markdown|txt|html?|pdf)$/i;
function assertAllowed(p: unknown, what: string): string {
  if (!isLocalAbsolute(p) || !allowedPaths.has(pathKey(p))) throw new Error(`${what}: 허용되지 않은 경로입니다.`);
  return p;
}

// 예전 이름(K-HWP) 때의 설정 폴더(최근 문서·환경 설정·자동 저장·AI 키)를 새 폴더로 옮긴다.
// 새 폴더에 아직 설정이 없을 때 한 번만 복사하고, 예전 폴더는 그대로 둔다.
function migrateOldUserData() {
  try {
    const target = app.getPath('userData');
    if (fs.existsSync(path.join(target, 'prefs.json')) || fs.existsSync(path.join(target, 'recent.json'))) return;
    const appData = app.getPath('appData');
    const old = ['K-HWP 워드프로세서', 'K-HWP'].map((n) => path.join(appData, n)).find((p) => fs.existsSync(p));
    if (!old) return;
    const SKIP = /^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|blob_storage|Crashpad|SingletonLock|SingletonCookie|SingletonSocket|lockfile)$/i;
    fs.mkdirSync(target, { recursive: true });
    for (const name of fs.readdirSync(old)) {
      if (SKIP.test(name)) continue;
      try {
        fs.cpSync(path.join(old, name), path.join(target, name), { recursive: true, force: false, errorOnExist: false });
      } catch {
        /* 사용 중인 파일 등은 건너뜀 */
      }
    }
  } catch {
    /* 무시 */
  }
}
if (!process.env.KITE_SMOKE && !process.env.KITE_USER_DATA && !MCP_BRIDGE) migrateOldUserData();
app.setAppUserModelId('com.minary.kite');

/** 창 아이콘 (배포본: dist/icon.png, 개발: public/icon.png) */
function appIcon(): string | undefined {
  for (const p of [path.join(__dirname, '../dist/icon.png'), path.join(__dirname, '../public/icon.png')]) if (fs.existsSync(p)) return p;
  return undefined;
}

// 자가 점검 실행은 별도 데이터 폴더를 써서 사용 중인 Kite 창과 섞이지 않게 한다
if (process.env.KITE_SMOKE) app.setPath('userData', path.join(os.tmpdir(), 'kite-smoke-' + process.pid));
// 개발/시험 실행(배포본 아님)에서만: 데이터 폴더 지정 (MCP 종단 간 시험 등)
if (!app.isPackaged && process.env.KITE_USER_DATA) app.setPath('userData', process.env.KITE_USER_DATA);

// MCP 다리는 실행 중인 Kite 와 따로 돌아야 하므로 단일 실행 잠금을 쓰지 않는다
const gotLock = MCP_BRIDGE ? true : app.requestSingleInstanceLock();
if (MCP_BRIDGE) {
  // 다리 모드: 아래 창 만들기 등은 건너뛴다
} else if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const files = filesFromArgv(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (files.length) mainWindow.webContents.send('app:open-files', files);
    }
  });
}

if (!MCP_BRIDGE) pendingFiles.push(...filesFromArgv(process.argv));

// macOS: Finder 에서 두 번 누르거나 '다음으로 열기'·open 명령으로 넘긴 파일은 명령줄이 아니라 open-file 이벤트로 온다
// (앱이 준비되기 전에도 올 수 있으므로 일찍 등록한다)
let initialFilesTaken = false;
if (!MCP_BRIDGE) {
  app.on('open-file', (e, p) => {
    e.preventDefault();
    const files = filesFromArgv(['', p]);
    if (!files.length) return;
    if (mainWindow && initialFilesTaken) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      mainWindow.webContents.send('app:open-files', files);
    } else pendingFiles.push(...files);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    title: 'Kite',
    icon: appIcon(),
    backgroundColor: '#e9ebee',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: true,
    },
  });
  Menu.setApplicationMenu(null);
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize();
    mainWindow?.show();
  });
  if (isDev) mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

  // 자가 점검 (KITE_SMOKE=1): 문서를 연 뒤 상태를 출력하고 종료
  if (process.env.KITE_SMOKE) {
    mainWindow.webContents.on('console-message', (_e, _l, msg) => console.log('[renderer]', msg));
    mainWindow.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          const r = await mainWindow!.webContents.executeJavaScript(
            `(async () => { const d = [...document.querySelectorAll('.doc-tab .dt-title')].map(e => e.textContent); const ai = window.kite ? await window.kite.aiKeyStatus() : null; let readDenied = false; try { await window.kite.readFile('C:\\Windows\\win.ini'); } catch { readDenied = true; } let writeDenied = false; try { await window.kite.writeFile('C:\\Windows\\Temp\\kite-smoke-x.txt', new Uint8Array(1)); } catch { writeDenied = true; } const fonts = [...document.fonts].map(f => f.family).filter(f => f !== 'kite-sym'); const fontLog = window.__kiteFontLog || null; return JSON.stringify({ tabs: d, pages: document.querySelectorAll('.workspace:not(.hidden-doc) .paper').length, title: document.title, hasApi: !!window.kite, ai, readDenied, writeDenied, fonts, fontLog }); })()`,
          );
          fs.writeFileSync(process.env.KITE_SMOKE!, 'SMOKE ' + r);
        } catch (e) {
          fs.writeFileSync(process.env.KITE_SMOKE!, 'SMOKE-ERR ' + String(e));
        }
        forceClose = true;
        app.exit(0);
      }, 8000);
    });
  }
  mainWindow.on('close', (e) => {
    if (forceClose) return;
    e.preventDefault();
    mainWindow?.webContents.send('app:request-close');
  });
  mainWindow.on('closed', () => (mainWindow = null));
  // Windows 로그오프/시스템 종료: 물어볼 시간이 없으므로 바로 자동 저장만 하고 끝낸다
  mainWindow.on('session-end' as any, async () => {
    await flushAutosave();
    forceClose = true;
    app.exit(0);
  });
  // 편집 화면이 죽었을 때: 자동 저장 파일은 남아 있으므로 다시 열어 복구를 제안한다
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit' || !mainWindow) return;
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'error',
      title: 'Kite',
      message: '편집 화면이 비정상적으로 종료되었습니다.',
      detail: `원인: ${details.reason}\n다시 열면 자동 저장된 문서를 복구할 수 있습니다.`,
      buttons: ['다시 열기', '끝내기'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r === 0) mainWindow.reload();
    else {
      forceClose = true;
      app.exit(1);
    }
  });
  mainWindow.on('unresponsive', () => {
    if (!mainWindow) return;
    const r = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      title: 'Kite',
      message: '응답이 없습니다. 큰 문서를 처리하는 중일 수 있습니다.',
      buttons: ['기다리기', '강제 종료'],
      defaultId: 0,
      cancelId: 0,
    });
    if (r === 1) {
      forceClose = true;
      app.exit(1);
    }
  });
  // 앱 화면은 다른 주소로 이동하지 않는다 (AI 응답 속 링크 등은 외부 브라우저로)
  // 앱 화면은 다른 주소로 이동하지 않고 새 창도 열지 않는다.
  // 링크는 렌더러가 확인을 거쳐 shell:open-external 로만 연다 (가운데 클릭 등으로 확인을 건너뛰지 못하게).
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url !== mainWindow?.webContents.getURL()) e.preventDefault();
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 개발자 도구는 개발 모드(또는 KITE_DEBUG)에서만
  if (isDev || process.env.KITE_DEBUG) {
    mainWindow.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') mainWindow?.webContents.toggleDevTools();
    });
  }
  try {
    session.defaultSession.setSpellCheckerLanguages(['en-US']);
  } catch {
    /* 무시 */
  }
}

app.whenReady().then(() => {
  if (MCP_BRIDGE) {
    runMcpBridge().catch((e) => {
      console.error('[mcp]', e);
      app.exit(1);
    });
    return;
  }
  // 이미 실행 중인 Kite 가 있으면(잠금 실패) 아무것도 시작하지 않는다 (파일은 기존 창으로 넘어갔다)
  if (!gotLock) return;
  // 웹 권한(카메라·마이크·위치·알림 등)은 쓰지 않으므로 모두 거부한다
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED_PERMISSIONS.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
  sweepStaleTemp();
  createWindow();
  initMcpHost(() => mainWindow);
  setupCollab();
  setupSupport();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (MCP_BRIDGE) return;
  if (process.platform !== 'darwin') app.quit();
});

// 창 닫기 외의 종료 요청(앱 메뉴, 시스템)도 저장 확인을 거친다
app.on('before-quit', (e) => {
  if (forceClose || !mainWindow || mainWindow.isDestroyed()) return;
  e.preventDefault();
  mainWindow.webContents.send('app:request-close');
});

/** 렌더러에 자동 저장을 요청하고 끝날 때까지(최대 2초) 기다린다 */
function flushAutosave(): Promise<void> {
  return new Promise((resolve) => {
    if (!mainWindow || mainWindow.isDestroyed()) return resolve();
    const timer = setTimeout(resolve, 2000);
    ipcMain.once('autosave:flushed', () => {
      clearTimeout(timer);
      resolve();
    });
    mainWindow.webContents.send('app:autosave-now');
  });
}

// 끌어다 놓은 파일: preload 가 실제 File 객체에서 얻은 경로만 들어온다 (렌더러가 임의 문자열을 보낼 수 없다)
ipcMain.on('file:dropped', (_e, p: unknown) => {
  if (isLocalAbsolute(p) && DOC_EXT.test(p)) allowPath(p);
});

// ---------------- 파일 ----------------
const userData = () => app.getPath('userData');

ipcMain.handle('app:initial-files', () => {
  initialFilesTaken = true;
  const f = [...pendingFiles];
  pendingFiles.length = 0;
  return f;
});

ipcMain.handle('file:open-dialog', async (_e, filters) => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: '불러오기',
    properties: ['openFile', 'multiSelections'],
    filters,
  });
  if (res.canceled) return [];
  res.filePaths.forEach(allowPath);
  return res.filePaths;
});

ipcMain.handle('file:read', async (_e, p: string) => {
  const buf = await fs.promises.readFile(assertAllowed(p, '읽기'));
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
});

ipcMain.handle('file:save-dialog', async (_e, defaultPath: string, filters) => {
  const res = await dialog.showSaveDialog(mainWindow!, { title: '다른 이름으로 저장', defaultPath: typeof defaultPath === 'string' ? defaultPath : undefined, filters });
  if (res.canceled || !res.filePath) return null;
  allowPath(res.filePath);
  return res.filePath;
});

const MAX_WRITE = 512 * 1024 * 1024;
ipcMain.handle('file:write', async (_e, p: string, data: Uint8Array) => {
  const target = assertAllowed(p, '저장');
  if (!SAVE_EXT.test(target)) throw new Error('저장: 지원하지 않는 파일 형식입니다.');
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_WRITE) throw new Error('저장할 내용이 올바르지 않습니다.');
  // 안전한 저장: 임시 파일에 쓴 뒤 교체. 실패하면 임시 파일을 남기지 않는다
  const tmp = target + '.kite-tmp';
  try {
    await fs.promises.writeFile(tmp, Buffer.from(data));
    await fs.promises.rename(tmp, target);
  } catch (e) {
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
  return true;
});

ipcMain.handle('file:image-dialog', async () => {
  const res = await dialog.showOpenDialog(mainWindow!, {
    title: '그림 넣기',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '그림 파일', extensions: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg'] }],
  });
  if (res.canceled) return [];
  return Promise.all(
    res.filePaths.map(async (p) => {
      const buf = await fs.promises.readFile(p);
      return { name: path.basename(p), data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
    }),
  );
});

ipcMain.handle('shell:show-item', (_e, p: string) => shell.showItemInFolder(assertAllowed(p, '폴더 열기')));
ipcMain.handle('shell:open-external', (_e, url: string) => {
  if (typeof url === 'string' && url.length < 2048 && /^(https?|mailto):/i.test(url)) shell.openExternal(url);
});

// ---------------- 최근 문서 ----------------
const recentPath = () => path.join(userData(), 'recent.json');
function readRecent(): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(recentPath(), 'utf8'));
    const list: string[] = Array.isArray(raw) ? raw.filter((p: unknown) => isLocalAbsolute(p) && fs.existsSync(p)) : [];
    list.forEach(allowPath);
    return list;
  } catch {
    return [];
  }
}
ipcMain.handle('recent:get', () => readRecent());
ipcMain.handle('recent:add', (_e, p: string) => {
  // 이미 열거나 저장한(허용된) 경로만 최근 목록에 넣는다
  assertAllowed(p, '최근 문서');
  const list = [p, ...readRecent().filter((x) => x !== p)].slice(0, 15);
  fs.mkdirSync(userData(), { recursive: true });
  fs.writeFileSync(recentPath(), JSON.stringify(list));
  try {
    app.addRecentDocument(p);
  } catch {
    /* 무시 */
  }
  return list;
});
ipcMain.handle('recent:clear', () => {
  try {
    fs.unlinkSync(recentPath());
  } catch {
    /* 무시 */
  }
  return [];
});

// ---------------- 설정 ----------------
const prefsPath = () => path.join(userData(), 'prefs.json');
ipcMain.handle('prefs:get', () => {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(), 'utf8'));
  } catch {
    return {};
  }
});
ipcMain.handle('prefs:set', (_e, prefs) => {
  if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new Error('설정 형식이 올바르지 않습니다.');
  const json = JSON.stringify(prefs, null, 2);
  if (json.length > 64 * 1024) throw new Error('설정이 너무 큽니다.');
  fs.mkdirSync(userData(), { recursive: true });
  fs.writeFileSync(prefsPath(), json);
  try {
    session.defaultSession.setSpellCheckerLanguages(prefs.spellcheck ? ['en-US'] : []);
  } catch {
    /* 무시 */
  }
  return true;
});

// ---------------- 자동 저장 / 복구 ----------------
const autosaveDir = () => path.join(userData(), 'autosave');
/** 자동 저장 id 는 docTab 이 만드는 형식만 (경로 조작 방지) */
function autosaveFile(id: unknown): string {
  if (typeof id !== 'string' || !/^doc-[a-z0-9]{1,24}-\d{1,9}$/.test(id)) throw new Error('자동 저장 id 가 올바르지 않습니다.');
  return path.join(autosaveDir(), `${id}.json`);
}
ipcMain.handle('autosave:write', async (_e, id: string, json: string) => {
  const file = autosaveFile(id);
  if (typeof json !== 'string' || json.length > 256 * 1024 * 1024) throw new Error('자동 저장 내용이 올바르지 않습니다.');
  await fs.promises.mkdir(autosaveDir(), { recursive: true });
  // 쓰는 도중 꺼져도 깨진 복구 파일이 남지 않도록 임시 파일에 쓴 뒤 교체
  const tmp = file + '.tmp';
  await fs.promises.writeFile(tmp, json, 'utf8');
  await fs.promises.rename(tmp, file);
  return true;
});
ipcMain.handle('autosave:remove', async (_e, id: string) => {
  try {
    await fs.promises.unlink(autosaveFile(id));
  } catch {
    /* 무시 */
  }
  return true;
});
ipcMain.handle('autosave:list', async () => {
  try {
    const files = await fs.promises.readdir(autosaveDir());
    const out: { id: string; json: string; mtime: number }[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(autosaveDir(), f);
      const st = await fs.promises.stat(p);
      const json = await fs.promises.readFile(p, 'utf8');
      // 복구된 문서를 원래 자리에 다시 저장할 수 있도록 기록된 경로를 허용한다
      try {
        const docPath = JSON.parse(json)?.path;
        if (isLocalAbsolute(docPath) && DOC_EXT.test(docPath) && loadKnownPaths().has(pathKey(docPath))) allowedPaths.add(pathKey(docPath));
      } catch {
        /* 무시 */
      }
      out.push({ id: f.replace(/\.json$/, ''), json, mtime: st.mtimeMs });
    }
    return out;
  } catch {
    return [];
  }
});

// ---------------- 인쇄 / PDF ----------------
ipcMain.handle('print:pdf', async (_e, opts: { widthMm: number; heightMm: number; defaultPath: string; path?: string }) => {
  if (!mainWindow) return null;
  // 다른 이름으로 저장에서 이미 고른 경로가 있으면 대화상자를 다시 띄우지 않는다
  let filePath: string;
  if (opts.path) {
    filePath = assertAllowed(opts.path, 'PDF 저장');
    if (!/\.pdf$/i.test(filePath)) throw new Error('PDF 저장: 확장자가 .pdf 가 아닙니다.');
  }
  else {
    const target = await dialog.showSaveDialog(mainWindow, {
      title: 'PDF로 저장',
      defaultPath: typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      filters: [{ name: 'PDF 문서', extensions: ['pdf'] }],
    });
    if (target.canceled || !target.filePath) return null;
    filePath = target.filePath;
    allowPath(filePath);
  }
  const target = { filePath };
  const data = await mainWindow.webContents.printToPDF({
    printBackground: true,
    preferCSSPageSize: true,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    pageSize: { width: opts.widthMm / 25.4, height: opts.heightMm / 25.4 },
  });
  await fs.promises.writeFile(target.filePath, data);
  return target.filePath;
});

ipcMain.handle('print:print', async (_e, opts: { widthMm: number; heightMm: number; landscape: boolean }) => {
  if (!mainWindow) return false;
  return new Promise((resolve) => {
    mainWindow!.webContents.print(
      {
        silent: false,
        printBackground: true,
        margins: { marginType: 'none' },
        pageSize: { width: Math.round(opts.widthMm * 1000), height: Math.round(opts.heightMm * 1000) },
      },
      (ok) => resolve(ok),
    );
  });
});

// ---------------- 편집 (붙이기 등) ----------------
ipcMain.handle('edit:paste', () => mainWindow?.webContents.paste());
ipcMain.handle('edit:paste-plain', () => mainWindow?.webContents.pasteAndMatchStyle());

ipcMain.handle('app:set-title', (_e, title: string) => mainWindow?.setTitle(title));
ipcMain.handle('app:close-confirmed', () => {
  forceClose = true;
  mainWindow?.close();
});
ipcMain.handle('app:toggle-fullscreen', () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()));
ipcMain.handle('app:version', () => app.getVersion());

ipcMain.handle('app:flags', () => ({ store: STORE_BUILD }));

// ---------------- PowerShell ----------------
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/**
 * 스크립트를 표준 입력으로 넘긴다 (-Command -).
 * 실행 정책을 건너뛰는 옵션(-ExecutionPolicy Bypass)이나 인코딩된 명령(-EncodedCommand)은 쓰지 않는다:
 * 악성 코드가 흔히 쓰는 형태라 스토어 심사·백신에 걸릴 수 있다. 표준 입력의 명령은 실행 정책 대상도 아니다.
 * 스크립트는 ASCII 만 쓰고, 파일 경로 같은 값은 환경 변수(env)로 넘긴다 (콘솔 코드 페이지와 상관없이 한글 경로가 안전).
 */
function runPowerShell(script: string, opts: { timeout?: number; maxBuffer?: number; env?: Record<string, string> } = {}): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command', '-'],
      { timeout: opts.timeout ?? 60000, maxBuffer: opts.maxBuffer ?? 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, ...(opts.env || {}) } },
      (err, stdout) => resolve({ ok: !err, stdout: String(stdout || '') }),
    );
    child.stdin?.end(script + '\r\nexit $LASTEXITCODE\r\n');
  });
}

/** 오래된 변환용 임시 폴더(kite-*) 정리: 변환이 중단되면 남을 수 있다 */
function sweepStaleTemp() {
  try {
    const tmp = os.tmpdir();
    const limit = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(tmp)) {
      if (!/^kite-[A-Za-z0-9]{6}$/.test(name)) continue;
      const p = path.join(tmp, name);
      try {
        if (fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        /* 사용 중이면 다음에 */
      }
    }
  } catch {
    /* 무시 */
  }
}

// ---------------- 시스템 글꼴 목록 ----------------
let fontCache: string[] | null = null;
ipcMain.handle('fonts:list', async () => {
  if (fontCache) return fontCache;
  if (process.platform !== 'win32') return [];
  const script =
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Add-Type -AssemblyName System.Drawing; (New-Object System.Drawing.Text.InstalledFontCollection).Families | ForEach-Object { $_.Name }";
  const r = await runPowerShell(script);
  fontCache = r.ok
    ? r.stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return fontCache;
});

// 한컴오피스가 자기 폴더에만 두는 글꼴 (HY헤드라인M 등): 이름 목록과 파일 바이트
// 스토어판에서는 쓰지 않는다: 한컴오피스용으로 허가된 글꼴을 다른 앱에서 쓰는 것은 라이선스 문제가 될 수 있다
ipcMain.handle('fonts:private-list', async () => (STORE_BUILD ? [] : listPrivateFonts().map((f) => f.names)));
ipcMain.handle('fonts:private-read', async (_e, name: unknown) => {
  if (STORE_BUILD || typeof name !== 'string') return null;
  return readPrivateFont(name);
});

// ---------------- 구형 DOC 변환 ----------------
ipcMain.handle('doc:convert', async (_e, data: Uint8Array) => {
  if (!(data instanceof Uint8Array) || data.byteLength > MAX_WRITE) throw new Error('DOC 내용이 올바르지 않습니다.');
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kite-'));
  const src = path.join(tmpDir, 'input.doc');
  const dst = path.join(tmpDir, 'output.docx');
  await fs.promises.writeFile(src, Buffer.from(data));
  try {
    // 1) Microsoft Word가 설치되어 있으면 COM 자동화로 DOCX 변환 (서식 유지)
    if (process.platform === 'win32') {
      // 사용자가 이미 Word를 쓰고 있으면 그 인스턴스에 붙을 수 있으므로,
      // 우리가 새로 띄운 경우에만 숨기고 종료한다.
      // 신뢰할 수 없는 문서이므로 매크로를 강제로 끄고(AutomationSecurity=3) 연결 갱신도 막는다.
      // 임시 파일에 다시 쓰면 다운로드 표식(MOTW)이 사라져 Office 의 매크로 차단이 적용되지 않기 때문이다.
      // 경로는 환경 변수로 넘긴다 (스크립트는 ASCII 만)
      const ps = [
        "$ErrorActionPreference='Stop'",
        '$running = @(Get-Process WINWORD -ErrorAction SilentlyContinue).Count -gt 0',
        '$w = New-Object -ComObject Word.Application',
        'if (-not $running) { $w.Visible = $false }',
        '$w.DisplayAlerts = 0',
        '$prevSec = $w.AutomationSecurity',
        '$w.AutomationSecurity = 3',
        'try { $w.Options.UpdateLinksAtOpen = $false } catch {}',
        'try { $d = $w.Documents.Open($env:KITE_DOC_SRC, $false, $true, $false); $d.SaveAs2($env:KITE_DOC_DST, 16); $d.Close($false) } finally { $w.AutomationSecurity = $prevSec; if (-not $running -and $w.Documents.Count -eq 0) { $w.Quit() } }',
      ].join('; ');
      const { ok } = await runPowerShell(`try { ${ps} } catch { exit 1 }`, { timeout: 60000, env: { KITE_DOC_SRC: src, KITE_DOC_DST: dst } });
      if (ok && fs.existsSync(dst)) {
        const buf = await fs.promises.readFile(dst);
        return { kind: 'docx', data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
      }
      // 2) LibreOffice
      const soffice = ['C:/Program Files/LibreOffice/program/soffice.exe', 'C:/Program Files (x86)/LibreOffice/program/soffice.exe'].find((p) => fs.existsSync(p));
      if (soffice) {
        const ok2 = await new Promise<boolean>((resolve) => {
          execFile(soffice, ['--headless', '--convert-to', 'docx', '--outdir', tmpDir, src], { timeout: 90000, windowsHide: true }, (err) => resolve(!err));
        });
        const out2 = path.join(tmpDir, 'input.docx');
        if (ok2 && fs.existsSync(out2)) {
          const buf = await fs.promises.readFile(out2);
          return { kind: 'docx', data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
        }
      }
    }
    // 3) 텍스트 추출
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const WordExtractor = require('word-extractor');
    const extractor = new WordExtractor();
    const doc = await extractor.extract(Buffer.from(data));
    return {
      kind: 'text',
      body: doc.getBody(),
      headers: doc.getHeaders({ includeFooters: false }),
      footers: doc.getFooters(),
      footnotes: doc.getFootnotes(),
    };
  } catch (e: any) {
    return { kind: 'error', message: 'DOC 파일을 읽을 수 없습니다: ' + (e?.message || e) };
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------- AI 도우미 ----------------
import { abortChat, keyStatus, listModels, setKey, startChat, type ChatRequest, type Provider } from './ai';

ipcMain.handle('ai:key-status', () => keyStatus());
ipcMain.handle('ai:set-key', (_e, p: Provider, key: string | null) => {
  if (!PROVIDERS.has(p) || (key != null && (typeof key !== 'string' || key.length > 512))) throw new Error('키 형식이 올바르지 않습니다.');
  setKey(p, key);
  return keyStatus();
});
ipcMain.handle('ai:models', async (_e, p: Provider) => {
  if (!PROVIDERS.has(p)) return { ok: false, error: '알 수 없는 AI 제공자입니다.' };
  try {
    return { ok: true, models: await listModels(p) };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
});
const PROVIDERS = new Set(['claude', 'openai', 'gemini', 'ollama']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const MAX_CHAT_CHARS = 2 * 1024 * 1024;
/** 렌더러에서 온 요청을 검사해 정리한 사본을 돌려준다 */
function validateChat(req: any): ChatRequest {
  if (!req || typeof req !== 'object') throw new Error('요청이 올바르지 않습니다.');
  if (!PROVIDERS.has(req.provider)) throw new Error('알 수 없는 AI 제공자입니다.');
  if (typeof req.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(req.id)) throw new Error('요청 id 가 올바르지 않습니다.');
  if (typeof req.model !== 'string' || !/^[A-Za-z0-9._:\/-]{1,128}$/.test(req.model)) throw new Error('모델 이름이 올바르지 않습니다.');
  if (!Array.isArray(req.messages) || req.messages.length === 0 || req.messages.length > 400) throw new Error('대화 내용이 올바르지 않습니다.');
  let total = typeof req.system === 'string' ? req.system.length : 0;
  const messages = req.messages.map((m: any) => {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') throw new Error('대화 내용이 올바르지 않습니다.');
    total += m.content.length;
    return { role: m.role, content: m.content };
  });
  if (total > MAX_CHAT_CHARS) throw new Error('보낼 내용이 너무 깁니다.');
  const out: ChatRequest = { id: req.id, provider: req.provider, model: req.model, system: typeof req.system === 'string' ? req.system : '', messages };
  if (req.effort != null) {
    if (!EFFORTS.has(req.effort)) throw new Error('effort 값이 올바르지 않습니다.');
    out.effort = req.effort;
  }
  return out;
}
let activeChats = 0;
ipcMain.handle('ai:chat', async (e, raw: unknown) => {
  const wc = e.sender;
  let req: ChatRequest;
  try {
    req = validateChat(raw);
  } catch (err: any) {
    const id = typeof (raw as any)?.id === 'string' ? (raw as any).id : '';
    if (!wc.isDestroyed()) wc.send('ai:event', { id, type: 'error', message: String(err?.message || err) });
    return false;
  }
  if (activeChats >= 3) {
    if (!wc.isDestroyed()) wc.send('ai:event', { id: req.id, type: 'error', message: '진행 중인 요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    return false;
  }
  activeChats++;
  startChat(req, (ev) => {
    if (!wc.isDestroyed()) wc.send('ai:event', ev);
  }).finally(() => activeChats--);
  return true;
});
ipcMain.handle('ai:abort', (_e, id: string) => {
  if (typeof id === 'string') abortChat(id);
});
