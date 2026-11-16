import { Extension } from '@tiptap/core';
import { cssToPt, r2 } from '../cssUnits';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textStyleExt: {
      setFontSize: (pt: number | null) => ReturnType;
      changeFontSize: (delta: number) => ReturnType;
      setLetterSpacing: (percent: number | null) => ReturnType;
      setFontWidth: (percent: number | null) => ReturnType;
      setTextEffect: (effect: string | null) => ReturnType;
      setTextStyleAttrs: (attrs: Record<string, any>) => ReturnType;
    };
  }
}

export const TEXT_EFFECT_CSS: Record<string, string> = {
  outline: '-webkit-text-stroke: 0.6px currentColor; color: transparent',
  shadow: 'text-shadow: 0.08em 0.08em 0 #b0b0b0',
  emboss: 'text-shadow: -1px -1px 0 #fff, 1px 1px 0 #999',
  engrave: 'text-shadow: 1px 1px 0 #fff, -1px -1px 0 #999',
};

/** 강조점 → CSS text-emphasis 모양과 자리 (over 위, under 아래) */
export const EMPHASIS_CSS: Record<string, [string, string]> = {
  DOT_ABOVE: ['filled dot', 'over'],
  RING_ABOVE: ['open circle', 'over'],
  TILDE: ["'~'", 'over'],
  CARON: ["'ˇ'", 'over'],
  SIDE: ['filled sesame', 'over'],
  COLON: ["':'", 'over'],
  GRAVE_ACCENT: ["'`'", 'over'],
  ACUTE_ACCENT: ["'´'", 'over'],
  CIRCUMFLEX: ["'^'", 'over'],
  MACRON: ["'¯'", 'over'],
  HOOK_ABOVE: ["'ˀ'", 'over'],
  DOT_BELOW: ['filled dot', 'under'],
};
/** 강조점 이름의 한글 표시 */
export const EMPHASIS_LABELS: [string, string][] = [
  ['', '없음'],
  ['DOT_ABOVE', '검은 점 ·'],
  ['RING_ABOVE', '흰 동그라미 ˚'],
  ['CARON', 'ˇ'],
  ['TILDE', '~'],
  ['SIDE', '、'],
  ['COLON', ':'],
  ['DOT_BELOW', '아래 점'],
];

