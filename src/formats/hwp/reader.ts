import { hwpToLatex } from '../../math/hwpEq';
import * as CFB from 'cfb';
import { Inflate } from 'pako';
import type { LoadedDoc, PageSetup } from '../../types';
import {
  type JNode,
  applyNumFormat,
  bytesToDataUrl,
  colorRefToHex,
  defaultSettings,
  docNode,
  hwpToMm,
  hwpToPt,
  hwpToPx,
  isBrowserImage,
  mimeFromExt,
  NumberingCounter,
  paragraph,
  placeholderImage,
  round,
  textNode,
  HWP_NUM_FORMATS,
  HWP_BORDER_WIDTHS,
  hwpBorderStyle,
  borderCss,
  normCrop,
  type BorderSide,
  FIXED_SPACE,
} from '../common';
import { charMarks, paraAttrs, imgFillFit, langFontsOf, gradientCss, type CharPr, type ParaPr, type BorderFill, type Numbering } from '../hwpx/reader';

/**
 * HWP 5.0 (바이너리, OLE 복합 문서) 읽기.
 * 참고: 한글과컴퓨터 "한글 문서 파일 형식 5.0" 공개 문서.
 */

// ---------- 레코드 ----------
const T = {
  DOCUMENT_PROPERTIES: 16,
  ID_MAPPINGS: 17,
  BIN_DATA: 18,
  FACE_NAME: 19,
  BORDER_FILL: 20,
  CHAR_SHAPE: 21,
  TAB_DEF: 22,
  NUMBERING: 23,
  BULLET: 24,
  PARA_SHAPE: 25,
  STYLE: 26,
  PARA_HEADER: 66,
  PARA_TEXT: 67,
  PARA_CHAR_SHAPE: 68,
  PARA_LINE_SEG: 69,
  CTRL_HEADER: 71,
  LIST_HEADER: 72,
  PAGE_DEF: 73,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  SHAPE_COMPONENT_RECTANGLE: 79,
  SHAPE_COMPONENT_ELLIPSE: 80,
  SHAPE_COMPONENT_PICTURE: 85,
  SHAPE_COMPONENT_CONTAINER: 86,
  CTRL_DATA: 87,
  EQEDIT: 88,
};

interface Rec {
  tag: number;
  level: number;
  data: Uint8Array;
  dv: DataView;
  children: Rec[];
}

function parseRecords(buf: Uint8Array): Rec[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: Rec[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const h = dv.getUint32(off, true);
    off += 4;
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (off + 4 > buf.length) break;
      size = dv.getUint32(off, true);
      off += 4;
    }
    const data = buf.subarray(off, Math.min(buf.length, off + size));
    out.push({ tag, level, data, dv: new DataView(data.buffer, data.byteOffset, data.byteLength), children: [] });
    off += size;
  }
  return out;
}

function buildTree(recs: Rec[]): Rec[] {
  const roots: Rec[] = [];
  const stack: Rec[] = [];
  for (const r of recs) {
    while (stack.length && stack[stack.length - 1].level >= r.level) stack.pop();
    if (stack.length) stack[stack.length - 1].children.push(r);
    else roots.push(r);
    stack.push(r);
  }
  return roots;
}

const u8 = (r: Rec, o: number) => (o < r.data.length ? r.data[o] : 0);
const u16 = (r: Rec, o: number) => (o + 2 <= r.data.length ? r.dv.getUint16(o, true) : 0);
const u32 = (r: Rec, o: number) => (o + 4 <= r.data.length ? r.dv.getUint32(o, true) : 0);
const i32 = (r: Rec, o: number) => (o + 4 <= r.data.length ? r.dv.getInt32(o, true) : 0);
const i8 = (r: Rec, o: number) => (o < r.data.length ? r.dv.getInt8(o) : 0);

function wstr(r: Rec, o: number): { s: string; end: number } {
  const len = u16(r, o);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(u16(r, o + 2 + i * 2));
  return { s, end: o + 2 + len * 2 };
}

