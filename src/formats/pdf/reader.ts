import type { LoadedDoc } from '../../types';
import { DEFAULT_FONT, type JNode, defaultSettings, docNode, paragraph, pushAll, round } from '../common';
import { bytesToBase64, fontStack, fontUsable, registerPdfFonts } from '../../fonts';
import type { PdfFontFace } from '../../types';
import { unicodeFont, unicodeRange } from './embedfont';
import { type FontInfo, type PageContent, type PdfImage, extractPage } from './extract';
import { type LayoutCtx, VECTOR_REF, analyzePage, cleanFontName, contentBounds, renderContainer, typicalLineRatio } from './layout';

/**
 * PDF 불러오기: pdf.js 의 그리기 명령을 해석해 글자(글꼴·크기·색·굵기), 채운 사각형, 선, 그림을 얻고
 * 표 격자·배경 상자·줄 간격을 재구성한다. (PDF는 편집용 구조가 없으므로 완벽한 복원은 불가능하다.)
 */

let pdfjsPromise: Promise<any> | null = null;
async function getPdfjs(): Promise<any> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib: any = await import('pdfjs-dist');
      // @ts-ignore - Vite ?url import
      const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    })();
  }
  return pdfjsPromise;
}

export async function readPdf(data: Uint8Array, onProgress?: (p: number) => void): Promise<LoadedDoc> {
  const pdfjs = await getPdfjs();
  const pdf = await pdfjs.getDocument({ data: data.slice(), isEvalSupported: false, useSystemFonts: true, fontExtraProperties: true, maxImageSize: 50_000_000, ...pdfjsAssetUrls() }).promise;
  pdfOps = pdfjs.OPS;
  return convertPdf(pdf, pdfjs.OPS, (page, img) => loadImage(page, img), onProgress);
}

/**
 * pdf.js 보조 자료 위치 (vite.config.ts 의 pdfjsAssets 가 화면 옆 pdfjs/ 에 둔다).
 * 색 변환(qcms)·JPEG2000·JBIG2 wasm 이 없으면 그림이 있는 쪽을 그리는 데 수 분이 걸리고,
 * CMap 이 없으면 글꼴을 넣지 않은 한글 PDF 의 글자를 읽지 못한다.
 */
function pdfjsAssetUrls(): Record<string, any> {
  try {
    const base = new URL('pdfjs/', document.baseURI).href;
    return { wasmUrl: base + 'wasm/', iccUrl: base + 'iccs/', cMapUrl: base + 'cmaps/', cMapPacked: true, standardFontDataUrl: base + 'standard_fonts/' };
  } catch {
    return {};
  }
}

