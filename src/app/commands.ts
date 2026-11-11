import { forEachSelectedPara } from '../editor/extensions/paragraphFormat';
import type { Editor } from '@tiptap/react';
import { CellSelection } from '@tiptap/pm/tables';
import { NodeSelection } from '@tiptap/pm/state';
import { app } from './controller';
import { platform } from '../platform';
import { bytesToDataUrl, mimeFromExt, splitExt } from '../formats/common';
import { sniffImageSize } from '../formats/imageUtil';
import { computeGeom } from '../print';
import * as review from './review';
import * as collab from '../collab/session';
import { openSponsor, openContact, contactAvailable } from '../support';
import { applyLeaderTab, insertToc, updateToc } from './toc';

/** 차례 만들기 (제목 1~3 · 한글의 개요 1~3 문단) */
async function runInsertToc() {
  const tab = app.active;
  if (!tab) return;
  if (!(await insertToc(tab))) app.toast('차례에 넣을 제목이 없습니다. 제목 1~3 스타일(또는 개요 문단)을 쓴 문단으로 차례를 만듭니다.', 'error', 6000);
}

async function runUpdateToc() {
  const tab = app.active;
  if (!tab) return;
  if (!(await updateToc(tab))) app.toast('이 문서에 차례가 없습니다. 입력 → 차례 만들기로 넣으세요.', 'error', 5000);
  else app.toast('차례를 새로 고쳤습니다.');
}

function runLeaderTab() {
  const tab = app.active;
  if (!tab) return;
  if (!applyLeaderTab(tab)) app.toast('점선으로 채울 곳을 찾지 못했습니다. "제목 3"처럼 끝에 쪽 번호가 있거나 탭이 든 문단을 고르세요.', 'error', 6000);
}

export interface Command {
  label: string;
  icon?: string;
  /** 표시용 단축키 */
  shortcut?: string;
  /** 전역에서 처리할 단축키 (편집기가 처리하는 경우는 생략) */
  keys?: string[];
  run: () => void;
  enabled?: () => boolean;
  active?: () => boolean;
}

const ed = (): Editor | null => app.active?.editor || null;
const chain = () => ed()!.chain().focus();
const hasDoc = () => !!app.active;
const inTable = () => !!ed()?.isActive('table');

export function insertImagesFromFiles(files: { name: string; data: Uint8Array }[]) {
  const editor = ed();
  if (!editor || !files.length) return;
  const g = computeGeom(app.active!.settings);
  for (const f of files) {
    const [, ext] = splitExt(f.name);
    const mime = mimeFromExt(ext || 'png');
    const src = bytesToDataUrl(f.data, mime);
    const size = sniffImageSize(f.data);
    let w = size?.width || null;
    let h = size?.height || null;
    if (w && h && w > g.contentW) {
      h = Math.round((h * g.contentW) / w);
      w = Math.round(g.contentW);
    }
    editor.chain().focus().setImage({ src, alt: f.name }).run();
    if (w && h) {
      const pos = editor.state.selection.from - 1;
      const node = editor.state.doc.nodeAt(pos);
      if (node?.type.name === 'image') editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, width: w, height: h }));
    }
  }
}

function startFormatPainter() {
  const editor = ed();
  if (!editor) return;
  if (app.painter) {
    app.set({ painter: null });
    return;
  }
  const { $from } = editor.state.selection;
  const marks = (editor.state.storedMarks || $from.marks()).map((m) => m.toJSON());
  const parent = $from.parent;
  const para = parent.type.name === 'paragraph' || parent.type.name === 'heading' ? { ...parent.attrs } : null;
  if (para) delete (para as any).level;
  app.set({ painter: { marks, para } });
  app.toast('모양 복사: 적용할 곳을 블록으로 선택하세요. (Esc 취소)', 'info', 2500);
}

export function applyFormatPainter() {
  const editor = ed();
  const p = app.painter;
  if (!editor || !p) return;
  const sel = editor.state.selection;
  if (sel.empty) return;
  const tr = editor.state.tr;
  // 셀 블록 선택이면 셀마다 범위가 따로 있다
  for (const r of sel.ranges) {
    const from = r.$from.pos;
    const to = r.$to.pos;
    tr.removeMark(from, to);
    for (const m of p.marks) {
      const type = editor.schema.marks[m.type];
      if (type) tr.addMark(from, to, type.create(m.attrs));
    }
  }
  if (p.para) {
    forEachSelectedPara(editor.state, (node, pos) => {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...p.para, level: node.attrs.level });
    });
  }
  editor.view.dispatch(tr);
  app.set({ painter: null });
}

/** 표를 노드로 선택 (복사·오려 두기·지우기용) */
export function selectTable() {
  const editor = ed();
  if (!editor) return;
  const sel = editor.state.selection as any;
  const $from = sel.$anchorCell || editor.state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === 'table') {
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, $from.before(d))));
      editor.view.focus();
      return;
    }
  }
}

