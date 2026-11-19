/** 검토 표시(변경 내용·메모)를 다루는 저장용 도우미 (편집기 없이 쓴다) */

/** 저장용: 변경을 모두 받아들인 문서 JSON (변경 기록을 지원하지 않는 형식으로 저장할 때) */
export function acceptAllJson(doc: any): any {
  const walk = (n: any): any => {
    if (!n || typeof n !== 'object') return n;
    if (n.type === 'text') {
      const marks = (n.marks || []).filter((m: any) => m.type !== 'insertion' && m.type !== 'comment');
      if ((n.marks || []).some((m: any) => m.type === 'deletion')) return null;
      return marks.length ? { ...n, marks } : { type: 'text', text: n.text };
    }
    if (!n.content) return n;
    const content = n.content.map(walk).filter((c: any) => c !== null);
    return { ...n, content };
  };
  return walk(doc);
}

/** 저장용: 메모 표시만 뺀 문서 JSON (변경 기록은 저장하지만 메모는 저장하지 못하는 형식: HWPX) */
export function stripCommentsJson(doc: any): any {
  const walk = (n: any): any => {
    if (!n || typeof n !== 'object') return n;
    if (n.type === 'text') {
      if (!(n.marks || []).some((m: any) => m.type === 'comment')) return n;
      const marks = n.marks.filter((m: any) => m.type !== 'comment');
      return marks.length ? { ...n, marks } : { type: 'text', text: n.text };
    }
    if (!n.content) return n;
    return { ...n, content: n.content.map(walk) };
  };
  return walk(doc);
}

/** 형식이 변경 기록(넣음·지움)을 저장하는가 */
export const keepsChanges = (format: string) => format === 'docx' || format === 'hwpx';
/** 형식이 메모를 저장하는가 */
export const keepsComments = (format: string) => format === 'docx';

/** 문서에 변경 표시나 메모가 있는가 (JSON) */
export function hasReviewMarks(doc: any): { changes: boolean; comments: boolean } {
  let changes = false;
  let comments = false;
  const walk = (n: any) => {
    if (!n || typeof n !== 'object' || (changes && comments)) return;
    for (const m of n.marks || []) {
      if (m.type === 'insertion' || m.type === 'deletion') changes = true;
      if (m.type === 'comment') comments = true;
    }
    (n.content || []).forEach(walk);
  };
  walk(doc);
  return { changes, comments };
}
