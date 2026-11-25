import { useState } from 'react';
import { fieldRange } from '../../editor/extensions/clickHere';
import { app } from '../../app/controller';
import { Modal, OkCancel, Fieldset, NumberInput, Seg, ColorField } from '../widgets';
import { PX_PER_MM } from '../../formats/common';
import { gotoBookmark, insertBookmark, listBookmarks, removeBookmark } from '../../app/bookmarks';
import { insertCrossRef } from '../../app/crossRefs';
import type { ShapeData, ShapeItem } from '../../formats/shape';

/** 입력 → 덧말 넣기: 블록으로 지정한 글(본말) 위나 아래에 작은 글을 얹는다. 블록이 없으면 본말도 함께 넣는다 */
export function RubyDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  // 대화상자를 연 때의 블록 (입력 칸으로 포커스가 옮겨 가도 그 자리에 적용한다)
  const [sel] = useState(() => {
    const { from, to, empty } = editor.state.selection;
    return { from, to, empty, text: empty ? '' : editor.state.doc.textBetween(from, to, ' '), cur: editor.getAttributes('ruby') };
  });
  const { empty, cur } = sel;
  const [s, setS] = useState({ main: sel.text, ruby: (cur.text as string) || '', pos: ((cur.pos as string) === 'bottom' ? 'bottom' : 'top') as 'top' | 'bottom' });
  const up = (p: Partial<typeof s>) => setS({ ...s, ...p });

  const apply = () => {
    const ruby = s.ruby.trim().slice(0, 200);
    if (empty) {
      const main = s.main.trim();
      if (!main) {
        app.toast('본말을 입력하세요.', 'error');
        return;
      }
      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: main, marks: ruby ? [{ type: 'ruby', attrs: { text: ruby, pos: s.pos } }] : [] })
        .run();
    } else if (ruby) editor.chain().focus().setTextSelection({ from: sel.from, to: sel.to }).setRuby(ruby, s.pos).run();
    else editor.chain().focus().setTextSelection({ from: sel.from, to: sel.to }).unsetRuby().run();
    onClose();
  };
  const remove = () => {
    editor.chain().focus().setTextSelection({ from: sel.from, to: sel.to }).unsetRuby().run();
    onClose();
  };

  return (
    <Modal
      title="덧말 넣기"
      onClose={onClose}
      width={420}
      onEnter={apply}
      footer={
        <OkCancel
          onOk={apply}
          onCancel={onClose}
          okLabel="넣기"
          extra={
            cur.text ? (
              <button className="btn" onClick={remove}>
                덧말 지우기
              </button>
            ) : undefined
          }
        />
      }
    >
      <div className="form-grid">
        <label>본말</label>
        <input type="text" value={s.main} readOnly={!empty} onChange={(e) => up({ main: e.target.value })} placeholder="덧말을 달 글" autoFocus={empty} />
        <label>덧말</label>
        <input type="text" value={s.ruby} onChange={(e) => up({ ruby: e.target.value })} placeholder="본말 위에 얹을 글" autoFocus={!empty} maxLength={200} />
        <label>덧말 위치</label>
        <Seg
          value={s.pos}
          onChange={(v) => up({ pos: v })}
          options={[
            { value: 'top', label: '위' },
            { value: 'bottom', label: '아래' },
          ]}
        />
      </div>
      <div className="kdoc-content" style={{ marginTop: 14, padding: '18px 12px 14px', border: '1px solid var(--line, #d5dae3)', borderRadius: 4, background: '#fff', color: '#000', textAlign: 'center', fontSize: 16 }}>
        <span className="k-ruby" data-rt={s.ruby || ' '} data-rt-pos={s.pos === 'bottom' ? 'bottom' : undefined}>
          {s.main || '본말'}
        </span>
      </div>
    </Modal>
  );
}

