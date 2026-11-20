import { useState } from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { app } from '../../app/controller';
import { Modal, OkCancel, Fieldset, NumberInput, Seg } from '../widgets';
import { floatOf } from '../../editor/extensions/nodes';
import { makeFloat, placementOf, type Placement } from '../../editor/objectPlace';

/**
 * 개체 속성 (그림·그리기 개체·글상자): 본문과의 배치, 위치, 크기, 바깥 여백.
 * 떠 있는 자리(float)는 문단 상자 왼쪽 위 기준 px. 배치를 바꾸면 한글에서 읽은 자리 값(hw)·쪽 기준 자리(py)는 버리고 새로 정한다
 */
const PX_PER_MM = 96 / 25.4;
const OBJECT_TYPES = new Set(['image', 'shape', 'textBox']);
/** 한글 화면 배치에서 읽은 글상자 자리 (배치를 바꾸면 지운다: 쪽 나누기가 옛 자리에 붙들지 않게) */
const HWP_BOX_ATTRS = ['hwpTop', 'hwpSeq', 'hwpLen', 'hwpPage', 'hwpCol'];

export function selectedObject(): { node: PMNode; pos: number } | null {
  const sel = app.active?.editor.state.selection;
  if (sel instanceof NodeSelection && OBJECT_TYPES.has(sel.node.type.name)) return { node: sel.node, pos: sel.from };
  return null;
}

/** 개체가 든 문단(또는 칸)의 글 폭 (px) — 오른쪽에 놓을 때 x 를 정한다 */
function paraWidth(pos: number): number {
  const view = app.active!.editor.view;
  const dom = view.nodeDOM(pos) as HTMLElement | null;
  const p = (dom?.closest?.('p, li, td, th, .k-textbox') as HTMLElement | null) || (view.dom as HTMLElement);
  return p.clientWidth || 600;
}

const mm = (px: number) => Math.round((px / PX_PER_MM) * 10) / 10;
const px = (v: number) => v * PX_PER_MM;

