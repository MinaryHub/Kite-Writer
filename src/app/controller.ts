import { DocTab } from '../doc/docTab';
import { platform } from '../platform';
import { importDocument, exportDocument, SAVE_FORMATS, OPEN_FILTERS } from '../formats';
import { baseName, splitExt, MAX_IMPORT_BYTES } from '../formats/common';
import type { SaveFormatId } from '../types';
import { withPrintRoot } from '../print';
import { viewState } from '../editor/viewState';
import { KOREAN_FONTS, LATIN_FONTS, installedFonts, privateFontNames, ensurePrivateFonts, collectFontNames, registerPdfFonts, applyPdfFontVars, embeddedAliases } from '../fonts';

import * as versions from './versions';

export interface DialogState {
  type: string;
  props?: any;
}

export interface ConfirmButton {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}

export interface ConfirmState {
  title: string;
  message: string;
  buttons: ConfirmButton[];
  resolve: (id: string) => void;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'warn';
}

export interface Prefs {
  autosaveMinutes: number;
  defaultFont: string;
  defaultFontSize: number;
  spellcheck: boolean;
  recentFonts: string[];
  defaultSaveFormat: SaveFormatId;
  /** 화면 테마 (system: 운영체제 설정을 따름) */
  theme: 'light' | 'dark' | 'system';
  /** 어두운 테마에서 종이도 어둡게 (화면에서만, 인쇄는 그대로) */
  darkPaper: boolean;
  /** 최근에 쓴 명령 (명령 팔레트) */
  recentCommands: string[];
  /** AI 앱(MCP)의 수정을 변경 제안으로 남긴다 */
  mcpSuggest: boolean;
  /** 변경 내용·메모에 남길 이름 */
  userName: string;
}

export interface ViewOptions {
  ruler: boolean;
  statusbar: boolean;
  marks: boolean;
  guides: boolean;
  transparent: boolean;
  toolbar: boolean;
  formatbar: boolean;
}

export interface PainterState {
  marks: any[];
  para: Record<string, any> | null;
}

let toastSeq = 0;

