/**
 * 윈도 메타파일(WMF·EMF)을 SVG 로 그린다. 문서에 든 그림(클립아트·차트·수식 미리 보기)과 OLE 개체의 표시 데이터에 쓴다.
 *
 * 그리는 것: 펜·붓·글꼴, 선·다각형·여러 다각형·사각형·둥근 사각형·타원·호·현·부채꼴·베지어, 경로(BeginPath…FillPath),
 * 글자(TextOut·ExtTextOut, 글꼴 문자 집합에 맞춘 글자 풀기), 비트맵(DIB), 창·뷰포트 좌표 대응과 EMF 의 월드 변환.
 * 그리지 않는 것: 영역 자르기(클립), 래스터 연산, 무늬 붓의 그림, EMF+ (같이 든 EMF 기록으로 그린다).
 *
 * 문서에서 온 바이트이므로 모든 길이·자리를 범위 안에서만 읽고, 기록 수와 출력 크기에 상한을 둔다. 읽을 수 없으면 null.
 */
import { bytesToBase64 } from './common';
import { dibToBmp } from './olePreview';

const MAX_RECORDS = 200000;
const MAX_SVG = 8 * 1024 * 1024;

const u16 = (d: Uint8Array, o: number) => (o >= 0 && o + 2 <= d.length ? d[o] | (d[o + 1] << 8) : 0);
const i16 = (d: Uint8Array, o: number) => {
  const v = u16(d, o);
  return v & 0x8000 ? v - 0x10000 : v;
};
const u32 = (d: Uint8Array, o: number) => (o >= 0 && o + 4 <= d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);
const i32 = (d: Uint8Array, o: number) => (o >= 0 && o + 4 <= d.length ? d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24) : 0);
const f32 = (d: Uint8Array, o: number) => (o >= 0 && o + 4 <= d.length ? new DataView(d.buffer, d.byteOffset + o, 4).getFloat32(0, true) : 0);
const r2 = (v: number) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : 0);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** COLORREF (0x00BBGGRR) → #RRGGBB */
const colorRef = (v: number) => '#' + [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff].map((c) => c.toString(16).padStart(2, '0')).join('');

/** 글꼴 문자 집합 → 글자 풀기 이름 */
function decoderFor(charset: number): TextDecoder {
  const name = ({ 129: 'euc-kr', 130: 'euc-kr', 128: 'shift_jis', 134: 'gbk', 136: 'big5', 204: 'windows-1251', 161: 'windows-1253', 162: 'windows-1254', 177: 'windows-1255', 178: 'windows-1256', 186: 'windows-1257', 238: 'windows-1250', 222: 'windows-874', 163: 'windows-1258' } as Record<number, string>)[charset] || 'windows-1252';
  try {
    return new TextDecoder(name);
  } catch {
    return new TextDecoder('windows-1252');
  }
}

interface Pen {
  k: 'pen';
  /** null: 긋지 않음 */
  color: string | null;
  /** 논리 단위 굵기 (0 이면 1 화소) */
  width: number;
  dash: string | null;
}
interface Brush {
  k: 'brush';
  /** null: 칠하지 않음 */
  color: string | null;
}
interface Font {
  k: 'font';
  height: number;
  weight: number;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  face: string;
  charset: number;
  /** 기울기 (0.1도) */
  esc: number;
}
type GObj = Pen | Brush | Font | { k: 'other' };

interface DC {
  pen: Pen;
  brush: Brush;
  font: Font;
  textColor: string;
  bkColor: string;
  bkOpaque: boolean;
  textAlign: number;
  evenOdd: boolean;
  mapMode: number;
  wo: [number, number];
  we: [number, number];
  vo: [number, number];
  ve: [number, number];
  /** EMF 월드 변환 [a, b, c, d, e, f] */
  xf: number[];
  pos: [number, number];
}

const BLACK_PEN: Pen = { k: 'pen', color: '#000000', width: 0, dash: null };
const WHITE_BRUSH: Brush = { k: 'brush', color: '#ffffff' };
const DEFAULT_FONT: Font = { k: 'font', height: -12, weight: 400, italic: false, underline: false, strike: false, face: 'sans-serif', charset: 0, esc: 0 };

