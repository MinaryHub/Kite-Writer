import JSZip from 'jszip';
import type { Columns, DocSettings, HeaderFooter, KDocument, LineNumbering, PageBorder, PageSetup, SectionHf } from '../../types';
import { type JNode, type ParaBorder, mmToTwip, xmlEscape, parseBorderCss, normColor, safeIsoDate, cleanColumns } from '../common';
import { type CharStyle, type FlatBlock, type FlatBox, type FlatFloat, type FlatInline, type FlatPara, type FlatTable, type ParaStyle, flattenContent, flattenDoc } from '../flatten';
import { prepareImage } from '../imageUtil';
import { pathOf, type ShapeItem } from '../shape';
import { naturalLineRatio } from '../fontMetrics';

/** DOCX 쓰기 (Word 2010 이상 호환) */

const W_NS =
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:w10="urn:schemas-microsoft-com:office:word" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"';
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
  endnotes: string[] = [];
  /** 책갈피 번호 (w:bookmarkStart·End 의 id) */
  bookmarkSeq = 0;
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
  /** 다음 문단에 매달 떠 있는 글상자들 (글상자는 뒤 문단 기준 자리) */
  anchors: string[] = [];
  /** 떠 있는 개체의 겹침 차례 */
  relHeight = 251658240;

  addRel(type: string, target: string, external = false): string {
    const id = `rId${++this.relNo}`;
    this.rels.push({ id, type, target, external });
    return id;
  }
}

function rPr(c: CharStyle, extra = ''): string {
  let x = '<w:rPr>' + extra;
  // 한글 글꼴이 따로 있으면(Word 문서에서 온 글자) 영문 글꼴과 한글 글꼴을 따로 적는다
  x += `<w:rFonts w:ascii="${xmlEscape(c.font)}" w:hAnsi="${xmlEscape(c.font)}" w:eastAsia="${xmlEscape(c.eaFont || c.font)}" w:cs="${xmlEscape(c.font)}"/>`;
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

/** font: 이 문단의 글꼴 — Word 의 줄 간격 배수는 글꼴의 고유 줄 높이에 대한 것이라, 글자 크기 기준인 Kite 의 줄 간격을 그 비율로 나눠 적는다 */
function pPr(p: ParaStyle, pageBreak: boolean, markChar?: CharStyle, font?: string): string {
  let x = '<w:pPr>';
  if (p.heading) x += `<w:pStyle w:val="Heading${p.heading}"/>`;
  // 쪽 나눔 규칙 (기본 스타일은 외톨이줄 방지를 꺼 둔다: 켠 문단만 적는다)
  if (p.keep?.includes('n')) x += '<w:keepNext/>';
  else if (p.heading) x += '<w:keepNext w:val="0"/>';
  if (p.keep?.includes('l')) x += '<w:keepLines/>';
  if (pageBreak) x += '<w:pageBreakBefore/>';
  if (p.keep?.includes('w')) x += '<w:widowControl/>';
  if (p.border) x += pBdrXml(p.border);
  else if (p.borderBottom) x += '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="000000"/></w:pBdr>';
  if (p.bg) x += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(p.bg)}"/>`;
  if (p.tabs?.s?.length) {
    const al = { l: 'left', c: 'center', r: 'right', d: 'decimal' } as const;
    x += '<w:tabs>' + p.tabs.s.map((t) => `<w:tab w:val="${al[t[1]]}"${leaderAttr(t[2])} w:pos="${Math.round(t[0] * 20)}"/>`).join('') + '</w:tabs>';
  }
  let line = '';
  if (/pt$/.test(p.lineHeight)) line = ` w:line="${Math.round(parseFloat(p.lineHeight) * 20)}" w:lineRule="exact"`;
  // 빈 문단(문단 부호만 있다): 높이를 글꼴과 상관없이 Kite 가 그리는 값(줄 간격 × 글자 크기) 그대로 고정한다.
  // 배수로 적으면 그 컴퓨터에 없는 글꼴이 다른 글꼴로 바뀔 때 빈 줄 높이가 달라진다
  else if (markChar) line = ` w:line="${Math.round((parseFloat(p.lineHeight) || 1.6) * markChar.size * 20)}" w:lineRule="exact"`;
  else line = ` w:line="${Math.round(((parseFloat(p.lineHeight) || 1.6) / naturalLineRatio(font)) * 240)}" w:lineRule="auto"`;
  // Word 에서 온 테두리: 위·아래 선이 차지하던 자리(읽을 때 문단 간격에 더한 것)는 Word 가 다시 더하므로 뺀다
  let before = p.spaceBefore;
  let after = p.spaceAfter;
  const room = p.border?.a;
  if (room && room[0] > 0 && p.border?.t) before = Math.max(0, before - room[0] * 0.75);
  if (room && room[1] > 0 && p.border?.b) after = Math.max(0, after - room[1] * 0.75);
  x += `<w:spacing w:before="${Math.round(before * 20)}" w:after="${Math.round(after * 20)}"${line}/>`;
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
  // 제목 스타일이 아닌 문단의 개요 수준 (Word 문서에서 온 제목 문단 등: 차례에 들어간다)
  if (!p.heading && p.outline) x += `<w:outlineLvl w:val="${Math.max(0, Math.min(8, p.outline - 1))}"/>`;
  if (markChar) x += rPr(markChar);
  return x + '</w:pPr>';
}

/**
 * 문단 테두리 → w:pBdr. Word 에서 온 테두리는 그 간격(sp) 그대로, 한글 문서의 것은 글과의 간격(o)을 간격으로 적는다.
 * 같은 테두리를 적은 이웃 문단은 Word 가 한 상자로 묶는다
 */
function pBdrXml(pb: ParaBorder): string {
  const VAL = { solid: 'single', dashed: 'dashed', dotted: 'dotted', double: 'double' } as const;
  const PT_MM = 25.4 / 72;
  let x = '';
  for (const [k, tag, i] of [['t', 'top', 2], ['l', 'left', 0], ['b', 'bottom', 3], ['r', 'right', 1]] as const) {
    const m = pb[k] ? /^([\d.]+)mm (solid|dashed|dotted|double) #([0-9A-Fa-f]{6})$/.exec(pb[k]!) : null;
    if (!m) continue;
    const mm = parseFloat(m[1]);
    // 굵기(1/8 pt): 이중선은 그려지는 굵기(값 × 2.4)를 선 둘과 사이 틈으로 셋으로 나눈 것
    const pt = m[2] === 'double' ? (mm * 2.4) / PT_MM / 3 : mm / PT_MM;
    const sz = Math.max(2, Math.min(96, Math.round(pt * 8)));
    const space = pb.sp ? pb.sp[i] : (pb.o?.[i] || 0) * 0.75;
    x += `<w:${tag} w:val="${VAL[m[2] as keyof typeof VAL]}" w:sz="${sz}" w:space="${Math.max(0, Math.min(31, Math.round(space)))}" w:color="${m[3].toUpperCase()}"/>`;
  }
  return x ? `<w:pBdr>${x}</w:pBdr>` : '';
}

