/**
 * 원본 보존형 저장 — HWP 바이너리 (formats/hwpBase.ts):
 *  - 원본 DocInfo 의 레코드를 그대로 두고, Kite 가 새로 만든 정의(글꼴·테두리/배경·글자 모양·탭·번호·문단 모양·스타일)만 목록마다 뒤에 붙인다
 *  - 고치지 않은 본문 문단은 원본 레코드(PARA_HEADER 와 그 아래 레코드들)를 그대로 쓴다
 */

/** DocInfo·본문 레코드 태그 (HWPTAG_BEGIN = 16) */
export const HT = {
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
  CTRL_HEADER: 71,
};

export interface RawRec {
  tag: number;
  level: number;
  data: Uint8Array;
}

/** 레코드들 → 바이트 (머리 4바이트: 태그 10비트, 수준 10비트, 크기 12비트. 크기가 4095 이상이면 뒤에 4바이트 크기) */
export function recsToBytes(recs: RawRec[]): Uint8Array {
  let n = 0;
  for (const r of recs) n += 4 + (r.data.length >= 0xfff ? 4 : 0) + r.data.length;
  const out = new Uint8Array(n);
  const dv = new DataView(out.buffer);
  let o = 0;
  for (const r of recs) {
    const big = r.data.length >= 0xfff;
    dv.setUint32(o, ((r.tag & 0x3ff) | ((r.level & 0x3ff) << 10) | ((big ? 0xfff : r.data.length) << 20)) >>> 0, true);
    o += 4;
    if (big) {
      dv.setUint32(o, r.data.length, true);
      o += 4;
    }
    out.set(r.data, o);
    o += r.data.length;
  }
  return out;
}

/** 바이트 → 레코드들 (나무로 엮지 않은 차례 그대로) */
export function bytesToRecs(buf: Uint8Array): RawRec[] {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out: RawRec[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const h = dv.getUint32(off, true);
    off += 4;
    let size = (h >>> 20) & 0xfff;
    if (size === 0xfff) {
      if (off + 4 > buf.length) break;
      size = dv.getUint32(off, true);
      off += 4;
    }
    if (off + size > buf.length) break;
    out.push({ tag: h & 0x3ff, level: (h >>> 10) & 0x3ff, data: buf.slice(off, off + size) });
    off += size;
  }
  return out;
}

/** 원본 DocInfo 의 정의 목록 (레코드 그대로)과 수 */
export interface HwpDocInfoBase {
  recs: RawRec[];
  /** ID_MAPPINGS 값들 */
  counts: number[];
  /** 언어별 원본 글꼴 이름 (한글, 영문, 한자, 일어, 기타, 기호, 사용자) */
  fontNames: string[][];
  nBf: number;
  nCs: number;
  nTab: number;
  nNum: number;
  nBullet: number;
  nPs: number;
  nStyle: number;
  styleNames: string[];
  /** 원본 문단 모양마다 문단 머리 종류 (0 없음, 1 개요, 2 번호, 3 글머리표) */
  paraHeading: number[];
  /** 원본 그림 목록 (BIN_DATA 차례): 번호·확장자·속성 */
  bins: { id: number; ext: string; attr: number }[];
}

const wstrAt = (d: Uint8Array, o: number): { s: string; end: number } => {
  if (o + 2 > d.length) return { s: '', end: o };
  const n = d[o] | (d[o + 1] << 8);
  let s = '';
  for (let i = 0; i < n && o + 2 + i * 2 + 1 < d.length; i++) s += String.fromCharCode(d[o + 2 + i * 2] | (d[o + 3 + i * 2] << 8));
  return { s, end: o + 2 + n * 2 };
};

