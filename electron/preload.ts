import { contextBridge, ipcRenderer, webUtils } from 'electron';

const api = {
  platform: 'electron' as const,
  initialFiles: (): Promise<string[]> => ipcRenderer.invoke('app:initial-files'),
  openDialog: (filters: any): Promise<string[]> => ipcRenderer.invoke('file:open-dialog', filters),
  readFile: (p: string): Promise<Uint8Array> => ipcRenderer.invoke('file:read', p),
  saveDialog: (defaultPath: string, filters: any): Promise<string | null> => ipcRenderer.invoke('file:save-dialog', defaultPath, filters),
  writeFile: (p: string, data: Uint8Array): Promise<boolean> => ipcRenderer.invoke('file:write', p, data),
  imageDialog: (): Promise<{ name: string; data: Uint8Array }[]> => ipcRenderer.invoke('file:image-dialog'),
  showItemInFolder: (p: string) => ipcRenderer.invoke('shell:show-item', p),
  openExternal: (url: string) => ipcRenderer.invoke('shell:open-external', url),
  supportSend: (p: { category: string; message: string; email?: string; withEnv?: boolean }): Promise<{ ok: boolean; error?: string; issueUrl?: string }> => ipcRenderer.invoke('support:send', p),
  getRecent: (): Promise<string[]> => ipcRenderer.invoke('recent:get'),
  addRecent: (p: string): Promise<string[]> => ipcRenderer.invoke('recent:add', p),
  clearRecent: (): Promise<string[]> => ipcRenderer.invoke('recent:clear'),
  getPrefs: (): Promise<any> => ipcRenderer.invoke('prefs:get'),
  setPrefs: (prefs: any): Promise<boolean> => ipcRenderer.invoke('prefs:set', prefs),
  autosaveWrite: (id: string, json: string) => ipcRenderer.invoke('autosave:write', id, json),
  autosaveRemove: (id: string) => ipcRenderer.invoke('autosave:remove', id),
  autosaveList: (): Promise<{ id: string; json: string; mtime: number }[]> => ipcRenderer.invoke('autosave:list'),
  /** 주 프로세스가 '지금 자동 저장' 을 요청할 때 */
  onAutosaveNow: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('app:autosave-now', h);
    return () => {
      ipcRenderer.removeListener('app:autosave-now', h);
    };
  },
  autosaveFlushed: () => ipcRenderer.send('autosave:flushed'),
  /** 끌어다 놓은 File 의 실제 경로 (없으면 null). 주 프로세스에 그 경로를 허용해 달라고 알린다 */
  droppedFilePath: (file: File): string | null => {
    let p = '';
    try {
      p = webUtils.getPathForFile(file);
    } catch {
      p = '';
    }
    if (p) ipcRenderer.send('file:dropped', p);
    return p || null;
  },
  appVersion: (): Promise<string> => ipcRenderer.invoke('app:version'),
  // ---- AI 앱 연결 (MCP) ----
  mcpStatus: (): Promise<any> => ipcRenderer.invoke('mcp:status'),
  mcpSet: (patch: { enabled?: boolean; confirmEdits?: boolean; allowed?: string[] }): Promise<any> => ipcRenderer.invoke('mcp:set', patch),
  mcpRegisterClaude: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('mcp:register-claude'),
  mcpOpenClaude: (): Promise<boolean> => ipcRenderer.invoke('mcp:open-claude'),
  onMcpCall: (cb: (call: any) => void) => {
    const h = (_e: unknown, call: any) => cb(call);
    ipcRenderer.on('mcp:call', h);
    return () => {
      ipcRenderer.removeListener('mcp:call', h);
    };
  },
  mcpResult: (r: { callId: string; ok: boolean; text: string }) => ipcRenderer.send('mcp:result', r),
  mcpReady: () => ipcRenderer.send('mcp:ready'),
  printToPdf: (opts: { widthMm: number; heightMm: number; defaultPath: string; path?: string }): Promise<string | null> => ipcRenderer.invoke('print:pdf', opts),
  print: (opts: { widthMm: number; heightMm: number; landscape: boolean }): Promise<boolean> => ipcRenderer.invoke('print:print', opts),
  paste: () => ipcRenderer.invoke('edit:paste'),
  pastePlain: () => ipcRenderer.invoke('edit:paste-plain'),
  setTitle: (t: string) => ipcRenderer.invoke('app:set-title', t),
  closeConfirmed: () => ipcRenderer.invoke('app:close-confirmed'),
  toggleFullscreen: () => ipcRenderer.invoke('app:toggle-fullscreen'),
  listFonts: (): Promise<string[]> => ipcRenderer.invoke('fonts:list'),
  listPrivateFonts: (): Promise<string[][]> => ipcRenderer.invoke('fonts:private-list'),
  readPrivateFont: (name: string): Promise<{ names: string[]; data: Uint8Array } | null> => ipcRenderer.invoke('fonts:private-read', name),
  convertDoc: (data: Uint8Array): Promise<any> => ipcRenderer.invoke('doc:convert', data),
  aiKeyStatus: (): Promise<Record<'claude' | 'openai' | 'gemini' | 'ollama', 'saved' | 'env' | 'login' | 'none'>> => ipcRenderer.invoke('ai:key-status'),
  /** '계정 로그인' 방식: Kite 안에 띄울 수 있는 공식 웹 대화창 목록, 로그인 정보 지우기 */
  aiWebServices: (): Promise<{ id: string; label: string; company: string; url: string }[]> => ipcRenderer.invoke('ai-web:services'),
  aiWebClear: (): Promise<boolean> => ipcRenderer.invoke('ai-web:clear'),
  aiSetKey: (p: string, key: string | null) => ipcRenderer.invoke('ai:set-key', p, key),
  aiModels: (p: string): Promise<{ ok: boolean; models?: { id: string; label: string }[]; error?: string }> => ipcRenderer.invoke('ai:models', p),
  aiChat: (req: any) => ipcRenderer.invoke('ai:chat', req),
  aiAbort: (id: string) => ipcRenderer.invoke('ai:abort', id),
  // 실시간 공동 편집 (실험)
  collabHost: (port?: number): Promise<{ port: number; code: string; addresses: string[] }> => ipcRenderer.invoke('collab:host', port),
  collabJoin: (address: string, code: string): Promise<boolean> => ipcRenderer.invoke('collab:join', address, code),
  collabStop: () => ipcRenderer.invoke('collab:stop'),
  collabSend: (data: Uint8Array) => ipcRenderer.send('collab:send', data),
  onCollabEvent: (cb: (ev: any) => void) => {
    const h = (_e: unknown, ev: any) => cb(ev);
    ipcRenderer.on('collab:event', h);
    return () => {
      ipcRenderer.removeListener('collab:event', h);
    };
  },
  onAiEvent: (cb: (ev: any) => void) => {
    const h = (_e: unknown, ev: any) => cb(ev);
    ipcRenderer.on('ai:event', h);
    return () => {
      ipcRenderer.removeListener('ai:event', h);
    };
  },
  onOpenFiles: (cb: (files: string[]) => void) => {
    const h = (_e: unknown, files: string[]) => cb(files);
    ipcRenderer.on('app:open-files', h);
    return () => ipcRenderer.removeListener('app:open-files', h);
  },
  onRequestClose: (cb: () => void) => {
    const h = () => cb();
    ipcRenderer.on('app:request-close', h);
    return () => ipcRenderer.removeListener('app:request-close', h);
  },
};

contextBridge.exposeInMainWorld('kite', api);

export type KiteApi = typeof api;
