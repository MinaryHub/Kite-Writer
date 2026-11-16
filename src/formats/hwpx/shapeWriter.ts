import { pxToHwp, xmlEscape } from '../common';
import { HWP_ARROW_SIZES, SHADOW_UNIT_PX, type Gradient, type Mat, type ShapeData, type ShapeItem, type ShapeRaw } from '../shape';

/**
 * 그리기 개체(ShapeData) → HWPX 의 도형 요소(hp:line, hp:rect, hp:ellipse, hp:arc, hp:polygon, hp:curve, hp:pic, hp:container).
 * 한글 문서에서 읽은 개체는 적혀 있던 크기·행렬(raw)을 그대로 되돌려 쓰고, Kite 에서 만든 개체는 행렬 하나로 쓴다.
 */

export interface ShapeWriteCtx {
  nextId(): number;
  zOrder(): number;
  /** 그림의 BinData id (없으면 null) */
  image(src: string): { id: string; w: number; h: number } | null;
  /** 도형 안 글의 문단 XML */
  textXml(content: any[]): string;
  subList(inner: string, vertAlign: string, width: number, height: number): string;
}

const u = (v: number) => Math.round(pxToHwp(v));
/** 음수는 한글처럼 부호 없는 32비트로 */
const u32 = (v: number) => (Math.round(v) >>> 0).toString();
const f6 = (v: number) => (Number.isFinite(v) ? +v.toFixed(6) : 0).toString();

const matXml = (name: string, e: number[]) => `<hc:${name} e1="${f6(e[0])}" e2="${f6(e[1])}" e3="${f6(e[2])}" e4="${f6(e[3])}" e5="${f6(e[4])}" e6="${f6(e[5])}"/>`;

/** 저장할 한글 값: 읽은 값이 있으면 그대로, 없으면 행렬(m)에서 만든다 (이동 + 크기 행렬 하나, 묶음 안이면 묶음 몫의 단위 행렬 쌍을 앞에) */
function rawOf(it: { m: Mat; w: number; h: number; raw?: ShapeRaw }, lvl: number): ShapeRaw {
  const r = it.raw;
  // 읽은 값은 묶음 깊이가 같을 때만 그대로 쓴다 (겹친 묶음을 한 겹으로 풀어 쓰면 행렬 쌍의 수가 달라진다)
  if (r && r.lvl === lvl && r.mats.length === 1 + 2 * (lvl + 1)) return r;
  const m = it.m;
  const ident = [1, 0, 0, 0, 1, 0];
  const mats: number[][] = [[1, 0, pxToHwp(m[4]), 0, 1, pxToHwp(m[5])]];
  for (let k = 0; k < lvl; k++) mats.push(ident, ident);
  mats.push([m[0], m[2], 0, m[1], m[3], 0], ident);
  const cw = Math.round(pxToHwp(it.w * Math.hypot(m[0], m[1])));
  const ch = Math.round(pxToHwp(it.h * Math.hypot(m[2], m[3])));
  return { off: [Math.round(pxToHwp(m[4])), Math.round(pxToHwp(m[5]))], org: [u(it.w), u(it.h)], cur: [cw, ch], flip: [0, 0], rot: [0, Math.round(cw / 2), Math.round(ch / 2)], mats, lvl, ...(r?.lw != null ? { lw: r.lw } : {}) };
}

function commonXml(raw: ShapeRaw): string {
  let ri = matXml('transMatrix', raw.mats[0]);
  for (let k = 1; k + 1 < raw.mats.length; k += 2) ri += matXml('scaMatrix', raw.mats[k]) + matXml('rotMatrix', raw.mats[k + 1]);
  return (
    `<hp:offset x="${u32(raw.off[0])}" y="${u32(raw.off[1])}"/><hp:orgSz width="${Math.abs(raw.org[0])}" height="${Math.abs(raw.org[1])}"/><hp:curSz width="${Math.abs(raw.cur[0])}" height="${Math.abs(raw.cur[1])}"/>` +
    `<hp:flip horizontal="${raw.flip[0] ? 1 : 0}" vertical="${raw.flip[1] ? 1 : 0}"/><hp:rotationInfo angle="${Math.round(raw.rot[0])}" centerX="${Math.round(raw.rot[1])}" centerY="${Math.round(raw.rot[2])}" rotateimage="1"/>` +
    `<hp:renderingInfo>${ri}</hp:renderingInfo>`
  );
}

