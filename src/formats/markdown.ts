import { marked } from 'marked';
import TurndownService from 'turndown';
// @ts-ignore - 타입 정의 없음
import { gfm } from 'turndown-plugin-gfm';
import type { KDocument, LoadedDoc } from '../types';
import { defaultSettings } from './common';
import { htmlToJson, jsonToHtml } from './html';

export function readMarkdown(text: string): LoadedDoc {
  // 각주 문법 [^1] 단순 지원
  const notes: Record<string, string> = {};
  text = text.replace(/^\[\^([^\]]+)\]:\s*(.+)$/gm, (_m, id, body) => {
    notes[id] = body.trim();
    return '';
  });
  let html = marked.parse(text, { gfm: true, breaks: false, async: false }) as string;
  html = html.replace(/\[\^([^\]]+)\]/g, (m, id) =>
    notes[id] !== undefined ? `<sup data-footnote="${escapeAttr(notes[id])}">*</sup>` : m,
  );
  // 페이지 나누기 주석
  html = html.replace(/<!--\s*pagebreak\s*-->/gi, '<div data-type="page-break"></div>');
  const titleMatch = /^#\s+(.+)$/m.exec(text);
  return {
    content: htmlToJson(html),
    settings: defaultSettings(),
    meta: { title: titleMatch ? titleMatch[1].trim() : undefined },
    warnings: [],
  };
}

function escapeAttr(s: string) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

export function writeMarkdown(doc: KDocument): string {
  // 표 셀 안의 문단을 풀어 GFM 표로 변환되게 한다
  const dom = new window.DOMParser().parseFromString(`<body>${jsonToHtml(doc.content as any)}</body>`, 'text/html');
  dom.body.querySelectorAll('td, th').forEach((cell) => {
    const parts = Array.from(cell.children).map((c) => c.innerHTML);
    cell.innerHTML = parts.join('<br>');
  });
  dom.body.querySelectorAll('colgroup').forEach((c) => c.remove());
  // 비어 있는 누름틀의 안내문은 자리 표시일 뿐이다
  dom.body.querySelectorAll('.k-field[data-empty]').forEach((c) => c.remove());
  // 첫 줄이 제목 줄이 아니면 GFM 표 변환을 위해 th로 바꾼다
  dom.body.querySelectorAll('table').forEach((t) => {
    const first = t.querySelector('tr');
    if (first && !first.querySelector('th')) first.querySelectorAll('td').forEach((td) => {
      const th = dom.createElement('th');
      th.innerHTML = td.innerHTML;
      td.replaceWith(th);
    });
  });
  const html = dom.body.innerHTML;
  const td = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
  });
  td.use(gfm);
  const notes: string[] = [];
  td.addRule('footnote', {
    filter: (node) => node.nodeName === 'SUP' && (node as HTMLElement).hasAttribute('data-footnote'),
    replacement: (_c, node) => {
      notes.push((node as HTMLElement).getAttribute('data-footnote') || '');
      return `[^${notes.length}]`;
    },
  });
  td.addRule('math', {
    filter: (node) => node.nodeName === 'SPAN' && (node as HTMLElement).hasAttribute('data-latex'),
    replacement: (_c, node) => `$${(node as HTMLElement).getAttribute('data-latex') || ''}$`,
  });
  td.addRule('pagebreak', {
    filter: (node) => (node as HTMLElement).getAttribute?.('data-type') === 'page-break',
    replacement: () => '\n\n<!-- pagebreak -->\n\n',
  });
  td.addRule('underline', {
    filter: ['u'],
    replacement: (c) => `<u>${c}</u>`,
  });
  td.addRule('tableCellParagraph', {
    filter: (node) => node.nodeName === 'P' && !!node.parentElement && /^(TD|TH)$/.test(node.parentElement.nodeName),
    replacement: (c, node) => (node.previousSibling ? '<br>' : '') + c,
  });
  let md = td.turndown(html);
  if (notes.length) md += '\n\n' + notes.map((t, i) => `[^${i + 1}]: ${t}`).join('\n');
  return md + '\n';
}
