import JSZip from 'jszip';
import type { HeaderFooter, KDocument } from '../../types';
import { type JNode, mmToHwp, pxToHwp, ptToHwp, xmlEscape, parseBorderCss, normColor, safeIsoDate, FIXED_SPACE } from '../common';
import { type CharStyle, type FlatBlock, type FlatPara, type FlatTable, type ParaStyle, charKey, langFontIds, defaultChar, defaultPara, flattenDoc, paraKey, type FlatBox } from '../flatten';
import { prepareImage } from '../imageUtil';

/**
 * HWPX(OWPML) 쓰기. 한글 2014 이상에서 열 수 있는 최소 구성 패키지를 만든다.
 */

const NS =
  'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';

const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>';
const LANGS = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
const LANG_ATTRS = ['hangul', 'latin', 'hanja', 'japanese', 'other', 'symbol', 'user'];

const langAttrs = (v: string | number) => LANG_ATTRS.map((l) => `${l}="${v}"`).join(' ');

interface BorderFillDef {
  bg: string | null;
  noBorders: string[];
  borders: boolean; // false면 모든 선 없음
  bottomOnly?: boolean;
  css?: string | null;
}

class Registry {
  fonts: string[] = [];
  chars: CharStyle[] = [];
  charIds = new Map<string, number>();
  paras: (ParaStyle & { bfId: number })[] = [];
  paraIds = new Map<string, number>();
  borderFills: BorderFillDef[] = [];
  bfIds = new Map<string, number>();
  images: { id: string; path: string; mime: string; bytes: Uint8Array }[] = [];

  constructor() {
    // 1: 쪽 테두리(없음), 2: 글자 기본(없음), 3: 표 기본(실선)
    this.borderFill({ bg: null, noBorders: ['l', 'r', 't', 'b'], borders: false });
    this.borderFill({ bg: null, noBorders: ['l', 'r', 't', 'b'], borders: false, bottomOnly: false } as any, 'char');
    this.borderFill({ bg: null, noBorders: [], borders: true });
    this.font('함초롬바탕');
    this.font('함초롬돋움');
    this.char(defaultChar());
    this.para(defaultPara());
  }

  font(name: string): number {
    let i = this.fonts.indexOf(name);
    if (i < 0) {
      i = this.fonts.length;
      this.fonts.push(name);
    }
    return i;
  }

  char(c: CharStyle): number {
    const k = charKey(c);
    let id = this.charIds.get(k);
    if (id === undefined) {
      id = this.chars.length;
      this.chars.push(c);
      this.charIds.set(k, id);
      langFontIds(c, (n) => this.font(n));
    }
    return id;
  }

  borderFill(d: BorderFillDef, tag = ''): number {
    const k = tag + JSON.stringify(d);
    let id = this.bfIds.get(k);
    if (id === undefined) {
      this.borderFills.push(d);
      id = this.borderFills.length; // 1부터
      this.bfIds.set(k, id);
    }
    return id;
  }

  para(p: ParaStyle): number {
    const k = paraKey(p);
    let id = this.paraIds.get(k);
    if (id === undefined) {
      let bfId = 2;
      if (p.bg || p.borderBottom)
        bfId = this.borderFill({ bg: p.bg, noBorders: p.borderBottom ? ['l', 'r', 't'] : ['l', 'r', 't', 'b'], borders: p.borderBottom });
      id = this.paras.length;
      this.paras.push({ ...p, bfId });
      this.paraIds.set(k, id);
    }
    return id;
  }
}

let uid = 1000000000 + Math.floor(Math.random() * 100000000);
const nextId = () => ++uid;

function hwpAlign(a: string) {
  return ({ left: 'LEFT', right: 'RIGHT', center: 'CENTER', justify: 'JUSTIFY', distribute: 'DISTRIBUTE' } as Record<string, string>)[a] || 'JUSTIFY';
}

class SectionWriter {
  out: string[] = [];
  footnoteNo = 0;
  zOrder = 0;
  /** 머리말/꼬리말을 쓰는 중 ({{PAGE}} → 쪽 번호 필드) */
  inHF = false;
  constructor(
    private reg: Registry,
    private doc: KDocument,
    private images: Map<string, { id: string; w: number; h: number } | null>,
    private bodyWidthHwp: number,
  ) {}

  paragraph(p: FlatPara, opts: { sub: boolean; first?: boolean; extraRuns?: string }): string {
    const paraId = this.reg.para(p.style);
    const pid = opts.sub ? '2147483648' : '0';
    let xml = `<hp:p id="${pid}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${p.pageBreakBefore && !opts.sub ? 1 : 0}" columnBreak="0" merged="0">`;
    if (opts.first) xml += this.secPrRun(p);
    if (opts.extraRuns) xml += opts.extraRuns;
    xml += this.runs(p);
    xml += '</hp:p>';
    return xml;
  }

