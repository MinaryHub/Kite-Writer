import { Extension, Mark, Node, mergeAttributes } from '@tiptap/core';
import Image from '@tiptap/extension-image';
import BulletList from '@tiptap/extension-bullet-list';
import OrderedList from '@tiptap/extension-ordered-list';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TableRow from '@tiptap/extension-table-row';
import Table, { TableView } from '@tiptap/extension-table';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, Plugin, PluginKey, TextSelection, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { viewState } from '../viewState';
import type { Columns, PageSetup } from '../../types';
import { cleanMargins } from '../../formats/flatten';
import { cleanColumns, cleanFloatWrap, normColor, parseBorderCss, type BorderSide, type FloatWrap } from '../../formats/common';
import { cleanLook, lookCss, lookStyle } from '../../formats/picLook';
import { viewSrc } from '../imageUrls';
import { decorationSet } from '../decoSet';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: { setPageBreak: () => ReturnType; setSectionBreak: (page: PageSetup) => ReturnType };
    columnBreak: { setColumnBreak: (columns?: Columns | null) => ReturnType };
    footnote: { insertFootnote: (text: string, kind?: 'end' | null) => ReturnType; updateFootnote: (pos: number, text: string) => ReturnType };
    overwrite: { toggleOverwrite: () => ReturnType };
  }
}

/** 떠 있는 개체의 자리 (px). 값이 이상하면 null */
export function floatOf(v: any): { x: number; y: number; behind: boolean; py: number | null; wrap: FloatWrap | null; ax: 'r' | 'c' | null; zw: number | null; zh: number | null; cf: 'l' | 'r' | null } | null {
  if (!v || typeof v !== 'object') return null;
  const x = Number(v.x);
  const y = Number(v.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 20000 || Math.abs(y) > 20000) return null;
  // py: 쪽·종이 기준으로 놓인 개체의 쪽 본문 안 세로 자리 (쪽 나누기가 그 자리에 놓는다: placePageFloats)
  const py = v.py != null && Number.isFinite(+v.py) && Math.abs(+v.py) < 20000 ? +v.py : null;
  // ax: 폭이 내용대로인 글상자(Word 의 틀)의 가로 기준 — r: x 는 오른쪽 끝에서 잰 거리, c: 가운데에서 민 거리
  const ax = v.ax === 'r' || v.ax === 'c' ? v.ax : null;
  // zw·zh: 크기를 정하지 않은 상자의 어림 폭·높이 (둘레 글이 비켜 갈 자리를 셀 때만 쓴다)
  const zw = Number.isFinite(+v.zw) && +v.zw > 0 && +v.zw < 5000 ? +v.zw : null;
  const zh = Number.isFinite(+v.zh) && +v.zh > 0 && +v.zh < 5000 ? +v.zh : null;
  // cf: 왼쪽(l)·오른쪽(r) 끝에 붙어 글이 옆으로 흐르는 글상자 (Word 의 틀·첫 글자 장식): 내용 폭 그대로 CSS float 로 그린다
  const cf = v.cf === 'l' || v.cf === 'r' ? v.cf : null;
  // wrap: 둘레 글이 비켜 가는 개체 (Word 의 정사각형·위아래 배치 — floatWrap 이 글줄을 비킨다)
  return { x, y, behind: v.behind === true, py, wrap: cleanFloatWrap(v.wrap), ax, zw, zh, cf };
}

// ---------------- 글상자 (도형 안의 글) ----------------
const RADIUS_RE = /^[\d.]+(px|%)$/;

/** 한글의 선 종류 → CSS 테두리 종류 */
function boxBorderStyle(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  if (/^(DASH|LONG_DASH|DASH_DOT|DASH_DOT_DOT)$/.test(s)) return 'dashed';
  if (/^(DOT|CIRCLE)$/.test(s)) return 'dotted';
  if (/^(DOUBLE_SLIM|SLIM_THICK|THICK_SLIM|SLIM_THICK_SLIM)$/.test(s)) return 'double';
  return 'solid';
}

/** 한글의 글상자·도형 안 글. 크기가 정해진 상자 안에 문단이 들어가며, 배경(색·그림)과 테두리를 가진다 */
export const TextBox = Node.create({
  name: 'textBox',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes() {
    const plain = { default: null, rendered: false };
    return {
      width: plain,
      height: plain,
      bg: plain,
      bgImage: plain,
      borderColor: plain,
      borderWidth: plain,
      /** 테두리 선 종류 (한글의 선 종류: DASH, DOT, DASH_DOT, DOUBLE_SLIM …). 없으면 실선 */
      borderDash: plain,
      /** 그러데이션 채우기 (CSS 그러데이션: 우리가 만든 꼴만 받는다) */
      bgGradient: plain,
      radius: plain,
      padding: plain,
      /** 떠 있는 자리 { x, y, behind? } (px: x 는 본문·칸 왼쪽, y 는 뒤따르는 문단 상자 위쪽 기준). 있으면 높이 없이 그 자리에 띄운다 */
      float: plain,
      /** 글의 세로 맞춤 (middle, bottom) */
      valign: plain,
      // 한글이 놓은 자리 (화면 전용: 쪽 나누기가 쓴다)
      hwpTop: plain,
      hwpSeq: plain,
      hwpLen: plain,
      hwpPage: plain,
      hwpCol: plain,
      // 원본 보존형 저장 (formats/hwpBase.ts): 글자처럼 놓인 글상자가 든 한글 문단의 원본 줄 정보·문단 차례·문단 모양 번호
      hwpSeg: plain,
      hwpChars: plain,
      hwpPr: plain,
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div.k-textbox',
        getAttrs: (el) => {
          const st = (el as HTMLElement).style;
          const m = /url\("?([^")]+)"?\)/.exec(st.backgroundImage || '');
          const pad = st.padding ? st.padding.split(/\s+/).map(parseFloat) : null;
          return {
            width: parseFloat(st.width) || null,
            height: parseFloat(st.minHeight) || null,
            bg: normColor(st.backgroundColor),
            bgImage: m && /^data:image\//.test(m[1]) ? m[1] : null,
            borderColor: normColor(st.borderColor),
            borderWidth: parseFloat(st.borderWidth) || null,
            radius: RADIUS_RE.test(st.borderRadius) ? st.borderRadius : null,
            padding: pad && pad.length === 4 && pad.every(Number.isFinite) ? pad : null,
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const a = node.attrs;
    const num = (v: any) => (Number.isFinite(+v) && +v > 0 ? +v : 0);
    const st: string[] = [];
    if (num(a.width)) st.push(`width:${num(a.width)}px`);
    const fl = floatOf(a.float);
    // 떠 있는 상자는 한글처럼 높이가 고정이다 (글이 넘치면 상자 밖으로)
    if (num(a.height)) st.push(fl ? `height:${num(a.height)}px` : `min-height:${num(a.height)}px`);
    const bg = normColor(a.bg);
    if (bg) st.push(`background-color:${bg}`);
    const grad = cleanGradient(a.bgGradient);
    if (typeof a.bgImage === 'string' && /^data:image\//.test(a.bgImage)) st.push(`background-image:url("${a.bgImage}")`);
    else if (grad) st.push(`background-image:${grad}`);
    const bc = normColor(a.borderColor);
    if (bc) st.push(`border:${num(a.borderWidth) || 1}px ${boxBorderStyle(a.borderDash)} ${bc}`);
    if (typeof a.radius === 'string' && RADIUS_RE.test(a.radius)) st.push(`border-radius:${a.radius}`);
    if (Array.isArray(a.padding) && a.padding.length === 4) st.push(`padding:${a.padding.map((v: any) => Math.max(0, +v || 0) + 'px').join(' ')}`);
    if (a.valign === 'middle' || a.valign === 'bottom') st.push('display:flex', 'flex-direction:column', `justify-content:${a.valign === 'middle' ? 'center' : 'flex-end'}`);
    // 세로쓰기 글상자: 글자는 위에서 아래로, 줄은 오른쪽에서 왼쪽으로
    if (a.vertical === true) st.push('writing-mode:vertical-rl', 'text-orientation:upright');
    if (fl && fl.cf && fl.py == null) {
      // 글이 옆으로 흐르는 틀: 상자를 감싼 CSS float (안쪽 여백이 둘레 글과의 간격). x 는 붙은 끝에서 민 거리
      const d = fl.wrap?.d || [0, 0, 0, 0];
      const side = fl.cf === 'r' ? 'right' : 'left';
      // hg: 곁 문단의 내어쓰기 (CSS 는 첫 줄을 그만큼 틀 쪽으로 당긴다: 비킬 자리를 그만큼 넓힌다)
      const hg = Number.isFinite(+(a.float as any)?.hg) ? Math.max(0, Math.min(500, +(a.float as any).hg)) : 0;
      const outer = [`float:${side}`, `margin-top:${fl.y}px`, `margin-${side}:${fl.x}px`, fl.cf === 'r' ? `padding:0 0 ${d[2]}px ${d[3]}px` : `padding:0 ${d[1] + hg}px ${d[2]}px 0`];
      return ['div', { class: 'k-float-anchor' }, ['div', { class: 'k-cfloat', style: outer.join(';'), 'data-f': side, 'data-t': '0' }, ['div', { class: 'k-textbox', style: st.join(';') }, 0]]];
    }
    if (fl) {
      if (fl.ax === 'r') st.push(`right:${fl.x}px`, `top:${fl.y}px`);
      else if (fl.ax === 'c') st.push(`left:calc(50% + ${fl.x}px)`, 'transform:translateX(-50%)', `top:${fl.y}px`);
      else st.push(`left:${fl.x}px`, `top:${fl.y}px`);
      return ['div', { class: 'k-float-anchor' }, ['div', { class: 'k-textbox k-float' + (fl.behind ? ' behind' : ''), style: st.join(';'), ...(fl.py != null ? { 'data-py': String(fl.py) } : {}) }, 0]];
    }
    return ['div', { class: 'k-textbox', style: st.join(';') }, 0];
  },
});

// ---------------- 탭 (폭·채움) ----------------
/** 탭 글자(\t) 하나에 붙는 마크. 한글 문서의 탭은 폭과 채움(점선 등)을 가진다 */
export const TabStop = Mark.create({
  name: 'tab',
  inclusive: false,
  addAttributes() {
    return {
      /** 탭이 차지하는 폭(px). 없으면 기본 탭 간격 */
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => parseFloat(el.style.width) || null,
        renderHTML: (a: Record<string, any>) => (Number.isFinite(+a.width) && +a.width > 0 ? { style: `width:${+a.width}px` } : {}),
      },
      /** 채움 종류 (0 없음, 1 실선, 2 긴 점선, 3 점선, 4 -.-, 5 -..-, 6 원점선, 7 이중선) */
      leader: {
        default: 0,
        parseHTML: (el: HTMLElement) => +(el.getAttribute('data-leader') || 0),
        renderHTML: (a: Record<string, any>) => (+a.leader ? { 'data-leader': String(+a.leader) } : {}),
      },
      /** 탭 종류 (한글 값 그대로 보존) */
      type: {
        default: 0,
        parseHTML: (el: HTMLElement) => +(el.getAttribute('data-tab-type') || 0),
        renderHTML: (a: Record<string, any>) => (+a.type ? { 'data-tab-type': String(+a.type) } : {}),
      },
      /** 절대 위치 탭 (Word 의 ptab): 글 영역의 왼쪽 끝(l)·가운데(c)·오른쪽 끝(r)에 뒤 글을 맞춘다 (tabLayout) */
      ptab: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-ptab');
          return v === 'l' || v === 'c' || v === 'r' ? v : null;
        },
        renderHTML: (a: Record<string, any>) => (a.ptab === 'l' || a.ptab === 'c' || a.ptab === 'r' ? { 'data-ptab': a.ptab } : {}),
      },
      /** 구분 값: 이웃한 탭이 모양이 같아도 한 글자 조각으로 합쳐지지 않게 번갈아 0·1 을 준다 (합쳐지면 탭 둘이 한 폭으로 그려진다) */
      k: {
        default: 0,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-k') === '1' ? 1 : 0),
        renderHTML: (a: Record<string, any>) => (+a.k === 1 ? { 'data-k': '1' } : {}),
      },
      /** 오른쪽 맞춤 채움 탭 (차례): 뒤 글이 문단 오른쪽 끝에 닿도록 폭을 저절로 맞춘다 (tabFill) */
      right: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-tab-right') === '1',
        renderHTML: (a: Record<string, any>) => (a.right ? { 'data-tab-right': '1' } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-tab' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-tab' }, HTMLAttributes), 0];
  },
});

