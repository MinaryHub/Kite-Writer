import { useEffect } from 'react';
import { useApp } from './app/hooks';
import { installShortcuts } from './app/commands';
import { MenuBar } from './ui/MenuBar';
import { BasicToolbar, FormatBar } from './ui/Toolbar';
import { TabBar } from './ui/TabBar';
import { Ruler } from './ui/Ruler';
import { PageView } from './ui/PageView';
import { MultiPageView } from './ui/MultiPageView';
import { StatusBar } from './ui/StatusBar';
import { FindPanel } from './ui/FindPanel';
import { Dialogs } from './ui/Dialogs';
import { PreviewModal } from './ui/PreviewModal';
import { Icon } from './ui/Icon';
import { AiPanel } from './ui/AiPanel';
import { CommandPalette } from './ui/CommandPalette';
import { CheckPanel } from './ui/CheckPanel';
import { ReviewPanel } from './ui/ReviewPanel';
import { VersionPanel } from './ui/VersionPanel';
import { SelectionBubble } from './ui/SelectionBubble';
import { baseName } from './formats/common';
import { displayPath } from './android';

export function App() {
  const app = useApp();

  useEffect(() => {
    const off = installShortcuts();
    app.init();
    const onFootnote = (e: Event) => {
      const d = (e as CustomEvent).detail;
      app.openDialog('footnote', { pos: d.pos, text: d.text });
    };
    window.addEventListener('kite:edit-footnote', onFootnote);
    const onMath = (e: Event) => app.openDialog('math', (e as CustomEvent).detail);
    window.addEventListener('kite:edit-math', onMath);
    // 브라우저에서 창 닫기 전 경고
    const before = (e: BeforeUnloadEvent) => {
      if (!import.meta.env.DEV && !(window as any).kite && app.docs.some((d) => d.dirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', before);
    return () => {
      off();
      window.removeEventListener('kite:edit-footnote', onFootnote);
      window.removeEventListener('kite:edit-math', onMath);
      window.removeEventListener('beforeunload', before);
    };
  }, []);

  const cls = ['app', app.view.marks ? 'show-marks' : 'hide-marks', app.view.guides ? 'show-guides' : '', app.view.transparent ? '' : 'hide-transparent'].join(' ');

  return (
    <div className={cls}>
      <MenuBar />
      <BasicToolbar />
      <FormatBar />
      <TabBar />
      <div className="main-row">
      <div className="work">
        {app.docs.length > 0 && !app.multiPage && <Ruler />}
        {app.docs.map((d) => (
          <PageView key={d.id} tab={d} active={d.id === app.activeId} hidden={app.multiPage} />
        ))}
        {app.multiPage && app.active && <MultiPageView key={app.active.id} tab={app.active} />}
        {app.docs.length === 0 && <StartScreen />}
        <FindPanel />
      </div>
      <CheckPanel />
      <ReviewPanel />
      <VersionPanel />
      <AiPanel />
      </div>
      <StatusBar />
      <Dialogs />
      <PreviewModal />
      <CommandPalette />
      <SelectionBubble />
      <div className="toast-wrap">
        {app.toasts.map((t) => (
          <div key={t.id} className={'toast ' + t.kind}>
            {t.text}
          </div>
        ))}
      </div>
      {app.busy && (
        <div className="busy">
          <div className="busy-box">
            <div className="spinner" />
            {app.busy}
          </div>
        </div>
      )}
    </div>
  );
}

function StartScreen() {
  const app = useApp();
  return (
    <div className="start-screen">
      <div className="start-card">
        <h1>
          <img className="start-logo" src="./icon.svg" alt="" />
          Kite
        </h1>
        <div className="sub">HWP · HWPX · DOCX · DOC · PDF · Markdown 문서를 열고 편집합니다.</div>
        <div className="start-actions">
          <button onClick={() => app.newDoc()}>
            <Icon name="FilePlus" size={24} />새 문서
          </button>
          <button onClick={() => app.openFiles()}>
            <Icon name="FolderOpen" size={24} />
            불러오기
          </button>
        </div>
        {app.recent.length > 0 && (
          <>
            <div className="unit" style={{ marginBottom: 6 }}>
              최근 문서
            </div>
            <div className="recent-list">
              {app.recent.map((p) => (
                <div key={p} className="ri" onClick={() => app.openPath(p)}>
                  <span>{baseName(p)}</span>
                  <span className="rp">{displayPath(p)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
