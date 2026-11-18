// 다단: 다단 정의·단 나누기·다단 설정 나누기를 HWPX/HWP 로 쓰고 다시 읽어 그대로인지 본다.  node tests/test-columns.mjs [다단 표본.hwpx] [첫 글자 장식이 든 다단 표본.hwpx]
import fs from 'node:fs';
import { load } from './harness.mjs';
const m = await load('tests/formats.entry.ts');
let fail = 0;
const check = (name, cond, extra = '') => {
  if (!cond) fail++;
  console.log((cond ? 'ok   ' : 'FAIL ') + name + (extra ? ' — ' + extra : ''));
};
const page = { width: 210, height: 297, marginTop: 20, marginBottom: 15, marginLeft: 30, marginRight: 30, marginHeader: 15, marginFooter: 15, gutter: 0, landscape: false };
const para = (t) => ({ type: 'paragraph', content: t ? [{ type: 'text', text: t }] : [] });
const text = (n) => (n.type === 'text' ? n.text : (n.content || []).map(text).join(''));
const base = { header: { text: '', align: 'center' }, footer: { text: '', align: 'center' }, pageNumber: { pos: 'none', format: 'digit', start: 1 } };
const near = (a, b, e = 0.06) => Math.abs(a - b) <= e;

for (const [fmt, write, read] of [
  ['HWPX', m.writeHwpx, m.readHwpx],
  ['HWP', m.writeHwp, m.readHwp],
]) {
  // 1. 너비가 같은 두 단 + 구분선, 단 나누기, 다단 설정 나누기(세 단, 한 단)
  const doc = {
    content: {
      type: 'doc',
      content: [
        para('첫 단'),
        { type: 'columnBreak' },
        para('둘째 단'),
        { type: 'columnBreak', attrs: { columns: { count: 3, gap: 6 } } },
        para('세 단으로'),
        { type: 'columnBreak', attrs: { columns: { count: 1, gap: 0 } } },
        para('한 단으로'),
      ],
    },
    settings: { ...base, page: { ...page, columns: { count: 2, gap: 8, line: { w: 0.4, c: '#FF0000', s: 'dashed' } } } },
    meta: {},
  };
  const back = await read(await write(doc));
  const c = back.settings.page.columns;
  check(`${fmt}: 두 단·간격`, c && c.count === 2 && near(c.gap, 8) && !c.widths, JSON.stringify(c));
  check(`${fmt}: 구분선`, c && c.line && near(c.line.w, 0.4, 0.02) && c.line.c.toUpperCase() === '#FF0000' && c.line.s === 'dashed', JSON.stringify(c?.line));
  const kinds = back.content.content.map((n) => (n.type === 'columnBreak' ? (n.attrs?.columns ? 'def' + n.attrs.columns.count : 'col') : n.type === 'paragraph' ? text(n) : n.type));
  check(`${fmt}: 단 나누기·다단 설정 나누기의 자리`, JSON.stringify(kinds) === JSON.stringify(['첫 단', 'col', '둘째 단', 'def3', '세 단으로', 'def1', '한 단으로']), JSON.stringify(kinds));
  const def3 = back.content.content.find((n) => n.type === 'columnBreak' && n.attrs?.columns?.count === 3);
  check(`${fmt}: 새 다단의 간격`, def3 && near(def3.attrs.columns.gap, 6), JSON.stringify(def3?.attrs));

  // 2. 너비가 다른 세 단
  const doc2 = {
    content: { type: 'doc', content: [para('본문')] },
    settings: { ...base, page: { ...page, columns: { count: 3, gap: 0, widths: [30, 56, 56], gaps: [4, 4, 0] } } },
    meta: {},
  };
  const c2 = (await read(await write(doc2))).settings.page.columns;
  check(`${fmt}: 너비가 다른 단`, c2 && c2.count === 3 && c2.widths && near(c2.widths[0], 30, 0.2) && near(c2.widths[1], 56, 0.2) && near(c2.gaps[0], 4, 0.2) && c2.gaps[2] === 0, JSON.stringify(c2));

  // 3. 다단이 없는 문서는 그대로 없다
  const plain = await read(await write({ content: { type: 'doc', content: [para('본문')] }, settings: { ...base, page }, meta: {} }));
  check(`${fmt}: 없으면 없다`, !plain.settings.page.columns && !plain.content.content.some((n) => n.type === 'columnBreak'), JSON.stringify(plain.settings.page.columns));
}

