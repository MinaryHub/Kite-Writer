import { reportAiResponse } from '../ai/report';
import { ensureAiConsent } from '../ai/consent';
import { useEffect, useMemo, useRef, useState } from 'react';
import { renderMarkdown } from './aiMarkdown';
import { AiDesktopPanel } from './AiDesktopPanel';
import { AiWebPanel } from './AiWebPanel';
import { getAiContext, insertAiHtml } from '../ai/insert';
import { useApp } from '../app/hooks';
import { app } from '../app/controller';
import { Icon } from './Icon';
import { Modal } from './widgets';
import { platform } from '../platform';

/**
 * AI 도우미. Kite 창 안에서 세 가지 방식으로 쓴다:
 *  - 계정 로그인: 각 회사의 공식 웹 대화창을 패널 안에 띄워 자기 계정(무료·구독)으로 쓴다 — API 키 필요 없음 (AiWebPanel)
 *  - API 키: Claude / GPT / Gemini / Ollama(로컬 모델)와 바로 대화. Claude 는 키가 없어도 로그인해 둔 계정(ant auth login)을 쓴다
 *  - Claude 데스크톱: Claude 데스크톱 앱이 Kite 문서를 읽고 고치게 연결 (AiDesktopPanel)
 */

type Provider = 'claude' | 'openai' | 'gemini' | 'ollama';
/** 키가 필요한데 없는지 (Ollama 는 키 대신 서버 주소, 기본값이 있어 늘 쓸 수 있다) */
const noKey = (keys: Record<string, string> | null, p: Provider) => !!keys && p !== 'ollama' && keys[p] === 'none';
type KeyState = Record<Provider, 'saved' | 'env' | 'login' | 'none'>;
type Mode = 'web' | 'api' | 'desktop';

interface Msg {
  role: 'user' | 'assistant';
  /** 화면에 보일 내용 */
  text: string;
  /** 모델에 보낼 내용 (문서 내용 포함) */
  sent?: string;
  provider?: Provider;
  model?: string;
  error?: boolean;
  note?: string;
  pending?: boolean;
}

const api = typeof window !== 'undefined' ? window.kite : undefined;

const PROVIDERS: { id: Provider; label: string; defaultModel: string }[] = [
  { id: 'claude', label: 'Claude', defaultModel: 'claude-opus-5-5' },
  { id: 'openai', label: 'GPT', defaultModel: 'gpt-5.5' },
  { id: 'gemini', label: 'Gemini', defaultModel: 'gemini-flash-latest' },
  { id: 'ollama', label: 'Ollama', defaultModel: 'qwen3' },
];

const SYSTEM = `당신은 한국어 워드프로세서 "Kite"에 내장된 문서 작성 도우미입니다.
- 사용자가 보낸 <문서> 또는 <선택> 내용을 바탕으로 요약, 교정, 다듬기, 번역, 초안 작성 등을 돕습니다.
- 답은 한국어로 하되, 사용자가 다른 언어를 요청하면 따르세요.
- 문서에 바로 넣을 결과물(교정본, 번역문, 초안 등)을 요청받으면 머리말이나 설명 없이 결과물만 Markdown으로 답하세요. 표가 필요하면 Markdown 표를 쓰세요.
- 공문서·보고서 문체(개조식, '~함', '~임' 등)가 쓰인 문서는 그 문체를 유지하세요.`;

const QUICK: { label: string; prompt: string }[] = [
  { label: '요약', prompt: '다음 내용을 핵심만 간결하게 개조식으로 요약해 주세요.' },
  { label: '맞춤법 교정', prompt: '다음 내용의 맞춤법, 띄어쓰기, 문법 오류를 바로잡은 교정본만 보여 주세요. 내용과 문체는 바꾸지 마세요.' },
  { label: '문장 다듬기', prompt: '다음 내용을 뜻은 그대로 두고 더 읽기 쉽고 매끄럽게 다듬어 주세요. 결과만 보여 주세요.' },
  { label: '공문서체로', prompt: '다음 내용을 공문서·보고서에 맞는 개조식 문체(~함, ~임)로 바꿔 주세요. 결과만 보여 주세요.' },
  { label: '영어로 번역', prompt: '다음 내용을 자연스러운 영어로 번역해 주세요. 번역문만 보여 주세요.' },
  { label: '한국어로 번역', prompt: '다음 내용을 자연스러운 한국어로 번역해 주세요. 번역문만 보여 주세요.' },
];

