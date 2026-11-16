import { useState } from 'react';
import { app } from '../../app/controller';
import { Modal, OkCancel, Fieldset, NumberInput, Seg, ColorField } from '../widgets';
import type { Columns, DocSettings, PageBorder, PageBorderSide, PageSetup } from '../../types';
import { cleanColumns } from '../../formats/common';

function applySettings(next: DocSettings) {
  const tab = app.active!;
  tab.settings = next;
  tab.markDirty();
  app.emit();
  tab.editor.storage.pagination.schedule();
}

type LineStyle = 'solid' | 'dashed' | 'dotted' | 'double';
const LINE_STYLES: { value: LineStyle; label: string }[] = [
  { value: 'solid', label: '실선' },
  { value: 'dashed', label: '파선' },
  { value: 'dotted', label: '점선' },
  { value: 'double', label: '이중선' },
];

/** 커서가 놓인 곳의 다단과 그 구역: 구역 나누기(위치)·다단 설정 나누기를 차례로 지나며 찾는다 */
function columnsAtCaret(): { cols: Columns | null; sectionPos: number | null; page: PageSetup } {
  const tab = app.active!;
  const { doc, selection } = tab.editor.state;
  const until = selection.$from.depth > 0 ? selection.$from.before(1) : selection.from;
  let cols: Columns | null = tab.settings.page.columns || null;
  let sectionPos: number | null = null;
  let page = tab.settings.page;
  doc.forEach((node, pos) => {
    if (pos > until) return;
    if (node.type.name === 'pageBreak' && node.attrs.sectionPage) {
      sectionPos = pos;
      page = node.attrs.sectionPage as PageSetup;
      cols = page.columns || null;
    } else if (node.type.name === 'columnBreak' && node.attrs.columns) cols = node.attrs.columns as Columns;
  });
  const c = cleanColumns(cols);
  return { cols: c && c.count > 1 ? (c as Columns) : null, sectionPos, page };
}

type Shape = 'same' | 'left' | 'right';

