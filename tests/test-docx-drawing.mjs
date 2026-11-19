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

// ---- 5. DOCX 로 다시 쓰기: 떠 있는 그림·글상자, 구역마다 용지, 쪽 배경·테두리 ----
{
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const para = (content, attrs = {}) => ({ type: 'paragraph', attrs, content });
  const tx = (s) => ({ type: 'text', text: s });
  const doc = {
    type: 'doc',
    content: [
      para([{ type: 'image', attrs: { src: png, width: 120, height: 80, float: { x: 30, y: 12, wrap: { s: 'r', d: [0, 12, 0, 12], o: 'bothSides' } } } }, tx('그림 옆 글')], { indentLeft: 18 }),
      { type: 'textBox', attrs: { width: 200, height: 90, padding: [4, 8, 4, 8], bg: '#FFEECC', borderColor: '#336699', borderWidth: 1.5, valign: 'middle', float: { x: 300, y: 5, wrap: { s: 'tb', d: [6, 0, 6, 0] } } }, content: [para([tx('상자 안 글')])] },
      para([tx('상자 뒤 문단')]),
      { type: 'pageBreak', attrs: { sectionPage: { width: 210, height: 297, landscape: true, marginTop: 10, marginBottom: 10, marginLeft: 20, marginRight: 20, marginHeader: 10, marginFooter: 10, gutter: 0 } } },
      para([tx('가로 구역')]),
    ],
  };
  const settings = (await m.readDocx(await makeDocx({ body: p(t('x')) }))).settings;
  settings.pageBorder = { body: false, offset: [8.5, 8.5, 8.5, 8.5], bg: '#FFFFCC', fillArea: 'paper', sides: { t: { s: 'solid', w: 0.5, c: '#FF0000' }, b: { s: 'double', w: 0.5, c: '#0000FF' } } };
  const out = await m.writeDocx({ content: doc, settings, meta: {} });
  const zip = await JSZip.loadAsync(out);
  const dx = await zip.file('word/document.xml').async('string');
  const st = await zip.file('word/settings.xml').async('string');
  ok(/<wp:anchor [^>]*behindDoc="0"[^>]*><wp:simplePos x="0" y="0"\/><wp:positionH relativeFrom="column"><wp:posOffset>(\d+)<\/wp:posOffset><\/wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>114300<\/wp:posOffset>/.test(dx), '떠 있는 그림: wp:anchor (문단 기준 자리)', dx.slice(dx.indexOf('<wp:anchor'), dx.indexOf('<wp:anchor') + 400));
  ok(/<wp:wrapSquare wrapText="bothSides"/.test(dx), '둘레 글 흐름: Word 에 적혀 있던 쪽(양쪽)을 되돌린다');
  ok(/<wps:wsp><wps:cNvSpPr txBox="1"\/>.*<a:srgbClr val="FFEECC"\/>.*<w:txbxContent><w:p>.*상자 안 글.*<\/w:txbxContent>.*anchor="ctr"/.test(dx) && /<wp:wrapTopAndBottom/.test(dx), '떠 있는 글상자: wps 글상자(바탕·테두리·세로 맞춤·위아래 배치)', '');
  // 글상자는 뒤 문단(상자 뒤 문단)에 매단다 (글상자 안의 문단은 빼고 본다)
  const flat = dx.replace(/<w:txbxContent>.*?<\/w:txbxContent>/g, '');
  ok(/<w:p><w:pPr>(?:(?!<\/w:p>).)*<\/w:pPr><w:r><w:drawing><wp:anchor(?:(?!<\/w:p>).)*상자 뒤 문단/.test(flat), '글상자는 뒤 문단의 맨 앞에 매단다');
  // 첫 구역은 시험 문서의 용지(편지지 세로)
  ok(/<w:sectPr>(?:(?!<\/w:sectPr>).)*<w:pgSz w:w="12240" w:h="15840"\/>(?:(?!<\/w:sectPr>).)*<\/w:sectPr><\/w:pPr>(?:(?!<\/w:p>).)*상자 뒤 문단/.test(flat), '구역 나누기: 앞 구역의 설정을 그 구역의 마지막 문단에', '');
  ok(/<w:body>.*<w:sectPr>(?:(?!<\/w:sectPr>).)*<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>.*<\/w:body>/.test(dx), '끝 구역: 가로 용지', '');
  ok(!/<w:pageBreakBefore\/>|w:type="page"/.test(dx), '새 구역 앞에 쪽 나누기를 따로 두지 않는다 (빈 쪽이 생기지 않게)');
  ok(/<w:background w:color="FFFFCC"/.test(dx) && /<w:displayBackgroundShape\/>/.test(st), '쪽 배경색과 배경 표시 설정');
  ok(/<w:pgBorders w:offsetFrom="page"><w:top w:val="single" w:sz="11" w:space="24" w:color="FF0000"\/><w:bottom w:val="double"/.test(dx), '쪽 테두리 (종이 기준, 굵기 1/8pt, 간격 pt)', (dx.match(/<w:pgBorders.*?<\/w:pgBorders>/) || [''])[0]);
  // 다시 읽기
  const back = await m.readDocx(out);
  const img = find(back.content.content, (n) => n.type === 'image')[0];
  ok(img && img.attrs.float && Math.abs(img.attrs.float.x - 30) < 1 && Math.abs(img.attrs.float.y - 12) < 1 && img.attrs.float.wrap?.o === 'bothSides', '다시 읽기: 그림 자리·글 흐름', JSON.stringify(img?.attrs.float));
  const box = boxes(back)[0];
  ok(box && Math.abs(box.attrs.float.x - 300) < 1 && box.attrs.float.wrap?.s === 'tb' && box.attrs.bg === '#FFEECC', '다시 읽기: 글상자 자리·바탕·배치', JSON.stringify(box?.attrs));
  const kinds = back.content.content.map((n) => n.type + (n.type === 'pageBreak' && n.attrs?.sectionPage?.landscape ? '(가로)' : ''));
  ok(kinds.includes('pageBreak(가로)'), '다시 읽기: 가로 구역', JSON.stringify(kinds));
  ok(back.settings.pageBorder?.bg === '#FFFFCC' && back.settings.pageBorder?.sides?.t?.c === '#FF0000', '다시 읽기: 쪽 배경·테두리', JSON.stringify(back.settings.pageBorder));
}

