/**
 * pdf.js 연산자 목록(getOperatorList)을 직접 해석해 페이지의 글자·채운 사각형·선·그림을 뽑는다.
 * 좌표는 모두 뷰포트 기준(pt, 왼쪽 위 원점, y는 아래로 증가)이다.
 */

export type Mat = [number, number, number, number, number, number];

export interface Glyph {
  ch: string;
  x: number;
  /** 기준선 y */
  y: number;
  /** 진행 폭 */
  w: number;
  size: number;
  font: string;
  /** pdf.js 글꼴 id (PDF 에 든 글꼴을 다시 쓰기 위해) */
  fid?: string;
  bold: boolean;
  italic: boolean;
  color: string;
  /** 자간 (% of size) */
  spacing: number;
  /** 장평 (%) */
  hscale: number;
  invisible: boolean;
}

export interface FillRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  color: string;
  /** 이미지 마스크 타일에서 온 것 */
  tile?: boolean;
  /** 그린 순서 (나중에 칠한 사각형이 먼저 그린 선을 가린다) */
  z?: number;
}

export interface Seg {
  /** 'h': y 고정, a..b 는 x 범위 / 'v': x 고정, a..b 는 y 범위 */
  dir: 'h' | 'v';
  pos: number;
  a: number;
  b: number;
  w: number;
  color: string;
  style?: 'solid' | 'dashed' | 'dotted';
  /** 그린 순서 */
  z?: number;
  /** 선이 아니라 배경색 경계에서 만든 칸 나눔 (테두리로 그리지 않는다) */
  ghost?: boolean;
}

export interface PdfImage {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** objs id 또는 인라인 이미지 데이터 */
  ref: string | any;
  /** 쪽에서 몇 번째 그림 그리기 명령인가 (그 그림만 다시 그릴 때 쓴다 — 그릴 때마다 id 가 바뀐다) */
  seq?: number;
  /** 표·밑줄·구분선에 쓰이지 않은 선 조각(체크 상자·괄호 선 등)을 살린 그림: 글 흐름을 밀지 않는 자리에만 놓는다 */
  stray?: boolean;
}

export interface PageContent {
  width: number;
  height: number;
  glyphs: Glyph[];
  fills: FillRect[];
  segs: Seg[];
  images: PdfImage[];
  /** 글꼴 id → (유니코드 코드 포인트 → pdf.js fontChar 코드 포인트) */
  fontChars?: Map<string, Map<number, number>>;
  /** 표·상자·선으로 옮기지 못한 도형(곡선·사선·다각형 — 화살표, 아이콘, 윤곽선 글씨 등)의 범위 */
  vectors?: { x0: number; y0: number; x1: number; y1: number; light: boolean }[];
}

export interface FontInfo {
  name: string;
  bold: boolean;
  italic: boolean;
  fontMatrix: number[];
  vertical: boolean;
}

/** 악의적인 PDF 로 계산이 폭주하지 않도록 페이지당 상한 */
const MAX_GLYPHS = 60000;
const MAX_SEGS = 40000;
const MAX_FILLS = 40000;
const MAX_VECTORS = 20000;