/** pdf.js 문서 → 편집 문서 (테스트에서도 쓰도록 분리) */
export async function convertPdf(pdf: any, OPS: Record<string, number>, imageSrc: (page: any, img: PdfImage) => Promise<string | null>, onProgress?: (p: number) => void): Promise<LoadedDoc> {
  const settings = defaultSettings();
  settings.fixedLines = true;
  const warnings: string[] = [];
  let meta: any = {};
  try {
    const m = await pdf.getMetadata();
    meta = { title: m.info?.Title || undefined, author: m.info?.Author || undefined, subject: m.info?.Subject || undefined };
  } catch {
    /* 무시 */
  }

  // 1단계: 모든 페이지 분석 (여백을 문서 전체로 맞추기 위해)
  const pages: { page: any; pc: PageContent; an: ReturnType<typeof analyzePage>; bounds: { x0: number; x1: number; y0: number; y1: number } | null; imagePage: boolean }[] = [];
  let imgCount = 0;
  const pageNums: { pi: number; n: number; dash: boolean; pos: 'bottom-center' | 'top-center' }[] = [];
  const embedded = new Map<string, { obj: any; chars: Map<number, number> }>();
  for (let pi = 1; pi <= pdf.numPages; pi++) {
    onProgress?.((pi / pdf.numPages) * 0.6);
    const page = await pdf.getPage(pi);
    const vp = page.getViewport({ scale: 1 });
    let pc: PageContent;
    try {
      const ops = await page.getOperatorList();
      pc = extractPage(ops, OPS, (id) => fontOf(page, id), vp);
      collectEmbeddedFonts(page, pc, embedded);
      await keepPageImages(page, pc.images);
    } catch {
      warnings.push(`${pi}쪽 내용을 읽지 못했습니다.`);
      pc = { width: vp.width, height: vp.height, glyphs: [], fills: [], segs: [], images: [] };
    }
    imgCount += pc.images.length;
    const an = analyzePage(pc);
    if (an.pageNum) pageNums.push({ pi, ...an.pageNum });
    pages.push({ page, pc, an, bounds: contentBounds(an.pageC, an.underlined), imagePage: isImagePage(pc) });
  }
  // 화면 글꼴로 폭을 잴 수 있으면 글자를 PDF 와 같은 자리에 둔다 (여백도 내용에 딱 맞춘다)
  const exact = !!measurer();
  // 쪽 전체를 그림으로 넣는 쪽이 대부분이면(스캔·도면) 여백 없이 쪽 크기 그대로
  const imageDoc = pages.length > 0 && pages.filter((p) => p.imagePage).length >= pages.length / 2;

  // PDF 에 든 글꼴: 시스템에 없는 것만 그 이름으로 올린다 (글자 폭을 재기 전에)
  const pdfFonts = await registerEmbedded(embedded);
  if (pdfFonts.length) settings.pdfFonts = pdfFonts;

  const first = pages[0];
  const pageW = first ? first.pc.width : 595;
  const pageH = first ? first.pc.height : 842;
  {
    const wmm = (pageW * 25.4) / 72;
    const hmm = (pageH * 25.4) / 72;
    settings.page.landscape = wmm > hmm;
    settings.page.width = round(Math.min(wmm, hmm), 1);
    settings.page.height = round(Math.max(wmm, hmm), 1);
  }
  // 여백: 페이지들의 내용 범위에서
  const bs = pages.map((p) => p.bounds).filter(Boolean) as { x0: number; x1: number; y0: number; y1: number }[];
  let left = 56;
  let right = pageW - 56;
  let top = 56;
  let bottom = pageH - 56;
  if (bs.length) {
    left = exact ? Math.min(...bs.map((b) => b.x0)) : percentileOf(bs.map((b) => b.x0), 0.2);
    right = exact ? Math.max(...bs.map((b) => b.x1)) : percentileOf(bs.map((b) => b.x1), 0.8);
    top = Math.min(...bs.map((b) => b.y0));
    bottom = Math.max(...bs.map((b) => b.y1));
    // 오른쪽 여백은 왼쪽과 비슷하게(본문이 짧게 끝난 페이지 때문에 좁아지지 않도록)
    if (right < pageW - left) right = Math.max(right, Math.min(pageW - left, Math.max(...bs.map((b) => b.x1))));
    if (right < pageW - left - 30) right = pageW - left;
  }
  // 쪽 번호가 대부분의 페이지에 있으면 문서의 쪽 번호 설정으로 바꾼다
  if (pages.length > 1 && pageNums.length >= pages.length * 0.6) {
    const f = pageNums[0];
    settings.pageNumber = { pos: f.pos, format: f.dash ? 'dash' : 'digit', start: Math.max(1, f.n - (f.pi - 1)) };
  }
  const pg = settings.page;
  const ptmm = (v: number) => (v * 25.4) / 72;
  pg.marginHeader = 0;
  pg.marginFooter = 0;
  if (imageDoc) {
    pg.marginLeft = pg.marginRight = pg.marginTop = pg.marginBottom = 0;
  } else if (exact) {
    // 글자 위치를 PDF 대로 맞추므로 여백은 내용 범위 그대로 (조금의 여유만)
    const maxMm = ptmm(Math.min(pageW, pageH)) * 0.45;
    pg.marginLeft = clampMm(ptmm(left) - 0.5, 0, maxMm);
    pg.marginRight = clampMm(ptmm(pageW - right) - 0.5, 0, maxMm);
    pg.marginTop = clampMm(ptmm(top) - 1, 0, maxMm);
    // 쪽마다 쪽 나누기가 있으므로 아래 여백을 줄여도 다음 쪽 내용이 올라오지 않는다 — 넘침만 막는다.
    // (쪽 번호가 있으면 그 자리를 위해 조금만 줄인다. 표·상자의 선·안 여백으로 생기는 작은 누적 오차로 넘치지 않게 6mm 여유)
    const bottomMm = ptmm(pageH - bottom);
    pg.marginBottom = settings.pageNumber.pos !== 'none' ? clampMm(bottomMm - 6, 0, maxMm) : clampMm(Math.min(bottomMm - 3, 10), 0, maxMm);
  } else {
    pg.marginLeft = clampMm(ptmm(left) - 0.5);
    pg.marginRight = clampMm(ptmm(pageW - right) - 0.5);
    pg.marginTop = clampMm(ptmm(top) - 1);
    // 대체 글꼴 등으로 조금 길어져도 다음 쪽으로 넘치지 않도록 아래 여백에 여유를 둔다
    pg.marginBottom = clampMm(Math.min(ptmm(pageH - bottom) - 6, 20));
  }
  const L = (pg.marginLeft * 72) / 25.4;
  const R = pageW - (pg.marginRight * 72) / 25.4;
  const T = (pg.marginTop * 72) / 25.4;

  // 2단계: 페이지별 블록
  const blocks: JNode[] = [];
  for (let i = 0; i < pages.length; i++) {
    onProgress?.(0.6 + ((i + 1) / pages.length) * 0.4);
    const { page, pc, an } = pages[i];
    // 같은 그림을 여러 칸에서 쓸 수 있으므로(표에 걸친 직인) 한 번만 만든다
    const srcCache = new Map<PdfImage, Promise<string | null>>();
    const cachedSrc = (img: PdfImage) => {
      let p = srcCache.get(img);
      if (!p) srcCache.set(img, (p = imageSrc(page, img)));
      return p;
    };
    const ctx: LayoutCtx = { imageSrc: cachedSrc, lineRatio: typicalLineRatio(pc.glyphs), measure: measurer() };
    // 쪽 배경 그림 (쪽 전체를 그림으로 넣는 쪽은 그 그림이 곧 배경이므로 제외)
    if (an.background && !pages[i].imagePage) {
      const bsrc = await cachedSrc(an.background);
      if (bsrc) {
        const b = an.background;
        (settings.pageBackgrounds ||= [])[i] = { src: bsrc, x: round(b.x0, 1), y: round(b.y0, 1), w: round(b.x1 - b.x0, 1), h: round(b.y1 - b.y0, 1) };
      }
    }
    let res;
    // 글자가 거의 없는 페이지(글자를 그림/도형으로 그린 표지·설명서 등)는 페이지 전체를 그림으로
    if (pages[i].imagePage) {
      const src = await imageSrc(page, { x0: 0, y0: 0, x1: pc.width, y1: pc.height, ref: null });
      if (src) {
        // 줄 높이(그림 높이 + 2pt)가 쪽 본문 높이를 넘지 않게
        const s = Math.min((R - L) / pc.width, (pageH - T - (pg.marginBottom * 72) / 25.4 - 3) / pc.height);
        const img: JNode = { type: 'image', attrs: { src, width: Math.round(pc.width * s * (96 / 72)), height: Math.round(pc.height * s * (96 / 72)) } };
        if (i > 0) blocks.push({ type: 'pageBreak' });
        blocks.push(paragraph({ textAlign: 'center', lineHeight: `${round(pc.height * s + 2, 1)}pt` }, [img]));
        page.cleanup?.();
        continue;
      }
    }
    try {
      res = await renderContainer(an.pageC, { x0: L, y0: T, x1: R, y1: pc.height }, ctx, an.underlined, T);
    } catch (e) {
      warnings.push(`${i + 1}쪽 배치를 재구성하지 못했습니다.`);
      res = { blocks: [] as JNode[], endY: T };
    }
    if (i > 0) blocks.push({ type: 'pageBreak' });
    pushAll(blocks, res.blocks);
    // 그림 읽기가 다 끝난 뒤에 쪽 자원을 푼다 (먼저 풀면 아직 못 읽은 그림이 빈 그림이 된다)
    await Promise.allSettled([...srcCache.values()]);
    page.cleanup?.();
  }
  if (imgCount === 0 && pages.every((p) => !p.pc.glyphs.length)) warnings.push('텍스트가 없는 PDF입니다 (스캔 이미지일 수 있음).');
  return { content: docNode(blocks.length ? blocks : [paragraph()]), settings, meta, warnings };
}