// ---- 6. 그리기 개체: DOCX 로 쓰고(묶음·사용자 경로·글·그림) 다시 읽기 ----
{
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const I = [1, 0, 0, 1, 0, 0];
  const items = [
    { k: 'rect', m: [1, 0, 0, 1, 10, 10], w: 100, h: 50, r: 20, fc: '#336699', sc: '#000000', sw: 1 },
    { k: 'ellipse', m: [1, 0, 0, 1, 130, 10], w: 60, h: 40, fc: '#FFCC00', sc: null },
    { k: 'poly', m: I, w: 200, h: 120, p: [10, 110, 60, 70, 110, 110], z: true, fc: '#CC0000', sc: '#000000', sw: 2 },
    { k: 'line', m: I, w: 200, h: 120, p: [120, 100, 190, 80], sc: '#0000FF', sw: 1.5, ts: 'ARROW', tf: true },
    { k: 'text', m: [1, 0, 0, 1, 10, 10], w: 100, h: 50, content: [{ type: 'paragraph', content: [{ type: 'text', text: '도형 안 글' }] }], pad: [2, 4, 2, 4], va: 'middle' },
    { k: 'img', m: [1, 0, 0, 1, 150, 60], w: 40, h: 40, src: png },
  ];
  const doc = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'shape', attrs: { width: 200, height: 120, d: { items, group: true }, float: { x: 20, y: 0, wrap: { s: 'tb', d: [0, 0, 0, 0] } } } }, { type: 'text', text: '뒤 글' }] }] };
  const settings = (await m.readDocx(await makeDocx({ body: p(t('x')) }))).settings;
  const out = await m.writeDocx({ content: doc, settings, meta: {} });
  const dx = await (await JSZip.loadAsync(out)).file('word/document.xml').async('string');
  ok(/<wp:anchor [^>]*>.*<wpg:wgp>.*<\/wpg:wgp>.*<\/wp:anchor>/.test(dx), '그리기 개체: 떠 있는 묶음(wpg:wgp)으로', dx.slice(0, 300));
  ok((dx.match(/<wps:wsp>/g) || []).length === 5 && /<pic:pic>/.test(dx), '조각마다 도형(wps)·글상자·그림(pic)', String((dx.match(/<wps:wsp>/g) || []).length));
  ok(/<a:custGeom>.*<a:cubicBezTo>/.test(dx) && /<a:tailEnd type="triangle"/.test(dx) && /<a:srgbClr val="CC0000"/.test(dx), '사용자 경로(둥근 모서리·타원은 베지어)·화살표·채우기', '');
  ok(/<w:txbxContent>.*도형 안 글.*<\/w:txbxContent>/.test(dx), '도형 안 글은 글상자로');
  const back = await m.readDocx(out);
  const sh = find(back.content.content, (n) => n.type === 'shape')[0];
  const kinds = sh ? sh.attrs.d.items.map((x) => x.k).join(',') : '';
  ok(sh && sh.attrs.d.group && /poly/.test(kinds) && /text/.test(kinds) && /img/.test(kinds), '다시 읽기: 묶음의 조각들 (사용자 경로는 다각형으로)', kinds);
  const poly = sh?.attrs.d.items.find((x) => x.k === 'poly' && x.fc === '#CC0000');
  ok(poly && poly.p.length === 6 && Math.abs(poly.p[2] - 60) < 1 && Math.abs(poly.p[3] - 70) < 1, '다시 읽기: 다각형 점 자리', JSON.stringify(poly?.p));
  ok(JSON.stringify(sh?.attrs.d.items.find((x) => x.k === 'text')?.content || []).includes('도형 안 글'), '다시 읽기: 도형 안 글', '');
}

