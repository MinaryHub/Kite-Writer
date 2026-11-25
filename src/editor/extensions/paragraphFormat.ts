import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { Node as PMNode } from '@tiptap/pm/model';
import { cssToPt, normLineHeight, r2 } from '../cssUnits';
import { cleanPageHide, cleanPageNumStart, cleanParaBorder, normColor } from '../../formats/common';
import { cleanTabs } from '../tabLayout';

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

/** 쪽 나눔 규칙 값: w·n·l 가운데 든 것만 (없으면 null) */
export function cleanKeep(v: any): string | null {
  if (typeof v !== 'string') return null;
  const out = ['w', 'n', 'l'].filter((c) => v.includes(c)).join('');
  return out || null;
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
          /** 쪽 나눔 규칙: w 외톨이줄 방지(쪽에 한 줄만 남기지 않는다), n 다음 문단과 함께, l 문단을 나누지 않음 (쪽 나누기가 따른다) */
          pageKeep: {
            default: null,
            parseHTML: (el: HTMLElement) => cleanKeep(el.getAttribute('data-keep')),
            renderHTML: (attrs: Record<string, any>) => {
              const k = cleanKeep(attrs.pageKeep);
              return k ? { 'data-keep': k } : {};
            },
          },
          /** 탭 자리 (Word 문서): { d: 기본 탭 간격 pt, s: [자리 pt, 맞춤, 채움][] }. 탭 폭은 화면에서 재서 맞춘다 (tabLayout) */
          tabs: {
            default: null,
            parseHTML: (el: HTMLElement) => {
              try {
                return cleanTabs(JSON.parse(el.getAttribute('data-tabs') || 'null'));
              } catch {
                return null;
              }
            },
            renderHTML: (attrs: Record<string, any>) => {
              const t = cleanTabs(attrs.tabs);
              return t ? { 'data-tabs': JSON.stringify(t) } : {};
            },
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
          /** 원본 보존형 저장 (formats/hwpBase.ts): 원본 [문단 모양 번호, 스타일 번호, 읽을 때의 문단 모양 열쇠] */
          hwpPr: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 원본 보존형 저장: 한글이 배치해 둔 줄 정보 (원본 값 그대로). 문단을 고치면 지운다 (hwpKeep) */
          hwpSeg: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 원본 보존형 저장: 읽을 때의 문단 글자 수 (한글 셈) [전체, 앞쪽 컨트롤 몫] */
          hwpChars: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 개요 수준 (1부터): 한글의 개요 문단. 차례 만들기가 제목 문단으로 쓴다 */
          /** 캡션 문단: 바로 뒤('top')·앞('bottom')의 표의 캡션 (한글로 저장하면 표 안의 캡션으로) */
          caption: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => {
              const v = el.getAttribute('data-caption');
              return v === 'top' || v === 'bottom' ? v : null;
            },
            renderHTML: (attrs: Record<string, any>) => (attrs.caption === 'top' || attrs.caption === 'bottom' ? { 'data-caption': attrs.caption } : {}),
          },
          outlineLevel: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => {
              const v = +(el.getAttribute('data-outline') || 0);
              return v >= 1 && v <= 10 ? v : null;
            },
            renderHTML: (a: Record<string, any>) => (+a.outlineLevel >= 1 ? { 'data-outline': String(+a.outlineLevel) } : {}),
          },
          /** 차례 문단 ('title' 차례 제목, 'entry' 항목): 차례 새로 고침이 이 문단들을 다시 만든다 */
          toc: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => {
              const v = el.getAttribute('data-toc');
              return v === 'title' || v === 'entry' ? v : null;
            },
            renderHTML: (a: Record<string, any>) => (a.toc === 'title' || a.toc === 'entry' ? { 'data-toc': a.toc } : {}),
          },
          /** 한글 줄 정보가 없는 문단의 줄 높이 어림: [줄 높이(다음 줄까지), 기준선] px (같은 모양의 다른 문단에서 빌린 값) */
          hwpPitch: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 칸·글상자 안에서 앞 문단과 더 벌어진 간격(px) */
          hwpGap: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 한글(HWP)에서 이 문단이 새 쪽의 맨 위에서 시작했다 (쪽 나누기가 그 자리에서 쪽을 넘긴다) */
          hwpPage: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /** 한글에서 이 문단이 시작한 단 (다단. 0 = 첫 단) */
          hwpCol: { default: null, keepOnSplit: false, parseHTML: () => null, renderHTML: () => ({}) },
          /**
           * 문단 테두리 (한글의 문단 모양 → 테두리/배경): { l, r, t, b: '굵기mm 종류 색', o: 글과의 간격 px [왼, 오른, 위, 아래], c: 이어진 문단과 한 상자 }.
           * 줄 배치를 바꾸지 않도록 문단 상자 위에 얹어 그린다 (editor.css 의 p[data-pb]::after)
           */
          paraBorder: {
            default: null,
            keepOnSplit: true,
            parseHTML: (el: HTMLElement) => {
              try {
                return cleanParaBorder(JSON.parse(el.getAttribute('data-pb') || 'null'));
              } catch {
                return null;
              }
            },
            renderHTML: (attrs: Record<string, any>) => {
              const pb = cleanParaBorder(attrs.paraBorder);
              if (!pb) return {};
              const o = pb.o || [0, 0, 0, 0];
              const st = ['position: relative'];
              for (const k of ['l', 'r', 't', 'b'] as const) st.push(`--pb-${k}: ${pb[k] ? pb[k]!.replace(/^([\d.]+)mm (double)/, (_m, w) => `max(3px, ${Math.round(parseFloat(w) * 240) / 100}mm) double`).replace(/^([\d.]+)mm (solid|dashed|dotted)/, 'max(1px, $1mm) $2') : 'none'}`);
              let ot = `${o[2]}px`;
              let ob = `${o[3]}px`;
              // Word 의 테두리: 위·아래 선은 문단 간격 안쪽(간격 - 선이 차지하는 자리)에 (간격은 상자 바깥이다). 음수면 상자가 간격까지 덮는다
              if (pb.a) {
                const sb = Math.max(0, +attrs.spaceBefore || 0);
                const sa = Math.max(0, +attrs.spaceAfter || 0);
                ot = pb.a[0] < 0 ? '0px' : `calc(${pb.a[0]}px - ${sb}pt)`;
                ob = pb.a[1] < 0 ? '0px' : `calc(${pb.a[1]}px - ${sa}pt)`;
              }
              st.push(`--pb-ol: ${o[0]}px`, `--pb-or: ${o[1]}px`, `--pb-ot: ${ot}`, `--pb-ob: ${ob}`);
              // Word 의 테두리 안 바탕: 테두리 상자를 글 뒤에 칠한다 (문단이 제 쌓임 맥락을 가져 글 아래·문단 위에 놓인다)
              const bg = pb.a ? normColor(attrs.paraBg) : null;
              if (bg) st.push(`--pb-bg: ${bg}`, '--pb-z: -1', 'isolation: isolate');
              return { 'data-pb': JSON.stringify(pb), ...(pb.c ? { 'data-pb-join': pb.c === 2 ? '2' : '1' } : {}), style: st.join('; ') };
            },
          },
          paraBg: {
            default: null,
            parseHTML: (el: HTMLElement) => normColor(el.getAttribute('data-bg')),
            renderHTML: (attrs: Record<string, any>) => {
              const c = normColor(attrs.paraBg);
              // Word 의 테두리 안 바탕: 문단 간격을 빼고 선 안쪽만 칠한다 (테두리 상자가 칠한다: paraBorder)
              if (c && cleanParaBorder(attrs.paraBorder)?.a) return { 'data-bg': c };
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
      {
        // 한글의 '감추기': 이 블록이 놓인 쪽에서 감출 것 (h 머리말, f 꼬리말, m 바탕쪽, b 쪽 테두리, x 쪽 배경, n 쪽 번호)
        types: [...PARA_TYPES, 'table', 'textBox'],
        attributes: {
          pageHide: {
            default: null,
            parseHTML: (el: HTMLElement) => cleanPageHide(el.getAttribute('data-page-hide')),
            renderHTML: (attrs: Record<string, any>) => (cleanPageHide(attrs.pageHide) ? { 'data-page-hide': cleanPageHide(attrs.pageHide) } : {}),
          },
          /** 한글의 '새 번호로 시작' (쪽 번호): 이 블록이 놓인 쪽부터 이 번호로 다시 매긴다 */
          pageNumStart: {
            default: null,
            keepOnSplit: false,
            parseHTML: (el: HTMLElement) => cleanPageNumStart(el.getAttribute('data-page-num-start')),
            renderHTML: (attrs: Record<string, any>) => (cleanPageNumStart(attrs.pageNumStart) != null ? { 'data-page-num-start': String(cleanPageNumStart(attrs.pageNumStart)) } : {}),
          },
        },
      },
      {
        // Word 문서: 표 칸 안에서 안쪽 표 바로 뒤에 오는 마지막 빈 문단. Word 처럼 비어 있는 동안은 그리지 않는다 (editor.css, 커서가 들어가면 나타난다: CellTail)
        types: ['paragraph'],
        attributes: {
          cellTail: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.getAttribute('data-cell-tail') === '1' ? true : null),
            renderHTML: (attrs: Record<string, any>) => (attrs.cellTail === true ? { 'data-cell-tail': '1' } : {}),
          },
        },
      },
    ];
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('cellTailCaret'),
        props: {
          // 숨겨 둔 칸 끝 빈 문단(cellTail)에 커서가 들어가면 보이게 한다 (Word 와 같이)
          decorations(state) {
            const { $from, empty } = state.selection;
            if (!empty || $from.depth < 1 || $from.parent.attrs.cellTail !== true) return null;
            const pos = $from.before();
            return DecorationSet.create(state.doc, [Decoration.node(pos, pos + $from.parent.nodeSize, { class: 'k-caret-here' })]);
          },
        },
      }),
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
