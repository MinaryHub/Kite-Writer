import type { DocSettings } from '../types';
import type { JNode } from './common';

/**
 * 원본 보존형 저장 (HWP·HWPX 를 읽어 같은 형식으로 저장할 때).
 *
 * 한글 문서를 Kite 의 모형으로 읽으면 Kite 가 모르는 것(탭 정의·스타일·번호 정의·대체 글꼴·호환 설정·구역 정의의 세부)이 빠지고,
 * 다시 쓰면 한글이 다른 모양으로 그린다. 그래서 읽을 때 원본의 정의(머리부)와 문단마다의 원본 번호·줄 정보를 남겨 두고,
 * 저장할 때 원본 정의를 앞에 그대로 두고 Kite 가 새로 만든 정의만 뒤에 붙인다. 고치지 않은 문단은 원본 문단 모양·스타일 번호를
 * 다시 쓰고, 문서 앞에서부터 고치지 않은 블록까지는 원본 줄 정보(한글이 배치해 둔 줄)를 그대로 쓴다.
 *
 * 줄 정보: 한글은 문서에 저장된 줄 정보를 그대로 믿고 그린다 (글이 바뀌어도). 줄 정보가 없는 문단이 있으면 그 문단부터 끝까지
 * 다시 배치한다 (한글 2018 로 확인). 그래서 처음 고친 블록부터는 줄 정보를 쓰지 않는다.
 */
export interface HwpBase {
  /** 원본 형식: 같은 형식으로 저장할 때만 원본 정의를 쓴다 */
  fmt: 'hwpx' | 'hwp';
  /** HWPX: 원본 Contents/header.xml */
  header?: string;
  /** HWPX: 원본 첫 구역 정의 (hp:secPr 요소 그대로) */
  secPr?: string;
  /** HWP: 원본 DocInfo 스트림 (압축을 푼 것, base64) */
  docInfo?: string;
  /** HWP: 원본 첫 구역의 구역 정의 컨트롤 레코드들 (base64): 구역 정의(secd)와 그 아래 레코드 */
  secd?: string;
  /** 읽을 때의 쪽 설정 열쇠 (baseKey): 바뀌었으면 원본 구역 정의와 줄 정보를 쓰지 않는다 */
  key: string;
  /**
   * 원본 그림 이름(바이너리 항목 id) → 그 그림으로 만든 그림 값(src)의 지문 (digest).
   * 원본 머리부의 테두리/배경 정의는 그림을 이름으로 가리키므로, 저장할 때 같은 그림에 원본 이름을 다시 붙인다
   */
  bins?: Record<string, string>;
  /** HWP: 원본 그림 번호 → 확장자 */
  binExt?: Record<string, string>;
  /** HWP: 브라우저가 못 그리는 원본 그림(WMF·OLE 등)의 원본 바이트 (data URL). 고치지 않은 문단이 원본 번호로 가리킨다 */
  binRaw?: Record<string, string>;
  /** 읽을 때의 머리말·꼬리말·쪽 번호 열쇠 (hfKey): 같으면 그것들이 든 원문 문단을 그대로 쓴다 */
  hf?: string;
  /** 머리말·꼬리말·쪽 번호 컨트롤이 든 원문 문단 수 (저장할 때 모두 원문으로 쓸 수 있어야 Kite 가 새로 만들지 않는다) */
  hfGroups?: number;
  /**
   * HWPX: 원본 version.xml (원문). 한글은 그 파일의 판(xmlVersion)에 따라 배치 규칙을 달리한다
   * (1.2 문서를 1.4 로 적으면 번호 문단 등이 옆으로 옮겨진다: 2026-11-24 한글 2018 로 확인)
   */
  ver?: string;
  /** HWPX: 원본 settings.xml (원문). 인쇄 설정(모아 찍기 등)·확대 비율이 들어 있다 */
  appSet?: string;
}

/**
 * 원본 보존형 저장: 고치지 않은 본문 문단의 원문 (원본 문단 하나가 Kite 블록 여러 개로 온 것은 한 묶음: g 묶음 번호, i 차례, n 블록 수).
 * 원문과 표시(flags: s 구역 정의, h 머리말·꼬리말·쪽 번호, c 단 정의)는 첫 블록에만
 */
