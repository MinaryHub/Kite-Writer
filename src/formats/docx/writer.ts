import JSZip from 'jszip';
import type { Columns, KDocument } from '../../types';
import { type JNode, mmToTwip, xmlEscape, parseBorderCss, normColor, safeIsoDate, cleanColumns } from '../common';
import { type CharStyle, type FlatBlock, type FlatInline, type FlatPara, type FlatTable, type ParaStyle, flattenDoc } from '../flatten';
import { prepareImage } from '../imageUtil';

/** DOCX 쓰기 (Word 2010 이상 호환) */

const W_NS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** 색 값을 RRGGBB 로 (색이 아니면 auto) */
const hex = (c: string) => {
  const n = normColor(c);
  return n ? n.slice(1) : 'auto';
};

class Ctx {
  rels: { id: string; type: string; target: string; external?: boolean }[] = [];
  relNo = 10;
  images = new Map<string, { rid: string; w: number; h: number; name: string } | null>();
  media: { path: string; bytes: Uint8Array; ext: string }[] = [];
  footnotes: string[] = [];
  docPrId = 1;
  bodyWidthTw = 9000;
  /** 변경 내용(w:ins/w:del) 번호 */
  changeNo = 1;
  /** 메모 id → Word 메모 번호 */
  commentNo = new Map<string, number>();
  /** 메모가 시작된 것 */
  commentOpen = new Set<string>();
  /** 메모마다 마지막으로 달린 글자 (그 뒤에서 범위를 닫는다) */
  commentLast = new Map<string, FlatInline>();

  addRel(type: string, target: string, external = false): string {
    const id = `rId${++this.relNo}`;
    this.rels.push({ id, type, target, external });
    return id;
  }
}

function rPr(c: CharStyle, extra = ''): string {
  let x = '<w:rPr>' + extra;
  x += `<w:rFonts w:ascii="${xmlEscape(c.font)}" w:hAnsi="${xmlEscape(c.font)}" w:eastAsia="${xmlEscape(c.font)}" w:cs="${xmlEscape(c.font)}"/>`;
  if (c.bold) x += '<w:b/><w:bCs/>';
  if (c.italic) x += '<w:i/><w:iCs/>';
  if (c.strike) x += '<w:strike/>';
  if (c.effect === 'outline') x += '<w:outline/>';
  if (c.effect === 'shadow') x += '<w:shadow/>';
  if (c.effect === 'emboss') x += '<w:emboss/>';
  if (c.effect === 'engrave') x += '<w:imprint/>';
  if (c.color && c.color !== '#000000') x += `<w:color w:val="${hex(c.color)}"/>`;
  // Word 의 자간 범위(±1584pt)를 넘지 않게
  if (c.letterSpacing) x += `<w:spacing w:val="${Math.max(-31680, Math.min(31680, Math.round(((c.size * c.letterSpacing) / 100) * 20)))}"/>`;
  if (c.fontWidth && c.fontWidth !== 100) x += `<w:w w:val="${Math.round(c.fontWidth)}"/>`;
  x += `<w:sz w:val="${Math.round(c.size * 2)}"/><w:szCs w:val="${Math.round(c.size * 2)}"/>`;
  if (c.underline) x += '<w:u w:val="single"/>';
  if (c.highlight) x += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.highlight)}"/>`;
  if (c.sup) x += '<w:vertAlign w:val="superscript"/>';
  else if (c.sub) x += '<w:vertAlign w:val="subscript"/>';
  return x + '</w:rPr>';
}

function pPr(p: ParaStyle, pageBreak: boolean, markChar?: CharStyle): string {
  let x = '<w:pPr>';
  if (p.heading) x += `<w:pStyle w:val="Heading${p.heading}"/>`;
  if (pageBreak) x += '<w:pageBreakBefore/>';
  if (p.borderBottom) x += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="000000"/></w:pBdr>';
  if (p.bg) x += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(p.bg)}"/>`;
  let line = '';
  if (/pt$/.test(p.lineHeight)) line = ` w:line="${Math.round(parseFloat(p.lineHeight) * 20)}" w:lineRule="exact"`;
  else line = ` w:line="${Math.round(((parseFloat(p.lineHeight) || 1.6) / 1.2) * 240)}" w:lineRule="auto"`;
  x += `<w:spacing w:before="${Math.round(p.spaceBefore * 20)}" w:after="${Math.round(p.spaceAfter * 20)}"${line}/>`;
  // 한글식 여백 → 워드식 (내어쓰기: left = 왼쪽 + 내어쓰기 폭, hanging = 폭)
  const left = Math.round(p.indentLeft * 20);
  const right = Math.round(p.indentRight * 20);
  const ti = Math.round(p.textIndent * 20);
  if (left || right || ti) {
    if (ti < 0) x += `<w:ind w:left="${left - ti}" w:right="${right}" w:hanging="${-ti}"/>`;
    else x += `<w:ind w:left="${left}" w:right="${right}" w:firstLine="${ti}"/>`;
  }
  const jc = { left: 'left', right: 'right', center: 'center', justify: 'both', distribute: 'distribute' }[p.align] || 'both';
  x += `<w:jc w:val="${jc}"/>`;
  if (markChar) x += rPr(markChar);
  return x + '</w:pPr>';
}