  private runs(p: FlatPara): string {
    if (!p.inlines.length) return `<hp:run charPrIDRef="${this.reg.char(p.baseChar)}"/>`;
    let xml = '';
    let curId = -1;
    let curLink: string | null = null;
    let open = false;
    let tOpen = false;
    let fieldId = 0;
    const closeT = () => {
      if (tOpen) {
        xml += '</hp:t>';
        tOpen = false;
      }
    };
    const closeRun = () => {
      closeT();
      if (open) {
        if (curLink) {
          xml += `<hp:ctrl><hp:fieldEnd beginIDRef="${fieldId}" fieldid="${fieldId}"/></hp:ctrl>`;
          curLink = null;
        }
        xml += '</hp:run>';
        open = false;
      }
    };
    const ensureRun = (charId: number, link: string | null) => {
      if (open && charId === curId && link === curLink) return;
      closeRun();
      xml += `<hp:run charPrIDRef="${charId}">`;
      open = true;
      curId = charId;
      if (link) {
        fieldId = nextId();
        const cmd = link.replace(/:/g, '\\:') + ';1;0;0;';
        xml += `<hp:ctrl><hp:fieldBegin id="${fieldId}" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="${fieldId}"><hp:parameters cnt="3" name=""><hp:integerParam name="Prop">0</hp:integerParam><hp:stringParam name="Command">${xmlEscape(cmd)}</hp:stringParam><hp:stringParam name="Path">${xmlEscape(link)}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`;
        curLink = link;
      }
    };
    const openT = () => {
      if (!tOpen) {
        xml += '<hp:t>';
        tOpen = true;
      }
    };
    for (const it of p.inlines) {
      if (it.type === 'text' && it.math && it.math.hwp.trim()) {
        // 수식: 한글 수식 개체로 (글자처럼 취급)
        ensureRun(this.reg.char({ ...it.style, italic: false }), it.link);
        closeT();
        xml += this.equation(it.math.hwp, it.style.size || 10, it.style.color || '#000000');
      } else if (it.type === 'text') {
        ensureRun(this.reg.char(it.style), it.link);
        openT();
        const parts = it.text.split('\t');
        const tb = it.tab;
        const tabXml = `<hp:tab width="${tb?.width ? pxToHwp(tb.width) : 4000}" leader="${tb?.leader || 0}" type="${tb ? tb.type : 1}"/>`;
        parts.forEach((part, i) => {
          if (i) xml += tabXml;
          // 고정폭 빈칸 (읽을 때 U+2005 로 바꾼 것)
          if (!part) return;
          const pageParts = this.inHF ? part.split('{{PAGE}}') : [part];
          pageParts.forEach((pp, k) => {
            if (k) {
              closeT();
              xml += PAGE_NUM_CTRL;
              openT();
            }
            if (pp) xml += xmlEscape(pp).split(String.fromCharCode(FIXED_SPACE)).join('<hp:fwSpace/>');
          });
        });
      } else if (it.type === 'break') {
        if (!open) ensureRun(this.reg.char(p.baseChar), null);
        openT();
        xml += '<hp:lineBreak/>';
      } else if (it.type === 'image') {
        const info = this.images.get(it.src);
        ensureRun(this.reg.char(it.style), null);
        closeT();
        if (info) xml += this.pic(info, it.width, it.height, it.crop);
      } else if (it.type === 'footnote') {
        ensureRun(this.reg.char(it.style), curLink);
        closeT();
        xml += this.footnote(it.text);
      }
    }
    closeRun();
    return xml;
  }

  private pic(info: { id: string; w: number; h: number }, wPx: number | null, hPx: number | null, crop: { t: number; r: number; b: number; l: number } | null = null): string {
    let w = wPx ? pxToHwp(wPx) : pxToHwp(info.w);
    let h = hPx ? pxToHwp(hPx) : pxToHwp(info.h);
    if (!hPx && wPx) h = Math.round((w * info.h) / Math.max(1, info.w));
    if (w > this.bodyWidthHwp) {
      h = Math.round((h * this.bodyWidthHwp) / w);
      w = this.bodyWidthHwp;
    }
    const ow = pxToHwp(info.w);
    const oh = pxToHwp(info.h);
    const c = crop || { t: 0, r: 0, b: 0, l: 0 };
    const sx = (w / Math.max(1, ow * (1 - c.l - c.r))).toFixed(6);
    const sy = (h / Math.max(1, oh * (1 - c.t - c.b))).toFixed(6);
    const clip = `left="${Math.round(ow * c.l)}" right="${Math.round(ow * (1 - c.r))}" top="${Math.round(oh * c.t)}" bottom="${Math.round(oh * (1 - c.b))}"`;
    const id = nextId();
    return (
      `<hp:pic id="${id}" zOrder="${this.zOrder++}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id - 1}" reverse="0">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${ow}" height="${oh}"/><hp:curSz width="${w}" height="${h}"/>` +
      `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="${sx}" e2="0" e3="0" e4="0" e5="${sy}" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${ow}" y="0"/><hc:pt2 x="${ow}" y="${oh}"/><hc:pt3 x="0" y="${oh}"/></hp:imgRect>` +
      `<hp:imgClip ${clip}/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:imgDim dimwidth="${ow}" dimheight="${oh}"/><hc:img binaryItemIDRef="${info.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>`
    );
  }

