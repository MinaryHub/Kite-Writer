/**
 * 한글(HWP) 수식 문법 ↔ LaTeX 변환 (자주 쓰는 범위).
 * 예: "{a+b} over 2" ↔ "\frac{a+b}{2}", "sum from {i=1} to n x_i" ↔ "\sum_{i=1}^{n} x_i"
 */

const GREEK = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'omicron', 'pi', 'rho', 'sigma', 'tau', 'upsilon', 'phi', 'chi', 'psi', 'omega'];
// KaTeX 에 대문자 명령이 있는 것 (나머지 대문자는 로마자와 모양이 같다)
const GREEK_UPPER: Record<string, string> = { GAMMA: '\\Gamma', DELTA: '\\Delta', THETA: '\\Theta', LAMBDA: '\\Lambda', XI: '\\Xi', PI: '\\Pi', SIGMA: '\\Sigma', UPSILON: '\\Upsilon', PHI: '\\Phi', PSI: '\\Psi', OMEGA: '\\Omega' };
const GREEK_UPPER_LATIN: Record<string, string> = { ALPHA: 'A', BETA: 'B', EPSILON: 'E', ZETA: 'Z', ETA: 'H', IOTA: 'I', KAPPA: 'K', MU: 'M', NU: 'N', OMICRON: 'O', RHO: 'P', TAU: 'T', CHI: 'X' };

/** 대소문자 가리지 않는 낱말 → LaTeX */
const WORDS: Record<string, string> = {
  times: '\\times', cdot: '\\cdot', div: '\\div', pm: '\\pm', mp: '\\mp', inf: '\\infty', infty: '\\infty', infinity: '\\infty',
  leq: '\\leq', le: '\\leq', geq: '\\geq', ge: '\\geq', neq: '\\neq', ne: '\\neq', approx: '\\approx', sim: '\\sim', simeq: '\\simeq', equiv: '\\equiv', cong: '\\cong', propto: '\\propto',
  partial: '\\partial', nabla: '\\nabla', therefore: '\\therefore', because: '\\because', deg: '^{\\circ}', prime: "'", angle: '\\angle', triangle: '\\triangle', perp: '\\perp', bot: '\\bot',
  in: '\\in', notin: '\\notin', owns: '\\ni', subset: '\\subset', supset: '\\supset', subseteq: '\\subseteq', supseteq: '\\supseteq', cup: '\\cup', cap: '\\cap', emptyset: '\\emptyset',
  forall: '\\forall', exist: '\\exists', exists: '\\exists', neg: '\\neg', vee: '\\vee', wedge: '\\wedge', larrow: '\\leftarrow', rarrow: '\\rightarrow', lrarrow: '\\leftrightarrow', uparrow: '\\uparrow', downarrow: '\\downarrow',
  dots: '\\cdots', cdots: '\\cdots', ldots: '\\ldots', vdots: '\\vdots', ddots: '\\ddots', hbar: '\\hbar', ell: '\\ell', aleph: '\\aleph', circ: '\\circ', bullet: '\\bullet', star: '\\star', oplus: '\\oplus', otimes: '\\otimes',
};
const FUNCS = new Set(['sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'log', 'ln', 'lg', 'exp', 'max', 'min', 'det', 'gcd', 'mod', 'arg', 'dim', 'ker', 'sup', 'inf']);
const BIG: Record<string, string> = { smallsum: '\\sum', smallprod: '\\prod', smallint: '\\int', smalloint: '\\oint', sum: '\\sum', prod: '\\prod', coprod: '\\coprod', int: '\\int', dint: '\\iint', tint: '\\iiint', oint: '\\oint', union: '\\bigcup', inter: '\\bigcap', bigcup: '\\bigcup', bigcap: '\\bigcap', lim: '\\lim', liminf: '\\liminf', limsup: '\\limsup' };
const ACCENT: Record<string, string> = { vec: '\\vec', bar: '\\overline', hat: '\\hat', dot: '\\dot', ddot: '\\ddot', tilde: '\\tilde', under: '\\underline', overline: '\\overline', check: '\\check', acute: '\\acute', grave: '\\grave', dyad: '\\overleftrightarrow', arch: '\\overgroup' };
const FONT: Record<string, string> = { rm: '\\mathrm', it: '\\mathit', bold: '\\mathbf' };
const MATRIX: Record<string, [string, string]> = { matrix: ['matrix', ''], pmatrix: ['pmatrix', ''], bmatrix: ['bmatrix', ''], dmatrix: ['vmatrix', ''], cases: ['cases', ''] };
const OPS: Record<string, string> = { '<=': '\\leq', '>=': '\\geq', '!=': '\\neq', '->': '\\rightarrow', '<-': '\\leftarrow', '<->': '\\leftrightarrow', '=>': '\\Rightarrow', '<=>': '\\Leftrightarrow', '+-': '\\pm', '-+': '\\mp', '==': '\\equiv', '<<': '\\ll', '>>': '\\gg', '...': '\\cdots' };

type Tok = { t: 'word' | 'num' | 'sym' | 'str'; v: string };

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      const e = j < 0 ? s.length : j;
      out.push({ t: 'str', v: s.slice(i + 1, e) });
      i = e + 1;
      continue;
    }
    const w = /^[A-Za-z]+/.exec(s.slice(i));
    if (w) {
      out.push({ t: 'word', v: w[0] });
      i += w[0].length;
      continue;
    }
    const n = /^\d+(?:\.\d+)?/.exec(s.slice(i));
    if (n) {
      out.push({ t: 'num', v: n[0] });
      i += n[0].length;
      continue;
    }
    const op = ['<=>', '<->', '...', '<=', '>=', '!=', '->', '<-', '=>', '+-', '-+', '==', '<<', '>>'].find((o) => s.startsWith(o, i));
    if (op) {
      out.push({ t: 'sym', v: op });
      i += op.length;
      continue;
    }
    out.push({ t: 'sym', v: c });
    i++;
  }
  return out;
}

