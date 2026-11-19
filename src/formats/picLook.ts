/**
 * 그림의 보정과 효과 (한글의 '그림 효과'·'밝기/대비'·'회색조'·'선').
 *
 * 문서(HWP/HWPX)에서 읽은 값을 그림 노드의 look 속성에 담고, 화면·인쇄에서는 CSS 로 그린다:
 *   밝기·대비·회색조·흑백 → filter, 투명도 → opacity, 선(테두리) → outline(그림 안쪽으로),
 *   그림자·네온 → drop-shadow, 부드러운 가장자리 → mask, 반사 → -webkit-box-reflect
 * 문서에서 온 값이므로 늘 범위를 확인한 숫자와 #RRGGBB 색만 쓴다 (CSS 에 그대로 넣지 않는다).
 */
export interface PicLook {
  /** 밝기·대비 (-100~100, 0 이 그대로) */
  bright?: number;
  contrast?: number;
  /** 1 회색조, 2 흑백 */
  gray?: 1 | 2;
  /** 투명도 (0 불투명 ~ 1 투명) */
  alpha?: number;
  /** 선: 굵기 px, 색, 종류 */
  line?: { w: number; c: string; s: 'solid' | 'dashed' | 'dotted' | 'double' };
  /** 그림자: 가로·세로 거리 px, 흐림 px, 색, 불투명도(0~1) */
  shadow?: { x: number; y: number; blur: number; c: string; a: number };
  /** 네온(바깥 빛): 크기 px, 색, 불투명도 */
  glow?: { r: number; c: string; a: number };
  /** 부드러운 가장자리 px */
  soft?: number;
  /** 반사: 그림과의 거리 px, 시작 불투명도(0~1), 반사가 보이는 길이(그림 높이에 대한 비율 0~1) */
  reflect?: { gap: number; a: number; size: number };
  /** 동영상의 첫 화면: 가운데에 재생 단추를 겹쳐 그린다 (한글처럼) */
  play?: boolean;
}

const HEX = /^#[0-9A-Fa-f]{6}$/;
const num = (v: any, lo: number, hi: number): number | null => {
  const n = +v;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n * 100) / 100)) : null;
};

/** 문서·붙여넣기에서 온 값 검사. 쓸 것이 없으면 null */
export function cleanLook(v: any): PicLook | null {
  if (!v || typeof v !== 'object') return null;
  const out: PicLook = {};
  const b = num(v.bright, -100, 100);
  if (b) out.bright = b;
  const c = num(v.contrast, -100, 100);
  if (c) out.contrast = c;
  if (v.gray === 1 || v.gray === 2) out.gray = v.gray;
  const a = num(v.alpha, 0, 1);
  if (a) out.alpha = a;
  if (v.line && typeof v.line === 'object' && HEX.test(v.line.c)) {
    const w = num(v.line.w, 0, 40);
    const s = ['solid', 'dashed', 'dotted', 'double'].includes(v.line.s) ? v.line.s : 'solid';
    if (w && w > 0) out.line = { w, c: v.line.c, s };
  }
  if (v.shadow && typeof v.shadow === 'object' && HEX.test(v.shadow.c)) {
    const x = num(v.shadow.x, -200, 200);
    const y = num(v.shadow.y, -200, 200);
    const blur = num(v.shadow.blur, 0, 200);
    const sa = num(v.shadow.a, 0, 1);
    if (x != null && y != null && blur != null && sa) out.shadow = { x, y, blur, c: v.shadow.c, a: sa };
  }
  if (v.glow && typeof v.glow === 'object' && HEX.test(v.glow.c)) {
    const r = num(v.glow.r, 0, 200);
    const ga = num(v.glow.a, 0, 1);
    if (r && ga) out.glow = { r, c: v.glow.c, a: ga };
  }
  const soft = num(v.soft, 0, 200);
  if (soft) out.soft = soft;
  if (v.reflect && typeof v.reflect === 'object') {
    const gap = num(v.reflect.gap, 0, 200);
    const ra = num(v.reflect.a, 0, 1);
    const size = num(v.reflect.size, 0, 1);
    if (gap != null && ra && size) out.reflect = { gap, a: ra, size };
  }
  if (v.play === true) out.play = true;
  return Object.keys(out).length ? out : null;
}

