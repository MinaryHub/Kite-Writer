import { Mark, mergeAttributes } from '@tiptap/core';
import Underline from '@tiptap/extension-underline';
import Strike from '@tiptap/extension-strike';
import { AUTO_NUM_KINDS, normColor } from '../../formats/common';

/**
 * 한글의 글자 모양 가운데 줄·덧말·겹침: 밑줄(종류·색·위치), 취소선(종류·색), 덧말(글 위의 작은 글), 글자 겹침(원·네모 안의 글자).
 */

/** 한글의 선 종류 이름 */
export const LINE_SHAPES = ['SOLID', 'DASH', 'DOT', 'DASH_DOT', 'DASH_DOT_DOT', 'LONG_DASH', 'CIRCLE', 'DOUBLE_SLIM', 'SLIM_THICK', 'THICK_SLIM', 'SLIM_THICK_SLIM', 'WAVE', 'DOUBLE_WAVE'];

/** 한글의 선 종류 → CSS text-decoration-style */
export function decoStyle(shape: unknown): string {
  const s = typeof shape === 'string' ? shape : '';
  if (/^(DASH|LONG_DASH|DASH_DOT|DASH_DOT_DOT)$/.test(s)) return 'dashed';
  if (/^(DOT|CIRCLE)$/.test(s)) return 'dotted';
  if (/^(DOUBLE_SLIM|SLIM_THICK|THICK_SLIM|SLIM_THICK_SLIM)$/.test(s)) return 'double';
  if (/WAVE/.test(s)) return 'wavy';
  return 'solid';
}

const cleanShape = (v: unknown) => (typeof v === 'string' && LINE_SHAPES.includes(v) && v !== 'SOLID' ? v : null);

const lineAttrs = {
  /** 선 종류 (한글 이름: DASH, DOT, DOUBLE_SLIM, WAVE …). 없으면 실선 */
  shape: {
    default: null,
    parseHTML: (el: HTMLElement) => cleanShape(el.getAttribute('data-shape')),
    renderHTML: (a: Record<string, any>) => (cleanShape(a.shape) ? { 'data-shape': a.shape } : {}),
  },
  /** 선 색. 없으면 글자 색 */
  color: {
    default: null,
    parseHTML: (el: HTMLElement) => normColor(el.getAttribute('data-line-color')),
    renderHTML: (a: Record<string, any>) => (normColor(a.color) ? { 'data-line-color': normColor(a.color) } : {}),
  },
};

function decoCss(line: string, a: Record<string, any>): string {
  const st = [`text-decoration-line: ${line}`];
  const style = decoStyle(a.shape);
  if (style !== 'solid') st.push(`text-decoration-style: ${style}`);
  const c = normColor(a.color);
  if (c) st.push(`text-decoration-color: ${c}`);
  return st.join('; ');
}

/** 밑줄: 종류·색, 그리고 글자 위에 긋는 윗줄 (한글의 밑줄 위치 '위쪽') */
export const KUnderline = Underline.extend({
  addAttributes() {
    return {
      ...lineAttrs,
      /** 'top' 이면 글자 위에 긋는다 */
      pos: {
        default: null,
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-line-pos') === 'top' ? 'top' : null),
        renderHTML: (a: Record<string, any>) => (a.pos === 'top' ? { 'data-line-pos': 'top' } : {}),
      },
    };
  },
  renderHTML({ mark, HTMLAttributes }) {
    const plain = !cleanShape(mark.attrs.shape) && !normColor(mark.attrs.color) && mark.attrs.pos !== 'top';
    return ['u', plain ? HTMLAttributes : mergeAttributes(HTMLAttributes, { style: decoCss(mark.attrs.pos === 'top' ? 'overline' : 'underline', mark.attrs) }), 0];
  },
});

