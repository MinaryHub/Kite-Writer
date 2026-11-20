import { attr, descendant, descendants, kid, kids, localName } from './common';

/**
 * HWPX 의 차트(Chart/chartN.xml: OOXML 차트)를 벡터 그림(SVG)으로 그린다.
 * 막대(세로·가로, 묶은·누적)·꺾은선·원(도넛) 차트의 눈금·범례·값 표시까지 다룬다. 한글의 차트 모양과 똑같지는 않지만
 * 같은 자리·크기에 같은 값이 보인다. 그릴 수 없는 종류면 null
 */

const PALETTE = ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47', '#264478', '#9E480E'];
const n = (v: number) => String(Math.round(v * 100) / 100);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');

interface Series {
  name: string;
  color: string;
  cats: string[];
  vals: (number | null)[];
  /** 점마다의 색 (원 차트) */
  ptColors: Map<number, string>;
  showVal: boolean;
  fmt: string;
}

function colorOf(spPr: Element | null): string | null {
  const fill = kid(spPr, 'solidFill');
  const c = attr(kid(fill, 'srgbClr'), 'val');
  return c && /^[0-9A-Fa-f]{6}$/.test(c) ? '#' + c.toUpperCase() : null;
}

/** 캐시된 점들 (strCache·numCache) → 차례대로의 글자 */
function cachePts(ref: Element | null): string[] {
  const cache = ref ? descendant(ref, 'strCache') || descendant(ref, 'numCache') || descendant(ref, 'strLit') || descendant(ref, 'numLit') : null;
  const out: string[] = [];
  for (const pt of kids(cache, 'pt')) out[+(attr(pt, 'idx') || out.length)] = kid(pt, 'v')?.textContent || '';
  for (let i = 0; i < out.length; i++) if (out[i] == null) out[i] = '';
  return out;
}