  /** 한글 수식 개체. 크기는 어림값이며 한글이 열 때 다시 계산한다 */
  private equation(script: string, sizePt: number, color: string): string {
    const id = nextId();
    const base = Math.round(sizePt * 100);
    const plain = script.replace(/\b(over|sqrt|root|of|from|to|LEFT|RIGHT|left|right|matrix|pmatrix|bmatrix|cases|rm|it|bold)\b|[{}~`]/g, '').replace(/\s+/g, '');
    const tall = /\b(over|matrix|pmatrix|bmatrix|dmatrix|cases|sum|int|prod|lim)\b/i.test(script);
    const w = Math.max(base, Math.round(plain.length * base * 0.55) + 200);
    const h = Math.round(base * (tall ? 2.4 : 1.25));
    return (
      `<hp:equation id="${id}" zOrder="${this.zOrder++}" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="${tall ? 65 : 86}" textColor="${xmlEscape(color)}" baseUnit="${base}" lineMode="CHAR" font="HancomEQN">` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="56" right="56" top="0" bottom="0"/><hp:shapeComment>수식입니다.</hp:shapeComment>` +
      `<hp:script>${xmlEscape(script)}</hp:script></hp:equation>`
    );
  }

  private subList(inner: string, vertAlign = 'TOP', width = 0, height = 0) {
    return `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${vertAlign}" linkListIDRef="0" linkListNextIDRef="0" textWidth="${width}" textHeight="${height}" hasTextRef="0" hasNumRef="0">${inner}</hp:subList>`;
  }

  private footnote(text: string): string {
    const n = ++this.footnoteNo;
    const c = defaultChar();
    c.size = 9;
    const charId = this.reg.char(c);
    const pp = defaultPara();
    pp.lineHeight = '1.3';
    const paraId = this.reg.para(pp);
    const inner =
      `<hp:p id="2147483648" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${charId}">` +
      `<hp:ctrl><hp:autoNum num="${n}" numType="FOOTNOTE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/></hp:autoNum></hp:ctrl>` +
      `<hp:t> ${xmlEscape(text)}</hp:t></hp:run></hp:p>`;
    return `<hp:ctrl><hp:footNote number="${n}" suffixChar="41" instId="${nextId()}">${this.subList(inner)}</hp:footNote></hp:ctrl>`;
  }

  table(t: FlatTable, sub: boolean, first = false): string {
    const totalPx = t.colWidthsPx.reduce((a, b) => a + b, 0) || 1;
    const scale = Math.min(1, this.bodyWidthHwp / pxToHwp(totalPx));
    const colW = t.colWidthsPx.map((w) => Math.round(pxToHwp(w) * scale));
    const tableW = colW.reduce((a, b) => a + b, 0);
    // 줄 높이: 지정된 줄은 그 높이, 아니면 최소값 (한글은 셀 높이를 최소 높이로 쓴다)
    const rowHs = Array.from({ length: t.rows }, (_, i) => (t.rowHeightsPx?.[i] ? Math.max(283, pxToHwp(t.rowHeightsPx[i]!) + 282) : 1000));
    const spanH = (r: number, n: number) => rowHs.slice(r, r + n).reduce((a, b) => a + b, 0);
    const id = nextId();
    let xml = `<hp:tbl id="${id}" zOrder="${this.zOrder++}" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="${t.rows}" colCnt="${t.cols}" cellSpacing="0" borderFillIDRef="3" noAdjust="0">`;
    xml += `<hp:sz width="${tableW}" widthRelTo="ABSOLUTE" height="${spanH(0, t.rows)}" heightRelTo="ABSOLUTE" protect="0"/>`;
    xml += `<hp:pos treatAsChar="${t.inline ? 1 : 0}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="${t.align === 'center' ? 'CENTER' : t.align === 'right' ? 'RIGHT' : 'LEFT'}" vertOffset="0" horzOffset="0"/>`;
    const pad = pxToHwp(t.cellPadPx);
    // 바깥 여백: 한글에서 읽은 표는 그 값, Kite 에서 만든 표는 화면과 같이 0 (HWP 와 같은 기본값)
    const om = t.outMarginPx ? t.outMarginPx.map((v) => pxToHwp(v)) : [0, 0, 0, 0];
    xml += `<hp:outMargin left="${om[0]}" right="${om[1]}" top="${om[2]}" bottom="${om[3]}"/><hp:inMargin left="${pad}" right="${pad}" top="141" bottom="141"/>`;
    for (const row of t.cells) {
      xml += '<hp:tr>';
      for (const cell of row) {
        const bf = this.reg.borderFill({ bg: cell.bg, noBorders: cell.noBorders, borders: cell.noBorders.length < 4, css: cell.borderCss });
        const w = colW.slice(cell.col, cell.col + cell.colspan).reduce((a, b) => a + b, 0);
        const inner = this.blocks(cell.blocks, true) || `<hp:p id="2147483648" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/></hp:p>`;
        const va = cell.vAlign === 'top' ? 'TOP' : cell.vAlign === 'bottom' ? 'BOTTOM' : 'CENTER';
        xml += `<hp:tc name="" header="${cell.header ? 1 : 0}" hasMargin="${cell.marginsPx ? 1 : 0}" protect="0" editable="0" dirty="0" borderFillIDRef="${bf}">`;
        xml += this.subList(inner, va);
        xml += `<hp:cellAddr colAddr="${cell.col}" rowAddr="${cell.row}"/><hp:cellSpan colSpan="${cell.colspan}" rowSpan="${cell.rowspan}"/>`;
        xml += `<hp:cellSz width="${w}" height="${spanH(cell.row, cell.rowspan)}"/>${cell.marginsPx ? `<hp:cellMargin left="${pxToHwp(cell.marginsPx[0])}" right="${pxToHwp(cell.marginsPx[1])}" top="${pxToHwp(cell.marginsPx[2])}" bottom="${pxToHwp(cell.marginsPx[3])}"/>` : `<hp:cellMargin left="${pad}" right="${pad}" top="141" bottom="141"/>`}</hp:tc>`;
      }
      xml += '</hp:tr>';
    }
    xml += '</hp:tbl>';
    const pp = defaultPara();
    // 글자처럼 놓인 표의 줄: 줄 간격이 160% 면 표 아래에 글자 크기의 60% 만큼 빈자리가 더 생긴다
    if (t.inline) pp.lineHeight = '1';
    const paraId = this.reg.para(pp);
    const pid = sub ? '2147483648' : '0';
    // 문서가 표로 시작하면 구역 정의를 표가 든 문단에 함께 둔다 (따로 빈 문단을 두면 그 줄만큼 본문이 내려간다)
    const sec = first ? this.secPrRun({ kind: 'para', style: pp, baseChar: defaultChar(), inlines: [], pageBreakBefore: false }) : '';
    return `<hp:p id="${pid}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${t.pageBreakBefore && !sub ? 1 : 0}" columnBreak="0" merged="0">${sec}<hp:run charPrIDRef="0">${xml}<hp:t/></hp:run></hp:p>`;
  }

  /** 글상자 → 사각형 도형(hp:rect) 안의 글 */
  box(b: FlatBox, sub: boolean): string {
    const W = Math.max(100, pxToHwp(b.width || 300));
    const H = Math.max(100, pxToHwp(b.height || 60));
    const id = nextId();
    const inner = this.blocks(b.blocks, true) || `<hp:p id="2147483648" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/></hp:p>`;
    const pad = (b.padding || [4, 4, 4, 4]).map((v) => pxToHwp(v));
    const lineAttrs = `endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"`;
    const line = b.borderColor
      ? `<hp:lineShape color="${b.borderColor}" width="${Math.max(1, Math.round((b.borderWidth || 1) / 0.0378))}" style="SOLID" ${lineAttrs}/>`
      : `<hp:lineShape color="#000000" width="0" style="NONE" ${lineAttrs}/>`;
    const img = b.bgImage ? this.images.get(b.bgImage) : null;
    let fill = '';
    if (img) fill = `<hp:fillBrush><hc:imgBrush mode="STRETCH"><hc:img binaryItemIDRef="${img.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/></hc:imgBrush></hp:fillBrush>`;
    else if (b.bg) fill = `<hp:fillBrush><hc:winBrush faceColor="${b.bg}" hatchColor="#FF000000" alpha="0"/></hp:fillBrush>`;
    const ratio = b.radius && b.radius.endsWith('px') && b.width && b.height ? Math.min(50, Math.round((parseFloat(b.radius) * 200) / Math.min(b.width, b.height))) : b.radius === '50%' ? 50 : 0;
    const xml =
      `<hp:rect id="${id}" zOrder="${this.zOrder++}" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id - 1}" ratio="${ratio}">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${W}" height="${H}"/><hp:curSz width="${W}" height="${H}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(W / 2)}" centerY="${Math.round(H / 2)}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
      line +
      fill +
      `<hp:drawText lastWidth="${W}" name="" editable="0"><hp:textMargin left="${pad[3]}" right="${pad[1]}" top="${pad[0]}" bottom="${pad[2]}"/>${this.subList(inner, 'TOP', Math.max(0, W - pad[1] - pad[3]), Math.max(0, H - pad[0] - pad[2]))}</hp:drawText>` +
      `<hp:sz width="${W}" widthRelTo="ABSOLUTE" height="${H}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:outMargin left="0" right="0" top="0" bottom="0"/><hc:pt0 x="0" y="0"/><hc:pt1 x="${W}" y="0"/><hc:pt2 x="${W}" y="${H}"/><hc:pt3 x="0" y="${H}"/></hp:rect>`;
    const paraId = this.reg.para(defaultPara());
    return `<hp:p id="${sub ? '2147483648' : '0'}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${b.pageBreakBefore && !sub ? 1 : 0}" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${xml}<hp:t/></hp:run></hp:p>`;
  }

  blocks(blocks: FlatBlock[], sub: boolean, firstExtra?: (p: FlatPara) => string): string {
    let xml = '';
    blocks.forEach((b, i) => {
      if (b.kind === 'para') xml += this.paragraph(b, { sub, first: !sub && i === 0 && !!firstExtra });
      else if (b.kind === 'box') xml += this.box(b, sub);
      else xml += this.table(b, sub);
    });
    return xml;
  }

  /** 첫 문단의 구역 정의 + 머리말/꼬리말/쪽 번호 컨트롤 */
  secPrRun(p: FlatPara): string {
    const s = this.doc.settings;
    const pg = s.page;
    const w = mmToHwp(pg.width);
    const h = mmToHwp(pg.height);
    const charId = this.reg.char(p.baseChar);
    let xml = `<hp:run charPrIDRef="${charId}"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">`;
    xml += `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="${s.pageNumber.start !== 1 ? s.pageNumber.start : 0}" pic="0" tbl="0" equation="0"/>`;
    xml += `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>`;
    xml += `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>`;
    xml += `<hp:pagePr landscape="${pg.landscape ? 'NARROWLY' : 'WIDELY'}" width="${w}" height="${h}" gutterType="LEFT_ONLY">`;
    xml += `<hp:margin header="${mmToHwp(pg.marginHeader)}" footer="${mmToHwp(pg.marginFooter)}" gutter="${mmToHwp(pg.gutter)}" left="${mmToHwp(pg.marginLeft)}" right="${mmToHwp(pg.marginRight)}" top="${mmToHwp(pg.marginTop)}" bottom="${mmToHwp(pg.marginBottom)}"/></hp:pagePr>`;
    xml += `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>`;
    xml += `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>`;
    for (const t of ['BOTH', 'EVEN', 'ODD'])
      xml += `<hp:pageBorderFill type="${t}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
    xml += `</hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl></hp:run>`;

    const bodyW = this.bodyWidthHwp;
    const hf = (kind: 'header' | 'footer') => {
      const def = kind === 'header' ? s.header : s.footer;
      const height0 = mmToHwp(kind === 'header' ? s.page.marginHeader : s.page.marginFooter);
      const rich = richHF(def);
      if (rich) {
        // 표·그림이 든 머리말/꼬리말: 본문과 같은 방식으로
        this.inHF = true;
        let inner = '';
        try {
          inner = this.blocks(rich, true);
        } finally {
          this.inHF = false;
        }
        if (inner) return `<hp:ctrl><hp:${kind} id="${kind === 'header' ? 0 : 1}" applyPageType="BOTH">${this.subList(inner, kind === 'header' ? 'TOP' : 'BOTTOM', bodyW, height0)}</hp:${kind}></hp:ctrl>`;
      }
      if (!def.text.trim()) return '';
      const pp = defaultPara();
      pp.align = def.align;
      const paraId = this.reg.para(pp);
      const c = defaultChar();
      c.size = 9;
      const cid = this.reg.char(c);
      const parts = def.text.split(/(\{\{PAGE\}\}|\{\{PAGES\}\})/);
      let inner = '';
      for (const part of parts) {
        if (part === '{{PAGE}}')
          inner += `<hp:ctrl><hp:autoNum num="1" numType="PAGE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl>`;
        else if (part === '{{PAGES}}') inner += `<hp:t>${this.pageCount}</hp:t>`;
        else if (part) inner += `<hp:t>${xmlEscape(part)}</hp:t>`;
      }
      const para = `<hp:p id="0" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${cid}">${inner}</hp:run></hp:p>`;
      const height = mmToHwp(kind === 'header' ? s.page.marginHeader : s.page.marginFooter);
      return `<hp:ctrl><hp:${kind} id="${kind === 'header' ? 0 : 1}" applyPageType="BOTH">${this.subList(para, kind === 'header' ? 'TOP' : 'BOTTOM', bodyW, height)}</hp:${kind}></hp:ctrl>`;
    };
    let ctrls = hf('header') + hf('footer');
    if (s.pageNumber.pos !== 'none') {
      const pos = s.pageNumber.pos.toUpperCase().replace('-', '_');
      const fmt = s.pageNumber.format === 'roman' ? 'ROMAN_SMALL' : s.pageNumber.format === 'ROMAN' ? 'ROMAN_CAPITAL' : 'DIGIT';
      const side = s.pageNumber.format === 'dash' ? '-' : '';
      ctrls += `<hp:ctrl><hp:pageNum pos="${pos}" formatType="${fmt}" sideChar="${side}"/></hp:ctrl>`;
    }
    if (ctrls) xml += `<hp:run charPrIDRef="${charId}">${ctrls}</hp:run>`;
    return xml;
  }

  pageCount = 1;
}