function textRuns(text: string, c: CharStyle, deleted = false): string {
  const parts = text.split('\t');
  let inner = '';
  const tag = deleted ? 'w:delText' : 'w:t';
  parts.forEach((part, i) => {
    if (i) inner += '<w:tab/>';
    if (part) inner += `<${tag} xml:space="preserve">${xmlEscape(part)}</${tag}>`;
  });
  return `<w:r>${rPr(c)}${inner}</w:r>`;
}

const isoTime = (t: number) => (t > 0 ? new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') : new Date().toISOString().replace(/\.\d+Z$/, 'Z'));

/** 글자 조각: 변경 내용이면 w:ins / w:del 로 감싼다 */
function reviewedRun(ctx: Ctx, it: Extract<FlatInline, { type: 'text' }>): string {
  const ch = it.review?.change;
  if (!ch) return textRuns(it.text, it.style);
  const tag = ch.type === 'ins' ? 'w:ins' : 'w:del';
  return `<${tag} w:id="${ctx.changeNo++}" w:author="${xmlEscape(ch.author || 'Kite')}" w:date="${isoTime(ch.time)}">${textRuns(it.text, it.style, ch.type === 'del')}</${tag}>`;
}

/** 메모 범위 시작/끝 (메모는 여러 문단에 걸칠 수 있다) */
function commentStarts(ctx: Ctx, it: FlatInline): string {
  let x = '';
  for (const id of (it.type === 'text' && it.review?.comments) || []) {
    const n = ctx.commentNo.get(id);
    if (n == null || ctx.commentOpen.has(id)) continue;
    ctx.commentOpen.add(id);
    x += `<w:commentRangeStart w:id="${n}"/>`;
  }
  return x;
}
function commentEnds(ctx: Ctx, it: FlatInline): string {
  let x = '';
  for (const id of (it.type === 'text' && it.review?.comments) || []) {
    const n = ctx.commentNo.get(id);
    if (n == null || ctx.commentLast.get(id) !== it) continue;
    x += `<w:commentRangeEnd w:id="${n}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${n}"/></w:r>`;
  }
  return x;
}

/** 메모가 달린 글자들을 훑어 번호와 마지막 글자를 정한다 */
function collectComments(ctx: Ctx, blocks: FlatBlock[], known: Record<string, unknown>) {
  for (const b of blocks) {
    if (b.kind === 'para') {
      for (const i of b.inlines)
        if (i.type === 'text')
          for (const id of i.review?.comments || []) {
            if (!known[id]) continue;
            if (!ctx.commentNo.has(id)) ctx.commentNo.set(id, ctx.commentNo.size);
            ctx.commentLast.set(id, i);
          }
    } else if (b.kind === 'box') collectComments(ctx, b.blocks, known);
    else for (const row of b.cells) for (const c of row) collectComments(ctx, c.blocks, known);
  }
}

function drawing(ctx: Ctx, info: { rid: string; w: number; h: number; name: string }, wPx: number | null, hPx: number | null, crop: { t: number; r: number; b: number; l: number } | null = null): string {
  let w = wPx || info.w;
  let h = hPx || (wPx ? Math.round((wPx * info.h) / Math.max(1, info.w)) : info.h);
  const maxPx = ctx.bodyWidthTw / 15;
  if (w > maxPx) {
    h = Math.round((h * maxPx) / w);
    w = maxPx;
  }
  const cx = Math.round(w * 9525);
  const cy = Math.round(h * 9525);
  const id = ctx.docPrId++;
  return (
    `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>` +
    `<wp:docPr id="${id}" name="그림 ${id}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>` +
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${info.name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${info.rid}"/>${crop ? `<a:srcRect l="${Math.round(crop.l * 100000)}" t="${Math.round(crop.t * 100000)}" r="${Math.round(crop.r * 100000)}" b="${Math.round(crop.b * 100000)}"/>` : ''}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`
  );
}

function paragraphXml(ctx: Ctx, p: FlatPara): string {
  let x = '<w:p>' + pPr(p.style, p.pageBreakBefore, p.inlines.length ? undefined : p.baseChar);
  // 단 나누기
  if (p.columnBreakBefore) x += '<w:r><w:br w:type="column"/></w:r>';
  let linkOpen: string | null = null;
  const closeLink = () => {
    if (linkOpen) {
      x += '</w:hyperlink>';
      linkOpen = null;
    }
  };
  for (const it of p.inlines) {
    const link = it.type === 'text' ? it.link : null;
    if (link !== linkOpen) {
      closeLink();
      if (link) {
        const rid = ctx.addRel('hyperlink', link, true);
        x += `<w:hyperlink r:id="${rid}" w:history="1">`;
        linkOpen = link;
      }
    }
    if (it.type === 'text') x += commentStarts(ctx, it) + reviewedRun(ctx, it) + commentEnds(ctx, it);
    else if (it.type === 'break') x += '<w:r><w:br/></w:r>';
    else if (it.type === 'image') {
      const info = ctx.images.get(it.src);
      if (info) x += `<w:r>${rPr(it.style)}${drawing(ctx, info, it.width, it.height, it.crop)}</w:r>`;
    } else if (it.type === 'footnote') {
      ctx.footnotes.push(it.text);
      const id = ctx.footnotes.length + 1;
      x += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
    }
  }
  closeLink();
  return x + '</w:p>';
}

function tableXml(ctx: Ctx, t: FlatTable): string {
  const totalPx = t.colWidthsPx.reduce((a, b) => a + b, 0) || 1;
  const scale = Math.min(1, ctx.bodyWidthTw / (totalPx * 15));
  const colTw = t.colWidthsPx.map((w) => Math.max(100, Math.round(w * 15 * scale)));
  const totalTw = colTw.reduce((a, b) => a + b, 0);
  let x = `<w:tbl><w:tblPr><w:tblW w:w="${totalTw}" w:type="dxa"/>${t.align !== 'left' ? `<w:jc w:val="${t.align}"/>` : ''}`;
  x += '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('') + '</w:tblBorders>';
  x += `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="28" w:type="dxa"/><w:left w:w="${Math.round(t.cellPadPx * 15)}" w:type="dxa"/><w:bottom w:w="28" w:type="dxa"/><w:right w:w="${Math.round(t.cellPadPx * 15)}" w:type="dxa"/></w:tblCellMar>`;
  x += '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="0"/></w:tblPr>';
  x += '<w:tblGrid>' + colTw.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>';
  // 세로 병합: 각 줄에 이어지는 셀 자리 표시
  const cont: { row: number; col: number; cell: (typeof t.cells)[0][0] }[] = [];
  for (const row of t.cells) for (const c of row) for (let r = 1; r < c.rowspan; r++) cont.push({ row: c.row + r, col: c.col, cell: c });
  t.cells.forEach((row, ri) => {
    const entries: { col: number; xml: string }[] = [];
    const tcPr = (c: (typeof t.cells)[0][0], merge: string) => {
      const w = colTw.slice(c.col, c.col + c.colspan).reduce((a, b) => a + b, 0);
      let p = `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/>`;
      if (c.colspan > 1) p += `<w:gridSpan w:val="${c.colspan}"/>`;
      if (merge) p += merge;
      const det = parseBorderCss(c.borderCss);
      if (c.noBorders.length || Object.keys(det).length) {
        const map: Record<string, string> = { t: 'top', l: 'left', b: 'bottom', r: 'right' };
        const VAL: Record<string, string> = { solid: 'single', dashed: 'dashed', dotted: 'dotted', double: 'double' };
        p +=
          '<w:tcBorders>' +
          ['t', 'l', 'b', 'r']
            .map((s) => {
              if (c.noBorders.includes(s)) return `<w:${map[s]} w:val="nil"/>`;
              const d = det[s as 'l'];
              return d ? `<w:${map[s]} w:val="${VAL[d.s]}" w:sz="${Math.max(2, Math.round((d.w / 0.3528) * 8))}" w:space="0" w:color="${hex(d.c)}"/>` : '';
            })
            .join('') +
          '</w:tcBorders>';
      }
      if (c.bg) p += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.bg)}"/>`;
      p += `<w:vAlign w:val="${c.vAlign === 'middle' ? 'center' : c.vAlign}"/>`;
      return p + '</w:tcPr>';
    };
    for (const c of row) {
      let inner = c.blocks.map((b) => blockXml(ctx, b)).join('');
      if (!c.blocks.length || c.blocks[c.blocks.length - 1].kind === 'table') inner += '<w:p/>';
      entries.push({ col: c.col, xml: `<w:tc>${tcPr(c, c.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : '')}${inner}</w:tc>` });
    }
    for (const k of cont.filter((x) => x.row === ri)) entries.push({ col: k.col, xml: `<w:tc>${tcPr(k.cell, '<w:vMerge/>')}<w:p/></w:tc>` });
    entries.sort((a, b) => a.col - b.col);
    const rh = t.rowHeightsPx?.[ri];
    const trPr = (ri === 0 && row.some((c) => c.header) ? '<w:tblHeader/>' : '') + (rh ? `<w:trHeight w:val="${Math.round(rh * 15)}" w:hRule="atLeast"/>` : '');
    x += '<w:tr>' + (trPr ? `<w:trPr>${trPr}</w:trPr>` : '') + entries.map((e) => e.xml).join('') + '</w:tr>';
  });
  x += '</w:tbl>';
  if (t.pageBreakBefore) x = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + x;
  else if (t.columnBreakBefore) x = '<w:p><w:r><w:br w:type="column"/></w:r></w:p>' + x;
  return x;
}