/** 한글 수식 → LaTeX */
export function hwpToLatex(script: string): string {
  const toks = tokenize(script || '');
  let p = 0;
  const peek = () => toks[p];
  const isWord = (k: string) => peek()?.t === 'word' && peek()!.v.toLowerCase() === k;

  const seq = (stop: (t: Tok) => boolean): string => {
    const items: string[] = [];
    while (p < toks.length && !stop(toks[p])) {
      if (isWord('over')) {
        p++;
        const num = items.pop() ?? '';
        const den = postfix(atom());
        items.push(`\\frac{${strip(num)}}{${strip(den)}}`);
        continue;
      }
      if (isWord('atop')) {
        p++;
        const num = items.pop() ?? '';
        items.push(`{${strip(num)} \\atop ${strip(postfix(atom()))}}`);
        continue;
      }
      items.push(postfix(atom()));
    }
    return items.join(' ').replace(/\s+/g, ' ').trim();
  };
  const strip = (s: string) => (s.startsWith('{') && s.endsWith('}') && balanced(s.slice(1, -1)) ? s.slice(1, -1) : s);
  const group = (s: string) => `{${strip(s)}}`;

  const postfix = (base: string): string => {
    for (;;) {
      const t = peek();
      if (!t) return base;
      if ((t.t === 'sym' && t.v === '^') || isWord('sup')) {
        p++;
        base += '^' + group(atom());
      } else if ((t.t === 'sym' && t.v === '_') || isWord('sub')) {
        p++;
        base += '_' + group(atom());
      } else return base;
    }
  };

  const atom = (): string => {
    const t = toks[p++];
    if (!t) return '';
    if (t.t === 'num') return t.v;
    if (t.t === 'str') return `\\text{${t.v.replace(/[{}\\]/g, '')}}`;
    if (t.t === 'sym') {
      if (t.v === '{') {
        const inner = seq((x) => x.t === 'sym' && x.v === '}');
        if (peek()?.v === '}') p++;
        return `{${inner}}`;
      }
      if (t.v === '}') return '';
      if (t.v === '~') return '\\ ';
      if (t.v === '`') return '\\,';
      if (t.v === '#') return '\\\\';
      if (OPS[t.v]) return OPS[t.v];
      if ('%$'.includes(t.v)) return '\\' + t.v;
      if (t.v === '\\') return '\\backslash';
      return t.v;
    }
    // 낱말
    const raw = t.v;
    const w = raw.toLowerCase();
    if (w === 'sqrt') return `\\sqrt{${strip(postfixless())}}`;
    if (w === 'root') {
      const n = atom();
      if (isWord('of')) p++;
      return `\\sqrt[${strip(n)}]{${strip(atom())}}`;
    }
    if (BIG[w]) {
      let s = BIG[w];
      if (isWord('from')) {
        p++;
        s += '_' + group(atom());
      }
      if (isWord('to')) {
        p++;
        s += '^' + group(atom());
      }
      return s;
    }
    if (MATRIX[w]) {
      if (peek()?.v === '{') {
        p++;
        const inner = seq((x) => x.t === 'sym' && x.v === '}');
        if (peek()?.v === '}') p++;
        return `\\begin{${MATRIX[w][0]}}${inner}\\end{${MATRIX[w][0]}}`;
      }
      return '';
    }
    if (w === 'left' || w === 'right') {
      const d = toks[p];
      if (!d) return '';
      p++;
      let v = d.v;
      if (d.t === 'word') {
        const lw = d.v.toLowerCase();
        v = ['lceil', 'rceil', 'lfloor', 'rfloor', 'langle', 'rangle', 'vert'].includes(lw) ? '\\' + lw : '.';
      } else if (v === '{' || v === '}') v = '\\' + v;
      else if (v === '<') v = '\\langle';
      else if (v === '>') v = '\\rangle';
      return `\\${w}${v} `;
    }
    if (ACCENT[w]) return `${ACCENT[w]}{${strip(atom())}}`;
    if (FONT[w]) return `${FONT[w]}{${strip(atom())}}`;
    if (GREEK_UPPER[raw]) return GREEK_UPPER[raw];
    if (GREEK_UPPER_LATIN[raw]) return GREEK_UPPER_LATIN[raw];
    if (GREEK.includes(raw)) return '\\' + raw;
    if (GREEK.includes(w) && raw[0] === raw[0].toUpperCase()) return GREEK_UPPER[raw.toUpperCase()] || GREEK_UPPER_LATIN[raw.toUpperCase()] || '\\' + w;
    if (WORDS[w]) return WORDS[w];
    if (FUNCS.has(w)) return '\\' + w;
    if (w === 'from' || w === 'to' || w === 'of') return '';
    return raw;
  };
  // sqrt 다음 덩어리 (첨자는 sqrt 밖에 붙는다)
  const postfixless = () => atom();

  const out = seq(() => false);
  return out;
}

