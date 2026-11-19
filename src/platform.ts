import type { KiteApi } from '../electron/preload';
import { android, isAndroid, onAndroid, handleBack, type BackOptions } from './android';

declare global {
  interface Window {
    kite?: KiteApi;
  }
}

export interface OpenedFile {
  name: string;
  path: string | null;
  data: Uint8Array;
}

const api = typeof window !== 'undefined' ? window.kite : undefined;
export const isElectron = !!api;
export { isAndroid };
/** 저장한 파일을 경로로 다시 열고 덮어쓸 수 있는가 (데스크톱 앱·안드로이드 앱) */
export const hasFilePaths = isElectron || isAndroid;

const RECENT_KEY = 'kite:recent';
const RECENT_MAX = 15;
function androidRecent(): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function saveAndroidRecent(list: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 무시 */
  }
}

function baseName(p: string) {
  return p.split(/[\\/]/).pop() || p;
}

function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    input.onchange = () => {
      resolve(Array.from(input.files || []));
      input.remove();
    };
    document.body.appendChild(input);
    input.click();
  });
}

const LS_PREFIX = 'kite:';

// 예전 이름(K-HWP) 때의 로컬 저장소 키를 새 이름으로 옮긴다 (한 번만)
try {
  if (typeof localStorage !== 'undefined' && !localStorage.getItem('kite:migrated')) {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('khwp:')) {
        const nk = 'kite:' + k.slice(5);
        if (localStorage.getItem(nk) == null) localStorage.setItem(nk, localStorage.getItem(k) || '');
      }
    }
    localStorage.setItem('kite:migrated', '1');
  }
} catch {
  /* 저장소를 쓸 수 없는 환경 */
}