const COMPOSE: { value: string; label: string }[] = [
  { value: 'SHAPE_CIRCLE', label: '원' },
  { value: 'SHAPE_REVERSAL_CIRCLE', label: '반전 원' },
  { value: 'SHAPE_RECTANGLE', label: '사각형' },
  { value: 'SHAPE_REVERSAL_RECTANGLE', label: '반전 사각형' },
  { value: 'SHAPE_ROUNDED_RECTANGLE', label: '둥근 사각형' },
  { value: 'SHAPE_TRIANGLE', label: '삼각형' },
  { value: 'SHAPE_RHOMBUS', label: '마름모' },
  { value: 'CHAR', label: '글자끼리 겹치기' },
];

/** 입력 → 글자 겹치기: 글자 몇 개를 한 글자 자리에 겹쳐 쓰고 원·사각형 등으로 두른다 (㉮, ⑩ 처럼) */
export function ComposeDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  // 대화상자를 연 때의 블록: 그 글자들을 겹친 글자로 바꾼다
  const [sel] = useState(() => {
    const { from, to, empty } = editor.state.selection;
    return { from, to, text: empty ? '' : editor.state.doc.textBetween(from, to, ''), cur: editor.getAttributes('compose') };
  });
  const [s, setS] = useState({ text: sel.text.slice(0, 9), shape: (sel.cur.shape as string) || 'SHAPE_CIRCLE' });
  const up = (p: Partial<typeof s>) => setS({ ...s, ...p });

  const apply = () => {
    const text = s.text.trim().slice(0, 9);
    if (!text) {
      app.toast('겹쳐 쓸 글자를 입력하세요.', 'error');
      return;
    }
    editor
      .chain()
      .focus()
      .setTextSelection({ from: sel.from, to: sel.to })
      .insertContent({ type: 'text', text, marks: [{ type: 'compose', attrs: { shape: s.shape } }] })
      .run();
    onClose();
  };

  return (
    <Modal title="글자 겹치기" onClose={onClose} width={440} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} okLabel="넣기" />}>
      <div className="form-grid">
        <label>겹쳐 쓸 글자</label>
        <input type="text" value={s.text} onChange={(e) => up({ text: e.target.value.slice(0, 9) })} placeholder="예: 가, 10, 인" autoFocus maxLength={9} />
      </div>
      <Fieldset legend="겹치기 종류" style={{ marginTop: 10 }}>
        <div className="row wrap" style={{ gap: 6 }}>
          {COMPOSE.map((c) => (
            <button key={c.value} className={'btn small' + (s.shape === c.value ? ' primary' : '')} onClick={() => up({ shape: c.value })} title={c.label}>
              {c.label}
            </button>
          ))}
        </div>
      </Fieldset>
      <div className="kdoc-content" style={{ marginTop: 12, padding: 14, border: '1px solid var(--line, #d5dae3)', borderRadius: 4, background: '#fff', color: '#000', textAlign: 'center', fontSize: 22 }}>
        <span className="k-compose" data-compose={s.shape}>
          {s.text || '가'}
        </span>
      </div>
    </Modal>
  );
}

type ShapeKind = 'line' | 'arrow' | 'rect' | 'round' | 'ellipse';
const KINDS: { value: ShapeKind; label: string }[] = [
  { value: 'line', label: '직선' },
  { value: 'arrow', label: '화살표' },
  { value: 'rect', label: '사각형' },
  { value: 'round', label: '둥근 사각형' },
  { value: 'ellipse', label: '타원' },
];
const DASHES: { value: string; label: string }[] = [
  { value: 'SOLID', label: '실선' },
  { value: 'DASH', label: '파선' },
  { value: 'DOT', label: '점선' },
  { value: 'DASH_DOT', label: '일점 쇄선' },
];

