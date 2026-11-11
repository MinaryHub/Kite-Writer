import { Editor } from '@tiptap/react';
import type { JSONContent } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import { getEditorExtensions } from '../editor/extensions';
import { sanitizeDoc } from '../editor/sanitize';
import type { DocMeta, DocSettings, FormatId, KDocument, SaveFormatId } from '../types';
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
  layout: LayoutResult = { pageCount: 1, footnotes: [], pageStarts: [0] };
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
  }) {
    this.id = `doc-${Date.now().toString(36)}-${++seq}`;
    this.title = init.title;
    this.path = init.path || null;
    this.sourceFormat = init.sourceFormat || null;
    this.saveFormat = this.sourceFormat === 'hwpx' || this.sourceFormat === 'hwp' || this.sourceFormat === 'docx' ? this.sourceFormat : this.sourceFormat === 'md' || this.sourceFormat === 'html' || this.sourceFormat === 'txt' ? this.sourceFormat : null;
    this.settings = init.settings || defaultSettings();
    this.meta = init.meta || {};
    this.warnings = init.warnings || [];
    this.editor = new Editor({
      extensions: getEditorExtensions(),
      content: '',
      editorProps: {
        attributes: { class: 'kdoc-content', spellcheck: 'false', autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off' },
      },
      injectCSS: false,
      enableInputRules: true,
      enablePasteRules: true,
    });
    // 한글 문서는 한글과 같은 글자 폭으로 (줄 바꿈·쪽 나누기가 한글과 맞게)
    this.editor.storage.hwpMetrics.enabled = !!this.settings.hwpMetrics;
    if (init.content) this.setContent(init.content, true);
    this.savedDoc = this.editor.state.doc;
    this.editor.on('update', ({ transaction }) => {
      // 탭 폭 맞춤(화면 배치)만 바뀐 것은 저장할 변경이 아니다: 저장한 문서로 여긴다
      if (transaction.getMeta(tabFillKey) && !this.dirty) this.savedDoc = this.editor.state.doc;
      const d = this.editor.state.doc !== this.savedDoc;
      if (d !== this.dirty) {
        this.dirty = d;
        this.emit();
      }
    });
    this.editor.storage.pagination.listeners.add((r: LayoutResult) => {
      this.layout = r;
      this.emit();
    });
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
    view.dispatch(tr);
  }

  toKDocument(): KDocument {
    return { content: this.editor.getJSON(), settings: this.settings, meta: this.meta };
  }

  markSaved() {
    this.savedDoc = this.editor.state.doc;
    this.dirty = false;
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
