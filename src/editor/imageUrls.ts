import { dataUrlToBytes } from '../formats/common';

/**
 * 편집 화면에 쓸 그림 주소. 큰 data URL 은 한 번만 Blob 으로 풀어 짧은 주소(blob:)로 바꿔 쓴다.
 * 같은 그림이 문서에 여러 번 나오면(한 그림을 쪽마다 넣은 문서 등) 그림마다 수 MB 짜리 주소를 넘기던 것을 피한다 —
 * 브라우저는 주소로 그림을 찾아 두므로 짧은 주소면 한 번만 풀어 그린다. 문서(노드)에는 data URL 이 그대로 남는다.
 */
const cache = new Map<string, string>();
/** 이보다 짧은 주소는 그대로 쓴다 */
const MIN_LEN = 32 * 1024;

export function viewSrc(src: unknown): string {
  if (typeof src !== 'string') return '';
  if (src.length < MIN_LEN || !src.startsWith('data:') || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return src;
  let u = cache.get(src);
  if (!u) {
    const d = dataUrlToBytes(src);
    if (!d) return src;
    try {
      u = URL.createObjectURL(new Blob([d.bytes as BlobPart], { type: d.mime }));
    } catch {
      return src;
    }
    cache.set(src, u);
  }
  return u;
}
