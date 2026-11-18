// 그리기 개체(선·사각형·타원·호·다각형·곡선·묶음): 읽기 → HWPX 로 쓰기 → 다시 읽기에서 도형과 자리가 그대로인지 본다.
//   node tests/test-shapes.mjs [파일...]   (파일이 없으면 안에 든 작은 문서로)
import { load } from './harness.mjs';
import fs from 'node:fs';
import JSZip from 'jszip';
const m = await load('tests/formats.entry.ts');

const shapesOf = (doc) => {
  const out = [];
  const walk = (n) => {
    if (n.type === 'shape') out.push(n);
    (n.content || []).forEach(walk);
  };
  walk(doc.content);
  return out;
};
const boxesOf = (doc) => {
  const out = [];
  const walk = (n) => {
    if (n.type === 'textBox' && n.attrs?.float) out.push(n);
    (n.content || []).forEach(walk);
  };
  walk(doc.content);
  return out;
};
const sig = (s) => ({
  w: Math.round(s.attrs.width), h: Math.round(s.attrs.height),
  // 쪽·종이 기준 개체는 쪽 안 자리(py)로 견준다 (문단 기준 y 는 줄 정보가 있을 때의 어림값)
  float: s.attrs.float ? [Math.round(s.attrs.float.x), Math.round(s.attrs.float.py ?? s.attrs.float.y), !!s.attrs.float.behind, s.attrs.float.hw?.wrap || ''] : null,
  items: s.attrs.d.items.map((it) => [it.k, it.m.map((v) => Math.round(v * 100) / 100).join(','), Math.round(it.w), Math.round(it.h), (it.p || []).map((v) => Math.round(v)).join(','), it.sc || '', it.sd || '', it.fc || '', it.fg ? it.fg.t + it.fg.c.join('') : '', it.fi ? 'img' : '', it.hs || '', it.ts || '', it.at || '', it.seg || '', it.k === 'text' ? JSON.stringify(it.content).length > 0 : ''].join('|')),
});

let fail = 0;
const check = (name, cond, extra = '') => {
  if (!cond) fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};

