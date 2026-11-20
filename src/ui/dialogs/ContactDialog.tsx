import { useState } from 'react';
import { Modal } from '../widgets';
import { app } from '../../app/controller';
import { platform } from '../../platform';
import { ISSUES_URL } from '../../appInfo';
import { issueTitle, newIssueUrl, osName } from '../../issueLink';

/**
 * 도구 > 문의하기: 분류·내용을 채운 GitHub 새 이슈 페이지를 브라우저로 연다.
 * Kite 는 아무것도 보내지 않는다: 사용자가 GitHub 에 로그인해 직접 올린다 (공개 이슈)
 */
const CATS = ['문의', '오류 신고', '기능 제안', '부적절한 AI 응답'];
async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function ContactDialog({ onClose, category: initCat, message: initMsg }: { onClose: () => void; category?: string; message?: string }) {
  const [category, setCategory] = useState(CATS.includes(initCat || '') ? initCat! : '문의');
  const [message, setMessage] = useState(initMsg || '');
  const [withEnv, setWithEnv] = useState(true);
  const [busy, setBusy] = useState(false);

  const send = async () => {
    if (!message.trim() || busy) return;
    setBusy(true);
    let body = message.trim();
    if (withEnv) {
      const ver = await platform.version().catch(() => '');
      body += `\n\n---\n- Kite: ${ver || '알 수 없음'}\n- 운영체제: ${osName()}`;
    }
    const { url, long } = newIssueUrl(category, issueTitle(category, message), body, '(Kite 문의 창에서 복사한 내용을 여기에 붙여 넣어 주세요: Ctrl+V)');
    if (long && !(await copyText(body))) {
      setBusy(false);
      app.toast('내용이 길어 복사해 넘기려 했는데 복사하지 못했습니다. 내용을 줄여 주세요.', 'error');
      return;
    }
    setBusy(false);
    onClose();
    platform.openExternal(url);
    app.toast(
      long ? '내용이 길어 클립보드에 복사했습니다. 열린 GitHub 페이지의 본문 칸에 붙여 넣은 뒤 "Submit new issue" 를 눌러 주세요.' : '열린 GitHub 페이지에서 내용을 확인하고 "Submit new issue" 를 눌러 주세요.',
      'info',
      8000,
    );
  };

  return (
    <Modal
      title="문의하기"
      onClose={onClose}
      width={520}
      footer={
        <>
          <button className="btn primary" disabled={!message.trim() || busy} onClick={send}>
            GitHub 에 올리기
          </button>
          <button className="btn" onClick={() => platform.openExternal(ISSUES_URL)}>
            올라온 이슈 보기
          </button>
          <button className="btn" onClick={onClose}>
            취소
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label>분류</label>
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATS.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </div>
      <textarea
        className="contact-msg"
        rows={9}
        value={message}
        autoFocus
        placeholder="문의·오류·제안 내용을 적어 주세요. 오류라면 어떤 문서에서 무엇을 했을 때 생겼는지 알려 주시면 도움이 됩니다."
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <label className="check" style={{ display: 'flex', marginTop: 6 }}>
        <input type="checkbox" checked={withEnv} onChange={(e) => setWithEnv(e.target.checked)} />
        앱 버전과 운영체제 이름을 함께 적기 (문서 내용은 넣지 않습니다)
      </label>
      <p className="unit" style={{ lineHeight: 1.6, marginTop: 8 }}>
        "GitHub 에 올리기" 를 누르면 내용을 채운 GitHub 의 새 이슈 페이지가 브라우저로 열립니다. GitHub 계정으로 로그인해 올리면 되고, 답변과 진행 상황은
        그 이슈에서 볼 수 있습니다. 이슈는 <b>공개</b>되어 누구나 볼 수 있으니 개인정보나 문서 내용은 적지 마세요.
      </p>
    </Modal>
  );
}
