import { createElement, useEffect, useRef, useState } from 'react';
import { useApp } from '../app/hooks';
import { app } from '../app/controller';
import { platform } from '../platform';
import { Icon } from './Icon';
import { getAiContext, insertAiHtml } from '../ai/insert';
import { sanitizeAiHtml } from './aiMarkdown';

/**
 * AI 도우미 — 계정 로그인 방식: 각 회사의 공식 웹 대화창(Claude · ChatGPT · Gemini)을 Kite 창 안에 띄운다.
 * 사용자는 그 웹사이트에 자기 계정(무료·구독)으로 직접 로그인하고, 한 번 로그인하면 다음에도 유지된다.
 * API 키가 필요 없다. Kite 는 계정 암호를 보거나 저장하지 않으며, 문서 내용은 사용자가 단추를 눌러 붙일 때만 대화창에 들어간다.
 * (띄울 수 있는 주소와 권한은 메인 프로세스가 정한다: electron/aiWeb.ts)
 */

interface Service {
  id: string;
  label: string;
  company: string;
  url: string;
}

/** Electron 의 webview 요소에서 쓰는 것만 */
interface WebviewEl extends HTMLElement {
  src: string;
  reload(): void;
  goBack(): void;
  canGoBack(): boolean;
  loadURL(url: string): Promise<void>;
  getURL(): string;
  insertText(text: string): Promise<void>;
  executeJavaScript(code: string, userGesture?: boolean): Promise<any>;
}

const PARTITION = 'persist:kite-ai-web';
const LS = 'kite:ai:web:';
const lsGet = (k: string) => {
  try {
    return localStorage.getItem(LS + k);
  } catch {
    return null;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(LS + k, v);
  } catch {
    /* 무시 */
  }
};

/**
 * 대화 입력 칸에 커서를 둔다: 이미 글을 넣을 수 있는 곳에 커서가 있으면 그대로, 아니면 화면에 보이는 입력 칸 가운데 마지막 것
 * (대화창의 입력 칸은 보통 맨 아래에 있다). 어느 회사 페이지든 같은 방법을 쓴다 — 페이지 구조에 기대지 않는다.
 */
const FOCUS_INPUT = `(() => {
  const editable = (e) => !!e && (e.isContentEditable || e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && /^(text|search|)$/.test(e.type || '')));
  if (editable(document.activeElement)) return true;
  const all = Array.from(document.querySelectorAll('[contenteditable="true"], textarea')).filter((e) => {
    const r = e.getBoundingClientRect();
    return r.width > 40 && r.height > 8 && !e.disabled && !e.readOnly;
  });
  const t = all[all.length - 1];
  if (!t) return false;
  t.focus();
  return true;
})()`;

/** 페이지에서 사용자가 끌어서 고른 부분의 HTML */
const GET_SELECTION = `(() => {
  const s = window.getSelection();
  if (!s || !s.rangeCount || s.isCollapsed) return '';
  const d = document.createElement('div');
  for (let i = 0; i < s.rangeCount; i++) d.appendChild(s.getRangeAt(i).cloneContents());
  return d.innerHTML.slice(0, 2000000);
})()`;

const MAX_PASTE = 300000;

async function ensureWebConsent(s: Service): Promise<boolean> {
  if (lsGet('consent:' + s.id) === '1') return true;
  const r = await app.confirm(
    `${s.label} 계정으로 쓰기 전에`,
    `Kite 창 안에 ${s.company}의 공식 웹 대화창(${new URL(s.url).host})을 띄웁니다.\n\n` +
      `· 로그인은 그 웹사이트에서 직접 합니다. Kite 는 계정 암호를 보거나 저장하지 않으며, 로그인 상태(쿠키)는 이 컴퓨터의 Kite 전용 저장소에만 남습니다.\n` +
      `· 대화 내용과 '선택 영역 보내기'·'문서 보내기'로 붙인 문서 내용은 ${s.company}의 서버로 전송되고, 그 회사의 약관·개인정보 처리방침을 따릅니다. Kite 개발사는 이 내용을 받지 않습니다.\n` +
      `· 개인정보·기밀이 담긴 문서는 보내기 전에 '개인정보 찾기·가림'으로 가리세요.\n` +
      `· AI 가 만든 내용은 틀릴 수 있으니 확인한 뒤 쓰세요.`,
    [
      { id: 'ok', label: '동의하고 열기', primary: true },
      { id: 'no', label: '열지 않음' },
    ],
  );
  if (r !== 'ok') return false;
  lsSet('consent:' + s.id, '1');
  return true;
}

