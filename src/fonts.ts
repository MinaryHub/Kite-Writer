/** 기본 제공 글꼴 목록 (시스템 글꼴 목록을 얻지 못한 경우에도 사용) */
export const KOREAN_FONTS = [
  '함초롬바탕',
  '함초롬돋움',
  '한컴바탕',
  '한컴돋움',
  '맑은 고딕',
  '바탕',
  '바탕체',
  '돋움',
  '돋움체',
  '굴림',
  '굴림체',
  '궁서',
  '궁서체',
  '나눔고딕',
  '나눔명조',
  '나눔바른고딕',
  '나눔스퀘어',
  '휴먼명조',
  '휴먼고딕',
  'HY헤드라인M',
  'HY견고딕',
  'HY중고딕',
  'HY신명조',
  'HY견명조',
  '한양신명조',
  '한양중고딕',
  'Noto Sans KR',
  'Noto Serif KR',
  '본고딕',
  '본명조',
];

export const LATIN_FONTS = [
  'Arial',
  'Times New Roman',
  'Calibri',
  'Cambria',
  'Segoe UI',
  'Verdana',
  'Tahoma',
  'Georgia',
  'Consolas',
  'Courier New',
  'D2Coding',
];

export const FONT_SIZES = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 54, 60, 72];

const SERIF_RE = /바탕|명조|궁서|신명|Batang|Myeongjo|Gungsuh|serif|Times|Georgia|Cambria|Garamond|Mincho|Song|Ming|윤명조|한양신|본명조/i;

const SANS_RE = /고딕|돋움|굴림|헤드라인|그래픽|Gothic|Dotum|Gulim|Sans|Arial|Helvetica|Verdana|Tahoma|Segoe|Calibri|Malgun|맑은|나눔스퀘어|Pretendard|Noto Sans|Roboto|Inter/i;

/** 시스템에 설치된 글꼴 이름 (앱이 시작할 때 채워진다; 비어 있으면 모름). 글꼴 목록 UI 용 —
 * 한글이 자기 폴더 글꼴을 세션에 등록해 두면 여기 이름이 있어도 브라우저(DirectWrite)는 그리지 못하므로 사용 가능 여부는 fontUsable 로 본다 */
export const installedFonts = new Set<string>();

const usableCache = new Map<string, boolean>();
let probeCtx: CanvasRenderingContext2D | null | undefined;

/** 이 이름의 글꼴로 실제로 글자를 그릴 수 있는가 (대체 글꼴과 폭이 다르면 있는 것으로 본다) */
export function fontUsable(name: string): boolean {
  if (typeof document === 'undefined') return true;
  const n = name.trim();
  if (!n) return false;
  const hit = usableCache.get(n);
  if (hit != null) return hit;
  if (probeCtx === undefined) probeCtx = document.createElement('canvas').getContext('2d');
  if (!probeCtx) return true;
  const ctx = probeCtx;
  const text = '가나다ABCxyz·123';
  const w = (f: string) => {
    ctx.font = `24px ${f}`;
    return ctx.measureText(text).width;
  };
  const q = `'${n.replace(/['"\\]/g, '')}'`;
  const ok = w(`${q}, monospace`) !== w('monospace') || w(`${q}, serif`) !== w('serif');
  usableCache.set(n, ok);
  return ok;
}

/** 글꼴을 새로 올렸을 때 (FontFace) */
function markUsable(name: string) {
  usableCache.set(name.trim(), true);
}

/** 한컴오피스 폴더에만 있는 글꼴 이름 → 그 글꼴 파일의 이름들 (앱이 시작할 때 채워진다) */
export const privateFontNames = new Map<string, string[]>();
const privateLoaded = new Set<string>();

