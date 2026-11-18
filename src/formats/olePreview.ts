/**
 * OLE 개체(한글 문서에 끼운 다른 프로그램의 개체)의 보이는 모양을 꺼낸다.
 *
 * 한글은 OLE 개체를 저장할 때 그 개체가 그려 둔 표시 데이터(OlePres000: 클립보드 형식의 그림)를 함께 넣는다.
 * 여기서는 그 가운데 비트맵을 꺼내 BMP 그림으로 돌려준다:
 *  - 그림판 그림 같은 개체의 원본(\x01Ole10Native 의 BMP 파일)
 *  - 표시 데이터가 DIB(CF_DIB) 이거나, 메타파일(CF_METAFILEPICT 의 WMF, CF_ENHMETAFILE 의 EMF) 안에 든 DIB
 * 선·글자로 그린 메타파일(벡터)은 아직 그리지 못한다 (null → 부르는 쪽이 자리 표시를 그린다).
 *
 * 문서에서 온 바이트이므로 모든 길이·자리를 범위 안에서만 읽는다.
 */
import * as CFB from 'cfb';
import { bytesToDataUrl } from './common';

/** 꺼낼 그림의 크기 상한 (바이트) */
const MAX_BMP = 64 * 1024 * 1024;

const u16 = (d: Uint8Array, o: number) => (o + 2 <= d.length ? d[o] | (d[o + 1] << 8) : 0);
const u32 = (d: Uint8Array, o: number) => (o + 4 <= d.length ? (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0 : 0);
const i32 = (d: Uint8Array, o: number) => (o + 4 <= d.length ? d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24) : 0);

/** DIB(BITMAPINFOHEADER + 색표 + 화소)의 길이 셈에 쓰는 머리 정보. 이상하면 null */
function dibInfo(d: Uint8Array, o: number, len: number): { hdr: number; pal: number; bits: number } | null {
  const hdr = u32(d, o);
  // BITMAPCOREHEADER(12)·INFO(40)·V4(108)·V5(124)
  if (![12, 40, 52, 56, 64, 108, 124].includes(hdr) || hdr > len) return null;
  let bitCount: number;
  let clrUsed = 0;
  let compression = 0;
  let width: number;
  let height: number;
  if (hdr === 12) {
    width = u16(d, o + 4);
    height = u16(d, o + 6);
    bitCount = u16(d, o + 10);
  } else {
    width = i32(d, o + 4);
    height = Math.abs(i32(d, o + 8));
    bitCount = u16(d, o + 14);
    compression = u32(d, o + 16);
    clrUsed = u32(d, o + 32);
  }
  if (!(width > 0 && width < 40000 && height > 0 && height < 40000) || ![1, 4, 8, 16, 24, 32].includes(bitCount)) return null;
  const entry = hdr === 12 ? 3 : 4;
  let colors = bitCount <= 8 ? clrUsed || 1 << bitCount : clrUsed;
  if (colors > 256 && bitCount <= 8) colors = 1 << bitCount;
  let pal = colors * entry;
  // 40바이트 머리의 BI_BITFIELDS(3): 색 마스크 3개가 뒤따른다
  if (hdr === 40 && compression === 3) pal += 12;
  // 압축하지 않은 화소: 줄마다 4바이트 정렬
  const stride = Math.floor((width * bitCount + 31) / 32) * 4;
  const bits = compression === 0 || compression === 3 ? stride * height : Math.max(0, len - hdr - pal);
  if (hdr + pal + bits > len + 4) return null;
  return { hdr, pal, bits: Math.min(bits, len - hdr - pal) };
}

/** DIB 를 BMP 파일로 (BITMAPFILEHEADER 14 바이트를 앞에) */
function dibToBmp(d: Uint8Array, o: number, len: number): Uint8Array | null {
  const info = dibInfo(d, o, len);
  if (!info) return null;
  const body = info.hdr + info.pal + info.bits;
  if (body > MAX_BMP) return null;
  const out = new Uint8Array(14 + body);
  out[0] = 0x42;
  out[1] = 0x4d;
  const dv = new DataView(out.buffer);
  dv.setUint32(2, out.length, true);
  dv.setUint32(10, 14 + info.hdr + info.pal, true);
  out.set(d.subarray(o, o + body), 14);
  return out;
}

/** WMF 레코드에서 가장 큰 DIB 를 찾는다 (META_DIBBITBLT·META_DIBSTRETCHBLT·META_STRETCHDIB) */
function dibFromWmf(d: Uint8Array): Uint8Array | null {
  let o = 0;
  // 놓을 자리 머리(placeable header, 22 바이트)
  if (u32(d, 0) === 0x9ac6cdd7) o = 22;
  const hdrWords = u16(d, o + 2);
  if (hdrWords !== 9) return null;
  o += 18;
  let best: Uint8Array | null = null;
  for (let n = 0; o + 6 <= d.length && n < 200000; n++) {
    const size = u32(d, o) * 2;
    const fn = u16(d, o + 4);
    if (size < 6 || o + size > d.length) break;
    if (fn === 0) break;
    // 레코드 안 DIB 의 자리: 함수마다 앞의 인자 길이가 다르다
    let at = -1;
    if (fn === 0x0b41) at = o + 6 + 4 + 2 * 8; // DIBSTRETCHBLT: 래스터 연산(4) + 8개 값
    else if (fn === 0x0940) at = o + 6 + 4 + 2 * 6; // DIBBITBLT: 래스터 연산(4) + 6개 값
    else if (fn === 0x0f43) at = o + 6 + 4 + 2 + 2 * 8; // STRETCHDIB: 래스터 연산(4) + 색 쓰임(2) + 8개 값
    if (at > 0 && at + 12 < o + size) {
      const bmp = dibToBmp(d, at, o + size - at);
      if (bmp && (!best || bmp.length > best.length)) best = bmp;
    }
    o += size;
  }
  return best;
}

