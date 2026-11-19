import { normColor, type JNode } from './common';

/**
 * 그리기 개체 (한글의 선·사각형·타원·호·다각형·곡선과 묶은 개체).
 *
 * 한글은 개체마다 '원래 크기'의 좌표로 점을 적고, 이동 행렬 하나와 (크기, 회전) 행렬 쌍들을 적어 둔다.
 * 화면의 점 = 이동 × (회전₁ × 크기₁) × (회전₂ × 크기₂) … × 개체의 점 (쌍은 바깥 묶음 → 자기 자신 순서).
 * 묶은 개체의 자식은 이 행렬에 묶음의 변환까지 들어 있어, 최상위 개체의 틀(왼쪽 위 0,0) 기준 자리가 바로 나온다.
 * 읽을 때 그 곱을 하나의 아핀 행렬(m)로 만들어 두고, 그릴 때는 SVG 의 matrix() 로 쓴다.
 */

/** 아핀 행렬 [a, b, c, d, e, f]: x' = a·x + c·y + e, y' = b·x + d·y + f (SVG matrix 와 같은 차례) */
export type Mat = [number, number, number, number, number, number];
export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** 한글 행렬(e1..e6: x' = e1·x + e2·y + e3, y' = e4·x + e5·y + e6) → Mat */
export const matOfHwp = (e: number[]): Mat => [e[0], e[3], e[1], e[4], e[2], e[5]];
export const hwpOfMat = (m: Mat): number[] => [m[0], m[2], m[4], m[1], m[3], m[5]];