/** F5: 셀 → (다시) 표의 모든 셀 → (다시) 표 전체 */
function selectCurrentCell() {
  const editor = ed();
  if (!editor) return;
  const cur = editor.state.selection;
  if (cur instanceof CellSelection) {
    const $a = cur.$anchorCell;
    let tableDepth = -1;
    for (let d = $a.depth; d > 0; d--) if ($a.node(d).type.name === 'table') tableDepth = d;
    if (tableDepth < 0) return;
    const table = $a.node(tableDepth);
    const start = $a.start(tableDepth);
    let first = -1;
    let last = -1;
    table.descendants((n, pos) => {
      if (n.type.name === 'tableCell' || n.type.name === 'tableHeader') {
        if (first < 0) first = start + pos;
        last = start + pos;
        return false;
      }
      return true;
    });
    let count = 0;
    cur.forEachCell(() => count++);
    let total = 0;
    table.descendants((n) => {
      if (n.type.name === 'tableCell' || n.type.name === 'tableHeader') {
        total++;
        return false;
      }
      return true;
    });
    if (count < total) editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, first, last)));
    else selectTable();
    return;
  }
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === 'tableCell' || n.type.name === 'tableHeader') {
      const pos = $from.before(d);
      editor.view.dispatch(editor.state.tr.setSelection(CellSelection.create(editor.state.doc, pos)));
      return;
    }
  }
}

function insertDateTime(fmt: 'date' | 'datetime' | 'time' | 'korean') {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  let s = '';
  if (fmt === 'date') s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  else if (fmt === 'time') s = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  else if (fmt === 'korean') s = `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${days[d.getDay()]}요일`;
  else s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  chain().insertContent(s).run();
}

