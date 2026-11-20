import { floatOf } from './extensions/nodes';

/** 개체의 본문과의 배치: 글자처럼 취급·어울림·자리 차지·글 앞으로·글 뒤로 */
export type Placement = 'inline' | 'square' | 'tb' | 'front' | 'behind';

export function placementOf(float: unknown): { mode: Placement; side: 'left' | 'right' } {
  const fl = floatOf(float);
  if (!fl) return { mode: 'inline', side: 'left' };
  if (fl.behind) return { mode: 'behind', side: 'left' };
  if (!fl.wrap) return { mode: 'front', side: 'left' };
  if (fl.wrap.s === 'tb') return { mode: 'tb', side: 'left' };
  // wrap.s: 글이 흐르는 쪽 — r 이면 개체는 왼쪽
  return { mode: 'square', side: fl.wrap.s === 'l' ? 'right' : 'left' };
}

/** 배치·위치·여백(px) → float 값 (글자처럼 취급이면 null) */
export function makeFloat(mode: Placement, side: 'left' | 'right', x: number, y: number, margin: number): Record<string, unknown> | null {
  if (mode === 'inline') return null;
  const base = { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  const d = [margin, margin, margin, margin];
  if (mode === 'behind') return { ...base, behind: true };
  if (mode === 'front') return base;
  if (mode === 'tb') return { ...base, wrap: { s: 'tb', d } };
  return { ...base, wrap: { s: side === 'left' ? 'r' : 'l', d } };
}
