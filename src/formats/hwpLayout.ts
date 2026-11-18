import type { JNode } from './common';

/**
 * 한글이 문서에 적어 둔 배치(줄마다의 세로 자리, 개체의 자리)를 문서 노드의 화면 전용 속성으로 옮기는 셈법.
 * HWP(바이너리) 리더가 쓴다. HWPX 리더에도 같은 셈법이 들어 있다 (hwpx/reader.ts 의 convertP).
 *
 * - hwpVs   : 줄마다 [줄 위쪽, 줄 높이, 줄 아래 간격, 기준선] (px) → hwpMetrics 가 줄 상자를 그 값으로 만든다
 * - hwpTop  : 본문 블록의 쪽 안 세로 위치(px) → 쪽 나누기가 그 자리에 맞춘다
 * - hwpSeq  : 본문 블록의 차례, hwpLen: 그때의 내용 크기 → 고친 블록이 있는 쪽은 자연 배치로 흐른다
 * - float   : 떠 있는 개체(글자처럼 취급하지 않는 그림·글상자)의 자리
 */

const PT2PX = 96 / 72;
const r2 = (v: number) => Math.round(v * 100) / 100;

const INLINE_LEAVES = new Set(['image', 'hardBreak', 'footnote', 'math', 'shape']);
const LEAF_BLOCKS = new Set(['pageBreak', 'columnBreak', 'horizontalRule']);
/** 쪽 나누기·단 나누기 (줄 정보를 갖지 않는 블록) */
export const isBreakBlock = (b: JNode) => b.type === 'pageBreak' || b.type === 'columnBreak';
function jsonSize(n: JNode): number {
  if (n.type === 'text') return (n.text || '').length;
  if (INLINE_LEAVES.has(n.type) || LEAF_BLOCKS.has(n.type)) return 1;
  return 2 + (n.content || []).reduce((a, c) => a + jsonSize(c), 0);
}
/** 내용 크기 (ProseMirror 의 node.content.size) */
export function jsonContentSize(n: JNode): number {
  return (n.content || []).reduce((a, c) => a + jsonSize(c), 0);
}

/**
 * 글자처럼 취급하는 표 앞의 빈칸: 한글에서는 표와 같은 줄에 있어 표를 그만큼 오른쪽으로 민다 (빈칸 폭 = 글자 크기의 절반).
 * 빈칸뿐인 문단들(blanks: 표보다 앞에 있는 것)의 폭(pt)을 표의 왼쪽 들여쓰기에 더한다. 가운데·오른쪽 정렬 표는 그대로 둔다
 */
export function indentByBlanks(table: JNode, blanks: JNode[]) {
  if (table.type !== 'table' || table.attrs?.align) return;
  let pt = 0;
  for (const b of blanks)
    for (const n of b.content || []) {
      if (n.type !== 'text') continue;
      const size = +(n.marks?.find((m) => m.type === 'textStyle')?.attrs?.fontSize || 10);
      pt += (n.text || '').length * (size / 2);
    }
  if (pt > 0.2 && pt < 200) table.attrs = { ...table.attrs, indent: r2((+table.attrs?.indent || 0) + pt) };
}

/** 빈칸 글의 폭(px): 한글의 빈칸은 글자 크기의 절반 (장평을 곱하고 자간 — 글자 크기에 대한 % — 을 더한다) */
function blankWidthPx(n: JNode): number {
  const ts = n.marks?.find((m) => m.type === 'textStyle')?.attrs || {};
  const size = +ts.fontSize > 0 ? +ts.fontSize : 10;
  const fw = +ts.fontWidth > 0 ? +ts.fontWidth / 100 : 1;
  const ls = Number.isFinite(+ts.letterSpacing) ? +ts.letterSpacing / 100 : 0;
  return (n.text || '').length * Math.max(0, size * (0.5 * fw + ls)) * PT2PX;
}