// DOCX: 구역의 다단과 단 나누기
{
  const doc = {
    content: { type: 'doc', content: [para('첫 단'), { type: 'columnBreak' }, para('둘째 단')] },
    settings: { ...base, page: { ...page, columns: { count: 2, gap: 8, line: { w: 0.12, c: '#000000', s: 'solid' } } } },
    meta: {},
  };
  const back = await m.readDocx(await m.writeDocx(doc));
  const c = back.settings.page.columns;
  check('DOCX: 두 단·간격·구분선', c && c.count === 2 && near(c.gap, 8, 0.1) && !!c.line, JSON.stringify(c));
  const kinds = back.content.content.map((n) => (n.type === 'paragraph' ? text(n) : n.type));
  check('DOCX: 단 나누기', kinds.includes('columnBreak') && kinds.indexOf('columnBreak') > kinds.indexOf('첫 단') && kinds.indexOf('columnBreak') < kinds.indexOf('둘째 단'), JSON.stringify(kinds));
  const c2 = (await m.readDocx(await m.writeDocx({ ...doc, settings: { ...base, page: { ...page, columns: { count: 2, gap: 0, widths: [50, 92], gaps: [8, 0] } } } }))).settings.page.columns;
  check('DOCX: 너비가 다른 단', c2 && c2.widths && near(c2.widths[0], 50, 0.2) && near(c2.widths[1], 92, 0.2) && near(c2.gaps[0], 8, 0.2), JSON.stringify(c2));
}

// Kite 가 쓴 HWP 의 줄 정보는 형식뿐이다 (문단마다 세로 위치 0): 다시 읽을 때 한글 배치로 따르면 문단이 모두 쪽 맨 위에 겹친다
{
  const doc = { content: { type: 'doc', content: [para('하나'), para('둘'), para('셋')] }, settings: { ...base, page }, meta: {} };
  const back = await m.readHwp(await m.writeHwp(doc));
  const has = (n) => (n.attrs && ['hwpTop', 'hwpSeq', 'hwpLines', 'hwpVs'].some((k) => n.attrs[k] != null)) || (n.content || []).some(has);
  check('형식뿐인 줄 정보는 따르지 않는다', !back.content.content.some(has), JSON.stringify(back.content.content[1]?.attrs));
}

// 4. 한글 문서의 다단: 단마다의 자리(hwpCol)와 단 정의
const sample = process.argv[2];
if (sample && fs.existsSync(sample)) {
  const d = await m.readHwpx(new Uint8Array(fs.readFileSync(sample)));
  const c = d.settings.page.columns;
  const colsSeen = new Set(d.content.content.map((n) => n.attrs?.hwpCol || 0));
  check('표본: 단 정의를 읽었다', c && c.count >= 2, JSON.stringify(c));
  check('표본: 문단마다 놓인 단', colsSeen.size === c.count, JSON.stringify([...colsSeen]));
  check('표본: 단이 바뀐 문단은 새 쪽 표시가 아니다', !d.content.content.some((n) => n.attrs?.hwpCol > 0 && n.attrs?.hwpPage), '');
  // 다시 쓰고 읽어도 같은 다단
  const again = (await m.readHwpx(await m.writeHwpx(d))).settings.page.columns;
  check('표본: 다시 써도 같은 다단', again && again.count === c.count && (!c.widths || (again.widths && again.widths.every((w, i) => near(w, c.widths[i], 0.3)))), JSON.stringify(again));
}
// 5. 어울림으로 놓인 개체(문단 첫 글자 장식) 옆으로 비켜 선 줄: 줄의 가로 시작 자리에서 문단 왼쪽 여백을 뺀 몫이 남는다
const sample2 = process.argv[3];
if (sample2 && fs.existsSync(sample2)) {
  const d = await m.readHwpx(new Uint8Array(fs.readFileSync(sample2)));
  const shifted = d.content.content.filter((n) => Array.isArray(n.attrs?.hwpLines) && n.attrs.hwpLines.some((l) => l[2] > 0));
  check('표본2: 개체 옆으로 들어간 줄', shifted.length === 1 && shifted[0].attrs.hwpLines.every((l) => near(l[2], 5050 / 75, 0.5)), JSON.stringify(shifted[0]?.attrs?.hwpLines));
  check('표본2: 두 단과 구분선', d.settings.page.columns?.count === 2 && !!d.settings.page.columns.line, JSON.stringify(d.settings.page.columns));
}
console.log(fail ? `\n실패 ${fail}건` : '\n모두 통과');
process.exit(fail ? 1 : 0);
