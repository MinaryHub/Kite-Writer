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

const INLINE_LEAVES = new Set(['image', 'hardBreak', 'footnote', 'math']);
const LEAF_BLOCKS = new Set(['pageBreak', 'horizontalRule']);
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

export interface FloatAt {
  x: number;
  y: number;
  behind?: boolean;
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
    private o: { inSub: boolean; width?: number; geom: () => PageGeomPx; hwpPage: boolean; pageBreak: boolean; pp: ParaBox; state: LayoutState },
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
    const vRel = inSub ? 'PARA' : p.vRel;
    let y: number;
    if (vRel === 'PARA') y = p.wrap === 'TOP_AND_BOTTOM' && this.pushed(p.h, p.omB, p.vOff) ? sb - p.omB - p.h : sb + p.vOff;
    else {
      if (v0 == null) return null;
      const refH = vRel === 'PAPER' ? g.H : g.bodyH;
      const top = vRel === 'PAPER' ? -g.mt : 0;
      const Y = top + (p.vAl === 'CENTER' ? (refH - p.h) / 2 + p.vOff : p.vAl === 'BOTTOM' ? refH - p.h - p.vOff : p.vOff);
      y = Y - (v0 - sb);
    }
    const colW = inSub ? this.o.width ?? 0 : g.bodyW;
    let base = 0;
    let refW = colW;
    if (p.hRel === 'PARA') {
      base = pp.indentLeft * PT2PX;
      refW = colW - (pp.indentLeft + pp.indentRight) * PT2PX;
    } else if (p.hRel === 'PAPER' && !inSub) {
      base = -g.ml;
      refW = g.W;
    }
    const x = base + (!(refW > 0) ? p.hOff : p.hAl === 'CENTER' ? (refW - p.w) / 2 + p.hOff : p.hAl === 'RIGHT' ? refW - p.w - p.hOff : p.hOff);
    return { x: r2(x), y: r2(y), ...(p.wrap === 'BEHIND_TEXT' ? { behind: true } : {}) };
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
    let paras = blocks.filter((b) => b.type !== 'pageBreak');
    // 글자처럼 취급하는 표·글상자 하나와 빈칸뿐인 글: 한글에서는 한 줄(개체 높이)이다
    if (segV.length === 1 && paras.length > 1) {
      const objs = paras.filter((b) => b.type !== 'paragraph');
      const blank = (b: JNode) => b.type === 'paragraph' && (b.content || []).every((n) => n.type === 'text' && !(n.text || '').trim());
      if (objs.length === 1 && paras.every((b) => b === objs[0] || blank(b))) {
        indentByBlanks(objs[0], paras.slice(0, paras.indexOf(objs[0])));
        paras = objs;
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
    const breaks = blocks.filter((b) => b.type === 'pageBreak');
    if (inSub) return { blocks: [...this.before, ...paras, ...this.after], lead: null };
    const v0 = segV.length ? segV[0][0] : null;
    let lead: JNode | null = null;
    if (one && v0 != null) {
      const sb = one.type === 'paragraph' ? pp.spaceBefore * PT2PX : 0;
      const omT = one.type === 'table' ? +(one.attrs?.outMargin?.[2] || 0) : 0;
      one.attrs = { ...one.attrs, hwpTop: r2(v0 - sb + omT) };
      for (const b of this.before) if (b.attrs?.float) b.attrs = { ...b.attrs, hwpTop: r2(v0 - sb) };
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
      if (b.type === 'pageBreak') continue;
      b.attrs = { ...b.attrs, hwpSeq: ++state.seq };
      if (b.attrs.hwpLen == null) b.attrs.hwpLen = jsonContentSize(b);
    }
    return { blocks: group, lead: lead || group.find((b) => b.type !== 'pageBreak') || null };
  }
}

/**
 * 칸·글상자 안 문단들: 한글이 놓은 문단 사이가 줄 높이·문단 간격으로 셈한 것보다 벌어져 있으면 그만큼 위를 띄운다 (hwpGap).
 * groups: 한글 문단 하나에서 나온 블록들의 목록
 */
export function gapInBox(groups: JNode[][]) {
  let prevEnd: number | null = 0;
  for (const blocks of groups) {
    const paras = blocks.filter((b) => b.type !== 'pageBreak' && !b.attrs?.float);
    const one = paras.length === 1 && paras[0].type === 'paragraph' ? paras[0] : null;
    const vs = one?.attrs?.hwpVs as number[][] | undefined;
    if (one && vs && vs.length) {
      const sb = (+one.attrs!.spaceBefore || 0) * PT2PX;
      const gap = prevEnd == null ? 0 : vs[0][0] - sb - prevEnd;
      if (gap > 0.5 && gap < 4000) one.attrs!.hwpGap = r2(gap);
      const last = vs[vs.length - 1];
      prevEnd = last[0] + last[1] + last[2] + (+one.attrs!.spaceAfter || 0) * PT2PX;
    } else prevEnd = null;
  }
}

/**
 * 칸의 마지막 문단: 적힌 칸 높이가 글(마지막 줄의 글자 높이까지)보다 작으면 한글은 칸 높이를 내용으로 새로 셈하고
 * 마지막 줄 간격·문단 아래 간격까지 넣는다 (hwpTrail). 돌려주는 값은 그때 내용이 요구하는 높이(px), 아니면 0
 */
export function markCellTrail(content: JNode[], cellHeightPx: number, vMarginPx: number): number {
  const lastP = content[content.length - 1];
  const vs = lastP && lastP.type === 'paragraph' ? (lastP.attrs?.hwpVs as number[][] | undefined) : undefined;
  if (!vs || !vs.length) return 0;
  const l = vs[vs.length - 1];
  const textOnly = l[0] + l[1] + vMarginPx;
  if (cellHeightPx >= textOnly - 1) return 0;
  lastP.attrs = { ...lastP.attrs, hwpTrail: true };
  return textOnly + l[2] + (+lastP.attrs.spaceAfter || 0) * PT2PX;
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