const rgba = (hex: string, a: number) => `rgba(${parseInt(hex.slice(1, 3), 16)}, ${parseInt(hex.slice(3, 5), 16)}, ${parseInt(hex.slice(5, 7), 16)}, ${Math.round(a * 1000) / 1000})`;

/**
 * 그림 상자(감싼 요소, wrap)와 그림(img)에 줄 CSS 속성들 (값은 cleanLook 을 거친 것만).
 * 부드러운 가장자리(mask)는 그림에 준다: 감싼 요소에 주면 그 바깥에 그리는 그림자·네온·반사까지 가려진다
 */
export function lookCss(v: any): { wrap: Record<string, string>; img: Record<string, string> } {
  const l = cleanLook(v);
  if (!l) return { wrap: {}, img: {} };
  const css: Record<string, string> = {};
  const img: Record<string, string> = {};
  const f: string[] = [];
  // 한글의 밝기는 색에 더하는 값에 가깝다: 배수로 어림한다
  if (l.bright) f.push(`brightness(${Math.round((1 + l.bright / 100) * 100) / 100})`);
  if (l.contrast) f.push(`contrast(${Math.round((1 + l.contrast / 100) * 100) / 100})`);
  if (l.gray === 1) f.push('grayscale(1)');
  else if (l.gray === 2) f.push('grayscale(1) contrast(100)');
  if (l.shadow) f.push(`drop-shadow(${l.shadow.x}px ${l.shadow.y}px ${Math.round(l.shadow.blur / 2 * 100) / 100}px ${rgba(l.shadow.c, l.shadow.a)})`);
  if (l.glow) {
    // 네온: 그림 둘레에 퍼진 빛 띠. 흐림 반경이 작은 그림자를 세 겹 깔아 한글처럼 띠가 또렷하게 보이게 한다
    const r = Math.round((l.glow.r / 4) * 100) / 100;
    const c = rgba(l.glow.c, Math.min(1, l.glow.a * 1.4));
    f.push(`drop-shadow(0 0 ${r}px ${c})`, `drop-shadow(0 0 ${r}px ${c})`, `drop-shadow(0 0 ${r}px ${c})`);
  }
  if (f.length) css.filter = f.join(' ');
  if (l.alpha) css.opacity = String(Math.round((1 - l.alpha) * 1000) / 1000);
  if (l.line) {
    css.outline = `${l.line.w}px ${l.line.s} ${l.line.c}`;
    css['outline-offset'] = `-${l.line.w}px`;
  }
  if (l.soft) {
    const s = `${l.soft}px`;
    const m = `linear-gradient(to right, transparent, #000 ${s}, #000 calc(100% - ${s}), transparent), linear-gradient(to bottom, transparent, #000 ${s}, #000 calc(100% - ${s}), transparent)`;
    img['-webkit-mask-image'] = m;
    img['mask-image'] = m;
    img['-webkit-mask-composite'] = 'source-in';
    img['mask-composite'] = 'intersect';
  }
  if (l.reflect) {
    // 반사의 마스크는 뒤집기 전 그림 좌표에 걸린다: 그림의 아래쪽(뒤집으면 그림에 붙는 쪽)을 진하게, 위로 갈수록 투명하게
    const end = Math.round(l.reflect.size * 1000) / 10;
    css['-webkit-box-reflect'] = `below ${l.reflect.gap}px linear-gradient(to top, rgba(0, 0, 0, ${l.reflect.a}) 0%, transparent ${end}%)`;
  }
  return { wrap: css, img };
}

const styleOf = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, val]) => `${k}: ${val}`)
    .join('; ');

/** lookCss 를 style 글로 (감싼 요소, 그림) */
export function lookStyle(v: any): { wrap: string; img: string } {
  const c = lookCss(v);
  return { wrap: styleOf(c.wrap), img: styleOf(c.img) };
}
