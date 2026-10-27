import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useApp } from '../app/hooks';
import { buildPrintPages, computeGeom } from '../print';
import { Icon } from './Icon';

/** 배율: 쪽 맞춤·폭 맞춤은 창 크기에 따라 다시 계산한다 */
type FitMode = 'page' | 'width' | 'custom';
type Layout = 'one' | 'many';
interface PvPrefs {
  fit: FitMode;
  zoom: number;
  layout: Layout;
}

const PREFS_KEY = 'kite.preview';
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3;
/** 본문 안 여백(.pv-body padding)과 쪽 번호 줄 */
const PAD = 24;
const LABEL_H = 22;

function loadPrefs(): PvPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    if (v && typeof v === 'object')
      return {
        fit: v.fit === 'width' || v.fit === 'custom' ? v.fit : 'page',
        zoom: typeof v.zoom === 'number' && v.zoom >= MIN_ZOOM && v.zoom <= MAX_ZOOM ? v.zoom : 0.6,
        layout: v.layout === 'one' ? 'one' : 'many',
      };
  } catch {
    /* 무시 */
  }
  return { fit: 'page', zoom: 0.6, layout: 'many' };
}

function savePrefs(p: PvPrefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* 무시 */
  }
}

const clampZoom = (z: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(z * 100) / 100));