/**
 * 한 줄 문단에 글자처럼 취급하는 표 하나와 그 뒤의 글·그림이 함께 있는 것: 한글은 한 줄에 왼쪽부터 차례로 나란히 놓는다
 * (표 + 빈칸 + 그래프 그림, 표 + 글 등). 표는 블록이라 글·그림과 한 줄에 둘 수 없으므로, 표 뒤의 내용을 한 줄짜리 문단에 담아
 * 표 옆 제자리에 띄운다. paras: 표로 쪼개진 문단의 블록들 (표 앞은 빈칸만, 표는 하나).
 * line: 한글이 놓은 줄의 가로 자리 (x 는 본문·칸 왼쪽에서, px), align: 문단 정렬, seg: 그 줄의 [위쪽, 높이, 아래 간격, 기준선] (px).
 * 표는 정렬 대신 줄 안 자리만큼 들여 쓰고, 표 뒤 내용은 높이 없는 자리 표시(anchor)의 문단으로 — 그 문단의 줄 상자를 한글의
 * 줄(높이·기준선)과 같게 하므로 글은 기준선에, 그림은 글자처럼 놓인다. 자리 표시의 위쪽이 줄 위쪽이다
 * (본문에서는 부르는 쪽이 자리 표시를 그 줄의 쪽 안 위치(hwpTop)에 둔다).
 * 줄에서 가장 큰 개체가 표가 아니거나, 가운데·오른쪽 정렬인데 폭을 모르는 글이 있으면 null
 */
export function sideBySide(paras: JNode[], line: { x: number; w: number }, align: string | null | undefined, seg: number[]): { table: JNode; anchor: JNode } | null {
  const objs = paras.filter((b) => b.type !== 'paragraph');
  const table = objs.length === 1 && objs[0].type === 'table' && objs[0].attrs?.inline === true ? objs[0] : null;
  if (!table || !(seg[1] > 0)) return null;
  const om: number[] = Array.isArray(table.attrs?.outMargin) && table.attrs!.outMargin.length === 4 ? table.attrs!.outMargin.map((v: any) => +v || 0) : [0, 0, 0, 0];
  // 표 폭: 첫 줄 칸들의 폭 합
  let tw = 0;
  for (const c of table.content?.[0]?.content || []) {
    const cw = c.attrs?.colwidth;
    if (!Array.isArray(cw) || !cw.length) return null;
    for (const w of cw) tw += +w || 0;
  }
  const tH = (+table.attrs?.hwpH || 0) + om[2] + om[3];
  if (!(tw > 0) || !(tH > 0)) return null;
  const ti = paras.indexOf(table);
  // 표 앞: 빈칸만 (표를 그만큼 민다)
  let lead = 0;
  for (const b of paras.slice(0, ti))
    for (const n of b.content || []) {
      if (n.type === 'text' && !(n.text || '').trim()) lead += blankWidthPx(n);
      else return null;
    }
  // 표 뒤: 빈칸·글·그림
  const rest: JNode[] = [];
  let restW = 0;
  let text = false;
  let shown = false;
  let size: number | null = null;
  for (const b of paras.slice(ti + 1)) {
    if (size == null && +b.attrs?.fontSize > 0) size = +b.attrs!.fontSize;
    for (const n of b.content || []) {
      if (n.type === 'text') {
        if ((n.text || '').trim()) text = shown = true;
        else restW += blankWidthPx(n);
      } else if (n.type === 'image' && !n.attrs?.float && +n.attrs?.width > 0 && +n.attrs?.height > 0) {
        if (+n.attrs!.height > tH + 1) return null;
        restW += +n.attrs!.width;
        shown = true;
      } else return null;
      rest.push(n);
    }
  }
  if (!shown || (text && (align === 'right' || align === 'center'))) return null;
  // 정렬: 줄 폭에서 남는 만큼 (가운데·오른쪽). 양쪽·배분 정렬은 왼쪽부터
  const tOuter = om[0] + tw + om[1];
  const free = Math.max(0, line.w - (lead + tOuter + restW));
  const x0 = line.x + (align === 'right' ? free : align === 'center' ? free / 2 : 0);
  const { align: _drop, ...ta } = table.attrs || {};
  table.attrs = { ...ta, indent: r2(((x0 + lead) * 72) / 96) };
  const rx = x0 + lead + tOuter;
  const H = Math.max(seg[1], tH);
  const base = seg[3] >= seg[1] * 0.6 ? seg[3] : seg[1] * 0.85;
  const p: JNode = { type: 'paragraph', attrs: size ? { fontSize: size } : {}, content: rest };
  p.attrs = { ...p.attrs, hwpLen: jsonContentSize(p), hwpLines: [[0, r2(Math.max(10, line.x + line.w - rx))]], hwpVs: [[0, r2(H), 0, r2(base + (H - seg[1]))]] };
  const anchor: JNode = { type: 'textBox', attrs: { width: null, height: null, padding: [0, 0, 0, 0], float: { x: r2(rx), y: 0 } }, content: [p] };
  return { table, anchor };
}