export function AiWebPanel() {
  const state = useApp();
  const api = typeof window !== 'undefined' ? window.kite : undefined;
  const [services, setServices] = useState<Service[]>([]);
  const [sid, setSid] = useState<string>(() => lsGet('service') || 'claude');
  /** 동의한 서비스만 띄운다 */
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const ref = useRef<WebviewEl | null>(null);

  useEffect(() => {
    api?.aiWebServices?.().then((list) => {
      setServices(list);
      const start: Record<string, boolean> = {};
      for (const s of list) if (lsGet('consent:' + s.id) === '1') start[s.id] = true;
      setOpened(start);
    });
  }, []);

  const service = services.find((s) => s.id === sid) || services[0];
  const shown = !!service && !!opened[service.id];

  // 웹 대화창의 상태 (불러오는 중·실패)
  useEffect(() => {
    const wv = ref.current;
    if (!wv || !shown) return;
    const start = () => {
      setLoading(true);
      setFailed(null);
    };
    const stop = () => setLoading(false);
    const fail = (e: any) => {
      // -3: 이동이 취소된 것 (다른 주소로 넘어가는 중) — 실패가 아니다
      if (e.isMainFrame && e.errorCode !== -3) setFailed(`${e.errorDescription || '연결하지 못했습니다'} (${e.errorCode})`);
    };
    wv.addEventListener('did-start-loading', start);
    wv.addEventListener('did-stop-loading', stop);
    wv.addEventListener('did-fail-load', fail);
    return () => {
      wv.removeEventListener('did-start-loading', start);
      wv.removeEventListener('did-stop-loading', stop);
      wv.removeEventListener('did-fail-load', fail);
    };
  }, [shown, service?.id]);

  if (!api?.aiWebServices) return <div className="ai-empty">계정 로그인 방식은 데스크톱 앱(Kite)에서 쓸 수 있습니다. 여기서는 API 키 방식을 쓰세요.</div>;
  if (!service) return null;

  const open = async (s: Service) => {
    setSid(s.id);
    lsSet('service', s.id);
    setFailed(null);
    if (!opened[s.id] && (await ensureWebConsent(s))) setOpened((o) => ({ ...o, [s.id]: true }));
  };

  /** 문서(선택 영역)를 대화 입력 칸에 붙인다. 보내기는 사용자가 직접 누른다 */
  const paste = async (mode: 'selection' | 'doc') => {
    const wv = ref.current;
    if (!wv || !shown) return;
    const ctx = getAiContext(mode);
    if (!ctx || !ctx.text) {
      app.toast(mode === 'selection' ? '문서에서 보낼 부분을 먼저 선택하세요.' : '보낼 문서 내용이 없습니다.', 'warn');
      return;
    }
    if (ctx.text.length > MAX_PASTE) {
      app.toast('내용이 너무 길어 붙이지 못했습니다. 필요한 부분을 선택해 "선택 영역 보내기"로 보내세요.', 'warn', 6000);
      return;
    }
    try {
      const ok = await wv.executeJavaScript(FOCUS_INPUT, true);
      if (!ok) {
        app.toast('대화 입력 칸을 찾지 못했습니다. 입력 칸을 한 번 누른 뒤 다시 시도하세요 (로그인 전이면 먼저 로그인하세요).', 'warn', 6000);
        return;
      }
      wv.focus();
      await wv.insertText(`<${ctx.label}>\n${ctx.text}\n</${ctx.label}>\n`);
      app.toast(`${ctx.label === '문서' ? '문서 전체' : '선택 영역'}를 입력 칸에 붙였습니다. 요청을 덧붙여 보내세요.`);
    } catch {
      app.toast('붙이지 못했습니다. 페이지가 다 열린 뒤 다시 시도하세요.', 'error');
    }
  };

  /** 웹 대화창에서 끌어서 고른 답을 문서에 넣는다 */
  const takeAnswer = async (replace: boolean) => {
    const wv = ref.current;
    if (!wv || !shown) return;
    // 단추의 켜짐·꺼짐은 문서의 선택이 바뀔 때마다 다시 그려지지 않으므로, 누를 때 확인한다
    if (replace && (!app.active || app.active.editor.state.selection.empty)) {
      app.toast('문서에서 바꿀 부분을 먼저 선택하세요.', 'warn');
      return;
    }
    let html = '';
    try {
      html = String((await wv.executeJavaScript(GET_SELECTION, true)) || '');
    } catch {
      /* 아래에서 안내 */
    }
    if (!html.trim()) {
      app.toast('웹 대화창에서 문서에 넣을 답을 마우스로 끌어 고른 뒤 누르세요.', 'warn', 5000);
      return;
    }
    if (!insertAiHtml(sanitizeAiHtml(html), replace)) app.toast('넣을 내용이 없습니다.', 'warn');
  };

  const logout = async () => {
    const r = await app.confirm('로그인 정보 지우기', 'Kite 안의 웹 대화창(Claude · ChatGPT · Gemini)에 남은 로그인 상태와 저장 데이터를 모두 지웁니다. 다음에 쓸 때 다시 로그인해야 합니다.', [
      { id: 'ok', label: '지우기', primary: true },
      { id: 'no', label: '취소' },
    ]);
    if (r !== 'ok') return;
    await api.aiWebClear();
    ref.current?.loadURL(service.url).catch(() => {});
    app.toast('로그인 정보를 지웠습니다.');
  };

  return (
    <div className="ai-web">
      <div className="ai-config">
        <span className="seg">
          {services.map((s) => (
            <button key={s.id} className={service.id === s.id ? 'on' : ''} onClick={() => open(s)} title={`${s.company} 계정으로 로그인해서 쓰기`}>
              {s.label}
            </button>
          ))}
        </span>
        <div className="row ai-web-bar">
          <button className="btn small" disabled={!shown || !state.active} title="문서에서 선택한 부분을 대화 입력 칸에 붙입니다" onClick={() => paste('selection')}>
            선택 영역 보내기
          </button>
          <button className="btn small" disabled={!shown || !state.active} title="문서 전체를 대화 입력 칸에 붙입니다" onClick={() => paste('doc')}>
            문서 보내기
          </button>
          <span style={{ flex: 1 }} />
          <button className="tb-btn" disabled={!shown} title="뒤로" onClick={() => ref.current?.canGoBack() && ref.current.goBack()}>
            <Icon name="ArrowLeft" size={14} />
          </button>
          <button className="tb-btn" disabled={!shown} title="새로 고침" onClick={() => ref.current?.reload()}>
            <Icon name="RefreshCw" size={14} />
          </button>
          <button className="tb-btn" disabled={!shown} title="로그인 정보 지우기 (로그아웃)" onClick={logout}>
            <Icon name="LogOut" size={14} />
          </button>
        </div>
        <div className="row ai-web-bar">
          <button className="btn small" disabled={!shown || !state.active} title="웹 대화창에서 끌어서 고른 답을 문서의 커서 자리에 넣습니다" onClick={() => takeAnswer(false)}>
            고른 답을 문서에 넣기
          </button>
          <button className="btn small" disabled={!shown || !state.active} title="웹 대화창에서 고른 답으로 문서의 선택 영역을 바꿉니다" onClick={() => takeAnswer(true)}>
            선택 영역 바꾸기
          </button>
          {loading && <span className="unit">불러오는 중…</span>}
        </div>
      </div>
      {shown ? (
        <div className="ai-web-view">
          {/* partition·allowpopups 는 붙기 전에 정해져야 한다. 주소는 메인 프로세스가 허용 목록으로 검사한다 */}
          {createElement('webview', { key: service.id, ref, src: service.url, partition: PARTITION, allowpopups: 'true', className: 'ai-webview' })}
          {failed && (
            <div className="ai-web-fail">
              <b>{service.label} 을(를) 열지 못했습니다.</b>
              <div className="unit">{failed}</div>
              <div className="row" style={{ gap: 6, marginTop: 8 }}>
                <button className="btn small" onClick={() => ref.current?.loadURL(service.url).catch(() => {})}>
                  다시 시도
                </button>
                <button className="btn small" onClick={() => platform.openExternal(service.url)}>
                  브라우저에서 열기
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="ai-empty">
          <b>{service.label}</b> 계정으로 로그인해서 Kite 안에서 대화합니다. API 키가 필요 없습니다.
          <br />
          <button className="btn primary" style={{ marginTop: 10 }} onClick={() => open(service)}>
            {service.label} 열기
          </button>
        </div>
      )}
      <div className="unit ai-web-foot">
        로그인은 {service.company} 웹사이트에서 직접 합니다. 로그인 화면이 "이 브라우저에서는 로그인할 수 없다"고 하면(Google 계정 등) 이메일 로그인을 쓰거나 API 키 방식을 쓰세요.
      </div>
    </div>
  );
}
