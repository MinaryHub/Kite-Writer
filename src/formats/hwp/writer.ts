import * as CFB from 'cfb';
import { deflateRaw } from 'pako';
import type { HeaderFooter, KDocument } from '../../types';
import { type JNode, mmToHwp, pxToHwp, ptToHwp, parseBorderCss, paraBorderToFill, HWP_BORDER_WIDTHS, FIXED_SPACE } from '../common';
import { type CharStyle, type FlatBlock, type FlatFloat, type FlatInline, type FlatPara, type FlatTable, type ParaStyle, charKey, langFontIds, defaultChar, defaultPara, flattenContent, flattenDoc, paraKey, unwrapBoxes } from '../flatten';
import { prepareImage } from '../imageUtil';
import { HWP_LINE_STYLES, SHADOW_UNIT_PX, type ShapeData, type ShapeItem, type ShapeRaw } from '../shape';
import { rawOf, shapeImageSrcs, shapeObjects } from '../hwpx/shapeWriter';

const PT2PX = 96 / 72;
/** 그림 채우는 방식의 번호 (리더의 IMG_FILL_MODES 와 같은 차례) */
const IMG_FILL_MODES = ['TILE', 'TILE_HORZ_TOP', 'TILE_HORZ_BOTTOM', 'TILE_VERT_LEFT', 'TILE_VERT_RIGHT', 'TOTAL', 'CENTER', 'CENTER_TOP', 'CENTER_BOTTOM', 'LEFT_CENTER', 'LEFT_TOP', 'LEFT_BOTTOM', 'RIGHT_CENTER', 'RIGHT_TOP', 'RIGHT_BOTTOM', 'ZOOM'];
/** 도형 종류 → 개체 요소의 ctrl ID 와 도형 레코드 */
const SHAPE_IDS: Record<string, string> = { line: '$lin', rect: '$rec', ellipse: '$ell', arc: '$arc', poly: '$pol', curve: '$cur', img: '$pic' };

/**
 * HWP 5.0 바이너리 쓰기.
 * 레코드 배치는 한글 2018~2022가 만든 실제 문서를 기준으로 하였다.
 */

// ---------------- 바이트 버퍼 ----------------
class Buf {
  private a: number[] = [];
  u8(v: number) {
    this.a.push(v & 0xff);
    return this;
  }
  i8(v: number) {
    return this.u8(v < 0 ? 256 + v : v);
  }
  u16(v: number) {
    this.a.push(v & 0xff, (v >>> 8) & 0xff);
    return this;
  }
  i16(v: number) {
    return this.u16(v < 0 ? 0x10000 + v : v);
  }
  u32(v: number) {
    v = v >>> 0;
    this.a.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  i32(v: number) {
    return this.u32(v | 0);
  }
  f64(v: number) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v, true);
    this.a.push(...b);
    return this;
  }
  /** WORD 길이 + WCHAR 문자열 */
  wstr(s: string) {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u16(s.charCodeAt(i));
    return this;
  }
  bytes(b: ArrayLike<number>) {
    for (let i = 0; i < b.length; i++) this.a.push(b[i]);
    return this;
  }
  zeros(n: number) {
    for (let i = 0; i < n; i++) this.a.push(0);
    return this;
  }
  get length() {
    return this.a.length;
  }
  out(): Uint8Array {
    return Uint8Array.from(this.a);
  }
}

const hex = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((x) => parseInt(x, 16)));

function rgb(c: string | null | undefined): number {
  if (!c) return 0;
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c);
  if (!m) return 0;
  return parseInt(m[1], 16) | (parseInt(m[2], 16) << 8) | (parseInt(m[3], 16) << 16);
}

/** 문자 4개 컨트롤 ID */
function ctrlId(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0;
}

// ---------------- 레코드 ----------------
const TAG = {
  DOCUMENT_PROPERTIES: 16,
  ID_MAPPINGS: 17,
  BIN_DATA: 18,
  FACE_NAME: 19,
  BORDER_FILL: 20,
  CHAR_SHAPE: 21,
  TAB_DEF: 22,
  NUMBERING: 23,
  PARA_SHAPE: 25,
  STYLE: 26,
  COMPATIBLE_DOCUMENT: 30,
  LAYOUT_COMPATIBILITY: 31,
  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  PARA_LINE_SEG: 69,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  PAGE_DEF: 73,
  FOOTNOTE_SHAPE: 74,
  PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  SHAPE_COMPONENT_LINE: 78,
  SHAPE_COMPONENT_RECTANGLE: 79,
  SHAPE_COMPONENT_ELLIPSE: 80,
  SHAPE_COMPONENT_ARC: 81,
  SHAPE_COMPONENT_POLYGON: 82,
  SHAPE_COMPONENT_CURVE: 83,
  SHAPE_COMPONENT_PICTURE: 85,
};

class RecWriter {
  private parts: Uint8Array[] = [];
  rec(tag: number, level: number, data: Uint8Array) {
    const size = data.length;
    const h = new Buf();
    if (size >= 0xfff) {
      h.u32((tag & 0x3ff) | ((level & 0x3ff) << 10) | (0xfff << 20));
      h.u32(size);
    } else h.u32((tag & 0x3ff) | ((level & 0x3ff) << 10) | (size << 20));
    this.parts.push(h.out(), data);
  }
  out(): Uint8Array {
    const n = this.parts.reduce((a, b) => a + b.length, 0);
    const o = new Uint8Array(n);
    let p = 0;
    for (const x of this.parts) {
      o.set(x, p);
      p += x.length;
    }
    return o;
  }
}

// ---------------- 스타일 등록 ----------------
interface BF {
  bg: string | null;
  noBorders: string[];
  borders: boolean;
  css?: string | null;
  /** 그림 채우기 (쪽 배경): BinData 번호와 채우는 방식 */
  img?: { binId: number; mode: string } | null;
}

class Registry {
  fonts: string[] = [];
  chars: CharStyle[] = [];
  charIds = new Map<string, number>();
  paras: (ParaStyle & { bf: number })[] = [];
  paraIds = new Map<string, number>();
  bfs: BF[] = [];
  bfIds = new Map<string, number>();
  bins: { id: number; ext: string; bytes: Uint8Array }[] = [];

  constructor() {
    this.bf({ bg: null, noBorders: ['l', 'r', 't', 'b'], borders: false }); // 1 쪽 테두리
    this.bf({ bg: null, noBorders: ['l', 'r', 't', 'b'], borders: false, tag: 'char' } as any); // 2 글자/문단 기본
    this.bf({ bg: null, noBorders: [], borders: true }); // 3 표
    this.font('함초롬바탕');
    this.font('함초롬돋움');
    this.char(defaultChar());
    this.para(defaultPara());
  }
  font(n: string) {
    let i = this.fonts.indexOf(n);
    if (i < 0) {
      i = this.fonts.length;
      this.fonts.push(n);
    }
    return i;
  }
  char(c: CharStyle) {
    const k = charKey(c);
    let id = this.charIds.get(k);
    if (id === undefined) {
      id = this.chars.length;
      this.chars.push(c);
      this.charIds.set(k, id);
      langFontIds(c, (n) => this.font(n));
    }
    return id;
  }
  bf(d: BF) {
    const k = JSON.stringify(d);
    let id = this.bfIds.get(k);
    if (id === undefined) {
      this.bfs.push(d);
      id = this.bfs.length;
      this.bfIds.set(k, id);
    }
    return id;
  }
  para(p: ParaStyle) {
    const k = paraKey(p);
    let id = this.paraIds.get(k);
    if (id === undefined) {
      let bf = 2;
      if (p.border) {
        const f = paraBorderToFill(p.border);
        bf = this.bf({ bg: p.bg, noBorders: f.noBorders, borders: f.noBorders.length < 4, css: f.css });
      } else if (p.bg || p.borderBottom) bf = this.bf({ bg: p.bg, noBorders: p.borderBottom ? ['l', 'r', 't'] : ['l', 'r', 't', 'b'], borders: p.borderBottom });
      id = this.paras.length;
      this.paras.push({ ...p, bf });
      this.paraIds.set(k, id);
    }
    return id;
  }
}