// ---------------- 문단 머리 (글머리표·문단 번호) ----------------
/**
 * 한글 문서의 문단 머리 글자(글머리표·문단 번호)에 붙는 마크. 한글은 머리를 '머리 글자 폭 + 본문과의 거리' 폭의 상자에 놓고,
 * 자동 내어쓰기면 둘째 줄부터 그 폭만큼 들인다. 폭과 내어쓰기는 hwpMetrics 가 화면에서 재서 만든다 (화면 전용)
 */
export const ParaHeadMark = Mark.create({
  name: 'paraHead',
  inclusive: false,
  addAttributes() {
    const num = (name: string, def: number | null) => ({
      default: def,
      parseHTML: (el: HTMLElement) => {
        const v = parseFloat(el.getAttribute('data-' + name) || '');
        return Number.isFinite(v) ? v : def;
      },
      renderHTML: (a: Record<string, any>) => (a[name] == null || !Number.isFinite(+a[name]) ? {} : { ['data-' + name]: String(+a[name]) }),
    });
    return {
      /** 머리 상자 안 정렬 */
      align: {
        default: 'left',
        parseHTML: (el: HTMLElement) => (['left', 'center', 'right'].includes(el.getAttribute('data-align') || '') ? el.getAttribute('data-align') : 'left'),
        renderHTML: (a: Record<string, any>) => (a.align === 'center' || a.align === 'right' ? { 'data-align': a.align } : {}),
      },
      /** 자동 내어쓰기 */
      auto: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-auto') === '1',
        renderHTML: (a: Record<string, any>) => (a.auto ? { 'data-auto': '1' } : {}),
      },
      /** 너비 조정 (px) */
      adj: num('adj', 0),
      /** 본문과의 거리: 글자 크기의 % 또는 값(px) */
      pct: num('pct', null),
      gap: num('gap', null),
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-phead' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-phead' }, HTMLAttributes), 0];
  },
});

// ---------------- 그림 (크기 조절·자르기) ----------------
export interface Crop {
  t: number;
  r: number;
  b: number;
  l: number;
}

/** 그림 효과가 쓰는 CSS 속성들 (바꿀 때 지난 것을 지운다) */
const LOOK_PROPS = ['filter', 'opacity', 'outline', 'outline-offset', '-webkit-mask-image', 'mask-image', '-webkit-mask-composite', 'mask-composite', '-webkit-box-reflect'];

export const cropOf = (v: any): Crop | null => {
  if (!v) return null;
  const c = { t: +v.t || 0, r: +v.r || 0, b: +v.b || 0, l: +v.l || 0 };
  return c.t || c.r || c.b || c.l ? c : null;
};

/**
 * 90·270도 돌린 한글 그림: 한글은 그림을 돌리기 전 틀(폭·높이를 바꾼 것)에 그려 돌리고, 돌린 뒤의 상자가 개체 크기다.
 * 그 그림의 img 스타일 (자른 그림이거나 크기를 모르면 null: 상자째 돌린다)
 */
function quarterTurn(rot: number, w: number, h: number, crop: unknown): string | null {
  if (!Number.isFinite(rot) || !(w > 0 && h > 0) || crop) return null;
  const r = ((Math.round(rot) % 360) + 360) % 360;
  if (r !== 90 && r !== 270) return null;
  return `display:block;max-width:none;width:${h}px;height:${w}px;transform:translate(${(w - h) / 2}px, ${(h - w) / 2}px) rotate(${r}deg)`;
}

