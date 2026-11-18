import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { loadConfigWithSource } from '@anthropic-ai/sdk/core/credentials';
import OpenAI from 'openai';
import { ApiError as GeminiApiError, GoogleGenAI } from '@google/genai';

/**
 * AI 채팅 (Claude / GPT / Gemini / Ollama). API 키는 메인 프로세스에만 두고
 * 운영체제 보안 저장소(safeStorage)로 암호화해 보관한다.
 * Ollama 는 이 컴퓨터(또는 사내 서버)에서 도는 로컬 모델이라 키 대신 서버 주소를 쓴다.
 */

export type Provider = 'claude' | 'openai' | 'gemini' | 'ollama';

export interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  id: string;
  provider: Provider;
  model: string;
  system: string;
  messages: ChatMsg[];
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export type ChatEvent =
  | { id: string; type: 'delta'; text: string }
  | { id: string; type: 'done'; model: string; note?: string }
  | { id: string; type: 'error'; message: string };

const ENV_KEYS: Record<Provider, string[]> = {
  claude: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  ollama: ['OLLAMA_HOST'],
};

// ---------------- API 키 ----------------
const keyFile = () => path.join(app.getPath('userData'), 'ai-keys.json');

function readStore(): Partial<Record<Provider, string>> {
  try {
    return JSON.parse(fs.readFileSync(keyFile(), 'utf8'));
  } catch {
    return {};
  }
}

function getKey(p: Provider): string | null {
  const enc = readStore()[p];
  if (enc) {
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(enc, 'base64')) : null;
    } catch {
      return null;
    }
  }
  for (const name of ENV_KEYS[p]) if (process.env[name]) return process.env[name]!;
  return null;
}

export type KeyState = 'saved' | 'env' | 'login' | 'none';

/**
 * Claude: API 키 없이 '로그인한 계정'으로 쓸 수 있는가. Anthropic CLI 로 로그인해 둔 프로필(`ant auth login`)이나
 * ANTHROPIC_AUTH_TOKEN 이 있으면 SDK 가 그 로그인 정보로 요청한다 (키를 넣지 않아도 된다)
 */
let claudeLogin = false;
export async function refreshClaudeLogin(): Promise<boolean> {
  try {
    claudeLogin = !!process.env.ANTHROPIC_AUTH_TOKEN || !!(await loadConfigWithSource());
  } catch {
    claudeLogin = false;
  }
  return claudeLogin;
}

export function keyStatus(): Record<Provider, KeyState> {
  const store = readStore();
  const out = {} as Record<Provider, KeyState>;
  for (const p of ['claude', 'openai', 'gemini', 'ollama'] as Provider[]) {
    out[p] = store[p] ? 'saved' : ENV_KEYS[p].some((n) => process.env[n]) ? 'env' : p === 'claude' && claudeLogin ? 'login' : 'none';
  }
  return out;
}

/** 지금 Claude 요청이 API 키가 아니라 로그인해 둔 계정으로 나가는가 (오류 안내를 그에 맞춘다) */
let claudeViaLogin = false;

/** Claude 클라이언트: 저장한 키(또는 환경 변수의 키)가 있으면 그것으로, 없으면 로그인해 둔 계정으로 */
async function claudeClient(): Promise<Anthropic> {
  const k = getKey('claude');
  claudeViaLogin = !k;
  if (k) return new Anthropic({ apiKey: k });
  // 키를 주지 않으면 SDK 가 로그인 정보(ANTHROPIC_AUTH_TOKEN, `ant auth login` 프로필)를 찾아 쓴다
  if (await refreshClaudeLogin()) return new Anthropic();
  throw new Error('Claude API 키가 없습니다. AI 도우미의 설정(⚙)에서 키를 넣거나, 터미널에서 `ant auth login` 으로 로그인해 두세요.');
}

