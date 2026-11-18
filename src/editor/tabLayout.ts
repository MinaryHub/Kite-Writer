/**
 * Word 문서의 탭 자리.
 *
 * Word 의 탭은 글 영역(본문·칸·글상자)의 왼쪽 끝에서 잰 '탭 자리'까지 간다. 탭 자리는 문단마다 정한 자리(왼쪽·가운데·오른쪽·소수점
 * 맞춤, 채움)가 먼저이고, 그 오른쪽은 기본 탭 간격의 배수다. 내어쓰기 문단은 왼쪽 여백 자리도 탭 자리다.
 * CSS 의 tab-size 는 문단 상자 왼쪽 끝에서 같은 간격으로만 재므로, 화면에 그린 뒤 탭마다 폭을 재서 맞춘다
 * (편집기에서는 tabFill 이 탭 마크의 width 에 적고, 머리말·꼬리말처럼 그림으로만 그리는 곳은 그 자리에서 폭을 준다).
 */

/** 탭 자리: [글 영역 왼쪽 끝에서의 거리 pt, 맞춤(l 왼쪽·c 가운데·r 오른쪽·d 소수점), 채움(탭 마크의 leader 값)] */
export type TabStopDef = [number, 'l' | 'c' | 'r' | 'd', number];

/** 문단의 탭 자리: d = 기본 탭 간격 pt, s = 정한 자리 (자리 순) */
export interface TabDefs {
  d: number;
  s?: TabStopDef[];
}

const PX = 96 / 72;

export function cleanTabs(v: any): TabDefs | null {
  if (!v || typeof v !== 'object') return null;
  const d = +v.d;
  if (!(d >= 1 && d <= 2000)) return null;
  const out: TabDefs = { d: Math.round(d * 100) / 100 };
  if (Array.isArray(v.s)) {
    const s: TabStopDef[] = [];
    for (const t of v.s.slice(0, 64)) {
      if (!Array.isArray(t)) continue;
      const p = +t[0];
      if (!(p > -2000 && p < 4000)) continue;
      const a = t[1] === 'c' || t[1] === 'r' || t[1] === 'd' ? t[1] : 'l';
      const l = +t[2];
      s.push([Math.round(p * 100) / 100, a, l >= 0 && l <= 7 ? Math.round(l) : 0]);
    }
    s.sort((x, y) => x[0] - y[0]);
    if (s.length) out.s = s;
  }
  return out;
}

export interface TabFix {
  span: HTMLElement;
  /** 탭이 차지할 폭 px (확대 전) */
  width: number;
  /** 채움 (탭 자리의 것) */
  leader: number;
}

/** 탭 뒤에서 다음 탭(없으면 문단 끝·줄 바꿈)까지의 글 폭 px. dec 면 첫 소수점 앞까지 */
function segWidth(p: HTMLElement, span: HTMLElement, next: HTMLElement | null, dec: boolean): number {
  const range = document.createRange();
  range.setStartAfter(span);
  if (next) range.setEndBefore(next);
  else range.setEnd(p, p.childNodes.length);
  // 줄 바꿈(<br>)이나 소수점에서 끊는다
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_ALL);
  walker.currentNode = span;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (span.contains(n)) continue;
    if (n === next) break;
    if (n.nodeName === 'BR') {
      range.setEndBefore(n);
      break;
    }
    if (dec && n.nodeType === Node.TEXT_NODE) {
      const i = (n.nodeValue || '').search(/[.,](?=\d)|[.,]$/);
      if (i >= 0) {
        range.setEnd(n, i);
        break;
      }
    }
  }
  // 글이 놓인 첫 줄의 왼쪽 끝 ~ 오른쪽 끝 (탭 폭이 아직 맞지 않아 글이 다음 줄로 넘어가 있어도 그 줄에서 잰다)
  let top = NaN;
  let bottom = NaN;
  let l = Infinity;
  let r = -Infinity;
  for (const rc of Array.from(range.getClientRects())) {
    if (rc.width <= 0) continue;
    if (isNaN(top)) {
      top = rc.top;
      bottom = rc.bottom;
    } else if (rc.top >= bottom - 1 || rc.bottom <= top + 1) continue;
    l = Math.min(l, rc.left);
    r = Math.max(r, rc.right);
  }
  return r > l ? r - l : 0;
}

/**
 * root 안의 Word 탭(탭 자리가 적힌 문단의 탭)마다 차지할 폭을 잰다.
 * zoom: 화면 확대 비율 (잰 값을 확대 전 px 로 돌린다)
 */
