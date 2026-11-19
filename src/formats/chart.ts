/**
 * Word·Excel 차트(DrawingML 차트: c:chartSpace) → SVG 그림.
 * 값은 차트 부분에 함께 저장된 캐시(numCache·strCache, numLit·strLit)에서 읽는다 (원본 엑셀 표는 읽지 않는다).
 * 막대(세로·가로; 묶은·누적·100% 누적), 꺾은선, 영역, 원형·도넛, 분산형을 Word(2013 이후)의 기본 모양대로 그린다:
 * 제목, 값 축 눈금(Excel 처럼 자동 최댓값·간격), 눈금선, 항목 축 글자, 범례, 계열 색(spPr 또는 테마 강조색), 데이터 레이블.
 * 문서에서 온 값이므로 계열·항목 수와 값의 범위를 줄여 받는다. 그릴 것이 없으면 null
 */
import { attr, bytesToBase64, descendant, descendants, kid, kids, localName, parseXml } from './common';
import { colorOf } from './docx/drawing';

const MAX_SERIES = 64;
const MAX_POINTS = 2000;

type Kind = 'bar' | 'line' | 'area' | 'pie' | 'doughnut' | 'scatter' | 'radar';

interface Series {
  name: string;
  cats: string[];
  vals: (number | null)[];
  /** 분산형의 x 값 */
  xs: (number | null)[] | null;
  /** 채우기 색 (막대·영역·원형) */
  fill: string | null;
  /** 선 색·굵기(px) (꺾은선·분산형) */
  line: string | null;
  lineW: number | null;
  /** 표식을 그린다 (꺾은선·분산형) */
  marker: boolean;
  markerColor: string | null;
  /** 점마다 다른 색 (c:dPt) */
  pts: Map<number, string>;
  /** 값의 표시 형식 (numCache 의 formatCode) */
  fmt: string;
}

interface Group {
  kind: Kind;
  /** 막대 방향: col 세로 막대, bar 가로 막대 */
  dir: 'col' | 'bar';
  grouping: 'clustered' | 'stacked' | 'percentStacked' | 'standard';
  gap: number;
  overlap: number;
  vary: boolean;
  hole: number;
  firstAng: number;
  series: Series[];
  labels: { val: boolean; pct: boolean; cat: boolean };
  /** 방사형: 칠한 꼴 */
  radarFill: boolean;
  /** 주식형의 고가-저가 선 */
  hiLow: boolean;
}

interface TextStyle {
  size: number;
  color: string;
  bold: boolean;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const r1 = (v: number) => Math.round(v * 10) / 10;
const fin = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);

/** 테마가 없을 때의 강조색 (Office 2013 테마) */
const OFFICE = ['#5B9BD5', '#ED7D31', '#A5A5A5', '#FFC000', '#4472C4', '#70AD47'];

/** 색을 어둡게(f < 1)·밝게(f > 1) */
function shade(hex: string, f: number): string {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v: number) => Math.round(f <= 1 ? v * f : v + (255 - v) * (f - 1));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** 계열(또는 점) 번호의 기본 색: 강조색 1~6, 그다음은 어둡게·밝게 */
function paletteColor(i: number, theme: Map<string, string>): string {
  const base = theme.get(`accent${(i % 6) + 1}`) || OFFICE[i % 6];
  const round = Math.floor(i / 6) % 3;
  return round === 0 ? base : round === 1 ? shade(base, 0.6) : shade(base, 1.4);
}

/** 캐시된 값 목록 (c:numCache·c:strCache·c:numLit·c:strLit, 여러 단계 항목은 첫 단계) */
function cacheOf(el: Element | null): { vals: (string | null)[]; fmt: string } {
  const out: { vals: (string | null)[]; fmt: string } = { vals: [], fmt: 'General' };
  if (!el) return out;
  const cache = descendant(el, 'numCache') || descendant(el, 'strCache') || descendant(el, 'numLit') || descendant(el, 'strLit') || descendant(el, 'lvl');
  if (!cache) return out;
  const n = Math.min(MAX_POINTS, parseInt(attr(kid(cache, 'ptCount'), 'val') || '0', 10) || 0);
  const vals: (string | null)[] = new Array(Math.max(0, n)).fill(null);
  for (const pt of kids(cache, 'pt')) {
    const i = parseInt(attr(pt, 'idx') || '-1', 10);
    if (!(i >= 0 && i < MAX_POINTS)) continue;
    while (vals.length <= i) vals.push(null);
    vals[i] = kid(pt, 'v')?.textContent ?? null;
  }
  out.vals = vals;
  out.fmt = kid(cache, 'formatCode')?.textContent || 'General';
  return out;
}

const numOf = (v: string | null) => {
  if (v == null || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? fin(n, -1e15, 1e15) : null;
};

/** 날짜 형식인가 (y·d 가 든 형식, 또는 m 과 / - 가 든 형식) */
const isDateFmt = (f: string) => /[yd]/i.test(f.replace(/"[^"]*"|\[[^\]]*\]/g, '')) || /m+[/\-.]|[/\-.]m+/i.test(f);

/** 엑셀 날짜 일련번호(1900 날짜 체계) → 형식대로 (yyyy·yy·mmmm·mmm·mm·m·dd·d) */
function formatDate(serial: number, fmt: string): string {
  const ms = Math.round((serial - 25569) * 86400000);
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return String(serial);
  const Y = d.getUTCFullYear();
  const M = d.getUTCMonth();
  const D = d.getUTCDate();
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const f = fmt.replace(/\[[^\]]*\]/g, '').split(';')[0];
  return f.replace(/"([^"]*)"|yyyy|yy|mmmm|mmm|mm|m|dd|d|\\(.)/gi, (t, q, e) => {
    if (q != null) return q;
    if (e != null) return e;
    switch (t.toLowerCase()) {
      case 'yyyy':
        return String(Y);
      case 'yy':
        return String(Y % 100).padStart(2, '0');
      case 'mmmm':
        return MONTH[M];
      case 'mmm':
        return MON[M];
      case 'mm':
        return String(M + 1).padStart(2, '0');
      case 'm':
        return String(M + 1);
      case 'dd':
        return String(D).padStart(2, '0');
      default:
        return String(D);
    }
  });
}

