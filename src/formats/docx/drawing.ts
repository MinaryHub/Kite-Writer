/**
 * Word(DOCX)의 그리기 개체(DrawingML): 떠 있는 개체의 자리, 색(테마 색과 조정), 기본 도형의 꼴.
 *
 * - 자리: wp:anchor 의 가로(종이·여백·단·글자 기준)·세로(종이·여백·문단·줄 기준) 자리와 정렬을 Kite 의 떠 있는 자리로 바꾼다
 *   (x 는 본문 왼쪽, y 는 문단 위쪽 기준 px. 종이·여백 기준 세로 자리는 py: 쪽 본문 맨 위 기준 — 쪽 나누기가 끝난 뒤 그 자리에 놓는다)
 * - 색: srgbClr·schemeClr(테마)·sysClr·prstClr 와 조정(lumMod·lumOff·shade·tint·alpha)
 * - 도형: prstGeom 의 사각형·둥근 사각형·타원·삼각형·마름모·평행사변형·사다리꼴·오각형·육각형·팔각형·별·화살표·갈매기·십자·선
 *
 * 문서에서 온 값이므로 수는 늘 범위를 확인하고, 색은 #RRGGBB 로만 낸다.
 */
import { attr, descendant, kid, kids, localName } from '../common';
import type { ShapeItem } from '../shape';

/** 1px = 9525 EMU */
export const EMU_PER_PX = 9525;

const fin = (v: number, lo: number, hi: number, d = 0) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
/** EMU 값(문자열) → px */
export const emuPx = (v: string | null | undefined, d = 0) => {
  const n = parseFloat(v ?? '');
  return Number.isFinite(n) ? fin(n / EMU_PER_PX, -1e5, 1e5, d) : d;
};

// ---------------- 색 ----------------

/** 테마의 색 구성표(a:clrScheme): dk1·lt1·dk2·lt2·accent1~6·hlink·folHlink → #RRGGBB */
export function themeColors(theme: Document | Element | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!theme) return out;
  const scheme = descendant(theme as Element, 'clrScheme');
  if (!scheme) return out;
  for (const c of kids(scheme)) {
    const v = kids(c)[0];
    if (!v) continue;
    const hex = localName(v) === 'sysClr' ? attr(v, 'lastClr') : attr(v, 'val');
    if (hex && /^[0-9A-Fa-f]{6}$/.test(hex)) out.set(localName(c), '#' + hex.toUpperCase());
  }
  return out;
}

const PRESET: Record<string, string> = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', darkGray: 'A9A9A9', lightGray: 'D3D3D3', orange: 'FFA500', purple: '800080', navy: '000080' };
const SCHEME_ALIAS: Record<string, string> = { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' };

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}

/**
 * 색 요소(srgbClr·schemeClr·sysClr·prstClr, 또는 그것을 품은 solidFill 등) → { c: #RRGGBB, a: 불투명도 0~1 }.
 * ph: 스타일 행렬의 자리 표시 색(phClr)을 갈음할 색
 */
