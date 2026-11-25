// 누름틀: 명령 글 만들기·읽기, HWP·HWPX 로 저장한 뒤 다시 읽기(안내문·메모·이름·빈 칸), DOCX 에는 안내문을 쓰지 않음,
// 한글이 만든 누름틀 문서 읽기
//   node tests/test-clickhere.mjs [누름틀이 든 .hwp]
import { load } from './harness.mjs';
import fs from 'node:fs';
const ch = await load('src/formats/clickHere.ts');
const { defaultSettings } = await load('src/formats/common.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};

{
  const cmd = ch.clickHereCommand({ guide: '이곳을 마우스로 누르고 내용을 입력하세요.', memo: '' });
  ok(cmd === 'Clickhere:set:66:Direction:wstring:23:이곳을 마우스로 누르고 내용을 입력하세요. HelpState:wstring:0:  ', '명령 글이 한글이 만든 것과 같다', JSON.stringify(cmd));
  const back = ch.parseClickHereCommand(ch.clickHereCommand({ guide: '이름: 홍길동 (예)', memo: '성과 이름' }));
  ok(back.guide === '이름: 홍길동 (예)' && back.memo === '성과 이름', '명령 글 읽기 (글 안의 쌍점·빈칸 그대로)', JSON.stringify(back));
}

const marksOf = (doc) => {
  const out = [];
  const walk = (n) => {
    if (n.type === 'text') for (const m of n.marks || []) if (m.type === 'clickHere') out.push({ text: n.text, ...m.attrs });
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return out;
};
const F = (attrs) => ({ type: 'clickHere', attrs });
const doc = {
  content: {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: '성명: ' }, { type: 'text', text: '홍길동', marks: [F({ guide: '이름을 쓰세요', memo: '성과 이름', name: '성명', empty: false })] }] },
      { type: 'paragraph', content: [{ type: 'text', text: '주소: ' }, { type: 'text', text: '주소를 쓰세요', marks: [F({ guide: '주소를 쓰세요', memo: '', name: '주소', empty: true })] }, { type: 'text', text: ' (끝)' }] },
    ],
  },
  settings: defaultSettings(),
  meta: {},
};
for (const [fmt, w, r] of [
  ['hwpx', 'writeHwpx', 'readHwpx'],
  ['hwp', 'writeHwp', 'readHwp'],
]) {
  const W = await load(`src/formats/${fmt}/writer.ts`);
  const R = await load(`src/formats/${fmt}/reader.ts`);
  const back = await R[r](await W[w](doc));
  const ms = marksOf(back.content);
  const filled = ms.find((m) => m.name === '성명');
  const empty = ms.find((m) => m.name === '주소');
  ok(filled && filled.text === '홍길동' && filled.guide === '이름을 쓰세요' && filled.memo === '성과 이름' && !filled.empty, `${fmt.toUpperCase()}: 입력한 누름틀 (글·안내문·메모·이름)`, JSON.stringify(ms));
  ok(empty && empty.empty && empty.text === '주소를 쓰세요', `${fmt.toUpperCase()}: 빈 누름틀은 안내문 자리 표시로`, JSON.stringify(empty));
  // 원본 보존형 저장의 속성(hwpRaw: 문단 원문 등)은 빼고 센다
  const text = JSON.stringify(back.content, (k, v) => (k.startsWith('hwp') ? undefined : v));
  ok(text.includes(' (끝)') && (text.match(/주소를 쓰세요/g) || []).length === 2, `${fmt.toUpperCase()}: 안내문을 본문 글로 두 번 쓰지 않는다`);
}
{
  const W = await load('src/formats/docx/writer.ts');
  const JSZip = (await import('jszip')).default;
  const z = await JSZip.loadAsync(await W.writeDocx(doc));
  const xml = await z.file('word/document.xml').async('string');
  ok(xml.includes('홍길동') && !xml.includes('주소를 쓰세요'), 'DOCX: 입력한 글은 쓰고, 빈 누름틀의 안내문은 쓰지 않는다');
}

const file = process.argv[2];
if (file && fs.existsSync(file)) {
  const R = await load('src/formats/hwp/reader.ts');
  const d = await R.readHwp(new Uint8Array(fs.readFileSync(file)));
  const ms = marksOf(d.content);
  ok(ms.some((m) => m.name === '필드1') && ms.every((m) => m.guide.startsWith('이곳을')), '한글이 만든 누름틀 읽기 (이름·안내문)', JSON.stringify(ms.slice(0, 4)));
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
