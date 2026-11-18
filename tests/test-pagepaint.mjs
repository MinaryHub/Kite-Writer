// 쪽 테두리/배경과 바탕쪽: HWPX 로 쓰고 다시 읽어 그대로인지 본다.  node tests/test-pagepaint.mjs
import { load } from './harness.mjs';
const m = await load('tests/formats.entry.ts');
let fail = 0;
const check = (name, cond, extra = '') => {
  if (!cond) fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};
const page = { width: 210, height: 297, marginTop: 20, marginBottom: 15, marginLeft: 30, marginRight: 30, marginHeader: 15, marginFooter: 15, gutter: 0, landscape: false };
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const doc = {
  content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: '본문' }] }] },
  settings: {
    page,
    header: { text: '', align: 'center' },
    footer: { text: '', align: 'center' },
    pageNumber: { pos: 'none', format: 'digit', start: 1 },
    pageBorder: {
      body: true,
      offset: [5, 5, 5, 5],
      sides: { l: { w: 0.4, c: '#D17373', s: 'solid' }, r: { w: 0.4, c: '#D17373', s: 'solid' }, t: { w: 0.7, c: '#0000FF', s: 'double' }, b: { w: 0.12, c: '#000000', s: 'dashed' } },
      bg: '#FFF2CC',
      image: PNG,
      imageMode: 'TOTAL',
      fillArea: 'paper',
      borderOn: 'notFirst',
    },
    masterPages: [{ type: 'both', content: [{ type: 'paragraph', attrs: { textAlign: 'center' }, content: [{ type: 'text', text: '대외비' }] }] }],
    hideFirst: { masterPage: true },
  },
  meta: {},
};
const back = await m.readHwpx(await m.writeHwpx(doc));
const pb = back.settings.pageBorder;
check('쪽 테두리를 읽었다', !!pb, JSON.stringify(pb)?.slice(0, 300));
check('위치 기준(본문)·간격', pb && pb.body === true && pb.offset.every((v) => Math.abs(v - 5) < 0.05), JSON.stringify(pb?.offset));
check('선 굵기·색·종류', pb && pb.sides?.l?.c === '#D17373' && Math.abs(pb.sides.l.w - 0.4) < 0.01 && pb.sides.t?.s === 'double' && pb.sides.t?.c === '#0000FF' && pb.sides.b?.s === 'dashed', JSON.stringify(pb?.sides));
check('바탕색·그림·채울 영역', pb && pb.bg === '#FFF2CC' && /^data:image\/png/.test(pb.image || '') && pb.fillArea === 'paper', JSON.stringify({ bg: pb?.bg, area: pb?.fillArea, img: (pb?.image || '').slice(0, 30) }));
check('첫 쪽에는 테두리 없음', pb && pb.borderOn === 'notFirst' && !pb.fillOn, JSON.stringify([pb?.borderOn, pb?.fillOn]));
const mp = back.settings.masterPages;
const text = (n) => (n.type === 'text' ? n.text : (n.content || []).map(text).join(''));
check('바탕쪽', mp && mp.length === 1 && mp[0].type === 'both' && mp[0].content.map(text).join('') === '대외비', JSON.stringify(mp)?.slice(0, 300));
check('첫 쪽에 바탕쪽 감춤', back.settings.hideFirst?.masterPage === true);
// HWP(바이너리)로 쓰고 다시 읽기
const hb = await m.readHwp(await m.writeHwp(doc));
const hp = hb.settings.pageBorder;
check('HWP: 쪽 테두리 위치·간격·선', hp && hp.body === true && hp.offset.every((v) => Math.abs(v - 5) < 0.05) && hp.sides?.l?.c === '#D17373' && hp.sides?.t?.s === 'double', JSON.stringify(hp)?.slice(0, 300));
check('HWP: 바탕색·그림·첫 쪽 감춤', hp && hp.bg === '#FFF2CC' && /^data:image\/png/.test(hp.image || '') && hp.borderOn === 'notFirst', JSON.stringify({ bg: hp?.bg, on: hp?.borderOn, img: (hp?.image || '').slice(0, 24) }));
check('HWP: 바탕쪽', hb.settings.masterPages?.length === 1 && hb.settings.masterPages[0].content.map(text).join('') === '대외비' && hb.settings.hideFirst?.masterPage === true, JSON.stringify(hb.settings.masterPages)?.slice(0, 200));
// 쪽 테두리가 없는 문서는 그대로 없다
const plain = await m.readHwpx(await m.writeHwpx({ ...doc, settings: { page, header: doc.settings.header, footer: doc.settings.footer, pageNumber: doc.settings.pageNumber } }));
check('없으면 없다', !plain.settings.pageBorder && !plain.settings.masterPages);
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