// ---- 7. 예전 방식(VML) 그리기 개체와 양식 확인란 ----
{
  const V = 'xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w10="urn:schemas-microsoft-com:office:word"';
  const pict = (inner) => `<w:r><w:pict ${V}>${inner}</w:pict></w:r>`;
  const body =
    // 문단 기준 선 (form 의 밑줄 선)
    p(pict('<v:line style="position:absolute;z-index:1;mso-position-horizontal-relative:text;mso-position-vertical-relative:text" from="252pt,10pt" to="525.6pt,10pt" strokecolor="#ff0000"/>') + t('선')) +
    // 떠 있는 글상자 (위아래 배치)
    p(pict('<v:shape type="#_x0000_t202" style="position:absolute;margin-left:36pt;margin-top:6pt;width:144pt;height:72pt;z-index:2" fillcolor="#ffffcc" strokecolor="blue"><v:textbox inset="3pt,2pt,3pt,2pt"><w:txbxContent>' + p(t('VML 상자')) + '</w:txbxContent></v:textbox><w10:wrap type="topAndBottom"/></v:shape>') + t('뒤 글')) +
    // 경로 도형 (비운 값은 0) 과 워드아트, 묶음
    p(pict('<v:shape style="width:72pt;height:72pt" coordsize="21600,21600" path="m,l,21600r21600,l21600,xe" fillcolor="#00ff00"/>') + pict('<v:shape type="#_x0000_t136" style="width:150pt;height:30pt" fillcolor="#9400ed"><v:textpath style="font-family:&quot;Arial Black&quot;" string="Word Art"/></v:shape>')) +
    p(pict('<v:group style="width:100pt;height:50pt" coordorigin="0,0" coordsize="1000,500"><v:rect style="position:absolute;left:0;top:0;width:500;height:500" fillcolor="red"/><v:oval style="position:absolute;left:500;top:0;width:500;height:500" fillcolor="blue" stroked="f"/></v:group>')) +
    // 양식 확인란
    p('<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:sizeAuto/><w:default w:val="1"/></w:checkBox></w:ffData></w:fldChar></w:r><w:r><w:instrText> FORMCHECKBOX </w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' + t(' 켜짐') + '<w:r><w:fldChar w:fldCharType="begin"><w:ffData><w:checkBox><w:default w:val="0"/></w:checkBox></w:ffData></w:fldChar></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>' + t(' 꺼짐'));
  const doc = await m.readDocx(await makeDocx({ body }));
  const shs = shapes(doc);
  const ln = shs.find((s) => s.attrs.d.items[0].k === 'line');
  ok(ln && ln.attrs.float && Math.abs(ln.attrs.width - 364.8) < 0.5 && ln.attrs.d.items[0].sc === '#FF0000', 'VML 선: 문단 기준 자리·길이·색', JSON.stringify(ln?.attrs));
  const vb = boxes(doc)[0];
  ok(vb && vb.attrs.float && Math.abs(vb.attrs.float.x - 48) < 0.5 && Math.abs(vb.attrs.float.y - 8) < 0.5 && vb.attrs.float.wrap?.s === 'tb' && vb.attrs.bg === '#FFFFCC' && vb.attrs.borderColor === '#0000FF', 'VML 글상자: 자리·위아래 배치·바탕·테두리', JSON.stringify(vb?.attrs));
  const poly = shs.find((s) => s.attrs.d.items[0].k === 'poly');
  ok(poly && JSON.stringify(poly.attrs.d.items[0].p) === '[0,0,0,96,96,96,96,0]' && poly.attrs.d.items[0].z, 'VML 경로: 비운 값은 0 (사각형)', JSON.stringify(poly?.attrs.d.items[0]));
  const art = shs.find((s) => s.attrs.d.items[0].k === 'art');
  ok(art && art.attrs.d.items[0].text === 'Word Art' && art.attrs.d.items[0].font === 'Arial Black', 'VML 워드아트: 글자·글꼴', JSON.stringify(art?.attrs.d.items[0]));
  const grp = shs.find((s) => s.attrs.d.group);
  ok(grp && grp.attrs.d.items.map((i) => i.k).join(',') === 'rect,ellipse' && Math.abs(grp.attrs.d.items[1].m[4] - 66.67) < 0.1 && grp.attrs.d.items[1].sc === null, 'VML 묶음: 좌표계 대응·조각', JSON.stringify(grp?.attrs.d.items.map((i) => [i.k, i.m, i.w, i.sc])));
  const texts = doc.content.content.map((n) => (n.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('')).join('|');
  ok(/☒ 켜짐☐ 꺼짐/.test(texts), '양식 확인란: 켜짐 ☒ · 꺼짐 ☐', texts);
}

// ---- 8. 틀 (w:framePr): 꼬리말의 오른쪽 쪽 번호, 본문 왼쪽 틀(글이 옆으로), 종이 기준 틀, 첫 글자 장식, 저장 ----
{
  const pp = (inner, ppr) => `<w:p><w:pPr>${ppr}</w:pPr>${inner}</w:p>`;
  const page = `<w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="18"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="18"/></w:rPr><w:t>7</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>`;
  const parts = { footer1: pp(page, '<w:framePr w:wrap="around" w:vAnchor="text" w:hAnchor="margin" w:xAlign="right" w:y="1"/>') + pp(t('꼬리말 글'), '<w:ind w:right="360"/><w:jc w:val="center"/>') };
  const frame = '<w:framePr w:hSpace="180" w:wrap="around" w:vAnchor="text" w:hAnchor="text" w:y="1"/>';
  const body =
    pp(t('틀 첫 문단'), frame) +
    pp(t('틀 둘째 문단'), frame) +
    pp(t('곁 문단'), '<w:ind w:left="720" w:hanging="360"/>') +
    pp(t('종이 기준 틀'), '<w:framePr w:w="2880" w:h="1440" w:hRule="exact" w:wrap="notBeside" w:vAnchor="page" w:hAnchor="page" w:x="1440" w:y="2880"/>') +
    p(t('뒤 문단')) +
    pp('<w:r><w:rPr><w:sz w:val="96"/></w:rPr><w:t>L</w:t></w:r>', '<w:framePr w:dropCap="drop" w:lines="3" w:wrap="around" w:vAnchor="text" w:hAnchor="text"/><w:spacing w:after="0" w:line="827" w:lineRule="exact"/>') +
    p(t('orem ipsum 첫 글자 장식 뒤 글'));
  const doc = await m.readDocx(await makeDocx({ body, parts, sect: '<w:footerReference w:type="default" r:id="r_footer1"/>' }));
  const top = doc.content.content;
  const kinds = top.map((n) => n.type + (n.type === 'textBox' ? '(' + n.content.length + ')' : ''));
  ok(JSON.stringify(kinds) === JSON.stringify(['textBox(2)', 'paragraph', 'textBox(1)', 'paragraph', 'textBox(1)', 'paragraph']), '같은 틀 속성의 이웃 문단은 한 틀, 틀은 뒤 문단 앞의 떠 있는 글상자', JSON.stringify(kinds));
  const f1 = top[0].attrs;
  ok(f1.float.cf === 'l' && f1.float.y === 0.07 && f1.float.wrap?.s === 'r' && f1.float.wrap.d[1] === 12 && !f1.width && JSON.stringify(f1.padding) === '[0,0,0,0]', '본문 왼쪽 틀: 내용 폭, 글은 오른쪽으로 hSpace 만큼 떨어져 (CSS float)', JSON.stringify(f1));
  // 곁 문단의 내어쓰기(18pt = 24px)만큼 비킬 자리를 넓힌다 (CSS 는 첫 줄을 틀 쪽으로 당긴다)
  ok(f1.float.hg === 24, '곁 문단의 내어쓰기만큼 비킬 자리', JSON.stringify(f1.float));
  const f2 = top[2].attrs;
  // 종이 기준: x = 1 인치(종이 왼쪽) → 본문 왼쪽 기준 0, y = 2 인치(종이 위) → 본문 맨 위 기준 96px
  ok(f2.width === 192 && f2.height === 96 && f2.float.x === 0 && f2.float.py === 96 && !f2.float.wrap, '종이 기준 틀: 크기·쪽 기준 자리 (옆을 비우는 notBeside 는 쪽 기준이라 비킴 없음)', JSON.stringify(f2));
  const f3 = top[4].attrs;
  ok(f3.float.cf === 'l' && f3.float.x === 0 && f3.float.y === 0 && f3.float.wrap?.s === 'r', '첫 글자 장식: 뒤 문단 맨 앞, 글이 오른쪽으로', JSON.stringify(f3));
  const foot = doc.settings.footer.content;
  const fb = foot[0];
  ok(fb.type === 'textBox' && fb.attrs.float.ax === 'r' && fb.attrs.float.x === 0 && !fb.attrs.width && foot[1].type === 'paragraph', '꼬리말의 쪽 번호 틀: 오른쪽 여백 끝에 붙는 내용 폭 상자, 꼬리말 글은 그대로', JSON.stringify(fb.attrs));
  const pn = fb.content[0].content[0];
  ok(pn.text === '{{PAGE}}' && pn.marks?.some((k) => k.type === 'textStyle' && k.attrs.fontSize === 9 && /Arial/.test(k.attrs.fontFamily)), '쪽 번호 자리 글자는 필드 결과 글자의 모양', JSON.stringify(pn));

  // 저장: 오른쪽 맞춤 틀은 오른쪽 맞춤, 크기를 정하지 않은 틀은 글에 맞춰 늘고 준다
  const out = await m.writeDocx({ content: doc.content, settings: doc.settings, meta: {} });
  const zip = await JSZip.loadAsync(out);
  const dx = await zip.file('word/document.xml').async('string');
  const ftrName = Object.keys(zip.files).find((n) => /^word\/footer\d*\.xml$/.test(n));
  const fx = ftrName ? await zip.file(ftrName).async('string') : '';
  ok(/<wp:positionH relativeFrom="margin"><wp:align>right<\/wp:align><\/wp:positionH>/.test(fx) && /wrap="none"[^>]*><a:spAutoFit\/>/.test(fx), '저장: 꼬리말 쪽 번호 틀 → 오른쪽 맞춤, 글에 맞춘 크기', fx.slice(0, 200));
  ok(/<wps:bodyPr [^>]*wrap="none"[^>]*><a:spAutoFit\/>/.test(dx) && /<wp:wrapSquare wrapText="[a-zA-Z]+"/.test(dx), '저장: 본문 틀 → 글에 맞춘 크기의 글상자, 둘레 글 흐름', '');
}

// ---- 9. 차트: 함께 저장된 값으로 그린다 (그릴 수 없는 새 차트는 Word 가 넣어 둔 그림) ----
{
  const zip = new JSZip();
  zip.file('[Content_Types].xml', DECL + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  zip.file('_rels/.rels', DECL + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', DECL + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rC1" Type="${REL}/chart" Target="charts/chart1.xml"/></Relationships>`);
  const C = 'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"';
  const pt = (v) => v.map((x, i) => `<c:pt idx="${i}"><c:v>${x}</c:v></c:pt>`).join('');
  zip.file('word/charts/chart1.xml', DECL + `<c:chartSpace ${C} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:title><c:overlay val="0"/></c:title><c:plotArea><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:tx><c:v>매출</c:v></c:tx><c:cat><c:strRef><c:strCache><c:ptCount val="3"/>${pt(['1분기', '2분기', '3분기'])}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="3"/>${pt([10, 20, 15])}</c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart><c:catAx><c:axId val="1"/></c:catAx><c:valAx><c:axId val="2"/></c:valAx></c:plotArea></c:chart></c:chartSpace>`);
  const drawing = `<w:r><w:drawing><wp:inline><wp:extent cx="${480 * EMU}" cy="${288 * EMU}"/><wp:docPr id="1" name="차트"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart ${C} xmlns:r="${REL}" r:id="rC1"/></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
  zip.file('word/document.xml', DECL + `<w:document ${NS}><w:body>${p(drawing)}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  zip.file('word/styles.xml', DECL + `<w:styles ${NS}></w:styles>`);
  const doc = await m.readDocx(await zip.generateAsync({ type: 'uint8array' }));
  const img = find(doc.content.content, (n) => n.type === 'image')[0];
  const svg = img && /^data:image\/svg\+xml;base64,/.test(img.attrs.src) ? Buffer.from(img.attrs.src.split(',')[1], 'base64').toString() : '';
  ok(img && img.attrs.width === 480 && img.attrs.height === 288 && />1분기</.test(svg) && />매출</.test(svg) && (svg.match(/<rect /g) || []).length >= 4, '차트: 크기 그대로 막대·항목·제목(글 없는 제목은 계열 이름)을 그린 SVG', svg.slice(0, 200));
}

console.log(failed ? `${failed}개 실패` : '모두 통과');
process.exit(failed ? 1 : 0);
