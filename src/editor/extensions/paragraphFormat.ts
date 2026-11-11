import { Extension } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { Node as PMNode } from '@tiptap/pm/model';
import { cssToPt, normLineHeight, r2 } from '../cssUnits';
import { normColor } from '../../formats/common';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphFormat: {
      setParagraphAttrs: (attrs: Record<string, any>) => ReturnType;
      setTextAlign: (align: string | null) => ReturnType;
      setLineHeight: (lh: string | null) => ReturnType;
      changeLineHeight: (deltaPercent: number) => ReturnType;
      changeIndent: (deltaPt: number) => ReturnType;
    };
  }
}

export const PARA_TYPES = ['paragraph', 'heading'];

/**
 * 선택 영역 안의 문단마다 fn 을 부른다.
 * 셀 블록 선택(CellSelection)은 from~to 가 마지막 셀만 가리키므로 셀마다 있는 ranges 를 모두 돈다.
 */
export function forEachSelectedPara(state: EditorState, fn: (node: PMNode, pos: number) => void): number {
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const from = Math.min(r.$from.pos, r.$to.pos);
    const to = Math.max(r.$from.pos, r.$to.pos);
    state.doc.nodesBetween(from, to, (node, pos) => {
      if (PARA_TYPES.includes(node.type.name)) {
        if (!seen.has(pos)) {
          seen.add(pos);
          fn(node, pos);
        }
        return false;
      }
      return true;
    });
  }
  return seen.size;
}

const ptAttr = (cssProp: string, styleProp: string) => ({
  default: null,
  parseHTML: (el: HTMLElement) => {
    const v = (el.style as any)[cssProp];
    const pt = cssToPt(v);
    return pt ? r2(pt) : null;
  },
  renderHTML: (attrs: Record<string, any>) => {
    const v = attrs[styleProp];
    return v ? { style: `${cssPropName(cssProp)}: ${v}pt` } : {};
  },
});

function cssPropName(p: string) {
  return p.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
}

