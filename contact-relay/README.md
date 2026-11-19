# Kite 문의 중계 (Brevo 메일 · GitHub 이슈)

Kite 의 "도구 → 문의하기" 창이 보낸 내용을 개발사에 전달하는 Vercel 함수입니다.
메일(Brevo)로, GitHub 이슈로, 또는 둘 다로 보낼 수 있습니다. 키·토큰·받는 주소는 서버 환경 변수에만 두어 앱에서 꺼낼 수 없습니다.

## 배포

```
cd contact-relay
vercel deploy --prod
```

Vercel 프로젝트 설정 → Environment Variables 에 아래 값을 넣고 다시 배포합니다. 메일과 이슈 가운데 하나 이상을 채웁니다.
배포 주소의 `/api/contact` 를 Kite 의 `src/appInfo.ts` → `CONTACT_FORM_ENDPOINT` 에 넣습니다 (이미 넣어 두었다면 앱은 고칠 것이 없습니다).

### 메일 (Brevo)

| 이름 | 값 |
|---|---|
| `BREVO_API_KEY` | Brevo → SMTP & API → API Keys 에서 만든 키 |
| `CONTACT_TO` | 문의를 받을 주소 |
| `CONTACT_SENDER` | Brevo 에서 확인한 보내는 주소 (Senders) |

### GitHub 이슈

문의에는 메일 주소·문서 내용 같은 개인정보가 들 수 있습니다. 공개 저장소(예: `MinaryHub/Kite-Writer`)의 이슈는 누구나 보므로,
**문의를 받을 비공개 저장소**(예: `MinaryHub/kite-support`)를 따로 만들어 그곳에 이슈를 만드는 것을 권합니다.

1. GitHub 에서 비공개 저장소를 만든다 (분류별 라벨 `문의`·`bug`·`enhancement`·`ai-report` 를 만들어 두면 이슈에 붙는다. 없으면 라벨 없이 만든다)
2. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
   - Resource owner: 저장소의 소유자 (조직이면 조직이 세분화된 토큰을 허용해야 한다)
   - Repository access: Only select repositories → 1 의 저장소 하나
   - Permissions → Repository permissions → **Issues: Read and write** (그 밖에는 주지 않는다)
   - 만료일을 정하고, 만료 전에 새로 만들어 바꾼다
3. Vercel 환경 변수

| 이름 | 값 |
|---|---|
| `GITHUB_TOKEN` | 2 에서 만든 토큰 |
| `GITHUB_REPO` | 이슈를 만들 저장소 `소유자/이름` (예: `MinaryHub/kite-support`) |
| `GITHUB_ALLOW_PUBLIC` | (보통 비워 둔다) `1` 이면 공개 저장소에도 만든다 |

중계는 처음 받을 때 저장소가 비공개인지 확인하고, **공개 저장소면 이슈를 만들지 않습니다** (`GITHUB_ALLOW_PUBLIC=1` 로 허락했을 때만 만들고,
그때도 답장 주소는 이슈에 적지 않습니다). 공개 저장소로 받기로 했다면 Kite 의 문의 창 안내 글(`src/ui/dialogs/ContactDialog.tsx`)도
"내용이 공개됩니다"로 바꿔야 합니다.

이슈 모양: 제목 `[분류] 첫 줄`, 본문은 사용자 글(코드 블록 안: `@멘션` 알림·`#번호` 링크·바깥 그림이 먹지 않는다), 분류, 답장 주소(비공개 저장소만),
분류에 맞는 라벨. 이슈는 토큰을 만든 계정 이름으로 만들어집니다.

## 지키는 것

- 메일의 받는 사람은 `CONTACT_TO` 하나로 고정. 사용자가 적은 메일 주소는 답장 주소(replyTo)로만 쓴다
- 이슈는 `GITHUB_REPO` 하나에만, 기본은 비공개 저장소에만
- 메일과 이슈를 둘 다 설정하면 하나라도 닿으면 보낸 것으로 본다
- 주소(IP)마다 10분에 5건, 내용 9,000자까지

시험: `node tests/test-contact-relay.mjs` (실제 서버는 부르지 않는다)