export function measureTabs(root: HTMLElement, zoom = 1): TabFix[] {
  const out: TabFix[] = [];
  const z = zoom || 1;
  for (const p of Array.from(root.querySelectorAll('[data-tabs]')) as HTMLElement[]) {
    if (p.closest('.pg-spacer')) continue;
    let defs: TabDefs | null = null;
    try {
      defs = cleanTabs(JSON.parse(p.getAttribute('data-tabs') || ''));
    } catch {
      defs = null;
    }
    if (!defs) continue;
    const spans = (Array.from(p.querySelectorAll('span.k-tab')) as HTMLElement[]).filter((s) => s.closest('[data-tabs]') === p);
    if (!spans.length) continue;
    const cs = getComputedStyle(p);
    const pr = p.getBoundingClientRect();
    if (!pr.width) continue;
    const ml = parseFloat(cs.marginLeft) || 0;
    const mr = parseFloat(cs.marginRight) || 0;
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0);
    const ti = parseFloat(cs.textIndent) || 0;
    /** 글 영역의 왼쪽 끝 (화면 좌표) */
    const origin = pr.left - ml * z;
    /** 글 영역의 너비 px */
    const areaW = pr.width / z + ml + mr;
    /** 둘째 줄부터의 글 시작 자리 px (왼쪽 여백) */
    const indent = ml + pad;
    let lineTop = NaN;
    let lineBottom = NaN;
    let shift = 0;
    spans.forEach((span, i) => {
      const r = span.getBoundingClientRect();
      // 같은 줄의 앞 탭 폭이 바뀌면 이 탭의 시작도 그만큼 옮겨진다
      if (isNaN(lineTop) || r.top >= lineBottom - 1 || r.bottom <= lineTop + 1) {
        lineTop = r.top;
        lineBottom = r.bottom;
        shift = 0;
      }
      const cur = r.width / z;
      const x = (r.left - origin) / z + shift;
      const ptab = span.getAttribute('data-ptab');
      let stop: number;
      let align = 'l';
      let leader = +(span.getAttribute('data-leader') || 0) || 0;
      if (ptab === 'c' || ptab === 'r' || ptab === 'l') {
        // 절대 위치 탭: 글 영역의 가운데·오른쪽 끝·왼쪽 끝
        align = ptab;
        stop = ptab === 'c' ? areaW / 2 : ptab === 'r' ? areaW : 0;
      } else {
        const xpt = x / PX;
        const s = defs!.s?.find((t) => t[0] > xpt + 0.25);
        // 내어쓰기 문단: 왼쪽 여백 자리도 탭 자리다 (번호 뒤의 탭이 본문 시작에 맞는다)
        const hang = ti < 0 && x < indent - 0.5 ? indent : null;
        if (s && (hang == null || s[0] * PX <= hang)) {
          stop = s[0] * PX;
          align = s[1];
          leader = s[2];
        } else if (hang != null) {
          stop = hang;
          leader = 0;
        } else {
          stop = (Math.floor(xpt / defs!.d + 1e-3) + 1) * defs!.d * PX;
          leader = 0;
        }
      }
      let w = stop - x;
      if (align !== 'l') {
        const seg = segWidth(p, span, spans[i + 1] || null, align === 'd') / z;
        w -= align === 'c' ? seg / 2 : seg;
      }
      // 자리를 이미 지났으면 폭 없이 이어 쓴다 (0 은 '폭 없음'으로 읽히므로 아주 작은 값)
      w = Math.round(Math.min(Math.max(w, 0.1), Math.max(areaW, 0.1)) * 100) / 100;
      shift += w - cur;
      out.push({ span, width: w, leader });
    });
  }
  return out;
}

/**
 * 그림으로만 그리는 곳(머리말·꼬리말)의 HTML 에서 탭 폭을 맞춘다: 그 너비의 보이지 않는 상자에 그려서 재고, 폭을 적은 HTML 을 돌려준다.
 * 탭 자리가 없는 HTML 은 그대로 돌려준다.
 */
const htmlCache = new Map<string, string>();
let fontHook = false;
export function layoutTabsHtml(html: string, widthPx: number): string {
  if (!html || html.indexOf('data-tabs') < 0 || typeof document === 'undefined' || !document.body) return html;
  if (/jsdom|Node\.js/i.test(typeof navigator !== 'undefined' ? navigator.userAgent : 'Node.js')) return html;
  const key = Math.round(widthPx * 10) + '|' + html;
  const hit = htmlCache.get(key);
  if (hit != null) return hit;
  if (!fontHook) {
    fontHook = true;
    // 글꼴이 늦게 실리면 글 폭이 달라진다: 다시 재도록 비운다
    (document as any).fonts?.addEventListener?.('loadingdone', () => htmlCache.clear());
  }
  const host = document.createElement('div');
  host.className = 'kdoc-content hf-rich';
  host.style.cssText = `position:absolute;left:-100000px;top:0;visibility:hidden;pointer-events:none;width:${widthPx}px`;
  host.innerHTML = html;
  document.body.appendChild(host);
  let out = html;
  try {
    for (let pass = 0; pass < 3; pass++) {
      let changed = false;
      for (const f of measureTabs(host, 1)) {
        const cur = parseFloat(f.span.style.width);
        if (!(Math.abs(cur - f.width) <= 0.3)) {
          f.span.style.width = f.width + 'px';
          changed = true;
        }
        if (f.leader) f.span.setAttribute('data-leader', String(f.leader));
        else f.span.removeAttribute('data-leader');
      }
      if (!changed) break;
    }
    out = host.innerHTML;
  } finally {
    host.remove();
  }
  if (htmlCache.size > 300) htmlCache.clear();
  htmlCache.set(key, out);
  return out;
}