export function ObjectDialog({ onClose }: { onClose: () => void }) {
  const obj = selectedObject();
  const a = obj?.node.attrs || {};
  const p0 = placementOf(a.float);
  const fl = floatOf(a.float);
  const [mode, setMode] = useState<Placement>(p0.mode);
  const [side, setSide] = useState<'left' | 'right'>(p0.side);
  const [x, setX] = useState(mm(fl?.x || 0));
  const [y, setY] = useState(mm(fl?.y || 0));
  const w0 = +a.width || 0;
  const h0 = +a.height || 0;
  const [w, setW] = useState(mm(w0));
  const [h, setH] = useState(mm(h0));
  const [keep, setKeep] = useState(true);
  const [margin, setMargin] = useState(mm(fl?.wrap ? fl.wrap.d[0] : px(1)));
  const [moved, setMoved] = useState(false);

  if (!obj) {
    return (
      <Modal title="개체 속성" onClose={onClose} width={340} footer={<button className="btn" onClick={onClose}>닫기</button>}>
        그림·도형·글상자를 먼저 선택하세요. (개체를 한 번 누르면 선택됩니다)
      </Modal>
    );
  }
  const isBox = obj.node.type.name === 'textBox';
  const ratio = w0 && h0 ? h0 / w0 : 0;
  const setWidth = (v: number) => {
    setW(v);
    if (keep && ratio) setH(Math.round(v * ratio * 10) / 10);
  };
  const setHeight = (v: number) => {
    setH(v);
    if (keep && ratio) setW(Math.round((v / ratio) * 10) / 10);
  };
  const pickMode = (m: Placement) => {
    setMode(m);
    // 글자처럼 놓여 있던 개체를 처음 띄우면: 왼쪽 위에, '어울림'에서 오른쪽을 고르면 오른쪽 끝에
    if (!fl && !moved && m === 'square' && side === 'right') setX(mm(Math.max(0, paraWidth(obj.pos) - px(w)))) ;
  };
  const pickSide = (s: 'left' | 'right') => {
    setSide(s);
    if (!moved) setX(s === 'right' ? mm(Math.max(0, paraWidth(obj.pos) - px(w))) : 0);
  };

  const ok = () => {
    const editor = app.active!.editor;
    const node = editor.state.doc.nodeAt(obj.pos);
    if (!node || node.type !== obj.node.type) return onClose();
    const attrs: Record<string, unknown> = { ...node.attrs, float: makeFloat(mode, side, px(x), px(y), px(margin)) };
    if (w > 0) attrs.width = Math.round(px(w));
    if (h > 0) attrs.height = Math.round(px(h));
    if (isBox) for (const k of HWP_BOX_ATTRS) if (k in attrs) attrs[k] = null;
    const tr = editor.state.tr.setNodeMarkup(obj.pos, undefined, attrs);
    tr.setSelection(NodeSelection.create(tr.doc, obj.pos));
    editor.view.dispatch(tr);
    editor.storage.pagination?.schedule?.();
    onClose();
  };

  const floating = mode !== 'inline';
  return (
    <Modal title="개체 속성" onClose={onClose} width={460} footer={<OkCancel onOk={ok} onCancel={onClose} />}>
      <Fieldset legend="본문과의 배치">
        <Seg<Placement>
          value={mode}
          onChange={pickMode}
          options={[
            { value: 'inline', label: '글자처럼', title: '글자처럼 취급: 글줄 안에 글자 하나처럼 놓는다' },
            { value: 'square', label: '어울림', title: '개체 옆으로 글이 흐른다' },
            { value: 'tb', label: '자리 차지', title: '개체가 차지한 높이만큼 글이 비켜 아래로 간다' },
            { value: 'front', label: '글 앞으로', title: '글 위에 겹쳐 놓는다' },
            { value: 'behind', label: '글 뒤로', title: '글 밑에 깔아 놓는다' },
          ]}
        />
        {mode === 'behind' && <p className="unit" style={{ marginTop: 6 }}>글 뒤로 보낸 개체는 글에 가려지므로 Alt 를 누른 채 눌러서 고릅니다.</p>}
        {mode === 'square' && (
          <div className="row" style={{ gap: 8, marginTop: 8, alignItems: 'center' }}>
            <span>개체 자리</span>
            <Seg<'left' | 'right'>
              value={side}
              onChange={pickSide}
              options={[
                { value: 'left', label: '왼쪽 (글은 오른쪽)' },
                { value: 'right', label: '오른쪽 (글은 왼쪽)' },
              ]}
            />
          </div>
        )}
      </Fieldset>
      <Fieldset legend="위치 (문단 왼쪽 위 기준)">
        <div className="row" style={{ gap: 14, alignItems: 'center', opacity: floating ? 1 : 0.5 }}>
          <span>가로</span>
          <NumberInput value={x} step={1} min={-500} max={500} unit="mm" disabled={!floating} onChange={(v) => (setX(v), setMoved(true))} />
          <span>세로</span>
          <NumberInput value={y} step={1} min={-500} max={500} unit="mm" disabled={!floating} onChange={(v) => (setY(v), setMoved(true))} />
        </div>
      </Fieldset>
      <Fieldset legend="크기">
        <div className="row wrap" style={{ gap: 14, alignItems: 'center' }}>
          <span>너비</span>
          <NumberInput value={w} step={1} min={1} max={1000} unit="mm" onChange={setWidth} />
          <span>높이</span>
          <NumberInput value={h} step={1} min={1} max={1000} unit="mm" onChange={setHeight} />
          {ratio > 0 && (
            <label className="check">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> 비율 유지
            </label>
          )}
        </div>
      </Fieldset>
      {(mode === 'square' || mode === 'tb') && (
        <Fieldset legend="바깥 여백 (글과의 간격)">
          <NumberInput value={margin} step={0.5} min={0} max={50} unit="mm" onChange={setMargin} />
        </Fieldset>
      )}
    </Modal>
  );
}
