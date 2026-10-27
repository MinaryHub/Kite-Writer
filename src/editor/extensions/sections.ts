import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import type { PageSetup } from '../../types';

/**
 * 구역마다 다른 용지. 한글 문서는 구역마다 용지 크기·방향·여백이 다를 수 있는데, 편집기는 하나의 본문 칸(문서 용지의
 * 본문 폭)에 모든 블록을 늘어놓는다. 구역 나누기(쪽 나누기의 sectionPage) 뒤의 최상위 블록을 그 구역 본문의 자리와
 * 폭으로 옮긴다: 블록 자신의 왼쪽·오른쪽 여백에 구역 본문과 문서 본문의 차이를 더한다. 쪽의 세로 자리는 pagination 이 맡는다.
 */
export const sectionsKey = new PluginKey<DecorationSet>('sections');

/** 구역 본문이 문서 본문보다 왼쪽 끝에서 안으로(dl), 오른쪽 끝에서 안으로(dr) 들어간 정도 (px, 음수면 바깥) */
export interface SectionShift {
  dl: number;
  dr: number;
}

export interface SectionsStorage {
  /** 구역 용지 → 옮길 정도. 화면(PageView)이 쪽 배치와 같은 식으로 정해 준다 */
  shiftOf: ((p: PageSetup) => SectionShift) | null;
  /** shiftOf 가 바뀌었는지 가리는 값 */
  key: string;
}

const PT2PX = 96 / 72;

/** 블록 자신의 왼쪽·오른쪽 여백(px). 문단 모양의 들여쓰기·내어쓰기를 CSS 로 그릴 때와 같은 식 */
function ownMargins(node: PMNode): [number, number] {
  const a = node.attrs || {};
  if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return [0, 0];
  const ml = (+a.indentLeft || 0) + Math.max(0, -(+a.textIndent || 0));
  return [ml * PT2PX, (+a.indentRight || 0) * PT2PX];
}

function build(doc: PMNode, shiftOf: SectionsStorage['shiftOf']): DecorationSet {
  if (!shiftOf) return DecorationSet.empty;
  const out: Decoration[] = [];
  let cur: SectionShift | null = null;
  doc.forEach((node, pos) => {
    if (node.type.name === 'pageBreak') {
      const sp = node.attrs?.sectionPage as PageSetup | null;
      if (sp) {
        const s = shiftOf(sp);
        cur = Math.abs(s.dl) > 0.05 || Math.abs(s.dr) > 0.05 ? s : null;
      }
      return;
    }
    if (!cur) return;
    const [ml, mr] = ownMargins(node);
    const style = `margin-left: ${(ml + cur.dl).toFixed(2)}px; margin-right: ${(mr + cur.dr).toFixed(2)}px`;
    out.push(Decoration.node(pos, pos + node.nodeSize, { style }));
  });
  return DecorationSet.create(doc, out);
}

export const Sections = Extension.create<object, SectionsStorage>({
  name: 'sections',

  addStorage() {
    return { shiftOf: null, key: '' };
  },

  addProseMirrorPlugins() {
    const storage = this.storage;
    return [
      new Plugin<DecorationSet>({
        key: sectionsKey,
        state: {
          init: (_c, state) => build(state.doc, storage.shiftOf),
          apply(tr, value, _old, state) {
            if (tr.getMeta(sectionsKey) || tr.docChanged) return build(state.doc, storage.shiftOf);
            return value;
          },
        },
        props: {
          decorations(state) {
            return sectionsKey.getState(state);
          },
        },
      }),
    ];
  },
});
