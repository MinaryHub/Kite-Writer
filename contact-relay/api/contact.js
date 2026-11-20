/**
 * Kite 문의 중계: 앱의 문의 창이 보낸 내용을 개발사에 전달한다 — Brevo 메일, GitHub 이슈, 또는 둘 다.
 * 키·토큰·받는 주소는 이 서버의 환경 변수에만 있다 (앱에는 이 함수 주소만 들어간다).
 *
 * 환경 변수 (Vercel → Project → Settings → Environment Variables). 메일과 이슈 가운데 하나 이상을 채운다
 *   메일
 *     BREVO_API_KEY   Brevo → SMTP & API → API Keys 에서 만든 키
 *     CONTACT_TO      문의를 받을 주소
 *     CONTACT_SENDER  Brevo 에서 확인(verify)한 보내는 주소 (Senders & IP → Senders)
 *   GitHub 이슈
 *     GITHUB_TOKEN    세분화된 개인 토큰(fine-grained): 저장소는 GITHUB_REPO 하나만, 권한은 Issues: Read and write
 *     GITHUB_REPO     이슈를 만들 저장소 (owner/name)
 *   공개 저장소에는 '공개된다'는 안내를 본 앱(문의 창이 public: true 를 함께 보낸다)에서 온 문의만 이슈로 올리고,
 *   답장 주소는 적지 않는다. 그 안내가 없던 예전 앱의 문의는 메일로만 전달한다. 비공개 저장소는 가리지 않는다
 *
 * 받을 때: POST JSON { category, message, email?, public? }  →  { ok: true, issue?: { number, url } } | { ok: false, error }
 */
