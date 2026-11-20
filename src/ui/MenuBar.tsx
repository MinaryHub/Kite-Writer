import { useEffect, useRef, useState } from 'react';
import { commands, runCommand } from '../app/commands';
import { useApp } from '../app/hooks';
import { useOutsideClose } from './widgets';
import { Icon } from './Icon';
import { baseName } from '../formats/common';
import { platform } from '../platform';

export type MenuEntry =
  | string
  | '-'
  | { label: string; items: MenuEntry[] }
  | { label: string; run: () => void; shortcut?: string; disabled?: boolean; icon?: string };

const MENUS: { label: string; key: string; items: () => MenuEntry[] }[] = [
  {
    label: '파일(F)',
    key: 'f',
    items: () => [
      'file.new',
      'file.template',
      'file.open',
      { label: '최근 문서', items: recentItems() },
      '-',
      'file.save',
      'file.saveAs',
      { label: '다른 형식으로 저장', items: ['file.saveHwpx', 'file.saveHwp', 'file.saveDocx', 'file.saveMd', 'file.saveHtml', 'file.saveTxt'] },
      'file.exportPdf',
      '-',
      'file.preview',
      'file.print',
      ...(platform.canShare() ? ['file.share'] : []),
      '-',
      'file.versions',
      'file.info',
      'file.close',
      'file.exit',
    ],
  },
  {
    label: '편집(E)',
    key: 'e',
    items: () => [
      'edit.undo',
      'edit.redo',
      '-',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.pastePlain',
      '-',
      'edit.selectAll',
      'edit.painter',
      '-',
      { label: '글자 바꾸기', items: ['edit.upper', 'edit.lower', 'edit.titleCase'] },
      { label: '정렬', items: ['edit.sortAsc', 'edit.sortDesc'] },
      '-',
      'edit.find',
      'edit.replace',
      'edit.findNext',
      'edit.goto',
    ],
  },
  {
    label: '보기(U)',
    key: 'u',
    items: () => [
      'view.toolbar',
      'view.formatbar',
      'view.ruler',
      'view.statusbar',
      '-',
      'view.marks',
      'view.guides',
      'view.transparent',
      '-',
      'view.zoomIn',
      'view.zoomOut',
      'view.zoom100',
      'view.fitWidth',
      'view.fitPage',
      'view.multiPage',
      'view.autoMultiPage',
      '-',
      'view.darkMode',
      'view.darkPaper',
      '-',
      'view.fullscreen',
    ],
  },
  {
    label: '입력(D)',
    key: 'd',
    items: () => [
      'insert.table',
      'insert.image',
      'image.crop',
      'object.props',
      'insert.shape',
      'insert.textBox',
      '-',
      'insert.ruby',
      'insert.compose',
      '-',
      'insert.link',
      'insert.clickHere',
      'insert.footnote',
      'insert.math',
      'insert.symbol',
      { label: '한자', items: ['insert.hanja', 'edit.hanjaToHangul'] },
      { label: '날짜/시간', items: ['insert.date', 'insert.dateKo', 'insert.time'] },
      { label: '차례', items: ['insert.toc', 'insert.tocUpdate', '-', 'format.leaderTab'] },
      '-',
      'insert.pageBreak',
      'insert.columnBreak',
      'insert.hr',
      'insert.quote',
      'insert.code',
      'insert.taskList',
    ],
  },
  {
    label: '서식(J)',
    key: 'j',
    items: () => [
      'format.char',
      'format.para',
      'format.style',
      '-',
      { label: '글자 속성', items: ['format.bold', 'format.italic', 'format.underline', 'format.strike', 'format.sup', 'format.sub', '-', 'format.sizeUp', 'format.sizeDown', 'format.clear'] },
      { label: '정렬', items: ['format.alignJustify', 'format.alignLeft', 'format.alignCenter', 'format.alignRight', 'format.alignDistribute'] },
      { label: '줄 간격', items: ['format.lineUp', 'format.lineDown'] },
      '-',
      'format.bullet',
      'format.number',
      'format.govNumber',
      'format.outdent',
      'format.indent',
      '-',
      'edit.painter',
    ],
  },
  {
    label: '쪽(W)',
    key: 'w',
    items: () => ['page.setup', 'page.orientation', 'page.border', '-', 'page.headerFooter', 'page.number', '-', 'page.columns', 'insert.columnBreak', 'insert.pageBreak', '-', 'page.prev', 'page.next', 'edit.goto'],
  },
  {
    label: '표(B)',
    key: 'b',
    items: () => [
      'table.insert',
      '-',
      'table.rowBefore',
      'table.rowAfter',
      'table.colBefore',
      'table.colAfter',
      '-',
      'table.deleteRow',
      'table.deleteCol',
      '-',
      'table.select',
      'table.selectCell',
      'table.merge',
      'table.split',
      'table.equalWidth',
      'table.equalHeight',
      'table.header',
      '-',
      { label: '쉬운 계산식', items: ['table.sumRow', 'table.sumCol', '-', 'table.avgRow', 'table.avgCol', '-', 'table.prodRow', 'table.prodCol'] },
      'table.toText',
      'table.fromText',
      '-',
      'table.cellProps',
      'table.delete',
    ],
  },
  {
    label: '검토(R)',
    key: 'r',
    items: () => [
      'tools.check',
      'tools.privacy',
      '-',
      'review.addComment',
      'review.panel',
      '-',
      'review.track',
      'review.acceptSel',
      'review.rejectSel',
      'review.acceptAll',
      'review.rejectAll',
    ],
  },
  {
    label: '도구(K)',
    key: 'k',
    items: () => ['tools.palette', '-', 'tools.ai', 'tools.mcp', 'tools.collab', '-', 'tools.check', 'tools.privacy', 'tools.spell', 'tools.wordCount', '-', 'tools.overwrite', '-', 'tools.prefs', 'tools.shortcuts', '-', 'tools.contact', 'tools.sponsor', '-', 'tools.privacyPolicy', 'tools.licenses', 'tools.about'],
  },
];

