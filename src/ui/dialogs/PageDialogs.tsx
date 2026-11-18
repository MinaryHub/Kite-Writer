import { useRef, useState } from 'react';
import { app } from '../../app/controller';
import { Modal, OkCancel, Fieldset, NumberInput, Seg } from '../widgets';
import type { DocSettings, HeaderFooter, HFAlign, LineNumbering, PageNumFormat, PageNumPos, PageSetup } from '../../types';
import { formatPageNumber } from '../../formats/common';

const PAPERS: { name: string; w: number; h: number }[] = [
  { name: 'A4 (국배판) [210×297mm]', w: 210, h: 297 },
  { name: 'A3 [297×420mm]', w: 297, h: 420 },
  { name: 'A5 (국판) [148×210mm]', w: 148, h: 210 },
  { name: 'B4 (타블로이드) [257×364mm]', w: 257, h: 364 },
  { name: 'B5 (46배판) [182×257mm]', w: 182, h: 257 },
  { name: 'Letter [215.9×279.4mm]', w: 215.9, h: 279.4 },
  { name: 'Legal [215.9×355.6mm]', w: 215.9, h: 355.6 },
  { name: '엽서 [100×148mm]', w: 100, h: 148 },
];

function applySettings(next: DocSettings) {
  const tab = app.active!;
  tab.settings = next;
  tab.markDirty();
  app.emit();
  tab.editor.storage.pagination.schedule();
}