export function colorOf(el: Element | null, theme: Map<string, string>, ph: string | null = null): { c: string; a: number } | null {
  if (!el) return null;
  const ln = localName(el);
  const COLOR = ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'];
  const ce = COLOR.includes(ln) ? el : kids(el).find((k) => COLOR.includes(localName(k))) || null;
  if (!ce) return null;
  const kind = localName(ce);
  let hex: string | null = null;
  if (kind === 'srgbClr') hex = attr(ce, 'val');
  else if (kind === 'sysClr') hex = attr(ce, 'lastClr') || (attr(ce, 'val') === 'window' ? 'FFFFFF' : '000000');
  else if (kind === 'prstClr') hex = PRESET[attr(ce, 'val') || ''] || null;
  else if (kind === 'schemeClr') {
    const v = attr(ce, 'val') || '';
    const t = v === 'phClr' ? ph : theme.get(SCHEME_ALIAS[v] || v) || null;
    hex = t ? t.replace('#', '') : null;
  } else if (kind === 'scrgbClr') {
    const p = (k: string) => fin((parseFloat(attr(ce, k) || '0') || 0) / 100000, 0, 1);
    hex = [p('r'), p('g'), p('b')].map((v) => Math.round(Math.pow(v, 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('');
  }
  if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  let r = parseInt(hex.slice(0, 2), 16) / 255;
  let g = parseInt(hex.slice(2, 4), 16) / 255;
  let b = parseInt(hex.slice(4, 6), 16) / 255;
  let a = 1;
  // 조정은 적힌 차례대로
  for (const m of kids(ce)) {
    const v = fin((parseFloat(attr(m, 'val') || '') || 0) / 100000, -10, 10);
    switch (localName(m)) {
      case 'alpha':
        a = fin(v, 0, 1, 1);
        break;
      case 'shade':
        r *= v;
        g *= v;
        b *= v;
        break;
      case 'tint':
        r = r * v + (1 - v);
        g = g * v + (1 - v);
        b = b * v + (1 - v);
        break;
      case 'lumMod':
      case 'lumOff': {
        const [h, s, l] = rgbToHsl(r, g, b);
        const nl = localName(m) === 'lumMod' ? l * v : l + v;
        [r, g, b] = hslToRgb(h, s, fin(nl, 0, 1));
        break;
      }
      case 'satMod': {
        const [h, s, l] = rgbToHsl(r, g, b);
        [r, g, b] = hslToRgb(h, fin(s * v, 0, 1), l);
        break;
      }
    }
    r = fin(r, 0, 1);
    g = fin(g, 0, 1);
    b = fin(b, 0, 1);
  }
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0').toUpperCase();
  return { c: `#${to(r)}${to(g)}${to(b)}`, a };
}

// ---------------- 떠 있는 개체의 자리 ----------------

/** 쪽의 크기와 여백 (px) */
export interface PageGeo {
  W: number;
  H: number;
  ml: number;
  mr: number;
  mt: number;
  mb: number;
}

/** 떠 있는 개체의 자리 */
export interface AnchorPlace {
  /** 본문 왼쪽 기준 가로 자리 (px) */
  x: number;
  /** 문단 위쪽 기준 세로 자리 (px). py 가 있으면 쪽 나누기 전의 어림 */
  y: number;
  /** 쪽 본문 맨 위 기준 세로 자리 (종이·여백 기준으로 놓인 개체) */
  py: number | null;
  /** 글 뒤로 */
  behind: boolean;
  /** 글 배치: 없음(글 앞·뒤), 네모·빽빽하게·통과(둘러싸기), 위아래 */
  wrap: 'none' | 'square' | 'tight' | 'through' | 'topBottom';
  /** 크기 (px) */
  w: number;
  h: number;
  /** 글이 흐르는 쪽 (wrapSquare·Tight·Through 의 wrapText): 양쪽·왼쪽만·오른쪽만·넓은 쪽 */
  side: 'bothSides' | 'left' | 'right' | 'largest';
  /** 둘레 글과의 간격 px (위·오른쪽·아래·왼쪽) */
  dist: [number, number, number, number];
}

/** anchor 의 자식 요소: 바로 아래이거나 mc:AlternateContent 안 (Word 2010 의 wp14 자리는 Choice, 예전 판용 값은 Fallback) */
function anchorKid(anchor: Element, name: string): Element | null {
  const direct = kid(anchor, name);
  if (direct) return direct;
  for (const ac of kids(anchor, 'AlternateContent')) {
    const e = kid(kid(ac, 'Choice'), name) || kid(kid(ac, 'Fallback'), name);
    if (e) return e;
  }
  return null;
}

/** 자리 값: EMU 의 posOffset, 또는 기준 상자 폭·높이에 대한 백분율(wp14:pctPosHOffset·pctPosVOffset, 1000 분의 1 %) */
function offsetIn(pos: Element | null, size: number): number | null {
  const off = kid(pos, 'posOffset');
  if (off) return emuPx(off.textContent);
  const pct = kid(pos, 'pctPosHOffset') || kid(pos, 'pctPosVOffset');
  if (pct) {
    const v = parseFloat(pct.textContent || '');
    if (Number.isFinite(v)) return fin((size * v) / 100000, -1e5, 1e5);
  }
  return null;
}

/** wp:anchor → 자리 */
export function anchorPlace(anchor: Element, geo: PageGeo): AnchorPlace {
  const ext = anchorKid(anchor, 'extent');
  let w = Math.max(0, emuPx(attr(ext, 'cx')));
  let h = Math.max(0, emuPx(attr(ext, 'cy')));
  const bodyW = Math.max(1, geo.W - geo.ml - geo.mr);
  const bodyH = Math.max(1, geo.H - geo.mt - geo.mb);
  // 상대 크기 (wp14:sizeRelH·sizeRelV, 1000 분의 1 %): 쪽·여백 폭·높이에 대한 비율. 0 이면 extent 를 쓴다
  const relSize = (name: string, pctName: string, refs: Record<string, number>, dflt: number): number | null => {
    const rel = anchorKid(anchor, name);
    const v = parseFloat(kid(rel, pctName)?.textContent || '');
    if (!rel || !Number.isFinite(v) || v <= 0) return null;
    return fin(((refs[attr(rel, 'relativeFrom') || ''] ?? dflt) * v) / 100000, 0, 1e5);
  };
  w = relSize('sizeRelH', 'pctWidth', { page: geo.W, margin: bodyW, leftMargin: geo.ml, rightMargin: geo.mr, insideMargin: geo.ml, outsideMargin: geo.mr }, geo.W) ?? w;
  h = relSize('sizeRelV', 'pctHeight', { page: geo.H, margin: bodyH, topMargin: geo.mt, bottomMargin: geo.mb, insideMargin: geo.mt, outsideMargin: geo.mb }, geo.H) ?? h;
  // 가로
  const ph = anchorKid(anchor, 'positionH');
  const hRel = attr(ph, 'relativeFrom') || 'column';
  const hAl = kid(ph, 'align')?.textContent?.trim() || '';
  // 기준 상자의 왼쪽(본문 왼쪽 기준)과 폭
  const hBox: Record<string, [number, number]> = {
    page: [-geo.ml, geo.W],
    margin: [0, bodyW],
    column: [0, bodyW],
    character: [0, bodyW],
    leftMargin: [-geo.ml, geo.ml],
    rightMargin: [bodyW, geo.mr],
    insideMargin: [-geo.ml, geo.ml],
    outsideMargin: [bodyW, geo.mr],
  };
  const [hx, hw] = hBox[hRel] || hBox.column;
  const hOff = offsetIn(ph, hw);
  let x: number;
  if (hOff != null) x = hx + hOff;
  else if (hAl === 'center') x = hx + (hw - w) / 2;
  else if (hAl === 'right' || hAl === 'outside') x = hx + hw - w;
  else x = hx;
  // 세로
  const pv = anchorKid(anchor, 'positionV');
  const vRel = attr(pv, 'relativeFrom') || 'paragraph';
  const vAl = kid(pv, 'align')?.textContent?.trim() || '';
  let y = 0;
  let py: number | null = null;
  if (vRel === 'paragraph' || vRel === 'line') {
    y = offsetIn(pv, 0) ?? 0;
  } else {
    // 쪽 본문 맨 위 기준 상자의 위쪽과 높이
    const vBox: Record<string, [number, number]> = {
      page: [-geo.mt, geo.H],
      margin: [0, bodyH],
      topMargin: [-geo.mt, geo.mt],
      bottomMargin: [bodyH, geo.mb],
      insideMargin: [-geo.mt, geo.mt],
      outsideMargin: [bodyH, geo.mb],
    };
    const [vy, vh] = vBox[vRel] || vBox.margin;
    const vOff = offsetIn(pv, vh);
    if (vOff != null) py = vy + vOff;
    else if (vAl === 'center') py = vy + (vh - h) / 2;
    else if (vAl === 'bottom' || vAl === 'outside') py = vy + vh - h;
    else py = vy;
  }
  const wrapEl = kids(anchor).find((k) => /^wrap/.test(localName(k)));
  const wn = wrapEl ? localName(wrapEl) : 'wrapNone';
  const wrap = wn === 'wrapSquare' ? 'square' : wn === 'wrapTight' ? 'tight' : wn === 'wrapThrough' ? 'through' : wn === 'wrapTopAndBottom' ? 'topBottom' : 'none';
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const wt = attr(wrapEl, 'wrapText');
  const side = wt === 'left' || wt === 'right' || wt === 'largest' ? wt : 'bothSides';
  // 간격: 배치 요소에 따로 적혔으면 그것, 아니면 anchor 의 것 (EMU)
  const gap = (k: string) => r2(fin(emuPx(attr(wrapEl, k) ?? attr(anchor, k)), 0, 500));
  const dist: [number, number, number, number] = [gap('distT'), gap('distR'), gap('distB'), gap('distL')];
  return { x: r2(x), y: r2(y), py: py == null ? null : r2(py), behind: attr(anchor, 'behindDoc') === '1', wrap, w: r2(w), h: r2(h), side, dist };
}

// ---------------- 기본 도형 ----------------

/** 도형 조정 값(a:avLst 의 gd: "val 50000") */
export function adjustValues(prstGeom: Element | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const gd of kids(kid(prstGeom, 'avLst'), 'gd')) {
    const m = /^val\s+(-?\d+)/.exec(attr(gd, 'fmla') || '');
    if (m) out.set(attr(gd, 'name') || '', parseInt(m[1], 10));
  }
  return out;
}

/** 점들을 w×h 상자에 꽉 차게 (별처럼 꼭짓점이 상자 끝에 닿지 않는 꼴을 Word 처럼 맞춘다) */
function fitBox(pts: number[], w: number, h: number): number[] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    x0 = Math.min(x0, pts[i]);
    x1 = Math.max(x1, pts[i]);
    y0 = Math.min(y0, pts[i + 1]);
    y1 = Math.max(y1, pts[i + 1]);
  }
  const sx = x1 > x0 ? w / (x1 - x0) : 1;
  const sy = y1 > y0 ? h / (y1 - y0) : 1;
  return pts.map((v, i) => (i % 2 === 0 ? (v - x0) * sx : (v - y0) * sy));
}

