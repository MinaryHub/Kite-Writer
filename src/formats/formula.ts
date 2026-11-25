/**
 * 표 계산식 (한글의 계산식 필드: HWPX fieldBegin type="FORMULA", HWP 필드 컨트롤 %fmu). 명령 글은
 *   "<계산식>??<결과 형식>;;<마지막 결과>"   예) "=SUM(LEFT)??%g,;;1,030.5"
 * 결과 형식은 printf 꼴에 천 단위 쉼표 표시(,)를 붙인 것: 합계는 "%g,", 평균은 "%.2f," (2026-11-25 한글 2018 의 쉬운 계산식으로 확인)
 *
 * 계산식: '=' 뒤에 사칙연산(+ - * /)·괄호·숫자·칸 주소(A1: 열 글자 + 줄 번호)·함수.
 * 함수의 인자는 식, 칸 범위(A1:B3), 방향(LEFT 왼쪽 칸들, RIGHT, ABOVE 위쪽 칸들, BELOW). 숫자가 아닌 칸은 건너뛴다.
 */

export interface Formula {
  formula: string;
  fmt: string;
}

/** 명령 글 → 계산식·결과 형식 */
export function parseFormulaCommand(cmd: unknown): Formula | null {
  if (typeof cmd !== 'string' || !cmd || cmd.length > 2000) return null;
  const q = cmd.indexOf('??');
  const formula = (q >= 0 ? cmd.slice(0, q) : cmd.split(';;')[0]).trim();
  if (!formula.startsWith('=')) return null;
  const rest = q >= 0 ? cmd.slice(q + 2) : '';
  const fmt = rest.split(';;')[0] || '%g,';
  return { formula, fmt };
}

/** 계산식 → 명령 글 (한글과 같은 꼴) */
export function formulaCommand(f: Formula, result: string): string {
  return `${f.formula}??${f.fmt};;${result}`;
}

/** 칸 글 → 숫자 (쉼표·빈칸·% 를 빼고). 숫자가 아니면 null */
export function cellNumber(text: string): number | null {
  const s = text.replace(/[\s,]/g, '').replace(/%$/, '');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}

/** 결과 형식대로 숫자를 글로 ("%g" 일반, "%.Nf" 소수 N 자리, "%d" 정수, 끝의 ',' 는 천 단위 쉼표) */
export function formatResult(v: number, fmt: string): string {
  if (!Number.isFinite(v)) return '?';
  const m = /^%(?:\.(\d+))?([gfd])(,)?/.exec(fmt || '%g,') || ['', undefined, 'g', ','];
  const comma = !!m[3];
  let s: string;
  if (m[2] === 'f') s = v.toFixed(Math.min(10, Number(m[1] ?? 6)));
  else if (m[2] === 'd') s = Math.round(v).toFixed(0);
  else s = String(parseFloat(v.toPrecision(12)));
  if (/e/i.test(s)) return s;
  if (!comma) return s;
  const neg = s.startsWith('-');
  const [int, frac] = (neg ? s.slice(1) : s).split('.');
  return (neg ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (frac != null ? '.' + frac : '');
}

/** 열 글자 → 0부터의 열 번호 (A=0, Z=25, AA=26) */
function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0부터의 열 번호 → 열 글자 */
export function colName(c: number): string {
  let s = '';
  let n = c + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** 칸 값 읽기: (줄, 열) → 칸 글 (표 밖이면 null) */
export type CellGetter = (r: number, c: number) => string | null;

type Tok = { t: 'num'; v: number } | { t: 'id'; v: string } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const num = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) {
      out.push({ t: 'num', v: Number(num[1]) });
      i += num[1].length;
      continue;
    }
    const id = /^[A-Za-z_?][A-Za-z0-9_?]*/.exec(src.slice(i));
    if (id) {
      out.push({ t: 'id', v: id[0].toUpperCase() });
      i += id[0].length;
      continue;
    }
    if ('+-*/(),:'.includes(ch)) {
      out.push({ t: 'op', v: ch });
      i++;
      continue;
    }
    return null;
  }
  return out.length > 500 ? null : out;
}

const FUNCS = new Set(['SUM', 'AVG', 'AVERAGE', 'PRODUCT', 'MIN', 'MAX', 'COUNT', 'ABS', 'INT', 'ROUND', 'SQRT', 'MOD']);
const DIRS = new Set(['LEFT', 'RIGHT', 'ABOVE', 'BELOW']);

/**
 * 계산식을 셈한다. at: 계산식이 든 칸의 (줄, 열), size: 표의 줄·열 수. 셈할 수 없으면(모르는 함수, 잘못된 꼴) null
 */
