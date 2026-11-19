/**
 * VML(예전 Word 의 그리기 개체: w:pict 안의 v:shape·v:rect·v:line …)을 읽는 도우미.
 * 모양(style)·길이 단위·색·경로(path)를 푼다. 문서에서 온 값이므로 범위를 넘는 값은 줄인다.
 */
import { attr, kid, localName } from '../common';

const fin = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : 0);

/** style 속성 → 이름별 값 */
export function vmlStyle(el: Element | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (attr(el, 'style') || '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0) out.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
  }
  return out;
}

/** 길이 (pt·in·cm·mm·px·pc, 단위 없으면 화소) → px */
export function vmlLen(v: string | null | undefined, dflt = 0): number {
  if (v == null) return dflt;
  const m = /^(-?\d*\.?\d+(?:e-?\d+)?)\s*(pt|in|cm|mm|px|pc|em)?$/i.exec(v.trim());
  if (!m) return dflt;
  const n = parseFloat(m[1]);
  const k = ({ pt: 96 / 72, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, px: 1, pc: 16, em: 16 } as Record<string, number>)[(m[2] || 'px').toLowerCase()] ?? 1;
  return fin(n * k, -1e5, 1e5);
}

const NAMED: Record<string, string> = {
  black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', lime: '00FF00', blue: '0000FF', yellow: 'FFFF00', aqua: '00FFFF', cyan: '00FFFF',
  fuchsia: 'FF00FF', magenta: 'FF00FF', gray: '808080', grey: '808080', silver: 'C0C0C0', maroon: '800000', olive: '808000', navy: '000080',
  purple: '800080', teal: '008080', orange: 'FFA500', window: 'FFFFFF', windowtext: '000000', buttonface: 'F0F0F0',
};

/** VML 색 ("#rrggbb", "#rgb", 이름, 뒤에 붙은 "[색 번호]") → #RRGGBB (아니면 null) */
export function vmlColor(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim().split(/\s|\[/)[0].toLowerCase();
  let m = /^#?([0-9a-f]{6})$/.exec(s);
  if (m) return '#' + m[1].toUpperCase();
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) return '#' + m[1].split('').map((c) => c + c).join('').toUpperCase();
  if (NAMED[s]) return '#' + NAMED[s];
  return null;
}

/** "f"·"false"·"0" 은 끔 */
export const vmlOff = (v: string | null | undefined) => v != null && /^(f|false|0|off)$/i.test(v.trim());

/** coordsize·coordorigin ("w,h") */
export function vmlPair(v: string | null | undefined, d: [number, number]): [number, number] {
  if (!v) return d;
  const [a, b] = v.split(',').map((x) => parseFloat(x));
  return [Number.isFinite(a) ? a : d[0], Number.isFinite(b) ? b : d[1]];
}

/**
 * VML 경로(path: m·l·c·x·e 와 그 상대판 t·r·v) → 점 목록들 (좌표계 단위). 곡선은 짧은 선분으로 편다.
 * 호(ar·at·wa·wr)·qx·qy 처럼 다루지 않는 명령이 나오면 그 경로는 그만 읽는다
 */