/** 취소선: 종류·색 */
export const KStrike = Strike.extend({
  addAttributes() {
    return { ...lineAttrs };
  },
  renderHTML({ mark, HTMLAttributes }) {
    const plain = !cleanShape(mark.attrs.shape) && !normColor(mark.attrs.color);
    return ['s', plain ? HTMLAttributes : mergeAttributes(HTMLAttributes, { style: decoCss('line-through', mark.attrs) }), 0];
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ruby: { setRuby: (text: string, pos?: 'top' | 'bottom') => ReturnType; unsetRuby: () => ReturnType };
    compose: { setCompose: (shape: string) => ReturnType; unsetCompose: () => ReturnType };
  }
}

/** 덧말: 본말 위(아래)에 작은 글을 얹는다 */
export const Ruby = Mark.create({
  name: 'ruby',
  inclusive: false,
  addAttributes() {
    return {
      text: {
        default: '',
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-rt') || '').slice(0, 200),
        renderHTML: (a: Record<string, any>) => ({ 'data-rt': String(a.text || '').slice(0, 200) }),
      },
      pos: {
        default: 'top',
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-rt-pos') === 'bottom' ? 'bottom' : 'top'),
        renderHTML: (a: Record<string, any>) => (a.pos === 'bottom' ? { 'data-rt-pos': 'bottom' } : {}),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-ruby[data-rt]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-ruby' }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setRuby:
        (text, pos = 'top') =>
        ({ commands }) =>
          commands.setMark(this.name, { text, pos }),
      unsetRuby:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});

/** 글자 겹침의 테두리 모양 (한글 값) */
export const COMPOSE_SHAPES = ['CHAR', 'SHAPE_CIRCLE', 'SHAPE_REVERSAL_CIRCLE', 'SHAPE_RECTANGLE', 'SHAPE_REVERSAL_RECTANGLE', 'SHAPE_TRIANGLE', 'SHAPE_REVERSAL_TIRANGLE', 'SHAPE_LIGHT', 'SHAPE_RHOMBUS', 'SHAPE_REVERSAL_RHOMBUS', 'SHAPE_ROUNDED_RECTANGLE', 'SHAPE_EMPTY_CIRCULATE_ARROW', 'SHAPE_THIN_CIRCULATE_ARROW', 'SHAPE_THICK_CIRCULATE_ARROW'];

/**
 * 자동 번호 (한글의 캡션 '표 1'·'그림 2' 의 번호): 글은 읽을 때의 번호이고, 한글로 저장하면 번호 컨트롤로 되돌린다 (한글이 다시 매긴다)
 */
export const AutoNum = Mark.create({
  name: 'autoNum',
  inclusive: false,
  addAttributes() {
    return {
      kind: {
        default: 'TABLE',
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-autonum') || '';
          return AUTO_NUM_KINDS.includes(v) ? v : 'TABLE';
        },
        renderHTML: (a: Record<string, any>) => ({ 'data-autonum': AUTO_NUM_KINDS.includes(a.kind) ? a.kind : 'TABLE' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-autonum]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-autonum' }, HTMLAttributes), 0];
  },
});

/** 글자 겹침: 글자들을 한 글자 자리에 겹쳐 쓰고 원·네모 등으로 두른다 */
export const Compose = Mark.create({
  name: 'compose',
  inclusive: false,
  addAttributes() {
    return {
      shape: {
        default: 'SHAPE_CIRCLE',
        parseHTML: (el: HTMLElement) => {
          const v = el.getAttribute('data-compose') || '';
          return COMPOSE_SHAPES.includes(v) ? v : 'SHAPE_CIRCLE';
        },
        renderHTML: (a: Record<string, any>) => ({ 'data-compose': COMPOSE_SHAPES.includes(a.shape) ? a.shape : 'SHAPE_CIRCLE' }),
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-compose[data-compose]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-compose' }, HTMLAttributes), 0];
  },
  addCommands() {
    return {
      setCompose:
        (shape) =>
        ({ commands }) =>
          commands.setMark(this.name, { shape }),
      unsetCompose:
        () =>
        ({ commands }) =>
          commands.unsetMark(this.name),
    };
  },
});
