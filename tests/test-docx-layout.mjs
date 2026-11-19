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

// ---- 5. 표 칸 안 안쪽 표 뒤의 마지막 빈 문단: Word 는 그리지 않는다 ----
{
  const inner = '<w:tbl><w:tblGrid><w:gridCol w:w="2000"/></w:tblGrid><w:tr><w:tc>' + p(t('안쪽')) + '</w:tc></w:tr></w:tbl>';
  const cell = (c) => `<w:tc><w:tcPr><w:tcW w:w="4000" w:type="dxa"/></w:tcPr>${c}</w:tc>`;
  const body = '<w:tbl><w:tblGrid><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/><w:gridCol w:w="4000"/></w:tblGrid><w:tr>' + cell(inner + p('')) + cell(inner + p(t('글'))) + cell(p('') + p('')) + '</w:tr></w:tbl>' + p('');
  const doc = await m.readDocx(await makeDocx({ body }));
  const cells = doc.content.content[0].content[0].content;
  const tails = cells.map((c) => c.content.map((n) => n.type + (n.attrs?.cellTail ? '*' : '')).join(','));
  ok(JSON.stringify(tails) === JSON.stringify(['table,paragraph*', 'table,paragraph', 'paragraph,paragraph']), '안쪽 표 바로 뒤의 마지막 빈 문단만 표시 (글이 있거나 표 뒤가 아니면 그대로)', JSON.stringify(tails));
}

// ---- 6. 표: 제목 줄 되풀이, 셀 간격, 아주 좁은 격자 열 ----
{
  const tc = (w, s, extra = '') => `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>${extra}</w:tcPr>${p(t(s))}</w:tc>`;
  const head = '<w:trPr><w:tblHeader/></w:trPr>';
  const body =
    '<w:tbl><w:tblPr><w:tblCellSpacing w:w="15" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
    `<w:tr>${head}${tc(3000, '머리 1')}${tc(3000, '머리 2')}</w:tr><w:tr>${head}${tc(3000, '머리 3')}${tc(3000, '머리 4')}</w:tr>` +
    `<w:tr>${tc(3000, '몸 1')}${tc(3000, '몸 2')}</w:tr><w:tr>${head}${tc(3000, '중간의 제목 줄 표시는 무시')}${tc(3000, '')}</w:tr></w:tbl>` +
    // 엑셀에서 옮긴 표처럼 아주 좁은 격자 열(29 twip)이 낀 표: 합친 뒤에도 칸 폭의 합이 표 폭과 같아야 한다
    '<w:tbl><w:tblPr><w:tblW w:w="6029" w:type="dxa"/><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="29"/><w:gridCol w:w="3000"/></w:tblGrid>' +
    `<w:tr>${tc(6029, '한 칸', '<w:gridSpan w:val="3"/>')}</w:tr><w:tr>${tc(3029, '왼쪽', '<w:gridSpan w:val="2"/>')}${tc(3000, '오른쪽')}</w:tr><w:tr>${tc(3000, '왼쪽')}${tc(3029, '오른쪽', '<w:gridSpan w:val="2"/>')}</w:tr></w:tbl>` +
    p('');
  const doc = await m.readDocx(await makeDocx({ body }));
  const [a, b] = doc.content.content.filter((n) => n.type === 'table');
  ok(JSON.stringify(a.content.map((r) => r.attrs?.repeat === true)) === '[true,true,false,false]', '제목 줄: 맨 앞에서부터 이어진 tblHeader 줄만', JSON.stringify(a.content.map((r) => r.attrs)));
  ok(a.attrs.cellSpacing === 2, '셀 간격: 적힌 값의 두 배 (15 twip → 2px)', JSON.stringify(a.attrs));
  const sums = b.content.map((r) => r.content.reduce((s, c) => s + (c.attrs.colwidth || []).reduce((x, y) => x + y, 0), 0));
  ok(sums.every((v) => Math.abs(v - 6029 / 15) < 1), '좁은 격자 열을 합쳐도 줄마다 칸 폭의 합이 표 폭', JSON.stringify(sums));
  const out = await m.writeDocx({ content: doc.content, settings: doc.settings, meta: {} });
  const dx = await (await JSZip.loadAsync(out)).file('word/document.xml').async('string');
  ok((dx.match(/<w:tblHeader\/>/g) || []).length === 2 && /<w:tblCellSpacing w:w="15" w:type="dxa"\/>/.test(dx), 'DOCX 로 쓰기: 제목 줄 두 줄과 셀 간격', String((dx.match(/<w:tblHeader\/>/g) || []).length));
}