export const KImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('width') || el.style.width;
          const n = v ? parseFloat(v) : NaN;
          return isNaN(n) ? null : Math.round(n);
        },
        renderHTML: (a: Record<string, any>) => (a.width ? { width: a.width } : {}),
      },
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('height') || el.style.height;
          const n = v ? parseFloat(v) : NaN;
          return isNaN(n) ? null : Math.round(n);
        },
        renderHTML: (a: Record<string, any>) => (a.height ? { height: a.height } : {}),
      },
      /** 떠 있는 자리 { x, y, behind? } (px, 문단 상자의 왼쪽 위 기준). 있으면 줄에 끼지 않고 그 자리에 뜬다 (한글 문서 화면 전용) */
      float: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 돌린 각도(도, 시계 방향). 한글 문서 화면 전용. 폭·높이는 돌린 뒤의 상자(한글의 sz): 90·270도는 그림을 폭·높이를 바꾼 틀에 그려 돌린다 */
      rotate: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 그림 보정·효과 (밝기·대비·회색조·투명도·선·그림자·네온·부드러운 가장자리·반사: picLook). 한글 문서에서 읽은 값 */
      look: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          try {
            return cleanLook(JSON.parse(el.getAttribute('data-look') || 'null'));
          } catch {
            return null;
          }
        },
        renderHTML: () => ({}),
      },
      /** 잘라 낸 비율 (0~1): 위/오른쪽/아래/왼쪽 */
      crop: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-crop');
          if (!v) return null;
          const [t, r, b, l] = v.split(',').map(Number);
          return cropOf({ t, r, b, l });
        },
        renderHTML: (a: Record<string, any>) => {
          const c = cropOf(a.crop);
          return c ? { 'data-crop': [c.t, c.r, c.b, c.l].join(',') } : {};
        },
      },
    };
  },

  // 편집기 밖에서 그릴 때(머리말·꼬리말·바탕쪽·도형 안의 글, HTML 저장): 떠 있는 자리·자르기·회전을 편집 화면과 같게
  renderHTML({ node, HTMLAttributes }) {
    const a = node.attrs;
    const fl = floatOf(a.float);
    const c = cropOf(a.crop);
    const rot = Number(a.rotate);
    const turned = Number.isFinite(rot) && rot % 360 !== 0;
    const base = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes);
    const look = cleanLook(a.look);
    if (!fl && !c && !turned && !look) return ['img', base];
    const st: string[] = [];
    const w = +a.width || 0;
    const h = +a.height || 0;
    let imgStyle = '';
    if (c && w && h) {
      const iw = w / Math.max(0.01, 1 - c.l - c.r);
      const ih = h / Math.max(0.01, 1 - c.t - c.b);
      st.push(`width:${w}px`, `height:${h}px`, 'overflow:hidden');
      imgStyle = `width:${iw}px;height:${ih}px;max-width:none;display:block;margin-left:${-c.l * iw}px;margin-top:${-c.t * ih}px`;
    } else if (w && h) imgStyle = `width:${w}px;height:${h}px`;
    if (fl) st.push(`left:${fl.x}px`, `top:${fl.y}px`);
    const qt = quarterTurn(rot, w, h, c);
    if (qt) {
      st.push(`width:${w}px`, `height:${h}px`, 'overflow:hidden');
      imgStyle = qt;
    } else if (turned) st.push(`transform:rotate(${rot}deg)`);
    const ls = look ? lookStyle(look) : null;
    if (ls?.wrap) st.push(ls.wrap);
    if (ls?.img) imgStyle = imgStyle ? imgStyle + ';' + ls.img : ls.img;
    const cls = 'k-image' + (fl ? ' k-float' + (fl.behind ? ' behind' : '') : '') + (c ? ' cropped' : '') + (look?.play ? ' k-play' : '');
    return ['span', { class: cls, style: st.join(';'), ...(fl && fl.py != null ? { 'data-py': String(fl.py) } : {}), ...(look ? { 'data-look': JSON.stringify(look) } : {}) }, ['img', imgStyle ? mergeAttributes(base, { style: imgStyle }) : base]];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      let current = node;
      const wrap = document.createElement('span');
      wrap.className = 'k-image';
      wrap.contentEditable = 'false';
      const img = document.createElement('img');
      img.draggable = false;
      const handle = document.createElement('span');
      handle.className = 'k-image-handle';
      handle.title = '끌기: 크기 조절 / Shift+끌기: 자르기';
      wrap.append(img, handle);

      const layout = (w: number | null, h: number | null, crop: Crop | null) => {
        if (crop && w && h) {
          const iw = w / Math.max(0.01, 1 - crop.l - crop.r);
          const ih = h / Math.max(0.01, 1 - crop.t - crop.b);
          wrap.classList.add('cropped');
          wrap.style.width = w + 'px';
          wrap.style.height = h + 'px';
          img.style.width = iw + 'px';
          img.style.height = ih + 'px';
          img.style.marginLeft = -crop.l * iw + 'px';
          img.style.marginTop = -crop.t * ih + 'px';
        } else {
          wrap.classList.remove('cropped');
          wrap.style.width = '';
          wrap.style.height = '';
          img.style.marginLeft = '';
          img.style.marginTop = '';
          img.style.width = w ? w + 'px' : '';
          img.style.height = h ? h + 'px' : '';
        }
      };
      const apply = (n: typeof node) => {
        // 큰 그림은 한 번만 푼 짧은 주소로 (imageUrls)
        const want = viewSrc(n.attrs.src);
        if (img.getAttribute('src') !== want) img.src = want;
        if (n.attrs.alt) img.alt = n.attrs.alt;
        layout(n.attrs.width, n.attrs.height, cropOf(n.attrs.crop));
        const fl = floatOf(n.attrs.float);
        wrap.classList.toggle('k-float', !!fl);
        wrap.classList.toggle('behind', !!fl?.behind);
        wrap.style.left = fl ? fl.x + 'px' : '';
        wrap.style.top = fl ? fl.y + 'px' : '';
        if (fl && fl.py != null) wrap.setAttribute('data-py', String(fl.py));
        else wrap.removeAttribute('data-py');
        // 글줄 안에서의 세로 자리 (한글 문서: 개체 높이에 따라 기준선 아래로 내린다 — editor.css)
        if (n.attrs.height) wrap.style.setProperty('--kh', n.attrs.height + 'px');
        else wrap.style.removeProperty('--kh');
        const rot = Number(n.attrs.rotate);
        const qt = quarterTurn(rot, +n.attrs.width || 0, +n.attrs.height || 0, cropOf(n.attrs.crop));
        if (qt) {
          // 90·270도: 상자는 돌린 뒤의 크기 그대로, 그림만 폭·높이를 바꾼 틀에 그려 가운데를 중심으로 돌린다
          wrap.style.transform = '';
          wrap.style.width = n.attrs.width + 'px';
          wrap.style.height = n.attrs.height + 'px';
          // 돌리기 전 그림 상자가 줄의 기준선을 정하지 않게 (돌린 그림은 상자 안에 꼭 든다)
          wrap.style.overflow = 'hidden';
          img.style.cssText = qt;
        } else {
          img.style.transform = '';
          wrap.style.overflow = '';
          wrap.style.transform = Number.isFinite(rot) && rot % 360 ? `rotate(${rot}deg)` : '';
        }
        // 그림 보정·효과: 지난번에 준 속성은 지우고 새로
        for (const k of LOOK_PROPS) {
          wrap.style.removeProperty(k);
          img.style.removeProperty(k);
        }
        const css = lookCss(n.attrs.look);
        wrap.classList.toggle('k-play', !!cleanLook(n.attrs.look)?.play);
        for (const [k, v] of Object.entries(css.wrap)) wrap.style.setProperty(k, v);
        for (const [k, v] of Object.entries(css.img)) img.style.setProperty(k, v);
        if (Object.keys(css.wrap).length || Object.keys(css.img).length) wrap.setAttribute('data-look', JSON.stringify(cleanLook(n.attrs.look)));
        else wrap.removeAttribute('data-look');
      };
      apply(node);
      // 그림이 로드되면 그 블록의 높이만 달라지므로 위치를 알려 그 부분만 다시 재게 한다
      img.addEventListener('load', () => {
        // 폭·높이가 모두 정해진 그림(HWP 에서 가져온 그림 전부)은 로드돼도 상자 크기가 그대로라 배치가 바뀌지 않는다
        if (current.attrs.width && current.attrs.height) return;
        // 이미 떨어져 나간 NodeView(getPos 가 undefined)의 로드는 배치에 영향이 없다
        const p = typeof getPos === 'function' ? getPos() : undefined;
        if (typeof p === 'number') window.dispatchEvent(new CustomEvent('kite:relayout', { detail: { pos: p } }));
      });

      handle.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cropping = e.shiftKey;
        const startX = e.clientX;
        const startY = e.clientY;
        const startW = wrap.offsetWidth || img.offsetWidth;
        const startH = wrap.offsetHeight || img.offsetHeight;
        const ratio = startH / Math.max(1, startW);
        const c0 = cropOf(current.attrs.crop) || { t: 0, r: 0, b: 0, l: 0 };
        // 자르기 기준: 원본 전체가 화면에 그려질 크기
        const fullW = startW / Math.max(0.01, 1 - c0.l - c0.r);
        const fullH = startH / Math.max(0.01, 1 - c0.t - c0.b);
        let res = { w: startW, h: startH, crop: c0 as Crop | null };
        const move = (ev: MouseEvent) => {
          const dx = (ev.clientX - startX) / viewState.zoom;
          const dy = (ev.clientY - startY) / viewState.zoom;
          if (cropping) {
            const r = Math.min(1 - c0.l - 0.05, Math.max(0, c0.r - dx / fullW));
            const b = Math.min(1 - c0.t - 0.05, Math.max(0, c0.b - dy / fullH));
            const crop = { ...c0, r, b };
            const w = fullW * (1 - crop.l - crop.r);
            const h = fullH * (1 - crop.t - crop.b);
            res = { w, h, crop };
            layout(w, h, crop);
          } else {
            const w = Math.max(16, startW + dx);
            res = { w, h: w * ratio, crop: cropOf(c0) };
            layout(res.w, res.h, res.crop);
          }
        };
        const up = () => {
          window.removeEventListener('mousemove', move);
          window.removeEventListener('mouseup', up);
          const pos = typeof getPos === 'function' ? getPos() : null;
          if (pos == null) return;
          editor.view.dispatch(
            editor.view.state.tr.setNodeMarkup(pos, undefined, {
              ...current.attrs,
              width: Math.round(res.w),
              height: Math.round(res.h),
              crop: cropOf(res.crop),
            }),
          );
        };
        window.addEventListener('mousemove', move);
        window.addEventListener('mouseup', up);
      });

      return {
        dom: wrap,
        update: (n) => {
          if (n.type !== current.type) return false;
          current = n;
          apply(n);
          return true;
        },
        selectNode: () => wrap.classList.add('selected'),
        deselectNode: () => wrap.classList.remove('selected'),
        ignoreMutation: () => true,
      };
    };
  },
}).configure({ inline: true, allowBase64: true });

