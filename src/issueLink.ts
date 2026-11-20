import { ISSUES_URL } from './appInfo';

/** 문의하기 → GitHub 새 이슈 페이지 주소 만들기 */
/** 분류 → 이슈 라벨 (저장소 쓰기 권한이 없으면 GitHub 가 무시한다) */
const LABELS: Record<string, string> = { 문의: 'question', '오류 신고': 'bug', '기능 제안': 'enhancement', '부적절한 AI 응답': 'ai-report' };
/** 데스크톱 앱이 바깥 브라우저로 넘기는 주소 길이 한도 (electron/main.ts 의 openExternal) */
const MAX_URL = 2000;

/** 운영체제 이름 (사용자 에이전트에서) */
export function osName(ua = navigator.userAgent): string {
  const m = /Android ([\d.]+)/.exec(ua);
  if (m) return `Android ${m[1]}`;
  if (/Windows NT 10/.test(ua)) return 'Windows 10/11';
  const w = /Windows NT ([\d.]+)/.exec(ua);
  if (w) return `Windows NT ${w[1]}`;
  if (/Mac OS X/.test(ua)) return 'macOS';
  if (/Linux/.test(ua)) return 'Linux';
  return '알 수 없음';
}

/** 이슈 제목: 분류와 첫 줄 */
export function issueTitle(category: string, message: string): string {
  const first = message.split('\n').map((l) => l.trim()).find(Boolean) || '';
  const short = first.length > 60 ? first.slice(0, 59) + '…' : first;
  return `[${category}] ${short}`;
}

/**
 * 새 이슈 주소. 내용이 길어 주소에 다 들어가지 않으면 본문 없이 만들고 long=true (내용은 클립보드로 넘긴다)
 */
export function newIssueUrl(category: string, title: string, body: string, pasteHint: string): { url: string; long: boolean } {
  const base = `${ISSUES_URL}/new?`;
  const q = (b: string) => {
    const p = new URLSearchParams({ title, body: b });
    if (LABELS[category]) p.set('labels', LABELS[category]);
    return base + p.toString();
  };
  const full = q(body);
  if (full.length <= MAX_URL) return { url: full, long: false };
  return { url: q(pasteHint), long: true };
}