/** 그리는 곳: 논리 좌표 → 출력 화소 좌표, SVG 조각 모으기 */
class Canvas {
  parts: string[] = [];
  size = 0;
  dc: DC;
  stack: DC[] = [];
  objs: (GObj | null)[] = [];
  /** 지금 만드는 경로 (BeginPath 와 EndPath 사이) */
  path: string[] | null = null;
  /** 끝난 경로 (FillPath 등을 기다린다) */
  donePath: string | null = null;
  constructor(
    /** 장치 좌표 → 출력 화소 */
    public dev: (x: number, y: number) => [number, number],
    /** 장치 단위 1 의 출력 화소 크기 (굵기·글자 크기) */
    public devScale: number,
    initial: Partial<DC>,
  ) {
    this.dc = { pen: BLACK_PEN, brush: WHITE_BRUSH, font: DEFAULT_FONT, textColor: '#000000', bkColor: '#ffffff', bkOpaque: true, textAlign: 0, evenOdd: true, mapMode: 1, wo: [0, 0], we: [1, 1], vo: [0, 0], ve: [1, 1], xf: [1, 0, 0, 1, 0, 0], pos: [0, 0], ...initial };
  }
  /** 장치 단위 크기 (EMF 의 고정 단위 대응: metric 단위 → 장치 화소) */
  unitPx = 1;
  /** 논리 좌표 → 출력 화소 */
  pt(x: number, y: number): [number, number] {
    const d = this.dc;
    const [a, b, c, e, f, g] = d.xf;
    const wx = x * a + y * c + f;
    const wy = x * b + y * e + g;
    let dx: number;
    let dy: number;
    if (d.mapMode === 1) {
      dx = wx - d.wo[0] + d.vo[0];
      dy = wy - d.wo[1] + d.vo[1];
    } else if (d.mapMode === 7 || d.mapMode === 8) {
      let sx = d.we[0] ? d.ve[0] / d.we[0] : 1;
      let sy = d.we[1] ? d.ve[1] / d.we[1] : 1;
      if (d.mapMode === 8) {
        // 같은 비율: 작은 쪽에 맞춘다 (방향은 그대로)
        const m = Math.min(Math.abs(sx), Math.abs(sy));
        sx = Math.sign(sx || 1) * m;
        sy = Math.sign(sy || 1) * m;
      }
      dx = (wx - d.wo[0]) * sx + d.vo[0];
      dy = (wy - d.wo[1]) * sy + d.vo[1];
    } else {
      // 고정 단위(0.1mm·0.01mm·0.01in·0.001in·twip): 위로 갈수록 y 가 크다
      const u = this.unitPx * ({ 2: 0.1, 3: 0.01, 4: 0.254, 5: 0.0254, 6: 25.4 / 1440 } as Record<number, number>)[d.mapMode]!;
      dx = (wx - d.wo[0]) * u + d.vo[0];
      dy = -(wy - d.wo[1]) * u + d.vo[1];
    }
    return this.dev(dx, dy);
  }
  /** 논리 길이 → 출력 화소 길이 (가로 기준) */
  len(v: number): number {
    const [x0, y0] = this.pt(0, 0);
    const [x1, y1] = this.pt(v, 0);
    return Math.hypot(x1 - x0, y1 - y0);
  }
  lenY(v: number): number {
    const [x0, y0] = this.pt(0, 0);
    const [x1, y1] = this.pt(0, v);
    return Math.hypot(x1 - x0, y1 - y0);
  }
  push(s: string) {
    if (this.size > MAX_SVG) return;
    this.size += s.length;
    this.parts.push(s);
  }
  strokeAttr(): string {
    const p = this.dc.pen;
    if (!p.color) return 'stroke="none"';
    const w = p.width > 0 ? Math.max(0.3, this.len(p.width)) : 1;
    return `stroke="${p.color}" stroke-width="${r2(w)}"${p.dash ? ` stroke-dasharray="${p.dash}"` : ''} stroke-linejoin="round"`;
  }
  fillAttr(): string {
    const b = this.dc.brush;
    return b.color ? `fill="${b.color}"${this.dc.evenOdd ? ' fill-rule="evenodd"' : ''}` : 'fill="none"';
  }
  /** 도형 그리기 (경로를 만드는 중이면 경로에 더한다) */
  shape(d: string, fill: boolean) {
    if (!d) return;
    if (this.path) {
      this.path.push(d);
      return;
    }
    this.push(`<path d="${d}" ${fill ? this.fillAttr() : 'fill="none"'} ${this.strokeAttr()}/>`);
  }
  polyD(pts: number[], close: boolean): string {
    if (pts.length < 4) return '';
    let s = '';
    for (let i = 0; i + 1 < pts.length; i += 2) {
      const [x, y] = this.pt(pts[i], pts[i + 1]);
      s += (i ? 'L' : 'M') + r2(x) + ' ' + r2(y);
    }
    return close ? s + 'Z' : s;
  }
  /** 사각형 상자의 타원 위 각 θ 의 점 (호·현·부채꼴) */
  ellipse(l: number, t: number, r: number, b: number) {
    const [x0, y0] = this.pt(l, t);
    const [x1, y1] = this.pt(r, b);
    return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, rx: Math.abs(x1 - x0) / 2, ry: Math.abs(y1 - y0) / 2 };
  }
  rect(l: number, t: number, r: number, b: number) {
    const [x0, y0] = this.pt(l, t);
    const [x1, y1] = this.pt(r, b);
    this.shape(`M${r2(x0)} ${r2(y0)}H${r2(x1)}V${r2(y1)}H${r2(x0)}Z`, true);
  }
  roundRect(l: number, t: number, r: number, b: number, w: number, h: number) {
    const [x0, y0] = this.pt(l, t);
    const [x1, y1] = this.pt(r, b);
    const rx = Math.min(Math.abs(x1 - x0) / 2, this.len(w) / 2);
    const ry = Math.min(Math.abs(y1 - y0) / 2, this.lenY(h) / 2);
    const X0 = Math.min(x0, x1);
    const Y0 = Math.min(y0, y1);
    const X1 = Math.max(x0, x1);
    const Y1 = Math.max(y0, y1);
    this.shape(`M${r2(X0 + rx)} ${r2(Y0)}H${r2(X1 - rx)}A${r2(rx)} ${r2(ry)} 0 0 1 ${r2(X1)} ${r2(Y0 + ry)}V${r2(Y1 - ry)}A${r2(rx)} ${r2(ry)} 0 0 1 ${r2(X1 - rx)} ${r2(Y1)}H${r2(X0 + rx)}A${r2(rx)} ${r2(ry)} 0 0 1 ${r2(X0)} ${r2(Y1 - ry)}V${r2(Y0 + ry)}A${r2(rx)} ${r2(ry)} 0 0 1 ${r2(X0 + rx)} ${r2(Y0)}Z`, true);
  }
  ellipseShape(l: number, t: number, r: number, b: number) {
    const e = this.ellipse(l, t, r, b);
    this.shape(`M${r2(e.cx - e.rx)} ${r2(e.cy)}A${r2(e.rx)} ${r2(e.ry)} 0 1 0 ${r2(e.cx + e.rx)} ${r2(e.cy)}A${r2(e.rx)} ${r2(e.ry)} 0 1 0 ${r2(e.cx - e.rx)} ${r2(e.cy)}Z`, true);
  }
  /** 호(kind 0)·현(1)·부채꼴(2): 시작점에서 끝점까지 시계 반대 방향 */
  arc(l: number, t: number, r: number, b: number, xs: number, ys: number, xe: number, ye: number, kind: number) {
    const e = this.ellipse(l, t, r, b);
    if (!(e.rx > 0 && e.ry > 0)) return;
    const [sx, sy] = this.pt(xs, ys);
    const [ex, ey] = this.pt(xe, ye);
    const a0 = Math.atan2((sy - e.cy) / e.ry, (sx - e.cx) / e.rx);
    const a1 = Math.atan2((ey - e.cy) / e.ry, (ex - e.cx) / e.rx);
    const p0 = [e.cx + e.rx * Math.cos(a0), e.cy + e.ry * Math.sin(a0)];
    const p1 = [e.cx + e.rx * Math.cos(a1), e.cy + e.ry * Math.sin(a1)];
    // 화면 좌표(아래로 y)에서 시계 반대 방향 = 각이 줄어드는 쪽
    let sweep = a0 - a1;
    while (sweep <= 0) sweep += Math.PI * 2;
    const large = sweep > Math.PI ? 1 : 0;
    let d = `M${r2(p0[0])} ${r2(p0[1])}A${r2(e.rx)} ${r2(e.ry)} 0 ${large} 0 ${r2(p1[0])} ${r2(p1[1])}`;
    if (kind === 1) d += 'Z';
    else if (kind === 2) d += `L${r2(e.cx)} ${r2(e.cy)}Z`;
    this.shape(d, kind !== 0);
  }
  /** 글자 한 줄: (x, y) 논리 좌표의 기준점, 글자 맞춤은 DC 의 것 */
  text(x: number, y: number, s: string) {
    s = s.replace(/[\u0000-\u001f]/g, '');
    if (!s.trim()) return;
    const d = this.dc;
    const f = d.font;
    let [px, py] = this.pt(x, y);
    if (d.textAlign & 1) [px, py] = this.pt(d.pos[0], d.pos[1]);
    // 글꼴 높이: 음수는 글자 크기(em), 양수는 칸 높이(글자 크기의 약 1.15 배)
    let size = this.lenY(Math.abs(f.height) || 12);
    if (f.height > 0) size /= 1.15;
    if (!(size > 0.5)) return;
    const h = d.textAlign & 6;
    const v = d.textAlign & 24;
    const anchor = h === 6 ? 'middle' : h === 2 ? 'end' : 'start';
    // 글자 기준점: 위(0)·아래(8)·바탕선(24)
    const dy = v === 24 ? 0 : v === 8 ? -size * 0.22 : size * 0.89;
    const rot = f.esc ? ` transform="rotate(${r2(-f.esc / 10)} ${r2(px)} ${r2(py)})"` : '';
    const deco = [f.underline ? 'underline' : '', f.strike ? 'line-through' : ''].filter(Boolean).join(' ');
    const family = esc(f.face || 'sans-serif') + ', sans-serif';
    this.push(
      `<text x="${r2(px)}" y="${r2(py + dy)}" font-family="${family}" font-size="${r2(size)}"${f.weight >= 600 ? ' font-weight="bold"' : ''}${f.italic ? ' font-style="italic"' : ''}${deco ? ` text-decoration="${deco}"` : ''} fill="${d.textColor}" text-anchor="${anchor}" xml:space="preserve"${rot}>${esc(s)}</text>`,
    );
  }
  /** DIB 비트맵을 (논리 상자에) 그린다 */
  image(d: Uint8Array, off: number, len: number, x: number, y: number, w: number, h: number) {
    const bmp = dibToBmp(d, off, len);
    if (!bmp) return;
    const [x0, y0] = this.pt(x, y);
    const [x1, y1] = this.pt(x + w, y + h);
    const W = Math.abs(x1 - x0);
    const H = Math.abs(y1 - y0);
    if (!(W > 0 && H > 0)) return;
    this.push(`<image x="${r2(Math.min(x0, x1))}" y="${r2(Math.min(y0, y1))}" width="${r2(W)}" height="${r2(H)}" preserveAspectRatio="none" href="data:image/bmp;base64,${bytesToBase64(bmp)}"/>`);
  }
  addObj(o: GObj): void {
    const i = this.objs.indexOf(null);
    if (i >= 0) this.objs[i] = o;
    else if (this.objs.length < 65535) this.objs.push(o);
  }
  select(o: GObj | null | undefined) {
    if (!o) return;
    if (o.k === 'pen') this.dc.pen = o;
    else if (o.k === 'brush') this.dc.brush = o;
    else if (o.k === 'font') this.dc.font = o;
  }
  save() {
    if (this.stack.length < 256) this.stack.push({ ...this.dc, pos: [...this.dc.pos] as [number, number], xf: [...this.dc.xf] });
  }
  restore(n: number) {
    // n < 0: 그만큼 거슬러, n > 0: 그 번째 상태로
    const k = n < 0 ? this.stack.length + n : n - 1;
    if (k < 0 || k >= this.stack.length) return;
    this.dc = this.stack[k];
    this.stack.length = k;
  }
  endPathFill(fill: boolean, stroke: boolean) {
    const d = this.donePath;
    this.donePath = null;
    if (!d) return;
    this.push(`<path d="${d}" ${fill ? this.fillAttr() : 'fill="none"'} ${stroke ? this.strokeAttr() : 'stroke="none"'}/>`);
  }
  svg(W: number, H: number): string | null {
    if (!this.parts.length || this.size > MAX_SVG) return null;
    const w = r2(W);
    const h = r2(H);
    const body = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" overflow="hidden">${this.parts.join('')}</svg>`;
    return 'data:image/svg+xml;base64,' + bytesToBase64(new TextEncoder().encode(body));
  }
}

