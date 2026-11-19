// 문의 중계(contact-relay): 메일(Brevo)·GitHub 이슈로 전달, 공개 저장소는 공개 안내를 본 앱의 문의만, 멘션·마크다운 막기, 실패 처리
//   node tests/test-contact-relay.mjs     (실제 서버는 부르지 않는다: fetch 를 가짜로 바꾼다)
const relay = await import('../contact-relay/api/contact.js');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};

/** 가짜 fetch: 부른 것을 적어 두고 규칙대로 답한다 */
let calls = [];
let rules = {};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const call = { url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null };
  calls.push(call);
  for (const [k, fn] of Object.entries(rules)) if (u.includes(k)) return fn(call);
  return new Response('{}', { status: 404 });
};
const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const ENV_KEYS = ['BREVO_API_KEY', 'CONTACT_TO', 'CONTACT_SENDER', 'GITHUB_TOKEN', 'GITHUB_REPO'];
const MAIL = { BREVO_API_KEY: 'k', CONTACT_TO: 'dev@example.com', CONTACT_SENDER: 'noreply@example.com' };
let ipNo = 0;
async function send(env, payload) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  calls = [];
  const req = new Request('https://relay.example/api/contact', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++ipNo}` },
    body: JSON.stringify(payload),
  });
  const res = await relay.POST(req);
  return { status: res.status, body: await res.json() };
}
const issuePosts = () => calls.filter((c) => c.method === 'POST' && /\/issues$/.test(c.url));

// ---- 설정이 없으면 ----
{
  const r = await send({}, { category: '문의', message: '안녕하세요' });
  ok(r.status === 503 && calls.length === 0, '메일도 이슈도 설정하지 않으면 503, 아무 데도 보내지 않는다');
}

// ---- 메일만 ----
{
  rules = { 'brevo.com': () => reply(201, { messageId: 'x' }) };
  const r = await send(MAIL, { category: '오류 신고', message: '열리지 않아요', email: 'user@example.com' });
  const mail = calls.find((c) => c.url.includes('brevo.com'));
  ok(r.status === 200 && r.body.ok && mail?.body.to[0].email === 'dev@example.com' && mail.body.replyTo.email === 'user@example.com', '메일: 받는 사람은 고정, 사용자 주소는 답장 주소로만');
}

// ---- 이슈만: 비공개 저장소 ----
{
  rules = {
    '/repos/team/support-private/issues': () => reply(201, { number: 1 }),
    '/repos/team/support-private': () => reply(200, { private: true }),
  };
  const msg = '첫 줄 제목 @someone 확인\n```코드```\n#12 ![x](https://evil/img.png)';
  const r = await send({ GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'team/support-private' }, { category: '오류 신고', message: msg, email: 'user@example.com' });
  const post = issuePosts()[0];
  ok(r.status === 200 && r.body.ok && post, '비공개 저장소에 이슈를 만든다', JSON.stringify(r));
  ok(post?.headers.authorization === 'Bearer ghp_x' && JSON.stringify(post.body.labels) === '["bug"]', '토큰으로 부르고 분류에 맞는 라벨', JSON.stringify(post?.body.labels));
  ok(post?.body.title === '[오류 신고] 첫 줄 제목 @​someone 확인', '제목: 분류와 첫 줄, 멘션은 끊는다', JSON.stringify(post?.body.title));
  // 사용자 글은 그 안의 ``` 보다 긴 울타리의 코드 블록 안 (멘션·#번호·그림이 먹지 않는다)
  ok(post?.body.body.startsWith('````text\n' + msg + '\n````'), '본문: 사용자 글을 더 긴 울타리의 코드 블록에', post?.body.body.slice(0, 80));
  ok(/- 답장: user@​example\.com/.test(post?.body.body || ''), '비공개 저장소에는 답장 주소를 적는다 (멘션이 되지 않게)');
}

