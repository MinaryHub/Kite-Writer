import { app } from '../app/controller';
import { htmlToJson } from '../formats/html';
import { writeMarkdown } from '../formats/markdown';

/**
 * AI 도우미가 함께 쓰는 것: 문서·선택 영역을 AI 로 보낼 글(Markdown)로 꺼내기, AI 가 쓴 답(정리된 HTML)을 문서에 넣기
 */

/** 현재 문서 또는 선택 영역의 내용 (Markdown). 보낼 것이 없으면 null */
export function getAiContext(mode: 'doc' | 'selection' | 'none'): { text: string; label: string } | null {
  const tab = app.active;
  if (!tab || mode === 'none') return null;
  const ed = tab.editor;
  const { from, to, empty } = ed.state.selection;
  if (mode === 'selection') {
    if (empty) return null;
    const slice = ed.state.doc.cut(from, to);
    const md = writeMarkdown({ content: slice.toJSON(), settings: tab.settings, meta: tab.meta }).trim();
    return { text: md || ed.state.doc.textBetween(from, to, '\n'), label: '선택' };
  }
  return { text: writeMarkdown(tab.toKDocument()).trim(), label: '문서' };
}

/**
 * 정리된 HTML(sanitizeAiHtml·renderMarkdown 을 거친 것)을 문서에 넣는다.
 * replace: 선택 영역을 바꾼다. 아니면 선택 끝(커서 자리)에 넣는다. 넣을 내용이 없으면 false
 */
export function insertAiHtml(html: string, replace: boolean): boolean {
  const tab = app.active;
  if (!tab) return false;
  const json = htmlToJson(html);
  let content = json.content || [];
  if (!content.length) return false;
  // 한 문단이면 글자만 넣어 현재 문단 서식을 유지
  if (content.length === 1 && content[0].type === 'paragraph') content = content[0].content || [];
  if (!content.length) return false;
  const c = tab.editor.chain().focus();
  if (!replace) {
    const { to } = tab.editor.state.selection;
    c.setTextSelection(to);
  }
  c.insertContent(content).run();
  app.toast(replace ? '선택 영역을 바꾸었습니다.' : '문서에 넣었습니다.');
  return true;
}