export function vmlPath(path: string): { p: number[]; z: boolean }[] {
  const out: { p: number[]; z: boolean }[] = [];
  // 수식(@n)을 쓰는 경로는 풀 수 없다
  if (path.includes('@')) return out;
  // 비운 값은 0: "m,l,21600r21600,l21600,xe" → m0,0 l0,21600 r21600,0 l21600,0 x e
  const norm = path
    .replace(/([a-z])\s*,/gi, '$1 0,')
    .replace(/,\s*(?=,)/g, ',0')
    .replace(/,\s*(?=[a-z]|$)/gi, ',0 ');
  // 붙어 있는 명령 글자는 나눈다 ("xe" → x, e)
  const tok: string[] = [];
  for (const t of norm.match(/[a-z]+|-?\d*\.?\d+/gi) || []) {
    if (/^[a-z]+$/i.test(t)) tok.push(...(t.toLowerCase().match(/nf|ns|ae|al|at|ar|wa|wr|qx|qy|qb|h[a-j]|[a-z]/g) || []));
    else tok.push(t);
  }
  let i = 0;
  let cmd = '';
  let cur: [number, number] = [0, 0];
  let pts: number[] = [];
  const flush = (z: boolean) => {
    if (pts.length >= 4) out.push({ p: pts, z });
    pts = [];
  };
  const num = () => {
    const v = parseFloat(tok[i] || '');
    i++;
    return Number.isFinite(v) ? v : 0;
  };
  const isNum = (t: string | undefined) => t != null && /^-?\d*\.?\d+$/.test(t);
  let guard = 0;
  while (i < tok.length && guard++ < 100000) {
    if (!isNum(tok[i])) {
      cmd = tok[i++].toLowerCase();
      if (cmd === 'x') {
        flush(true);
        continue;
      }
      if (cmd === 'e') {
        flush(false);
        continue;
      }
      if (cmd === 'nf' || cmd === 'ns') continue;
      if (!['m', 'l', 'c', 't', 'r', 'v'].includes(cmd)) break;
      if (!isNum(tok[i])) continue;
    }
    if (cmd === 'm' || cmd === 't') {
      flush(false);
      const x = num();
      const y = num();
      cur = cmd === 't' ? [cur[0] + x, cur[1] + y] : [x, y];
      pts = [cur[0], cur[1]];
    } else if (cmd === 'l' || cmd === 'r') {
      const x = num();
      const y = num();
      cur = cmd === 'r' ? [cur[0] + x, cur[1] + y] : [x, y];
      pts.push(cur[0], cur[1]);
    } else if (cmd === 'c' || cmd === 'v') {
      const rel = cmd === 'v';
      const c = [num(), num(), num(), num(), num(), num()];
      const [x0, y0] = cur;
      const P = rel ? c.map((v, k) => v + (k % 2 ? y0 : x0)) : c;
      for (let s = 1; s <= 10; s++) {
        const t = s / 10;
        const u = 1 - t;
        pts.push(u * u * u * x0 + 3 * u * u * t * P[0] + 3 * u * t * t * P[2] + t * t * t * P[4], u * u * u * y0 + 3 * u * u * t * P[1] + 3 * u * t * t * P[3] + t * t * t * P[5]);
      }
      cur = [P[4], P[5]];
    } else i++;
  }
  flush(false);
  return out;
}

/** 화살표 (v:stroke 의 startarrow·endarrow) → 도형 화살표 이름 */
export function vmlArrow(v: string | null | undefined): string | null {
  const s = (v || '').toLowerCase();
  if (!s || s === 'none') return null;
  if (s === 'classic' || s === 'open' || s === 'block') return 'ARROW';
  if (s === 'diamond') return 'DIAMOND';
  if (s === 'oval') return 'CIRCLE';
  return 'ARROW';
}

/** v:stroke 의 dashstyle → 도형 선 종류 */
export function vmlDash(v: string | null | undefined): string | null {
  const s = (v || '').toLowerCase();
  if (!s || s === 'solid') return null;
  if (/dashdotdot/.test(s)) return 'DASH_DOT_DOT';
  if (/dashdot/.test(s)) return 'DASH_DOT';
  if (/longdash/.test(s)) return 'LONG_DASH';
  if (/dash/.test(s)) return 'DASH';
  if (/dot/.test(s)) return 'DOT';
  return null;
}

/** VML 개체 요소인가 (v:shapetype 은 모양 틀일 뿐) */
export const isVmlShape = (el: Element) => ['shape', 'rect', 'roundrect', 'oval', 'line', 'polyline', 'group', 'image'].includes(localName(el)) && el.namespaceURI === 'urn:schemas-microsoft-com:vml';

/** w10:wrap 의 배치 (없으면 null) */
export function vmlWrap(el: Element): string | null {
  const w = kid(el, 'wrap');
  return w ? attr(w, 'type') || 'square' : null;
}