/**
 * 쪽에서 쓴 글꼴 가운데 PDF 에 들어 있는 것을 모은다.
 * 원래 이름을 잃은 글꼴(F1 등)은 'PDF F1' 같은 이름을 붙여 그 글꼴로 그리게 한다.
 */
function collectEmbeddedFonts(page: any, pc: PageContent, out: Map<string, { obj: any; chars: Map<number, number> }>) {
  if (!pc.fontChars) return;
  const renamed = new Map<string, string>();
  for (const [fid, chars] of pc.fontChars) {
    let e = out.get(fid);
    if (!e) {
      let obj: any = null;
      try {
        obj = page.commonObjs.has(fid) ? page.commonObjs.get(fid) : null;
      } catch {
        obj = null;
      }
      if (!obj?.data || !(obj.data instanceof Uint8Array) || obj.data.length < 100) continue;
      e = { obj, chars: new Map() };
      out.set(fid, e);
    }
    for (const [u, fc] of chars) if (!e.chars.has(u)) e.chars.set(u, fc);
    if (!cleanFontName(e.obj.name || '').family) renamed.set(fid, anonymousFamily(e.obj.name || fid));
  }
  if (renamed.size) for (const g of pc.glyphs) if (g.fid && renamed.has(g.fid)) g.font = renamed.get(g.fid)!;
}

