// 변경 내용·메모: DOCX 로 저장했다가 다시 열면 그대로, HWPX 는 변경 기록만 그대로, 다른 형식은 변경을 반영한 글만
import { load } from './harness.mjs';
const m = await load('tests/formats.entry.ts');
const { defaultSettings } = await load('src/formats/common.ts');
const ins = (t, a = '김검토') => ({ type: 'text', text: t, marks: [{ type: 'insertion', attrs: { id: 'c1', author: a, time: 1700000000000 } }] });
const del = (t, a = '김검토') => ({ type: 'text', text: t, marks: [{ type: 'deletion', attrs: { id: 'c2', author: a, time: 1700000000000 } }] });
const settings = { ...defaultSettings(), comments: { m1: { author: '이메모', time: 1700000000000, text: '확인 바랍니다', replies: [{ author: '김검토', time: 1700000001000, text: '확인함' }] } } };
const doc = {
  content: { type: 'doc', content: [{ type: 'paragraph', content: [
    { type: 'text', text: '회의는 ', marks: [{ type: 'comment', attrs: { id: 'm1' } }] },
    del('월요일'), ins('화요일'), { type: 'text', text: '에 합니다.' },
  ] }] },
  settings, meta: {},
};
const txt = (n) => n.text ?? (n.content || []).map(txt).join('');
const marksIn = (n, type, out = []) => { for (const mk of n.marks || []) if (mk.type === type) out.push({ text: n.text, attrs: mk.attrs }); (n.content || []).forEach((c) => marksIn(c, type, out)); return out; };
let fail = 0;
const ok = (c, msg) => { if (!c) fail++; console.log(c ? 'OK  ' : 'FAIL', msg); };

const back = await m.readDocx(await m.writeDocx(doc));
const insB = marksIn(back.content, 'insertion');
const delB = marksIn(back.content, 'deletion');
const comB = marksIn(back.content, 'comment');
ok(insB.length && insB[0].text === '화요일' && insB[0].attrs.author === '김검토', 'DOCX 넣음 유지 ' + JSON.stringify(insB.map((x) => x.text)));
ok(delB.length && delB[0].text === '월요일', 'DOCX 지움 유지 ' + JSON.stringify(delB.map((x) => x.text)));
const cid = comB[0]?.attrs?.id;
ok(cid && back.settings.comments?.[cid]?.text.includes('확인 바랍니다'), 'DOCX 메모 유지 ' + JSON.stringify(back.settings.comments));
ok(back.settings.comments?.[cid]?.text.includes('확인함'), 'DOCX 메모 답글 유지');

// HWPX: 변경 기록(넣음·지움)은 그대로, 메모는 뺀다 (한글의 변경 추적)
{
  const b = await m.readHwpx(await m.exportDocument('hwpx', doc));
  const insX = marksIn(b.content, 'insertion');
  const delX = marksIn(b.content, 'deletion');
  ok(insX.length === 1 && insX[0].text === '화요일' && insX[0].attrs.author === '김검토', 'hwpx: 넣음 유지 ' + JSON.stringify(insX.map((x) => [x.text, x.attrs.author])));
  ok(delX.length === 1 && delX[0].text === '월요일', 'hwpx: 지움 유지 ' + JSON.stringify(delX.map((x) => x.text)));
  ok(!marksIn(b.content, 'comment').length, 'hwpx: 메모는 빠짐');
}
for (const [name, r] of [['hwp', m.readHwp]]) {
  const b = await r(await m.exportDocument(name, doc));
  const t = txt(b.content);
  ok(t.includes('화요일에 합니다') && !t.includes('월요일') && !marksIn(b.content, 'insertion').length, `${name}: 변경 반영된 글만 "${t.trim()}"`);
}
console.log(fail ? `실패 ${fail}` : '모두 OK');
process.exit(fail ? 1 : 0);