/** 펜 종류 → 점선 */
function dashOf(style: number, w: number): string | null {
  const s = style & 0x0f;
  const u = Math.max(1, w);
  if (s === 1) return `${r2(u * 4)} ${r2(u * 2)}`;
  if (s === 2) return `${r2(u)} ${r2(u * 2)}`;
  if (s === 3) return `${r2(u * 4)} ${r2(u * 2)} ${r2(u)} ${r2(u * 2)}`;
  if (s === 4) return `${r2(u * 4)} ${r2(u * 2)} ${r2(u)} ${r2(u * 2)} ${r2(u)} ${r2(u * 2)}`;
  return null;
}

// ---------------- WMF ----------------

function wmfToSvg(d: Uint8Array): string | null {
  let o = 0;
  let bbox: [number, number, number, number] | null = null;
  let inch = 1440;
  if (u32(d, 0) === 0x9ac6cdd7) {
    // 놓을 자리가 적힌 머리(22 바이트): 상자와 인치당 단위
    bbox = [i16(d, 6), i16(d, 8), i16(d, 10), i16(d, 12)];
    inch = u16(d, 14) || 1440;
    o = 22;
  }
  const hdrWords = u16(d, o + 2);
  if (u16(d, o) > 2 || hdrWords !== 9) return null;
  o += hdrWords * 2;
  // 출력 크기 (px): 놓을 자리가 있으면 그 상자, 없으면 창 크기를 1440 단위/인치로 본다
  let W = bbox ? (Math.abs(bbox[2] - bbox[0]) / inch) * 96 : 0;
  let H = bbox ? (Math.abs(bbox[3] - bbox[1]) / inch) * 96 : 0;
  // 창이 정해지기 전에는 상자를 창으로
  const win = { ox: bbox ? Math.min(bbox[0], bbox[2]) : 0, oy: bbox ? Math.min(bbox[1], bbox[3]) : 0, ex: bbox ? Math.abs(bbox[2] - bbox[0]) || 1 : 1, ey: bbox ? Math.abs(bbox[3] - bbox[1]) || 1 : 1 };
  // 놓을 자리가 없으면 먼저 창 크기를 찾아 출력 크기를 정한다
  if (!bbox) {
    let p = o;
    for (let n = 0; n < MAX_RECORDS && p + 6 <= d.length; n++) {
      const size = u32(d, p) * 2;
      const fn = u16(d, p + 4);
      if (size < 6 || p + size > d.length) break;
      if (fn === 0x020c) {
        win.ey = i16(d, p + 6) || 1;
        win.ex = i16(d, p + 8) || 1;
      } else if (fn === 0x020b) {
        win.oy = i16(d, p + 6);
        win.ox = i16(d, p + 8);
      }
      if (fn === 0) break;
      p += size;
    }
    W = (Math.abs(win.ex) / 1440) * 96;
    H = (Math.abs(win.ey) / 1440) * 96;
  }
  if (!(W > 0.5 && H > 0.5 && W < 20000 && H < 20000)) return null;
  // 장치 좌표 = 창을 출력 상자에 맞춘 것 (창 → [0, W] × [0, H])
  const cv = new Canvas((x, y) => [x, y], 1, { mapMode: 8 });
  const setWin = () => {
    cv.dc.mapMode = 7;
    cv.dc.wo = [win.ox, win.oy];
    cv.dc.we = [win.ex, win.ey];
    cv.dc.vo = [0, 0];
    cv.dc.ve = [W, H];
  };
  setWin();
  const fontOf = (p: number, size: number): Font => {
    const faceBytes = d.subarray(p + 6 + 18, Math.min(p + size, p + 6 + 18 + 32));
    const z = faceBytes.indexOf(0);
    const charset = d[p + 6 + 14] ?? 0;
    return {
      k: 'font',
      height: i16(d, p + 6),
      esc: i16(d, p + 10),
      weight: i16(d, p + 14),
      italic: !!d[p + 16],
      underline: !!d[p + 17],
      strike: !!d[p + 18],
      charset,
      face: decoderFor(charset).decode(faceBytes.subarray(0, z >= 0 ? z : faceBytes.length)).trim(),
    };
  };
  const pts = (p: number, n: number) => {
    const out: number[] = [];
    for (let i = 0; i < n && p + i * 4 + 4 <= d.length; i++) out.push(i16(d, p + i * 4), i16(d, p + i * 4 + 2));
    return out;
  };
  let p = o;
  for (let n = 0; n < MAX_RECORDS && p + 6 <= d.length; n++) {
    const size = u32(d, p) * 2;
    const fn = u16(d, p + 4);
    if (size < 6 || p + size > d.length) break;
    const a = p + 6;
    switch (fn) {
      case 0x0000:
        n = MAX_RECORDS;
        break;
      case 0x020b: // SETWINDOWORG (y, x)
        win.oy = i16(d, a);
        win.ox = i16(d, a + 2);
        setWin();
        break;
      case 0x020c: // SETWINDOWEXT (y, x)
        win.ey = i16(d, a) || 1;
        win.ex = i16(d, a + 2) || 1;
        setWin();
        break;
      case 0x0211: // OFFSETWINDOWORG
        win.oy += i16(d, a);
        win.ox += i16(d, a + 2);
        setWin();
        break;
      case 0x0201: // SETBKCOLOR
        cv.dc.bkColor = colorRef(u32(d, a));
        break;
      case 0x0102: // SETBKMODE
        cv.dc.bkOpaque = u16(d, a) === 2;
        break;
      case 0x0209: // SETTEXTCOLOR
        cv.dc.textColor = colorRef(u32(d, a));
        break;
      case 0x012e: // SETTEXTALIGN
        cv.dc.textAlign = u16(d, a);
        break;
      case 0x0106: // SETPOLYFILLMODE
        cv.dc.evenOdd = u16(d, a) !== 2;
        break;
      case 0x02fa: {
        // CREATEPENINDIRECT: 종류, 굵기(x, y), 색
        const style = u16(d, a);
        const w = i16(d, a + 2);
        cv.addObj({ k: 'pen', color: (style & 0x0f) === 5 ? null : colorRef(u32(d, a + 6)), width: Math.abs(w), dash: dashOf(style, 1) });
        break;
      }
      case 0x02fc: {
        // CREATEBRUSHINDIRECT: 종류(0 단색, 1 없음, 2 빗금), 색, 빗금
        const style = u16(d, a);
        cv.addObj({ k: 'brush', color: style === 1 ? null : colorRef(u32(d, a + 2)) });
        break;
      }
      case 0x02fb: // CREATEFONTINDIRECT
        cv.addObj(fontOf(p, size));
        break;
      case 0x00f7: // CREATEPALETTE
      case 0x0142: // DIBCREATEPATTERNBRUSH
      case 0x01f9: // CREATEPATTERNBRUSH
      case 0x06ff: // CREATEREGION
        cv.addObj(fn === 0x0142 || fn === 0x01f9 ? { k: 'brush', color: '#808080' } : { k: 'other' });
        break;
      case 0x012d: // SELECTOBJECT
        cv.select(cv.objs[u16(d, a)]);
        break;
      case 0x01f0: {
        // DELETEOBJECT
        const i = u16(d, a);
        if (i < cv.objs.length) cv.objs[i] = null;
        break;
      }
      case 0x001e: // SAVEDC
        cv.save();
        break;
      case 0x0127: // RESTOREDC
        cv.restore(i16(d, a));
        break;
      case 0x0214: // MOVETO (y, x)
        cv.dc.pos = [i16(d, a + 2), i16(d, a)];
        break;
      case 0x0213: {
        // LINETO (y, x)
        const x = i16(d, a + 2);
        const y = i16(d, a);
        cv.shape(cv.polyD([cv.dc.pos[0], cv.dc.pos[1], x, y], false), false);
        cv.dc.pos = [x, y];
        break;
      }
      case 0x0325: // POLYLINE
        cv.shape(cv.polyD(pts(a + 2, u16(d, a)), false), false);
        break;
      case 0x0324: // POLYGON
        cv.shape(cv.polyD(pts(a + 2, u16(d, a)), true), true);
        break;
      case 0x0538: {
        // POLYPOLYGON: 다각형 수, 다각형마다 점 수, 점들
        const np = u16(d, a);
        let q = a + 2 + np * 2;
        let s = '';
        for (let i = 0; i < np && i < 4096; i++) {
          const c = u16(d, a + 2 + i * 2);
          s += cv.polyD(pts(q, c), true);
          q += c * 4;
        }
        cv.shape(s, true);
        break;
      }
      case 0x041b: // RECTANGLE (bottom, right, top, left)
        cv.rect(i16(d, a + 6), i16(d, a + 4), i16(d, a + 2), i16(d, a));
        break;
      case 0x061c: // ROUNDRECT (h, w, bottom, right, top, left)
        cv.roundRect(i16(d, a + 10), i16(d, a + 8), i16(d, a + 6), i16(d, a + 4), i16(d, a + 2), i16(d, a));
        break;
      case 0x0418: // ELLIPSE
        cv.ellipseShape(i16(d, a + 6), i16(d, a + 4), i16(d, a + 2), i16(d, a));
        break;
      case 0x0817: // ARC
      case 0x0830: // CHORD
      case 0x081a: // PIE (yEnd, xEnd, yStart, xStart, bottom, right, top, left)
        cv.arc(i16(d, a + 14), i16(d, a + 12), i16(d, a + 10), i16(d, a + 8), i16(d, a + 6), i16(d, a + 4), i16(d, a + 2), i16(d, a), fn === 0x0817 ? 0 : fn === 0x0830 ? 1 : 2);
        break;
      case 0x061d: {
        // PATBLT (rop, h, w, y, x): 붓으로 칠한 상자
        const h = i16(d, a + 4);
        const w = i16(d, a + 6);
        const y = i16(d, a + 8);
        const x = i16(d, a + 10);
        if (cv.dc.brush.color) {
          const [x0, y0] = cv.pt(x, y);
          const [x1, y1] = cv.pt(x + w, y + h);
          cv.push(`<rect x="${r2(Math.min(x0, x1))}" y="${r2(Math.min(y0, y1))}" width="${r2(Math.abs(x1 - x0))}" height="${r2(Math.abs(y1 - y0))}" fill="${cv.dc.brush.color}"/>`);
        }
        break;
      }
      case 0x0521: {
        // TEXTOUT: 글자 수, 글자(짝수 길이로), y, x
        const c = u16(d, a);
        const sb = d.subarray(a + 2, Math.min(a + 2 + c, p + size));
        const q = a + 2 + c + (c & 1);
        cv.text(i16(d, q + 2), i16(d, q), decoderFor(cv.dc.font.charset).decode(sb));
        break;
      }
      case 0x0a32: {
        // EXTTEXTOUT: y, x, 글자 수, 선택(ETO_OPAQUE 2·ETO_CLIPPED 4 이면 상자 8바이트), 글자
        const y = i16(d, a);
        const x = i16(d, a + 2);
        const c = u16(d, a + 4);
        const opt = u16(d, a + 6);
        let q = a + 8;
        if (opt & 6) {
          if (opt & 2 && cv.dc.bkOpaque !== false) {
            const [x0, y0] = cv.pt(i16(d, q), i16(d, q + 2));
            const [x1, y1] = cv.pt(i16(d, q + 4), i16(d, q + 6));
            if (Math.abs(x1 - x0) * Math.abs(y1 - y0) > 0) cv.push(`<rect x="${r2(Math.min(x0, x1))}" y="${r2(Math.min(y0, y1))}" width="${r2(Math.abs(x1 - x0))}" height="${r2(Math.abs(y1 - y0))}" fill="${cv.dc.bkColor}"/>`);
          }
          q += 8;
        }
        cv.text(x, y, decoderFor(cv.dc.font.charset).decode(d.subarray(q, Math.min(q + c, p + size))));
        break;
      }
      case 0x0b41: {
        // DIBSTRETCHBLT: rop(4), srcH, srcW, ySrc, xSrc, destH, destW, yDest, xDest, DIB
        const dh = i16(d, a + 12);
        const dw = i16(d, a + 14);
        const dy = i16(d, a + 16);
        const dx = i16(d, a + 18);
        cv.image(d, a + 20, p + size - (a + 20), dx, dy, dw, dh);
        break;
      }
      case 0x0f43: {
        // STRETCHDIB: rop(4), usage(2), srcH, srcW, ySrc, xSrc, destH, destW, yDest, xDest, DIB
        const dh = i16(d, a + 14);
        const dw = i16(d, a + 16);
        const dy = i16(d, a + 18);
        const dx = i16(d, a + 20);
        cv.image(d, a + 22, p + size - (a + 22), dx, dy, dw, dh);
        break;
      }
      case 0x0940: {
        // DIBBITBLT: rop(4), ySrc, xSrc, h, w, yDest, xDest, DIB
        const h = i16(d, a + 8);
        const w = i16(d, a + 10);
        const dy = i16(d, a + 12);
        const dx = i16(d, a + 14);
        if (size > 6 + 16 + 12) cv.image(d, a + 16, p + size - (a + 16), dx, dy, w, h);
        break;
      }
      default:
        break;
    }
    p += size;
  }
  return cv.svg(W, H);
}

