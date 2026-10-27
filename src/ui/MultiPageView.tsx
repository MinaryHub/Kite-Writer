import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { TextSelection } from '@tiptap/pm/state';
import type { DocTab } from '../doc/docTab';
import { useApp } from '../app/hooks';
import { buildPrintPage, collectPageBoxes, computeGeom, PAGE_GAP, printPlans, type PageBox, type PageGeom, type PagePlan } from '../print';

const GAP = 28;
const LABEL_H = 22;

/**
 * 여러 쪽 보기: 편집 화면의 배치를 쪽 단위로 잘라(인쇄용 DOM 과 같은 방법) 격자로 늘어놓는다.
 * 실제 편집기는 뒤에 숨은 채 배치만 맡고, 여기 보이는 쪽은 그 사본이다. 쪽을 누르면 그 자리로 돌아가 편집한다.
 */
export function MultiPageView({ tab }: { tab: DocTab }) {
  const app = useApp();
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => tab.subscribe(force), [tab]);
  const wsRef = useRef<HTMLDivElement>(null);
  const g: PageGeom = computeGeom(tab.settings, PAGE_GAP);
  const zoom = app.zoom;
  const pageCount = Math.max(1, tab.layout.pageCount);
  // 구역마다 용지가 다르면 칸은 가장 큰 용지 크기로
  const plans = printPlans(tab);
  const pw = Math.max(...plans.map((p) => p.g.W)) * zoom;
  const ph = Math.max(...plans.map((p) => p.g.H)) * zoom;
  const rowH = ph + LABEL_H + GAP;

  // 작업 영역 너비 → 열 수
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    setWidth(ws.clientWidth);
    const ro = new ResizeObserver(() => setWidth(ws.clientWidth));
    ro.observe(ws);
    return () => ro.disconnect();
  }, []);
  const cols = Math.max(1, Math.floor((width - 32 + GAP) / (pw + GAP)));

  // 처음 켤 때 한 화면에 두 쪽은 들어가게 배율을 낮추고, 숨은 편집기에 글자가 들어가지 않게 초점을 뺀다
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;
    const z2 = Math.floor(((ws.clientWidth - 32 - GAP) / (2 * g.W)) * 100) / 100;
    if (app.zoom > z2) app.setZoom(Math.max(0.25, z2));
    (tab.editor.view.dom as HTMLElement).blur();
    ws.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('.modal, .dialog')) app.setMultiPage(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 문서·배치가 바뀌면 조금 뒤에 보이는 쪽을 다시 만든다
  const [version, setVersion] = useState(0);
  useEffect(() => {
    let t: any = null;
    const h = () => {
      clearTimeout(t);
      t = setTimeout(() => setVersion((v) => v + 1), 250);
    };
    tab.editor.on('update', h);
    const un = tab.subscribe(h);
    return () => {
      tab.editor.off('update', h);
      un();
      clearTimeout(t);
    };
  }, [tab]);
  const boxes = useMemo(() => collectPageBoxes(tab.editor.view.dom as HTMLElement), [tab, version, pageCount]);

  // 보이는 줄만 만든다
  const [range, setRange] = useState<[number, number]>([0, 2]);
  const updateRange = () => {
    const ws = wsRef.current;
    if (!ws) return;
    // 보이는 줄과 그 아래 한 줄만 (큰 문서는 쪽 사본 하나가 수십 ms 걸린다)
    const first = Math.max(0, Math.floor((ws.scrollTop - 16) / rowH));
    const last = Math.ceil((ws.scrollTop + ws.clientHeight - 16) / rowH);
    setRange((r) => (r[0] === first && r[1] === last ? r : [first, last]));
  };
  useEffect(updateRange, [rowH, cols, width]);

  // 현재 커서가 있는 쪽
  const sel = tab.editor.state.selection.from;
  let curPage = 0;
  for (let i = 1; i < tab.layout.pageStarts.length; i++) if (tab.layout.pageStarts[i] <= sel) curPage = i;

  const goEdit = (k: number, e: React.MouseEvent) => {
    const cell = e.currentTarget as HTMLElement;
    const r = cell.getBoundingClientRect();
    // 쪽 안에서 누른 자리 → 편집기 좌표 (배율 없는 px)
    const pl = plans[k] || plans[0];
    const xDoc = (e.clientX - r.left) / zoom - pl.g.ml + pl.dx;
    const yDoc = pl.contentTop + (e.clientY - r.top) / zoom - pl.g.mt;
    app.setMultiPage(false);
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('kite:goto-page', { detail: k + 1 }));
      setTimeout(() => {
        const view = tab.editor.view;
        const rect = view.dom.getBoundingClientRect();
        const z = app.zoom;
        const x = Math.min(Math.max(rect.left + xDoc * z, rect.left + 2), rect.right - 2);
        const y = Math.min(Math.max(rect.top + yDoc * z, rect.top + 2), rect.bottom - 2);
        const hit = view.posAtCoords({ left: x, top: y });
        if (hit) {
          try {
            view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(hit.pos))));
          } catch {
            /* 무시 */
          }
        }
        view.focus();
      }, 30);
    }, 0);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (e.ctrlKey) {
      e.preventDefault();
      app.setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }
  };

  const cells = [];
  for (let k = 0; k < pageCount; k++) {
    const row = Math.floor(k / cols);
    const visible = row >= range[0] && row <= range[1];
    cells.push(
      <div key={k} className="mp-cell" style={{ width: pw, height: ph + LABEL_H }}>
        <div className={'mp-page' + (k === curPage ? ' current' : '')} style={{ width: (plans[k] || plans[0]).g.W * zoom, height: (plans[k] || plans[0]).g.H * zoom }} onClick={(e) => goEdit(k, e)} title="누르면 이 쪽을 편집합니다">
          {visible && <PageClone tab={tab} plan={plans[k] || plans[0]} k={k} boxes={boxes} pageCount={pageCount} zoom={zoom} version={version} />}
        </div>
        <div className="mp-label">{k + 1}</div>
      </div>,
    );
  }

  return (
    <div className="workspace multi" ref={wsRef} tabIndex={-1} onScroll={updateRange} onWheel={onWheel}>
      <div className="mp-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${pw}px)`, gap: `${GAP}px` }}>
        {cells}
      </div>
    </div>
  );
}

function PageClone({ tab, plan, k, boxes, pageCount, zoom, version }: { tab: DocTab; plan: PagePlan; k: number; boxes: PageBox[]; pageCount: number; zoom: number; version: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const g = plan.g;
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.replaceChildren(buildPrintPage(tab, plan, k, boxes, pageCount));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, g.W, g.H, plan.contentTop, plan.dx, k, boxes, pageCount, version]);
  return <div ref={ref} className="mp-scale" style={{ width: g.W, height: g.H, transform: `scale(${zoom})` }} />;
}
