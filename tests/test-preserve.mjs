// 원본 보존형 저장 (src/formats/hwpBase.ts): 한글 문서를 읽어 같은 형식으로 저장하면 고치지 않은 문단은 원문 그대로,
// 고친 문단만 새로 쓰고 원본 정의(문단·글자 모양 번호)를 다시 쓴다
//   node tests/test-preserve.mjs
import { load } from './harness.mjs';
import JSZip from 'jszip';
import * as CFB from 'cfb';
import { inflateRaw } from 'pako';
const m = await load('tests/formats.entry.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};
const page = { width: 210, height: 297, marginTop: 20, marginBottom: 15, marginLeft: 30, marginRight: 30, marginHeader: 15, marginFooter: 15, gutter: 0, landscape: false };
const settings = () => ({ page: { ...page }, header: { text: '', align: 'center' }, footer: { text: '', align: 'center' }, pageNumber: { pos: 'none', format: 'digit', start: 1 } });
const P = (text, marks, attrs) => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: [{ type: 'text', text, ...(marks ? { marks } : {}) }] });
const src = {
  content: {
    type: 'doc',
    content: [
      P('첫째 문단입니다.'),
      P('굵은 글자 문단', [{ type: 'bold' }, { type: 'textStyle', attrs: { fontSize: 14 } }], { textAlign: 'center' }),
      {
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableCell', attrs: { backgroundColor: '#FFEE88' }, content: [P('칸 하나')] }, { type: 'tableCell', content: [P('칸 둘')] }] },
        ],
      },
      P('넷째 문단입니다.'),
      P('다섯째 문단입니다.'),
    ],
  },
  settings: settings(),
  meta: {},
};
// 편집기(hwpKeep)가 고친 블록에 하는 일: 원문·줄 정보·크기 표시를 지운다
const touch = (n) => {
  for (const k of ['hwpRaw', 'hwpSeg', 'hwpChars', 'hwpSz']) if (n.attrs && n.attrs[k] != null) n.attrs[k] = null;
};
const textOf = (n) => (n.type === 'text' ? n.text : (n.content || []).map(textOf).join(''));

// ---------- HWPX ----------
{
  const tops = (xml) => {
    const re = /<(\/?)hp:p\b[^>]*?(\/?)>/g;
    let d = 0, st = -1, k;
    const o = [];
    while ((k = re.exec(xml))) {
      if (k[1]) { d--; if (!d) o.push(xml.slice(st, k.index + k[0].length)); }
      else if (!k[2]) { if (!d) st = k.index; d++; }
    }
    return o;
  };
  const sectionOf = async (bytes) => (await JSZip.loadAsync(bytes)).file('Contents/section0.xml').async('string');
  const first = await m.writeHwpx(src);
  const doc = await m.readHwpx(first);
  ok(doc.settings.hwpBase?.fmt === 'hwpx' && !!doc.settings.hwpBase.header, 'HWPX: 읽으면 원본 머리부를 남긴다');
  ok(doc.content.content.filter((n) => n.attrs?.hwpRaw).length === 5, 'HWPX: 본문 블록마다 원문 묶음', String(doc.content.content.filter((n) => n.attrs?.hwpRaw).length));
  const a = tops(await sectionOf(first));
  // 그대로 저장: 문단이 모두 원문 그대로
  const same = tops(await sectionOf(await m.writeHwpx(doc)));
  ok(same.length === a.length && same.every((p, i) => p === a[i]), 'HWPX: 고치지 않고 저장하면 문단이 모두 원문 그대로');
  // 넷째 문단만 고친다
  const doc2 = await m.readHwpx(first);
  const p4 = doc2.content.content[3];
  p4.content[0].text = '고친 넷째 문단';
  touch(p4);
  const out2 = await m.writeHwpx(doc2);
  const b = tops(await sectionOf(out2));
  ok(b[0] === a[0] && b[1] === a[1] && b[2] === a[2] && b[4] === a[4], 'HWPX: 고치지 않은 문단은 원문 그대로');
  ok(b[3] !== a[3] && b[3].includes('고친 넷째 문단'), 'HWPX: 고친 문단은 새로 쓴다');
  // 고친 문단도 문단·글자 모양을 바꾸지 않았으면 원본 번호를 쓴다
  const pr = (x, k) => new RegExp(`${k}="(\\d+)"`).exec(x)?.[1];
  ok(pr(b[3], 'paraPrIDRef') === pr(a[3], 'paraPrIDRef') && pr(b[3], 'charPrIDRef') === pr(a[3], 'charPrIDRef'), 'HWPX: 고친 문단도 원본 문단·글자 모양 번호', `${pr(b[3], 'paraPrIDRef')}/${pr(a[3], 'paraPrIDRef')} ${pr(b[3], 'charPrIDRef')}/${pr(a[3], 'charPrIDRef')}`);
  // 글자 모양을 바꾸면 원본 번호를 쓰지 않는다
  const doc3 = await m.readHwpx(first);
  const t5 = doc3.content.content[4].content[0];
  t5.marks = (t5.marks || []).map((mk) => (mk.type === 'textStyle' ? { ...mk, attrs: { ...mk.attrs, fontSize: 20 } } : mk));
  touch(doc3.content.content[4]);
  const c = tops(await sectionOf(await m.writeHwpx(doc3)));
  ok(pr(c[4], 'charPrIDRef') !== pr(a[4], 'charPrIDRef'), 'HWPX: 글자 크기를 바꾼 글은 새 글자 모양');
  const back = await m.readHwpx(out2);
  ok(textOf(back.content).includes('고친 넷째 문단') && textOf(back.content).includes('칸 둘'), 'HWPX: 저장본을 다시 읽을 수 있다');
  // 쪽 설정을 바꾸면 원본 구역 정의·줄 정보를 쓰지 않는다
  const doc4 = await m.readHwpx(first);
  doc4.settings.page = { ...doc4.settings.page, marginLeft: 40 };
  const d = await sectionOf(await m.writeHwpx(doc4));
  ok(/left="11339"/.test(d) || /left="1133[0-9]"/.test(d), 'HWPX: 바꾼 여백을 쓴다', /<hp:margin [^>]*>/.exec(d)?.[0]);
  // 붙여 넣은 내용(다른 문서에서 온 원본 번호)은 편집기가 지운다: 여기서는 원문 묶음이 깨진 블록이 새로 쓰이는지만 본다
  const doc5 = await m.readHwpx(first);
  doc5.content.content.splice(1, 0, JSON.parse(JSON.stringify(doc5.content.content[4])));
  touch(doc5.content.content[1]);
  const e = tops(await sectionOf(await m.writeHwpx(doc5)));
  ok(e.length === a.length + 1, 'HWPX: 끼운 문단');
}