/** 쪽 → 다단 설정: 단 수·간격·구분선. 구역 전체에 걸거나, 커서 자리부터 새 다단으로 나눈다 (다단 설정 나누기) */
export function ColumnsDialog({ onClose }: { onClose: () => void }) {
  const tab = app.active!;
  const cur = columnsAtCaret();
  const c0 = cur.cols;
  const uneven = !!(c0 && c0.widths && c0.count === 2);
  const [s, setS] = useState({
    count: c0 ? c0.count : 2,
    gap: c0 && !c0.widths ? c0.gap : c0?.gaps?.[0] ?? 8,
    shape: (uneven ? (c0!.widths![0] < c0!.widths![1] ? 'left' : 'right') : 'same') as Shape,
    line: !!c0?.line,
    lineStyle: (c0?.line?.s || 'solid') as LineStyle,
    lineWidth: c0?.line?.w || 0.12,
    lineColor: c0?.line?.c || '#000000',
    scope: 'section' as 'section' | 'here',
  });
  const up = (p: Partial<typeof s>) => setS({ ...s, ...p });
  const pg = cur.page;
  const bodyW = (pg.landscape ? Math.max(pg.width, pg.height) : pg.width) - pg.marginLeft - pg.marginRight - pg.gutter;

  const value = (): Columns | null => {
    const n = Math.max(1, Math.min(10, Math.round(s.count)));
    if (n < 2) return null;
    const gap = Math.max(0, Math.min(s.gap, (bodyW - n * 5) / (n - 1)));
    const out: Columns = { count: n, gap: Math.round(gap * 100) / 100 };
    if (n === 2 && s.shape !== 'same') {
      // 한쪽이 좁은 두 단: 1 : 2
      const narrow = Math.round(((bodyW - gap) / 3) * 100) / 100;
      const wide = Math.round((bodyW - gap - narrow) * 100) / 100;
      out.widths = s.shape === 'left' ? [narrow, wide] : [wide, narrow];
      out.gaps = [out.gap, 0];
      out.gap = 0;
    }
    if (s.line) out.line = { w: Math.max(0.1, s.lineWidth), c: s.lineColor, s: s.lineStyle };
    return out;
  };

  const apply = () => {
    const cols = value();
    if (s.scope === 'here') {
      // 커서 자리부터 새 다단 (한 단으로 되돌릴 때도 나누기를 넣는다)
      tab.editor
        .chain()
        .focus()
        .setColumnBreak(cols || { count: 1, gap: 0 })
        .run();
    } else if (cur.sectionPos != null) {
      const node = tab.editor.state.doc.nodeAt(cur.sectionPos);
      if (node) tab.editor.view.dispatch(tab.editor.state.tr.setNodeMarkup(cur.sectionPos, undefined, { ...node.attrs, sectionPage: { ...node.attrs.sectionPage, columns: cols } }));
      tab.editor.storage.pagination.schedule();
    } else applySettings({ ...tab.settings, page: { ...tab.settings.page, columns: cols } });
    onClose();
  };

  const n = Math.max(1, Math.min(10, Math.round(s.count)));
  const preview = value();
  const widths = preview?.widths || Array.from({ length: n }, () => 1);
  return (
    <Modal title="다단 설정" onClose={onClose} width={500} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} />}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div style={{ flex: 1 }}>
          <Fieldset legend="단 모양">
            <div style={{ marginBottom: 8 }}>
              <Seg
                value={n === 1 ? 'one' : n === 2 && s.shape === 'left' ? 'left' : n === 2 && s.shape === 'right' ? 'right' : n === 2 ? 'two' : n === 3 ? 'three' : ('etc' as string)}
                onChange={(v) => {
                  if (v === 'one') up({ count: 1, shape: 'same' });
                  else if (v === 'two') up({ count: 2, shape: 'same' });
                  else if (v === 'three') up({ count: 3, shape: 'same' });
                  else if (v === 'left' || v === 'right') up({ count: 2, shape: v });
                }}
                options={[
                  { value: 'one', label: '하나' },
                  { value: 'two', label: '둘' },
                  { value: 'three', label: '셋' },
                  { value: 'left', label: '왼쪽', title: '왼쪽 단이 좁은 두 단' },
                  { value: 'right', label: '오른쪽', title: '오른쪽 단이 좁은 두 단' },
                ]}
              />
            </div>
            <div className="form-grid">
              <label>단 개수</label>
              <NumberInput value={s.count} onChange={(v) => up({ count: Math.max(1, Math.min(10, Math.round(v))), shape: Math.round(v) === 2 ? s.shape : 'same' })} min={1} max={10} step={1} />
              <label>단 사이 간격</label>
              <NumberInput value={s.gap} onChange={(v) => up({ gap: v })} min={0} max={100} step={0.5} unit="mm" disabled={n < 2} />
            </div>
          </Fieldset>
        </div>
        <div className="paper-preview">
          <div className="pp" style={{ width: 96, height: 128, display: 'flex', gap: n > 1 ? 4 : 0, padding: 10, boxSizing: 'border-box' }}>
            {widths.map((w, i) => (
              <div key={i} style={{ flex: w, background: 'repeating-linear-gradient(#b9c4d6 0 1px, transparent 1px 5px)', borderLeft: i > 0 && s.line ? `1px ${s.lineStyle === 'double' ? 'solid' : s.lineStyle} ${s.lineColor}` : undefined, paddingLeft: i > 0 && s.line ? 2 : 0, backgroundClip: 'content-box' }} />
            ))}
          </div>
        </div>
      </div>
      <Fieldset legend="구분선">
        <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
          <label className="check">
            <input type="checkbox" checked={s.line} disabled={n < 2} onChange={(e) => up({ line: e.target.checked })} /> 구분선 넣기
          </label>
          <select value={s.lineStyle} disabled={!s.line || n < 2} onChange={(e) => up({ lineStyle: e.target.value as LineStyle })}>
            {LINE_STYLES.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
          <NumberInput value={s.lineWidth} onChange={(v) => up({ lineWidth: v })} min={0.1} max={5} step={0.1} unit="mm" disabled={!s.line || n < 2} />
          <ColorField value={s.lineColor} onChange={(v) => up({ lineColor: v || '#000000' })} allowNone={false} />
        </div>
      </Fieldset>
      <Fieldset legend="적용 범위">
        <Seg
          value={s.scope}
          onChange={(v) => up({ scope: v })}
          options={[
            { value: 'section', label: cur.sectionPos != null ? '현재 구역' : '문서 전체' },
            { value: 'here', label: '새 다단으로 (커서부터)', title: '다단 설정 나누기: 커서 자리부터 이 다단으로 새로 시작합니다' },
          ]}
        />
      </Fieldset>
    </Modal>
  );
}