/** 원본 DocInfo (압축을 푼 것)를 나눠 둔다. 모양이 예상과 다르면 null */
export function parseHwpDocInfo(bytes: Uint8Array | null | undefined): HwpDocInfoBase | null {
  if (!bytes || !bytes.length) return null;
  const recs = bytesToRecs(bytes);
  const idm = recs.find((r) => r.tag === HT.ID_MAPPINGS);
  if (!idm || idm.data.length < 15 * 4 || !recs.length || recs[0].tag !== HT.DOCUMENT_PROPERTIES) return null;
  const dv = new DataView(idm.data.buffer, idm.data.byteOffset, idm.data.byteLength);
  const counts: number[] = [];
  for (let o = 0; o + 4 <= idm.data.length; o += 4) counts.push(dv.getInt32(o, true));
  const cnt = (tag: number) => recs.filter((r) => r.tag === tag && r.level === 1).length;
  const nBf = cnt(HT.BORDER_FILL);
  const nCs = cnt(HT.CHAR_SHAPE);
  const nTab = cnt(HT.TAB_DEF);
  const nNum = cnt(HT.NUMBERING);
  const nBullet = cnt(HT.BULLET);
  const nPs = cnt(HT.PARA_SHAPE);
  const nStyle = cnt(HT.STYLE);
  // 목록 수가 ID_MAPPINGS 와 맞아야 번호를 그대로 쓸 수 있다
  if (nBf !== counts[8] || nCs !== counts[9] || nTab !== counts[10] || nNum !== counts[11] || nBullet !== counts[12] || nPs !== counts[13] || nStyle !== counts[14]) return null;
  const faces = recs.filter((r) => r.tag === HT.FACE_NAME && r.level === 1);
  const per = counts.slice(1, 8);
  if (per.reduce((a, b) => a + b, 0) !== faces.length) return null;
  const fontNames: string[][] = [];
  let k = 0;
  for (let l = 0; l < 7; l++) {
    const names: string[] = [];
    for (let i = 0; i < per[l]; i++) names.push(wstrAt(faces[k++].data, 1).s);
    fontNames.push(names);
  }
  const styleNames = recs.filter((r) => r.tag === HT.STYLE && r.level === 1).map((r) => wstrAt(r.data, 0).s);
  const paraHeading = recs.filter((r) => r.tag === HT.PARA_SHAPE && r.level === 1).map((r) => (r.data.length >= 4 ? (new DataView(r.data.buffer, r.data.byteOffset, 4).getUint32(0, true) >>> 23) & 3 : 0));
  const bins = recs
    .filter((r) => r.tag === HT.BIN_DATA && r.level === 1)
    .map((r) => {
      const d = new DataView(r.data.buffer, r.data.byteOffset, r.data.byteLength);
      const attr = r.data.length >= 2 ? d.getUint16(0, true) : 0;
      return { attr, id: r.data.length >= 4 ? d.getUint16(2, true) : 0, ext: (attr & 0xf) === 0 ? '' : wstrAt(r.data, 4).s };
    });
  if (bins.length !== counts[0]) return null;
  return { recs, counts, fontNames, nBf, nCs, nTab, nNum, nBullet, nPs, nStyle, styleNames, paraHeading, bins };
}

/** Kite 가 원본 DocInfo 에 더하는 것 */
export interface DocInfoAdds {
  /** 언어별로 원본 뒤에 붙일 글꼴 이름 */
  fonts: string[][];
  borderFills: Uint8Array[];
  charShapes: Uint8Array[];
  tabDefs: Uint8Array[];
  numberings: Uint8Array[];
  paraShapes: Uint8Array[];
  styles: Uint8Array[];
  /** 그림 목록 전체 (원본 차례 그대로, 새 그림은 뒤에): 번호·확장자 */
  bins: { id: number; ext: string }[];
  sectionCount: number;
}

const LIST_ORDER = [HT.BIN_DATA, HT.FACE_NAME, HT.BORDER_FILL, HT.CHAR_SHAPE, HT.TAB_DEF, HT.NUMBERING, HT.BULLET, HT.PARA_SHAPE, HT.STYLE];

const faceRec = (name: string): Uint8Array => {
  const d = new Uint8Array(1 + 2 + name.length * 2);
  d[0] = 0;
  d[1] = name.length & 0xff;
  d[2] = name.length >> 8;
  for (let i = 0; i < name.length; i++) {
    const c = name.charCodeAt(i);
    d[3 + i * 2] = c & 0xff;
    d[4 + i * 2] = c >> 8;
  }
  return d;
};

const binRec = (b: { id: number; ext: string }): Uint8Array => {
  const ext = b.ext || 'png';
  const d = new Uint8Array(4 + 2 + ext.length * 2);
  const dv = new DataView(d.buffer);
  // 속성: 종류 1(파일에 넣음), 압축은 문서 설정을 따른다(0)
  dv.setUint16(0, 1, true);
  dv.setUint16(2, b.id, true);
  dv.setUint16(4, ext.length, true);
  for (let i = 0; i < ext.length; i++) dv.setUint16(6 + i * 2, ext.charCodeAt(i), true);
  return d;
};