function anonymousFamily(name: string): string {
  return 'PDF ' + (name.replace(/^[A-Z]{6}\+/, '').replace(/^CIDFont\+/i, '').replace(/[^\w.-]/g, '').slice(0, 20) || 'font');
}

async function registerEmbedded(embedded: Map<string, { obj: any; chars: Map<number, number> }>): Promise<PdfFontFace[]> {
  if (typeof document === 'undefined') return [];
  // 가운뎃점 등을 맡는 기호 글꼴: 캔버스로 폭을 재기 전에 올라와 있어야 화면과 폭이 같다
  try {
    await document.fonts.load("10pt 'kite-sym'", '\u00b7');
  } catch {
    /* 무시 */
  }
  if (!embedded.size) return [];
  const faces: PdfFontFace[] = [];
  const systemHas = new Map<string, boolean>();
  for (const { obj, chars } of embedded.values()) {
    const name = obj.name || '';
    const fi = cleanFontName(name);
    const family = fi.family || anonymousFamily(name);
    if (!systemHas.has(family)) systemHas.set(family, fontUsable(family));
    // 시스템에 있으면 별칭으로 올린다 (PDF 에 든 글자는 PDF 글꼴로, 나머지는 시스템 글꼴로)
    const alias = !!systemHas.get(family);
    let made: ReturnType<typeof unicodeFont> = null;
    try {
      made = unicodeFont(obj.data, chars);
    } catch {
      made = null;
    }
    if (!made) continue;
    const weight = fi.bold || obj.bold || obj.black ? '700' : '400';
    const style = fi.italic || obj.italic ? 'italic' : 'normal';
    faces.push({ family, alias, weight, style, unicodeRange: unicodeRange(made.codes), data: bytesToBase64(made.font) });
  }
  // 문서 설정에도 담아 두므로 같은 방식으로 올린다 (복구할 때와 같은 길)
  await registerPdfFonts(faces);
  return faces;
}

