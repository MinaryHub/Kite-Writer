import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Icon } from './Icon';
import { cssFontFamily } from '../fonts';

// ---------------- 대화 상자 ----------------
export function Modal(props: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  modeless?: boolean;
  onEnter?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        props.onClose();
      } else if (e.key === 'Enter' && props.onEnter && !(e.target as HTMLElement)?.matches('textarea') && !e.isComposing) {
        e.preventDefault();
        props.onEnter();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [props.onClose, props.onEnter]);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus], input:not([type=checkbox]):not([type=radio]):not([type=color]), select, textarea');
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }, []);
  const startDrag = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const box = ref.current!.getBoundingClientRect();
    const dx = e.clientX - box.left;
    const dy = e.clientY - box.top;
    const move = (ev: MouseEvent) => setPos({ x: ev.clientX - dx, y: ev.clientY - dy });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };
  const style: React.CSSProperties = { width: props.width };
  if (pos) Object.assign(style, { position: 'fixed', left: pos.x, top: pos.y, margin: 0 });
  return (
    <div className={'modal-back' + (props.modeless ? ' no-dim' : '')} onMouseDown={(e) => e.stopPropagation()}>
      <div className="modal" ref={ref} style={style} role="dialog" aria-label={props.title}>
        <div className="modal-head" onMouseDown={startDrag}>
          <span className="mh-title">{props.title}</span>
          <button className="mh-close" onClick={props.onClose} title="닫기 (Esc)">
            <Icon name="X" size={15} />
          </button>
        </div>
        <div className="modal-body">{props.children}</div>
        {props.footer && <div className="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function OkCancel({ onOk, onCancel, okLabel = '설정', extra }: { onOk: () => void; onCancel: () => void; okLabel?: string; extra?: ReactNode }) {
  return (
    <>
      {extra}
      <button className="btn primary" onClick={onOk}>
        {okLabel}
      </button>
      <button className="btn" onClick={onCancel}>
        취소
      </button>
    </>
  );
}

export function Fieldset({ legend, children, style }: { legend: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="fieldset" style={style}>
      <span className="legend">{legend}</span>
      {children}
    </div>
  );
}

export function NumberInput(props: { value: number; onChange: (v: number) => void; step?: number; min?: number; max?: number; width?: number; unit?: string; disabled?: boolean }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = (s: string) => {
    const n = parseFloat(s);
    if (!isNaN(n)) {
      let v = n;
      if (props.min !== undefined) v = Math.max(props.min, v);
      if (props.max !== undefined) v = Math.min(props.max, v);
      props.onChange(Math.round(v * 100) / 100);
    } else setText(String(props.value));
  };
  return (
    <span className="row" style={{ gap: 3 }}>
      <input
        type="number"
        value={text}
        step={props.step ?? 1}
        min={props.min}
        max={props.max}
        disabled={props.disabled}
        style={{ width: props.width ?? 70 }}
        onChange={(e) => {
          setText(e.target.value);
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) props.onChange(n);
        }}
        onBlur={(e) => commit(e.target.value)}
      />
      {props.unit && <span className="unit">{props.unit}</span>}
    </span>
  );
}