/** 개체의 자리 정보 (px) */
export interface ObjPos {
  /** 글자처럼 취급 */
  inline: boolean;
  wrap: 'SQUARE' | 'TOP_AND_BOTTOM' | 'BEHIND_TEXT' | 'IN_FRONT_OF_TEXT';
  vRel: 'PAPER' | 'PAGE' | 'PARA';
  hRel: 'PAPER' | 'PAGE' | 'COLUMN' | 'PARA';
  vAl: 'TOP' | 'CENTER' | 'BOTTOM';
  hAl: 'LEFT' | 'CENTER' | 'RIGHT';
  vOff: number;
  hOff: number;
  w: number;
  h: number;
  omT: number;
  omB: number;
  /** 왼쪽·오른쪽 바깥 여백 (없으면 0) */
  omL?: number;
  omR?: number;
}

/** 용지 크기와 본문 자리 (px) */
export interface PageGeomPx {
  W: number;
  H: number;
  ml: number;
  mt: number;
  bodyW: number;
  bodyH: number;
}

/** 문단 모양 가운데 배치에 쓰는 값 (pt) */
export interface ParaBox {
  spaceBefore: number;
  /** 문단 아래 간격 (pt). 없으면 0 */
  spaceAfter?: number;
  indentLeft: number;
  indentRight: number;
  textIndent: number;
}

/** 리더가 문단들을 읽는 동안 이어 가는 값 */
export interface LayoutState {
  /** 앞 본문 문단의 마지막 줄이 끝난 자리 (px) */
  prevEndV: number;
  /** 본문 블록의 차례 */
  seq: number;
}

/** 한글 문서에 적힌 개체 자리 (저장할 때 그대로 되돌려 쓴다): 본문과의 배치, 세로·가로 기준과 맞춤, 오프셋·바깥 여백(HWPUNIT) */
export interface FloatHw {
  wrap: string;
  vr: string;
  hr: string;
  va: string;
  ha: string;
  vo: number;
  ho: number;
  /** 바깥 여백 [왼, 오른, 위, 아래] */
  om?: number[];
}

export interface FloatAt {
  x: number;
  y: number;
  behind?: boolean;
  hw?: FloatHw;
  /** 쪽·종이 기준으로 놓인 개체: 쪽 본문 맨 위에서의 세로 자리(px). 쪽 나누기가 끝난 뒤 그 자리에 놓는다 */
  py?: number;
}

/** 문단 하나의 배치 셈 */
export class ParaLayout {
  /** 떠 있는 개체: 문단 앞에 놓는 블록(글상자·글을 밀어낸 표)과 문단 뒤에 놓는 표 */
  readonly before: JNode[] = [];
  readonly after: JNode[] = [];
  private leadTables: { node: JNode; h: number; omB: number; omT: number }[] = [];
  private tableTops = new Map<JNode, number>();
  private prevEnd: number;

  constructor(
    /** 줄마다 [줄 위쪽, 줄 높이, 줄 아래 간격, 기준선] (px) */
    readonly segV: number[][],
    private o: {
      inSub: boolean;
      width?: number;
      geom: () => PageGeomPx;
      hwpPage: boolean;
      pageBreak: boolean;
      pp: ParaBox;
      state: LayoutState;
      origin?: { x: number; y: number };
      /** 첫 줄의 가로 자리 (본문·칸 왼쪽에서, px)와 문단 정렬: 한 줄에 나란히 놓인 표와 글·그림을 그 자리에 놓는 데 쓴다 */
      line0?: { x: number; w: number };
      align?: string | null;
    },
  ) {
    this.prevEnd = o.hwpPage || o.pageBreak ? 0 : o.state.prevEndV;
    if (!o.inSub && segV.length) {
      const l = segV[segV.length - 1];
      o.state.prevEndV = l[0] + l[1] + l[2];
    }
  }

