// 배포용 HWP 문서: AES-128 복호화, '배포용 문서 데이터' 레코드에서 키 풀기, 보호된 문서 탭(고치기 막기)
//   node tests/test-distribution.mjs [배포용.hwp]     (파일을 주면 그 파일도 읽어 본다)
import { load } from './harness.mjs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs';

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};

// ---- AES-128 ECB: Node 의 구현과 같은 결과 ----
{
  const m = await load('src/formats/hwp/aes.ts');
  let same = true;
  for (let t = 0; t < 30; t++) {
    const key = crypto.randomBytes(16);
    const pt = crypto.randomBytes(16 * (1 + (t % 7)));
    const c = crypto.createCipheriv('aes-128-ecb', key, null);
    c.setAutoPadding(false);
    const ct = Buffer.concat([c.update(pt), c.final()]);
    if (!Buffer.from(m.aes128EcbDecrypt(new Uint8Array(key), new Uint8Array(ct))).equals(pt)) same = false;
  }
  ok(same, 'AES-128 ECB 복호화가 표준 구현과 같다');
  const tail = m.aes128EcbDecrypt(new Uint8Array(16), new Uint8Array([1, 2, 3]));
  ok(tail.length === 3 && tail[0] === 1, '16바이트에 못 미치는 끝 조각은 그대로');
}

// ---- 배포용 스트림: 씨앗으로 섞은 키 → AES → 압축된 레코드 ----
const r = await load('src/formats/hwp/reader.ts');
{
  // 한글이 하듯 만든다: 256바이트 (앞 4바이트 씨앗, 씨앗에 따른 자리에 키), 난수열 XOR, 나머지는 AES
  const plain = zlib.deflateRawSync(Buffer.from('본문 레코드들'.repeat(20)));
  const padded = Buffer.concat([plain, Buffer.alloc(16 - (plain.length % 16))]);
  const data = crypto.randomBytes(256);
  const seed = data.readUInt32LE(0);
  const off = 4 + (data[0] & 0xf);
  const key = crypto.randomBytes(16);
  key.copy(data, off);
  let s = seed;
  const rand = () => ((s = (Math.imul(s, 214013) + 2531011) >>> 0), (s >>> 16) & 0x7fff);
  let k = 0;
  let n = 0;
  for (let i = 0; i < 256; i++) {
    if (n === 0) {
      k = rand() & 0xff;
      n = (rand() & 0xf) + 1;
    }
    if (i >= 4) data[i] ^= k;
    n--;
  }
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  c.setAutoPadding(false);
  const enc = Buffer.concat([c.update(padded), c.final()]);
  const head = Buffer.alloc(4);
  head.writeUInt32LE((28 | (256 << 20)) >>> 0);
  const out = r.decodeDistributedStream(new Uint8Array(Buffer.concat([head, data, enc])));
  ok(zlib.inflateRawSync(Buffer.from(out).subarray(0, plain.length)).toString() === '본문 레코드들'.repeat(20), '배포용 문서 데이터에서 키를 풀어 본문을 푼다');
  let threw = false;
  try {
    r.decodeDistributedStream(new Uint8Array(300));
  } catch {
    threw = true;
  }
  ok(threw, '맨 앞이 배포용 문서 데이터가 아니면 오류');
}

// ---- 실제 배포용 문서 ----
const file = process.argv[2];
if (file && fs.existsSync(file)) {
  const d = await r.readHwp(new Uint8Array(fs.readFileSync(file)));
  const text = (n) => n.text || (n.content || []).map(text).join(' ');
  ok(d.protect?.kind === 'distribution' && d.protect.noCopy && d.protect.noPrint, '배포용 문서는 보호 표시(복사·인쇄 막기)와 함께 읽는다');
  ok(text(d.content).trim().length > 50, '본문 글을 읽는다', text(d.content).slice(0, 80));
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