export interface RawRef {
  g: number;
  i: number;
  n: number;
  /** HWPX: 문단(hp:p) 원문 */
  xml?: string;
  /** HWP: 문단 레코드들의 원본 바이트 (base64) */
  bin?: string;
  flags?: string;
}

/** 원문 묶음 값 검사 */
export function rawRefOf(v: any): RawRef | null {
  if (!v || typeof v !== 'object' || !Number.isInteger(v.g) || !Number.isInteger(v.i) || !Number.isInteger(v.n) || v.i < 0 || v.n < 1 || v.i >= v.n) return null;
  if (v.i === 0) {
    const flags = typeof v.flags === 'string' ? v.flags : '';
    if (typeof v.xml === 'string' && v.xml.startsWith('<hp:p ') && v.xml.endsWith('</hp:p>')) return { g: v.g, i: 0, n: v.n, xml: v.xml, flags };
    if (typeof v.bin === 'string' && v.bin.length >= 8 && /^[A-Za-z0-9+/]+=*$/.test(v.bin)) return { g: v.g, i: 0, n: v.n, bin: v.bin, flags };
    return null;
  }
  return { g: v.g, i: v.i, n: v.n };
}

/** 원본 줄 정보 한 줄: [textpos, vertpos, vertsize, textheight, baseline, spacing, horzpos, horzsize, flags] (HWPUNIT, 한글 값 그대로) */
export type HwpSegRow = number[];

/** 값을 견줄 수 있게: 열쇠를 차례로 늘어놓고, 비어 있는 값(null·false·0·'')은 뺀다 */
function canon(v: unknown): string {
  if (v == null || v === false || v === 0 || v === '') return '';
  if (typeof v === 'number') return String(Math.round(v * 1000) / 1000);
  if (typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) {
    const c = canon(o[k]);
    if (c && c !== '{}' && c !== '[]') parts.push(JSON.stringify(k) + ':' + c);
  }
  return '{' + parts.join(',') + '}';
}

/**
 * 문단 모양 열쇠: 문단의 속성 가운데 모양에 드는 것 (한글 배치 정보 hwp*·차례 표시는 뺀다).
 * 읽을 때 적어 둔 열쇠와 저장할 때의 열쇠가 같으면 문단 모양을 고치지 않은 것이다
 */
export function paraSnap(attrs: Record<string, any> | null | undefined): string {
  if (!attrs) return '';
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(attrs)) {
    if (k.startsWith('hwp') || k === 'toc') continue;
    o[k] = attrs[k];
  }
  return canon(o);
}

/** 머리말·꼬리말·쪽 번호 열쇠 (짧은 지문: 머리말에 든 그림 값이 길 수 있다) */
export function hfKey(s: DocSettings): string {
  return digest(canon({ h: s.header, f: s.footer, n: s.pageNumber, x: s.hideFirst || null }));
}

/** 쪽 설정 열쇠: 용지·여백·쪽 테두리·감추기·시작 쪽 번호·줄 번호. 바뀌었으면 원본 구역 정의를 쓰지 않는다 */
export function baseKey(s: DocSettings): string {
  return canon({
    page: s.page,
    pageBorder: s.pageBorder || null,
    hideFirst: s.hideFirst || null,
    start: s.pageNumber?.start,
    lineNumbers: s.lineNumbers || null,
    masters: (s.masterPages || []).length,
  });
}

/** 글자 모양에 드는 마크: 글자 모양 열쇠는 이것들로 만든다 (링크·메모·변경 추적 표시는 글자 모양이 아니다) */
const CHAR_MARKS = new Set(['textStyle', 'bold', 'italic', 'underline', 'strike', 'superscript', 'subscript', 'highlight']);

type MarkLike = { type: string; attrs?: Record<string, any> | null };

/**
 * 글자 모양 열쇠: 글자에 붙은 글자 모양 마크들 (원본 글자 모양 번호 hwpCp 는 뺀다). 마크 차례·기본값(null)과 상관없이 같은 모양이면 같다.
 * 읽을 때 적어 둔 열쇠와 저장할 때의 열쇠가 같으면 글자 모양을 고치지 않은 것이다
 */