/** 숫자 → 표시 글 (formatCode 가운데 자주 쓰는 것: 날짜·백분율·소수 자리·천 단위 쉼표, 그 밖은 일반) */
export function formatNumber(v: number, fmt: string, unit = 0): string {
  if (fmt && !/^general$/i.test(fmt.trim()) && isDateFmt(fmt)) return formatDate(v, fmt);
  const f = (fmt || 'General').replace(/"[^"]*"|\[[^\]]*\]|\\./g, '').split(';')[0];
  const pct = f.includes('%');
  const x = pct ? v * 100 : v;
  const dm = /\.(0+|#+)/.exec(f);
  let dec = dm ? dm[1].length : -1;
  if (/^general$/i.test(f.trim()) || (dec < 0 && !/0/.test(f))) {
    // 일반: 그 값을 나타내는 가장 짧은 글 (눈금 간격 자리에서 반올림해 부동 소수 오차를 없앤다)
    const k = unit > 0 ? Math.max(0, Math.min(10, -Math.floor(Math.log10(unit) + 1e-9) + 1)) : -1;
    const y = k >= 0 ? parseFloat(x.toFixed(k)) : parseFloat(x.toPrecision(10));
    return String(y) + (pct ? '%' : '');
  }
  if (dec < 0) dec = 0;
  let s = Math.abs(x).toFixed(dec);
  if (/#,##|0,0/.test(f)) {
    const [i, d] = s.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (d ? '.' + d : '');
  }
  return (x < 0 && parseFloat(s) !== 0 ? '-' : '') + s + (pct ? '%' : '');
}

/** 값 축 눈금 (Excel 처럼: 최댓값에 5% 여유를 두고 1·2·5 단위로 10칸 이하, 모두 양수면 0 부터) */
export function niceScale(lo: number, hi: number, fixed: { min?: number; max?: number; unit?: number } = {}, maxSteps = 10): { min: number; max: number; unit: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  let min = lo >= 0 ? 0 : lo;
  let max = hi <= 0 ? 0 : hi;
  if (fixed.min != null) min = fixed.min;
  if (fixed.max != null) max = fixed.max;
  if (max <= min) max = min + (Math.abs(min) || 1);
  const span = max - min;
  const hiPad = fixed.max != null ? max : max > 0 ? max + span * 0.05 : max;
  const loPad = fixed.min != null ? min : min < 0 ? min - span * 0.05 : min;
  let unit = fixed.unit && fixed.unit > 0 ? fixed.unit : 0;
  if (!unit) {
    const range = hiPad - loPad || 1;
    const mag = Math.pow(10, Math.floor(Math.log10(range / 10)));
    for (const m of [1, 2, 5, 10, 20, 50]) {
      unit = m * mag;
      if (Math.ceil(range / unit - 1e-9) <= maxSteps) break;
    }
  }
  const outMax = fixed.max != null ? fixed.max : Math.ceil(hiPad / unit - 1e-9) * unit;
  const outMin = fixed.min != null ? fixed.min : Math.floor(loPad / unit + 1e-9) * unit;
  // 칸이 너무 많으면(고정 간격이 아주 작은 등) 줄인다
  while ((outMax - outMin) / unit > 50) unit *= 2;
  return { min: outMin, max: outMax > outMin ? outMax : outMin + unit, unit };
}

/** 글 상자(제목·축·범례)의 글자 모양: txPr·rich 의 defRPr (sz 는 1/100 pt) */
function textStyleOf(el: Element | null, theme: Map<string, string>, dflt: TextStyle): TextStyle {
  const def = el ? descendant(el, 'defRPr') || descendant(el, 'rPr') : null;
  if (!def) return dflt;
  const sz = parseInt(attr(def, 'sz') || '', 10);
  const c = colorOf(kid(def, 'solidFill'), theme);
  const b = attr(def, 'b');
  return { size: sz >= 100 && sz <= 40000 ? (sz / 100) * (96 / 72) : dflt.size, color: c ? c.c : dflt.color, bold: b != null ? b === '1' || b === 'true' : dflt.bold };
}

/** 글 폭 어림 (px): 영문 0.55em, 한글·한자 1em */
function textW(s: string, size: number): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᇿ⺀-꓏가-힯豈-﫿＀-ￜ]/.test(ch) ? 1 : /[\s.,:;|il1']/.test(ch) ? 0.3 : /[A-Z0-9%]/.test(ch) ? 0.62 : 0.52;
  return w * size;
}

function fitText(s: string, size: number, maxW: number): string {
  if (textW(s, size) <= maxW) return s;
  let t = s;
  while (t.length > 1 && textW(t + '…', size) > maxW) t = t.slice(0, -1);
  return t + '…';
}

/** 차트의 제목 글 (rich 의 글 또는 strRef 의 캐시) */
function titleText(t: Element | null): string | null {
  if (!t) return null;
  const tx = kid(t, 'tx');
  if (!tx) return null;
  const rich = kid(tx, 'rich');
  if (rich)
    return kids(rich, 'p')
      .map((p) => descendants(p, 't').map((x) => x.textContent || '').join(''))
      .join('\n');
  const c = cacheOf(tx);
  return c.vals.filter((v) => v != null).join(' ') || null;
}