// ---------------- DocInfo ----------------
const NUMBERING_TEMPLATE = hex(
  '0c 00 00 00 00 00 32 00 ff ff ff ff 03 00 5e 00 31 00 2e 00 0c 01 00 00 00 00 32 00 ff ff ff ff 03 00 5e 00 32 00 2e 00 0c 00 00 00 00 00 32 00 ff ff ff ff 03 00 5e 00 33 00 29 00 0c 01 00 00 00 00 32 00 ff ff ff ff 03 00 5e 00 34 00 29 00 0c 00 00 00 00 00 32 00 ff ff ff ff 04 00 28 00 5e 00 35 00 29 00 0c 01 00 00 00 00 32 00 ff ff ff ff 04 00 28 00 5e 00 36 00 29 00 2c 00 00 00 00 00 32 00 ff ff ff ff 02 00 5e 00 37 00 01 00',
);

function charShapeRec(r: Registry, c: CharStyle): Uint8Array {
  const b = new Buf();
  // 언어별 글꼴 번호 (글꼴 목록은 언어마다 같은 순서로 기록한다)
  for (const f of langFontIds(c, (n) => r.font(n))) b.u16(f);
  for (let i = 0; i < 7; i++) b.u8(Math.max(50, Math.min(200, Math.round(c.fontWidth || 100))));
  for (let i = 0; i < 7; i++) b.i8(Math.max(-50, Math.min(50, Math.round(c.letterSpacing || 0))));
  for (let i = 0; i < 7; i++) b.u8(100);
  // 글자 위치 (%)
  for (let i = 0; i < 7; i++) b.i8(Math.max(-100, Math.min(100, Math.round(c.offset || 0))));
  b.i32(ptToHwp(c.size));
  // 선 종류 번호 (0 실선, 1 긴 점선, 2 점선 … 11 물결선)
  const SHAPES = ['SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLE_WAVE'];
  const shapeNo = (v: string | null | undefined) => Math.max(0, SHAPES.indexOf(v || 'SOLID'));
  let attr = 0;
  if (c.italic) attr |= 1;
  if (c.bold) attr |= 2;
  // 밑줄: bit 2~3 종류(1 글자 아래, 3 글자 위), 4~7 모양. 강조점: bit 21~24. 취소선 모양: bit 26~29
  if (c.underline) attr |= ((c.ulPos === 'top' ? 3 : 1) << 2) | (shapeNo(c.ulShape) << 4);
  if (c.emphasis) attr |= Math.max(0, ['', 'DOT_ABOVE', 'RING_ABOVE', 'CARON', 'TILDE', 'SIDE', 'COLON'].indexOf(c.emphasis)) << 21;
  if (c.strike) attr |= shapeNo(c.stShape) << 26;
  if (c.effect === 'outline') attr |= 1 << 8;
  if (c.effect === 'shadow') attr |= 1 << 11;
  if (c.effect === 'emboss') attr |= 1 << 13;
  if (c.effect === 'engrave') attr |= 1 << 14;
  if (c.sup) attr |= 1 << 15;
  if (c.sub) attr |= 1 << 16;
  if (c.strike) attr |= 1 << 18;
  b.u32(attr >>> 0);
  b.i8(10).i8(10);
  b.u32(rgb(c.color));
  b.u32(c.ulColor ? rgb(c.ulColor) : c.underline ? rgb(c.color) : 0); // 밑줄 색
  b.u32(c.highlight ? rgb(c.highlight) : 0xffffffff); // 음영 색
  b.u32(0xc0c0c0); // 그림자 색
  b.u16(2); // 글자 테두리/배경
  b.u32(c.stColor ? rgb(c.stColor) : c.strike ? rgb(c.color) : 0); // 취소선 색
  return b.out();
}

function paraShapeRec(p: ParaStyle & { bf: number }): Uint8Array {
  const b = new Buf();
  const ALIGN: Record<string, number> = { justify: 0, left: 1, right: 2, center: 3, distribute: 4 };
  let lsType = 0;
  let lsVal = 160;
  if (/pt$/.test(p.lineHeight)) {
    lsType = 1;
    lsVal = ptToHwp(parseFloat(p.lineHeight)) * 2;
  } else if (p.lineHeight) lsVal = Math.round(parseFloat(p.lineHeight) * 100) || 160;
  // bit 7: 한글 줄 나눔 단위 (0 어절, 1 글자), bit 8: 편집 용지 줄 격자
  // bit 28: 이어진 문단의 테두리를 한 상자로
  const attr1 = (0x100 | (p.breakChar ? 0x80 : 0) | ((ALIGN[p.align] ?? 0) << 2) | (lsType === 1 ? 1 : 0) | (p.border?.c ? 1 << 28 : 0)) >>> 0;
  b.u32(attr1);
  // 여백 값은 2배로 저장
  b.i32(ptToHwp(p.indentLeft) * 2);
  b.i32(ptToHwp(p.indentRight) * 2);
  b.i32(ptToHwp(p.textIndent) * 2);
  b.i32(ptToHwp(p.spaceBefore) * 2);
  b.i32(ptToHwp(p.spaceAfter) * 2);
  b.i32(lsType === 0 ? lsVal : lsVal);
  b.u16(0); // 탭 정의
  b.u16(0); // 문단 번호/글머리표
  b.u16(p.bf);
  // 문단 테두리와 글의 간격 (왼·오른·위·아래)
  const po = (p.border?.o || [0, 0, 0, 0]).map((v) => Math.max(-32000, Math.min(32000, pxToHwp(v))));
  b.i16(po[0]).i16(po[1]).i16(po[2]).i16(po[3]);
  b.u32(0); // 속성 2
  b.u32(lsType); // 속성 3 (줄 간격 종류)
  b.u32(lsVal);
  b.u32(0);
  return b.out();
}

function borderFillRec(d: BF): Uint8Array {
  const b = new Buf();
  b.u16(0);
  const det = parseBorderCss(d.css);
  for (const s of ['l', 'r', 't', 'b']) {
    const on = d.borders && !d.noBorders.includes(s);
    const x = det[s as 'l'];
    if (on && x) {
      let wi = 0;
      HWP_BORDER_WIDTHS.forEach((w, i) => {
        if (Math.abs(w - x.w) < Math.abs(HWP_BORDER_WIDTHS[wi] - x.w)) wi = i;
      });
      const type = x.s === 'dashed' ? 2 : x.s === 'dotted' ? 3 : x.s === 'double' ? 8 : 1;
      b.u8(type).u8(wi).u32(rgb(x.c));
    } else b.u8(on ? 1 : 0).u8(on ? 1 : 0).u32(0);
  }
  b.u8(1).u8(0).u32(0); // 대각선
  if (d.bg || d.img) {
    // 채우기: 종류(4) → 단색(바탕색·무늬색·무늬 종류) → 그림(채우는 방식 1, 밝기 1, 명암 1, 효과 1, BinData 번호 2) → 추가 속성 길이(4) → 종류마다 1바이트
    b.u32((d.bg ? 1 : 0) | (d.img ? 2 : 0));
    if (d.bg) b.u32(rgb(d.bg)).u32(0x999999).i32(-1);
    if (d.img) b.u8(Math.max(0, IMG_FILL_MODES.indexOf(d.img.mode))).i8(0).i8(0).u8(0).u16(d.img.binId);
    b.u32(0);
    if (d.bg) b.u8(0);
    if (d.img) b.u8(0);
  } else b.u32(0).u32(0);
  return b.out();
}

