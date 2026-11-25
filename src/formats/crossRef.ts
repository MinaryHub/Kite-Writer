/**
 * 상호 참조 (한글의 필드: HWPX fieldBegin type="CROSSREF", HWP 필드 컨트롤 %xrf). 명령 글은
 *   "<대상>;<종류>;<내용>;<하이퍼링크>"
 * 대상: 책갈피는 '?' + 책갈피 이름. 종류: 0 표, 1 그림, 2 수식, 3 각주, 4 미주, 5 개요, 6 책갈피.
 * 내용: 0 쪽 번호, 1 번호(책갈피는 이름), 2 내용, 3 위/아래. 하이퍼링크: 1 이면 누르면 대상으로 간다.
 * (2026-11-25 한글 2018 자동화로 넣어 본 것: 결과 글은 필드 안에 한글이 적어 둔다 — 책갈피 쪽 번호면 "1")
 */
export const XREF_TYPES = ['TARGET_TABLE', 'TARGET_PICTURE', 'TARGET_EQUATION', 'TARGET_FOOTNOTE', 'TARGET_ENDNOTE', 'TARGET_OUTLINE', 'TARGET_BOOKMARK'];
export const XREF_CONTENTS = ['OBJECT_TYPE_PAGE', 'OBJECT_TYPE_NUMBER', 'OBJECT_TYPE_CONTENTS', 'OBJECT_TYPE_UPDOWNPOS'];
/** 종류 번호: 책갈피 */
export const XREF_BOOKMARK = 6;

export interface CrossRef {
  /** 대상 경로 (명령 글의 첫 마디 그대로) */
  path: string;
  /** 책갈피 이름 (대상이 책갈피일 때) */
  target: string;
  type: number;
  content: number;
  link: boolean;
}

/** 명령 글 → 상호 참조. 이상하면 null */
export function parseCrossRef(cmd: unknown): CrossRef | null {
  if (typeof cmd !== 'string' || !cmd || cmd.length > 1000) return null;
  const parts = cmd.split(';');
  if (parts.length < 3) return null;
  const path = parts[0];
  const type = parseInt(parts[1], 10);
  const content = parseInt(parts[2], 10);
  if (!Number.isFinite(type) || !Number.isFinite(content)) return null;
  return { path, target: path.startsWith('?') && !path.startsWith('?#') ? path.slice(1) : '', type, content, link: parts[3] === '1' };
}

/** 책갈피를 가리키는 상호 참조의 명령 글 */
export function crossRefCommand(target: string, content: number, link: boolean): string {
  return `?${target.replace(/;/g, '')};${XREF_BOOKMARK};${Math.max(0, Math.min(3, content | 0))};${link ? 1 : 0}`;
}

/** 사람이 읽는 설명 (말풍선) */
export function crossRefLabel(r: CrossRef): string {
  const what = r.type === XREF_BOOKMARK ? `책갈피 '${r.target}'` : ['표', '그림', '수식', '각주', '미주', '개요'][r.type] || '대상';
  const how = ['쪽 번호', r.type === XREF_BOOKMARK ? '이름' : '번호', '내용', '위/아래'][r.content] || '';
  return `상호 참조: ${what}의 ${how}`;
}

type JMarkLite = { type: string; attrs?: Record<string, any> };
type JNodeLite = { type: string; text?: string; marks?: JMarkLite[] };

/** 읽을 때: 상호 참조 필드 시작 뒤에 쌓인 글(결과 글)에 상호 참조 표시를 단다. parts: [글 목록, 시작 자리] */
export function applyCrossRef(parts: [JNodeLite[], number][], cmd: string) {
  if (!parseCrossRef(cmd)) return;
  for (const [inline, start] of parts)
    for (let k = Math.max(0, start); k < inline.length; k++) {
      const n = inline[k];
      if (n.type !== 'text' || !n.text) continue;
      n.marks = [...(n.marks || []).filter((m) => m.type !== 'crossRef'), { type: 'crossRef', attrs: { cmd: cmd.slice(0, 1000) } }];
    }
}
