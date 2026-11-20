/**
 * 한글의 그리기 개체(선·사각형·타원·다각형·곡선·호)를 벡터 그림(SVG)으로 옮긴다.
 * 문서에는 그림 노드로 들어가고(글자처럼 취급하면 줄 안에, 아니면 떠 있는 자리에), 화면·인쇄에서 선 굵기가 그대로다.
 */

export interface ShapeStyle {
  /** 선 색 (없으면 선 없음) */
  stroke: string | null;
  /** 선 굵기 (px) */
  sw: number;
  /** 선 종류 (HWPX 이름: SOLID, DASH, DOT, DASH_DOT, DASH_DOT_DOT, LONG_DASH, CIRCLE, DOUBLE_SLIM, SLIM_THICK, THICK_SLIM, SLIM_THICK_SLIM) */
  line: string;
  /** 채우는 색 (없으면 비움) */
  fill: string | null;
  /** 화살표 (시작·끝) */
  headStart?: boolean;
  headEnd?: boolean;
}

export type ShapeGeom =
  | { kind: 'line'; pts: [number, number][] }
  | { kind: 'polyline'; pts: [number, number][]; closed: boolean; smooth?: boolean }
  | { kind: 'rect'; rx: number }
  | { kind: 'ellipse' }
  | { kind: 'arc'; cx: number; cy: number; rx: number; ry: number; a0: number; a1: number; pie?: boolean; chord?: boolean };

const n = (v: number) => String(Math.round(v * 100) / 100);
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;

/** 선 종류 → 점선 무늬 (선 굵기에 비례: 한글 PDF 로 잰 표 테두리의 무늬와 같다 — 마디 4/3배, 틈 2배) */
function dashOf(line: string, sw: number): string {
  const w = Math.max(0.5, sw);
  switch (line) {
    case 'DASH':
      return `${n((w * 4) / 3)} ${n(w * 2)}`;
    case 'DOT':
      return `${n(w)} ${n(w)}`;
    case 'DASH_DOT':
      return `${n(w * 4)} ${n(w * 2)} ${n(w)} ${n(w * 2)}`;
    case 'DASH_DOT_DOT':
      return `${n(w * 4)} ${n(w * 2)} ${n(w)} ${n(w * 2)} ${n(w)} ${n(w * 2)}`;
    case 'LONG_DASH':
      return `${n(w * 6)} ${n(w * 2)}`;
    case 'CIRCLE':
      return `0 ${n(w * 2)}`;
    default:
      return '';
  }
}

/** 겹선(이중선 등): [가운데에서의 치우침(굵기 대비), 굵기(굵기 대비)] 목록. 치우침은 진행 방향의 왼쪽이 음수 */
function strands(line: string): [number, number][] | null {
  switch (line) {
    case 'DOUBLE_SLIM':
      return [
        [-0.35, 0.3],
        [0.35, 0.3],
      ];
    case 'SLIM_THICK':
      return [
        [-0.4, 0.2],
        [0.25, 0.5],
      ];
    case 'THICK_SLIM':
      return [
        [-0.25, 0.5],
        [0.4, 0.2],
      ];
    case 'SLIM_THICK_SLIM':
      return [
        [-0.42, 0.16],
        [0, 0.36],
        [0.42, 0.16],
      ];
    default:
      return null;
  }
}

/**
 * w×h(px) 상자의 도형 → 그림. 선이 상자 밖으로 반 굵기만큼 나가므로 그림은 pad 만큼 넉넉하게 만들고,
 * 그림 노드가 그만큼 음수 여백을 줘 자리는 w×h 로 둔다. 그릴 것이 없으면 null
 */