function docInfo(reg: Registry): Uint8Array {
  const w = new RecWriter();
  w.rec(TAG.DOCUMENT_PROPERTIES, 0, new Buf().u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).u32(0).u32(0).u32(0).out());
  const nf = reg.fonts.length;
  const ids = new Buf();
  [reg.bins.length, nf, nf, nf, nf, nf, nf, nf, reg.bfs.length, reg.chars.length, 2, 1, 0, reg.paras.length, 1, 0, 0, 0].forEach((v) => ids.i32(v));
  w.rec(TAG.ID_MAPPINGS, 0, ids.out());
  for (const bin of reg.bins) w.rec(TAG.BIN_DATA, 1, new Buf().u16(1).u16(bin.id).wstr(bin.ext).out());
  for (let lang = 0; lang < 7; lang++) for (const f of reg.fonts) w.rec(TAG.FACE_NAME, 1, new Buf().u8(0).wstr(f).out());
  for (const d of reg.bfs) w.rec(TAG.BORDER_FILL, 1, borderFillRec(d));
  for (const c of reg.chars) w.rec(TAG.CHAR_SHAPE, 1, charShapeRec(reg, c));
  w.rec(TAG.TAB_DEF, 1, hex('00 00 00 00 00 00 00 00'));
  w.rec(TAG.TAB_DEF, 1, hex('01 00 00 00 00 00 00 00'));
  w.rec(TAG.NUMBERING, 1, NUMBERING_TEMPLATE);
  for (const p of reg.paras) w.rec(TAG.PARA_SHAPE, 1, paraShapeRec(p));
  w.rec(TAG.STYLE, 1, new Buf().wstr('바탕글').wstr('Normal').u8(0).u8(0).i16(0x412).u16(0).u16(0).u16(0).out());
  w.rec(TAG.COMPATIBLE_DOCUMENT, 0, new Buf().u32(0).out());
  w.rec(TAG.LAYOUT_COMPATIBILITY, 1, new Buf().zeros(20).out());
  return w.out();
}

// ---------------- 본문 ----------------
let instSeq = 0x50000000;
const inst = () => ++instSeq;

interface ParaBuild {
  text: number[];
  shapes: [number, number][];
  ctrls: ((w: RecWriter, level: number) => void)[];
  maxSize: number;
}

class BodyWriter {
  w = new RecWriter();
  footNo = 0;
  /** 머리말/꼬리말을 쓰는 중 ({{PAGE}} → 쪽 번호 필드) */
  inHF = false;
  constructor(
    private reg: Registry,
    private doc: KDocument,
    private images: Map<string, { binId: number; w: number; h: number } | null>,
    private bodyW: number,
  ) {}

  private beginPara(): ParaBuild {
    return { text: [], shapes: [], ctrls: [], maxSize: 10 };
  }

  private setShape(pb: ParaBuild, charId: number) {
    const last = pb.shapes[pb.shapes.length - 1];
    if (last && last[1] === charId) return;
    if (last && last[0] === pb.text.length) last[1] = charId;
    else pb.shapes.push([pb.text.length, charId]);
  }

  /** 8 WCHAR 확장/인라인 컨트롤 */
  private ctrlChars(pb: ParaBuild, code: number, id: string) {
    const v = ctrlId(id);
    pb.text.push(code, v & 0xffff, v >>> 16, 0, 0, 0, 0, code);
  }

  private emitPara(pb: ParaBuild, paraId: number, level: number, last: boolean, breakType = 0) {
    pb.text.push(13);
    if (!pb.shapes.length) pb.shapes.push([0, 0]);
    let mask = 0;
    for (const c of pb.text) if (c < 32 && c !== 13) mask |= 1 << c;
    const n = pb.text.length;
    const hdr = new Buf()
      .u32((n | (last ? 0x80000000 : 0)) >>> 0)
      .u32(mask)
      .u16(paraId)
      .u8(0)
      .u8(breakType)
      .u16(pb.shapes.length)
      .u16(0)
      .u16(1)
      .u32(inst())
      .u16(0);
    this.w.rec(TAG.PARA_HEADER, level, hdr.out());
    if (n > 1) {
      const t = new Buf();
      for (const c of pb.text) t.u16(c);
      this.w.rec(TAG.PARA_TEXT, level + 1, t.out());
    }
    const cs = new Buf();
    for (const [pos, id] of pb.shapes) cs.u32(pos).u32(id);
    this.w.rec(TAG.PARA_CHAR_SHAPE, level + 1, cs.out());
    const lh = Math.round(pb.maxSize * 100);
    this.w.rec(
      TAG.PARA_LINE_SEG,
      level + 1,
      new Buf().u32(0).i32(0).i32(lh).i32(lh).i32(Math.round(lh * 0.85)).i32(Math.round(lh * 0.6)).i32(0).i32(this.bodyW).u32(0x60000).out(),
    );
    for (const c of pb.ctrls) c(this.w, level + 1);
  }

  /**
   * 개체 공통 속성(CTRL_HEADER 의 앞부분): 속성, 세로·가로 오프셋, 폭, 높이, 겹침 차례, 바깥 여백.
   * 떠 있는 개체는 한글에서 읽은 자리 값(hw)을 그대로 되돌려 쓰고, 없으면 문단 기준 오프셋으로 쓴다. 떠 있지 않으면 글자처럼 취급
   */
  private objHeader(id: string, fl: FlatFloat | null | undefined, wv: number, hv: number, paraLeft = 0, sb = 0): Buf {
    const b = new Buf().u32(ctrlId(id));
    if (!fl) return b.u32(0x042a2211).i32(0).i32(0).u32(wv).u32(hv).i32(0).u16(0).u16(0).u16(0).u16(0);
    const hw = fl.hw || { wrap: fl.behind ? 'BEHIND_TEXT' : 'IN_FRONT_OF_TEXT', vr: 'PARA', hr: 'COLUMN', va: 'TOP', ha: 'LEFT', vo: Math.max(0, pxToHwp(fl.y - sb)), ho: pxToHwp(fl.x + paraLeft), om: [0, 0, 0, 0] };
    const idx = (list: string[], v: string) => Math.max(0, list.indexOf(v));
    const wrap = idx(['SQUARE', 'TOP_AND_BOTTOM', 'BEHIND_TEXT', 'IN_FRONT_OF_TEXT'], hw.wrap);
    const vr = idx(['PAPER', 'PAGE', 'PARA'], hw.vr);
    const hr = idx(['PAPER', 'PAGE', 'COLUMN', 'PARA'], hw.hr);
    const va = idx(['TOP', 'CENTER', 'BOTTOM', 'INSIDE', 'OUTSIDE'], hw.va);
    const ha = idx(['LEFT', 'CENTER', 'RIGHT', 'INSIDE', 'OUTSIDE'], hw.ha);
    // bit 3~4 세로 기준, 5~7 세로 맞춤, 8~9 가로 기준, 10~12 가로 맞춤, 13 본문 영역으로 제한(문단 기준), 14 겹침 허용,
    // 15~17·18~19 폭·높이 기준(절대값), 21~23 본문과의 배치, 26~ 번호 종류(그림)
    const attr = ((vr << 3) | (va << 5) | (hr << 8) | (ha << 10) | (vr === 2 ? 1 << 13 : 0) | (wrap >= 2 ? 1 << 14 : 0) | (1 << 17) | (1 << 19) | (wrap << 21) | (1 << 26)) >>> 0;
    const om = hw.om || [0, 0, 0, 0];
    return b.u32(attr).i32(Math.round(hw.vo)).i32(Math.round(hw.ho)).u32(wv).u32(hv).i32(0).u16(om[0]).u16(om[1]).u16(om[2]).u16(om[3]);
  }

  /** HWP 로 쓸 수 있는 도형인가 (글맵시는 아직 쓰지 않는다) */
  private canWriteShape(d: ShapeData): boolean {
    const objs = shapeObjects(d);
    return objs.length > 0 && objs.every((o) => !!SHAPE_IDS[o.it.k] && (o.it.k !== 'img' || !!this.images.get(o.it.src || '')));
  }