// ---- 공개 저장소: 공개 안내를 본 앱(public: true)의 문의만 이슈로, 답장 주소는 빼고 ----
{
  rules = {
    '/repos/team/public-repo/issues': () => reply(201, { number: 7, html_url: 'https://github.com/team/public-repo/issues/7' }),
    '/repos/team/public-repo': () => reply(200, { private: false }),
    'brevo.com': () => reply(201, {}),
  };
  const r = await send({ GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'team/public-repo' }, { category: '문의', message: '예전 앱의 문의', email: 'user@example.com' });
  ok(r.status === 503 && issuePosts().length === 0 && /업데이트/.test(r.body.error), '예전 앱(공개 안내 없음)의 문의는 공개 이슈로 올리지 않는다 (이슈만 설정이면 업데이트 안내)', JSON.stringify(r));
  const r1 = await send({ ...MAIL, GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'team/public-repo' }, { category: '문의', message: '예전 앱의 문의', email: 'user@example.com' });
  ok(r1.status === 200 && issuePosts().length === 0 && calls.some((c) => c.url.includes('brevo.com')), '메일도 설정했으면 예전 앱의 문의는 메일로만', JSON.stringify(r1));
  const r2 = await send({ GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'team/public-repo' }, { category: '기능 제안', message: '이런 기능', email: 'user@example.com', public: true });
  const post = issuePosts()[0];
  ok(r2.status === 200 && post && !/user@/.test(post.body.body) && !/답장/.test(post.body.body) && JSON.stringify(post.body.labels) === '["enhancement"]', '공개 안내를 본 앱의 문의는 이슈로 만들되 답장 주소는 적지 않는다', JSON.stringify(post?.body));
  ok(r2.body.issue?.number === 7 && r2.body.issue?.url === 'https://github.com/team/public-repo/issues/7', '만든 이슈의 번호·주소를 돌려준다 (앱이 이슈를 열어 보게)', JSON.stringify(r2.body));
}

// ---- 라벨을 달 수 없으면 라벨 없이 다시 ----
{
  let n = 0;
  rules = {
    '/repos/team/lbl/issues': (c) => (++n === 1 && c.body.labels ? reply(422, { message: 'Validation Failed' }) : reply(201, { number: 3 })),
    '/repos/team/lbl': () => reply(200, { private: true }),
  };
  const r = await send({ GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'team/lbl' }, { category: '문의', message: '라벨' });
  const posts = issuePosts();
  ok(r.status === 200 && posts.length === 2 && posts[0].body.labels && !posts[1].body.labels, '라벨이 거부되면(422) 라벨 없이 다시 만든다', JSON.stringify(posts.map((p) => p.body.labels)));
}

// ---- 메일과 이슈 둘 다: 하나라도 닿으면 성공, 둘 다 실패하면 502 ----
{
  rules = {
    'brevo.com': () => reply(500, { message: 'down' }),
    '/repos/team/both/issues': () => reply(201, { number: 4 }),
    '/repos/team/both': () => reply(200, { private: true }),
  };
  const r = await send({ ...MAIL, GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'team/both' }, { category: '문의', message: '둘 다' });
  ok(r.status === 200 && r.body.ok, '메일이 실패해도 이슈가 만들어지면 보낸 것으로');
  rules = { 'brevo.com': () => reply(500, {}), '/repos/team/both2': () => reply(500, {}) };
  const r2 = await send({ ...MAIL, GITHUB_TOKEN: 'ghp_x', GITHUB_REPO: 'team/both2' }, { category: '문의', message: '둘 다 실패' });
  ok(r2.status === 502 && r2.body.ok === false, '둘 다 실패하면 502');
}

// ---- 잘못된 입력 ----
{
  rules = { 'brevo.com': () => reply(201, {}) };
  const r = await send(MAIL, { category: '문의', message: '   ' });
  ok(r.status === 400 && calls.length === 0, '빈 내용은 거절');
  const r2 = await send(MAIL, { category: '문의', message: 'x', email: 'not-an-email' });
  ok(r2.status === 400, '이상한 답장 주소는 거절');
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