export function PreviewModal() {
  const app = useApp();
  const tab = app.active;
  const bodyRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [prefs, setPrefs] = useState<PvPrefs>(loadPrefs);
  const [count, setCount] = useState(0);
  const [cur, setCur] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const [geom, setGeom] = useState<{ W: number; H: number } | null>(null);
  const [fitZoom, setFitZoom] = useState<number | null>(null);
  const open = app.previewOpen && !!tab;
  const zoom = prefs.fit === 'custom' ? prefs.zoom : fitZoom ?? prefs.zoom;

  const update = useCallback((p: Partial<PvPrefs>) => {
    setPrefs((old) => {
      const next = { ...old, ...p };
      savePrefs(next);
      return next;
    });
  }, []);
  const setZoom = useCallback((z: number) => update({ fit: 'custom', zoom: clampZoom(z) }), [update]);

  // 쪽 그리기
  useEffect(() => {
    if (!open || !tab || !pagesRef.current) return;
    const g = computeGeom(tab.settings);
    setGeom({ W: g.W, H: g.H });
    const host = pagesRef.current;
    host.replaceChildren();
    const pages = buildPrintPages(tab);
    pages.forEach((p, i) => {
      const wrap = document.createElement('div');
      wrap.className = 'pv-page';
      wrap.dataset.page = String(i + 1);
      wrap.appendChild(p);
      const label = document.createElement('div');
      label.className = 'pv-label';
      label.textContent = `${i + 1} / ${pages.length}`;
      wrap.appendChild(label);
      host.appendChild(wrap);
    });
    setCount(pages.length);
    setCur(1);
    setPageInput('1');
    bodyRef.current?.scrollTo(0, 0);
  }, [open, tab]);

  // 쪽 맞춤·폭 맞춤 배율 (창 크기가 바뀌면 다시)
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!open || !body || !geom || prefs.fit === 'custom') return;
    const calc = () => {
      const w = body.clientWidth - PAD * 2;
      const h = body.clientHeight - PAD * 2 - LABEL_H;
      if (w <= 0 || h <= 0) return;
      const z = prefs.fit === 'width' ? w / geom.W : Math.min(w / geom.W, h / geom.H);
      setFitZoom(clampZoom(Math.floor(z * 100) / 100));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(body);
    return () => ro.disconnect();
  }, [open, geom, prefs.fit]);

  const pageEls = () => Array.from(pagesRef.current?.querySelectorAll<HTMLElement>('.pv-page') || []);

  const goTo = useCallback(
    (n: number) => {
      const els = pageEls();
      if (!els.length) return;
      const k = Math.max(1, Math.min(els.length, Math.round(n)));
      els[k - 1].scrollIntoView({ block: 'start', inline: 'nearest' });
      curRef.current = k;
      setCur(k);
      setPageInput(String(k));
    },
    [],
  );

  // 배율·배치가 바뀌어도 보던 쪽에 머문다
  const curRef = useRef(cur);
  curRef.current = cur;
  useLayoutEffect(() => {
    if (open && curRef.current > 1) goTo(curRef.current);
  }, [open, zoom, prefs.layout, goTo]);

  // 스크롤하면 지금 보이는 쪽
  const onScroll = () => {
    const body = bodyRef.current;
    if (!body) return;
    const top = body.getBoundingClientRect().top + 40;
    const els = pageEls();
    let k = els.findIndex((el) => el.getBoundingClientRect().bottom > top);
    if (k < 0) k = els.length - 1;
    if (k + 1 !== cur) {
      setCur(k + 1);
      setPageInput(String(k + 1));
    }
  };

  const close = useCallback(() => app.set({ previewOpen: false }), [app]);
  const doPrint = useCallback(() => {
    close();
    setTimeout(() => app.print(), 50);
  }, [app, close]);
  const doPdf = useCallback(() => {
    close();
    setTimeout(() => app.exportPdf(), 50);
  }, [app, close]);

  // 단축키: 미리 보기가 떠 있는 동안은 편집 화면 단축키보다 먼저 받는다
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => {
      const inInput = e.target instanceof HTMLInputElement;
      const ctrl = e.ctrlKey || e.metaKey;
      let handled = true;
      if (e.key === 'Escape') close();
      else if (ctrl && (e.key === 'p' || e.key === 'P')) doPrint();
      else if (e.altKey && (e.key === 'p' || e.key === 'P')) doPrint();
      else if (ctrl && (e.key === '=' || e.key === '+')) setZoom(zoom + 0.1);
      else if (ctrl && e.key === '-') setZoom(zoom - 0.1);
      else if (ctrl && e.key === '0') setZoom(1);
      else if (inInput) handled = false;
      else if (e.key === 'PageDown' || (e.key === 'ArrowRight' && prefs.layout === 'one')) goTo(curRef.current + 1);
      else if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && prefs.layout === 'one')) goTo(curRef.current - 1);
      else if (e.key === 'Home' && ctrl) goTo(1);
      else if (e.key === 'End' && ctrl) goTo(count);
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [open, close, doPrint, setZoom, goTo, zoom, count, prefs.layout]);

  // Ctrl+휠: 배율
  useEffect(() => {
    const body = bodyRef.current;
    if (!open || !body) return;
    const w = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    body.addEventListener('wheel', w, { passive: false });
    return () => body.removeEventListener('wheel', w);
  }, [open, zoom, setZoom]);

  if (!open) return null;
  const submitPage = () => {
    const n = parseInt(pageInput, 10);
    if (isFinite(n)) goTo(n);
    else setPageInput(String(cur));
  };
  return (
    <div className="preview-modal">
      <div className="pv-bar">
        <b style={{ fontSize: 13 }}>미리 보기</b>
        <span className="unit pv-title">{tab!.title}</span>
        <span style={{ flex: 1 }} />

        <div className="pv-group">
          <button className="btn small" title="첫 쪽 (Ctrl+Home)" disabled={cur <= 1} onClick={() => goTo(1)}>
            <Icon name="ArrowUpToLine" size={14} />
          </button>
          <button className="btn small" title="이전 쪽 (PgUp)" disabled={cur <= 1} onClick={() => goTo(cur - 1)}>
            <Icon name="ArrowLeft" size={14} />
          </button>
          <input
            className="pv-pageno"
            aria-label="쪽 번호"
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ''))}
            onKeyDown={(e) => e.key === 'Enter' && submitPage()}
            onBlur={submitPage}
            onFocus={(e) => e.target.select()}
          />
          <span className="unit">/ {count}쪽</span>
          <button className="btn small" title="다음 쪽 (PgDn)" disabled={cur >= count} onClick={() => goTo(cur + 1)}>
            <Icon name="ArrowRight" size={14} />
          </button>
          <button className="btn small" title="마지막 쪽 (Ctrl+End)" disabled={cur >= count} onClick={() => goTo(count)}>
            <Icon name="ArrowDownToLine" size={14} />
          </button>
        </div>

        <div className="seg" role="group" aria-label="쪽 배치">
          <button className={prefs.layout === 'one' ? 'on' : ''} title="한 쪽씩" onClick={() => update({ layout: 'one' })}>
            <Icon name="FileText" size={14} /> 한 쪽
          </button>
          <button className={prefs.layout === 'many' ? 'on' : ''} title="여러 쪽" onClick={() => update({ layout: 'many' })}>
            <Icon name="LayoutGrid" size={14} /> 여러 쪽
          </button>
        </div>

        <div className="pv-group">
          <button className="btn small" title="축소 (Ctrl+-)" onClick={() => setZoom(zoom - 0.1)}>
            <Icon name="ZoomOut" size={14} />
          </button>
          <span className="pv-zoom">{Math.round(zoom * 100)}%</span>
          <button className="btn small" title="확대 (Ctrl+=)" onClick={() => setZoom(zoom + 0.1)}>
            <Icon name="ZoomIn" size={14} />
          </button>
          <div className="seg" role="group" aria-label="맞춤">
            <button className={prefs.fit === 'page' ? 'on' : ''} title="쪽 맞춤" onClick={() => update({ fit: 'page' })}>
              쪽 맞춤
            </button>
            <button className={prefs.fit === 'width' ? 'on' : ''} title="폭 맞춤" onClick={() => update({ fit: 'width' })}>
              폭 맞춤
            </button>
          </div>
        </div>

        <button className="btn" title="인쇄 (Ctrl+P)" onClick={doPrint}>
          <Icon name="Printer" size={14} /> 인쇄
        </button>
        <button className="btn" onClick={doPdf}>
          <Icon name="FileDown" size={14} /> PDF로 저장
        </button>
        <button className="btn primary" title="닫기 (Esc)" onClick={close}>
          닫기
        </button>
      </div>
      <div className="pv-body" ref={bodyRef} onScroll={onScroll}>
        <div className={`pv-pages ${prefs.layout}`} ref={pagesRef} style={{ zoom, '--pv-zoom': zoom } as any} />
      </div>
    </div>
  );
}
