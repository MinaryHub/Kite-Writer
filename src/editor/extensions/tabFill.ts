import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { viewState } from '../viewState';

/**
 * 오른쪽 맞춤 채움 탭 (차례의 "제목 ······· 3").
 *
 * 탭 마크의 right 가 켜진 탭은 뒤따르는 글(쪽 번호)이 문단 오른쪽 끝에 닿도록 폭을 맞춘다. 화면에서 재서 탭의 width
 * 속성에 적어 두므로, 인쇄·PDF·저장(HWP·HWPX 의 탭 폭)도 같은 폭을 쓴다. 제목을 고치면 다시 잰다.
 * 한글 문서에서 읽은 오른쪽 탭(종류 2)도 문단을 고쳐 한글 배치가 풀리면 같은 식으로 맞춘다.
 */
export const tabFillKey = new PluginKey('tabFill');

/** 한글의 탭 종류 값: 오른쪽 탭 */
export const TAB_TYPE_RIGHT = 2;
/** 채움: 점선 */
export const LEADER_DOTS = 3;

/**
 * 이 탭은 폭을 맞춰야 하는가: Kite 가 만든 오른쪽 채움 탭, 한글 문서의 오른쪽 채움 탭(차례). 한글의 오른쪽 탭은 탭 자리가
 * 본문 오른쪽 끝이라(차례) 뒤 글이 오른쪽 끝에 닿게 맞추면 같은 모양이고, 글꼴이 달라 제목 폭이 달라도 쪽 번호가 줄을 맞춘다
 */
function isAuto(mark: { attrs: Record<string, any> }, _para: PMNode): boolean {
  if (mark.attrs.right) return true;
  return +mark.attrs.type === TAB_TYPE_RIGHT && +mark.attrs.leader > 0;
}

const MIN_W = 6;

/** 탭 폭을 한 번 잰다: 바꿀 [위치, 새 폭] 목록 */
function measure(view: EditorView): [number, number][] {
  const root = view.dom as HTMLElement;
  if (!root.isConnected || root.offsetParent === null) return [];
  const z = viewState.zoom || 1;
  const out: [number, number][] = [];
  const spans = root.querySelectorAll('span.k-tab');
  for (const span of Array.from(spans) as HTMLElement[]) {
    if (span.closest('.pg-spacer')) continue;
    let pos: number;
    try {
      pos = view.posAtDOM(span, 0);
    } catch {
      continue;
    }
    const $p = view.state.doc.resolve(pos);
    const para = $p.parent;
    if (!para.isTextblock) continue;
    const node = view.state.doc.nodeAt(pos);
    const mark = node?.marks.find((m) => m.type.name === 'tab');
    if (!node || !mark || node.text !== '\t' || !isAuto(mark, para)) continue;
    const pEl = view.nodeDOM($p.before()) as HTMLElement | null;
    if (!(pEl instanceof HTMLElement)) continue;
    const pr = pEl.getBoundingClientRect();
    const cs = getComputedStyle(pEl);
    const right = pr.right - (parseFloat(cs.paddingRight) || 0) * z - (parseFloat(cs.borderRightWidth) || 0) * z;
    const left = pr.left + (parseFloat(cs.paddingLeft) || 0) * z + (parseFloat(cs.borderLeftWidth) || 0) * z;
    // 탭 앞 글의 끝 (그 글의 마지막 줄): 탭은 거기서 시작한다. 탭이 지금 다음 줄로 밀려 있어도 앞 글 기준으로 다시 잰다
    const before = document.createRange();
    before.setStart(pEl, 0);
    before.setEndBefore(span);
    let prev: DOMRect | null = null;
    for (const r of Array.from(before.getClientRects())) {
      if (r.width <= 0) continue;
      if (!prev || r.bottom > prev.bottom + 1 || (Math.abs(r.bottom - prev.bottom) <= 1 && r.right > prev.right)) prev = r;
    }
    const prevRight = prev ? prev.right : left + Math.max(0, parseFloat(cs.textIndent) || 0) * z;
    // 탭 뒤 글(쪽 번호)의 폭: 줄이 넘어가 있어도 폭만 센다
    const after = document.createRange();
    after.setStartAfter(span);
    after.setEnd(pEl, pEl.childNodes.length);
    let afterW = 0;
    for (const r of Array.from(after.getClientRects())) if (r.width > 0) afterW += r.width;
    const cur = +mark.attrs.width > 0 ? +mark.attrs.width : span.getBoundingClientRect().width / z;
    // 오른쪽 끝에 꼭 맞추면 반올림으로 줄이 넘어갈 수 있어 1px 남긴다
    let want = (right - prevRight - afterW) / z - 1;
    // 제목이 줄 끝까지 차서 들어갈 자리가 없으면 한글처럼 다음 줄 처음부터 채운다
    if (want < MIN_W) want = (right - left - afterW) / z - 1;
    want = Math.max(MIN_W, want);
    if (Math.abs(want - cur) > 0.5 || !(+mark.attrs.width > 0)) out.push([pos, Math.round(want * 100) / 100]);
  }
  return out;
}

export const TabFill = Extension.create({
  name: 'tabFill',
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: tabFillKey,
        view(view) {
          let raf = 0;
          let passes = 0;
          /** 지금 보내는 거래가 우리 것 (사용자 편집이 오면 되풀이 횟수를 새로 센다) */
          let ours = false;
          const run = () => {
            raf = 0;
            if (view.isDestroyed || view.composing) return;
            const fix = measure(view);
            if (!fix.length) {
              passes = 0;
              return;
            }
            // 잰 폭이 줄 바꿈을 바꿔 다시 달라질 수 있다: 몇 번까지만 되풀이한다
            if (++passes > 4) return;
            const tr = view.state.tr;
            for (const [pos, w] of fix) {
              const node = tr.doc.nodeAt(pos);
              const mark = node?.marks.find((m) => m.type.name === 'tab');
              if (!node || !mark) continue;
              tr.removeMark(pos, pos + 1, mark).addMark(pos, pos + 1, mark.type.create({ ...mark.attrs, width: w }));
            }
            tr.setMeta('addToHistory', false).setMeta(tabFillKey, true).setMeta('trackChanges:skip', true);
            ours = true;
            view.dispatch(tr);
            ours = false;
          };
          const schedule = () => {
            if (!raf) raf = requestAnimationFrame(run);
          };
          const fonts: FontFaceSet | undefined = typeof document !== 'undefined' ? (document as any).fonts : undefined;
          const onRe = () => schedule();
          fonts?.addEventListener('loadingdone', onRe);
          window.addEventListener('resize', onRe);
          schedule();
          return {
            update(v, prev) {
              if (v.state.doc === prev.doc) return;
              if (!ours) passes = 0;
              // 폭을 적은 우리 거래는 한 번 더 재서 맞았는지 본다 (passes 가 끝없는 되풀이를 막는다)
              schedule();
            },
            destroy() {
              if (raf) cancelAnimationFrame(raf);
              fonts?.removeEventListener('loadingdone', onRe);
              window.removeEventListener('resize', onRe);
            },
          };
        },
      }),
    ];
  },
});