/** 입력 → 도형: 직선·화살표·사각형·타원을 글자처럼 취급하는 그리기 개체로 넣는다 */
export function ShapeDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const [s, setS] = useState({ kind: 'rect' as ShapeKind, w: 40, h: 25, lineColor: '#000000' as string | null, lineWidth: 0.3, dash: 'SOLID', fill: null as string | null });
  const up = (p: Partial<typeof s>) => setS({ ...s, ...p });
  const isLine = s.kind === 'line' || s.kind === 'arrow';

  const build = (): { width: number; height: number; d: ShapeData } => {
    const w = Math.max(2, Math.round(s.w * PX_PER_MM * 100) / 100);
    const h = isLine ? Math.max(0, Math.round(s.h * PX_PER_MM * 100) / 100) : Math.max(2, Math.round(s.h * PX_PER_MM * 100) / 100);
    const sw = Math.max(0.3, Math.round(s.lineWidth * PX_PER_MM * 100) / 100);
    const line = { sc: s.lineColor || (isLine ? '#000000' : null), sw, sd: s.dash };
    let item: ShapeItem;
    if (isLine) item = { k: 'line', m: [1, 0, 0, 1, 0, 0], w, h: Math.max(h, 1), p: [0, 0, w, h], ...line, ...(s.kind === 'arrow' ? { ts: 'ARROW', tf: true, tz: [1, 1] as [number, number] } : {}) };
    else if (s.kind === 'ellipse') item = { k: 'ellipse', m: [1, 0, 0, 1, 0, 0], w, h, ...line, fc: s.fill };
    else item = { k: 'rect', m: [1, 0, 0, 1, 0, 0], w, h, ...line, fc: s.fill, ...(s.kind === 'round' ? { r: 20 } : {}) };
    return { width: w, height: Math.max(h, isLine ? Math.max(4, sw * 2) : 2), d: { items: [item] } };
  };

  const apply = () => {
    if (!isLine && !s.lineColor && !s.fill) {
      app.toast('선이나 채우기 색을 하나는 정하세요.', 'error');
      return;
    }
    editor.chain().focus().insertShape(build()).run();
    onClose();
  };

  // 미리 보기 (실제 크기의 비율로)
  const sc = Math.min(150 / Math.max(1, s.w), 90 / Math.max(1, isLine ? Math.max(s.h, 1) : s.h));
  const pw = Math.max(2, s.w * sc);
  const ph = Math.max(isLine ? 2 : 2, s.h * sc);
  const stroke = s.lineColor || (isLine ? '#000000' : 'none');
  const dash = s.dash === 'DASH' ? '6 3' : s.dash === 'DOT' ? '2 2' : s.dash === 'DASH_DOT' ? '6 2 2 2' : undefined;
  const swPx = Math.max(1, s.lineWidth * 3);
  return (
    <Modal title="도형 넣기" onClose={onClose} width={500} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} okLabel="넣기" />}>
      <Fieldset legend="종류">
        <Seg value={s.kind} onChange={(v) => up({ kind: v, ...(v === 'line' || v === 'arrow' ? { h: 0 } : s.h === 0 ? { h: 25 } : {}) })} options={KINDS} />
      </Fieldset>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div style={{ flex: 1 }}>
          <Fieldset legend="크기">
            <div className="form-grid">
              <label>너비</label>
              <NumberInput value={s.w} onChange={(v) => up({ w: v })} min={1} max={400} step={1} unit="mm" />
              <label>{isLine ? '높이 (기울기)' : '높이'}</label>
              <NumberInput value={s.h} onChange={(v) => up({ h: v })} min={isLine ? 0 : 1} max={400} step={1} unit="mm" />
            </div>
          </Fieldset>
        </div>
        <div className="paper-preview" style={{ width: 170, height: 120, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#fff' }}>
          <svg width={pw + 12} height={ph + 12} style={{ overflow: 'visible' }}>
            <defs>
              <marker id="shape-dlg-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill={stroke} />
              </marker>
            </defs>
            {isLine ? (
              <line x1={6} y1={6} x2={6 + pw} y2={6 + s.h * sc} stroke={stroke} strokeWidth={swPx} strokeDasharray={dash} markerEnd={s.kind === 'arrow' ? 'url(#shape-dlg-arrow)' : undefined} />
            ) : s.kind === 'ellipse' ? (
              <ellipse cx={6 + pw / 2} cy={6 + ph / 2} rx={pw / 2} ry={ph / 2} fill={s.fill || 'none'} stroke={stroke} strokeWidth={swPx} strokeDasharray={dash} />
            ) : (
              <rect x={6} y={6} width={pw} height={ph} rx={s.kind === 'round' ? Math.min(pw, ph) * 0.2 : 0} fill={s.fill || 'none'} stroke={stroke} strokeWidth={swPx} strokeDasharray={dash} />
            )}
          </svg>
        </div>
      </div>
      <Fieldset legend="선">
        <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
          <select value={s.dash} onChange={(e) => up({ dash: e.target.value })}>
            {DASHES.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
          <NumberInput value={s.lineWidth} onChange={(v) => up({ lineWidth: v })} min={0.1} max={10} step={0.1} unit="mm" />
          <ColorField value={s.lineColor} onChange={(v) => up({ lineColor: v })} allowNone={!isLine} />
        </div>
      </Fieldset>
      {!isLine && (
        <Fieldset legend="채우기">
          <div className="row" style={{ gap: 12, alignItems: 'center' }}>
            <label>면 색</label>
            <ColorField value={s.fill} onChange={(v) => up({ fill: v })} />
          </div>
        </Fieldset>
      )}
    </Modal>
  );
}

/** 입력 → 누름틀: 서식 문서의 입력 칸. 커서가 누름틀 안이면 그 누름틀을 고친다 */
export function ClickHereDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const [sel] = useState(() => {
    const { from, to, empty } = editor.state.selection;
    const type = editor.schema.marks.clickHere;
    const r = type ? fieldRange(editor.state.doc, from, type) : null;
    return { from, to, empty, field: r };
  });
  const cur = sel.field?.mark.attrs;
  const [guide, setGuide] = useState<string>(cur?.guide || '이곳을 눌러 내용을 입력하세요.');
  const [memo, setMemo] = useState<string>(cur?.memo || '');
  const [name, setName] = useState<string>(cur?.name || '');
  const apply = () => {
    const g = guide.trim();
    if (!g) {
      app.toast('안내문을 입력하세요.', 'error');
      return;
    }
    const c = editor.chain().focus().setTextSelection({ from: sel.from, to: sel.to });
    if (sel.field) c.updateClickHere({ guide: g, memo: memo.trim(), name: name.trim() }).run();
    else c.insertClickHere({ guide: g, memo: memo.trim(), name: name.trim() }).run();
    onClose();
  };
  const remove = () => {
    editor.chain().focus().setTextSelection(sel.from).removeClickHere().run();
    onClose();
  };
  return (
    <Modal
      title={sel.field ? '누름틀 고치기' : '누름틀 넣기'}
      onClose={onClose}
      width={420}
      footer={
        <OkCancel
          onOk={apply}
          onCancel={onClose}
          okLabel={sel.field ? '고치기' : '넣기'}
          extra={
            sel.field ? (
              <button className="btn" onClick={remove}>
                누름틀 지우기
              </button>
            ) : undefined
          }
        />
      }
    >
      <div className="form-grid">
        <label>안내문</label>
        <input type="text" value={guide} autoFocus onChange={(e) => setGuide(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && apply()} />
        <label>메모</label>
        <input type="text" value={memo} placeholder="선택 — 누름틀에 마우스를 올리면 보이는 도움말" onChange={(e) => setMemo(e.target.value)} />
        <label>필드 이름</label>
        <input type="text" value={name} placeholder="선택" onChange={(e) => setName(e.target.value)} />
      </div>
      <p className="unit" style={{ lineHeight: 1.6, marginTop: 8 }}>
        {sel.empty && !sel.field
          ? '커서 자리에 안내문이 빨간 글씨로 들어갑니다. 누르면 안내문이 통째로 골라져 치는 글로 바뀝니다. 안내문은 인쇄되지 않습니다.'
          : !sel.field
            ? '고른 글을 누름틀로 만듭니다.'
            : '누름틀 지우기: 입력한 글은 남기고 누름틀만 없앱니다.'}
      </p>
    </Modal>
  );
}

/** 입력 → 책갈피 (Ctrl+K,B): 커서 자리에 이름 붙은 자리를 넣고, 문서의 책갈피로 옮겨 가거나 지운다 */
/** 표 → 계산식: 커서가 든 칸에 계산식을 넣거나 고친다 (한글의 계산식 필드로 저장, 칸 값이 바뀌면 다시 셈한다) */
export function FormulaDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const cur = editor.getAttributes('formula') as { formula?: string; fmt?: string };
  const [formula, setFormula] = useState(cur.formula || '=SUM(LEFT)');
  const [fmt0] = useState(cur.fmt || '%g,');
  const m = /^%(?:\.(\d+))?([gfd])(,)?/.exec(fmt0);
  const [dec, setDec] = useState<string>(m && m[2] === 'f' ? m[1] || '0' : 'g');
  const [comma, setComma] = useState(m ? !!m[3] : true);
  const ok = () => {
    const f = formula.trim().startsWith('=') ? formula.trim() : '=' + formula.trim();
    if (f.length < 2) return;
    editor.chain().focus().insertFormula(f, (dec === 'g' ? '%g' : `%.${dec}f`) + (comma ? ',' : '')).run();
    onClose();
  };
  const add = (s: string) => setFormula((v) => (v.trim() ? v.replace(/\s+$/, '') + s : '=' + s));
  return (
    <Modal title="계산식" onClose={onClose} width={440} onEnter={ok} footer={<OkCancel onOk={ok} onCancel={onClose} okLabel={cur.formula ? '고치기' : '넣기'} />}>
      <Fieldset legend="계산식">
        <input type="text" value={formula} onChange={(e) => setFormula(e.target.value)} style={{ width: '100%', fontFamily: 'monospace' }} autoFocus />
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
          {['SUM(', 'AVG(', 'PRODUCT(', 'MIN(', 'MAX(', 'COUNT(', 'ROUND(', 'LEFT)', 'ABOVE)', 'RIGHT)', 'BELOW)'].map((s) => (
            <button key={s} className="btn" style={{ padding: '1px 6px' }} onClick={() => add(s)}>
              {s.replace(/[()]/g, '')}
            </button>
          ))}
        </div>
        <div className="unit">칸 주소는 열 글자와 줄 번호(A1, B2, A1:C3). LEFT·ABOVE 는 이 칸의 왼쪽·위쪽 칸들. 예: =SUM(A1:A3)*2, =AVG(LEFT)</div>
      </Fieldset>
      <Fieldset legend="결과 모양">
        <Seg value={dec} onChange={(v) => setDec(v)} options={[{ value: 'g', label: '기본' }, { value: '0', label: '정수' }, { value: '1', label: '소수 1자리' }, { value: '2', label: '소수 2자리' }]} />
        <label className="check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={comma} onChange={(e) => setComma(e.target.checked)} />
          천 단위 쉼표
        </label>
      </Fieldset>
    </Modal>
  );
}

