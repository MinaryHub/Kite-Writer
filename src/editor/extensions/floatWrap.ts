import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { floatOf } from './nodes';

/**
 * 떠 있는 그림·도형·글상자 둘레로 글이 비켜 가게 한다 (Word 의 정사각형·빽빽하게·통과·위아래 배치: float.wrap).
 *
 * 개체는 제자리(문단 기준 절대 위치)에 그대로 두고, 문단 맨 앞에 보이지 않는 CSS float 를 둔다.
 * float 의 꼴(shape-outside)은 개체가 차지하는 세로 범위만이라, 그 위의 글줄은 그대로이고 그 범위의 글줄만 짧아지거나 아래로 밀린다.
 * float 는 뒤따르는 문단의 글줄도 비키게 하므로(Word 도 그렇다) 개체가 문단보다 길어도 된다.
 * 글상자(높이 없는 자리 표시 + 뒤 문단 기준)는 바로 뒤 문단 맨 앞에 둔다.
 */

const key = new PluginKey<WrapState>('floatWrap');

interface WrapState {
  /** 글이 비켜 갈 개체가 문서에 있는가 (없으면 문서가 바뀔 때 새로 든 것만 살핀다) */
  has: boolean;
  set: DecorationSet;
}

/** 비켜 갈 자리 하나 (문단 상자 기준 px). left: 왼쪽에 붙어 글을 오른쪽으로 (a = 폭), right: 오른쪽에 붙어 글을 왼쪽으로 (a = 시작 x), full: 옆을 비움 */
interface Zone {
  f: 'left' | 'right' | 'full';
  a: number;
  top: number;
  bottom: number;
  /** 오른쪽 자리의 폭 (오른쪽 끝에 붙인 상자: 폭을 모르는 Word 의 틀). 있으면 a 대신 쓴다 */
  rw?: number;
}

function zoneOf(n: PMNode): Zone | null {
  const fl = floatOf(n.attrs.float);
  // 쪽 기준 개체(py)는 쪽 나누기 뒤에야 자리가 정해진다: 다루지 않는다. CSS float 로 그리는 틀(cf)은 스스로 글을 비킨다
  if (!fl || !fl.wrap || fl.py != null || fl.behind || fl.cf) return null;
  const w = +n.attrs.width || fl.zw || 0;
  const h = +n.attrs.height || fl.zh || 0;
  if (!(w > 0 && h > 0)) return null;
  const [t, r, b, l] = fl.wrap.d;
  const top = Math.max(0, fl.y - t);
  const bottom = fl.y + h + b;
  if (!(bottom > top)) return null;
  // 오른쪽 끝에서 잰 상자: 글은 왼쪽으로 (옆을 비우는 것은 그대로)
  if (fl.ax === 'r') return fl.wrap.s === 'tb' ? { f: 'full', a: 0, top, bottom } : { f: 'right', a: 0, rw: Math.max(0, fl.x + w + l), top, bottom };
  if (fl.ax === 'c') return { f: 'full', a: 0, top, bottom };
  if (fl.wrap.s === 'r') {
    const a = fl.x + w + r;
    return a > 0 ? { f: 'left', a, top, bottom } : null;
  }
  if (fl.wrap.s === 'l') return { f: 'right', a: Math.max(0, fl.x - l), top, bottom };
  return { f: 'full', a: 0, top, bottom };
}

/** 같은 쪽의 자리는 하나로 합친다 (CSS float 는 나란히 쌓여 제자리를 벗어난다) */
function merge(zs: Zone[]): Zone[] {
  const out: Zone[] = [];
  for (const z of zs) {
    const o = out.find((q) => q.f === z.f);
    if (!o) {
      out.push({ ...z });
      continue;
    }
    o.a = z.f === 'left' ? Math.max(o.a, z.a) : Math.min(o.a, z.a);
    if (z.rw != null || o.rw != null) o.rw = Math.max(o.rw ?? 0, z.rw ?? 0);
    o.top = Math.min(o.top, z.top);
    o.bottom = Math.max(o.bottom, z.bottom);
  }
  // 옆을 비우는 것이 먼저 놓여야 다른 것이 그 옆에 밀려나지 않는다
  return out.sort((p, q) => (p.f === 'full' ? -1 : 0) - (q.f === 'full' ? -1 : 0));
}