export function Seg<T extends string>(props: { value: T; options: { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void }) {
  return (
    <span className="seg">
      {props.options.map((o) => (
        <button key={o.value} className={o.value === props.value ? 'on' : ''} title={o.title} onClick={() => props.onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </span>
  );
}

// ---------------- 드롭다운 ----------------
export function useOutsideClose(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    setTimeout(() => window.addEventListener('mousedown', h), 0);
    window.addEventListener('keydown', k);
    return () => {
      window.removeEventListener('mousedown', h);
      window.removeEventListener('keydown', k);
    };
  }, [open]);
}

export function Dropdown(props: { button: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [fixed, setFixed] = useState<CSSProperties | null>(null);
  useOutsideClose(open, () => setOpen(false), ref);
  // 가로로 스크롤되는 도구 상자(좁은 화면) 안에서는 잘리지 않게 화면 기준으로 띄운다
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return setFixed(null);
    const scroller = el.closest('.toolbar') as HTMLElement | null;
    if (!scroller || getComputedStyle(scroller).overflowX === 'visible') return setFixed(null);
    const r = el.getBoundingClientRect();
    setFixed({ position: 'fixed', top: r.bottom + 2, left: Math.max(4, Math.min(r.left, window.innerWidth - 280)), right: 'auto' });
  }, [open]);
  return (
    <div className="dropdown" ref={ref}>
      {props.button(open, () => setOpen(!open))}
      {open && (
        <div className="dropdown-pop" style={fixed || (props.align === 'right' ? { left: 'auto', right: 0 } : undefined)} onMouseDown={(e) => e.preventDefault()}>
          {props.children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

// ---------------- 색 선택 ----------------
export const PALETTE = [
  '#000000', '#434343', '#666666', '#999999', '#B7B7B7', '#CCCCCC', '#D9D9D9', '#EFEFEF', '#F3F3F3', '#FFFFFF',
  '#980000', '#FF0000', '#FF9900', '#FFFF00', '#00FF00', '#00FFFF', '#4A86E8', '#0000FF', '#9900FF', '#FF00FF',
  '#E6B8AF', '#F4CCCC', '#FCE5CD', '#FFF2CC', '#D9EAD3', '#D0E0E3', '#C9DAF8', '#CFE2F3', '#D9D2E9', '#EAD1DC',
  '#DD7E6B', '#EA9999', '#F9CB9C', '#FFE599', '#B6D7A8', '#A2C4C9', '#A4C2F4', '#9FC5E8', '#B4A7D6', '#D5A6BD',
  '#CC4125', '#E06666', '#F6B26B', '#FFD966', '#93C47D', '#76A5AF', '#6D9EEB', '#6FA8DC', '#8E7CC3', '#C27BA0',
  '#A61C00', '#CC0000', '#E69138', '#F1C232', '#6AA84F', '#45818E', '#3C78D8', '#3D85C6', '#674EA7', '#A64D79',
  '#5B0F00', '#660000', '#783F04', '#7F6000', '#274E13', '#0C343D', '#1C4587', '#073763', '#20124D', '#4C1130',
];

export function ColorGrid({ onPick, noneLabel, onNone }: { onPick: (c: string) => void; noneLabel?: string; onNone?: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <div className="color-grid">
        {PALETTE.map((c) => (
          <button key={c} style={{ background: c }} title={c} onClick={() => onPick(c)} />
        ))}
      </div>
      <div className="color-pop-foot">
        {onNone ? (
          <button className="link-btn" onClick={onNone}>
            {noneLabel || '없음'}
          </button>
        ) : (
          <span />
        )}
        <button className="link-btn" onClick={() => inputRef.current?.click()}>
          다른 색...
        </button>
        <input ref={inputRef} type="color" style={{ width: 0, height: 0, opacity: 0, position: 'absolute' }} onChange={(e) => onPick(e.target.value.toUpperCase())} />
      </div>
    </div>
  );
}

export function ColorButton(props: { icon: string; color: string | null; title: string; onPick: (c: string | null) => void; noneLabel?: string; defaultColor: string }) {
  const [last, setLast] = useState<string>(props.defaultColor);
  return (
    <span className="tb-split" title={props.title}>
      <button className="tb-btn" style={{ flexDirection: 'column', gap: 0 }} onMouseDown={(e) => e.preventDefault()} onClick={() => props.onPick(last)}>
        <Icon name={props.icon} size={15} />
        <span className="color-bar" style={{ background: last }} />
      </button>
      <Dropdown
        button={(_open, toggle) => (
          <button className="tb-btn caret" onMouseDown={(e) => e.preventDefault()} onClick={toggle}>
            <Icon name="ChevronDown" size={11} />
          </button>
        )}
      >
        {(close) => (
          <ColorGrid
            onPick={(c) => {
              setLast(c);
              props.onPick(c);
              close();
            }}
            noneLabel={props.noneLabel}
            onNone={() => {
              props.onPick(null);
              close();
            }}
          />
        )}
      </Dropdown>
    </span>
  );
}

export function ColorField({ value, onChange, allowNone = true }: { value: string | null; onChange: (v: string | null) => void; allowNone?: boolean }) {
  return (
    <span className="color-input">
      <input type="color" value={value || '#ffffff'} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      <span style={{ fontFamily: 'Consolas, monospace', fontSize: 11, width: 60 }}>{value || '없음'}</span>
      {allowNone && (
        <button className="btn small" onClick={() => onChange(null)}>
          없음
        </button>
      )}
    </span>
  );
}

// ---------------- 글꼴 선택 ----------------
export function FontCombo(props: { value: string; fonts: { korean: string[]; others: string[]; recent: string[] }; onChange: (f: string) => void; width?: number }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(props.value);
  const [filter, setFilter] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useOutsideClose(open, () => setOpen(false), ref);
  useEffect(() => {
    if (!open) setText(props.value);
  }, [props.value, open]);
  useLayoutEffect(() => {
    if (open && listRef.current) {
      const sel = listRef.current.querySelector('.sel') as HTMLElement | null;
      if (sel) listRef.current.scrollTop = sel.offsetTop - 80;
    }
  }, [open]);
  const f = filter.toLowerCase();
  const match = (x: string) => !f || x.toLowerCase().includes(f);
  const pick = (x: string) => {
    props.onChange(x);
    setText(x);
    setOpen(false);
    setFilter('');
  };
  const section = (title: string, list: string[]) => {
    const items = list.filter(match);
    if (!items.length) return null;
    return (
      <>
        <div className="fl-head">{title}</div>
        {items.map((x) => (
          <div key={title + x} className={'fl-item' + (x === props.value ? ' sel' : '')} style={{ fontFamily: cssFontFamily(x) }} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(x)}>
            {x}
          </div>
        ))}
      </>
    );
  };
  return (
    <div className="font-combo dropdown" ref={ref}>
      <input
        type="text"
        value={text}
        style={{ width: props.width ?? 150 }}
        title="글꼴"
        onMouseDown={() => setOpen(true)}
        onKeyUp={(e) => e.key === 'ArrowDown' && setOpen(true)}
        onChange={(e) => {
          setText(e.target.value);
          setFilter(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim()) pick(text.trim());
        }}
      />
      {open && (
        <div className="dropdown-pop font-list" ref={listRef}>
          {section('최근 사용', props.fonts.recent)}
          {section('한글 글꼴', props.fonts.korean)}
          {section('영문 및 기타', props.fonts.others)}
        </div>
      )}
    </div>
  );
}