let measureCtx: CanvasRenderingContext2D | null | undefined;
/** 화면 글꼴로 글자 폭(pt)을 재는 함수 (캔버스가 없으면 undefined) */
function measurer(): LayoutCtx['measure'] {
  if (measureCtx === undefined) {
    try {
      measureCtx = typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
    } catch {
      measureCtx = null;
    }
  }
  const mc = measureCtx;
  if (!mc) return undefined;
  const cache = new Map<string, number>();
  return (text, family, sizePt, bold, italic) => {
    const font = `${italic ? 'italic ' : ''}${bold ? 'bold ' : ''}${sizePt}pt ${fontStack(family || DEFAULT_FONT, { canvas: true })}`;
    const key = font + '|' + text;
    let w = cache.get(key);
    if (w == null) {
      mc.font = font;
      w = (mc.measureText(text).width * 72) / 96;
      cache.set(key, w);
    }
    return w;
  };
}

function fontOf(page: any, id: string): FontInfo | null {
  try {
    const o = page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
    if (!o) return null;
    return { name: o.name || o.loadedName || '', bold: !!(o.bold || o.black), italic: !!o.italic, fontMatrix: o.fontMatrix || [0.001, 0, 0, 0.001, 0, 0], vertical: !!o.vertical };
  } catch {
    return null;
  }
}

const pageRenders = new WeakMap<any, Promise<HTMLCanvasElement | null>>();
const imageRenders = new WeakMap<any, Promise<HTMLCanvasElement | null>>();
const vectorRenders = new WeakMap<any, Promise<HTMLCanvasElement | null>>();
const singleRenders = new WeakMap<any, Map<number, Promise<HTMLCanvasElement | null>>>();
const imageOpIndex = new WeakMap<object, number[]>();
let pdfOps: Record<string, number> = {};

/**
 * 페이지를 그린다. imagesOnly 면 그림만 투명 바탕에 그린다 — 그림 영역을 잘라 쓸 때
 * 그 위에 놓인 글자·선(편집 문서에 따로 들어가는 것)이 그림에 함께 찍히지 않게 한다.
 */
function renderPage(page: any, mode: 'all' | 'images' | 'vectors' | { single: number } = 'all'): Promise<HTMLCanvasElement | null> {
  let p: Promise<HTMLCanvasElement | null> | undefined;
  let cache: WeakMap<any, Promise<HTMLCanvasElement | null>> | null = null;
  let singles: Map<number, Promise<HTMLCanvasElement | null>> | undefined;
  if (typeof mode === 'object') {
    singles = singleRenders.get(page);
    if (!singles) singleRenders.set(page, (singles = new Map()));
    p = singles.get(mode.single);
  } else {
    cache = mode === 'images' ? imageRenders : mode === 'vectors' ? vectorRenders : pageRenders;
    p = cache.get(page);
  }
  if (!p) {
    p = (async () => {
      try {
        const vp = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const O = pdfOps;
        const text = new Set([O.showText, O.showSpacedText, O.nextLineShowText, O.nextLineSetSpacingShowText]);
        const imageOps = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageXObjectRepeat, O.paintImageMaskXObject, O.paintSolidColorImageMask, O.paintImageMaskXObjectRepeat]);
        const pictureOps = new Set([O.paintImageXObject, O.paintInlineImageXObject, O.paintImageXObjectRepeat]);
        /** 그리기 목록에서 seq 번째 그림 명령의 위치 */
        const nthPicture = (ol: { fnArray: number[] }, seq: number) => {
          let idx = imageOpIndex.get(ol);
          if (!idx) {
            idx = [];
            ol.fnArray.forEach((f, k) => pictureOps.has(f) && idx!.push(k));
            imageOpIndex.set(ol, idx);
          }
          return idx[seq];
        };
        const filter = (i: number, ol: { fnArray: number[]; argsArray: any[] }) => {
          const fn = ol.fnArray[i];
          if (text.has(fn)) return false;
          if (mode === 'vectors') return !imageOps.has(fn);
          // 그림 하나만: 같은 자리에 겹친 다른 그림이 함께 찍히지 않게
          if (typeof mode === 'object' && imageOps.has(fn)) return pictureOps.has(fn) && nthPicture(ol, mode.single) === i;
          if (fn === O.shadingFill) return false;
          // 경로는 잘라내기(endPath)만 — 채우기/선은 편집 문서에 표·선으로 따로 들어간다
          if (fn === O.constructPath) return ol.argsArray[i]?.[0] === O.endPath;
          return true;
        };
        await page.render({
          canvasContext: canvas.getContext('2d'),
          viewport: vp,
          canvas,
          ...(mode !== 'all' && O.showText != null ? { operationsFilter: filter, background: 'rgba(0,0,0,0)' } : {}),
        }).promise;
        return canvas;
      } catch {
        return null;
      }
    })();
    if (singles && typeof mode === 'object') singles.set(mode.single, p);
    else cache!.set(page, p);
  }
  return p;
}