export function setKey(p: Provider, key: string | null) {
  if (p === 'ollama' && key && key.trim()) key = normalizeOllamaUrl(key);
  const store = readStore();
  if (key && key.trim()) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('이 컴퓨터에서는 키를 안전하게 저장할 수 없습니다.');
    store[p] = safeStorage.encryptString(key.trim()).toString('base64');
  } else delete store[p];
  fs.mkdirSync(path.dirname(keyFile()), { recursive: true });
  fs.writeFileSync(keyFile(), JSON.stringify(store));
}

function requireKey(p: Provider): string {
  const k = getKey(p);
  if (!k) {
    const name = p === 'claude' ? 'Claude(Anthropic)' : p === 'openai' ? 'OpenAI' : 'Gemini(Google)';
    throw new Error(`${name} API 키가 없습니다. AI 도우미의 설정(⚙)에서 키를 입력하세요.`);
  }
  return k;
}

// ---------------- Ollama (로컬 모델) ----------------
export const OLLAMA_DEFAULT = 'http://localhost:11434';

/** 서버 주소 정리: http(s) 만, 경로·쿼리는 버린다 */
function normalizeOllamaUrl(raw: string): string {
  let v = raw.trim();
  if (!/^[a-z]+:\/\//i.test(v)) v = 'http://' + v;
  const u = new URL(v);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Ollama 주소는 http:// 또는 https:// 여야 합니다.');
  if (u.username || u.password) throw new Error('Ollama 주소에 사용자 이름·암호를 넣을 수 없습니다.');
  return `${u.protocol}//${u.host}`;
}

function ollamaBase(): string {
  const v = getKey('ollama');
  if (!v) return OLLAMA_DEFAULT;
  try {
    return normalizeOllamaUrl(v);
  } catch {
    return OLLAMA_DEFAULT;
  }
}

async function ollamaFetch(pathname: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
  const base = ollamaBase();
  let res: Response;
  try {
    res = await fetch(base + pathname, init);
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`Ollama 서버(${base})에 연결하지 못했습니다. Ollama 를 설치하고 실행했는지 확인하세요 (ollama.com).`);
  }
  if (!res.ok) {
    let msg = '';
    try {
      msg = ((await res.json()) as any)?.error || '';
    } catch {
      /* 무시 */
    }
    if (res.status === 404 && /model/i.test(msg)) throw new Error(`모델을 찾을 수 없습니다. 터미널에서 'ollama pull 모델이름' 으로 먼저 받으세요. (${msg})`);
    throw new Error(`Ollama 오류 (${res.status}): ${msg || res.statusText}`);
  }
  return res;
}

async function listOllamaModels(): Promise<{ id: string; label: string }[]> {
  const res = await ollamaFetch('/api/tags', { signal: AbortSignal.timeout(5000) });
  const j = (await res.json()) as { models?: { name: string; details?: { parameter_size?: string } }[] };
  const out = (j.models || []).map((m) => ({ id: m.name, label: m.details?.parameter_size ? `${m.name} (${m.details.parameter_size})` : m.name }));
  if (!out.length) throw new Error("Ollama 에 받아 둔 모델이 없습니다. 터미널에서 'ollama pull qwen3' 처럼 모델을 먼저 받으세요.");
  return out;
}

async function chatOllama(req: ChatRequest, emit: (e: ChatEvent) => void, signal: AbortSignal) {
  const res = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: req.model,
      stream: true,
      messages: [...(req.system ? [{ role: 'system', content: req.system }] : []), ...req.messages],
      // 생각하는 모델(qwen3 등)의 생각 글은 받지 않는다
      think: false,
    }),
    signal,
  });
  if (!res.body) throw new Error('Ollama 응답이 비어 있습니다.');
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let note: string | undefined;
  let model = req.model;
  const handle = (line: string) => {
    if (!line.trim()) return;
    const j = JSON.parse(line);
    if (j.error) throw new Error('Ollama 오류: ' + j.error);
    const t = j.message?.content;
    if (t) emit({ id: req.id, type: 'delta', text: t });
    if (j.done) {
      if (j.model) model = j.model;
      if (j.done_reason === 'length') note = '응답이 최대 길이에 도달해 잘렸습니다.';
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  handle(buf);
  emit({ id: req.id, type: 'done', model, note });
}

// ---------------- 모델 목록 ----------------
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-2', label: 'Claude Fable 5.2' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
];

