# Kite 문의 중계 (Brevo 메일 · GitHub 이슈)

Kite 의 "도구 → 문의하기" 창이 보낸 내용을 개발사에 전달하는 Vercel 함수입니다.
메일(Brevo)로, GitHub 이슈로, 또는 둘 다로 보낼 수 있습니다 (지금은 둘 다: 이슈는 공개, 답장 주소는 메일로만). 키·토큰·받는 주소는 서버 환경 변수에만 두어 앱에서 꺼낼 수 없습니다.

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

문의를 GitHub 의 Kite 저장소(`MinaryHub/Kite-Writer`)에 **공개 이슈**로 올립니다. Kite 의 문의 창은 "보낸 내용은 공개 이슈로 올라갑니다"라고
알리고, 그 안내를 보여 준 앱은 문의에 `public: true` 를 함께 보냅니다. 중계는 공개 저장소에는 이 표시가 있는 문의만 이슈로 올리고,
**답장 주소는 이슈에 적지 않습니다** (메일로만 개발사에 전달). 안내가 없던 예전 앱(1.5.0 전)의 문의는 메일로만 전달하므로
메일(Brevo) 설정도 그대로 두는 것을 권합니다. 비공개 저장소를 쓰면 표시와 상관없이 이슈로 올리고 답장 주소도 적습니다.

1. GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens** → Generate new token
   - Resource owner: `MinaryHub` (조직이 세분화된 토큰을 허용해야 한다: 조직 Settings → Personal access tokens)
   - Repository access: Only select repositories → `MinaryHub/Kite-Writer`
   - Permissions → Repository permissions → **Issues: Read and write** (그 밖에는 주지 않는다)
   - 만료일을 정하고, 만료 전에 새로 만들어 바꾼다
2. Vercel 환경 변수

| 이름 | 값 |
|---|---|
| `GITHUB_TOKEN` | 1 에서 만든 토큰 |
| `GITHUB_REPO` | `MinaryHub/Kite-Writer` |

이슈 모양: 제목 `[분류] 첫 줄`, 본문은 사용자 글(코드 블록 안: `@멘션` 알림·`#번호` 링크·바깥 그림이 먹지 않는다)과 분류,
분류에 맞는 라벨 (`question`·`bug`·`enhancement`, AI 응답 신고는 `ai-report` — 저장소에 없는 라벨이면 라벨 없이 만든다).
이슈는 토큰을 만든 계정 이름으로 만들어지고, 앱은 만든 이슈를 열어 볼 수 있게 보여 줍니다. 원치 않는 이슈는 닫거나 지우면 됩니다.

## 지키는 것

- 메일의 받는 사람은 `CONTACT_TO` 하나로 고정. 사용자가 적은 메일 주소는 답장 주소(replyTo)로만 쓴다
- 이슈는 `GITHUB_REPO` 하나에만. 공개 저장소에는 공개 안내를 본 앱의 문의만, 답장 주소 없이
- 메일과 이슈를 둘 다 설정하면 하나라도 닿으면 보낸 것으로 본다
- 주소(IP)마다 10분에 5건, 내용 9,000자까지

시험: `node tests/test-contact-relay.mjs` (실제 서버는 부르지 않는다)
