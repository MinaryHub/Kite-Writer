// 한글 편집 기능의 읽기·쓰기: 책갈피, 표 캡션(자동 번호), 세로쓰기 칸, 새 번호로 시작·감추기, 구역 나누기, 탭 자리
//   node tests/test-features.mjs
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
const settings = () => ({ page: { ...page }, header: { text: '', align: 'center' }, footer: { text: '', align: 'center' }, pageNumber: { pos: 'bottom-center', format: 'digit', start: 1 } });
const P = (content, attrs) => ({ type: 'paragraph', ...(attrs ? { attrs } : {}), content: typeof content === 'string' ? [{ type: 'text', text: content }] : content });
const num = (n) => ({ type: 'text', text: String(n), marks: [{ type: 'autoNum', attrs: { kind: 'TABLE' } }] });
const cell = (text, attrs) => ({ type: 'tableCell', ...(attrs ? { attrs } : {}), content: [P(text)] });
const doc = {
  content: {
    type: 'doc',
    content: [
      P([{ type: 'text', text: '앞 ' }, { type: 'bookmark', attrs: { name: '책갈피 하나' } }, { type: 'text', text: '뒤' }], { pageHide: 'n' }),
      P([{ type: 'text', text: 'A' }, { type: 'text', text: '\t', marks: [{ type: 'tab', attrs: { width: null, leader: 0, type: 0 } }] }, { type: 'text', text: 'B' }], { tabs: { d: 40, s: [[113.39, 'l', 0], [283.46, 'r', 3]] } }),
      { type: 'table', content: [{ type: 'tableRow', content: [cell('세로', { vertical: true }), cell('가로')] }] },
      P([{ type: 'text', text: '표 ' }, num(1), { type: 'text', text: ' 캡션' }], { caption: 'bottom' }),
      { type: 'pageBreak' },
      P('새 번호 쪽', { pageNumStart: 5 }),
      { type: 'pageBreak', attrs: { sectionPage: { ...page, landscape: true } } },
      P('가로 구역'),
    ],
  },
  settings: settings(),
  meta: {},
};
const walk = (n, f) => {
  f(n);
  (n.content || []).forEach((c) => walk(c, f));
};
const facts = (d) => {
  const out = { bookmarks: [], caption: null, captionNum: null, vertical: [], pageNumStart: [], pageHide: [], sections: [] };
  walk(d, (n) => {
    if (n.type === 'bookmark') out.bookmarks.push(n.attrs.name);
    if (n.type === 'paragraph' && n.attrs?.caption) {
      out.caption = n.attrs.caption;
      const t = (n.content || []).find((c) => (c.marks || []).some((mk) => mk.type === 'autoNum'));
      out.captionNum = t ? t.text : null;
    }
    if ((n.type === 'tableCell' || n.type === 'tableHeader') && n.attrs?.vertical) out.vertical.push((n.content || []).map((p) => (p.content || []).map((c) => c.text || '').join('')).join(''));
    if (n.attrs?.pageNumStart != null) out.pageNumStart.push(n.attrs.pageNumStart);
    if (n.attrs?.pageHide) out.pageHide.push(n.attrs.pageHide);
    if (n.type === 'pageBreak' && n.attrs?.sectionPage) out.sections.push(!!n.attrs.sectionPage.landscape);
  });
  return out;
};