function headerXml(reg: Registry, pageNumChar: number | null = null): string {
  const fontsXml = LANGS.map(
    (lang) =>
      `<hh:fontface lang="${lang}" fontCnt="${reg.fonts.length}">` +
      reg.fonts
        .map(
          (f, i) =>
            `<hh:font id="${i}" face="${xmlEscape(f)}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>`,
        )
        .join('') +
      '</hh:fontface>',
  ).join('');

  const bfXml = reg.borderFills
    .map((b, i) => {
      const det = parseBorderCss(b.css);
      const TYPE: Record<string, string> = { solid: 'SOLID', dashed: 'DASH', dotted: 'DOT', double: 'DOUBLE_SLIM' };
      const side = (tag: string, s: string) => {
        const on = b.borders && !b.noBorders.includes(s);
        const d = det[s as 'l'];
        if (!on || !d) return `<hh:${tag} type="${on ? 'SOLID' : 'NONE'}" width="0.12 mm" color="#000000"/>`;
        return `<hh:${tag} type="${TYPE[d.s] || 'SOLID'}" width="${d.w} mm" color="${d.c}"/>`;
      };
      let x = `<hh:borderFill id="${i + 1}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>`;
      x += side('leftBorder', 'l') + side('rightBorder', 'r') + side('topBorder', 't') + side('bottomBorder', 'b');
      x += `<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>`;
      if (b.bg) x += `<hc:fillBrush><hc:winBrush faceColor="${normColor(b.bg) || 'none'}" hatchColor="#999999" alpha="0"/></hc:fillBrush>`;
      else if (i === 1) x += `<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush>`;
      return x + '</hh:borderFill>';
    })
    .join('');

  const charXml = reg.chars
    .map((c, i) => {
      const ids = langFontIds(c, (n) => reg.font(n));
      let x = `<hh:charPr id="${i}" height="${ptToHwp(c.size)}" textColor="${normColor(c.color) || '#000000'}" shadeColor="${normColor(c.highlight) || 'none'}" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2">`;
      x += `<hh:fontRef ${LANG_ATTRS.map((l, k) => `${l}="${ids[k]}"`).join(' ')}/><hh:ratio ${langAttrs(c.fontWidth || 100)}/><hh:spacing ${langAttrs(Math.max(-50, Math.min(50, Math.round(c.letterSpacing || 0))))}/><hh:relSz ${langAttrs(100)}/><hh:offset ${langAttrs(0)}/>`;
      if (c.italic) x += '<hh:italic/>';
      if (c.bold) x += '<hh:bold/>';
      x += `<hh:underline type="${c.underline ? 'BOTTOM' : 'NONE'}" shape="SOLID" color="#000000"/>`;
      x += `<hh:strikeout shape="${c.strike ? 'SOLID' : 'NONE'}" color="#000000"/>`;
      x += `<hh:outline type="${c.effect === 'outline' ? 'SOLID' : 'NONE'}"/>`;
      x += `<hh:shadow type="${c.effect === 'shadow' ? 'DROP' : 'NONE'}" color="#B2B2B2" offsetX="10" offsetY="10"/>`;
      if (c.effect === 'emboss') x += '<hh:emboss/>';
      if (c.effect === 'engrave') x += '<hh:engrave/>';
      if (c.sup) x += '<hh:supscript/>';
      if (c.sub) x += '<hh:subscript/>';
      return x + '</hh:charPr>';
    })
    .join('');

  const paraXml = reg.paras
    .map((p, i) => {
      let lsType = 'PERCENT';
      let lsVal = 160;
      if (/pt$/.test(p.lineHeight)) {
        lsType = 'FIXED';
        lsVal = ptToHwp(parseFloat(p.lineHeight));
      } else if (p.lineHeight) lsVal = Math.round(parseFloat(p.lineHeight) * 100) || 160;
      const m = (tag: string, v: number, k = 1) => `<hc:${tag} value="${ptToHwp(v) * k}" unit="HWPUNIT"/>`;
      // 한글과 같이 두 벌로: 글자 단위를 아는 판(값 그대로)과 기본(값 2배). 한 벌만 두면 한글이 기본 형식으로 읽어 여백이 반이 된다
      const margin = (k: number) => `<hh:margin>${m('intent', p.textIndent, k)}${m('left', p.indentLeft, k)}${m('right', p.indentRight, k)}${m('prev', p.spaceBefore, k)}${m('next', p.spaceAfter, k)}</hh:margin>`;
      const spacing = `<hh:lineSpacing type="${lsType}" value="${lsVal}" unit="HWPUNIT"/>`;
      return (
        `<hh:paraPr id="${i}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">` +
        `<hh:align horizontal="${hwpAlign(p.align)}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/>` +
        `<hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="${p.breakChar ? 'KEEP_WORD' : 'BREAK_WORD'}" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>` +
        `<hh:autoSpacing eAsianEng="0" eAsianNum="0"/>` +
        `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin(1)}${spacing}</hp:case><hp:default>${margin(2)}${spacing}</hp:default></hp:switch>` +
        `<hh:border borderFillIDRef="${p.bfId}" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`
      );
    })
    .join('');

  const numbering =
    `<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">` +
    [
      ['1', 'DIGIT', '^1.'],
      ['2', 'HANGUL_SYLLABLE', '^2.'],
      ['3', 'DIGIT', '^3)'],
      ['4', 'HANGUL_SYLLABLE', '^4)'],
      ['5', 'DIGIT', '(^5)'],
      ['6', 'HANGUL_SYLLABLE', '(^6)'],
      ['7', 'CIRCLED_DIGIT', '^7'],
    ]
      .map(
        ([lv, fmt, txt]) =>
          `<hh:paraHead start="1" level="${lv}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="${fmt}" charPrIDRef="4294967295" checkable="${lv === '7' ? 1 : 0}">${txt}</hh:paraHead>`,
      )
      .join('') +
    `</hh:numbering></hh:numberings>`;

  return (
    // 한글 2018 과 같은 1.4: 1.2 로 두면 한글이 문단 여백(hp:switch 의 값)을 반으로 읽는다
    XML_DECL +
    `<hh:head ${NS} version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>` +
    `<hh:fontfaces itemCnt="7">${fontsXml}</hh:fontfaces>` +
    `<hh:borderFills itemCnt="${reg.borderFills.length}">${bfXml}</hh:borderFills>` +
    `<hh:charProperties itemCnt="${reg.chars.length}">${charXml}</hh:charProperties>` +
    `<hh:tabProperties itemCnt="3"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/><hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/><hh:tabPr id="2" autoTabLeft="0" autoTabRight="1"/></hh:tabProperties>` +
    numbering +
    `<hh:paraProperties itemCnt="${reg.paras.length}">${paraXml}</hh:paraProperties>` +
    `<hh:styles itemCnt="${pageNumChar == null ? 1 : 2}"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>` +
    // 쪽 번호는 '쪽 번호' 스타일의 글자 모양으로 찍힌다 (한글도, Kite 도)
    (pageNumChar == null ? '' : `<hh:style id="1" type="PARA" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="${pageNumChar}" nextStyleIDRef="1" langID="1042" lockForm="0"/>`) +
    `</hh:styles>` +
    `</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>` +
    `<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`
  );
}

