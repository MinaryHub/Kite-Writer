import { app, ipcMain, session, shell, type BrowserWindow, type WebContents } from 'electron';

/**
 * AI 도우미의 '계정 로그인' 방식: 각 회사의 공식 웹 대화창을 Kite 창 안(webview)에 띄운다.
 * 사용자는 그 웹사이트에 자기 계정으로 직접 로그인하고, 로그인 정보(쿠키)는 Kite 전용 저장소(partition)에만 남는다.
 * Kite 는 계정 암호를 보거나 저장하지 않는다.
 *
 * 안에 띄우는 것은 남의 웹 페이지이므로 권한을 좁게 준다:
 *  - 정해진 저장소(partition)와 정해진 시작 주소만 붙일 수 있다 (will-attach-webview)
 *  - preload·Node 통합 없음, 샌드박스·문맥 분리 켬
 *  - 카메라·마이크·위치·알림 등 권한은 모두 거부, 내려받기는 막는다
 *  - 새 창은 로그인 창(정해진 로그인 주소)만 허용하고 그 밖의 링크는 기본 브라우저로 연다
 */
export const AI_WEB_PARTITION = 'persist:kite-ai-web';

export interface AiWebService {
  id: string;
  label: string;
  company: string;
  url: string;
}

const SERVICES: AiWebService[] = [
  { id: 'claude', label: 'Claude', company: 'Anthropic', url: 'https://claude.ai/new' },
  { id: 'chatgpt', label: 'ChatGPT', company: 'OpenAI', url: 'https://chatgpt.com/' },
  { id: 'gemini', label: 'Gemini', company: 'Google', url: 'https://gemini.google.com/app' },
];

/** 로그인 창(새 창)으로 열어도 되는 주소: 각 서비스와 그 서비스가 쓰는 로그인 제공자 */
const AUTH_HOSTS = new Set([
  'claude.ai',
  'chatgpt.com',
  'auth.openai.com',
  'auth0.openai.com',
  'gemini.google.com',
  'accounts.google.com',
  'appleid.apple.com',
  'login.microsoftonline.com',
  'login.live.com',
]);

/**
 * 시험용 서비스 (개발 실행에서만): KITE_AI_WEB_TEST_URL 에 준 주소를 목록에 더한다.
 * 설치본(app.isPackaged)에서는 무시한다 — 띄울 수 있는 주소는 위 목록뿐이다.
 */
function services(): AiWebService[] {
  const t = !app.isPackaged ? process.env.KITE_AI_WEB_TEST_URL : '';
  if (t && /^https?:\/\//i.test(t)) return [...SERVICES, { id: 'test', label: '시험', company: '시험 서버', url: t }];
  return SERVICES;
}

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
};

/** 시작 주소로 허용하는가: 목록에 있는 서비스와 같은 출처(origin) */
function isStartUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return services().some((s) => {
    const b = new URL(s.url);
    return u.protocol === b.protocol && u.host === b.host;
  });
}

const isHttp = (url: string) => /^https?:\/\//i.test(url);
/** 마지막으로 기본 브라우저를 연 때 */
let lastExternal = 0;

/** 안에 띄운 페이지(와 그 로그인 창)의 이동·새 창을 지킨다 */
function guard(wc: WebContents, getWin: () => BrowserWindow | null, popup = false) {
  // 시험 서비스(http://localhost)만 http 를 쓴다. 그 밖에는 https 만
  const okNav = (url: string) => /^https:\/\//i.test(url) || (isHttp(url) && isStartUrl(url));
  wc.on('will-navigate', (e, url) => {
    if (!okNav(url)) e.preventDefault();
  });
  wc.on('will-redirect', (e, url) => {
    if (!okNav(url)) e.preventDefault();
  });
  wc.setWindowOpenHandler(({ url }) => {
    const host = hostOf(url);
    // 로그인 창: 같은 저장소를 쓰는 작은 창으로 (연 페이지와의 연결이 유지되어야 로그인이 끝난다)
    if (!popup && host && /^https:/i.test(url) && AUTH_HOSTS.has(host)) {
      const parent = getWin();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          ...(parent ? { parent } : {}),
          width: 520,
          height: 720,
          autoHideMenuBar: true,
          title: '로그인',
          webPreferences: { partition: AI_WEB_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false },
        },
      };
    }
    // 그 밖의 링크(답 속의 출처 등)는 기본 브라우저로. 페이지가 창을 잇달아 열지 못하게 간격을 둔다
    const now = Date.now();
    if (isHttp(url) && now - lastExternal > 1500) {
      lastExternal = now;
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  wc.on('did-create-window', (child) => guard(child.webContents, getWin, true));
}

export function setupAiWeb(getWin: () => BrowserWindow | null) {
  const ses = session.fromPartition(AI_WEB_PARTITION);
  // 웹 권한: 답 복사(클립보드 쓰기)만 허용
  const ALLOWED = new Set(['clipboard-sanitized-write']);
  ses.setPermissionRequestHandler((_wc, permission, cb) => cb(ALLOWED.has(permission)));
  ses.setPermissionCheckHandler((_wc, permission) => ALLOWED.has(permission));
  ses.on('will-download', (e) => e.preventDefault());

  ipcMain.handle('ai-web:services', () => services());
  /** 로그아웃: 이 저장소의 쿠키·저장 데이터·캐시를 모두 지운다 */
  ipcMain.handle('ai-web:clear', async () => {
    await ses.clearStorageData();
    await ses.clearCache();
    return true;
  });
}

/** 본 창에 webview 를 붙일 때의 검사와, 붙은 뒤의 지킴이를 건다 */
export function guardAiWebHost(win: BrowserWindow, getWin: () => BrowserWindow | null) {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    // 렌더러가 무엇을 적어 보내든 여기서 정한 값만 쓴다
    delete (webPreferences as any).preload;
    delete (webPreferences as any).preloadURL;
    webPreferences.nodeIntegration = false;
    webPreferences.nodeIntegrationInSubFrames = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    webPreferences.webSecurity = true;
    webPreferences.allowRunningInsecureContent = false;
    (webPreferences as any).webviewTag = false;
    if (params.partition !== AI_WEB_PARTITION || !isStartUrl(params.src)) event.preventDefault();
  });
  win.webContents.on('did-attach-webview', (_e, guest) => guard(guest, getWin));
}
