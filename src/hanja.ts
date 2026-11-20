/**
 * 한자 변환 사전 (libhangul 의 한자 사전에서 만든 src/data/hanja/*.txt). 처음 쓸 때만 불러온다 (낱말 사전이 커서)
 */
export interface HanjaItem {
  /** 한자 (낱말이면 여러 글자) */
  h: string;
  /** 뜻 (글자 하나일 때: '옳을 가') */
  m?: string;
}

export interface HanjaDict {
  chars: Map<string, HanjaItem[]>;
  words: Map<string, string[]>;
  /** 한자 한 글자 → 읽기 (그 한자가 가장 앞 차례로 나오는 읽기) */
  reading: Map<string, string>;
}

let loading: Promise<HanjaDict> | null = null;

export function parseHanja(charsTxt: string, wordsTxt: string): HanjaDict {
  const chars = new Map<string, HanjaItem[]>();
  const reading = new Map<string, string>();
  const rank = new Map<string, number>();
  for (const line of charsTxt.split('\n')) {
    const t = line.indexOf('\t');
    if (t < 1) continue;
    const r = line.slice(0, t);
    const items: HanjaItem[] = [];
    line
      .slice(t + 1)
      .split('|')
      .forEach((e, i) => {
        const [h] = Array.from(e);
        if (!h) return;
        const m = e.slice(h.length).trim();
        items.push(m ? { h, m } : { h });
        // 같은 한자의 읽기가 여럿이면(樂: 락·낙·악·요) 그 읽기 목록에서 더 앞에 나오는 것
        if (!rank.has(h) || i < rank.get(h)!) {
          rank.set(h, i);
          reading.set(h, r);
        }
      });
    chars.set(r, items);
  }
  const words = new Map<string, string[]>();
  for (const line of wordsTxt.split('\n')) {
    const t = line.indexOf('\t');
    if (t < 1) continue;
    const r = line.slice(0, t);
    const n = Array.from(r).length;
    const cps = Array.from(line.slice(t + 1));
    const list: string[] = [];
    for (let i = 0; i + n <= cps.length; i += n) list.push(cps.slice(i, i + n).join(''));
    words.set(r, list);
  }
  return { chars, words, reading };
}

export function loadHanja(): Promise<HanjaDict> {
  if (!loading) {
    loading = Promise.all([import('./data/hanja/chars.txt?raw'), import('./data/hanja/words.txt?raw')]).then(([c, w]) => parseHanja(c.default, w.default));
    loading.catch(() => (loading = null));
  }
  return loading;
}

const HANGUL = /^[가-힣]+$/;
export const isHangulWord = (s: string) => HANGUL.test(s);
const HAN_CHAR = /[㐀-䶿一-鿿豈-﫿\u{20000}-\u{2fa1f}]/u;
export const hasHanja = (s: string) => HAN_CHAR.test(s);

/** 낱말(2~4글자) 또는 글자 하나의 후보 */
export function candidates(d: HanjaDict, reading: string): HanjaItem[] {
  if (Array.from(reading).length === 1) return d.chars.get(reading) || [];
  return (d.words.get(reading) || []).map((h) => ({ h }));
}

/**
 * 커서 앞 글(한글만 이어진 끝부분)에서 사전에 있는 가장 긴 낱말(4~2글자)을, 없으면 마지막 한 글자를 고른다.
 * 돌려주는 길이는 글자 수 (끝에서부터)
 */
export function wordBeforeCursor(d: HanjaDict, before: string): string | null {
  const m = /[가-힣]+$/.exec(before);
  if (!m) return null;
  const run = Array.from(m[0]);
  for (let n = Math.min(4, run.length); n >= 2; n--) {
    const w = run.slice(run.length - n).join('');
    if (d.words.has(w)) return w;
  }
  const last = run[run.length - 1];
  return d.chars.has(last) ? last : null;
}

/** 한자를 한글 읽기로 (모르는 한자는 그대로) */
export function hanjaToHangul(d: HanjaDict, s: string): string {
  return Array.from(s)
    .map((c) => d.reading.get(c) || c)
    .join('');
}

export type HanjaFormat = 'hanja' | 'hanjaHangul' | 'hangulHanja';
/** 넣는 꼴: 漢字 / 漢字(한자) / 한자(漢字) */
export function formatHanja(fmt: HanjaFormat, hanja: string, hangul: string): string {
  if (fmt === 'hanjaHangul') return `${hanja}(${hangul})`;
  if (fmt === 'hangulHanja') return `${hangul}(${hanja})`;
  return hanja;
}
