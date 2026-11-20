import { useEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { commands, runCommand } from '../app/commands';
import { useApp, useEditorTick } from '../app/hooks';
import { Icon } from './Icon';
import { ColorButton, Dropdown, FontCombo } from './widgets';
import { FONT_SIZES } from '../fonts';
import { HEADING_SIZES } from '../formats/flatten';
import { insertTableFull } from '../editor/tableUtil';

function TbBtn({ id, big, label }: { id: string; big?: boolean; label?: string }) {
  const c = commands[id];
  if (!c) return null;
  const disabled = c.enabled ? !c.enabled() : false;
  const active = c.active ? c.active() : false;
  return (
    <button
      className={'tb-btn' + (big ? ' big' : '') + (active ? ' active' : '')}
      disabled={disabled}
      title={c.label + (c.shortcut ? ` (${c.shortcut})` : '')}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => runCommand(id)}
    >
      <Icon name={c.icon} size={big ? 22 : 16} strokeWidth={big ? 1.5 : 1.7} />
      {big && <span>{label || c.label.replace(/\.\.\.$/, '').replace(/하기$/, '')}</span>}
    </button>
  );
}

function TableGridPicker({ onPick }: { onPick: (r: number, c: number) => void }) {
  const [hover, setHover] = useState<[number, number]>([0, 0]);
  const R = 10;
  const C = 10;
  return (
    <div className="table-grid-picker">
      <div className="tg" style={{ gridTemplateColumns: `repeat(${C}, 16px)` }} onMouseLeave={() => setHover([0, 0])}>
        {Array.from({ length: R * C }, (_, i) => {
          const r = Math.floor(i / C) + 1;
          const c = (i % C) + 1;
          return <div key={i} className={r <= hover[0] && c <= hover[1] ? 'on' : ''} onMouseEnter={() => setHover([r, c])} onClick={() => onPick(r, c)} />;
        })}
      </div>
      <div className="tg-label">{hover[0] ? `${hover[0]} 줄 × ${hover[1]} 칸` : '표 크기 선택'}</div>
      <div style={{ textAlign: 'center', paddingTop: 4 }}>
        <button className="link-btn" onClick={() => runCommand('insert.table')}>
          표 만들기...
        </button>
      </div>
    </div>
  );
}

export function BasicToolbar() {
  const app = useApp();
  useEditorTick(app.active?.editor);
  if (!app.view.toolbar) return null;
  return (
    <div className="toolbar big">
      <TbBtn id="file.new" big label="새 문서" />
      <TbBtn id="file.open" big label="불러오기" />
      <TbBtn id="file.save" big label="저장" />
      <div className="tb-sep" />
      <TbBtn id="file.preview" big label="미리 보기" />
      <TbBtn id="file.print" big label="인쇄" />
      <TbBtn id="file.exportPdf" big label="PDF" />
      <div className="tb-sep" />
      <TbBtn id="edit.cut" big label="오려 두기" />
      <TbBtn id="edit.copy" big label="복사" />
      <TbBtn id="edit.paste" big label="붙이기" />
      <TbBtn id="edit.painter" big label="모양 복사" />
      <div className="tb-sep" />
      <TbBtn id="edit.undo" big label="되돌리기" />
      <TbBtn id="edit.redo" big label="다시 실행" />
      <div className="tb-sep" />
      <TbBtn id="edit.find" big label="찾기" />
      <div className="tb-sep" />
      <Dropdown
        button={(open, toggle) => (
          <button className={'tb-btn big' + (open ? ' active' : '')} title="표 (Ctrl+N,T)" disabled={!app.active} onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
            <Icon name="Table" size={22} strokeWidth={1.5} />
            <span>표</span>
          </button>
        )}
      >
        {(close) => (
          <TableGridPicker
            onPick={(rows, cols) => {
              close();
              app.active && insertTableFull(app.active.editor, app.active.settings, rows, cols);
            }}
          />
        )}
      </Dropdown>
      <TbBtn id="insert.image" big label="그림" />
      <TbBtn id="insert.link" big label="하이퍼링크" />
      <TbBtn id="insert.symbol" big label="문자표" />
      <TbBtn id="insert.footnote" big label="각주" />
      <TbBtn id="insert.pageBreak" big label="쪽 나누기" />
      <div className="tb-sep" />
      <TbBtn id="format.char" big label="글자 모양" />
      <TbBtn id="format.para" big label="문단 모양" />
      <div className="tb-sep" />
      <TbBtn id="page.setup" big label="편집 용지" />
      <TbBtn id="page.headerFooter" big label="머리말" />
      <TbBtn id="page.number" big label="쪽 번호" />
      <div className="tb-sep" />
      <TbBtn id="tools.ai" big label="AI 도우미" />
    </div>
  );
}

const STYLES = [
  { id: 'p', label: '바탕글' },
  { id: 'body', label: '본문' },
  { id: 'h1', label: '제목 1' },
  { id: 'h2', label: '제목 2' },
  { id: 'h3', label: '제목 3' },
  { id: 'h4', label: '제목 4' },
  { id: 'h5', label: '제목 5' },
  { id: 'h6', label: '제목 6' },
  { id: 'quote', label: '인용' },
  { id: 'code', label: '코드' },
];