function parseSeries(ser: Element, kind: Kind, idx: number, theme: Map<string, string>): Series {
  const tx = kid(ser, 'tx');
  const name = (tx && (cacheOf(tx).vals[0] ?? kid(tx, 'v')?.textContent)) || `계열 ${idx + 1}`;
  const cat = cacheOf(kid(ser, 'cat') || kid(ser, 'xVal'));
  const val = cacheOf(kid(ser, 'val') || kid(ser, 'yVal'));
  const spPr = kid(ser, 'spPr');
  const fillEl = kid(spPr, 'solidFill') || kid(spPr, 'gradFill');
  const fill = fillEl ? colorOf(localName(fillEl) === 'gradFill' ? descendant(fillEl, 'gs') : fillEl, theme)?.c || null : kid(spPr, 'noFill') ? 'none' : null;
  const ln = kid(spPr, 'ln');
  const line = ln ? (kid(ln, 'noFill') ? 'none' : colorOf(kid(ln, 'solidFill'), theme)?.c || null) : null;
  const lw = ln && attr(ln, 'w') ? fin(parseInt(attr(ln, 'w') || '0', 10) / 9525, 0, 30) : null;
  const mk = kid(ser, 'marker');
  const sym = attr(kid(mk, 'symbol'), 'val');
  const marker = kind === 'scatter' ? sym !== 'none' : !!mk && sym != null && sym !== 'none';
  const markerColor = colorOf(kid(kid(mk, 'spPr'), 'solidFill'), theme)?.c || null;
  const pts = new Map<number, string>();
  for (const dp of kids(ser, 'dPt')) {
    const i = parseInt(attr(kid(dp, 'idx'), 'val') || '-1', 10);
    const c = colorOf(kid(kid(dp, 'spPr'), 'solidFill'), theme);
    if (i >= 0 && i < MAX_POINTS && c) pts.set(i, c.c);
  }
  const xs = kind === 'scatter' && kid(ser, 'xVal') ? cat.vals.map(numOf) : null;
  // 숫자 항목(날짜 등)은 형식대로 글로
  const catNum = !!descendant(kid(ser, 'cat'), 'numCache') || !!descendant(kid(ser, 'cat'), 'numLit');
  const cats = cat.vals.map((v) => {
    const n = catNum ? numOf(v) : null;
    return n != null ? formatNumber(n, cat.fmt) : v ?? '';
  });
  return { name: String(name), cats, vals: val.vals.map(numOf), xs, fill, line, lineW: lw, marker, markerColor, pts, fmt: val.fmt };
}

const GROUPS: Record<string, Kind> = {
  barChart: 'bar',
  bar3DChart: 'bar',
  lineChart: 'line',
  line3DChart: 'line',
  areaChart: 'area',
  area3DChart: 'area',
  pieChart: 'pie',
  pie3DChart: 'pie',
  ofPieChart: 'pie',
  doughnutChart: 'doughnut',
  scatterChart: 'scatter',
  radarChart: 'radar',
  // 주식형: 고가·저가·종가 계열을 꺾은선 묶음으로 (선이 없는 계열은 표식만)
  stockChart: 'line',
};

function parseGroup(el: Element, kind: Kind, theme: Map<string, string>, base: number): Group {
  const v = (n: string) => attr(kid(el, n), 'val');
  const grouping = (v('grouping') || (kind === 'bar' ? 'clustered' : 'standard')) as Group['grouping'];
  const series = kids(el, 'ser')
    .slice(0, MAX_SERIES)
    .map((s, i) => ({ s, order: parseInt(attr(kid(s, 'order'), 'val') || String(i), 10) || 0, idx: parseInt(attr(kid(s, 'idx'), 'val') || String(base + i), 10) || 0 }))
    .sort((a, b) => a.order - b.order)
    .map(({ s, idx }) => {
      const ser = parseSeries(s, kind, idx, theme);
      // 색을 적지 않은 계열은 계열 번호의 강조색
      if (!ser.fill && kind !== 'line' && kind !== 'scatter' && kind !== 'radar') ser.fill = paletteColor(idx, theme);
      if (!ser.line && (kind === 'line' || kind === 'scatter' || kind === 'radar')) ser.line = paletteColor(idx, theme);
      return ser;
    });
  const dl = kid(el, 'dLbls') || descendant(el, 'dLbls');
  const on = (n: string) => attr(kid(dl, n), 'val') === '1';
  return {
    kind,
    radarFill: v('radarStyle') === 'filled',
    hiLow: !!kid(el, 'hiLowLines'),
    dir: v('barDir') === 'bar' ? 'bar' : 'col',
    grouping: ['clustered', 'stacked', 'percentStacked', 'standard'].includes(grouping) ? grouping : 'standard',
    gap: fin(parseFloat(v('gapWidth') || '150'), 0, 500),
    overlap: fin(parseFloat(v('overlap') || (grouping === 'stacked' || grouping === 'percentStacked' ? '100' : '0')), -100, 100),
    vary: v('varyColors') === '1' && (kind === 'pie' || kind === 'doughnut' || series.length === 1),
    hole: fin(parseFloat(v('holeSize') || '50'), 10, 90),
    firstAng: fin(parseFloat(v('firstSliceAng') || '0'), 0, 360),
    series,
    labels: { val: on('showVal'), pct: on('showPercent'), cat: on('showCatName') },
  };
}

class Svg {
  parts: string[] = [];
  font: string;
  constructor(font: string) {
    this.font = font;
  }
  rect(x: number, y: number, w: number, h: number, fill: string, stroke = '', sw = 0) {
    if (!(w > 0 && h > 0)) return;
    this.parts.push(`<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="${r1(sw)}"` : ''}/>`);
  }
  line(x1: number, y1: number, x2: number, y2: number, stroke: string, sw = 1) {
    this.parts.push(`<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${stroke}" stroke-width="${r1(sw)}"/>`);
  }
  path(d: string, fill: string, stroke = 'none', sw = 0, extra = '') {
    this.parts.push(`<path d="${d}" fill="${fill}" stroke="${stroke}"${sw ? ` stroke-width="${r1(sw)}"` : ''}${extra}/>`);
  }
  text(x: number, y: number, s: string, st: TextStyle, anchor: 'start' | 'middle' | 'end' = 'start') {
    if (!s) return;
    this.parts.push(
      `<text x="${r1(x)}" y="${r1(y)}" font-family="${esc(this.font)}" font-size="${r1(st.size)}"${st.bold ? ' font-weight="bold"' : ''} fill="${st.color}" text-anchor="${anchor}" dominant-baseline="central">${esc(s)}</text>`,
    );
  }
}

interface ChartOpts {
  /** 그릴 크기 (px) */
  w: number;
  h: number;
  /** 테마 색 (accent1 … dk1 …) */
  theme?: Map<string, string>;
  /** 테마 본문 글꼴 */
  font?: string;
}

/** 차트 XML → SVG data URL (그릴 것이 없으면 null) */
export function chartToSvg(xml: string, opts: ChartOpts): string | null {
  let doc: Document;
  try {
    doc = parseXml(xml);
  } catch {
    return null;
  }
  const svg = renderChart(doc, opts);
  return svg ? 'data:image/svg+xml;base64,' + bytesToBase64(new TextEncoder().encode(svg)) : null;
}