// ---- 6b. 자동 문단 간격 (HTML 문단): 14pt, 표 칸의 처음·끝과 목록 항목 사이에는 두지 않는다 ----
{
  const styles =
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Web"><w:name w:val="Normal (Web)"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="100" w:beforeAutospacing="1" w:after="100" w:afterAutospacing="1"/></w:pPr></w:style>';
  const web = (s, extra = '') => p(t(s), `<w:pStyle w:val="Web"/>${extra}`);
  const li = (s) => p(t(s), '<w:pStyle w:val="Web"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  const body =
    web('웹 문단') +
    web('자동 끔', '<w:spacing w:beforeAutospacing="0" w:afterAutospacing="0"/>') +
    li('항목 1') + li('항목 2') + li('항목 3') +
    `<w:tbl><w:tblGrid><w:gridCol w:w="4000"/></w:tblGrid><w:tr><w:tc>${web('칸 처음')}${web('칸 끝')}</w:tc></w:tr></w:tbl>` +
    p('');
  const doc = await m.readDocx(await makeDocx({ body, styles }));
  const ps = doc.content.content;
  const sp = (n) => [n.attrs?.spaceBefore ?? 0, n.attrs?.spaceAfter ?? 0];
  ok(JSON.stringify(sp(ps[0])) === '[14,14]', '자동 간격은 14pt', JSON.stringify(sp(ps[0])));
  // 끄면 스타일에 적힌 값(100 twip = 5pt)으로. 앞 문단 아래 14pt 와 겹치는 위 간격은 빠진다
  ok(sp(ps[1])[1] === 5, '자동을 끄면 적힌 값', JSON.stringify(sp(ps[1])));
  const items = ps.slice(2, 5).map(sp);
  ok(items[0][1] === 0 && items[1][0] === 0 && items[1][1] === 0 && items[2][0] === 0 && items[2][1] === 14, '목록 항목 사이에는 자동 간격을 두지 않는다 (목록 끝 아래는 둔다)', JSON.stringify(items));
  const cell = ps.find((n) => n.type === 'table').content[0].content[0].content.map(sp);
  ok(cell[0][0] === 0 && cell[1][1] === 0 && cell[0][1] === 14, '표 칸의 첫 문단 위·마지막 문단 아래 자동 간격은 없다', JSON.stringify(cell));
}

// ---- 7. 구역 나누기: 새 쪽에서 시작하는 구역은 그 구역의 용지를 담은 쪽 나누기 ----
{
  const sect = (w, h, extra = '') => `<w:sectPr>${extra}<w:pgSz w:w="${w}" w:h="${h}"${w > h ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  const body =
    p(t('첫 구역')) +
    `<w:p><w:pPr>${sect(11906, 16838)}</w:pPr>${t('첫 구역 끝')}</w:p>` +
    p(t('가로 구역')) +
    `<w:p><w:pPr>${sect(16838, 11906)}</w:pPr>${t('가로 구역 끝')}</w:p>` +
    p(t('이어지는 구역'));
  // 본문 끝의 구역 설정(makeDocx 가 붙이는 편지지 세로)은 이어지는 구역으로
  const doc = await m.readDocx(await makeDocx({ body, sect: '<w:type w:val="continuous"/>' }));
  const kinds = doc.content.content.map((n) => (n.type === 'pageBreak' ? 'PB' + (n.attrs?.sectionPage?.landscape ? '(가로)' : '') : text(n)));
  ok(JSON.stringify(kinds) === JSON.stringify(['첫 구역', '첫 구역 끝', 'PB(가로)', '가로 구역', '가로 구역 끝', '이어지는 구역']), '구역 끝 문단 뒤에 다음 구역의 쪽 나누기 (이어지는 구역은 쪽을 나누지 않는다)', JSON.stringify(kinds));
  const pg = doc.settings.page;
  ok(!pg.landscape && Math.abs(pg.width - 210) < 0.5 && Math.abs(pg.height - 297) < 0.5, '문서의 용지는 첫 구역의 것 (A4 세로)', JSON.stringify(pg));
}

// ---- 8. 문단 테두리 (w:pBdr): 같은 테두리의 이웃 문단은 한 상자, 위·아래 선이 자리를 차지, 스타일 상속, 저장 후 다시 읽기 ----
{
  const box = '<w:pBdr><w:top w:val="single" w:sz="8" w:space="4" w:color="FF0000"/><w:left w:val="single" w:sz="8" w:space="4" w:color="auto"/><w:bottom w:val="double" w:sz="4" w:space="1" w:color="0000FF"/><w:right w:val="dotted" w:sz="8" w:space="4"/></w:pBdr>';
  const styles =
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Ruled"><w:name w:val="Ruled"/><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="1" w:color="00FF00"/></w:pBdr><w:spacing w:after="240"/></w:pPr></w:style>';
  const body =
    p(t('위'), `${box}<w:spacing w:before="120" w:after="60"/>`) +
    p(t('가운데'), box) +
    p(t('아래'), `${box}<w:spacing w:after="200"/>`) +
    p(t('제목'), '<w:pStyle w:val="Ruled"/>') +
    p(t('지운 선'), '<w:pStyle w:val="Ruled"/><w:pBdr><w:bottom w:val="nil"/><w:top w:val="single" w:sz="4" w:space="0" w:color="000000"/></w:pBdr>') +
    p(t('사이1'), '<w:pBdr><w:between w:val="single" w:sz="4" w:space="1" w:color="000000"/><w:left w:val="single" w:sz="4" w:space="4" w:color="000000"/></w:pBdr>') +
    p(t('사이2'), '<w:pBdr><w:between w:val="single" w:sz="4" w:space="1" w:color="000000"/><w:left w:val="single" w:sz="4" w:space="4" w:color="000000"/></w:pBdr>') +
    p(t('내어쓰기'), '<w:ind w:left="720" w:hanging="360"/><w:pBdr><w:left w:val="single" w:sz="8" w:space="4" w:color="000000"/></w:pBdr>');
  const doc = await m.readDocx(await makeDocx({ body, styles }));
  const ps = doc.content.content;
  const pb = (i) => ps[i].attrs?.paraBorder;
  const [a, b, c] = [pb(0), pb(1), pb(2)];
  ok(a && b && c && a.c && a.c === b.c && b.c === c.c, '같은 테두리의 이웃 문단은 한 상자 (이음 표시)', JSON.stringify([a, b, c]));
  ok(a.t === '0.353mm solid #FF0000' && a.l === '0.353mm solid #000000' && a.r === '0.353mm dotted #000000', '선 굵기(1/8 pt → mm)·종류·색 (auto·없음은 검정)', JSON.stringify(a));
  // 이중선: 그려지는 굵기 = 선 둘 + 틈 = 0.5pt × 3 = 1.5pt → 2.4 로 나눈 값
  ok(c.b === '0.22mm double #0000FF', '이중선은 그려지는 굵기(선 둘과 틈)', c.b);
  // 위 간격: 6pt + 선 1pt + 간격 4pt, 아래 간격: 10pt + 이중선 1.5pt + 간격 1pt. 가운데 문단은 그대로
  ok(ps[0].attrs.spaceBefore === 11 && ps[2].attrs.spaceAfter === 12.5 && !ps[1].attrs.spaceBefore && !ps[1].attrs.spaceAfter, '위 선은 첫 문단 위, 아래 선은 끝 문단 아래에 자리를 차지 (문단 간격은 상자 바깥)', JSON.stringify([ps[0].attrs.spaceBefore, ps[1].attrs, ps[2].attrs.spaceAfter]));
  ok(JSON.stringify(a.a) === JSON.stringify([6.67, 0]) && JSON.stringify(c.a) === JSON.stringify([0, 3.33]) && JSON.stringify(a.sp) === JSON.stringify([4, 4, 4, 1]), '선이 차지하는 자리(px)와 Word 의 간격(pt)', JSON.stringify([a.a, c.a, a.sp]));
  // 왼쪽 선은 글 바깥으로 간격 + 굵기 (4pt + 1pt = 6.67px)
  ok(a.o[0] === 6.67 && a.o[1] === 6.67, '왼쪽·오른쪽 선은 글 바깥으로 간격 + 굵기만큼', JSON.stringify(a.o));
  ok(pb(3)?.b === '0.529mm solid #00FF00' && !pb(3).t && ps[3].attrs.spaceAfter === 14.5, '스타일의 테두리 (아래 선 1.5pt + 간격 1pt 가 아래 간격 12pt 에 더해진다)', JSON.stringify([pb(3), ps[3].attrs.spaceAfter]));
  ok(pb(4)?.t && !pb(4).b && pb(3).a[1] > 0 && pb(4).a[0] > 0, '문단에서 nil 로 지운 변과 더한 변 (다른 테두리라 다른 상자: 저마다 선 자리를 차지)', JSON.stringify(pb(4)));
  ok(pb(5)?.b && !pb(5).c && !pb(6)?.b && pb(5).a[1] === -1 && pb(6).a[0] === -1, '사이 선: 앞 문단 상자의 아래에 (상자끼리 이어 붙는다)', JSON.stringify([pb(5), pb(6)]));
  ok(pb(4).c === undefined && pb(3).c === undefined, '한 문단뿐인 테두리는 잇지 않는다', '');
  // 내어쓰기: 왼쪽 선은 첫 줄(가장 왼쪽 글) 바깥 → 내어쓰기 18pt + 4pt + 1pt = 23pt
  ok(Math.abs(pb(7).o[0] - 30.67) < 0.01, '내어쓰기 문단의 왼쪽 선은 첫 줄 바깥', JSON.stringify(pb(7)));

  // 저장: 같은 테두리를 문단마다 적고, 읽을 때 더한 간격은 뺀다 → 다시 읽으면 같다
  const out = await m.writeDocx({ content: doc.content, settings: doc.settings, meta: {} });
  const dx = await (await JSZip.loadAsync(out)).file('word/document.xml').async('string');
  ok(/<w:pBdr><w:top w:val="single" w:sz="8" w:space="4" w:color="FF0000"\/><w:left w:val="single" w:sz="8" w:space="4" w:color="000000"\/><w:bottom w:val="double" w:sz="4" w:space="1" w:color="0000FF"\/><w:right w:val="dotted" w:sz="8" w:space="4" w:color="000000"\/><\/w:pBdr>/.test(dx), '저장: w:pBdr (선 종류·굵기·간격·색)', dx.slice(dx.indexOf('<w:pBdr>'), dx.indexOf('<w:pBdr>') + 360));
  ok(/<w:spacing w:before="120" w:after="60"/.test(dx), '저장: 읽을 때 더한 테두리 자리는 문단 간격에서 뺀다', '');
  const back = await m.readDocx(out);
  const bp = back.content.content;
  const same = [0, 1, 2, 3].every((i) => JSON.stringify(bp[i].attrs.paraBorder) === JSON.stringify(ps[i].attrs.paraBorder) && bp[i].attrs.spaceBefore === ps[i].attrs.spaceBefore && bp[i].attrs.spaceAfter === ps[i].attrs.spaceAfter);
  ok(same, '저장 후 다시 읽으면 테두리·간격이 같다', JSON.stringify([bp[0].attrs, ps[0].attrs]));
}

console.log(failed ? `실패 ${failed}건` : '모두 통과');
process.exit(failed ? 1 : 0);
