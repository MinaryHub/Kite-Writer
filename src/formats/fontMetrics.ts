import { fontStack } from '../fonts';

/**
 * 글꼴의 '고유 줄 높이' (글자 크기에 대한 비율: 위 높이 + 아래 높이 + 줄 사이).
 * Word 의 줄 간격 '1줄'은 글자 크기의 몇 배가 아니라 이 고유 줄 높이이고, 1.5줄·배수는 그 배수다.
 * 화면이 있으면 실제로 그릴 글꼴(없는 글꼴은 대신 쓰는 글꼴)로 재고, 없으면(변환·시험) 알려진 값의 표를 쓴다.
 */
const KNOWN: Record<string, number> = {
  'times new roman': 1.149,
  'liberation serif': 1.149,
  arial: 1.149,
  'liberation sans': 1.149,
  helvetica: 1.149,
  'courier new': 1.133,
  'liberation mono': 1.133,
  calibri: 1.2207,
  carlito: 1.2207,
  cambria: 1.172,
  caladea: 1.172,
  verdana: 1.215,
  tahoma: 1.207,
  georgia: 1.136,
  'trebuchet ms': 1.161,
  'segoe ui': 1.33,
  consolas: 1.171,
  garamond: 1.125,
  '맑은 고딕': 1.33,
  'malgun gothic': 1.33,
};
const CJK_NAME = /[가-힣一-鿿ぁ-ヿ]|Batang|Gulim|Dotum|Gungsuh|Mincho|Gothic|SimSun|SimHei|MingLiU|Meiryo|Yu |Noto (Sans|Serif) (CJK|KR|JP|SC|TC)|Nanum|HCR|Hanyang|HY/i;

const cache = new Map<string, number>();

export function naturalLineRatio(font: string | null | undefined): number {
  const name = (font || '').trim();
  const key = name.toLowerCase();
  const hit = cache.get(key);
  if (hit != null) return hit;
  let v = 0;
  // 실제 배치를 하지 않는 환경(시험의 jsdom)에서는 재지 않는다
  const canMeasure = typeof document !== 'undefined' && !!document.body && !(typeof navigator !== 'undefined' && /jsdom|Node\.js/i.test(navigator.userAgent || ''));
  if (name && canMeasure) {
    try {
      // 줄 상자의 높이 (line-height: normal 은 글꼴의 줄 사이까지 넣는다)
      const d = document.createElement('div');
      d.textContent = 'Ag';
      d.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;padding:0;border:0;margin:0;font-size:100px;line-height:normal;font-family:${fontStack(name)}`;
      document.body.appendChild(d);
      const h = d.getBoundingClientRect().height;
      d.remove();
      if (h > 60 && h < 300) v = h / 100;
    } catch {
      v = 0;
    }
  }
  if (!v) v = KNOWN[key] || (CJK_NAME.test(name) ? 1.3 : 1.2);
  v = Math.round(v * 1000) / 1000;
  cache.set(key, v);
  return v;
}