export function PageSetupDialog({ onClose }: { onClose: () => void }) {
  const tab = app.active!;
  const [p, setP] = useState<PageSetup>({ ...tab.settings.page });
  const up = (x: Partial<PageSetup>) => setP({ ...p, ...x });
  // 줄 번호 (한글의 구역 설정 → 줄 번호)
  const [ln, setLn] = useState<LineNumbering | null>(tab.settings.lineNumbers ? { ...tab.settings.lineNumbers } : null);
  const preset = PAPERS.findIndex((x) => Math.abs(x.w - p.width) < 0.6 && Math.abs(x.h - p.height) < 0.6);
  const apply = () => {
    const body = (p.landscape ? Math.max(p.width, p.height) : p.width) - p.marginLeft - p.marginRight - p.gutter;
    const bodyH = (p.landscape ? Math.min(p.width, p.height) : p.height) - p.marginTop - p.marginBottom - p.marginHeader - p.marginFooter;
    if (body < 20 || bodyH < 20) {
      app.toast('여백이 너무 커서 본문 영역이 없습니다.', 'error');
      return;
    }
    applySettings({ ...tab.settings, page: p, lineNumbers: ln });
    onClose();
  };
  const W = p.landscape ? Math.max(p.width, p.height) : p.width;
  const H = p.landscape ? Math.min(p.width, p.height) : p.height;
  const sc = 140 / Math.max(W, H);
  return (
    <Modal title="편집 용지" onClose={onClose} width={560} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} />}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div style={{ flex: 1 }}>
          <Fieldset legend="용지 종류">
            <div className="form-grid">
              <label>종류</label>
              <select
                value={preset < 0 ? 'custom' : String(preset)}
                onChange={(e) => {
                  if (e.target.value === 'custom') return;
                  const x = PAPERS[+e.target.value];
                  up({ width: x.w, height: x.h });
                }}
              >
                {PAPERS.map((x, i) => (
                  <option key={i} value={String(i)}>
                    {x.name}
                  </option>
                ))}
                <option value="custom">사용자 정의</option>
              </select>
              <label>폭</label>
              <NumberInput value={p.width} onChange={(v) => up({ width: v })} min={50} max={2000} step={0.1} unit="mm" />
              <label>길이</label>
              <NumberInput value={p.height} onChange={(v) => up({ height: v })} min={50} max={2000} step={0.1} unit="mm" />
              <label>용지 방향</label>
              <Seg
                value={p.landscape ? 'l' : 'p'}
                onChange={(v) => up({ landscape: v === 'l' })}
                options={[
                  { value: 'p', label: '세로' },
                  { value: 'l', label: '가로' },
                ]}
              />
            </div>
          </Fieldset>
        </div>
        <div className="paper-preview">
          <div className="pp" style={{ width: W * sc, height: H * sc }}>
            <div
              className="pb"
              style={{
                left: (p.marginLeft + p.gutter) * sc,
                right: p.marginRight * sc,
                top: (p.marginTop + p.marginHeader) * sc,
                bottom: (p.marginBottom + p.marginFooter) * sc,
              }}
            />
          </div>
        </div>
      </div>
      <Fieldset legend="용지 여백">
        <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
          <div className="form-grid">
            <label>위쪽</label>
            <NumberInput value={p.marginTop} onChange={(v) => up({ marginTop: v })} min={0} step={0.5} unit="mm" />
            <label>머리말</label>
            <NumberInput value={p.marginHeader} onChange={(v) => up({ marginHeader: v })} min={0} step={0.5} unit="mm" />
            <label>왼쪽</label>
            <NumberInput value={p.marginLeft} onChange={(v) => up({ marginLeft: v })} min={0} step={0.5} unit="mm" />
            <label>제본</label>
            <NumberInput value={p.gutter} onChange={(v) => up({ gutter: v })} min={0} step={0.5} unit="mm" />
          </div>
          <div className="form-grid">
            <label>아래쪽</label>
            <NumberInput value={p.marginBottom} onChange={(v) => up({ marginBottom: v })} min={0} step={0.5} unit="mm" />
            <label>꼬리말</label>
            <NumberInput value={p.marginFooter} onChange={(v) => up({ marginFooter: v })} min={0} step={0.5} unit="mm" />
            <label>오른쪽</label>
            <NumberInput value={p.marginRight} onChange={(v) => up({ marginRight: v })} min={0} step={0.5} unit="mm" />
          </div>
        </div>
        <div className="unit" style={{ marginTop: 8 }}>
          한글과 같이 본문은 '위쪽 + 머리말' 아래에서 시작하고 '아래쪽 + 꼬리말' 위에서 끝납니다.
        </div>
      </Fieldset>
      <Fieldset legend="줄 번호">
        <label className="check">
          <input type="checkbox" checked={!!ln} onChange={(e) => setLn(e.target.checked ? { restart: 'continue', countBy: 1, distance: 5, start: 1 } : null)} />
          본문 줄마다 왼쪽 여백에 번호 넣기
        </label>
        {ln && (
          <div className="row" style={{ gap: 24, alignItems: 'flex-start', marginTop: 8 }}>
            <div className="form-grid">
              <label>새로 시작</label>
              <Seg
                value={ln.restart === 'page' ? 'page' : 'continue'}
                onChange={(v) => setLn({ ...ln, restart: v })}
                options={[
                  { value: 'continue', label: '이어서' },
                  { value: 'page', label: '쪽마다' },
                ]}
              />
              <label>시작 번호</label>
              <NumberInput value={ln.start} onChange={(v) => setLn({ ...ln, start: Math.max(1, Math.round(v)) })} min={1} />
            </div>
            <div className="form-grid">
              <label>번호 간격</label>
              <NumberInput value={ln.countBy} onChange={(v) => setLn({ ...ln, countBy: Math.max(1, Math.min(100, Math.round(v))) })} min={1} max={100} unit="줄마다" />
              <label>본문과 간격</label>
              <NumberInput value={ln.distance} onChange={(v) => setLn({ ...ln, distance: Math.max(0, Math.min(50, v)) })} min={0} max={50} step={0.5} unit="mm" />
            </div>
          </div>
        )}
      </Fieldset>
    </Modal>
  );
}