  /** 그리기 개체 컨트롤: 개체 공통 속성 + 개체 요소(묶음이면 자식들) */
  private shapeCtrl(w: RecWriter, lv: number, it: Extract<FlatInline, { type: 'shape' }>, paraLeft: number, sb: number) {
    const d = it.d;
    const objs = shapeObjects(d);
    const W = Math.max(1, pxToHwp(it.width));
    const H = Math.max(1, pxToHwp(it.height));
    w.rec(TAG.CTRL_HEADER, lv, this.objHeader('gso ', it.float, W, H, paraLeft, sb).u32(inst()).u32(0).u16(0).out());
    if (!d.group && objs.length === 1) {
      this.shapeComp(w, lv + 1, objs[0].it, objs[0].text, 0);
      return;
    }
    // 묶은 개체: 묶음의 개체 요소 뒤에 자식 수와 자식들의 ctrl ID
    const raw: ShapeRaw =
      d.raw && d.raw.lvl === 0 && d.raw.mats.length === 3
        ? d.raw
        : { off: [0, 0], org: [W, H], cur: [W, H], flip: [0, 0], rot: [0, Math.round(W / 2), Math.round(H / 2)], mats: [[1, 0, 0, 0, 1, 0], [1, 0, 0, 0, 1, 0], [1, 0, 0, 0, 1, 0]], lvl: 0 };
    const b = this.shapeCommon('$con', raw, true);
    b.u16(objs.length);
    for (const o of objs) b.u32(ctrlId(SHAPE_IDS[o.it.k]));
    b.u32(inst());
    w.rec(TAG.SHAPE_COMPONENT, lv + 1, b.out());
    for (const o of objs) this.shapeComp(w, lv + 2, o.it, o.text, 1);
  }

  /** 개체 요소의 공통 부분: ctrl ID(최상위는 두 번), 묶음 안 자리, 묶음 깊이, 원래·현재 크기, 뒤집기, 회전, 렌더링 행렬 */
  private shapeCommon(id: string, raw: ShapeRaw, top: boolean): Buf {
    const b = new Buf().u32(ctrlId(id));
    if (top) b.u32(ctrlId(id));
    b.i32(raw.off[0]).i32(raw.off[1]).u16(raw.lvl).u16(1).u32(Math.abs(raw.org[0])).u32(Math.abs(raw.org[1])).u32(Math.abs(raw.cur[0])).u32(Math.abs(raw.cur[1]));
    b.u32((raw.flip[0] ? 1 : 0) | (raw.flip[1] ? 2 : 0)).i16(Math.round(raw.rot[0])).i32(Math.round(raw.rot[1])).i32(Math.round(raw.rot[2]));
    b.u16((raw.mats.length - 1) >> 1);
    for (const m of raw.mats) for (const v of m) b.f64(Number.isFinite(v) ? v : 0);
    return b;
  }

  /** 개체 요소 하나: SHAPE_COMPONENT(선·채우기·그림자) + 도형 안의 글 + 도형 레코드 */
  private shapeComp(w: RecWriter, lv: number, it: ShapeItem, text: ShapeItem | null, lvl: number) {
    const raw = rawOf(it, lvl);
    const id = SHAPE_IDS[it.k];
    const b = this.shapeCommon(id, raw, lvl === 0);
    const hw = (v: number) => Math.round(pxToHwp(v));
    if (it.k === 'img') {
      const info = this.images.get(it.src || '');
      if (!info) return;
      w.rec(TAG.SHAPE_COMPONENT, lv, b.out());
      this.pictureRec(w, lv + 1, Math.abs(raw.org[0]), Math.abs(raw.org[1]), info.binId, pxToHwp(info.w), pxToHwp(info.h), it.crop || null, inst());
      return;
    }
    // 선 정보: 색(4) 굵기(4) 속성(4) 윤곽(1). 속성: bit 0~5 선 종류, 6~9 끝 모양, 10~15·16~21 시작·끝 화살표, 22~25·26~29 화살표 크기, 30·31 화살표 채움
    const ARROW: Record<string, number> = { ARROW: 1, SPEAR: 2, CONCAVE_ARROW: 3, DIAMOND: 4, CIRCLE: 5, BOX: 6 };
    const asz = (z: [number, number] | undefined) => Math.round(z?.[0] ?? 1) * 3 + Math.round(z?.[1] ?? 1);
    if (it.sc) {
      const type = Math.max(0, HWP_LINE_STYLES.indexOf(it.sd || 'SOLID')) + 1;
      const prop = (type | ((it.cap === 'round' ? 0 : 1) << 6) | ((it.hs ? ARROW[it.hs] || 0 : 0) << 10) | ((it.ts ? ARROW[it.ts] || 0 : 0) << 16) | (asz(it.hz) << 22) | (asz(it.tz) << 26) | ((!it.hs || it.hf ? 1 : 0) << 30) | ((!it.ts || it.tf ? 1 : 0) << 31)) >>> 0;
      b.u32(rgb(it.sc)).i32(raw.lw != null ? Math.round(raw.lw) : Math.max(1, hw(it.sw || 0.45))).u32(prop).u8(0);
    } else b.u32(0).i32(0).u32(0xd1000040).u8(0);
    // 채우기 정보
    const img = it.fi ? this.images.get(it.fi) : null;
    const g = it.fg;
    const kind = (it.fc && !g ? 1 : 0) | (img ? 2 : 0) | (g ? 4 : 0);
    if (!kind || it.k === 'line') b.u32(0).u32(0);
    else {
      b.u32(kind);
      if (kind & 1) b.u32(rgb(it.fc!)).u32(0).i32(-1);
      if (g) {
        b.u8(Math.max(1, ['', 'LINEAR', 'RADIAL', 'CONICAL', 'SQUARE'].indexOf(g.t))).u32(Math.round(g.a) >>> 0).u32(Math.round(g.cx)).u32(Math.round(g.cy)).u32(255).u32(g.c.length);
        if (g.c.length > 2) g.c.forEach((_c, i) => b.i32(Math.round((i * 100) / (g.c.length - 1))));
        for (const c of g.c) b.u32(rgb(c));
      }
      if (img) b.u8(5).i8(0).i8(0).u8(0).u16(img.binId);
      // 추가 속성 (그러데이션의 번짐 중심 1바이트), 그리고 채우기 종류마다 1바이트
      if (g) b.u32(1).u8(Math.round(g.sc ?? 50));
      else b.u32(0);
      if (kind & 1) b.u8(0);
      if (g) b.u8(0);
      if (img) b.u8(0);
    }
    // 그림자: 종류(1 왼쪽 위, 2 오른쪽 위, 3 왼쪽 아래, 4 오른쪽 아래) 색 가로·세로 거리(0.01mm)
    if (it.sh) b.u32(it.sh.x < 0 ? (it.sh.y < 0 ? 1 : 3) : it.sh.y < 0 ? 2 : 4).u32(rgb(it.sh.c)).i32(Math.round(Math.abs(it.sh.x) / SHADOW_UNIT_PX)).i32(Math.round(Math.abs(it.sh.y) / SHADOW_UNIT_PX));
    else b.u32(0).u32(0xb2b2b2).i32(0).i32(0);
    b.u32(inst()).u8(0).u8(0);
    w.rec(TAG.SHAPE_COMPONENT, lv, b.out());
    // 도형 안의 글: 문단 수(4) 속성(4: bit 5~6 세로 맞춤) 왼쪽·오른쪽·위·아래 여백(각 2) 글 폭(4) …
    if (text && text.content && it.k !== 'line') {
      const blocks = unwrapBoxes(flattenContent(text.content));
      if (blocks.length) {
        const pad = (text.pad || [3.77, 3.77, 3.77, 3.77]).map((v) => hw(v));
        const va = text.va === 'middle' ? 1 : text.va === 'bottom' ? 2 : 0;
        w.rec(TAG.LIST_HEADER, lv + 1, new Buf().i32(blocks.length).u32(va << 5).u16(pad[3]).u16(pad[1]).u16(pad[0]).u16(pad[2]).u32(Math.abs(raw.org[0])).zeros(13).out());
        const saved = this.w;
        this.w = w;
        this.blocks(blocks, lv + 1);
        this.w = saved;
      }
    }
    const p = (it.p || []).map((v) => hw(v));
    switch (it.k) {
      case 'line':
        w.rec(TAG.SHAPE_COMPONENT_LINE, lv + 1, new Buf().i32(p[0] || 0).i32(p[1] || 0).i32(p[2] || 0).i32(p[3] || 0).u32(0).out());
        break;
      case 'rect': {
        const W = Math.abs(raw.org[0]);
        const H = Math.abs(raw.org[1]);
        w.rec(TAG.SHAPE_COMPONENT_RECTANGLE, lv + 1, new Buf().u8(Math.round(it.r || 0)).i32(0).i32(0).i32(W).i32(0).i32(W).i32(H).i32(0).i32(H).out());
        break;
      }
      case 'ellipse': {
        const W = Math.abs(raw.org[0]);
        const H = Math.abs(raw.org[1]);
        w.rec(TAG.SHAPE_COMPONENT_ELLIPSE, lv + 1, new Buf().u32(0).i32(Math.round(W / 2)).i32(Math.round(H / 2)).i32(W).i32(Math.round(H / 2)).i32(Math.round(W / 2)).i32(0).zeros(32).out());
        break;
      }
      case 'arc':
        w.rec(TAG.SHAPE_COMPONENT_ARC, lv + 1, new Buf().u8(it.at === 'PIE' ? 1 : it.at === 'CHORD' ? 2 : 0).i32(p[0] || 0).i32(p[1] || 0).i32(p[2] || 0).i32(p[3] || 0).i32(p[4] || 0).i32(p[5] || 0).out());
        break;
      case 'poly': {
        const pts = p.slice(0, p.length - (p.length % 2));
        // 닫힌 다각형은 처음 점으로 돌아온다
        if (it.z && pts.length >= 4 && (pts[0] !== pts[pts.length - 2] || pts[1] !== pts[pts.length - 1])) pts.push(pts[0], pts[1]);
        const pb = new Buf().i32(pts.length / 2);
        for (const v of pts) pb.i32(v);
        w.rec(TAG.SHAPE_COMPONENT_POLYGON, lv + 1, pb.u32(0).out());
        break;
      }
      case 'curve': {
        const n = Math.floor(p.length / 2);
        const cb = new Buf().i32(n);
        for (let i = 0; i < n * 2; i++) cb.i32(p[i]);
        const seg = it.seg || '';
        for (let i = 0; i < n - 1; i++) cb.u8(seg[i] === 'L' ? 0 : 1);
        w.rec(TAG.SHAPE_COMPONENT_CURVE, lv + 1, cb.u32(0).out());
        break;
      }
    }
  }