/** 입력 → 상호 참조: 책갈피의 쪽 번호·이름·위/아래를 글로 넣는다 (한글의 상호 참조 필드로 저장) */
export function CrossRefDialog({ onClose }: { onClose: () => void }) {
  const tab = app.active!;
  const [list] = useState(() => listBookmarks(tab.editor));
  const [target, setTarget] = useState(list[0]?.name || '');
  const [content, setContent] = useState<'0' | '1' | '3'>('0');
  const [link, setLink] = useState(true);
  const ok = () => {
    if (!target) return;
    insertCrossRef(tab, target, Number(content), link);
    onClose();
  };
  return (
    <Modal title="상호 참조" onClose={onClose} width={400} onEnter={ok} footer={<OkCancel onOk={ok} onCancel={onClose} okLabel="넣기" />}>
      <Fieldset legend={`참조할 책갈피 (${list.length})`}>
        <div className="list-box" style={{ maxHeight: 180, overflow: 'auto' }}>
          {list.length === 0 && <div className="unit">책갈피가 없습니다. 먼저 참조할 곳에 책갈피를 넣으세요 (Ctrl+K,B).</div>}
          {list.map((b) => (
            <div key={b.pos} className={'list-item' + (b.name === target ? ' on' : '')} onClick={() => setTarget(b.name)}>
              {b.name}
            </div>
          ))}
        </div>
      </Fieldset>
      <Fieldset legend="넣을 내용">
        <Seg value={content} onChange={(v) => setContent(v as '0' | '1' | '3')} options={[{ value: '0', label: '쪽 번호' }, { value: '1', label: '책갈피 이름' }, { value: '3', label: '위/아래' }]} />
        <label className="check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} />
          하이퍼링크로 (문맥 메뉴에서 참조한 곳으로 갈 수 있게)
        </label>
        <div className="unit">쪽이 바뀌면 문맥 메뉴의 '상호 참조 새로 고침'으로 번호를 다시 셉니다.</div>
      </Fieldset>
    </Modal>
  );
}