export async function listModels(p: Provider): Promise<{ id: string; label: string }[]> {
  if (p === 'claude') return CLAUDE_MODELS;
  if (p === 'ollama') return listOllamaModels();
  if (p === 'openai') {
    const client = new OpenAI({ apiKey: requireKey('openai') });
    const out: { id: string; label: string }[] = [];
    for await (const m of client.models.list()) {
      // 대화용 모델만 (임베딩·음성·이미지 등 제외)
      if (/^(gpt-|o\d|chatgpt)/.test(m.id) && !/(embed|audio|realtime|tts|transcribe|image|search|moderation|instruct)/.test(m.id)) out.push({ id: m.id, label: m.id });
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }
  const ai = new GoogleGenAI({ apiKey: requireKey('gemini') });
  const out: { id: string; label: string }[] = [];
  const pager = await ai.models.list();
  for await (const m of pager) {
    if (!m.name || !(m.supportedActions || []).includes('generateContent')) continue;
    if (/(embedding|aqa|imagen|veo|tts|image)/.test(m.name)) continue;
    const id = m.name.replace(/^models\//, '');
    out.push({ id, label: m.displayName || id });
  }
  return out;
}

// ---------------- 채팅 ----------------
/** 서버 측 대체 모델(fallbacks: "default")을 지원하는 Claude 모델 */
const CLAUDE_FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5']);

async function chatClaude(req: ChatRequest, emit: (e: ChatEvent) => void, signal: AbortSignal) {
  const client = await claudeClient();
  const useFallback = CLAUDE_FALLBACK_MODELS.has(req.model);
  const stream = client.beta.messages.stream(
    {
      model: req.model,
      max_tokens: 64000,
      system: req.system,
      messages: req.messages,
      ...(req.effort ? { output_config: { effort: req.effort } } : {}),
      ...(useFallback ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    },
    { signal },
  );
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') emit({ id: req.id, type: 'delta', text: event.delta.text });
  }
  const final = await stream.finalMessage();
  if (final.stop_reason === 'refusal') {
    emit({ id: req.id, type: 'error', message: '모델이 이 요청에 응답하지 않았습니다(안전 정책). 질문을 바꿔 다시 시도해 주세요.' });
    return;
  }
  let note: string | undefined;
  if (final.stop_reason === 'max_tokens') note = '응답이 최대 길이에 도달해 잘렸습니다.';
  if (final.model !== req.model) note = `${final.model} 모델이 대신 응답했습니다.`;
  emit({ id: req.id, type: 'done', model: final.model, note });
}

async function chatOpenAI(req: ChatRequest, emit: (e: ChatEvent) => void, signal: AbortSignal) {
  const client = new OpenAI({ apiKey: requireKey('openai') });
  const stream = await client.responses.create(
    {
      model: req.model,
      instructions: req.system,
      input: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
    },
    { signal },
  );
  let note: string | undefined;
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') emit({ id: req.id, type: 'delta', text: event.delta });
    else if (event.type === 'response.incomplete') note = '응답이 완료되지 않았습니다(길이 제한 등).';
    else if (event.type === 'error') throw new Error(event.message);
    else if (event.type === 'response.failed') throw new Error(event.response.error?.message || 'OpenAI 응답 실패');
  }
  emit({ id: req.id, type: 'done', model: req.model, note });
}

async function chatGemini(req: ChatRequest, emit: (e: ChatEvent) => void, signal: AbortSignal) {
  const ai = new GoogleGenAI({ apiKey: requireKey('gemini') });
  const stream = await ai.models.generateContentStream({
    model: req.model,
    contents: req.messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    config: { systemInstruction: req.system, abortSignal: signal },
  });
  let note: string | undefined;
  for await (const chunk of stream) {
    const t = chunk.text;
    if (t) emit({ id: req.id, type: 'delta', text: t });
    const reason = chunk.candidates?.[0]?.finishReason;
    if (reason && reason !== 'STOP') note = `응답이 중단되었습니다 (${reason}).`;
  }
  emit({ id: req.id, type: 'done', model: req.model, note });
}

function friendlyError(p: Provider, e: any): string {
  if (e?.name === 'AbortError' || e instanceof Anthropic.APIUserAbortError) return '중지했습니다.';
  if (p === 'claude') {
    if (e instanceof Anthropic.AuthenticationError) return claudeViaLogin ? 'Claude 로그인 정보가 만료되었거나 올바르지 않습니다. 터미널에서 `ant auth login` 으로 다시 로그인하거나, 설정(⚙)에서 API 키를 넣으세요.' : 'Claude API 키가 올바르지 않습니다.';
    if (e instanceof Anthropic.PermissionDeniedError) return '이 Claude 모델을 사용할 권한이 없습니다.';
    if (e instanceof Anthropic.NotFoundError) return '모델을 찾을 수 없습니다. 모델 이름을 확인하세요.';
    if (e instanceof Anthropic.RateLimitError) return '요청이 너무 많습니다. 잠시 후 다시 시도하세요.';
    if (e instanceof Anthropic.BadRequestError) return '요청 오류: ' + e.message;
    if (e instanceof Anthropic.APIConnectionError) return '인터넷 연결을 확인하세요.';
    if (e instanceof Anthropic.APIError) return `Claude 오류 (${e.status}): ${e.message}`;
    // 로그인해 둔 계정으로 보내려다 로그인 정보를 읽지 못했다 (만료, 파일 권한 등: SDK 가 알려 준 까닭을 덧붙인다)
    if (claudeViaLogin) return `Claude 로그인 정보를 쓸 수 없습니다. 터미널에서 \`ant auth login\` 으로 다시 로그인하거나, 설정(⚙)에서 API 키를 넣으세요. (${String(e?.message || e).slice(0, 300)})`;
  }
  if (p === 'openai') {
    if (e instanceof OpenAI.AuthenticationError) return 'OpenAI API 키가 올바르지 않습니다.';
    if (e instanceof OpenAI.NotFoundError) return '모델을 찾을 수 없습니다. 모델 이름을 확인하세요.';
    if (e instanceof OpenAI.RateLimitError) return '요청이 너무 많거나 사용 한도를 넘었습니다.';
    if (e instanceof OpenAI.APIConnectionError) return '인터넷 연결을 확인하세요.';
    if (e instanceof OpenAI.APIError) return `OpenAI 오류 (${e.status}): ${e.message}`;
  }
  if (p === 'gemini' && e instanceof GeminiApiError) {
    const raw = String(e.message || '');
    if (/API key not valid|API_KEY_INVALID/i.test(raw)) return 'Gemini API 키가 올바르지 않습니다.';
    if (e.status === 404) return '모델을 찾을 수 없습니다. 모델 이름을 확인하세요.';
    if (e.status === 429) return '요청이 너무 많거나 사용 한도를 넘었습니다.';
    if (e.status === 403) return '이 Gemini 모델을 사용할 권한이 없습니다.';
    const m = /"message":\s*"([^"]+)"/.exec(raw);
    return `Gemini 오류 (${e.status}): ${m ? m[1] : raw.slice(0, 200)}`;
  }
  return String(e?.message || e);
}

const running = new Map<string, AbortController>();

export async function startChat(req: ChatRequest, emit: (e: ChatEvent) => void) {
  const ctrl = new AbortController();
  running.set(req.id, ctrl);
  try {
    if (req.provider === 'claude') await chatClaude(req, emit, ctrl.signal);
    else if (req.provider === 'openai') await chatOpenAI(req, emit, ctrl.signal);
    else if (req.provider === 'ollama') await chatOllama(req, emit, ctrl.signal);
    else await chatGemini(req, emit, ctrl.signal);
  } catch (e: any) {
    emit({ id: req.id, type: 'error', message: friendlyError(req.provider, e) });
  } finally {
    running.delete(req.id);
  }
}

export function abortChat(id: string) {
  running.get(id)?.abort();
}