  private inlines(pb: ParaBuild, list: FlatInline[], level: number, paraLeft = 0, sb = 0) {
    let curLink: string | null = null;
    const endLink = () => {
      if (!curLink) return;
      pb.text.push(4, 0x6c6b, 0x0068, 0, 0, 0, 0, 4);
      curLink = null;
    };
    for (const it of list) {
      const link = it.type === 'text' ? it.link : null;
      if (link !== curLink) {
        endLink();
        if (link) {
          this.ctrlChars(pb, 3, '%hlk');
          const cmd = link.replace(/:/g, '\\:') + ';1;0;0;';
          pb.ctrls.push((w, lv) => w.rec(TAG.CTRL_HEADER, lv, new Buf().u32(ctrlId('%hlk')).u32(0).u8(0).wstr(cmd).u32(inst()).u32(0).out()));
          curLink = link;
        }
      }
      if (it.type === 'text' && (it.ruby || it.compose) && it.text) {
        // 덧말·글자 겹침: 컨트롤 하나 (글자 코드 23)
        const cid = this.reg.char(it.style);
        this.setShape(pb, cid);
        pb.maxSize = Math.max(pb.maxSize, it.style.size);
        const text = it.text;
        if (it.ruby) {
          const sub = it.ruby.text;
          const pos = it.ruby.pos === 'bottom' ? 1 : 0;
          this.ctrlChars(pb, 23, 'tdut');
          // 본말, 덧말, 위치, 글자 크기 비율, 선택 사항, 스타일 번호, 정렬(가운데)
          pb.ctrls.push((w, lv) => w.rec(TAG.CTRL_HEADER, lv, new Buf().u32(ctrlId('tdut')).wstr(text).wstr(sub).u32(pos).u32(0).u32(0).u32(0).u32(2).out()));
        } else {
          const shape = Math.max(0, ['CHAR', 'SHAPE_CIRCLE', 'SHAPE_REVERSAL_CIRCLE', 'SHAPE_RECTANGLE', 'SHAPE_REVERSAL_RECTANGLE', 'SHAPE_TRIANGLE', 'SHAPE_REVERSAL_TIRANGLE', 'SHAPE_LIGHT', 'SHAPE_RHOMBUS', 'SHAPE_REVERSAL_RHOMBUS', 'SHAPE_ROUNDED_RECTANGLE'].indexOf(it.compose || ''));
          this.ctrlChars(pb, 23, 'tcps');
          // 겹칠 글자, 테두리 모양, 안 글자 크기, 펼침, 글자 모양 수와 번호
          pb.ctrls.push((w, lv) => w.rec(TAG.CTRL_HEADER, lv, new Buf().u32(ctrlId('tcps')).wstr(text).u8(shape).i8(-3).u8(1).u8(1).u32(cid).out()));
        }
      } else if (it.type === 'text') {
        this.setShape(pb, this.reg.char(it.style));
        pb.maxSize = Math.max(pb.maxSize, it.style.size);
        // 머리말/꼬리말 안의 쪽 번호 자리({{PAGE}})는 쪽 번호 필드로
        const parts = this.inHF ? it.text.split('{{PAGE}}') : [it.text];
        parts.forEach((part, pi) => {
        if (pi > 0) {
          this.ctrlChars(pb, 18, 'atno');
          pb.ctrls.push((ww, l2) => ww.rec(TAG.CTRL_HEADER, l2, new Buf().u32(ctrlId('atno')).u32(0).u16(1).u16(0).u16(0).u16(0).out()));
        }
        for (const ch of part) {
          const code = ch.codePointAt(0)!;
          if (ch === '\t') {
            // 탭: 폭(UINT32)·채움·종류를 가진 8 WCHAR 인라인 컨트롤
            const tw = it.tab?.width ? pxToHwp(it.tab.width) : 4000;
            pb.text.push(9, tw & 0xffff, tw >>> 16, ((it.tab?.leader || 0) & 0xff) | (((it.tab?.type || 0) & 0xff) << 8), 0, 0, 0, 9);
          }
          else if (code < 32) continue;
          // 고정폭 빈칸 (읽을 때 U+2005 로 바꾼 것)
          else if (code === FIXED_SPACE) pb.text.push(31);
          else if (code > 0xffff) {
            const s = ch;
            pb.text.push(s.charCodeAt(0), s.charCodeAt(1));
          } else pb.text.push(code);
        }
        });
      } else if (it.type === 'break') {
        pb.text.push(10);
      } else if (it.type === 'image') {
        const info = this.images.get(it.src);
        if (!info) continue;
        this.setShape(pb, this.reg.char(it.style));
        this.ctrlChars(pb, 11, 'gso ');
        let wv = it.width ? pxToHwp(it.width) : pxToHwp(info.w);
        let hv = it.height ? pxToHwp(it.height) : it.width ? Math.round((pxToHwp(it.width) * info.h) / Math.max(1, info.w)) : pxToHwp(info.h);
        // 떠 있는 그림은 본문 폭을 넘을 수 있다 (종이 기준으로 놓인 배경 그림 등)
        if (wv > this.bodyW && !it.float) {
          hv = Math.round((hv * this.bodyW) / wv);
          wv = this.bodyW;
        }
        // 떠 있는 그림은 줄 높이에 들지 않는다
        if (!it.float) pb.maxSize = Math.max(pb.maxSize, hv / 100);
        const binId = info.binId;
        const crop = it.crop;
        const ow = pxToHwp(info.w);
        const oh = pxToHwp(info.h);
        const fl = it.float || null;
        pb.ctrls.push((w, lv) => this.picture(w, lv, wv, hv, binId, ow, oh, crop, fl, paraLeft, sb));
      } else if (it.type === 'shape') {
        if (!this.canWriteShape(it.d)) continue;
        this.setShape(pb, this.reg.char(it.style));
        this.ctrlChars(pb, 11, 'gso ');
        if (!it.float) pb.maxSize = Math.max(pb.maxSize, pxToHwp(it.height) / 100);
        pb.ctrls.push((w, lv) => this.shapeCtrl(w, lv, it, paraLeft, sb));
      } else if (it.type === 'footnote') {
        this.setShape(pb, this.reg.char(it.style));
        this.ctrlChars(pb, 17, 'fn  ');
        const no = ++this.footNo;
        const text = it.text;
        pb.ctrls.push((w, lv) => this.footnote(w, lv, no, text));
      }
    }
    endLink();
  }