/**
 * 원본 DocInfo 에 Kite 의 정의를 목록마다 뒤에 붙여 새 DocInfo 를 만든다 (원본 정의의 번호는 그대로).
 * ID_MAPPINGS 의 수와 문서 속성의 구역 수를 고쳐 쓴다
 */
export function mergeDocInfo(base: HwpDocInfoBase, add: DocInfoAdds): Uint8Array {
  const out: RawRec[] = [];
  const added = new Set<number>();
  const listAdds = (tag: number): RawRec[] => {
    switch (tag) {
      case HT.BIN_DATA:
        return add.bins.map((b) => ({ tag, level: 1, data: binRec(b) }));
      case HT.BORDER_FILL:
        return add.borderFills.map((data) => ({ tag, level: 1, data }));
      case HT.CHAR_SHAPE:
        return add.charShapes.map((data) => ({ tag, level: 1, data }));
      case HT.TAB_DEF:
        return add.tabDefs.map((data) => ({ tag, level: 1, data }));
      case HT.NUMBERING:
        return add.numberings.map((data) => ({ tag, level: 1, data }));
      case HT.PARA_SHAPE:
        return add.paraShapes.map((data) => ({ tag, level: 1, data }));
      case HT.STYLE:
        return add.styles.map((data) => ({ tag, level: 1, data }));
      default:
        return [];
    }
  };
  // 글꼴: 언어마다 원본 글꼴 뒤에 Kite 글꼴
  const faceRecs: RawRec[] = [];
  {
    const faces = base.recs.filter((r) => r.tag === HT.FACE_NAME && r.level === 1);
    let k = 0;
    for (let l = 0; l < 7; l++) {
      for (let i = 0; i < base.fontNames[l].length; i++) faceRecs.push(faces[k++]);
      for (const n of add.fonts[l] || []) faceRecs.push({ tag: HT.FACE_NAME, level: 1, data: faceRec(n) });
    }
  }
  /** 목록 tag 까지(그 앞 목록들 포함) 아직 쓰지 않은 Kite 정의를 쓴다 */
  const flushUpTo = (tag: number) => {
    for (const t of LIST_ORDER) {
      if (LIST_ORDER.indexOf(t) > LIST_ORDER.indexOf(tag)) break;
      if (added.has(t)) continue;
      added.add(t);
      if (t === HT.FACE_NAME) out.push(...faceRecs);
      else out.push(...listAdds(t));
    }
  };
  let inLists = false;
  let curList = -1;
  for (let i = 0; i < base.recs.length; i++) {
    const r = base.recs[i];
    if (r.tag === HT.DOCUMENT_PROPERTIES && r.level === 0) {
      const d = r.data.slice();
      if (d.length >= 2) new DataView(d.buffer).setUint16(0, add.sectionCount, true);
      out.push({ ...r, data: d });
      continue;
    }
    if (r.tag === HT.ID_MAPPINGS && r.level === 0) {
      const counts = base.counts.slice();
      counts[0] = add.bins.length;
      for (let l = 0; l < 7; l++) counts[1 + l] = base.fontNames[l].length + (add.fonts[l] || []).length;
      counts[8] = base.nBf + add.borderFills.length;
      counts[9] = base.nCs + add.charShapes.length;
      counts[10] = base.nTab + add.tabDefs.length;
      counts[11] = base.nNum + add.numberings.length;
      counts[13] = base.nPs + add.paraShapes.length;
      counts[14] = base.nStyle + add.styles.length;
      const d = new Uint8Array(counts.length * 4);
      const dv = new DataView(d.buffer);
      counts.forEach((v, k) => dv.setInt32(k * 4, v, true));
      out.push({ tag: r.tag, level: r.level, data: d });
      inLists = true;
      continue;
    }
    const li = r.level === 1 ? LIST_ORDER.indexOf(r.tag) : -1;
    if (inLists && li >= 0) {
      // 목록이 바뀌면 앞 목록(들)의 Kite 정의를 먼저
      if (li !== curList) {
        if (curList >= 0) flushUpTo(LIST_ORDER[curList]);
        // 원본에 없던 앞 목록들도 차례대로
        if (li > 0) flushUpTo(LIST_ORDER[li - 1]);
        curList = li;
      }
      // 그림 목록·글꼴은 통째로 새로 쓴다 (원본 레코드는 건너뛴다)
      if (r.tag === HT.BIN_DATA || r.tag === HT.FACE_NAME) {
        // 딸린 하위 레코드도 건너뛴다
        while (i + 1 < base.recs.length && base.recs[i + 1].level > 1) i++;
        continue;
      }
      out.push(r);
      continue;
    }
    // 정의 목록이 끝났다 (목록이 아닌 레코드): 남은 Kite 정의를 모두 (목록 레코드에 딸린 하위 레코드는 그대로 지나간다)
    if (inLists && li < 0 && r.level <= 1 && (r.level === 0 || curList >= 0)) {
      flushUpTo(HT.STYLE);
      inLists = false;
    }
    out.push(r);
  }
  if (inLists) flushUpTo(HT.STYLE);
  return recsToBytes(out);
}