export function renderChart(doc: Document, opts: ChartOpts): string | null {
  const theme = opts.theme || new Map<string, string>();
  const W = fin(opts.w, 20, 4000);
  const H = fin(opts.h, 20, 4000);
  const cs = doc.documentElement;
  const chart = kid(cs, 'chart');
  const plot = kid(chart, 'plotArea');
  if (!chart || !plot) return null;
  const groups: Group[] = [];
  let base = 0;
  for (const el of kids(plot)) {
    const kind = GROUPS[localName(el)];
    if (!kind) continue;
    const g = parseGroup(el, kind, theme, base);
    base += g.series.length;
    if (g.series.length) groups.push(g);
  }
  if (!groups.length) return null;
  const gray = theme.get('dk1') ? shade(theme.get('dk1')!, 1.65) : '#595959';
  const baseText = textStyleOf(kid(cs, 'txPr'), theme, { size: (10 * 96) / 72, color: gray, bold: false });
  const s = new Svg(opts.font ? `${opts.font}, Calibri, Arial, sans-serif` : 'Calibri, Arial, sans-serif');
  // 차트 영역: 바탕·테두리 (적힌 것이 없으면 흰 바탕에 연한 회색 테두리)
  const csp = kid(cs, 'spPr');
  const bg = kid(csp, 'noFill') ? 'none' : colorOf(kid(csp, 'solidFill'), theme)?.c || '#FFFFFF';
  const cln = kid(csp, 'ln');
  const border = cln ? (kid(cln, 'noFill') ? '' : colorOf(kid(cln, 'solidFill'), theme)?.c || '#D9D9D9') : csp ? '' : '#D9D9D9';
  s.rect(0.5, 0.5, W - 1, H - 1, bg, border, border ? 1 : 0);
  const pad = 10;
  let top = pad;
  let bottom = H - pad;
  let left = pad;
  let right = W - pad;
  const allSeries = groups.flatMap((g) => g.series);
  // 제목
  const tEl = kid(chart, 'title');
  const autoDel = attr(kid(chart, 'autoTitleDeleted'), 'val') === '1';
  let title = tEl ? titleText(tEl) : null;
  // 글을 적지 않은 제목: 계열이 하나면 그 이름, 아니면 Word 가 넣는 '차트 제목' (문서 언어에 따라)
  const lang = attr(kid(cs, 'lang'), 'val') || '';
  if (tEl && title == null) title = allSeries.length === 1 ? allSeries[0].name : /^ko/i.test(lang) || !lang ? '차트 제목' : 'Chart Title';
  if (!tEl && !autoDel && allSeries.length === 1 && (groups[0].kind === 'pie' || groups[0].kind === 'doughnut')) title = allSeries[0].name;
  if (title) {
    const ts = textStyleOf(kid(tEl, 'txPr') || descendant(kid(tEl, 'tx'), 'rich'), theme, { size: (14 * 96) / 72, color: gray, bold: false });
    for (const line of title.split('\n').slice(0, 4)) {
      s.text(W / 2, top + ts.size * 0.6, fitText(line, ts.size, W - 2 * pad), ts, 'middle');
      top += ts.size * 1.25;
    }
    top += 6;
  }
  // 범례
  const lg = kid(chart, 'legend');
  const pie = groups[0].kind === 'pie' || groups[0].kind === 'doughnut';
  const legendItems: { name: string; color: string; line: boolean }[] = [];
  if (lg) {
    if (pie || (groups.length === 1 && groups[0].vary)) {
      const ser = groups[0].series[0];
      ser.cats.forEach((c, i) => legendItems.push({ name: c || String(i + 1), color: ser.pts.get(i) || paletteColor(i, theme), line: false }));
    } else {
      for (const g of groups)
        for (const ser of g.series) {
          const lineKind = g.kind === 'line' || g.kind === 'scatter' || (g.kind === 'radar' && !g.radarFill);
          const color = (lineKind ? ser.line : g.kind === 'radar' ? ser.line : ser.fill) || '#808080';
          // 선도 표식도 없는 계열(주식형의 고가·저가)은 범례에 넣지 않는다
          if (lineKind && color === 'none' && !ser.marker) continue;
          legendItems.push({ name: ser.name, color: color === 'none' ? ser.markerColor || '#808080' : color, line: lineKind });
        }
      // 가로 막대만 있는 차트의 범례는 계열이 아래에서 위로 쌓인 차례를 따라 거꾸로 (Word 와 같이)
      if (groups.length === 1 && groups[0].kind === 'bar' && groups[0].dir === 'bar' && groups[0].grouping === 'clustered') legendItems.reverse();
    }
  }
  if (legendItems.length) {
    const ls = textStyleOf(kid(lg, 'txPr'), theme, baseText.size === (10 * 96) / 72 ? { ...baseText, size: (9 * 96) / 72 } : baseText);
    const pos = attr(kid(lg, 'legendPos'), 'val') || 'r';
    const sw = ls.size * 0.6;
    if (pos === 'b' || pos === 't') {
      // 한 줄(넘치면 여러 줄)로 가운데에
      const rows: { name: string; color: string; line: boolean; w: number }[][] = [[]];
      let rowW = 0;
      for (const it of legendItems.slice(0, 200)) {
        const w = sw + 4 + textW(it.name, ls.size) + 12;
        if (rowW + w > W - 2 * pad && rows[rows.length - 1].length) {
          rows.push([]);
          rowW = 0;
        }
        rows[rows.length - 1].push({ ...it, w });
        rowW += w;
      }
      const lh = ls.size * 1.4;
      const total = rows.length * lh;
      let y = pos === 'b' ? bottom - total : top;
      for (const row of rows) {
        let x = (W - row.reduce((a, b) => a + b.w, 0) + 12) / 2;
        for (const it of row) {
          if (it.line) s.line(x - 2, y + lh / 2, x + sw + 2, y + lh / 2, it.color, 2);
          else s.rect(x, y + lh / 2 - sw / 2, sw, sw, it.color);
          s.text(x + sw + 4, y + lh / 2, it.name, ls);
          x += it.w;
        }
        y += lh;
      }
      if (pos === 'b') bottom -= total + 6;
      else top += total + 6;
    } else {
      // 오른쪽(또는 왼쪽)에 세로로
      const lh = ls.size * 1.5;
      const maxW = Math.min(W * 0.35, Math.max(...legendItems.map((it) => textW(it.name, ls.size))) + sw + 8);
      const items = legendItems.slice(0, Math.max(1, Math.floor((bottom - top) / lh)));
      let y = (top + bottom - items.length * lh) / 2;
      const x0 = pos === 'l' ? left : right - maxW;
      for (const it of items) {
        if (it.line) s.line(x0 - 2, y + lh / 2, x0 + sw + 2, y + lh / 2, it.color, 2);
        else s.rect(x0, y + lh / 2 - sw / 2, sw, sw, it.color);
        s.text(x0 + sw + 4, y + lh / 2, fitText(it.name, ls.size, maxW - sw - 4), ls);
        y += lh;
      }
      if (pos === 'l') left += maxW + 8;
      else right -= maxW + 8;
    }
  }
  if (!(right - left > 10 && bottom - top > 10)) return wrapSvg(s, W, H);
  if (pie) drawPie(s, groups[0], { left, top, right, bottom }, theme, baseText);
  else if (groups[0].kind === 'radar') drawRadar(s, groups[0], plot, { left, top, right, bottom }, theme, baseText);
  else drawAxes(s, groups, plot, { left, top, right, bottom }, theme, baseText, gray);
  return wrapSvg(s, W, H);
}