/** 문서의 글꼴 이름 → 같은 글꼴의 다른 이름들 (옛 한양시스템 이름, 한글이 쓰는 HY 이름, 윈도우에 영문으로 설치된 이름) */
const FONT_ALIASES: Record<string, string[]> = {
  한양중고딕: ['HY중고딕', 'HYGothic-Medium'],
  한양견고딕: ['HY견고딕', 'HYGothic-Extra'],
  한양신명조: ['HY신명조', 'HYSinMyeongJo-Medium'],
  한양견명조: ['HY견명조', 'HYMyeongJo-Extra'],
  한양그래픽: ['HY그래픽', 'HYGraphic-Medium'],
  한양궁서: ['HY궁서', 'HYGungSo-Bold'],
  한양목판: ['HY목판L', 'HYPMokGak-Bold'],
  한양엽서: ['HY엽서M', 'HYPost-Medium'],
  한양얕은샘물: ['HY얕은샘물M', 'HYShortSamul-Medium'],
  '#신명조': ['HY신명조', 'HYSinMyeongJo-Medium'],
  '#중고딕': ['HY중고딕', 'HYGothic-Medium'],
  '#견고딕': ['HY견고딕', 'HYGothic-Extra'],
  '#견명조': ['HY견명조', 'HYMyeongJo-Extra'],
  '#헤드라인': ['HY헤드라인M', 'HYHeadLine-Medium'],
  '#궁서': ['HY궁서', 'HYGungSo-Bold'],
  HY헤드라인M: ['HYHeadLine-Medium'],
  HY중고딕: ['HYGothic-Medium'],
  HY견고딕: ['HYGothic-Extra'],
  HY신명조: ['HYSinMyeongJo-Medium'],
  HY견명조: ['HYMyeongJo-Extra'],
  HY그래픽: ['HYGraphic-Medium'],
  HY궁서: ['HYGungSo-Bold'],
  HY울릉도M: ['HYwulM'],
  HY엽서M: ['HYPost-Medium'],
  HY엽서L: ['HYPost-Light'],
  // 한컴 자체 형식(HFT) 영문 글꼴이라 브라우저가 못 쓰는 것: 글자 폭이 같은 계열로 (한글에서 잰 폭이 Palatino 와 같다)
  'HCI Poppy': ['Palatino Linotype', 'Book Antiqua', 'Palatino'],
};

/** 한컴 폴더에서 올릴 수 있는 글꼴이면 그 파일의 이름(별칭 포함) */
export function privateFontFor(name: string): string | null {
  const n = name.trim();
  if (privateFontNames.has(n)) return n;
  for (const a of FONT_ALIASES[n] || []) if (privateFontNames.has(a)) return a;
  return null;
}

/** 문서의 글꼴이 이 컴퓨터에 없어(별칭·한컴 폴더·PDF 글꼴로도) 대체 글꼴로 그려지는가 */
export function fontMissing(name: string): boolean {
  const n = name.trim();
  if (!n) return false;
  return !fontUsable(n) && !usableAlias(n) && !embeddedAliases.has(n);
}

/** 그 이름으로는 못 그리지만 다른 이름으로 설치되어 있으면 그 이름 */
function usableAlias(name: string): string | null {
  for (const a of FONT_ALIASES[name.trim()] || []) if (fontUsable(a)) return a;
  return null;
}

/**
 * 문서가 쓰는 글꼴 가운데 시스템에는 없지만 한컴오피스 폴더에 있는 것을 FontFace 로 올린다.
 * (HY헤드라인M, 한컴 윤고딕 등은 한글이 자기 폴더에만 설치하므로 브라우저는 모른다)
 * 올라오면 document.fonts 의 loadingdone 으로 쪽 나누기가 다시 돈다.
 */
/** 자가 점검용 기록 (어떤 글꼴을 요청했고 무엇이 올라왔는지) */
export const privateFontLog: { requested: string[]; loaded: string[]; failed: string[]; known: number; seen: string[] } = { requested: [], loaded: [], failed: [], known: 0, seen: [] };
if (typeof window !== 'undefined') (window as any).__kiteFontLog = privateFontLog;

