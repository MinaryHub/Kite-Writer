import { useEffect, useMemo, useRef, useState } from 'react';
import { app } from '../../app/controller';
import { Modal } from '../widgets';
import { candidates, formatHanja, loadHanja, type HanjaDict, type HanjaFormat, type HanjaItem } from '../../hanja';

/**
 * 한자로 바꾸기 (F9·한자 키): 고른 낱말(또는 커서 앞 낱말)의 한자 후보를 보이고 고른 것으로 바꾼다.
 * 사전에 없는 여러 글자는 한 글자씩 차례로 묻는다 (건너뛰기 가능)
 */
interface Seg {
  /** 처음 문서에서의 자리 (앞 글자를 바꾸며 생긴 길이 차이는 offset 으로 더한다) */
  from: number;
  to: number;
  reading: string;
}

const FMT_KEY = 'kite:hanjaFormat';
function savedFormat(): HanjaFormat {
  try {
    const v = localStorage.getItem(FMT_KEY);
    return v === 'hanjaHangul' || v === 'hangulHanja' ? v : 'hanja';
  } catch {
    return 'hanja';
  }
}

/** 바꿀 조각들: 사전에 있는 낱말·글자 하나면 통째로, 아니면 한글 글자마다 */
export function segmentsOf(d: HanjaDict, from: number, text: string): Seg[] {
  const cps = Array.from(text);
  if ((cps.length === 1 && d.chars.has(text)) || d.words.has(text)) return [{ from, to: from + text.length, reading: text }];
  const out: Seg[] = [];
  let at = from;
  for (const c of cps) {
    if (/[가-힣]/.test(c) && d.chars.has(c)) out.push({ from: at, to: at + c.length, reading: c });
    at += c.length;
  }
  return out;
}

export function HanjaDialog({ onClose, from, text }: { onClose: () => void; from: number; text: string }) {
  const [dict, setDict] = useState<HanjaDict | null>(null);
  const [err, setErr] = useState('');
  const [idx, setIdx] = useState(0);
  const [pick, setPick] = useState(0);
  const [fmt, setFmt] = useState<HanjaFormat>(savedFormat);
  const offset = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    loadHanja().then(setDict, (e) => setErr(String(e?.message || e)));
  }, []);
  const segs = useMemo(() => (dict ? segmentsOf(dict, from, text) : []), [dict, from, text]);
  const seg = segs[idx];
  const items: HanjaItem[] = dict && seg ? candidates(dict, seg.reading) : [];

  const next = () => {
    setPick(0);
    if (idx + 1 >= segs.length) onClose();
    else setIdx(idx + 1);
  };
  const choose = (it: HanjaItem | undefined) => {
    if (!it || !seg) return;
    const editor = app.active!.editor;
    const a = seg.from + offset.current;
    const b = seg.to + offset.current;
    // 그 자리 글이 그대로일 때만 바꾼다 (창을 연 뒤 문서가 바뀌었으면 건드리지 않는다)
    if (editor.state.doc.textBetween(a, b) !== seg.reading) return onClose();
    const out = formatHanja(fmt, it.h, seg.reading);
    editor.view.dispatch(editor.state.tr.insertText(out, a, b));
    offset.current += out.length - (b - a);
    try {
      localStorage.setItem(FMT_KEY, fmt);
    } catch {
      /* 무시 */
    }
    next();
  };
  useEffect(() => {
    listRef.current?.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }, [pick, idx]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') setPick((p) => Math.min(items.length - 1, p + 1));
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') setPick((p) => Math.max(0, p - 1));
    else if (e.key === 'PageDown') setPick((p) => Math.min(items.length - 1, p + 9));
    else if (e.key === 'PageUp') setPick((p) => Math.max(0, p - 9));
    else if (e.key === 'Enter') choose(items[pick]);
    else if (/^[1-9]$/.test(e.key)) choose(items[Number(e.key) - 1]);
    else if (e.key === 'Tab') next();
    else return;
    e.preventDefault();
  };

  return (
    <Modal
      title={`한자로 바꾸기${segs.length > 1 ? ` (${idx + 1}/${segs.length})` : ''}`}
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn primary" disabled={!items.length} onClick={() => choose(items[pick])}>
            바꾸기
          </button>
          {segs.length > 1 && (
            <button className="btn" onClick={next}>
              건너뛰기 (Tab)
            </button>
          )}
          <button className="btn" onClick={onClose}>
            닫기
          </button>
        </>
      }
    >
      <div onKeyDown={onKey} tabIndex={-1} autoFocus style={{ outline: 'none' }} ref={(el) => el?.focus()}>
        {err && <div className="ai-warn">사전을 불러오지 못했습니다: {err}</div>}
        {!dict && !err && <div className="unit">사전을 불러오는 중…</div>}
        {dict && !segs.length && <div className="unit">'{text}' 은(는) 사전에 없습니다.</div>}
        {seg && (
          <>
            <div style={{ fontSize: 18, marginBottom: 6 }}>
              <b>{seg.reading}</b> <span className="unit">후보 {items.length}개 · 1~9·↑↓·Enter 로 고르기</span>
            </div>
            <div ref={listRef} className="hanja-list" style={{ maxHeight: 300, overflowY: 'auto', border: '1px solid var(--border, #ccc)', borderRadius: 4 }}>
              {items.map((it, i) => (
                <div
                  key={it.h + i}
                  className={'menu-item' + (i === pick ? ' on' : '')}
                  style={{ display: 'flex', gap: 10, padding: '4px 8px', cursor: 'pointer', background: i === pick ? 'var(--accent-soft, #dbe8ff)' : undefined }}
                  onMouseEnter={() => setPick(i)}
                  onClick={() => choose(it)}
                >
                  <span className="unit" style={{ width: 14 }}>{i < 9 ? i + 1 : ''}</span>
                  <span style={{ fontSize: 18, minWidth: 60 }}>{it.h}</span>
                  {it.m && <span className="unit">{it.m}</span>}
                </div>
              ))}
            </div>
          </>
        )}
        <div className="row" style={{ gap: 8, marginTop: 10, alignItems: 'center' }}>
          <span>넣는 꼴</span>
          <select value={fmt} onChange={(e) => setFmt(e.target.value as HanjaFormat)}>
            <option value="hanja">漢字</option>
            <option value="hanjaHangul">漢字(한자)</option>
            <option value="hangulHanja">한자(漢字)</option>
          </select>
        </div>
      </div>
    </Modal>
  );
}
