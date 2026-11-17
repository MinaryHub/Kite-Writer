// Word 문서의 배치 정보: 탭 자리·절대 위치 탭, 머리말/꼬리말(첫 쪽·짝수 쪽·모양), 문단 사이 간격, 쪽 나눔 규칙
//   node tests/test-docx-layout.mjs
import { load } from './harness.mjs';
import JSZip from 'jszip';
const m = await load('tests/formats.entry.ts');

let failed = 0;
const ok = (cond, label, extra = '') => {
  if (!cond) failed++;
  console.log((cond ? 'OK   ' : 'FAIL ') + label + (cond ? '' : ' ' + extra));
};
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 시험용 DOCX 를 만든다 */
async function makeDocx({ body, sect = '', settings = '', styles = '', parts = {}, app = '' }) {
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
  for (const n of names) zip.file(`word/${n}.xml`, DECL + `<w:${n.startsWith('header') ? 'hdr' : 'ftr'} ${W}>${parts[n]}</w:${n.startsWith('header') ? 'hdr' : 'ftr'}>`);
  zip.file('word/document.xml', DECL + `<w:document ${W}><w:body>${body}<w:sectPr>${sect}<w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`);
  zip.file('word/styles.xml', DECL + `<w:styles ${W}>${styles}</w:styles>`);
  zip.file('word/settings.xml', DECL + `<w:settings ${W}>${settings}</w:settings>`);
  if (app) zip.file('docProps/app.xml', DECL + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${app}</Application></Properties>`);
  return zip.generateAsync({ type: 'uint8array' });
}
const p = (inner, ppr = '') => `<w:p>${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${inner}</w:p>`;
const t = (s) => `<w:r><w:t xml:space="preserve">${s}</w:t></w:r>`;
const tabs = (n) => (n.content || []).filter((c) => c.type === 'text' && c.marks?.some((k) => k.type === 'tab'));
const tabMark = (c) => c.marks.find((k) => k.type === 'tab').attrs;
const text = (n) => (n.type === 'text' ? n.text : (n.content || []).map(text).join(''));

// ---- 1. 탭 자리 ----
{
  const styles =
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Tabbed"><w:name w:val="Tabbed"/><w:basedOn w:val="Normal"/><w:pPr><w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:leader="dot" w:pos="9360"/></w:tabs></w:pPr></w:style>';
  const body =
    p(t('가') + '<w:r><w:tab/></w:r>' + t('나') + '<w:r><w:tab/></w:r><w:r><w:tab/></w:r>' + t('다'), '<w:pStyle w:val="Tabbed"/><w:tabs><w:tab w:val="clear" w:pos="4680"/><w:tab w:val="decimal" w:pos="2880"/><w:tab w:val="bar" w:pos="1000"/></w:tabs>') +
    p(t('탭 없는 문단'), '<w:pStyle w:val="Tabbed"/>') +
    p(t('왼쪽') + '<w:r><w:ptab w:relativeTo="margin" w:alignment="center" w:leader="none"/></w:r>' + t('가운데') + '<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="dot"/></w:r>' + t('오른쪽'));
  const doc = await m.readDocx(await makeDocx({ body, styles, settings: '<w:defaultTabStop w:val="708"/>' }));
  const [a, b, c] = doc.content.content;
  ok(JSON.stringify(a.attrs.tabs) === JSON.stringify({ d: 35.4, s: [[144, 'd', 0], [468, 'r', 3]] }), '탭 자리: 스타일의 자리에 문단의 자리를 더하고 clear 로 지운다, 기본 탭 간격', JSON.stringify(a.attrs.tabs));
  ok(tabs(a).length === 3 && tabs(a).every((x) => x.text === '\t'), '탭마다 따로 떨어진 탭 글자', JSON.stringify(a.content));
  ok(tabMark(tabs(a)[1]).k !== tabMark(tabs(a)[2]).k, '이웃한 탭은 구분 값이 달라 합쳐지지 않는다');
  ok(!b.attrs.tabs, '탭이 없는 문단에는 탭 자리를 적지 않는다');
  ok(tabs(c).length === 2 && tabMark(tabs(c)[0]).ptab === 'c' && tabMark(tabs(c)[1]).ptab === 'r' && tabMark(tabs(c)[1]).leader === 3 && c.attrs.tabs?.d === 35.4, '절대 위치 탭 (가운데·오른쪽, 채움)', JSON.stringify(c.content));
  // 다시 쓰고 읽어도 같다
  const out = await m.writeDocx({ content: doc.content, settings: doc.settings, meta: {} });
  const zip = await JSZip.loadAsync(out);
  const dx = await zip.file('word/document.xml').async('string');
  ok(/<w:tabs><w:tab w:val="decimal" w:pos="2880"\/><w:tab w:val="right" w:leader="dot" w:pos="9360"\/><\/w:tabs>/.test(dx), '쓰기: 문단의 탭 자리', dx.slice(0, 600));
  ok(/<w:ptab w:relativeTo="margin" w:alignment="center" w:leader="none"\/>/.test(dx) && /<w:ptab w:relativeTo="margin" w:alignment="right" w:leader="dot"\/>/.test(dx), '쓰기: 절대 위치 탭');
  ok(/<w:defaultTabStop w:val="708"\/>/.test(await zip.file('word/settings.xml').async('string')), '쓰기: 기본 탭 간격');
  const back = await m.readDocx(out);
  ok(JSON.stringify(back.content.content[0].attrs.tabs) === JSON.stringify(a.attrs.tabs) && tabMark(tabs(back.content.content[2])[1]).ptab === 'r', '다시 읽어도 탭 자리가 같다', JSON.stringify(back.content.content[0].attrs.tabs));
}

// ---- 2. 머리말/꼬리말: 첫 쪽·짝수 쪽, 모양 ----
{
  const sect =
    '<w:headerReference w:type="default" r:id="r_header1"/><w:headerReference w:type="first" r:id="r_header2"/><w:headerReference w:type="even" r:id="r_header3"/>' +
    '<w:footerReference w:type="default" r:id="r_footer1"/><w:titlePg/>';
  const parts = {
    header1: p(t('왼쪽') + '<w:r><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/></w:r>' + t('쪽 ') + '<w:fldSimple w:instr=" PAGE "><w:r><w:t>3</w:t></w:r></w:fldSimple>'),
    header2: p(t('첫 쪽 머리말')),
    header3: p(t('짝수 쪽 머리말'), '<w:jc w:val="right"/>'),
    footer1: p(t('꼬리말')) + p(''),
  };
  const doc = await m.readDocx(await makeDocx({ body: p(t('본문')), sect, parts, settings: '<w:evenAndOddHeaders/>' }));
  const h = doc.settings.header;
  const f = doc.settings.footer;
  ok(Array.isArray(h.content) && text({ content: h.content }) === '왼쪽\t쪽 {{PAGE}}', '머리말: 모양 그대로 담고 쪽 번호는 자리 표시로', JSON.stringify(h.content));
  ok(h.first && text({ content: h.first.content }) === '첫 쪽 머리말', '첫 쪽 머리말', JSON.stringify(h.first));
  ok(h.even && text({ content: h.even.content }) === '짝수 쪽 머리말' && h.even.align === 'right', '짝수 쪽 머리말', JSON.stringify(h.even));
  ok(f.valign === 'bottom' && f.content?.length === 2, '꼬리말: 빈 문단까지 담고 아래쪽에 맞춘다', JSON.stringify(f));
  ok(doc.settings.hideFirst?.footer === true && f.oddOnly === true, '첫 쪽·짝수 쪽의 꼬리말이 없으면 비운다', JSON.stringify([doc.settings.hideFirst, f.oddOnly]));
  ok(doc.settings.pageNumber.pos === 'none', 'Word 의 쪽 번호는 머리말 내용에 그대로 둔다');
  // 다시 쓰기
  const out = await m.writeDocx({ content: doc.content, settings: doc.settings, meta: {} });
  const zip = await JSZip.loadAsync(out);
  const dx = await zip.file('word/document.xml').async('string');
  const refs = [...dx.matchAll(/<w:(header|footer)Reference w:type="(\w+)"/g)].map((x) => x[1] + ':' + x[2]).sort().join(',');
  ok(refs === 'footer:default,header:default,header:even,header:first' && /<w:titlePg\/>/.test(dx), '쓰기: 기본·첫 쪽·짝수 쪽 머리말과 titlePg', refs);
  ok(/<w:evenAndOddHeaders\/>/.test(await zip.file('word/settings.xml').async('string')), '쓰기: evenAndOddHeaders');
  let wellFormed = true;
  for (const n of Object.keys(zip.files)) {
    if (!/\.(xml|rels)$/.test(n)) continue;
    const x = new DOMParser().parseFromString(await zip.file(n).async('string'), 'application/xml');
    if (x.getElementsByTagName('parsererror').length) {
      wellFormed = false;
      console.log('  XML 오류:', n);
    }
  }
  ok(wellFormed, '쓴 파일의 XML 이 모두 올바르다');
  const back = await m.readDocx(out);
  const bh = back.settings.header;
  ok(text({ content: bh.content }) === '왼쪽\t쪽 {{PAGE}}' && text({ content: bh.first?.content }) === '첫 쪽 머리말' && text({ content: bh.even?.content }) === '짝수 쪽 머리말', '다시 읽어도 머리말이 같다', JSON.stringify(bh).slice(0, 400));
  ok(back.settings.hideFirst?.footer === true && back.settings.footer.oddOnly === true && back.settings.footer.content?.length === 2, '다시 읽어도 꼬리말이 같다', JSON.stringify([back.settings.hideFirst, back.settings.footer]).slice(0, 300));
}

// ---- 3. Kite 가 쓴 글자 머리말·쪽 번호는 Kite 의 설정으로 돌아온다 ----
{
  const base = await m.readDocx(await makeDocx({ body: p(t('본문')) }));
  const settings = { ...base.settings, header: { text: '문서 제목', align: 'right' }, footer: { text: '꼬리 {{PAGES}}', align: 'left' }, pageNumber: { ...base.settings.pageNumber, pos: 'bottom-center', format: 'dash' } };
  const out = await m.writeDocx({ content: base.content, settings, meta: {} });
  const back = await m.readDocx(out);
  ok(JSON.stringify(back.settings.header) === JSON.stringify({ text: '문서 제목', align: 'right' }), 'Kite 머리말: 글자와 정렬', JSON.stringify(back.settings.header));
  ok(JSON.stringify(back.settings.footer) === JSON.stringify({ text: '꼬리 {{PAGES}}', align: 'left' }), 'Kite 꼬리말: 글자와 정렬 (쪽 번호 문단은 뺀다)', JSON.stringify(back.settings.footer));
  ok(back.settings.pageNumber.pos === 'bottom-center' && back.settings.pageNumber.format === 'dash', 'Kite 쪽 번호: 자리와 모양', JSON.stringify(back.settings.pageNumber));
}

// ---- 4. 문단 사이 간격, 쪽 나눔 규칙, 모두 대문자 ----
{
  const body =
    p(t('앞'), '<w:spacing w:after="200"/>') +
    p(t('제목'), '<w:keepNext/><w:keepLines/><w:spacing w:before="480" w:after="0"/>') +
    p(t('작은 위 간격'), '<w:widowControl w:val="0"/><w:spacing w:before="100"/>') +
    p('<w:r><w:rPr><w:caps/></w:rPr><w:t>Caps Text</w:t></w:r>');
  const doc = await m.readDocx(await makeDocx({ body }));
  const [a, b, c, d] = doc.content.content;
  ok(a.attrs.spaceAfter === 10 && b.attrs.spaceBefore === 14, '문단 사이 간격은 앞 문단의 아래 간격과 위 간격 가운데 큰 쪽', JSON.stringify([a.attrs.spaceAfter, b.attrs.spaceBefore]));
  ok(b.attrs.pageKeep === 'wnl' && a.attrs.pageKeep === 'w' && !c.attrs.pageKeep, '쪽 나눔 규칙: 외톨이줄 방지(기본)·다음 문단과 함께·문단 보호', JSON.stringify([a.attrs.pageKeep, b.attrs.pageKeep, c.attrs.pageKeep]));
  ok(text(d) === 'CAPS TEXT', '모두 대문자');
  const add = await m.readDocx(await makeDocx({ body, settings: '<w:compat><w:doNotUseHTMLParagraphAutoSpacing/></w:compat>' }));
  ok(add.content.content[1].attrs.spaceBefore === 24, '간격을 더하는 문서(doNotUseHTMLParagraphAutoSpacing)는 그대로', JSON.stringify(add.content.content[1].attrs));
  // Kite 는 간격을 더해 그린다: 쓴 문서에 그 설정을 적고, 다시 읽어도 값이 같다
  const out = await m.writeDocx({ content: doc.content, settings: doc.settings, meta: {} });
  const zip = await JSZip.loadAsync(out);
  ok(/<w:doNotUseHTMLParagraphAutoSpacing\/>/.test(await zip.file('word/settings.xml').async('string')), '쓰기: 간격을 더하는 설정');
  const dx = await zip.file('word/document.xml').async('string');
  ok(/<w:keepNext\/><w:keepLines\/><w:widowControl\/>/.test(dx), '쓰기: 쪽 나눔 규칙', dx.slice(0, 500));
  const back = await m.readDocx(out);
  const [ba, bb, bc] = back.content.content;
  ok(ba.attrs.spaceAfter === 10 && bb.attrs.spaceBefore === 14 && bb.attrs.pageKeep === 'wnl' && ba.attrs.pageKeep === 'w' && !bc.attrs.pageKeep, '다시 읽어도 간격과 쪽 나눔 규칙이 같다', JSON.stringify([ba.attrs, bb.attrs, bc.attrs]));
}

console.log(failed ? `실패 ${failed}건` : '모두 통과');
process.exit(failed ? 1 : 0);