function collectImageSrcs(blocks: FlatBlock[], out: Set<string>) {
  for (const b of blocks) {
    if (b.kind === 'para') {
      for (const i of b.inlines) if (i.type === 'image' && i.src) out.add(i.src);
    } else if (b.kind === 'box') {
      if (b.bgImage) out.add(b.bgImage);
      collectImageSrcs(b.blocks, out);
    } else for (const row of b.cells) for (const c of row) collectImageSrcs(c.blocks, out);
  }
}

function previewText(blocks: FlatBlock[]): string {
  const lines: string[] = [];
  const walk = (bs: FlatBlock[]) => {
    for (const b of bs) {
      if (lines.join('\n').length > 1000) return;
      if (b.kind === 'para') lines.push(b.inlines.map((i) => (i.type === 'text' ? i.text : '')).join(''));
      else if (b.kind === 'box') walk(b.blocks);
      else for (const row of b.cells) lines.push(row.map((c) => `<${c.blocks.map((x) => (x.kind === 'para' ? x.inlines.map((i) => (i.type === 'text' ? i.text : '')).join('') : '')).join(' ')}>`).join(''));
    }
  };
  walk(blocks);
  return lines.join('\r\n').slice(0, 1024);
}

const PAGE_NUM_CTRL = `<hp:ctrl><hp:autoNum num="1" numType="PAGE"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl>`;

