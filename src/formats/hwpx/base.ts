/**
 * 원본 보존형 저장 — HWPX (formats/hwpBase.ts):
 *  - 원본 머리부(header.xml)의 정의 목록을 원문 그대로 나눠 둔다 (저장할 때 앞에 그대로 두고 Kite 의 정의를 뒤에 붙인다)
 *  - 문단 안 차례(글 길이·탭·개체·컨트롤): 읽을 때와 저장할 때 같아야 원본 줄 정보를 쓸 수 있다
 */

/** 한글의 글자 셈: 문단 안 차례와 글자 수 */
export interface ParaShape {
  /** 전체 글자 수 (한글 셈: 글자 1, 탭 8, 개체 8, 컨트롤 안 요소마다 8) */
  total: number;
  /** 첫 글자(글·탭) 앞의 컨트롤·개체 묶음의 몫 (구역 정의·단 정의·머리말·쪽 번호·문단 앞 개체 등). 원본과 달라도 된다 */
  lead: number;
  /** 그 뒤의 차례: 글 길이(t), 탭(T), 글 사이 컨트롤·개체 묶음의 몫(x) (예: 't25|x8|t10|T|t3') */
  shape: string;
}

/** hp:t 안에서 글자 하나로 세는 요소 (탭은 따로) */
const ONE = new Set(['lineBreak', 'nbSpace', 'fwSpace', 'hyphen']);
const ZERO = new Set(['markpenBegin', 'markpenEnd']);

class ShapeAcc {
  tokens: string[] = [];
  widths: number[] = [];
  text = 0;
  flush() {
    if (this.text > 0) {
      this.tokens.push('t' + this.text);
      this.widths.push(this.text);
    }
    this.text = 0;
  }
  add(tok: string, w: number) {
    this.flush();
    this.tokens.push(tok);
    this.widths.push(w);
  }
  done(): ParaShape {
    this.flush();
    const total = this.widths.reduce((a, b) => a + b, 0);
    const isText = (t: string) => t[0] === 't' || t === 'T';
    // 첫 글자 앞의 컨트롤·개체 묶음: 몫만 (Kite 가 쓰는 앞쪽 컨트롤 수가 원본과 달라도 그만큼 줄 첫 자리를 옮기면 된다)
    let i = 0;
    let lead = 0;
    while (i < this.tokens.length && !isText(this.tokens[i])) lead += this.widths[i++];
    // 그 뒤: 이어진 컨트롤·개체는 몫만 (그 사이 차례가 바뀌어도 뒤 글자들의 줄 첫 자리는 같다)
    const out: string[] = [];
    let x = 0;
    for (; i < this.tokens.length; i++) {
      const t = this.tokens[i];
      if (isText(t)) {
        if (x) out.push('x' + x);
        x = 0;
        out.push(t);
      } else x += this.widths[i];
    }
    if (x) out.push('x' + x);
    return { total, lead, shape: out.join('|') };
  }
}

const unescLen = (s: string) => s.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, 'x').length;

/** 저장기가 만든 문단 XML(<hp:p>…</hp:p>)의 차례·글자 수. 안쪽 표·글상자의 문단은 세지 않는다 */
export function paraShapeXml(xml: string): ParaShape {
  const acc = new ShapeAcc();
  const re = /<(\/?)hp:([A-Za-z0-9]+)\b([^>]*?)(\/?)>|<[^>]*>|([^<]+)/g;
  // 쌓인 hp 요소: [이름, 그 요소에서 센 바로 아래 요소 수]
  const stack: { name: string; kids: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, close, name, , selfClose, text] = m;
    const d = stack.length;
    if (text != null) {
      // 글: 뿌리 문단의 run 아래 hp:t 바로 안의 글만
      if (d === 3 && stack[2].name === 't' && stack[1].name === 'run') acc.text += unescLen(text);
      continue;
    }
    if (name == null) continue;
    if (close) {
      const top = stack.pop();
      if (!top) break;
      // run 아래 요소가 닫힘: ctrl 은 안의 요소 수만큼
      if (stack.length === 2 && stack[1].name === 'run') {
        if (top.name === 'ctrl') acc.add('c' + top.kids, 8 * top.kids);
      }
      if (!stack.length) break;
      continue;
    }
    // 여는 태그
    if (d === 2 && stack[1].name === 'run') {
      // run 바로 아래 요소
      if (name === 't') {
        if (!selfClose) stack.push({ name, kids: 0 });
        continue;
      }
      if (name === 'ctrl') {
        if (selfClose) acc.add('c0', 0);
        else stack.push({ name, kids: 0 });
        continue;
      }
      if (name === 'secPr') acc.add('c1', 8);
      else acc.add('o', 8);
      if (!selfClose) stack.push({ name, kids: 0 });
      continue;
    }
    if (d === 3 && stack[2].name === 'ctrl' && stack[1].name === 'run') stack[2].kids++;
    if (d === 3 && stack[2].name === 't' && stack[1].name === 'run') {
      // hp:t 안의 요소
      if (name === 'tab') acc.add('T', 8);
      else if (ONE.has(name)) acc.text += 1;
      else if (!ZERO.has(name) && !selfClose) {
        // 그 밖의 요소: 안의 글자 수 (끝 태그까지)
        const end = xml.indexOf(`</hp:${name}>`, re.lastIndex);
        if (end >= 0) {
          acc.text += unescLen(xml.slice(re.lastIndex, end).replace(/<[^>]*>/g, ''));
          re.lastIndex = end + name.length + 6;
        }
      }
      continue;
    }
    if (!selfClose) stack.push({ name, kids: 0 });
  }
  return acc.done();
}