/** p × q (q 를 먼저 적용) */
export function matMul(p: Mat, q: Mat): Mat {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

export function matApply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 이동 × Π(회전ᵢ × 크기ᵢ). 이동·크기·회전의 이동 성분(e, f)에 unit 을 곱해 단위를 바꾼다 (HWPUNIT → px) */
export function composeMats(trans: Mat, pairs: [Mat, Mat][], unit = 1): Mat {
  const u = (m: Mat): Mat => [m[0], m[1], m[2], m[3], m[4] * unit, m[5] * unit];
  let out = u(trans);
  for (const [sca, rot] of pairs) out = matMul(out, matMul(u(rot), u(sca)));
  return out;
}

export interface Gradient {
  /** LINEAR 줄무늬, RADIAL 원형, CONICAL 원뿔, SQUARE 사각형 */
  t: 'LINEAR' | 'RADIAL' | 'CONICAL' | 'SQUARE';
  /** 기울임 (도). 줄무늬: 0 은 위→아래로 변하고 90 은 왼쪽→오른쪽 */
  a: number;
  /** 가로·세로 중심 (%): 첫 색이 놓이는 자리 */
  cx: number;
  cy: number;
  /** 번짐 중심 (%) */
  sc?: number;
  c: string[];
}

export type ShapeKind = 'line' | 'rect' | 'ellipse' | 'arc' | 'poly' | 'curve' | 'img' | 'text' | 'art';

export interface ShapeItem {
  k: ShapeKind;
  /** 개체 좌표(px) → 틀 좌표(px) */
  m: Mat;
  /** 개체 좌표에서의 크기 (px) */
  w: number;
  h: number;
  /** 점들 (px): line [x1,y1,x2,y2], poly·curve [x,y, …], arc [중심x,중심y, 축1x,축1y, 축2x,축2y] */
  p?: number[];
  /** curve: 구간마다 L(직선)·C(곡선) */
  seg?: string;
  /** 닫힌 도형 (poly·curve) */
  z?: boolean;
  /** rect: 모서리 곡률 (%: 0 직각, 50 반원) */
  r?: number;
  /** arc·ellipse 의 호 종류: NORMAL 호, PIE 부채꼴, CHORD 활 */
  at?: string;
  // ---- 선 ----
  /** 선 색 (없으면 선 없음), 굵기(px), 종류(SOLID, DASH, DOT …), 끝 모양 */
  sc?: string | null;
  sw?: number;
  sd?: string;
  cap?: string;
  /** 화살표: 시작·끝 모양(ARROW, SPEAR, CONCAVE_ARROW, DIAMOND, CIRCLE, BOX), 채움, 크기(0 작게 ~ 2 크게: [폭, 길이]) */
  hs?: string;
  ts?: string;
  hf?: boolean;
  tf?: boolean;
  hz?: [number, number];
  tz?: [number, number];
  // ---- 채우기 ----
  fc?: string | null;
  fg?: Gradient | null;
  /** 그림 채우기 (data URL) */
  fi?: string | null;
  /** 투명도 (0 불투명 ~ 1 투명) */
  al?: number;
  /** 그림자: 색과 틀 좌표에서 벗어난 거리(px). 한글 문서의 그림자 거리는 0.01mm 단위다 (SHADOW_UNIT_PX) */
  sh?: { c: string; x: number; y: number } | null;
  // ---- 그림 (k = img) ----
  src?: string;
  /** 잘라 낸 비율 (0~1) */
  crop?: { t: number; r: number; b: number; l: number } | null;
  // ---- 글 (k = text: 도형 안의 글, 화면 전용) ----
  content?: JNode[];
  /** 안 여백 [위, 오른쪽, 아래, 왼쪽] px */
  pad?: number[];
  va?: 'top' | 'middle' | 'bottom';
  // ---- 글맵시 (k = art) ----
  text?: string;
  font?: string;
  // ---- 저장용: 한글 문서의 값 그대로 (HWPUNIT) ----
  raw?: ShapeRaw;
}

/** 다시 저장할 때 그대로 쓰는 한글의 값 */
export interface ShapeRaw {
  /** 묶음 안에서의 자리 */
  off: [number, number];
  org: [number, number];
  cur: [number, number];
  flip: [number, number];
  /** 회전각, 회전 중심 x, y */
  rot: [number, number, number];
  /** 이동 행렬과 (크기, 회전) 쌍들 (한글의 e1..e6 차례) */
  mats: number[][];
  /** 묶음 깊이 (0 최상위) */
  lvl: number;
  /** 선 굵기 (HWPUNIT) */
  lw?: number;
}

export interface ShapeData {
  items: ShapeItem[];
  /** 묶은 개체인가 (저장할 때 container 로) */
  group?: boolean;
  /** 최상위 묶음의 값 (저장용) */
  raw?: ShapeRaw;
}

// ---------------- 값 검사 (문서·붙여넣기에서 온 값) ----------------
const KINDS = new Set<ShapeKind>(['line', 'rect', 'ellipse', 'arc', 'poly', 'curve', 'img', 'text', 'art']);
const LINE_STYLES = new Set(['SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM']);
const ARROWS = new Set(['ARROW', 'SPEAR', 'CONCAVE_ARROW', 'DIAMOND', 'CIRCLE', 'BOX']);
const IMG_RE = /^data:image\/(png|jpeg|gif|webp|bmp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const MAX_ITEMS = 2000;
const MAX_POINTS = 20000;

const fin = (v: any, def = 0, lo = -1e6, hi = 1e6) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

function cleanMat(v: any): Mat {
  if (!Array.isArray(v) || v.length !== 6) return [...IDENTITY];
  return v.map((x, i) => fin(x, IDENTITY[i])) as Mat;
}

function cleanGradient(v: any): Gradient | null {
  if (!v || typeof v !== 'object' || !Array.isArray(v.c)) return null;
  const c = v.c.map((x: any) => normColor(x)).filter((x: any): x is string => !!x).slice(0, 12);
  if (c.length < 2) return null;
  const t = ['LINEAR', 'RADIAL', 'CONICAL', 'SQUARE'].includes(v.t) ? v.t : 'LINEAR';
  const out: Gradient = { t, a: fin(v.a, 0, -3600, 3600), cx: fin(v.cx, 50, 0, 100), cy: fin(v.cy, 50, 0, 100), c };
  if (v.sc != null && fin(v.sc, 50, 0, 100) !== 50) out.sc = fin(v.sc, 50, 0, 100);
  return out;
}

function cleanRaw(v: any): ShapeRaw | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const pair = (x: any): [number, number] => [fin(x?.[0], 0, -1e8, 1e8), fin(x?.[1], 0, -1e8, 1e8)];
  const mats = Array.isArray(v.mats) ? v.mats.slice(0, 33).map((m: any) => (Array.isArray(m) && m.length === 6 ? m.map((x: any) => fin(x, 0, -1e9, 1e9)) : [1, 0, 0, 0, 1, 0])) : [];
  if (!mats.length) return undefined;
  const out: ShapeRaw = { off: pair(v.off), org: pair(v.org), cur: pair(v.cur), flip: [v.flip?.[0] ? 1 : 0, v.flip?.[1] ? 1 : 0], rot: [fin(v.rot?.[0], 0, -36000, 36000), fin(v.rot?.[1], 0, -1e8, 1e8), fin(v.rot?.[2], 0, -1e8, 1e8)], mats, lvl: fin(v.lvl, 0, 0, 32) };
  if (v.lw != null) out.lw = fin(v.lw, 0, 0, 1e6);
  return out;
}

/** 블록 JSON 을 그대로 두되 깊이·크기를 제한한다 (그릴 때 문서 스키마로 다시 검사한다) */
function cleanContent(v: any): JNode[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  try {
    const s = JSON.stringify(v);
    if (s.length > 2_000_000) return undefined;
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function cleanShapeItem(v: any): ShapeItem | null {
  if (!v || typeof v !== 'object' || !KINDS.has(v.k)) return null;
  const it: ShapeItem = { k: v.k, m: cleanMat(v.m), w: fin(v.w, 0, 0, 1e5), h: fin(v.h, 0, 0, 1e5) };
  if (Array.isArray(v.p)) it.p = v.p.slice(0, MAX_POINTS).map((x: any) => fin(x));
  if (typeof v.seg === 'string' && /^[LC]{0,10000}$/.test(v.seg)) it.seg = v.seg;
  if (v.z) it.z = true;
  if (v.r != null) it.r = fin(v.r, 0, 0, 50);
  if (typeof v.at === 'string' && ['NORMAL', 'PIE', 'CHORD'].includes(v.at)) it.at = v.at;
  const sc = normColor(v.sc);
  if (sc) {
    it.sc = sc;
    it.sw = fin(v.sw, 0.45, 0, 400);
    if (typeof v.sd === 'string' && LINE_STYLES.has(v.sd) && v.sd !== 'SOLID') it.sd = v.sd;
    if (v.cap === 'round') it.cap = 'round';
    if (typeof v.hs === 'string' && ARROWS.has(v.hs)) {
      it.hs = v.hs;
      it.hf = !!v.hf;
      it.hz = [fin(v.hz?.[0], 1, 0, 2), fin(v.hz?.[1], 1, 0, 2)];
    }
    if (typeof v.ts === 'string' && ARROWS.has(v.ts)) {
      it.ts = v.ts;
      it.tf = !!v.tf;
      it.tz = [fin(v.tz?.[0], 1, 0, 2), fin(v.tz?.[1], 1, 0, 2)];
    }
  }
  const fc = normColor(v.fc);
  if (fc) it.fc = fc;
  const fg = cleanGradient(v.fg);
  if (fg) it.fg = fg;
  if (typeof v.fi === 'string' && IMG_RE.test(v.fi)) it.fi = v.fi;
  if (v.al != null && fin(v.al, 0, 0, 1) > 0) it.al = fin(v.al, 0, 0, 1);
  if (v.sh && typeof v.sh === 'object' && normColor(v.sh.c)) {
    const sh = { c: normColor(v.sh.c)!, x: fin(v.sh.x, 0, -500, 500), y: fin(v.sh.y, 0, -500, 500) };
    if (sh.x || sh.y) it.sh = sh;
  }
  if (it.k === 'img') {
    if (typeof v.src !== 'string' || !IMG_RE.test(v.src)) return null;
    it.src = v.src;
    if (v.crop && typeof v.crop === 'object') {
      const c = { t: fin(v.crop.t, 0, 0, 0.95), r: fin(v.crop.r, 0, 0, 0.95), b: fin(v.crop.b, 0, 0, 0.95), l: fin(v.crop.l, 0, 0, 0.95) };
      if ((c.t || c.r || c.b || c.l) && c.l + c.r < 0.96 && c.t + c.b < 0.96) it.crop = c;
    }
  }
  if (it.k === 'text') {
    const content = cleanContent(v.content);
    if (!content) return null;
    it.content = content;
    if (Array.isArray(v.pad) && v.pad.length === 4) it.pad = v.pad.map((x: any) => fin(x, 0, 0, 2000));
    if (v.va === 'middle' || v.va === 'bottom') it.va = v.va;
  }
  if (it.k === 'art') {
    if (typeof v.text !== 'string' || !v.text) return null;
    it.text = v.text.slice(0, 2000);
    if (typeof v.font === 'string' && v.font.length <= 80) it.font = v.font.replace(/["'\\;{}<>]/g, '');
  }
  const raw = cleanRaw(v.raw);
  if (raw) it.raw = raw;
  return it;
}

export function cleanShape(v: any): ShapeData | null {
  if (!v || typeof v !== 'object' || !Array.isArray(v.items)) return null;
  const items = v.items.slice(0, MAX_ITEMS).map(cleanShapeItem).filter((x: ShapeItem | null): x is ShapeItem => !!x);
  if (!items.length) return null;
  const out: ShapeData = { items };
  if (v.group) out.group = true;
  const raw = cleanRaw(v.raw);
  if (raw) out.raw = raw;
  return out;
}

// ---------------- SVG 로 그리기 ----------------
const SVG_NS = 'http://www.w3.org/2000/svg';
const n2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** 선 종류 → 점선 무늬 (선 굵기의 배수). 한글의 미리 보기 그림에서 잰 점선(DOT) 비율을 기준으로 삼았다 */
const DASHES: Record<string, number[]> = {
  DASH: [14, 4.5],
  DOT: [7.5, 4.5],
  DASH_DOT: [14, 4.5, 3, 4.5],
  DASH_DOT_DOT: [14, 4.5, 3, 4.5, 3, 4.5],
  LONG_DASH: [24, 7],
  CIRCLE: [0.01, 2.2],
};

/** 이중선·삼중선: [가운데에서 벗어난 자리, 굵기] 를 선 굵기의 비율로 */
const MULTI: Record<string, [number, number][]> = {
  DOUBLE_SLIM: [[-0.35, 0.3], [0.35, 0.3]],
  SLIM_THICK: [[-0.4, 0.2], [0.2, 0.6]],
  THICK_SLIM: [[-0.2, 0.6], [0.4, 0.2]],
  SLIM_THICK_SLIM: [[-0.42, 0.16], [0, 0.4], [0.42, 0.16]],
};

let gradSeq = 0;

/** 줄무늬 그러데이션의 축: 중심(첫 색 자리)이 축의 어디(0~1)에 오는지와 SVG 의 선형 그러데이션 좌표 */
function linearAxis(g: Gradient, w: number, h: number) {
  // 한글의 기울임 0 은 위→아래 (CSS 180deg), 90 은 왼쪽→오른쪽
  const th = ((180 - g.a) * Math.PI) / 180;
  const dx = Math.sin(th);
  const dy = -Math.cos(th);
  const L = Math.abs(w * dx) + Math.abs(h * dy) || 1;
  const mx = w / 2;
  const my = h / 2;
  const c = ((g.cx / 100 - 0.5) * w * dx + (g.cy / 100 - 0.5) * h * dy) / L + 0.5;
  return { x1: mx - (dx * L) / 2, y1: my - (dy * L) / 2, x2: mx + (dx * L) / 2, y2: my + (dy * L) / 2, c: Math.min(1, Math.max(0, c)) };
}

/** 색 목록을 중심에서 양 끝으로 번지게 놓은 색 멈춤: [자리(0~1), 색] */
function linearStops(g: Gradient, c: number): [number, string][] {
  const cs = g.c;
  const n = cs.length - 1;
  const out: [number, string][] = [];
  // 중심 앞쪽: 마지막 색 → 첫 색, 중심 뒤쪽: 첫 색 → 마지막 색
  if (c > 0.001) for (let i = n; i >= 1; i--) out.push([c * (1 - i / n), cs[i]]);
  out.push([c, cs[0]]);
  if (c < 0.999) for (let i = 1; i <= n; i++) out.push([c + (1 - c) * (i / n), cs[i]]);
  return out;
}

/** 한글 그러데이션 → CSS background-image 값 (칸·글상자 배경) */
export function gradientToCss(g: Gradient, w = 1, h = 1): string {
  const at = `${n2(g.cx)}% ${n2(g.cy)}%`;
  if (g.t === 'RADIAL' || g.t === 'SQUARE') return `radial-gradient(farthest-corner at ${at}, ${g.c.join(', ')})`;
  if (g.t === 'CONICAL') return `conic-gradient(from ${Math.round(g.a)}deg at ${at}, ${g.c.join(', ')})`;
  const ax = linearAxis(g, w, h);
  return `linear-gradient(${n2(180 - g.a)}deg, ${linearStops(g, ax.c).map(([o, c]) => `${c} ${n2(o * 100)}%`).join(', ')})`;
}

function el(doc: Document, name: string, attrs: Record<string, string | number | null | undefined>): SVGElement {
  const e = doc.createElementNS(SVG_NS, name) as SVGElement;
  for (const k of Object.keys(attrs)) {
    const v = attrs[k];
    if (v != null && v !== '') e.setAttribute(k, typeof v === 'number' ? n2(v) : v);
  }
  return e;
}

/** 채우기: 색·그러데이션·그림. defs 에 필요한 정의를 넣고 fill 값을 돌려준다 */
function fillOf(doc: Document, defs: SVGElement, it: ShapeItem, tf: string | null = null): string {
  // tf: 도형을 틀 좌표로 그릴 때(행렬 없이) 채우기 무늬를 개체 좌표에서 틀 좌표로 옮기는 변환
  if (it.fi) {
    const id = `ksf${++gradSeq}`;
    const pat = el(doc, 'pattern', { id, patternUnits: 'userSpaceOnUse', x: 0, y: 0, width: Math.max(1, it.w), height: Math.max(1, it.h), patternTransform: tf });
    if (it.fc) pat.appendChild(el(doc, 'rect', { x: 0, y: 0, width: it.w, height: it.h, fill: it.fc }));
    pat.appendChild(el(doc, 'image', { href: it.fi, x: 0, y: 0, width: it.w, height: it.h, preserveAspectRatio: 'none' }));
    defs.appendChild(pat);
    return `url(#${id})`;
  }
  const g = it.fg;
  if (g) {
    const id = `ksg${++gradSeq}`;
    let grad: SVGElement;
    let stops: [number, string][];
    if (g.t === 'LINEAR' || g.t === 'CONICAL') {
      const ax = linearAxis(g, it.w, it.h);
      grad = el(doc, 'linearGradient', { id, gradientUnits: 'userSpaceOnUse', x1: ax.x1, y1: ax.y1, x2: ax.x2, y2: ax.y2, gradientTransform: tf });
      stops = linearStops(g, ax.c);
    } else {
      const cx = (g.cx / 100) * it.w;
      const cy = (g.cy / 100) * it.h;
      // 가장 먼 모서리까지
      const r = Math.max(Math.hypot(cx, cy), Math.hypot(it.w - cx, cy), Math.hypot(cx, it.h - cy), Math.hypot(it.w - cx, it.h - cy)) || 1;
      grad = el(doc, 'radialGradient', { id, gradientUnits: 'userSpaceOnUse', cx, cy, r, gradientTransform: tf });
      stops = g.c.map((c, i) => [i / (g.c.length - 1), c]);
    }
    for (const [o, c] of stops) grad.appendChild(el(doc, 'stop', { offset: n2(o), 'stop-color': c }));
    defs.appendChild(grad);
    return `url(#${id})`;
  }
  return it.fc || 'none';
}

/** 개체 좌표의 도형 경로 (SVG 경로: 절대 좌표의 M·L·H·V·C·A·Z) */
export function pathOf(it: ShapeItem): string {
  const p = it.p || [];
  switch (it.k) {
    case 'line':
      return p.length >= 4 ? `M${n2(p[0])} ${n2(p[1])}L${n2(p[2])} ${n2(p[3])}` : '';
    case 'rect': {
      const { w, h } = it;
      const r = it.r ? (Math.min(w, h) * Math.min(50, it.r)) / 100 : 0;
      if (!r) return `M0 0H${n2(w)}V${n2(h)}H0Z`;
      return `M${n2(r)} 0H${n2(w - r)}A${n2(r)} ${n2(r)} 0 0 1 ${n2(w)} ${n2(r)}V${n2(h - r)}A${n2(r)} ${n2(r)} 0 0 1 ${n2(w - r)} ${n2(h)}H${n2(r)}A${n2(r)} ${n2(r)} 0 0 1 0 ${n2(h - r)}V${n2(r)}A${n2(r)} ${n2(r)} 0 0 1 ${n2(r)} 0Z`;
    }
    case 'ellipse': {
      const rx = it.w / 2;
      const ry = it.h / 2;
      return `M0 ${n2(ry)}A${n2(rx)} ${n2(ry)} 0 1 0 ${n2(it.w)} ${n2(ry)}A${n2(rx)} ${n2(ry)} 0 1 0 0 ${n2(ry)}Z`;
    }
    case 'arc': {
      // 중심 c, 축 끝점 a1 → a2 를 잇는 1/4 타원
      if (p.length < 6) return '';
      const [cx, cy, x1, y1, x2, y2] = p;
      const rx = Math.max(Math.abs(x1 - cx), Math.abs(x2 - cx));
      const ry = Math.max(Math.abs(y1 - cy), Math.abs(y2 - cy));
      // 도는 방향: 중심에서 본 두 축의 외적
      const sweep = (x1 - cx) * (y2 - cy) - (y1 - cy) * (x2 - cx) > 0 ? 1 : 0;
      const arc = `M${n2(x1)} ${n2(y1)}A${n2(rx)} ${n2(ry)} 0 0 ${sweep} ${n2(x2)} ${n2(y2)}`;
      if (it.at === 'PIE') return `${arc}L${n2(cx)} ${n2(cy)}Z`;
      if (it.at === 'CHORD') return `${arc}Z`;
      return arc;
    }
    case 'poly': {
      if (p.length < 4) return '';
      let d = `M${n2(p[0])} ${n2(p[1])}`;
      for (let i = 2; i + 1 < p.length; i += 2) d += `L${n2(p[i])} ${n2(p[i + 1])}`;
      return d + (it.z ? 'Z' : '');
    }
    case 'curve': {
      // 곡선 구간(C)은 점들을 부드럽게 지나는 곡선이다 (한글의 곡선은 조절점이 아니라 지나는 점을 적는다)
      const n = Math.floor(p.length / 2);
      if (n < 2) return '';
      const seg = it.seg || '';
      const X = (i: number) => p[i * 2];
      const Y = (i: number) => p[i * 2 + 1];
      const isC = (s: number) => s >= 0 && s < n - 1 && seg[s] === 'C';
      // 닫힌 곡선(처음과 끝이 같은 점)은 이음매도 부드럽게
      const loop = n > 3 && Math.abs(X(0) - X(n - 1)) < 0.01 && Math.abs(Y(0) - Y(n - 1)) < 0.01 && isC(0) && isC(n - 2);
      let d = `M${n2(X(0))} ${n2(Y(0))}`;
      for (let s = 0; s < n - 1; s++) {
        const a = s;
        const b = s + 1;
        if (!isC(s)) {
          d += `L${n2(X(b))} ${n2(Y(b))}`;
          continue;
        }
        // 앞뒤 이웃 점 (곡선 구간으로 이어질 때만. 아니면 끝점 자신)
        const pa = isC(s - 1) ? a - 1 : loop && s === 0 ? n - 2 : a;
        const nb = isC(s + 1) ? b + 1 : loop && s === n - 2 ? 1 : b;
        const c1x = X(a) + (X(b) - X(pa)) / 6;
        const c1y = Y(a) + (Y(b) - Y(pa)) / 6;
        const c2x = X(b) - (X(nb) - X(a)) / 6;
        const c2y = Y(b) - (Y(nb) - Y(a)) / 6;
        d += `C${n2(c1x)} ${n2(c1y)} ${n2(c2x)} ${n2(c2y)} ${n2(X(b))} ${n2(Y(b))}`;
      }
      return d + (it.z || loop ? 'Z' : '');
    }
  }
  return '';
}

/** 선의 양 끝 (화살표를 달 자리): [끝점, 그 앞 점] 을 개체 좌표로 */
function endsOf(it: ShapeItem): { head: [number, number, number, number]; tail: [number, number, number, number] } | null {
  const p = it.p || [];
  if (it.k === 'line' && p.length >= 4) return { head: [p[0], p[1], p[2], p[3]], tail: [p[2], p[3], p[0], p[1]] };
  if ((it.k === 'poly' || it.k === 'curve') && !it.z && p.length >= 4) {
    const n = p.length;
    return { head: [p[0], p[1], p[2], p[3]], tail: [p[n - 2], p[n - 1], p[n - 4], p[n - 3]] };
  }
  if (it.k === 'arc' && it.at !== 'PIE' && it.at !== 'CHORD' && p.length >= 6) return { head: [p[2], p[3], p[0], p[1]], tail: [p[4], p[5], p[0], p[1]] };
  return null;
}

/** 화살표 크기(px): 가는 선에서도 보이도록 바닥값을 둔다 (한글의 미리 보기에서 0.12mm 선의 보통 크기 상자가 3.5mm) */
function arrowSize(sw: number, z: [number, number] | undefined): [number, number] {
  const f = [0.65, 1, 1.5];
  const base = Math.max(sw * 3.2, 12);
  return [base * f[Math.round(z?.[0] ?? 1)], base * f[Math.round(z?.[1] ?? 1)]];
}

/** 틀 좌표에서의 화살표 도형 (끝점 tip, 방향은 from → tip) */
function arrowEl(doc: Document, style: string, filled: boolean, tip: [number, number], from: [number, number], size: [number, number], color: string, sw: number): SVGElement | null {
  const dx = tip[0] - from[0];
  const dy = tip[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (!(len > 0.01)) return null;
  const ux = dx / len;
  const uy = dy / len;
  const [aw, al] = size;
  // 끝점 좌표계: u 는 선 방향, v 는 그에 수직
  const pt = (along: number, across: number) => `${n2(tip[0] + ux * along - uy * across)} ${n2(tip[1] + uy * along + ux * across)}`;
  const common = { stroke: color, 'stroke-width': Math.max(0.6, Math.min(sw, 1.5)), 'stroke-linejoin': 'miter', fill: filled ? color : '#FFFFFF' };
  switch (style) {
    case 'ARROW':
      return el(doc, 'path', { d: `M${pt(0, 0)}L${pt(-al, aw / 2)}L${pt(-al, -aw / 2)}Z`, fill: color, stroke: 'none' });
    case 'SPEAR':
      return el(doc, 'path', { d: `M${pt(0, 0)}L${pt(-al, aw / 2)}L${pt(-al * 0.6, 0)}L${pt(-al, -aw / 2)}Z`, fill: color, stroke: 'none' });
    case 'CONCAVE_ARROW':
      return el(doc, 'path', { d: `M${pt(0, 0)}L${pt(-al * 1.1, aw / 2)}L${pt(-al * 0.75, 0)}L${pt(-al * 1.1, -aw / 2)}Z`, fill: color, stroke: 'none' });
    case 'DIAMOND':
      return el(doc, 'path', { d: `M${pt(al / 2, 0)}L${pt(0, aw / 2)}L${pt(-al / 2, 0)}L${pt(0, -aw / 2)}Z`, ...common });
    case 'CIRCLE':
      return el(doc, 'ellipse', { cx: tip[0], cy: tip[1], rx: al / 2, ry: aw / 2, transform: `rotate(${n2((Math.atan2(uy, ux) * 180) / Math.PI)} ${n2(tip[0])} ${n2(tip[1])})`, ...common });
    case 'BOX':
      return el(doc, 'path', { d: `M${pt(al / 2, aw / 2)}L${pt(-al / 2, aw / 2)}L${pt(-al / 2, -aw / 2)}L${pt(al / 2, -aw / 2)}Z`, ...common });
  }
  return null;
}

/** 선 속성 (굵기는 --sw 로도 실어 화면에서는 너무 가늘지 않게, 인쇄에서는 제 굵기로 그린다: editor.css) */
function strokeAttrs(it: ShapeItem, scale: number): Record<string, string | number> {
  if (!it.sc || !(it.sw! >= 0)) return { stroke: 'none' };
  // 행렬이 크기를 바꿔도 선 굵기는 그대로 (non-scaling-stroke)
  const sw = Math.max(0.1, it.sw || 0.45);
  const a: Record<string, string | number> = { stroke: it.sc, 'stroke-width': sw, 'vector-effect': 'non-scaling-stroke', style: `--sw:${n2(sw)}px`, 'stroke-linejoin': 'miter' };
  const dash = it.sd ? DASHES[it.sd] : null;
  if (dash) {
    a['stroke-dasharray'] = dash.map((d) => n2(d * sw)).join(' ');
    if (it.sd === 'CIRCLE') a['stroke-linecap'] = 'round';
  } else if (it.cap === 'round') a['stroke-linecap'] = 'round';
  void scale;
  return a;
}

export interface ShapeDom {
  /** 도형을 그린 SVG */
  svg: SVGElement;
  /** 도형 안의 글 (틀 좌표의 자리에 놓을 것): 부르는 쪽이 문서 스키마로 그린다 */
  texts: ShapeItem[];
}

/** 그리기 개체 → SVG (틀 크기 w×h px). 틀 밖으로 나간 부분도 보인다 (overflow: visible) */
export function shapeToSvg(doc: Document, d: ShapeData, w: number, h: number): ShapeDom {
  const svg = el(doc, 'svg', { xmlns: SVG_NS, width: Math.max(1, w), height: Math.max(1, h), viewBox: `0 0 ${n2(Math.max(1, w))} ${n2(Math.max(1, h))}`, overflow: 'visible', class: 'k-shape-svg' });
  const defs = el(doc, 'defs', {});
  const texts: ShapeItem[] = [];
  for (const it of d.items) {
    const tf0 = `matrix(${it.m.map(n2).join(' ')})`;
    const opacity = it.al ? n2(1 - it.al) : null;
    if (it.k === 'text') {
      texts.push(it);
      continue;
    }
    if (it.k === 'img') {
      const g = el(doc, 'g', { transform: tf0, opacity });
      const c = it.crop;
      if (c) {
        // 잘라 낸 부분이 개체 크기를 채운다
        const fw = it.w / Math.max(0.01, 1 - c.l - c.r);
        const fh = it.h / Math.max(0.01, 1 - c.t - c.b);
        const inner = el(doc, 'svg', { x: 0, y: 0, width: it.w, height: it.h, viewBox: `0 0 ${n2(it.w)} ${n2(it.h)}`, overflow: 'hidden' });
        inner.appendChild(el(doc, 'image', { href: it.src!, x: -c.l * fw, y: -c.t * fh, width: fw, height: fh, preserveAspectRatio: 'none' }));
        g.appendChild(inner);
      } else g.appendChild(el(doc, 'image', { href: it.src!, x: 0, y: 0, width: it.w, height: it.h, preserveAspectRatio: 'none' }));
      svg.appendChild(g);
      continue;
    }
    if (it.k === 'art') {
      // 글맵시: 줄마다 글자를 상자 폭에 맞추고 줄 높이를 채우도록 세로로 늘인다
      const lines = (it.text || '').split(/\r?\n|\u240d\u240a?|\u240a/).filter((s) => s.length);
      if (!lines.length) continue;
      const g = el(doc, 'g', { transform: tf0, opacity });
      const lh = it.h / lines.length;
      // 글자 폭 어림 (em): 한글·한자는 1, 그 밖은 0.55
      const ems = (t: string) => Array.from(t).reduce((a, ch) => a + (ch.codePointAt(0)! >= 0x1100 ? 1 : ch === ' ' ? 0.35 : 0.55), 0) || 1;
      lines.forEach((t0, i) => {
        const fs = Math.max(1, it.w / ems(t0));
        const sy = (lh * 0.92) / fs;
        const t = el(doc, 'text', { x: 0, y: 0, 'font-size': fs, textLength: it.w, lengthAdjust: 'spacingAndGlyphs', transform: `translate(0 ${n2(i * lh + lh * 0.82)}) scale(1 ${n2(sy)})`, fill: it.fc || '#000000', ...(it.font ? { 'font-family': `'${it.font}', sans-serif` } : {}), ...(it.sc ? { stroke: it.sc, 'stroke-width': 0.5 } : {}) });
        t.textContent = t0;
        g.appendChild(t);
      });
      svg.appendChild(g);
      continue;
    }
    // 점으로 된 도형(선·다각형·곡선)은 점을 틀 좌표로 옮겨 그린다: 폭이나 높이가 0 인 선(가로·세로 선)의 행렬은
    // 역행렬이 없어 SVG 가 그리지 않는다
    let dPath: string;
    let tf: string | null = tf0;
    if ((it.k === 'line' || it.k === 'poly' || it.k === 'curve') && it.p) {
      const q: number[] = [];
      for (let i = 0; i + 1 < it.p.length; i += 2) q.push(...matApply(it.m, it.p[i], it.p[i + 1]));
      dPath = pathOf({ ...it, p: q });
      tf = null;
    } else dPath = pathOf(it);
    if (!dPath) continue;
    const open = it.k === 'line' || ((it.k === 'poly' || it.k === 'curve') && !it.z) || (it.k === 'arc' && it.at !== 'PIE' && it.at !== 'CHORD');
    const fill = it.k === 'line' ? 'none' : fillOf(doc, defs, it, tf === null ? tf0 : null);
    const multi = it.sc && it.sd ? MULTI[it.sd] : null;
    // 그림자가 위·왼쪽으로 지면 한글은 도형을 아래·오른쪽으로 조금 밀어 그린다 (미리 보기 그림에서 그림자 거리의 절반쯤)
    const push = 0.45;
    const g = el(doc, 'g', { opacity, transform: it.sh && (it.sh.x < 0 || it.sh.y < 0) ? `translate(${n2(Math.max(0, -it.sh.x) * push)} ${n2(Math.max(0, -it.sh.y) * push)})` : null });
    if (it.sh) {
      // 그림자: 같은 도형을 그림자 색으로, 벗어난 자리에 먼저 그린다
      const sg = el(doc, 'g', { transform: `translate(${n2(it.sh.x)} ${n2(it.sh.y)})` });
      const filled = it.k !== 'line' && (!!it.fc || !!it.fg || !!it.fi || !open);
      sg.appendChild(el(doc, 'path', { d: dPath, transform: tf, fill: filled ? it.sh.c : 'none', stroke: it.sc ? it.sh.c : 'none', 'stroke-width': Math.max(0.45, it.sw || 0.45), 'vector-effect': 'non-scaling-stroke' }));
      g.appendChild(sg);
    }
    if (multi && it.k !== 'line') {
      // 이중선: 채우기만 먼저, 선은 굵기를 나눠 여러 번
      g.appendChild(el(doc, 'path', { d: dPath, transform: tf, fill, stroke: 'none' }));
    }
    if (multi) {
      const sw = Math.max(0.6, it.sw || 0.45);
      if (it.k === 'line' && it.p && it.p.length >= 4) {
        // 선은 수직 방향으로 벌려 나란히 그린다 (틀 좌표에서)
        const a = matApply(it.m, it.p[0], it.p[1]);
        const b = matApply(it.m, it.p[2], it.p[3]);
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const nx = -(b[1] - a[1]) / len;
        const ny = (b[0] - a[0]) / len;
        for (const [off, wd] of multi) g.appendChild(el(doc, 'path', { d: `M${n2(a[0] + nx * off * sw)} ${n2(a[1] + ny * off * sw)}L${n2(b[0] + nx * off * sw)} ${n2(b[1] + ny * off * sw)}`, fill: 'none', stroke: it.sc!, 'stroke-width': Math.max(0.3, wd * sw) }));
      } else {
        // 닫힌 도형: 굵은 선 위에 바탕색 선을 덧그려 이중선처럼 보이게 한다
        g.appendChild(el(doc, 'path', { d: dPath, transform: tf, fill: 'none', stroke: it.sc!, 'stroke-width': sw, 'vector-effect': 'non-scaling-stroke' }));
        g.appendChild(el(doc, 'path', { d: dPath, transform: tf, fill: 'none', stroke: '#FFFFFF', 'stroke-width': sw * 0.34, 'vector-effect': 'non-scaling-stroke' }));
      }
    } else {
      g.appendChild(el(doc, 'path', { d: dPath, transform: tf, fill, 'fill-rule': 'evenodd', ...strokeAttrs(it, 1) }));
    }
    // 화살표 (틀 좌표에서: 행렬로 찌그러지지 않게)
    if (open && it.sc && (it.hs || it.ts)) {
      const ends = endsOf(it);
      if (ends) {
        const sw = Math.max(0.45, it.sw || 0.45);
        const mk = (e: [number, number, number, number], style: string | undefined, filled: boolean | undefined, z: [number, number] | undefined) => {
          if (!style) return;
          const a = arrowEl(doc, style, !!filled, matApply(it.m, e[0], e[1]), matApply(it.m, e[2], e[3]), arrowSize(sw, z), it.sc!, sw);
          if (a) g.appendChild(a);
        };
        mk(ends.head, it.hs, it.hf, it.hz);
        mk(ends.tail, it.ts, it.tf, it.tz);
      }
    }
    svg.appendChild(g);
  }
  if (defs.childNodes.length) svg.insertBefore(defs, svg.firstChild);
  return { svg, texts };
}

/** 그리기 개체가 차지하는 자리 (틀 좌표 px): 모든 점의 범위 */
export function shapeBounds(d: ShapeData): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (m: Mat, x: number, y: number) => {
    const [a, b] = matApply(m, x, y);
    x0 = Math.min(x0, a); y0 = Math.min(y0, b); x1 = Math.max(x1, a); y1 = Math.max(y1, b);
  };
  for (const it of d.items) {
    if ((it.k === 'line' || it.k === 'poly' || it.k === 'curve') && it.p && it.p.length >= 4) {
      for (let i = 0; i + 1 < it.p.length; i += 2) add(it.m, it.p[i], it.p[i + 1]);
    } else {
      add(it.m, 0, 0); add(it.m, it.w, 0); add(it.m, it.w, it.h); add(it.m, 0, it.h);
    }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1 } : null;
}

// ---------------- 한글 값 → 도형 속성 ----------------
/** 한글의 화살표 모양 이름 → [모양, 채움] */
export function arrowOf(style: string | null | undefined, fill: boolean): { s?: string; f?: boolean } {
  switch ((style || 'NORMAL').toUpperCase()) {
    case 'ARROW':
      return { s: 'ARROW', f: true };
    case 'SPEAR':
      return { s: 'SPEAR', f: true };
    case 'CONCAVE_ARROW':
      return { s: 'CONCAVE_ARROW', f: true };
    case 'EMPTY_DIAMOND':
    case 'DIAMOND':
      return { s: 'DIAMOND', f: fill };
    case 'EMPTY_CIRCLE':
    case 'CIRCLE':
      return { s: 'CIRCLE', f: fill };
    case 'EMPTY_BOX':
    case 'BOX':
      return { s: 'BOX', f: fill };
  }
  return {};
}

/** 한글의 화살표 크기 이름(SMALL_SMALL … LARGE_LARGE: 폭_길이) → [폭, 길이] (0 작게 ~ 2 크게) */
export function arrowSizeOf(name: string | null | undefined): [number, number] {
  const idx = (s: string) => (s === 'SMALL' ? 0 : s === 'LARGE' ? 2 : 1);
  const [a, b] = (name || 'MEDIUM_MEDIUM').toUpperCase().split('_');
  return [idx(a), idx(b || 'MEDIUM')];
}

/** 한글의 그림자 거리 단위(0.01mm)를 px 로. 미리 보기 그림에서 잰 값: 거리 283 이 2.8mm 쯤 */
export const SHADOW_UNIT_PX = 0.01 * (96 / 25.4);
/** 거리가 0 으로 적힌 그림자를 한글이 그리는 거리 (0.01mm) */
export const SHADOW_DEFAULT = 283;

export const HWP_LINE_STYLES = ['SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM'];
export const HWP_ARROW_STYLES = ['NORMAL', 'ARROW', 'SPEAR', 'CONCAVE_ARROW', 'EMPTY_DIAMOND', 'EMPTY_CIRCLE', 'EMPTY_BOX'];
export const HWP_ARROW_SIZES = ['SMALL_SMALL', 'SMALL_MEDIUM', 'SMALL_LARGE', 'MEDIUM_SMALL', 'MEDIUM_MEDIUM', 'MEDIUM_LARGE', 'LARGE_SMALL', 'LARGE_MEDIUM', 'LARGE_LARGE'];