const r2 = (v: number) => Math.round(v * 100) / 100;

function zoneDom(z: Zone): HTMLElement {
  const el = document.createElement('span');
  el.className = 'k-wrap-x';
  const side = z.f === 'right' ? 'right' : 'left';
  const width = z.f === 'left' ? `${r2(z.a)}px` : z.f === 'right' ? (z.rw != null ? `${r2(z.rw)}px` : `calc(100% - ${r2(z.a)}px)`) : '100%';
  el.style.cssText = `float:${side};width:${width};height:${r2(z.bottom)}px;shape-outside:inset(${r2(z.top)}px 0 0 0)`;
  // 인쇄: 뒤 블록의 사본에 이어 둘 때 쓴다 (print.ts)
  el.dataset.f = z.f;
  el.dataset.t = String(r2(z.top));
  return el;
}

function widgetAt(pos: number, zones: Zone[]): Decoration {
  const spec = zones.map((z) => `${z.f}${r2(z.a)},${r2(z.top)},${r2(z.bottom)}${z.rw != null ? ',' + r2(z.rw) : ''}`).join('|');
  return Decoration.widget(
    pos,
    () => {
      const box = document.createElement('span');
      box.className = 'k-wrap';
      box.contentEditable = 'false';
      box.setAttribute('aria-hidden', 'true');
      for (const z of zones) box.appendChild(zoneDom(z));
      // 빈 문단의 줄이 폭을 갖게 하는 자리 (editor.css): float 뒤에 있어야 float 가 줄 맨 위에 놓인다
      const w = document.createElement('span');
      w.className = 'k-wrap-w';
      box.appendChild(w);
      return box;
    },
    { side: -1, key: 'kwrap:' + spec, ignoreSelection: true },
  );
}

function build(doc: PMNode): WrapState {
  const decos: Decoration[] = [];
  let has = false;
  const visit = (parent: PMNode, base: number) => {
    // 문단 앞에 놓인 떠 있는 글상자들 (뒤 문단 기준)
    let pending: Zone[] = [];
    parent.forEach((child, offset) => {
      const pos = base + offset;
      if (child.isTextblock) {
        const zs = pending;
        pending = [];
        child.forEach((inl) => {
          if (!inl.attrs.float) return;
          const z = zoneOf(inl);
          if (!z) return;
          has = true;
          zs.push(z);
        });
        if (zs.length) decos.push(widgetAt(pos + 1, merge(zs)));
        return;
      }
      if (child.type.name === 'textBox' && child.attrs.float) {
        const z = zoneOf(child);
        if (z) {
          has = true;
          pending.push(z);
        }
        visit(child, pos + 1);
        return;
      }
      pending = [];
      if (!child.isLeaf) visit(child, pos + 1);
    });
  };
  visit(doc, 0);
  return { has, set: decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty };
}

/** 이 변경이 둘레 글이 비켜 갈 개체를 들여오는가 (그런 개체가 없던 문서에서 다시 셀지 정한다) */
function bringsWrap(tr: Transaction): boolean {
  for (const st of tr.steps as any[]) {
    const content = st.slice?.content;
    if (content && content.size) {
      let found = false;
      content.descendants((n: PMNode) => {
        if (!found && n.attrs?.float?.wrap) found = true;
        return !found;
      });
      if (found) return true;
    }
    if (st.attr === 'float' && st.value?.wrap) return true;
  }
  return false;
}

export const FloatWrap = Extension.create({
  name: 'floatWrap',
  addProseMirrorPlugins() {
    return [
      new Plugin<WrapState>({
        key,
        state: {
          init: (_, state) => build(state.doc),
          apply(tr, old) {
            if (!tr.docChanged) return old;
            if (!old.has && !bringsWrap(tr)) return old;
            return build(tr.doc);
          },
        },
        props: {
          decorations: (state) => key.getState(state)?.set,
          // 빈 문단도 폭을 조금 갖게 한다 (editor.css): 폭 없는 줄은 옆을 비운 개체 곁 0 폭 자리에도 들어가 밀리지 않는다
          attributes: (state): Record<string, string> => (key.getState(state)?.has ? { class: 'k-has-wrap' } : {}),
        },
      }),
    ];
  },
});