export const commands: Record<string, Command> = {
  // ----- 파일 -----
  'file.new': { label: '새 문서', icon: 'FilePlus', shortcut: 'Alt+N', keys: ['Alt+N'], run: () => app.newDoc() },
  'file.template': { label: '서식 문서로 새로 만들기...', icon: 'LayoutTemplate', shortcut: 'Ctrl+Alt+N', keys: ['Ctrl+Alt+N'], run: () => app.openDialog('template') },
  'file.open': { label: '불러오기...', icon: 'FolderOpen', shortcut: 'Alt+O', keys: ['Alt+O', 'Ctrl+O'], run: () => app.openFiles() },
  'file.save': { label: '저장하기', icon: 'Save', shortcut: 'Alt+S', keys: ['Alt+S', 'Ctrl+S'], run: () => app.save(), enabled: hasDoc },
  'file.saveAs': { label: '다른 이름으로 저장하기...', icon: 'SaveAll', shortcut: 'Alt+V', keys: ['Alt+V', 'Ctrl+Shift+S'], run: () => app.saveAs(), enabled: hasDoc },
  'file.saveHwpx': { label: 'HWPX로 저장...', run: () => app.saveAs(undefined, 'hwpx'), enabled: hasDoc },
  'file.saveHwp': { label: 'HWP로 저장...', run: () => app.saveAs(undefined, 'hwp'), enabled: hasDoc },
  'file.saveDocx': { label: 'Word(DOCX)로 저장...', run: () => app.saveAs(undefined, 'docx'), enabled: hasDoc },
  'file.saveMd': { label: 'Markdown으로 저장...', run: () => app.saveAs(undefined, 'md'), enabled: hasDoc },
  'file.saveHtml': { label: 'HTML로 저장...', run: () => app.saveAs(undefined, 'html'), enabled: hasDoc },
  'file.saveTxt': { label: '텍스트로 저장...', run: () => app.saveAs(undefined, 'txt'), enabled: hasDoc },
  'file.exportPdf': { label: 'PDF로 저장하기...', icon: 'FileDown', run: () => app.exportPdf(), enabled: hasDoc },
  'file.preview': { label: '미리 보기', icon: 'Eye', run: () => app.set({ previewOpen: true }), enabled: hasDoc },
  'file.print': { label: '인쇄...', icon: 'Printer', shortcut: 'Alt+P', keys: ['Alt+P', 'Ctrl+P'], run: () => app.print(), enabled: hasDoc },
  'file.share': {
    label: '공유하기...',
    icon: 'Share2',
    run: async () => {
      const tab = app.active;
      if (!tab) return;
      // 저장한 파일을 보낸다: 고친 내용이 있으면 먼저 저장
      if ((!tab.path || tab.dirty) && !(await app.save(tab))) return;
      if (tab.path) platform.share(tab.path);
    },
    enabled: () => hasDoc() && platform.canShare(),
  },
  'file.info': { label: '문서 정보...', icon: 'Info', shortcut: 'Ctrl+Q,I', run: () => app.openDialog('docInfo'), enabled: hasDoc },
  'file.close': { label: '문서 닫기', icon: 'X', shortcut: 'Ctrl+F4', keys: ['Ctrl+F4', 'Ctrl+W'], run: () => app.active && app.closeTab(app.active.id), enabled: hasDoc },
  'file.exit': { label: '끝', icon: 'LogOut', shortcut: 'Alt+X', keys: ['Alt+X'], run: () => app.requestQuit() },

  // ----- 편집 -----
  'edit.undo': { label: '되돌리기', icon: 'Undo2', shortcut: 'Ctrl+Z', run: () => collab.collabUndo() || chain().undo().run(), enabled: () => collab.isCollabTab(app.active) || !!ed()?.can().undo() },
  'edit.redo': { label: '다시 실행', icon: 'Redo2', shortcut: 'Ctrl+Shift+Z', run: () => collab.collabUndo(true) || chain().redo().run(), enabled: () => collab.isCollabTab(app.active) || !!ed()?.can().redo() },
  'edit.cut': { label: '오려 두기', icon: 'Scissors', shortcut: 'Ctrl+X', run: () => (ed()?.commands.focus(), document.execCommand('cut')), enabled: hasDoc },
  'edit.copy': { label: '복사하기', icon: 'Copy', shortcut: 'Ctrl+C', run: () => (ed()?.commands.focus(), document.execCommand('copy')), enabled: hasDoc },
  'edit.paste': { label: '붙이기', icon: 'ClipboardPaste', shortcut: 'Ctrl+V', run: () => (ed()?.commands.focus(), platform.paste()), enabled: hasDoc },
  'edit.pastePlain': { label: '텍스트만 붙이기', icon: 'ClipboardType', shortcut: 'Ctrl+Shift+V', run: () => (ed()?.commands.focus(), platform.paste(true)), enabled: hasDoc },
  'edit.selectAll': { label: '모두 선택', icon: 'TextSelect', shortcut: 'Ctrl+A', run: () => chain().selectAll().run(), enabled: hasDoc },
  'edit.painter': { label: '모양 복사', icon: 'Paintbrush', shortcut: 'Alt+C', keys: ['Alt+C'], run: startFormatPainter, enabled: hasDoc, active: () => !!app.painter },
  'edit.find': { label: '찾기...', icon: 'Search', shortcut: 'Ctrl+F', keys: ['Ctrl+F'], run: () => app.set({ findOpen: 'find' }), enabled: hasDoc },
  'edit.replace': { label: '찾아 바꾸기...', icon: 'Replace', shortcut: 'Ctrl+H', keys: ['Ctrl+H', 'Ctrl+F2'], run: () => app.set({ findOpen: 'replace' }), enabled: hasDoc },
  'edit.goto': { label: '찾아가기...', icon: 'CornerDownRight', shortcut: 'Alt+G', keys: ['Alt+G'], run: () => app.openDialog('goto'), enabled: hasDoc },

  // ----- 보기 -----
  'view.ruler': { label: '눈금자', run: () => app.toggleView('ruler'), active: () => app.view.ruler },
  'view.statusbar': { label: '상태 표시줄', run: () => app.toggleView('statusbar'), active: () => app.view.statusbar },
  'view.toolbar': { label: '기본 도구 상자', run: () => app.toggleView('toolbar'), active: () => app.view.toolbar },
  'view.formatbar': { label: '서식 도구 상자', run: () => app.toggleView('formatbar'), active: () => app.view.formatbar },
  'view.marks': { label: '문단 부호', icon: 'Pilcrow', shortcut: 'Ctrl+G,T', run: () => app.toggleView('marks'), active: () => app.view.marks },
  'view.guides': { label: '쪽 윤곽(여백 안내선)', run: () => app.toggleView('guides'), active: () => app.view.guides },
  'view.transparent': { label: '투명 선', run: () => app.toggleView('transparent'), active: () => app.view.transparent },
  'view.zoomIn': { label: '확대', icon: 'ZoomIn', shortcut: 'Ctrl+=', keys: ['Ctrl+=', 'Ctrl++'], run: () => app.setZoom(app.zoom + 0.1) },
  'view.zoomOut': { label: '축소', icon: 'ZoomOut', shortcut: 'Ctrl+-', keys: ['Ctrl+-'], run: () => app.setZoom(app.zoom - 0.1) },
  'view.zoom100': { label: '100%', shortcut: 'Ctrl+0', keys: ['Ctrl+0'], run: () => app.setZoom(1) },
  'view.fitWidth': { label: '폭 맞춤', run: () => window.dispatchEvent(new CustomEvent('kite:fit', { detail: 'width' })) },
  'view.fitPage': { label: '쪽 맞춤', run: () => window.dispatchEvent(new CustomEvent('kite:fit', { detail: 'page' })) },
  'view.multiPage': {
    label: '여러 쪽 보기',
    icon: 'LayoutGrid',
    shortcut: 'Ctrl+Alt+M',
    keys: ['Ctrl+Alt+M'],
    run: () => app.setMultiPage(!app.multiPage),
    active: () => app.multiPage,
    enabled: hasDoc,
  },
  'view.autoMultiPage': {
    label: '축소하면 여러 쪽 보기',
    run: () => {
      app.prefs = { ...app.prefs, autoMultiPage: app.prefs.autoMultiPage === false };
      app.savePrefs();
      app.emit();
    },
    active: () => app.prefs.autoMultiPage !== false,
  },
  'view.fullscreen': { label: '전체 화면', shortcut: 'F11', keys: ['F11'], run: () => platform.toggleFullscreen() },
  'view.darkMode': {
    label: '어두운 화면',
    icon: 'Moon',
    run: () => app.setTheme(app.effectiveTheme === 'dark' ? 'light' : 'dark'),
    active: () => app.effectiveTheme === 'dark',
  },
  'view.darkPaper': {
    label: '종이도 어둡게 (화면에서만)',
    run: () => app.setTheme(app.effectiveTheme === 'dark' ? app.prefs.theme : 'dark', !app.prefs.darkPaper),
    active: () => app.effectiveTheme === 'dark' && app.prefs.darkPaper,
  },

  // ----- 입력 -----
  'insert.table': { label: '표...', icon: 'Table', shortcut: 'Ctrl+N,T', run: () => app.openDialog('table'), enabled: hasDoc },
  'insert.image': {
    label: '그림...',
    icon: 'Image',
    shortcut: 'Ctrl+N,I',
    run: async () => insertImagesFromFiles(await platform.pickImages()),
    enabled: hasDoc,
  },
  'image.crop': { label: '그림 자르기...', icon: 'Crop', run: () => app.openDialog('imageCrop'), enabled: () => isImageSelected() },
  'image.uncrop': {
    label: '자르기 취소',
    run: () => {
      const editor = ed();
      const sel = editor?.state.selection;
      if (!editor || !(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return;
      const a = sel.node.attrs;
      const c = a.crop;
      if (!c) return;
      const w = a.width ? Math.round(a.width / Math.max(0.01, 1 - c.l - c.r)) : null;
      const h = a.height ? Math.round(a.height / Math.max(0.01, 1 - c.t - c.b)) : null;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(sel.from, undefined, { ...a, crop: null, width: w, height: h }));
    },
    enabled: () => isImageSelected() && !!(ed()!.state.selection as NodeSelection).node.attrs.crop,
  },
  'insert.link': { label: '하이퍼링크...', icon: 'Link', shortcut: 'Ctrl+K,H', keys: ['Ctrl+K'], run: () => app.openDialog('link'), enabled: hasDoc },
  'insert.symbol': { label: '문자표...', icon: 'Omega', shortcut: 'Ctrl+F10', keys: ['Ctrl+F10'], run: () => app.openDialog('symbol'), enabled: hasDoc },
  'insert.footnote': { label: '각주', icon: 'Superscript', shortcut: 'Ctrl+N,N', run: () => app.openDialog('footnote', { pos: null, text: '' }), enabled: hasDoc },
  'insert.math': { label: '수식...', icon: 'Sigma', shortcut: 'Ctrl+N,M', run: () => app.openDialog('math', { pos: null, latex: '', hwp: '' }), enabled: hasDoc },
  'insert.toc': { label: '차례 만들기', icon: 'TableOfContents', run: () => void runInsertToc(), enabled: hasDoc },
  'insert.tocUpdate': { label: '차례 새로 고침', icon: 'RefreshCw', run: () => void runUpdateToc(), enabled: hasDoc },
  'format.leaderTab': { label: '제목과 쪽 사이 점선 채우기', icon: 'MoreHorizontal', run: runLeaderTab, enabled: hasDoc },
  'insert.pageBreak': { label: '쪽 나누기', icon: 'SeparatorHorizontal', shortcut: 'Ctrl+Enter', run: () => chain().setPageBreak().run(), enabled: hasDoc },
  'insert.hr': { label: '가로줄', icon: 'Minus', run: () => chain().setHorizontalRule().run(), enabled: hasDoc },
  'insert.date': { label: '날짜 (yyyy-mm-dd)', icon: 'Calendar', run: () => insertDateTime('date'), enabled: hasDoc },
  'insert.dateKo': { label: '날짜 (yyyy년 m월 d일 요일)', icon: 'Calendar', run: () => insertDateTime('korean'), enabled: hasDoc },
  'insert.time': { label: '시간 (hh:mm)', icon: 'Clock', run: () => insertDateTime('time'), enabled: hasDoc },
  'insert.quote': { label: '인용 문단', icon: 'Quote', run: () => chain().toggleBlockquote().run(), enabled: hasDoc, active: () => !!ed()?.isActive('blockquote') },
  'insert.code': { label: '코드 블록', icon: 'Code2', run: () => chain().toggleCodeBlock().run(), enabled: hasDoc, active: () => !!ed()?.isActive('codeBlock') },
  'insert.taskList': { label: '확인 목록(체크리스트)', icon: 'ListChecks', run: () => chain().toggleTaskList().run(), enabled: hasDoc, active: () => !!ed()?.isActive('taskList') },

  // ----- 서식 -----
  'format.char': { label: '글자 모양...', icon: 'Type', shortcut: 'Alt+L', keys: ['Alt+L'], run: () => app.openDialog('charShape'), enabled: hasDoc },
  'format.para': { label: '문단 모양...', icon: 'AlignLeft', shortcut: 'Alt+T', keys: ['Alt+T'], run: () => app.openDialog('paraShape'), enabled: hasDoc },
  'format.style': { label: '스타일...', icon: 'Palette', shortcut: 'F6', keys: ['F6'], run: () => app.openDialog('style'), enabled: hasDoc },
  'format.bold': { label: '진하게', icon: 'Bold', shortcut: 'Ctrl+B', run: () => chain().toggleBold().run(), active: () => !!ed()?.isActive('bold'), enabled: hasDoc },
  'format.italic': { label: '기울임', icon: 'Italic', shortcut: 'Ctrl+I', run: () => chain().toggleItalic().run(), active: () => !!ed()?.isActive('italic'), enabled: hasDoc },
  'format.underline': { label: '밑줄', icon: 'Underline', shortcut: 'Ctrl+U', run: () => chain().toggleUnderline().run(), active: () => !!ed()?.isActive('underline'), enabled: hasDoc },
  'format.strike': { label: '취소선', icon: 'Strikethrough', shortcut: 'Ctrl+Shift+X', keys: ['Ctrl+Shift+X'], run: () => chain().toggleStrike().run(), active: () => !!ed()?.isActive('strike'), enabled: hasDoc },
  'format.sup': { label: '위 첨자', icon: 'Superscript', shortcut: 'Ctrl+.', run: () => chain().toggleSuperscript().run(), active: () => !!ed()?.isActive('superscript'), enabled: hasDoc },
  'format.sub': { label: '아래 첨자', icon: 'Subscript', shortcut: 'Ctrl+,', run: () => chain().toggleSubscript().run(), active: () => !!ed()?.isActive('subscript'), enabled: hasDoc },
  'format.clear': { label: '글자 모양 지우기', icon: 'RemoveFormatting', shortcut: 'Ctrl+Space', keys: ['Ctrl+Space'], run: () => chain().unsetAllMarks().run(), enabled: hasDoc },
  'format.sizeUp': { label: '글자 크게', icon: 'AArrowUp', shortcut: 'Alt+Shift+E', run: () => chain().changeFontSize(1).run(), enabled: hasDoc },
  'format.sizeDown': { label: '글자 작게', icon: 'AArrowDown', shortcut: 'Alt+Shift+R', run: () => chain().changeFontSize(-1).run(), enabled: hasDoc },
  'format.alignLeft': { label: '왼쪽 정렬', icon: 'AlignLeft', shortcut: 'Ctrl+Shift+L', run: () => chain().setTextAlign('left').run(), active: () => alignIs('left'), enabled: hasDoc },
  'format.alignCenter': { label: '가운데 정렬', icon: 'AlignCenter', shortcut: 'Ctrl+Shift+C', run: () => chain().setTextAlign('center').run(), active: () => alignIs('center'), enabled: hasDoc },
  'format.alignRight': { label: '오른쪽 정렬', icon: 'AlignRight', shortcut: 'Ctrl+Shift+R', run: () => chain().setTextAlign('right').run(), active: () => alignIs('right'), enabled: hasDoc },
  'format.alignJustify': { label: '양쪽 정렬', icon: 'AlignJustify', shortcut: 'Ctrl+Shift+M', run: () => chain().setTextAlign('justify').run(), active: () => alignIs('justify'), enabled: hasDoc },
  'format.alignDistribute': { label: '배분 정렬', icon: 'AlignHorizontalSpaceAround', shortcut: 'Ctrl+Shift+T', run: () => chain().setTextAlign('distribute').run(), active: () => alignIs('distribute'), enabled: hasDoc },
  'format.bullet': { label: '글머리표', icon: 'List', shortcut: 'Ctrl+Shift+8', run: () => chain().toggleBulletList().run(), active: () => !!ed()?.isActive('bulletList'), enabled: hasDoc },
  'format.number': { label: '문단 번호', icon: 'ListOrdered', shortcut: 'Ctrl+Shift+7', run: () => chain().toggleOrderedList().run(), active: () => !!ed()?.isActive('orderedList'), enabled: hasDoc },
  'format.indent': { label: '왼쪽 여백 늘리기', icon: 'IndentIncrease', shortcut: 'Ctrl+Alt+F6', keys: ['Ctrl+Alt+F6'], run: () => (ed()?.isActive('listItem') ? chain().sinkListItem('listItem').run() : chain().changeIndent(10).run()), enabled: hasDoc },
  'format.outdent': { label: '왼쪽 여백 줄이기', icon: 'IndentDecrease', shortcut: 'Ctrl+Alt+F5', keys: ['Ctrl+Alt+F5'], run: () => (ed()?.isActive('listItem') ? chain().liftListItem('listItem').run() : chain().changeIndent(-10).run()), enabled: hasDoc },
  'format.lineUp': { label: '줄 간격 넓게', shortcut: 'Alt+Shift+A', run: () => chain().changeLineHeight(10).run(), enabled: hasDoc },
  'format.lineDown': { label: '줄 간격 좁게', shortcut: 'Alt+Shift+Z', run: () => chain().changeLineHeight(-10).run(), enabled: hasDoc },
  'format.paragraph': { label: '바탕글', run: () => chain().setParagraph().run(), enabled: hasDoc },
  'format.h1': { label: '제목 1', run: () => chain().toggleHeading({ level: 1 }).run(), enabled: hasDoc, active: () => !!ed()?.isActive('heading', { level: 1 }) },
  'format.h2': { label: '제목 2', run: () => chain().toggleHeading({ level: 2 }).run(), enabled: hasDoc, active: () => !!ed()?.isActive('heading', { level: 2 }) },
  'format.h3': { label: '제목 3', run: () => chain().toggleHeading({ level: 3 }).run(), enabled: hasDoc, active: () => !!ed()?.isActive('heading', { level: 3 }) },

  // ----- 쪽 -----
  'page.setup': { label: '편집 용지...', icon: 'FileText', shortcut: 'F7', keys: ['F7'], run: () => app.openDialog('pageSetup'), enabled: hasDoc },
  'page.headerFooter': { label: '머리말/꼬리말...', icon: 'PanelTop', shortcut: 'Ctrl+N,H', run: () => app.openDialog('headerFooter'), enabled: hasDoc },
  'page.number': { label: '쪽 번호 매기기...', icon: 'Hash', shortcut: 'Ctrl+N,P', run: () => app.openDialog('pageNumber'), enabled: hasDoc },
  'page.orientation': {
    label: '용지 방향 바꾸기 (가로/세로)',
    icon: 'RectangleHorizontal',
    run: () => {
      const t = app.active;
      if (!t) return;
      t.settings = { ...t.settings, page: { ...t.settings.page, landscape: !t.settings.page.landscape } };
      t.markDirty();
      app.emit();
    },
    enabled: hasDoc,
  },
  'page.next': { label: '다음 쪽', shortcut: 'Alt+PgDn', keys: ['Alt+PageDown'], run: () => window.dispatchEvent(new CustomEvent('kite:page-step', { detail: 1 })) },
  'page.prev': { label: '이전 쪽', shortcut: 'Alt+PgUp', keys: ['Alt+PageUp'], run: () => window.dispatchEvent(new CustomEvent('kite:page-step', { detail: -1 })) },

  // ----- 표 -----
  'table.insert': { label: '표 만들기...', icon: 'Table', shortcut: 'Ctrl+N,T', run: () => app.openDialog('table'), enabled: hasDoc },
  'table.rowBefore': { label: '위쪽에 줄 추가하기', icon: 'ArrowUpToLine', run: () => chain().addRowBefore().run(), enabled: inTable },
  'table.rowAfter': { label: '아래쪽에 줄 추가하기', icon: 'ArrowDownToLine', shortcut: 'Alt+Insert', keys: ['Alt+Insert'], run: () => chain().addRowAfter().run(), enabled: inTable },
  'table.colBefore': { label: '왼쪽에 칸 추가하기', icon: 'ArrowLeftToLine', run: () => chain().addColumnBefore().run(), enabled: inTable },
  'table.colAfter': { label: '오른쪽에 칸 추가하기', icon: 'ArrowRightToLine', run: () => chain().addColumnAfter().run(), enabled: inTable },
  'table.deleteRow': { label: '줄 지우기', icon: 'Rows3', shortcut: 'Alt+Delete', keys: ['Alt+Delete'], run: () => chain().deleteRow().run(), enabled: inTable },
  'table.deleteCol': { label: '칸 지우기', icon: 'Columns3', run: () => chain().deleteColumn().run(), enabled: inTable },
  'table.delete': { label: '표 지우기', icon: 'Trash2', run: () => chain().deleteTable().run(), enabled: inTable },
  'table.merge': { label: '셀 합치기', icon: 'Merge', shortcut: 'M', run: () => chain().mergeCells().run(), enabled: () => !!ed()?.can().mergeCells() },
  'table.split': { label: '셀 나누기', icon: 'Split', shortcut: 'S', run: () => chain().splitCell().run(), enabled: () => !!ed()?.can().splitCell() },
  'table.selectCell': { label: '셀 블록 지정 (F5 반복: 모든 셀 → 표)', shortcut: 'F5', keys: ['F5'], run: selectCurrentCell, enabled: inTable },
  'table.select': { label: '표 선택', icon: 'Table', run: selectTable, enabled: inTable },
  'table.header': { label: '제목 줄 지정/해제', icon: 'PanelTopOpen', run: () => chain().toggleHeaderRow().run(), enabled: inTable },
  'table.cellProps': { label: '셀 테두리/배경...', icon: 'PaintBucket', shortcut: 'L', run: () => app.openDialog('cellProps'), enabled: inTable },
  'table.equalWidth': {
    label: '셀 너비를 같게',
    icon: 'Columns2',
    run: () => {
      const editor = ed();
      if (!editor) return;
      const { $from } = editor.state.selection;
      for (let d = $from.depth; d > 0; d--) {
        const n = $from.node(d);
        if (n.type.name !== 'table') continue;
        const pos = $from.before(d);
        const g = computeGeom(app.active!.settings);
        let cols = 0;
        n.firstChild?.forEach((c) => (cols += c.attrs.colspan || 1));
        const w = Math.floor(g.contentW / Math.max(1, cols));
        const tr = editor.state.tr;
        n.descendants((c, p) => {
          if (c.type.name === 'tableCell' || c.type.name === 'tableHeader') {
            tr.setNodeMarkup(pos + 1 + p, undefined, { ...c.attrs, colwidth: new Array(c.attrs.colspan || 1).fill(w) });
            return false;
          }
          return true;
        });
        editor.view.dispatch(tr);
        return;
      }
    },
    enabled: inTable,
  },

  // ----- 검토 -----
  'review.track': {
    label: '변경 내용 기록',
    icon: 'PencilLine',
    shortcut: 'Ctrl+Shift+E',
    keys: ['Ctrl+Shift+E'],
    run: () => review.setTracking(!review.trackingOn()),
    active: () => review.trackingOn(),
    enabled: hasDoc,
  },
  'review.panel': {
    label: '검토 창 (메모·변경 내용)',
    icon: 'MessageSquare',
    run: () => app.set({ reviewOpen: !app.reviewOpen }),
    active: () => app.reviewOpen,
    enabled: hasDoc,
  },
  'review.addComment': {
    label: '메모 넣기',
    icon: 'MessageSquarePlus',
    shortcut: 'Ctrl+Alt+C',
    keys: ['Ctrl+Alt+C'],
    run: () => app.set({ reviewOpen: true, reviewTab: 'comments', commentDraft: true }),
    enabled: hasDoc,
  },
  'review.acceptSel': {
    label: '이 변경 받아들이기',
    icon: 'Check',
    run: () => {
      const n = review.resolve(true);
      app.toast(n ? `변경 ${n}개를 받아들였습니다.` : '받아들일 변경이 없습니다.');
    },
    enabled: hasDoc,
  },
  'review.rejectSel': {
    label: '이 변경 되돌리기',
    icon: 'X',
    run: () => {
      const n = review.resolve(false);
      app.toast(n ? `변경 ${n}개를 되돌렸습니다.` : '되돌릴 변경이 없습니다.');
    },
    enabled: hasDoc,
  },
  'review.acceptAll': {
    label: '변경 내용 모두 받아들이기',
    icon: 'CheckCheck',
    run: () => {
      const n = review.resolve(true, { all: true });
      app.toast(n ? `변경 ${n}개를 모두 받아들였습니다.` : '받아들일 변경이 없습니다.');
    },
    enabled: hasDoc,
  },
  'review.rejectAll': {
    label: '변경 내용 모두 되돌리기',
    run: () => {
      const n = review.resolve(false, { all: true });
      app.toast(n ? `변경 ${n}개를 모두 되돌렸습니다.` : '되돌릴 변경이 없습니다.');
    },
    enabled: hasDoc,
  },

  // ----- 도구 -----
  'tools.privacy': {
    label: '개인정보 찾기·가림...',
    icon: 'EyeOff',
    run: () => app.openDialog('privacy'),
    enabled: hasDoc,
  },
  'file.versions': {
    label: '버전 기록',
    icon: 'History',
    shortcut: 'Ctrl+Alt+H',
    keys: ['Ctrl+Alt+H'],
    run: () => app.set({ versionsOpen: !app.versionsOpen }),
    active: () => app.versionsOpen,
    enabled: hasDoc,
  },
  'tools.collab': {
    label: '실시간 공동 편집 (실험)...',
    icon: 'Users',
    run: () => app.openDialog('collab'),
    enabled: () => collab.collabAvailable(),
    active: () => !!collab.collabState(),
  },
  'tools.check': {
    label: '맞춤법·공문서 검사',
    icon: 'SpellCheck',
    shortcut: 'F8',
    keys: ['F8'],
    run: () => app.set({ checkOpen: !app.checkOpen }),
    active: () => app.checkOpen,
    enabled: hasDoc,
  },
  'tools.spell': {
    label: '영문 맞춤법 밑줄',
    run: () => {
      app.prefs.spellcheck = !app.prefs.spellcheck;
      app.savePrefs();
      document.querySelectorAll('.kdoc-content').forEach((el) => el.setAttribute('spellcheck', String(app.prefs.spellcheck)));
      app.toast(app.prefs.spellcheck ? '맞춤법 검사를 켰습니다.' : '맞춤법 검사를 껐습니다.');
      app.emit();
    },
    active: () => app.prefs.spellcheck,
  },
  'tools.wordCount': { label: '글자 수 세기...', icon: 'BarChart3', run: () => app.openDialog('docInfo'), enabled: hasDoc },
  'tools.ai': { label: 'AI 도우미 (Claude·GPT·Gemini)', icon: 'Sparkles', shortcut: 'Ctrl+Shift+A', keys: ['Ctrl+Shift+A'], run: () => app.set({ aiOpen: !app.aiOpen }), active: () => app.aiOpen },
  'tools.prefs': { label: '환경 설정...', icon: 'Settings', run: () => app.openDialog('prefs') },
  'tools.shortcuts': { label: '단축키 목록', icon: 'Keyboard', shortcut: 'Shift+F1', keys: ['Shift+F1'], run: () => app.openDialog('shortcuts') },
  'tools.mcp': { label: 'AI 앱 연결 (MCP)...', icon: 'Plug', run: () => app.openDialog('mcp') },
  'tools.about': { label: 'Kite 정보', icon: 'Info', run: () => app.openDialog('about') },
  'tools.sponsor': { label: '후원하기 (GitHub Sponsors)', icon: 'Heart', run: () => openSponsor() },
  'tools.contact': { label: '문의하기...', icon: 'Mail', run: () => openContact(), enabled: () => contactAvailable() },
  'tools.privacyPolicy': { label: '개인정보 처리방침', icon: 'ShieldCheck', run: () => app.openDialog('legal', { kind: 'privacy' }) },
  'tools.licenses': { label: '오픈소스 라이선스', icon: 'FileText', run: () => app.openDialog('legal', { kind: 'licenses' }) },
  'tools.palette': { label: '명령 찾기', icon: 'Command', shortcut: 'Ctrl+Shift+P', keys: ['Ctrl+Shift+P'], run: () => app.set({ paletteOpen: true }) },
  'tools.overwrite': { label: '삽입/수정 모드 전환', shortcut: 'Insert', run: () => chain().toggleOverwrite().run(), enabled: hasDoc },
};

function isImageSelected() {
  const sel = ed()?.state.selection;
  return sel instanceof NodeSelection && sel.node.type.name === 'image';
}

function alignIs(a: string) {
  const editor = ed();
  if (!editor) return false;
  const { $from } = editor.state.selection;
  const p = $from.parent;
  const cur = p.attrs?.textAlign || 'justify';
  return cur === a;
}

export function runCommand(id: string) {
  const c = commands[id];
  if (!c) return;
  if (c.enabled && !c.enabled()) return;
  c.run();
  // 명령 팔레트의 '최근 사용'
  if (id !== 'tools.palette') {
    app.prefs.recentCommands = [id, ...(app.prefs.recentCommands || []).filter((x) => x !== id)].slice(0, 12);
    clearTimeout(recentSaveTimer);
    recentSaveTimer = setTimeout(() => app.savePrefs(), 1500);
  }
}
let recentSaveTimer: any = null;

// ---------------- 전역 단축키 ----------------
function keyName(e: KeyboardEvent): string {
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = k.toUpperCase();
  if (e.code && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (e.code && /^Digit\d$/.test(e.code) && (e.ctrlKey || e.altKey)) k = e.code.slice(5);
  else if (e.code === 'Equal' && (e.ctrlKey || e.metaKey)) k = '=';
  else if (e.code === 'Minus' && (e.ctrlKey || e.metaKey)) k = '-';
  parts.push(k);
  return parts.join('+');
}

const keyMap = new Map<string, string>();
for (const [id, c] of Object.entries(commands)) for (const k of c.keys || []) keyMap.set(k, id);

/** Ctrl+N 다음 글자로 이어지는 한글식 단축키 */
const CHORDS: Record<string, Record<string, string>> = {
  'Ctrl+N': { T: 'insert.table', I: 'insert.image', H: 'page.headerFooter', P: 'page.number', N: 'insert.footnote', M: 'insert.math' },
  'Ctrl+Q': { I: 'file.info' },
  'Ctrl+G': { T: 'view.marks' },
};

let pendingChord: string | null = null;
let chordTimer: any = null;

export function installShortcuts() {
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || e.keyCode === 229) return;
    const name = keyName(e);
    const target = e.target as HTMLElement;
    const inField = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') && !target.closest('.kdoc-content');
    if (e.key === 'Escape') {
      if (app.painter) {
        app.set({ painter: null });
        e.preventDefault();
        return;
      }
    }
    if (pendingChord) {
      const map = CHORDS[pendingChord];
      pendingChord = null;
      clearTimeout(chordTimer);
      const k = name.replace(/^Ctrl\+/, '');
      if (map && map[k]) {
        e.preventDefault();
        e.stopPropagation();
        runCommand(map[k]);
        return;
      }
    }
    if (CHORDS[name] && !inField) {
      e.preventDefault();
      e.stopPropagation();
      pendingChord = name;
      chordTimer = setTimeout(() => (pendingChord = null), 1500);
      return;
    }
    // 셀 블록에서 M/S/L
    const editor = ed();
    if (editor && editor.state.selection instanceof CellSelection && !e.ctrlKey && !e.altKey && !e.metaKey && !inField) {
      const k = e.key.toLowerCase();
      if (k === 'm' || k === 's' || k === 'l') {
        e.preventDefault();
        runCommand(k === 'm' ? 'table.merge' : k === 's' ? 'table.split' : 'table.cellProps');
        return;
      }
    }
    if (inField && !/^(F\d+|Alt\+.|Ctrl\+(S|O|P|W|F4))$/.test(name)) return;
    const id = keyMap.get(name);
    if (id) {
      if (app.dialog && !id.startsWith('file.')) return;
      e.preventDefault();
      e.stopPropagation();
      runCommand(id);
    }
  };
  window.addEventListener('keydown', onKey, true);
  return () => window.removeEventListener('keydown', onKey, true);
}