export async function ensurePrivateFonts(names: Iterable<string>, read: (name: string) => Promise<{ names: string[]; data: Uint8Array } | null>): Promise<void> {
  const jobs: Promise<void>[] = [];
  privateFontLog.known = privateFontNames.size;
  for (const raw of names) {
    const name = raw.trim();
    if (!name) continue;
    privateFontLog.seen.push(`${name}${fontUsable(name) ? '(사용가능)' : ''}${privateLoaded.has(name) ? '(이미)' : ''}${privateFontFor(name) ? '(한컴:' + privateFontFor(name) + ')' : ''}`);
    if (privateLoaded.has(name) || fontUsable(name) || usableAlias(name)) continue;
    const source = privateFontFor(name);
    if (!source) continue;
    privateLoaded.add(name);
    privateFontLog.requested.push(name);
    jobs.push(
      (async () => {
        try {
          const f = await read(source);
          if (!f) return;
          const buf = f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength) as ArrayBuffer;
          // 파일에 적힌 이름이 여럿이면(한국어·영어) 각각 등록해 어느 이름으로 참조해도 맞게 한다
          const aliases = new Set<string>([name, ...f.names]);
          for (const alias of aliases) {
            if (alias !== name && fontUsable(alias)) continue;
            const face = new FontFace(alias, buf);
            await face.load();
            document.fonts.add(face);
            privateLoaded.add(alias);
            markUsable(alias);
            privateFontLog.loaded.push(alias);
          }
        } catch (e) {
          privateFontLog.failed.push(`${name}: ${String((e as any)?.message || e)}`);
          console.warn('글꼴을 올리지 못했습니다:', name, e);
        }
      })(),
    );
  }
  await Promise.all(jobs);
}