/** 표·그림이 든 머리말/꼬리말의 블록 (없으면 null) */
function richHF(def: HeaderFooter): FlatBlock[] | null {
  if (!Array.isArray(def.content) || !def.content.length) return null;
  try {
    return flattenDoc({ type: 'doc', content: def.content } as JNode);
  } catch {
    return null;
  }
}

export async function writeHwpx(doc: KDocument, opts: { pageCount?: number } = {}): Promise<Uint8Array> {
  const blocks = flattenDoc(doc.content as JNode);
  if (!blocks.length || (blocks[0].kind !== 'para' && blocks[0].kind !== 'table')) {
    const p: FlatPara = { kind: 'para', style: defaultPara(), baseChar: defaultChar(), inlines: [], pageBreakBefore: false };
    blocks.unshift(p);
  }
  const reg = new Registry();
  const pg = doc.settings.page;
  const pageW = pg.landscape ? Math.max(pg.width, pg.height) : pg.width;
  const bodyWidthHwp = mmToHwp(pageW - pg.marginLeft - pg.marginRight - pg.gutter);

  // 그림 준비
  const srcs = new Set<string>();
  collectImageSrcs(blocks, srcs);
  for (const hf of [doc.settings.header, doc.settings.footer]) collectImageSrcs(richHF(hf) || [], srcs);
  const imageInfo = new Map<string, { id: string; w: number; h: number } | null>();
  let imgNo = 0;
  for (const src of srcs) {
    const prep = await prepareImage(src);
    if (!prep) {
      imageInfo.set(src, null);
      continue;
    }
    imgNo++;
    const id = `image${imgNo}`;
    const path = `BinData/${id}.${prep.ext}`;
    reg.images.push({ id, path, mime: prep.mime === 'image/jpeg' ? 'image/jpg' : prep.mime, bytes: prep.bytes });
    imageInfo.set(src, { id, w: prep.width, h: prep.height });
  }

  const sw = new SectionWriter(reg, doc, imageInfo, bodyWidthHwp);
  sw.pageCount = opts.pageCount || 1;
  let body = '';
  blocks.forEach((b, i) => {
    if (b.kind === 'para') body += sw.paragraph(b, { sub: false, first: i === 0 });
    else if (b.kind === 'box') body += sw.box(b, false);
    else body += sw.table(b, false, i === 0);
  });
  const section = XML_DECL + `<hs:sec ${NS}>${body}</hs:sec>`;
  const pn = doc.settings.pageNumber;
  const pnChar = pn.fontSize && pn.fontSize > 0 ? reg.char({ ...defaultChar(), font: pn.fontFamily || '함초롬돋움', size: pn.fontSize, bold: !!pn.bold, italic: !!pn.italic, color: pn.color || '#000000' }) : null;
  const header = headerXml(reg, pnChar);

  const meta = doc.meta;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const manifestItems =
    `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>` +
    reg.images.map((im) => `<opf:item id="${im.id}" href="${im.path}" media-type="${im.mime}" isEmbeded="1"/>`).join('') +
    `<opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>` +
    `<opf:item id="settings" href="settings.xml" media-type="application/xml"/>`;
  const hpf =
    XML_DECL +
    `<opf:package ${NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${xmlEscape(meta.title || '')}</opf:title><opf:language>ko</opf:language>` +
    `<opf:meta name="creator" content="text">${xmlEscape(meta.author || '')}</opf:meta><opf:meta name="subject" content="text">${xmlEscape(meta.subject || '')}</opf:meta>` +
    `<opf:meta name="description" content="text"/><opf:meta name="lastsaveby" content="text">${xmlEscape(meta.author || '')}</opf:meta>` +
    `<opf:meta name="CreatedDate" content="text">${safeIsoDate(meta.created, now)}</opf:meta><opf:meta name="ModifiedDate" content="text">${now}</opf:meta>` +
    `<opf:meta name="keyword" content="text">${xmlEscape(meta.keywords || '')}</opf:meta></opf:metadata>` +
    `<opf:manifest>${manifestItems}</opf:manifest><opf:spine><opf:itemref idref="header" linear="yes"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`;

  const zip = new JSZip();
  const add = zip.file.bind(zip);
  (zip as any).file = (name: string, data: any, o: any = {}) => add(name, data, { createFolders: false, ...o });
  zip.file('mimetype', 'application/hwp+zip', { compression: 'STORE' });
  zip.file(
    'version.xml',
    XML_DECL +
      `<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.4" application="Hancom Office Hangul" appVersion="11, 0, 0, 2129 WIN32LEWindows_8"/>`,
    { compression: 'STORE' },
  );
  zip.file('Contents/header.xml', header);
  zip.file('Contents/section0.xml', section);
  zip.file('Preview/PrvText.txt', previewText(blocks));
  zip.file(
    'settings.xml',
    XML_DECL +
      `<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`,
  );
  zip.file(
    'META-INF/container.xml',
    XML_DECL +
      `<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/><ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/><ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/></ocf:rootfiles></ocf:container>`,
  );
  zip.file(
    'META-INF/container.rdf',
    XML_DECL +
      `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description><rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description><rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description><rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description><rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description></rdf:RDF>`,
  );
  zip.file('META-INF/manifest.xml', XML_DECL + `<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`);
  zip.file('Contents/content.hpf', hpf);
  for (const im of reg.images) zip.file(im.path, im.bytes, { compression: 'STORE' });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 }, mimeType: 'application/hwp+zip' });
}
