// Word·Excel 차트(c:chartSpace) → SVG: 막대·꺾은선·원형·분산형·방사형, 값 축 눈금, 표시 형식, 망가진 입력
//   node tests/test-chart.mjs
import { load } from './harness.mjs';
const m = await load('src/formats/chart.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};
const svgOf = (url) => (url ? Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString() : '');

const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const strCache = (vals) => `<c:strCache><c:ptCount val="${vals.length}"/>${vals.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join('')}</c:strCache>`;
const numCache = (vals, fmt = 'General') => `<c:numCache><c:formatCode>${fmt}</c:formatCode><c:ptCount val="${vals.length}"/>${vals.map((v, i) => (v == null ? '' : `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`)).join('')}</c:numCache>`;
const ser = (i, name, cats, vals, extra = '') =>
  `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:strRef>${strCache([name])}</c:strRef></c:tx>${extra}<c:cat><c:strRef>${strCache(cats)}</c:strRef></c:cat><c:val><c:numRef>${numCache(vals)}</c:numRef></c:val></c:ser>`;
const axes = '<c:catAx><c:axId val="1"/><c:delete val="0"/><c:axPos val="b"/></c:catAx><c:valAx><c:axId val="2"/><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/></c:valAx>';
const chart = (plot, extra = '') => `<?xml version="1.0"?><c:chartSpace ${C}><c:lang val="en-US"/><c:chart>${extra}<c:plotArea><c:layout/>${plot}</c:plotArea><c:legend><c:legendPos val="b"/></c:legend></c:chart></c:chartSpace>`;
const theme = new Map([['accent1', '#4472C4'], ['accent2', '#ED7D31'], ['accent3', '#A5A5A5'], ['dk1', '#000000']]);

// ---- 값 축 눈금 (Excel 처럼) ----
{
  const a = m.niceScale(2, 5);
  ok(a.min === 0 && a.max === 6 && a.unit === 1, '최댓값 5 → 0~6, 간격 1 (5% 여유 후 올림)', JSON.stringify(a));
  const b = m.niceScale(0, 100);
  ok(b.min === 0 && b.max === 120 && b.unit === 20, '최댓값 100 → 0~120, 간격 20 (10칸 이하)', JSON.stringify(b));
  const c = m.niceScale(-30, 45);
  ok(c.min < -30 && c.max > 45 && c.min % c.unit === 0, '음수가 든 값: 0 을 지나 양쪽으로', JSON.stringify(c));
  const d = m.niceScale(10, 20, { min: 5, max: 25, unit: 5 });
  ok(d.min === 5 && d.max === 25 && d.unit === 5, '축에 적은 최솟값·최댓값·간격', JSON.stringify(d));
}

// ---- 표시 형식 ----
{
  ok(m.formatNumber(0.25, '0%') === '25%' && m.formatNumber(1234567.891, '#,##0.00') === '1,234,567.89', '백분율·천 단위 쉼표·소수 자리');
  ok(m.formatNumber(37261, 'm/d/yyyy') === '1/5/2002' && m.formatNumber(37261, 'yyyy-mm-dd') === '2002-01-05', '날짜 일련번호 → 날짜', m.formatNumber(37261, 'm/d/yyyy'));
  ok(m.formatNumber(0.5, 'General', 0.5) === '0.5' && m.formatNumber(1, 'General', 0.5) === '1' && m.formatNumber(0.30000000000000004, 'General', 0.1) === '0.3' && m.formatNumber(4.4000000000000004, 'General') === '4.4', '일반 형식: 가장 짧게, 부동 소수 오차 없이');
}

// ---- 묶은 세로 막대: 막대 수·색·눈금·범례 ----
{
  const cats = ['A', 'B', 'C', 'D'];
  const plot =
    `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>` +
    ser(0, 'S1', cats, [4.3, 2.5, 3.5, 4.5]) +
    ser(1, 'S2', cats, [2.4, 4.4, 1.8, 5], '<c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr>') +
    `<c:gapWidth val="219"/><c:overlap val="-27"/><c:axId val="1"/><c:axId val="2"/></c:barChart>` +
    axes;
  const svg = svgOf(m.chartToSvg(chart(plot, '<c:title><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>'), { w: 480, h: 300, theme }));
  const bars = [...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" fill="(#[0-9A-F]{6})"\/>/g)].filter((r) => r[5] === '#4472C4' || r[5] === '#FF0000');
  ok(bars.filter((r) => +r[3] > 10).length === 8, '막대 8개 (계열 2 × 항목 4, 범례 칸은 작다)', String(bars.length));
  ok(svg.includes('fill="#4472C4"') && svg.includes('fill="#FF0000"'), '색을 적지 않은 계열은 강조색 1, 적은 계열은 그 색');
  ok(/>Chart Title</.test(svg) && />S1</.test(svg) && />S2</.test(svg), '글 없는 제목은 Chart Title (영어 문서), 범례에 계열 이름');
  ok(/>6</.test(svg) && />0</.test(svg) && !/>7</.test(svg) && !/>0\.0</.test(svg), '값 축 0~6 (최댓값 5), 일반 형식은 짧게', '');
  // 막대 폭: 항목 칸 = 막대 폭 × (2 + 0.27 + 2.19): 막대 둘 + 사이 + 간격
  const big = bars.filter((r) => +r[3] > 10);
  const w = +big[0][3];
  const xs = big.filter((r) => r[5] === '#4472C4').map((r) => +r[1]).sort((a, b) => a - b);
  const band = xs[1] - xs[0];
  ok(Math.abs(band / w - (2 + 0.27 + 2.19)) < 0.05, '막대 폭: 간격(gapWidth)·겹침(overlap)은 막대 하나 폭에 대한 비율', `${band / w}`);
}

// ---- 가로 막대·누적·원형·꺾은선·분산형·방사형 ----
{
  const cats = ['가', '나', '다'];
  const stacked = svgOf(m.chartToSvg(chart(`<c:barChart><c:barDir val="bar"/><c:grouping val="percentStacked"/>${ser(0, 'X', cats, [1, 2, 3])}${ser(1, 'Y', cats, [3, 2, 1])}<c:overlap val="100"/><c:axId val="1"/><c:axId val="2"/></c:barChart>${axes}`), { w: 400, h: 300, theme }));
  ok(/>100%</.test(stacked) && /><\/?/.test(stacked) && />가</.test(stacked), '100% 누적 가로 막대: 값 축 0%~100%, 항목 글', '');
  const pie = svgOf(m.chartToSvg(chart(`<c:pieChart><c:varyColors val="1"/>${ser(0, '점유율', ['갑', '을', '병'], [50, 30, 20])}<c:dLbls><c:showPercent val="1"/></c:dLbls><c:firstSliceAng val="0"/></c:pieChart>`), { w: 400, h: 300, theme }));
  ok((pie.match(/<path d="M[\d. ]+L[\d. ]+A/g) || []).length === 3 && />50%</.test(pie) && />갑</.test(pie), '원형: 조각 3개, 백분율 레이블, 범례에 항목', '');
  const line = svgOf(m.chartToSvg(chart(`<c:lineChart><c:grouping val="standard"/>${ser(0, 'L', cats, [1, null, 3])}<c:axId val="1"/><c:axId val="2"/></c:lineChart>${axes}`), { w: 400, h: 300, theme }));
  ok(/<path d="M[\d. ]+L[\d. ]+" fill="none" stroke="#4472C4" stroke-width="3"/.test(line), '꺾은선: 빈 값은 건너 이어 그린다 (굵기 3px)', '');
  const radar = svgOf(m.chartToSvg(chart(`<c:radarChart><c:radarStyle val="marker"/>${ser(0, 'R', ['a', 'b', 'c', 'd'], [1, 2, 3, 4])}<c:axId val="1"/><c:axId val="2"/></c:radarChart>${axes}`), { w: 400, h: 300, theme }));
  ok((radar.match(/fill="none" stroke="#D9D9D9"/g) || []).length >= 3 && /stroke="#4472C4"/.test(radar), '방사형: 다각형 눈금선과 계열 다각형', '');
}

// ---- 망가진 입력 ----
{
  ok(m.chartToSvg('<not xml', { w: 100, h: 100 }) === null, 'XML 이 아니면 null');
  ok(m.chartToSvg(chart('<c:surfaceChart/>'), { w: 100, h: 100 }) === null, '그릴 수 없는 종류만 있으면 null');
  const huge = `<c:barChart><c:barDir val="col"/><c:ser><c:idx val="0"/><c:order val="0"/><c:val><c:numRef><c:numCache><c:ptCount val="999999999"/><c:pt idx="5000000"><c:v>1</c:v></c:pt><c:pt idx="1"><c:v>1e400</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser></c:barChart>${axes}`;
  const t0 = Date.now();
  const r = m.chartToSvg(chart(huge), { w: 1e9, h: -5 });
  ok(r !== null && Date.now() - t0 < 2000, '엄청난 점 수·범위를 넘는 값·크기도 줄여서 빨리', String(Date.now() - t0));
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