/** 읽은 문단(hp:p 요소)의 차례·글자 수 — paraShapeXml 과 같은 셈 (리더의 LineTrack 과도 같다) */
export function paraShapeEl(p: Element): ParaShape {
  const acc = new ShapeAcc();
  const ln = (e: Element) => e.localName || e.nodeName.replace(/^.*:/, '');
  for (let r = p.firstElementChild; r; r = r.nextElementSibling) {
    if (ln(r) !== 'run') continue;
    for (let c = r.firstElementChild; c; c = c.nextElementSibling) {
      const name = ln(c);
      if (name === 't') {
        for (let n = c.firstChild; n; n = n.nextSibling) {
          if (n.nodeType === 3 || n.nodeType === 4) acc.text += (n.nodeValue || '').length;
          else if (n.nodeType === 1) {
            const en = ln(n as Element);
            if (en === 'tab') acc.add('T', 8);
            else if (ONE.has(en)) acc.text += 1;
            else if (!ZERO.has(en)) acc.text += (n.textContent || '').length;
          }
        }
      } else if (name === 'ctrl') {
        let k = 0;
        for (let x = c.firstElementChild; x; x = x.nextElementSibling) k++;
        acc.add('c' + k, 8 * k);
      } else if (name === 'secPr') acc.add('c1', 8);
      else acc.add('o', 8);
    }
  }
  return acc.done();
}

/** 원본 머리부의 정의 목록 (원문 그대로) */
export interface HwpxHeaderBase {
  /** 원본 머리부의 판 (hh:head 의 version) */
  headVersion?: string;
  /** 언어별 글꼴 (HANGUL, LATIN, HANJA, JAPANESE, OTHER, SYMBOL, USER 차례): 이름과 원문 */
  fonts: { names: string[]; raw: string[] }[];
  borderFills: string[];
  charPrs: string[];
  tabPrs: string[];
  numberings: string[];
  bullets: string[];
  paraPrs: string[];
  /** 문단 모양마다 문단 머리 종류 (NONE, OUTLINE, NUMBER, BULLET) */
  paraHeading: string[];
  styles: string[];
  styleNames: string[];
  memoPrs: string[];
  /** hh:beginNum (원문) */
  beginNum: string | null;
  /** refList 뒤의 요소들 (호환 설정·문서 설정 등, 원문) */
  tail: string;
  /** 정의 번호의 다음 값: Kite 의 정의는 이 번호부터 붙인다 */
  next: { borderFill: number; charPr: number; paraPr: number; tabPr: number; numbering: number; bullet: number; style: number; memoPr: number };
}

const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];

/** 묶음 요소 안의 항목들 (원문). 항목 이름의 요소가 같은 이름을 품지 않는다고 본다 */
function items(xml: string, container: string, item: string): string[] {
  const open = new RegExp(`<hh:${container}\\b[^>]*?(/?)>`).exec(xml);
  if (!open || open[1]) return [];
  const start = open.index + open[0].length;
  const end = xml.indexOf(`</hh:${container}>`, start);
  if (end < 0) return [];
  const body = xml.slice(start, end);
  const out: string[] = [];
  const re = new RegExp(`<hh:${item}\\b[^>]*?(/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1]) {
      out.push(m[0]);
      continue;
    }
    const close = body.indexOf(`</hh:${item}>`, re.lastIndex);
    if (close < 0) break;
    out.push(body.slice(m.index, close + item.length + 6));
    re.lastIndex = close + item.length + 6;
  }
  return out;
}

const attrOf = (raw: string, name: string): string | null => new RegExp(`\\b${name}="([^"]*)"`).exec(raw)?.[1] ?? null;

