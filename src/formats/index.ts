import type { FormatId, KDocument, LoadedDoc, SaveFormatId } from '../types';
import { defaultSettings, docNode, paragraph, splitExt } from './common';

export const OPEN_FILTERS = [
  { name: '모든 지원 문서', extensions: ['hwp', 'hwpx', 'docx', 'doc', 'pdf', 'md', 'markdown', 'txt', 'html', 'htm'] },
  { name: '한글 문서 (*.hwp, *.hwpx)', extensions: ['hwp', 'hwpx'] },
  { name: 'Word 문서 (*.docx, *.doc)', extensions: ['docx', 'doc'] },
  { name: 'PDF 문서 (*.pdf)', extensions: ['pdf'] },
  { name: 'Markdown (*.md)', extensions: ['md', 'markdown'] },
  { name: '텍스트 (*.txt)', extensions: ['txt'] },
  { name: 'HTML (*.html)', extensions: ['html', 'htm'] },
  { name: '모든 파일', extensions: ['*'] },
];

export const SAVE_FORMATS: { id: SaveFormatId; name: string; ext: string }[] = [
  { id: 'hwpx', name: '한글 문서 HWPX (*.hwpx)', ext: 'hwpx' },
  { id: 'hwp', name: '한글 97~2022 문서 HWP (*.hwp)', ext: 'hwp' },
  { id: 'docx', name: 'Word 문서 (*.docx)', ext: 'docx' },
  { id: 'pdf', name: 'PDF 문서 (*.pdf)', ext: 'pdf' },
  { id: 'md', name: 'Markdown (*.md)', ext: 'md' },
  { id: 'html', name: '웹 문서 (*.html)', ext: 'html' },
  { id: 'txt', name: '텍스트 문서 (*.txt)', ext: 'txt' },
];

export function detectFormat(name: string, data: Uint8Array): FormatId {
  const [, ext] = splitExt(name);
  const b = data;
  if (b[0] === 0x50 && b[1] === 0x4b) {
    const head = new TextDecoder('latin1').decode(b.subarray(0, Math.min(b.length, 200)));
    if (head.includes('application/hwp+zip') || ext === 'hwpx') return 'hwpx';
    return 'docx';
  }
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    if (ext === 'doc') return 'doc';
    if (ext === 'hwp') return 'hwp';
    // 내용으로 판별
    const s = new TextDecoder('utf-16le').decode(b.subarray(0, Math.min(b.length, 1 << 16)));
    if (s.includes('FileHeader') || s.includes('BodyText')) return 'hwp';
    return 'doc';
  }
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  if (ext === 'md' || ext === 'markdown') return 'md';
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'hwp') return 'hwp';
  if (ext === 'hwpx') return 'hwpx';
  if (ext === 'docx') return 'docx';
  if (ext === 'pdf') return 'pdf';
  return 'txt';
}

/** BOM/UTF-8/EUC-KR 자동 판별 */
export function decodeText(b: Uint8Array): string {
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return new TextDecoder('utf-8').decode(b.subarray(3));
  if (b[0] === 0xff && b[1] === 0xfe) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xfe && b[1] === 0xff) return new TextDecoder('utf-16be').decode(b.subarray(2));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    try {
      return new TextDecoder('euc-kr').decode(b);
    } catch {
      return new TextDecoder('utf-8').decode(b);
    }
  }
}

export type LegacyDocResult =
  | { kind: 'docx'; data: Uint8Array }
  | { kind: 'text'; body: string; headers?: string; footers?: string; footnotes?: string }
  | { kind: 'error'; message: string };

export interface ImportOptions {
  /** .doc 변환 (Electron 메인 프로세스) */
  convertLegacyDoc?: (data: Uint8Array) => Promise<LegacyDocResult>;
  onProgress?: (p: number) => void;
}

