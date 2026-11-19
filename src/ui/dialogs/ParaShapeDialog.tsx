import { useState } from 'react';
import { app } from '../../app/controller';
import { Modal, OkCancel, Fieldset, NumberInput, ColorField, Seg } from '../widgets';
import { Icon } from '../Icon';
import { cleanParaBorder, type ParaBorder } from '../../formats/common';

const PB_RE = /^([\d.]+)mm (solid|dashed|dotted|double) (#[0-9A-Fa-f]{6})$/;
/** 문단 테두리 값 → 대화 상자의 값 (그릴 변, 선 종류·굵기·색, 글과의 간격, 이어진 문단과 연결) */
function borderState(pb: ParaBorder | null) {
  const first = pb ? PB_RE.exec(pb.t || pb.b || pb.l || pb.r || '') : null;
  return {
    bl: !!pb?.l,
    br: !!pb?.r,
    bt: !!pb?.t,
    bb: !!pb?.b,
    bStyle: first ? first[2] : 'solid',
    bWidth: first ? parseFloat(first[1]) : 0.12,
    bColor: first ? first[3] : '#000000',
    bGap: pb?.o ? Math.round((pb.o[0] / (96 / 25.4)) * 10) / 10 : 0,
    bJoin: !!pb?.c,
  };
}

export function ParaShapeDialog({ onClose }: { onClose: () => void }) {
  const editor = app.active!.editor;
  const a = editor.state.selection.$from.parent.attrs || {};
  const ti = a.textIndent || 0;
  const lhRaw: string | null = a.lineHeight || null;
  const [s, setS] = useState({
    align: (a.textAlign as string) || 'justify',
    left: a.indentLeft || 0,
    right: a.indentRight || 0,
    firstMode: ti > 0 ? 'indent' : ti < 0 ? 'hang' : 'normal',
    firstVal: Math.abs(ti) || 10,
    lhType: lhRaw && /pt$/.test(lhRaw) ? 'fixed' : 'percent',
    lhVal: lhRaw ? (/pt$/.test(lhRaw) ? parseFloat(lhRaw) : Math.round(parseFloat(lhRaw) * 100)) : 160,
    before: a.spaceBefore || 0,
    after: a.spaceAfter || 0,
    bg: (a.paraBg as string) || null,
    ...borderState(cleanParaBorder(a.paraBorder)),
  });
  const up = (p: Partial<typeof s>) => setS({ ...s, ...p });
  /** 대화 상자의 값 → 문단 테두리 값 (그릴 변이 없으면 null) */
  const borderValue = (): ParaBorder | null => {
    const side = `${Math.max(0.1, s.bWidth)}mm ${s.bStyle} ${s.bColor}`;
    const gap = Math.round(s.bGap * (96 / 25.4) * 100) / 100;
    return cleanParaBorder({ ...(s.bl ? { l: side } : {}), ...(s.br ? { r: side } : {}), ...(s.bt ? { t: side } : {}), ...(s.bb ? { b: side } : {}), o: [gap, gap, gap, gap], c: s.bJoin });
  };

  /** 선을 바꾸지 않았으면 원래 값 그대로 (Word 에서 온 테두리의 묶음·간격 정보를 지킨다) */
  const keptBorder = (): ParaBorder | null => {
    const next = borderValue();
    const orig = cleanParaBorder(a.paraBorder);
    if (orig && next && (['l', 'r', 't', 'b'] as const).every((k) => orig[k] === next[k]) && !!orig.c === !!next.c) return orig;
    if (orig && !next && orig.a && !orig.l && !orig.r && !orig.t && !orig.b) return orig;
    return next;
  };

  const apply = () => {
    const textIndent = s.firstMode === 'normal' ? null : s.firstMode === 'indent' ? s.firstVal : -s.firstVal;
    const lineHeight = s.lhType === 'fixed' ? `${s.lhVal}pt` : s.lhVal === 160 ? null : String(s.lhVal / 100);
    editor
      .chain()
      .focus()
      .setParagraphAttrs({
        textAlign: s.align === 'justify' ? null : s.align,
        indentLeft: s.left || null,
        indentRight: s.right || null,
        textIndent,
        lineHeight,
        spaceBefore: s.before || null,
        spaceAfter: s.after || null,
        paraBg: s.bg,
        paraBorder: keptBorder(),
      })
      .run();
    onClose();
  };

  // 미리 보기
  const pv: React.CSSProperties = {
    textAlign: s.align === 'distribute' ? 'justify' : (s.align as any),
    textAlignLast: s.align === 'distribute' ? 'justify' : undefined,
    marginLeft: (s.left + (s.firstMode === 'hang' ? s.firstVal : 0)) * 0.5,
    marginRight: s.right * 0.5,
    textIndent: s.firstMode === 'normal' ? 0 : (s.firstMode === 'indent' ? s.firstVal : -s.firstVal) * 0.5,
    lineHeight: s.lhType === 'fixed' ? `${s.lhVal * 0.6}px` : s.lhVal / 100,
    paddingTop: s.before * 0.5,
    paddingBottom: s.after * 0.5,
    background: s.bg || undefined,
    borderLeft: s.bl ? `${Math.max(1, s.bWidth * 3.78)}px ${s.bStyle} ${s.bColor}` : undefined,
    borderRight: s.br ? `${Math.max(1, s.bWidth * 3.78)}px ${s.bStyle} ${s.bColor}` : undefined,
    borderTop: s.bt ? `${Math.max(1, s.bWidth * 3.78)}px ${s.bStyle} ${s.bColor}` : undefined,
    borderBottom: s.bb ? `${Math.max(1, s.bWidth * 3.78)}px ${s.bStyle} ${s.bColor}` : undefined,
  };
  const filler = '앞 문단 '.repeat(24);
  const sample = '현재 문단의 모양을 미리 보여 줍니다. '.repeat(5);

  return (
    <Modal title="문단 모양" onClose={onClose} width={560} onEnter={apply} footer={<OkCancel onOk={apply} onCancel={onClose} />}>
      <Fieldset legend="정렬 방식">
        <Seg
          value={s.align}
          onChange={(v) => up({ align: v })}
          options={[
            { value: 'justify', label: <><Icon name="AlignJustify" size={14} /> 양쪽</> },
            { value: 'left', label: <><Icon name="AlignLeft" size={14} /> 왼쪽</> },
            { value: 'center', label: <><Icon name="AlignCenter" size={14} /> 가운데</> },
            { value: 'right', label: <><Icon name="AlignRight" size={14} /> 오른쪽</> },
            { value: 'distribute', label: <><Icon name="AlignHorizontalSpaceAround" size={14} /> 배분</> },
          ]}
        />
      </Fieldset>
      <div className="row" style={{ alignItems: 'stretch', gap: 12 }}>
        <Fieldset legend="여백" style={{ flex: 1 }}>
          <div className="form-grid">
            <label>왼쪽</label>
            <NumberInput value={s.left} onChange={(v) => up({ left: v })} min={0} step={0.5} unit="pt" />
            <label>오른쪽</label>
            <NumberInput value={s.right} onChange={(v) => up({ right: v })} min={0} step={0.5} unit="pt" />
          </div>
        </Fieldset>
        <Fieldset legend="첫 줄" style={{ flex: 1.3 }}>
          <div className="row" style={{ marginBottom: 8 }}>
            <Seg
              value={s.firstMode}
              onChange={(v) => up({ firstMode: v })}
              options={[
                { value: 'normal', label: '보통' },
                { value: 'indent', label: '들여쓰기' },
                { value: 'hang', label: '내어쓰기' },
              ]}
            />
          </div>
          <NumberInput value={s.firstVal} onChange={(v) => up({ firstVal: v })} min={0} step={0.5} unit="pt" disabled={s.firstMode === 'normal'} />
        </Fieldset>
      </div>
      <Fieldset legend="간격">
        <div className="form-grid">
          <label>줄 간격</label>
          <div className="row">
            <select value={s.lhType} onChange={(e) => up({ lhType: e.target.value, lhVal: e.target.value === 'fixed' ? 16 : 160 })}>
              <option value="percent">글자에 따라</option>
              <option value="fixed">고정 값</option>
            </select>
            <NumberInput value={s.lhVal} onChange={(v) => up({ lhVal: v })} min={s.lhType === 'fixed' ? 1 : 50} max={s.lhType === 'fixed' ? 500 : 500} step={s.lhType === 'fixed' ? 0.5 : 5} unit={s.lhType === 'fixed' ? 'pt' : '%'} />
          </div>
          <label>문단 위</label>
          <NumberInput value={s.before} onChange={(v) => up({ before: v })} min={0} step={0.5} unit="pt" />
          <label>문단 아래</label>
          <NumberInput value={s.after} onChange={(v) => up({ after: v })} min={0} step={0.5} unit="pt" />
          <label>문단 배경</label>
          <ColorField value={s.bg} onChange={(v) => up({ bg: v })} />
        </div>
      </Fieldset>
      <Fieldset legend="테두리">
        <div className="row wrap" style={{ gap: 12, marginBottom: 8 }}>
          {(
            [
              ['bt', '위'],
              ['bb', '아래'],
              ['bl', '왼쪽'],
              ['br', '오른쪽'],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={s[k]} onChange={(e) => up({ [k]: e.target.checked } as any)} />
              {label}
            </label>
          ))}
          <button className="btn" onClick={() => up({ bt: true, bb: true, bl: true, br: true })}>
            상자
          </button>
          <button className="btn" onClick={() => up({ bt: false, bb: false, bl: false, br: false })}>
            없음
          </button>
        </div>
        <div className="row wrap" style={{ gap: 10 }}>
          <select value={s.bStyle} onChange={(e) => up({ bStyle: e.target.value })}>
            <option value="solid">실선</option>
            <option value="dashed">파선</option>
            <option value="dotted">점선</option>
            <option value="double">이중 실선</option>
          </select>
          <NumberInput value={s.bWidth} onChange={(v) => up({ bWidth: v })} min={0.1} max={5} step={0.1} unit="mm" width={64} />
          <ColorField value={s.bColor} onChange={(v) => up({ bColor: v || '#000000' })} allowNone={false} />
          <span>글과의 간격</span>
          <NumberInput value={s.bGap} onChange={(v) => up({ bGap: v })} min={0} max={30} step={0.5} unit="mm" width={64} />
          <label className="check" title="같은 테두리의 이어진 문단을 한 상자로 묶는다">
            <input type="checkbox" checked={s.bJoin} onChange={(e) => up({ bJoin: e.target.checked })} />
            이어진 문단과 연결
          </label>
        </div>
      </Fieldset>
      <div className="preview-box para">
        <div>{filler}</div>
        <div className="pv-cur" style={pv}>
          {sample}
        </div>
        <div>{'뒤 문단 '.repeat(24)}</div>
      </div>
    </Modal>
  );
}
