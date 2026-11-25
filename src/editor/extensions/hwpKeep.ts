import { Extension } from '@tiptap/core';
import { Fragment, Slice, type Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { PARA_TYPES } from './paragraphFormat';
import { tabFillKey } from './tabFill';

/**
 * 원본 보존형 저장 (formats/hwpBase.ts): 문서를 고치면, 고친 자리에 걸친 블록(그 블록을 품은 표·글상자까지)의 원본 줄 정보를 지운다.
 * 한글은 저장된 줄 정보를 글이 바뀌어도 그대로 믿고 그리므로, 고친 블록에 원본 줄 정보를 남기면 한글에서 줄이 어긋난다.
 * 줄 정보가 없는 블록부터는 저장할 때 줄 정보를 쓰지 않는다 (한글이 그 뒤를 다시 배치한다).
 * 문서를 통째로 넣는 트랜잭션(불러오기·버전 되돌리기)에는 'hwpKeep' 표시를 달아 건너뛴다.
 *
 * 붙여 넣은 내용에서는 원본 번호(문단 모양·글자 모양 번호)를 지운다: 다른 문서에서 온 번호는 이 문서의 원본 머리부에서 다른 모양을 가리킨다
 */
export const hwpKeepKey = new PluginKey('hwpKeep');

/** 원본 머리부의 번호를 가리키는 속성: 붙여 넣은 내용에서는 지운다 */
const ID_ATTRS = ['hwpPr', 'hwpSeg', 'hwpChars', 'hwpSz', 'hwpCp', 'hwpEnd', 'hwpBf', 'hwpSec', 'hwpRaw', 'hwpLead'];

function stripNode(n: PMNode): PMNode {
  let attrs: Record<string, unknown> | null = null;
  for (const k of ID_ATTRS)
    if (n.attrs[k] != null) {
      attrs = attrs || { ...n.attrs };
      attrs[k] = null;
    }
  const marks = n.marks.some((m) => m.attrs.hwpCp != null) ? n.marks.map((m) => (m.attrs.hwpCp != null ? m.type.create({ ...m.attrs, hwpCp: null }) : m)) : null;
  if (n.isText) return marks ? n.mark(marks) : n;
  const content = n.content.childCount ? stripFragment(n.content) : n.content;
  if (!attrs && !marks && content === n.content) return n;
  return n.type.create(attrs || n.attrs, content, marks || n.marks);
}

function stripFragment(f: Fragment): Fragment {
  const out: PMNode[] = [];
  let changed = false;
  f.forEach((c) => {
    const s = stripNode(c);
    if (s !== c) changed = true;
    out.push(s);
  });
  return changed ? Fragment.from(out) : f;
}

export const HwpKeep = Extension.create({
  name: 'hwpKeep',
  addGlobalAttributes() {
    const plain = { default: null, parseHTML: () => null, renderHTML: () => ({}) };
    return [
      // 원본 보존형 저장 (formats/hwpBase.ts): 개체가 든 한글 글자 묶음의 원본 글자 모양 번호
      { types: ['table', 'textBox', 'image', 'shape'], attributes: { hwpCp: plain } },
      // 칸 안처럼 Kite 가 글 흐름에 둔, 한글에서는 떠 있던 그림의 원본 자리 { wrap, pos, om } (원문)
      { types: ['image'], attributes: { hwpPos: plain } },
      // 표의 원본 테두리/배경 번호, 칸의 원본 [테두리/배경 번호, 읽을 때의 칸 테두리/배경 열쇠]
      { types: ['table', 'tableCell', 'tableHeader'], attributes: { hwpBf: plain } },
      // 표 캡션의 원본 모양 { side, w, gap, full } (HWPUNIT)
      { types: ['table'], attributes: { hwpCap: plain } },
      // 글상자의 세로쓰기 (칸의 세로쓰기는 칸 속성: nodes.ts 의 cellAttrs)
      {
        types: ['textBox'],
        attributes: {
          vertical: {
            default: null,
            parseHTML: (el: HTMLElement) => (el.hasAttribute('data-vertical') ? true : null),
            renderHTML: (a: Record<string, any>) => (a.vertical === true ? { 'data-vertical': '' } : {}),
          },
        },
      },
      // 구역 나누기: 그 구역의 원본 [구역 정의 원문, 읽을 때의 용지 열쇠]
      { types: ['pageBreak'], attributes: { hwpSec: plain } },
      // 고치지 않은 본문 블록의 원문 묶음 { g, i, n, xml?, flags? } (고치면 지운다)
      { types: [...PARA_TYPES, 'table', 'textBox'], attributes: { hwpRaw: { ...plain, keepOnSplit: false } } },
      // 문단 끝(마지막 글자 묶음)의 원본 글자 모양 번호
      { types: PARA_TYPES, attributes: { hwpEnd: { ...plain, keepOnSplit: false } } },
      // HWP: 떠 있는 표가 든 원본 문단의 빈 줄 (뒤 표 문단 자신의 줄: 저장할 때 따로 쓰지 않는다. 글을 넣으면 지운다)
      { types: PARA_TYPES, attributes: { hwpLead: { ...plain, keepOnSplit: false } } },
      // 글자의 원본 [글자 모양 번호, 읽을 때의 글자 모양 열쇠]
      { types: ['textStyle'], attributes: { hwpCp: plain } },
    ];
  },
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: hwpKeepKey,
        props: {
          transformPasted: (slice) => {
            const content = stripFragment(slice.content);
            return content === slice.content ? slice : new Slice(content, slice.openStart, slice.openEnd);
          },
        },
        appendTransaction(trs, _old, state) {
          // 탭 폭 맞춤(화면 배치)은 고친 것이 아니다
          const skip = (tr: (typeof trs)[number]) => !!tr.getMeta('hwpKeep') || !!tr.getMeta(tabFillKey);
          const changed = trs.filter((tr) => tr.docChanged && !skip(tr));
          if (!changed.length) return null;
          // 바뀐 범위: 트랜잭션마다 새 문서 좌표로 모으고, 뒤 트랜잭션들로 옮긴다
          const ranges: [number, number][] = [];
          const idx = trs.indexOf(changed[0]);
          for (let t = idx; t < trs.length; t++) {
            const tr = trs[t];
            for (const r of ranges) {
              r[0] = tr.mapping.map(r[0], -1);
              r[1] = tr.mapping.map(r[1], 1);
            }
            if (!tr.docChanged || skip(tr)) continue;
            const maps = tr.mapping.maps;
            maps.forEach((m, i) => {
              m.forEach((_os, _oe, ns, ne) => {
                let a = ns;
                let b = ne;
                for (let j = i + 1; j < maps.length; j++) {
                  a = maps[j].map(a, -1);
                  b = maps[j].map(b, 1);
                }
                ranges.push([a, b]);
              });
            });
          }
          if (!ranges.length) return null;
          const doc = state.doc;
          const size = doc.content.size;
          const hit = new Set<number>();
          for (const [a0, b0] of ranges) {
            const a = Math.max(0, Math.min(a0, b0) - 1);
            const b = Math.min(size, Math.max(a0, b0) + 1);
            if (a >= b) continue;
            doc.nodesBetween(a, b, (node, pos) => {
              if (node.attrs && (node.attrs.hwpSeg != null || node.attrs.hwpSz != null || node.attrs.hwpRaw != null || node.attrs.hwpLead != null)) hit.add(pos);
              return true;
            });
          }
          if (!hit.size) return null;
          const tr = state.tr;
          for (const pos of hit) {
            const node = tr.doc.nodeAt(pos);
            if (!node) continue;
            const a: Record<string, unknown> = { ...node.attrs };
            if (a.hwpSeg != null) a.hwpSeg = a.hwpChars = null;
            // 칸·표의 원본 크기: 고친 칸과 그 표는 Kite 가 다시 셈한다
            if (a.hwpSz != null) a.hwpSz = null;
            // 원문: 고친 블록은 Kite 가 새로 쓴다
            if (a.hwpRaw != null) a.hwpRaw = null;
            if (a.hwpLead != null) a.hwpLead = null;
            tr.setNodeMarkup(pos, undefined, a, node.marks);
          }
          tr.setMeta('hwpKeep', true);
          tr.setMeta('addToHistory', false);
          tr.setMeta('trackChanges:skip', true);
          return tr.docChanged ? tr : null;
        },
      }),
    ];
  },
});