/** 붙여 넣은 HTML 의 구역 용지: 숫자만 받아 쓸 수 있는 범위로 (용지 10~2000mm, 여백은 용지 안에) */
function cleanPageSetup(v: any): Record<string, any> | null {
  if (!v || typeof v !== 'object') return null;
  const num = (x: any, lo: number, hi: number) => {
    const n = Number(x);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;
  };
  const width = num(v.width, 10, 2000);
  const height = num(v.height, 10, 2000);
  if (!(Number(v.width) > 0) || !(Number(v.height) > 0)) return null;
  const mh = Math.min(width, height) / 2;
  return {
    width,
    height,
    marginTop: num(v.marginTop, 0, mh),
    marginBottom: num(v.marginBottom, 0, mh),
    marginLeft: num(v.marginLeft, 0, mh),
    marginRight: num(v.marginRight, 0, mh),
    marginHeader: num(v.marginHeader, 0, mh),
    marginFooter: num(v.marginFooter, 0, mh),
    gutter: num(v.gutter, 0, mh),
    landscape: v.landscape === true,
    ...(cleanColumns(v.columns) ? { columns: cleanColumns(v.columns) } : {}),
  };
}

/**
 * 자리 pos 가 놓인 구역의 구역 나누기 (본문 최상위의, pos 앞 마지막 '용지를 가진 쪽 나누기'). 첫 구역이면 null
 */
export function sectionAt(doc: PMNode, pos: number): { pos: number; node: PMNode } | null {
  let found: { pos: number; node: PMNode } | null = null;
  doc.forEach((node, offset) => {
    if (offset >= pos) return;
    if (node.type.name === 'pageBreak' && node.attrs.sectionPage) found = { pos: offset, node };
  });
  return found;
}

/** 쪽 나누기·단 나누기 같은 '나누기' 블록을 커서 자리에 넣는다 (문단 가운데면 문단을 쪼갠다) */
function insertBreak(state: any, tr: Transaction, dispatch: ((tr: Transaction) => void) | undefined, pb: PMNode): boolean {
  const para = state.schema.nodes.paragraph;
  if (!state.selection.empty) tr.deleteSelection();
  const $from = tr.selection.$from;
  let caretPos: number;
  if ($from.depth > 1 || !$from.parent.isTextblock) {
    // 표/목록 안: 해당 최상위 블록 뒤에 넣는다
    const after = $from.after(1);
    tr.insert(after, [pb, para.create()]);
    caretPos = after + 2;
  } else if ($from.parentOffset === 0 && $from.parent.content.size > 0) {
    tr.insert($from.before(), pb);
    caretPos = $from.pos + 1;
  } else if ($from.parentOffset === $from.parent.content.size) {
    const after = $from.after();
    const next = tr.doc.resolve(after).nodeAfter;
    if (next && next.isTextblock) {
      tr.insert(after, pb);
      caretPos = after + 2;
    } else {
      tr.insert(after, [pb, para.create($from.parent.attrs)]);
      caretPos = after + 2;
    }
  } else {
    tr.split($from.pos);
    tr.insert($from.pos + 1, pb);
    caretPos = $from.pos + 3;
  }
  tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(caretPos, tr.doc.content.size))));
  if (dispatch) dispatch(tr.scrollIntoView());
  return true;
}

// ---------------- 책갈피 ----------------
/** 책갈피 이름 검사: 앞뒤 빈칸을 빼고 64자까지 (빈 이름은 쓰지 않는다) */
export const cleanBookmarkName = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 64) : '');

/** 책갈피 (한글의 입력 → 책갈피, Word 의 책갈피): 글 사이의 이름 붙은 자리. 화면에는 문단 부호를 보일 때만 표시가 보인다 */
export const Bookmark = Node.create({
  name: 'bookmark',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return {
      name: {
        default: '',
        parseHTML: (el: HTMLElement) => cleanBookmarkName(el.getAttribute('data-bookmark')),
        renderHTML: (a: Record<string, any>) => ({ 'data-bookmark': cleanBookmarkName(a.name), title: `책갈피: ${cleanBookmarkName(a.name)}` }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-bookmark]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-bookmark' }, HTMLAttributes)];
  },
});

// ---------------- 쪽 나누기 ----------------
export const PageBreak = Node.create({
  name: 'pageBreak',
  priority: 1000,
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      /**
       * 구역 나누기: 여기서 시작하는 구역의 편집 용지 (PageSetup). 없으면 앞 구역의 용지 그대로 쪽만 넘긴다.
       * 한글 문서는 구역마다 용지 크기·방향·여백이 다를 수 있다
       */
      sectionPage: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          try {
            return cleanPageSetup(JSON.parse(el.getAttribute('data-section') || 'null'));
          } catch {
            return null;
          }
        },
        renderHTML: (a: Record<string, any>) => (a.sectionPage ? { 'data-section': JSON.stringify(a.sectionPage) } : {}),
      },
      /** 여기서 시작하는 구역의 머리말·꼬리말·쪽 번호 (Word 의 구역마다 다른 머리말: SectionHf). 화면에 적지 않는다 */
      sectionHf: { default: null, rendered: false },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="page-break"]' }, { tag: 'hr[data-type="page-break"]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-type': 'page-break', class: 'page-break' }];
  },
  addCommands() {
    return {
      setPageBreak:
        () =>
        ({ state, tr, dispatch }) =>
          insertBreak(state, tr, dispatch, state.schema.nodes.pageBreak.create()),
      /** 구역 나누기: 여기서 새 구역이 시작한다 (그 구역의 편집 용지를 따로 정할 수 있다) */
      setSectionBreak:
        (page: PageSetup) =>
        ({ state, tr, dispatch }) =>
          insertBreak(state, tr, dispatch, state.schema.nodes.pageBreak.create({ sectionPage: cleanPageSetup(page) })),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() };
  },
});

// ---------------- 단 나누기 ----------------
/**
 * 단 나누기 (한글의 Ctrl+Shift+Enter): 뒤 내용을 다음 단으로 넘긴다 (마지막 단이면 다음 쪽).
 * columns 가 있으면 '다단 설정 나누기': 여기서부터 그 다단으로 새로 시작한다 (같은 쪽, 앞 다단 아래에서. count 1 이면 한 단으로)
 */
export const ColumnBreak = Node.create({
  name: 'columnBreak',
  priority: 1000,
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      columns: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          try {
            return cleanColumns(JSON.parse(el.getAttribute('data-columns') || 'null'));
          } catch {
            return null;
          }
        },
        renderHTML: (a: Record<string, any>) => (a.columns ? { 'data-columns': JSON.stringify(a.columns) } : {}),
      },
      /** 한글 문서에 있던 나누기 (블록마다 적힌 단을 따르므로 쪽 나누기가 한글 배치를 끊지 않는다) */
      hwp: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-type="column-break"]' }];
  },
  renderHTML({ HTMLAttributes, node }) {
    return ['div', { ...HTMLAttributes, 'data-type': 'column-break', class: 'page-break column-break' + (node.attrs.columns ? ' column-def' : '') }];
  },
  addCommands() {
    return {
      setColumnBreak:
        (columns) =>
        ({ state, tr, dispatch }) =>
          insertBreak(state, tr, dispatch, state.schema.nodes.columnBreak.create(columns ? { columns: cleanColumns(columns) } : null)),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Shift-Enter': () => this.editor.commands.setColumnBreak() };
  },
});

// ---------------- 각주 ----------------
export const Footnote = Node.create({
  name: 'footnote',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-footnote') || '',
        renderHTML: (a: Record<string, any>) => ({ 'data-footnote': a.text }),
      },
      /** 'end': 미주 (문서 끝에 모아 보인다. 번호는 각주와 따로) */
      kind: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-note') === 'end' ? 'end' : null),
        renderHTML: (a: Record<string, any>) => (a.kind === 'end' ? { 'data-note': 'end' } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { class: node.attrs.kind === 'end' ? 'endnote-ref' : 'footnote-ref' }), '*'];
  },
  addNodeView() {
    return ({ node, getPos }) => {
      const dom = document.createElement('sup');
      let cur = node;
      dom.className = node.attrs.kind === 'end' ? 'endnote-ref' : 'footnote-ref';
      dom.textContent = '*';
      dom.title = node.attrs.text;
      dom.setAttribute('data-footnote', node.attrs.text);
      dom.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : null;
        window.dispatchEvent(new CustomEvent('kite:edit-footnote', { detail: { pos, text: cur.attrs.text, kind: cur.attrs.kind } }));
      });
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'footnote' || n.attrs.kind !== cur.attrs.kind) return false;
          cur = n;
          dom.title = n.attrs.text;
          dom.setAttribute('data-footnote', n.attrs.text);
          const p = typeof getPos === 'function' ? getPos() : undefined;
          if (typeof p === 'number') window.dispatchEvent(new CustomEvent('kite:relayout', { detail: { pos: p } }));
          return true;
        },
        ignoreMutation: () => true,
      };
    };
  },
  addCommands() {
    return {
      insertFootnote:
        (text, kind = null) =>
        ({ chain }) =>
          chain().insertContent({ type: 'footnote', attrs: { text, kind: kind === 'end' ? 'end' : null } }).run(),
      updateFootnote:
        (pos, text) =>
        ({ tr, dispatch, state }) => {
          const node = state.doc.nodeAt(pos);
          if (!node || node.type.name !== 'footnote') return false;
          if (dispatch) dispatch(tr.setNodeMarkup(pos, undefined, { text }));
          return true;
        },
    };
  },
});