export function BookmarkDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const [list, setList] = useState(() => listBookmarks(editor));
  // 고른 글이 있으면 그 글을 이름으로 (한글처럼)
  const sel = editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ').trim().slice(0, 64);
  const [name, setName] = useState(sel || `책갈피${list.length + 1}`);
  const [picked, setPicked] = useState<string | null>(null);
  const exists = list.some((b) => b.name === name.trim());
  const insert = () => {
    if (!name.trim()) return;
    insertBookmark(editor, name);
    onClose();
  };
  return (
    <Modal
      title="책갈피"
      onClose={onClose}
      width={400}
      onEnter={insert}
      footer={
        <>
          <button className="btn primary" onClick={insert} disabled={!name.trim()}>
            {exists ? '옮기기' : '넣기'}
          </button>
          <button
            className="btn"
            disabled={!picked}
            onClick={() => {
              if (picked && gotoBookmark(editor, picked)) onClose();
            }}
          >
            이동
          </button>
          <button
            className="btn"
            disabled={!picked}
            onClick={() => {
              if (!picked) return;
              removeBookmark(editor, picked);
              setList(listBookmarks(editor));
              setPicked(null);
            }}
          >
            지우기
          </button>
          <button className="btn" onClick={onClose}>
            닫기
          </button>
        </>
      }
    >
      <Fieldset legend="책갈피 이름">
        <input type="text" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} style={{ width: '100%' }} autoFocus />
        {exists && <div className="unit">같은 이름의 책갈피가 있습니다. 넣으면 그 책갈피를 이 자리로 옮깁니다.</div>}
      </Fieldset>
      <Fieldset legend={`문서의 책갈피 (${list.length})`}>
        <div className="list-box" style={{ maxHeight: 180, overflow: 'auto' }}>
          {list.length === 0 && <div className="unit">책갈피가 없습니다.</div>}
          {list.map((b) => (
            <div
              key={b.pos}
              className={'list-item' + (picked === b.name ? ' on' : '')}
              onClick={() => {
                setPicked(b.name);
                setName(b.name);
              }}
              onDoubleClick={() => {
                if (gotoBookmark(editor, b.name)) onClose();
              }}
              style={{ padding: '3px 6px', cursor: 'pointer', background: picked === b.name ? 'var(--accent-soft, rgba(47,128,237,.18))' : undefined }}
            >
              {b.name}
            </div>
          ))}
        </div>
        <div className="unit">두 번 누르면 그 자리로 옮겨 갑니다. 하이퍼링크의 주소를 #이름 으로 쓰면 그 책갈피로 갑니다.</div>
      </Fieldset>
    </Modal>
  );
}