// ---------------- EMF ----------------

/** EMF 의 재고 개체 (SelectObject 의 0x80000000 | 번호) */
function stockObject(i: number): GObj | null {
  switch (i) {
    case 0:
      return { k: 'brush', color: '#ffffff' };
    case 1:
      return { k: 'brush', color: '#c0c0c0' };
    case 2:
      return { k: 'brush', color: '#808080' };
    case 3:
      return { k: 'brush', color: '#404040' };
    case 4:
      return { k: 'brush', color: '#000000' };
    case 5:
      return { k: 'brush', color: null };
    case 6:
      return { k: 'pen', color: '#ffffff', width: 0, dash: null };
    case 7:
      return { k: 'pen', color: '#000000', width: 0, dash: null };
    case 8:
      return { k: 'pen', color: null, width: 0, dash: null };
    case 10:
    case 11:
    case 12:
    case 13:
    case 14:
    case 16:
    case 17:
      return DEFAULT_FONT;
    default:
      return null;
  }
}

function emfToSvg(d: Uint8Array): string | null {
  if (u32(d, 0) !== 1 || u32(d, 40) !== 0x464d4520) return null;
  // 머리: 테두리(장치 화소)·틀(0.01mm)·참조 장치 크기(화소·mm)
  const fl = i32(d, 24);
  const ft = i32(d, 28);
  const fr = i32(d, 32);
  const fb = i32(d, 36);
  const devW = i32(d, 72) || 1024;
  const devH = i32(d, 76) || 768;
  const mmW = i32(d, 80) || 320;
  const mmH = i32(d, 84) || 240;
  // 0.01mm 당 장치 화소
  const pxPerHmmX = devW / (mmW * 100);
  const pxPerHmmY = devH / (mmH * 100);
  let devL = fl * pxPerHmmX;
  let devT = ft * pxPerHmmY;
  let devR = fr * pxPerHmmX;
  let devB = fb * pxPerHmmY;
  // 틀이 비었으면 테두리(장치 화소)로
  if (!(devR > devL && devB > devT)) {
    devL = i32(d, 8);
    devT = i32(d, 12);
    devR = i32(d, 16);
    devB = i32(d, 20);
  }
  if (!(devR > devL && devB > devT)) return null;
  // 출력 크기: 틀이 있으면 그 크기(0.01mm → 화소), 없으면 장치 화소 그대로
  let W = fr > fl ? ((fr - fl) / 2540) * 96 : devR - devL;
  let H = fb > ft ? ((fb - ft) / 2540) * 96 : devB - devT;
  if (!(W > 0.5 && H > 0.5)) return null;
  if (W > 20000 || H > 20000) {
    const k = 20000 / Math.max(W, H);
    W *= k;
    H *= k;
  }
  const sx = W / (devR - devL);
  const sy = H / (devB - devT);
  const cv = new Canvas((x, y) => [(x - devL) * sx, (y - devT) * sy], (sx + sy) / 2, { mapMode: 1 });
  cv.unitPx = devW / mmW;
  const fontW = (q: number, end: number): Font => {
    const faceEnd = Math.min(end, q + 28 + 64);
    let face = '';
    for (let k = q + 28; k + 1 < faceEnd; k += 2) {
      const c = u16(d, k);
      if (!c) break;
      face += String.fromCharCode(c);
    }
    return { k: 'font', height: i32(d, q), esc: i32(d, q + 8), weight: i32(d, q + 16), italic: !!d[q + 20], underline: !!d[q + 21], strike: !!d[q + 22], charset: d[q + 23] ?? 0, face: face.trim() };
  };
  const ptsOf = (q: number, n: number, small: boolean) => {
    const out: number[] = [];
    const step = small ? 4 : 8;
    for (let i = 0; i < n && q + i * step + step <= d.length && i < 100000; i++) out.push(small ? i16(d, q + i * step) : i32(d, q + i * step), small ? i16(d, q + i * step + 2) : i32(d, q + i * step + 4));
    return out;
  };
  /** 베지어 (점: 시작 + 3 점씩) */
  const bezD = (pts: number[], moveFirst: boolean, from?: [number, number]): string => {
    let s = '';
    let i = 0;
    if (moveFirst) {
      if (pts.length < 2) return '';
      const [x, y] = cv.pt(pts[0], pts[1]);
      s = `M${r2(x)} ${r2(y)}`;
      i = 2;
    } else if (from) {
      const [x, y] = cv.pt(from[0], from[1]);
      s = `M${r2(x)} ${r2(y)}`;
    }
    for (; i + 5 < pts.length; i += 6) {
      const a = cv.pt(pts[i], pts[i + 1]);
      const b = cv.pt(pts[i + 2], pts[i + 3]);
      const c = cv.pt(pts[i + 4], pts[i + 5]);
      s += `C${r2(a[0])} ${r2(a[1])} ${r2(b[0])} ${r2(b[1])} ${r2(c[0])} ${r2(c[1])}`;
    }
    return s;
  };
  let p = 0;
  for (let n = 0; n < MAX_RECORDS && p + 8 <= d.length; n++) {
    const type = u32(d, p);
    const size = u32(d, p + 4);
    if (size < 8 || size % 4 || p + size > d.length) break;
    const a = p + 8;
    const end = p + size;
    switch (type) {
      case 14: // EOF
        n = MAX_RECORDS;
        break;
      case 9: // SETWINDOWEXTEX
        cv.dc.we = [i32(d, a) || 1, i32(d, a + 4) || 1];
        break;
      case 10: // SETWINDOWORGEX
        cv.dc.wo = [i32(d, a), i32(d, a + 4)];
        break;
      case 11: // SETVIEWPORTEXTEX
        cv.dc.ve = [i32(d, a) || 1, i32(d, a + 4) || 1];
        break;
      case 12: // SETVIEWPORTORGEX
        cv.dc.vo = [i32(d, a), i32(d, a + 4)];
        break;
      case 17: // SETMAPMODE
        cv.dc.mapMode = Math.max(1, Math.min(8, u32(d, a)));
        break;
      case 18: // SETBKMODE
        cv.dc.bkOpaque = u32(d, a) === 2;
        break;
      case 19: // SETPOLYFILLMODE
        cv.dc.evenOdd = u32(d, a) !== 2;
        break;
      case 22: // SETTEXTALIGN
        cv.dc.textAlign = u32(d, a);
        break;
      case 24: // SETTEXTCOLOR
        cv.dc.textColor = colorRef(u32(d, a));
        break;
      case 25: // SETBKCOLOR
        cv.dc.bkColor = colorRef(u32(d, a));
        break;
      case 27: // MOVETOEX
        cv.dc.pos = [i32(d, a), i32(d, a + 4)];
        if (cv.path) {
          const [x, y] = cv.pt(cv.dc.pos[0], cv.dc.pos[1]);
          cv.path.push(`M${r2(x)} ${r2(y)}`);
        }
        break;
      case 54: {
        // LINETO
        const x = i32(d, a);
        const y = i32(d, a + 4);
        if (cv.path) {
          const [px, py] = cv.pt(x, y);
          cv.path.push(`L${r2(px)} ${r2(py)}`);
        } else cv.shape(cv.polyD([cv.dc.pos[0], cv.dc.pos[1], x, y], false), false);
        cv.dc.pos = [x, y];
        break;
      }
      case 33: // SAVEDC
        cv.save();
        break;
      case 34: // RESTOREDC
        cv.restore(i32(d, a));
        break;
      case 35: // SETWORLDTRANSFORM
        cv.dc.xf = [f32(d, a), f32(d, a + 4), f32(d, a + 8), f32(d, a + 12), f32(d, a + 16), f32(d, a + 20)].map((v) => (Number.isFinite(v) ? v : 0));
        break;
      case 36: {
        // MODIFYWORLDTRANSFORM: 1 단위 행렬로, 2 왼쪽 곱, 3 오른쪽 곱, 4 그대로 둔다
        const m = [f32(d, a), f32(d, a + 4), f32(d, a + 8), f32(d, a + 12), f32(d, a + 16), f32(d, a + 20)];
        const mode = u32(d, a + 24);
        const x = cv.dc.xf;
        const mul = (p1: number[], q: number[]) => [p1[0] * q[0] + p1[1] * q[2], p1[0] * q[1] + p1[1] * q[3], p1[2] * q[0] + p1[3] * q[2], p1[2] * q[1] + p1[3] * q[3], p1[4] * q[0] + p1[5] * q[2] + q[4], p1[4] * q[1] + p1[5] * q[3] + q[5]];
        if (mode === 1) cv.dc.xf = [1, 0, 0, 1, 0, 0];
        else if (mode === 2) cv.dc.xf = mul(m, x);
        else if (mode === 3) cv.dc.xf = mul(x, m);
        else if (mode === 4) cv.dc.xf = m;
        if (cv.dc.xf.some((v) => !Number.isFinite(v))) cv.dc.xf = [1, 0, 0, 1, 0, 0];
        break;
      }
      case 37: {
        // SELECTOBJECT
        const ih = u32(d, a);
        cv.select(ih & 0x80000000 ? stockObject(ih & 0x7fffffff) : cv.objs[ih]);
        break;
      }
      case 40: {
        // DELETEOBJECT
        const ih = u32(d, a);
        if (ih < cv.objs.length) cv.objs[ih] = null;
        break;
      }
      case 38: {
        // CREATEPEN: ih, 종류, 굵기(POINTL), 색
        const ih = u32(d, a);
        const style = u32(d, a + 4);
        if (ih < 65536) {
          while (cv.objs.length <= ih) cv.objs.push(null);
          cv.objs[ih] = { k: 'pen', color: (style & 0x0f) === 5 ? null : colorRef(u32(d, a + 16)), width: Math.abs(i32(d, a + 8)), dash: dashOf(style, 1) };
        }
        break;
      }
      case 95: {
        // EXTCREATEPEN: ih, offBmi, cbBmi, offBits, cbBits, 종류, 굵기, 붓 종류, 색
        const ih = u32(d, a);
        const style = u32(d, a + 20);
        if (ih < 65536) {
          while (cv.objs.length <= ih) cv.objs.push(null);
          cv.objs[ih] = { k: 'pen', color: (style & 0x0f) === 5 || u32(d, a + 28) === 1 ? null : colorRef(u32(d, a + 32)), width: u32(d, a + 24), dash: dashOf(style, 1) };
        }
        break;
      }
      case 39: {
        // CREATEBRUSHINDIRECT: ih, 종류, 색, 빗금
        const ih = u32(d, a);
        const style = u32(d, a + 4);
        if (ih < 65536) {
          while (cv.objs.length <= ih) cv.objs.push(null);
          cv.objs[ih] = { k: 'brush', color: style === 1 ? null : colorRef(u32(d, a + 8)) };
        }
        break;
      }
      case 93: // CREATEMONOBRUSH
      case 94: {
        // CREATEDIBPATTERNBRUSHPT: 무늬는 그리지 않고 회색으로
        const ih = u32(d, a);
        if (ih < 65536) {
          while (cv.objs.length <= ih) cv.objs.push(null);
          cv.objs[ih] = { k: 'brush', color: '#808080' };
        }
        break;
      }
      case 82: {
        // EXTCREATEFONTINDIRECTW: ih, LOGFONTW
        const ih = u32(d, a);
        if (ih < 65536) {
          while (cv.objs.length <= ih) cv.objs.push(null);
          cv.objs[ih] = fontW(a + 4, end);
        }
        break;
      }
      case 49: // CREATEPALETTE
        {
          const ih = u32(d, a);
          if (ih < 65536) {
            while (cv.objs.length <= ih) cv.objs.push(null);
            cv.objs[ih] = { k: 'other' };
          }
        }
        break;
      case 42: // ELLIPSE
        cv.ellipseShape(i32(d, a), i32(d, a + 4), i32(d, a + 8), i32(d, a + 12));
        break;
      case 43: // RECTANGLE
        cv.rect(i32(d, a), i32(d, a + 4), i32(d, a + 8), i32(d, a + 12));
        break;
      case 44: // ROUNDRECT
        cv.roundRect(i32(d, a), i32(d, a + 4), i32(d, a + 8), i32(d, a + 12), i32(d, a + 16), i32(d, a + 20));
        break;
      case 45: // ARC
      case 46: // CHORD
      case 47: // PIE
        cv.arc(i32(d, a), i32(d, a + 4), i32(d, a + 8), i32(d, a + 12), i32(d, a + 16), i32(d, a + 20), i32(d, a + 24), i32(d, a + 28), type === 45 ? 0 : type === 46 ? 1 : 2);
        break;
      case 2: // POLYBEZIER
      case 85: // POLYBEZIER16
        cv.shape(bezD(ptsOf(a + 20, u32(d, a + 16), type === 85), true), false);
        break;
      case 5: // POLYBEZIERTO
      case 88: {
        // POLYBEZIERTO16
        const pts = ptsOf(a + 20, u32(d, a + 16), type === 88);
        if (cv.path) cv.path.push(bezD(pts, false));
        else cv.shape(bezD(pts, false, cv.dc.pos), false);
        if (pts.length >= 2) cv.dc.pos = [pts[pts.length - 2], pts[pts.length - 1]];
        break;
      }
      case 3: // POLYGON
      case 86: // POLYGON16
        cv.shape(cv.polyD(ptsOf(a + 20, u32(d, a + 16), type === 86), true), true);
        break;
      case 4: // POLYLINE
      case 87: // POLYLINE16
        cv.shape(cv.polyD(ptsOf(a + 20, u32(d, a + 16), type === 87), false), false);
        break;
      case 6: // POLYLINETO
      case 89: {
        // POLYLINETO16
        const pts = ptsOf(a + 20, u32(d, a + 16), type === 89);
        if (cv.path) {
          let s = '';
          for (let i = 0; i + 1 < pts.length; i += 2) {
            const [x, y] = cv.pt(pts[i], pts[i + 1]);
            s += `L${r2(x)} ${r2(y)}`;
          }
          cv.path.push(s);
        } else cv.shape(cv.polyD([cv.dc.pos[0], cv.dc.pos[1], ...pts], false), false);
        if (pts.length >= 2) cv.dc.pos = [pts[pts.length - 2], pts[pts.length - 1]];
        break;
      }
      case 7: // POLYPOLYLINE
      case 8: // POLYPOLYGON
      case 90: // POLYPOLYLINE16
      case 91: {
        // POLYPOLYGON16: 테두리, 다각형 수, 점 수 합, 다각형마다 점 수, 점들
        const small = type >= 90;
        const close = type === 8 || type === 91;
        const np = Math.min(u32(d, a + 16), 100000);
        let q = a + 24 + np * 4;
        let s = '';
        for (let i = 0; i < np && q < end; i++) {
          const c = u32(d, a + 24 + i * 4);
          s += cv.polyD(ptsOf(q, c, small), close);
          q += c * (small ? 4 : 8);
        }
        cv.shape(s, close);
        break;
      }
      case 59: // BEGINPATH
        cv.path = [];
        cv.donePath = null;
        break;
      case 60: // ENDPATH
        cv.donePath = cv.path ? cv.path.join('') : null;
        cv.path = null;
        break;
      case 61: // CLOSEFIGURE
        if (cv.path) cv.path.push('Z');
        break;
      case 68: // ABORTPATH
        cv.path = null;
        cv.donePath = null;
        break;
      case 62: // FILLPATH
        cv.endPathFill(true, false);
        break;
      case 63: // STROKEANDFILLPATH
        cv.endPathFill(true, true);
        break;
      case 64: // STROKEPATH
        cv.endPathFill(false, true);
        break;
      case 83: // EXTTEXTOUTA
      case 84: {
        // EXTTEXTOUTW: 테두리, 그래픽 모드, 배율 x·y, EMRTEXT(기준점, 글자 수, 글자 자리, 선택, 상자, 간격 자리)
        const t = a + 28;
        const x = i32(d, t);
        const y = i32(d, t + 4);
        const nc = Math.min(u32(d, t + 8), 10000);
        const off = u32(d, t + 12);
        const opt = u32(d, t + 16);
        if (opt & 2 && cv.dc.bkOpaque) {
          const [x0, y0] = cv.pt(i32(d, t + 20), i32(d, t + 24));
          const [x1, y1] = cv.pt(i32(d, t + 28), i32(d, t + 32));
          if (Math.abs(x1 - x0) * Math.abs(y1 - y0) > 0) cv.push(`<rect x="${r2(Math.min(x0, x1))}" y="${r2(Math.min(y0, y1))}" width="${r2(Math.abs(x1 - x0))}" height="${r2(Math.abs(y1 - y0))}" fill="${cv.dc.bkColor}"/>`);
        }
        const so = p + off;
        let s = '';
        if (type === 84) {
          for (let i = 0; i < nc && so + i * 2 + 2 <= end; i++) s += String.fromCharCode(u16(d, so + i * 2));
        } else s = decoderFor(cv.dc.font.charset).decode(d.subarray(so, Math.min(so + nc, end)));
        cv.text(x, y, s);
        break;
      }
      case 81: {
        // STRETCHDIBITS: 테두리, xDest, yDest, xSrc, ySrc, cxSrc, cySrc, offBmi, cbBmi, offBits, cbBits, usage, rop, cxDest, cyDest
        const xd = i32(d, a + 16);
        const yd = i32(d, a + 20);
        const offBmi = u32(d, a + 40);
        const cbBmi = u32(d, a + 44);
        const offBits = u32(d, a + 48);
        const cbBits = u32(d, a + 52);
        const cx = i32(d, a + 64);
        const cy = i32(d, a + 68);
        if (cbBmi && cbBits && offBits === offBmi + cbBmi && p + offBits + cbBits <= end) cv.image(d, p + offBmi, cbBmi + cbBits, xd, yd, cx, cy);
        break;
      }
      case 114: // ALPHABLEND (반투명 비트맵: STRETCHBLT 와 같은 꼴)
      case 116: // TRANSPARENTBLT (한 색을 투명으로: 같은 꼴)
      case 77: {
        // STRETCHBLT: 테두리, xDest, yDest, cxDest, cyDest, rop, xSrc, ySrc, xform(24), bk, usage, offBmi, cbBmi, offBits, cbBits, cxSrc, cySrc
        const xd = i32(d, a + 16);
        const yd = i32(d, a + 20);
        const cx = i32(d, a + 24);
        const cy = i32(d, a + 28);
        const offBmi = u32(d, a + 76);
        const cbBmi = u32(d, a + 80);
        const offBits = u32(d, a + 84);
        const cbBits = u32(d, a + 88);
        if (cbBmi && cbBits && offBits === offBmi + cbBmi && p + offBits + cbBits <= end) cv.image(d, p + offBmi, cbBmi + cbBits, xd, yd, cx, cy);
        else if (cv.dc.brush.color) cv.rect(xd, yd, xd + cx, yd + cy);
        break;
      }
      case 80: {
        // SETDIBITSTODEVICE: 테두리, xDest, yDest, xSrc, ySrc, cxSrc, cySrc, offBmi, cbBmi, offBits, cbBits, usage, 시작 줄, 줄 수
        const xd = i32(d, a + 16);
        const yd = i32(d, a + 20);
        const cx = i32(d, a + 32);
        const cy = i32(d, a + 36);
        const offBmi = u32(d, a + 40);
        const cbBmi = u32(d, a + 44);
        const offBits = u32(d, a + 48);
        const cbBits = u32(d, a + 52);
        if (cbBmi && cbBits && offBits === offBmi + cbBmi && p + offBits + cbBits <= end) cv.image(d, p + offBmi, cbBmi + cbBits, xd, yd, cx, cy);
        break;
      }
      case 78: // MASKBLT (가림 그림은 쓰지 않는다: BITBLT 와 같은 앞부분)
      case 76: {
        // BITBLT: 그림이 있으면 그림, 없으면(PATCOPY 등) 붓으로 칠한 상자
        const xd = i32(d, a + 16);
        const yd = i32(d, a + 20);
        const cx = i32(d, a + 24);
        const cy = i32(d, a + 28);
        const offBmi = u32(d, a + 76);
        const cbBmi = u32(d, a + 80);
        const offBits = u32(d, a + 84);
        const cbBits = u32(d, a + 88);
        if (size > 100 && cbBmi && cbBits && offBits === offBmi + cbBmi && p + offBits + cbBits <= end) cv.image(d, p + offBmi, cbBmi + cbBits, xd, yd, cx, cy);
        else if (cv.dc.brush.color) {
          const [x0, y0] = cv.pt(xd, yd);
          const [x1, y1] = cv.pt(xd + cx, yd + cy);
          cv.push(`<rect x="${r2(Math.min(x0, x1))}" y="${r2(Math.min(y0, y1))}" width="${r2(Math.abs(x1 - x0))}" height="${r2(Math.abs(y1 - y0))}" fill="${cv.dc.brush.color}"/>`);
        }
        break;
      }
      default:
        break;
    }
    p += size;
  }
  return cv.svg(W, H);
}

/** WMF 또는 EMF → SVG 데이터 URL (그릴 것이 없거나 읽을 수 없으면 null) */
export function metafileToSvg(bytes: Uint8Array): string | null {
  try {
    if (u32(bytes, 0) === 1 && u32(bytes, 40) === 0x464d4520) return emfToSvg(bytes);
    if (u32(bytes, 0) === 0x9ac6cdd7 || ((u16(bytes, 0) === 1 || u16(bytes, 0) === 2) && u16(bytes, 2) === 9)) return wmfToSvg(bytes);
  } catch {
    /* 읽을 수 없는 메타파일 */
  }
  return null;
}

/** 확장자가 메타파일인가 */
export const isMetafileExt = (ext: string) => /^(wmf|emf)$/i.test(ext);