  private picture(w: RecWriter, lv: number, wv: number, hv: number, binId: number, ow = wv, oh = hv, crop: { t: number; r: number; b: number; l: number } | null = null, fl: FlatFloat | null = null, paraLeft = 0, sb = 0) {
    const id = inst();
    // 개체 공통 속성: 글자처럼 취급(bit0) 또는 떠 있는 자리
    w.rec(TAG.CTRL_HEADER, lv, this.objHeader('gso ', fl, wv, hv, paraLeft, sb).u32(id).u32(0).u16(0).out());
    const sc = new Buf().u32(ctrlId('$pic')).u32(ctrlId('$pic')).i32(0).i32(0).u16(0).u16(1).u32(wv).u32(hv).u32(wv).u32(hv).u32(0).i16(0).i32(Math.round(wv / 2)).i32(Math.round(hv / 2)).u16(1);
    const ident = [1, 0, 0, 0, 1, 0];
    for (let k = 0; k < 3; k++) ident.forEach((v) => sc.f64(v));
    w.rec(TAG.SHAPE_COMPONENT, lv + 1, sc.out());
    this.pictureRec(w, lv + 2, wv, hv, binId, ow, oh, crop, id);
  }

  /** 그림 레코드: 테두리(12), 네 꼭짓점, 자르기(원본 좌표), 안 여백, 밝기·명암·효과, BinData 번호 … */
  private pictureRec(w: RecWriter, lv: number, wv: number, hv: number, binId: number, ow: number, oh: number, crop: { t: number; r: number; b: number; l: number } | null, id: number) {
    const c = crop || { t: 0, r: 0, b: 0, l: 0 };
    const pic = new Buf()
      .u32(0)
      .i32(0)
      .u32(0)
      .i32(0)
      .i32(0)
      .i32(wv)
      .i32(0)
      .i32(wv)
      .i32(hv)
      .i32(0)
      .i32(hv)
      .i32(Math.round(ow * c.l))
      .i32(Math.round(oh * c.t))
      .i32(Math.round(ow * (1 - c.r)))
      .i32(Math.round(oh * (1 - c.b)))
      .u16(0)
      .u16(0)
      .u16(0)
      .u16(0)
      .i8(0)
      .i8(0)
      .u8(0)
      .u16(binId)
      .u8(0)
      .u32(id)
      .u32(0)
      .u32(ow)
      .u32(oh)
      .u8(0);
    w.rec(TAG.SHAPE_COMPONENT_PICTURE, lv, pic.out());
  }

  private footnote(w: RecWriter, lv: number, no: number, text: string) {
    w.rec(TAG.CTRL_HEADER, lv, new Buf().u32(ctrlId('fn  ')).u32(no).u16(0).u16(0x29).u32(0).u32(inst()).out());
    w.rec(TAG.LIST_HEADER, lv + 1, new Buf().i16(1).u32(0).u16(0).zeros(8).out());
    const c = defaultChar();
    c.size = 9;
    const pb = this.beginPara();
    this.setShape(pb, this.reg.char(c));
    pb.maxSize = 9;
    this.ctrlChars(pb, 18, 'atno');
    pb.ctrls.push((ww, l2) => ww.rec(TAG.CTRL_HEADER, l2, new Buf().u32(ctrlId('atno')).u32(1).u16(no).u16(0).u16(0).u16(0x29).out()));
    for (const ch of ' ' + text) if (ch.charCodeAt(0) >= 32) pb.text.push(ch.charCodeAt(0));
    const pp = defaultPara();
    pp.lineHeight = '1.3';
    // 각주 문단은 부모 문단보다 한 단계 아래
    const saved = this.w;
    this.w = w;
    this.emitPara(pb, this.reg.para(pp), lv + 1, true);
    this.w = saved;
  }

  private headerFooter(w: RecWriter, lv: number, kind: 'head' | 'foot', text: string, align: string, heightHwp: number, rich: FlatBlock[] | null = null) {
    w.rec(TAG.CTRL_HEADER, lv, new Buf().u32(ctrlId(kind)).u32(0).u32(1).out());
    if (rich && rich.length) {
      // 표·그림이 든 머리말/꼬리말: 본문과 같은 방식으로 문단·표를 쓴다 (문단 수 = 최상위 블록 수)
      w.rec(TAG.LIST_HEADER, lv + 1, new Buf().i16(rich.length).u32(kind === 'foot' ? 0x00400000 : 0).u16(0).u32(this.bodyW).u32(heightHwp).zeros(18).out());
      const saved = this.w;
      this.w = w;
      this.inHF = true;
      try {
        this.blocks(rich, lv + 1);
      } finally {
        this.inHF = false;
        this.w = saved;
      }
      return;
    }
    w.rec(TAG.LIST_HEADER, lv + 1, new Buf().i16(1).u32(kind === 'foot' ? 0x00400000 : 0).u16(0).u32(this.bodyW).u32(heightHwp).zeros(18).out());
    const c = defaultChar();
    c.size = 9;
    const pb = this.beginPara();
    this.setShape(pb, this.reg.char(c));
    pb.maxSize = 9;
    for (const part of text.split(/(\{\{PAGE\}\}|\{\{PAGES\}\})/)) {
      if (part === '{{PAGE}}') {
        this.ctrlChars(pb, 18, 'atno');
        pb.ctrls.push((ww, l2) => ww.rec(TAG.CTRL_HEADER, l2, new Buf().u32(ctrlId('atno')).u32(0).u16(1).u16(0).u16(0).u16(0).out()));
      } else if (part === '{{PAGES}}') {
        for (const ch of String(this.pageCount)) pb.text.push(ch.charCodeAt(0));
      } else for (const ch of part) if (ch.charCodeAt(0) >= 32) pb.text.push(ch.charCodeAt(0));
    }
    const pp = defaultPara();
    pp.align = align as any;
    const saved = this.w;
    this.w = w;
    this.emitPara(pb, this.reg.para(pp), lv + 1, true);
    this.w = saved;
  }

  pageCount = 1;