function wrapSvg(s: Svg, W: number, H: number): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${r1(W)}" height="${r1(H)}" viewBox="0 0 ${r1(W)} ${r1(H)}">${s.parts.join('')}</svg>`;
}

/** 원형·도넛: 12시 방향(첫 조각 각도만큼 돌림)에서 시계 방향으로 */
function drawPie(s: Svg, g: Group, box: { left: number; top: number; right: number; bottom: number }, theme: Map<string, string>, txt: TextStyle) {
  const ser = g.series[0];
  const vals = ser.vals.map((v) => (v != null && v > 0 ? v : 0));
  const sum = vals.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return;
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const R = Math.max(4, (Math.min(box.right - box.left, box.bottom - box.top) / 2) * 0.92);
  const r0 = g.kind === 'doughnut' ? (R * g.hole) / 100 : 0;
  let a = ((g.firstAng - 90) * Math.PI) / 180;
  const pt = (ang: number, r: number) => `${r1(cx + r * Math.cos(ang))} ${r1(cy + r * Math.sin(ang))}`;
  const ls: TextStyle = { ...txt, size: (9 * 96) / 72, color: '#404040' };
  vals.forEach((v, i) => {
    if (!(v > 0)) return;
    const da = (v / sum) * Math.PI * 2;
    const b = a + da;
    const color = ser.pts.get(i) || (g.vary ? paletteColor(i, theme) : ser.fill || paletteColor(0, theme));
    const large = da > Math.PI ? 1 : 0;
    let d: string;
    if (da >= Math.PI * 2 - 1e-6) {
      d = `M${pt(a, R)}A${r1(R)} ${r1(R)} 0 1 1 ${pt(a + Math.PI, R)}A${r1(R)} ${r1(R)} 0 1 1 ${pt(a, R)}Z`;
      if (r0) d += `M${pt(a, r0)}A${r1(r0)} ${r1(r0)} 0 1 0 ${pt(a + Math.PI, r0)}A${r1(r0)} ${r1(r0)} 0 1 0 ${pt(a, r0)}Z`;
    } else if (r0) d = `M${pt(a, R)}A${r1(R)} ${r1(R)} 0 ${large} 1 ${pt(b, R)}L${pt(b, r0)}A${r1(r0)} ${r1(r0)} 0 ${large} 0 ${pt(a, r0)}Z`;
    else d = `M${r1(cx)} ${r1(cy)}L${pt(a, R)}A${r1(R)} ${r1(R)} 0 ${large} 1 ${pt(b, R)}Z`;
    s.path(d, color, '#FFFFFF', 1, ' fill-rule="evenodd"');
    if (g.labels.val || g.labels.pct || g.labels.cat) {
      const mid = a + da / 2;
      const rl = r0 ? (R + r0) / 2 : R * 0.68;
      const parts: string[] = [];
      if (g.labels.cat) parts.push(ser.cats[i] || '');
      if (g.labels.val) parts.push(formatNumber(v, ser.fmt));
      if (g.labels.pct) parts.push(Math.round((v / sum) * 100) + '%');
      s.text(cx + rl * Math.cos(mid), cy + rl * Math.sin(mid), parts.filter(Boolean).join('; '), ls, 'middle');
    }
    a = b;
  });
}