function blockXml(ctx: Ctx, b: FlatBlock): string {
  if (b.kind === 'box') return b.blocks.map((x) => blockXml(ctx, x)).join('');
  return b.kind === 'para' ? paragraphXml(ctx, b) : tableXml(ctx, b);
}

function collectImages(blocks: FlatBlock[], out: Set<string>) {
  for (const b of blocks) {
    if (b.kind === 'para') {
      for (const i of b.inlines) if (i.type === 'image' && i.src) out.add(i.src);
    } else if (b.kind === 'box') collectImages(b.blocks, out);
    else for (const row of b.cells) for (const c of row) collectImages(c.blocks, out);
  }
}

function hfXml(tag: 'hdr' | 'ftr', paras: string[]): string {
  return DECL + `<w:${tag} ${W_NS}>${paras.join('') || '<w:p/>'}</w:${tag}>`;
}

function hfParagraph(text: string, align: string, pageFmt: string): string {
  const jc = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
  const rp = '<w:rPr><w:sz w:val="18"/></w:rPr>';
  let runs = '';
  for (const part of text.split(/(\{\{PAGE\}\}|\{\{PAGES\}\})/)) {
    if (part === '{{PAGE}}' || part === '{{PAGES}}') {
      const instr = part === '{{PAGE}}' ? `PAGE${pageFmt}` : 'NUMPAGES';
      runs += `<w:r>${rp}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rp}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r>${rp}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rp}<w:t>1</w:t></w:r><w:r>${rp}<w:fldChar w:fldCharType="end"/></w:r>`;
    } else if (part) runs += `<w:r>${rp}<w:t xml:space="preserve">${xmlEscape(part)}</w:t></w:r>`;
  }
  return `<w:p><w:pPr><w:jc w:val="${jc}"/></w:pPr>${runs}</w:p>`;
}