/** 원문 문단의 표시: s 구역 정의, h 머리말·꼬리말·쪽 번호·새 번호, c 단 정의 */
export interface HwpRawPara {
  bytes: Uint8Array;
  flags: string;
}

const ctrlIdOf = (d: Uint8Array): string => (d.length >= 4 ? String.fromCharCode(d[3], d[2], d[1], d[0]) : '');

/**
 * 본문 문단(PARA_HEADER 와 그 아래 레코드들)의 원본 바이트와 표시. 필드가 문단 밖으로 이어지는 문단은 null
 * (필드 시작 컨트롤 수와 필드 끝 글자(4) 수가 다르다: 짝이 되는 문단을 고치면 짝이 깨진다)
 */
export function rawParaRecs(recs: RawRec[]): HwpRawPara | null {
  if (!recs.length || recs[0].tag !== HT.PARA_HEADER) return null;
  const lv0 = recs[0].level;
  const flags = new Set<string>();
  let fieldBegins = 0;
  let fieldEnds = 0;
  for (const r of recs) {
    if (r.tag === HT.CTRL_HEADER && r.level === lv0 + 1) {
      const id = ctrlIdOf(r.data);
      if (id === 'secd') flags.add('s');
      else if (id === 'head' || id === 'foot' || id === 'pgnp' || id === 'nwno' || id === 'pgct') flags.add('h');
      else if (id === 'cold') flags.add('c');
      else if (id.startsWith('%')) fieldBegins++;
    } else if (r.tag === HT.PARA_TEXT && r.level === lv0 + 1) {
      const d = r.data;
      for (let o = 0; o + 2 <= d.length; ) {
        const c = d[o] | (d[o + 1] << 8);
        if (c === 4) fieldEnds++;
        // 확장·인라인 컨트롤은 8글자 (글자 컨트롤 0·10·13·24~31 은 1글자)
        if (c < 32 && !(c === 0 || c === 10 || c === 13 || c >= 24)) o += 16;
        else o += 2;
      }
    }
  }
  if (fieldBegins !== fieldEnds) return null;
  return { bytes: recsToBytes(recs), flags: [...flags].sort().join('') };
}

/** 원문 문단 바이트의 '목록의 마지막 문단' 표시(PARA_HEADER 첫 4바이트의 31번 비트)를 고친다 */
export function setLastPara(bytes: Uint8Array, last: boolean): Uint8Array {
  if (bytes.length < 8) return bytes;
  const out = bytes.slice();
  const dv = new DataView(out.buffer);
  const h = dv.getUint32(0, true);
  const size = (h >>> 20) & 0xfff;
  const off = size === 0xfff ? 8 : 4;
  if (out.length < off + 4) return bytes;
  const v = dv.getUint32(off, true);
  dv.setUint32(off, last ? (v | 0x80000000) >>> 0 : v & 0x7fffffff, true);
  return out;
}

/** 원문 문단 바이트에서 문단 자신의 줄 정보(PARA_LINE_SEG) 레코드를 뺀다: 한글이 그 문단부터 다시 배치한다 */
export function dropParaSegs(bytes: Uint8Array): Uint8Array {
  const recs = bytesToRecs(bytes);
  if (!recs.length) return bytes;
  const lv = recs[0].level;
  const keep = recs.filter((r, i) => !(i > 0 && r.tag === 69 && r.level === lv + 1));
  return keep.length === recs.length ? bytes : recsToBytes(keep);
}

/** base64 ↔ 바이트 (문서 설정·노드 속성은 JSON 이라 글로 담는다) */
export function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(s: string): Uint8Array | null {
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