/** 화살표 모양 이름: 마름모·원·상자는 EMPTY_ 이름에 채움 여부(headfill)를 따로 적는다 */
function arrowName(s: string | undefined): string {
  if (!s) return 'NORMAL';
  if (s === 'ARROW' || s === 'SPEAR' || s === 'CONCAVE_ARROW') return s;
  return 'EMPTY_' + s;
}

function lineShapeXml(it: ShapeItem, raw: ShapeRaw): string {
  const size = (z: [number, number] | undefined) => HWP_ARROW_SIZES[Math.round(z?.[0] ?? 1) * 3 + Math.round(z?.[1] ?? 1)] || 'MEDIUM_MEDIUM';
  if (!it.sc) return `<hp:lineShape color="#000000" width="0" style="NONE" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="MEDIUM_MEDIUM" tailSz="MEDIUM_MEDIUM" outlineStyle="NORMAL" alpha="0"/>`;
  const w = raw.lw != null ? Math.round(raw.lw) : Math.max(1, u(it.sw || 0.45));
  return (
    `<hp:lineShape color="${it.sc}" width="${w}" style="${it.sd || 'SOLID'}" endCap="${it.cap === 'round' ? 'ROUND' : 'FLAT'}" headStyle="${arrowName(it.hs)}" tailStyle="${arrowName(it.ts)}" ` +
    `headfill="${it.hs && !it.hf ? 0 : 1}" tailfill="${it.ts && !it.tf ? 0 : 1}" headSz="${size(it.hz)}" tailSz="${size(it.tz)}" outlineStyle="NORMAL" alpha="0"/>`
  );
}

function gradXml(g: Gradient): string {
  return `<hc:gradation type="${g.t}" angle="${Math.round(g.a)}" centerX="${Math.round(g.cx)}" centerY="${Math.round(g.cy)}" step="255" colorNum="${g.c.length}" stepCenter="${Math.round(g.sc ?? 50)}" alpha="0">${g.c.map((c) => `<hc:color value="${c}"/>`).join('')}</hc:gradation>`;
}

function fillXml(it: ShapeItem, ctx: ShapeWriteCtx): string {
  const img = it.fi ? ctx.image(it.fi) : null;
  if (!it.fc && !it.fg && !img) return '';
  let x = '<hc:fillBrush>';
  if (it.fc && !it.fg) x += `<hc:winBrush faceColor="${it.fc}" hatchColor="#000000" alpha="0"/>`;
  if (it.fg) x += gradXml(it.fg);
  if (img) x += `<hc:imgBrush mode="TOTAL"><hc:img binaryItemIDRef="${img.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/></hc:imgBrush>`;
  return x + '</hc:fillBrush>';
}

function shadowXml(it: ShapeItem): string {
  const sh = it.sh;
  if (!sh) return `<hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/>`;
  const type = `PARELLEL_${sh.x < 0 ? 'LEFT' : 'RIGHT'}${sh.y < 0 ? 'TOP' : 'BOTTOM'}`;
  return `<hp:shadow type="${type}" color="${sh.c}" offsetX="${Math.round(Math.abs(sh.x) / SHADOW_UNIT_PX)}" offsetY="${Math.round(Math.abs(sh.y) / SHADOW_UNIT_PX)}" alpha="0"/>`;
}

const ptXml = (name: string, x: number, y: number) => `<hc:${name} x="${u32(pxToHwp(x))}" y="${u32(pxToHwp(y))}"/>`;

function drawTextXml(t: ShapeItem | null, ctx: ShapeWriteCtx): string {
  if (!t || !t.content) return '';
  const pad = (t.pad || [3.77, 3.77, 3.77, 3.77]).map((v) => u(v));
  const W = u(t.w);
  const H = u(t.h);
  const inner = ctx.textXml(t.content) || `<hp:p id="2147483648" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"/></hp:p>`;
  const va = t.va === 'middle' ? 'CENTER' : t.va === 'bottom' ? 'BOTTOM' : 'TOP';
  return `<hp:drawText lastWidth="${W}" name="" editable="0">${ctx.subList(inner, va, Math.max(0, W - pad[1] - pad[3]), Math.max(0, H - pad[0] - pad[2]))}<hp:textMargin left="${pad[3]}" right="${pad[1]}" top="${pad[0]}" bottom="${pad[2]}"/></hp:drawText>`;
}