  /**
   * 자리를 차지하는 개체가 이 문단의 첫 줄을 아래로 밀어냈는가. 한글 판에 따라 빈 문단의 줄을 개체 아래로 밀기도 하고
   * 제자리에 둔 채 개체가 덮기도 하므로, 첫 줄이 앞 문단 끝에서 개체 높이만큼 떨어져 있는지로 가린다
   */
  pushed(h: number, omB: number, vOff: number): boolean {
    const segV = this.segV;
    if (!segV.length || vOff >= Math.max(4, segV[0][1])) return false;
    const v0 = segV[0][0];
    if (this.o.inSub) return v0 >= h + omB - 1;
    if (this.o.hwpPage) return v0 > 4;
    return h > 4 && v0 - this.prevEnd >= 0.9 * h - 1;
  }

  /** 떠 있는 개체의 자리: x 는 본문(칸) 왼쪽, y 는 문단 상자 위쪽 기준 px. 흐름 안에 둘 개체면 null */
  floatPos(p: ObjPos): FloatAt | null {
    if (p.inline || !(p.w > 0) || !(p.h > 0)) return null;
    const { inSub, pp } = this.o;
    // 칸·글상자 안에서 자리를 차지하는 개체는 칸의 내용 높이에 든다: 흐름 안에 둔다
    if (inSub && p.wrap === 'TOP_AND_BOTTOM') return null;
    const sb = pp.spaceBefore * PT2PX;
    const v0 = this.segV.length ? this.segV[0][0] : null;
    const g = this.o.geom();
    // 칸·글상자 안의 개체는 문단 기준으로만 놓인다. 머리말·꼬리말·바탕쪽(origin)은 종이에서의 자리를 알므로 종이·쪽 기준도 된다
    const origin = this.o.origin;
    const vRel = inSub && !origin ? 'PARA' : p.vRel;
    let y: number;
    let py: number | null = null;
    if (vRel === 'PARA') y = p.wrap === 'TOP_AND_BOTTOM' && this.pushed(p.h, p.omB, p.vOff) ? sb - p.omB - p.h : sb + p.vOff + p.omT;
    else {
      const refH = vRel === 'PAPER' ? g.H : g.bodyH;
      const top = vRel === 'PAPER' ? -g.mt : 0;
      // 바깥 여백: 개체는 여백 상자 안쪽에 놓인다
      const Y = top + (p.vAl === 'CENTER' ? (refH - p.h) / 2 + p.vOff : p.vAl === 'BOTTOM' ? refH - p.h - p.vOff - p.omB : p.vOff + p.omT);
      if (origin) y = Y + g.mt - origin.y - ((v0 ?? sb) - sb);
      else {
        // 본문: 문단 첫 줄의 쪽 안 위치를 알면 그것으로 어림하고, 쪽 나누기가 끝나면 쪽 기준 자리(py)에 놓는다
        y = v0 != null ? Y - (v0 - sb) : 0;
        py = Y;
      }
    }
    const colW = inSub ? this.o.width ?? 0 : g.bodyW;
    let base = 0;
    let refW = colW;
    if (p.hRel === 'PARA') {
      base = pp.indentLeft * PT2PX;
      refW = colW - (pp.indentLeft + pp.indentRight) * PT2PX;
    } else if (p.hRel === 'PAPER' && (!inSub || origin)) {
      base = -(origin ? origin.x : g.ml);
      refW = g.W;
    } else if (p.hRel === 'PAGE' && origin) {
      base = g.ml - origin.x;
      refW = g.bodyW;
    }
    const omL = p.omL || 0;
    const x = base + (!(refW > 0) ? p.hOff + omL : p.hAl === 'CENTER' ? (refW - p.w) / 2 + p.hOff : p.hAl === 'RIGHT' ? refW - p.w - p.hOff - (p.omR || 0) : p.hOff + omL);
    const hw: FloatHw = { wrap: p.wrap, vr: p.vRel, hr: p.hRel, va: p.vAl, ha: p.hAl, vo: Math.round(p.vOff * 75), ho: Math.round(p.hOff * 75), om: [p.omL || 0, p.omR || 0, p.omT, p.omB].map((v) => Math.round(v * 75)) };
    return { x: r2(x), y: r2(y), ...(p.wrap === 'BEHIND_TEXT' ? { behind: true } : {}), ...(py != null ? { py: r2(py) } : {}), hw };
  }