/** 표시 형식(#,##0 · 0.0 · 0% …)대로 수를 적는다 */
function fmtNum(v: number, code: string): string {
  const c = code && code !== 'General' ? code.split(';')[0] : '';
  const pct = c.includes('%');
  const x = pct ? v * 100 : v;
  const dm = /\.([0#]+)/.exec(c);
  const dec = dm ? dm[1].length : c ? 0 : Math.abs(x) >= 100 || Number.isInteger(x) ? 0 : 2;
  let s = x.toFixed(dec);
  if (!c && s.includes('.')) s = s.replace(/\.?0+$/, '');
  if (c.includes(',')) {
    const [i, f] = s.split('.');
    s = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
  }
  return s + (pct ? '%' : '');
}

/** 눈금: 엑셀처럼 보기 좋은 간격(1·2·5 × 10ⁿ)으로, 자료의 끝에서 조금 넉넉하게 */
function niceAxis(lo: number, hi: number, fixedMin: number | null, fixedMax: number | null, unit: number | null): { min: number; max: number; step: number } {
  let min = fixedMin ?? Math.min(0, lo);
  let max = fixedMax ?? hi + (hi - Math.min(0, lo)) * 0.05;
  if (!(max > min)) max = min + 1;
  let step = unit && unit > 0 ? unit : 0;
  if (!step) {
    const raw = (max - min) / 5;
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const m = raw / p;
    step = (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
  }
  if (fixedMin == null) min = Math.floor(min / step) * step;
  if (fixedMax == null) max = Math.ceil(max / step - 1e-9) * step;
  if ((max - min) / step > 40) step = (max - min) / 10;
  return { min, max, step };
}

function textOf(el: Element | null): string {
  return descendants(el, 't')
    .map((t) => t.textContent || '')
    .join('');
}

/** 글자 크기(pt): txPr·rich 의 sz (1/100 pt) */
function fontPt(el: Element | null, def: number): number {
  for (const r of [...descendants(el, 'defRPr'), ...descendants(el, 'rPr')]) {
    const sz = +(attr(r, 'sz') || 0);
    if (sz > 0) return Math.max(5, Math.min(40, sz / 100));
  }
  return def;
}

export function chartToSvg(doc: Document, w: number, h: number): string | null {
  const plot = descendant(doc, 'plotArea');
  if (!plot || !(w > 20) || !(h > 20)) return null;
  const chartEl = kids(plot).find((e) => /Chart$/.test(localName(e)));
  if (!chartEl) return null;
  const type = localName(chartEl);
  const horizontal = type === 'barChart' && attr(kid(chartEl, 'barDir'), 'val') === 'bar';
  const grouping = attr(kid(chartEl, 'grouping'), 'val') || 'clustered';
  const stacked = grouping === 'stacked' || grouping === 'percentStacked';
  const chartLbls = kid(chartEl, 'dLbls');
  const series: Series[] = kids(chartEl, 'ser').map((ser, i) => {
    const lbls = kid(ser, 'dLbls') || chartLbls;
    const ptColors = new Map<number, string>();
    for (const dp of kids(ser, 'dPt')) {
      const c = colorOf(kid(dp, 'spPr'));
      if (c) ptColors.set(+(attr(kid(dp, 'idx'), 'val') || 0), c);
    }
    const lineColor = attr(kid(kid(kid(kid(ser, 'spPr'), 'ln'), 'solidFill'), 'srgbClr'), 'val');
    return {
      name: cachePts(kid(ser, 'tx'))[0] || `계열 ${i + 1}`,
      color: (type === 'lineChart' && lineColor && /^[0-9A-Fa-f]{6}$/.test(lineColor) ? '#' + lineColor.toUpperCase() : colorOf(kid(ser, 'spPr'))) || PALETTE[i % PALETTE.length],
      cats: cachePts(kid(ser, 'cat')),
      vals: cachePts(kid(ser, 'val')).map((v) => (v === '' || !isFinite(+v) ? null : +v)),
      ptColors,
      showVal: !!lbls && attr(kid(lbls, 'showVal'), 'val') === '1' && attr(kid(lbls, 'delete'), 'val') !== '1',
      fmt: attr(kid(lbls, 'numFmt'), 'formatCode') || '',
    };
  });
  if (!series.length) return null;
  const cats = series.reduce<string[]>((a, s) => (s.cats.length > a.length ? s.cats : a), []);
  const nCat = Math.max(cats.length, ...series.map((s) => s.vals.length));
  if (!nCat) return null;
  const FONT = `font-family='Arial, "Malgun Gothic", "맑은 고딕", sans-serif'`;
  const titleEl = kid(descendant(doc, 'chart'), 'title');
  const title = attr(kid(descendant(doc, 'chart'), 'autoTitleDeleted'), 'val') === '1' ? '' : textOf(titleEl);
  const legendEl = kid(descendant(doc, 'chart'), 'legend');
  const legendPos = legendEl ? attr(kid(legendEl, 'legendPos'), 'val') || 'r' : '';
  const PX = 96 / 72;
  let body = '';
  let x0 = 6;
  let y0 = 6;
  let x1 = w - 6;
  let y1 = h - 6;
  if (title) {
    const fs = fontPt(titleEl, 14) * PX;
    body += `<text x='${n(w / 2)}' y='${n(y0 + fs)}' text-anchor='middle' font-size='${n(fs)}' ${FONT}>${esc(title)}</text>`;
    y0 += fs * 1.5;
  }
  // 범례
  const pie = type === 'pieChart' || type === 'doughnutChart' || type === 'pie3DChart';
  const legendItems = pie ? Array.from({ length: nCat }, (_, i) => ({ name: cats[i] || String(i + 1), color: series[0].ptColors.get(i) || PALETTE[i % PALETTE.length] })) : series.map((s) => ({ name: s.name, color: s.color }));
  if (legendPos && legendItems.length) {
    const fs = fontPt(legendEl, 10) * PX;
    const itemW = (t: string) => fs * 1.6 + [...t].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e7f ? fs : fs * 0.56), 0) + fs;
    if (legendPos === 'b' || legendPos === 't') {
      const total = legendItems.reduce((a, it) => a + itemW(it.name), 0);
      let x = Math.max(x0, (w - total) / 2);
      const y = legendPos === 'b' ? y1 - fs * 0.4 : y0 + fs;
      for (const it of legendItems) {
        body += `<rect x='${n(x)}' y='${n(y - fs * 0.75)}' width='${n(fs * 0.8)}' height='${n(fs * 0.8)}' fill='${it.color}'/><text x='${n(x + fs * 1.2)}' y='${n(y)}' font-size='${n(fs)}' ${FONT}>${esc(it.name)}</text>`;
        x += itemW(it.name);
      }
      if (legendPos === 'b') y1 -= fs * 1.8;
      else y0 += fs * 1.8;
    } else {
      const lw = Math.min(w * 0.35, Math.max(...legendItems.map((it) => itemW(it.name))));
      const left = legendPos === 'l';
      let y = (y0 + y1) / 2 - (legendItems.length * fs * 1.5) / 2 + fs;
      const x = left ? x0 : x1 - lw;
      for (const it of legendItems) {
        body += `<rect x='${n(x)}' y='${n(y - fs * 0.75)}' width='${n(fs * 0.8)}' height='${n(fs * 0.8)}' fill='${it.color}'/><text x='${n(x + fs * 1.2)}' y='${n(y)}' font-size='${n(fs)}' ${FONT}>${esc(it.name)}</text>`;
        y += fs * 1.5;
      }
      if (left) x0 += lw + 6;
      else x1 -= lw + 6;
    }
  }

  if (pie) {
    const s = series[0];
    const vals = s.vals.map((v) => Math.max(0, v || 0));
    const sum = vals.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) return null;
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    const r = Math.max(4, Math.min(x1 - x0, y1 - y0) / 2 - 4);
    const hole = type === 'doughnutChart' ? r * 0.5 : 0;
    const fs = 10 * PX;
    let a = -Math.PI / 2;
    vals.forEach((v, i) => {
      const b = a + (v / sum) * Math.PI * 2;
      const col = s.ptColors.get(i) || PALETTE[i % PALETTE.length];
      const large = b - a > Math.PI ? 1 : 0;
      const p = (ang: number, rad: number) => `${n(cx + rad * Math.cos(ang))} ${n(cy + rad * Math.sin(ang))}`;
      if (v >= sum - 1e-9) body += `<circle cx='${n(cx)}' cy='${n(cy)}' r='${n(r)}' fill='${col}'/>`;
      else if (v > 0) body += `<path d='M${p(a, r)} A${n(r)} ${n(r)} 0 ${large} 1 ${p(b, r)} L${hole ? p(b, hole) + ` A${n(hole)} ${n(hole)} 0 ${large} 0 ${p(a, hole)}` : `${n(cx)} ${n(cy)}`} Z' fill='${col}' stroke='#fff' stroke-width='1'/>`;
      if (s.showVal && v > 0) {
        const mid = (a + b) / 2;
        const rr = hole ? (r + hole) / 2 : r * 0.65;
        body += `<text x='${n(cx + rr * Math.cos(mid))}' y='${n(cy + rr * Math.sin(mid) + fs * 0.35)}' text-anchor='middle' font-size='${n(fs)}' ${FONT}>${esc(fmtNum(s.vals[i] || 0, s.fmt))}</text>`;
      }
      a = b;
    });
    if (hole) body += `<circle cx='${n(cx)}' cy='${n(cy)}' r='${n(hole)}' fill='#fff'/>`;
  } else if (type === 'barChart' || type === 'lineChart' || type === 'areaChart' || type === 'bar3DChart') {
    const valAx = kids(plot, 'valAx')[0] || null;
    const catAx = kids(plot, 'catAx')[0] || kids(plot, 'dateAx')[0] || null;
    const sc = kid(valAx, 'scaling');
    const num = (e: Element | null) => (e && attr(e, 'val') != null && isFinite(+attr(e, 'val')!) ? +attr(e, 'val')! : null);
    // 값의 범위 (누적이면 항목마다의 합)
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < nCat; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of series) {
        const v = s.vals[i] || 0;
        if (stacked) v >= 0 ? (pos += v) : (neg += v);
        else {
          hi = Math.max(hi, v);
          lo = Math.min(lo, v);
        }
      }
      if (stacked) {
        hi = Math.max(hi, pos);
        lo = Math.min(lo, neg);
      }
    }
    const ax = niceAxis(lo, hi, num(kid(sc, 'min')), num(kid(sc, 'max')), num(kid(valAx, 'majorUnit')));
    const axFmt = attr(kid(valAx, 'numFmt'), 'formatCode') || '';
    const valShown = !!valAx && attr(kid(valAx, 'delete'), 'val') !== '1';
    const catShown = !!catAx && attr(kid(catAx, 'delete'), 'val') !== '1';
    const fsV = fontPt(kid(valAx, 'txPr'), 10) * PX;
    const fsC = fontPt(kid(catAx, 'txPr'), 10) * PX;
    const vTitle = textOf(kid(valAx, 'title'));
    const cTitle = textOf(kid(catAx, 'title'));
    const ticks: number[] = [];
    for (let v = ax.min; v <= ax.max + ax.step * 1e-6; v += ax.step) ticks.push(Math.abs(v) < ax.step * 1e-9 ? 0 : v);
    const tickLabels = ticks.map((v) => fmtNum(v, axFmt));
    const labW = valShown ? Math.max(...tickLabels.map((t) => t.length)) * fsV * 0.56 + 6 : 0;
    const vTitleW = vTitle ? fontPt(kid(valAx, 'title'), 10) * PX * 1.6 : 0;
    const cTitleH = cTitle ? fontPt(kid(catAx, 'title'), 10) * PX * 1.6 : 0;
    // 그림 영역
    let px0 = x0;
    let py0 = y0 + fsV * 0.8;
    let px1 = x1 - 4;
    let py1 = y1;
    if (horizontal) {
      const catW = catShown ? Math.min((x1 - x0) * 0.35, Math.max(...cats.map((c) => [...c].reduce((a, ch) => a + (ch.charCodeAt(0) > 0x2e7f ? fsC : fsC * 0.56), 0)), 0) + 8) : 0;
      px0 += catW + cTitleH;
      py1 -= (valShown ? fsV * 1.6 : 0) + vTitleW;
      px1 -= fsV * 1.5;
    } else {
      px0 += labW + vTitleW;
      py1 -= (catShown ? fsC * 1.7 : 0) + cTitleH;
    }
    const pw = Math.max(10, px1 - px0);
    const ph = Math.max(10, py1 - py0);
    const V = (v: number) => (v - ax.min) / (ax.max - ax.min);
    const grid = !!kid(valAx, 'majorGridlines');
    // 눈금선과 값 축
    ticks.forEach((v, k) => {
      if (horizontal) {
        const x = px0 + V(v) * pw;
        if (grid) body += `<line x1='${n(x)}' y1='${n(py0)}' x2='${n(x)}' y2='${n(py1)}' stroke='#D9D9D9' stroke-width='0.75'/>`;
        if (valShown) body += `<text x='${n(x)}' y='${n(py1 + fsV * 1.2)}' text-anchor='middle' font-size='${n(fsV)}' ${FONT}>${esc(tickLabels[k])}</text>`;
      } else {
        const y = py1 - V(v) * ph;
        if (grid) body += `<line x1='${n(px0)}' y1='${n(y)}' x2='${n(px1)}' y2='${n(y)}' stroke='#D9D9D9' stroke-width='0.75'/>`;
        if (valShown) body += `<text x='${n(px0 - 5)}' y='${n(y + fsV * 0.35)}' text-anchor='end' font-size='${n(fsV)}' ${FONT}>${esc(tickLabels[k])}</text>`;
      }
    });
    const zero = Math.max(0, Math.min(1, V(0)));
    // 자료
    const band = (horizontal ? ph : pw) / nCat;
    const gapWidth = (num(kid(chartEl, 'gapWidth')) ?? 150) / 100;
    const nBars = stacked ? 1 : series.length;
    const barW = band / (nBars + gapWidth);
    if (type === 'barChart' || type === 'bar3DChart') {
      for (let i = 0; i < nCat; i++) {
        let accP = 0;
        let accN = 0;
        series.forEach((s, k) => {
          const v = s.vals[i];
          if (v == null) return;
          const from = stacked ? (v >= 0 ? accP : accN) : 0;
          const to = from + v;
          if (stacked) v >= 0 ? (accP = to) : (accN = to);
          const a = V(Math.min(from, to));
          const b = V(Math.max(from, to));
          const off = band * i + (band - barW * nBars) / 2 + (stacked ? 0 : barW * k);
          const col = s.ptColors.get(i) || s.color;
          const label = s.showVal ? fmtNum(v, s.fmt) : '';
          if (horizontal) {
            body += `<rect x='${n(px0 + a * pw)}' y='${n(py0 + off)}' width='${n(Math.max(0, (b - a) * pw))}' height='${n(barW)}' fill='${col}'/>`;
            if (label) body += `<text x='${n(px0 + b * pw + 4)}' y='${n(py0 + off + barW / 2 + fsV * 0.35)}' font-size='${n(fsV)}' ${FONT}>${esc(label)}</text>`;
          } else {
            body += `<rect x='${n(px0 + off)}' y='${n(py1 - b * ph)}' width='${n(barW)}' height='${n(Math.max(0, (b - a) * ph))}' fill='${col}'/>`;
            if (label) body += `<text x='${n(px0 + off + barW / 2)}' y='${n(py1 - b * ph - fsV * 0.4)}' text-anchor='middle' font-size='${n(fsV)}' ${FONT}>${esc(label)}</text>`;
          }
        });
      }
    } else {
      for (const s of series) {
        const pts: [number, number][] = [];
        s.vals.forEach((v, i) => {
          if (v != null) pts.push([px0 + band * (i + 0.5), py1 - V(v) * ph]);
        });
        if (!pts.length) continue;
        if (type === 'areaChart') body += `<path d='M${n(pts[0][0])} ${n(py1 - zero * ph)} ${pts.map((p) => `L${n(p[0])} ${n(p[1])}`).join(' ')} L${n(pts[pts.length - 1][0])} ${n(py1 - zero * ph)} Z' fill='${s.color}' fill-opacity='0.6'/>`;
        body += `<path d='${pts.map((p, i) => `${i ? 'L' : 'M'}${n(p[0])} ${n(p[1])}`).join(' ')}' fill='none' stroke='${s.color}' stroke-width='2.25' stroke-linejoin='round'/>`;
        if (type === 'lineChart') for (const p of pts) body += `<circle cx='${n(p[0])}' cy='${n(p[1])}' r='3' fill='${s.color}'/>`;
        if (s.showVal) s.vals.forEach((v, i) => {
          if (v != null) body += `<text x='${n(px0 + band * (i + 0.5))}' y='${n(py1 - V(v) * ph - fsV * 0.6)}' text-anchor='middle' font-size='${n(fsV)}' ${FONT}>${esc(fmtNum(v, s.fmt))}</text>`;
        });
      }
    }
    // 항목 축 (0 의 자리)과 항목 이름
    if (horizontal) {
      const x = px0 + zero * pw;
      body += `<line x1='${n(x)}' y1='${n(py0)}' x2='${n(x)}' y2='${n(py1)}' stroke='#868686' stroke-width='0.75'/>`;
      if (catShown) for (let i = 0; i < nCat; i++) body += `<text x='${n(px0 - 5)}' y='${n(py0 + band * (i + 0.5) + fsC * 0.35)}' text-anchor='end' font-size='${n(fsC)}' ${FONT}>${esc(cats[i] || '')}</text>`;
      if (vTitle) body += `<text x='${n((px0 + px1) / 2)}' y='${n(y1 - 2)}' text-anchor='middle' font-size='${n(fontPt(kid(valAx, 'title'), 10) * PX)}' ${FONT}>${esc(vTitle)}</text>`;
    } else {
      const y = py1 - zero * ph;
      body += `<line x1='${n(px0)}' y1='${n(y)}' x2='${n(px1)}' y2='${n(y)}' stroke='#868686' stroke-width='0.75'/>`;
      if (catShown) for (let i = 0; i < nCat; i++) body += `<text x='${n(px0 + band * (i + 0.5))}' y='${n(py1 + fsC * 1.3)}' text-anchor='middle' font-size='${n(fsC)}' ${FONT}>${esc(cats[i] || '')}</text>`;
      if (vTitle) {
        const fs = fontPt(kid(valAx, 'title'), 10) * PX;
        const tx = x0 + fs;
        const ty = (py0 + py1) / 2;
        body += `<text x='${n(tx)}' y='${n(ty)}' text-anchor='middle' font-size='${n(fs)}' transform='rotate(-90 ${n(tx)} ${n(ty)})' ${FONT}>${esc(vTitle)}</text>`;
      }
      if (cTitle) body += `<text x='${n((px0 + px1) / 2)}' y='${n(y1 - 2)}' text-anchor='middle' font-size='${n(fontPt(kid(catAx, 'title'), 10) * PX)}' ${FONT}>${esc(cTitle)}</text>`;
    }
  } else return null;
  return `<svg xmlns='http://www.w3.org/2000/svg' width='${n(w)}' height='${n(h)}' viewBox='0 0 ${n(w)} ${n(h)}'>${body}</svg>`;
}

/** SVG 글 → 그림 주소 */
export function svgDataUrl(svg: string): string {
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}
