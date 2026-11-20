import { LineSegStats, ParaLayout, dropHwpLayout, estimateMissingLines, floatOverhang, floatTableX, gapInBox, headMark, indentByPara, isBreakBlock, jsonContentSize, markCellTrail, solveSpanRows, type LayoutState, type ObjPos, type PageGeomPx, type ParaHead } from '../hwpLayout';
import { cleanLook, type PicLook } from '../picLook';
import { olePreview } from '../olePreview';
import { isMetafileExt, metafileToSvg } from '../metafile';
import { hwpToLatex } from '../../math/hwpEq';
import * as CFB from 'cfb';
import { Inflate } from 'pako';
import type { Columns, DocSettings, LoadedDoc, PageSetup } from '../../types';
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
  cleanPageHide,
  round,
  textNode,
  HWP_NUM_FORMATS,
  HWP_BORDER_WIDTHS,
  hwpBorderStyle,
  borderCss,
  normCrop,
  type BorderSide,
  FIXED_SPACE,
  pushAll,
} from '../common';
import { applyPageNumStyle, stripLayout, charMarks, paraAttrs, paraBorderFrom, imgFillFit, langFontsOf, lineColorOf, gradientCss, gradientOf, pageBorderOf, type CharPr, type ParaPr, type BorderFill, type Numbering } from '../hwpx/reader';
import { type Gradient, type Mat, type ShapeData, type ShapeItem, type ShapeRaw, HWP_ARROW_SIZES, HWP_ARROW_STYLES, HWP_LINE_STYLES, SHADOW_DEFAULT, SHADOW_UNIT_PX, arrowOf, arrowSizeOf, composeMats, matOfHwp, shapeBounds } from '../shape';

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
  PAGE_BORDER_FILL: 75,
  SHAPE_COMPONENT: 76,
  TABLE: 77,
  SHAPE_COMPONENT_LINE: 78,
  SHAPE_COMPONENT_RECTANGLE: 79,
  SHAPE_COMPONENT_ELLIPSE: 80,
  SHAPE_COMPONENT_ARC: 81,
  SHAPE_COMPONENT_POLYGON: 82,
  SHAPE_COMPONENT_CURVE: 83,
  SHAPE_COMPONENT_OLE: 84,
  SHAPE_COMPONENT_PICTURE: 85,
  SHAPE_COMPONENT_CONTAINER: 86,
  CTRL_DATA: 87,
  EQEDIT: 88,
  SHAPE_COMPONENT_TEXTART: 90,
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