  /** 문단 상자의 왼쪽 (CSS margin-left, px): 문단 안에 띄우는 그림의 x 는 이만큼 뺀다 */
  paraLeft(): number {
    return (this.o.pp.indentLeft + Math.max(0, -this.o.pp.textIndent)) * PT2PX;
  }

  /**
   * 떠 있는 표(글자처럼 취급하지 않는 표)를 놓는다: 문단의 글을 쪼개지 않고, 글을 밀어낸 표는 글 앞에, 그 밖에는 뒤에.
   * 줄 정보가 없거나 글자처럼 취급하는 표면 false (부르는 쪽이 흐름 안에 놓는다)
   */
  placeTable(blocks: JNode[], table: JNode, p: ObjPos): boolean {
    if (!this.segV.length || p.inline) return false;
    if (this.pushed(p.h, p.omB, p.vOff)) {
      this.before.push(...blocks);
      this.leadTables.push({ node: table, h: p.h, omB: p.omB, omT: p.omT });
    } else {
      this.after.push(...blocks);
      const rel = this.o.inSub ? 'PARA' : p.vRel;
      if (p.vAl === 'TOP') this.tableTops.set(table, rel === 'PARA' ? this.segV[0][0] + p.vOff + p.omT : rel === 'PAPER' ? p.vOff + p.omT - this.o.geom().mt : p.vOff + p.omT);
    }
    return true;
  }

  /**
   * 마무리: blocks(흐름 안 블록, 쪽 나누기 포함)에 줄 자리·쪽 안 위치·차례를 달고 떠 있는 블록을 앞뒤에 놓는다.
   * lines: 줄 첫 자리 목록([문단 안 위치, 줄 폭]) — 모두 찾았을 때만. floating: 자리를 모르는 떠 있는 그림이 줄 안에 있다
   */
  finish(blocks: JNode[], lines: [number, number][] | null, floating: boolean): { blocks: JNode[]; lead: JNode | null } {
    const { segV } = this;
    const { inSub, pp, state } = this.o;
    let paras = blocks.filter((b) => !isBreakBlock(b));
    let sideAnchor: JNode | null = null;
    // 글자처럼 취급하는 표·글상자 하나와 빈칸뿐인 글: 한글에서는 한 줄(개체 높이)이다
    if (segV.length === 1 && paras.length > 1) {
      const objs = paras.filter((b) => b.type !== 'paragraph');
      const blank = (b: JNode) => b.type === 'paragraph' && (b.content || []).every((n) => n.type === 'text' && !(n.text || '').trim());
      if (objs.length === 1 && paras.every((b) => b === objs[0] || blank(b))) {
        indentByBlanks(objs[0], paras.slice(0, paras.indexOf(objs[0])));
        paras = objs;
      } else if (!floating && this.o.line0) {
        // 표와 글·그림이 한 줄에 나란히: 표 뒤의 내용을 표 옆 제자리에 띄운다
        const side = sideBySide(paras, this.o.line0, this.o.align, segV[0]);
        if (side) {
          this.before.push(side.anchor);
          sideAnchor = side.anchor;
          paras = [side.table];
        }
      }
    }
    const one = paras.length === 1 ? paras[0] : null;
    if (one && one.type === 'paragraph' && segV.length && !floating) {
      const a: Record<string, any> = { ...one.attrs, hwpLen: jsonContentSize(one) };
      if (lines) a.hwpLines = lines;
      else delete a.hwpLines;
      if (a.hwpLines || segV.length === 1) a.hwpVs = segV;
      one.attrs = a;
    }
    // 칸·글상자 안에서 글자처럼 취급하는 표 하나뿐인 문단: 표 아래에 그 줄의 아래 간격과 문단 아래 간격을 둔다 (HWPX 와 같게)
    if (inSub && one && one.type === 'table' && segV.length === 1) {
      const after = segV[0][2] + (pp.spaceAfter || 0) * PT2PX;
      one.attrs = { ...one.attrs, hwpVs: segV, ...(after > 0.3 && after < 400 ? { hwpAfter: r2(after) } : {}) };
    }
    const breaks = blocks.filter(isBreakBlock);
    if (inSub) return { blocks: [...this.before, ...paras, ...this.after], lead: null };
    const v0 = segV.length ? segV[0][0] : null;
    let lead: JNode | null = null;
    if (one && v0 != null) {
      const sb = one.type === 'paragraph' ? pp.spaceBefore * PT2PX : 0;
      const omT = one.type === 'table' ? +(one.attrs?.outMargin?.[2] || 0) : 0;
      one.attrs = { ...one.attrs, hwpTop: r2(v0 - sb + omT) };
      for (const b of this.before) if (b.attrs?.float) b.attrs = { ...b.attrs, hwpTop: r2(v0 - sb) };
      // 표 옆에 띄운 내용의 자리 표시는 줄 위쪽에 (그 안 문단의 줄 상자가 한글의 줄과 같다)
      if (sideAnchor) sideAnchor.attrs = { ...sideAnchor.attrs, hwpTop: r2(v0) };
      if (this.leadTables.length && one.type === 'paragraph' && !this.o.hwpPage) {
        // 밀린 첫 줄 바로 위에서부터 거꾸로 쌓아 올린다
        let y = v0 - sb;
        const tops: number[] = [];
        for (let k = this.leadTables.length - 1; k >= 0; k--) {
          y -= this.leadTables[k].omB + this.leadTables[k].h;
          tops[k] = y;
          y -= this.leadTables[k].omT;
        }
        if (y >= this.prevEnd - 2) this.leadTables.forEach((t, k) => (t.node.attrs = { ...t.node.attrs, hwpTop: r2(Math.max(0, tops[k])) }));
      }
      lead = [...this.before.filter((x) => x.attrs?.float), one].find((x) => x.attrs?.hwpTop != null) || one;
    }
    for (const [t, top] of this.tableTops) if (top > -1) t.attrs = { ...t.attrs, hwpTop: r2(Math.max(0, top)) };
    const group = [...breaks, ...this.before, ...paras, ...this.after];
    for (const b of group) {
      if (isBreakBlock(b)) continue;
      b.attrs = { ...b.attrs, hwpSeq: ++state.seq };
      if (b.attrs.hwpLen == null) b.attrs.hwpLen = jsonContentSize(b);
    }
    return { blocks: group, lead: lead || group.find((b) => !isBreakBlock(b)) || null };
  }
}