function HFEditor({ label, value, onChange }: { label: string; value: { text: string; align: HFAlign }; onChange: (v: { text: string; align: HFAlign }) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const insert = (tok: string) => {
    const el = ref.current;
    const pos = el?.selectionStart ?? value.text.length;
    const text = value.text.slice(0, pos) + tok + value.text.slice(el?.selectionEnd ?? pos);
    onChange({ ...value, text });
    setTimeout(() => {
      el?.focus();
      el?.setSelectionRange(pos + tok.length, pos + tok.length);
    }, 0);
  };
  return (
    <Fieldset legend={label}>
      <div className="row" style={{ marginBottom: 8 }}>
        <input ref={ref} type="text" style={{ flex: 1 }} value={value.text} placeholder={`${label} 내용 (비우면 없음)`} onChange={(e) => onChange({ ...value, text: e.target.value })} />
      </div>
      <div className="row wrap">
        <Seg
          value={value.align}
          onChange={(v) => onChange({ ...value, align: v })}
          options={[
            { value: 'left', label: '왼쪽' },
            { value: 'center', label: '가운데' },
            { value: 'right', label: '오른쪽' },
          ]}
        />
        <button className="btn small" onClick={() => insert('{{PAGE}}')}>
          쪽 번호 넣기
        </button>
        <button className="btn small" onClick={() => insert('{{PAGES}}')}>
          전체 쪽수 넣기
        </button>
        <button className="btn small" onClick={() => insert(new Date().toLocaleDateString('ko-KR'))}>
          오늘 날짜
        </button>
      </div>
    </Fieldset>
  );
}

export function HeaderFooterDialog({ onClose }: { onClose: () => void }) {
  const tab = app.active!;
  const [h, setH] = useState({ ...tab.settings.header });
  const [f, setF] = useState({ ...tab.settings.footer });
  const apply = () => {
    // 글자나 정렬을 고치면 한글에서 온 표·그림 모양(content) 대신 고친 글자를 쓴다
    const keep = (v: HeaderFooter, old: HeaderFooter): HeaderFooter => {
      if (v.text === old.text && v.align === old.align) return v;
      const { content: _drop, ...rest } = v;
      return rest;
    };
    applySettings({ ...tab.settings, header: keep(h, tab.settings.header), footer: keep(f, tab.settings.footer) });
    onClose();
  };
  return (
    <Modal title="머리말/꼬리말" onClose={onClose} width={560} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} />}>
      <HFEditor label="머리말" value={h} onChange={setH} />
      <HFEditor label="꼬리말" value={f} onChange={setF} />
      <div className="unit">{'{{PAGE}}'}는 현재 쪽 번호, {'{{PAGES}}'}는 전체 쪽수로 바뀝니다. 머리말/꼬리말 영역을 두 번 누르면 이 창이 열립니다.</div>
    </Modal>
  );
}

export function PageNumberDialog({ onClose }: { onClose: () => void }) {
  const tab = app.active!;
  const [n, setN] = useState({ ...tab.settings.pageNumber });
  const apply = () => {
    applySettings({ ...tab.settings, pageNumber: n });
    onClose();
  };
  const cell = (pos: PageNumPos, label: string) => (
    <button className={n.pos === pos ? 'on' : ''} onClick={() => setN({ ...n, pos })}>
      {label}
    </button>
  );
  return (
    <Modal title="쪽 번호 매기기" onClose={onClose} width={440} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} />}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 18 }}>
        <Fieldset legend="번호 위치">
          <div className="page-pos-grid">
            {cell('top-left', '왼쪽 위')}
            {cell('top-center', '가운데 위')}
            {cell('top-right', '오른쪽 위')}
            <div className="mid" />
            {cell('bottom-left', '왼쪽 아래')}
            {cell('bottom-center', '가운데 아래')}
            {cell('bottom-right', '오른쪽 아래')}
          </div>
          <label className="check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={n.pos === 'none'} onChange={(e) => setN({ ...n, pos: e.target.checked ? 'none' : 'bottom-center' })} />
            쪽 번호 없음
          </label>
        </Fieldset>
        <Fieldset legend="번호 모양" style={{ flex: 1 }}>
          <div className="form-grid">
            <label>모양</label>
            <select value={n.format} onChange={(e) => setN({ ...n, format: e.target.value as PageNumFormat })}>
              <option value="digit">1, 2, 3</option>
              <option value="dash">- 1 -, - 2 -</option>
              <option value="paren">(1), (2)</option>
              <option value="roman">i, ii, iii</option>
              <option value="ROMAN">I, II, III</option>
            </select>
            <label>시작 번호</label>
            <NumberInput value={n.start} onChange={(v) => setN({ ...n, start: Math.max(1, Math.round(v)) })} min={1} />
            <label>보기</label>
            <span style={{ fontFamily: 'serif', fontSize: 14 }}>{formatPageNumber(n.start, n.format)}</span>
          </div>
        </Fieldset>
      </div>
    </Modal>
  );
}
