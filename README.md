# 📬 Mail

> 사내 보안망이 Gmail 웹(`mail.google.com`)은 막아도 **Gmail API / OAuth / SMTP는 통과**하는 환경에서,
> 내 머신에 직접 띄워 쓰는 **개인용 Gmail + Google 캘린더 클라이언트**.

<table>
<tr><td><b>백엔드</b></td><td>Bun · Hono · Gmail / Calendar REST API</td></tr>
<tr><td><b>프론트</b></td><td>React · Vite</td></tr>
<tr><td><b>인증</b></td><td>OAuth2 — refresh token은 <b>이 머신에만</b> 로컬 저장</td></tr>
</table>

**메일** — 받은편지함·라벨 조회, Gmail 문법 검색, 본문/첨부 보기, 읽음·보관·삭제, 작성·답장·발송(첨부 포함)
**캘린더** — 월 그리드 / 목록 뷰, 캘린더별 표시 토글, 일정 상세, 60초 자동 갱신 *(읽기 전용)*

---

## 🚀 빠른 시작

> **클론했다면 [`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md) 를 그대로 따라가면 끝.** (각자 자기 Google 계정으로 5분)
>
> Client ID/Secret·토큰은 **사람마다 다르고 레포에 올라가지 않는다.** 클론해도 본인 것을 새로 만들어야 한다.
> 아래는 그 가이드의 요약이다.

```sh
git clone <repo-url> && cd mail
bun install
cp .env.example .env      # 아래 1·2단계로 발급한 값 채우기
bun run dev               # → http://localhost:5173
```

> 필요: [Bun](https://bun.sh) (`curl -fsSL https://bun.sh/install | bash`)

---

## 1. Google Cloud 설정 (최초 1회)

콘솔(`console.cloud.google.com`)과 로그인(`accounts.google.com`)은 보통 보안망에서도 열린다.
콘솔까지 막혔다면 망 밖 기기에서 클라이언트만 만들어 **Client ID / Secret 두 값만** 가져오면 된다.

#### ① 프로젝트 생성
상단 프로젝트 선택 → **새 프로젝트**(New Project) → 이름 입력 후 만들기.

#### ② API 사용 설정
**API 및 서비스**(APIs & Services) → **라이브러리**(Library) 에서 각각 검색 후 **사용**(Enable):
| API | 용도 |
|---|---|
| **Gmail API** | 메일 |
| **Google Calendar API** | 캘린더 *(⚠️ "CalDAV API" 아님)* |

> 안 켜면 `403 ... has not been used in project` 가 뜬다.

#### ③ OAuth 동의 화면
**API 및 서비스 → OAuth 동의 화면**(OAuth consent screen)
- 사용자 유형(User Type): **외부**(External) → 만들기
- 앱 이름 / 지원 이메일 등 필수값만 입력
- **테스트 사용자**(Test users) 에 **본인 Gmail 주소 추가** ← *빠뜨리면 로그인이 거부된다(`403 access_denied`)*
- 앱은 **"테스트"(Testing) 상태**로 둔다 *(개인용이라 게시·검수 불필요)*

#### ④ OAuth 클라이언트 ID 생성
**API 및 서비스 → 사용자 인증 정보**(Credentials) → **사용자 인증 정보 만들기 → OAuth 클라이언트 ID**
- 애플리케이션 유형(Application type): **웹 애플리케이션**(Web application) ← *반드시*
- **승인된 리디렉션 URI**(Authorized redirect URIs) 에 정확히 추가:
  ```
  http://localhost:8787/auth/callback
  ```
  *`http` (https 아님) · 끝에 `/` 없이 · "승인된 자바스크립트 원본"이 아니라 "리디렉션 URI" 칸*
- 만들기 → **Client ID** 와 **Client secret** 복사

---

## 2. 환경 변수

```sh
cp .env.example .env
```

```dotenv
GOOGLE_CLIENT_ID=복사한-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=복사한-client-secret
OAUTH_REDIRECT=http://localhost:8787/auth/callback
PORT=8787
```

> - 값에 **따옴표를 붙이지 않는다** (정상 시크릿은 `GOCSPX-` 로 시작, 35자).
> - `OAUTH_REDIRECT` 포트 · `PORT` · 콘솔 리디렉션 URI 포트 **세 군데가 정확히 일치**해야 한다 *(불일치 시 `redirect_uri_mismatch`)*.

---

## 3. 실행

**개발 모드** — Vite(5173) + API(8787), 핫리로드
```sh
bun run dev
```
→ http://localhost:5173

**프로덕션 모드** — 단일 서버가 SPA까지 서빙(+ gzip 압축, 정적 자산 장기 캐시)
```sh
bun run build && bun run start
```
→ http://localhost:8787

### 🐳 Docker

```sh
docker build -t mail .
docker run --rm -p 8787:8787 \
  --env-file .env \
  -v "$PWD/server/.data:/app/server/.data" \
  mail
```
> `--env-file` 로 자격증명 주입, `-v ...server/.data` 볼륨으로 토큰을 재시작 후에도 유지.
> CI(`.github/workflows/ci.yml`)는 push/PR마다 `typecheck` + `build` 를 검증한다.

---

## 4. 첫 로그인

1. **"Gmail 연결하기"** 클릭
2. 본인 Google 계정 선택 → 권한 허용
   - *"앱이 확인되지 않았습니다"* 경고 → **고급 → (안전하지 않음) 이동** *(본인이 만든 앱이라 정상)*
3. 받은편지함이 뜨면 성공. 토큰은 `server/.data/token.json` 에 **이 머신에만** 저장된다.

> 문제가 생기면 → [`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md) 의 트러블슈팅 표.

---

## 🔍 검색 문법

상단 검색창은 Gmail 문법을 그대로 쓴다.

```
from:someone@x.com   subject:송장   has:attachment   is:unread newer_than:7d   label:work
```

## 🔐 권한 범위

| Scope | 설명 |
|---|---|
| `gmail.modify` | 읽기 / 발송 / 라벨 / 읽음표시 / 보관 / 휴지통. **영구 삭제 불가**(안전장치) |
| `calendar.readonly` | 캘린더 / 일정 **조회 전용** |

> 휴지통 메일은 Gmail 정책상 30일 후 자동 삭제. 캘린더 쓰기까지 필요하면 scope를 `calendar`로 올리고 재로그인.

## 🗂 구조

```
server/
  auth.ts      OAuth2 + 토큰 저장/갱신
  gmail.ts     Gmail API 래퍼 (list/get/send/modify/trash/labels/attachments)
  calendar.ts  Calendar API 래퍼 (events/calendars)
  index.ts     Hono 라우트 (/auth/*, /api/*) + 정적 서빙(프로덕션)
web/src/
  api.ts       프론트 API 클라이언트 + 타입
  App.tsx      전체 UI (사이드바 / 메일 / 캘린더 / 작성)
  styles.css
```