export const mul = (m1: number[], m2: number[]): Mat => [
  m1[0] * m2[0] + m1[1] * m2[2],
  m1[0] * m2[1] + m1[1] * m2[3],
  m1[2] * m2[0] + m1[3] * m2[2],
  m1[2] * m2[1] + m1[3] * m2[3],
  m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
  m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
];
const apply = (m: number[], x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

interface State {
  ctm: Mat;
  fill: string;
  /** 채우기가 패턴/그러데이션(색을 모름) — 그림으로 채운 도형 등 */
  fillPattern?: boolean;
  /** 마지막 잘라내기 경로의 범위 (그러데이션 채우기 영역) */
  clipBox?: { x0: number; y0: number; x1: number; y1: number } | null;
  stroke: string;
  fillAlpha: number;
  lineWidth: number;
  dash: number[];
  font: FontInfo | null;
  fontId: string;
  fontSize: number;
  charSpacing: number;
  wordSpacing: number;
  hScale: number;
  leading: number;
  render: number;
  rise: number;
  tm: Mat;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
}

const cloneState = (s: State): State => ({ ...s });

/**
 * @param OPS pdf.js 의 OPS 상수
 * @param getFont 글꼴 id → 정보
 * @param viewport 뷰포트 변환 행렬과 크기
 */
export function extractPage(ops: { fnArray: number[]; argsArray: any[] }, OPS: Record<string, number>, getFont: (id: string) => FontInfo | null, viewport: { transform: number[]; width: number; height: number }): PageContent {
  const glyphs: Glyph[] = [];
  const fills: FillRect[] = [];
  const segs: Seg[] = [];
  const images: PdfImage[] = [];
  const fontChars = new Map<string, Map<number, number>>();
  let imageSeq = 0;
  const vectors: { x0: number; y0: number; x1: number; y1: number; light: boolean }[] = [];
  let z = 0;
  const addVector = (b: { x0: number; y0: number; x1: number; y1: number }, pad: number, color = '#000000') => {
    if (vectors.length >= MAX_VECTORS || !isFinite(b.x0 + b.y0 + b.x1 + b.y1)) return;
    const r = { x0: clampX(b.x0 - pad), y0: clampY(b.y0 - pad), x1: clampX(b.x1 + pad), y1: clampY(b.y1 + pad) };
    if (r.x1 <= 0 || r.y1 <= 0 || r.x0 >= W || r.y0 >= H || r.x1 - r.x0 < 0.5 || r.y1 - r.y0 < 0.5) return;
    // 아주 연한 색(워터마크·바탕 장식)인지
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
    const light = !!m && (0.299 * parseInt(m[1], 16) + 0.587 * parseInt(m[2], 16) + 0.114 * parseInt(m[3], 16)) / 255 > 0.85;
    vectors.push({ ...r, light });
  };
  let st: State = {
    ctm: viewport.transform.slice(0, 6) as Mat,
    fill: '#000000',
    stroke: '#000000',
    fillAlpha: 1,
    lineWidth: 1,
    dash: [],
    font: null,
    fontId: '',
    fontSize: 10,
    charSpacing: 0,
    wordSpacing: 0,
    hScale: 1,
    leading: 0,
    render: 0,
    rise: 0,
    tm: [1, 0, 0, 1, 0, 0],
    x: 0,
    y: 0,
    lineX: 0,
    lineY: 0,
  };
  const stack: State[] = [];
  const W = viewport.width;
  const H = viewport.height;

  const unitRect = (m: number[]) => {
    const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  };

  const scaleOf = (m: number[]) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

  const clampX = (v: number) => Math.max(-10, Math.min(W + 10, v));
  const clampY = (v: number) => Math.max(-10, Math.min(H + 10, v));
  const addLine = (p: [number, number], q: [number, number], w: number, color: string) => {
    if (segs.length >= MAX_SEGS) return;
    if (!isFinite(p[0] + p[1] + q[0] + q[1])) return;
    p = [clampX(p[0]), clampY(p[1])];
    q = [clampX(q[0]), clampY(q[1])];
    const style: Seg['style'] = st.dash.length && st.dash.some((v) => v > 0) ? (st.dash[0] <= st.lineWidth * 2.5 ? 'dotted' : 'dashed') : 'solid';
    const dx = Math.abs(p[0] - q[0]);
    const dy = Math.abs(p[1] - q[1]);
    // 점선을 아주 짧은 조각(0.3pt 안팎)으로 그리는 경우도 있다
    if (dy < 0.8 && dx > 0.15 && dx >= dy) segs.push({ dir: 'h', pos: (p[1] + q[1]) / 2, a: Math.min(p[0], q[0]), b: Math.max(p[0], q[0]), w, color, style, z: z++ });
    else if (dx < 0.8 && dy > 0.15 && dy > dx) segs.push({ dir: 'v', pos: (p[0] + q[0]) / 2, a: Math.min(p[1], q[1]), b: Math.max(p[1], q[1]), w, color, style, z: z++ });
  };

  const addFillRect = (r0: { x0: number; y0: number; x1: number; y1: number }, color: string, tile = false) => {
    if (fills.length >= MAX_FILLS || !isFinite(r0.x0 + r0.y0 + r0.x1 + r0.y1)) return;
    const r = { x0: clampX(r0.x0), y0: clampY(r0.y0), x1: clampX(r0.x1), y1: clampY(r0.y1) };
    const w = r.x1 - r.x0;
    const h = r.y1 - r.y0;
    if (w <= 0 || h <= 0) return;
    if (r.x1 < 0 || r.y1 < 0 || r.x0 > W || r.y0 > H) return;
    // 가는 사각형은 선으로 본다
    if (!tile && h <= 2.2 && w > 2.5) segs.push({ dir: 'h', pos: (r.y0 + r.y1) / 2, a: r.x0, b: r.x1, w: h, color, z: z++ });
    else if (!tile && w <= 2.2 && h > 2.5) segs.push({ dir: 'v', pos: (r.x0 + r.x1) / 2, a: r.y0, b: r.y1, w, color, z: z++ });
    else fills.push({ ...r, color, tile, z: z++ });
  };

  const doPath = (paintOp: number, data: ArrayLike<number> | null) => {
    if (!data) return;
    const isStroke = paintOp === OPS.stroke || paintOp === OPS.closeStroke || paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke || paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
    const isFill = paintOp === OPS.fill || paintOp === OPS.eoFill || paintOp === OPS.fillStroke || paintOp === OPS.eoFillStroke || paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke;
    if (!isStroke && !isFill) {
      // 잘라내기 경로: 뒤따르는 그러데이션 채우기(sh)의 영역으로 기억해 둔다
      if (paintOp === OPS.endPath) {
        const m = st.ctm;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (let i = 0; i < data.length; ) {
          const op = data[i++];
          const n = op === 0 || op === 1 ? 2 : op === 2 ? 6 : op === 3 ? 4 : 0;
          for (let k = 0; k + 1 < n; k += 2) {
            const [px, py] = apply(m, data[i + k], data[i + k + 1]);
            x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py);
          }
          i += n;
          if (op > 4) break;
        }
        if (isFinite(x0 + y0 + x1 + y1)) st.clipBox = { x0, y0, x1, y1 };
      }
      return;
    }
    // 하위 경로로 나눈다
    const subs: { pts: [number, number][]; curve: boolean; closed: boolean }[] = [];
    let cur: { pts: [number, number][]; curve: boolean; closed: boolean } | null = null;
    const m = st.ctm;
    for (let i = 0; i < data.length; ) {
      const op = data[i++];
      if (op === 0) {
        cur = { pts: [apply(m, data[i], data[i + 1])], curve: false, closed: false };
        subs.push(cur);
        i += 2;
      } else if (op === 1) {
        cur?.pts.push(apply(m, data[i], data[i + 1]));
        i += 2;
      } else if (op === 2) {
        if (cur) {
          cur.curve = true;
          cur.pts.push(apply(m, data[i + 4], data[i + 5]));
        }
        i += 6;
      } else if (op === 3) {
        if (cur) {
          cur.curve = true;
          cur.pts.push(apply(m, data[i + 2], data[i + 3]));
        }
        i += 4;
      } else if (op === 4) {
        if (cur) cur.closed = true;
      } else break;
    }
    const lw = Math.max(0.1, st.lineWidth * scaleOf(m));
    // 테두리 고리: 바깥 사각형 안에 안쪽 사각형을 겹쳐 칠한 경로 (WeasyPrint 등은 상자 테두리를 이렇게 그린다).
    // 짝홀 규칙이든 반대 방향 감기든 실제로 칠해지는 곳은 두 사각형 사이의 띠뿐이므로, 네 변의 띠로 옮긴다
    // (꽉 찬 사각형 두 개로 보면 상자 전체가 검게 칠해진다)
    if (isFill && !isStroke && subs.length === 2 && st.fill !== 'transparent' && st.fillAlpha > 0.15) {
      const box = (sp: (typeof subs)[number]) => {
        if (sp.curve || sp.pts.length < 4 || sp.pts.length > 5) return null;
        const xs = sp.pts.map((p) => p[0]);
        const ys = sp.pts.map((p) => p[1]);
        const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
        return sp.pts.every((p) => (Math.abs(p[0] - b.x0) < 0.3 || Math.abs(p[0] - b.x1) < 0.3) && (Math.abs(p[1] - b.y0) < 0.3 || Math.abs(p[1] - b.y1) < 0.3)) ? b : null;
      };
      let o = box(subs[0]);
      let i = box(subs[1]);
      if (o && i && i.x0 - o.x0 < 0 && i.y0 - o.y0 < 0) [o, i] = [i, o];
      if (o && i && i.x0 >= o.x0 - 0.05 && i.y0 >= o.y0 - 0.05 && i.x1 <= o.x1 + 0.05 && i.y1 <= o.y1 + 0.05 && (i.x1 - i.x0) * (i.y1 - i.y0) < (o.x1 - o.x0) * (o.y1 - o.y0) * 0.999) {
        const band = (x0: number, y0: number, x1: number, y1: number) => {
          if (x1 - x0 > 0.05 && y1 - y0 > 0.05) addFillRect({ x0, y0, x1, y1 }, st.fill);
        };
        band(o.x0, o.y0, o.x1, i.y0); // 위
        band(o.x0, i.y1, o.x1, o.y1); // 아래
        band(o.x0, i.y0, i.x0, i.y1); // 왼쪽
        band(i.x1, i.y0, o.x1, i.y1); // 오른쪽
        return;
      }
    }
    for (const s of subs) {
      if (s.pts.length < 2) continue;
      const xs = s.pts.map((p) => p[0]);
      const ys = s.pts.map((p) => p[1]);
      const bb = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
      const isRect = !s.curve && s.pts.length >= 4 && s.pts.length <= 5 && s.pts.every((p) => (Math.abs(p[0] - bb.x0) < 0.3 || Math.abs(p[0] - bb.x1) < 0.3) && (Math.abs(p[1] - bb.y0) < 0.3 || Math.abs(p[1] - bb.y1) < 0.3));
      const big = bb.x1 - bb.x0 > 12 && bb.y1 - bb.y0 > 8;
      // 패턴/그러데이션으로 칠한 도형(그림 채우기·그러데이션 상자): 색을 몰라 상자로는 못 옮기므로 그림으로
      if (isFill && st.fill === 'transparent' && st.fillPattern && st.fillAlpha > 0.15) addVector(bb, 0);
      if (isFill && st.fill !== 'transparent' && st.fillAlpha > 0.15) {
        if (isRect || (s.curve && big && (s.closed || s.pts.length > 4))) addFillRect(bb, st.fill);
        // 작은 곡선·다각형 채우기(화살표, 아이콘, 윤곽선 글씨): 그림으로 살린다
        else addVector(bb, 0.5, st.fill);
      }
      if (isStroke && st.stroke !== 'transparent') {
        if (s.curve) {
          // 둥근 모서리 상자 등: 바깥 사각형으로 본다
          if (big && (s.closed || Math.hypot(s.pts[0][0] - s.pts[s.pts.length - 1][0], s.pts[0][1] - s.pts[s.pts.length - 1][1]) < 2)) {
            addLine([bb.x0, bb.y0], [bb.x1, bb.y0], lw, st.stroke);
            addLine([bb.x0, bb.y1], [bb.x1, bb.y1], lw, st.stroke);
            addLine([bb.x0, bb.y0], [bb.x0, bb.y1], lw, st.stroke);
            addLine([bb.x1, bb.y0], [bb.x1, bb.y1], lw, st.stroke);
          } else addVector(bb, lw / 2 + 0.5, st.stroke);
          continue;
        }
        for (let k = 1; k < s.pts.length; k++) {
          const p = s.pts[k - 1];
          const q = s.pts[k];
          const dx = Math.abs(p[0] - q[0]);
          const dy = Math.abs(p[1] - q[1]);
          // 아주 조금 기운 긴 선(쪽 높이에 2pt 쯤 기운 단 구분선 등)은 곧은 선으로 본다: 그림으로 두면 그 높이만큼 자리를 차지해 글을 밀어낸다
          if (dx >= 0.8 && dy >= 0.8 && Math.min(dx, dy) < 3 && Math.min(dx, dy) < Math.max(dx, dy) * 0.01) {
            if (dx < dy) {
              const x = (p[0] + q[0]) / 2;
              addLine([x, p[1]], [x, q[1]], lw, st.stroke);
            } else {
              const y = (p[1] + q[1]) / 2;
              addLine([p[0], y], [q[0], y], lw, st.stroke);
            }
          }
          // 사선(가로·세로가 아닌 선)은 표·밑줄로 옮길 수 없으므로 그림으로
          else if (dx >= 0.8 && dy >= 0.8) addVector({ x0: Math.min(p[0], q[0]), y0: Math.min(p[1], q[1]), x1: Math.max(p[0], q[0]), y1: Math.max(p[1], q[1]) }, lw / 2 + 0.5, st.stroke);
          else addLine(p, q, lw, st.stroke);
        }
        if (s.closed || paintOp === OPS.closeStroke || paintOp === OPS.closeFillStroke || paintOp === OPS.closeEOFillStroke) addLine(s.pts[s.pts.length - 1], s.pts[0], lw, st.stroke);
      }
    }
  };

  const showText = (arr: any[]) => {
    const font = st.font;
    if (!font || !arr) return;
    const fs = st.fontSize;
    if (!fs) return;
    const fm = font.fontMatrix || [0.001, 0, 0, 0.001, 0, 0];
    const M = mul(st.tm, st.ctm);
    // 회전된 글자(워터마크 등)는 건너뛴다
    const dirX = M[0];
    const dirY = M[1];
    const rotated = Math.abs(dirY) > Math.abs(dirX) * 0.18;
    const sizeDev = Math.hypot(M[2], M[3]) * Math.abs(fs);
    const xScale = Math.hypot(M[0], M[1]);
    const hs = st.hScale;
    const bold = font.bold || st.render === 2 || st.render === 6;
    const invisible = st.render === 3 || st.render === 7;
    const color = st.render === 1 || st.render === 5 ? st.stroke : st.fill;
    const spacingPct = fs ? Math.round(((st.charSpacing * hs) / Math.abs(fs)) * 100) : 0;
    let x = 0;
    for (const g of arr) {
      if (typeof g === 'number') {
        x -= (g * fs) / 1000;
        continue;
      }
      if (!g) continue;
      const spacing = (g.isSpace ? st.wordSpacing : 0) + st.charSpacing;
      const adv = (g.width || 0) * fm[0] * fs + spacing;
      if (!rotated) {
        const [px, py] = apply(M, st.x + x * hs, st.y + st.rise);
        // 아래아(U+119E, 조합용 자모)로 쓴 가운뎃점은 호환 자모 ㆍ로
        // 제어·서식 문자(폭 없는 공백, BOM 등)는 버린다: 화면 폭이 PDF 와 달라 위치 계산을 흐트러뜨린다
        const ch = typeof g.unicode === 'string' ? g.unicode.replace(/\u119E/g, '\u318D').replace(/[\p{Cc}\p{Cf}]/gu, '') : '';
        if (ch && glyphs.length < MAX_GLYPHS && px > -5 && px < W + 5 && py > -5 && py < H + 5) {
          // 글자 하나 = 코드 포인트 하나일 때만 (합자 fi 등은 글꼴 문자 표에 넣지 않는다)
          if (st.fontId && typeof g.fontChar === 'string' && g.fontChar && !invisible) {
            const u = ch.codePointAt(0)!;
            const fc = g.fontChar.codePointAt(0)!;
            if (ch.length === (u > 0xffff ? 2 : 1) && g.fontChar.length === (fc > 0xffff ? 2 : 1)) {
              let m = fontChars.get(st.fontId);
              if (!m) fontChars.set(st.fontId, (m = new Map()));
              if (!m.has(u)) m.set(u, fc);
              // 원래 글자가 아래아(U+119E)였으면 그 코드도 같은 글리프로
              if (g.unicode !== ch && g.unicode.length === 1 && !m.has(g.unicode.codePointAt(0))) m.set(g.unicode.codePointAt(0), fc);
            }
          }
          glyphs.push({
            ch,
            x: px,
            y: py,
            w: Math.abs(((g.width || 0) * fm[0] * fs + spacing) * hs * xScale),
            size: sizeDev,
            font: font.name,
            fid: st.fontId || undefined,
            bold,
            italic: font.italic,
            color,
            spacing: spacingPct,
            hscale: Math.round(hs * 100),
            invisible,
          });
        }
      }
      x += adv;
    }
    st.x += x * hs;
  };

  const { fnArray, argsArray } = ops;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const a = argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(cloneState(st));
        break;
      case OPS.restore:
        if (stack.length) st = stack.pop()!;
        break;
      case OPS.transform:
        st.ctm = mul(a, st.ctm);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(cloneState(st));
        if (Array.isArray(a?.[0]) || ArrayBuffer.isView(a?.[0])) st.ctm = mul(Array.from(a[0] as number[]), st.ctm);
        break;
      case OPS.paintFormXObjectEnd:
        if (stack.length) st = stack.pop()!;
        break;
      case OPS.beginGroup:
        stack.push(cloneState(st));
        if (a?.[0]?.matrix) st.ctm = mul(Array.from(a[0].matrix as number[]), st.ctm);
        break;
      case OPS.endGroup:
        if (stack.length) st = stack.pop()!;
        break;
      case OPS.setLineWidth:
        st.lineWidth = a[0];
        break;
      case OPS.setDash:
        st.dash = Array.isArray(a?.[0]) ? a[0] : [];
        break;
      case OPS.setFillRGBColor:
        st.fill = typeof a[0] === 'string' ? a[0] : rgbHex(a);
        st.fillPattern = false;
        break;
      case OPS.setStrokeRGBColor:
        st.stroke = typeof a[0] === 'string' ? a[0] : rgbHex(a);
        break;
      case OPS.setFillTransparent:
        st.fill = 'transparent';
        st.fillPattern = false;
        break;
      case OPS.setStrokeTransparent:
        st.stroke = 'transparent';
        break;
      case OPS.setFillColorN:
        // 패턴/음영 채우기: 색을 알 수 없다
        if (typeof a?.[0] === 'string' && /^#/.test(a[0])) {
          st.fill = a[0];
          st.fillPattern = false;
        } else if (a?.[0] === 'TilingPattern' || a?.[0] === 'Shading' || Array.isArray(a?.[0])) {
          st.fill = 'transparent';
          st.fillPattern = true;
        }
        break;
      case OPS.shadingFill:
        // sh: 잘라내기 영역 안을 그러데이션으로 칠한다
        if (st.clipBox) addVector(st.clipBox, 0);
        break;
      case OPS.setGState:
        for (const [k, v] of (a?.[0] || []) as [string, any][]) {
          if (k === 'LW') st.lineWidth = v;
          else if (k === 'D' && Array.isArray(v)) st.dash = Array.isArray(v[0]) ? v[0] : [];
          else if (k === 'ca') st.fillAlpha = v;
          else if (k === 'Font' && Array.isArray(v)) {
            const f = typeof v[0] === 'string' ? getFont(v[0]) : null;
            if (f) {
              st.font = f;
              st.fontId = v[0];
            }
            st.fontSize = v[1];
          }
        }
        break;
      case OPS.constructPath: {
        const d = a?.[1]?.[0];
        doPath(a[0], d && typeof d === 'object' && 'length' in d ? d : null);
        break;
      }
      case OPS.beginText:
        st.tm = [1, 0, 0, 1, 0, 0];
        st.x = st.y = st.lineX = st.lineY = 0;
        break;
      case OPS.setFont: {
        const f = getFont(a[0]);
        st.font = f;
        st.fontId = a[0];
        st.fontSize = a[1] < 0 ? -a[1] : a[1];
        break;
      }
      case OPS.setCharSpacing:
        st.charSpacing = a[0];
        break;
      case OPS.setWordSpacing:
        st.wordSpacing = a[0];
        break;
      case OPS.setHScale:
        st.hScale = a[0] / 100;
        break;
      case OPS.setLeading:
        st.leading = -a[0];
        break;
      case OPS.setTextRenderingMode:
        st.render = a[0];
        break;
      case OPS.setTextRise:
        st.rise = a[0];
        break;
      case OPS.moveText:
        st.x = st.lineX += a[0];
        st.y = st.lineY += a[1];
        break;
      case OPS.setLeadingMoveText:
        st.leading = a[1];
        st.x = st.lineX += a[0];
        st.y = st.lineY += a[1];
        break;
      case OPS.setTextMatrix: {
        const m = a.length === 1 ? a[0] : a;
        st.tm = Array.from(m as number[]) as Mat;
        st.x = st.y = st.lineX = st.lineY = 0;
        break;
      }
      case OPS.nextLine:
        st.x = st.lineX += 0;
        st.y = st.lineY += st.leading;
        break;
      case OPS.showText:
      case OPS.showSpacedText:
        showText(a[0]);
        break;
      case OPS.nextLineShowText:
        st.x = st.lineX;
        st.y = st.lineY += st.leading;
        showText(a[0]);
        break;
      case OPS.nextLineSetSpacingShowText:
        st.wordSpacing = a[0];
        st.charSpacing = a[1];
        st.x = st.lineX;
        st.y = st.lineY += st.leading;
        showText(a[2]);
        break;
      case OPS.paintImageMaskXObject:
      case OPS.paintSolidColorImageMask:
      case OPS.paintImageMaskXObjectRepeat: {
        if (st.fill === 'transparent') break;
        const img = a?.[0];
        if (fn === OPS.paintImageMaskXObject && img && !isSolidMask(img)) break;
        addFillRect(unitRect(st.ctm), st.fill, true);
        break;
      }
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageXObjectRepeat: {
        const seq = imageSeq++;
        const r = unitRect(st.ctm);
        if (r.x1 - r.x0 < 4 || r.y1 - r.y0 < 4 || images.length >= 500 || !isFinite(r.x0 + r.y0 + r.x1 + r.y1)) break;
        images.push({ ...r, ref: a[0], seq });
        break;
      }
    }
  }
  return { width: W, height: H, glyphs, fills, segs, images: dropGlyphImages(images, glyphs), fontChars, vectors };
}