/** 탭 채움 값 → Word 의 leader 속성 (없으면 빈 글) */
function leaderAttr(leader: number): string {
  const v = leader === 1 || leader === 7 ? 'underscore' : leader === 2 || leader === 4 || leader === 5 ? 'hyphen' : leader === 3 ? 'dot' : leader === 6 ? 'middleDot' : '';
  return v ? ` w:leader="${v}"` : '';
}

function textRuns(text: string, c: CharStyle, deleted = false, ptab?: { ptab?: 'l' | 'c' | 'r' | null; leader: number } | null): string {
  const parts = text.split('\t');
  let inner = '';
  const tag = deleted ? 'w:delText' : 'w:t';
  // 절대 위치 탭: 글 영역의 왼쪽 끝·가운데·오른쪽 끝
  const tabXml = ptab?.ptab
    ? `<w:ptab w:relativeTo="margin" w:alignment="${ptab.ptab === 'c' ? 'center' : ptab.ptab === 'r' ? 'right' : 'left'}" w:leader="${leaderAttr(ptab.leader).replace(/^.*"(\w+)"$/, '$1') || 'none'}"/>`
    : '<w:tab/>';
  parts.forEach((part, i) => {
    if (i) inner += tabXml;
    if (part) inner += `<${tag} xml:space="preserve">${xmlEscape(part)}</${tag}>`;
  });
  return `<w:r>${rPr(c)}${inner}</w:r>`;
}

const isoTime = (t: number) => (t > 0 ? new Date(t).toISOString().replace(/\.\d+Z$/, 'Z') : new Date().toISOString().replace(/\.\d+Z$/, 'Z'));