/** 글자 모양의 밑줄·취소선 모양 번호 → 이름 (0 실선은 따로 두지 않는다) */
const LINE_SHAPE_NAMES = ['', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLE_WAVE'];
/** 글자 겹침의 테두리 모양 번호 → 이름 */
const COMPOSE_SHAPE_NAMES = ['CHAR', 'SHAPE_CIRCLE', 'SHAPE_REVERSAL_CIRCLE', 'SHAPE_RECTANGLE', 'SHAPE_REVERSAL_RECTANGLE', 'SHAPE_TRIANGLE', 'SHAPE_REVERSAL_TIRANGLE', 'SHAPE_LIGHT', 'SHAPE_RHOMBUS', 'SHAPE_REVERSAL_RHOMBUS', 'SHAPE_ROUNDED_RECTANGLE'];

// ---------- DocInfo ----------
interface DocInfo {
  charPrs: CharPr[];
  paraPrs: ParaPr[];
  borderFills: BorderFill[]; // 1부터 시작하는 id → index id-1
  numberings: Numbering[]; // 1부터
  bullets: string[]; // 1부터
  /** 글머리표의 머리 모양 (bullets 와 같은 차례) */
  bulletHeads: ParaHead[];
  /** '쪽 번호' 스타일의 글자 모양 번호 */
  pageNumCharPr?: number;
  binData: Map<number, { ext: string; compress: number }>;
}

function parseDocInfo(recs: Rec[]): DocInfo {
  const info: DocInfo = { charPrs: [], paraPrs: [], borderFills: [], numberings: [], bullets: [], bulletHeads: [], binData: new Map() };
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
        // 대각선: 속성 bit 2~4 가 ／ 모양, bit 5~7 이 ＼ 모양 (0 이면 없음). 선 종류(26)·굵기(27)·색(28)
        const da = u16(r, 0);
        const slash = ((da >>> 2) & 7) !== 0;
        const back = ((da >>> 5) & 7) !== 0;
        const diag = (slash || back) && u8(r, 26) !== 0 ? { ...(slash ? { slash: true } : {}), ...(back ? { back: true } : {}), c: colorRefToHex(u32(r, 28)) || '#000000' } : null;
        info.borderFills.push({ bg, noBorders, css: borderCss(sides), img, gradient, diag });
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
          // 밑줄 모양(bit 4~7)·색, 취소선 모양(bit 26~29)·색, 강조점(bit 21~24), 글자 위치(언어별 1바이트, 한글 것)
          ulShape: LINE_SHAPE_NAMES[(attr >>> 4) & 0xf] || null,
          ulColor: lineColorOf(colorRefToHex(u32(r, 56)), colorRefToHex(color)),
          ulPos: ulType === 3 ? 'top' : null,
          stShape: LINE_SHAPE_NAMES[(attr >>> 26) & 0xf] || null,
          stColor: r.data.length >= 74 ? lineColorOf(colorRefToHex(u32(r, 70)), colorRefToHex(color)) : null,
          emphasis: ['', 'DOT_ABOVE', 'RING_ABOVE', 'CARON', 'TILDE', 'SIDE', 'COLON'][(attr >>> 21) & 0xf] || null,
          offset: i8(r, 35) || undefined,
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
          // 문단 테두리: 테두리/배경 번호 뒤에 글과의 간격(왼·오른·위·아래, 각 2바이트), 속성1 bit 28 이어진 문단과 연결
          border: paraBorderFrom(bfId ? info.borderFills[bfId - 1] : undefined, [34, 36, 38, 40].map((o) => r.dv.getInt16(o, true)), ((a1 >>> 28) & 1) === 1),
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
          const head = paraHeadAt(r, o);
          o += 12;
          const { s, end } = wstr(r, o);
          o = end;
          levels.push({ text: s, format: HWP_NUM_FORMATS[(a >>> 5) & 0xf] || 'DIGIT', start: 1, head });
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
        info.bulletHeads.push(paraHeadAt(r, 0));
        break;
      }
      case T.STYLE: {
        // 스타일: 이름, 영문 이름, 속성(1) 다음 스타일(1) 언어(2) 문단 모양(2) 글자 모양(2)
        const nm = wstr(r, 0);
        const en = wstr(r, nm.end);
        if ((nm.s === '쪽 번호' || en.s === 'Page Number') && info.pageNumCharPr == null && en.end + 8 <= r.data.length) info.pageNumCharPr = u16(r, en.end + 6);
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

/**
 * 문단 머리 정보 (문단 번호의 수준마다, 글머리표마다 12바이트): 속성(4: bit 0~1 정렬, 3 자동 내어쓰기, 4 본문과의 거리가 값),
 * 너비 조정(2), 본문과의 거리(2: 글자 크기의 % 또는 값), 글자 모양(4: 0xFFFFFFFF 면 문단의 글자 모양)
 */
function paraHeadAt(r: Rec, o: number): ParaHead {
  const a = u32(r, o);
  const dist = o + 8 <= r.data.length ? r.dv.getInt16(o + 6, true) : 50;
  const adj = o + 6 <= r.data.length ? r.dv.getInt16(o + 4, true) : 0;
  const cs = u32(r, o + 8);
  const value = ((a >>> 4) & 1) === 1;
  return {
    align: (['left', 'center', 'right'] as const)[a & 3] || 'left',
    auto: ((a >>> 3) & 1) === 1,
    adj: hwpToPt(adj),
    pct: value ? null : dist,
    gap: value ? hwpToPt(dist) : null,
    charPr: cs === 0xffffffff ? null : cs,
  };
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
  /** 이 문단에서 읽은 감추기 (첫 블록에 단다) */
  private pageHide: string | null = null;
  /** 지금 읽는 문단이 놓인 쪽 (0 부터; 쪽 나누기와 줄 정보로 센다) */
  private page = 0;
  private lastVpos = 0;
  private topParas = 0;
  private pageMarks = new HwpPageMarks();
  /** 머리말/꼬리말을 읽는 중 (쪽 번호 필드를 {{PAGE}} 로) */
  private inHF = false;
  /** 쪽 번호 매기기를 이미 만났다 */
  private pgnpSeen = false;
  /** 한글 배치를 옮기는 동안 이어 가는 값 (앞 문단이 끝난 자리, 블록 차례) */
  private layState: LayoutState = { prevEndV: 0, seq: 0 };

  /** 다단: 지금 구역의 다단(한 단이면 null), 지금 다단의 단 수, 지금 문단이 놓인 단, 구역의 첫 문단을 읽을 차례인가 */
  private secCols: Columns | null = null;
  private colCount = 1;
  private col = 0;
  private secFirst = true;
  /** 본문 문단의 줄 정보가 형식뿐인지 (다른 프로그램이 쓴 파일) */
  segStats = new LineSegStats();

  /** 구역이 바뀌면 쪽 안 자리 셈을 새로 */
  startSection() {
    this.sectionPage = null;
    this.layState.prevEndV = 0;
    this.secCols = null;
    this.colCount = 1;
    this.col = 0;
    this.secFirst = true;
  }

  /** 지금 구역 용지의 크기와 본문 자리 (px) */
  private pageGeom = (): PageGeomPx => {
    const p = this.sectionPage || this.settings.page;
    const MM = 96 / 25.4;
    const W = (p.landscape ? Math.max(p.width, p.height) : p.width) * MM;
    const H = (p.landscape ? Math.min(p.width, p.height) : p.height) * MM;
    const ml = (p.marginLeft + p.gutter) * MM;
    const mt = (p.marginTop + p.marginHeader) * MM;
    return { W, H, ml, mt, bodyW: W - ml - p.marginRight * MM, bodyH: H - mt - (p.marginBottom + p.marginFooter) * MM };
  };

  constructor(
    private info: DocInfo,
    private images: Map<number, string>,
    public settings = defaultSettings(),
    public warnings: string[] = [],
  ) {}

  private charPr(id: number) {
    return this.info.charPrs[id];
  }

  /** 방금 만든 머리 글자의 모양 (numberPrefix 가 채운다) */
  private prefixHead: ParaHead | null = null;

  private numberPrefix(pp: ParaPr): string | null {
    this.prefixHead = null;
    if (pp.headingType === 'NONE') return null;
    if (pp.headingType === 'BULLET') {
      this.prefixHead = this.info.bulletHeads[+pp.headingIdRef - 1] || null;
      return (this.info.bullets[+pp.headingIdRef - 1] || '•') + ' ';
    }
    const numId = pp.headingType === 'OUTLINE' ? this.outlineNumId : pp.headingIdRef;
    const nb = this.info.numberings[+numId - 1];
    if (!nb) return null;
    const lvl = Math.max(0, Math.min(6, pp.headingLevel));
    const def = nb.levels[lvl];
    if (!def || !def.text) return null;
    this.prefixHead = def.head || null;
    const vals = this.counter.next(numId, lvl, def.start || 1);
    return applyNumFormat(def.text, vals, nb.levels.map((l) => l.format)) + ' ';
  }

  convertParagraphs(paras: Rec[], inSub: boolean, bg?: string | null, width?: number, origin?: { x: number; y: number }): JNode[] {
    const groups: JNode[][] = [];
    for (const p of paras) if (p.tag === T.PARA_HEADER) groups.push(this.convertPara(p, inSub, bg, width, origin));
    // 칸·글상자 안: 한글이 놓은 문단 사이가 더 벌어져 있으면(개체가 글을 밀어낸 자리 등) 그만큼 띄운다
    if (inSub) gapInBox(groups);
    return groups.flat();
  }

  /** origin: 머리말·꼬리말·바탕쪽 영역의 왼쪽 위가 종이에서 놓인 자리 (종이·쪽 기준 개체의 자리를 셈한다) */
  convertPara(p: Rec, inSub: boolean, bg?: string | null, width?: number, origin?: { x: number; y: number }): JNode[] {
    const psId = u16(p, 8);
    const breakType = u8(p, 11);
    const pp = this.info.paraPrs[psId];
    const pAttrs = paraAttrs(pp);
    // 개요 문단: 차례 만들기가 제목으로 쓴다
    if (pp && pp.headingType === 'OUTLINE') pAttrs.outlineLevel = Math.max(0, Math.min(9, pp.headingLevel)) + 1;
    if (bg && !pAttrs.paraBg) pAttrs.paraBg = bg;
    const blocks: JNode[] = [];
    /** 쪽 나누기 없이 한글이 새 쪽에 놓은 문단 */
    let hwpPage = false;
    let vpos: number | null = null;
    /** 이 문단이 시작한 단 (다단), 단이 바뀌었는가 */
    let startCol = 0;
    let newCol = false;
    if (!inSub) {
      // 쪽 세기: 쪽 나누기, 또는 한글이 배치해 둔 줄 정보(첫 줄의 세로 위치)가 되돌아가면 새 쪽 (첫 문단 앞은 세지 않는다)
      const seg = p.children.find((c) => c.tag === T.PARA_LINE_SEG);
      vpos = seg && seg.data.length >= 8 ? i32(seg, 4) : null;
      if (seg && vpos != null) this.segStats.note(Math.floor(seg.data.length / 36), vpos);
      const pb = !!(breakType & 0x05);
      const started = this.topParas++ > 0;
      const reset = started && !pb && vpos != null && vpos < this.lastVpos;
      // 다단 정의(cold): 구역의 첫 문단에 있으면 그 구역의 다단, 그 밖에는 '다단 설정 나누기' (여기서부터 새 다단)
      const first = this.secFirst;
      this.secFirst = false;
      const cold = p.children.find((c) => c.tag === T.CTRL_HEADER && ctrlIdOf(c) === 'cold');
      const cols = cold ? columnsOfCold(cold, this.pageGeom().bodyW / (96 / 25.4)) : null;
      const colBreak = !!(breakType & 0x08) && started;
      let zone = false;
      if (cols && first) {
        this.colCount = cols.count;
        this.secCols = cols.count > 1 ? cols : null;
        if (this.sectionPage && this.secCols) this.sectionPage.columns = this.secCols;
      } else if (cols) {
        this.colCount = cols.count;
        zone = true;
      }
      if (pb) this.col = 0;
      else if (zone) {
        // 새 다단은 앞 다단 아래에서 시작한다. 세로 위치가 되돌아갔으면 다음 쪽에서 시작한 것이다
        this.col = 0;
        hwpPage = reset;
      } else if (reset || colBreak) {
        // 세로 위치가 되돌아갔다: 다음 단으로 넘어갔거나, 마지막 단이었으면 다음 쪽이다
        if (this.col < this.colCount - 1) {
          this.col++;
          newCol = true;
        } else {
          this.col = 0;
          hwpPage = true;
        }
      }
      if (started && (pb || hwpPage)) this.page++;
      startCol = this.col;
      // 문단 안에서 줄의 세로 위치가 되돌아간 곳마다 단(쪽)이 바뀐다
      if (seg) for (let o = 36; o + 36 <= seg.data.length; o += 36) if (i32(seg, o + 4) < i32(seg, o - 32)) this.col = this.col < this.colCount - 1 ? this.col + 1 : 0;
      // 다음 문단과는 이 문단 마지막 줄의 세로 위치로 견준다 (여러 줄 문단은 줄 사이에서 쪽이 바뀔 수 있다)
      if (seg && seg.data.length >= 36) this.lastVpos = i32(seg, (Math.floor(seg.data.length / 36) - 1) * 36 + 4);
      if (pb) blocks.push({ type: 'pageBreak' });
      if (zone) blocks.push({ type: 'columnBreak', attrs: { columns: cols, hwp: true } });
      else if (colBreak && !pb) blocks.push({ type: 'columnBreak', attrs: { hwp: true } });
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
    // 줄 정보 36바이트: 글자 위치, 세로 위치, 줄 높이, 글자 높이, 기준선, 줄 간격, 가로 시작 자리, 줄 폭, 속성.
    // 셋째 값: 가로 시작 자리에서 문단 왼쪽 여백을 뺀 것 — 어울림으로 놓인 개체를 피해 들어간 몫
    const lineSegs: [number, number, number][] = [];
    const leftPx = (pp?.indentLeft || 0) * (96 / 72);
    if (lineRec) for (let o = 0; o + 36 <= lineRec.data.length; o += 36) lineSegs.push([u32(lineRec, o), hwpToPx(i32(lineRec, o + 28)), hwpToPx(i32(lineRec, o + 24)) - leftPx]);
    const lineAt = new Map<number, number>();
    /** 한글이 놓은 줄마다의 세로 자리 (px): [줄 위쪽, 줄 높이, 줄 아래 간격, 기준선]. 줄 정보 36바이트: 글자 위치, 세로 위치, 줄 높이, 글자 높이, 기준선, 줄 간격 … */
    const segV: number[][] = [];
    if (lineRec) for (let o = 0; o + 36 <= lineRec.data.length; o += 36) segV.push([4, 8, 20, 16].map((k) => Math.round(hwpToPx(i32(lineRec, o + k)) * 100) / 100));
    // 문단에 글이 있는가 (빈칸·컨트롤뿐이면 아니다): 컨트롤 글자는 8칸(글자 컨트롤 0·10·13·24~31 은 1칸)
    let hasText = false;
    if (textRec)
      for (let o = 0; o + 2 <= textRec.data.length && !hasText; ) {
        const ch = u16(textRec, o);
        if (ch < 32) o += ch === 0 || ch === 10 || ch === 13 || ch >= 24 ? 2 : 16;
        else {
          if (ch !== 32 && ch !== 0xa0 && ch !== 0x3000) hasText = true;
          o += 2;
        }
      }
    const lay = new ParaLayout(segV, {
      inSub,
      width,
      geom: this.pageGeom,
      hasText,
      // 새 단으로 넘어온 문단도 단 맨 위에서 시작한다
      hwpPage: hwpPage || newCol,
      pageBreak: !inSub && !!(breakType & 0x05),
      pp: { spaceBefore: pp?.spaceBefore || 0, spaceAfter: pp?.spaceAfter || 0, indentLeft: pp?.indentLeft || 0, indentRight: pp?.indentRight || 0, textIndent: pp?.textIndent || 0 },
      state: this.layState,
      origin,
      line0: lineSegs.length ? { x: lineSegs[0][2] + leftPx, w: lineSegs[0][1] } : undefined,
      align: pAttrs.textAlign || null,
    });

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
      // 머리 글자: 제 글자 모양이 있으면 그것으로, 없으면 문단 첫 글자의 모양으로. 폭·내어쓰기는 마크가 전한다
      const head = this.prefixHead;
      const hcp = head && typeof head.charPr === 'number' ? this.charPr(head.charPr) || firstCp : firstCp;
      const t = textNode(prefix, head ? [...charMarks(hcp), headMark(head)] : charMarks(firstCp));
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
          const res = this.handleCtrl(ctrl, shapeAt(i), inline, captions, lay);
          if (res.length) {
            for (const b of res) {
              if (b.type !== 'table') continue;
              if (!b.attrs?.inline) {
                // 떠 있는 표: 문단 정렬이 아니라 개체의 가로 기준·맞춤을 따른다
                const op = objPosOf(ctrl);
                floatTableX(b, { hAl: op.hAl, hRel: op.hRel, hOff: op.hOff * 0.75 }, { indentLeft: pp?.indentLeft || 0 }, inSub ? 0 : this.pageGeom().ml * 0.75);
              } else if (pAttrs.textAlign === 'center' || pAttrs.textAlign === 'right') b.attrs = { ...b.attrs, align: pAttrs.textAlign };
              else if (pp) indentByPara(b, pp);
            }
            const table = ctrlIdOf(ctrl) === 'tbl ' ? res.find((b) => b.type === 'table') : undefined;
            // 떠 있는 글상자·도형은 문단 앞에 높이 없는 블록으로, 떠 있는 표는 글을 쪼개지 않고 앞이나 뒤로
            const floats = res.filter((b) => b.attrs?.float);
            const rest = res.filter((b) => !b.attrs?.float);
            lay.before.push(...floats);
            if (table && lay.placeTable(rest, table, objPosOf(ctrl))) {
              /* 떠 있는 표: 배치 셈이 맡았다 */
            } else if (rest.length) {
              flush();
              blocks.push(...rest);
              produced = true;
            }
          }
        }
        i += 8;
      }
      pushText();
    }
    // 텍스트 없이 컨트롤만 있는 경우(구역 정의 등)
    for (; ctrlIdx < ctrls.length; ctrlIdx++) {
      const id = ctrlIdOf(ctrls[ctrlIdx]);
      if (id === 'secd' || id === 'cold' || id === 'head' || id === 'foot' || id === 'pgnp' || id === 'nwno' || id === 'pghd') this.handleCtrl(ctrls[ctrlIdx], 0, inline);
    }
    const lineSize = inline.length && !produced ? inlineSize() : 0;
    // 표(블록)로 쪼개진 문단에 떠 있는 개체만 남았으면: 표와 같은 줄에 걸린 개체다. 새 문단(빈 줄)을 세우지 않고
    // 높이 없는 자리 표시에 담아 표 앞에 둔다 (HWPX 와 같게)
    if (produced && inline.length && inline.every((n) => !!n.attrs?.float && n.type !== 'text')) {
      lay.before.push({ type: 'textBox', attrs: { width: null, height: null, padding: [0, 0, 0, 0], float: { x: 0, y: 0 } }, content: [paragraph({ ...pAttrs, fontSize }, inline)] });
      inline = [];
    }
    if (inline.length) flush();
    else if (!produced) blocks.push(paragraph({ ...pAttrs, fontSize }));
    // 문단이 표 등으로 쪼개지지 않고 줄 위치를 모두 찾았을 때만. 첫 줄은 문단 번호(머리 글자)부터
    lineAt.set(0, 0);
    // 떠 있는 개체 표시는 늘 지운다 (문서 노드에는 없는 속성)
    const floating = blocks.map(takeFloating).some(Boolean);
    // 줄 자리·쪽 안 위치·블록 차례를 달고 떠 있는 블록을 앞뒤에 놓는다 (hwpLayout)
    const lines: [number, number][] | null =
      lineSize && lineSegs.length && lineSegs.every((s) => lineAt.has(s[0]))
        ? lineSegs.map((s) => (s[2] > 2 ? [lineAt.get(s[0])!, Math.round(s[1] * 100) / 100, Math.round(s[2] * 100) / 100] : [lineAt.get(s[0])!, Math.round(s[1] * 100) / 100]) as [number, number])
        : null;
    const seq0 = this.layState.seq;
    const done = lay.finish(blocks, lines, floating, { lineSegs, at: lineAt });
    const out = placeCaptions(done.blocks, captions);
    if (!inSub && this.pageHide) {
      const first = out.find((b) => !isBreakBlock(b));
      if (first) first.attrs = { ...first.attrs, pageHide: cleanPageHide(this.pageHide) };
      this.pageHide = null;
    }
    if (!inSub) {
      // 캡션 문단도 본문 블록이다: 차례가 끊기지 않게 캡션까지 넣어 다시 매긴다
      this.layState.seq = seq0;
      for (const b of out) {
        if (isBreakBlock(b)) continue;
        b.attrs = { ...b.attrs, hwpSeq: ++this.layState.seq };
        if (b.attrs.hwpLen == null) b.attrs.hwpLen = jsonContentSize(b);
        if (startCol > 0) b.attrs.hwpCol = startCol;
      }
      this.pageMarks.mark(done.lead || out.find((b) => !isBreakBlock(b)), vpos, hwpPage);
    }
    return out;
  }

  /** 확장 컨트롤 처리. 블록을 반환하면 문단을 끊고 삽입 */
  private handleCtrl(ctrl: Rec, shapeId: number, inline: JNode[], captions?: Captions, lay?: ParaLayout): JNode[] {
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
        return this.convertGso(ctrl, inline, captions, lay);
      case 'head':
      case 'foot': {
        // 쪽 종류 (속성 bit 0~1: 0 양쪽, 1 짝수 쪽, 2 홀수 쪽): 양쪽·홀수는 기본 자리에, 짝수는 even 에.
        // 같은 종류가 또 나오면(뒤 구역) 먼저 것을 둔다 (HWPX 리더와 같다)
        const kind = u32(ctrl, 4) & 3;
        const main = id === 'head' ? this.settings.header : this.settings.footer;
        const mainSet = !!(main.text || main.content);
        let target: typeof main;
        if (kind === 1) {
          if (main.even) return [];
          target = main.even = { text: '', align: 'center' };
        } else {
          if (mainSet) return [];
          target = main;
          if (kind === 2) main.oddOnly = true;
        }
        // 머리말이 시작하는 쪽 (첫 쪽이 아니면 앞 쪽들에는 없다)
        if (main.from == null || this.page < main.from) main.from = this.page;
        this.inHF = true;
        let blocks: JNode[];
        try {
          // 영역의 종이 안 자리: 머리말은 위쪽 여백 아래, 꼬리말은 본문 아래 (종이·쪽 기준으로 놓인 개체의 자리를 셈한다)
          const g = this.pageGeom();
          const pg = this.sectionPage || this.settings.page;
          // 글 영역 폭: 머리말·꼬리말 문단 목록 머리의 폭 (없으면 본문 폭)
          const lhw = ctrl.children.find((c) => c.tag === T.LIST_HEADER);
          const hfW = lhw && lhw.data.length >= 12 && u32(lhw, 8) > 0 ? hwpToPx(u32(lhw, 8)) : g.bodyW;
          blocks = this.convertParagraphs(ctrl.children, true, undefined, hfW, { x: g.ml, y: id === 'head' ? pg.marginTop * (96 / 25.4) : g.mt + g.bodyH }).map(stripLayout);
        } finally {
          this.inHF = false;
        }
        const text = this.subText(ctrl, true) || plainText(blocks);
        if (text) {
          target.text = text;
          const firstPara = ctrl.children.find((c) => c.tag === T.PARA_HEADER);
          const pp = firstPara ? this.info.paraPrs[u16(firstPara, 8)] : undefined;
          target.align = pp?.align === 'right' ? 'right' : pp?.align === 'left' ? 'left' : 'center';
        }
        // 글자 모양·정렬·표·그림까지 한글 그대로 그리도록 문단 블록도 담는다 (쪽 번호는 {{PAGE}})
        if (text || blocks.some(hasObject)) target.content = blocks as any;
        else delete target.content;
        // 영역 안 세로 맞춤 (문단 목록 머리의 속성 bit 5~6: 0 위, 1 가운데, 2 아래)
        const lh = ctrl.children.find((c) => c.tag === T.LIST_HEADER);
        const va = lh ? (u32(lh, 2) >>> 21) & 3 : 0;
        if (va === 2) target.valign = 'bottom';
        else if (va === 1) target.valign = 'middle';
        else delete target.valign;
        return [];
      }
      case 'fn  ':
      case 'en  ':
        inline.push({ type: 'footnote', attrs: { text: this.subText(ctrl, false) } });
        return [];
      case 'pghd': {
        // 감추기: 이 문단이 놓인 쪽에서 감출 것 (속성 비트: 머리말, 꼬리말, 바탕쪽, 테두리, 배경, 쪽 번호). 문단의 첫 블록에 단다
        const a = u32(ctrl, 4);
        const flags = ['h', 'f', 'm', 'b', 'x', 'n'].filter((_, i) => a & (1 << i)).join('');
        if (flags) this.pageHide = (this.pageHide || '') + flags;
        return [];
      }
      case 'pgnp': {
        const a = u32(ctrl, 4);
        const fmt = a & 0xff;
        const pos = (a >>> 8) & 0xf;
        const POS = ['none', 'top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right', 'top-right', 'bottom-right', 'top-left', 'bottom-left'];
        // 쪽 번호 매기기가 뒤쪽에서 시작하면 앞 쪽들에는 찍지 않는다 (처음 나온 자리가 시작 쪽)
        const first = this.settings.pageNumber.pos === 'none' && !this.pgnpSeen;
        this.pgnpSeen = true;
        this.settings.pageNumber.pos = (POS[pos] || 'bottom-center') as any;
        const dash = u16(ctrl, 14);
        this.settings.pageNumber.format = fmt === 3 ? 'roman' : fmt === 2 ? 'ROMAN' : dash === 0x2d ? 'dash' : 'digit';
        if (first && this.page > 0 && pos !== 0) this.settings.pageNumber.from = this.page;
        return [];
      }
      case 'nwno': {
        // 새 번호로 시작 (속성 bit 0~3: 0 쪽 번호): 이 문단이 있는 쪽이 그 번호가 된다
        if ((u32(ctrl, 4) & 0xf) === 0) {
          this.settings.pageNumber.start = Math.max(1, u16(ctrl, 8));
          if (this.page > 0) this.settings.pageNumber.base = this.page;
        }
        return [];
      }
      case 'pghd': {
        // 감추기 (속성 bit 0 머리말, 1 꼬리말, 5 쪽 번호): 첫 쪽(표지)의 것만 따른다
        if (this.page === 0) {
          const a = u32(ctrl, 4);
          const h = { header: !!(a & 1), footer: !!(a & 2), pageNum: !!(a & 0x20) };
          if (h.header || h.footer || h.pageNum) this.settings.hideFirst = { ...this.settings.hideFirst, ...Object.fromEntries(Object.entries(h).filter(([, v]) => v)) };
        }
        return [];
      }
      case '%hlk': {
        const cmd = wstr(ctrl, 9).s;
        this.linkHref = cmd.split(';')[0].replace(/\\:/g, ':') || null;
        return [];
      }
      case 'tdut': {
        // 덧말: 본말, 덧말, 위치(0 위, 1 아래) …
        const main = wstr(ctrl, 4);
        const sub = wstr(ctrl, main.end);
        const marks = charMarks(this.charPr(shapeId), this.linkHref);
        if (sub.s) marks.push({ type: 'ruby', attrs: { text: sub.s, pos: u32(ctrl, sub.end) === 1 ? 'bottom' : 'top' } });
        const t = textNode(main.s || sub.s, marks);
        if (t) inline.push(t);
        return [];
      }
      case 'tcps': {
        // 글자 겹침: 겹칠 글자, 테두리 모양(1), 안 글자 크기(1), 펼침(1), 글자 모양 수(1)와 번호들
        const text = wstr(ctrl, 4);
        if (!text.s) return [];
        const shape = COMPOSE_SHAPE_NAMES[u8(ctrl, text.end)] || 'SHAPE_CIRCLE';
        const n = u8(ctrl, text.end + 3);
        const cid = n > 0 && ctrl.data.length >= text.end + 8 ? u32(ctrl, text.end + 4) : 0xffffffff;
        const cp = cid !== 0xffffffff && this.info.charPrs[cid] ? this.info.charPrs[cid] : this.charPr(shapeId);
        const t = textNode(text.s, [...charMarks(cp, this.linkHref), { type: 'compose', attrs: { shape } }]);
        if (t) inline.push(t);
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
    // 다단은 구역마다 따로 정한다 (구역의 첫 문단에 든 단 정의)
    const pg: PageSetup = { ...this.settings.page };
    if (this.secCols) pg.columns = this.secCols;
    else delete pg.columns;
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
    const firstSec = !this.settingsSet;
    if (!this.settingsSet) {
      this.settingsSet = true;
      this.settings.page = pg;
    }
    if (!this.sectionPage) this.sectionPage = pg;
    if (!firstSec) return;
    // 구역 속성: bit 2 첫 쪽에 바탕쪽 감춤, 3 테두리 감춤, 4 배경 감춤, 8 첫 쪽에만 테두리, 9 첫 쪽에만 배경
    const sp = u32(ctrl, 4);
    // 쪽 테두리/배경 (양쪽·짝수·홀수 차례로 세 개: 양쪽 것을 쓴다). 속성: bit 0 위치 기준, 1 머리말 포함, 2 꼬리말 포함, 3~4 채울 영역
    const pbf = ctrl.children.find((c) => c.tag === T.PAGE_BORDER_FILL);
    if (pbf && pbf.data.length >= 14) {
      const a = u32(pbf, 0);
      const bf = this.info.borderFills[u16(pbf, 12) - 1];
      const image = bf?.img ? this.images.get(+bf.img.id) || null : null;
      const pb = pageBorderOf(bf, {
        paperBasis: (a & 1) === 1,
        offsetHwp: [u16(pbf, 4), u16(pbf, 6), u16(pbf, 8), u16(pbf, 10)],
        headerInside: !!(a & 2),
        footerInside: !!(a & 4),
        fillArea: ['PAPER', 'PAGE', 'BORDER'][(a >>> 3) & 3] || 'PAPER',
        image: image && /^data:image\//.test(image) ? image : null,
      });
      if (pb) {
        if (sp & (1 << 8)) pb.borderOn = 'first';
        else if (sp & (1 << 3)) pb.borderOn = 'notFirst';
        if (sp & (1 << 9)) pb.fillOn = 'first';
        else if (sp & (1 << 4)) pb.fillOn = 'notFirst';
        this.settings.pageBorder = pb;
      }
    }
    if (sp & (1 << 2)) this.settings.hideFirst = { ...this.settings.hideFirst, masterPage: true };
    // 바탕쪽: 구역 정의 아래의 문단 목록들 (양쪽·짝수·홀수 차례)
    const masters: NonNullable<DocSettings['masterPages']> = [];
    let cur: Rec[] | null = null;
    const lists: Rec[][] = [];
    for (const c of ctrl.children) {
      if (c.tag === T.LIST_HEADER) lists.push((cur = []));
      else if (c.tag === T.PARA_HEADER && cur) cur.push(c);
    }
    const g = this.pageGeom();
    lists.slice(0, 3).forEach((paras, i) => {
      if (!paras.some((p) => paraHasContent(p))) return;
      this.inHF = true;
      try {
        const content = this.convertParagraphs(paras, true, undefined, g.bodyW, { x: g.ml, y: g.mt }).map(stripLayoutAttrs);
        if (content.length) masters.push({ content: content as any, type: (['both', 'even', 'odd'] as const)[i] });
      } finally {
        this.inHF = false;
      }
    });
    if (masters.length) this.settings.masterPages = masters;
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

  /** 칸 안 문단에 떠 있는 개체(글자처럼 취급하지 않고 문단 기준으로 놓인 것)의 아래 끝 가운데 가장 아래 (px, 칸 안쪽 위끝 기준). 없으면 0 */
  private cellObjectsBottom(paras: Rec[]): number {
    let bottom = 0;
    /** 앞 문단이 끝난 자리 (px): 개체에 밀려 내려간 첫 줄의 문단 위끝 */
    let prevEnd = 0;
    for (const p of paras) {
      if (p.tag !== T.PARA_HEADER) continue;
      const seg = p.children.find((c) => c.tag === T.PARA_LINE_SEG);
      if (!seg || seg.data.length < 8) continue;
      const pp = this.info.paraPrs[u16(p, 8)];
      const v0 = hwpToPx(i32(seg, 4));
      const top = v0 - (pp?.spaceBefore || 0) * (96 / 72);
      const lo = (Math.floor(seg.data.length / 36) - 1) * 36;
      const segEnd = lo >= 0 && seg.data.length >= lo + 36 ? hwpToPx(i32(seg, lo + 4) + i32(seg, lo + 8) + i32(seg, lo + 20)) : v0;
      for (const c of p.children) {
        if (c.tag !== T.CTRL_HEADER) continue;
        const id = ctrlIdOf(c);
        if (id !== 'gso ' && id !== 'tbl ') continue;
        const o = objPosOf(c);
        if (o.inline || o.vRel !== 'PARA') continue;
        const raw = o.vOff + o.h + o.omB;
        // 자리를 차지하는 개체가 첫 줄을 아래로 밀었으면 문단 위끝은 앞 문단 끝이다 (밀린 줄 자리를 위끝으로 보면 개체 높이를 두 번 센다)
        const pushed = o.wrap === 'TOP_AND_BOTTOM' && v0 >= prevEnd + raw - 1.5;
        const b = (pushed ? prevEnd : top) + raw;
        if (b > bottom && b < 30000) bottom = b;
      }
      prevEnd = segEnd;
    }
    return bottom;
  }

  convertTable(ctrl: Rec): JNode {
    const tbl = ctrl.children.find((c) => c.tag === T.TABLE);
    const nRowsDecl = tbl ? u16(tbl, 4) : 0;
    const repeatHeader = !!tbl && (u32(tbl, 0) & 4) !== 0;
    type Cell = { row: number; col: number; cs: number; rs: number; w: number; node: JNode };
    const cells: Cell[] = [];
    const rowH: number[] = [];
    /** 여러 줄을 합친 칸: 첫 줄, 줄 수, 칸 높이(px), 내용이 요구하는 높이(px) */
    const spans: { row: number; rs: number; h: number; need: number }[] = [];
    /** 줄마다 낱칸 내용이 요구하는 높이(px, 위아래 안 여백 포함): 적힌 칸 높이보다 클 때만 */
    const rowNeed: number[] = [];
    const VM = hwpToPx(CELL_VMARGIN_HWP);
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
      // 칸의 안 여백: '칸 여백 지정'(속성 뒤 2바이트의 bit 0)이 켜진 칸만 제 값을 쓰고, 아니면 표의 기본 안 여백을 쓴다
      const ownMargin = (u16(lh, 6) & 1) === 1;
      const cmv = ownMargin || !tbl ? [u16(lh, 24), u16(lh, 26), u16(lh, 28), u16(lh, 30)] : [u16(tbl, 10), u16(tbl, 12), u16(tbl, 14), u16(tbl, 16)];
      const cellVm = hwpToPx(cmv[2] + cmv[3]);
      let content = this.convertParagraphs(cur.paras, true, null, w - hwpToPx(cmv[0] + cmv[1])).filter((n) => n.type !== 'pageBreak');
      if (!content.length) content = [paragraph()];
      // 적힌 칸 높이가 글보다 작으면 한글은 칸 높이를 내용(마지막 줄의 글자 높이까지)으로 늘린다.
      // 칸 안에 떠 있는 개체(문단 기준)도 칸을 늘린다: 개체 아래 끝 = 문단 위끝(첫 줄 - 문단 위 간격) + 세로 오프셋 + 높이 + 바깥 아래 여백
      const objBottom = this.cellObjectsBottom(cur.paras);
      const objPx = objBottom > 0 ? objBottom + cellVm : 0;
      if (rs === 1 && objPx > 0) rowH[row] = Math.max(rowH[row] || 0, objPx - VM);
      // 칸의 내용이 요구하는 높이: 위 맞춤 칸은 마지막 줄 간격·문단 아래 간격까지 든다 (hwpLayout 의 markCellTrail)
      const va = (attrVal >>> 21) & 3;
      const need = Math.max(markCellTrail(content, hwpToPx(u32(lh, 20)), cellVm, va === 0), objPx > hwpToPx(u32(lh, 20)) + 1 ? objPx : 0);
      if (rs > 1) spans.push({ row, rs, h: hwpToPx(u32(lh, 20)), need });
      // 낱칸의 내용 높이: 합친 칸이 덮은 줄의 실제 높이를 셈할 때 쓴다
      else if (need > 0) rowNeed[row] = Math.max(rowNeed[row] || 0, need);
      const attrs: Record<string, any> = { colspan: cs, rowspan: rs, colwidth: null };
      if (bf?.bg) attrs.backgroundColor = bf.bg;
      if (bf?.gradient) attrs.bgGradient = bf.gradient;
      if (bf && bf.noBorders.length) attrs.borderStyle = bf.noBorders.join(' ');
      if (bf?.css) attrs.borderCss = bf.css;
      if (bf?.diag) attrs.diag = bf.diag;
      const fillSrc = bf?.img ? this.images.get(+bf.img.id) : null;
      if (fillSrc && bf?.img) attrs.bgImages = [{ src: fillSrc, fit: imgFillFit(bf.img.mode) }];
      // 칸 자체 안 여백 (속성 뒤 2바이트의 bit 0 이 켜진 칸만; 아니면 표의 기본 여백)
      // (표의 기본 안 여백이 위·아래 0.5mm 가 아닐 때도 넣는다: 화면의 기본 위·아래 여백은 0.5mm)
      if (ownMargin || Math.abs(cmv[2] - 141) > 2 || Math.abs(cmv[3] - 141) > 2) attrs.margins = cmv.map((v) => Math.round(hwpToPx(v) * 100) / 100);
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
    // 합친 칸으로만 덮인 줄의 높이, 내용이 넘치는 합친 칸의 마지막 줄
    solveSpanRows(rowH, spans, VM, rowNeed);
    const t = assembleTable(cells, nRowsDecl, nColsDecl, hwpToPx(u32(ctrl, 16)), rowH);
    // 표 속성 bit 0~1: 쪽 경계에서 나눔 (0 나누지 않음, 1 셀 단위로 나눔, 2 나눔). hwpSplit 은 쪽 나누기가 쓴다 (화면 전용)
    if (tbl) t.attrs = { cellPadding: Math.round(hwpToPx((u16(tbl, 10) + u16(tbl, 12)) / 2) * 10) / 10, hwpSplit: (['none', 'cell', 'row'] as const)[u32(tbl, 0) & 3] || 'row' };
    // 한글이 적어 둔 표 높이 (px, 쪽에 걸친 표는 첫 쪽 몫). 문서 노드에는 없는 값: 견주기 도구가 읽는다
    t.attrs = { ...t.attrs, hwpH: Math.round(hwpToPx(u32(ctrl, 20)) * 100) / 100 };
    // 쪽 경계에서 나눔 (표 속성 bit 0~1): 0 나누지 않음, 1 셀 단위로 나눔(줄을 통째로 넘김), 2 나눔
    if (tbl) {
      const brk = u32(tbl, 0) & 3;
      if (brk === 1) t.attrs = { ...t.attrs, pageSplit: 'row' };
      else if (brk === 0) t.attrs = { ...t.attrs, pageSplit: 'none' };
    }
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
        const top = Math.round((m[2] + vOff) * 10) / 10;
        // 표가 이어지는 쪽에서는 이 오프셋이 들지 않는다 (쪽 나누기가 뺀다: hwpVOff)
        t.attrs = { ...t.attrs, outMargin: [m[0], m[1], top, m[3]], hwpVOff: Math.round((top - m[2]) * 10) / 10 };
      }
    }
    fitTableLines(t);
    if (caption && caption.length) (t as any).caption = { top: captionTop, blocks: this.convertParagraphs(caption, true) } satisfies Caption;
    return t;
  }

  private convertGso(ctrl: Rec, inline: JNode[], captions?: Captions, lay?: ParaLayout): JNode[] {
    /** 떠 있는 개체의 자리 (글자처럼 취급하거나 자리를 셈할 수 없으면 null) */
    const fp = lay ? lay.floatPos(objPosOf(ctrl)) : null;
    const w = Math.round(hwpToPx(u32(ctrl, 16)));
    const h = Math.round(hwpToPx(u32(ctrl, 20)));
    const pics: Rec[] = [];
    let oleRec: Rec | null = null;
    const texts: { header: Rec; paras: Rec[]; shape: Rec }[] = [];
    let shapeRec: Rec | null = null;
    let rectRec: Rec | null = null;
    let lineRec: Rec | null = null;
    let ellipse = false;
    /** 개체 바로 아래의 LIST_HEADER 는 캡션 (글상자의 문단 목록은 SHAPE_COMPONENT 아래에 있다) */
    let cap: { top: boolean; gap: number; paras: Rec[] } | null = null;
    const visit = (r: Rec) => {
      let curText: { header: Rec; paras: Rec[]; shape: Rec } | null = null;
      for (const c of r.children) {
        if (r === ctrl && c.tag === T.LIST_HEADER) {
          cap = { top: isCaptionTop(c), gap: c.data.length >= 18 ? hwpToPx(u16(c, 16)) : 11.3, paras: [] };
          continue;
        }
        if (r === ctrl && c.tag === T.PARA_HEADER && cap) {
          cap.paras.push(c);
          continue;
        }
        if (c.tag === T.SHAPE_COMPONENT_PICTURE) pics.push(c);
        else if (c.tag === T.SHAPE_COMPONENT_OLE && !oleRec) oleRec = c;
        else if (c.tag === T.SHAPE_COMPONENT && !shapeRec) shapeRec = c;
        else if (c.tag === T.SHAPE_COMPONENT_RECTANGLE) rectRec = c;
        else if (c.tag === T.SHAPE_COMPONENT_LINE) lineRec = c;
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
    const capList = cap as { top: boolean; gap: number; paras: Rec[] } | null;
    /** 캡션: 떠 있는 개체는 개체 아래(위)에 함께 띄울 글상자를, 흐름 안의 개체는 문단 앞뒤에 놓는다 */
    const capFloats: JNode[] = [];
    if (capList && capList.paras.length) {
      const capBlocks = this.convertParagraphs(capList.paras, true);
      if (fp && capBlocks.length) {
        // 캡션 글의 높이: 마지막 문단의 마지막 줄 아래까지 (한글이 적어 둔 줄 자리)
        const lastSeg = capList.paras[capList.paras.length - 1].children.find((c) => c.tag === T.PARA_LINE_SEG);
        const lo = lastSeg && lastSeg.data.length >= 36 ? (Math.floor(lastSeg.data.length / 36) - 1) * 36 : -1;
        const capH = lastSeg && lo >= 0 ? hwpToPx(i32(lastSeg, lo + 4) + i32(lastSeg, lo + 8)) : 16;
        const y = capList.top ? fp.y - capList.gap - capH : fp.y + h + capList.gap;
        capFloats.push({ type: 'textBox', attrs: { width: w || null, height: null, padding: [0, 0, 0, 0], float: { x: fp.x, y: Math.round(y * 100) / 100, ...(fp.behind ? { behind: true } : {}), ...(fp.py != null ? { py: Math.round((fp.py + y - fp.y) * 100) / 100 } : {}) } }, content: capBlocks });
      } else if (captions) (capList.top ? captions.before : captions.after).push(...capBlocks);
    }
    const top = ctrl.children.find((c) => c.tag === T.SHAPE_COMPONENT) || null;
    const topKind = top ? ctrlIdOf(top) : '';
    const oleR = oleRec as Rec | null;
    if (oleR && topKind === '$ole' && oleR.data.length >= 14) {
      // OLE 개체: 개체가 그려 둔 모양(BinData 에서 꺼낸 그림)을 그림처럼 그 자리에. 속성(4) 범위 x·y(8) 다음이 BinData 번호
      const id = u16(oleR, 12);
      const ole: JNode = { type: 'image', attrs: { src: this.images.get(id) || placeholderImage('OLE 개체', w || 120, h || 60), width: w || null, height: h || null, alt: 'OLE 개체' } };
      if (fp && lay) ole.attrs = { ...ole.attrs, float: { ...fp, x: Math.round((fp.x - lay.paraLeft()) * 100) / 100 } };
      else if (!(u32(ctrl, 4) & 1)) ole.attrs = { ...ole.attrs, [FLOATING]: true };
      inline.push(ole);
      return capFloats;
    }
    if (pics.length === 1 && !texts.length && (topKind === '$pic' || !top)) {
      const pic = this.picture(pics[0], w, h);
      // 글자처럼 취급하지 않는(떠 있는) 그림: 한글의 줄 배치에 들지 않는다 (hasFloating)
      // 자리를 아는 떠 있는 그림은 그 자리에 띄운다 (x 는 문단 상자 왼쪽 기준). 모르면 예전처럼 줄 안에
      if (fp && lay) pic.attrs = { ...pic.attrs, float: { ...fp, x: Math.round((fp.x - lay.paraLeft()) * 100) / 100 } };
      else if (!(u32(ctrl, 4) & 1)) pic.attrs = { ...pic.attrs, [FLOATING]: true };
      inline.push(pic);
      return capFloats;
    }
    // 글상자로 읽을 것: 글이 든, 돌리지 않은 사각형·타원 하나. 그 밖의 도형(선·다각형·곡선·호·묶음, 글 없는 도형)은 그려서 보여 준다
    const mt = top ? shapeMatrixOf(top) : null;
    const plain = !!mt && Math.abs(mt.m[1]) < 1e-4 && Math.abs(mt.m[2]) < 1e-4 && mt.m[0] > 0 && mt.m[3] > 0;
    const asTextBox = (topKind === '$rec' || topKind === '$ell') && texts.length === 1 && texts[0].shape === top && plain && texts[0].paras.some((p) => paraHasContent(p));
    if (top && !asTextBox) {
      const node = this.shapeNode(top, w, h);
      if (node) {
        if (fp && lay) node.attrs = { ...node.attrs, float: { ...fp, x: Math.round((fp.x - lay.paraLeft()) * 100) / 100 } };
        else if (!(u32(ctrl, 4) & 1)) node.attrs = { ...node.attrs, [FLOATING]: true };
        inline.push(node);
        return capFloats;
      }
    }
    const blocks: JNode[] = [...capFloats];
    if (texts.length) {
      // 글상자: 도형(또는 그림을 배경으로 한 상자) 안의 문단들
      const st = shapeRec && !pics.length ? shapeStyle(shapeRec) : { borderColor: null, borderWidth: null, bg: null, gradient: null, dash: null };
      const bgImage = pics.length === 1 ? this.pictureSrc(pics[0]) : null;
      let radius: string | null = null;
      if (ellipse) radius = '50%';
      else if (rectRec) {
        const ratio = u8(rectRec, 0);
        if (ratio > 0 && w && h) radius = `${Math.round((Math.min(w, h) * Math.min(50, ratio)) / 100)}px`;
      }
      // 묶음(그룹) 개체 안에 글상자가 여럿이면(예: 제목 탭 + 본문) 한 상자에 차례로 넣는다.
      // 여백은 문단이 가장 많은 글상자(본문)의 것을 쓴다.
      const main = texts.reduce((a, b) => (b.paras.length > a.paras.length ? b : a), texts[0]);
      // LIST_HEADER(글상자): 문단 수(2) 속성(4) 예비(2) 왼쪽·오른쪽·위·아래 여백(각 2)
      const hd = main.header;
      const padding = hd.data.length >= 16 ? [u16(hd, 12), u16(hd, 10), u16(hd, 14), u16(hd, 8)].map((v) => Math.round(hwpToPx(v))) : null;
      const content: JNode[] = [];
      const groupW = u32(ctrl, 16);
      const innerW = w && padding ? w - padding[1] - padding[3] : undefined;
      for (const t of texts) {
        const paras = this.convertParagraphs(t.paras, true, undefined, innerW);
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
        pushAll(content, paras);
      }
      // 글의 세로 맞춤: LIST_HEADER 의 속성(문단 수 4바이트 뒤) bit 5~6 (0 위, 1 가운데, 2 아래)
      const va = hd.data.length >= 8 ? (u32(hd, 4) >>> 5) & 3 : 0;
      // 세로 맞춤은 떠 있는 개체까지 넣은 내용 높이로: 글 아래로 나온 개체만큼 아래 안 여백을 늘린다
      const over = va === 1 || va === 2 ? floatOverhang(content) : 0;
      blocks.push({
        type: 'textBox',
        attrs: {
          width: w || null,
          height: h || null,
          bg: st.bg,
          bgImage,
          bgGradient: st.gradient,
          borderColor: st.borderColor,
          borderWidth: st.borderWidth,
          borderDash: st.dash,
          radius,
          padding: over > 0 ? (Array.isArray(padding) ? padding : [4, 4, 4, 4]).map((v: number, i: number) => (i === 2 ? v + over : v)) : padding,
          ...(va === 1 ? { valign: 'middle' } : va === 2 ? { valign: 'bottom' } : {}),
          ...(fp ? { float: fp } : {}),
        },
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
    for (const t of texts) pushAll(blocks, this.convertParagraphs(t.paras, true));
    return blocks;
  }

  /**
   * 그리기 개체 요소(SHAPE_COMPONENT)를 도형 항목으로 (묶음이면 자식들까지). 자식의 행렬에는 묶음의 변환이 이미 들어 있어
   * 모두 최상위 개체의 틀 기준이다
   */
  private gsoItems(sc: Rec, out: ShapeItem[], depth = 0) {
    if (depth > 16) return;
    const kind = ctrlIdOf(sc);
    if (kind === '$con') {
      for (const c of sc.children) if (c.tag === T.SHAPE_COMPONENT) this.gsoItems(c, out, depth + 1);
      return;
    }
    const mt = shapeMatrixOf(sc);
    if (!mt) return;
    const { m, w, h } = mt;
    const look = shapeLook(sc, this.images);
    const raw: ShapeRaw = { ...mt.raw, ...(look.lw != null ? { lw: look.lw } : {}) };
    delete look.lw;
    const base = { m, w, h, raw };
    const rec = (tag: number) => sc.children.find((c) => c.tag === tag) || null;
    const px = (r: Rec, o: number) => hwpToPx(i32(r, o));
    switch (kind) {
      case '$pic': {
        const p = rec(T.SHAPE_COMPONENT_PICTURE);
        if (!p) return;
        const pic = this.picture(p, 0, 0);
        const src = pic.attrs?.src;
        if (typeof src !== 'string' || !/^data:image\/(png|jpeg|gif|webp|bmp)/.test(src)) return;
        out.push({ k: 'img', ...base, src, crop: pic.attrs?.crop || null });
        return;
      }
      case '$lin':
      case '$col': {
        const r = rec(T.SHAPE_COMPONENT_LINE);
        if (!r || r.data.length < 16) return;
        const a = [px(r, 0), px(r, 4)];
        const b = [px(r, 8), px(r, 12)];
        if (kind === '$col') {
          // 개체 연결선: 종류(4: 0~2 직선, 3~5 꺾인 선, 6~8 곡선; 나머지 3 = 화살표 없음·한쪽·양쪽), 이어진 개체와 그 변, 조절점
          const type = u32(r, 16);
          const cnt = Math.min(64, u32(r, 36));
          const cps: number[] = [];
          for (let k = 0; k < cnt && 40 + k * 10 + 8 <= r.data.length; k++) cps.push(px(r, 40 + k * 10), px(r, 44 + k * 10));
          const lineOnly = { ...look, fc: null, fg: null, fi: null };
          if (cps.length > 4) out.push({ k: 'poly', ...base, ...lineOnly, p: cps });
          else if (type >= 3 && type <= 5) {
            // 꺾인 연결선: 이어진 변(오른쪽·왼쪽이면 가로로, 위·아래면 세로로 나간다)에 맞춰 직각으로 꺾는다
            const sH = u32(r, 24) % 2 === 1;
            const eH = u32(r, 32) % 2 === 1;
            const mid = sH && eH ? [(a[0] + b[0]) / 2, a[1], (a[0] + b[0]) / 2, b[1]] : !sH && !eH ? [a[0], (a[1] + b[1]) / 2, b[0], (a[1] + b[1]) / 2] : sH ? [b[0], a[1]] : [a[0], b[1]];
            out.push({ k: 'poly', ...base, ...lineOnly, p: [...a, ...mid, ...b] });
          } else out.push({ k: 'line', ...base, ...look, p: [...a, ...b] });
          const it = out[out.length - 1];
          if (type % 3 >= 1 && !it.ts) Object.assign(it, { ts: 'ARROW', tf: true, tz: [1, 1] });
          if (type % 3 === 2 && !it.hs) Object.assign(it, { hs: 'ARROW', hf: true, hz: [1, 1] });
        } else out.push({ k: 'line', ...base, ...look, p: [...a, ...b] });
        break;
      }
      case '$rec': {
        const r = rec(T.SHAPE_COMPONENT_RECTANGLE);
        const ratio = r ? u8(r, 0) : 0;
        const c = r && r.data.length >= 33 ? [0, 1, 2, 3].map((k) => [px(r, 1 + k * 8), px(r, 5 + k * 8)]) : null;
        // 꼭짓점이 상자 모서리와 다르면(기울인 사각형) 다각형으로
        const boxLike = !c || (Math.abs(c[0][0]) < 0.5 && Math.abs(c[0][1]) < 0.5 && Math.abs(c[2][0] - w) < 0.5 && Math.abs(c[2][1] - h) < 0.5 && Math.abs(c[1][1]) < 0.5 && Math.abs(c[3][0]) < 0.5);
        if (boxLike) out.push({ k: 'rect', ...base, ...look, ...(ratio > 0 ? { r: Math.min(50, ratio) } : {}) });
        else out.push({ k: 'poly', ...base, ...look, p: c!.flat(), z: true });
        break;
      }
      case '$ell':
        out.push({ k: 'ellipse', ...base, ...look });
        break;
      case '$arc': {
        const r = rec(T.SHAPE_COMPONENT_ARC);
        if (!r || r.data.length < 25) return;
        const t = u8(r, 0);
        out.push({ k: 'arc', ...base, ...look, at: t === 1 ? 'PIE' : t === 2 ? 'CHORD' : 'NORMAL', p: [px(r, 1), px(r, 5), px(r, 9), px(r, 13), px(r, 17), px(r, 21)] });
        break;
      }
      case '$pol': {
        const r = rec(T.SHAPE_COMPONENT_POLYGON);
        if (!r) return;
        const n = Math.min(10000, i32(r, 0));
        const p: number[] = [];
        for (let k = 0; k < n && 4 + k * 8 + 8 <= r.data.length; k++) p.push(px(r, 4 + k * 8), px(r, 8 + k * 8));
        if (p.length < 4) return;
        const closed = p.length > 4 && Math.abs(p[0] - p[p.length - 2]) < 0.01 && Math.abs(p[1] - p[p.length - 1]) < 0.01;
        out.push({ k: 'poly', ...base, ...look, p, ...(closed ? { z: true } : {}) });
        break;
      }
      case '$cur': {
        const r = rec(T.SHAPE_COMPONENT_CURVE);
        if (!r) return;
        const n = Math.min(10000, i32(r, 0));
        const p: number[] = [];
        for (let k = 0; k < n && 4 + k * 8 + 8 <= r.data.length; k++) p.push(px(r, 4 + k * 8), px(r, 8 + k * 8));
        if (p.length < 4) return;
        // 구간 종류 (점 수 - 1 개): 0 직선, 1 곡선
        let seg = '';
        const so = 4 + n * 8;
        for (let k = 0; k < n - 1; k++) seg += so + k < r.data.length && u8(r, so + k) === 0 ? 'L' : 'C';
        out.push({ k: 'curve', ...base, ...look, p, seg });
        break;
      }
      case '$tat': {
        const r = rec(T.SHAPE_COMPONENT_TEXTART);
        if (!r || r.data.length < 36) return;
        const text = wstr(r, 32);
        const font = wstr(r, text.end);
        if (!text.s.trim()) return;
        out.push({ k: 'art', ...base, text: text.s.replace(/\r\n?/g, '\n'), font: font.s || undefined, fc: look.fc || '#000000', sc: look.sc });
        return;
      }
      default:
        return;
    }
    // 도형 안의 글 (화면 전용: 도형의 개체 좌표 상자에 놓는다)
    const li = sc.children.findIndex((c) => c.tag === T.LIST_HEADER);
    if (li >= 0) {
      const hd = sc.children[li];
      const paras = sc.children.slice(li + 1).filter((c) => c.tag === T.PARA_HEADER);
      if (paras.some((p) => paraHasContent(p))) {
        // LIST_HEADER(글상자): 문단 수(2) 속성(4) 예비(2) 왼쪽·오른쪽·위·아래 여백(각 2)
        const pad = hd.data.length >= 16 ? [u16(hd, 12), u16(hd, 10), u16(hd, 14), u16(hd, 8)].map((v) => Math.round(hwpToPx(v) * 100) / 100) : [3.77, 3.77, 3.77, 3.77];
        const content = this.convertParagraphs(paras, true, undefined, w - pad[1] - pad[3]).map(stripLayoutAttrs);
        const va = hd.data.length >= 8 ? (u32(hd, 4) >>> 5) & 3 : 0;
        if (content.length) out.push({ k: 'text', m, w, h, content, pad, ...(va === 1 ? { va: 'middle' as const } : va === 2 ? { va: 'bottom' as const } : {}) });
      }
    }
  }

  /** 그리기 개체(묶음 포함) → 도형 노드 (틀 크기 w×h px). 그릴 것이 없으면 null */
  private shapeNode(top: Rec, w: number, h: number): JNode | null {
    const items: ShapeItem[] = [];
    try {
      this.gsoItems(top, items);
    } catch {
      return null;
    }
    if (!items.length) return null;
    const d: ShapeData = { items };
    if (ctrlIdOf(top) === '$con') {
      d.group = true;
      const mt = shapeMatrixOf(top);
      if (mt) d.raw = mt.raw;
    }
    if (!(w > 0) || !(h > 0)) {
      const b = shapeBounds(d);
      if (!(w > 0)) w = b ? Math.max(1, Math.round(b.x1)) : 1;
      if (!(h > 0)) h = b ? Math.max(1, Math.round(b.y1)) : 1;
    }
    return { type: 'shape', attrs: { width: w, height: h, d } };
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
    // 그림 보정: 밝기(INT8 68)·대비(INT8 69)·효과(70: 0 그대로, 1 회색조, 2 흑백). 선: 색(0)·굵기(4)·속성(8, bit 0~5 종류 — 0 선 없음)
    const look: PicLook = {};
    if (p.data.length >= 71) {
      const s8 = (o: number) => (p.data[o] << 24) >> 24;
      if (s8(68)) look.bright = s8(68);
      if (s8(69)) look.contrast = s8(69);
      const eff = p.data[70];
      if (eff === 1) look.gray = 1;
      else if (eff === 2) look.gray = 2;
    }
    const bw = p.data.length >= 12 ? i32(p, 4) : 0;
    const btype = p.data.length >= 12 ? u32(p, 8) & 0x3f : 0;
    // 개체 선 종류: 1 실선, 2 긴 점선, 3 점선, 4 -.-, 5 -..-, 6 긴 대시, 7 원형 점선, 8~ 이중선 계열
    const bstyle = btype === 3 || btype === 7 ? 'dotted' : btype >= 8 ? 'double' : btype >= 2 ? 'dashed' : 'solid';
    if (bw > 0 && btype > 0) look.line = { w: Math.max(1, Math.round(hwpToPx(bw) * 100) / 100), c: colorRefToHex(u32(p, 0)), s: bstyle };
    const lk = cleanLook(look);
    return { type: 'image', attrs: { src, width: w || null, height: h || null, crop, ...(lk ? { look: lk } : {}) } };
  }
}

/** 문단에 글자나 개체가 있는가 (문단 끝 표시만 있는 빈 문단이 아닌가) */
function paraHasContent(p: Rec): boolean {
  if (p.children.some((c) => c.tag === T.CTRL_HEADER)) return true;
  const t = p.children.find((c) => c.tag === T.PARA_TEXT);
  if (!t) return false;
  for (let i = 0; i + 2 <= t.data.length; i += 2) if (u16(t, i) !== 13) return true;
  return false;
}

/** 편집기 밖에서 그리는 블록(도형 안의 글)용 사본: 쪽 나누기·줄 바꿈이 쓰는 배치 정보는 빼고 한 줄 문단의 줄 높이만 남긴다 */
function stripLayoutAttrs(n: JNode): JNode {
  const out: JNode = { ...n };
  if (n.attrs) {
    const a: Record<string, any> = {};
    for (const k of Object.keys(n.attrs)) if (!/^hwp(Lines|Len|Top|Seq|Page)$/.test(k)) a[k] = n.attrs[k];
    out.attrs = a;
  }
  if (n.content) out.content = n.content.map(stripLayoutAttrs);
  return out;
}

/**
 * 개체 공통 속성(CTRL_HEADER: 표·그리기 개체)의 자리 정보. 속성(4): bit0 글자처럼 취급, 3~4 세로 기준(종이·쪽·문단),
 * 5~7 세로 맞춤, 8~9 가로 기준(종이·쪽·단·문단), 10~12 가로 맞춤, 21~23 본문과의 배치. 이어서 세로·가로 오프셋, 폭, 높이,
 * z-order, 바깥 여백(왼·오른·위·아래)
 */
function objPosOf(ctrl: Rec): ObjPos {
  const a = ctrl.data.length >= 8 ? u32(ctrl, 4) : 1;
  const WRAP: ObjPos['wrap'][] = ['SQUARE', 'TOP_AND_BOTTOM', 'BEHIND_TEXT', 'IN_FRONT_OF_TEXT'];
  const AL_V: ObjPos['vAl'][] = ['TOP', 'CENTER', 'BOTTOM', 'TOP', 'BOTTOM'];
  const AL_H: ObjPos['hAl'][] = ['LEFT', 'CENTER', 'RIGHT', 'LEFT', 'RIGHT'];
  const px = (o: number, signed = true) => (ctrl.data.length >= o + 4 ? hwpToPx(signed ? i32(ctrl, o) : u32(ctrl, o)) : 0);
  const m = (o: number) => (ctrl.data.length >= o + 2 ? hwpToPx(u16(ctrl, o)) : 0);
  return {
    inline: (a & 1) === 1,
    wrap: WRAP[(a >>> 21) & 7] || 'SQUARE',
    vRel: (['PAPER', 'PAGE', 'PARA'] as const)[(a >>> 3) & 3] || 'PARA',
    hRel: (['PAPER', 'PAGE', 'COLUMN', 'PARA'] as const)[(a >>> 8) & 3],
    vAl: AL_V[(a >>> 5) & 7] || 'TOP',
    hAl: AL_H[(a >>> 10) & 7] || 'LEFT',
    vOff: px(8),
    hOff: px(12),
    w: px(16, false),
    h: px(20, false),
    omT: m(32),
    omB: m(34),
    omL: m(28),
    omR: m(30),
  };
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
    if (max > 0) p.attrs!.hwpLines = lines.map(([a, lw, x]: number[]) => (x ? [a, Math.min(lw, Math.round(max * 100) / 100), x] : [a, Math.min(lw, Math.round(max * 100) / 100)]));
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
    // 줄 정보 없는 문단이 표로 시작했으면 표는 앞 쪽에서 시작해 쪽을 넘어왔을 수 있다 (표는 쪽에 걸쳐 나뉜다): 표가 아니라 이 문단에 표시한다
    const target = newPage ? (this.pending && vpos > 0 && this.pending.type !== 'table' ? this.pending : first) : null;
    if (target && (target.type === 'paragraph' || target.type === 'table' || target.type === 'textBox')) target.attrs = { ...target.attrs, hwpPage: true };
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
      if (h && h > 0 && h < 3000) row.attrs = { height: Math.round(h * 100) / 100 };
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
    // OLE 개체: 개체가 그려 둔 모양(비트맵)을 꺼낸다. 못 꺼내면 자리 표시
    if (/^ole$/i.test(b.ext)) images.set(id, olePreview(bytes) || placeholderImage('OLE 개체'));
    else if (isBrowserImage(mime)) images.set(id, bytesToDataUrl(bytes, mime));
    // 윈도 메타파일(WMF·EMF): 그려서 SVG 로
    else images.set(id, (isMetafileExt(b.ext) && metafileToSvg(bytes)) || placeholderImage(`그림(${b.ext.toUpperCase()})`));
  }

  const conv = new HwpConverter(info, images, defaultSettings(), warnings);
  conv.settings.hwpMetrics = true;
  // 쪽 번호는 '쪽 번호' 스타일의 글자 모양으로 찍힌다
  if (info.pageNumCharPr != null) applyPageNumStyle(conv.settings, info.charPrs[info.pageNumCharPr]);
  const blocks: JNode[] = [];
  for (let i = 0; ; i++) {
    const sec = find(`BodyText/Section${i}`);
    if (!sec) break;
    const recs = buildTree(parseRecords(decompress(new Uint8Array(sec.content as any), compressed)));
    // 구역 나누기: 구역마다 용지가 다를 수 있으므로 쪽 나누기에 이 구역의 용지(구역 정의에서 읽은 것)를 담는다
    const brk: JNode | null = i > 0 && blocks.length ? { type: 'pageBreak' } : null;
    if (brk) blocks.push(brk);
    conv.startSection();
    pushAll(blocks, conv.convertParagraphs(recs, false));
    if (brk && conv.sectionPage) brk.attrs = { sectionPage: conv.sectionPage };
  }
  while (blocks.length && blocks[0].type === 'pageBreak') blocks.shift();
  // 줄 정보가 형식뿐인 문서(한글이 배치하지 않은 파일)는 그 값을 따르지 않고 자연 배치로 흐르게 한다
  const content = docNode(conv.segStats.fake ? blocks.map(dropHwpLayout) : blocks);
  // 한글이 줄 정보를 적지 않은 문단의 줄 높이를 같은 모양의 다른 문단에서 빌린다
  if (!conv.segStats.fake) estimateMissingLines(content);
  return { content, settings: conv.settings, meta: {}, warnings: [...new Set(warnings)].slice(0, 20) };
}

/**
 * SHAPE_COMPONENT(그리기 개체 공통)에서 선·채우기 정보.
 * 공통 부분(id 2개, 위치, 크기, 뒤집기, 회전, 렌더링 행렬 cnt 개) 뒤에 선 정보(색 4, 굵기 4, 속성 4)와 채우기 정보(종류 4, 색 4 …)가 온다.
 */
/**
 * 단 정의(cold) → 다단 값. ctrl ID 뒤: 속성 u16 (bit 2~9 단 수, bit 12 너비 같게), 너비가 같으면 단 사이 간격 u16 · 속성2 u16,
 * 다르면 속성2 u16 뒤에 단마다 너비 u16 · 간격 u16 (본문 폭에 대한 비율), 이어서 구분선 종류 u8 · 굵기 u8 · 색 u32
 */
function columnsOfCold(r: Rec, bodyMm: number): Columns {
  const a = u16(r, 4);
  const n = Math.max(1, Math.min(20, (a >>> 2) & 0xff));
  const same = !!(a & 0x1000);
  if (n < 2) return { count: 1, gap: 0 };
  const out: Columns = { count: n, gap: 0 };
  let o = 6;
  if (same) {
    out.gap = round(hwpToMm(u16(r, o)), 2);
    o += 4;
  } else {
    o += 2;
    const ws: number[] = [];
    const gs: number[] = [];
    for (let i = 0; i < n && o + 4 <= r.data.length; i++, o += 4) {
      ws.push(u16(r, o));
      gs.push(u16(r, o + 2));
    }
    const total = ws.reduce((x, y) => x + y, 0) + gs.slice(0, n - 1).reduce((x, y) => x + y, 0);
    if (ws.length === n && total > 0 && ws.every((w) => w > 0)) {
      const k = bodyMm / total;
      out.widths = ws.map((w) => round(w * k, 2));
      out.gaps = gs.map((g, i) => (i < n - 1 ? round(g * k, 2) : 0));
    }
  }
  if (o + 6 <= r.data.length) {
    const type = u8(r, o);
    if (type > 0) out.line = { w: HWP_BORDER_WIDTHS[u8(r, o + 1)] ?? 0.12, c: colorRefToHex(u32(r, o + 2)), s: hwpBorderStyle(type) };
  }
  return out;
}

/** SHAPE_COMPONENT 의 공통 정보 시작 위치: 최상위 개체는 ctrl ID 를 두 번 쓰고(8), 묶음 안의 개체는 한 번 쓴다(4) */
function shapeBase(sc: Rec): number {
  return u32(sc, 0) === u32(sc, 4) ? 8 : 4;
}

/** SHAPE_COMPONENT 의 렌더링 행렬 뒤 (선 정보가 시작하는 곳). 행렬 수가 이상하면 -1 */
function shapeAfterMats(sc: Rec): number {
  const base = shapeBase(sc);
  // base 뒤: x(4) y(4) 그룹(2) 버전(2) 원래 폭·높이(8) 현재 폭·높이(8) 뒤집기(4) 회전각(2) 회전 중심(8) → 행렬 수(2), 행렬들
  const cnt = u16(sc, base + 42);
  if (cnt > 32) return -1;
  return base + 44 + 48 + 96 * cnt;
}

/** 채우기 정보 (BORDER_FILL·SHAPE_COMPONENT 공통): 종류(4) 뒤에 단색(12) · 그러데이션 · 그림 차례 */
function parseFill(r: Rec, o: number): { fc: string | null; grad: Gradient | null; binId: number; end: number } {
  const type = u32(r, o);
  let p = o + 4;
  const out = { fc: null as string | null, grad: null as Gradient | null, binId: 0, end: o + 8 };
  if (!type) return out;
  if (type & 1) {
    const c = u32(r, p);
    if (c !== 0xffffffff && (c & 0xff000000) === 0) out.fc = colorRefToHex(c);
    p += 12;
  }
  if (type & 4) {
    // 종류(1) 기울임(4) 가로 중심(4) 세로 중심(4) 번짐 정도(4) 색 수(4) [색이 3개 이상이면 바뀌는 위치 4×n] 색 4×n
    const gt = ['LINEAR', 'LINEAR', 'RADIAL', 'CONICAL', 'SQUARE'][u8(r, p)] || 'LINEAR';
    const angle = u32(r, p + 1) | 0;
    const cx = u32(r, p + 5) | 0;
    const cy = u32(r, p + 9) | 0;
    const n = Math.min(16, u32(r, p + 17));
    let co = p + 21 + (n > 2 ? n * 4 : 0);
    const colors: string[] = [];
    for (let k = 0; k < n && co + 4 <= r.data.length; k++, co += 4) colors.push(colorRefToHex(u32(r, co)) || '');
    out.grad = gradientOf(gt, angle, cx, cy, colors);
    p = co;
  }
  if (type & 2) {
    out.binId = u16(r, p + 4);
    p += 6;
  }
  // 추가 속성: 길이(4) + 내용 (그러데이션의 번짐 중심 1), 그리고 채우기 종류마다 1바이트
  const extra = u32(r, p);
  p += 4;
  if (extra === 1 && out.grad) {
    const sc = u8(r, p);
    if (sc !== 50 && sc <= 100) out.grad.sc = sc;
  }
  p += Math.min(extra, 64);
  p += (type & 1 ? 1 : 0) + (type & 4 ? 1 : 0) + (type & 2 ? 1 : 0);
  out.end = p;
  return out;
}

/** 그리기 개체 요소(SHAPE_COMPONENT)의 선·채우기·그림자. 선 정보: 색(4) 굵기(4) 속성(4) 윤곽(1), 이어서 채우기, 그림자 */
function shapeLook(sc: Rec, images: Map<number, string>): Partial<ShapeItem> & { lw?: number } {
  const out: Partial<ShapeItem> & { lw?: number } = {};
  const off = shapeAfterMats(sc);
  if (off < 0 || sc.data.length < off + 13) return out;
  const color = u32(sc, off);
  const lw = i32(sc, off + 4);
  const prop = u32(sc, off + 8);
  const type = prop & 0x3f;
  out.lw = lw;
  // 선 종류 0 은 선 없음 (1 실선, 2 긴 점선 …)
  if (type > 0 && (color & 0xff000000) === 0) {
    out.sc = colorRefToHex(color);
    out.sw = Math.max(0.3, hwpToPx(Math.max(0, lw)));
    const style = HWP_LINE_STYLES[type - 1];
    if (style && style !== 'SOLID') out.sd = style;
    if (((prop >>> 6) & 0xf) === 0) out.cap = 'round';
    const head = arrowOf(HWP_ARROW_STYLES[(prop >>> 10) & 0x3f], !!(prop & (1 << 30)));
    if (head.s) {
      out.hs = head.s;
      out.hf = head.f;
      out.hz = arrowSizeOf(HWP_ARROW_SIZES[(prop >>> 22) & 0xf]);
    }
    const tail = arrowOf(HWP_ARROW_STYLES[(prop >>> 16) & 0x3f], !!(prop & 0x80000000));
    if (tail.s) {
      out.ts = tail.s;
      out.tf = tail.f;
      out.tz = arrowSizeOf(HWP_ARROW_SIZES[(prop >>> 26) & 0xf]);
    }
  }
  if (sc.data.length < off + 21) return out;
  const fill = parseFill(sc, off + 13);
  if (fill.fc) out.fc = fill.fc;
  if (fill.grad) out.fg = fill.grad;
  const fi = fill.binId ? images.get(fill.binId) : null;
  if (fi && /^data:image\//.test(fi)) out.fi = fi;
  // 그림자: 종류(4) 색(4) 가로·세로 거리(4, 4)
  const so = fill.end;
  if (sc.data.length >= so + 16) {
    const st = u32(sc, so);
    const c = u32(sc, so + 4);
    if (st >= 1 && st <= 4 && (c & 0xff000000) === 0) {
      // 그림자 거리는 0.01mm 단위. 0 으로 적힌 그림자도 한글은 조금 벗어난 자리에 그린다
      const rx = Math.min(5000, Math.abs(i32(sc, so + 8)));
      const ry = Math.min(5000, Math.abs(i32(sc, so + 12)));
      const dx = (rx || ry ? rx : SHADOW_DEFAULT) * SHADOW_UNIT_PX;
      const dy = (rx || ry ? ry : SHADOW_DEFAULT) * SHADOW_UNIT_PX;
      // 1 왼쪽 위, 2 오른쪽 위, 3 왼쪽 아래, 4 오른쪽 아래
      out.sh = { c: colorRefToHex(c), x: st === 1 || st === 3 ? -dx : dx, y: st === 1 || st === 2 ? -dy : dy };
    }
  }
  return out;
}

/** SHAPE_COMPONENT 의 행렬: 이동 × Π(회전 × 크기) 를 px 단위 행렬 하나로. raw 는 저장할 때 그대로 쓰는 한글 값 */
function shapeMatrixOf(sc: Rec): { m: Mat; raw: ShapeRaw; w: number; h: number } | null {
  const base = shapeBase(sc);
  const cnt = u16(sc, base + 42);
  if (cnt > 32 || sc.data.length < base + 44 + 48 + 96 * cnt) return null;
  const mats: number[][] = [];
  for (let k = 0; k < 1 + 2 * cnt; k++) {
    const v: number[] = [];
    for (let i = 0; i < 6; i++) v.push(sc.dv.getFloat64(base + 44 + k * 48 + i * 8, true));
    if (!v.every(Number.isFinite)) return null;
    mats.push(v);
  }
  const pairs: [Mat, Mat][] = [];
  for (let k = 0; k < cnt; k++) pairs.push([matOfHwp(mats[1 + 2 * k]), matOfHwp(mats[2 + 2 * k])]);
  const flip = u32(sc, base + 28);
  const raw: ShapeRaw = {
    off: [i32(sc, base), i32(sc, base + 4)],
    org: [i32(sc, base + 12), i32(sc, base + 16)],
    cur: [i32(sc, base + 20), i32(sc, base + 24)],
    flip: [flip & 1, (flip >>> 1) & 1],
    rot: [sc.dv.getInt16(base + 32, true), i32(sc, base + 34), i32(sc, base + 38)],
    mats,
    lvl: u16(sc, base + 8),
  };
  return { m: composeMats(matOfHwp(mats[0]), pairs, 1 / 75), raw, w: hwpToPx(Math.abs(raw.org[0])), h: hwpToPx(Math.abs(raw.org[1])) };
}

function shapeStyle(sc: Rec): { borderColor: string | null; borderWidth: number | null; bg: string | null; gradient: string | null; dash: string | null } {
  const look = shapeLook(sc, new Map());
  return {
    borderColor: look.sc || null,
    // 화면용 테두리 굵기 (가는 선도 보이게)
    borderWidth: look.sc ? Math.max(0.75, Math.min(8, look.sw || 0.45)) : null,
    bg: look.fc || null,
    gradient: look.fg ? gradientCss(look.fg.t, look.fg.a, look.fg.cx, look.fg.cy, look.fg.c, look.fg.sc ?? 50) : null,
    dash: look.sd || null,
  };
}