export function shapeToImage(w: number, h: number, g: ShapeGeom, st: ShapeStyle): { src: string; width: number; height: number; pad: number } | null {
  if (!(w >= 0) || !(h >= 0) || w > 20000 || h > 20000) return null;
  const stroke = st.stroke && COLOR_RE.test(st.stroke) ? st.stroke : null;
  const fill = st.fill && COLOR_RE.test(st.fill) ? st.fill : null;
  if (!stroke && !fill) return null;
  const sw = stroke ? Math.max(0.45, Math.min(60, st.sw || 0)) : 0;
  const head = st.headStart || st.headEnd ? Math.max(6, sw * 4) : 0;
  const pad = Math.ceil(sw / 2 + head / 2 + 1);
  const W = Math.max(1, w) + pad * 2;
  const H = Math.max(0, h) + pad * 2;
  const dash = stroke ? dashOf(st.line, sw) : '';
  const cap = st.line === 'CIRCLE' ? ` stroke-linecap='round'` : '';
  const sAttr = (width: number) => (stroke ? `stroke='${stroke}' stroke-width='${n(width)}'${dash ? ` stroke-dasharray='${dash}'` : ''}${cap}` : `stroke='none'`);
  const fAttr = `fill='${fill || 'none'}'`;
  let body = '';
  const multi = stroke ? strands(st.line) : null;
  if (g.kind === 'line') {
    const [a, b] = g.pts;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    // 진행 방향의 왼쪽(화면에서는 위쪽: 왼쪽 → 오른쪽 선일 때)
    const nx = dy / len;
    const ny = -dx / len;
    const seg = (off: number, width: number) => `<line x1='${n(a[0] - nx * off)}' y1='${n(a[1] - ny * off)}' x2='${n(b[0] - nx * off)}' y2='${n(b[1] - ny * off)}' ${sAttr(width)}/>`;
    if (multi) for (const [off, wd] of multi) body += seg(-off * sw, Math.max(0.3, wd * sw));
    else body += seg(0, sw);
    if (stroke && head) {
      const tri = (tip: [number, number], ux: number, uy: number) => {
        const bx = tip[0] - ux * head;
        const by = tip[1] - uy * head;
        return `<polygon points='${n(tip[0])},${n(tip[1])} ${n(bx + uy * head * 0.35)},${n(by - ux * head * 0.35)} ${n(bx - uy * head * 0.35)},${n(by + ux * head * 0.35)}' fill='${stroke}'/>`;
      };
      if (st.headEnd) body += tri(b, dx / len, dy / len);
      if (st.headStart) body += tri(a, -dx / len, -dy / len);
    }
  } else if (g.kind === 'polyline') {
    if (g.pts.length < 2) return null;
    let d = '';
    if (g.smooth && g.pts.length > 2) {
      // 점들을 지나는 매끄러운 곡선 (Catmull-Rom → 3차 베지어)
      const p = g.pts;
      d = `M${n(p[0][0])} ${n(p[0][1])}`;
      for (let i = 0; i < p.length - 1; i++) {
        const p0 = p[Math.max(0, i - 1)];
        const p1 = p[i];
        const p2 = p[i + 1];
        const p3 = p[Math.min(p.length - 1, i + 2)];
        d += ` C${n(p1[0] + (p2[0] - p0[0]) / 6)} ${n(p1[1] + (p2[1] - p0[1]) / 6)} ${n(p2[0] - (p3[0] - p1[0]) / 6)} ${n(p2[1] - (p3[1] - p1[1]) / 6)} ${n(p2[0])} ${n(p2[1])}`;
      }
    } else d = g.pts.map((p, i) => `${i ? 'L' : 'M'}${n(p[0])} ${n(p[1])}`).join(' ');
    if (g.closed) d += ' Z';
    body += `<path d='${d}' ${g.closed ? fAttr : `fill='none'`} ${sAttr(sw)} stroke-linejoin='round'/>`;
  } else if (g.kind === 'rect') {
    body += `<rect x='0' y='0' width='${n(w)}' height='${n(h)}'${g.rx > 0 ? ` rx='${n(g.rx)}'` : ''} ${fAttr} ${sAttr(sw)}/>`;
  } else if (g.kind === 'ellipse') {
    body += `<ellipse cx='${n(w / 2)}' cy='${n(h / 2)}' rx='${n(w / 2)}' ry='${n(h / 2)}' ${fAttr} ${sAttr(sw)}/>`;
  } else if (g.kind === 'arc') {
    const pt = (ang: number): [number, number] => [g.cx + g.rx * Math.cos(ang), g.cy + g.ry * Math.sin(ang)];
    const s = pt(g.a0);
    const e = pt(g.a1);
    let sweep = g.a1 - g.a0;
    while (sweep < 0) sweep += Math.PI * 2;
    const large = sweep > Math.PI ? 1 : 0;
    let d = `M${n(s[0])} ${n(s[1])} A${n(g.rx)} ${n(g.ry)} 0 ${large} 1 ${n(e[0])} ${n(e[1])}`;
    if (g.pie) d += ` L${n(g.cx)} ${n(g.cy)} Z`;
    else if (g.chord) d += ' Z';
    body += `<path d='${d}' ${g.pie || g.chord ? fAttr : `fill='none'`} ${sAttr(sw)}/>`;
  }
  if (!body) return null;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${n(W)}' height='${n(H)}' viewBox='${-pad} ${-pad} ${n(W)} ${n(H)}'>${body}</svg>`;
  return { src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), width: Math.round(W * 100) / 100, height: Math.round(H * 100) / 100, pad };
}
