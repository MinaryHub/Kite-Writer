import JSZip from 'jszip';
import type { Columns, HeaderFooter, KDocument } from '../../types';
import { type JNode, mmToHwp, pxToHwp, ptToHwp, xmlEscape, parseBorderCss, paraBorderToFill, normColor, safeIsoDate, cleanColumns, FIXED_SPACE } from '../common';
import type { PicLook } from '../picLook';
import { type CharStyle, type FlatBlock, type FlatFloat, type FlatPara, type FlatTable, type ParaStyle, charKey, langFontIds, defaultChar, defaultPara, flattenContent, flattenDoc, paraKey, type FlatBox } from '../flatten';
import { prepareImage } from '../imageUtil';
import { shapeImageSrcs, shapeXml } from './shapeWriter';

const PT2PX = 96 / 72;
/** 음수는 한글처럼 부호 없는 32비트로 */
const u32s = (v: number) => (Math.round(v) >>> 0).toString();

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
  /** 그림 채우기: BinData id 와 채우는 방식 (쪽 배경) */
  img?: { id: string; mode: string } | null;
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
  /** 변경 추적: 바뀐 내용(hh:trackChange, id 는 1부터)과 사람(hh:trackChangeAuthor, id 는 1부터) */
  changes: { type: 'ins' | 'del'; author: number; time: number }[] = [];
  changeIds = new Map<string, number>();
  authors: string[] = [];

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

  /** 바뀐 내용 하나의 id (같은 종류·사람·시각이면 같은 id) */
  change(c: { type: 'ins' | 'del'; author: string; time: number }): number {
    const key = `${c.type}|${c.author}|${c.time}`;
    let id = this.changeIds.get(key);
    if (id == null) {
      let a = this.authors.indexOf(c.author);
      if (a < 0) {
        a = this.authors.length;
        this.authors.push(c.author);
      }
      this.changes.push({ type: c.type, author: a + 1, time: c.time });
      id = this.changes.length;
      this.changeIds.set(key, id);
    }
    return id;
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
      if (p.border) {
        const f = paraBorderToFill(p.border);
        bfId = this.borderFill({ bg: p.bg, noBorders: f.noBorders, borders: f.noBorders.length < 4, css: f.css });
      } else if (p.bg || p.borderBottom)
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

  /**
   * 개체의 자리 (본문과의 배치, hp:pos, hp:outMargin). 떠 있는 개체는 한글에서 읽은 자리 값(hw)을 그대로 되돌려 쓰고,
   * 없으면 문단 기준 오프셋으로 쓴다 (paraLeft: 문단 상자 왼쪽, sb: 문단 위 간격 px). 떠 있지 않으면 글자처럼 취급
   */
  private place(fl: FlatFloat | null | undefined, paraLeft = 0, sb = 0, inlineAlign = 'LEFT'): { wrap: string; tail: string } {
    if (!fl) {
      return {
        wrap: 'TOP_AND_BOTTOM',
        tail:
          `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="${inlineAlign}" vertOffset="0" horzOffset="0"/>` +
          `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`,
      };
    }
    const hw = fl.hw || {
      // Word 문서의 둘레 글 흐름은 한글의 어울림·자리 차지로 (바깥 여백: 왼쪽·오른쪽·위·아래)
      wrap: fl.wrap ? (fl.wrap.s === 'tb' ? 'TOP_AND_BOTTOM' : 'SQUARE') : fl.behind ? 'BEHIND_TEXT' : 'IN_FRONT_OF_TEXT',
      vr: 'PARA',
      hr: 'COLUMN',
      va: 'TOP',
      ha: 'LEFT',
      vo: Math.max(0, pxToHwp(fl.y - sb)),
      ho: pxToHwp(fl.x + paraLeft),
      om: fl.wrap ? [fl.wrap.d[3], fl.wrap.d[1], fl.wrap.d[0], fl.wrap.d[2]].map((v) => Math.min(60000, pxToHwp(v))) : [0, 0, 0, 0],
    };
    const om = hw.om || [0, 0, 0, 0];
    const overlay = hw.wrap === 'IN_FRONT_OF_TEXT' || hw.wrap === 'BEHIND_TEXT';
    return {
      wrap: hw.wrap,
      tail:
        `<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="${overlay ? 0 : 1}" allowOverlap="${overlay ? 1 : 0}" holdAnchorAndSO="0" vertRelTo="${hw.vr}" horzRelTo="${hw.hr}" vertAlign="${hw.va}" horzAlign="${hw.ha}" vertOffset="${u32s(hw.vo)}" horzOffset="${u32s(hw.ho)}"/>` +
        `<hp:outMargin left="${om[0]}" right="${om[1]}" top="${om[2]}" bottom="${om[3]}"/>`,
    };
  }

  /** 그리기 개체 (선·사각형·타원·다각형·곡선·묶음) */
  private shape(it: Extract<FlatPara['inlines'][number], { type: 'shape' }>, p: FlatPara): string {
    const pl = this.place(it.float, (p.style.indentLeft + Math.max(0, -p.style.textIndent)) * PT2PX, p.style.spaceBefore * PT2PX);
    const frame = `<hp:sz width="${pxToHwp(it.width)}" widthRelTo="ABSOLUTE" height="${pxToHwp(it.height)}" heightRelTo="ABSOLUTE" protect="0"/>${pl.tail}`;
    return shapeXml(it.d, it.width, it.height, pl.wrap, frame, {
      nextId,
      zOrder: () => this.zOrder++,
      image: (src) => this.images.get(src) || null,
      textXml: (content) => this.blocks(flattenContent(content), true),
      subList: (inner, va, w, h) => this.subList(inner, va, w, h),
    });
  }

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
    // 변경 추적 구간 (hp:t 안의 insertBegin~insertEnd, deleteBegin~deleteEnd). 문단 끝에서 닫는다
    let chKey = '';
    let chTag = '';
    let chId = 0;
    const endChange = () => {
      if (!chKey) return;
      openT();
      xml += `<hp:${chTag}End Id="${chId}" TcId="${chId}" paraend="0"/>`;
      chKey = '';
    };
    const toChange = (ch: { type: 'ins' | 'del'; author: string; time: number } | undefined) => {
      const key = ch ? `${ch.type}|${ch.author}|${ch.time}` : '';
      if (key === chKey) return;
      endChange();
      if (!ch) return;
      chId = this.reg.change(ch);
      chTag = ch.type === 'ins' ? 'insert' : 'delete';
      chKey = key;
      openT();
      xml += `<hp:${chTag}Begin Id="${chId}" TcId="${chId}"/>`;
    };
    for (const it of p.inlines) {
      if (it.type === 'text' && it.math && it.math.hwp.trim()) {
        // 수식: 한글 수식 개체로 (글자처럼 취급)
        ensureRun(this.reg.char({ ...it.style, italic: false }), it.link);
        closeT();
        xml += this.equation(it.math.hwp, it.style.size || 10, it.style.color || '#000000');
      } else if (it.type === 'text' && it.ruby) {
        // 덧말: 본말 위(아래)의 작은 글
        ensureRun(this.reg.char(it.style), it.link);
        closeT();
        xml += `<hp:dutmal posType="${it.ruby.pos === 'bottom' ? 'BOTTOM' : 'TOP'}" szRatio="0" option="0" styleIDRef="0" align="CENTER"><hp:mainText>${xmlEscape(it.text)}</hp:mainText><hp:subText>${xmlEscape(it.ruby.text)}</hp:subText></hp:dutmal>`;
      } else if (it.type === 'text' && it.compose) {
        // 글자 겹침: 겹칠 글자와 테두리 모양, 글자 모양 (열 칸 가운데 첫 칸만 쓴다)
        const cid = this.reg.char(it.style);
        ensureRun(cid, it.link);
        closeT();
        xml += `<hp:compose circleType="${it.compose}" charSz="-3" composeType="SPREAD" charPrCnt="10" composeText="${xmlEscape(it.text)}"><hp:charPr prIDRef="${cid}"/>${'<hp:charPr prIDRef="4294967295"/>'.repeat(9)}</hp:compose>`;
      } else if (it.type === 'text') {
        ensureRun(this.reg.char(it.style), it.link);
        openT();
        toChange(it.review?.change);
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
        if (info) xml += this.pic(info, it.width, it.height, it.crop, it.float ? this.place(it.float, (p.style.indentLeft + Math.max(0, -p.style.textIndent)) * PT2PX, p.style.spaceBefore * PT2PX) : null, it.rotate || 0, it.look || null);
      } else if (it.type === 'shape') {
        ensureRun(this.reg.char(it.style), null);
        closeT();
        xml += this.shape(it, p);
      } else if (it.type === 'footnote') {
        ensureRun(this.reg.char(it.style), curLink);
        closeT();
        xml += this.footnote(it.text);
      }
    }
    if (chKey) {
      if (!open) ensureRun(this.reg.char(p.baseChar), null);
      endChange();
    }
    closeRun();
    return xml;
  }

  private pic(info: { id: string; w: number; h: number }, wPx: number | null, hPx: number | null, crop: { t: number; r: number; b: number; l: number } | null = null, pl: { wrap: string; tail: string } | null = null, rotate = 0, look: PicLook | null = null): string {
    let w = wPx ? pxToHwp(wPx) : pxToHwp(info.w);
    let h = hPx ? pxToHwp(hPx) : pxToHwp(info.h);
    if (!hPx && wPx) h = Math.round((w * info.h) / Math.max(1, info.w));
    // 떠 있는 그림은 본문 폭을 넘을 수 있다 (종이 기준으로 놓인 배경 그림 등)
    if (w > this.bodyWidthHwp && !pl) {
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
    const place = pl || this.place(null);
    // 돌린 그림: 가운데를 중심으로 도는 회전 행렬
    const rad = (rotate * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = w / 2;
    const cy = h / 2;
    const rot = rotate ? `e1="${cos.toFixed(6)}" e2="${(-sin).toFixed(6)}" e3="${(cx - cos * cx + sin * cy).toFixed(3)}" e4="${sin.toFixed(6)}" e5="${cos.toFixed(6)}" e6="${(cy - sin * cx - cos * cy).toFixed(3)}"` : `e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"`;
    return (
      `<hp:pic id="${id}" zOrder="${this.zOrder++}" numberingType="PICTURE" textWrap="${place.wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id - 1}" reverse="0">` +
      `<hp:offset x="0" y="0"/><hp:orgSz width="${ow}" height="${oh}"/><hp:curSz width="${w}" height="${h}"/>` +
      `<hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="${Math.round(rotate)}" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="${sx}" e2="0" e3="0" e4="0" e5="${sy}" e6="0"/><hc:rotMatrix ${rot}/></hp:renderingInfo>` +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${ow}" y="0"/><hc:pt2 x="${ow}" y="${oh}"/><hc:pt3 x="0" y="${oh}"/></hp:imgRect>` +
      `<hp:imgClip ${clip}/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:imgDim dimwidth="${ow}" dimheight="${oh}"/><hc:img binaryItemIDRef="${info.id}" bright="${Math.round(look?.bright || 0)}" contrast="${Math.round(look?.contrast || 0)}" effect="${look?.gray === 1 ? 'GRAY_SCALE' : look?.gray === 2 ? 'BLACK_WHITE' : 'REAL_PIC'}" alpha="${look?.alpha ? Math.round(look.alpha * 255) : 0}"/><hp:effects/>` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      `${place.tail}</hp:pic>`
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

  table(t: FlatTable, sub: boolean, first = false, extraRuns = ''): string {
    const xml = this.tableXml(t);
    const pp = defaultPara();
    // 글자처럼 놓인 표의 줄: 줄 간격이 160% 면 표 아래에 글자 크기의 60% 만큼 빈자리가 더 생긴다
    if (t.inline) pp.lineHeight = '1';
    const paraId = this.reg.para(pp);
    const pid = sub ? '2147483648' : '0';
    // 문서가 표로 시작하면 구역 정의를 표가 든 문단에 함께 둔다 (따로 빈 문단을 두면 그 줄만큼 본문이 내려간다)
    const sec = first ? this.secPrRun({ kind: 'para', style: pp, baseChar: defaultChar(), inlines: [], pageBreakBefore: false }) : '';
    return `<hp:p id="${pid}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${t.pageBreakBefore && !sub ? 1 : 0}" columnBreak="0" merged="0">${sec}${extraRuns}<hp:run charPrIDRef="0">${xml}<hp:t/></hp:run></hp:p>`;
  }

  /** 표 개체 (hp:tbl). pl 이 있으면 그 자리에 떠 있는 표 */
  private tableXml(t: FlatTable, pl: { wrap: string; tail: string } | null = null): string {
    const totalPx = t.colWidthsPx.reduce((a, b) => a + b, 0) || 1;
    const scale = Math.min(1, this.bodyWidthHwp / pxToHwp(totalPx));
    const colW = t.colWidthsPx.map((w) => Math.round(pxToHwp(w) * scale));
    const tableW = colW.reduce((a, b) => a + b, 0);
    // 줄 높이: 지정된 줄은 그 높이, 아니면 최소값 (한글은 셀 높이를 최소 높이로 쓴다)
    const rowHs = Array.from({ length: t.rows }, (_, i) => (t.rowHeightsPx?.[i] ? Math.max(283, pxToHwp(t.rowHeightsPx[i]!) + 282) : 1000));
    const spanH = (r: number, n: number) => rowHs.slice(r, r + n).reduce((a, b) => a + b, 0);
    const id = nextId();
    let xml = `<hp:tbl id="${id}" zOrder="${this.zOrder++}" numberingType="TABLE" textWrap="${pl ? pl.wrap : 'TOP_AND_BOTTOM'}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="${t.pageSplit === 'row' ? 'TABLE' : t.pageSplit === 'none' ? 'NONE' : 'CELL'}" repeatHeader="1" rowCnt="${t.rows}" colCnt="${t.cols}" cellSpacing="0" borderFillIDRef="3" noAdjust="0">`;
    xml += `<hp:sz width="${tableW}" widthRelTo="ABSOLUTE" height="${spanH(0, t.rows)}" heightRelTo="ABSOLUTE" protect="0"/>`;
    const pad = pxToHwp(t.cellPadPx);
    if (pl) xml += pl.tail;
    else {
      xml += `<hp:pos treatAsChar="${t.inline ? 1 : 0}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="${t.align === 'center' ? 'CENTER' : t.align === 'right' ? 'RIGHT' : 'LEFT'}" vertOffset="0" horzOffset="0"/>`;
      // 바깥 여백: 한글에서 읽은 표는 그 값, Kite 에서 만든 표는 화면과 같이 0 (HWP 와 같은 기본값)
      const om = t.outMarginPx ? t.outMarginPx.map((v) => pxToHwp(v)) : [0, 0, 0, 0];
      xml += `<hp:outMargin left="${om[0]}" right="${om[1]}" top="${om[2]}" bottom="${om[3]}"/>`;
    }
    xml += `<hp:inMargin left="${pad}" right="${pad}" top="141" bottom="141"/>`;
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
    return xml;
  }

  /** 글상자 → 사각형 도형(hp:rect) 안의 글 */
  box(b: FlatBox, sub: boolean, extraRuns = ''): string {
    const paraId = this.reg.para(defaultPara());
    return `<hp:p id="${sub ? '2147483648' : '0'}" paraPrIDRef="${paraId}" styleIDRef="0" pageBreak="${b.pageBreakBefore && !sub ? 1 : 0}" columnBreak="0" merged="0">${extraRuns}<hp:run charPrIDRef="0">${this.boxXml(b)}<hp:t/></hp:run></hp:p>`;
  }

  /** 떠 있는 블록(글상자, 떠 있는 표를 담은 상자)을 뒤따르는 문단에 넣을 run 으로 */
  private floatRun(b: FlatBox): string {
    const pl = this.place(b.float);
    // 선·바탕 없는 상자에 표 하나: 떠 있는 표 (글 앞·글 뒤로 놓인 표)
    const only = b.blocks.length === 1 ? b.blocks[0] : null;
    if (only && only.kind === 'table' && !b.borderColor && !b.bg && !b.bgImage) return `<hp:run charPrIDRef="0">${this.tableXml(only, pl)}</hp:run>`;
    return `<hp:run charPrIDRef="0">${this.boxXml(b, pl)}</hp:run>`;
  }

  /** 사각형·타원 도형(hp:rect, hp:ellipse) 안의 글. pl 이 있으면 그 자리에 떠 있는 글상자 */
  private boxXml(b: FlatBox, pl: { wrap: string; tail: string } | null = null): string {
    const W = Math.max(100, pxToHwp(b.width || 300));
    const H = Math.max(100, pxToHwp(b.height || 60));
    const id = nextId();
    const inner = this.blocks(b.blocks, true) || `<hp:p id="2147483648" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/></hp:p>`;
    const pad = (b.padding || [4, 4, 4, 4]).map((v) => pxToHwp(v));
    const lineAttrs = `endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="SMALL_SMALL" tailSz="SMALL_SMALL" outlineStyle="NORMAL" alpha="0"`;
    // 선 굵기는 HWPUNIT (33 ≈ 0.12mm)
    const line = b.borderColor
      ? `<hp:lineShape color="${b.borderColor}" width="${Math.max(1, pxToHwp(b.borderWidth && b.borderWidth > 0.8 ? b.borderWidth : 0.44))}" style="${b.borderDash || 'SOLID'}" ${lineAttrs}/>`
      : `<hp:lineShape color="#000000" width="0" style="NONE" ${lineAttrs}/>`;
    const img = b.bgImage ? this.images.get(b.bgImage) : null;
    let fill = '';
    if (img) fill = `<hc:fillBrush><hc:imgBrush mode="TOTAL"><hc:img binaryItemIDRef="${img.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/></hc:imgBrush></hc:fillBrush>`;
    else if (b.bg) fill = `<hc:fillBrush><hc:winBrush faceColor="${b.bg}" hatchColor="#000000" alpha="0"/></hc:fillBrush>`;
    const ellipse = b.radius === '50%';
    // 모서리 곡률(%): 50 이 반원
    const ratio = b.radius && b.radius.endsWith('px') && b.width && b.height ? Math.min(50, Math.round((parseFloat(b.radius) * 100) / Math.min(b.width, b.height))) : 0;
    const place = pl || this.place(null);
    const va = b.valign === 'middle' ? 'CENTER' : b.valign === 'bottom' ? 'BOTTOM' : 'TOP';
    const common =
      `<hp:offset x="0" y="0"/><hp:orgSz width="${W}" height="${H}"/><hp:curSz width="${W}" height="${H}"/><hp:flip horizontal="0" vertical="0"/><hp:rotationInfo angle="0" centerX="${Math.round(W / 2)}" centerY="${Math.round(H / 2)}" rotateimage="1"/>` +
      `<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>` +
      line +
      fill +
      `<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>` +
      `<hp:drawText lastWidth="${W}" name="" editable="0">${this.subList(inner, va, Math.max(0, W - pad[1] - pad[3]), Math.max(0, H - pad[0] - pad[2]))}<hp:textMargin left="${pad[3]}" right="${pad[1]}" top="${pad[0]}" bottom="${pad[2]}"/></hp:drawText>`;
    const frame = `<hp:sz width="${W}" widthRelTo="ABSOLUTE" height="${H}" heightRelTo="ABSOLUTE" protect="0"/>${place.tail}`;
    const head = `id="${id}" zOrder="${this.zOrder++}" numberingType="PICTURE" textWrap="${place.wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id - 1}"`;
    if (ellipse)
      return (
        `<hp:ellipse ${head} intervalDirty="0" hasArcPr="0" arcType="NORMAL">${common}` +
        `<hc:center x="${Math.round(W / 2)}" y="${Math.round(H / 2)}"/><hc:ax1 x="${W}" y="${Math.round(H / 2)}"/><hc:ax2 x="${Math.round(W / 2)}" y="0"/><hc:start1 x="0" y="0"/><hc:end1 x="0" y="0"/><hc:start2 x="0" y="0"/><hc:end2 x="0" y="0"/>${frame}</hp:ellipse>`
      );
    return `<hp:rect ${head} ratio="${ratio}">${common}<hc:pt0 x="0" y="0"/><hc:pt1 x="${W}" y="0"/><hc:pt2 x="${W}" y="${H}"/><hc:pt3 x="0" y="${H}"/>${frame}</hp:rect>`;
  }

  /**
   * 블록들을 쓴다. 떠 있는 블록(글상자·떠 있는 표)은 한글처럼 뒤따르는 문단 안의 개체로 넣는다 (따로 문단을 세우면 빈 줄이 생긴다).
   * first: 첫 문단에 구역 정의를 넣는다 (본문 최상위)
   */
  blocks(blocks: FlatBlock[], sub: boolean, first = false): string {
    let xml = '';
    let pending = '';
    let begun = false;
    // 떠 있는 블록에 달린 감추기는 뒤따르는 문단으로 넘긴다
    let pendingHide = '';
    for (const b of blocks) {
      if (b.kind === 'box' && b.float) {
        pending += this.floatRun(b);
        pendingHide += b.pageHide || '';
        continue;
      }
      const isFirst = first && !begun;
      begun = true;
      // 다단 설정 나누기: 앞 다단과 다를 때만 이 문단에 다단 정의를 넣는다 (본문 최상위에서만)
      let colRun = '';
      if (!sub && !isFirst && b.columnsBefore && colKey(b.columnsBefore) !== this.curCols) {
        this.curCols = colKey(b.columnsBefore);
        colRun = `<hp:run charPrIDRef="0"><hp:ctrl>${colPrXml(b.columnsBefore)}</hp:ctrl></hp:run>`;
      }
      // 감추기: 이 문단이 놓인 쪽에서 감출 것
      const hide = (b.pageHide || '') + pendingHide;
      pendingHide = '';
      if (hide && !sub) {
        const on = (c: string) => (hide.includes(c) ? 1 : 0);
        colRun += `<hp:run charPrIDRef="0"><hp:ctrl><hp:pageHiding hideHeader="${on('h')}" hideFooter="${on('f')}" hideMasterPage="${on('m')}" hideBorder="${on('b')}" hideFill="${on('x')}" hidePageNum="${on('n')}"/></hp:ctrl></hp:run>`;
      }
      let bx: string;
      if (b.kind === 'para') bx = this.paragraph(b, { sub, first: isFirst, extraRuns: colRun + pending });
      else if (b.kind === 'box') {
        // 문서가 글상자로 시작하면 구역 정의를 담을 빈 문단을 앞에 둔다
        if (isFirst) xml += this.paragraph({ kind: 'para', style: defaultPara(), baseChar: defaultChar(), inlines: [], pageBreakBefore: false }, { sub, first: true });
        bx = this.box(b, sub, colRun + pending);
      } else bx = this.table(b, sub, isFirst, colRun + pending);
      // 단 나누기 (블록을 담은 문단의 속성)
      if (!sub && !isFirst && b.columnBreakBefore) bx = bx.replace('columnBreak="0"', 'columnBreak="1"');
      xml += bx;
      pending = '';
    }
    // 뒤따르는 문단이 없는 떠 있는 블록: 빈 문단에 담는다
    if (pending || (first && !begun)) xml += this.paragraph({ kind: 'para', style: defaultPara(), baseChar: defaultChar(), inlines: [], pageBreakBefore: false }, { sub, first: first && !begun, extraRuns: pending });
    return xml;
  }

  /** 지금까지 쓴 다단 (다단 설정 나누기를 앞 다단과 다를 때만 쓴다) */
  private curCols = '1';

  /** 첫 문단의 구역 정의 + 머리말/꼬리말/쪽 번호 컨트롤 */
  secPrRun(p: FlatPara): string {
    const s = this.doc.settings;
    const pg = s.page;
    const w = mmToHwp(pg.width);
    const h = mmToHwp(pg.height);
    const charId = this.reg.char(p.baseChar);
    // 쪽 테두리/배경과 바탕쪽
    const pb = s.pageBorder;
    const vis = (v: 'first' | 'notFirst' | null | undefined) => (v === 'first' ? 'SHOW_FIRST' : v === 'notFirst' ? 'HIDE_FIRST' : 'SHOW_ALL');
    this.masterXml = [];
    for (const mp of s.masterPages || []) {
      const blocks = flattenContent((mp.content || []) as any);
      const inner = blocks.length ? this.blocks(blocks, true) : '';
      if (!inner) continue;
      const id = `masterpage${this.masterXml.length}`;
      const pgH = pg.landscape ? Math.min(pg.width, pg.height) : pg.height;
      const bodyH = mmToHwp(pgH - pg.marginTop - pg.marginBottom - pg.marginHeader - pg.marginFooter);
      this.masterXml.push({ id, xml: `<masterPage ${NS} id="${id}" type="${mp.type === 'even' ? 'EVEN' : mp.type === 'odd' ? 'ODD' : 'BOTH'}" pageNumber="0" pageDuplicate="0" pageFront="0">${this.subList(inner, 'TOP', this.bodyWidthHwp, bodyH)}</masterPage>` });
    }
    let xml = `<hp:run charPrIDRef="${charId}"><hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="${this.masterXml.length}">`;
    xml += `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="${s.pageNumber.start !== 1 ? s.pageNumber.start : 0}" pic="0" tbl="0" equation="0"/>`;
    xml += `<hp:visibility hideFirstHeader="${s.hideFirst?.header ? 1 : 0}" hideFirstFooter="${s.hideFirst?.footer ? 1 : 0}" hideFirstMasterPage="${s.hideFirst?.masterPage ? 1 : 0}" border="${vis(pb?.borderOn)}" fill="${vis(pb?.fillOn)}" hideFirstPageNum="${s.hideFirst?.pageNum ? 1 : 0}" hideFirstEmptyLine="0" showLineNumber="${s.lineNumbers ? 1 : 0}"/>`;
    // 줄 번호 (새로 시작: 1 쪽마다, 2 구역마다, 3 이어서)
    const ln = s.lineNumbers;
    xml += ln
      ? `<hp:lineNumberShape restartType="${ln.restart === 'page' ? 1 : ln.restart === 'section' ? 2 : 3}" countBy="${Math.max(1, Math.round(+ln.countBy || 1))}" distance="${Math.max(0, mmToHwp(+ln.distance || 0))}" startNumber="${Math.max(1, Math.round(+ln.start || 1))}"/>`
      : `<hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>`;
    xml += `<hp:pagePr landscape="${pg.landscape ? 'NARROWLY' : 'WIDELY'}" width="${w}" height="${h}" gutterType="LEFT_ONLY">`;
    xml += `<hp:margin header="${mmToHwp(pg.marginHeader)}" footer="${mmToHwp(pg.marginFooter)}" gutter="${mmToHwp(pg.gutter)}" left="${mmToHwp(pg.marginLeft)}" right="${mmToHwp(pg.marginRight)}" top="${mmToHwp(pg.marginTop)}" bottom="${mmToHwp(pg.marginBottom)}"/></hp:pagePr>`;
    xml += `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>`;
    xml += `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>`;
    // 쪽 테두리/배경: 양쪽 쪽에 적용. 위치 기준은 한글이 쓰는 값 그대로 (본문 기준이 PAPER 로 적힌다: 리더의 pageBorderOf)
    let pbId = 1;
    let pbAttrs = `textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"`;
    let pbOff = [1417, 1417, 1417, 1417];
    if (pb) {
      const sides = pb.sides || {};
      const noBorders = (['l', 'r', 't', 'b'] as const).filter((k) => !sides[k]);
      const css = (['t', 'b', 'l', 'r'] as const)
        .filter((k) => sides[k])
        .map((k) => `${k}:${Math.max(0.1, +sides[k]!.w || 0.12)}mm ${sides[k]!.s} ${normColor(sides[k]!.c) || '#000000'}`)
        .join(';');
      const img = pb.image ? this.images.get(pb.image) : null;
      pbId = this.reg.borderFill({ bg: normColor(pb.bg), noBorders, borders: noBorders.length < 4, css: css || null, img: img ? { id: img.id, mode: pb.imageMode || 'TOTAL' } : null }, 'page');
      pbAttrs = `textBorder="${pb.body ? 'PAPER' : 'CONTENT'}" headerInside="${pb.headerInside ? 1 : 0}" footerInside="${pb.footerInside ? 1 : 0}" fillArea="${pb.fillArea === 'border' ? 'BORDER' : pb.fillArea === 'page' ? 'PAGE' : 'PAPER'}"`;
      pbOff = [0, 1, 2, 3].map((i) => Math.max(0, mmToHwp(+pb.offset?.[i] || 0)));
    }
    for (const t of ['BOTH', 'EVEN', 'ODD'])
      xml += `<hp:pageBorderFill type="${t}" borderFillIDRef="${t === 'BOTH' ? pbId : 1}" ${t === 'BOTH' ? pbAttrs : 'textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"'}><hp:offset left="${t === 'BOTH' ? pbOff[0] : 1417}" right="${t === 'BOTH' ? pbOff[1] : 1417}" top="${t === 'BOTH' ? pbOff[2] : 1417}" bottom="${t === 'BOTH' ? pbOff[3] : 1417}"/></hp:pageBorderFill>`;
    for (const m of this.masterXml) xml += `<hp:masterPage idRef="${m.id}"/>`;
    this.curCols = colKey(pg.columns);
    xml += `</hp:secPr><hp:ctrl>${colPrXml(pg.columns)}</hp:ctrl></hp:run>`;

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
  /** 바탕쪽 파일들 (구역 정의를 쓸 때 채운다) */
  masterXml: { id: string; xml: string }[] = [];
}

/** 변경 추적 목록: 바뀐 내용(종류·시각·사람)과 사람들 */
function trackChangesXml(reg: Registry): string {
  if (!reg.changes.length) return '';
  const iso = (t: number) => new Date(t > 0 ? t : Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
  return (
    `<hh:trackChanges itemCnt="${reg.changes.length}">` +
    reg.changes.map((c, i) => `<hh:trackChange type="${c.type === 'ins' ? 'Insert' : 'Delete'}" date="${iso(c.time)}" authorID="${c.author}" hide="0" id="${i + 1}"/>`).join('') +
    `</hh:trackChanges><hh:trackChangeAuthors itemCnt="${reg.authors.length}">` +
    reg.authors.map((a, i) => `<hh:trackChangeAuthor name="${xmlEscape(a || 'Kite')}" mark="1" id="${i + 1}"/>`).join('') +
    `</hh:trackChangeAuthors>`
  );
}

function headerXml(reg: Registry): string {
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
      if (b.bg || b.img)
        x +=
          `<hc:fillBrush>` +
          (b.bg ? `<hc:winBrush faceColor="${normColor(b.bg) || 'none'}" hatchColor="#999999" alpha="0"/>` : '') +
          (b.img ? `<hc:imgBrush mode="${/^[A-Z_]{3,20}$/.test(b.img.mode) ? b.img.mode : 'TOTAL'}"><hc:img binaryItemIDRef="${b.img.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/></hc:imgBrush>` : '') +
          `</hc:fillBrush>`;
      else if (i === 1) x += `<hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush>`;
      return x + '</hh:borderFill>';
    })
    .join('');

  const charXml = reg.chars
    .map((c, i) => {
      const ids = langFontIds(c, (n) => reg.font(n));
      const sym = c.emphasis && /^[A-Z_]{3,20}$/.test(c.emphasis) ? c.emphasis : 'NONE';
      let x = `<hh:charPr id="${i}" height="${ptToHwp(c.size)}" textColor="${normColor(c.color) || '#000000'}" shadeColor="${normColor(c.highlight) || 'none'}" useFontSpace="0" useKerning="0" symMark="${sym}" borderFillIDRef="2">`;
      x += `<hh:fontRef ${LANG_ATTRS.map((l, k) => `${l}="${ids[k]}"`).join(' ')}/><hh:ratio ${langAttrs(c.fontWidth || 100)}/><hh:spacing ${langAttrs(Math.max(-50, Math.min(50, Math.round(c.letterSpacing || 0))))}/><hh:relSz ${langAttrs(100)}/><hh:offset ${langAttrs(Math.max(-100, Math.min(100, Math.round(c.offset || 0))))}/>`;
      if (c.italic) x += '<hh:italic/>';
      if (c.bold) x += '<hh:bold/>';
      // 밑줄·취소선: 선 종류와 색 (색이 없으면 글자 색)
      const lineShape = (v: string | null | undefined) => (v && /^[A-Z_]{3,20}$/.test(v) ? v : 'SOLID');
      x += `<hh:underline type="${c.underline ? (c.ulPos === 'top' ? 'TOP' : 'BOTTOM') : 'NONE'}" shape="${lineShape(c.ulShape)}" color="${normColor(c.ulColor) || (c.underline ? normColor(c.color) : null) || '#000000'}"/>`;
      x += `<hh:strikeout shape="${c.strike ? lineShape(c.stShape) : 'NONE'}" color="${normColor(c.stColor) || (c.strike ? normColor(c.color) : null) || '#000000'}"/>`;
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
        `<hh:border borderFillIDRef="${p.bfId}" offsetLeft="${pxToHwp(p.border?.o?.[0] || 0)}" offsetRight="${pxToHwp(p.border?.o?.[1] || 0)}" offsetTop="${pxToHwp(p.border?.o?.[2] || 0)}" offsetBottom="${pxToHwp(p.border?.o?.[3] || 0)}" connect="${p.border?.c ? 1 : 0}" ignoreMargin="0"/></hh:paraPr>`
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
    `<hh:styles itemCnt="1"><hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/></hh:styles>` +
    trackChangesXml(reg) +
    `</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>` +
    `<hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`
  );
}

function collectImageSrcs(blocks: FlatBlock[], out: Set<string>) {
  for (const b of blocks) {
    if (b.kind === 'para') {
      for (const i of b.inlines) {
        if (i.type === 'image' && i.src) out.add(i.src);
        else if (i.type === 'shape') {
          shapeImageSrcs(i.d, out);
          // 도형 안 글에 든 그림
          for (const it of i.d.items) if (it.k === 'text' && it.content) collectImageSrcs(flattenContent(it.content), out);
        }
      }
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
  const reg = new Registry();
  const pg = doc.settings.page;
  const pageW = pg.landscape ? Math.max(pg.width, pg.height) : pg.width;
  const bodyWidthHwp = mmToHwp(pageW - pg.marginLeft - pg.marginRight - pg.gutter);

  // 그림 준비
  const srcs = new Set<string>();
  collectImageSrcs(blocks, srcs);
  for (const hf of [doc.settings.header, doc.settings.footer]) collectImageSrcs(richHF(hf) || [], srcs);
  if (doc.settings.pageBorder?.image) srcs.add(doc.settings.pageBorder.image);
  for (const mp of doc.settings.masterPages || []) collectImageSrcs(flattenContent((mp.content || []) as any), srcs);
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
  const body = sw.blocks(blocks, false, true);
  const section = XML_DECL + `<hs:sec ${NS}>${body}</hs:sec>`;
  const header = headerXml(reg);

  const meta = doc.meta;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const manifestItems =
    `<opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>` +
    reg.images.map((im) => `<opf:item id="${im.id}" href="${im.path}" media-type="${im.mime}" isEmbeded="1"/>`).join('') +
    sw.masterXml.map((m) => `<opf:item id="${m.id}" href="Contents/${m.id}.xml" media-type="application/xml"/>`).join('') +
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
  for (const m of sw.masterXml) zip.file(`Contents/${m.id}.xml`, XML_DECL + m.xml);
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

/** 다단 값을 견주는 열쇠 (한 단은 '1') */
function colKey(c: Columns | null | undefined): string {
  const v = cleanColumns(c);
  return v && v.count > 1 ? JSON.stringify(v) : '1';
}

/** 다단 정의 (hp:colPr). 너비가 다른 단의 너비·간격은 본문 폭에 대한 비율(합 32768)로 적는다 */
function colPrXml(c: Columns | null | undefined): string {
  const v = cleanColumns(c);
  if (!v || v.count < 2) return `<hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/>`;
  const n = v.count;
  const TYPE: Record<string, string> = { solid: 'SOLID', dashed: 'DASH', dotted: 'DOT', double: 'DOUBLE_SLIM' };
  const line = v.line ? `<hp:colLine type="${TYPE[v.line.s] || 'SOLID'}" width="${v.line.w} mm" color="${normColor(v.line.c) || '#000000'}"/>` : '';
  if (v.widths && v.gaps) {
    const total = v.widths.reduce((a, b) => a + b, 0) + v.gaps.slice(0, n - 1).reduce((a, b) => a + b, 0) || 1;
    const u = (x: number) => Math.max(0, Math.round((x / total) * 32768));
    const szs = v.widths.map((w, i) => `<hp:colSz width="${u(w)}" gap="${i < n - 1 ? u(v.gaps![i]) : 0}"/>`).join('');
    return `<hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="${n}" sameSz="0" sameGap="0">${line}${szs}</hp:colPr>`;
  }
  return `<hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="${n}" sameSz="1" sameGap="${mmToHwp(v.gap)}"${line ? `>${line}</hp:colPr>` : '/>'}`;
}