export function applyStyle(editor: Editor, id: string) {
  const c = editor.chain().focus();
  if (editor.isActive('blockquote') && id !== 'quote') c.lift('blockquote');
  if (id === 'p') c.setParagraph().setParagraphAttrs({ indentLeft: null });
  else if (id === 'body') c.setParagraph().setParagraphAttrs({ indentLeft: 15 });
  else if (/^h\d$/.test(id)) c.setHeading({ level: +id[1] as any });
  else if (id === 'quote') c.setParagraph().toggleBlockquote();
  else if (id === 'code') c.toggleCodeBlock();
  c.run();
}

function currentStyle(editor: Editor): string {
  if (editor.isActive('codeBlock')) return 'code';
  if (editor.isActive('blockquote')) return 'quote';
  for (let l = 1; l <= 6; l++) if (editor.isActive('heading', { level: l })) return 'h' + l;
  const p = editor.state.selection.$from.parent;
  if (p.attrs?.indentLeft === 15) return 'body';
  return 'p';
}

export function currentFontSize(editor: Editor): number {
  const ts = editor.getAttributes('textStyle');
  if (ts.fontSize) return ts.fontSize;
  const p = editor.state.selection.$from.parent;
  if (p.type.name === 'heading') return HEADING_SIZES[p.attrs.level] || 10;
  if (p.attrs?.fontSize) return p.attrs.fontSize;
  return 10;
}