/** EMF 레코드에서 가장 큰 DIB 를 찾는다 (EMR_STRETCHDIBITS·EMR_BITBLT·EMR_STRETCHBLT) */
function dibFromEmf(d: Uint8Array): Uint8Array | null {
  if (u32(d, 0) !== 1 || u32(d, 40) !== 0x464d4520) return null;
  let o = 0;
  let best: Uint8Array | null = null;
  for (let n = 0; o + 8 <= d.length && n < 500000; n++) {
    const type = u32(d, o);
    const size = u32(d, o + 4);
    if (size < 8 || o + size > d.length) break;
    let offBmi = 0;
    let cbBmi = 0;
    let offBits = 0;
    let cbBits = 0;
    if (type === 0x51) {
      // EMR_STRETCHDIBITS: 경계(16) 대상 x,y(8) 원본 x,y,w,h(16) 다음
      offBmi = u32(d, o + 48);
      cbBmi = u32(d, o + 52);
      offBits = u32(d, o + 56);
      cbBits = u32(d, o + 60);
    } else if (type === 0x4c || type === 0x4d) {
      // EMR_BITBLT / EMR_STRETCHBLT: 원본 비트맵 자리
      offBmi = u32(d, o + 84);
      cbBmi = u32(d, o + 88);
      offBits = u32(d, o + 92);
      cbBits = u32(d, o + 96);
    }
    if (cbBmi >= 12 && cbBits > 0 && offBmi + cbBmi <= size && offBits + cbBits <= size && cbBmi + cbBits <= MAX_BMP) {
      // 머리·색표와 화소가 떨어져 있을 수 있으므로 이어 붙여 DIB 로
      const dib = new Uint8Array(cbBmi + cbBits);
      dib.set(d.subarray(o + offBmi, o + offBmi + cbBmi), 0);
      dib.set(d.subarray(o + offBits, o + offBits + cbBits), cbBmi);
      const bmp = dibToBmp(dib, 0, dib.length);
      if (bmp && (!best || bmp.length > best.length)) best = bmp;
    }
    if (type === 14) break; // EMR_EOF
    o += size;
  }
  return best;
}

/** 표시 데이터 스트림(OlePres000): 클립보드 형식, 대상 장치, 모양, … 크기, 데이터 */
function fromPresentation(d: Uint8Array): Uint8Array | null {
  let o = 0;
  const marker = u32(d, 0);
  let format = 0;
  if (marker === 0xffffffff || marker === 0xfffffffe) {
    format = u32(d, 4);
    o = 8;
  } else if (marker > 0 && marker < 256) {
    // 이름으로 적힌 형식 (등록한 형식): 그림이 아니다
    return null;
  } else return null;
  const tds = u32(d, o);
  if (tds < 4 || o + tds > d.length) return null;
  o += tds;
  // 모양(4) 줄(4) 알림(4) 예비(4) 폭(4) 높이(4) 크기(4)
  o += 16;
  o += 8;
  const size = u32(d, o);
  o += 4;
  if (!(size > 0) || o + size > d.length) return null;
  const data = d.subarray(o, o + size);
  if (format === 8) return dibToBmp(data, 0, data.length); // CF_DIB
  if (format === 3) return dibFromWmf(data); // CF_METAFILEPICT
  if (format === 14) return dibFromEmf(data); // CF_ENHMETAFILE
  return null;
}

/**
 * OLE 개체 바이트(한글 BinData, 앞에 길이 4바이트가 붙어 있을 수 있다) → 보이는 모양의 그림 data URL. 꺼내지 못하면 null
 */
export function olePreview(bytes: Uint8Array): string | null {
  let cfb: CFB.CFB$Container | null = null;
  for (const off of [4, 0]) {
    if (bytes.length < off + 512) continue;
    // 복합 문서의 시작 표시 (D0 CF 11 E0)
    if (bytes[off] !== 0xd0 || bytes[off + 1] !== 0xcf || bytes[off + 2] !== 0x11 || bytes[off + 3] !== 0xe0) continue;
    try {
      cfb = CFB.read(bytes.subarray(off), { type: 'array' });
      break;
    } catch {
      cfb = null;
    }
  }
  if (!cfb) return null;
  const stream = (re: RegExp): Uint8Array | null => {
    const i = cfb!.FullPaths.findIndex((p) => re.test(p));
    const e = i >= 0 ? cfb!.FileIndex[i] : null;
    return e && e.content && (e.content as any).length ? Uint8Array.from(e.content as any) : null;
  };
  try {
    // 원본이 BMP 파일인 개체 (그림판 그림 등)
    const native = stream(/\/\u0001Ole10Native$/);
    if (native && native.length > 18 && native[4] === 0x42 && native[5] === 0x4d) {
      const len = Math.min(u32(native, 0), native.length - 4);
      if (len > 14 && len <= MAX_BMP && dibInfo(native, 4 + 14, len - 14)) return bytesToDataUrl(native.subarray(4, 4 + len), 'image/bmp');
    }
    // 표시 데이터
    for (let k = 0; k < 4; k++) {
      const pres = stream(new RegExp(`/\\u0002OlePres00${k}$`));
      if (!pres) continue;
      const bmp = fromPresentation(pres);
      if (bmp) return bytesToDataUrl(bmp, 'image/bmp');
    }
  } catch {
    /* 이상한 개체: 자리 표시로 */
  }
  return null;
}
