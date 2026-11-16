// 글자 모양: 밑줄·취소선의 종류/색/위치, 강조점, 글자 위치, 덧말, 글자 겹침 — HWPX·HWP 로 쓰고 다시 읽어 그대로인지 본다.
//   node tests/test-charshape.mjs
import { load } from './harness.mjs';
const m = await load('tests/formats.entry.ts');
let fail = 0;
const check = (name, cond, extra = '') => {
  if (!cond) fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};
const T = (text, marks) => ({ type: 'text', text, marks });
const doc = {
  content: {
    type: 'doc',
    content: [
      {
        type: 'paragraph',
        content: [
          T('이중 빨간 밑줄 ', [{ type: 'underline', attrs: { shape: 'DOUBLE_SLIM', color: '#FF0000' } }]),
          T('윗줄 ', [{ type: 'underline', attrs: { pos: 'top' } }]),
          T('점선 취소선 ', [{ type: 'strike', attrs: { shape: 'DOT', color: '#0000FF' } }]),
          T('강조점 ', [{ type: 'textStyle', attrs: { emphasis: 'DOT_ABOVE' } }]),
          T('아래로 ', [{ type: 'textStyle', attrs: { offset: 20 } }]),
          T('본말', [{ type: 'ruby', attrs: { text: '덧말', pos: 'top' } }]),
          T(' '),
          T('12', [{ type: 'compose', attrs: { shape: 'SHAPE_RECTANGLE' } }]),
          T(' 보통 밑줄', [{ type: 'underline' }]),
        ],
      },
      { type: 'paragraph', attrs: { paraBorder: { t: '0.4mm solid #FF0000', b: '0.7mm double #0000FF', l: '0.12mm dashed #000000', o: [7.56, 7.56, 3.78, 3.78], c: true }, paraBg: '#FFF2CC' }, content: [T('테두리 문단')] },
    ],
  },
  settings: { page: { width: 210, height: 297, marginTop: 20, marginBottom: 15, marginLeft: 30, marginRight: 30, marginHeader: 15, marginFooter: 15, gutter: 0, landscape: false }, header: { text: '', align: 'center' }, footer: { text: '', align: 'center' }, pageNumber: { pos: 'none', format: 'digit', start: 1 } },
  meta: {},
};
const find = (d, text) => {
  let hit = null;
  const walk = (n) => {
    if (n.type === 'text' && (n.text || '').includes(text)) hit = hit || n;
    (n.content || []).forEach(walk);
  };
  walk(d.content);
  return hit;
};
const mark = (n, type) => (n?.marks || []).find((x) => x.type === type);
for (const [fmt, write, read] of [['HWPX', m.writeHwpx, m.readHwpx], ['HWP', m.writeHwp, m.readHwp]]) {
  const back = await read(await write(doc));
  const u = mark(find(back, '이중 빨간 밑줄'), 'underline');
  check(`${fmt}: 밑줄 종류·색`, u && u.attrs?.shape === 'DOUBLE_SLIM' && u.attrs?.color === '#FF0000', JSON.stringify(u));
  const o = mark(find(back, '윗줄'), 'underline');
  check(`${fmt}: 윗줄`, o && o.attrs?.pos === 'top' && !o.attrs?.shape, JSON.stringify(o));
  const st = mark(find(back, '점선 취소선'), 'strike');
  check(`${fmt}: 취소선 종류·색`, st && st.attrs?.shape === 'DOT' && st.attrs?.color === '#0000FF', JSON.stringify(st));
  const e = mark(find(back, '강조점'), 'textStyle');
  check(`${fmt}: 강조점`, e?.attrs?.emphasis === 'DOT_ABOVE', JSON.stringify(e?.attrs));
  const off = mark(find(back, '아래로'), 'textStyle');
  check(`${fmt}: 글자 위치`, off?.attrs?.offset === 20, JSON.stringify(off?.attrs));
  const r = mark(find(back, '본말'), 'ruby');
  check(`${fmt}: 덧말`, r?.attrs?.text === '덧말' && r.attrs.pos === 'top', JSON.stringify(r));
  const c = mark(find(back, '12'), 'compose');
  check(`${fmt}: 글자 겹침`, c?.attrs?.shape === 'SHAPE_RECTANGLE', JSON.stringify(c));
  const p = mark(find(back, '보통 밑줄'), 'underline');
  check(`${fmt}: 보통 밑줄은 그대로`, p && !p.attrs?.shape && !p.attrs?.color && !p.attrs?.pos, JSON.stringify(p));
  // 문단 테두리
  let bp = null;
  const walkP = (n) => {
    if (n.type === 'paragraph' && n.attrs?.paraBorder) bp = bp || n;
    (n.content || []).forEach(walkP);
  };
  walkP(back.content);
  const pb = bp?.attrs?.paraBorder;
  check(`${fmt}: 문단 테두리의 변·종류·색`, pb && pb.t === '0.4mm solid #FF0000' && pb.b === '0.7mm double #0000FF' && pb.l === '0.12mm dashed #000000' && !pb.r, JSON.stringify(pb));
  check(`${fmt}: 문단 테두리의 간격·연결·배경`, pb && pb.o && Math.abs(pb.o[0] - 7.56) < 0.1 && Math.abs(pb.o[2] - 3.78) < 0.1 && pb.c === true && bp.attrs.paraBg === '#FFF2CC', JSON.stringify([pb?.o, pb?.c, bp?.attrs?.paraBg]));
  const text = (n) => (n.type === 'text' ? n.text : (n.content || []).map(text).join(''));
  check(`${fmt}: 글이 그대로`, text(back.content) === text(doc.content), JSON.stringify(text(back.content)));
}
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