// ---------------- 글머리표 / 문단 번호 모양 ----------------
const listStyleAttr = {
  listStyle: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.listStyleType || null,
    renderHTML: (a: Record<string, any>) => (a.listStyle ? { style: `list-style-type: ${a.listStyle}` } : {}),
  },
};

export const KBulletList = BulletList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...listStyleAttr };
  },
});

export const KOrderedList = OrderedList.extend({
  addAttributes() {
    return { ...this.parent?.(), ...listStyleAttr };
  },
});

// ---------------- 표 ----------------
/** linear/radial/conic-gradient 에 각도·위치·색만 든 값인지 (임의 CSS·url() 은 거른다) */
function cleanGradient(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return /^(linear|radial|conic)-gradient\([\w\s%.,#()-]{1,400}\)$/.test(s) && !/url|var|expression/i.test(s) ? s : null;
}

/** 칸 대각선 값 검사: 색과 숫자만 받는다 */
function cleanDiag(v: any): { slash: boolean; back: boolean; c: string; zw: number; zh: number; px: number; py: number } | null {
  if (!v || typeof v !== 'object' || !(v.slash || v.back)) return null;
  const num = (x: any, def: number, lo: number, hi: number) => (Number.isFinite(+x) ? Math.min(hi, Math.max(lo, +x)) : def);
  return { slash: !!v.slash, back: !!v.back, c: normColor(v.c) || '#000000', zw: num(v.zw, 100, 100, 100000), zh: num(v.zh, 100, 100, 100000), px: num(v.px, 0, 0, 100), py: num(v.py, 0, 0, 100) };
}

/**
 * 한글 문서의 칸 테두리 값 (editor.css 의 td::before 가 쓴다). CSS 테두리는 인쇄할 때 굵기가 px 단위로 맞춰져
 * 0.12mm 선도 0.4mm 선도 1px 로 찍히므로, 한글 문서는 실제 굵기의 그림자로 선을 긋는다.
 * 실선은 굵기(--bw?)·색(--bc?)을 넘기고, 점선·이중선은 그림자로 긋지 않고(--n?: 0) 그림으로 그린다 (hwpBorderImage)
 */
function hwpBorderVars(css: string): string {
  const sides = parseBorderCss(css);
  const out: string[] = [];
  for (const k of ['t', 'b', 'l', 'r'] as const) {
    const v: BorderSide | undefined = sides[k];
    if (!v) continue;
    if (v.s !== 'solid') {
      out.push(`--n${k}: 0`);
      continue;
    }
    out.push(`--bw${k}: ${Math.round(Math.max(0.05, Math.min(10, v.w)) * 1000) / 1000}mm`, `--bc${k}: ${v.c}`);
  }
  return out.join('; ');
}

let bxSheet: HTMLStyleElement | null = null;
const bxKeys = new Map<string, string>();
const BX_SCOPE = ':is(.workspace.hwp-metrics .ProseMirror, .kdoc-content.hwp-metrics) :is(td, th)';
/**
 * 점선·이중선 테두리 그림 (SVG) 규칙을 (값마다 한 번) 만들고 그 키를 돌려준다. 실선뿐이면 null.
 * 그림은 칸 경계에서 4px 밖까지 덮는 겹(td::after)에 꼭 맞게 그려진다. 선은 실선처럼 경계에서 위·왼쪽으로 굵기만큼 차지한다.
 * 화면용은 가는 선도 1px 보다 가늘지 않게, 인쇄용은 실제 굵기로
 */
function hwpBorderImage(css: string): string | null {
  const sides = parseBorderCss(css);
  const ks = (['t', 'b', 'l', 'r'] as const).filter((k) => sides[k] && sides[k]!.s !== 'solid');
  if (!ks.length) return null;
  const id = ks.map((k) => `${k}:${sides[k]!.w}:${sides[k]!.s}:${sides[k]!.c}`).join(';');
  let key = bxKeys.get(id);
  if (key) return key;
  key = 'b' + bxKeys.size.toString(36);
  bxKeys.set(id, key);
  if (typeof document === 'undefined') return key;
  const N = 4;
  const n = (v: number) => String(Math.round(v * 1000) / 1000);
  const svg = (minPx: number) => {
    let body = '';
    for (const k of ks) {
      const v = sides[k]!;
      const w = Math.max(minPx, Math.max(0.05, Math.min(5, v.w)) * (96 / 25.4));
      // [경계에서 선 가운데까지, 선 굵기, 점선 무늬]
      const strokes: [number, number, string][] =
        v.s === 'double'
          ? // 이중선: 한글은 굵기의 0.42배인 두 줄을 가운데 사이 1.27배로 긋는다 (한글 PDF 로 잰 값)
            [
              [-0.5 - 0.635 * w, Math.max(minPx, 0.42 * w), ''],
              [-0.5 + 0.635 * w, Math.max(minPx, 0.42 * w), ''],
            ]
          : // 점선: 한글의 마디는 굵기의 4/3배, 틈은 2배 (한글 PDF 로 잰 값). 원형 점선은 마디와 틈을 굵기만큼
            [[-w / 2, w, v.s === 'dashed' ? `${n((w * 4) / 3)} ${n(w * 2)}` : `${n(w)} ${n(w)}`]];
      for (const [off, sw, dash] of strokes) {
        const st = `stroke='${v.c}' stroke-width='${n(sw)}'` + (dash ? ` stroke-dasharray='${dash}'` : '');
        if (k === 't') body += `<line x1='${2 * N}' y1='${n(N + off)}' x2='100%' y2='${n(N + off)}' transform='translate(${-N} 0)' ${st}/>`;
        else if (k === 'b') body += `<line x1='${2 * N}' y1='100%' x2='100%' y2='100%' transform='translate(${-N} ${n(-N + off)})' ${st}/>`;
        else if (k === 'l') body += `<line x1='${n(N + off)}' y1='${2 * N}' x2='${n(N + off)}' y2='100%' transform='translate(0 ${-N})' ${st}/>`;
        else body += `<line x1='100%' y1='${2 * N}' x2='100%' y2='100%' transform='translate(${n(-N + off)} ${-N})' ${st}/>`;
      }
    }
    const doc = `<svg xmlns='http://www.w3.org/2000/svg' width='100%' height='100%'>${body}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(doc).replace(/'/g, '%27').replace(/"/g, '%22')}")`;
  };
  if (!bxSheet) {
    bxSheet = document.createElement('style');
    bxSheet.id = 'kite-cell-border-images';
    document.head.appendChild(bxSheet);
  }
  bxSheet.appendChild(
    document.createTextNode(
      `${BX_SCOPE}[data-bx="${key}"]::after { background-image: ${svg(1)}; }
@media print { ${BX_SCOPE}[data-bx="${key}"]::after { background-image: ${svg(0)}; } }
`,
    ),
  );
  return key;
}

const cellAttrs = {
  backgroundColor: {
    default: null,
    // 색 값만 받는다 (HTML/붙여넣기로 들어온 임의 CSS 가 style 에 실리지 않도록)
    parseHTML: (el: HTMLElement) => normColor(el.getAttribute('data-bg') || el.style.backgroundColor),
    renderHTML: (a: Record<string, any>) => {
      const c = normColor(a.backgroundColor);
      return c ? { 'data-bg': c, style: `background-color: ${c}` } : {};
    },
  },
  /** 그러데이션 채우기 (한글): 우리가 만든 꼴의 CSS 그러데이션만 받는다 */
  bgGradient: {
    default: null,
    parseHTML: (el: HTMLElement) => cleanGradient(el.getAttribute('data-bg-gradient')),
    renderHTML: (a: Record<string, any>) => {
      const g = cleanGradient(a.bgGradient);
      return g ? { 'data-bg-gradient': g, style: `background-image: ${g}` } : {};
    },
  },
  /**
   * 대각선 (한글 칸의 대각선): { slash?, back?, c, zw?, zh?, px?, py? }. slash 는 ／, back 은 ＼, c 는 색.
   * 여러 칸에 걸친 대각선(셀 영역)은 zw·zh(영역 크기, 칸 크기의 %)와 px·py(이 칸의 자리, background-position %)로 제 몫만 그린다
   */
  diag: {
    default: null,
    parseHTML: (el: HTMLElement) => {
      try {
        return cleanDiag(JSON.parse(el.getAttribute('data-diag') || 'null'));
      } catch {
        return null;
      }
    },
    renderHTML: (a: Record<string, any>) => {
      const d = cleanDiag(a.diag);
      if (!d) return {};
      const line = (dir: string) => `linear-gradient(to ${dir}, transparent calc(50% - 0.5px), ${d.c} calc(50% - 0.5px), ${d.c} calc(50% + 0.5px), transparent calc(50% + 0.5px))`;
      // 모서리로 향하는 그러데이션의 50% 선은 나머지 두 모서리를 지난다: 'top right' → ＼, 'bottom right' → ／
      const imgs = [d.back ? line('top right') : '', d.slash ? line('bottom right') : ''].filter(Boolean);
      // --dg: 대각선 그림 모두(예전 방식의 규칙용), --dg1·--dg2: 한 겹씩 (한글 문서는 테두리 겹과 함께 그린다)
      return { 'data-diag': JSON.stringify(d), style: `--dg: ${imgs.join(', ')}; --dg1: ${imgs[0]}; --dg2: ${imgs[1] || 'none'}; --dg-size: ${d.zw}% ${d.zh}%; --dg-pos: ${d.px}% ${d.py}%` };
    },
  },
  verticalAlign: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.verticalAlign || el.getAttribute('valign') || null,
    renderHTML: (a: Record<string, any>) => (a.verticalAlign ? { style: `vertical-align: ${a.verticalAlign}` } : {}),
  },
  /** 세로쓰기 (한글의 칸 속성 → 세로쓰기): 글자를 위에서 아래로, 줄은 오른쪽에서 왼쪽으로 */
  vertical: {
    default: null,
    parseHTML: (el: HTMLElement) => (el.hasAttribute('data-vertical') ? true : null),
    renderHTML: (a: Record<string, any>) => (a.vertical === true ? { 'data-vertical': '' } : {}),
  },
  /** 선 굵기/색/종류 (t:0.5mm solid #00A651;...) */
  borderCss: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-border-css') || null,
    renderHTML: (a: Record<string, any>) => {
      if (!a.borderCss) return {};
      const names: Record<string, string> = { t: 'top', b: 'bottom', l: 'left', r: 'right' };
      const half: string[] = [];
      const style = String(a.borderCss)
        .split(';')
        .map((p: string) => {
          const [k, v] = p.split(':');
          if (!names[k] || !v) return '';
          // 이중선: 한글은 두 줄이 보이게 그린다 (적힌 굵기의 두 배 남짓). 화면에서 3px 는 되어야 두 줄로 보인다
          const m = /^([\d.]+)mm double (#[0-9A-Fa-f]{6})$/.exec(v.trim());
          const mm = m ? parseFloat(m[1]) * 2.4 : parseFloat(v);
          // 위·아래 굵은 선: 그려지는 굵기(화면 px 로 내림)의 절반. 한글은 칸 높이에 선 굵기를 넣지 않으므로 그만큼 안 여백을 줄인다 (CSS)
          if ((k === 't' || k === 'b') && mm > 0) {
            const px = Math.max(m ? 3 : 1, Math.floor((mm * 96) / 25.4));
            if (px > 1) half.push(`--bh-${k}: ${px / 2}px`);
          }
          return m ? `border-${names[k]}: max(3px, ${Math.round(parseFloat(m[1]) * 240) / 100}mm) double ${m[2]}` : `border-${names[k]}: ${v}`;
        })
        .filter(Boolean)
        .concat(half)
        .join('; ');
      const bx = hwpBorderImage(String(a.borderCss));
      return { 'data-border-css': a.borderCss, ...(bx ? { 'data-bx': bx } : {}), style: [style, hwpBorderVars(String(a.borderCss))].filter(Boolean).join('; ') };
    },
  },
  /** 칸 자체 안 여백 [왼, 오른, 위, 아래] (px) — 한글 문서의 '칸 여백 지정'. 없으면 표 기본 */
  margins: {
    default: null,
    parseHTML: (el: HTMLElement) => {
      try {
        return cleanMargins(JSON.parse(el.getAttribute('data-cm') || 'null'));
      } catch {
        return null;
      }
    },
    renderHTML: (a: Record<string, any>) => {
      const v = cleanMargins(a.margins);
      if (!v) return {};
      // 위·아래 안 여백이 테두리 굵기의 절반보다 작은 칸: 한글은 선 굵기를 칸 높이에 넣지 않으므로, 모자란 만큼 첫·끝 내용을
      // 테두리 쪽으로 당긴다 (CSS --cneg-t/b → 첫 블록의 margin-top, 끝 블록의 margin-bottom. 한글 문서에서만)
      const half = (k: 't' | 'b') => {
        const side = parseBorderCss(a.borderCss)[k];
        if (!side) return 0.5;
        const mm = side.s === 'double' ? side.w * 2.4 : side.w;
        return Math.max(side.s === 'double' ? 3 : 1, Math.floor((mm * 96) / 25.4)) / 2;
      };
      const neg = (k: 't' | 'b', m: number) => Math.round(Math.max(0, half(k) - m) * 100) / 100;
      const nt = neg('t', v[2]);
      const nb = neg('b', v[3]);
      const extra = (nt > 0 ? `; --cneg-t: -${nt}px` : '') + (nb > 0 ? `; --cneg-b: -${nb}px` : '');
      return { 'data-cm': JSON.stringify(v), style: `--cm-l: ${v[0]}px; --cm-r: ${v[1]}px; --cm-t: ${v[2]}px; --cm-b: ${v[3]}px${extra}` };
    },
  },
  borderStyle: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-border') || null,
    renderHTML: (a: Record<string, any>) => (a.borderStyle ? { 'data-border': a.borderStyle } : {}),
  },
  /**
   * 칸에 걸친 그림 (PDF 의 직인 등 표 위에 겹친 그림): [{ src, x, y, w, h }] — 칸 왼쪽 위 기준 pt.
   * 편집기에 떠 있는 개체가 없어서 겹친 칸마다 배경 그림으로 그 부분을 깐다.
   * 한글의 칸 그림 채우기는 { src, fit } — fit: stretch(칸 크기에 맞춤) · tile(바둑판) · center(가운데).
   */
  bgImages: {
    default: null,
    rendered: true,
    parseHTML: (el: HTMLElement) => {
      try {
        const v = JSON.parse(el.getAttribute('data-bg-images') || 'null');
        return cleanBgImages(v);
      } catch {
        return null;
      }
    },
    renderHTML: (a: Record<string, any>) => {
      const list = cleanBgImages(a.bgImages);
      if (!list) return {};
      // 그림 주소는 style 합치기에서 ';'·':' 가 잘리므로 스타일시트 규칙(data-bg-key)으로 넣는다
      const key = bgRuleFor(list.map((b) => b.src));
      const style = [
        `background-position: ${list.map((b) => (b.fit === 'center' ? 'center' : b.fit ? '0 0' : `${b.x}pt ${b.y}pt`)).join(', ')}`,
        `background-size: ${list.map((b) => (b.fit === 'stretch' ? '100% 100%' : b.fit ? 'auto' : `${b.w}pt ${b.h}pt`)).join(', ')}`,
        `background-repeat: ${list.map((b) => (b.fit === 'tile' ? 'repeat' : 'no-repeat')).join(', ')}`,
        'background-origin: border-box',
      ].join('; ');
      return { 'data-bg-images': JSON.stringify(list), 'data-bg-key': key, style };
    },
  },
  /** 원본 보존형 저장 (formats/hwpBase.ts): 한글 칸의 원본 크기 [폭, 높이] (HWPUNIT). 칸을 고치면 지운다 (hwpKeep) */
  hwpSz: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
};

