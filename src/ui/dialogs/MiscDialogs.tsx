import { useEffect, useMemo, useState } from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import { platform } from '../../platform';
import { cropOf, type Crop } from '../../editor/extensions/nodes';
import { app } from '../../app/controller';
import { commands } from '../../app/commands';
import { Modal, OkCancel, Fieldset, NumberInput, ColorField, Seg, FontCombo } from '../widgets';
import { insertTableFull } from '../../editor/tableUtil';
import { applyStyle } from '../Toolbar';
import { baseName } from '../../formats/common';
import { SAVE_FORMATS } from '../../formats';
import { refreshAuthor } from '../../app/review';
import { HWP_NOTICE } from '../../appInfo';
import { openSponsor, openContact, contactAvailable } from '../../support';
import { Icon } from '../Icon';
import type { SaveFormatId } from '../../types';

export function TableDialog({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState(3);
  const [cols, setCols] = useState(4);
  const [header, setHeader] = useState(false);
  const ok = () => {
    insertTableFull(app.active!.editor, app.active!.settings, Math.max(1, Math.min(200, rows)), Math.max(1, Math.min(60, cols)), header);
    onClose();
  };
  return (
    <Modal title="표 만들기" onClose={onClose} width={340} onEnter={ok} footer={<OkCancel onOk={ok} onCancel={onClose} okLabel="만들기" />}>
      <Fieldset legend="줄/칸">
        <div className="form-grid">
          <label>줄 개수</label>
          <NumberInput value={rows} onChange={setRows} min={1} max={200} />
          <label>칸 개수</label>
          <NumberInput value={cols} onChange={setCols} min={1} max={60} />
        </div>
      </Fieldset>
      <label className="check">
        <input type="checkbox" checked={header} onChange={(e) => setHeader(e.target.checked)} />
        첫 줄을 제목 줄로
      </label>
    </Modal>
  );
}

export function LinkDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const cur = editor.getAttributes('link').href || '';
  const { from, to, empty } = editor.state.selection;
  const [url, setUrl] = useState(cur || 'https://');
  const [text, setText] = useState(empty ? '' : editor.state.doc.textBetween(from, to, ' '));
  const ok = () => {
    let href = url.trim();
    if (!href || href === 'https://') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      onClose();
      return;
    }
    if (!/^[a-z]+:/i.test(href) && !href.startsWith('#')) href = (href.includes('@') && !href.includes('/') ? 'mailto:' : 'https://') + href;
    if (empty && !cur) {
      const t = text || href;
      editor.chain().focus().insertContent({ type: 'text', text: t, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    onClose();
  };
  return (
    <Modal
      title="하이퍼링크"
      onClose={onClose}
      width={460}
      onEnter={ok}
      footer={
        <OkCancel
          onOk={ok}
          onCancel={onClose}
          okLabel="넣기"
          extra={
            cur ? (
              <button
                className="btn danger"
                style={{ marginRight: 'auto' }}
                onClick={() => {
                  editor.chain().focus().extendMarkRange('link').unsetLink().run();
                  onClose();
                }}
              >
                링크 지우기
              </button>
            ) : undefined
          }
        />
      }
    >
      <div className="form-grid">
        <label>표시할 문자열</label>
        <input type="text" value={text} disabled={!empty || !!cur} onChange={(e) => setText(e.target.value)} placeholder="(선택한 내용)" />
        <label>연결 대상</label>
        <input type="text" value={url} onChange={(e) => setUrl(e.target.value)} data-autofocus />
      </div>
    </Modal>
  );
}

// ---------------- 문자표 ----------------
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => String.fromCharCode(a + i));
const SYMBOLS: { name: string; chars: string[] }[] = [
  { name: '일반 기호', chars: [...'※★☆○●◎◇◆□■△▲▽▼→←↑↓↔〓◁◀▷▶♤♠♡♥♧♣⊙◈▣◐◑▒▤▥▨▧▦▩♨☏☎☜☞¶†‡↕↗↙↖↘♭♩♪♬㉿㈜№㏇™㏂㏘℡€®©§'] },
  { name: '괄호·문장 부호', chars: [...'「」『』【】〔〕〈〉《》“”‘’·‥…¨〃―∥＼∼´～ˇ˘˝˚˙¸˛¡¿ː、。〓・'] },
  { name: '수학 기호', chars: [...'±×÷≠≤≥∞∴♂♀∠⊥⌒∂∇≡≒≪≫√∽∝∵∫∬∈∋⊆⊇⊂⊃∪∩∧∨￢⇒⇔∀∃∮∑∏∅∉≈≅≦≧½⅓⅔¼¾⅛⅜⅝⅞¹²³⁴ⁿ₁₂₃₄'] },
  { name: '단위', chars: [...'℃℉Å￠￡￥‰㎕㎖㎗ℓ㎘㏄㎣㎤㎥㎦㎙㎚㎛㎜㎝㎞㎟㎠㎡㎢㏊㎍㎎㎏㏏㎈㎉㏈㎧㎨㎰㎱㎲㎳㎴㎵㎶㎷㎸㎹㎀㎁㎂㎃㎄㎺㎻㎼㎽㎾㎿㎐㎑㎒㎓㎔Ω㏀㏁㎊㎋㎌㏖㏅㎭㎮㎯㏛㎩㎪㎫㎬㏝㏐㏓㏃㏉㏜㏆'] },
  { name: '원 문자', chars: [...range(0x2460, 0x2473), ...range(0x3260, 0x326d), ...range(0x326e, 0x327b), ...range(0x24d0, 0x24e9), ...range(0x24b6, 0x24cf)] },
  { name: '괄호 문자', chars: [...range(0x2474, 0x2487), ...range(0x3200, 0x320d), ...range(0x320e, 0x321b), ...range(0x249c, 0x24b5)] },
  { name: '로마 숫자', chars: [...range(0x2170, 0x2179), ...range(0x2160, 0x2169)] },
  { name: '그리스 문자', chars: [...range(0x391, 0x3a1), ...range(0x3a3, 0x3a9), ...range(0x3b1, 0x3c1), ...range(0x3c3, 0x3c9)] },
  { name: '화살표·도형', chars: [...range(0x2190, 0x21ff), ...range(0x25a0, 0x25ff).slice(0, 96)] },
  { name: '괘선', chars: [...range(0x2500, 0x254b)] },
  { name: '한글 자모', chars: [...range(0x3131, 0x318e)] },
  { name: '히라가나', chars: [...range(0x3041, 0x3093)] },
  { name: '가타카나', chars: [...range(0x30a1, 0x30f6)] },
  { name: '라틴 확장', chars: [...range(0xc0, 0xff), ...range(0x152, 0x153)] },
];

export function SymbolDialog({ onClose }: { onClose: () => void }) {
  const [cat, setCat] = useState(0);
  const [sel, setSel] = useState<string>('');
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('kite:recent-symbols') || '[]');
    } catch {
      return [];
    }
  });
  const insert = (ch: string) => {
    if (!ch) return;
    app.active?.editor.chain().focus().insertContent(ch).run();
    const r = [ch, ...recent.filter((x) => x !== ch)].slice(0, 16);
    setRecent(r);
    try {
      localStorage.setItem('kite:recent-symbols', JSON.stringify(r));
    } catch {
      /* 무시 */
    }
  };
  return (
    <Modal
      title="문자표"
      onClose={onClose}
      width={720}
      onEnter={() => insert(sel)}
      footer={
        <>
          <span style={{ marginRight: 'auto', fontSize: 22, minWidth: 40 }}>{sel}</span>
          <span className="unit" style={{ marginRight: 8 }}>
            {sel ? 'U+' + sel.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0') : ''}
          </span>
          <button className="btn primary" disabled={!sel} onClick={() => insert(sel)}>
            넣기
          </button>
          <button className="btn" onClick={onClose}>
            닫기
          </button>
        </>
      }
    >
      {recent.length > 0 && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="unit">최근:</span>
          {recent.map((c) => (
            <button key={c} className="btn small" style={{ minWidth: 28, fontSize: 15 }} onClick={() => insert(c)}>
              {c}
            </button>
          ))}
        </div>
      )}
      <div className="row" style={{ alignItems: 'flex-start' }}>
        <div className="symbol-cats">
          {SYMBOLS.map((s, i) => (
            <button key={s.name} className={i === cat ? 'on' : ''} onClick={() => setCat(i)}>
              {s.name}
            </button>
          ))}
        </div>
        <div className="symbol-grid">
          {SYMBOLS[cat].chars.map((c, i) => (
            <button key={i} className={c === sel ? 'sel' : ''} onClick={() => setSel(c)} onDoubleClick={() => insert(c)} title={'U+' + c.charCodeAt(0).toString(16).toUpperCase()}>
              {c}
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

export function FootnoteDialog({ onClose, pos, text: init, kind = null }: { onClose: () => void; pos: number | null; text: string; kind?: 'end' | null }) {
  const [text, setText] = useState(init || '');
  const editor = app.active!.editor;
  const what = kind === 'end' ? '미주' : '각주';
  const ok = () => {
    if (pos != null) {
      if (!text.trim()) editor.chain().focus().deleteRange({ from: pos, to: pos + 1 }).run();
      else editor.chain().focus().updateFootnote(pos, text.trim()).run();
    } else if (text.trim()) editor.chain().focus().insertFootnote(text.trim(), kind).run();
    onClose();
  };
  return (
    <Modal title={pos != null ? `${what} 고치기` : `${what} 넣기`} onClose={onClose} width={480} footer={<OkCancel onOk={ok} onCancel={onClose} okLabel={pos != null ? '고치기' : '넣기'} />}>
      <textarea
        style={{ width: '100%', height: 110 }}
        value={text}
        placeholder={`${what} 내용을 입력하세요. ${kind === 'end' ? '미주는 문서 끝에 모아 보입니다. ' : ''}(Ctrl+Enter: 확인)`}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && e.ctrlKey) {
            e.preventDefault();
            ok();
          }
        }}
        data-autofocus
      />
      {pos != null && <div className="unit">내용을 모두 지우고 확인하면 {what}가 삭제됩니다.</div>}
    </Modal>
  );
}

export function GotoDialog({ onClose }: { onClose: () => void }) {
  const total = app.active?.layout.pageCount || 1;
  const [page, setPage] = useState(1);
  const ok = () => {
    window.dispatchEvent(new CustomEvent('kite:goto-page', { detail: Math.max(1, Math.min(total, page)) }));
    onClose();
  };
  return (
    <Modal title="찾아가기" onClose={onClose} width={300} onEnter={ok} footer={<OkCancel onOk={ok} onCancel={onClose} okLabel="가기" />}>
      <div className="form-grid">
        <label>쪽 번호</label>
        <NumberInput value={page} onChange={setPage} min={1} max={total} unit={`/ ${total} 쪽`} />
      </div>
    </Modal>
  );
}

const PX_MM = 96 / 25.4;
const mm2 = (px: number) => Math.round((px / PX_MM) * 100) / 100;
const px2 = (mm: number) => Math.round(mm * PX_MM * 100) / 100;
/** 칸 테두리 선 (borderCss 한 변: '0.12mm solid #000000') */
const LINE_RE = /^([\d.]+)mm (solid|dashed|dotted|double) (#[0-9A-Fa-f]{6})$/;

export function CellPropsDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const attrs = editor.getAttributes('tableCell').colspan !== undefined ? editor.getAttributes('tableCell') : editor.getAttributes('tableHeader');
  const nb: string[] = attrs.borderStyle ? String(attrs.borderStyle).split(' ') : [];
  const [bg, setBg] = useState<string | null>(attrs.backgroundColor || null);
  const [va, setVa] = useState<string>(attrs.verticalAlign || 'middle');
  const [sides, setSides] = useState({ t: !nb.includes('t'), b: !nb.includes('b'), l: !nb.includes('l'), r: !nb.includes('r') });
  // 선 모양: 지금 칸의 첫 선 (없으면 0.12mm 검은 실선). 고치지 않으면 칸마다의 원래 선을 그대로 둔다
  const firstLine = String(attrs.borderCss || '')
    .split(';')
    .map((p) => LINE_RE.exec((p.split(':')[1] || '').trim()))
    .find(Boolean);
  const [line, setLine] = useState({ style: firstLine ? firstLine[2] : 'solid', width: firstLine ? parseFloat(firstLine[1]) : 0.12, color: firstLine ? firstLine[3] : '#000000' });
  const [lineTouched, setLineTouched] = useState(false);
  const upLine = (p: Partial<typeof line>) => {
    setLine({ ...line, ...p });
    setLineTouched(true);
  };
  // 안 여백 (mm): 칸 자체 여백이 없으면 표 기본 (왼·오른 1.8mm, 위·아래 0.5mm)
  const m0: number[] | null = Array.isArray(attrs.margins) && attrs.margins.length === 4 ? attrs.margins : null;
  const [ownMargin, setOwnMargin] = useState(!!m0);
  const [vertical, setVertical] = useState(attrs.vertical === true);
  const [margin, setMargin] = useState<number[]>(m0 ? m0.map(mm2) : [1.8, 1.8, 0.5, 0.5]);
  const ok = () => {
    const none = (['l', 'r', 't', 'b'] as const).filter((s) => !sides[s]).join(' ') || null;
    const w = Math.max(0.1, Math.min(5, line.width));
    const css = (['t', 'b', 'l', 'r'] as const)
      .filter((s) => sides[s])
      .map((s) => `${s}:${w}mm ${line.style} ${line.color}`)
      .join(';');
    let c = editor
      .chain()
      .focus()
      .setCellAttribute('backgroundColor', bg)
      .setCellAttribute('verticalAlign', va === 'middle' ? null : va)
      .setCellAttribute('borderStyle', none)
      .setCellAttribute('margins', ownMargin ? margin.map((v) => px2(Math.max(0, Math.min(50, v)))) : null)
      .setCellAttribute('vertical', vertical ? true : null);
    if (lineTouched) c = c.setCellAttribute('borderCss', css || null);
    c.run();
    onClose();
  };
  const all = (v: boolean) => setSides({ t: v, b: v, l: v, r: v });
  return (
    <Modal title="셀 속성" onClose={onClose} width={460} onEnter={ok} footer={<OkCancel onOk={ok} onCancel={onClose} />}>
      <Fieldset legend="테두리">
        <div className="row wrap" style={{ gap: 14 }}>
          {(
            [
              ['t', '위'],
              ['b', '아래'],
              ['l', '왼쪽'],
              ['r', '오른쪽'],
            ] as const
          ).map(([k, l]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={sides[k]} onChange={(e) => setSides({ ...sides, [k]: e.target.checked })} />
              {l}
            </label>
          ))}
          <button className="btn small" onClick={() => all(true)}>
            모두
          </button>
          <button className="btn small" onClick={() => all(false)}>
            없음
          </button>
        </div>
      </Fieldset>
      <Fieldset legend="선 모양">
        <div className="form-grid">
          <label>종류</label>
          <select value={line.style} onChange={(e) => upLine({ style: e.target.value })}>
            <option value="solid">실선</option>
            <option value="dashed">파선</option>
            <option value="dotted">점선</option>
            <option value="double">이중 실선</option>
          </select>
          <label>굵기</label>
          <NumberInput value={line.width} onChange={(v) => upLine({ width: v })} min={0.1} max={5} step={0.05} unit="mm" />
          <label>색</label>
          <ColorField value={line.color} onChange={(v) => upLine({ color: v || '#000000' })} />
        </div>
      </Fieldset>
      <Fieldset legend="배경">
        <ColorField value={bg} onChange={setBg} />
      </Fieldset>
      <Fieldset legend="안 여백">
        <label className="check">
          <input type="checkbox" checked={ownMargin} onChange={(e) => setOwnMargin(e.target.checked)} />
          안 여백 지정 (끄면 표의 기본 여백)
        </label>
        {ownMargin && (
          <div className="form-grid" style={{ gridTemplateColumns: 'auto 1fr auto 1fr', marginTop: 6 }}>
            {(['왼쪽', '오른쪽', '위쪽', '아래쪽'] as const).map((label, i) => (
              <span key={label} style={{ display: 'contents' }}>
                <label>{label}</label>
                <NumberInput value={margin[i]} onChange={(v) => setMargin(margin.map((x, k) => (k === i ? v : x)))} min={0} max={50} step={0.1} unit="mm" />
              </span>
            ))}
          </div>
        )}
      </Fieldset>
      <Fieldset legend="글 방향">
        <label className="check">
          <input type="checkbox" checked={vertical} onChange={(e) => setVertical(e.target.checked)} />
          세로쓰기 (글자는 위에서 아래로, 줄은 오른쪽에서 왼쪽으로)
        </label>
      </Fieldset>
      <Fieldset legend="세로 정렬">
        <Seg
          value={va}
          onChange={setVa}
          options={[
            { value: 'top', label: '위' },
            { value: 'middle', label: '가운데' },
            { value: 'bottom', label: '아래' },
          ]}
        />
      </Fieldset>
      <div className="unit">여러 셀을 블록으로 지정(F5 또는 끌기)하면 한꺼번에 바뀝니다.</div>
    </Modal>
  );
}

/** 커서가 든 표 (가장 안쪽)의 자리와 노드 */
function tableAtCursor() {
  const editor = app.active!.editor;
  const $p = editor.state.selection.$from;
  for (let d = $p.depth; d > 0; d--) {
    const n = $p.node(d);
    if (n.type.name === 'table') return { editor, pos: $p.before(d), node: n };
  }
  return null;
}

/** 표 속성: 위치(정렬·글자처럼 취급), 바깥 여백, 쪽 경계에서 나누기, 칸 간격 (한글의 표 고치기 → 표) */
export function TablePropsDialog({ onClose }: { onClose: () => void }) {
  const at = tableAtCursor();
  const a = at?.node.attrs || {};
  const om0: number[] | null = Array.isArray(a.outMargin) && a.outMargin.length === 4 ? a.outMargin : null;
  const [s, setS] = useState({
    align: (a.align as string) || 'left',
    inline: !!a.inline,
    split: (a.pageSplit as string) || 'split',
    spacing: a.cellSpacing ? mm2(+a.cellSpacing) : 0,
    om: om0 ? om0.map(mm2) : [0, 0, 0, 0],
  });
  const up = (p: Partial<typeof s>) => setS({ ...s, ...p });
  const ok = () => {
    if (!at) return onClose();
    const { editor, pos, node } = at;
    const om = s.om.map((v) => px2(Math.max(0, Math.min(100, v))));
    const next = {
      ...node.attrs,
      align: s.align === 'left' ? null : s.align,
      inline: s.inline,
      pageSplit: s.split === 'split' ? null : s.split,
      cellSpacing: s.spacing > 0 ? px2(Math.min(10, s.spacing)) : null,
      outMargin: om.some((v) => v > 0) || om0 ? om : null,
    };
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, next, node.marks));
    editor.commands.focus();
    onClose();
  };
  if (!at) return null;
  return (
    <Modal title="표 속성" onClose={onClose} width={440} onEnter={ok} footer={<OkCancel onOk={ok} onCancel={onClose} />}>
      <Fieldset legend="위치">
        <div className="form-grid">
          <label>가로 정렬</label>
          <Seg
            value={s.align}
            onChange={(v) => up({ align: v })}
            options={[
              { value: 'left', label: '왼쪽' },
              { value: 'center', label: '가운데' },
              { value: 'right', label: '오른쪽' },
            ]}
          />
        </div>
        <label className="check" style={{ marginTop: 8 }}>
          <input type="checkbox" checked={s.inline} onChange={(e) => up({ inline: e.target.checked })} />
          글자처럼 취급
        </label>
      </Fieldset>
      <Fieldset legend="바깥 여백">
        <div className="form-grid" style={{ gridTemplateColumns: 'auto 1fr auto 1fr' }}>
          {(['왼쪽', '오른쪽', '위쪽', '아래쪽'] as const).map((label, i) => (
            <span key={label} style={{ display: 'contents' }}>
              <label>{label}</label>
              <NumberInput value={s.om[i]} onChange={(v) => up({ om: s.om.map((x, k) => (k === i ? v : x)) })} min={0} max={100} step={0.1} unit="mm" />
            </span>
          ))}
        </div>
      </Fieldset>
      <Fieldset legend="쪽 경계에서">
        <Seg
          value={s.split}
          onChange={(v) => up({ split: v })}
          options={[
            { value: 'split', label: '나눔' },
            { value: 'row', label: '셀 단위로 나눔' },
            { value: 'none', label: '나누지 않음' },
          ]}
        />
      </Fieldset>
      <Fieldset legend="칸 간격">
        <NumberInput value={s.spacing} onChange={(v) => up({ spacing: v })} min={0} max={10} step={0.1} unit="mm" />
      </Fieldset>
      <div className="unit">칸의 테두리·배경·안 여백은 셀 속성(L)에서 고칩니다. 제목 줄 반복은 표 → 제목 줄 지정/해제.</div>
    </Modal>
  );
}