  /** 첫 문단: 구역/단 정의, 머리말·꼬리말, 쪽 번호 */
  private sectionCtrls(pb: ParaBuild) {
    const s = this.doc.settings;
    const pg = s.page;
    this.ctrlChars(pb, 2, 'secd');
    pb.ctrls.push((w, lv) => {
      const secd = hex('64 63 65 73 00 00 00 00 6e 04 00 00 00 00 40 1f 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 00');
      new DataView(secd.buffer).setUint16(20, s.pageNumber.start !== 1 ? s.pageNumber.start : 0, true);
      // 구역 속성: bit 2 첫 쪽에 바탕쪽 감춤, 3 테두리 감춤, 4 배경 감춤, 8 첫 쪽에만 테두리, 9 첫 쪽에만 배경
      const border = s.pageBorder;
      let sp = s.hideFirst?.masterPage ? 1 << 2 : 0;
      if (border?.borderOn === 'notFirst') sp |= 1 << 3;
      if (border?.borderOn === 'first') sp |= 1 << 8;
      if (border?.fillOn === 'notFirst') sp |= 1 << 4;
      if (border?.fillOn === 'first') sp |= 1 << 9;
      new DataView(secd.buffer).setUint32(4, sp, true);
      w.rec(TAG.CTRL_HEADER, lv, secd);
      w.rec(
        TAG.PAGE_DEF,
        lv + 1,
        new Buf()
          .u32(mmToHwp(pg.width))
          .u32(mmToHwp(pg.height))
          .u32(mmToHwp(pg.marginLeft))
          .u32(mmToHwp(pg.marginRight))
          .u32(mmToHwp(pg.marginTop))
          .u32(mmToHwp(pg.marginBottom))
          .u32(mmToHwp(pg.marginHeader))
          .u32(mmToHwp(pg.marginFooter))
          .u32(mmToHwp(pg.gutter))
          .u32(pg.landscape ? 1 : 0)
          .out(),
      );
      w.rec(TAG.FOOTNOTE_SHAPE, lv + 1, hex('00 00 00 00 00 00 00 00 29 00 01 00 ff ff ff ff 52 03 37 02 1b 01 01 01 00 00 00 00'));
      w.rec(TAG.FOOTNOTE_SHAPE, lv + 1, hex('00 00 00 00 00 00 00 00 29 00 01 00 f8 2f e0 00 52 03 37 02 00 00 01 01 00 00 00 00'));
      // 쪽 테두리/배경 (양쪽·짝수·홀수): 속성(bit 0 위치 기준, 1 머리말 포함, 2 꼬리말 포함, 3~4 채울 영역), 간격, 테두리/배경 번호
      if (border) {
        const sides = border.sides || {};
        const noBorders = (['l', 'r', 't', 'b'] as const).filter((k) => !sides[k]);
        const css = (['t', 'b', 'l', 'r'] as const)
          .filter((k) => sides[k])
          .map((k) => `${k}:${Math.max(0.1, +sides[k]!.w || 0.12)}mm ${sides[k]!.s} ${sides[k]!.c}`)
          .join(';');
        const img = border.image ? this.images.get(border.image) : null;
        const bf = this.reg.bf({ bg: border.bg || null, noBorders, borders: noBorders.length < 4, css: css || null, img: img ? { binId: img.binId, mode: border.imageMode || 'TOTAL' } : null });
        const prop = (border.body ? 1 : 0) | (border.headerInside ? 2 : 0) | (border.footerInside ? 4 : 0) | ((border.fillArea === 'border' ? 2 : border.fillArea === 'page' ? 1 : 0) << 3);
        const off = [0, 1, 2, 3].map((i) => Math.max(0, Math.min(65535, mmToHwp(+border.offset?.[i] || 0))));
        w.rec(TAG.PAGE_BORDER_FILL, lv + 1, new Buf().u32(prop).u16(off[0]).u16(off[1]).u16(off[2]).u16(off[3]).u16(bf).out());
      } else w.rec(TAG.PAGE_BORDER_FILL, lv + 1, hex('01 00 00 00 89 05 89 05 89 05 89 05 01 00'));
      for (let i = 0; i < 2; i++) w.rec(TAG.PAGE_BORDER_FILL, lv + 1, hex('01 00 00 00 89 05 89 05 89 05 89 05 01 00'));
      // 바탕쪽: 문단 목록(문단 수, 속성, 글 폭, 글 높이)과 그 문단들. 양쪽 바탕쪽만 쓴다 (목록의 차례가 적용 쪽을 정한다)
      const mp = (s.masterPages || []).find((x) => x.type === 'both');
      const mBlocks = mp ? unwrapBoxes(flattenContent((mp.content || []) as any)) : [];
      if (mBlocks.length) {
        const pgH = pg.landscape ? Math.min(pg.width, pg.height) : pg.height;
        const bodyH = mmToHwp(pgH - pg.marginTop - pg.marginBottom - pg.marginHeader - pg.marginFooter);
        w.rec(TAG.LIST_HEADER, lv + 1, new Buf().i32(mBlocks.length).u32(0).u32(this.bodyW).u32(bodyH).zeros(18).out());
        const saved = this.w;
        this.w = w;
        this.inHF = true;
        try {
          this.blocks(mBlocks, lv + 1);
        } finally {
          this.inHF = false;
          this.w = saved;
        }
      }
    });
    this.ctrlChars(pb, 2, 'cold');
    pb.ctrls.push((w, lv) => w.rec(TAG.CTRL_HEADER, lv, hex('64 6c 6f 63 04 10 00 00 00 00 00 00 00 00 00 00')));
    const hfHeight = (mm: number) => Math.max(1000, mmToHwp(mm));
    if (s.header.text.trim()) {
      this.ctrlChars(pb, 16, 'head');
      const t = s.header.text;
      const a = s.header.align;
      const rich = richHF(s.header);
      pb.ctrls.push((w, lv) => this.headerFooter(w, lv, 'head', t, a, hfHeight(pg.marginHeader), rich));
    }
    if (s.footer.text.trim()) {
      this.ctrlChars(pb, 16, 'foot');
      const t = s.footer.text;
      const a = s.footer.align;
      const rich = richHF(s.footer);
      pb.ctrls.push((w, lv) => this.headerFooter(w, lv, 'foot', t, a, hfHeight(pg.marginFooter), rich));
    }
    if (s.pageNumber.pos !== 'none') {
      const POS: Record<string, number> = { 'top-left': 1, 'top-center': 2, 'top-right': 3, 'bottom-left': 4, 'bottom-center': 5, 'bottom-right': 6 };
      const fmt = s.pageNumber.format === 'roman' ? 3 : s.pageNumber.format === 'ROMAN' ? 2 : 0;
      const attr = fmt | ((POS[s.pageNumber.pos] || 5) << 8);
      this.ctrlChars(pb, 21, 'pgnp');
      const dash = s.pageNumber.format === 'dash' ? 0x2d : 0;
      pb.ctrls.push((w, lv) => w.rec(TAG.CTRL_HEADER, lv, new Buf().u32(ctrlId('pgnp')).u32(attr).u16(0).u16(0).u16(0).u16(dash).out()));
    }
  }

  para(p: FlatPara, level: number, last: boolean, first = false) {
    const pb = this.beginPara();
    pb.maxSize = p.baseChar.size;
    this.setShape(pb, this.reg.char(p.baseChar));
    if (first) this.sectionCtrls(pb);
    this.inlines(pb, p.inlines, level, (p.style.indentLeft + Math.max(0, -p.style.textIndent)) * PT2PX, p.style.spaceBefore * PT2PX);
    this.emitPara(pb, this.reg.para(p.style), level, last, first ? 3 : p.pageBreakBefore && level === 0 ? 4 : 0);
  }

  table(t: FlatTable, level: number, last: boolean, first = false) {
    const pb = this.beginPara();
    this.setShape(pb, 0);
    // 문서가 표로 시작하면 구역 정의를 표가 든 문단에 함께 둔다 (따로 빈 문단을 두면 그 줄만큼 본문이 내려간다)
    if (first) this.sectionCtrls(pb);
    this.ctrlChars(pb, 11, 'tbl ');
    pb.ctrls.push((w, lv) => this.tableCtrl(w, lv, t));
    const pp = defaultPara();
    if (t.align !== 'left') pp.align = t.align as any;
    // 글자처럼 놓인 표의 줄: 줄 간격이 160% 면 표 아래에 글자 크기의 60% 만큼 빈자리가 더 생긴다
    if (t.inline) pp.lineHeight = '1';
    this.emitPara(pb, this.reg.para(pp), level, last, first ? 3 : t.pageBreakBefore && level === 0 ? 4 : 0);
  }