function stylesXml(): string {
  const heading = (n: number, size: number) =>
    `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size * 2}"/></w:rPr></w:style>`;
  return (
    DECL +
    `<w:styles ${W_NS}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="함초롬바탕" w:hAnsi="함초롬바탕" w:eastAsia="함초롬바탕" w:cs="함초롬바탕"/><w:sz w:val="20"/><w:szCs w:val="20"/><w:lang w:val="en-US" w:eastAsia="ko-KR" w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
    `<w:pPrDefault><w:pPr><w:spacing w:after="0" w:line="320" w:lineRule="auto"/><w:jc w:val="both"/></w:pPr></w:pPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/><w:pPr><w:widowControl w:val="0"/><w:wordWrap w:val="0"/><w:autoSpaceDE w:val="0"/><w:autoSpaceDN w:val="0"/></w:pPr></w:style>` +
    [20, 16, 14, 12, 11, 10].map((s, i) => heading(i + 1, s)).join('') +
    `<w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont"><w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/><w:semiHidden/></w:style>` +
    `<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `</w:styles>`
  );
}

export async function writeDocx(doc: KDocument): Promise<Uint8Array> {
  const blocks = flattenDoc(doc.content as JNode);
  const ctx = new Ctx();
  const s = doc.settings;
  const pg = s.page;
  const pageW = pg.landscape ? Math.max(pg.width, pg.height) : pg.width;
  const pageH = pg.landscape ? Math.min(pg.width, pg.height) : pg.height;
  ctx.bodyWidthTw = mmToTwip(pageW - pg.marginLeft - pg.marginRight - pg.gutter);

  const srcs = new Set<string>();
  collectImages(blocks, srcs);
  let n = 0;
  for (const src of srcs) {
    const img = await prepareImage(src);
    if (!img) {
      ctx.images.set(src, null);
      continue;
    }
    n++;
    const name = `image${n}.${img.ext}`;
    ctx.media.push({ path: `word/media/${name}`, bytes: img.bytes, ext: img.ext });
    const rid = ctx.addRel('image', `media/${name}`);
    ctx.images.set(src, { rid, w: img.width, h: img.height, name });
  }

  const commentData = s.comments || {};
  collectComments(ctx, blocks, commentData);
  const body = blocks.map((b) => blockXml(ctx, b)).join('');

  // 머리말/꼬리말
  const pfmt = s.pageNumber.format === 'roman' ? ' \\* roman' : s.pageNumber.format === 'ROMAN' ? ' \\* ROMAN' : '';
  const pageText = s.pageNumber.format === 'dash' ? '- {{PAGE}} -' : s.pageNumber.format === 'paren' ? '({{PAGE}})' : '{{PAGE}}';
  const hdrParas: string[] = [];
  const ftrParas: string[] = [];
  if (s.header.text.trim()) hdrParas.push(hfParagraph(s.header.text, s.header.align, pfmt));
  if (s.footer.text.trim()) ftrParas.push(hfParagraph(s.footer.text, s.footer.align, pfmt));
  if (s.pageNumber.pos !== 'none') {
    const [vpos, hpos] = s.pageNumber.pos.split('-');
    (vpos === 'top' ? hdrParas : ftrParas).push(hfParagraph(pageText, hpos, pfmt));
  }
  let sectRefs = '';
  const files: [string, string][] = [];
  if (hdrParas.length) {
    files.push(['word/header1.xml', hfXml('hdr', hdrParas)]);
    sectRefs += `<w:headerReference w:type="default" r:id="${ctx.addRel('header', 'header1.xml')}"/>`;
  }
  if (ftrParas.length) {
    files.push(['word/footer1.xml', hfXml('ftr', ftrParas)]);
    sectRefs += `<w:footerReference w:type="default" r:id="${ctx.addRel('footer', 'footer1.xml')}"/>`;
  }
  const top = mmToTwip(pg.marginTop + pg.marginHeader);
  const bottom = mmToTwip(pg.marginBottom + pg.marginFooter);
  const sectPr =
    `<w:sectPr>${sectRefs}<w:pgSz w:w="${mmToTwip(pageW)}" w:h="${mmToTwip(pageH)}"${pg.landscape ? ' w:orient="landscape"' : ''}/>` +
    `<w:pgMar w:top="${top}" w:right="${mmToTwip(pg.marginRight)}" w:bottom="${bottom}" w:left="${mmToTwip(pg.marginLeft)}" w:header="${mmToTwip(pg.marginTop)}" w:footer="${mmToTwip(pg.marginBottom)}" w:gutter="${mmToTwip(pg.gutter)}"/>` +
    (s.pageNumber.start !== 1 ? `<w:pgNumType w:start="${s.pageNumber.start}"/>` : '') +
    `${colsXml(pg.columns)}<w:docGrid w:linePitch="360"/></w:sectPr>`;

  const documentXml = DECL + `<w:document ${W_NS}><w:body>${body}${sectPr}</w:body></w:document>`;

  const hasFootnotes = ctx.footnotes.length > 0;
  if (hasFootnotes) {
    const sep = (type: string, id: number, tag: string) =>
      `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${tag}/></w:r></w:p></w:footnote>`;
    const notes = ctx.footnotes
      .map(
        (t, i) =>
          `<w:footnote w:id="${i + 2}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${xmlEscape(t)}</w:t></w:r></w:p></w:footnote>`,
      )
      .join('');
    files.push(['word/footnotes.xml', DECL + `<w:footnotes ${W_NS}>${sep('separator', 0, 'separator')}${sep('continuationSeparator', 1, 'continuationSeparator')}${notes}</w:footnotes>`]);
    ctx.addRel('footnotes', 'footnotes.xml');
  }
  // 메모 (답글은 같은 메모 안의 문단으로)
  const hasComments = ctx.commentNo.size > 0;
  if (hasComments) {
    const para = (t: string, first: boolean, n: number) =>
      `<w:p><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${first ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : ''}<w:r><w:t xml:space="preserve">${xmlEscape(t)}</w:t></w:r></w:p>`;
    const items = [...ctx.commentNo.entries()]
      .map(([id, n]) => {
        const c = commentData[id];
        const body = [para((c.resolved ? '[해결됨] ' : '') + c.text, true, n), ...(c.replies || []).map((r) => para(`↳ ${r.author}: ${r.text}`, false, n))].join('');
        const initials = (c.author || 'K').slice(0, 2);
        return `<w:comment w:id="${n}" w:author="${xmlEscape(c.author || 'Kite')}" w:date="${isoTime(c.time)}" w:initials="${xmlEscape(initials)}">${body}</w:comment>`;
      })
      .join('');
    files.push(['word/comments.xml', DECL + `<w:comments ${W_NS}>${items}</w:comments>`]);
    ctx.addRel('comments', 'comments.xml');
  }
  ctx.addRel('styles', 'styles.xml');
  ctx.addRel('settings', 'settings.xml');

  const settingsXml =
    DECL +
    `<w:settings ${W_NS}><w:zoom w:percent="100"/><w:defaultTabStop w:val="800"/><w:characterSpacingControl w:val="doNotCompress"/>` +
    (hasFootnotes ? '<w:footnotePr><w:footnote w:id="0"/><w:footnote w:id="1"/></w:footnotePr>' : '') +
    `<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

  const relTypeUri = (t: string) =>
    ({
      image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
      hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
      header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
      footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
      footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
      comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
      styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
      settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
    })[t] || t;
  const docRels =
    DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    ctx.rels.map((r) => `<Relationship Id="${r.id}" Type="${relTypeUri(r.type)}" Target="${xmlEscape(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
    `</Relationships>`;

  const exts = new Set(ctx.media.map((m) => m.ext));
  const mimeOf = (e: string) => ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' })[e] || 'image/png';
  const contentTypes =
    DECL +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>` +
    [...exts].map((e) => `<Default Extension="${e}" ContentType="${mimeOf(e)}"/>`).join('') +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>` +
    (hasFootnotes ? `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>` : '') +
    (hasComments ? `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>` : '') +
    (hdrParas.length ? `<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>` : '') +
    (ftrParas.length ? `<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>` : '') +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core =
    DECL +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${xmlEscape(doc.meta.title || '')}</dc:title><dc:subject>${xmlEscape(doc.meta.subject || '')}</dc:subject><dc:creator>${xmlEscape(doc.meta.author || '')}</dc:creator><cp:keywords>${xmlEscape(doc.meta.keywords || '')}</cp:keywords>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${safeIsoDate(doc.meta.created, now)}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;

  const zip = new JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file(
    '_rels/.rels',
    DECL +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  );
  zip.file('docProps/core.xml', core);
  zip.file('docProps/app.xml', DECL + `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Kite</Application></Properties>`);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml());
  zip.file('word/settings.xml', settingsXml);
  zip.file('word/_rels/document.xml.rels', docRels);
  for (const [p, x] of files) zip.file(p, x);
  for (const m of ctx.media) zip.file(m.path, m.bytes);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
}

/** 구역의 다단 (w:cols): 단 수·간격·구분선, 너비가 다른 단은 단마다 너비와 간격 */
function colsXml(c: Columns | null | undefined): string {
  const v = cleanColumns(c);
  if (!v || v.count < 2) return '<w:cols w:space="425"/>';
  const sep = v.line ? ' w:sep="1"' : '';
  if (v.widths && v.gaps) {
    const each = v.widths.map((w, i) => `<w:col w:w="${mmToTwip(w)}" w:space="${i < v.count - 1 ? mmToTwip(v.gaps![i]) : 0}"/>`).join('');
    return `<w:cols w:num="${v.count}"${sep} w:space="${mmToTwip(v.gaps[0] || 0)}" w:equalWidth="0">${each}</w:cols>`;
  }
  return `<w:cols w:num="${v.count}"${sep} w:space="${mmToTwip(v.gap)}"/>`;
}