export function DocInfoDialog({ onClose }: { onClose: () => void }) {
  const tab = app.active!;
  const [meta, setMeta] = useState({ ...tab.meta });
  const stats = useMemo(() => {
    const doc = tab.editor.state.doc;
    const text = doc.textBetween(0, doc.content.size, '\n', ' ');
    let paras = 0;
    let images = 0;
    let tables = 0;
    let footnotes = 0;
    doc.descendants((n) => {
      if (n.type.name === 'paragraph' || n.type.name === 'heading') paras++;
      else if (n.type.name === 'image') images++;
      else if (n.type.name === 'table') tables++;
      else if (n.type.name === 'footnote') footnotes++;
      return true;
    });
    const noSpace = text.replace(/\s/g, '').length;
    const withSpace = text.replace(/\n/g, '').length;
    const words = (text.match(/\S+/g) || []).length;
    // 원고지(200자) 매수
    const manuscript = Math.ceil(withSpace / 200);
    return { noSpace, withSpace, words, paras, images, tables, footnotes, manuscript, pages: tab.layout.pageCount };
  }, []);
  const ok = () => {
    tab.meta = meta;
    tab.markDirty();
    onClose();
  };
  return (
    <Modal title="문서 정보" onClose={onClose} width={520} footer={<OkCancel onOk={ok} onCancel={onClose} />}>
      <div className="tabs-head">
        <button className="on">일반 / 문서 통계</button>
      </div>
      <Fieldset legend="문서 요약">
        <div className="form-grid">
          <label>제목</label>
          <input type="text" value={meta.title || ''} onChange={(e) => setMeta({ ...meta, title: e.target.value })} />
          <label>지은이</label>
          <input type="text" value={meta.author || ''} onChange={(e) => setMeta({ ...meta, author: e.target.value })} />
          <label>주제</label>
          <input type="text" value={meta.subject || ''} onChange={(e) => setMeta({ ...meta, subject: e.target.value })} />
          <label>키워드</label>
          <input type="text" value={meta.keywords || ''} onChange={(e) => setMeta({ ...meta, keywords: e.target.value })} />
        </div>
      </Fieldset>
      <table className="doc-info-table">
        <tbody>
          <tr>
            <td>파일</td>
            <td style={{ wordBreak: 'break-all' }}>{tab.path || '(저장되지 않음)'}</td>
          </tr>
          <tr>
            <td>원본 형식</td>
            <td>{tab.sourceFormat ? tab.sourceFormat.toUpperCase() : '새 문서'}</td>
          </tr>
          <tr>
            <td>쪽 수</td>
            <td>{stats.pages.toLocaleString()} 쪽</td>
          </tr>
          <tr>
            <td>글자 (공백 포함)</td>
            <td>{stats.withSpace.toLocaleString()} 자</td>
          </tr>
          <tr>
            <td>글자 (공백 제외)</td>
            <td>{stats.noSpace.toLocaleString()} 자</td>
          </tr>
          <tr>
            <td>낱말</td>
            <td>{stats.words.toLocaleString()} 개</td>
          </tr>
          <tr>
            <td>문단</td>
            <td>{stats.paras.toLocaleString()} 개</td>
          </tr>
          <tr>
            <td>원고지 (200자)</td>
            <td>{stats.manuscript.toLocaleString()} 장</td>
          </tr>
          <tr>
            <td>표 / 그림 / 각주</td>
            <td>
              {stats.tables} / {stats.images} / {stats.footnotes}
            </td>
          </tr>
        </tbody>
      </table>
    </Modal>
  );
}