/** 문서 JSON 에서 쓰인 글꼴 이름들 */
export function collectFontNames(doc: any): Set<string> {
  const out = new Set<string>();
  const walk = (n: any) => {
    if (!n || typeof n !== 'object') return;
    for (const m of n.marks || []) {
      if (m?.type !== 'textStyle') continue;
      if (typeof m.attrs?.fontFamily === 'string') out.add(m.attrs.fontFamily.split(',')[0].replace(/['"]/g, '').trim());
      const lf = m.attrs?.langFonts;
      if (lf && typeof lf === 'object') for (const v of Object.values(lf)) if (typeof v === 'string' && v.trim()) out.add(v.trim());
    }
    for (const c of n.content || []) walk(c);
  };
  walk(doc);
  return out;
}

/** PDF 에서 꺼내 올린 글꼴 이름들 (시스템에 없어서 PDF 안의 글꼴로 대신 그리는 것) */
export const embeddedFamilies = new Set<string>();
/** 시스템에도 있는 글꼴의 PDF 판: 글꼴 이름 → 별칭 (PDF 에 든 글자는 이것으로, 나머지는 시스템 글꼴로 그린다) */
export const embeddedAliases = new Map<string, string>();

/**
 * PDF 에 들어 있던 글꼴(일부 글자만 담긴 것)을 그 글꼴 이름으로 올린다.
 * unicode-range 를 담긴 글자로 한정하므로, 담기지 않은 글자는 원래처럼 대체 글꼴로 그려진다.
 */
export async function registerEmbeddedFont(family: string, data: Uint8Array, opts: { weight: string; style: string; unicodeRange: string; alias?: boolean }): Promise<boolean> {
  if (typeof FontFace === 'undefined' || typeof document === 'undefined') return false;
  // 항상 따로 된 이름으로 올린다. 원래 이름(예: 맑은 고딕)으로 올리면 화면 글꼴과 다른 문서까지 PDF 의 일부 글자(굵은 판 등)로 그려진다.
  // 이 이름은 그 PDF 문서를 보고 있을 때만 CSS 변수(pdfFontVar)로 글꼴 목록 앞에 끼워진다.
  const name = family.trim() + ' kite-pdf';
  try {
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    // 위아래 높이를 모든 PDF 글꼴에 같게: 글꼴이 섞인 줄이 줄 간격보다 높아지지 않게 한다
    // (88/12 는 PDF 배치 코드가 가정하는 기준선 위치와 같다)
    const face = new FontFace(name, buf, {
      weight: opts.weight,
      style: opts.style,
      unicodeRange: opts.unicodeRange,
      display: 'block',
      ascentOverride: '88%',
      descentOverride: '12%',
      lineGapOverride: '0%',
    } as FontFaceDescriptors);
    await face.load();
    document.fonts.add(face);
    embeddedAliases.set(family.trim(), name);
    if (!opts.alias) embeddedFamilies.add(family.trim());
    return true;
  } catch (e) {
    console.warn('PDF 글꼴을 올리지 못했습니다:', family, e);
    return false;
  }
}

const pdfFaceKeys = new Set<string>();
/** 문서에 담긴 PDF 글꼴을 (아직 안 올렸으면) 올린다 — 자동 저장에서 복구한 문서 등 */
export async function registerPdfFonts(list: { family: string; alias?: boolean; weight: string; style: string; unicodeRange: string; data: string }[] | undefined): Promise<void> {
  if (!Array.isArray(list) || typeof atob === 'undefined') return;
  const jobs: Promise<unknown>[] = [];
  for (const f of list.slice(0, 200)) {
    if (!f || typeof f.family !== 'string' || typeof f.data !== 'string' || typeof f.unicodeRange !== 'string') continue;
    const key = `${f.family}|${f.weight}|${f.style}|${f.alias ? 1 : 0}|${f.data.length}|${f.data.slice(0, 64)}|${f.data.slice(-64)}`;
    if (pdfFaceKeys.has(key)) continue;
    pdfFaceKeys.add(key);
    try {
      const bin = atob(f.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      jobs.push(registerEmbeddedFont(f.family, bytes, { weight: /^(400|700)$/.test(f.weight) ? f.weight : '400', style: f.style === 'italic' ? 'italic' : 'normal', unicodeRange: f.unicodeRange, alias: !!f.alias }));
    } catch {
      /* 깨진 글꼴은 건너뛴다 */
    }
  }
  await Promise.all(jobs);
}

/** base64 (큰 배열도 되도록 나눠서) */
export function bytesToBase64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

/** 이름만으로 굵은 제목용 글꼴임을 알 수 있는 것들 (설치되어 있지 않으면 대체 글꼴을 굵게 보여 준다) */
const HEAVY_RE = /헤드라인|견고딕|견명조|태고딕|태명조|굵은|Headline|Black|Heavy|ExtraBold|Bold|\bB$/i;

/** 설치되지 않은 제목용 글꼴이면 굵게 */
export function fontWeightFallback(name: string): string | null {
  if (!HEAVY_RE.test(name)) return null;
  const n = name.trim();
  if (embeddedFamilies.has(n)) return null;
  if (fontUsable(n) || usableAlias(n)) return null;
  // 한컴 폴더에서 실제 글꼴을 올릴 수 있으면 굵기를 흉내 내지 않는다
  if (privateFontFor(n)) return null;
  return '700';
}

/** PDF 글꼴을 켜는 CSS 변수 이름 (글꼴 이름마다 하나) */
export function pdfFontVar(family: string): string {
  let h = 2166136261;
  for (let i = 0; i < family.length; i++) h = Math.imul(h ^ family.charCodeAt(i), 16777619);
  return '--kpf-' + (h >>> 0).toString(36);
}

let pdfVarsOn: string[] = [];
/** 지금 보고 있는 문서의 PDF 글꼴만 켠다 (다른 문서·화면 글자에는 쓰이지 않게) */
export function applyPdfFontVars(families: string[]) {
  if (typeof document === 'undefined') return;
  const root = document.documentElement.style;
  for (const v of pdfVarsOn) root.removeProperty(v);
  pdfVarsOn = [];
  for (const f of new Set(families.map((x) => x.trim()))) {
    const name = embeddedAliases.get(f);
    if (!name) continue;
    const v = pdfFontVar(f);
    root.setProperty(v, `'${name.replace(/['"\\]/g, '')}'`);
    pdfVarsOn.push(v);
  }
}

/** 설치되지 않은 글꼴을 위한 대체 글꼴 목록 (한글처럼 명조/고딕 계열 유지) */
export function fontStack(name: string, opts: { canvas?: boolean } = {}): string {
  // 문서에서 온 글꼴 이름이므로 CSS 구문을 바꿀 수 있는 문자는 모두 제거
  const safe = name.replace(/[\u0000-\u001f\u007f'"\\;:{}()<>@[\]]/g, '').trim().slice(0, 80) || '함초롬바탕';
  // 그 이름으로는 못 그리지만 다른 이름(영문 이름·HY 이름)으로 설치되어 있으면 그 이름을 먼저 둔다
  const alias = fontUsable(safe) ? null : usableAlias(safe);
  // PDF 판(같은 글꼴의 일부 글자)은 앞에 둔다: PDF 와 같은 글리프·높이로 그리고, 없는 글자는 시스템 글꼴로.
  // 그 PDF 문서를 보고 있을 때만 값이 들어가는 CSS 변수라, 다른 문서나 화면 글자에는 끼어들지 않는다.
  // (글꼴을 나중에 올려도 다시 그리지 않고 바로 쓰이도록 변수는 늘 넣어 둔다)
  // 캔버스(글자 폭 재기)는 CSS 변수를 풀지 못하므로 PDF 글꼴 이름을 바로 쓴다
  const direct = embeddedAliases.get(safe);
  const pdfAlias = opts.canvas ? (direct ? `'${direct.replace(/['"\\]/g, '')}', ` : '') : `var(${pdfFontVar(safe)}, kite-none), `;
  const q = pdfAlias + (alias ? `'${alias}', '${safe}'` : `'${safe}'`);
  if (/D2Coding|Consolas|Courier|Mono|코딩/i.test(name)) return `${q}, D2Coding, Consolas, monospace`;
  // kite-sym: 가운뎃점(·) 등 몇몇 기호만 맡는 글꼴(editor.css 의 @font-face, unicode-range).
  // 휴먼명조·HY 계열 글꼴은 이 기호를 전각으로 그리지만 한글은 기호 글꼴로 반각으로 보여 주므로 그에 맞춘다.
  // 한글은 설치되지 않은 글꼴을 기본 글꼴(함초롬바탕)로 보여 준다. 이름이 분명히 고딕 계열일 때만 고딕으로 대신한다
  // macOS: 일반 serif/sans-serif 는 'Apple SD Gothic Neo' 로 풀리는데 그 글꼴의 한글 폭은 0.865em 이라
  // 한글 글꼴(모두 1em)보다 좁아 줄 바꿈이 달라진다. 한글 폭이 1em 에 가깝고 계열이 맞는 나눔·애플 글꼴을 앞에 둔다
  return SANS_RE.test(name) && !SERIF_RE.test(name)
    ? `'kite-sym', ${q}, '함초롬돋움', 'HCR Dotum', '맑은 고딕', 'Malgun Gothic', 'NanumGothic', 'AppleGothic', sans-serif, 'Segoe UI Symbol', Wingdings`
    : `'kite-sym', ${q}, '함초롬바탕', 'HCR Batang', '휴먼명조', '바탕', Batang, 'NanumMyeongjo', 'AppleMyungjo', serif, 'Segoe UI Symbol', Wingdings`;
}

export function cssFontFamily(name: string): string {
  return fontStack(name);
}