/** 도형 하나(와 그 안의 글)의 요소. tail 은 최상위 개체에만 붙는 크기·자리 */
function itemXml(it: ShapeItem, text: ShapeItem | null, lvl: number, wrap: string, tail: string, ctx: ShapeWriteCtx): string {
  const raw = rawOf(it, lvl);
  const id = ctx.nextId();
  const head = `id="${id}" zOrder="${ctx.zOrder()}" numberingType="PICTURE" textWrap="${wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="${lvl}" instid="${id - 1}"`;
  const common = commonXml(raw);
  const look = () => lineShapeXml(it, raw) + fillXml(it, ctx) + shadowXml(it);
  const p = it.p || [];
  switch (it.k) {
    case 'img': {
      const info = it.src ? ctx.image(it.src) : null;
      if (!info) return '';
      const ow = raw.org[0];
      const oh = raw.org[1];
      const dw = pxToHwp(info.w);
      const dh = pxToHwp(info.h);
      const c = it.crop || { t: 0, r: 0, b: 0, l: 0 };
      return (
        `<hp:pic ${head} reverse="0">${common}` +
        `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${ow}" y="0"/><hc:pt2 x="${ow}" y="${oh}"/><hc:pt3 x="0" y="${oh}"/></hp:imgRect>` +
        `<hp:imgClip left="${Math.round(dw * c.l)}" right="${Math.round(dw * (1 - c.r))}" top="${Math.round(dh * c.t)}" bottom="${Math.round(dh * (1 - c.b))}"/><hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
        `<hp:imgDim dimwidth="${dw}" dimheight="${dh}"/><hc:img binaryItemIDRef="${info.id}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/><hp:effects/>${tail}</hp:pic>`
      );
    }
    case 'line':
      return `<hp:line ${head} isReverseHV="0">${common}${lineShapeXml(it, raw)}${shadowXml(it)}${ptXml('startPt', p[0] || 0, p[1] || 0)}${ptXml('endPt', p[2] || 0, p[3] || 0)}${tail}</hp:line>`;
    case 'rect':
      return (
        `<hp:rect ${head} ratio="${Math.round(it.r || 0)}">${common}${look()}${drawTextXml(text, ctx)}` +
        `${ptXml('pt0', 0, 0)}${ptXml('pt1', it.w, 0)}${ptXml('pt2', it.w, it.h)}${ptXml('pt3', 0, it.h)}${tail}</hp:rect>`
      );
    case 'ellipse':
      return (
        `<hp:ellipse ${head} intervalDirty="0" hasArcPr="0" arcType="NORMAL">${common}${look()}${drawTextXml(text, ctx)}` +
        `${ptXml('center', it.w / 2, it.h / 2)}${ptXml('ax1', it.w, it.h / 2)}${ptXml('ax2', it.w / 2, 0)}${ptXml('start1', 0, 0)}${ptXml('end1', 0, 0)}${ptXml('start2', 0, 0)}${ptXml('end2', 0, 0)}${tail}</hp:ellipse>`
      );
    case 'arc':
      return `<hp:arc ${head} type="${it.at || 'NORMAL'}">${common}${look()}${drawTextXml(text, ctx)}${ptXml('center', p[0] || 0, p[1] || 0)}${ptXml('ax1', p[2] || 0, p[3] || 0)}${ptXml('ax2', p[4] || 0, p[5] || 0)}${tail}</hp:arc>`;
    case 'poly': {
      let pts = '';
      for (let i = 0; i + 1 < p.length; i += 2) pts += ptXml('pt', p[i], p[i + 1]);
      // 닫힌 다각형은 처음 점으로 돌아온다
      if (it.z && p.length >= 4 && (Math.abs(p[0] - p[p.length - 2]) > 0.01 || Math.abs(p[1] - p[p.length - 1]) > 0.01)) pts += ptXml('pt', p[0], p[1]);
      return `<hp:polygon ${head}>${common}${look()}${drawTextXml(text, ctx)}${pts}${tail}</hp:polygon>`;
    }
    case 'curve': {
      let segs = '';
      const seg = it.seg || '';
      for (let i = 0, k = 0; i + 3 < p.length; i += 2, k++)
        segs += `<hp:seg type="${seg[k] === 'L' ? 'LINE' : 'CURVE'}" x1="${u32(pxToHwp(p[i]))}" y1="${u32(pxToHwp(p[i + 1]))}" x2="${u32(pxToHwp(p[i + 2]))}" y2="${u32(pxToHwp(p[i + 3]))}"/>`;
      return `<hp:curve ${head}>${common}${look()}${drawTextXml(text, ctx)}${segs}${tail}</hp:curve>`;
    }
    case 'art': {
      const text0 = (it.text || '').split('\n').join('␍␊');
      return (
        `<hp:textart ${head} text="${xmlEscape(text0)}">${common}${lineShapeXml(it, raw)}<hc:fillBrush><hc:winBrush faceColor="${it.fc || '#000000'}" hatchColor="#000000" alpha="0"/></hc:fillBrush>${shadowXml(it)}` +
        `${ptXml('pt0', 0, 0)}${ptXml('pt1', it.w, 0)}${ptXml('pt2', it.w, it.h)}${ptXml('pt3', 0, it.h)}` +
        `<hp:textartPr fontName="${xmlEscape(it.font || '함초롬바탕')}" fontStyle="보통" fontType="TTF" textShape="PARALLELOGRAM" lineSpacing="120" charSpacing="100" align="LEFT"><hp:shadow type="NONE" color="#B2B2B2" offsetX="0" offsetY="0" alpha="0"/></hp:textartPr>${tail}</hp:textart>`
      );
    }
  }
  return '';
}