/**
 * 칸·글상자 안 문단들: 한글이 놓은 문단 사이가 줄 높이·문단 간격으로 셈한 것보다 벌어져 있으면 그만큼 위를 띄운다 (hwpGap).
 * groups: 한글 문단 하나에서 나온 블록들의 목록
 */
export function gapInBox(groups: JNode[][]) {
  let prevEnd: number | null = 0;
  for (const blocks of groups) {
    const paras = blocks.filter((b) => !isBreakBlock(b) && !b.attrs?.float);
    const one = paras.length === 1 && paras[0].type === 'paragraph' ? paras[0] : null;
    const vs = one?.attrs?.hwpVs as number[][] | undefined;
    // 글자처럼 취급하는 표 하나뿐인 문단: 표 아래 간격(hwpAfter)까지 그 줄이 끝난 자리
    const tvs = paras.length === 1 && paras[0].type === 'table' ? (paras[0].attrs?.hwpVs as number[][] | undefined) : undefined;
    if (one && vs && vs.length) {
      const sb = (+one.attrs!.spaceBefore || 0) * PT2PX;
      const gap = prevEnd == null ? 0 : vs[0][0] - sb - prevEnd;
      if (gap > 0.5 && gap < 4000) one.attrs!.hwpGap = r2(gap);
      const last = vs[vs.length - 1];
      prevEnd = last[0] + last[1] + last[2] + (+one.attrs!.spaceAfter || 0) * PT2PX;
    } else if (tvs && tvs.length === 1) prevEnd = tvs[0][0] + tvs[0][1] + (+paras[0].attrs!.hwpAfter || 0);
    else prevEnd = null;
  }
  // 칸·글상자의 마지막 줄 아래 간격은 칸 높이에 들지 않는다: 마지막 블록이 표면 그 아래 간격을 지운다
  for (let g = groups.length - 1; g >= 0; g--) {
    const last = [...groups[g]].reverse().find((b) => !isBreakBlock(b) && !b.attrs?.float);
    if (!last) continue;
    if (last.type === 'table' && last.attrs?.hwpAfter != null) {
      const { hwpAfter: _drop, ...rest } = last.attrs;
      last.attrs = rest;
    }
    break;
  }
}