/** 방사형: 12시 방향에서 시계 방향으로 항목마다 바큇살, 값 눈금마다 다각형 눈금선, 계열은 선(또는 칠한) 다각형 */
function drawRadar(s: Svg, g: Group, plot: Element, box: { left: number; top: number; right: number; bottom: number }, theme: Map<string, string>, txt: TextStyle) {
  const nCat = Math.max(3, ...g.series.map((ser) => Math.max(ser.vals.length, ser.cats.length)));
  let lo = Infinity;
  let hi = -Infinity;
  for (const ser of g.series) for (const v of ser.vals) if (v != null) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
  if (!Number.isFinite(lo)) ((lo = 0), (hi = 1));
  const vAx = kid(plot, 'valAx');
  const sc = niceScale(lo, hi, {}, 5);
  const st: TextStyle = { ...txt, size: txt.size === (10 * 96) / 72 ? (9 * 96) / 72 : txt.size };
  const cats = g.series[0].cats;
  const labW = Math.max(20, ...cats.map((c) => textW(c, st.size)));
  const cx = (box.left + box.right) / 2;
  const cy = (box.top + box.bottom) / 2;
  const R = Math.max(8, Math.min((box.right - box.left) / 2 - labW - 6, (box.bottom - box.top) / 2 - st.size * 1.4));
  const ang = (i: number) => -Math.PI / 2 + (i / nCat) * Math.PI * 2;
  const at = (i: number, v: number) => {
    const r = ((v - sc.min) / (sc.max - sc.min || 1)) * R;
    return [cx + r * Math.cos(ang(i)), cy + r * Math.sin(ang(i))] as const;
  };
  const poly = (pts: (readonly [number, number])[]) => 'M' + pts.map((p) => `${r1(p[0])} ${r1(p[1])}`).join('L') + 'Z';
  // 눈금선(다각형)과 바큇살
  for (let v = sc.min, k = 0; v <= sc.max + sc.unit * 1e-6 && k < 30; v += sc.unit, k++) {
    s.path(poly(Array.from({ length: nCat }, (_, i) => at(i, v))), 'none', '#D9D9D9', 1);
    if (attr(kid(vAx, 'delete'), 'val') !== '1') s.text(cx - 4, at(0, v)[1], formatNumber(Math.round(v / sc.unit) * sc.unit, 'General', sc.unit), st, 'end');
  }
  for (let i = 0; i < nCat; i++) {
    const [x, y] = at(i, sc.max);
    s.line(cx, cy, x, y, '#D9D9D9', 1);
    const c = Math.cos(ang(i));
    const lx = cx + (R + 8) * c;
    const ly = cy + (R + st.size * 0.8) * Math.sin(ang(i));
    s.text(lx, ly, cats[i] || String(i + 1), st, Math.abs(c) < 0.2 ? 'middle' : c > 0 ? 'start' : 'end');
  }
  g.series.forEach((ser, si) => {
    const pts = ser.vals.slice(0, nCat).map((v, i) => at(i, v ?? sc.min));
    if (pts.length < 2) return;
    const color = ser.line && ser.line !== 'none' ? ser.line : paletteColor(si, theme);
    if (g.radarFill) s.path(poly(pts), ser.fill && ser.fill !== 'none' ? ser.fill : color, 'none', 0, ' fill-opacity="0.8"');
    else s.path(poly(pts), 'none', color, ser.lineW ?? 2.5, ' stroke-linejoin="round"');
    if (ser.marker) for (const p of pts) s.path(`M${r1(p[0] - 3)} ${r1(p[1])}a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z`, ser.markerColor || color);
  });
}

