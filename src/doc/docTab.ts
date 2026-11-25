import { Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { Plugin, PluginKey, Selection } from '@tiptap/pm/state';
import { getEditorExtensions } from '../editor/extensions';
import { sanitizeDoc } from '../editor/sanitize';
import type { DocMeta, DocProtect, DocSettings, FormatId, KDocument, SaveFormatId } from '../types';
import { defaultSettings } from '../formats/common';
import type { LayoutResult } from '../editor/extensions/pagination';
import { tabFillKey } from '../editor/extensions/tabFill';

let seq = 0;

export class DocTab {
  id: string;
  title: string;
  path: string | null;
  sourceFormat: FormatId | null;
  saveFormat: SaveFormatId | null;
  editor: Editor;
  settings: DocSettings;
  meta: DocMeta;
  dirty = false;
  warnings: string[] = [];
  /** 배포용 문서처럼 보호된 문서: 고칠 수 없고 저장하지 않는다 (복사·인쇄도 막을 수 있다) */
  readonly protect: DocProtect | null;
  /** 쪽 배치 결과: 늘 최신 값 (쪽 시작 위치처럼 화면을 다시 그리지 않는 변화도 반영) */
  get layout(): LayoutResult {
    return this.editor.storage.pagination.result;
  }
  scrollTop = 0;
  private listeners = new Set<() => void>();
  private savedDoc: any = null;

  constructor(init: {
    content?: JSONContent;
    settings?: DocSettings;
    meta?: DocMeta;
    title: string;
    path?: string | null;
    sourceFormat?: FormatId | null;
    warnings?: string[];
    protect?: DocProtect | null;
  }) {
    this.id = `doc-${Date.now().toString(36)}-${++seq}`;
    this.title = init.title;
    this.path = init.path || null;
    this.sourceFormat = init.sourceFormat || null;
    this.saveFormat = this.sourceFormat === 'hwpx' || this.sourceFormat === 'hwp' || this.sourceFormat === 'docx' ? this.sourceFormat : this.sourceFormat === 'md' || this.sourceFormat === 'html' || this.sourceFormat === 'txt' ? this.sourceFormat : null;
    this.settings = init.settings || defaultSettings();
    this.meta = init.meta || {};
    this.warnings = init.warnings || [];
    this.protect = init.protect || null;
    if (this.protect) this.saveFormat = null;
    const block = (_v: unknown, e: Event) => {
      e.preventDefault();
      return true;
    };
    this.editor = new Editor({
      extensions: getEditorExtensions(),
      content: '',
      editorProps: {
        attributes: { class: 'kdoc-content', spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off' },
        // 복사를 막은 문서: 복사·오려 두기·끌어 놓기로 글을 꺼내지 못하게
        ...(this.protect?.noCopy ? { handleDOMEvents: { copy: block, cut: block, dragstart: block } } : {}),
      },
      editable: !this.protect,
      injectCSS: false,
      enableInputRules: true,
      enablePasteRules: true,
    });
    // 한글 문서는 한글과 같은 글자 폭으로 (줄 바꿈·쪽 나누기가 한글과 맞게)
    this.editor.storage.hwpMetrics.enabled = !!this.settings.hwpMetrics;
    if (init.content) this.setContent(init.content, true);
    this.savedDoc = this.editor.state.doc;
    // 보호된 문서: 도구 상자·명령이 편집기를 직접 고치는 것도 막는다.
    // 되돌리기 기록에 남지 않는 것(쪽 배치처럼 화면을 맞추는 변화)만 지나가게 한다
    if (this.protect)
      this.editor.registerPlugin(
        new Plugin({
          key: new PluginKey('kiteProtect'),
          filterTransaction: (tr) => !tr.docChanged || tr.getMeta('addToHistory') === false || !!tr.getMeta(tabFillKey),
        }),
      );
    this.editor.on('update', ({ transaction }) => {
      // 탭 폭 맞춤(화면 배치)만 바뀐 것은 저장할 변경이 아니다: 저장한 문서로 여긴다
      if (transaction.getMeta(tabFillKey) && !this.dirty) this.savedDoc = this.editor.state.doc;
      const d = this.editor.state.doc !== this.savedDoc;
      if (d !== this.dirty) {
        this.dirty = d;
        this.emit();
      }
    });
    this.editor.storage.pagination.listeners.add(() => this.emit());
  }

  setContent(json: JSONContent, initial = false) {
    const doc = sanitizeDoc(json as any, this.editor.schema);
    const { state, view } = this.editor;
    const tr = state.tr.replaceWith(0, state.doc.content.size, doc.content);
    tr.setSelection(Selection.atStart(tr.doc));
    // 처음 불러온 내용은 되돌리기 기록에서 제외
    if (initial) tr.setMeta('addToHistory', false);
    // 문서를 통째로 바꾸는 것은 변경 내용 추적 대상이 아니다
    tr.setMeta('trackChanges:skip', true);
    // 원본 보존형 저장의 줄 정보를 지우지 않는다 (hwpKeep)
    tr.setMeta('hwpKeep', true);
    view.dispatch(tr);
  }

  toKDocument(): KDocument {
    return { content: this.editor.getJSON(), settings: this.settings, meta: this.meta };
  }

  /**
   * 저장 완료. snap: 저장한 내용의 문서 (저장하는 동안 더 고친 것이 있으면 그것은 여전히 '수정됨' 이다)
   */
  markSaved(snap = this.editor.state.doc) {
    this.savedDoc = snap;
    this.dirty = this.editor.state.doc !== snap;
    this.emit();
  }

  markDirty() {
    this.dirty = true;
    this.emit();
  }

  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  emit() {
    this.listeners.forEach((f) => f());
  }

  destroy() {
    this.editor.destroy();
    this.listeners.clear();
  }
}
