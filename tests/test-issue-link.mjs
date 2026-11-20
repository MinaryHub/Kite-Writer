// 문의하기 → GitHub 새 이슈 주소: 제목·본문·라벨, 긴 내용은 본문 없이(클립보드로), 운영체제 이름
//   node tests/test-issue-link.mjs
import { load } from './harness.mjs';
const m = await load('src/issueLink.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};

{
  const t = m.issueTitle('오류 신고', '\n  표가 깨져요  \n자세한 내용');
  ok(t === '[오류 신고] 표가 깨져요', '제목: 분류와 첫 줄', t);
  ok(m.issueTitle('문의', 'ㄱ'.repeat(100)).length === '[문의] '.length + 60, '긴 첫 줄은 60자로 줄인다');
}
{
  const r = m.newIssueUrl('오류 신고', '[오류 신고] 표', '표가 깨져요 & #1 @someone', '(붙여 넣기)');
  const u = new URL(r.url);
  ok(!r.long && u.origin + u.pathname === 'https://github.com/MinaryHub/Kite-Writer/issues/new', '새 이슈 페이지 주소', r.url);
  ok(u.searchParams.get('title') === '[오류 신고] 표' && u.searchParams.get('body') === '표가 깨져요 & #1 @someone' && u.searchParams.get('labels') === 'bug', '제목·본문·라벨을 채운다 (특수 문자는 주소에 맞게)', r.url);
  const long = m.newIssueUrl('기능 제안', '[기능 제안] 긴 글', '가'.repeat(600), '(붙여 넣기)');
  const lu = new URL(long.url);
  ok(long.long && lu.searchParams.get('body') === '(붙여 넣기)' && long.url.length <= 2000, '주소에 다 들어가지 않는 긴 내용은 본문 대신 붙여 넣기 안내 (2000자 이하)', String(long.url.length));
  ok(new URL(m.newIssueUrl('없는 분류', 't', 'b', '').url).searchParams.get('labels') === null, '모르는 분류는 라벨 없이');
}
{
  ok(m.osName('Mozilla/5.0 (Linux; Android 15; Pixel 7) AppleWebKit') === 'Android 15', '안드로이드');
  ok(m.osName('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Kite/1.5.2 Electron/33') === 'Windows 10/11', '윈도우');
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