const blobUrls = new Map<string, string>();
/** data:image 주소 → 같은 그림의 blob: 주소 (한 번만 만든다) */
function blobUrlFor(src: string): string {
  let u = blobUrls.get(src);
  if (u) return u;
  try {
    const m = /^data:([^;,]+);base64,(.*)$/.exec(src);
    if (!m || typeof URL === 'undefined' || !URL.createObjectURL) return '';
    const bin = atob(m[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    u = URL.createObjectURL(new Blob([bytes], { type: m[1] }));
    blobUrls.set(src, u);
    return u;
  } catch {
    return '';
  }
}

let bgSheet: HTMLStyleElement | null = null;
const bgKeys = new Map<string, string>();
/** 그림 주소 목록에 대한 배경 그림 규칙을 (한 번만) 만들고 그 키를 돌려준다 */
function bgRuleFor(srcs: string[]): string {
  const id = srcs.join('|');
  let key = bgKeys.get(id);
  if (key) return key;
  key = 'k' + bgKeys.size.toString(36);
  bgKeys.set(id, key);
  if (typeof document !== 'undefined') {
    if (!bgSheet) {
      bgSheet = document.createElement('style');
      bgSheet.id = 'kite-cell-bg-images';
      document.head.appendChild(bgSheet);
    }
    const urls = srcs.map((s) => `url("${blobUrlFor(s)}")`).join(', ');
    bgSheet.appendChild(document.createTextNode(`[data-bg-key="${key}"] { background-image: ${urls}; }\n`));
  }
  return key;
}

/** 칸 배경 그림 목록: data:image 주소와 유한한 수만 남긴다 (문서에서 온 값이므로) */
type BgImage = { src: string; x: number; y: number; w: number; h: number; fit?: 'stretch' | 'tile' | 'center' };
function cleanBgImages(v: any): BgImage[] | null {
  if (!Array.isArray(v)) return null;
  const num = (n: any) => (typeof n === 'number' && isFinite(n) ? Math.round(n * 10) / 10 : null);
  const FITS = ['stretch', 'tile', 'center'];
  const out = v
    .slice(0, 8)
    .map((b: any) => {
      const fit = FITS.includes(b?.fit) ? b.fit : undefined;
      // 맞춤 방식이 있으면 위치·크기는 칸이 정한다
      return fit ? { src: b?.src, x: 0, y: 0, w: 1, h: 1, fit } : { src: b?.src, x: num(b?.x), y: num(b?.y), w: num(b?.w), h: num(b?.h) };
    })
    .filter((b: any) => typeof b.src === 'string' && /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(b.src) && b.x != null && b.y != null && b.w != null && b.w > 0 && b.h != null && b.h > 0);
  return out.length ? (out as BgImage[]) : null;
}

export const KTableCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttrs };
  },
});

