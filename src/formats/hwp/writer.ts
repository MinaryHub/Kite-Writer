import * as CFB from 'cfb';
import { deflateRaw } from 'pako';
import type { HeaderFooter, KDocument } from '../../types';
import { type JNode, mmToHwp, pxToHwp, ptToHwp, parseBorderCss, HWP_BORDER_WIDTHS, FIXED_SPACE } from '../common';
import { type CharStyle, type FlatBlock, type FlatInline, type FlatPara, type FlatTable, type ParaStyle, charKey, langFontIds, defaultChar, defaultPara, flattenDoc, paraKey, unwrapBoxes } from '../flatten';
import { prepareImage } from '../imageUtil';

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
      if (p.bg || p.borderBottom) bf = this.bf({ bg: p.bg, noBorders: p.borderBottom ? ['l', 'r', 't'] : ['l', 'r', 't', 'b'], borders: p.borderBottom });
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
  for (let i = 0; i < 7; i++) b.i8(0);
  b.i32(ptToHwp(c.size));
  let attr = 0;
  if (c.italic) attr |= 1;
  if (c.bold) attr |= 2;
  if (c.underline) attr |= 1 << 2;
  if (c.effect === 'outline') attr |= 1 << 8;
  if (c.effect === 'shadow') attr |= 1 << 11;
  if (c.effect === 'emboss') attr |= 1 << 13;
  if (c.effect === 'engrave') attr |= 1 << 14;
  if (c.sup) attr |= 1 << 15;
  if (c.sub) attr |= 1 << 16;
  if (c.strike) attr |= 1 << 18;
  b.u32(attr);
  b.i8(10).i8(10);
  b.u32(rgb(c.color));
  b.u32(0); // 밑줄 색
  b.u32(c.highlight ? rgb(c.highlight) : 0xffffffff); // 음영 색
  b.u32(0xc0c0c0); // 그림자 색
  b.u16(2); // 글자 테두리/배경
  b.u32(0); // 취소선 색
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
  const attr1 = 0x100 | (p.breakChar ? 0x80 : 0) | ((ALIGN[p.align] ?? 0) << 2) | (lsType === 1 ? 1 : 0);
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
  b.i16(0).i16(0).i16(0).i16(0);
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
  if (d.bg) {
    b.u32(1).u32(rgb(d.bg)).u32(0x999999).i32(-1);
    b.u32(0).u8(0);
  } else b.u32(0).u32(0);
  return b.out();
}

function docInfo(reg: Registry, pageNumChar: number | null = null): Uint8Array {
  const w = new RecWriter();
  w.rec(TAG.DOCUMENT_PROPERTIES, 0, new Buf().u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).u16(1).u32(0).u32(0).u32(0).out());
  const nf = reg.fonts.length;
  const ids = new Buf();
  [reg.bins.length, nf, nf, nf, nf, nf, nf, nf, reg.bfs.length, reg.chars.length, 2, 1, 0, reg.paras.length, pageNumChar == null ? 1 : 2, 0, 0, 0].forEach((v) => ids.i32(v));
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
  // 쪽 번호는 '쪽 번호' 스타일의 글자 모양으로 찍힌다 (한글도, Kite 도)
  if (pageNumChar != null) w.rec(TAG.STYLE, 1, new Buf().wstr('쪽 번호').wstr('Page Number').u8(0).u8(1).i16(0x412).u16(0).u16(pageNumChar).u16(0).out());
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

  private inlines(pb: ParaBuild, list: FlatInline[], level: number) {
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
      if (it.type === 'text') {
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
        if (wv > this.bodyW) {
          hv = Math.round((hv * this.bodyW) / wv);
          wv = this.bodyW;
        }
        pb.maxSize = Math.max(pb.maxSize, hv / 100);
        const binId = info.binId;
        const crop = it.crop;
        const ow = pxToHwp(info.w);
        const oh = pxToHwp(info.h);
        pb.ctrls.push((w, lv) => this.picture(w, lv, wv, hv, binId, ow, oh, crop));
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

  private picture(w: RecWriter, lv: number, wv: number, hv: number, binId: number, ow = wv, oh = hv, crop: { t: number; r: number; b: number; l: number } | null = null) {
    const c = crop || { t: 0, r: 0, b: 0, l: 0 };
    const id = inst();
    // 개체 공통 속성: 글자처럼 취급(bit0)
    w.rec(
      TAG.CTRL_HEADER,
      lv,
      new Buf().u32(ctrlId('gso ')).u32(0x042a2211).i32(0).i32(0).u32(wv).u32(hv).i32(0).u16(0).u16(0).u16(0).u16(0).u32(id).u32(0).u16(0).out(),
    );
    const sc = new Buf().u32(ctrlId('$pic')).u32(ctrlId('$pic')).i32(0).i32(0).u16(0).u16(1).u32(wv).u32(hv).u32(wv).u32(hv).u32(0).i16(0).i32(Math.round(wv / 2)).i32(Math.round(hv / 2)).u16(1);
    const ident = [1, 0, 0, 0, 1, 0];
    for (let k = 0; k < 3; k++) ident.forEach((v) => sc.f64(v));
    w.rec(TAG.SHAPE_COMPONENT, lv + 1, sc.out());
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
    w.rec(TAG.SHAPE_COMPONENT_PICTURE, lv + 2, pic.out());
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
      for (let i = 0; i < 3; i++) w.rec(TAG.PAGE_BORDER_FILL, lv + 1, hex('01 00 00 00 89 05 89 05 89 05 89 05 01 00'));
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
    this.inlines(pb, p.inlines, level);
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
    const tb = new Buf().u32(0x04000006).u16(t.rows).u16(t.cols).u16(0).u16(pad).u16(pad).u16(141).u16(141);
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
      for (const i of b.inlines) if (i.type === 'image' && i.src) out.add(i.src);
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
  const pn = doc.settings.pageNumber;
  const pnChar = pn.fontSize && pn.fontSize > 0 ? reg.char({ ...defaultChar(), font: pn.fontFamily || '함초롬돋움', size: pn.fontSize, bold: !!pn.bold, italic: !!pn.italic, color: pn.color || '#000000' }) : null;
  const info = docInfo(reg, pnChar);

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