const SIDES: ['l' | 'r' | 't' | 'b', string][] = [
  ['t', '위'],
  ['b', '아래'],
  ['l', '왼쪽'],
  ['r', '오른쪽'],
];

/** 쪽 → 쪽 테두리/배경: 테두리 선(변마다 켜고 끔)·위치·배경색 */
export function PageBorderDialog({ onClose }: { onClose: () => void }) {
  const tab = app.active!;
  const pb = tab.settings.pageBorder || null;
  const first = pb?.sides ? pb.sides.t || pb.sides.b || pb.sides.l || pb.sides.r : undefined;
  const [s, setS] = useState({
    t: !!pb?.sides?.t,
    b: !!pb?.sides?.b,
    l: !!pb?.sides?.l,
    r: !!pb?.sides?.r,
    style: (first?.s || 'solid') as LineStyle,
    width: first?.w || 0.12,
    color: first?.c || '#000000',
    body: pb ? pb.body : false,
    offL: pb?.offset?.[0] ?? 5,
    offR: pb?.offset?.[1] ?? 5,
    offT: pb?.offset?.[2] ?? 5,
    offB: pb?.offset?.[3] ?? 5,
    bg: pb?.bg || null,
    fillArea: (pb?.fillArea || 'paper') as 'paper' | 'page' | 'border',
    on: (pb?.borderOn || 'all') as 'all' | 'first' | 'notFirst',
  });
  const up = (p: Partial<typeof s>) => setS({ ...s, ...p });
  const all = s.t && s.b && s.l && s.r;

  const apply = () => {
    const side: PageBorderSide = { w: Math.max(0.1, s.width), c: s.color, s: s.style };
    const sides: NonNullable<PageBorder['sides']> = {};
    for (const [k] of SIDES) if (s[k]) sides[k] = side;
    const hasSides = Object.keys(sides).length > 0;
    // 그림·그러데이션 채우기(한글 문서에서 읽은 것)는 그대로 둔다
    const keep = pb ? { gradient: pb.gradient, image: pb.image, imageMode: pb.imageMode, headerInside: pb.headerInside, footerInside: pb.footerInside } : {};
    const hasFill = !!(s.bg || pb?.gradient || pb?.image);
    const next: PageBorder | null =
      hasSides || hasFill
        ? {
            ...keep,
            ...(hasSides ? { sides } : {}),
            body: s.body,
            offset: [s.offL, s.offR, s.offT, s.offB].map((v) => Math.max(0, Math.min(100, v))),
            bg: s.bg,
            fillArea: s.fillArea,
            borderOn: s.on === 'all' ? null : s.on,
            fillOn: s.on === 'all' ? null : s.on,
          }
        : null;
    applySettings({ ...tab.settings, pageBorder: next });
    onClose();
  };

  const css = `${Math.max(1, s.width * 3)}px ${s.style} ${s.color}`;
  return (
    <Modal title="쪽 테두리/배경" onClose={onClose} width={520} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} />}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <div style={{ flex: 1 }}>
          <Fieldset legend="테두리">
            <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
              {SIDES.map(([k, label]) => (
                <label key={k} className="check">
                  <input type="checkbox" checked={s[k]} onChange={(e) => up({ [k]: e.target.checked } as any)} /> {label}
                </label>
              ))}
              <button className="btn small" onClick={() => up({ t: !all, b: !all, l: !all, r: !all })}>
                {all ? '모두 없음' : '모두'}
              </button>
            </div>
            <div className="form-grid">
              <label>종류</label>
              <select value={s.style} onChange={(e) => up({ style: e.target.value as LineStyle })}>
                {LINE_STYLES.map((x) => (
                  <option key={x.value} value={x.value}>
                    {x.label}
                  </option>
                ))}
              </select>
              <label>굵기</label>
              <NumberInput value={s.width} onChange={(v) => up({ width: v })} min={0.1} max={5} step={0.1} unit="mm" />
              <label>색</label>
              <ColorField value={s.color} onChange={(v) => up({ color: v || '#000000' })} allowNone={false} />
            </div>
          </Fieldset>
        </div>
        <div className="paper-preview">
          <div className="pp" style={{ width: 99, height: 140, background: s.fillArea === 'paper' && s.bg ? s.bg : undefined }}>
            <div
              style={{
                position: 'absolute',
                inset: s.body ? '12px 12px 12px 12px' : '6px 6px 6px 6px',
                background: s.fillArea !== 'paper' && s.bg ? s.bg : undefined,
                borderTop: s.t ? css : undefined,
                borderBottom: s.b ? css : undefined,
                borderLeft: s.l ? css : undefined,
                borderRight: s.r ? css : undefined,
              }}
            />
          </div>
        </div>
      </div>
      <Fieldset legend="위치">
        <div className="row wrap" style={{ gap: 12, alignItems: 'center', marginBottom: 8 }}>
          <Seg
            value={s.body ? 'body' : 'paper'}
            onChange={(v) => up({ body: v === 'body' })}
            options={[
              { value: 'paper', label: '종이 기준', title: '종이 끝에서 안쪽으로 잰 거리' },
              { value: 'body', label: '쪽 기준', title: '본문 영역에서 바깥쪽으로 잰 거리' },
            ]}
          />
          <Seg
            value={s.on}
            onChange={(v) => up({ on: v })}
            options={[
              { value: 'all', label: '모든 쪽' },
              { value: 'notFirst', label: '첫 쪽 제외' },
              { value: 'first', label: '첫 쪽만' },
            ]}
          />
        </div>
        <div className="row" style={{ gap: 24, alignItems: 'flex-start' }}>
          <div className="form-grid">
            <label>왼쪽</label>
            <NumberInput value={s.offL} onChange={(v) => up({ offL: v })} min={0} max={100} step={0.5} unit="mm" />
            <label>위쪽</label>
            <NumberInput value={s.offT} onChange={(v) => up({ offT: v })} min={0} max={100} step={0.5} unit="mm" />
          </div>
          <div className="form-grid">
            <label>오른쪽</label>
            <NumberInput value={s.offR} onChange={(v) => up({ offR: v })} min={0} max={100} step={0.5} unit="mm" />
            <label>아래쪽</label>
            <NumberInput value={s.offB} onChange={(v) => up({ offB: v })} min={0} max={100} step={0.5} unit="mm" />
          </div>
        </div>
      </Fieldset>
      <Fieldset legend="배경">
        <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
          <label>면 색</label>
          <ColorField value={s.bg} onChange={(v) => up({ bg: v })} />
          <Seg
            value={s.fillArea}
            onChange={(v) => up({ fillArea: v })}
            options={[
              { value: 'paper', label: '종이' },
              { value: 'page', label: '쪽' },
              { value: 'border', label: '테두리 안' },
            ]}
          />
        </div>
      </Fieldset>
    </Modal>
  );
}
