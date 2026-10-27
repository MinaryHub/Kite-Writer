/**
 * 배포 정보: 스토어 등록 전에 채운다.
 * - CONTACT_FORM_ENDPOINT / CONTACT_FORM_KEY: 문의를 받을 곳. 둘 중 하나를 채우면 '문의하기'가 켜진다
 *   · Brevo 중계(contact-relay/, Vercel 함수): 배포 주소의 /api/contact 를 ENDPOINT 에 (권장, Brevo 키는 서버에만)
 *   · Formspree: https://formspree.io 에서 양식을 만들고 받은 주소(https://formspree.io/f/xxxxxxxx)를 ENDPOINT 에
 *   · Web3Forms: https://web3forms.com 에서 받은 Access Key 를 KEY 에 (ENDPOINT 는 비워 둔다)
 *   메일 주소는 앱 안에 두지 않는다: 문의는 양식 서비스를 거쳐 등록된 메일로 전달된다
 * - PRIVACY_URL: 개인정보 처리방침을 올린 웹 주소 (PRIVACY.md 내용). 비어 있으면 앱 안의 내용을 보여 준다
 */
export const CONTACT_FORM_ENDPOINT = 'https://kite-contact-relay.vercel.app/api/contact';
export const CONTACT_FORM_KEY = '';
export const PRIVACY_URL = '';

/** 후원(GitHub Sponsors) 주소 */
export const SPONSOR_URL = 'https://github.com/sponsors/minaryhub';

/** 문의 양식을 쓸 수 있는지 (주 프로세스와 화면이 함께 쓴다) */
export const contactFormConfigured = () => !!(CONTACT_FORM_ENDPOINT || CONTACT_FORM_KEY);

/** 한글과컴퓨터 HWP 공개 문서 라이선스가 요구하는 고지 */
export const HWP_NOTICE = '본 제품은 한글과컴퓨터의 한/글 문서 파일(.hwp) 공개 문서를 참고하여 개발하였습니다.';