/** 축이 있는 차트: 값 축·항목 축(분산형은 둘 다 값 축), 눈금선, 막대·꺾은선·영역·점 */
function drawAxes(s: Svg, groups: Group[], plot: Element, box: { left: number; top: number; right: number; bottom: number }, theme: Map<string, string>, txt: TextStyle, gray: string) {
  const g0 = groups[0];
  const horiz = g0.kind === 'bar' && g0.dir === 'bar';
  const scatter = g0.kind === 'scatter';
  const valAxes = kids(plot, 'valAx');
  const catAx = kid(plot, 'catAx') || kid(plot, 'dateAx');
  // 분산형은 가로 값 축(축 위치 b·t)과 세로 값 축이 따로
  const vAx = scatter ? valAxes.find((a) => ['l', 'r'].includes(attr(kid(a, 'axPos'), 'val') || '')) || valAxes[1] || valAxes[0] : valAxes[0] || null;
  const xAx = scatter ? valAxes.find((a) => a !== vAx) || null : catAx;
  const axText = (ax: Element | null) => textStyleOf(kid(ax, 'txPr'), theme, txt.size === (10 * 96) / 72 ? { ...txt, size: (9 * 96) / 72 } : txt);
  const vt = axText(vAx);
  const ct = axText(xAx);
  const deleted = (ax: Element | null) => !ax || attr(kid(ax, 'delete'), 'val') === '1' || attr(kid(ax, 'tickLblPos'), 'val') === 'none';
  const fixedOf = (ax: Element | null) => {
    const sc = kid(ax, 'scaling');
    const n = (e: Element | null) => (e ? numOf(attr(e, 'val')) ?? undefined : undefined);
    return { min: n(kid(sc, 'min')), max: n(kid(sc, 'max')), unit: n(kid(ax, 'majorUnit')) };
  };
  // 값의 범위 (누적은 항목마다 더한 값)
  let lo = Infinity;
  let hi = -Infinity;
  let pct = false;
  const nCat = Math.max(1, ...groups.flatMap((g) => g.series.map((ser) => Math.max(ser.vals.length, ser.cats.length))));
  for (const g of groups) {
    if (g.grouping === 'percentStacked') {
      pct = true;
      lo = Math.min(lo, 0);
      hi = Math.max(hi, 1);
      continue;
    }
    if (g.grouping === 'stacked' && g.kind !== 'scatter') {
      for (let i = 0; i < nCat; i++) {
        let pos = 0;
        let neg = 0;
        for (const ser of g.series) {
          const v = ser.vals[i] ?? 0;
          if (v >= 0) pos += v;
          else neg += v;
        }
        lo = Math.min(lo, neg);
        hi = Math.max(hi, pos);
      }
    } else for (const ser of g.series) for (const v of ser.vals) if (v != null) ((lo = Math.min(lo, v)), (hi = Math.max(hi, v)));
  }
  if (!Number.isFinite(lo)) ((lo = 0), (hi = 1));
  const sc = niceScale(lo, hi, pct ? { min: 0, max: 1, unit: fixedOf(vAx).unit ?? 0.1 } : fixedOf(vAx));
  const vFmt = (() => {
    const nf = kid(vAx, 'numFmt');
    if (pct) return '0%';
    if (nf && attr(nf, 'sourceLinked') !== '1') return attr(nf, 'formatCode') || 'General';
    return g0.series[0]?.fmt || 'General';
  })();
  const ticks: number[] = [];
  for (let v = sc.min, k = 0; v <= sc.max + sc.unit * 1e-6 && k < 60; v += sc.unit, k++) ticks.push(Math.round(v / sc.unit) * sc.unit);
  const vLabels = deleted(vAx) ? [] : ticks.map((v) => formatNumber(v, vFmt, sc.unit));
  // 분산형의 가로 값 축
  let xs: { min: number; max: number; unit: number } | null = null;
  let xLabels: string[] = [];
  let xTicks: number[] = [];
  if (scatter) {
    let xlo = Infinity;
    let xhi = -Infinity;
    for (const g of groups)
      for (const ser of g.series)
        ser.vals.forEach((_, i) => {
          const x = ser.xs ? ser.xs[i] : i + 1;
          if (x != null) ((xlo = Math.min(xlo, x)), (xhi = Math.max(xhi, x)));
        });
    xs = niceScale(xlo, xhi, fixedOf(xAx));
    for (let v = xs.min, k = 0; v <= xs.max + xs.unit * 1e-6 && k < 60; v += xs.unit, k++) xTicks.push(Math.round(v / xs.unit) * xs.unit);
    xLabels = deleted(xAx) ? [] : xTicks.map((v) => formatNumber(v, 'General', xs!.unit));
  }
  const cats: string[] = [];
  const firstSer = g0.series[0];
  for (let i = 0; i < nCat; i++) cats.push(firstSer?.cats[i] || String(i + 1));
  const catLabels = deleted(xAx) || scatter ? [] : cats;
  // 축 글자 자리
  const valSt = horiz ? ct : vt;
  const sideLabels = horiz ? catLabels : scatter ? vLabels : vLabels;
  const sideW = sideLabels.length ? Math.min((box.right - box.left) * 0.4, Math.max(...sideLabels.map((t) => textW(t, (horiz ? ct : vt).size)))) + 8 : 0;
  const bottomLabels = horiz ? vLabels : scatter ? xLabels : catLabels;
  const bottomH = bottomLabels.length ? (horiz ? vt : ct).size * 1.6 : 0;
  const L = box.left + sideW;
  const R = box.right - 4;
  const T = box.top + 4;
  const B = box.bottom - bottomH;
  if (!(R - L > 10 && B - T > 10)) return;
  void valSt;
  const reverseCats = attr(kid(kid(xAx, 'scaling'), 'orientation'), 'val') === 'maxMin';
  // 값 → 화면 자리
  const vPos = (v: number) => {
    const f = (v - sc.min) / (sc.max - sc.min || 1);
    return horiz ? L + f * (R - L) : B - f * (B - T);
  };
  // 눈금선 (값 축의 majorGridlines, 없으면 그리지 않는다)
  const grid = kid(vAx, 'majorGridlines');
  const gridColor = grid ? colorOf(kid(kid(kid(grid, 'spPr'), 'ln'), 'solidFill'), theme)?.c || '#D9D9D9' : null;
  if (gridColor)
    for (const v of ticks) {
      const p = vPos(v);
      if (horiz) s.line(p, T, p, B, gridColor, 1);
      else s.line(L, p, R, p, gridColor, 1);
    }
  if (scatter && xs && kid(xAx, 'majorGridlines')) for (const v of xTicks) s.line(L + ((v - xs.min) / (xs.max - xs.min || 1)) * (R - L), T, L + ((v - xs.min) / (xs.max - xs.min || 1)) * (R - L), B, gridColor || '#D9D9D9', 1);
  // 값 축 글자
  vLabels.forEach((t, i) => {
    const p = vPos(ticks[i]);
    if (horiz) s.text(p, B + vt.size * 0.85, t, vt, 'middle');
    else s.text(L - 6, p, t, vt, 'end');
  });
  // 항목 자리 (가로 막대는 아래에서 위로)
  const band = (horiz ? B - T : R - L) / nCat;
  const catAt = (i: number) => {
    const k = reverseCats ? nCat - 1 - i : i;
    return horiz ? B - (k + 0.5) * band : L + (k + 0.5) * band;
  };
  if (catLabels.length) {
    const st = horiz ? ct : ct;
    // 겹치는 글은 건너뛴다
    const maxW = horiz ? sideW - 8 : band;
    const step = horiz ? Math.max(1, Math.ceil((st.size * 1.2) / band)) : Math.max(1, Math.ceil(Math.max(...catLabels.map((c) => textW(c, st.size))) / Math.max(1, band - 4)));
    const useStep = horiz ? step : step > 1 && step * band > 60 ? step : step;
    catLabels.forEach((c, i) => {
      if (i % useStep) return;
      const p = catAt(i);
      if (horiz) s.text(L - 6, p, fitText(c, st.size, maxW), st, 'end');
      else s.text(p, B + st.size * 0.85, fitText(c, st.size, useStep > 1 ? band * useStep : band - 2), st, 'middle');
    });
  }
  if (scatter && xs)
    xLabels.forEach((t, i) => {
      const p = L + ((xTicks[i] - xs!.min) / (xs!.max - xs!.min || 1)) * (R - L);
      s.text(p, B + ct.size * 0.85, t, ct, 'middle');
    });
  // 계열
  const zero = vPos(Math.max(sc.min, Math.min(sc.max, 0)));
  for (const g of groups) {
    const n = g.series.length;
    if (g.kind === 'bar') {
      const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked';
      // 간격(gapWidth)은 막대 하나 폭에 대한 비율, 겹침(overlap)도 막대 폭에 대한 비율 (음수면 막대 사이를 띄운다)
      const k = stacked ? 1 : n;
      const ov = stacked ? 1 : g.overlap / 100;
      const bw = band / (k - (k - 1) * ov + g.gap / 100);
      const groupW = bw * (k - (k - 1) * ov);
      const posAcc = new Array(nCat).fill(0);
      const negAcc = new Array(nCat).fill(0);
      const totals = new Array(nCat).fill(0).map((_, i) => g.series.reduce((a, ser) => a + Math.abs(ser.vals[i] ?? 0), 0));
      g.series.forEach((ser, si) => {
        for (let i = 0; i < nCat; i++) {
          let v = ser.vals[i];
          if (v == null) continue;
          if (g.grouping === 'percentStacked') v = totals[i] ? v / totals[i] : 0;
          const c = catAt(i);
          const off = stacked ? -bw / 2 : -groupW / 2 + si * bw * (1 - ov);
          let a0 = 0;
          let a1 = v;
          if (stacked) {
            const acc = v >= 0 ? posAcc : negAcc;
            a0 = acc[i];
            a1 = acc[i] + v;
            acc[i] = a1;
          }
          const p0 = vPos(Math.max(sc.min, Math.min(sc.max, a0)));
          const p1 = vPos(Math.max(sc.min, Math.min(sc.max, a1)));
          const color = ser.pts.get(i) || (g.vary ? paletteColor(i, theme) : ser.fill || paletteColor(si, theme));
          if (color === 'none') continue;
          // 가로 막대: 계열이 아래에서 위로 쌓인다
          if (horiz) s.rect(Math.min(p0, p1), c - off - bw, Math.abs(p1 - p0), bw, color);
          else s.rect(c + off, Math.min(p0, p1), bw, Math.abs(p1 - p0), color);
          if (g.labels.val) {
            const lt = formatNumber(ser.vals[i]!, ser.fmt);
            if (horiz) s.text(Math.max(p0, p1) + 4, c - off - bw / 2, lt, { ...txt, size: (9 * 96) / 72, color: '#404040' });
            else s.text(c + off + bw / 2, Math.min(p0, p1) - 8, lt, { ...txt, size: (9 * 96) / 72, color: '#404040' }, 'middle');
          }
        }
      });
    } else if (g.kind === 'line' || g.kind === 'area' || g.kind === 'scatter') {
      const acc = new Array(nCat).fill(0);
      const totals = new Array(nCat).fill(0).map((_, i) => g.series.reduce((a, ser) => a + (ser.vals[i] ?? 0), 0));
      const stacked = g.grouping === 'stacked' || g.grouping === 'percentStacked';
      const layers: { pts: [number, number][]; base: [number, number][]; ser: Series; si: number }[] = [];
      g.series.forEach((ser, si) => {
        const pts: [number, number][] = [];
        const basePts: [number, number][] = [];
        for (let i = 0; i < Math.max(nCat, ser.vals.length); i++) {
          let v = ser.vals[i];
          if (v == null) continue;
          if (g.grouping === 'percentStacked') v = totals[i] ? v / totals[i] : 0;
          const b0 = stacked ? acc[i] : 0;
          const v1 = stacked ? b0 + v : v;
          if (stacked) acc[i] = v1;
          let x: number;
          if (g.kind === 'scatter' && xs) {
            const xv = ser.xs ? ser.xs[i] : i + 1;
            if (xv == null) continue;
            x = L + ((xv - xs.min) / (xs.max - xs.min || 1)) * (R - L);
          } else x = catAt(i);
          pts.push([x, vPos(Math.max(sc.min, Math.min(sc.max, v1)))]);
          basePts.push([x, vPos(Math.max(sc.min, Math.min(sc.max, b0)))]);
        }
        layers.push({ pts, base: basePts, ser, si });
      });
      // 주식형의 고가-저가 선: 항목마다 가장 낮은 값에서 가장 높은 값까지
      if (g.hiLow)
        for (let i = 0; i < nCat; i++) {
          const vs = g.series.map((ser) => ser.vals[i]).filter((v): v is number => v != null);
          if (vs.length > 1) s.line(catAt(i), vPos(Math.min(...vs)), catAt(i), vPos(Math.max(...vs)), '#7F7F7F', 1);
        }
      for (const { pts, base, ser, si } of layers) {
        if (!pts.length) continue;
        const color = (g.kind === 'area' ? ser.fill : ser.line) || paletteColor(si, theme);
        if (g.kind === 'area') {
          // 영역: 항목 칸의 가운데 사이를 칠한다 (Word 는 첫·끝 항목 칸 가운데에서 시작·끝)
          const d = 'M' + pts.map((p) => `${r1(p[0])} ${r1(p[1])}`).join('L') + 'L' + [...base].reverse().map((p) => `${r1(p[0])} ${r1(p[1])}`).join('L') + 'Z';
          if (color !== 'none') s.path(stacked ? d : d.replace(/L[^L]*Z$/, '') + `L${r1(pts[pts.length - 1][0])} ${r1(zero)}L${r1(pts[0][0])} ${r1(zero)}Z`, color);
        } else {
          const w = ser.lineW ?? (g.kind === 'scatter' ? 0 : 3);
          if (color !== 'none' && w > 0 && (g.kind === 'line' || ser.lineW)) s.path('M' + pts.map((p) => `${r1(p[0])} ${r1(p[1])}`).join('L'), 'none', color, w, ' stroke-linejoin="round" stroke-linecap="round"');
          if (ser.marker || g.kind === 'scatter') for (const p of pts) s.path(`M${r1(p[0] - 3.5)} ${r1(p[1])}a3.5 3.5 0 1 0 7 0a3.5 3.5 0 1 0 -7 0Z`, ser.markerColor || (color === 'none' ? paletteColor(si, theme) : color));
        }
        if (g.labels.val)
          pts.forEach((p, i) => {
            const v = ser.vals.filter((x) => x != null)[i];
            if (v != null) s.text(p[0], p[1] - 10, formatNumber(v, ser.fmt), { ...txt, size: (9 * 96) / 72, color: '#404040' }, 'middle');
          });
      }
    }
  }
  // 항목 축 선 (값 0 자리. 적힌 선이 없으면 연한 회색)
  if (!scatter) {
    const axLn = kid(kid(xAx, 'spPr'), 'ln');
    const axColor = axLn ? (kid(axLn, 'noFill') ? null : colorOf(kid(axLn, 'solidFill'), theme)?.c || '#D9D9D9') : deleted(xAx) ? null : '#D9D9D9';
    if (axColor) {
      if (horiz) s.line(zero, T, zero, B, axColor, 1);
      else s.line(L, zero, R, zero, axColor, 1);
    }
  } else {
    s.line(L, B, R, B, '#D9D9D9', 1);
  }
  void gray;
}

/** 차트 XML 에서 계열·값을 꺼내 본다 (시험용) */
export function chartSummary(xml: string): { kinds: string[]; series: { name: string; n: number }[] } | null {
  try {
    const doc = parseXml(xml);
    const plot = kid(kid(doc.documentElement, 'chart'), 'plotArea');
    const kinds = kids(plot).map(localName).filter((n) => GROUPS[n]);
    const series = descendants(plot, 'ser').map((s, i) => {
      const ser = parseSeries(s, 'bar', i, new Map());
      return { name: ser.name, n: ser.vals.length };
    });
    return { kinds, series };
  } catch {
    return null;
  }
}