/** Word 문서: 머리말·꼬리말이 길면 본문 영역을 그만큼 줄인다 (화면에서 잰다. 브라우저에서만) */
async function fitDocx(d: LoadedDoc): Promise<LoadedDoc> {
  const rich = (h: LoadedDoc['settings']['header']) => !!(h.content || h.even || h.first);
  if (typeof document !== 'undefined' && (rich(d.settings.header) || rich(d.settings.footer))) {
    try {
      (await import('../hfRich')).fitHeaderFooter(d.settings);
    } catch {
      /* 잴 수 없으면 그대로 */
    }
  }
  return d;
}

export async function importDocument(name: string, data: Uint8Array, opts: ImportOptions = {}): Promise<LoadedDoc & { format: FormatId }> {
  const format = detectFormat(name, data);
  const done = (d: LoadedDoc) => ({ ...d, format });
  switch (format) {
    case 'hwpx':
      return done(await (await import('./hwpx/reader')).readHwpx(data));
    case 'hwp':
      return done(await (await import('./hwp/reader')).readHwp(data));
    case 'docx':
      return done(await fitDocx(await (await import('./docx/reader')).readDocx(data)));
    case 'doc': {
      if (!opts.convertLegacyDoc) throw new Error('DOC 형식은 데스크톱 앱에서만 열 수 있습니다.');
      const res = await opts.convertLegacyDoc(data);
      if (res.kind === 'error') throw new Error(res.message);
      if (res.kind === 'docx') {
        const d = await fitDocx(await (await import('./docx/reader')).readDocx(res.data));
        return done(d);
      }
      const lines = res.body.replace(/\r\n?/g, '\n').split('\n');
      const blocks = lines.map((l) => (l ? paragraph({}, [{ type: 'text', text: l }]) : paragraph()));
      const settings = defaultSettings();
      if (res.headers?.trim()) settings.header.text = res.headers.trim().split('\n')[0];
      if (res.footers?.trim()) settings.footer.text = res.footers.trim().split('\n')[0];
      return done({
        content: docNode(blocks),
        settings,
        meta: {},
        warnings: ['DOC 파일은 텍스트만 가져왔습니다. (Microsoft Word가 설치되어 있으면 서식까지 가져옵니다)'],
      });
    }
    case 'pdf':
      return done(await (await import('./pdf/reader')).readPdf(data, opts.onProgress));
    case 'md':
      return done((await import('./markdown')).readMarkdown(decodeText(data)));
    case 'html':
      return done((await import('./html')).readHtml(decodeText(data)));
    default:
      return done((await import('./html')).readText(decodeText(data)));
  }
}

export async function exportDocument(format: SaveFormatId, doc: KDocument, opts: { pageCount?: number } = {}): Promise<Uint8Array> {
  const enc = (s: string, bom = false) => {
    const body = new TextEncoder().encode(s);
    if (!bom) return body;
    const out = new Uint8Array(body.length + 3);
    out.set([0xef, 0xbb, 0xbf]);
    out.set(body, 3);
    return out;
  };
  // 변경 내용·메모를 저장하지 못하는 형식은 변경을 모두 반영하고 메모를 뺀 사본으로 저장한다
  if (format !== 'docx') {
    const { acceptAllJson, hasReviewMarks } = await import('./review');
    const r = hasReviewMarks(doc.content);
    if (r.changes || r.comments) doc = { ...doc, content: acceptAllJson(doc.content), settings: { ...doc.settings, comments: undefined } };
  }
  switch (format) {
    case 'hwpx':
      return (await import('./hwpx/writer')).writeHwpx(doc, opts);
    case 'hwp':
      return (await import('./hwp/writer')).writeHwp(doc, opts);
    case 'docx':
      return (await import('./docx/writer')).writeDocx(doc);
    case 'md':
      return enc((await import('./markdown')).writeMarkdown(doc));
    case 'html':
      return enc((await import('./html')).writeHtml(doc));
    case 'txt':
      return enc((await import('./html')).writeText(doc), true);
    default:
      throw new Error('지원하지 않는 저장 형식: ' + format);
  }
}