/** 정의들의 다음 번호 (id 의 최댓값 + 1, 없으면 start) */
function nextId(list: string[], start: number): number {
  let n = start;
  for (const r of list) {
    const v = Number(attrOf(r, 'id'));
    if (Number.isFinite(v) && v + 1 > n) n = v + 1;
  }
  return n;
}

/** 원본 header.xml → 되살릴 정의 목록. 알아볼 수 없으면 null */
export function parseHwpxHeader(xml: string | null | undefined): HwpxHeaderBase | null {
  if (!xml || xml.length > 20_000_000 || !/<hh:refList\b/.test(xml)) return null;
  try {
    const fontfaces = items(xml, 'fontfaces', 'fontface');
    const fonts = LANGS.map((lang) => {
      const ff = fontfaces.find((f) => attrOf(f.slice(0, f.indexOf('>') + 1), 'lang') === lang) || '';
      const raw = ff ? items(ff.replace(/^<hh:fontface\b/, '<hh:fontfaceX').replace(/<\/hh:fontface>$/, '</hh:fontfaceX>'), 'fontfaceX', 'font') : [];
      return { names: raw.map((r) => attrOf(r, 'face') || ''), raw };
    });
    const borderFills = items(xml, 'borderFills', 'borderFill');
    const charPrs = items(xml, 'charProperties', 'charPr');
    const tabPrs = items(xml, 'tabProperties', 'tabPr');
    const numberings = items(xml, 'numberings', 'numbering');
    const bullets = items(xml, 'bullets', 'bullet');
    const paraPrs = items(xml, 'paraProperties', 'paraPr');
    const styles = items(xml, 'styles', 'style');
    const memoPrs = items(xml, 'memoProperties', 'memoPr');
    // 문단 모양 번호는 0 부터 차례대로여야 원본 번호를 그대로 쓸 수 있다
    const seq = (list: string[], from: number) => list.every((r, i) => Number(attrOf(r, 'id')) === i + from);
    if (!seq(paraPrs, 0) || !seq(charPrs, 0) || !seq(borderFills, 1) || !seq(styles, 0)) return null;
    const paraHeading = paraPrs.map((r) => attrOf(/<hh:heading\b[^>]*>/.exec(r)?.[0] || '', 'type') || 'NONE');
    const beginNum = /<hh:beginNum\b[^>]*\/>/.exec(xml)?.[0] || null;
    const tailStart = xml.indexOf('</hh:refList>');
    const tailEnd = xml.lastIndexOf('</hh:head>');
    const tail = tailStart >= 0 && tailEnd > tailStart ? xml.slice(tailStart + '</hh:refList>'.length, tailEnd) : '';
    return {
      headVersion: attrOf(/<hh:head\b[^>]*>/.exec(xml)?.[0] || '', 'version') || undefined,
      fonts,
      borderFills,
      charPrs,
      tabPrs,
      numberings,
      bullets,
      paraPrs,
      paraHeading,
      styles,
      styleNames: styles.map((r) => attrOf(r, 'name') || ''),
      memoPrs,
      beginNum,
      tail,
      next: {
        borderFill: nextId(borderFills, 1),
        charPr: nextId(charPrs, 0),
        paraPr: nextId(paraPrs, 0),
        tabPr: nextId(tabPrs, 0),
        numbering: nextId(numberings, 1),
        bullet: nextId(bullets, 1),
        style: nextId(styles, 0),
        memoPr: nextId(memoPrs, 1),
      },
    };
  } catch {
    return null;
  }
}

/** 원본 줄 정보 → hp:linesegarray */
export function segArrayXml(rows: number[][]): string {
  return (
    '<hp:linesegarray>' +
    rows
      .map(
        (r) =>
          `<hp:lineseg textpos="${r[0]}" vertpos="${r[1]}" vertsize="${r[2]}" textheight="${r[3]}" baseline="${r[4]}" spacing="${r[5]}" horzpos="${r[6]}" horzsize="${r[7]}" flags="${r[8] >>> 0}"/>`,
      )
      .join('') +
    '</hp:linesegarray>'
  );
}