/**
 * 칸 내용이 요구하는 높이(px): 적힌 칸 높이가 글(마지막 줄의 글자 높이까지 + 위아래 안 여백)보다 작으면 한글은 칸 높이를
 * 그 내용 높이로 늘린다. 마지막 줄 아래 간격과 문단 아래 간격은 넣지 않는다 — 한글이 적어 둔 표 높이(sz)와 견주어
 * 표 42개 모두 이 셈과 맞았다. 적힌 높이로 충분하면 0
 */
export function cellContentNeed(content: JNode[], cellHeightPx: number, vMarginPx: number): number {
  const lastP = content[content.length - 1];
  const vs = lastP && lastP.type === 'paragraph' ? (lastP.attrs?.hwpVs as number[][] | undefined) : undefined;
  if (!vs || !vs.length) return 0;
  // 빈 문단 하나뿐인 칸(색 띠로 쓰는 낮은 칸 등)은 줄 높이만큼만 차지한다
  if (content.length === 1 && !(lastP.content || []).length) return 0;
  const l = vs[vs.length - 1];
  const textOnly = l[0] + l[1] + vMarginPx;
  return cellHeightPx >= textOnly - 1 ? 0 : textOnly;
}

/**
 * 표 줄 높이 마무리 (rowH: 줄마다 '칸 높이 - 위아래 안 여백' px, 낱칸에서 읽은 것).
 * 합친 칸으로만 덮인 줄의 높이를 거꾸로 셈하고, 합친 칸의 내용이 덮은 줄들보다 크면 마지막 줄을 늘린다
 */
export function solveSpanRows(rowH: number[], spans: { row: number; rs: number; h: number; need: number }[], vMarginPx: number) {
  for (let pass = 0; pass < spans.length + 1; pass++) {
    let found = false;
    for (const sp of spans) {
      const unknown: number[] = [];
      let known = 0;
      for (let r = sp.row; r < sp.row + sp.rs; r++) {
        if (rowH[r] == null) unknown.push(r);
        else known += rowH[r] + vMarginPx;
      }
      if (unknown.length !== 1) continue;
      const h = sp.h - known;
      if (h > 0) {
        rowH[unknown[0]] = Math.max(0.1, h - vMarginPx);
        found = true;
      }
    }
    if (!found) break;
  }
  for (const sp of spans) {
    if (!(sp.need > 0)) continue;
    let sum = 0;
    let all = true;
    for (let r = sp.row; r < sp.row + sp.rs; r++) {
      if (rowH[r] == null) all = false;
      else sum += rowH[r] + vMarginPx;
    }
    if (all && sp.need > sum + 1) rowH[sp.row + sp.rs - 1] += sp.need - sum;
  }
}

/**
 * 한글이 줄 정보를 적지 않은 문단(HWP 의 일부 제목·글머리표 문단)의 줄 높이 어림: 같은 글꼴·글자 크기·줄 간격으로
 * 줄 정보가 있는 다른 문단의 값을 빌린다 (hwpPitch: [줄 높이(다음 줄까지), 기준선] px). 글꼴마다 한글이 쓰는 줄 높이가
 * 달라(맑은 고딕은 글자 크기의 1.7배) 글자 크기 × 줄 간격으로는 맞지 않는다
 */