export function PrefsDialog({ onClose }: { onClose: () => void }) {
  const [p, setP] = useState({ ...app.prefs });
  const ok = () => {
    app.prefs = p;
    app.savePrefs();
    app.restartAutosave();
    app.applySpellcheck();
    app.applyTheme();
    refreshAuthor();
    app.emit();
    onClose();
  };
  return (
    <Modal title="환경 설정" onClose={onClose} width={460} onEnter={ok} footer={<OkCancel onOk={ok} onCancel={onClose} />}>
      <Fieldset legend="편집">
        <div className="form-grid">
          <label>사용자 이름</label>
          <input value={p.userName || ''} placeholder="변경 내용·메모에 남길 이름" onChange={(e) => setP({ ...p, userName: e.target.value })} style={{ width: 200 }} />
          <label>새 문서 기본 글꼴</label>
          <FontCombo value={p.defaultFont} fonts={app.fontList()} onChange={(f) => setP({ ...p, defaultFont: f })} width={200} />
          <label>기본 글자 크기</label>
          <NumberInput value={p.defaultFontSize} onChange={(v) => setP({ ...p, defaultFontSize: v })} min={4} max={72} step={0.5} unit="pt" />
          <label>기본 저장 형식</label>
          <select value={p.defaultSaveFormat} onChange={(e) => setP({ ...p, defaultSaveFormat: e.target.value as SaveFormatId })}>
            {SAVE_FORMATS.filter((f) => f.id !== 'pdf').map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
        </div>
      </Fieldset>
      <Fieldset legend="화면">
        <div className="form-grid">
          <label>테마</label>
          <select value={p.theme} onChange={(e) => setP({ ...p, theme: e.target.value as any })}>
            <option value="system">운영체제 설정을 따름</option>
            <option value="light">밝게</option>
            <option value="dark">어둡게</option>
          </select>
        </div>
        <label className="check">
          <input type="checkbox" checked={p.darkPaper} onChange={(e) => setP({ ...p, darkPaper: e.target.checked })} />
          어두운 테마에서 종이도 어둡게 (화면에서만, 인쇄는 그대로)
        </label>
      </Fieldset>
      <Fieldset legend="저장">
        <div className="form-grid">
          <label>자동 저장 간격</label>
          <NumberInput value={p.autosaveMinutes} onChange={(v) => setP({ ...p, autosaveMinutes: v })} min={0} max={120} unit="분 (0 = 끄기)" />
        </div>
      </Fieldset>
      <label className="check">
        <input type="checkbox" checked={p.spellcheck} onChange={(e) => setP({ ...p, spellcheck: e.target.checked })} />
        영문 맞춤법 검사 사용
      </label>
    </Modal>
  );
}

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const list = Object.values(commands).filter((c) => c.shortcut);
  return (
    <Modal title="단축키 목록" onClose={onClose} width={520} footer={<button className="btn" onClick={onClose}>닫기</button>}>
      <div className="scroll-y">
        <table className="doc-info-table kbd-table">
          <tbody>
            {list.map((c) => (
              <tr key={c.label}>
                <td>{c.shortcut}</td>
                <td>{c.label.replace(/\.\.\.$/, '')}</td>
              </tr>
            ))}
            <tr>
              <td>Tab / Shift+Tab</td>
              <td>표에서 다음/이전 셀, 목록에서 수준 바꾸기</td>
            </tr>
            <tr>
              <td>F5 → M / S / L</td>
              <td>셀 블록 후 셀 합치기 / 나누기 / 테두리·배경</td>
            </tr>
            <tr>
              <td>Ctrl+Alt+1~6</td>
              <td>제목 1~6</td>
            </tr>
            <tr>
              <td>Ctrl+휠</td>
              <td>화면 확대/축소</td>
            </tr>
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

const STYLE_LIST = [
  { id: 'p', name: '바탕글', desc: '기본 문단 (함초롬바탕 10pt, 줄 간격 160%)' },
  { id: 'body', name: '본문', desc: '왼쪽 여백 15pt 문단' },
  { id: 'h1', name: '제목 1 (개요 1)', desc: '20pt 진하게' },
  { id: 'h2', name: '제목 2 (개요 2)', desc: '16pt 진하게' },
  { id: 'h3', name: '제목 3 (개요 3)', desc: '14pt 진하게' },
  { id: 'h4', name: '제목 4 (개요 4)', desc: '12pt 진하게' },
  { id: 'h5', name: '제목 5 (개요 5)', desc: '11pt 진하게' },
  { id: 'h6', name: '제목 6 (개요 6)', desc: '10pt 진하게' },
  { id: 'quote', name: '인용', desc: '왼쪽 선이 있는 인용 문단' },
  { id: 'code', name: '코드', desc: '고정폭 글꼴 코드 블록' },
];

export function StyleDialog({ onClose }: { onClose: () => void }) {
  const [sel, setSel] = useState('p');
  const ok = () => {
    applyStyle(app.active!.editor, sel);
    onClose();
  };
  return (
    <Modal title="스타일" onClose={onClose} width={420} onEnter={ok} footer={<OkCancel onOk={ok} onCancel={onClose} okLabel="설정" />}>
      <div style={{ border: '1px solid var(--c-border)', maxHeight: 320, overflowY: 'auto' }}>
        {STYLE_LIST.map((s) => (
          <div key={s.id} className="menu-item" style={{ height: 'auto', padding: '6px 10px', background: sel === s.id ? 'var(--c-accent-soft)' : undefined }} onClick={() => setSel(s.id)} onDoubleClick={() => (setSel(s.id), applyStyle(app.active!.editor, s.id), onClose())}>
            <div>
              <div style={{ fontWeight: 600 }}>{s.name}</div>
              <div className="unit">{s.desc}</div>
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}

/** 빌드 시각 (vite define) → 2026-10-16 09:30 */
function buildDate(): string {
  const d = new Date(__BUILD_TIME__);
  if (isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const [version, setVersion] = useState('');
  useEffect(() => {
    platform.version().then((v) => setVersion(v || ''));
  }, []);
  return (
    <Modal title="Kite 정보" onClose={onClose} width={420} footer={<button className="btn primary" onClick={onClose}>확인</button>}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <img src="./icon.svg" alt="" style={{ width: 56, height: 56 }} />
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Kite Writer</div>
          <div className="unit">
            버전 {version || '개발판'} · {buildDate()} 빌드
          </div>
          <div className="unit">HWP · HWPX · DOCX · DOC · PDF · MD 문서 편집기</div>
        </div>
      </div>
      <p style={{ lineHeight: 1.6 }}>
        한글(HWP 5.0 / HWPX)·워드·PDF·마크다운 문서를 열어 편집하고 HWPX, HWP, DOCX, PDF, MD, HTML, TXT 형식으로 저장할 수 있습니다.
        <br />
      </p>
      <p className="unit" style={{ lineHeight: 1.6 }}>
        {HWP_NOTICE}
        <br />
        HWPX 는 국가 표준 KS X 6101(개방형 문서 형식, OWPML)을 따릅니다. 한글·한컴은 한글과컴퓨터의 상표이며, Kite 는 한글과컴퓨터와 관계가 없습니다.
      </p>
      <div className="row" style={{ gap: 6 }}>
        <button className="btn small" onClick={() => app.openDialog('legal', { kind: 'privacy' })}>
          개인정보 처리방침
        </button>
        <button className="btn small" onClick={() => app.openDialog('legal', { kind: 'licenses' })}>
          오픈소스 라이선스
        </button>
        <span style={{ flex: 1 }} />
        {contactAvailable() && (
          <button className="btn small" onClick={() => (app.closeDialog(), openContact())}>
            <Icon name="Mail" size={12} /> 문의
          </button>
        )}
        <button className="btn small" onClick={() => openSponsor()}>
          <Icon name="Heart" size={12} color="#e0457b" /> 후원하기
        </button>
      </div>
      {app.active?.path && <div className="unit">현재 문서: {baseName(app.active.path)}</div>}
    </Modal>
  );
}

export function ConfirmDialog() {
  const st = app.confirmState;
  if (!st) return null;
  const def = st.buttons.find((b) => b.primary) || st.buttons[0];
  const cancel = st.buttons.find((b) => b.id === 'cancel') || st.buttons[st.buttons.length - 1];
  return (
    <Modal
      title={st.title}
      onClose={() => st.resolve(cancel.id)}
      width={420}
      onEnter={() => st.resolve(def.id)}
      footer={
        <>
          {st.buttons.map((b) => (
            <button key={b.id} className={'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '')} onClick={() => st.resolve(b.id)} data-autofocus={b.primary ? true : undefined}>
              {b.label}
            </button>
          ))}
        </>
      }
    >
      <div style={{ lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{st.message}</div>
    </Modal>
  );
}

// ---------------- 그림 자르기 ----------------
export function ImageCropDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const sel = editor.state.selection;
  const node = sel instanceof NodeSelection && sel.node.type.name === 'image' ? sel.node : null;
  const pos = node ? sel.from : -1;
  const c0: Crop = cropOf(node?.attrs.crop) || { t: 0, r: 0, b: 0, l: 0 };
  const [crop, setCrop] = useState<Crop>(c0);
  const [nat, setNat] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!node) return;
    const im = new Image();
    im.onload = () => setNat({ w: im.naturalWidth || 200, h: im.naturalHeight || 150 });
    im.src = node.attrs.src;
  }, []);
  if (!node) {
    return (
      <Modal title="그림 자르기" onClose={onClose} width={340} footer={<button className="btn" onClick={onClose}>닫기</button>}>
        그림을 먼저 선택하세요. (그림을 한 번 누르면 선택됩니다)
      </Modal>
    );
  }
  const sc = nat ? Math.min(460 / nat.w, 340 / nat.h, 1) : 1;
  const W = nat ? nat.w * sc : 300;
  const H = nat ? nat.h * sc : 200;
  const box = { x: crop.l * W, y: crop.t * H, w: W * (1 - crop.l - crop.r), h: H * (1 - crop.t - crop.b) };
  const MIN = 0.05;
  const drag = (kind: string) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX;
    const sy = e.clientY;
    const s0 = { ...crop };
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    const move = (ev: MouseEvent) => {
      const dx = (ev.clientX - sx) / W;
      const dy = (ev.clientY - sy) / H;
      const c = { ...s0 };
      if (kind === 'move') {
        const mx = Math.max(-s0.l, Math.min(s0.r, dx));
        const my = Math.max(-s0.t, Math.min(s0.b, dy));
        c.l = s0.l + mx;
        c.r = s0.r - mx;
        c.t = s0.t + my;
        c.b = s0.b - my;
      } else {
        if (kind.includes('w')) c.l = clamp(Math.min(s0.l + dx, 1 - s0.r - MIN));
        if (kind.includes('e')) c.r = clamp(Math.min(s0.r - dx, 1 - s0.l - MIN));
        if (kind.includes('n')) c.t = clamp(Math.min(s0.t + dy, 1 - s0.b - MIN));
        if (kind.includes('s')) c.b = clamp(Math.min(s0.b - dy, 1 - s0.t - MIN));
      }
      setCrop(c);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const ok = () => {
    // 원본 전체가 그려지던 크기를 유지한 채 남은 부분만 보이게
    const curW = node.attrs.width || nat?.w || 200;
    const curH = node.attrs.height || nat?.h || 150;
    const fullW = curW / Math.max(0.01, 1 - c0.l - c0.r);
    const fullH = curH / Math.max(0.01, 1 - c0.t - c0.b);
    const w = Math.round(fullW * (1 - crop.l - crop.r));
    const h = Math.round(fullH * (1 - crop.t - crop.b));
    editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, crop: cropOf(crop), width: w, height: h }));
    onClose();
  };
  const pct = (v: number) => Math.round(v * 1000) / 10;
  const setPct = (k: keyof Crop) => (v: number) => {
    const c = { ...crop, [k]: Math.max(0, Math.min(0.95, v / 100)) };
    if (c.l + c.r > 0.95 || c.t + c.b > 0.95) return;
    setCrop(c);
  };
  const handles: [string, number, number][] = [
    ['nw', box.x, box.y],
    ['n', box.x + box.w / 2, box.y],
    ['ne', box.x + box.w, box.y],
    ['w', box.x, box.y + box.h / 2],
    ['e', box.x + box.w, box.y + box.h / 2],
    ['sw', box.x, box.y + box.h],
    ['s', box.x + box.w / 2, box.y + box.h],
    ['se', box.x + box.w, box.y + box.h],
  ];
  const cursor: Record<string, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', w: 'ew-resize', e: 'ew-resize' };
  return (
    <Modal
      title="그림 자르기"
      onClose={onClose}
      width={560}
      onEnter={ok}
      footer={
        <OkCancel
          onOk={ok}
          onCancel={onClose}
          extra={
            <button className="btn" style={{ marginRight: 'auto' }} onClick={() => setCrop({ t: 0, r: 0, b: 0, l: 0 })}>
              원래대로
            </button>
          }
        />
      }
    >
      <div style={{ textAlign: 'center', marginBottom: 10 }}>
        <div className="crop-stage" style={{ width: W, height: H }}>
          <img src={node.attrs.src} style={{ width: W, height: H }} alt="" />
          <div className="crop-shade" style={{ left: 0, top: 0, width: W, height: box.y }} />
          <div className="crop-shade" style={{ left: 0, top: box.y + box.h, width: W, height: H - box.y - box.h }} />
          <div className="crop-shade" style={{ left: 0, top: box.y, width: box.x, height: box.h }} />
          <div className="crop-shade" style={{ left: box.x + box.w, top: box.y, width: W - box.x - box.w, height: box.h }} />
          <div className="crop-box" style={{ left: box.x, top: box.y, width: box.w, height: box.h }} onMouseDown={drag('move')} />
          {handles.map(([k, x, y]) => (
            <div key={k} className="crop-h" style={{ left: x, top: y, cursor: cursor[k] }} onMouseDown={drag(k)} />
          ))}
        </div>
      </div>
      <div className="row wrap" style={{ gap: 14, justifyContent: 'center' }}>
        <span className="row">위 <NumberInput value={pct(crop.t)} onChange={setPct('t')} min={0} max={95} width={56} unit="%" /></span>
        <span className="row">아래 <NumberInput value={pct(crop.b)} onChange={setPct('b')} min={0} max={95} width={56} unit="%" /></span>
        <span className="row">왼쪽 <NumberInput value={pct(crop.l)} onChange={setPct('l')} min={0} max={95} width={56} unit="%" /></span>
        <span className="row">오른쪽 <NumberInput value={pct(crop.r)} onChange={setPct('r')} min={0} max={95} width={56} unit="%" /></span>
      </div>
      <div className="unit" style={{ marginTop: 8, textAlign: 'center' }}>
        테두리나 모서리를 끌어 남길 부분을 정합니다. 편집 화면에서 그림 모서리를 Shift+끌기 해도 자를 수 있습니다.
      </div>
    </Modal>
  );
}
