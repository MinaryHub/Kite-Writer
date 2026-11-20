/**
 * AES-128 복호화 (ECB, 덧붙임 처리 없음). 배포용 HWP 문서의 본문을 푸는 데만 쓴다.
 * 브라우저·안드로이드 웹뷰에서도 돌아야 해서(WebCrypto 에는 ECB 가 없다) 직접 구현한다 (FIPS-197).
 */

const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
(() => {
  // GF(2^8) 의 곱셈 역원과 아핀 변환으로 S-box 를 만든다
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
})();

const xt = (a: number) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
function mul(a: number, b: number): number {
  let r = 0;
  while (b) {
    if (b & 1) r ^= a;
    a = xt(a);
    b >>= 1;
  }
  return r;
}

/** 키 확장: 11개 라운드 키 (176바이트) */
function expandKey(key: Uint8Array): Uint8Array {
  const w = new Uint8Array(176);
  w.set(key.subarray(0, 16));
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
    if (i % 16 === 0) {
      const s = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[s];
      rcon = xt(rcon);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

// 역 MixColumns 곱셈 표
const M9 = new Uint8Array(256);
const M11 = new Uint8Array(256);
const M13 = new Uint8Array(256);
const M14 = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
  M9[i] = mul(i, 9);
  M11[i] = mul(i, 11);
  M13[i] = mul(i, 13);
  M14[i] = mul(i, 14);
}

function decryptBlock(s: Uint8Array, w: Uint8Array) {
  const t = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] ^= w[160 + i];
  for (let round = 9; round >= 0; round--) {
    // 역 ShiftRows + 역 SubBytes (열 우선 배치: s[r + 4c])
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) t[r + 4 * ((c + r) % 4)] = INV[s[r + 4 * c]];
    for (let i = 0; i < 16; i++) s[i] = t[i] ^ w[round * 16 + i];
    if (round === 0) break;
    // 역 MixColumns
    for (let c = 0; c < 4; c++) {
      const a0 = s[4 * c];
      const a1 = s[4 * c + 1];
      const a2 = s[4 * c + 2];
      const a3 = s[4 * c + 3];
      s[4 * c] = M14[a0] ^ M11[a1] ^ M13[a2] ^ M9[a3];
      s[4 * c + 1] = M9[a0] ^ M14[a1] ^ M11[a2] ^ M13[a3];
      s[4 * c + 2] = M13[a0] ^ M9[a1] ^ M14[a2] ^ M11[a3];
      s[4 * c + 3] = M11[a0] ^ M13[a1] ^ M9[a2] ^ M14[a3];
    }
  }
}

/** AES-128-ECB 로 푼다. 16바이트에 못 미치는 끝 조각은 그대로 둔다 */
export function aes128EcbDecrypt(key: Uint8Array, data: Uint8Array): Uint8Array {
  const w = expandKey(key);
  const out = new Uint8Array(data);
  const n = out.length - (out.length % 16);
  for (let i = 0; i < n; i += 16) decryptBlock(out.subarray(i, i + 16), w);
  return out;
}