const LS = 'kite:ai:';
const lsGet = (k: string, d: string) => {
  try {
    return localStorage.getItem(LS + k) || d;
  } catch {
    return d;
  }
};
const lsSet = (k: string, v: string) => {
  try {
    localStorage.setItem(LS + k, v);
  } catch {
    /* 무시 */
  }
};

export { renderMarkdown };

export function AiPanel() {
  const appState = useApp();
  const [provider, setProvider] = useState<Provider>(() => (lsGet('provider', 'claude') as Provider) || 'claude');
  const [models, setModels] = useState<Record<Provider, { id: string; label: string }[]>>({ claude: [], openai: [], gemini: [], ollama: [] });
  const [model, setModel] = useState<Record<Provider, string>>(() => ({
    claude: lsGet('model:claude', 'claude-opus-5-5'),
    openai: lsGet('model:openai', 'gpt-5.5'),
    gemini: lsGet('model:gemini', 'gemini-flash-latest'),
    ollama: lsGet('model:ollama', 'qwen3'),
  }));
  const [keys, setKeys] = useState<KeyState | null>(null);
  const [ctxMode, setCtxMode] = useState<'doc' | 'selection' | 'none'>(() => lsGet('ctx', 'selection') as any);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [modelError, setModelError] = useState<string | null>(null);
  // 'web': 계정 로그인(공식 웹 대화창을 패널 안에) / 'api': API 키로 직접 대화 / 'desktop': Claude 데스크톱 연결(MCP)
  const [mode, setMode] = useState<Mode | null>(() => {
    const m = lsGet('mode', '');
    return m === 'web' || m === 'api' || m === 'desktop' ? m : null;
  });
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!api) return;
    api.aiKeyStatus().then(setKeys);
    return api.onAiEvent((ev: any) => {
      setMsgs((cur) => {
        const i = cur.findIndex((m) => (m as any).id === ev.id);
        if (i < 0) return cur;
        const next = [...cur];
        const m = { ...next[i] };
        if (ev.type === 'delta') m.text += ev.text;
        else if (ev.type === 'done') {
          m.pending = false;
          m.model = ev.model;
          m.note = ev.note;
        } else if (ev.type === 'error') {
          m.pending = false;
          if (!m.text) {
            m.text = ev.message;
            m.error = true;
          } else m.note = ev.message;
        }
        next[i] = m;
        return next;
      });
      if (ev.type !== 'delta') setBusyId(null);
    });
  }, []);

  // 모델 목록 (GPT/Gemini는 API에서 가져옴)
  useEffect(() => {
    if (!api || !keys || models[provider].length) return;
    if (noKey(keys, provider)) return;
    setModelError(null);
    api.aiModels(provider).then((r) => {
      if (r.ok && r.models) {
        setModels((m) => ({ ...m, [provider]: r.models! }));
        if (r.models.length && !r.models.some((x) => x.id === model[provider])) {
          const pick = r.models[0].id;
          setModel((m) => ({ ...m, [provider]: pick }));
        }
      } else setModelError(r.error || '모델 목록을 가져오지 못했습니다.');
    });
  }, [provider, keys]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [msgs]);

  const curModel = model[provider];
  const modelOptions = useMemo(() => {
    const list = models[provider];
    if (!list.some((m) => m.id === curModel)) return [{ id: curModel, label: curModel }, ...list];
    return list;
  }, [models, provider, curModel]);

  if (!appState.aiOpen) return null;

  const send = async (text: string, quick = false) => {
    if (!api) {
      app.toast('AI 도우미는 데스크톱 앱에서 사용할 수 있습니다.', 'warn');
      return;
    }
    if (busyId || !text.trim()) return;
    if (noKey(keys, provider)) {
      setShowKeys(true);
      return;
    }
    const mode = quick && ctxMode === 'none' ? 'selection' : ctxMode;
    let ctx = getAiContext(mode);
    if (quick && !ctx) ctx = getAiContext('doc');
    if (ctx && ctx.text.length > 600000) {
      app.toast('문서가 너무 커서 보낼 수 없습니다. 필요한 부분을 선택한 뒤 "선택 영역"으로 보내 주세요.', 'warn', 6000);
      return;
    }
    // 클라우드 AI 로 처음 보낼 때 동의를 받는다 (거부하면 입력은 그대로 둔다)
    if (!(await ensureAiConsent(provider))) return;
    const sent = ctx ? `${text.trim()}\n\n<${ctx.label}>\n${ctx.text}\n</${ctx.label}>` : text.trim();
    const id = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const history = msgs.filter((m) => !m.error && !m.pending && m.text).map((m) => ({ role: m.role, content: m.role === 'user' ? m.sent || m.text : m.text }));
    const user: Msg = { role: 'user', text: text.trim() + (ctx ? `\n📎 ${ctx.label === '문서' ? '문서 전체' : '선택 영역'} 포함` : ''), sent };
    const bot: Msg & { id: string } = { id, role: 'assistant', text: '', provider, model: curModel, pending: true };
    setMsgs([...msgs, user, bot]);
    setInput('');
    setBusyId(id);
    await api.aiChat({ id, provider, model: curModel, system: SYSTEM, messages: [...history, { role: 'user', content: sent }] });
  };

  // 화면 표시와 같은 정리(외부 그림 제거)를 거친 뒤 문서에 넣는다
  const insert = (md: string, replace: boolean) => {
    insertAiHtml(renderMarkdown(md), replace);
  };

  // 처음에는: 쓸 수 있는 API 키(또는 Claude 로그인)가 있으면 API 키 방식, 없으면 계정 로그인 방식 (둘 다 Kite 안에서 대화한다)
  const canWeb = !!api?.aiWebServices;
  const effMode: Mode = mode || (keys && (['claude', 'openai', 'gemini'] as Provider[]).some((p) => keys[p] !== 'none') ? 'api' : canWeb ? 'web' : 'api');
  const chooseMode = (m: Mode) => {
    setMode(m);
    lsSet('mode', m);
  };

  const pname = (p?: Provider) => PROVIDERS.find((x) => x.id === p)?.label || '';
  const hasSel = !!app.active && !app.active.editor.state.selection.empty;

  return (
    <aside className={'ai-panel' + (effMode === 'web' ? ' web' : '')}>
      <div className="ai-head">
        <b>AI 도우미</b>
        <span style={{ flex: 1 }} />
        {effMode === 'api' && (
          <>
            <button className="tb-btn" title="대화 지우기" onClick={() => setMsgs([])} disabled={!!busyId}>
              <Icon name="Trash2" size={14} />
            </button>
            <button className="tb-btn" title="API 키 설정" onClick={() => setShowKeys(true)}>
              <Icon name="Settings" size={14} />
            </button>
          </>
        )}
        <button className="tb-btn" title="닫기" onClick={() => app.set({ aiOpen: false })}>
          <Icon name="X" size={14} />
        </button>
      </div>
      <div className="ai-mode">
        <span className="seg">
          <button className={effMode === 'web' ? 'on' : ''} onClick={() => chooseMode('web')} title="Claude · ChatGPT · Gemini 에 내 계정으로 로그인해서 Kite 안에서 대화 — API 키 필요 없음">
            계정 로그인
          </button>
          <button className={effMode === 'api' ? 'on' : ''} onClick={() => chooseMode('api')} title="API 키로 Kite 안에서 바로 대화 (Claude 는 ant auth login 으로 로그인해 둔 계정도 사용)">
            API 키
          </button>
          <button className={effMode === 'desktop' ? 'on' : ''} onClick={() => chooseMode('desktop')} title="Claude 데스크톱 앱이 Kite 문서를 직접 읽고 고치게 연결 (대화는 Claude 데스크톱에서)">
            Claude 데스크톱
          </button>
        </span>
      </div>
      {effMode === 'web' ? (
        <AiWebPanel />
      ) : effMode === 'desktop' ? (
        <AiDesktopPanel />
      ) : (
        <>
      <div className="ai-config">
        <span className="seg">
          {PROVIDERS.map((p) => (
            <button
              key={p.id}
              className={provider === p.id ? 'on' : ''}
              onClick={() => {
                setProvider(p.id);
                lsSet('provider', p.id);
              }}
            >
              {p.label}
              {noKey(keys, p.id) && <span className="ai-nokey" title="API 키 없음">!</span>}
            </button>
          ))}
        </span>
        <select
          value={curModel}
          onChange={(e) => {
            setModel({ ...model, [provider]: e.target.value });
            lsSet('model:' + provider, e.target.value);
          }}
          title="모델"
        >
          {modelOptions.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {modelError && <div className="ai-warn">{modelError}</div>}
        <div className="row" style={{ gap: 6 }}>
          <span className="unit">함께 보내기</span>
          <span className="seg small">
            {(
              [
                ['selection', '선택 영역'],
                ['doc', '문서 전체'],
                ['none', '없음'],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                className={ctxMode === k ? 'on' : ''}
                onClick={() => {
                  setCtxMode(k);
                  lsSet('ctx', k);
                }}
              >
                {l}
              </button>
            ))}
          </span>
        </div>
      </div>
      <div className="ai-quick">
        {QUICK.map((q) => (
          <button key={q.label} className="btn small" disabled={!!busyId} title={hasSel ? '선택 영역에 적용' : '문서 전체에 적용'} onClick={() => send(q.prompt, true)}>
            {q.label}
          </button>
        ))}
      </div>
      <div
        className="ai-list"
        ref={listRef}
        // 가운데 버튼/보조 클릭은 확인 없이 새 창을 열려 하므로 막는다
        onAuxClick={(e) => {
          if ((e.target as HTMLElement).closest('a')) e.preventDefault();
        }}
        onClick={(e) => {
          const a = (e.target as HTMLElement).closest('a');
          if (a) {
            e.preventDefault();
            const href = a.getAttribute('href') || '';
            // 링크 주소에 문서 내용이 실려 나갈 수 있으므로 전체 주소를 보여 주고 확인받는다
            if (/^https?:/.test(href) && window.confirm(`AI 응답 속 링크를 외부 브라우저로 엽니다.

${href.slice(0, 500)}

주소를 확인한 뒤 여세요. 계속할까요?`)) platform.openExternal(href);
          }
        }}
      >
        {!api && <div className="ai-empty">AI 도우미는 데스크톱 앱(Kite)에서 사용할 수 있습니다.</div>}
        {api && !msgs.length && (
          <div className="ai-empty">
            문서를 쓰다가 궁금한 것을 물어보세요.
            <br />
            글을 선택한 뒤 위의 단추(요약·교정·번역 등)를 누르면 선택한 부분에 적용합니다.
          </div>
        )}
        {msgs.map((m, i) => (
          <div key={i} className={'ai-msg ' + m.role + (m.error ? ' error' : '')}>
            {m.role === 'assistant' && (
              <div className="ai-meta">
                {pname(m.provider)} · {m.model}
                {m.pending && <span className="ai-dots"> 작성 중…</span>}
              </div>
            )}
            {m.role === 'user' ? (
              <div className="ai-text">{m.text}</div>
            ) : (
              // DOMPurify로 정리한 Markdown 렌더링
              <div className="ai-text md" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text || (m.pending ? '' : '(빈 응답)')) }} />
            )}
            {m.note && <div className="ai-note">{m.note}</div>}
            {m.role === 'assistant' && !m.pending && !m.error && m.text && (
              <div className="ai-actions">
                <button className="link-btn" onClick={() => navigator.clipboard.writeText(m.text).then(() => app.toast('복사했습니다.'))}>
                  복사
                </button>
                <button className="link-btn" onClick={() => insert(m.text, false)}>
                  문서에 넣기
                </button>
                <button className="link-btn" disabled={!hasSel} title={hasSel ? '' : '문서에서 바꿀 부분을 먼저 선택하세요'} onClick={() => insert(m.text, true)}>
                  선택 영역 바꾸기
                </button>
                <span style={{ flex: 1 }} />
                <button className="link-btn ai-report" title="부적절하거나 사실과 다른 응답 신고" onClick={() => reportAiResponse({ provider: pname(m.provider), model: m.model, text: m.text })}>
                  신고
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="ai-disclaimer">AI가 만든 내용은 틀리거나 부적절할 수 있습니다. 확인한 뒤 쓰세요.</div>
      <div className="ai-input">
        <textarea
          ref={inputRef}
          value={input}
          rows={3}
          placeholder={`${pname(provider)}에게 물어보기 (Enter 보내기, Shift+Enter 줄 바꿈)`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send(input);
            }
          }}
        />
        {busyId ? (
          <button className="btn" onClick={() => api?.aiAbort(busyId)}>
            중지
          </button>
        ) : (
          <button className="btn primary" disabled={!input.trim()} onClick={() => send(input)}>
            보내기
          </button>
        )}
      </div>
        </>
      )}
      {showKeys && (
        <AiKeysDialog
          keys={keys}
          onClose={() => setShowKeys(false)}
          onSaved={(k) => {
            setKeys(k);
            setModels({ claude: [], openai: [], gemini: [], ollama: [] });
          }}
        />
      )}
    </aside>
  );
}

