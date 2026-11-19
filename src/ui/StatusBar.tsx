import { useEffect, useState } from 'react';
import { useApp, useEditorTick } from '../app/hooks';
import { caretPage } from './PageView';
import { runCommand } from '../app/commands';

export function StatusBar() {
  const app = useApp();
  const tab = app.active;
  useEditorTick(tab?.editor);
  // 글자·단어 수는 문서 전체를 세므로(큰 문서에서 20ms) 입력마다 세지 않고 잠시 뒤에 한 번만 센다
  const [counts, setCounts] = useState<{ chars: number; words: number; doc: unknown }>({ chars: 0, words: 0, doc: null });
  useEffect(() => {
    if (!tab) return;
    const ed = tab.editor;
    const d = ed.state.doc;
    if (counts.doc === d) return;
    const big = d.content.size > 50000;
    const t = setTimeout(() => {
      const cc = ed.storage.characterCount;
      setCounts({ chars: cc?.characters() ?? 0, words: cc?.words() ?? 0, doc: d });
    }, counts.doc == null ? 0 : big ? 700 : 150);
    return () => clearTimeout(t);
  });
  // 훅(useState·useEffect)을 모두 부른 뒤에 감춘다 (상태 표시줄을 껐다 켤 때 훅 순서가 어긋나지 않게)
  if (!app.view.statusbar) return null;
  let page = 1;
  let pages = 1;
  let line = 1;
  let col = 1;
  let chars = 0;
  let words = 0;
  let overwrite = false;
  let selChars = 0;
  if (tab) {
    const ed = tab.editor;
    pages = tab.layout.pageCount;
    page = caretPage(tab);
    const { $head, from, to } = ed.state.selection;
    col = $head.parentOffset + 1;
    try {
      const view = ed.view;
      const a = view.coordsAtPos($head.start());
      const b = view.coordsAtPos($head.pos);
      const lh = Math.max(8, (b.bottom - b.top) * 1.2);
      line = Math.max(1, Math.round((b.top - a.top) / lh) + 1);
    } catch {
      /* 무시 */
    }
    chars = counts.chars;
    words = counts.words;
    overwrite = !!ed.storage.keyboardExtras?.overwrite;
    if (to > from) selChars = ed.state.doc.textBetween(from, to, '\n').length;
  }
  const pct = Math.round(app.zoom * 100);
  return (
    <div className="statusbar">
      <span className="sb-item click" title="찾아가기 (Alt+G)" onClick={() => runCommand('edit.goto')}>
        {page} / {pages} 쪽
      </span>
      <span className="sb-item">
        {line}줄 {col}칸
      </span>
      <span className="sb-item click" title="문서 정보" onClick={() => runCommand('file.info')}>
        글자 {chars.toLocaleString()} · 단어 {words.toLocaleString()}
        {selChars ? ` · 선택 ${selChars.toLocaleString()}` : ''}
      </span>
      <span className="sb-item click" title="Insert 키로 전환" onClick={() => runCommand('tools.overwrite')}>
        {overwrite ? '수정' : '삽입'}
      </span>
      {tab?.sourceFormat && <span className="sb-item">{tab.sourceFormat.toUpperCase()}</span>}
      {app.painter && <span className="sb-item" style={{ color: '#2f6fd6' }}>모양 복사 중 (Esc 취소)</span>}
      <span className="sb-spacer" />
      <span className="zoom-ctl">
        <button onClick={() => runCommand('view.fitWidth')} title="폭 맞춤">
          폭 맞춤
        </button>
        <button onClick={() => runCommand('view.fitPage')} title="쪽 맞춤">
          쪽 맞춤
        </button>
        <button className={app.multiPage ? 'on' : ''} onClick={() => runCommand('view.multiPage')} title="여러 쪽 보기 (Ctrl+Alt+M)">
          여러 쪽
        </button>
        <button onClick={() => app.setZoom(app.zoom - 0.1)} title="축소">
          −
        </button>
        <input type="range" min={25} max={300} step={5} value={pct} onChange={(e) => app.setZoom(+e.target.value / 100)} />
        <button onClick={() => app.setZoom(app.zoom + 0.1)} title="확대">
          +
        </button>
        <span className="zv" onDoubleClick={() => app.setZoom(1)} title="두 번 누르면 100%">
          {pct}%
        </span>
      </span>
    </div>
  );
}