/** 쪽마다 미리 읽어 둔 그림 (그림 이름 → data URL) */
const keptImages = new WeakMap<any, Map<string, string>>();

/**
 * 그리기 목록을 얻은 직후, 어떤 렌더·정리보다 먼저 그 쪽의 그림을 읽어 둔다. pdf.js 는 쪽을 정리할 때
 * (렌더가 끝나며 미뤄 둔 정리가 돌 때도) 그림 bitmap 을 닫으므로, 나중에 읽으면 빈 그림이 될 수 있다.
 */
async function keepPageImages(page: any, images: PdfImage[]) {
  if (typeof document === 'undefined') return;
  const kept = new Map<string, string>();
  for (const im of images) {
    if (typeof im.ref !== 'string' || im.ref === VECTOR_REF || kept.has(im.ref)) continue;
    try {
      const url = imageToDataUrl(await getObj(page, im.ref));
      if (url && url.length > 100) kept.set(im.ref, url);
    } catch {
      /* 나중에 다시 */
    }
  }
  keptImages.set(page, kept);
}

async function loadImage(page: any, img: PdfImage): Promise<string | null> {
  if (img.ref === VECTOR_REF) return cropRender(page, img, 'vectors');
  const kept = typeof img.ref === 'string' ? keptImages.get(page)?.get(img.ref) : null;
  if (kept) return kept;
  try {
    const obj = typeof img.ref === 'string' ? await getObj(page, img.ref) : img.ref;
    const url = imageToDataUrl(obj);
    if (url && url.length > 100) return url;
  } catch {
    /* 아래에서 다시 */
  }
  // 쪽 전체(ref 없음)는 모두 그리고, 그림 하나는 그 그림만 그린 쪽에서 잘라 낸다
  return cropRender(page, img, img.ref == null ? 'all' : typeof img.seq === 'number' ? { single: img.seq } : 'images');
}

/** 쪽을 (mode 에 따라 골라) 그린 뒤 그림 영역을 잘라 낸다 */
async function cropRender(page: any, img: PdfImage, mode: 'all' | 'images' | 'vectors' | { single: number }): Promise<string | null> {
  const canvas = await renderPage(page, mode);
  if (!canvas) return null;
  const s = 2;
  const w = Math.max(1, Math.round((img.x1 - img.x0) * s));
  const h = Math.max(1, Math.round((img.y1 - img.y0) * s));
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  octx.drawImage(canvas, Math.round(img.x0 * s), Math.round(img.y0 * s), w, h, 0, 0, w, h);
  return out.toDataURL(w * h > 1200 * 1200 && !hasTransparency(octx, w, h) ? 'image/jpeg' : 'image/png', 0.9);
}

function percentileOf(arr: number[], p: number): number {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor((s.length - 1) * p)))];
}

function clampMm(v: number, min = 5, max = 60) {
  return round(Math.max(min, Math.min(max, v)), 1);
}