export function currentFont(editor: Editor): string {
  const ts = editor.getAttributes('textStyle');
  if (ts.fontFamily) return String(ts.fontFamily).replace(/['"]/g, '').split(',')[0];
  const p = editor.state.selection.$from.parent;
  if (p.type.name === 'heading') return '함초롬돋움';
  if (editor.isActive('codeBlock')) return 'D2Coding';
  return '함초롬바탕';
}

const LINE_HEIGHTS = [100, 115, 130, 140, 150, 160, 170, 180, 200, 250, 300];

const BULLET_STYLES = [
  { v: null, label: '• 기본' },
  { v: 'k-filled-circle', label: '● 검은 원' },
  { v: 'circle', label: '○ 흰 원' },
  { v: 'square', label: '■ 네모' },
  { v: 'k-hollow-square', label: '□ 빈 네모' },
  { v: 'k-diamond', label: '◆ 마름모' },
  { v: 'k-arrow', label: '➢ 화살표' },
  { v: 'k-check', label: '✓ 체크' },
  { v: 'k-dash', label: '- 줄표' },
  { v: 'k-ref', label: '※ 참고' },
];

const NUMBER_STYLES = [
  { v: 'k-gov', label: '공문서 (1. 가. 1) 가) (1) (가) ① ㉮)' },
  { v: null, label: '1. 2. 3.' },
  { v: 'k-rparen', label: '1) 2) 3)' },
  { v: 'k-rparen-hangul', label: '가) 나) 다)' },
  { v: 'k-circled-hangul', label: '㉮ ㉯ ㉰' },
  { v: 'hangul', label: '가. 나. 다.' },
  { v: 'hangul-consonant', label: 'ㄱ. ㄴ. ㄷ.' },
  { v: 'k-circled', label: '① ② ③' },
  { v: 'k-paren', label: '(1) (2) (3)' },
  { v: 'k-paren-hangul', label: '(가) (나) (다)' },
  { v: 'upper-roman', label: 'Ⅰ. Ⅱ. Ⅲ.' },
  { v: 'lower-roman', label: 'ⅰ. ⅱ. ⅲ.' },
  { v: 'upper-alpha', label: 'A. B. C.' },
  { v: 'lower-alpha', label: 'a. b. c.' },
];

function setListStyle(editor: Editor, type: 'bulletList' | 'orderedList', style: string | null) {
  const c = editor.chain().focus();
  if (!editor.isActive(type)) c.toggleList(type, 'listItem');
  c.updateAttributes(type, { listStyle: style }).run();
}

export function FormatBar() {
  const app = useApp();
  const editor = app.active?.editor || null;
  useEditorTick(editor);
  const [sizeText, setSizeText] = useState('10');
  const size = editor ? currentFontSize(editor) : 10;
  useEffect(() => setSizeText(String(size)), [size]);
  if (!app.view.formatbar) return null;
  const dis = !editor;
  const lh = (() => {
    if (!editor) return 160;
    const v = editor.state.selection.$from.parent.attrs?.lineHeight;
    if (!v) return 160;
    if (/pt$/.test(v)) return v;
    return Math.round(parseFloat(v) * 100);
  })();
  const applySize = (v: number) => {
    if (!editor || !v || v <= 0) return;
    editor.chain().focus().setFontSize(Math.min(4096, v)).run();
  };
  return (
    <div className="toolbar">
      <select
        className="tb-select"
        style={{ width: 92 }}
        disabled={dis}
        value={editor ? currentStyle(editor) : 'p'}
        title="스타일 (F6)"
        onChange={(e) => editor && applyStyle(editor, e.target.value)}
      >
        {STYLES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.label}
          </option>
        ))}
      </select>
      <div className="tb-sep" />
      <FontCombo
        value={editor ? currentFont(editor) : '함초롬바탕'}
        fonts={app.fontList()}
        onChange={(f) => {
          if (!editor) return;
          editor.chain().focus().setFontFamily(f).run();
          app.rememberFont(f);
        }}
      />
      <span className="font-size-box" title="글자 크기 (pt)">
        <input
          type="text"
          list="font-sizes"
          value={sizeText}
          disabled={dis}
          onChange={(e) => setSizeText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applySize(parseFloat(sizeText));
          }}
          onBlur={() => {
            const v = parseFloat(sizeText);
            if (v && v !== size) applySize(v);
            else setSizeText(String(size));
          }}
        />
        <datalist id="font-sizes">
          {FONT_SIZES.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
        <span className="spin">
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand('format.sizeUp')} disabled={dis}>
            ▲
          </button>
          <button onMouseDown={(e) => e.preventDefault()} onClick={() => runCommand('format.sizeDown')} disabled={dis}>
            ▼
          </button>
        </span>
      </span>
      <div className="tb-sep" />
      <TbBtn id="format.bold" />
      <TbBtn id="format.italic" />
      <TbBtn id="format.underline" />
      <TbBtn id="format.strike" />
      <TbBtn id="format.sup" />
      <TbBtn id="format.sub" />
      <ColorButton
        icon="Baseline"
        title="글자 색"
        defaultColor="#FF0000"
        color={editor?.getAttributes('textStyle').color || null}
        noneLabel="검정(기본)"
        onPick={(c) => editor && (c ? editor.chain().focus().setColor(c).run() : editor.chain().focus().unsetColor().run())}
      />
      <ColorButton
        icon="Highlighter"
        title="형광펜"
        defaultColor="#FFFF00"
        color={editor?.getAttributes('highlight').color || null}
        noneLabel="형광펜 지우기"
        onPick={(c) => editor && (c ? editor.chain().focus().setHighlight({ color: c }).run() : editor.chain().focus().unsetHighlight().run())}
      />
      <TbBtn id="format.clear" />
      <div className="tb-sep" />
      <TbBtn id="format.alignJustify" />
      <TbBtn id="format.alignLeft" />
      <TbBtn id="format.alignCenter" />
      <TbBtn id="format.alignRight" />
      <TbBtn id="format.alignDistribute" />
      <div className="tb-sep" />
      <select
        className="tb-select"
        style={{ width: 70 }}
        title="줄 간격"
        disabled={dis}
        value={String(lh)}
        onChange={(e) => editor?.chain().focus().setLineHeight(e.target.value === '160' ? null : String(+e.target.value / 100)).run()}
      >
        {!LINE_HEIGHTS.includes(lh as number) && <option value={String(lh)}>{typeof lh === 'number' ? lh + '%' : lh}</option>}
        {LINE_HEIGHTS.map((v) => (
          <option key={v} value={String(v)}>
            {v}%
          </option>
        ))}
      </select>
      <div className="tb-sep" />
      <span className="tb-split">
        <TbBtn id="format.bullet" />
        <Dropdown
          button={(_o, toggle) => (
            <button className="tb-btn caret" disabled={dis} onMouseDown={(e) => e.preventDefault()} onClick={toggle} title="글머리표 모양">
              <Icon name="ChevronDown" size={11} />
            </button>
          )}
        >
          {(close) => (
            <div style={{ minWidth: 150 }}>
              {BULLET_STYLES.map((b) => (
                <div
                  key={String(b.v)}
                  className="menu-item"
                  onClick={() => {
                    close();
                    editor && setListStyle(editor, 'bulletList', b.v);
                  }}
                >
                  {b.label}
                </div>
              ))}
            </div>
          )}
        </Dropdown>
      </span>
      <span className="tb-split">
        <TbBtn id="format.number" />
        <Dropdown
          button={(_o, toggle) => (
            <button className="tb-btn caret" disabled={dis} onMouseDown={(e) => e.preventDefault()} onClick={toggle} title="문단 번호 모양">
              <Icon name="ChevronDown" size={11} />
            </button>
          )}
        >
          {(close) => (
            <div style={{ minWidth: 150 }}>
              {NUMBER_STYLES.map((b) => (
                <div
                  key={String(b.v)}
                  className="menu-item"
                  onClick={() => {
                    close();
                    editor && setListStyle(editor, 'orderedList', b.v);
                  }}
                >
                  {b.label}
                </div>
              ))}
            </div>
          )}
        </Dropdown>
      </span>
      <TbBtn id="format.outdent" />
      <TbBtn id="format.indent" />
      <div className="tb-sep" />
      <TbBtn id="view.marks" />
    </div>
  );
}
