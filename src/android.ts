/**
 * 안드로이드 앱(android/)의 WebView 셸과 이야기하는 부분.
 *
 * 셸은 window.KiteAndroid 를 넣어 두고, 오래 걸리는 일의 결과는 window.__kiteAndroid.resolve(번호, 성공, 값) 으로,
 * 뒤로 가기·다음으로 열기 같은 알림은 window.__kiteAndroid.emit(이름, 값) 으로 돌려준다.
 * 문서 경로는 "<content uri>#/<파일 이름>" 꼴이라 baseName() 이 그대로 파일 이름을 얻는다.
 */

interface KiteAndroidNative {
  version(): string;
  takeInitialFiles(): string;
  openDocuments(cb: number, mimeTypesJson: string): void;
  createDocument(cb: number, suggestedName: string, formatsJson: string): void;
  writeStart(id: string): void;
  writeChunk(id: string, base64: string): void;
  writeFinish(cb: number, id: string, path: string): void;
  print(cb: number, jobName: string, widthMm: number, heightMm: number, landscape: boolean): void;
  releasePath(path: string): void;
  openExternal(url: string): void;
  share(path: string, mime: string): void;
  setTitle(title: string): void;
  exitApp(): void;
  readClipboard?(cb: number): void;
  autosaveWrite?(cb: number, id: string, json: string): void;
  autosaveRemove?(id: string): void;
  autosaveList?(cb: number): void;
}

declare global {
  interface Window {
    KiteAndroid?: KiteAndroidNative;
    __kiteAndroid?: { resolve(cb: number, ok: boolean, value: any): void; emit(event: string, value: any): void };
  }
}

const native = typeof window !== 'undefined' ? window.KiteAndroid : undefined;
export const isAndroid = !!native;

const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
const listeners = new Map<string, Set<(v: any) => void>>();
let seq = 1;

if (native) {
  window.__kiteAndroid = {
    resolve(cb, ok, value) {
      const p = pending.get(cb);
      if (!p) return;
      pending.delete(cb);
      if (ok) p.resolve(value);
      else p.reject(new Error(String(value || '오류')));
    },
    emit(event, value) {
      listeners.get(event)?.forEach((fn) => {
        try {
          fn(value);
        } catch (e) {
          console.error(e);
        }
      });
    },
  };
  document.documentElement.classList.add('is-android');
}

