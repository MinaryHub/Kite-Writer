// Word 문서의 떠 있는 개체: 자리·상대 크기·둘레 글 흐름, 머리말 안의 개체, 쪽 배경·쪽 테두리
//   node tests/test-docx-drawing.mjs
import { load } from './harness.mjs';
import JSZip from 'jszip';
const m = await load('tests/formats.entry.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};
const NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing" ' +
  'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const EMU = 9525;

/** 시험용 DOCX: 편지지(8.5×11 인치), 여백 1 인치, 머리말 0.5 인치 */
async function makeDocx({ body, sect = '', settings = '', parts = {}, before = '' }) {
  const zip = new JSZip();
  const names = Object.keys(parts);
  zip.file(
    '[Content_Types].xml',
    DECL +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file('_rels/.rels', DECL + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file(
    'word/_rels/document.xml.rels',
    DECL +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      names.map((n) => `<Relationship Id="r_${n}" Type="${REL}/${n.startsWith('header') ? 'header' : 'footer'}" Target="${n}.xml"/>`).join('') +
      `</Relationships>`,
  );
  for (const n of names) zip.file(`word/${n}.xml`, DECL + `<w:${n.startsWith('header') ? 'hdr' : 'ftr'} ${NS}>${parts[n]}</w:${n.startsWith('header') ? 'hdr' : 'ftr'}>`);
  zip.file('word/document.xml', DECL + `<w:document ${NS}>${before}<w:body>${body}<w:sectPr>${sect}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  zip.file('word/styles.xml', DECL + `<w:styles ${NS}></w:styles>`);
  zip.file('word/settings.xml', DECL + `<w:settings ${NS}>${settings}</w:settings>`);
  return zip.generateAsync({ type: 'uint8array' });
}
const p = (inner) => `<w:p>${inner}</w:p>`;
const t = (s) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;

/** 떠 있는 도형(글상자 또는 그린 도형) 하나: 크기·자리는 px */
function anchor({ w, h, x = 0, y = 0, hRel = 'column', vRel = 'paragraph', vAlign = '', wrap = '<wp:wrapSquare wrapText="bothSides"/>', prst = 'rect', text = '상자 글', rel = '', dist = [0, 114300, 0, 114300] }) {
  const pv = vAlign ? `<wp:align>${vAlign}</wp:align>` : `<wp:posOffset>${Math.round(y * EMU)}</wp:posOffset>`;
  const txbx = text ? `<wps:txbx><w:txbxContent>${p(t(text))}</w:txbxContent></wps:txbx>` : '';
  return (
    `<w:r><w:drawing><wp:anchor distT="${dist[0]}" distB="${dist[2]}" distL="${dist[3]}" distR="${dist[1]}" simplePos="0" relativeHeight="1" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1">` +
    `<wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="${hRel}"><wp:posOffset>${Math.round(x * EMU)}</wp:posOffset></wp:positionH>` +
    `<wp:positionV relativeFrom="${vRel}">${pv}</wp:positionV><wp:extent cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/>${wrap}<wp:docPr id="1" name="상자"/>` +
    `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${Math.round(w * EMU)}" cy="${Math.round(h * EMU)}"/></a:xfrm>` +
    `<a:prstGeom prst="${prst}"><a:avLst/></a:prstGeom><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></wps:spPr>${txbx}<wps:bodyPr/></wps:wsp></a:graphicData></a:graphic>${rel}</wp:anchor></w:drawing></w:r>`
  );
}
const find = (nodes, pred, out = []) => {
  for (const n of nodes || []) {
    if (pred(n)) out.push(n);
    find(n.content, pred, out);
  }
  return out;
};
const boxes = (doc) => find(doc.content.content, (n) => n.type === 'textBox');
const shapes = (doc) => find(doc.content.content, (n) => n.type === 'shape');

// ---- 1. 둘레 글 흐름 ----
{
  // 본문 폭 624px: 왼쪽 끝 상자는 글이 오른쪽으로, 오른쪽 끝 상자는 왼쪽으로, 본문보다 넓은 상자는 옆을 비운다
  const body =
    p(anchor({ w: 200, h: 100, x: 0, y: 10 }) + t('왼쪽 상자')) +
    p(anchor({ w: 200, h: 100, x: 424, y: 0 }) + t('오른쪽 상자')) +
    p(anchor({ w: 640, h: 300, x: -8, y: 20 })) +
    p(anchor({ w: 200, h: 100, x: 100, wrap: '<wp:wrapTopAndBottom/>' }) + t('위아래')) +
    p(anchor({ w: 200, h: 100, x: 100, wrap: '<wp:wrapNone/>' }) + t('글 앞')) +
    p(anchor({ w: 200, h: 100, x: 100, y: 200, vRel: 'page' }) + t('쪽 기준'));
  const doc = await m.readDocx(await makeDocx({ body }));
  const bs = boxes(doc);
  ok(bs.length === 6, '떠 있는 글상자 여섯', String(bs.length));
  const wr = bs.map((b) => b.attrs.float?.wrap || null);
  ok(wr[0]?.s === 'r' && JSON.stringify(wr[0].d) === '[0,12,0,12]', '왼쪽 끝 상자: 글은 오른쪽으로, 간격(EMU → px)', JSON.stringify(wr[0]));
  ok(wr[1]?.s === 'l', '오른쪽 끝 상자: 글은 왼쪽으로', JSON.stringify(wr[1]));
  ok(wr[2]?.s === 'tb', '본문보다 넓은 상자: 옆을 비운다', JSON.stringify(wr[2]));
  ok(wr[3]?.s === 'tb', '위아래 배치', JSON.stringify(wr[3]));
  ok(wr[4] === null, '글 앞 배치는 비키지 않는다', JSON.stringify(wr[4]));
  ok(wr[5] === null && bs[5].attrs.float.py === 104, '쪽 기준 개체는 쪽 안 자리(py)만, 비키지 않는다', JSON.stringify(bs[5].attrs.float));
  ok(bs[0].attrs.float.y === 10 && bs[0].attrs.float.x === 0, '문단 기준 자리', JSON.stringify(bs[0].attrs.float));
  // 한글로 저장: 어울림·자리 차지와 바깥 여백
  const hx = await m.writeHwpx({ content: doc.content, settings: doc.settings, meta: {} });
  const zip = await JSZip.loadAsync(hx);
  const sec = await zip.file('Contents/section0.xml').async('string');
  ok(/textWrap="SQUARE"/.test(sec) && /textWrap="TOP_AND_BOTTOM"[^>]*numberingType|numberingType="[A-Z]+" textWrap="TOP_AND_BOTTOM"/.test(sec) && /<hp:outMargin left="900" right="900"/.test(sec), 'HWPX 로 저장: 어울림·자리 차지, 바깥 여백', (sec.match(/textWrap="\w+"/g) || []).join(','));
}

// ---- 2. 상대 크기 (wp14:sizeRelH·sizeRelV) ----
{
  const rel = '<wp14:sizeRelH relativeFrom="page"><wp14:pctWidth>50000</wp14:pctWidth></wp14:sizeRelH><wp14:sizeRelV relativeFrom="margin"><wp14:pctHeight>25000</wp14:pctHeight></wp14:sizeRelV>';
  const zero = '<wp14:sizeRelH relativeFrom="page"><wp14:pctWidth>0</wp14:pctWidth></wp14:sizeRelH>';
  const body = p(anchor({ w: 100, h: 50, rel })) + p(anchor({ w: 100, h: 50, rel: zero }));
  const doc = await m.readDocx(await makeDocx({ body }));
  const [a, b] = boxes(doc);
  ok(a.attrs.width === 408 && a.attrs.height === 216, '쪽 폭의 50%, 본문 높이의 25%', JSON.stringify([a.attrs.width, a.attrs.height]));
  ok(b.attrs.width === 100 && b.attrs.height === 50, '비율 0 이면 extent 크기', JSON.stringify([b.attrs.width, b.attrs.height]));
}

// ---- 3. 머리말 안의 떠 있는 개체 (쪽 가운데 세로선) ----
{
  const line = anchor({ w: 2, h: 0, x: 300, hRel: 'page', vRel: 'page', vAlign: 'center', prst: 'line', text: '', wrap: '<wp:wrapNone/>', rel: '<wp14:sizeRelV relativeFrom="margin"><wp14:pctHeight>100000</wp14:pctHeight></wp14:sizeRelV>' });
  const parts = { header1: p(line + t('머리말')) };
  const doc = await m.readDocx(await makeDocx({ body: p(t('본문')), parts, sect: '<w:headerReference w:type="default" r:id="r_header1"/>' }));
  const hs = find(doc.settings.header.content || [], (n) => n.type === 'shape');
  const fl = hs[0]?.attrs.float;
  // 본문 높이 864px 의 선이 쪽 가운데(위끝 96px): 머리말 영역 위쪽(48px) 기준으로 48px 아래
  ok(hs.length === 1 && hs[0].attrs.height === 864 && fl && fl.py == null && fl.y === 48, '머리말 안 세로선: 크기·영역 기준 자리', JSON.stringify(hs[0]?.attrs && { h: hs[0].attrs.height, fl }));
}

// ---- 4. 쪽 배경·쪽 테두리 ----
{
  const before = '<w:background w:color="FFFFCC"/>';
  const sect = '<w:pgBorders w:offsetFrom="page"><w:top w:val="single" w:sz="8" w:space="24" w:color="FF0000"/><w:left w:val="double" w:sz="4" w:space="24" w:color="auto"/><w:bottom w:val="mapleMuffins" w:sz="12" w:space="24"/></w:pgBorders>';
  const shown = await m.readDocx(await makeDocx({ body: p(t('본문')), before, sect, settings: '<w:displayBackgroundShape/>' }));
  const pb = shown.settings.pageBorder;
  ok(pb?.bg === '#FFFFCC' && pb.fillArea === 'paper', '쪽 배경색 (displayBackgroundShape 가 있을 때)', JSON.stringify(pb));
  ok(pb?.sides?.t?.s === 'solid' && pb.sides.t.c === '#FF0000' && Math.abs(pb.sides.t.w - 0.353) < 0.01 && pb.sides.l?.s === 'double' && pb.sides.l.c === '#000000', '선으로 된 쪽 테두리: 종류·색·굵기', JSON.stringify(pb?.sides));
  ok(!pb?.sides?.b && pb?.body === false && Math.abs(pb.offset[2] - 8.47) < 0.01, '그림 테두리는 빼고, 종이 끝 기준 간격(pt → mm)', JSON.stringify(pb && { b: pb.sides?.b, body: pb.body, off: pb.offset }));
  const hidden = await m.readDocx(await makeDocx({ body: p(t('본문')), before }));
  ok(!hidden.settings.pageBorder?.bg, 'displayBackgroundShape 가 없으면 쪽 배경을 보이지 않는다', JSON.stringify(hidden.settings.pageBorder));
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
