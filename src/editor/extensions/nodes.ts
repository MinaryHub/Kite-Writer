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
import { cleanMargins } from '../../formats/flatten';
import { normColor } from '../../formats/common';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: { setPageBreak: () => ReturnType };
    footnote: { insertFootnote: (text: string) => ReturnType; updateFootnote: (pos: number, text: string) => ReturnType };
    overwrite: { toggleOverwrite: () => ReturnType };
  }
}

// ---------------- 글상자 (도형 안의 글) ----------------
const RADIUS_RE = /^[\d.]+(px|%)$/;

/** 한글의 글상자·도형 안 글. 크기가 정해진 상자 안에 문단이 들어가며, 배경(색·그림)과 테두리를 가진다 */
export const TextBox = Node.create({
  name: 'textBox',
  group: 'block',
  content: 'block+',
  defining: true,
  isolating: true,
  addAttributes() {
    const plain = { default: null, rendered: false };
    return { width: plain, height: plain, bg: plain, bgImage: plain, borderColor: plain, borderWidth: plain, radius: plain, padding: plain };
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
    if (num(a.height)) st.push(`min-height:${num(a.height)}px`);
    const bg = normColor(a.bg);
    if (bg) st.push(`background-color:${bg}`);
    if (typeof a.bgImage === 'string' && /^data:image\//.test(a.bgImage)) st.push(`background-image:url("${a.bgImage}")`);
    const bc = normColor(a.borderColor);
    if (bc) st.push(`border:${num(a.borderWidth) || 1}px solid ${bc}`);
    if (typeof a.radius === 'string' && RADIUS_RE.test(a.radius)) st.push(`border-radius:${a.radius}`);
    if (Array.isArray(a.padding) && a.padding.length === 4) st.push(`padding:${a.padding.map((v: any) => Math.max(0, +v || 0) + 'px').join(' ')}`);
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
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-tab' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-tab' }, HTMLAttributes), 0];
  },
});

// ---------------- 그림 (크기 조절·자르기) ----------------
export interface Crop {
  t: number;
  r: number;
  b: number;
  l: number;
}

export const cropOf = (v: any): Crop | null => {
  if (!v) return null;
  const c = { t: +v.t || 0, r: +v.r || 0, b: +v.b || 0, l: +v.l || 0 };
  return c.t || c.r || c.b || c.l ? c : null;
};

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
        if (img.getAttribute('src') !== n.attrs.src) img.src = n.attrs.src;
        if (n.attrs.alt) img.alt = n.attrs.alt;
        layout(n.attrs.width, n.attrs.height, cropOf(n.attrs.crop));
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
function cleanPageSetup(v: any): Record<string, number | boolean> | null {
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
  };
}

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
        ({ state, tr, dispatch }) => {
          const pb = state.schema.nodes.pageBreak.create();
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
        },
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.setPageBreak() };
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
    };
  },
  parseHTML() {
    return [{ tag: 'sup[data-footnote]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['sup', mergeAttributes(HTMLAttributes, { class: 'footnote-ref' }), '*'];
  },
  addNodeView() {
    return ({ node, getPos }) => {
      const dom = document.createElement('sup');
      dom.className = 'footnote-ref';
      dom.textContent = '*';
      dom.title = node.attrs.text;
      dom.setAttribute('data-footnote', node.attrs.text);
      dom.addEventListener('dblclick', (e) => {
        e.preventDefault();
        const pos = typeof getPos === 'function' ? getPos() : null;
        window.dispatchEvent(new CustomEvent('kite:edit-footnote', { detail: { pos, text: node.attrs.text } }));
      });
      return {
        dom,
        update: (n) => {
          if (n.type.name !== 'footnote') return false;
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
        (text) =>
        ({ chain }) =>
          chain().insertContent({ type: 'footnote', attrs: { text } }).run(),
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
  verticalAlign: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.verticalAlign || el.getAttribute('valign') || null,
    renderHTML: (a: Record<string, any>) => (a.verticalAlign ? { style: `vertical-align: ${a.verticalAlign}` } : {}),
  },
  /** 선 굵기/색/종류 (t:0.5mm solid #00A651;...) */
  borderCss: {
    default: null,
    parseHTML: (el: HTMLElement) => el.getAttribute('data-border-css') || null,
    renderHTML: (a: Record<string, any>) => {
      if (!a.borderCss) return {};
      const names: Record<string, string> = { t: 'top', b: 'bottom', l: 'left', r: 'right' };
      const style = String(a.borderCss)
        .split(';')
        .map((p: string) => {
          const [k, v] = p.split(':');
          return names[k] && v ? `border-${names[k]}: ${v}` : '';
        })
        .filter(Boolean)
        .join('; ');
      return { 'data-border-css': a.borderCss, style };
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
      return v ? { 'data-cm': JSON.stringify(v), style: `--cm-l: ${v[0]}px; --cm-r: ${v[1]}px; --cm-t: ${v[2]}px; --cm-b: ${v[3]}px` } : {};
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
    const align = node.attrs.align;
    const indent = typeof node.attrs.indent === 'number' && isFinite(node.attrs.indent) ? Math.max(-200, Math.min(400, node.attrs.indent)) : 0;
    // 한글 표의 바깥 여백 [왼, 오른, 위, 아래]: 위·아래는 그대로 띄우고, 왼쪽은 정렬이 없을 때만 (가운데·오른쪽은 auto 가 자리를 정한다)
    const om = cleanMargins(node.attrs.outMargin);
    const left = (indent ? indent * (96 / 72) : 0) + (om && !align ? om[0] : 0);
    t.style.marginLeft = align === 'center' || align === 'right' ? 'auto' : left ? left.toFixed(1) + 'px' : '';
    t.style.marginRight = align === 'center' ? 'auto' : '';
    t.style.marginTop = om && om[2] ? om[2] + 'px' : '';
    t.style.marginBottom = om && om[3] ? om[3] + 'px' : '';
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
          if (!v) return {};
          // 한글처럼 위·아래 바깥 여백만큼 표를 띄운다 (왼쪽 여백은 정렬이 없을 때만: 가운데·오른쪽 정렬은 CSS 가 자리를 정한다)
          const st = [`margin-top: ${v[2]}px`, `margin-bottom: ${v[3]}px`];
          if (!a.align && v[0]) st.push(`margin-left: ${v[0]}px`);
          return { 'data-out-margin': JSON.stringify(v), style: st.join('; ') };
        },
      },
      /** 한글(HWP)에서 이 표가 새 쪽의 맨 위에서 시작했다 (쪽 나누기가 그 자리에서 쪽을 넘긴다). 화면 전용 */
      hwpPage: { default: false, parseHTML: () => false, renderHTML: () => ({}) },
      borderless: {
        default: false,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-borderless') === 'true',
        renderHTML: (a: Record<string, any>) => (a.borderless ? { 'data-borderless': 'true' } : {}),
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
  return DecorationSet.create(doc, noWrapDecosIn(doc, 0, doc.content.size));
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
