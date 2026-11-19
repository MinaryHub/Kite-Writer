// 윈도 메타파일(WMF·EMF) → SVG: 도형·글자·비트맵, 좌표 대응, 망가진 파일
//   node tests/test-metafile.mjs
import { load } from './harness.mjs';
const m = await load('src/formats/metafile.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};
const svgOf = (url) => (url ? Buffer.from(url.slice('data:image/svg+xml;base64,'.length), 'base64').toString() : '');

/** 작은 엔디언 바이트 묶음 */
class B {
  constructor() {
    this.a = [];
  }
  u8(v) {
    this.a.push(v & 0xff);
    return this;
  }
  u16(v) {
    return this.u8(v).u8(v >> 8);
  }
  i16(v) {
    return this.u16(v & 0xffff);
  }
  u32(v) {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  i32(v) {
    return this.u32(v >>> 0);
  }
  bytes(arr) {
    for (const x of arr) this.u8(x);
    return this;
  }
  get length() {
    return this.a.length;
  }
  out() {
    return Uint8Array.from(this.a);
  }
}

/** 1×1 24비트 DIB (빨강) */
const dib = () => new B().u32(40).i32(1).i32(1).u16(1).u16(24).u32(0).u32(4).i32(0).i32(0).u32(0).u32(0).bytes([0, 0, 255, 0]).out();

// ---- WMF: 놓을 자리 머리 + 창 + 펜·붓 + 사각형 + 글자 + 비트맵 ----
{
  const recs = [];
  const rec = (fn, params) => recs.push({ fn, params });
  rec(0x020c, new B().i16(1000).i16(2000).out()); // SETWINDOWEXT (y, x)
  rec(0x020b, new B().i16(0).i16(0).out()); // SETWINDOWORG
  rec(0x02fa, new B().u16(0).i16(20).i16(0).u32(0x0000ff).out()); // CREATEPENINDIRECT 빨강 (0x00BBGGRR)
  rec(0x02fc, new B().u16(0).u32(0x00ff00).u16(0).out()); // CREATEBRUSHINDIRECT 초록
  rec(0x012d, new B().u16(0).out()); // SELECTOBJECT 0 (펜)
  rec(0x012d, new B().u16(1).out()); // SELECTOBJECT 1 (붓)
  rec(0x041b, new B().i16(500).i16(1000).i16(100).i16(100).out()); // RECTANGLE (bottom, right, top, left)
  const font = new B().i16(-200).i16(0).i16(0).i16(0).i16(700).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0).u8(0);
  font.bytes([...Buffer.from('Arial'), 0]);
  while (font.length % 2) font.u8(0);
  rec(0x02fb, font.out()); // CREATEFONTINDIRECT (굵게)
  rec(0x012d, new B().u16(2).out());
  rec(0x0209, new B().u32(0xff0000).out()); // SETTEXTCOLOR 파랑
  const text = Buffer.from('Hi<&>');
  const to = new B().u16(text.length).bytes([...text]);
  if (text.length % 2) to.u8(0);
  to.i16(800).i16(1200); // y, x
  rec(0x0521, to.out()); // TEXTOUT
  const di = dib();
  rec(0x0b41, new B().u32(0x00cc0020).i16(1).i16(1).i16(0).i16(0).i16(100).i16(100).i16(600).i16(1500).bytes([...di]).out()); // DIBSTRETCHBLT
  rec(0x0000, new Uint8Array(0)); // EOF
  const body = new B();
  // 표준 머리 (9 워드)
  let total = 9;
  for (const r of recs) total += 3 + r.params.length / 2;
  body.u16(1).u16(9).u16(0x300).u32(total).u16(4).u32(0).u16(0);
  for (const r of recs) {
    body.u32(3 + r.params.length / 2).u16(r.fn).bytes([...r.params]);
  }
  // 놓을 자리 머리: 상자 0,0 ~ 2000,1000, 인치당 1000 → 192×96 px
  const head = new B().u32(0x9ac6cdd7).u16(0).i16(0).i16(0).i16(2000).i16(1000).u16(1000).u32(0);
  let sum = 0;
  for (let i = 0; i < 10; i++) sum ^= head.a[i * 2] | (head.a[i * 2 + 1] << 8);
  head.u16(sum);
  const wmf = Uint8Array.from([...head.a, ...body.a]);
  const svg = svgOf(m.metafileToSvg(wmf));
  ok(/width="192" height="96"/.test(svg), 'WMF: 놓을 자리 상자와 인치당 단위로 크기', svg.slice(0, 160));
  // 창 2000×1000 → 192×96: (100,100)~(1000,500) → (9.6,9.6)~(96,48)
  ok(/<path d="M9\.6 9\.6H96V48H9\.6Z" fill="#00ff00"[^>]*stroke="#ff0000"/.test(svg), 'WMF: 사각형을 창 좌표에서 출력 좌표로, 붓·펜 색', svg);
  ok(/<text x="115\.2" y="[\d.]+" font-family="Arial, sans-serif" font-size="19\.2" font-weight="bold" fill="#0000ff"[^>]*>Hi&lt;&amp;&gt;<\/text>/.test(svg), 'WMF: 글자(글꼴·크기·굵기·색, 특수 글자 처리)', svg.slice(svg.indexOf('<text'), svg.indexOf('<text') + 260));
  // 대상 (1500, 600) 100×100 → (144, 57.6) 9.6×9.6
  ok(/<image x="144" y="57\.6" width="9\.6" height="9\.6" preserveAspectRatio="none" href="data:image\/bmp;base64,Qk/.test(svg), 'WMF: 비트맵(DIB → BMP)', svg.slice(svg.indexOf('<image'), svg.indexOf('<image') + 160));
  // 망가진 파일: 잘린 것·엉뚱한 바이트
  ok(m.metafileToSvg(wmf.subarray(0, 40)) === null, 'WMF: 잘린 파일은 null');
  ok(m.metafileToSvg(new Uint8Array(100).fill(0xff)) === null, '메타파일이 아니면 null');
}

// ---- EMF: 머리 + 사각형 + 글자(UTF-16) + 끝 ----
{
  const recs = [];
  const emr = (type, params) => {
    const b = new B().u32(type).u32(8 + params.length).bytes([...params]);
    recs.push(b.out());
  };
  emr(43, new B().i32(10).i32(10).i32(110).i32(60).out()); // RECTANGLE
  const s = '한글 ok';
  const t = new B().i32(0).i32(0).i32(200).i32(100); // 테두리
  t.u32(1).u32(0).u32(0); // 그래픽 모드, 배율 x·y (float 0)
  // EMRTEXT: 기준점, 글자 수, 글자 자리(기록 처음부터), 선택, 상자, 간격 자리
  const off = 8 + 16 + 12 + 40;
  t.i32(20).i32(80).u32(s.length).u32(off).u32(0).i32(0).i32(0).i32(0).i32(0).u32(0);
  for (const ch of s) t.u16(ch.charCodeAt(0));
  while (t.length % 4) t.u8(0);
  emr(84, t.out()); // EXTTEXTOUTW
  emr(14, new B().u32(0).u32(0).u32(0).out()); // EOF
  // 머리: 테두리, 틀(0.01mm), 서명, 판, 크기, 기록 수, 개체 수, …, 장치 크기(화소), 장치 크기(mm)
  const h = new B().u32(1).u32(88).i32(0).i32(0).i32(199).i32(99).i32(0).i32(0).i32(5292).i32(2646).u32(0x464d4520).u32(0x10000).u32(0).u32(recs.length + 1).u16(1).u16(0).u32(0).u32(0).u32(0).i32(1000).i32(1000).i32(264).i32(264);
  const all = [...h.a];
  for (const r of recs) all.push(...r);
  const emf = Uint8Array.from(all);
  emf.set(new B().u32(emf.length).out(), 48);
  const svg = svgOf(m.metafileToSvg(emf));
  ok(/<svg [^>]*width="200(\.\d+)?" height="100(\.\d+)?"/.test(svg), 'EMF: 틀(0.01mm)로 크기', svg.slice(0, 160));
  // 참조 장치 화소(1000px/264mm)와 틀(0.01mm)의 비율로 출력 화소에 맞춘다: (10,10)~(110,60) → 약 (9.98, 9.98)~(109.76, 59.87)
  ok(/<path d="M9\.98 9\.98H109\.76V59\.87H9\.98Z"/.test(svg), 'EMF: 사각형 (장치 화소 → 출력 화소)', svg);
  ok(/>한글 ok<\/text>/.test(svg), 'EMF: 글자(UTF-16)', svg);
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