export const TextStyleExt = Extension.create({
  name: 'textStyleExt',

  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const pt = cssToPt(el.style.fontSize);
              return pt ? r2(pt) : null;
            },
            renderHTML: (a: Record<string, any>) => (a.fontSize ? { style: `font-size: ${a.fontSize}pt` } : {}),
          },
          /** 자간 (%) : 글자 크기 대비 */
          letterSpacing: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const ls = el.style.letterSpacing;
              if (!ls) return null;
              const m = /^(-?[\d.]+)em$/.exec(ls);
              if (m) return Math.round(parseFloat(m[1]) * 100);
              return null;
            },
            renderHTML: (a: Record<string, any>) => (a.letterSpacing ? { style: `letter-spacing: ${a.letterSpacing / 100}em` } : {}),
          },
          /** 장평 (%) */
          fontWidth: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = el.getAttribute('data-font-width');
              return v ? parseInt(v, 10) : null;
            },
            renderHTML: (a: Record<string, any>) =>
              a.fontWidth && a.fontWidth !== 100
                ? { 'data-font-width': a.fontWidth, style: `font-stretch: ${Math.max(50, Math.min(200, a.fontWidth))}%` }
                : {},
          },
          /**
           * 언어별 글꼴 (한글 문서): { en?: 영문, hanja?: 한자, sym?: 기호 } — 한글 글꼴(fontFamily)과 다른 것만.
           * 화면에서는 hwpMetrics 가 그 언어의 글자 묶음에 글꼴을 입힌다.
           */
          langFonts: {
            default: null,
            parseHTML: (el: HTMLElement) => cleanLangFonts(safeJson(el.getAttribute('data-lang-fonts'))),
            renderHTML: (a: Record<string, any>) => {
              const v = cleanLangFonts(a.langFonts);
              return v ? { 'data-lang-fonts': JSON.stringify(v) } : {};
            },
          },
          /** 강조점 (한글의 강조점 이름: DOT_ABOVE, RING_ABOVE, TILDE …) */
          emphasis: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = el.getAttribute('data-emphasis') || '';
              return EMPHASIS_CSS[v] ? v : null;
            },
            renderHTML: (a: Record<string, any>) => {
              const e = EMPHASIS_CSS[a.emphasis];
              return e ? { 'data-emphasis': a.emphasis, style: `text-emphasis: ${e[0]}; -webkit-text-emphasis: ${e[0]}; text-emphasis-position: ${e[1]} right; -webkit-text-emphasis-position: ${e[1]} right` } : {};
            },
          },
          /** 글자 위치 (%: 글자 크기에 대한 비율. 양수면 아래로 — 한글과 같다) */
          offset: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const v = parseFloat(el.getAttribute('data-offset') || '');
              return Number.isFinite(v) && v ? Math.max(-100, Math.min(100, v)) : null;
            },
            renderHTML: (a: Record<string, any>) => {
              const v = +a.offset;
              return Number.isFinite(v) && v ? { 'data-offset': String(v), style: `position: relative; top: ${Math.max(-100, Math.min(100, v)) / 100}em` } : {};
            },
          },
          /** 외곽선/그림자/양각/음각 */
          textEffect: {
            default: null,
            parseHTML: (el: HTMLElement) => el.getAttribute('data-effect') || null,
            renderHTML: (a: Record<string, any>) =>
              a.textEffect && TEXT_EFFECT_CSS[a.textEffect]
                ? { 'data-effect': a.textEffect, style: TEXT_EFFECT_CSS[a.textEffect] }
                : {},
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setTextStyleAttrs:
        (attrs) =>
        ({ chain }) =>
          chain().setMark('textStyle', attrs).removeEmptyTextStyle().run(),
      setFontSize:
        (pt) =>
        ({ commands }) =>
          commands.setTextStyleAttrs({ fontSize: pt }),
      changeFontSize:
        (delta) =>
        ({ editor, commands }) => {
          const cur = editor.getAttributes('textStyle').fontSize || paragraphFontSize(editor) || 10;
          const next = Math.max(1, Math.min(4096, r2(cur + delta)));
          return commands.setTextStyleAttrs({ fontSize: next });
        },
      setLetterSpacing:
        (v) =>
        ({ commands }) =>
          commands.setTextStyleAttrs({ letterSpacing: v || null }),
      setFontWidth:
        (v) =>
        ({ commands }) =>
          commands.setTextStyleAttrs({ fontWidth: v && v !== 100 ? v : null }),
      setTextEffect:
        (e) =>
        ({ commands }) =>
          commands.setTextStyleAttrs({ textEffect: e }),
    };
  },

  addKeyboardShortcuts() {
    return {
      'Alt-Shift-e': () => this.editor.commands.changeFontSize(1),
      'Alt-Shift-r': () => this.editor.commands.changeFontSize(-1),
      'Mod-]': () => this.editor.commands.changeFontSize(1),
      'Mod-[': () => this.editor.commands.changeFontSize(-1),
    };
  },
});

function safeJson(s: string | null): any {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** 언어별 글꼴 값 정리: 알려진 키의 짧은 글꼴 이름만 */
export function cleanLangFonts(v: any): { en?: string; hanja?: string; sym?: string } | null {
  if (!v || typeof v !== 'object') return null;
  const out: Record<string, string> = {};
  for (const k of ['en', 'hanja', 'sym']) if (typeof v[k] === 'string' && v[k].trim() && v[k].length <= 80) out[k] = v[k].trim();
  return Object.keys(out).length ? out : null;
}

function paragraphFontSize(editor: any): number | null {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.attrs && n.attrs.fontSize) return n.attrs.fontSize;
  }
  return null;
}