/** HWPX 본문·머리부의 이름공간 선언 (Kite 가 쓰는 파일의 뿌리 요소에 붙인다) */
export const HWPX_NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

/** 접두사 → 이름공간 (Kite 가 선언하는 것) */
const OUR_NS = new Map([...HWPX_NS.matchAll(/xmlns:(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]] as [string, string]));

/** 원문 문단의 표시: s 구역 정의, h 머리말·꼬리말·쪽 번호·새 번호, c 단 정의 (쓸 수 있는 조건이 다르다) */
export interface RawPara {
  xml: string;
  flags: string;
}

const escText = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\t/g, '&#9;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;');

/**
 * 원본 보존형 저장: 본문 문단(hp:p) 원문. 고치지 않은 문단은 저장할 때 이 글을 그대로 쓴다.
 * 쓰지 못하는 문단은 null: 접두사가 Kite 가 선언하는 이름공간과 다르거나, 필드가 문단 밖으로 이어지는 문단
 * (짝이 되는 문단을 고치면 짝이 깨진다). rootNs: 원본 구역 파일의 뿌리 요소에 선언된 접두사 → 이름공간
 */
export function rawParaXml(p: Element, rootNs: Map<string, string>): RawPara | null {
  let out = '';
  let ok = true;
  const flags = new Set<string>();
  const fields = new Map<string, number>();
  const walk = (n: Node, local: Map<string, string>) => {
    if (!ok) return;
    if (n.nodeType === 3 || n.nodeType === 4) {
      out += escText(n.nodeValue || '');
      return;
    }
    if (n.nodeType !== 1) return;
    const e = n as Element;
    const name = e.nodeName;
    // 이 요소에서 선언한 이름공간 (원문 그대로 둔다)
    let scope = local;
    for (let i = 0; i < e.attributes.length; i++) {
      const a = e.attributes[i];
      if (a.name.startsWith('xmlns:')) {
        if (scope === local) scope = new Map(local);
        scope.set(a.name.slice(6), a.value);
      } else if (a.name === 'xmlns') ok = false;
    }
    // 접두사가 원본에서 가리키던 이름공간과 Kite 가 선언하는 이름공간이 같아야 한다 (접두사 없는 요소는 쓰지 않는다)
    const check = (qn: string, el: boolean) => {
      const k = qn.indexOf(':');
      if (k <= 0) {
        if (el) ok = false;
        return;
      }
      const pre = qn.slice(0, k);
      if (pre === 'xmlns' || pre === 'xml' || scope.has(pre)) return;
      if (OUR_NS.get(pre) == null || OUR_NS.get(pre) !== rootNs.get(pre)) ok = false;
    };
    check(name, true);
    const ln = name.slice(name.indexOf(':') + 1);
    if (ln === 'secPr') flags.add('s');
    else if (ln === 'header' || ln === 'footer' || ln === 'pageNum' || ln === 'newNum' || ln === 'pageNumCtrl') flags.add('h');
    else if (ln === 'colPr') flags.add('c');
    else if (ln === 'fieldBegin') {
      const id = e.getAttribute('fieldid') || e.getAttribute('id') || '';
      fields.set(id, (fields.get(id) || 0) + 1);
    } else if (ln === 'fieldEnd') {
      const id = e.getAttribute('fieldid') || e.getAttribute('beginIDRef') || '';
      fields.set(id, (fields.get(id) || 0) - 1);
    }
    out += '<' + name;
    for (let i = 0; i < e.attributes.length; i++) {
      const a = e.attributes[i];
      if (!a.name.startsWith('xmlns')) check(a.name, false);
      out += ` ${a.name}="${escAttr(a.value)}"`;
    }
    if (!e.firstChild) {
      out += '/>';
      return;
    }
    out += '>';
    for (let c: ChildNode | null = e.firstChild; c; c = c.nextSibling) walk(c, scope);
    out += '</' + name + '>';
  };
  walk(p, new Map());
  if (!ok) return null;
  for (const v of fields.values()) if (v !== 0) return null;
  return { xml: out, flags: [...flags].sort().join('') };
}

/** 원문 문단의 맨 끝 줄 정보(그 문단 자신의 hp:linesegarray)를 뺀다: 한글이 그 문단부터 다시 배치한다 */
export function dropOwnSegs(xml: string): string {
  const end = '</hp:linesegarray></hp:p>';
  if (!xml.endsWith(end)) return xml;
  const i = xml.lastIndexOf('<hp:linesegarray>');
  return i > 0 ? xml.slice(0, i) + '</hp:p>' : xml;
}