let appRef: ReturnType<typeof useApp> | null = null;

/** 안드로이드에서는 쓸 수 없는 데스크톱 전용 메뉴를 감춘다 (눌러도 안내만 뜨거나 아무 일도 없었다) */
const DESKTOP_ONLY = new Set(['tools.ai', 'tools.mcp', 'tools.collab', 'view.fullscreen']);
function visibleItems(items: MenuEntry[]): MenuEntry[] {
  if (!platform.isAndroid) return items;
  const out = items.filter((it) => !(typeof it === 'string' && DESKTOP_ONLY.has(it)));
  // 감춘 뒤 이어지거나 끝에 남은 구분선 정리
  return out.filter((it, i) => !(it === '-' && (i === 0 || out[i - 1] === '-' || i === out.length - 1)));
}

function recentItems(): MenuEntry[] {
  const list = appRef?.recent || [];
  if (!list.length) return [{ label: '(최근 문서 없음)', run: () => {}, disabled: true }];
  return [
    ...list.slice(0, 12).map((p, i) => ({ label: `${i + 1} ${baseName(p)}`, run: () => appRef?.openPath(p), shortcut: '' })),
    '-',
    { label: '목록 지우기', run: async () => appRef && appRef.set({ recent: await (await import('../platform')).platform.clearRecent() }) },
  ];
}

export function MenuList({ items, close }: { items: MenuEntry[]; close: () => void }) {
  const [sub, setSub] = useState<number | null>(null);
  return (
    <>
      {items.map((it, i) => {
        if (it === '-') return <div key={i} className="menu-sep" />;
        if (typeof it === 'string') {
          const c = commands[it];
          if (!c) return null;
          const disabled = c.enabled ? !c.enabled() : false;
          const checked = c.active ? c.active() : false;
          return (
            <div
              key={i}
              className={'menu-item' + (disabled ? ' disabled' : '')}
              onMouseEnter={() => setSub(null)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                if (disabled) return;
                close();
                setTimeout(() => runCommand(it), 0);
              }}
            >
              <span className="mi-icon">{checked ? <Icon name="Check" size={14} color="#2f6fd6" /> : <Icon name={c.icon} size={14} />}</span>
              <span className="mi-label">{c.label}</span>
              {c.shortcut && <span className="mi-short">{c.shortcut}</span>}
            </div>
          );
        }
        if ('items' in it) {
          return (
            <div
              key={i}
              className="menu-item"
              onMouseEnter={() => setSub(i)}
              onMouseDown={(e) => e.preventDefault()}
              // 터치 화면: 눌러서 펼친다
              onClick={() => setSub(i)}
            >
              <span className="mi-icon" />
              <span className="mi-label">{it.label}</span>
              <Icon name="ChevronRight" size={13} />
              {sub === i && (
                <div className="menu-pop menu-sub">
                  <MenuList items={it.items} close={close} />
                </div>
              )}
            </div>
          );
        }
        return (
          <div
            key={i}
            className={'menu-item' + (it.disabled ? ' disabled' : '')}
            onMouseEnter={() => setSub(null)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (it.disabled) return;
              close();
              setTimeout(() => it.run(), 0);
            }}
          >
            <span className="mi-icon">
              <Icon name={it.icon} size={14} />
            </span>
            <span className="mi-label">{it.label}</span>
            {it.shortcut && <span className="mi-short">{it.shortcut}</span>}
          </div>
        );
      })}
    </>
  );
}

export function MenuBar() {
  const app = useApp();
  appRef = app;
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  useOutsideClose(open !== null, () => setOpen(null), ref);
  // Alt+글자 로 메뉴 열기 (commands.ts 의 단축키 처리가 알린다)
  useEffect(() => {
    const h = (e: Event) => {
      const i = MENUS.findIndex((m) => m.key === (e as CustomEvent).detail);
      if (i < 0) return;
      e.preventDefault();
      setOpen((o) => (o === i ? null : i));
    };
    window.addEventListener('kite:open-menu', h);
    return () => window.removeEventListener('kite:open-menu', h);
  }, []);
  return (
    <div className="menubar" ref={ref}>
      <div className="brand">
        <img className="brand-mark" src="./icon.svg" alt="" />
        <span>Kite</span>
      </div>
      {MENUS.map((m, i) => (
        <div key={m.label} className={'menu-root' + (open === i ? ' open' : '')}>
          <button onMouseDown={(e) => (e.preventDefault(), setOpen(open === i ? null : i))} onMouseEnter={() => open !== null && setOpen(i)}>
            {m.label}
          </button>
          {open === i && (
            <div className="menu-pop">
              <MenuList items={visibleItems(m.items())} close={() => setOpen(null)} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
