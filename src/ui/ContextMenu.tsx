import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DocTab } from '../doc/docTab';
import { MenuList, type MenuEntry } from './MenuBar';
import { platform } from '../platform';
import { app } from '../app/controller';

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;

function Menu({ x, y, items, onClose }: { x: number; y: number; items: MenuEntry[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  useEffect(() => {
    const el = ref.current!;
    const r = el.getBoundingClientRect();
    setPos({ x: Math.min(x, window.innerWidth - r.width - 4), y: Math.min(y, window.innerHeight - r.height - 4) });
    const h = (e: MouseEvent) => !el.contains(e.target as Node) && onClose();
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    setTimeout(() => window.addEventListener('mousedown', h), 0);
    window.addEventListener('keydown', k);
    window.addEventListener('blur', onClose);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
      window.removeEventListener('blur', onClose);
    };
  }, []);
  return (
    <div className="ctx-menu" ref={ref} style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <MenuList items={items} close={onClose} />
    </div>
  );
}

export function showContextMenu(x: number, y: number, tab: DocTab) {
  const editor = tab.editor;
  const items: MenuEntry[] = ['edit.cut', 'edit.copy', 'edit.paste', 'edit.pastePlain', '-'];
  const link = editor.getAttributes('link').href;
  if (link) {
    items.push(
      { label: '하이퍼링크 열기', icon: 'Link', run: () => platform.openExternal(link) },
      { label: '하이퍼링크 고치기...', run: () => app.openDialog('link') },
      { label: '하이퍼링크 지우기', run: () => editor.chain().focus().extendMarkRange('link').unsetLink().run() },
      '-',
    );
  }
  const sel = editor.state.selection as { node?: { type: { name: string } } };
  if (sel.node && /^(image|shape|textBox)$/.test(sel.node.type.name)) items.push('object.props');
  if (editor.isActive('image')) {
    items.push('image.crop', 'image.uncrop');
    items.push(
      {
        label: '그림 원래 크기로',
        icon: 'Maximize2',
        run: () => {
          const { from } = editor.state.selection;
          const node = editor.state.doc.nodeAt(from);
          if (node?.type.name !== 'image') return;
          const img = new Image();
          img.onload = () => editor.view.dispatch(editor.state.tr.setNodeMarkup(from, undefined, { ...node.attrs, width: img.naturalWidth, height: img.naturalHeight }));
          img.src = node.attrs.src;
        },
      },
      '-',
    );
  }
  items.push('review.addComment');
  if (editor.isActive('insertion') || editor.isActive('deletion')) items.push('review.acceptSel', 'review.rejectSel');
  items.push('-');
  items.push('format.char', 'format.para', 'format.style', '-');
  if (editor.isActive('table')) {
    items.push(
      'table.select',
      'table.cellProps',
      'table.merge',
      'table.split',
      '-',
      'table.rowBefore',
      'table.rowAfter',
      'table.colBefore',
      'table.colAfter',
      '-',
      'table.deleteRow',
      'table.deleteCol',
      'table.delete',
      '-',
    );
  }
  items.push('insert.link', 'insert.footnote', 'insert.symbol');
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const close = () => root!.render(<></>);
  root!.render(<Menu key={Date.now()} x={x} y={y} items={items} onClose={close} />);
}