  private tableCtrl(w: RecWriter, lv: number, t: FlatTable) {
    const totalPx = t.colWidthsPx.reduce((a, b) => a + b, 0) || 1;
    const scale = Math.min(1, this.bodyW / pxToHwp(totalPx));
    const colW = t.colWidthsPx.map((x) => Math.round(pxToHwp(x) * scale));
    const tableW = colW.reduce((a, b) => a + b, 0);
    const rowHs = Array.from({ length: t.rows }, (_, i) => (t.rowHeightsPx?.[i] ? Math.max(283, pxToHwp(t.rowHeightsPx[i]!) + 282) : 1000));
    const spanH = (r: number, n: number) => rowHs.slice(r, r + n).reduce((a, b) => a + b, 0);
    const pad = pxToHwp(t.cellPadPx);
    // 글자처럼 취급(bit 0)이면 표가 든 문단의 정렬을, 아니면 가로 정렬(bit 10~12)을 따른다. 바깥 여백은 읽은 값 그대로
    // 바깥 여백: 한글에서 읽은 표는 그 값, Kite 에서 만든 표는 화면과 같이 0 (HWPX 와 같은 기본값)
    const om = t.outMarginPx ? t.outMarginPx.map((v) => pxToHwp(v)) : [0, 0, 0, 0];
    const objAttr = t.inline ? 0x082a2211 : (0x082a2210 | ((t.align === 'center' ? 1 : t.align === 'right' ? 2 : 0) << 10)) >>> 0;
    w.rec(TAG.CTRL_HEADER, lv, new Buf().u32(ctrlId('tbl ')).u32(objAttr).i32(0).i32(0).u32(tableW).u32(spanH(0, t.rows)).i32(0).u16(om[0]).u16(om[1]).u16(om[2]).u16(om[3]).u32(inst()).u32(0).u16(0).out());
    // 표 속성: bit 0~1 쪽 경계에서 나눔(0 나누지 않음, 1 셀 단위로 나눔, 2 나눔), bit 2 제목 줄 자동 반복
    const tb = new Buf().u32(0x04000004 | (t.pageSplit === 'row' ? 1 : t.pageSplit === 'none' ? 0 : 2)).u16(t.rows).u16(t.cols).u16(0).u16(pad).u16(pad).u16(141).u16(141);
    for (const row of t.cells) tb.u16(row.length);
    tb.u16(3).u16(0);
    w.rec(TAG.TABLE, lv + 1, tb.out());
    for (const row of t.cells) {
      for (const cell of row) {
        const bf = this.reg.bf({ bg: cell.bg, noBorders: cell.noBorders, borders: cell.noBorders.length < 4, css: cell.borderCss });
        const cw = colW.slice(cell.col, cell.col + cell.colspan).reduce((a, b) => a + b, 0);
        const va = cell.vAlign === 'top' ? 0 : cell.vAlign === 'bottom' ? 2 : 1;
        const blocks = cell.blocks.length ? cell.blocks : [{ kind: 'para', style: defaultPara(), baseChar: defaultChar(), inlines: [], pageBreakBefore: false } as FlatPara];
        const nParas = blocks.length;
        w.rec(
          TAG.LIST_HEADER,
          lv + 1,
          new Buf()
            .i16(nParas)
            .u32(va << 21)
            // 칸 자체 여백(bit 0), 제목 칸(bit 2)
            .u16((cell.header ? 4 : 0) | (cell.marginsPx ? 1 : 0))
            .u16(cell.col)
            .u16(cell.row)
            .u16(cell.colspan)
            .u16(cell.rowspan)
            .u32(cw)
            .u32(spanH(cell.row, cell.rowspan))
            .u16(cell.marginsPx ? pxToHwp(cell.marginsPx[0]) : pad)
            .u16(cell.marginsPx ? pxToHwp(cell.marginsPx[1]) : pad)
            .u16(cell.marginsPx ? pxToHwp(cell.marginsPx[2]) : 141)
            .u16(cell.marginsPx ? pxToHwp(cell.marginsPx[3]) : 141)
            .u16(bf)
            .u32(cw)
            .zeros(9)
            .out(),
        );
        const saved = this.w;
        this.w = w;
        this.blocks(blocks, lv + 1);
        this.w = saved;
      }
    }
  }

  blocks(blocks: FlatBlock[], level: number, topLevel = false) {
    blocks.forEach((b, i) => {
      const last = i === blocks.length - 1;
      if (b.kind === 'para') this.para(b, level, last, topLevel && i === 0);
      else if (b.kind === 'table') this.table(b, level, last, topLevel && i === 0);
      else this.blocks(b.blocks, level, false);
    });
  }
}

/** 표·그림이 든 머리말/꼬리말의 블록 (없으면 null) */
function richHF(def: HeaderFooter): FlatBlock[] | null {
  if (!Array.isArray(def.content) || !def.content.length) return null;
  try {
    return unwrapBoxes(flattenDoc({ type: 'doc', content: def.content } as JNode));
  } catch {
    return null;
  }
}

function collectImages(blocks: FlatBlock[], out: Set<string>) {
  for (const b of blocks) {
    if (b.kind === 'para') {
      for (const i of b.inlines) {
        if (i.type === 'image' && i.src) out.add(i.src);
        else if (i.type === 'shape') {
          shapeImageSrcs(i.d, out);
          // 도형 안 글에 든 그림
          for (const it of i.d.items) if (it.k === 'text' && it.content) collectImages(flattenContent(it.content), out);
        }
      }
    } else if (b.kind === 'box') collectImages(b.blocks, out);
    else for (const row of b.cells) for (const c of row) collectImages(c.blocks, out);
  }
}

function previewText(blocks: FlatBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (out.join('').length > 1000) break;
    if (b.kind === 'para') out.push(b.inlines.map((i) => (i.type === 'text' ? i.text : '')).join(''));
  }
  return out.join('\r\n').slice(0, 1024);
}

export async function writeHwp(doc: KDocument, opts: { pageCount?: number } = {}): Promise<Uint8Array> {
  // 글상자는 아직 HWP 바이너리로 쓰지 않으므로 안의 문단만 남긴다
  const blocks = unwrapBoxes(flattenDoc(doc.content as JNode));
  if (!blocks.length || (blocks[0].kind !== 'para' && blocks[0].kind !== 'table')) blocks.unshift({ kind: 'para', style: defaultPara(), baseChar: defaultChar(), inlines: [], pageBreakBefore: false });
  const reg = new Registry();
  const pg = doc.settings.page;
  const pageW = pg.landscape ? Math.max(pg.width, pg.height) : pg.width;
  const bodyW = mmToHwp(pageW - pg.marginLeft - pg.marginRight - pg.gutter);

  const srcs = new Set<string>();
  collectImages(blocks, srcs);
  for (const hf of [doc.settings.header, doc.settings.footer]) collectImages(richHF(hf) || [], srcs);
  if (doc.settings.pageBorder?.image) srcs.add(doc.settings.pageBorder.image);
  for (const mp of doc.settings.masterPages || []) collectImages(flattenContent((mp.content || []) as any), srcs);
  const images = new Map<string, { binId: number; w: number; h: number } | null>();
  for (const src of srcs) {
    const img = await prepareImage(src);
    if (!img) {
      images.set(src, null);
      continue;
    }
    const id = reg.bins.length + 1;
    reg.bins.push({ id, ext: img.ext === 'jpeg' ? 'jpg' : img.ext, bytes: img.bytes });
    images.set(src, { binId: id, w: img.width, h: img.height });
  }

  const body = new BodyWriter(reg, doc, images, bodyW);
  body.pageCount = opts.pageCount || 1;
  body.blocks(blocks, 0, true);
  const section = body.w.out();
  const info = docInfo(reg);

  // FileHeader (256 바이트)
  const fh = new Uint8Array(256);
  fh.set(new TextEncoder().encode('HWP Document File'));
  const dv = new DataView(fh.buffer);
  dv.setUint32(32, 0x05010001, true); // 5.1.0.1
  dv.setUint32(36, 1, true); // 압축
  dv.setUint32(44, 4, true);

  const cfb = CFB.utils.cfb_new();
  const add = (name: string, data: Uint8Array) => CFB.utils.cfb_add(cfb, name, data as any);
  add('/FileHeader', fh);
  add('/DocInfo', deflateRaw(info));
  add('/BodyText/Section0', deflateRaw(section));
  for (const b of reg.bins) add(`/BinData/BIN${b.id.toString(16).toUpperCase().padStart(4, '0')}.${b.ext}`, deflateRaw(b.bytes));
  const prv = previewText(blocks);
  const prvBuf = new Uint8Array(prv.length * 2 + 2);
  for (let i = 0; i < prv.length; i++) new DataView(prvBuf.buffer).setUint16(i * 2, prv.charCodeAt(i), true);
  add('/PrvText', prvBuf);
  try {
    CFB.utils.cfb_del(cfb, '/\u0001Sh33tJ5');
  } catch {
    /* 없음 */
  }
  const out = CFB.write(cfb, { type: 'array', fileType: 'cfb' }) as any;
  return out instanceof Uint8Array ? out : Uint8Array.from(out);
}