/** 파일 오류 코드를 사람이 읽을 수 있는 말로 */
export function friendlyFsError(e: any): string {
  const msg = String(e?.message || e || '');
  const code = e?.code || (/\b(EPERM|EBUSY|EACCES|ENOSPC|ENOENT|EROFS|EISDIR|ENAMETOOLONG)\b/.exec(msg) || [])[1];
  switch (code) {
    case 'EPERM':
    case 'EBUSY':
      return '다른 프로그램에서 이 파일을 사용 중입니다. 그 프로그램에서 닫은 뒤 다시 저장하거나, 다른 이름으로 저장하세요.';
    case 'EACCES':
    case 'EROFS':
      return '이 위치에 쓸 권한이 없습니다. 다른 폴더에 저장하세요.';
    case 'ENOSPC':
      return '디스크 공간이 부족합니다.';
    case 'ENOENT':
      return '폴더가 없거나 이동되었습니다. 다른 이름으로 저장하세요.';
    case 'EISDIR':
      return '폴더 이름과 같은 이름으로는 저장할 수 없습니다.';
    case 'ENAMETOOLONG':
      return '파일 이름이 너무 깁니다.';
  }
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export class AppController {
  docs: DocTab[] = [];
  activeId: string | null = null;
  zoom = 1;
  zoomMode: 'custom' | 'width' | 'page' = 'custom';
  /** 여러 쪽 보기 (쪽 사본을 격자로; 누르면 그 자리로 돌아가 편집) */
  multiPage = false;
  view: ViewOptions = { ruler: true, statusbar: true, marks: false, guides: true, transparent: true, toolbar: true, formatbar: true };
  dialog: DialogState | null = null;
  confirmState: ConfirmState | null = null;
  findOpen: 'find' | 'replace' | null = null;
  previewOpen = false;
  aiOpen = false;
  /** AI 앱(MCP)이 한 작업 기록 (최근 것이 앞) */
  mcpLog: { time: number; client: string; tool: string; title: string; ok: boolean; edits: boolean; detail: string }[] = [];
  toasts: Toast[] = [];
  busy: string | null = null;
  recent: string[] = [];
  systemFonts: string[] = [];
  painter: PainterState | null = null;
  prefs: Prefs = {
    autosaveMinutes: 5,
    defaultFont: '함초롬바탕',
    defaultFontSize: 10,
    spellcheck: false,
    recentFonts: [],
    defaultSaveFormat: 'hwpx',
    theme: 'system',
    darkPaper: false,
    recentCommands: [],
    mcpSuggest: false,
    userName: '',
  };
  /** 명령 팔레트 */
  paletteOpen = false;
  /** 문서 검사 창 */
  checkOpen = false;
  /** 검토 창 (메모·변경 내용) */
  reviewOpen = false;
  versionsOpen = false;
  reviewTab: 'comments' | 'changes' = 'comments';
  /** 메모 입력 칸을 바로 연다 */
  commentDraft = false;
  private listeners = new Set<() => void>();
  private untitledNo = 0;
  private autosaveTimer: any = null;
  /** 원본을 덮어쓰기 전에 확인이 필요한 문서: 손실 경고가 있던 가져온 문서 / 복구된 문서 */
  private overwriteConfirm = new Map<string, 'lossy' | 'recovered'>();
  private docUnsubs = new Map<string, () => void>();

  get active(): DocTab | null {
    return this.docs.find((d) => d.id === this.activeId) || null;
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit() {
    this.syncPdfFontVars();
    this.listeners.forEach((f) => f());
  }

  private pdfVarsKey = '';
  /** 지금 보고 있는 문서의 PDF 글꼴만 켠다 */
  private syncPdfFontVars() {
    const tab = this.active;
    const fams = (tab?.settings.pdfFonts || []).map((f: any) => String(f.family || ''));
    const key = (tab?.id || '') + '|' + fams.length + '|' + embeddedAliases.size;
    if (key === this.pdfVarsKey) return;
    this.pdfVarsKey = key;
    applyPdfFontVars(fams);
    // 글꼴이 바뀌었으니 쪽 배치를 다시 잰다 (글꼴을 다 받은 뒤에도 한 번 더)
    if (tab && fams.length) {
      const relayout = () => tab.editor.storage.pagination?.schedule?.();
      relayout();
      void document.fonts?.ready.then(relayout);
    }
  }

  set(p: Partial<AppController>) {
    Object.assign(this, p);
    this.emit();
  }

  async init() {
    versions.startAutoVersions(() => this.docs);
    try {
      const prefs = await platform.getPrefs();
      if (prefs && typeof prefs === 'object') this.prefs = { ...this.prefs, ...prefs };
      if (prefs?.view) this.view = { ...this.view, ...prefs.view };
      if (prefs?.zoom) this.zoom = prefs.zoom;
      // 휴대폰처럼 좁은 화면: 처음엔 눈금자를 감추고, 늘 쪽 폭에 맞춰 연다
      if (typeof window !== 'undefined' && window.innerWidth < 760) {
        if (!prefs?.view) this.view = { ...this.view, ruler: false };
        this.zoomMode = 'width';
      }
    } catch {
      /* 무시 */
    }
    this.applyTheme();
    this.recent = await platform.getRecent();
    platform.listFonts().then((f) => {
      this.systemFonts = f;
      f.forEach((n) => installedFonts.add(n));
      this.emit();
      // 한컴오피스 폴더의 글꼴 이름을 알아 두고, 이미 열린 문서에 필요한 것은 올린다
      platform.listPrivateFonts().then((groups) => {
        for (const g of groups) for (const n of g) privateFontNames.set(n, g);
        for (const d of this.docs) this.loadDocFonts(d);
      });
    });
    platform.onOpenFiles((files) => files.forEach((f) => this.openPath(f)));
    platform.onRequestClose(() => this.requestQuit());
    // AI 앱 연결(MCP) 도구 처리기 (준비됨 신호는 첫 문서가 열린 뒤에 보낸다)
    (await import('./mcpHandlers')).installMcpHandlers();
    platform.onAutosaveNow(async () => {
      try {
        await this.autosaveNow(true);
      } finally {
        platform.autosaveFlushed();
      }
    });
    const initial = await platform.initialFiles();
    for (const f of initial) await this.openPath(f);
    await this.checkRecovery();
    if (!this.docs.length) this.newDoc();
    platform.mcp.ready();
    this.restartAutosave();
    this.emit();
  }

  savePrefs() {
    platform.setPrefs({ ...this.prefs, view: this.view, zoom: this.zoom });
  }

  // ---------------- 테마 ----------------
  private themeQuery: MediaQueryList | null = null;
  /** 실제로 쓰는 테마 */
  get effectiveTheme(): 'light' | 'dark' {
    if (this.prefs.theme === 'dark' || this.prefs.theme === 'light') return this.prefs.theme;
    return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  /** 테마를 문서 루트에 반영 (대화 상자 등 앱 밖에 붙는 요소까지 같은 색을 쓰게) */
  applyTheme() {
    if (typeof document === 'undefined') return;
    const dark = this.effectiveTheme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (dark && this.prefs.darkPaper) document.documentElement.dataset.paper = 'dark';
    else delete document.documentElement.dataset.paper;
    if (!this.themeQuery && window.matchMedia) {
      this.themeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      this.themeQuery.addEventListener('change', () => {
        if (this.prefs.theme === 'system') {
          this.applyTheme();
          this.emit();
        }
      });
    }
  }
  setTheme(theme: Prefs['theme'], darkPaper = this.prefs.darkPaper) {
    this.prefs = { ...this.prefs, theme, darkPaper };
    this.applyTheme();
    this.savePrefs();
    this.emit();
  }

  // ---------------- 알림 ----------------
  toast(text: string, kind: Toast['kind'] = 'info', ms = 3500) {
    const t = { id: ++toastSeq, text, kind };
    this.toasts = [...this.toasts, t];
    this.emit();
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
      this.emit();
    }, ms);
  }

  confirm(title: string, message: string, buttons: ConfirmButton[]): Promise<string> {
    return new Promise((resolve) => {
      this.confirmState = {
        title,
        message,
        buttons,
        resolve: (id) => {
          this.confirmState = null;
          this.emit();
          resolve(id);
        },
      };
      this.emit();
    });
  }

  openDialog(type: string, props?: any) {
    this.dialog = { type, props };
    this.emit();
  }

  closeDialog() {
    this.dialog = null;
    this.emit();
    setTimeout(() => this.active?.editor.commands.focus(), 0);
  }

  // ---------------- 문서 ----------------
  /** 문서가 쓰는 글꼴 가운데 한컴 폴더에만 있는 것과 문서에 담긴 PDF 글꼴을 올린다 */
  private loadDocFonts(tab: DocTab) {
    // PDF 에서 꺼낸 글꼴 (자동 저장에서 복구한 문서도 같은 글꼴로)
    if (tab.settings.pdfFonts) void registerPdfFonts(tab.settings.pdfFonts).then(() => this.emit());
    if (!privateFontNames.size) return;
    const names = collectFontNames(tab.editor.getJSON());
    void ensurePrivateFonts(names, (n) => platform.readPrivateFont(n));
  }

  private addDoc(tab: DocTab) {
    this.docs = [...this.docs, tab];
    this.loadDocFonts(tab);
    this.activeId = tab.id;
    this.docUnsubs.set(
      tab.id,
      tab.subscribe(() => {
        this.updateTitle();
        this.emit();
      }),
    );
    this.updateTitle();
    this.emit();
    setTimeout(() => tab.editor.commands.focus('start'), 50);
  }

  /** 사본(버전 기록 등)을 새 탭으로 연다 */
  openCopy(title: string, doc: { content: any; settings?: any; meta?: any }) {
    const tab = new DocTab({ title, content: doc.content, settings: doc.settings, meta: doc.meta });
    this.addDoc(tab);
    return tab;
  }

  newDoc() {
    this.untitledNo++;
    const tab = new DocTab({ title: `빈 문서 ${this.untitledNo}` });
    if (this.prefs.defaultFont !== '함초롬바탕' || this.prefs.defaultFontSize !== 10) {
      tab.editor.commands.setContent({
        type: 'doc',
        content: [{ type: 'paragraph', attrs: { fontSize: this.prefs.defaultFontSize } }],
      });
      tab.editor.chain().setFontFamily(this.prefs.defaultFont).setFontSize(this.prefs.defaultFontSize).run();
      tab.markSaved();
    }
    this.addDoc(tab);
    return tab;
  }

  activate(id: string) {
    const cur = this.active;
    if (cur) cur.scrollTop = document.querySelector(`[data-doc="${cur.id}"]`)?.scrollTop || 0;
    this.activeId = id;
    this.updateTitle();
    this.emit();
    setTimeout(() => this.active?.editor.commands.focus(), 30);
  }

  updateTitle() {
    const d = this.active;
    platform.setTitle(d ? `${d.dirty ? '* ' : ''}${d.title} - Kite` : 'Kite');
  }

  async openFiles() {
    const files = await platform.openFiles(OPEN_FILTERS);
    for (const f of files) await this.openData(f.name, f.data, f.path);
  }

  async openPath(p: string) {
    const existing = this.docs.find((d) => d.path && d.path.toLowerCase() === p.toLowerCase());
    if (existing) {
      this.activate(existing.id);
      return;
    }
    try {
      const f = await platform.readPath(p);
      await this.openData(f.name, f.data, f.path);
    } catch (e: any) {
      this.toast(`파일을 열 수 없습니다: ${e?.message || e}`, 'error', 6000);
    }
  }

  async openData(name: string, data: Uint8Array, path: string | null) {
    if (data.byteLength > MAX_IMPORT_BYTES) {
      this.toast(`'${name}' 파일이 너무 큽니다 (${Math.round(data.byteLength / 1048576)}MB). ${Math.round(MAX_IMPORT_BYTES / 1048576)}MB 이하만 열 수 있습니다.`, 'error', 7000);
      return;
    }
    this.set({ busy: `'${name}' 불러오는 중…` });
    // 진행 표시가 그려지도록 한 프레임 양보
    await new Promise((r) => setTimeout(r, 30));
    try {
      const loaded = await importDocument(name, data, {
        convertLegacyDoc: (d) => platform.convertDoc(d) as any,
        onProgress: (p) => this.set({ busy: `'${name}' 불러오는 중… ${Math.round(p * 100)}%` }),
      });
      const [stem] = splitExt(name);
      const cur = this.active;
      // 수정하지 않은 빈 새 문서는 교체
      const replace = cur && !cur.path && !cur.dirty && cur.editor.state.doc.textContent.length === 0 && cur.editor.state.doc.childCount <= 1;
      const tab = new DocTab({
        content: loaded.content,
        settings: loaded.settings,
        meta: loaded.meta,
        title: loaded.format === 'pdf' || loaded.format === 'doc' ? stem : name,
        path: loaded.format === 'pdf' || loaded.format === 'doc' ? null : path,
        sourceFormat: loaded.format,
        warnings: loaded.warnings,
      });
      if (loaded.format === 'pdf' || loaded.format === 'doc') tab.title = `${stem} (${loaded.format.toUpperCase()}에서 변환)`;
      if (replace && cur) this.closeTab(cur.id, true);
      // 변환하면서 잃은 것이 있는 문서는 원본을 덮어쓰기 전에 한 번 확인한다
      if (tab.path && tab.saveFormat && loaded.warnings.length) this.overwriteConfirm.set(tab.id, 'lossy');
      this.addDoc(tab);
      if (path) this.recent = await platform.addRecent(path);
      if (loaded.warnings.length) this.toast(loaded.warnings.slice(0, 2).join(' / '), 'warn', 6000);
    } catch (e: any) {
      console.error(e);
      this.toast(`'${name}' 파일을 열 수 없습니다: ${e?.message || e}`, 'error', 7000);
    } finally {
      this.set({ busy: null });
    }
  }

  async save(tab = this.active): Promise<boolean> {
    if (!tab) return false;
    if (!tab.path || !tab.saveFormat) return this.saveAs(tab);
    const reason = this.overwriteConfirm.get(tab.id);
    if (reason) {
      const msg =
        reason === 'recovered'
          ? `'${baseName(tab.path)}' 은(는) 자동 저장본에서 복구한 문서입니다. 디스크의 파일이 더 새로울 수 있습니다. 원본을 덮어쓸까요?`
          : `'${baseName(tab.path)}' 을(를) 불러올 때 일부 기능을 변환하지 못했습니다:\n${tab.warnings.slice(0, 3).join('\n')}\n\n이대로 원본을 덮어쓰면 그 내용이 사라집니다. 덮어쓸까요?`;
      const r = await this.confirm('원본 덮어쓰기', msg, [
        { id: 'saveAs', label: '다른 이름으로 저장', primary: true },
        { id: 'overwrite', label: '덮어쓰기', danger: true },
        { id: 'cancel', label: '취소' },
      ]);
      if (r === 'cancel') return false;
      if (r === 'saveAs') return this.saveAs(tab);
      this.overwriteConfirm.delete(tab.id);
    }
    return this.writeTo(tab, tab.path, tab.saveFormat);
  }

  async saveAs(tab = this.active, format?: SaveFormatId): Promise<boolean> {
    if (!tab) return false;
    const fmt = format || tab.saveFormat || this.prefs.defaultSaveFormat;
    const def = SAVE_FORMATS.find((f) => f.id === fmt) || SAVE_FORMATS[0];
    const [stem] = splitExt(tab.path ? baseName(tab.path) : tab.title.replace(/\s*\(.*에서 변환\)$/, ''));
    const dir = tab.path ? tab.path.slice(0, tab.path.length - baseName(tab.path).length) : '';
    // 안드로이드는 형식이 여럿이면 저장 위치를 고르기 전에 형식부터 묻는다: 형식을 정해 부른 경우엔 묻지 않는다
    const choices = format && platform.isAndroid ? [def] : [def, ...SAVE_FORMATS.filter((f) => f.id !== def.id && f.id !== 'pdf')];
    const filters = choices.map((f) => ({ name: f.name, extensions: [f.ext] }));
    const target = await platform.chooseSavePath(dir + stem + '.' + def.ext, filters);
    if (!target) return false;
    const [, ext] = splitExt(target);
    const chosen = (SAVE_FORMATS.find((f) => f.ext === ext)?.id || fmt) as SaveFormatId;
    if (chosen === 'pdf') {
      // PDF 내보내기는 편집 가능한 저장이 아니다: 문서는 그대로 '수정됨' 으로 두어 닫을 때 다시 묻는다
      await this.exportPdf(tab, target);
      return false;
    }
    const finalPath = ext ? target : `${target}.${def.ext}`;
    return this.writeTo(tab, finalPath, chosen);
  }

  private async writeTo(tab: DocTab, path: string, format: SaveFormatId): Promise<boolean> {
    // 변경 내용·메모는 DOCX 만 저장한다: 다른 형식이면 알리고 고르게 한다
    if (format !== 'docx') {
      const { hasReviewMarks } = await import('../formats/review');
      const r = hasReviewMarks(tab.editor.getJSON());
      if (r.changes || r.comments) {
        const what = [r.changes ? '변경 내용 기록' : '', r.comments ? '메모' : ''].filter(Boolean).join('과 ');
        const pick = await this.confirm(
          '검토 내용 저장',
          `${format.toUpperCase()} 형식에는 ${what}을(를) 저장할 수 없습니다.\n변경은 모두 반영하고 메모는 뺀 상태로 저장합니다. (편집 중인 문서는 그대로 남습니다)\n\n검토 내용을 그대로 두려면 Word(DOCX)로 저장하세요.`,
          [
            { id: 'save', label: '반영하여 저장', primary: true },
            { id: 'docx', label: 'Word(DOCX)로 저장' },
            { id: 'cancel', label: '취소' },
          ],
        );
        if (pick === 'cancel') return false;
        if (pick === 'docx') return this.saveAs(tab, 'docx');
      }
    }
    this.set({ busy: '저장하는 중…' });
    try {
      const data = await exportDocument(format, tab.toKDocument(), { pageCount: tab.layout.pageCount });
      await platform.writeFile(path, data);
      if (platform.hasFilePaths) {
        tab.path = path;
        tab.title = baseName(path);
        tab.saveFormat = format;
        this.recent = await platform.addRecent(path);
      } else {
        tab.title = baseName(path);
        tab.saveFormat = format;
      }
      tab.markSaved();
      void versions.snapshot(tab, 'save');
      this.overwriteConfirm.delete(tab.id);
      platform.autosaveRemove(tab.id);
      this.toast(`저장했습니다: ${baseName(path)}`);
      if (format === 'md' || format === 'txt' || format === 'html') this.toast('이 형식은 일부 서식(쪽 설정, 글꼴 등)이 저장되지 않습니다.', 'warn', 5000);
      return true;
    } catch (e: any) {
      console.error(e);
      this.toast(`저장하지 못했습니다: ${friendlyFsError(e)}`, 'error', 7000);
      return false;
    } finally {
      this.set({ busy: null });
      this.updateTitle();
    }
  }

  async exportPdf(tab = this.active, path?: string) {
    if (!tab) return;
    const [stem] = splitExt(tab.path ? baseName(tab.path) : tab.title);
    this.set({ busy: 'PDF 만드는 중…' });
    try {
      const out = await withPrintRoot(tab, (g) => platform.printToPdf({ widthMm: g.wMm, heightMm: g.hMm, defaultPath: stem + '.pdf', path }));
      if (out) this.toast(`PDF로 저장했습니다: ${baseName(out)}`);
    } catch (e: any) {
      this.toast(`PDF 저장 실패: ${friendlyFsError(e)}`, 'error');
    } finally {
      this.set({ busy: null });
    }
  }

  async print(tab = this.active) {
    if (!tab) return;
    try {
      await withPrintRoot(tab, (g) => platform.print({ widthMm: g.wMm, heightMm: g.hMm, landscape: tab.settings.page.landscape }));
    } catch (e: any) {
      this.toast(`인쇄 실패: ${e?.message || e}`, 'error');
    }
  }

  async closeTab(id: string, force = false): Promise<boolean> {
    const tab = this.docs.find((d) => d.id === id);
    if (!tab) return true;
    if (!force && tab.dirty) {
      this.activate(id);
      const r = await this.confirm('저장 확인', `'${tab.title}' 문서의 변경 내용을 저장하시겠습니까?`, [
        { id: 'save', label: '저장', primary: true },
        { id: 'discard', label: '저장 안 함', danger: true },
        { id: 'cancel', label: '취소' },
      ]);
      if (r === 'cancel') return false;
      if (r === 'save' && !(await this.save(tab))) return false;
    }
    const idx = this.docs.indexOf(tab);
    // 공동 편집 중인 문서를 닫으면 공동 편집도 끝낸다
    void import('../collab/session').then((m) => {
      if (m.collabState()?.tabId === id) void m.stopCollab();
    });
    this.docUnsubs.get(id)?.();
    this.docUnsubs.delete(id);
    this.docs = this.docs.filter((d) => d.id !== id);
    platform.autosaveRemove(tab.id);
    if (this.activeId === id) this.activeId = this.docs[Math.min(idx, this.docs.length - 1)]?.id || null;
    setTimeout(() => tab.destroy(), 0);
    this.updateTitle();
    this.emit();
    return true;
  }

  async requestQuit() {
    for (const d of [...this.docs]) {
      if (d.dirty && !(await this.closeTab(d.id))) return;
    }
    this.savePrefs();
    platform.closeConfirmed();
  }

  // ---------------- 자동 저장 / 복구 ----------------
  restartAutosave() {
    if (this.autosaveTimer) clearInterval(this.autosaveTimer);
    const m = this.prefs.autosaveMinutes;
    if (!m || m <= 0) return;
    this.autosaveTimer = setInterval(() => this.autosaveNow(), m * 60 * 1000);
  }

  private autosavedDoc = new WeakMap<DocTab, unknown>();
  /**
   * 자동 저장. 큰 문서는 직렬화에 수백 ms 가 걸리므로 평소에는 입력이 멈춘 유휴 시간에 문서 하나씩 처리한다.
   * (immediate: 로그오프·종료 때처럼 바로 해야 할 때)
   */
  async autosaveNow(immediate = false) {
    const jobs: Promise<unknown>[] = [];
    const idle = () => new Promise<void>((r) => ((window as any).requestIdleCallback ? (window as any).requestIdleCallback(() => r(), { timeout: 4000 }) : setTimeout(r, 0)));
    for (const d of this.docs) {
      if (!d.dirty) continue;
      // 지난 자동 저장 뒤로 바뀐 것이 없으면 건너뛴다
      if (this.autosavedDoc.get(d) === d.editor.state.doc) continue;
      if (!immediate) await idle();
      this.autosavedDoc.set(d, d.editor.state.doc);
      const json = JSON.stringify({ title: d.title, path: d.path, saveFormat: d.saveFormat, doc: d.toKDocument(), time: Date.now() });
      jobs.push(Promise.resolve(platform.autosaveWrite(d.id, json)).catch(() => {}));
    }
    await Promise.all(jobs);
  }

  private async checkRecovery() {
    const list = await platform.autosaveList();
    if (!list.length) return;
    const r = await this.confirm(
      '문서 복구',
      `비정상적으로 종료되어 저장되지 않은 문서 ${list.length}개가 있습니다. 복구하시겠습니까?`,
      [
        { id: 'yes', label: '복구', primary: true },
        { id: 'no', label: '삭제', danger: true },
      ],
    );
    let failed = 0;
    for (const item of list) {
      if (r === 'yes') {
        try {
          const data = JSON.parse(item.json);
          if (!data?.doc?.content) throw new Error('empty');
          const tab = new DocTab({
            content: data.doc.content,
            settings: data.doc.settings,
            meta: data.doc.meta,
            title: data.title + ' (복구됨)',
            path: typeof data.path === 'string' ? data.path : null,
          });
          tab.saveFormat = data.saveFormat;
          tab.markDirty();
          if (tab.path) this.overwriteConfirm.set(tab.id, 'recovered');
          this.addDoc(tab);
        } catch {
          // 깨진 복구 파일은 지우지 않고 남겨 둔다 (유일한 사본일 수 있다)
          failed++;
          continue;
        }
      }
      platform.autosaveRemove(item.id);
    }
    if (failed) this.toast(`복구 파일 ${failed}개를 읽지 못했습니다. 파일은 자동 저장 폴더에 그대로 두었습니다.`, 'warn', 8000);
  }

  // ---------------- 보기 ----------------
  setZoom(z: number, mode: AppController['zoomMode'] = 'custom') {
    const zoom = Math.max(0.25, Math.min(4, Math.round(z * 100) / 100));
    viewState.zoom = zoom;
    this.zoom = zoom;
    this.zoomMode = mode;
    this.emit();
    // 배율은 CSS 변환이라 쪽 나누기를 다시 잴 필요가 없다 (큰 문서에서 확대/축소 때마다 300ms 가 들었다)
    this.savePrefs();
  }

  setMultiPage(on: boolean) {
    if (this.multiPage === on) return;
    this.multiPage = on;
    this.emit();
  }

  toggleView(k: keyof ViewOptions) {
    this.view = { ...this.view, [k]: !this.view[k] };
    this.emit();
    this.savePrefs();
    setTimeout(() => window.dispatchEvent(new Event('kite:relayout')), 0);
  }

  fontList(): { korean: string[]; others: string[]; recent: string[] } {
    const sys = this.systemFonts;
    const isKo = (s: string) => /[가-힯]/.test(s);
    const set = new Set<string>();
    if (sys.length) {
      sys.forEach((f) => !f.startsWith('@') && set.add(f));
      set.add('함초롬바탕');
      set.add('함초롬돋움');
    } else {
      KOREAN_FONTS.forEach((f) => set.add(f));
      LATIN_FONTS.forEach((f) => set.add(f));
    }
    const all = [...set];
    return {
      recent: this.prefs.recentFonts.slice(0, 6),
      korean: all.filter(isKo).sort((a, b) => a.localeCompare(b, 'ko')),
      others: all.filter((f) => !isKo(f)).sort((a, b) => a.localeCompare(b, 'en')),
    };
  }

  rememberFont(f: string) {
    this.prefs.recentFonts = [f, ...this.prefs.recentFonts.filter((x) => x !== f)].slice(0, 8);
    this.savePrefs();
  }
}

export const app = new AppController();
