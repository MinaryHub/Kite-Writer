import { useEffect, useReducer, type RefObject } from 'react';
import type { Editor } from '@tiptap/react';
import { app } from './controller';

/** 앱 상태 변경 시 다시 그리기 */
export function useApp() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => app.subscribe(force), []);
  return app;
}

/** 두 손가락으로 벌리고 오므려 확대/축소 (터치 화면). 배율은 프레임마다 한 번만 바꾼다 */
export function usePinchZoom(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let d0 = 0;
    let z0 = 1;
    let want = 0;
    let raf = 0;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const start = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        d0 = dist(e.touches);
        z0 = app.zoom;
      }
    };
    const move = (e: TouchEvent) => {
      if (e.touches.length !== 2 || !d0) return;
      e.preventDefault();
      want = (z0 * dist(e.touches)) / d0;
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          app.setZoom(want);
        });
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length < 2) d0 = 0;
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ref]);
}

/** 편집기 트랜잭션마다(프레임당 1회) 다시 그리기 */
export function useEditorTick(editor: Editor | null | undefined) {
  const [tick, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const h = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        force();
      });
    };
    editor.on('transaction', h);
    editor.on('focus', h);
    return () => {
      editor.off('transaction', h);
      editor.off('focus', h);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [editor]);
  return tick;
}