/**
 * 글자 자리에 겹쳐 놓인 글자 모양 그림을 뺀다. 한글이 만든 PDF 는 글꼴에 없는 기호(｢ ｣ 등)를
 * 빈 Type3 글자(검색·복사용) + 같은 자리의 작은 그림(보이는 모양)으로 넣는다. 글자를 살리고 그림을 빼야
 * 기호가 두 번 그려지지 않고 그림이 따로 줄을 차지하지 않는다.
 */
function dropGlyphImages<T extends { x0: number; y0: number; x1: number; y1: number }>(images: T[], glyphs: { ch: string; x: number; y: number; w: number; size: number; font: string }[]): T[] {
  const t3 = glyphs.filter((g) => g.font === 'Type3' && g.ch.trim());
  if (!t3.length) return images;
  return images.filter((im) => {
    const w = im.x1 - im.x0;
    const h = im.y1 - im.y0;
    const cx = (im.x0 + im.x1) / 2;
    const cy = (im.y0 + im.y1) / 2;
    return !t3.some(
      (g) =>
        h <= g.size * 1.6 &&
        h >= g.size * 0.5 &&
        w <= g.size * 1.6 &&
        cy >= g.y - g.size && cy <= g.y + g.size * 0.3 &&
        cx >= g.x - g.size * 0.5 && cx <= g.x + Math.max(g.w, g.size),
    );
  });
}

function rgbHex(a: number[]): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + h(a[0]) + h(a[1]) + h(a[2]);
}

/** 마스크 대부분이 칠해지는(또는 비는) 단색 타일인지 */
function isSolidMask(img: any): boolean {
  const d: Uint8Array | undefined = img?.data;
  if (!d || !img.width || !img.height) return true;
  const rowBytes = Math.ceil(img.width / 8);
  if (d.length < rowBytes * img.height) return true;
  let ones = 0;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) if ((d[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) ones++;
  const frac = ones / (img.width * img.height);
  return frac > 0.9 || frac < 0.1;
}