/** 별: 꼭짓점 n 개, 안쪽 반지름 비율 inner (0~1). 위 꼭짓점부터 */
function starPoints(n: number, inner: number, w: number, h: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n * 2; i++) {
    const r = i % 2 === 0 ? 1 : inner;
    const t = -Math.PI / 2 + (i * Math.PI) / n;
    pts.push(Math.cos(t) * r, Math.sin(t) * r);
  }
  return fitBox(pts, w, h);
}

/** 정다각형 (위가 꼭짓점이거나 변) */
function regularPoints(n: number, w: number, h: number, rot = -Math.PI / 2): number[] {
  const pts: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = rot + (i * 2 * Math.PI) / n;
    pts.push(Math.cos(t), Math.sin(t));
  }
  return fitBox(pts, w, h);
}

const STAR_INNER: Record<string, [number, number]> = {
  star4: [4, 12500],
  star5: [5, 19098],
  star6: [6, 28868],
  star7: [7, 34601],
  star8: [8, 38250],
  star10: [10, 42533],
  star12: [12, 37500],
  star16: [16, 37500],
  star24: [24, 37500],
  star32: [32, 37500],
};

/**
 * prstGeom → 도형 조각의 꼴 (k 와 점들). 모르는 꼴은 사각형으로 (자리와 채우기는 보이게)
 */