export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',

  addGlobalAttributes() {
    return [
      {
        types: PARA_TYPES,
        attributes: {
          textAlign: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const a = el.style.textAlign || el.getAttribute('align');
              if (!a) return null;
              if (a === 'justify' && el.style.textAlignLast === 'justify') return 'distribute';
              if (a === 'start') return 'left';
              if (a === 'end') return 'right';
              return ['left', 'center', 'right', 'justify'].includes(a) ? a : null;
            },
            renderHTML: (attrs: Record<string, any>) => {
              const a = attrs.textAlign;
              if (!a) return {};
              if (a === 'distribute') return { style: 'text-align: justify; text-align-last: justify' };
              return { style: `text-align: ${a}` };
            },
          },
          lineHeight: {
            default: null,
            parseHTML: (el: HTMLElement) => normLineHeight(el.style.lineHeight),
            renderHTML: (attrs: Record<string, any>) => (attrs.lineHeight ? { style: `line-height: ${attrs.lineHeight}` } : {}),
          },
          // 한글 의미: indentLeft = 왼쪽 여백, textIndent = 첫 줄(음수면 내어쓰기).
          // CSS로는 내어쓰기 폭만큼 margin-left를 더하고 text-indent를 음수로 준다.
          indentLeft: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const ml = cssToPt(el.style.marginLeft) || 0;
              const ti = cssToPt(el.style.textIndent) || 0;
              const v = ml - Math.max(0, -ti);
              return v > 0.01 ? r2(v) : null;
            },
            renderHTML: (attrs: Record<string, any>) => {
              const ml = (attrs.indentLeft || 0) + Math.max(0, -(attrs.textIndent || 0));
              return ml ? { style: `margin-left: ${r2(ml)}pt` } : {};
            },
          },
          indentRight: ptAttr('marginRight', 'indentRight'),
          textIndent: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const pt = cssToPt(el.style.textIndent);
              return pt ? r2(pt) : null;
            },
            renderHTML: (attrs: Record<string, any>) => (attrs.textIndent ? { style: `text-indent: ${attrs.textIndent}pt` } : {}),
          },
          spaceBefore: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const pt = cssToPt(el.style.paddingTop || el.style.marginTop);
              return pt ? r2(pt) : null;
            },
            renderHTML: (attrs: Record<string, any>) => (attrs.spaceBefore ? { style: `padding-top: ${attrs.spaceBefore}pt` } : {}),
          },
          spaceAfter: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const pt = cssToPt(el.style.paddingBottom || el.style.marginBottom);
              return pt ? r2(pt) : null;
            },
            renderHTML: (attrs: Record<string, any>) => (attrs.spaceAfter ? { style: `padding-bottom: ${attrs.spaceAfter}pt` } : {}),
          },
          /** 한글 줄 나눔 단위: 글자 (한글의 '줄 나눔 기준 - 한글 단위: 글자'). 기본은 어절 */
          breakChar: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute('data-break') === 'char' ? true : null),
            // normal: 한글은 글자 사이 어디서나 나누고 영어 낱말은 지킨다 (break-all 은 영어 낱말도 자른다)
            renderHTML: (attrs: Record<string, any>) => (attrs.breakChar ? { 'data-break': 'char', style: 'word-break: normal' } : {}),
          },
          /**
           * 한글(HWP)이 배치해 둔 줄: [줄 첫 글자의 문단 안 위치, 줄 폭(px)] 목록과 그때의 문단 내용 크기.
           * 내용 크기가 그대로일 때만 hwpMetrics 가 같은 자리에서 줄을 바꾼다. 화면 전용이라 HTML 로는 나가지 않는다
           */
          hwpLines: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          hwpLen: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 한글이 놓은 줄마다의 세로 자리(px): [줄 위쪽, 줄 높이, 줄 아래 간격, 기준선]. hwpMetrics 가 줄 상자를 그 높이로 만든다 */
          hwpVs: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 한글이 놓은 쪽 안 세로 위치(px, 본문 맨 위 기준). 쪽 나누기가 그 자리에 맞춘다 (본문 최상위 블록만) */
          hwpTop: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 한글 문서에서의 블록 차례 (사이에 지우거나 끼운 블록이 있으면 그 쪽은 한글 위치를 따르지 않는다) */
          hwpSeq: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 칸의 마지막 문단: 마지막 줄 간격·문단 아래 간격을 칸 높이에 넣는다 (한글이 칸 높이를 내용으로 새로 셈한 칸) */
          hwpTrail: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 한글 줄 정보가 없는 문단의 줄 높이 어림: [줄 높이(다음 줄까지), 기준선] px (같은 모양의 다른 문단에서 빌린 값) */
          hwpPitch: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 칸·글상자 안에서 앞 문단과 더 벌어진 간격(px) */
          hwpGap: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 한글(HWP)에서 이 문단이 새 쪽의 맨 위에서 시작했다 (쪽 나누기가 그 자리에서 쪽을 넘긴다) */
          hwpPage: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          paraBg: {
            default: null,
            parseHTML: (el: HTMLElement) => normColor(el.getAttribute('data-bg')),
            renderHTML: (attrs: Record<string, any>) => {
              const c = normColor(attrs.paraBg);
              return c ? { 'data-bg': c, style: `background-color: ${c}` } : {};
            },
          },
          /** 빈 문단의 높이 유지를 위한 문단 기본 글자 크기(pt) */
          fontSize: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              const pt = cssToPt(el.style.fontSize);
              return pt ? r2(pt) : null;
            },
            renderHTML: (attrs: Record<string, any>) => (attrs.fontSize ? { style: `font-size: ${attrs.fontSize}pt` } : {}),
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      setParagraphAttrs:
        (attrs) =>
        ({ tr, state, dispatch }) => {
          const changed = forEachSelectedPara(state, (node, pos) => tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs })) > 0;
          if (changed && dispatch) dispatch(tr);
          return changed;
        },
      setTextAlign:
        (align) =>
        ({ commands }) =>
          commands.setParagraphAttrs({ textAlign: align === 'justify' ? null : align }),
      setLineHeight:
        (lh) =>
        ({ commands }) =>
          commands.setParagraphAttrs({ lineHeight: lh }),
      changeLineHeight:
        (delta) =>
        ({ tr, state, dispatch }) => {
          forEachSelectedPara(state, (node, pos) => {
            const cur = node.attrs.lineHeight;
            let pct = 160;
            if (cur && !/pt$/.test(cur)) pct = Math.round(parseFloat(cur) * 100);
            const next = Math.max(50, Math.min(500, pct + delta));
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight: next === 160 ? null : String(next / 100) });
          });
          if (dispatch) dispatch(tr);
          return true;
        },
      changeIndent:
        (delta) =>
        ({ tr, state, dispatch }) => {
          forEachSelectedPara(state, (node, pos) => {
            const v = Math.max(0, (node.attrs.indentLeft || 0) + delta);
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, indentLeft: v ? r2(v) : null });
          });
          if (dispatch) dispatch(tr);
          return true;
        },
    };
  },

  addKeyboardShortcuts() {
    return {
      'Mod-Shift-l': () => this.editor.commands.setTextAlign('left'),
      'Mod-Shift-c': () => this.editor.commands.setTextAlign('center'),
      'Mod-Shift-r': () => this.editor.commands.setTextAlign('right'),
      'Mod-Shift-m': () => this.editor.commands.setTextAlign('justify'),
      'Mod-Shift-t': () => this.editor.commands.setTextAlign('distribute'),
      'Alt-Shift-a': () => this.editor.commands.changeLineHeight(10),
      'Alt-Shift-z': () => this.editor.commands.changeLineHeight(-10),
    };
  },
});
