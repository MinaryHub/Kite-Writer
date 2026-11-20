import { app } from './app/controller';
import { platform } from './platform';
import { SPONSOR_URL } from './appInfo';

/** 도구 > 후원하기: GitHub Sponsors 페이지를 브라우저로 연다 */
export function openSponsor() {
  platform.openExternal(SPONSOR_URL);
}

/** 문의 창을 쓸 수 있는지 (GitHub 이슈 페이지를 여는 것이라 어디서나 된다) */
export const contactAvailable = () => true;

/** 도구 > 문의하기: 분류·내용을 적는 창 → GitHub 새 이슈 페이지 (분류·내용을 미리 채울 수 있다) */
export function openContact(prefill: { category?: string; message?: string } = {}) {
  app.openDialog('contact', prefill);
}