function balanced(s: string): boolean {
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === '{') d++;
    else if (s[i] === '}' && --d < 0) return false;
  }
  return d === 0;
}

// ---------------- LaTeX → 한글 수식 ----------------
const REV_WORDS: Record<string, string> = {};
for (const [k, v] of Object.entries(WORDS)) if (!(v in REV_WORDS)) REV_WORDS[v] = k;
Object.assign(REV_WORDS, { '\\pm': '+-', '\\mp': '-+', '\\le': '<=', '\\leq': '<=', '\\ge': '>=', '\\geq': '>=', '\\ne': '!=', '\\neq': '!=', '\\to': '->', '\\rightarrow': '->', '\\leftarrow': '<-', '\\Rightarrow': '=>', '\\Leftrightarrow': '<=>', '\\infty': 'inf', '\\exists': 'exist', '\\cdots': 'cdots', '\\ldots': 'ldots' });
const REV_BIG: Record<string, string> = Object.fromEntries(Object.entries(BIG).filter(([k]) => !k.startsWith('small')).map(([k, v]) => [v, k]));
const REV_ACCENT: Record<string, string> = { '\\vec': 'vec', '\\overline': 'bar', '\\bar': 'bar', '\\hat': 'hat', '\\widehat': 'hat', '\\dot': 'dot', '\\ddot': 'ddot', '\\tilde': 'tilde', '\\widetilde': 'tilde', '\\underline': 'under', '\\check': 'check', '\\acute': 'acute', '\\grave': 'grave' };
const REV_FONT: Record<string, string> = { '\\mathrm': 'rm', '\\text': '', '\\textrm': '', '\\mathit': 'it', '\\mathbf': 'bold', '\\textbf': 'bold', '\\boldsymbol': 'bold', '\\operatorname': 'rm' };
const REV_ENV: Record<string, string> = { matrix: 'matrix', pmatrix: 'pmatrix', bmatrix: 'bmatrix', vmatrix: 'dmatrix', Vmatrix: 'dmatrix', cases: 'cases', array: 'matrix', aligned: 'matrix' };