export function charSnap(marks: MarkLike[] | null | undefined): string {
  const o: Record<string, unknown> = {};
  for (const m of marks || []) {
    if (!CHAR_MARKS.has(m.type)) continue;
    const a: Record<string, unknown> = { ...(m.attrs || {}) };
    delete a.hwpCp;
    const c = canon(a);
    o[m.type] = c && c !== '{}' ? a : true;
  }
  return canon(o);
}

/** 짧은 지문 (긴 값을 열쇠에 그대로 넣지 않으려고: 칸 배경 그림, 그림 값 등) */
export function digest(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36) + ':' + s.length;
}

/** 칸 테두리/배경 열쇠: 칸 속성 가운데 테두리/배경 정의에 드는 것 */
export function cellBfSnap(attrs: Record<string, any> | null | undefined): string {
  const a = attrs || {};
  return canon({ bg: a.backgroundColor, g: a.bgGradient, d: a.diag, c: a.borderCss, s: a.borderStyle, i: a.bgImages ? digest(JSON.stringify(a.bgImages)) : null });
}

/** 저장: 칸의 테두리/배경을 고치지 않았으면 원본 테두리/배경 번호, 아니면 null */
export function keptCellBf(attrs: Record<string, any> | null | undefined): number | null {
  const bf = attrs?.hwpBf;
  if (!Array.isArray(bf) || bf.length !== 2 || !Number.isInteger(bf[0]) || bf[0] < 1) return null;
  return cellBfSnap(attrs) === bf[1] ? bf[0] : null;
}

/** 구역 용지 열쇠: 구역 나누기의 용지(sectionPage)가 읽을 때와 같으면 그 구역의 원본 구역 정의를 쓴다 */
export function secKey(page: unknown): string {
  return canon(page);
}

/** 저장: 구역 나누기의 용지를 고치지 않았으면 그 구역의 원본 구역 정의 (hp:secPr 원문), 아니면 null */
export function keptSecRaw(attrs: Record<string, any> | null | undefined): string | null {
  const s = attrs?.hwpSec;
  if (!Array.isArray(s) || s.length !== 2 || typeof s[0] !== 'string' || !/^<hp:secPr\b[\s\S]*<\/hp:secPr>$/.test(s[0])) return null;
  return secKey(attrs?.sectionPage) === s[1] ? s[0] : null;
}

/**
 * 읽기 마무리: 원본 문단 번호(hwpPr: [문단 모양, 스타일])가 붙은 문단에 그때의 문단 모양 열쇠를,
 * 원본 글자 모양 번호(글자 모양 마크의 hwpCp: [번호])가 붙은 글자에 그때의 글자 모양 열쇠를 더한다
 */
export function attachSnaps(nodes: JNode[] | undefined) {
  if (!nodes) return;
  for (const n of nodes) {
    const pr = n.attrs?.hwpPr;
    if (Array.isArray(pr) && pr.length === 2) n.attrs = { ...n.attrs, hwpPr: [pr[0], pr[1], paraSnap(n.attrs)] };
    const bf = n.attrs?.hwpBf;
    if (Array.isArray(bf) && bf.length === 1) n.attrs = { ...n.attrs, hwpBf: [bf[0], cellBfSnap(n.attrs)] };
    // 구역 나누기: 그 구역의 원본 구역 정의와 그때의 용지 열쇠
    const sec = n.attrs?.hwpSec;
    if (Array.isArray(sec) && sec.length === 1) n.attrs = { ...n.attrs, hwpSec: [sec[0], secKey(n.attrs?.sectionPage)] };
    const marks = n.marks as MarkLike[] | undefined;
    const ts = marks?.find((m) => m.type === 'textStyle');
    const cp = ts?.attrs?.hwpCp;
    // (마크 묶음은 여러 글자가 함께 쓸 수 있다: 고쳐 쓰지 않고 새로 만든다)
    if (marks && ts && Array.isArray(cp) && cp.length === 1) {
      const snap = charSnap(marks);
      n.marks = marks.map((m) => (m === ts ? { ...m, attrs: { ...m.attrs, hwpCp: [cp[0], snap] } } : m)) as JNode['marks'];
    }
    if (n.content) attachSnaps(n.content);
  }
}