function AiKeysDialog({ keys, onClose, onSaved }: { keys: KeyState | null; onClose: () => void; onSaved: (k: KeyState) => void }) {
  const [vals, setVals] = useState<Record<Provider, string>>({ claude: '', openai: '', gemini: '', ollama: '' });
  const status = (p: Provider) => (keys?.[p] === 'saved' ? '저장됨' : keys?.[p] === 'env' ? '환경 변수 사용 중' : keys?.[p] === 'login' ? '키 없이 로그인한 계정 사용 중 (ant auth login)' : '없음');
  const save = async () => {
    if (!api) return;
    let k: KeyState | null = keys;
    try {
      for (const p of ['claude', 'openai', 'gemini', 'ollama'] as Provider[]) if (vals[p].trim()) k = await api.aiSetKey(p, vals[p].trim());
    } catch (e: any) {
      app.toast(String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error', 6000);
      return;
    }
    if (k) onSaved(k);
    app.toast('설정을 저장했습니다.');
    onClose();
  };
  const remove = async (p: Provider) => {
    if (!api) return;
    onSaved(await api.aiSetKey(p, null));
  };
  const row = (p: Provider, label: string, link: string, ph: string) => (
    <>
      <label>{label}</label>
      <div>
        <div className="row">
          <input type="password" style={{ flex: 1 }} placeholder={ph} value={vals[p]} onChange={(e) => setVals({ ...vals, [p]: e.target.value })} autoComplete="off" />
          {keys?.[p] === 'saved' && (
            <button className="btn small danger" onClick={() => remove(p)}>
              삭제
            </button>
          )}
        </div>
        <div className="unit">
          {status(p)} · 발급: {link}
        </div>
      </div>
    </>
  );
  return (
    <Modal title="AI 연결 설정" onClose={onClose} width={520} onEnter={save} footer={<><button className="btn primary" onClick={save}>저장</button><button className="btn" onClick={onClose}>닫기</button></>}>
      <div className="form-grid" style={{ alignItems: 'start' }}>
        {row('claude', 'Claude', 'console.anthropic.com', 'sk-ant-...')}
        {row('openai', 'OpenAI (GPT)', 'platform.openai.com', 'sk-...')}
        {row('gemini', 'Gemini', 'aistudio.google.com', 'AIza...')}
        <label>Ollama 주소</label>
        <div>
          <div className="row">
            <input style={{ flex: 1 }} placeholder="http://localhost:11434 (기본)" value={vals.ollama} onChange={(e) => setVals({ ...vals, ollama: e.target.value })} autoComplete="off" spellCheck={false} />
            {keys?.ollama === 'saved' && (
              <button className="btn small" onClick={() => remove('ollama')}>
                기본값으로
              </button>
            )}
          </div>
          <div className="unit">{keys?.ollama === 'saved' ? '직접 정한 주소 사용 중' : keys?.ollama === 'env' ? 'OLLAMA_HOST 환경 변수 사용 중' : '기본 주소 사용 중'} · 키가 필요 없는 로컬 모델 (ollama.com)</div>
        </div>
      </div>
      <p className="unit" style={{ marginTop: 12, lineHeight: 1.6 }}>
        키는 이 컴퓨터에만 운영체제 보안 저장소로 암호화해 보관하며, 각 회사의 API로만 전송됩니다. 비워 두면 기존 값을 그대로 둡니다.
        <br />
        Claude 는 키를 넣지 않아도, Anthropic CLI 로 로그인해 두었으면(터미널에서 ant auth login) 그 계정으로 씁니다. 키 없이 웹 계정(구독)으로 쓰려면 '계정 로그인' 방식을 고르세요.
        <br />
        AI에 보낸 문서 내용은 선택한 회사(Anthropic·OpenAI·Google)로 전송되니, 민감한 문서는 주의하세요. Ollama 는 문서가 이 컴퓨터(또는 지정한 서버) 밖으로 나가지 않습니다.
      </p>
    </Modal>
  );
}