const BREVO_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const GITHUB_API = process.env.GITHUB_API_URL || 'https://api.github.com';
const CATEGORIES = new Set(['문의', '오류 신고', '기능 제안', '부적절한 AI 응답']);
/** 분류 → 이슈 라벨 (GitHub 기본 라벨. 달 수 없으면 라벨 없이 만든다) */
const LABELS = { 문의: ['question'], '오류 신고': ['bug'], '기능 제안': ['enhancement'], '부적절한 AI 응답': ['ai-report'] };
const LIMIT = { windowMs: 10 * 60 * 1000, max: 5 }; // 주소(IP)마다 10분에 5건
const hits = new Map();
/** 저장소가 비공개인가 (함수가 살아 있는 동안 기억한다) */
const repoPrivate = new Map();

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
// 붙여 넣을 때 섞인 앞뒤 공백·줄바꿈·따옴표는 지운다
const clean = (v) => (v || '').trim().replace(/^['"]|['"]$/g, '').trim();

function rateLimited(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < LIMIT.windowMs);
  if (list.length >= LIMIT.max) return true;
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return false;
}

/** 사용자 글을 이슈에 그대로 보이게: 코드 블록에 넣는다 (멘션 알림·#번호 링크·그림 불러오기·마크다운이 먹지 않게) */
function fenced(text) {
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((s) => s.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/** 이슈 제목: 분류와 첫 줄 (멘션이 되지 않게 @ 뒤에 보이지 않는 글자를 넣는다) */
function issueTitle(category, message) {
  const first = message.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const short = first.length > 80 ? first.slice(0, 79) + '…' : first;
  return `[${category}] ${short}`.replace(/@/g, '@​');
}

async function sendMail(cfg, { category, message, email }) {
  const body = {
    sender: { email: cfg.sender, name: 'Kite 문의' },
    to: [{ email: cfg.to }],
    subject: `[Kite] ${category}`,
    textContent: `${message}\n\n---\n분류: ${category}\n답장: ${email || '(없음)'}\n`,
    htmlContent: `<pre style="font-family:inherit;white-space:pre-wrap">${esc(message)}</pre><hr><p>분류: ${esc(category)}<br>답장: ${email ? esc(email) : '(없음)'}</p>`,
  };
  // 받는 사람은 고정: 사용자가 적은 주소로는 보내지 않고 '답장 주소'로만 쓴다 (스팸 중계 방지)
  if (email) body.replyTo = { email };
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': cfg.key, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`brevo ${res.status} ${(await res.text()).slice(0, 300)}`);
}

const ghHeaders = (token) => ({ authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'kite-contact-relay' });

/** 저장소가 비공개인가 (못 알아내면 null) */
async function isPrivate(cfg) {
  if (repoPrivate.has(cfg.repo)) return repoPrivate.get(cfg.repo);
  const res = await fetch(`${GITHUB_API}/repos/${cfg.repo}`, { headers: ghHeaders(cfg.token), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`github repo ${res.status} ${(await res.text()).slice(0, 200)}`);
  const v = (await res.json())?.private === true;
  repoPrivate.set(cfg.repo, v);
  return v;
}

/**
 * GitHub 이슈를 만들고 { number, url } 을 돌려준다. 공개 저장소인데 사용자가 공개 안내를 보지 못했으면(예전 앱) 만들지 않는다 ('skipped')
 */
async function createIssue(cfg, { category, message, email, consent }) {
  const priv = await isPrivate(cfg);
  if (!priv && !consent) return 'skipped';
  const lines = [fenced(message), '', `- 분류: ${category}`];
  // 답장 주소는 비공개 저장소에만 적는다 (공개 저장소면 메일로만 전달된다)
  if (priv) lines.push(`- 답장: ${email ? email.replace(/@/g, '@​') : '(없음)'}`);
  lines.push('', '_Kite 의 문의 창에서 보냈습니다._');
  const post = (labels) =>
    fetch(`${GITHUB_API}/repos/${cfg.repo}/issues`, {
      method: 'POST',
      headers: { ...ghHeaders(cfg.token), 'content-type': 'application/json' },
      body: JSON.stringify({ title: issueTitle(category, message), body: lines.join('\n'), ...(labels ? { labels } : {}) }),
      signal: AbortSignal.timeout(10000),
    });
  let res = await post(LABELS[category] || null);
  // 라벨을 달 수 없으면(권한·라벨 문제) 라벨 없이 다시
  if (res.status === 422 || res.status === 403) res = await post(null);
  if (!res.ok) throw new Error(`github issue ${res.status} ${(await res.text()).slice(0, 300)}`);
  const j = await res.json().catch(() => ({}));
  return { number: j?.number ?? null, url: typeof j?.html_url === 'string' ? j.html_url : null };
}

export async function POST(request) {
  const mail = { key: clean(process.env.BREVO_API_KEY), to: clean(process.env.CONTACT_TO), sender: clean(process.env.CONTACT_SENDER) };
  const gh = { token: clean(process.env.GITHUB_TOKEN), repo: clean(process.env.GITHUB_REPO) };
  const useMail = !!(mail.key && mail.to && mail.sender);
  const useIssue = !!(gh.token && /^[\w.-]+\/[\w.-]+$/.test(gh.repo));
  if (!useMail && !useIssue) return json({ ok: false, error: '문의 서버 설정이 끝나지 않았습니다.' }, 503);
  if (!(request.headers.get('content-type') || '').includes('application/json')) return json({ ok: false, error: '형식이 올바르지 않습니다.' }, 415);
  const ip = (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';
  if (rateLimited(ip)) return json({ ok: false, error: '잠시 후 다시 보내 주세요.' }, 429);

  let p;
  try {
    const text = await request.text();
    if (text.length > 20000) return json({ ok: false, error: '내용이 너무 깁니다.' }, 413);
    p = JSON.parse(text);
  } catch {
    return json({ ok: false, error: '형식이 올바르지 않습니다.' }, 400);
  }
  const category = CATEGORIES.has(p?.category) ? p.category : '문의';
  const message = typeof p?.message === 'string' ? p.message.trim() : '';
  const email = typeof p?.email === 'string' ? p.email.trim() : '';
  if (!message) return json({ ok: false, error: '내용을 적어 주세요.' }, 400);
  if (message.length > 9000) return json({ ok: false, error: '내용이 너무 깁니다.' }, 413);
  const validEmail = email && email.length <= 200 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  if (email && !validEmail) return json({ ok: false, error: '답장 받을 메일 주소 형식이 올바르지 않습니다.' }, 400);
  // public: 문의 창이 '공개 이슈로 올라간다'는 안내를 보여 준 앱에서 왔다
  const msg = { category, message, email: validEmail ? email : '', consent: p?.public === true };

  // 설정된 곳마다 보내고, 하나라도 닿으면 보낸 것으로 본다
  const jobs = [];
  if (useMail) jobs.push(sendMail(mail, msg).then(() => 'sent'));
  if (useIssue) jobs.push(createIssue(gh, msg));
  const results = await Promise.allSettled(jobs);
  for (const r of results) if (r.status === 'rejected') console.error('contact', String(r.reason?.message || r.reason).slice(0, 400));
  const issue = results.map((r) => (r.status === 'fulfilled' && typeof r.value === 'object' ? r.value : null)).find(Boolean);
  if (results.some((r) => r.status === 'fulfilled' && r.value !== 'skipped')) return json(issue?.url ? { ok: true, issue } : { ok: true });
  if (results.every((r) => r.status === 'fulfilled')) {
    // 이슈만 설정했는데 공개 저장소에 예전 앱의 문의가 온 경우: 메일 설정이 없어 전달할 곳이 없다
    console.error('contact: 공개 안내가 없는 예전 앱의 문의라 공개 이슈로 올리지 않았습니다 (메일도 설정하면 메일로 전달합니다)');
    return json({ ok: false, error: '이 버전에서는 문의를 보낼 수 없습니다. Kite 를 최신 버전으로 업데이트해 주세요.' }, 503);
  }
  return json({ ok: false, error: '보내지 못했습니다. 잠시 후 다시 시도해 주세요.' }, 502);
}

export function GET() {
  return json({ ok: true, service: 'kite-contact-relay' });
}