/** 표 줄: 높이(px, 최소 높이) */
export const KTableRow = TableRow.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      height: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = parseFloat(el.style.height);
          return v > 0 ? v : null;
        },
        renderHTML: (a: Record<string, any>) => (a.height ? { style: `height: ${a.height}px; --row-h: ${a.height}px` } : {}),
      },
      // 제목 줄 되풀이 (Word 의 tblHeader): 표가 다음 쪽으로 이어지면 쪽 맨 위에 다시 그린다. 칸 모양은 보통 칸 그대로
      repeat: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-repeat') === '1' ? true : null),
        renderHTML: (a: Record<string, any>) => (a.repeat === true ? { 'data-repeat': '1' } : {}),
      },
    };
  },
});

export const KTableHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), ...cellAttrs };
  },
});

/** 표 속성(테두리 없음, 셀 안 여백, 정렬)을 <table>에 반영하는 NodeView */
class KTableView extends TableView {
  constructor(node: PMNode, cellMinWidth: number, view?: EditorView) {
    super(node, cellMinWidth);
    this.applyAttrs(node);
    // 표 전체 선택 손잡이 (왼쪽 위)
    const handle = document.createElement('div');
    handle.className = 'table-handle';
    handle.contentEditable = 'false';
    handle.title = '표 선택 (끌지 말고 누르기) — 선택 후 Delete로 지우기, Ctrl+X/C로 오려 두기·복사';
    handle.textContent = '⊞';
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!view) return;
      selectTableAtDom(view, this.table);
    });
    this.dom.appendChild(handle);
  }
  ignoreMutation(record: any) {
    if (record.target && (record.target as HTMLElement).classList?.contains('table-handle')) return true;
    return super.ignoreMutation(record);
  }
  update(node: PMNode) {
    const ok = super.update(node);
    if (ok) this.applyAttrs(node);
    return ok;
  }
  applyAttrs(node: PMNode) {
    const t = this.table as HTMLTableElement;
    if (node.attrs.borderless) t.setAttribute('data-borderless', 'true');
    else t.removeAttribute('data-borderless');
    if (node.attrs.tight) t.setAttribute('data-tight', 'true');
    else t.removeAttribute('data-tight');
    if (node.attrs.cellPadding != null) t.style.setProperty('--cell-px', node.attrs.cellPadding + 'px');
    else t.style.removeProperty('--cell-px');
    // 칸 사이 간격 (Word 의 셀 간격): 칸마다 제 테두리를 따로 그린다
    const sp = +node.attrs.cellSpacing;
    t.style.borderCollapse = sp > 0 && sp <= 50 ? 'separate' : '';
    t.style.borderSpacing = sp > 0 && sp <= 50 ? sp + 'px' : '';
    const align = node.attrs.align;
    const indent = typeof node.attrs.indent === 'number' && isFinite(node.attrs.indent) ? Math.max(-200, Math.min(400, node.attrs.indent)) : 0;
    // 한글 표의 바깥 여백 [왼, 오른, 위, 아래]: 위·아래는 그대로 띄우고, 왼쪽은 정렬이 없을 때만 (가운데·오른쪽은 auto 가 자리를 정한다)
    const om = cleanMargins(node.attrs.outMargin);
    const left = (indent ? indent * (96 / 72) : 0) + (om && !align ? om[0] : 0);
    t.style.marginLeft = align === 'center' || align === 'right' ? 'auto' : left ? left.toFixed(1) + 'px' : '';
    // 오른쪽 정렬 표는 한글처럼 오른쪽 바깥 여백만큼 본문 끝에서 떨어진다
    t.style.marginRight = align === 'center' ? 'auto' : align === 'right' && om && om[1] ? om[1] + 'px' : '';
    const gap = typeof node.attrs.hwpGap === 'number' && node.attrs.hwpGap > 0 && node.attrs.hwpGap < 4000 ? node.attrs.hwpGap : 0;
    t.style.marginTop = (om && om[2]) || gap ? ((om ? om[2] : 0) + gap).toFixed(2) + 'px' : '';
    // 표가 이어지는 쪽에서의 위 바깥 여백 (되풀이하는 제목 줄·여는 선의 자리: 세로 오프셋과 칸 안 간격은 첫 쪽에서만 든다)
    const vOff = typeof node.attrs.hwpVOff === 'number' && node.attrs.hwpVOff > 0 ? node.attrs.hwpVOff : 0;
    if (om && om[2]) t.setAttribute('data-om-top', Math.max(0, om[2] - vOff).toFixed(2));
    else t.removeAttribute('data-om-top');
    // 한글 문서의 칸 안에서 표 하나뿐인 문단: 그 줄의 아래 간격(hwpAfter)도 표 아래에 둔다
    const after = (om ? om[3] : 0) + (+node.attrs.hwpAfter > 0 ? +node.attrs.hwpAfter : 0);
    t.style.marginBottom = after ? Math.round(after * 100) / 100 + 'px' : '';
  }
}

/** DOM 속 표를 노드 선택으로 */
export function selectTableAtDom(view: EditorView, table: HTMLElement) {
  try {
    const inside = view.posAtDOM(table, 0);
    const $p = view.state.doc.resolve(inside);
    for (let d = $p.depth; d >= 0; d--) {
      if ($p.node(d).type.name === 'table') {
        view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, $p.before(d))));
        view.focus();
        return;
      }
    }
  } catch {
    /* 무시 */
  }
}

