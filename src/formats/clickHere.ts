import type { FlatField } from './flatten';

/**
 * 누름틀 명령 글 (HWP 의 필드 컨트롤 %clk 와 HWPX 의 Command 매개 변수):
 *   "Clickhere:set:<본문 길이>:Direction:wstring:<n>:<안내문> HelpState:wstring:<m>:<메모> " + " "
 * (한글이 만든 파일과 같은 꼴: 본문은 항목마다 끝에 빈칸 하나, 전체 끝에 빈칸 하나 더)
 */
export function clickHereCommand(f: Pick<FlatField, 'guide' | 'memo'>): string {
  const body = `Direction:wstring:${f.guide.length}:${f.guide} HelpState:wstring:${f.memo.length}:${f.memo} `;
  return `Clickhere:set:${body.length}:${body} `;
}

/** 명령 글에서 안내문·메모를 꺼낸다 (길이를 적어 둔 대로 읽으므로 글 안의 ':'·빈칸도 그대로) */
export function parseClickHereCommand(cmd: string): { guide: string; memo: string } {
  const out = { guide: '', memo: '' };
  const take = (key: string): string => {
    const at = cmd.indexOf(`${key}:wstring:`);
    if (at < 0) return '';
    const rest = cmd.slice(at + key.length + 9);
    const m = /^(\d+):/.exec(rest);
    if (!m) return '';
    return rest.slice(m[0].length, m[0].length + Math.min(2000, Number(m[1])));
  };
  out.guide = take('Direction');
  out.memo = take('HelpState');
  return out;
}

type JMarkLite = { type: string; attrs?: Record<string, any> };
type JNodeLite = { type: string; text?: string; marks?: JMarkLite[] };

/**
 * 읽을 때: 누름틀 시작 뒤에 쌓인 글에 누름틀 표시를 단다. parts: [글 목록, 시작 자리] (여러 문단에 걸친 누름틀은 여럿).
 * 글이 없으면(빈 누름틀) 마지막 목록 끝에 안내문을 자리 표시로 넣는다. emptyMarks: 그 안내문의 글자 모양 표시
 */
export function applyClickHere(parts: [JNodeLite[], number][], f: { guide: string; memo: string; name: string }, emptyMarks: JMarkLite[]) {
  const attrs = { guide: f.guide.slice(0, 500), memo: f.memo.slice(0, 500), name: f.name.slice(0, 100) };
  let any = false;
  for (const [inline, start] of parts)
    for (let k = Math.max(0, start); k < inline.length; k++) {
      const n = inline[k];
      if (n.type !== 'text' || !n.text) continue;
      n.marks = [...(n.marks || []).filter((m) => m.type !== 'clickHere'), { type: 'clickHere', attrs: { ...attrs, empty: false } }];
      any = true;
    }
  const last = parts[parts.length - 1]?.[0];
  if (!any && last && attrs.guide) last.push({ type: 'text', text: attrs.guide, marks: [...emptyMarks.filter((m) => m.type !== 'clickHere'), { type: 'clickHere', attrs: { ...attrs, empty: true } }] });
}

/** HWP 필드 컨트롤의 CTRL_DATA(매개 변수 집합)에서 필드 이름 (항목 0x4000, 문자열) */
export function fieldNameFromCtrlData(d: Uint8Array): string {
  if (d.length < 12) return '';
  const u16 = (o: number) => d[o] | (d[o + 1] << 8);
  const count = u16(2);
  let o = 6;
  for (let k = 0; k < count && o + 6 <= d.length; k++) {
    const id = u16(o);
    const type = u16(o + 2);
    o += 4;
    if (type !== 1) break;
    const len = u16(o);
    o += 2;
    if (o + len * 2 > d.length) break;
    let s = '';
    for (let j = 0; j < len; j++) s += String.fromCharCode(u16(o + j * 2));
    o += len * 2;
    if (id === 0x4000) return s.slice(0, 100);
  }
  return '';
}