/** 글자가 거의 없는 쪽(글자를 그림/도형으로 그린 표지·스캔·설명서 등): 쪽 전체를 그림으로 넣는다 */
function isImagePage(pc: PageContent): boolean {
  const realText = pc.glyphs.filter((g) => !g.invisible && /[\p{L}\p{N}]/u.test(g.ch)).length;
  return realText < 15 && (pc.images.length > 0 || pc.fills.length > 0 || pc.segs.length > 10);
}

function getObj(page: any, id: string): Promise<any> {
  return new Promise((resolve) => {
    try {
      // 여러 쪽에 되풀이되는 그림은 pdf.js 가 문서 공용 저장소(commonObjs)에 'g_' 이름으로 둔다
      const store = id.startsWith('g_') ? page.commonObjs : page.objs;
      if (store.has(id)) return resolve(store.get(id));
      store.get(id, (o: any) => resolve(o));
      setTimeout(() => resolve(null), 3000);
    } catch {
      resolve(null);
    }
  });
}

function imageToDataUrl(img: any): string | null {
  if (!img) return null;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (typeof VideoFrame !== 'undefined' && img.bitmap instanceof VideoFrame) {
    // pdf.js 는 JPEG 를 VideoFrame 으로 풀어 둔다 (한 번 그리면 닫으므로 그 전에 읽어야 한다)
    const f = img.bitmap as VideoFrame;
    if (!f.displayWidth || !f.displayHeight) return null;
    canvas.width = f.displayWidth;
    canvas.height = f.displayHeight;
    ctx.drawImage(f, 0, 0);
  } else if (img.bitmap) {
    canvas.width = img.bitmap.width;
    canvas.height = img.bitmap.height;
    ctx.drawImage(img.bitmap, 0, 0);
  } else if (typeof ImageBitmap !== 'undefined' && img instanceof ImageBitmap) {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);
  } else if (img.data && img.width && img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
    const id = ctx.createImageData(img.width, img.height);
    const src = img.data as Uint8ClampedArray;
    const n = img.width * img.height;
    if (src.length === n * 4) id.data.set(src);
    else if (src.length === n * 3) {
      for (let i = 0, j = 0; i < n; i++) {
        id.data[j++] = src[i * 3];
        id.data[j++] = src[i * 3 + 1];
        id.data[j++] = src[i * 3 + 2];
        id.data[j++] = 255;
      }
    } else if (src.length === n) {
      for (let i = 0, j = 0; i < n; i++) {
        id.data[j++] = src[i];
        id.data[j++] = src[i];
        id.data[j++] = src[i];
        id.data[j++] = 255;
      }
    } else {
      // 1비트 흑백 등
      const rowBytes = Math.ceil(img.width / 8);
      for (let y = 0; y < img.height; y++)
        for (let x = 0; x < img.width; x++) {
          const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const v = bit ? 255 : 0;
          const k = (y * img.width + x) * 4;
          id.data[k] = id.data[k + 1] = id.data[k + 2] = v;
          id.data[k + 3] = 255;
        }
    }
    ctx.putImageData(id, 0, 0);
  } else return null;
  if (!canvas.width || !canvas.height) return null;
  // 큰 그림은 JPEG 로 줄이되, 투명한 곳이 있으면 PNG (JPEG 는 투명한 곳이 검게 된다)
  const big = canvas.width * canvas.height > 1200 * 1200;
  return canvas.toDataURL(big && !hasTransparency(ctx, canvas.width, canvas.height) ? 'image/jpeg' : 'image/png', 0.9);
}

/** 캔버스에 투명한 픽셀이 있는가 (성기게 훑는다) */
function hasTransparency(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  try {
    const d = ctx.getImageData(0, 0, w, h).data;
    const step = Math.max(1, Math.floor((w * h) / 200000)) * 4;
    for (let i = 3; i < d.length; i += step) if (d[i] < 250) return true;
  } catch {
    return true;
  }
  return false;
}