export const KTable = Table.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      /** 글자처럼 취급 (한글 문서에서 읽은 값; 저장할 때 되돌린다) */
      inline: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-inline') === 'true',
        renderHTML: (a: Record<string, any>) => (a.inline ? { 'data-inline': 'true' } : {}),
      },
      /** 한글 문서의 칸·글상자 안에서 표 하나뿐인 문단: 그 줄의 아래 간격과 문단 아래 간격 (px). 표 아래에 둔다 (화면 전용) */
      hwpAfter: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
      /** 표 바깥 여백 [왼, 오른, 위, 아래] (px) — 한글 문서에서 읽은 값을 저장할 때 되돌리려고 둔다 */
      outMargin: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          try {
            return cleanMargins(JSON.parse(el.getAttribute('data-out-margin') || 'null'));
          } catch {
            return null;
          }
        },
        renderHTML: (a: Record<string, any>) => {
          const v = cleanMargins(a.outMargin);
          if (!v) return +a.hwpAfter > 0 ? { style: `margin-bottom: ${Math.round(+a.hwpAfter * 100) / 100}px` } : {};
          // 한글처럼 위·아래 바깥 여백만큼 표를 띄운다 (왼쪽 여백은 정렬이 없을 때만: 가운데·오른쪽 정렬은 CSS 가 자리를 정한다)
          const after = v[3] + (+a.hwpAfter > 0 ? +a.hwpAfter : 0);
          const st = [`margin-top: ${v[2]}px`, `margin-bottom: ${Math.round(after * 100) / 100}px`];
          if (!a.align && v[0]) st.push(`margin-left: ${v[0]}px`);
          if (a.align === 'right' && v[1]) st.push(`margin-right: ${v[1]}px`);
          return { 'data-out-margin': JSON.stringify(v), style: st.join('; ') };
        },
      },
      /**
       * 쪽 경계에서 표를 나누는 방식 (한글의 표 속성): 없으면 '나눔'(칸 안의 줄 단위로 나눈다), 'row' 는 '셀 단위로 나눔'(줄을 통째로 넘긴다),
       * 'none' 은 '나누지 않음'(표를 통째로 다음 쪽으로)
       */
      pageSplit: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-page-split');
          return v === 'row' || v === 'none' ? v : null;
        },
        renderHTML: (a: Record<string, any>) => (a.pageSplit === 'row' || a.pageSplit === 'none' ? { 'data-page-split': a.pageSplit } : {}),
      },
      /** 한글(HWP)에서 이 표가 새 쪽의 맨 위에서 시작했다 (쪽 나누기가 그 자리에서 쪽을 넘긴다). 화면 전용 */
      hwpPage: { default: false, parseHTML: () => false, renderHTML: () => ({}) },
      hwpCol: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      // 한글이 놓은 자리·차례·그때의 내용 크기 (화면 전용: 쪽 나누기가 쓴다)
      hwpTop: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      hwpSeq: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      hwpLen: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 칸·글상자 안에서 앞 블록과 더 벌어진 간격(px): 표가 놓인 문단의 위 간격 등 (화면 전용) */
      hwpGap: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 원본 보존형 저장 (formats/hwpBase.ts): 표가 놓인 문단의 원본 줄 정보·글자 수. 표를 고치면 지운다 (hwpKeep) */
      hwpSeg: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      hwpChars: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 원본 보존형 저장: 떠 있는 표가 딸린 한글 문단 ('prev' 앞 문단, 'next' 뒤 문단)과 원본 자리 { wrap, pos, om } (원문) */
      hwpAnchor: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      hwpPos: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 원본 보존형 저장: 글자처럼 놓인 이 표와 뒤 문단이 원래 한 한글 문단 ('next') */
      hwpJoin: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 원본 보존형 저장: 표가 든 한글 문단의 원본 [문단 모양 번호, 스타일 번호, 읽을 때의 표 속성 열쇠] */
      hwpPr: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 원본 보존형 저장: 한글 표의 원본 크기 [폭, 높이] (HWPUNIT). 표 안을 고치면 지운다 (hwpKeep) */
      hwpSz: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 위 바깥 여백에 더해 둔 세로 오프셋(px: 떠 있는 표가 문단에서 떨어진 거리). 표가 이어지는 쪽에서는 들지 않는다 (화면 전용) */
      hwpVOff: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 한글의 '쪽 경계에서': cell(셀 단위로 나눔: 칸 안에서도 나눈다) · row(나눔: 줄 단위) · none(나누지 않음) */
      hwpSplit: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      /** 칸 안의 표(글자처럼 취급): 표가 놓인 줄의 자리 [[줄 위쪽, 줄 높이, 줄 아래 간격, 기준선]] — 칸이 쪽에 걸쳐 나뉜 자리를 안다 */
      hwpVs: { default: null, parseHTML: () => null, renderHTML: () => ({}) },
      borderless: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-borderless') === 'true',
        renderHTML: (a: Record<string, any>) => (a.borderless ? { 'data-borderless': 'true' } : {}),
      },
      /** 칸 사이 간격 (px): 칸마다 제 테두리를 따로 그리고 이웃한 칸·표 가장자리와 이만큼 띄운다 (Word 의 '셀 간격', HTML 의 cellspacing) */
      cellSpacing: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = parseFloat(el.getAttribute('data-cell-spacing') || '');
          return v > 0 && v <= 50 ? v : null;
        },
        renderHTML: (a: Record<string, any>) => {
          const v = +a.cellSpacing;
          return v > 0 && v <= 50 ? { 'data-cell-spacing': String(v), style: `border-collapse: separate; border-spacing: ${v}px` } : {};
        },
      },
      /** 칸 위아래 안 여백 없음 (PDF 에서 나란한 상자들을 담는 배치용 표) */
      tight: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-tight') === 'true',
        renderHTML: (a: Record<string, any>) => (a.tight ? { 'data-tight': 'true' } : {}),
      },
      /** 셀 왼쪽/오른쪽 안 여백 (px) */
      cellPadding: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = el.style.getPropertyValue('--cell-px');
          return v ? parseFloat(v) : null;
        },
        renderHTML: (a: Record<string, any>) => (a.cellPadding != null ? { style: `--cell-px: ${a.cellPadding}px` } : {}),
      },
      align: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-align') || null,
        renderHTML: (a: Record<string, any>) => (a.align ? { 'data-align': a.align } : {}),
      },
      /** 왼쪽 들여쓰기 (pt) — 왼쪽 정렬일 때 본문 왼쪽 끝에서 표까지 */
      indent: {
        default: null,
        parseHTML: (el: HTMLElement) => {
          const v = parseFloat(el.getAttribute('data-indent') || '');
          return isFinite(v) && v ? v : null;
        },
        renderHTML: (a: Record<string, any>) => (a.indent ? { 'data-indent': String(a.indent), style: `margin-left: ${a.indent}pt` } : {}),
      },
    };
  },
  // 열/행 크기 조절은 tableResize 확장이 맡는다 (여백선 스냅). NodeView 는 직접 연결.
  addNodeView() {
    return ({ node, editor }) => new KTableView(node, 4, editor.view) as any;
  },
}).configure({ resizable: false, cellMinWidth: 4, allowTableNodeSelection: true });

// ---------------- 탭 키 / 수정(겹쳐쓰기) 모드 ----------------
const overwriteKey = new PluginKey('overwrite');

export const KeyboardExtras = Extension.create({
  name: 'keyboardExtras',
  priority: 50,
  addStorage() {
    return { overwrite: false };
  },
  addCommands() {
    return {
      toggleOverwrite:
        () =>
        ({ editor }) => {
          editor.storage.keyboardExtras.overwrite = !editor.storage.keyboardExtras.overwrite;
          editor.view.dispatch(editor.state.tr.setMeta('overwrite-toggle', true));
          return true;
        },
    };
  },
  addKeyboardShortcuts() {
    return {
      Tab: () => {
        const { state } = this.editor;
        const { $from } = state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const n = $from.node(d).type.name;
          if (n === 'tableCell' || n === 'tableHeader' || n === 'listItem' || n === 'taskItem') return false;
        }
        return this.editor.commands.insertContent('\t');
      },
      Insert: () => this.editor.commands.toggleOverwrite(),
    };
  },
  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin({
        key: overwriteKey,
        props: {
          handleTextInput(view, from, to, text) {
            if (!storage.overwrite || from !== to || view.composing) return false;
            const $pos = view.state.doc.resolve(from);
            const end = Math.min($pos.end(), from + text.length);
            if (end <= from) return false;
            const tr = view.state.tr.insertText(text, from, end);
            tr.setSelection(TextSelection.create(tr.doc, from + text.length));
            view.dispatch(tr);
            return true;
          },
        },
      }),
    ];
  },
});

// ---------------- 표 셀 안의 짧은 숫자/영문 낱말 줄바꿈 방지 ----------------
// 한글과 글꼴 너비가 조금 달라 "08:30" 같은 값이 두 줄로 깨지는 것을 막는다.
const NOWRAP_RE = /^[\x21-\x7e]{1,10}$/;
const cellNoWrapKey = new PluginKey<DecorationSet>('cellNoWrap');

/** from~to 범위(최상위 블록 경계로 넓힌 것)의 셀 문단만 검사한다 */
function noWrapDecosIn(doc: PMNode, from: number, to: number): Decoration[] {
  const decos: Decoration[] = [];
  doc.nodesBetween(from, to, (node, pos, parent) => {
    if (node.type.name === 'table' || node.type.name === 'tableRow' || node.type.name === 'tableCell' || node.type.name === 'tableHeader') return true;
    if (node.isTextblock && parent && (parent.type.name === 'tableCell' || parent.type.name === 'tableHeader')) {
      if (NOWRAP_RE.test(node.textContent.trim())) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'k-nowrap' }));
      return false;
    }
    return node.type.name !== 'paragraph';
  });
  return decos;
}

function noWrapDecos(doc: PMNode): DecorationSet {
  return decorationSet(doc, noWrapDecosIn(doc, 0, doc.content.size));
}

/** 최상위 블록 경계로 넓힌 범위 */
function blockSpan(doc: PMNode, from: number, to: number): [number, number] {
  const $f = doc.resolve(Math.max(0, Math.min(from, doc.content.size)));
  const $t = doc.resolve(Math.max(0, Math.min(to, doc.content.size)));
  return [$f.depth ? $f.before(1) : $f.pos, $t.depth ? $t.after(1) : $t.pos];
}

/**
 * 문서가 바뀐 범위(바뀐 최상위 블록)만 다시 계산한다.
 * 큰 문서(표 수백 개)에서 글자 하나 칠 때마다 전체를 훑으면 수십~백 ms 가 걸렸다.
 */
function noWrapDecosIncremental(tr: Transaction, old: DecorationSet): DecorationSet {
  const doc = tr.doc;
  let set = old.map(tr.mapping, doc);
  const spans: [number, number][] = [];
  tr.mapping.maps.forEach((map, i) => {
    const rest = tr.mapping.slice(i + 1);
    map.forEach((_os, _oe, ns, ne) => spans.push(blockSpan(doc, rest.map(ns, -1), rest.map(ne, 1))));
  });
  // 겹치는 범위 합치기
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const sp of spans) {
    const last = merged[merged.length - 1];
    if (last && sp[0] <= last[1]) last[1] = Math.max(last[1], sp[1]);
    else merged.push([...sp] as [number, number]);
  }
  for (const [from, to] of merged) {
    if (to <= from) continue;
    const stale = set.find(from, to);
    if (stale.length) set = set.remove(stale);
    const fresh = noWrapDecosIn(doc, from, to);
    if (fresh.length) set = set.add(doc, fresh);
  }
  return set;
}

export const CellNoWrap = Extension.create({
  name: 'cellNoWrap',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: cellNoWrapKey,
        state: {
          init: (_c, state) => noWrapDecos(state.doc),
          apply: (tr, old) => (tr.docChanged ? noWrapDecosIncremental(tr, old) : old),
        },
        props: {
          decorations(state) {
            return cellNoWrapKey.getState(state);
          },
        },
      }),
    ];
  },
});
