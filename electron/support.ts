import { app, ipcMain } from 'electron';
import os from 'node:os';
import { CONTACT_FORM_ENDPOINT, CONTACT_FORM_KEY } from '../src/appInfo';

/**
 * 문의 보내기: 앱 안 문의 창의 내용을 문의 중계(Kite 의 contact-relay) 또는 문의 양식 서비스(Formspree·Web3Forms)로 보낸다.
 * 보낼 주소는 여기서 정한다 (화면 쪽이 임의의 주소로 보내게 하지 않는다). 개발사 메일 주소는 앱에 없다.
 * 중계는 문의를 GitHub 의 Kite 저장소에 공개 이슈로도 올린다: 문의 창이 그 사실을 알리므로 public: true 를 함께 보낸다
 */
const CATEGORIES = new Set(['문의', '오류 신고', '기능 제안', '부적절한 AI 응답']);
let lastSent = 0;

function osName(): string {
  if (process.platform === 'win32') return `Windows ${os.release()}`;
  if (process.platform === 'darwin') return `macOS (Darwin ${os.release()})`;
  return `${process.platform} ${os.release()}`;
}

export function setupSupport() {
  ipcMain.handle('support:send', async (_e, raw: unknown): Promise<{ ok: boolean; error?: string; issueUrl?: string }> => {
    const p = raw as { category?: unknown; message?: unknown; email?: unknown; withEnv?: unknown };
    const category = typeof p?.category === 'string' && CATEGORIES.has(p.category) ? p.category : '문의';
    const message = typeof p?.message === 'string' ? p.message.trim() : '';
    const email = typeof p?.email === 'string' ? p.email.trim() : '';
    if (!message) return { ok: false, error: '내용을 적어 주세요.' };
    if (message.length > 8000) return { ok: false, error: '내용이 너무 깁니다 (8,000자까지).' };
    if (email && (email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return { ok: false, error: '답장 받을 메일 주소 형식이 올바르지 않습니다.' };
    // 개발판 시험용: KITE_CONTACT_ENDPOINT 로 보낼 곳을 바꿀 수 있다 (배포판에서는 무시)
    const testEndpoint = !app.isPackaged ? process.env.KITE_CONTACT_ENDPOINT || '' : '';
    const endpoint = testEndpoint || CONTACT_FORM_ENDPOINT;
    if (!endpoint && !CONTACT_FORM_KEY) return { ok: false, error: '문의 양식이 아직 설정되지 않았습니다.' };
    if (Date.now() - lastSent < 30_000) return { ok: false, error: '잠시 후 다시 보내 주세요.' };

    const env = p?.withEnv === false ? '' : `Kite ${app.getVersion()} · ${osName()}${(process as any).windowsStore ? ' · Microsoft Store' : ''}`;
    const subject = `[Kite] ${category}`;
    const body: Record<string, string> = {
      subject,
      _subject: subject,
      category,
      message: env ? `${message}\n\n---\n${env}` : message,
      from_name: 'Kite 사용자',
    };
    // 문의 창이 '공개 이슈로 올라간다'고 알렸다 (이 표시가 없는 예전 앱의 문의는 중계가 공개하지 않는다)
    const extra = { public: true };
    if (email) {
      body.email = email; // 두 서비스 모두 이 값을 '답장 받을 주소'로 쓴다
      body.replyto = email;
    }
    const url = endpoint || 'https://api.web3forms.com/submit';
    if (!/^https:\/\//.test(url) && !(testEndpoint && /^http:\/\/127\.0\.0\.1[:/]/.test(url))) return { ok: false, error: '문의 양식 주소가 올바르지 않습니다.' };
    if (!endpoint) body.access_key = CONTACT_FORM_KEY;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ ...body, ...extra }),
        signal: AbortSignal.timeout(15_000),
      });
      let j: any = null;
      try {
        j = await res.json();
      } catch {
        /* 무시 */
      }
      if (!res.ok || j?.success === false || j?.ok === false) {
        const msg = j?.message || j?.error || j?.errors?.[0]?.message || `HTTP ${res.status}`;
        return { ok: false, error: `보내지 못했습니다: ${String(msg).slice(0, 200)}` };
      }
      lastSent = Date.now();
      // 중계가 만든 GitHub 이슈 주소 (GitHub 주소만 받는다)
      const issueUrl = typeof j?.issue?.url === 'string' ? j.issue.url : '';
      return /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+$/.test(issueUrl) ? { ok: true, issueUrl } : { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.name === 'TimeoutError' ? '응답이 없습니다. 인터넷 연결을 확인하세요.' : '보내지 못했습니다. 인터넷 연결을 확인하세요.' };
    }
  });
}