export function estimateMissingLines(root: JNode) {
  const firstText = (n: JNode): JNode | null => {
    for (const c of n.content || []) {
      if (c.type === 'text') return c;
      const t = firstText(c);
      if (t) return t;
    }
    return null;
  };
  const keyOf = (n: JNode) => {
    const ts = firstText(n)?.marks?.find((m) => m.type === 'textStyle')?.attrs;
    return [ts?.fontFamily || '', n.attrs?.lineHeight || '', +(ts?.fontSize || n.attrs?.fontSize || 10)].join('|');
  };
  const stats = new Map<string, [number, number]>();
  const paras: JNode[] = [];
  const walk = (n: JNode) => {
    if (n.type === 'paragraph') paras.push(n);
    else (n.content || []).forEach(walk);
  };
  walk(root);
  for (const p of paras) {
    const vs = p.attrs?.hwpVs as number[][] | undefined;
    if (!vs || !vs.length || !firstText(p)) continue;
    const k = keyOf(p);
    if (stats.has(k)) continue;
    const v = vs[0];
    const pitch = vs[1] && vs[1][0] > v[0] + 0.5 ? vs[1][0] - v[0] : v[1] + v[2];
    if (pitch > 1) stats.set(k, [r2(pitch), r2(v[3] >= v[1] * 0.6 ? v[3] : v[1] * 0.85)]);
  }
  if (!stats.size) return;
  for (const p of paras) {
    if (p.attrs?.hwpVs || !firstText(p)) continue;
    const s = stats.get(keyOf(p));
    if (s) p.attrs = { ...p.attrs, hwpPitch: s };
  }
}

/**
 * 한글 배치 정보(줄 자리·쪽 안 위치·차례 등)를 모두 뺀 사본. 줄 정보가 형식만 갖춘 문서(Kite 등 다른 프로그램이 쓴 HWP:
 * 문단마다 세로 위치 0 인 줄 하나)는 그 값을 따르면 모든 문단이 쪽 맨 위에 겹치므로, 배치 정보 없이 자연 배치로 흐르게 한다
 */
export function dropHwpLayout(n: JNode): JNode {
  const out: JNode = { ...n };
  if (n.attrs) {
    const a: Record<string, any> = {};
    for (const k of Object.keys(n.attrs)) if (!/^hwp(Lines|Len|Top|Seq|Page|Col|Vs|Gap|Trail|Pitch)$/.test(k)) a[k] = n.attrs[k];
    out.attrs = a;
  }
  if (n.content) out.content = n.content.map(dropHwpLayout);
  return out;
}

/** 본문 문단들의 줄 정보가 형식뿐인가: 줄 정보가 있는 문단이 둘 이상인데 모두 '세로 위치 0 인 줄 하나'일 때 */
export class LineSegStats {
  private paras = 0;
  private zero = 0;
  /** 본문 문단 하나: 줄 수와 첫 줄의 세로 위치 */
  note(lines: number, vpos: number) {
    if (lines < 1) return;
    this.paras++;
    if (lines === 1 && vpos === 0) this.zero++;
  }
  get fake(): boolean {
    return this.paras >= 2 && this.zero === this.paras;
  }
}

/**
 * 글상자 안에서 떠 있는 개체가 글 아래로 나온 높이 (px). 한글은 글의 세로 맞춤(가운데·아래)을 떠 있는 개체까지 넣은
 * 내용 높이로 한다: 글 아래로 나온 만큼을 상자의 아래 안 여백에 더하면 같은 자리에 온다.
 * 줄 자리(hwpVs)를 모르는 문단이 있으면 셈하지 않는다 (0)
 */
export function floatOverhang(content: JNode[]): number {
  let textBottom = 0;
  let floatBottom = 0;
  /** 뒤따르는 문단을 기다리는 떠 있는 상자 (자리는 그 문단 상자의 위쪽 기준) */
  const waiting: JNode[] = [];
  const num = (v: any) => (Number.isFinite(+v) ? +v : 0);
  for (const b of content) {
    if (b.attrs?.float && b.type !== 'paragraph') {
      waiting.push(b);
      continue;
    }
    if (b.type !== 'paragraph') return 0;
    const vs = b.attrs?.hwpVs as number[][] | undefined;
    if (!Array.isArray(vs) || !vs.length) return 0;
    const top = vs[0][0] - num(b.attrs?.spaceBefore) * PT2PX;
    const last = vs[vs.length - 1];
    textBottom = Math.max(textBottom, last[0] + last[1]);
    for (const w of waiting.splice(0)) floatBottom = Math.max(floatBottom, top + num(w.attrs!.float.y) + num(w.attrs!.height));
    for (const n of b.content || []) if (n.attrs?.float) floatBottom = Math.max(floatBottom, top + num(n.attrs.float.y) + num(n.attrs.height));
  }
  const d = floatBottom - textBottom;
  return d > 0.5 && d < 5000 ? r2(d) : 0;
}