for (const [fmt, w, r] of [
  ['HWPX', m.writeHwpx, m.readHwpx],
  ['HWP', m.writeHwp, m.readHwp],
]) {
  const bytes = await w(doc);
  const f = facts((await r(bytes)).content);
  ok(f.bookmarks.length === 1 && f.bookmarks[0] === '책갈피 하나', `${fmt}: 책갈피`, JSON.stringify(f.bookmarks));
  ok(f.caption === 'bottom' && f.captionNum === '1', `${fmt}: 표 캡션과 자동 번호`, JSON.stringify([f.caption, f.captionNum]));
  ok(f.vertical.length === 1 && f.vertical[0] === '세로', `${fmt}: 세로쓰기 칸`, JSON.stringify(f.vertical));
  ok(f.pageNumStart.includes(5), `${fmt}: 새 번호로 시작`, JSON.stringify(f.pageNumStart));
  ok(f.pageHide.includes('n'), `${fmt}: 감추기`, JSON.stringify(f.pageHide));
  ok(f.sections.length === 1 && f.sections[0] === true, `${fmt}: 구역 나누기 (가로 용지)`, JSON.stringify(f.sections));
  if (fmt === 'HWPX') {
    const z = await JSZip.loadAsync(bytes);
    const head = await z.file('Contents/header.xml').async('string');
    const sec0 = await z.file('Contents/section0.xml').async('string');
    ok(!!z.file('Contents/section1.xml'), 'HWPX: 구역마다 구역 파일');
    ok(/<hh:tabItem pos="11339" type="LEFT" leader="NONE" unit="HWPUNIT"\/>/.test(head) && /<hh:tabItem pos="56692" type="RIGHT" leader="DOT"\/>/.test(head), 'HWPX: 탭 자리 정의 (두 벌: 값 그대로·2배)');
    ok(/<hp:caption side="BOTTOM"[^>]*>[\s\S]*<hp:autoNum num="1" numType="TABLE">/.test(sec0), 'HWPX: 표 안의 캡션과 번호 컨트롤');
    ok(/textDirection="VERTICAL"/.test(sec0), 'HWPX: 세로쓰기 칸');
    ok(/<hp:bookmark name="책갈피 하나"\/>/.test(sec0), 'HWPX: 책갈피 컨트롤');
  } else {
    const c = CFB.read(bytes, { type: 'array' });
    const sec = (k) => c.FullPaths.findIndex((p) => new RegExp(`BodyText/Section${k}$`, 'i').test(p));
    ok(sec(0) >= 0 && sec(1) >= 0, 'HWP: 구역마다 구역 스트림');
    const buf = inflateRaw(new Uint8Array(c.FileIndex[sec(0)].content));
    // 표 컨트롤의 개체 속성 bit 29 (캡션 있음): 없으면 한글이 문서를 열지 못한다
    let found = false;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    for (let o = 0; o + 4 <= buf.length; ) {
      const h = dv.getUint32(o, true);
      o += 4;
      let size = (h >>> 20) & 0xfff;
      if (size === 0xfff) {
        size = dv.getUint32(o, true);
        o += 4;
      }
      if ((h & 0x3ff) === 71 && size >= 8 && String.fromCharCode(buf[o + 3], buf[o + 2], buf[o + 1], buf[o]) === 'tbl ') found = (dv.getUint32(o + 4, true) & 0x20000000) !== 0;
      o += size;
    }
    ok(found, 'HWP: 캡션이 있는 표의 개체 속성 (bit 29)');
  }
}
// DOCX: 책갈피
{
  const back = await m.readDocx(await m.writeDocx(doc));
  ok(facts(back.content).bookmarks.includes('책갈피 하나'), 'DOCX: 책갈피');
}
// 각주·미주: 형식마다 쓰고 다시 읽어도 종류가 섞이지 않는다
{
  const nd = {
    content: { type: 'doc', content: [P([{ type: 'text', text: '본문' }, { type: 'footnote', attrs: { text: '각주 글' } }, { type: 'text', text: ' 이어서' }, { type: 'footnote', attrs: { text: '미주 하나', kind: 'end' } }]), P([{ type: 'text', text: '둘째' }, { type: 'footnote', attrs: { text: '미주 둘', kind: 'end' } }])] },
    settings: settings(),
    meta: {},
  };
  const notes = (d) => {
    const out = [];
    walk(d, (n) => n.type === 'footnote' && out.push((n.attrs.kind === 'end' ? 'E:' : 'F:') + n.attrs.text));
    return out.join('|');
  };
  const want = 'F:각주 글|E:미주 하나|E:미주 둘';
  for (const [fmt, w, r] of [
    ['HWPX', m.writeHwpx, m.readHwpx],
    ['HWP', m.writeHwp, m.readHwp],
    ['DOCX', m.writeDocx, m.readDocx],
  ]) {
    const got = notes((await r(await w(nd))).content);
    ok(got === want, `${fmt}: 각주와 미주`, got);
  }
  const sec = await (await JSZip.loadAsync(await m.writeHwpx(nd))).file('Contents/section0.xml').async('string');
  ok(/<hp:endNote number="2"[\s\S]*?numType="ENDNOTE"/.test(sec) && /<hp:footNote number="1"/.test(sec), 'HWPX: 미주 컨트롤과 미주 번호 (각주와 따로)');
}

// 상호 참조: 책갈피의 쪽 번호 (HWPX CROSSREF 필드, HWP %xrf)
{
  const xr = (text, cmd) => ({ type: 'text', text, marks: [{ type: 'crossRef', attrs: { cmd } }] });
  const nd = {
    content: { type: 'doc', content: [P([{ type: 'bookmark', attrs: { name: '목표' } }, { type: 'text', text: '목표 문단' }]), P([{ type: 'text', text: '앞 ' }, xr('1', '?목표;6;0;1'), { type: 'text', text: '쪽, ' }, xr('위', '?목표;6;3;0')])] },
    settings: settings(),
    meta: {},
  };
  const refs = (d) => {
    const out = [];
    walk(d, (n) => {
      const mk = (n.marks || []).find((x) => x.type === 'crossRef');
      if (mk) out.push(`${n.text}=${mk.attrs.cmd}`);
    });
    return out.join('|');
  };
  const want = '1=?목표;6;0;1|위=?목표;6;3;0';
  for (const [fmt, w, r] of [
    ['HWPX', m.writeHwpx, m.readHwpx],
    ['HWP', m.writeHwp, m.readHwp],
  ]) {
    const bytes = await w(nd);
    const got = refs((await r(bytes)).content);
    ok(got === want, `${fmt}: 상호 참조 (명령 글·결과 글)`, got);
  }
  const sec = await (await JSZip.loadAsync(await m.writeHwpx(nd))).file('Contents/section0.xml').async('string');
  ok(/<hp:fieldBegin [^>]*type="CROSSREF"[\s\S]*?name="Command">\?목표;6;0;1<[\s\S]*?name="RefType">TARGET_BOOKMARK<[\s\S]*?name="RefHyperLink">true</.test(sec) && /<hp:t>1<\/hp:t><\/hp:run><hp:run[^>]*><hp:ctrl><hp:fieldEnd|<hp:t>1<\/hp:t><hp:ctrl><hp:fieldEnd/.test(sec), 'HWPX: 상호 참조 필드 (한글과 같은 매개 변수, 결과 글은 필드 안)');
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