/** 글자 조각: 변경 내용이면 w:ins / w:del 로 감싼다 */
function reviewedRun(ctx: Ctx, it: Extract<FlatInline, { type: 'text' }>): string {
  const ch = it.review?.change;
  if (!ch) return textRuns(it.text, it.style, false, it.tab);
  const tag = ch.type === 'ins' ? 'w:ins' : 'w:del';
  return `<${tag} w:id="${ctx.changeNo++}" w:author="${xmlEscape(ch.author || 'Kite')}" w:date="${isoTime(ch.time)}">${textRuns(it.text, it.style, ch.type === 'del', it.tab)}</${tag}>`;
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

const emu = (px: number) => Math.round((Number.isFinite(px) ? px : 0) * 9525);

/** 그림의 그래픽 부분 (글줄 안·떠 있는 그림 공통) */
function picGraphic(id: number, info: { rid: string; name: string }, cx: number, cy: number, crop: { t: number; r: number; b: number; l: number } | null): string {
  return (
    `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${info.name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    `<pic:blipFill><a:blip r:embed="${info.rid}"/>${crop ? `<a:srcRect l="${Math.round(crop.l * 100000)}" t="${Math.round(crop.t * 100000)}" r="${Math.round(crop.r * 100000)}" b="${Math.round(crop.b * 100000)}"/>` : ''}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`
  );
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
    picGraphic(id, info, cx, cy, crop) +
    `</wp:inline></w:drawing>`
  );
}

/**
 * 떠 있는 개체의 wp:anchor 앞부분 (자리·크기·글 흐름). x: 단 왼쪽 기준 px, 세로는 문단 기준(y) 또는 쪽 기준(py: 여백 위쪽 기준).
 * 둘레 글 흐름은 Word 에 적혀 있던 쪽(o)을 되돌린다
 */
function anchorHead(ctx: Ctx, fl: FlatFloat, cx: number, cy: number, xPx: number, id: number, name: string): string {
  const d = fl.wrap?.d || [0, 0, 0, 0];
  const dist = `distT="${emu(d[0])}" distB="${emu(d[2])}" distL="${emu(d[3])}" distR="${emu(d[1])}"`;
  let wrap = '<wp:wrapNone/>';
  if (fl.wrap && !fl.behind) {
    if (fl.wrap.s === 'tb') wrap = `<wp:wrapTopAndBottom distT="${emu(d[0])}" distB="${emu(d[2])}"/>`;
    else wrap = `<wp:wrapSquare wrapText="${fl.wrap.o || (fl.wrap.s === 'l' ? 'left' : 'right')}" ${dist}/>`;
  }
  const v = fl.py != null ? `<wp:positionV relativeFrom="margin"><wp:posOffset>${emu(fl.py)}</wp:posOffset></wp:positionV>` : `<wp:positionV relativeFrom="paragraph"><wp:posOffset>${emu(fl.y)}</wp:posOffset></wp:positionV>`;
  // 오른쪽·가운데 맞춤 틀 (폭이 내용대로): 단 오른쪽 끝·가운데에 맞춘다 (끝에서 민 거리가 있으면 종이 기준으로 어림)
  const right = fl.ax === 'r' || fl.cf === 'r';
  const h =
    right || fl.ax === 'c'
      ? `<wp:positionH relativeFrom="${Math.abs(fl.x) > 1 ? 'page' : 'margin'}"><wp:align>${right ? 'right' : 'center'}</wp:align></wp:positionH>`
      : `<wp:positionH relativeFrom="column"><wp:posOffset>${emu(xPx)}</wp:posOffset></wp:positionH>`;
  return (
    `<wp:anchor ${dist} simplePos="0" relativeHeight="${ctx.relHeight++}" behindDoc="${fl.behind ? 1 : 0}" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>` +
    `${h}${v}<wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/>${wrap}` +
    `<wp:docPr id="${id}" name="${xmlEscape(name)}"/><wp:cNvGraphicFramePr/>`
  );
}

/** 떠 있는 그림 (x 는 문단 상자 기준이라 문단 왼쪽(paraLeft px)을 더해 단 기준으로) */
function anchoredPicture(ctx: Ctx, info: { rid: string; w: number; h: number; name: string }, it: Extract<FlatInline, { type: 'image' }>, paraLeft: number): string {
  const w = it.width || info.w;
  const h = it.height || (it.width ? Math.round((it.width * info.h) / Math.max(1, info.w)) : info.h);
  const cx = emu(w);
  const cy = emu(h);
  const id = ctx.docPrId++;
  return `<w:drawing>${anchorHead(ctx, it.float!, cx, cy, it.float!.x + paraLeft, id, `그림 ${id}`)}${picGraphic(id, info, cx, cy, it.crop)}</wp:anchor></w:drawing>`;
}

// ---------------- 그리기 개체 → DrawingML 묶음 (wpg:wgp) ----------------

/**
 * SVG 경로(절대 좌표의 M·L·H·V·C·A·Z) → DrawingML 경로 명령. 호(A)는 3차 베지어로 바꾼다.
 * 좌표는 EMU (경로 w·h 를 개체 크기의 EMU 로 두어 그대로 맞는다)
 */
function svgPathToDml(d: string): string {
  const tok = d.match(/[MLHVCAZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) || [];
  let i = 0;
  const num = () => parseFloat(tok[i++] || '0') || 0;
  let out = '';
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  const pt = (x: number, y: number) => `<a:pt x="${emu(x)}" y="${emu(y)}"/>`;
  let cmd = '';
  let guard = 0;
  while (i < tok.length && guard++ < 200000) {
    if (/^[MLHVCAZ]$/i.test(tok[i])) cmd = tok[i++].toUpperCase();
    if (cmd === 'M') {
      cx = num();
      cy = num();
      sx = cx;
      sy = cy;
      out += `<a:moveTo>${pt(cx, cy)}</a:moveTo>`;
      cmd = 'L';
    } else if (cmd === 'L') {
      cx = num();
      cy = num();
      out += `<a:lnTo>${pt(cx, cy)}</a:lnTo>`;
    } else if (cmd === 'H') {
      cx = num();
      out += `<a:lnTo>${pt(cx, cy)}</a:lnTo>`;
    } else if (cmd === 'V') {
      cy = num();
      out += `<a:lnTo>${pt(cx, cy)}</a:lnTo>`;
    } else if (cmd === 'C') {
      const x1 = num(), y1 = num(), x2 = num(), y2 = num();
      cx = num();
      cy = num();
      out += `<a:cubicBezTo>${pt(x1, y1)}${pt(x2, y2)}${pt(cx, cy)}</a:cubicBezTo>`;
    } else if (cmd === 'A') {
      const rx = num(), ry = num(), rot = num(), large = num(), sweep = num(), x = num(), y = num();
      out += arcToBeziers(cx, cy, rx, ry, rot, !!large, !!sweep, x, y).map((c) => `<a:cubicBezTo>${pt(c[0], c[1])}${pt(c[2], c[3])}${pt(c[4], c[5])}</a:cubicBezTo>`).join('');
      cx = x;
      cy = y;
    } else if (cmd === 'Z') {
      out += '<a:close/>';
      cx = sx;
      cy = sy;
      cmd = '';
    } else i++;
  }
  return out;
}

/** SVG 의 타원 호 → 3차 베지어들 (SVG 명세의 끝점 → 중심 바꾸기) */
function arcToBeziers(x1: number, y1: number, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, x2: number, y2: number): number[][] {
  if (!(rx > 0 && ry > 0) || (x1 === x2 && y1 === y2)) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (rotDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy;
  const yp = -sin * dx + cos * dy;
  const lam = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const co = sign * Math.sqrt(Math.max(0, num / (rx * rx * yp * yp + ry * ry * xp * xp)));
  const cxp = (co * rx * yp) / ry;
  const cyp = (-co * ry * xp) / rx;
  const cxx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cyy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = ang(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let dt = ang((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  else if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const P = (t: number) => [cxx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cyy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos];
  const D = (t: number) => [-rx * Math.sin(t) * cos - ry * Math.cos(t) * sin, -rx * Math.sin(t) * sin + ry * Math.cos(t) * cos];
  const out: number[][] = [];
  for (let s = 0; s < n; s++) {
    const a = t1 + s * step;
    const b = a + step;
    const [p0x, p0y] = P(a);
    const [d0x, d0y] = D(a);
    const [p3x, p3y] = P(b);
    const [d3x, d3y] = D(b);
    out.push([p0x + k * d0x, p0y + k * d0y, p3x - k * d3x, p3y - k * d3y, p3x, p3y]);
  }
  return out;
}

/** 조각의 행렬 → 상자(틀 좌표 px)·돌림(도)·뒤집기. 기울임은 버린다 */
function itemBox(it: ShapeItem) {
  const [a, b, c, d, e, f] = it.m;
  const sx = Math.hypot(a, b) || 1;
  const sy = Math.hypot(c, d) || 1;
  const flip = a * d - b * c < 0;
  const rot = (Math.atan2(b, a) * 180) / Math.PI;
  const w = it.w * sx;
  const h = it.h * sy;
  const cx = a * (it.w / 2) + c * (it.h / 2) + e;
  const cy = b * (it.w / 2) + d * (it.h / 2) + f;
  return { x: cx - w / 2, y: cy - h / 2, w, h, rot: ((rot % 360) + 360) % 360, flipV: flip };
}

const DML_DASH: Record<string, string> = { DASH: 'dash', DOT: 'sysDot', DASH_DOT: 'dashDot', DASH_DOT_DOT: 'lgDashDotDot', LONG_DASH: 'lgDash', CIRCLE: 'sysDot' };
const DML_ARROW = (s: string | undefined, filled: boolean | undefined): string | null =>
  !s ? null : s === 'ARROW' ? (filled === false ? 'arrow' : 'triangle') : s === 'SPEAR' || s === 'CONCAVE_ARROW' ? 'stealth' : s === 'DIAMOND' ? 'diamond' : s === 'CIRCLE' ? 'oval' : 'triangle';
const arrowSize = (z: [number, number] | undefined, k: 0 | 1) => ['sm', 'med', 'lg'][Math.max(0, Math.min(2, Math.round(z ? z[k] : 1)))];

/** 조각의 채우기(그림·그러데이션·단색)·선 */
function itemLook(ctx: Ctx, it: ShapeItem, filled: boolean): string {
  let fill = '<a:noFill/>';
  const fc = normColor(it.fc || '');
  const pic = filled && it.fi ? ctx.images.get(it.fi) : null;
  if (pic) fill = `<a:blipFill><a:blip r:embed="${pic.rid}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>`;
  else if (filled && it.fg && Array.isArray(it.fg.c) && it.fg.c.length >= 2) {
    const cs = it.fg.c.map((c) => normColor(c)).filter((c): c is string => !!c);
    const stops = cs.map((c, i) => `<a:gs pos="${Math.round((i / Math.max(1, cs.length - 1)) * 100000)}"><a:srgbClr val="${c.slice(1)}"/></a:gs>`).join('');
    const ang = ((((90 - (+it.fg.a || 0)) % 360) + 360) % 360) * 60000;
    fill = `<a:gradFill rotWithShape="1"><a:gsLst>${stops}</a:gsLst>${it.fg.t === 'LINEAR' ? `<a:lin ang="${ang}" scaled="0"/>` : '<a:path path="circle"><a:fillToRect l="50000" t="50000" r="50000" b="50000"/></a:path>'}</a:gradFill>`;
  } else if (filled && fc) {
    const alpha = it.al && it.al > 0 ? `<a:alpha val="${Math.round(Math.max(0, 1 - it.al) * 100000)}"/>` : '';
    fill = `<a:solidFill><a:srgbClr val="${fc.slice(1)}">${alpha}</a:srgbClr></a:solidFill>`;
  }
  const sc = normColor(it.sc || '');
  let ln = '<a:ln><a:noFill/></a:ln>';
  if (sc) {
    const dash = it.sd && DML_DASH[it.sd] ? `<a:prstDash val="${DML_DASH[it.sd]}"/>` : '';
    const head = DML_ARROW(it.hs, it.hf);
    const tail = DML_ARROW(it.ts, it.tf);
    ln =
      `<a:ln w="${emu(Math.max(0.25, it.sw || 1))}"><a:solidFill><a:srgbClr val="${sc.slice(1)}"/></a:solidFill>${dash}` +
      `${head ? `<a:headEnd type="${head}" w="${arrowSize(it.hz, 0)}" len="${arrowSize(it.hz, 1)}"/>` : ''}${tail ? `<a:tailEnd type="${tail}" w="${arrowSize(it.tz, 0)}" len="${arrowSize(it.tz, 1)}"/>` : ''}</a:ln>`;
  }
  return fill + ln;
}

/** 묶음 안의 조각 하나 → wps:wsp (도형·글) 또는 pic:pic (그림). 쓸 수 없으면 '' */
function itemXml(ctx: Ctx, it: ShapeItem): string {
  const box = itemBox(it);
  if (!(box.w > 0.01 || box.h > 0.01)) return '';
  const id = ctx.docPrId++;
  const xfrm = `<a:xfrm${box.rot > 0.01 ? ` rot="${Math.round(box.rot * 60000)}"` : ''}${box.flipV ? ' flipV="1"' : ''}><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${emu(Math.max(0.01, box.w))}" cy="${emu(Math.max(0.01, box.h))}"/></a:xfrm>`;
  if (it.k === 'img') {
    const info = it.src ? ctx.images.get(it.src) : null;
    if (!info) return '';
    const c = it.crop;
    return (
      `<pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${info.name}"/><pic:cNvPicPr/></pic:nvPicPr>` +
      `<pic:blipFill><a:blip r:embed="${info.rid}"/>${c ? `<a:srcRect l="${Math.round(c.l * 100000)}" t="${Math.round(c.t * 100000)}" r="${Math.round(c.r * 100000)}" b="${Math.round(c.b * 100000)}"/>` : ''}<a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
      `<pic:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>`
    );
  }
  if (it.k === 'text' || it.k === 'art') {
    // 도형 안의 글: 안 보이는 글상자. 글맵시는 그 글자를 글상자로
    const blocks = it.k === 'text' ? flattenContent(it.content || []) : flattenContent([{ type: 'paragraph', attrs: { textAlign: 'center' }, content: it.text ? [{ type: 'text', text: it.text }] : [] }]);
    const waiting = ctx.anchors;
    ctx.anchors = [];
    const inner = blocksXml(ctx, blocks) || '<w:p/>';
    ctx.anchors = waiting;
    const pad = it.pad && it.pad.length === 4 ? it.pad : [0, 0, 0, 0];
    const anchor = it.va === 'middle' ? 'ctr' : it.va === 'bottom' ? 'b' : 't';
    return (
      `<wps:wsp><wps:cNvPr id="${id}" name="글 ${id}"/><wps:cNvSpPr txBox="1"/><wps:spPr>${xfrm}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></wps:spPr>` +
      `<wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx><wps:bodyPr rot="0" vert="horz" wrap="square" lIns="${emu(pad[3])}" tIns="${emu(pad[0])}" rIns="${emu(pad[1])}" bIns="${emu(pad[2])}" anchor="${anchor}" anchorCtr="0"><a:noAutofit/></wps:bodyPr></wps:wsp>`
    );
  }
  // 도형: 개체 좌표의 경로를 그대로 (경로 크기 = 개체 크기). 화면(SVG)처럼 닫히지 않은 다각형·곡선·호도 칠한다 (선만 칠하지 않는다)
  const d = pathOf(it);
  if (!d) return '';
  const filled = it.k !== 'line';
  const geom = `<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="${emu(Math.max(0.01, it.w))}" h="${emu(Math.max(0.01, it.h))}"${filled ? '' : ' fill="none"'}>${svgPathToDml(d)}</a:path></a:pathLst></a:custGeom>`;
  // 개체 상자 크기로 경로를 맞추므로 상자는 개체 크기에 행렬의 배율을 곱한 것 (itemBox)
  return `<wps:wsp><wps:cNvPr id="${id}" name="도형 ${id}"/><wps:cNvSpPr/><wps:spPr>${xfrm}${geom}${itemLook(ctx, it, filled)}</wps:spPr><wps:bodyPr/></wps:wsp>`;
}

/** 그리기 개체 → 묶음 그래픽 (a:graphic). 조각이 없으면 '' */
function shapeGraphic(ctx: Ctx, it: Extract<FlatInline, { type: 'shape' }>): string {
  const cx = emu(it.width);
  const cy = emu(it.height);
  const kids = it.d.items.map((x) => itemXml(ctx, x)).join('');
  if (!kids) return '';
  return (
    `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"><wpg:wgp><wpg:cNvGrpSpPr/>` +
    `<wpg:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/><a:chOff x="0" y="0"/><a:chExt cx="${cx}" cy="${cy}"/></a:xfrm></wpg:grpSpPr>${kids}</wpg:wgp></a:graphicData></a:graphic>`
  );
}

/** 그리기 개체 하나 (떠 있으면 wp:anchor, 아니면 글줄 안 wp:inline) */
function shapeDrawing(ctx: Ctx, it: Extract<FlatInline, { type: 'shape' }>, paraLeft: number): string {
  const cx = emu(Math.max(1, it.width));
  const cy = emu(Math.max(1, it.height));
  const id = ctx.docPrId++;
  const g = shapeGraphic(ctx, it);
  if (!g) return '';
  if (it.float) return `<w:drawing>${anchorHead(ctx, it.float, cx, cy, it.float.x + paraLeft, id, `그리기 ${id}`)}${g}</wp:anchor></w:drawing>`;
  return `<w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="그리기 ${id}"/><wp:cNvGraphicFramePr/>${g}</wp:inline></w:drawing>`;
}

/** 떠 있는 글상자 → 글상자 도형(wps:wsp) 을 담은 글자 묶음 (뒤 문단에 매단다) */
function textBoxRun(ctx: Ctx, b: FlatBox): string {
  const fl = b.float!;
  // 크기를 정하지 않은 상자(Word 의 틀): 어림 크기로 두고 Word 가 글에 맞춰 늘이고 줄이게 한다 (spAutoFit, 줄 바꿈 없음)
  const auto = !(b.width && b.width > 0);
  const w = b.width && b.width > 0 ? b.width : fl.zw || 200;
  const h = b.height && b.height > 0 ? b.height : 100;
  const cx = emu(w);
  const cy = emu(h);
  const id = ctx.docPrId++;
  // 안의 문단은 따로 쓴다 (그 안에서 기다리는 글상자와 섞이지 않게)
  const waiting = ctx.anchors;
  ctx.anchors = [];
  const inner = blocksXml(ctx, b.blocks) || '<w:p/>';
  ctx.anchors = waiting;
  const r = String(b.radius || '');
  const geom = r === '50%' ? 'ellipse' : /px$/.test(r) && parseFloat(r) > 0 ? 'roundRect' : 'rect';
  const av = geom === 'roundRect' ? `<a:gd name="adj" fmla="val ${Math.min(50000, Math.round((parseFloat(r) / Math.max(1, Math.min(w, h))) * 100000))}"/>` : '';
  const bg = normColor(b.bg || '');
  const fill = bg ? `<a:solidFill><a:srgbClr val="${bg.slice(1)}"/></a:solidFill>` : '<a:noFill/>';
  const bc = normColor(b.borderColor || '');
  const dash = b.borderDash && /DASH|DOT/i.test(b.borderDash) ? `<a:prstDash val="${/DOT/i.test(b.borderDash) && !/DASH/i.test(b.borderDash) ? 'sysDot' : 'dash'}"/>` : '';
  const ln = bc ? `<a:ln w="${emu(b.borderWidth || 1)}"><a:solidFill><a:srgbClr val="${bc.slice(1)}"/></a:solidFill>${dash}</a:ln>` : '<a:ln><a:noFill/></a:ln>';
  let pad = b.padding && b.padding.length === 4 ? b.padding : [4.8, 9.6, 4.8, 9.6];
  // 타원: Word 는 글 영역을 타원 안에 든 사각형으로 줄이므로, 그만큼(읽을 때 더한 몫)을 뺀다
  if (geom === 'ellipse') {
    const k = (1 - Math.SQRT1_2) / 2;
    pad = [pad[0] - h * k, pad[1] - w * k, pad[2] - h * k, pad[3] - w * k].map((v) => Math.max(0, Math.round(v * 100) / 100));
  }
  const anchor = b.valign === 'middle' ? 'ctr' : b.valign === 'bottom' ? 'b' : 't';
  return (
    `<w:r><w:drawing>${anchorHead(ctx, fl, cx, cy, fl.x, id, `글상자 ${id}`)}` +
    `<a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:wsp><wps:cNvSpPr txBox="1"/>` +
    `<wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="${geom}"><a:avLst>${av}</a:avLst></a:prstGeom>${fill}${ln}</wps:spPr>` +
    `<wps:txbx><w:txbxContent>${inner}</w:txbxContent></wps:txbx>` +
    `<wps:bodyPr rot="0" vert="horz" wrap="${auto ? 'none' : 'square'}" lIns="${emu(pad[3])}" tIns="${emu(pad[0])}" rIns="${emu(pad[1])}" bIns="${emu(pad[2])}" anchor="${anchor}" anchorCtr="0">${auto || !(b.height && b.height > 0) ? '<a:spAutoFit/>' : '<a:noAutofit/>'}</wps:bodyPr>` +
    `</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`
  );
}

function paragraphXml(ctx: Ctx, p: FlatPara): string {
  const firstText = p.inlines.find((it) => it.type === 'text');
  let x = '<w:p>' + pPr(p.style, p.pageBreakBefore, p.inlines.length ? undefined : p.baseChar, (firstText && firstText.type === 'text' ? firstText.style.font : '') || p.baseChar.font);
  // 단 나누기
  if (p.columnBreakBefore) x += '<w:r><w:br w:type="column"/></w:r>';
  // 이 문단 앞에 놓였던 떠 있는 글상자들 (자리는 이 문단 기준)
  if (ctx.anchors.length) x += ctx.anchors.splice(0).join('');
  /** 문단 상자 왼쪽 (단 왼쪽 기준 px): 떠 있는 그림의 x 는 이것을 기준으로 적혀 있다 */
  const paraLeft = ((p.style.indentLeft || 0) + Math.max(0, -(p.style.textIndent || 0))) * (96 / 72);
  let linkOpen: string | null = null;
  const closeLink = () => {
    if (linkOpen) {
      x += '</w:hyperlink>';
      linkOpen = null;
    }
  };
  for (const it of p.inlines) {
    // 비어 있는 누름틀의 안내문은 자리 표시일 뿐이라 쓰지 않는다
    if (it.type === 'text' && it.field?.empty) continue;
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
      if (info) x += `<w:r>${rPr(it.style)}${it.float ? anchoredPicture(ctx, info, it, paraLeft) : drawing(ctx, info, it.width, it.height, it.crop)}</w:r>`;
    } else if (it.type === 'shape') {
      // 그리기 개체: DrawingML 묶음 (도형 경로·채우기·선·화살표, 안의 글, 그림)
      const dr = shapeDrawing(ctx, it, paraLeft);
      if (dr) x += `<w:r>${rPr(it.style)}${dr}</w:r>`;
    } else if (it.type === 'bookmark') {
      // 책갈피: 길이 없는 책갈피 (시작·끝을 붙여서)
      const id = ++ctx.bookmarkSeq;
      x += `<w:bookmarkStart w:id="${id}" w:name="${xmlEscape(it.name)}"/><w:bookmarkEnd w:id="${id}"/>`;
    } else if (it.type === 'footnote' && it.end) {
      ctx.endnotes.push(it.text);
      const id = ctx.endnotes.length + 1;
      x += `<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteReference w:id="${id}"/></w:r>`;
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
  // 셀 간격: 칸 사이 간격의 절반을 적는다 (Word 와 같이)
  if (t.cellSpacingPx) x += `<w:tblCellSpacing w:w="${Math.max(1, Math.round((t.cellSpacingPx * 15) / 2))}" w:type="dxa"/>`;
  x += '<w:tblBorders>' + ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="000000"/>`).join('') + '</w:tblBorders>';
  x += `<w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="28" w:type="dxa"/><w:left w:w="${Math.round(t.cellPadPx * 15)}" w:type="dxa"/><w:bottom w:w="28" w:type="dxa"/><w:right w:w="${Math.round(t.cellPadPx * 15)}" w:type="dxa"/></w:tblCellMar>`;
  x += '<w:tblLook w:val="0000" w:firstRow="0" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="0"/></w:tblPr>';
  x += '<w:tblGrid>' + colTw.map((w) => `<w:gridCol w:w="${w}"/>`).join('') + '</w:tblGrid>';
  // 세로 병합: 각 줄에 이어지는 셀 자리 표시
  const cont: { row: number; col: number; cell: (typeof t.cells)[0][0] }[] = [];
  for (const row of t.cells) for (const c of row) for (let r = 1; r < c.rowspan; r++) cont.push({ row: c.row + r, col: c.col, cell: c });
  let headRun = 0;
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
              // 굵기(1/8 pt): 이중선은 그려지는 굵기(값 × 2.4)를 선 둘과 사이 틈으로 셋으로 나눈 것
              return d ? `<w:${map[s]} w:val="${VAL[d.s]}" w:sz="${Math.max(2, Math.min(96, Math.round(((d.s === 'double' ? (d.w * 2.4) / 3 : d.w) / 0.3528) * 8)))}" w:space="0" w:color="${hex(d.c)}"/>` : '';
            })
            .join('') +
          '</w:tcBorders>';
      }
      if (c.bg) p += `<w:shd w:val="clear" w:color="auto" w:fill="${hex(c.bg)}"/>`;
      p += `<w:vAlign w:val="${c.vAlign === 'middle' ? 'center' : c.vAlign}"/>`;
      return p + '</w:tcPr>';
    };
    for (const c of row) {
      let inner = blocksXml(ctx, c.blocks);
      if (!c.blocks.length || c.blocks[c.blocks.length - 1].kind === 'table') inner += '<w:p/>';
      entries.push({ col: c.col, xml: `<w:tc>${tcPr(c, c.rowspan > 1 ? '<w:vMerge w:val="restart"/>' : '')}${inner}</w:tc>` });
    }
    for (const k of cont.filter((x) => x.row === ri)) entries.push({ col: k.col, xml: `<w:tc>${tcPr(k.cell, '<w:vMerge/>')}<w:p/></w:tc>` });
    entries.sort((a, b) => a.col - b.col);
    const rh = t.rowHeightsPx?.[ri];
    // 제목 줄: 맨 앞에서부터 이어진, 제목 칸으로만 된 줄들 (Word 는 쪽마다 되풀이한다)
    if (ri === headRun && row.length && row.every((c) => c.header)) headRun++;
    const trPr = (ri < headRun ? '<w:tblHeader/>' : '') + (rh ? `<w:trHeight w:val="${Math.round(rh * 15)}" w:hRule="atLeast"/>` : '');
    x += '<w:tr>' + (trPr ? `<w:trPr>${trPr}</w:trPr>` : '') + entries.map((e) => e.xml).join('') + '</w:tr>';
  });
  x += '</w:tbl>';
  if (t.pageBreakBefore) x = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>' + x;
  else if (t.columnBreakBefore) x = '<w:p><w:r><w:br w:type="column"/></w:r></w:p>' + x;
  return x;
}

function blockXml(ctx: Ctx, b: FlatBlock): string {
  if (b.kind === 'box') {
    // 떠 있는 글상자는 뒤 문단에 매단다. 떠 있지 않은 상자는 안의 문단만 (Word 의 글상자는 떠 있는 것뿐)
    if (b.float) {
      ctx.anchors.push(textBoxRun(ctx, b));
      return '';
    }
    return blocksXml(ctx, b.blocks);
  }
  return b.kind === 'para' ? paragraphXml(ctx, b) : tableXml(ctx, b);
}

/** 블록들. 끝까지 매달 문단이 없던 떠 있는 글상자는 빈 문단에 */
function blocksXml(ctx: Ctx, blocks: FlatBlock[]): string {
  let x = blocks.map((b) => blockXml(ctx, b)).join('');
  if (ctx.anchors.length) x += '<w:p>' + ctx.anchors.splice(0).join('') + '</w:p>';
  return x;
}

function collectImages(blocks: FlatBlock[], out: Set<string>) {
  for (const b of blocks) {
    if (b.kind === 'para') {
      for (const i of b.inlines) {
        if (i.type === 'image' && i.src) out.add(i.src);
        // 그리기 개체 안의 그림과 글 속 그림
        else if (i.type === 'shape')
          for (const it of i.d.items) {
            if (it.k === 'img' && it.src) out.add(it.src);
            else if (it.k === 'text' && it.content) collectImages(flattenContent(it.content), out);
            if (it.fi) out.add(it.fi);
          }
      }
    } else if (b.kind === 'box') collectImages(b.blocks, out);
    else for (const row of b.cells) for (const c of row) collectImages(c.blocks, out);
  }
}

const REL_TYPES: Record<string, string> = {
  image: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
  hyperlink: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink',
  header: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
  footer: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
  footnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes',
  endnotes: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes',
  comments: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
  styles: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  settings: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings',
};

/** 관계 파일 (.rels) */
function relsXml(rels: Ctx['rels']): string {
  return (
    DECL +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    rels.map((r) => `<Relationship Id="${r.id}" Type="${REL_TYPES[r.type] || r.type}" Target="${xmlEscape(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('') +
    `</Relationships>`
  );
}

function hfXml(tag: 'hdr' | 'ftr', inner: string): string {
  return DECL + `<w:${tag} ${W_NS}>${inner || '<w:p/>'}</w:${tag}>`;
}

/** 글자뿐인 머리말·꼬리말·쪽 번호 문단. Header·Footer 스타일을 달아 둔다 (다시 읽을 때 Kite 의 글자 머리말로 알아본다) */
function hfParagraph(text: string, align: string, pageFmt: string, kind: 'header' | 'footer'): string {
  const jc = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
  const rp = '<w:rPr><w:sz w:val="18"/></w:rPr>';
  let runs = '';
  for (const part of text.split(/(\{\{PAGE\}\}|\{\{PAGES\}\})/)) {
    if (part === '{{PAGE}}' || part === '{{PAGES}}') {
      const instr = part === '{{PAGE}}' ? `PAGE${pageFmt}` : 'NUMPAGES';
      runs += `<w:r>${rp}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rp}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r>${rp}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rp}<w:t>1</w:t></w:r><w:r>${rp}<w:fldChar w:fldCharType="end"/></w:r>`;
    } else if (part) runs += `<w:r>${rp}<w:t xml:space="preserve">${xmlEscape(part)}</w:t></w:r>`;
  }
  return `<w:p><w:pPr><w:pStyle w:val="${kind === 'header' ? 'Header' : 'Footer'}"/><w:jc w:val="${jc}"/></w:pPr>${runs}</w:p>`;
}

/** 글 속의 쪽 번호 자리({{PAGE}}·{{PAGES}})를 Word 의 필드로 바꾼다 (모양을 갖춘 머리말·꼬리말) */
function pageFields(xml: string, pageFmt: string): string {
  if (!/\{\{PAGES?\}\}/.test(xml)) return xml;
  return xml.replace(/<w:r>((?:<w:rPr>.*?<\/w:rPr>)?)(.*?)<\/w:r>/gs, (m, rp: string, inner: string) => {
    if (!/\{\{PAGES?\}\}/.test(inner)) return m;
    const fld = (instr: string) =>
      `</w:r><w:r>${rp}<w:fldChar w:fldCharType="begin"/></w:r><w:r>${rp}<w:instrText xml:space="preserve"> ${instr} </w:instrText></w:r><w:r>${rp}<w:fldChar w:fldCharType="separate"/></w:r><w:r>${rp}<w:t>1</w:t></w:r><w:r>${rp}<w:fldChar w:fldCharType="end"/></w:r><w:r>${rp}`;
    const out = inner.replace(/<w:t xml:space="preserve">([^<]*)<\/w:t>/g, (_t, text: string) =>
      text
        .split(/(\{\{PAGES?\}\})/)
        .map((part) => (part === '{{PAGE}}' ? fld('PAGE' + pageFmt) : part === '{{PAGES}}' ? fld('NUMPAGES') : part ? `<w:t xml:space="preserve">${part}</w:t>` : ''))
        .join(''),
    );
    return `<w:r>${rp}${out}</w:r>`;
  });
}

/** 모양을 갖춘 머리말/꼬리말의 블록 (없으면 null) */
function richHF(def: HeaderFooter | null | undefined): FlatBlock[] | null {
  if (!def || !Array.isArray(def.content) || !def.content.length) return null;
  try {
    return flattenContent(def.content as JNode[]);
  } catch {
    return null;
  }
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
    `<w:style w:type="paragraph" w:styleId="Header"><w:name w:val="header"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Footer"><w:name w:val="footer"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="FootnoteText"><w:name w:val="footnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="EndnoteText"><w:name w:val="endnote text"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:line="240" w:lineRule="auto"/></w:pPr><w:rPr><w:sz w:val="18"/></w:rPr></w:style>` +
    `<w:style w:type="character" w:styleId="EndnoteReference"><w:name w:val="endnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>` +
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
  // 머리말·꼬리말(기본·첫 쪽·짝수 쪽)의 그림도 함께 담는다
  for (const def of [s.header, s.header.first, s.header.even, s.footer, s.footer.first, s.footer.even]) collectImages(richHF(def) || [], srcs);
  // 구역마다 다른 머리말·꼬리말의 그림도
  for (const b of blocks)
    if (b.sectionHfBefore) for (const h of [b.sectionHfBefore.header, b.sectionHfBefore.footer]) for (const def of [h, h.first, h.even]) collectImages(richHF(def) || [], srcs);
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
  // 본문. 구역 나누기(구역마다 용지)는 앞 구역의 설정을 그 구역의 마지막 문단에 단다 (머리말 참조가 정해진 뒤에: 아래)
  const parts: { xml: string; para: boolean }[] = [];
  const sectionAt: { index: number; page: PageSetup; hf: SectionHf | null }[] = [];
  for (const b of blocks) {
    if (b.sectionPageBefore) {
      sectionAt.push({ index: parts.length, page: b.sectionPageBefore, hf: b.sectionHfBefore || null });
      // 새 구역은 새 쪽에서 시작한다 (쪽 나누기를 따로 두면 빈 쪽이 생긴다)
      b.pageBreakBefore = false;
    }
    parts.push({ xml: blockXml(ctx, b), para: b.kind === 'para' });
  }
  if (ctx.anchors.length) parts.push({ xml: '<w:p>' + ctx.anchors.splice(0).join('') + '</w:p>', para: true });
  // 쪽 배경 (색·그림): Word 는 settings 의 displayBackgroundShape 가 있어야 보인다
  const pbd = s.pageBorder;
  const bgColor = pbd ? normColor(pbd.bg || '') : null;
  let bgRid: string | null = null;
  if (pbd?.image) {
    const img = await prepareImage(pbd.image);
    if (img) {
      const name = `background.${img.ext}`;
      ctx.media.push({ path: `word/media/${name}`, bytes: img.bytes, ext: img.ext });
      bgRid = ctx.addRel('image', `media/${name}`);
    }
  }
  const background =
    bgColor || bgRid
      ? `<w:background w:color="${bgColor ? bgColor.slice(1) : 'FFFFFF'}">${bgRid ? `<v:background id="_x0000_s1025" o:bwmode="white" fillcolor="${bgColor || '#ffffff'}"><v:fill r:id="${bgRid}" o:title="" type="${String(pbd?.imageMode || '').startsWith('TILE') ? 'tile' : 'frame'}"/></v:background>` : ''}</w:background>`
      : '';

  // 머리말/꼬리말: 기본(홀수 쪽)·첫 쪽·짝수 쪽. 모양을 갖춘 것(content)은 본문처럼 쓰고, 글자뿐인 것은 한 문단으로 쓴다
  const pfmt = s.pageNumber.format === 'roman' ? ' \\* roman' : s.pageNumber.format === 'ROMAN' ? ' \\* ROMAN' : '';
  const pageText = s.pageNumber.format === 'dash' ? '- {{PAGE}} -' : s.pageNumber.format === 'paren' ? '({{PAGE}})' : '{{PAGE}}';
  const [numV, numH] = s.pageNumber.pos === 'none' ? ['', ''] : s.pageNumber.pos.split('-');
  const files: [string, string][] = [];
  const hfOverrides: string[] = [];
  let partNo = 0;
  /** 머리말/꼬리말 부분 하나를 쓰고 구역에서 가리킬 참조를 돌려준다. 내용이 없으면 쓰지 않는다 */
  const hfPart = (kind: 'header' | 'footer', type: 'default' | 'first' | 'even', def: HeaderFooter | null | undefined, pageNum: boolean): string => {
    const hc = new Ctx();
    hc.relNo = 0;
    hc.bodyWidthTw = ctx.bodyWidthTw;
    hc.docPrId = ctx.docPrId + 1000 * (partNo + 1);
    let inner = '';
    const rich = richHF(def);
    if (rich) {
      // 이 부분의 그림은 이 부분의 관계 파일로 가리킨다
      const used = new Set<string>();
      collectImages(rich, used);
      for (const src of used) {
        const img = ctx.images.get(src);
        hc.images.set(src, img ? { ...img, rid: hc.addRel('image', `media/${img.name}`) } : null);
      }
      inner = pageFields(blocksXml(hc, rich), pfmt);
    } else if (def?.text.trim()) inner = hfParagraph(def.text, def.align, pfmt, kind);
    if (pageNum) inner += hfParagraph(pageText, numH, pfmt, kind);
    if (!inner) return '';
    const name = `${kind}${++partNo}.xml`;
    files.push([`word/${name}`, hfXml(kind === 'header' ? 'hdr' : 'ftr', inner)]);
    if (hc.rels.length) files.push([`word/_rels/${name}.rels`, relsXml(hc.rels)]);
    hfOverrides.push(`<Override PartName="/word/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${kind}+xml"/>`);
    return `<w:${kind}Reference w:type="${type}" r:id="${ctx.addRel(kind, name)}"/>`;
  };
  // 짝수 쪽을 다르게 (문서 전체 설정): 문서의 것이나 어느 구역의 것이든 짝수 쪽이 다르면
  const sectHfs = sectionAt.map((x) => x.hf).filter((x): x is SectionHf => !!x);
  const evenOdd = [s, ...sectHfs].some((h) => !!(h.header.even || h.footer.even || h.header.oddOnly || h.footer.oddOnly));
  /** 머리말·꼬리말 묶음 하나(문서의 것 또는 구역의 것)의 부분들을 쓰고 참조와 '첫 쪽 다르게'를 돌려준다 */
  const refsFor = (h: { header: HeaderFooter; footer: HeaderFooter }, hideFirst: DocSettings['hideFirst']) => {
    // 첫 쪽을 다르게: 머리말·꼬리말 가운데 하나라도 첫 쪽이 다르면 둘 다 첫 쪽의 것을 따로 쓴다 (다르지 않은 쪽은 기본과 같은 내용)
    const titlePg = !!(h.header.first || h.footer.first || hideFirst?.header || hideFirst?.footer);
    let refs = '';
    for (const kind of ['header', 'footer'] as const) {
      const def = h[kind];
      const num = numV === (kind === 'header' ? 'top' : 'bottom');
      refs += hfPart(kind, 'default', def, num);
      if (titlePg) refs += hfPart(kind, 'first', def.first || (hideFirst?.[kind] ? null : def), num && !hideFirst?.pageNum);
      if (evenOdd) refs += hfPart(kind, 'even', def.even || (def.oddOnly ? null : def), num);
    }
    return { refs, titlePg };
  };
  const docRefs = refsFor(s, s.hideFirst);
  const fmtOf = (f: string | null | undefined) => (f === 'roman' ? ' w:fmt="lowerRoman"' : f === 'ROMAN' ? ' w:fmt="upperRoman"' : '');
  /**
   * 구역 설정 하나. 첫 구역은 문서의 머리말·꼬리말과 시작 쪽 번호, 구역마다 다른 머리말이 있는 구역은 그 구역의 것
   * (그 구역의 쪽 번호 다시 시작·모양과 '첫 쪽 다르게'까지)
   */
  const sectXml = (p: PageSetup, first: boolean, hf?: SectionHf | null) => {
    const pw = p.landscape ? Math.max(p.width, p.height) : p.width;
    const ph = p.landscape ? Math.min(p.width, p.height) : p.height;
    const r = hf ? refsFor(hf, undefined) : docRefs;
    const pgNum = hf
      ? hf.start != null || hf.fmt
        ? `<w:pgNumType${fmtOf(hf.fmt)}${hf.start != null ? ` w:start="${Math.round(hf.start)}"` : ''}/>`
        : ''
      : first && (s.pageNumber.start !== 1 || fmtOf(s.pageNumber.format))
        ? `<w:pgNumType${fmtOf(s.pageNumber.format)}${s.pageNumber.start !== 1 ? ` w:start="${s.pageNumber.start}"` : ''}/>`
        : '';
    return (
      `<w:sectPr>${r.refs}<w:pgSz w:w="${mmToTwip(pw)}" w:h="${mmToTwip(ph)}"${p.landscape ? ' w:orient="landscape"' : ''}/>` +
      `<w:pgMar w:top="${mmToTwip(p.marginTop + p.marginHeader)}" w:right="${mmToTwip(p.marginRight)}" w:bottom="${mmToTwip(p.marginBottom + p.marginFooter)}" w:left="${mmToTwip(p.marginLeft)}" w:header="${mmToTwip(p.marginTop)}" w:footer="${mmToTwip(p.marginBottom)}" w:gutter="${mmToTwip(p.gutter)}"/>` +
      // sectPr 자식 차례 (스키마): … pgMar, pgBorders, lnNumType, pgNumType, cols, titlePg, docGrid
      pgBordersXml(pbd) +
      lnNumXml(s.lineNumbers) +
      pgNum +
      `${colsXml(p.columns)}${(first || hf) && r.titlePg ? '<w:titlePg/>' : ''}<w:docGrid w:linePitch="360"/></w:sectPr>`
    );
  };
  // 구역마다의 용지와 머리말: 첫 구역은 문서의 것, 그 뒤는 구역 나누기에 담긴 것
  const pages = [pg, ...sectionAt.map((x) => x.page)];
  const hfs: (SectionHf | null)[] = [null, ...sectionAt.map((x) => x.hf || null)];
  for (let k = sectionAt.length - 1; k >= 0; k--) {
    const at = sectionAt[k].index;
    const sect = sectXml(pages[k], k === 0, hfs[k]);
    // 앞 구역의 마지막 문단에 단다 (문단 속성의 끝). 바로 앞이 표이거나 문단이 없으면 빈 문단을 넣는다
    let j = at - 1;
    while (j >= 0 && !parts[j].xml) j--;
    const prev = j >= 0 ? parts[j] : null;
    const close = prev && prev.para ? prev.xml.indexOf('</w:pPr>') : -1;
    if (prev && close >= 0 && prev.xml.startsWith('<w:p><w:pPr>')) prev.xml = prev.xml.slice(0, close) + sect + prev.xml.slice(close);
    else parts.splice(at, 0, { xml: `<w:p><w:pPr>${sect}</w:pPr></w:p>`, para: true });
  }
  const body = parts.map((x) => x.xml).join('');
  const sectPr = sectXml(pages[pages.length - 1], pages.length === 1, hfs[hfs.length - 1]);

  const documentXml = DECL + `<w:document ${W_NS}>${background}<w:body>${body}${sectPr}</w:body></w:document>`;

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
  const hasEndnotes = ctx.endnotes.length > 0;
  if (hasEndnotes) {
    const sep = (type: string, id: number, tag: string) =>
      `<w:endnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${tag}/></w:r></w:p></w:endnote>`;
    const notes = ctx.endnotes
      .map(
        (t, i) =>
          `<w:endnote w:id="${i + 2}"><w:p><w:pPr><w:pStyle w:val="EndnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteRef/></w:r><w:r><w:t xml:space="preserve"> ${xmlEscape(t)}</w:t></w:r></w:p></w:endnote>`,
      )
      .join('');
    files.push(['word/endnotes.xml', DECL + `<w:endnotes ${W_NS}>${sep('separator', 0, 'separator')}${sep('continuationSeparator', 1, 'continuationSeparator')}${notes}</w:endnotes>`]);
    ctx.addRel('endnotes', 'endnotes.xml');
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

  // 기본 탭 간격: Word 문서에서 온 문단이 있으면 그 문서의 값, 아니면 Kite 의 40pt
  const tabbed = (bs: FlatBlock[]): number | null => {
    for (const b of bs) {
      const v = b.kind === 'para' ? b.style.tabs?.d ?? null : b.kind === 'box' ? tabbed(b.blocks) : b.cells.reduce<number | null>((a, row) => a ?? row.reduce<number | null>((x, c) => x ?? tabbed(c.blocks), null), null);
      if (v) return v;
    }
    return null;
  };
  const defaultTab = Math.round((tabbed(blocks) || 40) * 20);
  const settingsXml =
    DECL +
    `<w:settings ${W_NS}><w:zoom w:percent="100"/>${background ? '<w:displayBackgroundShape/>' : ''}<w:defaultTabStop w:val="${defaultTab}"/>${evenOdd ? '<w:evenAndOddHeaders/>' : ''}<w:characterSpacingControl w:val="doNotCompress"/>` +
    (hasFootnotes ? '<w:footnotePr><w:footnote w:id="0"/><w:footnote w:id="1"/></w:footnotePr>' : '') +
    (hasEndnotes ? '<w:endnotePr><w:endnote w:id="0"/><w:endnote w:id="1"/></w:endnotePr>' : '') +
    // Kite 는 문단의 위 간격과 앞 문단의 아래 간격을 더해 그린다: Word 도 그렇게 하도록 적는다 (없으면 큰 쪽만 둔다)
    `<w:compat><w:doNotUseHTMLParagraphAutoSpacing/><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

  const docRels = relsXml(ctx.rels);

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
    (hasEndnotes ? `<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>` : '') +
    (hasComments ? `<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>` : '') +
    hfOverrides.join('') +
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
/** 줄 번호 (w:lnNumType): start 는 0부터 센 값 */
function lnNumXml(ln: LineNumbering | null | undefined): string {
  if (!ln) return '';
  const restart = ln.restart === 'continue' ? 'continuous' : ln.restart === 'section' ? 'newSection' : 'newPage';
  return `<w:lnNumType w:countBy="${Math.max(1, Math.round(+ln.countBy || 1))}" w:start="${Math.max(0, Math.round(+ln.start || 1) - 1)}" w:distance="${mmToTwip(Math.max(0, +ln.distance || 0))}" w:restart="${restart}"/>`;
}

/** 쪽 테두리 (선 종류·굵기·색, 본문 또는 종이 기준 간격) */
function pgBordersXml(pb: PageBorder | null | undefined): string {
  if (!pb || !pb.sides) return '';
  const names = { t: 'top', l: 'left', b: 'bottom', r: 'right' } as const;
  const VAL: Record<string, string> = { solid: 'single', dashed: 'dashed', dotted: 'dotted', double: 'double' };
  const off = Array.isArray(pb.offset) ? pb.offset : [0, 0, 0, 0];
  const at = { l: 0, r: 1, t: 2, b: 3 } as const;
  const PT = 72 / 25.4;
  let x = '';
  for (const k of ['t', 'l', 'b', 'r'] as const) {
    const side = pb.sides[k];
    if (!side) continue;
    const sz = Math.max(2, Math.min(96, Math.round((+side.w || 0.12) * PT * 8)));
    const space = Math.max(0, Math.min(31, Math.round((+off[at[k]] || 0) * PT)));
    x += `<w:${names[k]} w:val="${VAL[side.s] || 'single'}" w:sz="${sz}" w:space="${space}" w:color="${hex(side.c)}"/>`;
  }
  if (!x) return '';
  const disp = pb.borderOn === 'first' ? ' w:display="firstPage"' : pb.borderOn === 'notFirst' ? ' w:display="notFirstPage"' : '';
  return `<w:pgBorders w:offsetFrom="${pb.body ? 'text' : 'page'}"${disp}>${x}</w:pgBorders>`;
}

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