export function presetGeometry(prst: string, w: number, h: number, av: Map<string, number>): Pick<ShapeItem, 'k' | 'p' | 'z' | 'r'> {
  const ss = Math.min(w, h);
  const a = (name: string, d: number) => fin(av.get(name) ?? d, -100000, 200000, d);
  const poly = (p: number[]): Pick<ShapeItem, 'k' | 'p' | 'z'> => ({ k: 'poly', p: p.map((v) => Math.round(v * 100) / 100), z: true });
  switch (prst) {
    case 'rect':
    case 'flowChartProcess':
    case 'flowChartAlternateProcess':
    case 'frame':
    case 'snip1Rect':
      return { k: 'rect' };
    case 'roundRect':
      return { k: 'rect', r: fin(a('adj', 16667) / 1000, 0, 50) };
    case 'ellipse':
    case 'flowChartConnector':
    case 'donut':
      return { k: 'ellipse' };
    case 'triangle':
    case 'flowChartExtract': {
      const x = (w * a('adj', 50000)) / 100000;
      return poly([x, 0, w, h, 0, h]);
    }
    case 'rtTriangle':
      return poly([0, 0, w, h, 0, h]);
    case 'diamond':
    case 'flowChartDecision':
      return poly([w / 2, 0, w, h / 2, w / 2, h, 0, h / 2]);
    case 'parallelogram':
    case 'flowChartInputOutput': {
      const x = (ss * a('adj', 25000)) / 100000;
      return poly([x, 0, w, 0, w - x, h, 0, h]);
    }
    case 'trapezoid': {
      const x = (ss * a('adj', 25000)) / 100000;
      return poly([0, h, x, 0, w - x, 0, w, h]);
    }
    case 'pentagon':
      return poly(regularPoints(5, w, h));
    case 'hexagon': {
      const x = (ss * a('adj', 25000)) / 100000;
      return poly([x, 0, w - x, 0, w, h / 2, w - x, h, x, h, 0, h / 2]);
    }
    case 'heptagon':
      return poly(regularPoints(7, w, h));
    case 'octagon': {
      const x = (ss * a('adj', 29289)) / 100000;
      return poly([x, 0, w - x, 0, w, x, w, h - x, w - x, h, x, h, 0, h - x, 0, x]);
    }
    case 'decagon':
      return poly(regularPoints(10, w, h, 0));
    case 'dodecagon':
      return poly(regularPoints(12, w, h, 0));
    case 'homePlate': {
      const x = w - (ss * a('adj', 50000)) / 100000;
      return poly([0, 0, x, 0, w, h / 2, x, h, 0, h]);
    }
    case 'chevron': {
      const x = (ss * a('adj', 50000)) / 100000;
      return poly([0, 0, w - x, 0, w, h / 2, w - x, h, 0, h, x, h / 2]);
    }
    case 'plus': {
      const x = (ss * a('adj', 25000)) / 100000;
      return poly([x, 0, w - x, 0, w - x, x, w, x, w, h - x, w - x, h - x, w - x, h, x, h, x, h - x, 0, h - x, 0, x, x, x]);
    }
    case 'rightArrow':
    case 'leftArrow':
    case 'upArrow':
    case 'downArrow': {
      // 오른쪽 화살표를 만들고 방향대로 돌린다: adj1 몸통 굵기(높이 비율), adj2 머리 길이(짧은 변 비율)
      const horiz = prst === 'rightArrow' || prst === 'leftArrow';
      const L = horiz ? w : h;
      const T = horiz ? h : w;
      const d = (T * a('adj1', 50000)) / 200000;
      const hx = L - (Math.min(L, T) * a('adj2', 50000)) / 100000;
      let p = [0, T / 2 - d, hx, T / 2 - d, hx, 0, L, T / 2, hx, T, hx, T / 2 + d, 0, T / 2 + d];
      if (prst === 'leftArrow') p = p.map((v, i) => (i % 2 === 0 ? L - v : v));
      if (prst === 'downArrow') p = p.flatMap((_, i) => (i % 2 === 0 ? [p[i + 1], p[i]] : []));
      if (prst === 'upArrow') p = p.flatMap((_, i) => (i % 2 === 0 ? [p[i + 1], L - p[i]] : []));
      return poly(p);
    }
    case 'leftRightArrow': {
      const d = (h * a('adj1', 50000)) / 200000;
      const hx = (ss * a('adj2', 50000)) / 100000;
      return poly([0, h / 2, hx, 0, hx, h / 2 - d, w - hx, h / 2 - d, w - hx, 0, w, h / 2, w - hx, h, w - hx, h / 2 + d, hx, h / 2 + d, hx, h]);
    }
    case 'line':
    case 'straightConnector1':
    case 'bentConnector2':
    case 'bentConnector3':
    case 'curvedConnector3':
      return { k: 'line', p: [0, 0, w, h] };
    default: {
      const st = STAR_INNER[prst];
      if (st) return poly(starPoints(st[0], fin(a('adj', st[1]) / 50000, 0.05, 1), w, h));
      return { k: 'rect' };
    }
  }
}

/** 선 종류 (a:prstDash) → Kite 도형의 선 종류 */
export function dashOf(v: string | null): string {
  if (!v || v === 'solid') return 'SOLID';
  if (v === 'dot' || v === 'sysDot') return 'DOT';
  if (v === 'dashDot' || v === 'sysDashDot' || v === 'lgDashDot') return 'DASH_DOT';
  if (v === 'lgDashDotDot' || v === 'sysDashDotDot') return 'DASH_DOT_DOT';
  if (v === 'lgDash') return 'LONG_DASH';
  return 'DASH';
}

/** 선 끝 모양 (a:headEnd·tailEnd type) → Kite 의 화살표 */
export function arrowOfEnd(el: Element | null): string | null {
  const t = attr(el, 'type');
  if (!t || t === 'none') return null;
  return t === 'triangle' ? 'ARROW' : t === 'stealth' ? 'SPEAR' : t === 'arrow' ? 'CONCAVE_ARROW' : t === 'diamond' ? 'DIAMOND' : t === 'oval' ? 'CIRCLE' : 'ARROW';
}