// ---------- HWP ----------
{
  const paras = (bytes) => {
    const c = CFB.read(bytes, { type: 'array' });
    const i = c.FullPaths.findIndex((p) => /BodyText\/Section0$/i.test(p));
    const buf = inflateRaw(new Uint8Array(c.FileIndex[i].content));
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const recs = [];
    for (let o = 0; o + 4 <= buf.length; ) {
      const h = dv.getUint32(o, true);
      const s = o;
      o += 4;
      let size = (h >>> 20) & 0xfff;
      if (size === 0xfff) { size = dv.getUint32(o, true); o += 4; }
      recs.push({ level: (h >>> 10) & 0x3ff, s, e: o + size });
      o += size;
    }
    const out = [];
    for (let i2 = 0; i2 < recs.length; i2++) {
      if (recs[i2].level !== 0) continue;
      let j = i2 + 1;
      while (j < recs.length && recs[j].level > 0) j++;
      // '마지막 문단' 표시와 문단 자신의 줄 정보(PARA_LINE_SEG)는 빼고 견준다 (고친 문단 뒤에서는 한글이 다시 배치하도록 뺀다)
      const parts = [];
      for (let r = i2; r < j; r++) {
        const tag = dv.getUint32(recs[r].s, true) & 0x3ff;
        if (r > i2 && tag === 69 && recs[r].level === 1) continue;
        parts.push(Buffer.from(buf.slice(recs[r].s, recs[r].e)));
      }
      const b = Buffer.concat(parts);
      b[7] &= 0x7f;
      out.push(b.toString('base64'));
    }
    return out;
  };
  const first = await m.writeHwp(src);
  const doc = await m.readHwp(first);
  ok(doc.settings.hwpBase?.fmt === 'hwp' && !!doc.settings.hwpBase.docInfo, 'HWP: 읽으면 원본 DocInfo 를 남긴다');
  const a = paras(first);
  const same = paras(await m.writeHwp(doc));
  ok(same.length === a.length && same.every((p, i) => p === a[i]), 'HWP: 고치지 않고 저장하면 문단이 모두 원본 레코드 그대로', `${same.length}/${a.length}`);
  const doc2 = await m.readHwp(first);
  // (HWP 로 읽으면 표가 든 문단은 빈 문단 + 표로 온다: 블록 차례가 아니라 글로 찾는다)
  const p4 = doc2.content.content.find((n) => n.type === 'paragraph' && textOf(n) === '넷째 문단입니다.');
  p4.content[0].text = '고친 넷째 문단';
  touch(p4);
  const out2 = await m.writeHwp(doc2);
  const b = paras(out2);
  const k = a.findIndex((p, i) => p !== b[i]);
  ok(b.length === a.length && k >= 0 && a.every((p, i) => i === k || p === b[i]), 'HWP: 고친 문단만 새로 쓴다', `${b.length}/${a.length} 다른 문단 ${a.map((p, i) => (p === b[i] ? '' : i)).join('')}`);
  const back = await m.readHwp(out2);
  ok(textOf(back.content).includes('고친 넷째 문단') && textOf(back.content).includes('칸 둘'), 'HWP: 저장본을 다시 읽을 수 있다');
  // 다른 형식으로 저장하면 원본 정보를 쓰지 않는다 (HWP 원본 → HWPX)
  const x = await m.readHwpx(await m.writeHwpx(doc));
  ok(textOf(x.content).includes('넷째 문단입니다.'), 'HWP → HWPX: 원본 정보 없이 새로 쓴다');
}

// HWPX: 원본 settings.xml 의 인쇄 설정(모아 찍기)을 그대로 둔다
{
  const z = await JSZip.loadAsync(await m.writeHwpx(src));
  const appSet =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="3" pos="7"/><config:config-item-set name="PrintInfo"><config:config-item name="PrintMethod" type="short">4</config:config-item></config:config-item-set></ha:HWPApplicationSetting>';
  z.file('settings.xml', appSet);
  const doc = await m.readHwpx(await z.generateAsync({ type: 'uint8array' }));
  const set = await (await JSZip.loadAsync(await m.writeHwpx(doc))).file('settings.xml').async('string');
  ok(set.includes('<config:config-item name="PrintMethod" type="short">4</config:config-item>') && set.includes('paraIDRef="0" pos="0"'), 'HWPX: 원본 인쇄 설정을 남기고 커서 자리만 처음으로');
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