function call<T>(fn: (cb: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cb = seq++;
    pending.set(cb, { resolve, reject });
    try {
      fn(cb);
    } catch (e: any) {
      pending.delete(cb);
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

export function onAndroid(event: string, fn: (v: any) => void): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

/** 파일 확장자 → 안드로이드 저장소에 알려 줄 MIME 형식 */
const MIME: Record<string, string> = {
  hwp: 'application/x-hwp',
  hwpx: 'application/hwp+zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  pdf: 'application/pdf',
  md: 'text/markdown',
  markdown: 'text/markdown',
  html: 'text/html',
  htm: 'text/html',
  txt: 'text/plain',
};

export const mimeOf = (ext: string) => MIME[ext.toLowerCase()] || 'application/octet-stream';

function extOf(name: string) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export const android = {
  version: () => native!.version(),

  takeInitialFiles(): string[] {
    try {
      return JSON.parse(native!.takeInitialFiles() || '[]');
    } catch {
      return [];
    }
  },

  /** 저장소 접근 프레임워크로 문서 고르기 (여러 개). 결과는 문서 경로들 */
  openDocuments(extensions: string[]): Promise<string[]> {
    // 제공자마다 HWP 의 MIME 형식이 제각각이라 형식으로 거르지 않고 모두 보여 준다. 고른 뒤 확장자로 판별한다.
    void extensions;
    return call<string[]>((cb) => native!.openDocuments(cb, '[]')).then((a) => a || []);
  },

  async read(path: string): Promise<Uint8Array> {
    const res = await fetch('/__kite/read?path=' + encodeURIComponent(path), { cache: 'no-store' });
    if (!res.ok) throw new Error((await res.text().catch(() => '')) || `파일을 읽을 수 없습니다 (${res.status})`);
    return new Uint8Array(await res.arrayBuffer());
  },

  /** 저장 위치 고르기. 형식이 여럿이면 셸이 먼저 형식을 묻는다. 취소하면 null */
  createDocument(defaultName: string, filters: { name: string; extensions: string[] }[]): Promise<string | null> {
    const formats = filters.map((f) => ({ name: f.name, ext: f.extensions[0], mime: mimeOf(f.extensions[0] || '') }));
    const base = defaultName.split(/[\\/]/).pop() || defaultName;
    return call<string | null>((cb) => native!.createDocument(cb, base, JSON.stringify(formats)));
  },

  /** 큰 문서도 다룰 수 있게 나눠서 보낸다 */
  async write(path: string, data: Uint8Array): Promise<void> {
    const id = 'w' + seq++ + '_' + Date.now();
    native!.writeStart(id);
    const CHUNK = 384 * 1024; // 3 의 배수: 조각마다 base64 를 따로 만들어도 이어 붙인 것과 같다
    for (let i = 0; i < data.length; i += CHUNK) {
      native!.writeChunk(id, bytesToBase64(data.subarray(i, i + CHUNK)));
      // 큰 파일일 때 화면이 멈추지 않도록 잠깐 양보
      if (i && i % (CHUNK * 8) === 0) await new Promise((r) => setTimeout(r, 0));
    }
    await call<boolean>((cb) => native!.writeFinish(cb, id, path));
  },

  print(jobName: string, widthMm: number, heightMm: number, landscape: boolean): Promise<boolean> {
    return call<boolean>((cb) => native!.print(cb, jobName, widthMm, heightMm, landscape));
  },

  releasePath: (p: string) => native!.releasePath(p),
  openExternal: (url: string) => native!.openExternal(url),
  share: (p: string) => native!.share(p, mimeOf(extOf(p))),
  setTitle: (t: string) => native!.setTitle(t),
  exitApp: () => native!.exitApp(),
  /** 클립보드 {text, html} (셸이 이 기능을 모르면 null) */
  readClipboard(): Promise<{ text?: string; html?: string } | null> {
    if (!native!.readClipboard) return Promise.resolve(null);
    return call((cb) => native!.readClipboard!(cb));
  },
  /** 앱 전용 폴더의 자동 저장 (셸이 이 기능을 모르면 false: localStorage 를 쓴다) */
  hasFileAutosave: () => !!native?.autosaveWrite,
  autosaveWrite: (id: string, json: string) => call<boolean>((cb) => native!.autosaveWrite!(cb, id, json)),
  autosaveRemove: (id: string) => native!.autosaveRemove!(id),
  autosaveList: () => call<{ id: string; json: string; mtime: number }[]>((cb) => native!.autosaveList!(cb)).then((a) => a || []),
};

function bytesToBase64(b: Uint8Array): string {
  let s = '';
  const STEP = 0x8000;
  for (let i = 0; i < b.length; i += STEP) s += String.fromCharCode.apply(null, b.subarray(i, i + STEP) as unknown as number[]);
  return btoa(s);
}

/** 사람이 알아볼 수 있는 경로 (최근 문서 목록 등) */
export function displayPath(p: string): string {
  const i = p.lastIndexOf('#/');
  if (!p.startsWith('content://') || i < 0) return p;
  const name = p.slice(i + 2);
  try {
    // 외부 저장소 문서 id 는 "primary:Documents/보고서.hwp" 꼴이다
    const uri = decodeURIComponent(p.slice(0, i));
    const m = /:([^:]*\/)[^/]*$/.exec(uri.replace(/^content:\/\/[^/]+\//, ''));
    if (m) return m[1] + name;
  } catch {
    /* 그대로 */
  }
  return name;
}

/** 안드로이드에서 뒤로 가기: 열린 창·메뉴가 있으면 닫고, 없으면 끝내기를 요청한다 */
export interface BackOptions {
  /** 열린 옆 창(찾기·AI·검사 등)을 하나 닫았으면 true */
  closePanel?: () => boolean;
  /** 저장하지 않은 문서가 있는가 (있으면 끝내기 확인이 뜨므로 두 번 누르기를 묻지 않는다) */
  hasUnsaved?: () => boolean;
  toast?: (text: string) => void;
}

export function handleBack(requestClose: () => void, opts: BackOptions = {}) {
  // 저장·불러오기 중에는 아무것도 하지 않는다 (끝내기 확인이 저장을 한 번 더 부르거나 쓰는 도중에 끝나지 않게)
  if (document.querySelector('.busy')) return;
  const open = document.querySelector('.modal, .modal-back, .menu-pop, .ctx-menu, .dropdown-pop, .preview-modal, .palette-back');
  if (open) {
    const target = (document.activeElement as HTMLElement | null) || document.body;
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true, cancelable: true }));
    return;
  }
  // 찾기·AI·검사·검토·버전 창 (초점이 문서에 있으면 Esc 를 받지 못하므로 직접 닫는다)
  if (opts.closePanel?.()) return;
  // 바꾼 것이 없으면 끝내기 전에 한 번 더 누르게 한다 (실수로 눌러 열린 문서가 사라지지 않게)
  const now = Date.now();
  if (!opts.hasUnsaved?.() && now - lastBack > 2000) {
    lastBack = now;
    opts.toast?.('한 번 더 누르면 끝냅니다.');
    return;
  }
  requestClose();
}
let lastBack = 0;