export const platform = {
  isElectron,
  isAndroid,
  hasFilePaths,

  async openFiles(filters: { name: string; extensions: string[] }[]): Promise<OpenedFile[]> {
    if (api) {
      const paths = await api.openDialog(filters);
      return Promise.all(paths.map((p) => this.readPath(p)));
    }
    if (isAndroid) {
      const paths = await android.openDocuments(filters.flatMap((f) => f.extensions));
      const out: OpenedFile[] = [];
      for (const p of paths) out.push(await this.readPath(p));
      return out;
    }
    const exts = filters[0]?.extensions.map((e) => '.' + e).join(',') || '';
    const files = await pickFiles(exts);
    return Promise.all(files.map(async (f) => ({ name: f.name, path: null, data: new Uint8Array(await f.arrayBuffer()) })));
  },

  async readPath(p: string): Promise<OpenedFile> {
    if (isAndroid) return { name: baseName(p), path: p, data: await android.read(p) };
    if (!api) throw new Error('파일 경로로 열기는 데스크톱 앱에서만 가능합니다.');
    const data = await api.readFile(p);
    return { name: baseName(p), path: p, data: new Uint8Array(data) };
  },

  /** 저장 위치 선택. 브라우저에서는 파일 이름만 돌려준다. */
  async chooseSavePath(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
    if (api) return api.saveDialog(defaultName, filters);
    if (isAndroid) return android.createDocument(defaultName, filters);
    const name = window.prompt('저장할 파일 이름', defaultName);
    return name || null;
  },

  async writeFile(pathOrName: string, data: Uint8Array): Promise<void> {
    if (api) {
      await api.writeFile(pathOrName, data);
      return;
    }
    if (isAndroid) return android.write(pathOrName, data);
    const blob = new Blob([data as BlobPart]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = baseName(pathOrName);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  },

  async pickImages(): Promise<{ name: string; data: Uint8Array }[]> {
    if (api) return api.imageDialog();
    const files = await pickFiles('image/*');
    return Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })));
  },

  async print(opts: { widthMm: number; heightMm: number; landscape: boolean }) {
    if (api) return api.print(opts);
    if (isAndroid) return android.print(document.title.replace(/ - Kite$/, ''), opts.widthMm, opts.heightMm, opts.landscape);
    window.print();
    return true;
  },

  async printToPdf(opts: { widthMm: number; heightMm: number; defaultPath: string; path?: string }): Promise<string | null> {
    if (api) return api.printToPdf(opts);
    // 안드로이드는 인쇄 화면에서 'PDF로 저장' 을 고른다
    if (isAndroid) {
      await android.print(opts.defaultPath.replace(/\.pdf$/i, ''), opts.widthMm, opts.heightMm, opts.heightMm < opts.widthMm);
      return null;
    }
    window.print();
    return null;
  },

  async getRecent(): Promise<string[]> {
    if (isAndroid) return androidRecent();
    return api ? api.getRecent() : [];
  },
  async addRecent(p: string): Promise<string[]> {
    if (isAndroid) {
      const list = [p, ...androidRecent().filter((x) => x !== p)];
      for (const old of list.splice(RECENT_MAX)) android.releasePath(old);
      saveAndroidRecent(list);
      return list;
    }
    return api ? api.addRecent(p) : [];
  },
  /** 열 수 없는 파일을 최근 목록에서 뺀다 (데스크톱 앱은 없는 파일을 목록을 읽을 때 저절로 뺀다) */
  async removeRecent(p: string): Promise<string[]> {
    if (isAndroid) {
      const list = androidRecent().filter((x) => x !== p);
      saveAndroidRecent(list);
      android.releasePath(p);
      return list;
    }
    return api ? api.getRecent() : [];
  },
  async clearRecent(): Promise<string[]> {
    if (isAndroid) {
      androidRecent().forEach((p) => android.releasePath(p));
      saveAndroidRecent([]);
      return [];
    }
    return api ? api.clearRecent() : [];
  },

  async getPrefs(): Promise<any> {
    if (api) return api.getPrefs();
    try {
      return JSON.parse(localStorage.getItem(LS_PREFIX + 'prefs') || '{}');
    } catch {
      return {};
    }
  },
  async setPrefs(p: any) {
    if (api) return api.setPrefs(p);
    try {
      localStorage.setItem(LS_PREFIX + 'prefs', JSON.stringify(p));
    } catch {
      /* 무시 */
    }
  },

  async autosaveWrite(id: string, json: string) {
    if (api) return api.autosaveWrite(id, json);
    if (isAndroid && android.hasFileAutosave()) {
      await android.autosaveWrite(id, json);
      // 예전(localStorage) 자동 저장본은 치운다
      try {
        localStorage.removeItem(LS_PREFIX + 'autosave:' + id);
      } catch {
        /* 무시 */
      }
      return;
    }
    // 용량 초과 등은 알린다 (자동 저장이 된 줄 알고 있다가 잃지 않게)
    localStorage.setItem(LS_PREFIX + 'autosave:' + id, json);
  },
  async autosaveRemove(id: string) {
    if (api) return api.autosaveRemove(id);
    if (isAndroid && android.hasFileAutosave()) android.autosaveRemove(id);
    try {
      localStorage.removeItem(LS_PREFIX + 'autosave:' + id);
    } catch {
      /* 무시 */
    }
  },
  async autosaveList(): Promise<{ id: string; json: string; mtime: number }[]> {
    if (api) return api.autosaveList();
    const out: { id: string; json: string; mtime: number }[] = [];
    // 안드로이드: 앱 폴더의 자동 저장본 + 예전 판이 localStorage 에 남긴 것
    if (isAndroid && android.hasFileAutosave()) out.push(...(await android.autosaveList().catch(() => [])));
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (k.startsWith(LS_PREFIX + 'autosave:')) out.push({ id: k.slice((LS_PREFIX + 'autosave:').length), json: localStorage.getItem(k)!, mtime: Date.now() });
      }
    } catch {
      /* 무시 */
    }
    return out;
  },

  /** 한컴오피스 폴더에만 있는 글꼴 이름 묶음들 (브라우저에서는 없음) */
  async listPrivateFonts(): Promise<string[][]> {
    if (api?.listPrivateFonts) return api.listPrivateFonts();
    return [];
  },

  /** 한컴오피스 폴더의 글꼴 파일 바이트 */
  async readPrivateFont(name: string): Promise<{ names: string[]; data: Uint8Array } | null> {
    if (api?.readPrivateFont) return api.readPrivateFont(name);
    return null;
  },

  async listFonts(): Promise<string[]> {
    if (api) return api.listFonts();
    try {
      const q = (window as any).queryLocalFonts;
      if (q) {
        const fonts = await q();
        return [...new Set<string>(fonts.map((f: any) => f.family))];
      }
    } catch {
      /* 권한 거부 등 */
    }
    return [];
  },

  async convertDoc(data: Uint8Array) {
    if (!api) return { kind: 'error', message: 'DOC 형식은 데스크톱 앱에서만 열 수 있습니다.' } as const;
    return api.convertDoc(data);
  },

  /**
   * 붙이기 (메뉴·도구 상자·오른쪽 단추). view: 붙일 편집기.
   * 데스크톱 앱은 주 프로세스가, 안드로이드는 셸이 클립보드를 읽어 준다. 브라우저는 권한이 있으면 읽고, 없으면 false (Ctrl+V 안내)
   */
  async paste(plain = false, view?: { pasteText(t: string): boolean; pasteHTML(h: string): boolean } | null): Promise<boolean> {
    if (api) {
      await (plain ? api.pastePlain() : api.paste());
      return true;
    }
    let clip: { text?: string; html?: string } | null = null;
    try {
      if (isAndroid) clip = await android.readClipboard();
      else if (navigator.clipboard?.readText) clip = { text: await navigator.clipboard.readText() };
    } catch {
      clip = null;
    }
    if (!clip || !view) return false;
    if (!plain && clip.html) return view.pasteHTML(clip.html);
    if (clip.text) return view.pasteText(clip.text);
    return true;
  },

  setTitle(t: string) {
    document.title = t;
    api?.setTitle(t);
    if (isAndroid) android.setTitle(t);
  },

  onOpenFiles(cb: (files: string[]) => void) {
    if (isAndroid) return onAndroid('open-files', (files) => cb(Array.isArray(files) ? files : []));
    return api ? api.onOpenFiles(cb) : () => {};
  },
  onRequestClose(cb: () => void, back?: BackOptions) {
    if (isAndroid) return onAndroid('back', () => handleBack(cb, back));
    return api ? api.onRequestClose(cb) : () => {};
  },
  onAutosaveNow(cb: () => void) {
    if (isAndroid) return onAndroid('autosave-now', cb);
    return api ? api.onAutosaveNow(cb) : () => {};
  },
  autosaveFlushed() {
    api?.autosaveFlushed();
  },
  /** 끌어다 놓은 파일의 경로 (브라우저에서는 없음) */
  droppedFilePath(file: File): string | null {
    return api ? api.droppedFilePath(file) : null;
  },
  async version(): Promise<string> {
    if (isAndroid) return android.version();
    return api ? api.appVersion() : '';
  },
  // ---- AI 앱 연결 (MCP): 데스크톱 앱에서만 ----
  mcp: {
    available: () => !!api,
    status: () => (api ? api.mcpStatus() : Promise.resolve(null)),
    set: (patch: { enabled?: boolean; confirmEdits?: boolean; allowed?: string[] }) => (api ? api.mcpSet(patch) : Promise.resolve(null)),
    registerClaude: () => (api ? api.mcpRegisterClaude() : Promise.resolve({ ok: false, message: '데스크톱 앱에서만 쓸 수 있습니다.' })),
    openClaude: (): Promise<boolean> => (api ? api.mcpOpenClaude() : Promise.resolve(false)),
    onCall: (cb: (call: any) => void) => (api ? api.onMcpCall(cb) : () => {}),
    result: (r: { callId: string; ok: boolean; text: string }) => api?.mcpResult(r),
    ready: () => api?.mcpReady(),
  },
  closeConfirmed() {
    if (api) api.closeConfirmed();
    if (isAndroid) android.exitApp();
  },
  async initialFiles(): Promise<string[]> {
    if (isAndroid) return android.takeInitialFiles();
    return api ? api.initialFiles() : [];
  },
  /** 안드로이드: 저장한 문서를 다른 앱으로 보내기 */
  canShare: () => isAndroid,
  share(p: string) {
    if (isAndroid) android.share(p);
  },
  showItemInFolder(p: string) {
    api?.showItemInFolder(p);
  },
  openExternal(url: string) {
    if (api) api.openExternal(url);
    else if (isAndroid) android.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  },
  toggleFullscreen() {
    if (api) api.toggleFullscreen();
    else if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.();
  },
};
