import { Mark, mergeAttributes } from '@tiptap/core';
import { crossRefLabel, parseCrossRef } from '../../formats/crossRef';

/**
 * 상호 참조 (한글의 상호 참조 필드): 책갈피 등 대상의 쪽 번호·이름·위/아래를 보이는 글. 글에 다는 표시(mark)로 두고,
 * 명령 글(cmd: formats/crossRef.ts)을 그대로 지닌다. 결과 글은 '상호 참조 새로 고침'이 다시 셈한다 (app/crossRefs.ts)
 */
export const CrossRef = Mark.create({
  name: 'crossRef',
  // 상호 참조 끝에서 이어 치는 글은 상호 참조 밖 (결과 글만 상호 참조)
  inclusive: false,
  addAttributes() {
    return {
      cmd: {
        default: '',
        parseHTML: (el: HTMLElement) => (el.getAttribute('data-xref') || '').slice(0, 1000),
        renderHTML: (a: Record<string, any>) => {
          const r = parseCrossRef(a.cmd);
          return { 'data-xref': String(a.cmd || '').slice(0, 1000), ...(r ? { title: crossRefLabel(r) } : {}) };
        },
      },
    };
  },
  parseHTML() {
    return [{ tag: 'span.k-xref[data-xref]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes({ class: 'k-xref' }, HTMLAttributes), 0];
  },
});