async function roundtrip(name, data, reader) {
  const doc = await reader(data);
  const a = shapesOf(doc);
  const out = await m.writeHwpx(doc);
  // XML 유효성
  const zip = await JSZip.loadAsync(out);
  const xml = await zip.file('Contents/section0.xml').async('string');
  const d = new DOMParser().parseFromString(xml, 'application/xml');
  check(`${name}: 쓴 XML 이 유효하다`, !d.getElementsByTagName('parsererror').length);
  const back = await m.readHwpx(out);
  const b = shapesOf(back);
  check(`${name}: 도형 수가 같다`, a.length === b.length, `${a.length} → ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = JSON.stringify(sig(a[i]));
    const y = JSON.stringify(sig(b[i]));
    check(`${name}: 도형 ${i + 1} (${a[i].attrs.d.items.map((t) => t.k).join(',')})`, x === y, x === y ? '' : `\n   읽음   ${x.slice(0, 600)}\n   다시   ${y.slice(0, 600)}`);
  }
  const fa = boxesOf(doc).map((n) => [Math.round(n.attrs.float.x), Math.round(n.attrs.float.py ?? n.attrs.float.y)].join(','));
  const fb = boxesOf(back).map((n) => [Math.round(n.attrs.float.x), Math.round(n.attrs.float.py ?? n.attrs.float.y)].join(','));
  check(`${name}: 떠 있는 글상자의 자리`, JSON.stringify(fa) === JSON.stringify(fb), `${fa} → ${fb}`);
  // HWP(바이너리)로 쓰고 다시 읽기: 글맵시는 쓰지 않고, 글이 든 사각형·타원은 글상자로 읽힌다
  const hwp = await m.readHwp(await m.writeHwp(doc));
  const want = a.filter((s) => s.attrs.d.items.every((it) => it.k !== 'art'));
  const c = shapesOf(hwp);
  check(`${name}: HWP 로 쓴 도형 수`, want.length === c.length, `${want.length} → ${c.length}`);
  for (let i = 0; i < Math.min(want.length, c.length); i++) {
    const x = JSON.stringify(sig(want[i]));
    const y = JSON.stringify(sig(c[i]));
    check(`${name}: HWP 도형 ${i + 1} (${want[i].attrs.d.items.map((t) => t.k).join(',')})`, x === y, x === y ? '' : `\n   읽음   ${x.slice(0, 700)}\n   다시   ${y.slice(0, 700)}`);
  }
  return { doc, back, out };
}

const files = process.argv.slice(2);
if (files.length) {
  for (const f of files) {
    const data = new Uint8Array(fs.readFileSync(f));
    await roundtrip(f.split('/').pop(), data, /\.hwp$/i.test(f) ? m.readHwp : m.readHwpx);
  }
} else {
  // 작은 문서: 편집기 문서(JSON)에 도형을 넣어 HWPX 로 쓰고 다시 읽는다
  const I = [1, 0, 0, 1, 0, 0];
  const doc = {
    content: {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '도형 ' },
            { type: 'shape', attrs: { width: 200, height: 100, float: { x: 40, y: 20 }, d: { items: [{ k: 'rect', m: I, w: 200, h: 100, sc: '#FF0000', sw: 2, sd: 'DASH', fc: '#FFFF00', r: 20 }] } } },
            { type: 'shape', attrs: { width: 120, height: 60, d: { items: [{ k: 'line', m: I, w: 120, h: 60, p: [0, 0, 120, 60], sc: '#000000', sw: 1, ts: 'ARROW', tf: true, tz: [1, 1] }] } } },
            { type: 'shape', attrs: { width: 100, height: 100, float: { x: 300, y: 0, behind: true }, d: { items: [{ k: 'ellipse', m: I, w: 100, h: 100, sc: '#0000FF', sw: 1, fg: { t: 'LINEAR', a: 0, cx: 50, cy: 50, c: ['#FFFFFF', '#4B87CB'] } }] } } },
            { type: 'shape', attrs: { width: 150, height: 150, d: { items: [{ k: 'poly', m: [0.5, 0, 0, 0.5, 10, 10], w: 150, h: 150, p: [0, 0, 150, 0, 75, 150], z: true, sc: '#008000', sw: 1, fc: '#CCFFCC' }, { k: 'curve', m: I, w: 150, h: 150, p: [0, 0, 50, 100, 100, 0, 150, 100], seg: 'CCC', sc: '#800080', sw: 1 }, { k: 'arc', m: I, w: 80, h: 80, p: [0, 0, 0, 80, 80, 0], at: 'PIE', sc: '#000000', sw: 1, fc: '#F1CB7E' }], group: true } } },
          ],
        },
      ],
    },
    settings: (await m.readHwpx(await m.writeHwpx({ content: { type: 'doc', content: [{ type: 'paragraph' }] }, settings: undefined, meta: {} }).catch(() => null) || new Uint8Array()).catch(() => null))?.settings,
    meta: {},
  };
  if (!doc.settings) {
    doc.settings = { page: { width: 210, height: 297, marginTop: 20, marginBottom: 15, marginLeft: 30, marginRight: 30, marginHeader: 15, marginFooter: 15, gutter: 0, landscape: false }, header: { text: '', align: 'center' }, footer: { text: '', align: 'center' }, pageNumber: { pos: 'none', format: 'digit', start: 1 } };
  }
  const out = await m.writeHwpx(doc);
  const back = await m.readHwpx(out);
  const a = shapesOf(doc);
  const b = shapesOf(back);
  check('만든 도형: 수가 같다', a.length === b.length, `${a.length} → ${b.length}`);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const kinds = (s) => s.attrs.d.items.map((t) => t.k).join(',');
    check(`만든 도형 ${i + 1}: 종류 (${kinds(a[i])})`, kinds(a[i]) === kinds(b[i]), kinds(b[i]));
    check(`만든 도형 ${i + 1}: 틀 크기`, Math.abs(a[i].attrs.width - b[i].attrs.width) < 1 && Math.abs(a[i].attrs.height - b[i].attrs.height) < 1);
    check(`만든 도형 ${i + 1}: 떠 있는가`, !!a[i].attrs.float === !!b[i].attrs.float);
  }
  const r = b[0]?.attrs.d.items[0];
  check('사각형: 선 색·점선·채우기·곡률', r && r.sc === '#FF0000' && r.sd === 'DASH' && r.fc === '#FFFF00' && r.r === 20, JSON.stringify(r));
  const l = b[1]?.attrs.d.items[0];
  check('선: 끝 화살표', l && l.ts === 'ARROW' && !l.hs, JSON.stringify(l));
  const e = b[2]?.attrs.d.items[0];
  check('타원: 그러데이션', e && e.fg && e.fg.c.join() === '#FFFFFF,#4B87CB' && e.fg.cy === 50, JSON.stringify(e?.fg));
  check('타원: 글 뒤로', b[2]?.attrs.float?.behind === true);
  const g = b[3]?.attrs.d;
  check('묶음: 세 도형', g && g.group && g.items.length === 3, JSON.stringify(g?.items.map((t) => t.k)));
  const pm = g?.items[0].m;
  check('묶음 안 다각형: 크기·자리 행렬', pm && Math.abs(pm[0] - 0.5) < 1e-3 && Math.abs(pm[4] - 10) < 0.1 && Math.abs(pm[5] - 10) < 0.1, JSON.stringify(pm));
  // HWP(바이너리)로 쓰고 다시 읽기
  const h = shapesOf(await m.readHwp(await m.writeHwp(doc)));
  check('HWP: 도형 수가 같다', h.length === a.length, `${a.length} → ${h.length}`);
  const hr = h[0]?.attrs.d.items[0];
  check('HWP 사각형: 선 색·점선·채우기·곡률', hr && hr.sc === '#FF0000' && hr.sd === 'DASH' && hr.fc === '#FFFF00' && hr.r === 20, JSON.stringify(hr)?.slice(0, 300));
  check('HWP 사각형: 떠 있는 자리', h[0]?.attrs.float && Math.abs(h[0].attrs.float.x - 40) < 1 && Math.abs(h[0].attrs.float.y - 20) < 1, JSON.stringify(h[0]?.attrs.float));
  const hl = h[1]?.attrs.d.items[0];
  check('HWP 선: 끝 화살표·점', hl && hl.ts === 'ARROW' && !hl.hs && hl.p.map(Math.round).join() === '0,0,120,60', JSON.stringify(hl)?.slice(0, 300));
  const he = h[2]?.attrs.d.items[0];
  check('HWP 타원: 그러데이션·글 뒤로', he && he.fg && he.fg.c.join() === '#FFFFFF,#4B87CB' && he.fg.cy === 50 && h[2].attrs.float?.behind === true, JSON.stringify(he?.fg));
  const hg = h[3]?.attrs.d;
  check('HWP 묶음: 다각형·곡선·호', hg && hg.group && hg.items.map((t) => t.k).join() === 'poly,curve,arc' && hg.items[1].seg === 'CCC' && hg.items[2].at === 'PIE', JSON.stringify(hg?.items.map((t) => [t.k, t.seg, t.at])));
  const hm = hg?.items[0].m;
  check('HWP 묶음 안 다각형: 크기·자리 행렬', hm && Math.abs(hm[0] - 0.5) < 1e-3 && Math.abs(hm[4] - 10) < 0.1 && Math.abs(hm[5] - 10) < 0.1, JSON.stringify(hm));
}
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