/** LaTeX → 한글 수식 */
export function latexToHwp(latex: string): string {
  const s = latex || '';
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const cmd = (): string => {
    const m = /^\\([A-Za-z]+|.)/.exec(s.slice(i));
    if (!m) return '';
    i += m[0].length;
    return '\\' + m[1];
  };
  /** 덩어리 하나: {…} 또는 글자/명령 하나 */
  const arg = (): string => {
    ws();
    if (s[i] === '{') {
      i++;
      const inner = seq('}');
      i++;
      return `{${inner}}`;
    }
    return one();
  };
  const optArg = (): string | null => {
    ws();
    if (s[i] !== '[') return null;
    const j = s.indexOf(']', i);
    const v = s.slice(i + 1, j < 0 ? s.length : j);
    i = j < 0 ? s.length : j + 1;
    return latexToHwp(v);
  };
  const one = (): string => {
    ws();
    const c = s[i];
    if (c == null) return '';
    if (c === '\\') {
      const k = cmd();
      if (k === '\\frac' || k === '\\dfrac' || k === '\\tfrac') {
        const a = arg();
        const b = arg();
        return `${a} over ${b}`;
      }
      if (k === '\\sqrt') {
        const n = optArg();
        const x = arg();
        return n ? `root {${n}} of ${x}` : `sqrt ${x}`;
      }
      if (REV_BIG[k]) return REV_BIG[k];
      if (REV_ACCENT[k]) return `${REV_ACCENT[k]} ${arg()}`;
      if (k in REV_FONT) {
        if (k === '\\text' || k === '\\textrm') {
          ws();
          if (s[i] === '{') {
            const j = s.indexOf('}', i);
            const v = s.slice(i + 1, j < 0 ? s.length : j);
            i = j < 0 ? s.length : j + 1;
            return `"${v}"`;
          }
        }
        return `${REV_FONT[k]} ${arg()}`.trim();
      }
      if (k === '\\left' || k === '\\right') {
        ws();
        let d = s[i] === '\\' ? cmd() : s[i++];
        if (d === '\\{' || d === '\\}') d = d[1];
        else if (d === '\\langle') d = '<';
        else if (d === '\\rangle') d = '>';
        else if (d === '.') d = '';
        else if (d.startsWith('\\')) d = d.slice(1);
        return `${k === '\\left' ? 'LEFT' : 'RIGHT'} ${d}`;
      }
      if (k === '\\begin') {
        const env = /^\{([A-Za-z*]+)\}/.exec(s.slice(i));
        if (env) {
          i += env[0].length;
          if (env[1] === 'array') optArg(), arg();
          const end = `\\end{${env[1]}}`;
          const j = s.indexOf(end, i);
          const body = s.slice(i, j < 0 ? s.length : j);
          i = j < 0 ? s.length : j + end.length;
          const rows = body.split(/\\\\/).map((r) => r.split('&').map((c) => latexToHwp(c)).join(' & '));
          return `${REV_ENV[env[1].replace('*', '')] || 'matrix'}{${rows.join(' # ')}}`;
        }
        return '';
      }
      if (k === '\\\\') return '#';
      if (k === '\\,' || k === '\;' || k === '\\:') return '`';
      if (k === '\\ ' || k === '\\quad' || k === '\\qquad') return '~';
      if (k === '\\{' || k === '\\}' || k === '\\%' || k === '\\$' || k === '\\&' || k === '\\#') return k[1];
      if (REV_WORDS[k]) return REV_WORDS[k];
      const name = k.slice(1);
      if (GREEK.includes(name)) return name;
      if (GREEK.includes(name.toLowerCase())) return name.toUpperCase();
      if (FUNCS.has(name)) return name;
      return name;
    }
    if (c === '{') return arg();
    // 이어진 로마자·숫자는 한 낱말로 (dx, 4ac)
    const run = /^(?:[A-Za-z]+|\d+(?:\.\d+)?)/.exec(s.slice(i));
    if (run) {
      i += run[0].length;
      return run[0];
    }
    if (c === '^' || c === '_') {
      i++;
      return `${c}${arg()}`;
    }
    i++;
    return c;
  };
  const seq = (end?: string): string => {
    const parts: string[] = [];
    for (;;) {
      ws();
      if (i >= s.length || (end && s[i] === end)) break;
      const before = i;
      let piece = one();
      // \sum_{a}^{b} → sum from {a} to {b}
      if (/^(sum|prod|coprod|int|dint|tint|oint|union|inter|lim|liminf|limsup)$/.test(piece)) {
        let from = '';
        let to = '';
        for (let k = 0; k < 2; k++) {
          ws();
          if (s[i] === '_') (i++, (from = arg()));
          else if (s[i] === '^') (i++, (to = arg()));
        }
        if (from) piece += ` from ${from}`;
        if (to) piece += ` to ${to}`;
      }
      parts.push(piece);
      if (i === before) i++;
    }
    return parts
      .join(' ')
      .replace(/\s+([\^_])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
  };
  return seq();
}