/** 저장: 글자 모양을 고치지 않았으면 원본 글자 모양 번호, 아니면 null */
export function keptCharRef(marks: MarkLike[] | null | undefined): number | null {
  const ts = marks?.find((m) => m.type === 'textStyle');
  const cp = ts?.attrs?.hwpCp;
  if (!Array.isArray(cp) || cp.length !== 2 || !Number.isInteger(cp[0]) || cp[0] < 0) return null;
  return charSnap(marks) === cp[1] ? cp[0] : null;
}

/** 저장: 개체(표·글상자·그림·도형)가 든 글자 묶음의 원본 글자 모양 번호. 개체에 글자 모양을 입혔으면 null */
export function keptObjCharRef(n: { attrs?: Record<string, any> | null; marks?: MarkLike[] | null } | null | undefined): number | null {
  const cp = n?.attrs?.hwpCp;
  if (!Number.isInteger(cp) || cp < 0) return null;
  const s = charSnap(n?.marks);
  return !s || s === '{}' ? cp : null;
}

/** 저장: 문단 모양을 고치지 않았으면 원본 [문단 모양 번호, 스타일 번호], 아니면 null */
export function keptParaRef(attrs: Record<string, any> | null | undefined): [number, number] | null {
  const pr = attrs?.hwpPr;
  if (!Array.isArray(pr) || pr.length !== 3) return null;
  const [p, s, snap] = pr;
  if (!Number.isInteger(p) || p < 0 || !Number.isInteger(s) || s < 0) return null;
  return paraSnap(attrs) === snap ? [p, s] : null;
}

/** 원본 줄 정보와 그때의 문단 차례·글자 수 */
export interface KeptSegs {
  rows: HwpSegRow[];
  /** [전체 글자 수, 앞쪽 컨트롤 몫, 앞쪽 컨트롤 다음의 차례] (한글 셈: formats/hwpx/base.ts 의 ParaShape) */
  chars: [number, number, string];
}

/** 저장: 원본 줄 정보와 그때의 문단 차례. 모양이 맞지 않으면 null */
export function keptSegs(attrs: Record<string, any> | null | undefined): KeptSegs | null {
  const rows = attrs?.hwpSeg;
  const ch = attrs?.hwpChars;
  // 빈 목록: 원본에 줄 정보가 없던 문단 (저장할 때도 없이 쓴다)
  if (!Array.isArray(rows) || !Array.isArray(ch) || ch.length !== 3 || typeof ch[2] !== 'string') return null;
  if (!rows.every((r) => Array.isArray(r) && r.length === 9 && r.every((v: unknown) => Number.isFinite(v as number)))) return null;
  return { rows, chars: [ch[0], ch[1], ch[2]] };
}

/**
 * 원본 줄 정보를 저장할 문단에 맞춘다: 앞쪽 컨트롤 다음의 차례(글 길이·탭·개체·컨트롤의 순서)가 원본과 같을 때만.
 * 앞쪽 컨트롤(구역 정의·머리말 등) 수가 다르면 그만큼 줄 첫 자리를 옮긴다. 맞출 수 없으면 null
 */
export function fitSegs(k: KeptSegs, now: { total: number; lead: number; shape: string }): HwpSegRow[] | null {
  const [t0, l0, s0] = k.chars;
  // 한 줄 문단: 줄 첫 자리는 늘 0 이라 차례가 조금 달라도(표 앞뒤 빈칸·컨트롤 차례) 줄 나눔이 바뀌지 않는다
  // (고친 문단은 편집기가 원본 줄 정보를 지운다: hwpKeep)
  if (k.rows.length === 1 && k.rows[0][0] === 0) return [k.rows[0].slice()];
  if (now.shape !== s0 || now.total - now.lead !== t0 - l0) return null;
  const d = now.lead - l0;
  // 앞 묶음 안에서 시작하는 줄은 옮길 자리를 모른다
  if (d && k.rows.some((r) => r[0] > 0 && r[0] < l0)) return null;
  return k.rows.map((r) => (d && r[0] >= l0 ? [r[0] + d, ...r.slice(1)] : r.slice()));
}