/**
 * 그리기 개체 전체의 XML. frame 은 최상위 개체의 크기·자리(hp:sz, hp:pos, hp:outMargin), wrap 은 본문과의 배치.
 * 도형 하나면 그 도형으로, 여럿이면 묶은 개체(hp:container)로 쓴다
 */
export function shapeXml(d: ShapeData, width: number, height: number, wrap: string, frame: string, ctx: ShapeWriteCtx): string {
  // 도형과 바로 뒤의 글(같은 자리)을 한 개체로
  const objs: { it: ShapeItem; text: ShapeItem | null }[] = [];
  for (const it of d.items) {
    const last = objs[objs.length - 1];
    if (it.k === 'text') {
      if (last && !last.text && last.it.k !== 'img' && last.it.k !== 'line' && last.it.k !== 'art' && last.it.m.every((v, i) => Math.abs(v - it.m[i]) < 1e-6)) last.text = it;
      // 임자 없는 글: 선·채우기 없는 사각형에 담는다
      else objs.push({ it: { k: 'rect', m: it.m, w: it.w, h: it.h }, text: it });
    } else objs.push({ it, text: null });
  }
  if (!objs.length) return '';
  if (!d.group && objs.length === 1) return itemXml(objs[0].it, objs[0].text, 0, wrap, frame, ctx);
  const W = u(width);
  const H = u(height);
  const raw: ShapeRaw =
    d.raw && d.raw.lvl === 0 && d.raw.mats.length === 3
      ? d.raw
      : { off: [0, 0], org: [W, H], cur: [W, H], flip: [0, 0], rot: [0, Math.round(W / 2), Math.round(H / 2)], mats: [[1, 0, 0, 0, 1, 0], [1, 0, 0, 0, 1, 0], [1, 0, 0, 0, 1, 0]], lvl: 0 };
  const id = ctx.nextId();
  const kids = objs.map((o) => itemXml(o.it, o.text, 1, 'TOP_AND_BOTTOM', '', ctx)).join('');
  return (
    `<hp:container id="${id}" zOrder="${ctx.zOrder()}" numberingType="PICTURE" textWrap="${wrap}" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${id - 1}">` +
    `${commonXml(raw)}${kids}${frame}</hp:container>`
  );
}

/** 도형이 쓰는 그림 주소들 (그림 항목과 그림 채우기) */
export function shapeImageSrcs(d: ShapeData, out: Set<string>) {
  for (const it of d.items) {
    if (it.k === 'img' && it.src) out.add(it.src);
    if (it.fi) out.add(it.fi);
  }
}