function ctrlIdOf(r: Rec): string {
  const v = u32(r, 0);
  return String.fromCharCode((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
}

const MAX_INFLATED = 256 * 1024 * 1024;
/** 풀린 크기에 상한을 두는 inflate (압축률 1000:1 의 폭탄 방어) */
function inflateCapped(data: Uint8Array, raw: boolean): Uint8Array {
  const inf = new Inflate({ raw });
  const chunks: Uint8Array[] = [];
  let total = 0;
  inf.onData = (chunk: Uint8Array) => {
    total += chunk.length;
    if (total > MAX_INFLATED) throw new Error('압축을 푼 데이터가 너무 큽니다.');
    chunks.push(chunk);
  };
  inf.push(data, true);
  if (inf.err) throw new Error(inf.msg || 'inflate 실패');
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function decompress(data: Uint8Array, compressed: boolean): Uint8Array {
  if (!compressed) return data;
  try {
    return inflateCapped(data, true);
  } catch (e: any) {
    if (/너무 큽니다/.test(String(e?.message))) throw e;
    try {
      return inflateCapped(data, false);
    } catch (e2: any) {
      if (/너무 큽니다/.test(String(e2?.message))) throw e2;
      return data;
    }
  }
}

/** 그림 채우기 방식 번호 → HWPX 이름 */
const IMG_FILL_MODES = ['TILE', 'TILE_HORZ_TOP', 'TILE_HORZ_BOTTOM', 'TILE_VERT_LEFT', 'TILE_VERT_RIGHT', 'TOTAL', 'CENTER', 'CENTER_TOP', 'CENTER_BOTTOM', 'LEFT_CENTER', 'LEFT_TOP', 'LEFT_BOTTOM', 'RIGHT_CENTER', 'RIGHT_TOP', 'RIGHT_BOTTOM', 'ZOOM'];

// ---------- DocInfo ----------
interface DocInfo {
  charPrs: CharPr[];
  paraPrs: ParaPr[];
  borderFills: BorderFill[]; // 1부터 시작하는 id → index id-1
  numberings: Numbering[]; // 1부터
  bullets: string[]; // 1부터
  binData: Map<number, { ext: string; compress: number }>;
}

function parseDocInfo(recs: Rec[]): DocInfo {
  const info: DocInfo = { charPrs: [], paraPrs: [], borderFills: [], numberings: [], bullets: [], binData: new Map() };
  let counts: number[] = [];
  const fonts: string[][] = [[], [], [], [], [], [], []];
  let faceIdx = 0;
  for (const r of recs) {
    switch (r.tag) {
      case T.ID_MAPPINGS:
        counts = [];
        for (let o = 0; o + 4 <= r.data.length; o += 4) counts.push(i32(r, o));
        break;
      case T.FACE_NAME: {
        // 언어별 순서: 한글, 영문, 한자, 일어, 기타, 기호, 사용자
        let lang = 0;
        let acc = 0;
        for (let l = 0; l < 7; l++) {
          acc += counts[1 + l] || 0;
          if (faceIdx < acc) {
            lang = l;
            break;
          }
        }
        fonts[lang].push(wstr(r, 1).s);
        faceIdx++;
        break;
      }
      case T.BORDER_FILL: {
        const noBorders: string[] = [];
        const sides: Record<string, BorderSide> = {};
        ['l', 'r', 't', 'b'].forEach((side, i) => {
          const type = u8(r, 2 + i * 6);
          if (type === 0) noBorders.push(side);
          else sides[side] = { w: HWP_BORDER_WIDTHS[u8(r, 3 + i * 6)] ?? 0.12, c: colorRefToHex(u32(r, 4 + i * 6)), s: hwpBorderStyle(type) };
        });
        // 채우기: 종류(4) 뒤에 단색(12) · 그러데이션 · 그림(채우기 방식 1, 밝기 1, 명암 1, 효과 1, BinData 번호 2) 순서
        const fillType = u32(r, 32);
        let bg: string | null = null;
        if (fillType & 1) {
          const c = u32(r, 36);
          if (c !== 0xffffffff && (c & 0xff000000) === 0) bg = colorRefToHex(c);
          if (bg === '#FFFFFF') bg = null;
        }
        let img: BorderFill['img'] = null;
        if (fillType & 2 && !(fillType & 4)) {
          const o = 36 + (fillType & 1 ? 12 : 0);
          const binId = u16(r, o + 4);
          if (binId) img = { id: String(binId), mode: IMG_FILL_MODES[u8(r, o)] || 'TOTAL' };
        }
        // 그러데이션: 종류(1) 기울임(4) 가로 중심(4) 세로 중심(4) 번짐 정도(4) 색 수(4) [색이 3개 이상이면 바뀌는 위치 4×n] 색 4×n
        let gradient: string | null = null;
        if (fillType & 4) {
          const o = 36 + (fillType & 1 ? 12 : 0);
          if (r.data.length >= o + 21) {
            const gt = (['LINEAR', 'LINEAR', 'RADIAL', 'CONICAL', 'SQUARE'] as const)[u8(r, o)] || 'LINEAR';
            const angle = u32(r, o + 1) | 0;
            const cx = u32(r, o + 5) | 0;
            const cy = u32(r, o + 9) | 0;
            const n = Math.min(16, u32(r, o + 17));
            let co = o + 21 + (n > 2 ? n * 4 : 0);
            const colors: string[] = [];
            for (let k = 0; k < n && co + 4 <= r.data.length; k++, co += 4) colors.push(colorRefToHex(u32(r, co)) || '');
            gradient = gradientCss(gt, angle, cx, cy, colors);
            if (!bg && colors[0]) bg = colors[0] === '#FFFFFF' ? null : colors[0];
          }
        }
        info.borderFills.push({ bg, noBorders, css: borderCss(sides), img, gradient });
        break;
      }
      case T.CHAR_SHAPE: {
        const faceId = u16(r, 0);
        const ratio = u8(r, 14);
        const spacing = i8(r, 21);
        const relSz = u8(r, 28) || 100;
        const base = i32(r, 42);
        const attr = u32(r, 46);
        const color = u32(r, 52);
        const shade = u32(r, 60);
        const ulType = (attr >>> 2) & 3;
        const outline = (attr >>> 8) & 7;
        const shadow = (attr >>> 11) & 3;
        let effect: string | null = null;
        if (outline) effect = 'outline';
        if (shadow) effect = 'shadow';
        if (attr & (1 << 13)) effect = 'emboss';
        if (attr & (1 << 14)) effect = 'engrave';
        const shadeHex = shade === 0xffffffff || shade & 0xff000000 ? null : colorRefToHex(shade);
        // 언어별 글꼴 번호: 한글(0) 영문(2) 한자(4) 일어(6) 기타(8) 기호(10) 사용자(12)
        const fontFamily = fonts[0][faceId] || fonts[1][u16(r, 2)] || undefined;
        info.charPrs.push({
          fontFamily,
          langFonts: langFontsOf(fontFamily, fonts[1][u16(r, 2)], fonts[2][u16(r, 4)], fonts[5][u16(r, 10)]),
          fontSize: round((base / 100) * (relSz / 100), 1) || 10,
          color: colorRefToHex(color),
          bold: !!(attr & 2),
          italic: !!(attr & 1),
          underline: ulType === 1 || ulType === 3,
          // 새 버전은 '종류=1, 모양=15(없음)'을 기본으로 기록하므로 모양까지 확인
          strike: ((attr >>> 18) & 7) !== 0 && ((attr >>> 26) & 15) !== 15,
          sup: !!(attr & (1 << 15)),
          sub: !!(attr & (1 << 16)),
          highlight: shadeHex && shadeHex !== '#FFFFFF' ? shadeHex : null,
          letterSpacing: spacing || undefined,
          fontWidth: ratio && ratio !== 100 ? ratio : undefined,
          textEffect: effect,
        });
        break;
      }
      case T.PARA_SHAPE: {
        const a1 = u32(r, 0);
        // 여백 값은 2배로 저장됨
        const left = i32(r, 4) / 2;
        const right = i32(r, 8) / 2;
        const indent = i32(r, 12) / 2;
        const prev = i32(r, 16) / 2;
        const next = i32(r, 20) / 2;
        let lsType = a1 & 3;
        let lsVal = i32(r, 24);
        if (r.data.length >= 54) {
          lsType = u32(r, 46) & 0x1f;
          lsVal = u32(r, 50);
        }
        let lineHeight: string | null = null;
        if (lsType === 0) lineHeight = lsVal === 160 || !lsVal ? null : String(round(lsVal / 100, 2));
        else if (lsType === 1 || lsType === 3) lineHeight = `${round(hwpToPt(lsVal / 2), 1)}pt`;
        else if (lsType === 2) lineHeight = String(round(1.2 + hwpToPt(lsVal / 2) / 10, 2));
        const alignCode = (a1 >>> 2) & 7;
        const ALIGN = ['justify', 'left', 'right', 'center', 'distribute', 'distribute'];
        const headingType = (a1 >>> 23) & 3;
        const bfId = u16(r, 32);
        info.paraPrs.push({
          align: ALIGN[alignCode] || null,
          indentLeft: hwpToPt(left),
          indentRight: hwpToPt(right),
          textIndent: hwpToPt(indent),
          spaceBefore: hwpToPt(prev),
          spaceAfter: hwpToPt(next),
          lineHeight,
          headingType: ['NONE', 'OUTLINE', 'NUMBER', 'BULLET'][headingType],
          headingIdRef: String(u16(r, 30)),
          headingLevel: (a1 >>> 25) & 7,
          pageBreakBefore: false,
          bg: bfId ? info.borderFills[bfId - 1]?.bg || null : null,
          // 속성1 bit 7: 줄 나눔 기준 한글 단위 (0 어절, 1 글자)
          breakChar: ((a1 >>> 7) & 1) === 1,
        });
        break;
      }
      case T.NUMBERING: {
        const levels: Numbering['levels'] = [];
        let o = 0;
        for (let l = 0; l < 7 && o + 14 <= r.data.length; l++) {
          const a = u32(r, o);
          o += 12;
          const { s, end } = wstr(r, o);
          o = end;
          levels.push({ text: s, format: HWP_NUM_FORMATS[(a >>> 5) & 0xf] || 'DIGIT', start: 1 });
        }
        const start = u16(r, o);
        o += 2;
        for (let l = 0; l < 7; l++) {
          const st = o + l * 4 + 4 <= r.data.length ? u32(r, o + l * 4) : 0;
          if (levels[l]) levels[l].start = st || start || 1;
        }
        info.numberings.push({ levels });
        break;
      }
      case T.BULLET: {
        const ch = u16(r, 12);
        info.bullets.push(ch >= 0x20 && !(ch >= 0xe000 && ch <= 0xf8ff) ? String.fromCharCode(ch) : '•');
        break;
      }
      case T.BIN_DATA: {
        const a = u16(r, 0);
        const type = a & 0xf;
        if (type === 0) break; // 외부 연결
        const id = u16(r, 2);
        const ext = wstr(r, 4).s;
        info.binData.set(id, { ext, compress: (a >>> 4) & 3 });
        break;
      }
    }
  }
  return info;
}

// ---------- 본문 ----------
const CHAR_CTRL = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
const INLINE_CTRL = new Set([4, 5, 6, 7, 8, 9, 19, 20]);

class HwpConverter {
  outlineNumId = '1';
  counter = new NumberingCounter();
  settingsSet = false;
  /** 지금 읽는 구역의 편집 용지 (구역 정의에서 처음 읽은 것) */
  sectionPage: PageSetup | null = null;
  private linkHref: string | null = null;
  /** 지금 읽는 문단이 놓인 쪽 (0 부터; 쪽 나누기와 줄 정보로 센다) */
  private page = 0;
  private lastVpos = 0;
  private topParas = 0;
  private pageMarks = new HwpPageMarks();
  /** 머리말/꼬리말을 읽는 중 (쪽 번호 필드를 {{PAGE}} 로) */
  private inHF = false;

  constructor(
    private info: DocInfo,
    private images: Map<number, string>,
    public settings = defaultSettings(),
    public warnings: string[] = [],
  ) {}

  private charPr(id: number) {
    return this.info.charPrs[id];
  }

  private numberPrefix(pp: ParaPr): string | null {
    if (pp.headingType === 'NONE') return null;
    if (pp.headingType === 'BULLET') return (this.info.bullets[+pp.headingIdRef - 1] || '•') + ' ';
    const numId = pp.headingType === 'OUTLINE' ? this.outlineNumId : pp.headingIdRef;
    const nb = this.info.numberings[+numId - 1];
    if (!nb) return null;
    const lvl = Math.max(0, Math.min(6, pp.headingLevel));
    const def = nb.levels[lvl];
    if (!def || !def.text) return null;
    const vals = this.counter.next(numId, lvl, def.start || 1);
    return applyNumFormat(def.text, vals, nb.levels.map((l) => l.format)) + ' ';
  }

  convertParagraphs(paras: Rec[], inSub: boolean, bg?: string | null): JNode[] {
    const out: JNode[] = [];
    for (const p of paras) if (p.tag === T.PARA_HEADER) out.push(...this.convertPara(p, inSub, bg));
    return out;
  }

  convertPara(p: Rec, inSub: boolean, bg?: string | null): JNode[] {
    const psId = u16(p, 8);
    const breakType = u8(p, 11);
    const pp = this.info.paraPrs[psId];
    const pAttrs = paraAttrs(pp);
    if (bg && !pAttrs.paraBg) pAttrs.paraBg = bg;
    const blocks: JNode[] = [];
    /** 쪽 나누기 없이 한글이 새 쪽에 놓은 문단 */
    let hwpPage = false;
    let vpos: number | null = null;
    if (!inSub) {
      // 쪽 세기: 쪽 나누기, 또는 한글이 배치해 둔 줄 정보(첫 줄의 세로 위치)가 되돌아가면 새 쪽 (첫 문단 앞은 세지 않는다)
      const seg = p.children.find((c) => c.tag === T.PARA_LINE_SEG);
      vpos = seg && seg.data.length >= 8 ? i32(seg, 4) : null;
      hwpPage = this.topParas > 0 && !(breakType & 0x05) && vpos != null && vpos < this.lastVpos;
      if (this.topParas++ > 0 && (breakType & 0x05 || (vpos != null && vpos < this.lastVpos))) this.page++;
      // 다음 문단과는 이 문단 마지막 줄의 세로 위치로 견준다 (여러 줄 문단은 줄 사이에서 쪽이 바뀔 수 있다)
      if (seg && seg.data.length >= 36) this.lastVpos = i32(seg, (Math.floor(seg.data.length / 36) - 1) * 36 + 4);
      if (breakType & 0x05) blocks.push({ type: 'pageBreak' });
    }

    const textRec = p.children.find((c) => c.tag === T.PARA_TEXT);
    const csRec = p.children.find((c) => c.tag === T.PARA_CHAR_SHAPE);
    const ctrls = p.children.filter((c) => c.tag === T.CTRL_HEADER);
    const shapes: [number, number][] = [];
    if (csRec) for (let o = 0; o + 8 <= csRec.data.length; o += 8) shapes.push([u32(csRec, o), u32(csRec, o + 4)]);
    if (!shapes.length) shapes.push([0, 0]);
    let si = 0;
    const shapeAt = (pos: number) => {
      while (si + 1 < shapes.length && shapes[si + 1][0] <= pos) si++;
      return shapes[si][1];
    };

    // 한글이 배치해 둔 줄: [줄 첫 글자 위치, 줄 폭(px)]. 화면에서 같은 자리에서 줄을 바꾸도록 문단에 넘긴다 (hwpMetrics)
    const lineRec = p.children.find((c) => c.tag === T.PARA_LINE_SEG);
    const lineSegs: [number, number][] = [];
    if (lineRec) for (let o = 0; o + 36 <= lineRec.data.length; o += 36) lineSegs.push([u32(lineRec, o), hwpToPx(i32(lineRec, o + 28))]);
    const lineAt = new Map<number, number>();

    let inline: JNode[] = [];
    let produced = false;
    const captions: Captions = { before: [], after: [] };
    const firstCp = this.charPr(shapes[0][1]);
    const firstSize = firstCp?.fontSize || null;
    const fontSize = firstSize && firstSize !== 10 ? firstSize : null;
    const flush = () => {
      if (!inline.length) return;
      blocks.push(paragraph({ ...pAttrs, fontSize }, inline));
      inline = [];
      produced = true;
    };

    const prefix = pp ? this.numberPrefix(pp) : null;
    if (prefix) {
      const t = textNode(prefix, charMarks(firstCp));
      if (t) inline.push(t);
    }

    let ctrlIdx = 0;
    let buf = '';
    let bufShape = -1;
    const pushText = () => {
      if (!buf) return;
      const t = textNode(buf, charMarks(this.charPr(bufShape), this.linkHref));
      if (t) inline.push(t);
      buf = '';
    };
    const addChar = (ch: string, pos: number) => {
      const s = shapeAt(pos);
      if (s !== bufShape) {
        pushText();
        bufShape = s;
      }
      buf += ch;
    };

    const inlineSize = () => inline.reduce((s, nd) => s + (nd.type === 'text' ? (nd.text || '').length : 1), 0) + buf.length;
    const wantLines = new Set(lineSegs.map((s) => s[0]));

    if (textRec) {
      const n = textRec.data.length >> 1;
      let i = 0;
      while (i < n) {
        if (wantLines.has(i)) lineAt.set(i, inlineSize());
        const c = u16(textRec, i * 2);
        if (c >= 32) {
          addChar(String.fromCharCode(c), i);
          i++;
          continue;
        }
        if (CHAR_CTRL.has(c)) {
          if (c === 10) {
            pushText();
            inline.push({ type: 'hardBreak' });
          } else if (c === 24) addChar('-', i);
          else if (c === 30) addChar(' ', i);
          else if (c === 31) addChar(String.fromCharCode(FIXED_SPACE), i);
          i++;
          continue;
        }
        if (INLINE_CTRL.has(c)) {
          if (c === 9) {
            // 탭 인라인 컨트롤: [9, 폭(UINT32), 채움(UINT8)+종류(UINT8), 예비, …, 9]
            pushText();
            const tw = u16(textRec, (i + 1) * 2) | (u16(textRec, (i + 2) * 2) << 16);
            const t = textNode('\t', [
              ...charMarks(this.charPr(shapeAt(i)), this.linkHref),
              { type: 'tab', attrs: { width: tw > 0 && tw < 0x1000000 ? Math.round(hwpToPx(tw) * 100) / 100 : null, leader: u8(textRec, (i + 3) * 2), type: u8(textRec, (i + 3) * 2 + 1) } },
            ]);
            if (t) inline.push(t);
          } else if (c === 4) {
            pushText();
            this.linkHref = null;
          }
          i += 8;
          continue;
        }
        // 확장 컨트롤
        pushText();
        const ctrl = ctrls[ctrlIdx++];
        if (ctrl) {
          const res = this.handleCtrl(ctrl, shapeAt(i), inline, captions);
          if (res.length) {
            for (const b of res)
              if (b.type === 'table' && (pAttrs.textAlign === 'center' || pAttrs.textAlign === 'right')) b.attrs = { ...b.attrs, align: pAttrs.textAlign };
            flush();
            blocks.push(...res);
            produced = true;
          }
        }
        i += 8;
      }
      pushText();
    }
    // 텍스트 없이 컨트롤만 있는 경우(구역 정의 등)
    for (; ctrlIdx < ctrls.length; ctrlIdx++) {
      const id = ctrlIdOf(ctrls[ctrlIdx]);
      if (id === 'secd' || id === 'cold' || id === 'head' || id === 'foot' || id === 'pgnp') this.handleCtrl(ctrls[ctrlIdx], 0, inline);
    }
    const lineSize = inline.length && !produced ? inlineSize() : 0;
    if (inline.length) flush();
    else if (!produced) blocks.push(paragraph({ ...pAttrs, fontSize }));
    // 문단이 표 등으로 쪼개지지 않고 줄 위치를 모두 찾았을 때만. 첫 줄은 문단 번호(머리 글자)부터
    lineAt.set(0, 0);
    // 떠 있는 개체 표시는 늘 지운다 (문서 노드에는 없는 속성)
    const floating = blocks.map(takeFloating).some(Boolean);
    const paras = blocks.filter((b) => b.type !== 'pageBreak');
    if (lineSize && lineSegs.length && paras.length === 1 && paras[0].type === 'paragraph' && !floating && lineSegs.every((s) => lineAt.has(s[0]))) {
      paras[0].attrs = { ...paras[0].attrs, hwpLines: lineSegs.map((s) => [lineAt.get(s[0])!, Math.round(s[1] * 100) / 100]), hwpLen: lineSize };
    }
    const out = placeCaptions(blocks, captions);
    const first = out.find((b) => b.type !== 'pageBreak');
    if (!inSub) this.pageMarks.mark(first, vpos, hwpPage);
    return out;
  }

  /** 확장 컨트롤 처리. 블록을 반환하면 문단을 끊고 삽입 */
  private handleCtrl(ctrl: Rec, shapeId: number, inline: JNode[], captions?: Captions): JNode[] {
    const id = ctrlIdOf(ctrl);
    switch (id) {
      case 'secd':
        this.handleSecd(ctrl);
        return [];
      case 'tbl ': {
        const t = this.convertTable(ctrl);
        const cap = (t as any).caption as Caption | undefined;
        delete (t as any).caption;
        return cap ? (cap.top ? [...cap.blocks, t] : [t, ...cap.blocks]) : [t];
      }
      case 'gso ':
        return this.convertGso(ctrl, inline, captions);
      case 'head':
      case 'foot': {
        // 속성 bit 0~1: 0 양쪽, 1 짝수 쪽, 2 홀수 쪽 — Kite 는 머리말이 하나이므로 짝수 쪽 전용은 건너뛴다
        if ((u32(ctrl, 4) & 3) === 1) return [];
        const target = id === 'head' ? this.settings.header : this.settings.footer;
        // 첫 쪽에 걸리는 것(첫 쪽에서 마지막으로 정의된 것)을 쓴다. 뒤쪽에서 바뀐 머리말은 첫 쪽에 보이지 않는다
        if ((target.text || target.content) && this.page > 0) return [];
        this.inHF = true;
        let blocks: JNode[];
        try {
          blocks = this.convertParagraphs(ctrl.children, true);
        } finally {
          this.inHF = false;
        }
        const text = this.subText(ctrl, true) || plainText(blocks);
        if (!text && !blocks.some(hasObject)) return [];
        target.text = text;
        const firstPara = ctrl.children.find((c) => c.tag === T.PARA_HEADER);
        const pp = firstPara ? this.info.paraPrs[u16(firstPara, 8)] : undefined;
        target.align = pp?.align === 'right' ? 'right' : pp?.align === 'left' ? 'left' : 'center';
        // 표·그림이 있거나 여러 줄이면 모양 그대로 그린다
        if (blocks.some(hasObject) || blocks.filter((b) => plainText([b])).length > 1) target.content = blocks;
        else delete target.content;
        return [];
      }
      case 'fn  ':
      case 'en  ':
        inline.push({ type: 'footnote', attrs: { text: this.subText(ctrl, false) } });
        return [];
      case 'pgnp': {
        const a = u32(ctrl, 4);
        const fmt = a & 0xff;
        const pos = (a >>> 8) & 0xf;
        const POS = ['none', 'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right', 'top-right', 'bottom-right', 'top-left', 'bottom-left'];
        this.settings.pageNumber.pos = (POS[pos] || 'bottom-center') as any;
        const dash = u16(ctrl, 14);
        this.settings.pageNumber.format = fmt === 3 ? 'roman' : fmt === 2 ? 'ROMAN' : dash === 0x2d ? 'dash' : 'digit';
        return [];
      }
      case '%hlk': {
        const cmd = wstr(ctrl, 9).s;
        this.linkHref = cmd.split(';')[0].replace(/\\:/g, ':') || null;
        return [];
      }
      case 'eqed': {
        const eq = ctrl.children.find((c) => c.tag === T.EQEDIT);
        const script = eq ? wstr(eq, 4).s : '';
        if (script.trim()) inline.push({ type: 'math', attrs: { latex: hwpToLatex(script), hwp: script }, marks: charMarks(this.charPr(shapeId)) });
        return [];
      }
      case 'atno': {
        const type = u32(ctrl, 4) & 0xf;
        const num = u16(ctrl, 8);
        if (type === 0 && this.inHF) {
          const t = textNode('{{PAGE}}', charMarks(this.charPr(shapeId)));
          if (t) inline.push(t);
        } else if (type !== 0 && num) {
          const t = textNode(String(num), charMarks(this.charPr(shapeId)));
          if (t) inline.push(t);
        }
        return [];
      }
      default:
        return [];
    }
  }

  private handleSecd(ctrl: Rec) {
    const ol = u16(ctrl, 18);
    if (ol) this.outlineNumId = String(ol);
    const pd = ctrl.children.find((c) => c.tag === T.PAGE_DEF);
    if (!pd) return;
    const pg: PageSetup = { ...this.settings.page };
    pg.width = round(hwpToMm(u32(pd, 0)), 1);
    pg.height = round(hwpToMm(u32(pd, 4)), 1);
    pg.marginLeft = round(hwpToMm(u32(pd, 8)), 1);
    pg.marginRight = round(hwpToMm(u32(pd, 12)), 1);
    pg.marginTop = round(hwpToMm(u32(pd, 16)), 1);
    pg.marginBottom = round(hwpToMm(u32(pd, 20)), 1);
    pg.marginHeader = round(hwpToMm(u32(pd, 24)), 1);
    pg.marginFooter = round(hwpToMm(u32(pd, 28)), 1);
    pg.gutter = round(hwpToMm(u32(pd, 32)), 1);
    pg.landscape = (u32(pd, 36) & 1) === 1;
    // 첫 구역의 용지가 문서 용지, 다음 구역부터는 구역 나누기에 담는다 (readHwp)
    if (!this.settingsSet) {
      this.settingsSet = true;
      this.settings.page = pg;
    }
    if (!this.sectionPage) this.sectionPage = pg;
  }

  /** 머리말/각주 등 하위 문단의 텍스트 */
  private subText(ctrl: Rec, pageToken: boolean): string {
    const parts: string[] = [];
    for (const p of ctrl.children) {
      if (p.tag !== T.PARA_HEADER) continue;
      const tr = p.children.find((c) => c.tag === T.PARA_TEXT);
      const cs = p.children.filter((c) => c.tag === T.CTRL_HEADER);
      if (!tr) continue;
      let s = '';
      let k = 0;
      const n = tr.data.length >> 1;
      for (let i = 0; i < n; ) {
        const c = u16(tr, i * 2);
        if (c >= 32) {
          s += String.fromCharCode(c);
          i++;
        } else if (CHAR_CTRL.has(c)) {
          if (c === 10) s += ' ';
          i++;
        } else if (INLINE_CTRL.has(c)) {
          if (c === 9) s += '\t';
          i += 8;
        } else {
          const ct = cs[k++];
          if (ct && ctrlIdOf(ct) === 'atno' && (u32(ct, 4) & 0xf) === 0 && pageToken) s += '{{PAGE}}';
          i += 8;
        }
      }
      parts.push(s);
    }
    return parts.join(' ').trim();
  }

  convertTable(ctrl: Rec): JNode {
    const tbl = ctrl.children.find((c) => c.tag === T.TABLE);
    const nRowsDecl = tbl ? u16(tbl, 4) : 0;
    const repeatHeader = !!tbl && (u32(tbl, 0) & 4) !== 0;
    type Cell = { row: number; col: number; cs: number; rs: number; w: number; node: JNode };
    const cells: Cell[] = [];
    const rowH: number[] = [];
    let cur: { lh: Rec; paras: Rec[] } | null = null;
    const finish = () => {
      if (!cur) return;
      const lh = cur.lh;
      const attrVal = u32(lh, 2);
      const col = u16(lh, 8);
      const row = u16(lh, 10);
      const cs = Math.max(1, u16(lh, 12));
      const rs = Math.max(1, u16(lh, 14));
      const w = hwpToPx(u32(lh, 16));
      // 셀 높이에는 위/아래 안 여백이 들어 있다 (편집기 줄 높이와 맞추려고 뺀다)
      if (rs === 1) rowH[row] = Math.max(rowH[row] || 0, hwpToPx(u32(lh, 20) - CELL_VMARGIN_HWP));
      const bfId = u16(lh, 32);
      const bf = bfId ? this.info.borderFills[bfId - 1] : undefined;
      let content = this.convertParagraphs(cur.paras, true).filter((n) => n.type !== 'pageBreak');
      if (!content.length) content = [paragraph()];
      const va = (attrVal >>> 21) & 3;
      const attrs: Record<string, any> = { colspan: cs, rowspan: rs, colwidth: null };
      if (bf?.bg) attrs.backgroundColor = bf.bg;
      if (bf?.gradient) attrs.bgGradient = bf.gradient;
      if (bf && bf.noBorders.length) attrs.borderStyle = bf.noBorders.join(' ');
      if (bf?.css) attrs.borderCss = bf.css;
      const fillSrc = bf?.img ? this.images.get(+bf.img.id) : null;
      if (fillSrc && bf?.img) attrs.bgImages = [{ src: fillSrc, fit: imgFillFit(bf.img.mode) }];
      // 칸 자체 안 여백 (속성 뒤 2바이트의 bit 0 이 켜진 칸만; 아니면 표의 기본 여백)
      if (u16(lh, 6) & 1) attrs.margins = [u16(lh, 24), u16(lh, 26), u16(lh, 28), u16(lh, 30)].map((v) => Math.round(hwpToPx(v) * 10) / 10);
      if (va === 0) attrs.verticalAlign = 'top';
      else if (va === 2) attrs.verticalAlign = 'bottom';
      // 제목 칸(속성 뒤 2바이트의 bit 2)이고 표가 '제목 줄 자동 반복'(표 속성 bit 2)이면 제목 칸으로: 쪽이 바뀌면 되풀이된다
      const head = repeatHeader && (u16(lh, 6) & 4) !== 0;
      cells.push({ row, col, cs, rs, w, node: { type: head ? 'tableHeader' : 'tableCell', attrs, content } });
      cur = null;
    };
    // TABLE 레코드 앞의 LIST_HEADER는 캡션
    let seenTable = false;
    let caption: Rec[] | null = null;
    let captionTop = false;
    for (const c of ctrl.children) {
      if (c.tag === T.TABLE) {
        seenTable = true;
        continue;
      }
      if (!seenTable) {
        if (c.tag === T.LIST_HEADER) {
          caption = [];
          captionTop = isCaptionTop(c);
        } else if (c.tag === T.PARA_HEADER && caption) caption.push(c);
        continue;
      }
      if (c.tag === T.LIST_HEADER) {
        finish();
        cur = { lh: c, paras: [] };
      } else if (c.tag === T.PARA_HEADER && cur) cur.paras.push(c);
    }
    finish();
    const nColsDecl = tbl ? u16(tbl, 6) : 0;
    const t = assembleTable(cells, nRowsDecl, nColsDecl, hwpToPx(u32(ctrl, 16)), rowH);
    if (tbl) t.attrs = { cellPadding: Math.round(hwpToPx((u16(tbl, 10) + u16(tbl, 12)) / 2) * 10) / 10 };
    // 글자처럼 취급(개체 속성 bit 0): 쪽에서 나뉘지 않고 문단 정렬을 따른다. 저장할 때 되돌린다
    const objAttr = u32(ctrl, 4);
    if (objAttr & 1) t.attrs = { ...t.attrs, inline: true };
    // 표 바깥 여백 [왼, 오른, 위, 아래] (저장할 때 그대로 되돌린다). 개체 공통 속성에서 z-order(24, INT32) 다음 28 부터
    if (ctrl.data.length >= 36) t.attrs = { ...t.attrs, outMargin: [28, 30, 32, 34].map((o) => Math.round(hwpToPx(u16(ctrl, o)) * 10) / 10) };
    // 떠 있는 표(글자처럼 취급 아님)가 문단 기준(bit 3-4 = 2)으로 아래로 떨어져 있으면 그만큼 위 여백으로
    // (Kite 에는 떠 있는 개체가 없어 흐름에 놓는다: 한글에서 표가 놓이는 세로 자리는 맞춘다)
    if (!(objAttr & 1) && ((objAttr >> 3) & 3) === 2 && ctrl.data.length >= 32) {
      const vOff = hwpToPx(u32(ctrl, 8));
      if (vOff > 0.5 && vOff < 2000) {
        const m = (t.attrs as any).outMargin || [0, 0, 0, 0];
        t.attrs = { ...t.attrs, outMargin: [m[0], m[1], Math.round((m[2] + vOff) * 10) / 10, m[3]] };
      }
    }
    fitTableLines(t);
    if (caption && caption.length) (t as any).caption = { top: captionTop, blocks: this.convertParagraphs(caption, true) } satisfies Caption;
    return t;
  }

  private convertGso(ctrl: Rec, inline: JNode[], captions?: Captions): JNode[] {
    const w = Math.round(hwpToPx(u32(ctrl, 16)));
    const h = Math.round(hwpToPx(u32(ctrl, 20)));
    const pics: Rec[] = [];
    const texts: { header: Rec; paras: Rec[]; shape: Rec }[] = [];
    let shapeRec: Rec | null = null;
    let rectRec: Rec | null = null;
    let ellipse = false;
    /** 개체 바로 아래의 LIST_HEADER 는 캡션 (글상자의 문단 목록은 SHAPE_COMPONENT 아래에 있다) */
    let cap: { top: boolean; paras: Rec[] } | null = null;
    const visit = (r: Rec) => {
      let curText: { header: Rec; paras: Rec[]; shape: Rec } | null = null;
      for (const c of r.children) {
        if (r === ctrl && c.tag === T.LIST_HEADER) {
          cap = { top: isCaptionTop(c), paras: [] };
          continue;
        }
        if (r === ctrl && c.tag === T.PARA_HEADER && cap) {
          cap.paras.push(c);
          continue;
        }
        if (c.tag === T.SHAPE_COMPONENT_PICTURE) pics.push(c);
        else if (c.tag === T.SHAPE_COMPONENT && !shapeRec) shapeRec = c;
        else if (c.tag === T.SHAPE_COMPONENT_RECTANGLE) rectRec = c;
        else if (c.tag === T.SHAPE_COMPONENT_ELLIPSE) ellipse = true;
        else if (c.tag === T.LIST_HEADER) {
          // 글상자의 문단 목록: 이 목록을 가진 개체(r)의 위치·크기로 묶음 안에서의 자리를 안다
          curText = { header: c, paras: [], shape: r };
          texts.push(curText);
        } else if (c.tag === T.PARA_HEADER && curText) curText.paras.push(c);
        if (c.tag !== T.PARA_HEADER) visit(c);
      }
    };
    visit(ctrl);
    const capList = cap as { top: boolean; paras: Rec[] } | null;
    if (capList && capList.paras.length && captions) (capList.top ? captions.before : captions.after).push(...this.convertParagraphs(capList.paras, true));
    if (pics.length === 1 && !texts.length) {
      const pic = this.picture(pics[0], w, h);
      // 글자처럼 취급하지 않는(떠 있는) 그림: 한글의 줄 배치에 들지 않는다 (hasFloating)
      if (!(u32(ctrl, 4) & 1)) pic.attrs = { ...pic.attrs, [FLOATING]: true };
      inline.push(pic);
      return [];
    }
    const blocks: JNode[] = [];
    if (texts.length) {
      // 글상자: 도형(또는 그림을 배경으로 한 상자) 안의 문단들
      const st = shapeRec && !pics.length ? shapeStyle(shapeRec) : { borderColor: null, borderWidth: null, bg: null };
      const bgImage = pics.length === 1 ? this.pictureSrc(pics[0]) : null;
      let radius: string | null = null;
      if (ellipse) radius = '50%';
      else if (rectRec) {
        const ratio = u8(rectRec, 0);
        if (ratio > 0 && w && h) radius = `${Math.round((Math.min(w, h) * Math.min(50, ratio)) / 200)}px`;
      }
      // 묶음(그룹) 개체 안에 글상자가 여럿이면(예: 제목 탭 + 본문) 한 상자에 차례로 넣는다.
      // 여백은 문단이 가장 많은 글상자(본문)의 것을 쓴다.
      const main = texts.reduce((a, b) => (b.paras.length > a.paras.length ? b : a), texts[0]);
      // LIST_HEADER(글상자): 문단 수(2) 속성(4) 예비(2) 왼쪽·오른쪽·위·아래 여백(각 2)
      const hd = main.header;
      const padding = hd.data.length >= 16 ? [u16(hd, 12), u16(hd, 10), u16(hd, 14), u16(hd, 8)].map((v) => Math.round(hwpToPx(v))) : null;
      const content: JNode[] = [];
      const groupW = u32(ctrl, 16);
      for (const t of texts) {
        const paras = this.convertParagraphs(t.paras, true);
        // 묶음 안의 작은 글상자(제목 탭 등)는 그 가로 자리만큼 양쪽 여백을 줘서 원래 자리에 글이 오게 한다
        if (t !== main && texts.length > 1 && t.shape.tag === T.SHAPE_COMPONENT) {
          const base = shapeBase(t.shape);
          const x = i32(t.shape, base);
          const sw = i32(t.shape, base + 20);
          if (x >= 0 && sw > 0 && x + sw <= groupW && sw < groupW * 0.9) {
            const l = hwpToPt(x);
            const rgt = hwpToPt(groupW - x - sw);
            for (const n of paras) if (n.type === 'paragraph') n.attrs = { ...n.attrs, indentLeft: (n.attrs?.indentLeft || 0) + l, indentRight: (n.attrs?.indentRight || 0) + rgt };
          }
        }
        content.push(...paras);
      }
      blocks.push({
        type: 'textBox',
        attrs: { width: w || null, height: h || null, bg: st.bg, bgImage, borderColor: st.borderColor, borderWidth: st.borderWidth, radius, padding },
        content: content.length ? content : [paragraph()],
      });
      if (pics.length > 1) for (const p of pics) blocks.push(paragraph({ textAlign: 'center' }, [this.picture(p, w, h)]));
      return blocks;
    }
    for (const p of pics) {
      const sw = Math.round(hwpToPx(Math.abs(i32(p, 20) - i32(p, 12)))) || w;
      const sh = Math.round(hwpToPx(Math.abs(i32(p, 32) - i32(p, 16)))) || h;
      blocks.push(paragraph({ textAlign: 'center' }, [this.picture(p, pics.length === 1 ? w : sw, pics.length === 1 ? h : sh)]));
    }
    for (const t of texts) blocks.push(...this.convertParagraphs(t.paras, true));
    return blocks;
  }

  /** 그림 개체의 데이터 URL (없으면 null) */
  private pictureSrc(p: Rec): string | null {
    return this.images.get(u16(p, 71)) || null;
  }

  private picture(p: Rec, w: number, h: number): JNode {
    const binId = u16(p, 71);
    let src = this.images.get(binId);
    if (!src) {
      this.warnings.push(`그림 데이터를 찾을 수 없음 (BIN${binId.toString(16).toUpperCase().padStart(4, '0')})`);
      src = placeholderImage('그림', w || 100, h || 60);
    }
    const ow = p.data.length >= 90 ? u32(p, 82) : Math.abs(i32(p, 20) - i32(p, 12));
    const oh = p.data.length >= 90 ? u32(p, 86) : Math.abs(i32(p, 32) - i32(p, 16));
    let crop = null;
    if (ow > 0 && oh > 0) crop = normCrop(i32(p, 48) / oh, 1 - i32(p, 52) / ow, 1 - i32(p, 56) / oh, i32(p, 44) / ow);
    return { type: 'image', attrs: { src, width: w || null, height: h || null, crop } };
  }
}

/** 블록들의 글자 (표 칸은 빈칸으로 잇는다) */
function plainText(blocks: JNode[]): string {
  const parts: string[] = [];
  const walk = (n: JNode) => {
    if (n.type === 'text') parts.push(n.text || '');
    else if (n.type === 'tableCell' || n.type === 'paragraph') parts.push(' ');
    (n.content || []).forEach(walk);
  };
  blocks.forEach(walk);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/** 개체(표·그림·도형)의 캡션 문단. top 이면 개체 위에 */
export interface Caption {
  top: boolean;
  blocks: JNode[];
}

/** 문단 안 개체(그림 등)의 캡션: 그 문단 앞(위 캡션)과 뒤(아래·옆 캡션)에 놓는다 */
export interface Captions {
  before: JNode[];
  after: JNode[];
}

/** 캡션 LIST_HEADER: 문단 수(2) 속성(4) 예비(2) 다음 캡션 속성(4)의 bit 0~1 이 방향 (0 왼, 1 오른, 2 위, 3 아래) */
function isCaptionTop(lh: Rec): boolean {
  return lh.data.length >= 12 && (u32(lh, 8) & 3) === 2;
}

/** 문단에서 나온 블록들 앞뒤에 캡션을 넣는다 (맨 앞 쪽 나누기는 그대로 맨 앞에) */
export function placeCaptions(blocks: JNode[], captions: Captions): JNode[] {
  if (!captions.before.length && !captions.after.length) return blocks;
  const k = blocks[0]?.type === 'pageBreak' ? 1 : 0;
  return [...blocks.slice(0, k), ...captions.before, ...blocks.slice(k), ...captions.after];
}

/**
 * 칸 안 문단의 한글 줄 폭을 Kite 의 칸 안 폭(열 폭 합 - 왼·오른 안 여백)으로 제한한다. '한 줄로 입력' 칸에서 한글은
 * 넘치는 줄의 자간을 줄여 칸에 맞추는데, 저장된 줄 폭은 줄이기 전의 폭이다. 또 줄마다 칸 폭이 어긋난 표는 Kite 의
 * 열 경계로 맞추면서 칸이 원래보다 좁아질 수 있다. 줄 폭은 문단 왼쪽·오른쪽 여백을 뺀 폭이므로 그것도 뺀다
 */
export function fitTableLines(table: JNode) {
  const pad = +table.attrs?.cellPadding;
  for (const row of table.content || [])
    for (const cell of row.content || []) {
      const cw = cell.attrs?.colwidth as number[] | null;
      if (!cw || !cw.length) continue;
      const m = cell.attrs?.margins as number[] | undefined;
      const side = m ? m[0] + m[1] : 2 * (pad >= 0 ? pad : hwpToPx(510));
      fitLinesToCell(cell.content || [], cw.reduce((a, b) => a + b, 0) - side);
    }
}

function fitLinesToCell(content: JNode[], innerPx: number) {
  for (const p of content) {
    const lines = p.attrs?.hwpLines as [number, number][] | undefined;
    if (p.type !== 'paragraph' || !lines) continue;
    const max = innerPx - ((+p.attrs!.indentLeft || 0) + (+p.attrs!.indentRight || 0)) * (96 / 72);
    if (max > 0) p.attrs!.hwpLines = lines.map(([a, lw]) => [a, Math.min(lw, Math.round(max * 100) / 100)]);
  }
}

/** 떠 있는 개체 표시 (읽는 동안만 쓰고 takeFloating 이 지운다) */
export const FLOATING = '__floating';

/**
 * 문단에 떠 있는 개체(글자처럼 취급하지 않는 그림)가 있는가. 표시는 지운다.
 * 한글의 줄 정보에는 떠 있는 개체가 들지 않는데 Kite 는 그것을 줄 안에 그리므로, 그런 문단은 한글 줄 배치를 쓰지 않는다
 */
export function takeFloating(p: JNode): boolean {
  let found = false;
  for (const n of p.content || []) {
    if (n.attrs && FLOATING in n.attrs) {
      found = true;
      delete n.attrs[FLOATING];
    }
  }
  return found;
}

/**
 * 한글이 새 쪽에 놓은 문단 표시(hwpPage). 첫 줄의 세로 위치가 앞 문단보다 작아지면 새 쪽이다. 그림만 든 문단처럼
 * 한글이 줄 정보를 남기지 않은 문단을 지나 새 쪽 첫 줄이 쪽 맨 위가 아니면, 새 쪽은 그 문단들부터 시작했다
 */
export class HwpPageMarks {
  /** 줄 정보 없이 이어진 문단들 중 첫 문단의 첫 블록 */
  private pending: JNode | null = null;
  /** first: 이 문단의 첫 블록, vpos: 첫 줄의 세로 위치(없으면 null), newPage: 세로 위치가 되돌아갔다 */
  mark(first: JNode | undefined, vpos: number | null, newPage: boolean) {
    if (vpos == null) {
      if (!this.pending && first) this.pending = first;
      return;
    }
    const target = newPage ? (this.pending && vpos > 0 ? this.pending : first) : null;
    if (target && (target.type === 'paragraph' || target.type === 'table')) target.attrs = { ...target.attrs, hwpPage: true };
    this.pending = null;
  }
  reset() {
    this.pending = null;
  }
}

/** 표·그림·글상자가 들어 있는가 */
function hasObject(n: JNode): boolean {
  return n.type === 'table' || n.type === 'image' || n.type === 'textBox' || (n.content || []).some(hasObject);
}

/** 셀 목록 → 표 JSON (빈 줄/열 너비 보정 포함) */
/** 한글 셀의 위+아래 안 여백 기본값 (HWPUNIT, 0.5mm×2). 줄 높이를 읽고 쓸 때 빼고 더한다 */
export const CELL_VMARGIN_HWP = 282;

export function assembleTable(
  cells: { row: number; col: number; cs: number; rs: number; w: number; node: JNode }[],
  nRowsDecl: number,
  nColsDecl = 0,
  /** 표 전체 너비(px) — 계산한 너비가 더 크면 이 너비에 맞춤 */
  tableWidth = 0,
  /** 원래 줄 번호별 줄 높이(px, 최소 높이) */
  rowHeights: (number | null)[] = [],
): JNode {
  // 잘못된 값 방어: 칸/줄 합치기 범위를 표 크기 안으로 제한 (선언된 줄 수가 없어도 절대 상한을 둔다)
  const MAX_ROWS = 4096;
  const maxCols = nColsDecl > 0 ? Math.min(nColsDecl, 512) : 512;
  const maxRows = Math.min(MAX_ROWS, Math.max(nRowsDecl, 1) + MAX_ROWS);
  cells = cells.filter((c) => c.col >= 0 && c.row >= 0 && c.col < maxCols && c.row < maxRows);
  if (cells.length > 200000) cells = cells.slice(0, 200000);
  for (const c of cells) {
    c.cs = Math.max(1, Math.min(c.cs | 0, maxCols - c.col));
    c.rs = Math.max(1, Math.min(c.rs | 0, maxRows - c.row));
    if (nRowsDecl > 0 && c.row + c.rs > nRowsDecl) c.rs = Math.max(1, nRowsDecl - c.row);
    if (!isFinite(c.w) || c.w > 5000) c.w = 0;
    c.node.attrs!.colspan = c.cs;
    c.node.attrs!.rowspan = c.rs;
  }
  const nRows = Math.max(nRowsDecl, ...cells.map((c) => c.row + c.rs), 0);
  const rowsWithCells = new Set(cells.map((c) => c.row));
  const removed: number[] = [];
  for (let r = 0; r < nRows; r++) if (!rowsWithCells.has(r)) removed.push(r);
  const keptRows: number[] = [];
  for (let r = 0; r < nRows; r++) if (rowsWithCells.has(r)) keptRows.push(r);
  if (removed.length) {
    for (const c of cells) {
      c.rs -= removed.filter((r) => r > c.row && r < c.row + c.rs).length;
      c.node.attrs!.rowspan = Math.max(1, c.rs);
      c.row -= removed.filter((r) => r < c.row).length;
    }
  }
  const byRow = new Map<number, typeof cells>();
  for (const c of cells) {
    if (!byRow.has(c.row)) byRow.set(c.row, []);
    byRow.get(c.row)!.push(c);
  }
  const rows: JNode[] = [...byRow.keys()]
    .sort((a, b) => a - b)
    .map((r) => {
      const h = rowHeights[keptRows[r]];
      const row: JNode = { type: 'tableRow', content: byRow.get(r)!.sort((a, b) => a.col - b.col).map((c) => c.node) };
      if (h && h > 0 && h < 3000) row.attrs = { height: Math.round(h * 10) / 10 };
      return row;
    });
  const nCols = Math.max(1, ...cells.map((c) => c.col + c.cs));
  // 열 경계 계산: 각 셀의 왼쪽/오른쪽 경계를 전파해 정확한 격자 너비를 구한다
  const x: (number | null)[] = new Array(nCols + 1).fill(null);
  x[0] = 0;
  // 합친 칸의 폭이 그 아래 낱칸 폭의 합과 다를 수 있다 (한글은 줄마다 칸 폭대로 그린다). 낱칸부터 믿는다
  const bySpan = [...cells].sort((a, b) => a.cs - b.cs);
  for (let iter = 0; iter < nCols + 4; iter++) {
    let changed = false;
    for (const c of bySpan) {
      if (!(c.w > 0)) continue;
      const a = c.col;
      const b = c.col + c.cs;
      if (x[a] != null && x[b] == null) {
        x[b] = x[a]! + c.w;
        changed = true;
      } else if (x[b] != null && x[a] == null) {
        x[a] = x[b]! - c.w;
        changed = true;
      }
    }
    if (!changed) break;
  }
  // 알 수 없는 경계는 앞뒤 값 사이를 고르게 채움
  for (let i = 1; i <= nCols; i++) {
    if (x[i] != null) continue;
    let j = i + 1;
    while (j <= nCols && x[j] == null) j++;
    const left = x[i - 1]!;
    const right = j <= nCols ? x[j]! : left + 60 * (j - i);
    for (let k = i; k < j; k++) x[k] = left + ((right - left) * (k - i + 1)) / (j - i + 1);
  }
  for (let i = 1; i <= nCols; i++) if (x[i]! <= x[i - 1]!) x[i] = x[i - 1]! + 4;
  let total = x[nCols]!;
  const scale = tableWidth && total > tableWidth + 1 ? tableWidth / total : 1;
  // 0.1px 까지 둔다: 정수로 자르면 칸이 원본보다 조금 좁아져 칸에 꼭 맞던 글이 한글에서 줄을 바꾼다
  const bounds = x.map((v) => Math.round(v! * scale * 10) / 10);
  total = bounds[nCols];
  const finalW = bounds.slice(1).map((v, i) => Math.max(1, Math.min(2000, Math.round((v - bounds[i]) * 10) / 10)));
  // 병합 때문에 생긴 아주 좁은 열(셀 안 여백보다 좁음)은 이웃 열에 합친다
  for (let k = finalW.length - 1; k >= 0 && finalW.length > 1; k--) {
    if (finalW[k] >= 8) continue;
    const covering = cells.filter((c) => c.col <= k && k < c.col + c.cs);
    if (covering.some((c) => c.cs === 1)) continue;
    const target = k + 1 < finalW.length ? k + 1 : k - 1;
    finalW[target] += finalW[k];
    finalW.splice(k, 1);
    for (const c of cells) {
      if (c.col <= k && k < c.col + c.cs) c.cs--;
      else if (c.col > k) c.col--;
      c.node.attrs!.colspan = c.cs;
    }
  }
  for (const c of cells) c.node.attrs!.colwidth = finalW.slice(c.col, c.col + c.cs);
  return {
    type: 'table',
    content: rows.length ? rows : [{ type: 'tableRow', content: [{ type: 'tableCell', content: [paragraph()] }] }],
  };
}

export async function readHwp(data: Uint8Array): Promise<LoadedDoc> {
  const cfb = CFB.read(data, { type: 'array' });
  const find = (name: string) => {
    const lower = name.toLowerCase();
    const idx = cfb.FullPaths.findIndex((p) => p.toLowerCase().endsWith('/' + lower) || p.toLowerCase() === lower);
    return idx >= 0 ? cfb.FileIndex[idx] : null;
  };
  const header = find('FileHeader');
  if (!header) throw new Error('HWP 파일이 아닙니다 (FileHeader 없음). HWP 3.x 이하 형식은 지원하지 않습니다.');
  const hb = new Uint8Array(header.content as any);
  const sig = new TextDecoder('ascii').decode(hb.subarray(0, 17));
  if (sig !== 'HWP Document File') throw new Error('HWP 5.0 형식이 아닙니다.');
  const hdv = new DataView(hb.buffer, hb.byteOffset, hb.byteLength);
  const flags = hdv.getUint32(36, true);
  const compressed = (flags & 1) === 1;
  if (flags & 2) throw new Error('암호가 설정된 문서는 열 수 없습니다.');
  if (flags & 4) throw new Error('배포용 문서는 열 수 없습니다.');

  const docInfoEntry = find('DocInfo');
  if (!docInfoEntry) throw new Error('DocInfo 스트림이 없습니다.');
  const info = parseDocInfo(parseRecords(decompress(new Uint8Array(docInfoEntry.content as any), compressed)));

  const warnings: string[] = [];
  const images = new Map<number, string>();
  for (const [id, b] of info.binData) {
    const name = `BIN${id.toString(16).toUpperCase().padStart(4, '0')}.${b.ext}`;
    const e = find('BinData/' + name) || find(name);
    if (!e) continue;
    let bytes = new Uint8Array(e.content as any);
    const comp = b.compress === 0 ? compressed : b.compress === 1;
    if (comp) bytes = decompress(bytes, true);
    const mime = mimeFromExt(b.ext);
    images.set(id, isBrowserImage(mime) ? bytesToDataUrl(bytes, mime) : placeholderImage(`그림(${b.ext.toUpperCase()})`));
  }

  const conv = new HwpConverter(info, images, defaultSettings(), warnings);
  conv.settings.hwpMetrics = true;
  const blocks: JNode[] = [];
  for (let i = 0; ; i++) {
    const sec = find(`BodyText/Section${i}`);
    if (!sec) break;
    const recs = buildTree(parseRecords(decompress(new Uint8Array(sec.content as any), compressed)));
    // 구역 나누기: 구역마다 용지가 다를 수 있으므로 쪽 나누기에 이 구역의 용지(구역 정의에서 읽은 것)를 담는다
    const brk: JNode | null = i > 0 && blocks.length ? { type: 'pageBreak' } : null;
    if (brk) blocks.push(brk);
    conv.sectionPage = null;
    blocks.push(...conv.convertParagraphs(recs, false));
    if (brk && conv.sectionPage) brk.attrs = { sectionPage: conv.sectionPage };
  }
  while (blocks.length && blocks[0].type === 'pageBreak') blocks.shift();
  return { content: docNode(blocks), settings: conv.settings, meta: {}, warnings: [...new Set(warnings)].slice(0, 20) };
}

/**
 * SHAPE_COMPONENT(그리기 개체 공통)에서 선·채우기 정보.
 * 공통 부분(id 2개, 위치, 크기, 뒤집기, 회전, 렌더링 행렬 cnt 개) 뒤에 선 정보(색 4, 굵기 4, 속성 4)와 채우기 정보(종류 4, 색 4 …)가 온다.
 */
/** SHAPE_COMPONENT 의 공통 정보 시작 위치: 최상위 개체는 ctrl ID 를 두 번 쓰고(8), 묶음 안의 개체는 한 번 쓴다(4) */
function shapeBase(sc: Rec): number {
  return u32(sc, 0) === u32(sc, 4) ? 8 : 4;
}

function shapeStyle(sc: Rec): { borderColor: string | null; borderWidth: number | null; bg: string | null } {
  const none = { borderColor: null, borderWidth: null, bg: null };
  const base = shapeBase(sc);
  // base 뒤: x(4) y(4) 그룹(2) 버전(2) 원래 폭·높이(8) 현재 폭·높이(8) 뒤집기(4) 회전각(2) 회전 중심(8) → 행렬 수(2), 행렬들
  const cnt = u16(sc, base + 42);
  if (cnt > 16) return none;
  const off = base + 44 + 48 + 96 * cnt;
  if (sc.data.length < off + 16) return none;
  const lineColor = u32(sc, off);
  const lineW = i32(sc, off + 4);
  const fillType = u32(sc, off + 12);
  let borderColor: string | null = null;
  let borderWidth: number | null = null;
  if (lineW > 0 && (lineColor & 0xff000000) === 0) {
    borderColor = colorRefToHex(lineColor);
    // 굵기 단위가 HWPUNIT(1/7200in)인지 0.01mm 인지 문서마다 달라 보여, 화면용으로 좁은 범위로 잘라 쓴다
    borderWidth = Math.max(0.75, Math.min(6, lineW < 100 ? lineW * 0.0378 : hwpToPx(lineW)));
  }
  let bg: string | null = null;
  if (fillType & 1 && sc.data.length >= off + 20) {
    const face = u32(sc, off + 16);
    if (face !== 0xffffffff && (face & 0xff000000) === 0) bg = colorRefToHex(face);
  }
  return { borderColor, borderWidth, bg };
}