export function evaluateFormula(formula: string, at: { r: number; c: number }, size: { rows: number; cols: number }, get: CellGetter): number | null {
  const toks = tokenize(formula.replace(/^\s*=/, ''));
  if (!toks || !toks.length) return null;
  let p = 0;
  const peek = () => toks[p];
  const isOp = (v: string) => peek()?.t === 'op' && peek()!.v === v;
  const fail = (): never => {
    throw new Error('formula');
  };
  const numAt = (r: number, c: number): number | null => {
    if (r < 0 || c < 0 || r >= size.rows || c >= size.cols || (r === at.r && c === at.c)) return null;
    const t = get(r, c);
    return t == null ? null : cellNumber(t);
  };
  const cellRef = (id: string): { r: number; c: number } | null => {
    // '?' 는 계산식이 든 칸과 같은 열(또는 줄): '?11' 은 이 칸의 열 11번째 줄 (h1 의 '=SUM(?11:?12)')
    const m = /^([A-Z]{1,3}|\?)(\d{1,5}|\?)$/.exec(id);
    return m ? { r: m[2] === '?' ? at.r : Number(m[2]) - 1, c: m[1] === '?' ? at.c : colIndex(m[1]) } : null;
  };
  /** 함수 인자 하나 → 숫자 목록 (범위·방향은 여럿, 식은 하나) */
  const arg = (): number[] => {
    const t = peek();
    if (t?.t === 'id' && DIRS.has(t.v)) {
      p++;
      const out: number[] = [];
      const push = (r: number, c: number) => {
        const v = numAt(r, c);
        if (v != null) out.push(v);
      };
      if (t.v === 'LEFT') for (let c = 0; c < at.c; c++) push(at.r, c);
      else if (t.v === 'RIGHT') for (let c = at.c + 1; c < size.cols; c++) push(at.r, c);
      else if (t.v === 'ABOVE') for (let r = 0; r < at.r; r++) push(r, at.c);
      else for (let r = at.r + 1; r < size.rows; r++) push(r, at.c);
      return out;
    }
    if (t?.t === 'id' && cellRef(t.v) && toks[p + 1]?.t === 'op' && toks[p + 1].v === ':') {
      const a = cellRef(t.v)!;
      const bt = toks[p + 2];
      const b = bt?.t === 'id' ? cellRef(bt.v) : null;
      if (!b) fail();
      p += 3;
      const out: number[] = [];
      for (let r = Math.min(a.r, b!.r); r <= Math.max(a.r, b!.r); r++)
        for (let c = Math.min(a.c, b!.c); c <= Math.max(a.c, b!.c); c++) {
          const v = numAt(r, c);
          if (v != null) out.push(v);
        }
      return out;
    }
    return [expr()];
  };
  const call = (name: string): number => {
    if (!isOp('(')) fail();
    p++;
    const vals: number[] = [];
    if (!isOp(')'))
      for (;;) {
        vals.push(...arg());
        if (isOp(',')) {
          p++;
          continue;
        }
        break;
      }
    if (!isOp(')')) fail();
    p++;
    switch (name) {
      case 'SUM':
        return vals.reduce((a, b) => a + b, 0);
      case 'AVG':
      case 'AVERAGE':
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
      case 'PRODUCT':
        return vals.length ? vals.reduce((a, b) => a * b, 1) : 0;
      case 'MIN':
        return vals.length ? Math.min(...vals) : 0;
      case 'MAX':
        return vals.length ? Math.max(...vals) : 0;
      case 'COUNT':
        return vals.length;
      case 'ABS':
        return Math.abs(vals[0] ?? 0);
      case 'INT':
        return Math.trunc(vals[0] ?? 0);
      case 'SQRT':
        return Math.sqrt(vals[0] ?? 0);
      case 'MOD':
        return (vals[0] ?? 0) % (vals[1] || NaN);
      case 'ROUND': {
        const k = Math.max(0, Math.min(10, Math.trunc(vals[1] ?? 0)));
        return Math.round((vals[0] ?? 0) * 10 ** k) / 10 ** k;
      }
    }
    return fail();
  };
  const factor = (): number => {
    const t = peek();
    if (!t) return fail();
    if (t.t === 'num') {
      p++;
      return t.v;
    }
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
      p++;
      const v = factor();
      return t.v === '-' ? -v : v;
    }
    if (t.t === 'op' && t.v === '(') {
      p++;
      const v = expr();
      if (!isOp(')')) fail();
      p++;
      return v;
    }
    if (t.t === 'id') {
      p++;
      if (FUNCS.has(t.v)) return call(t.v);
      const ref = cellRef(t.v);
      if (ref) return numAt(ref.r, ref.c) ?? 0;
    }
    return fail();
  };
  const term = (): number => {
    let v = factor();
    while (isOp('*') || isOp('/')) {
      const op = peek()!.v;
      p++;
      const w = factor();
      v = op === '*' ? v * w : v / w;
    }
    return v;
  };
  function expr(): number {
    let v = term();
    while (isOp('+') || isOp('-')) {
      const op = peek()!.v;
      p++;
      const w = term();
      v = op === '+' ? v + w : v - w;
    }
    return v;
  }
  try {
    const v = expr();
    if (p !== toks.length) return null;
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

type JMarkLite = { type: string; attrs?: Record<string, any> };
type JNodeLite = { type: string; text?: string; marks?: JMarkLite[] };

/** 읽을 때: 계산식 필드 시작 뒤에 쌓인 글(결과 글)에 계산식 표시를 단다. parts: [글 목록, 시작 자리] */
export function applyFormula(parts: [JNodeLite[], number][], f: Formula | null) {
  if (!f) return;
  const attrs = { formula: f.formula.slice(0, 500), fmt: f.fmt.slice(0, 40) };
  for (const [inline, start] of parts)
    for (let k = Math.max(0, start); k < inline.length; k++) {
      const n = inline[k];
      if (n.type !== 'text' || !n.text) continue;
      n.marks = [...(n.marks || []).filter((m) => m.type !== 'formula'), { type: 'formula', attrs }];
    }
}
