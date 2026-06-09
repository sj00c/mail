# Mail

원내 보안망이 Gmail 웹 UI(`mail.google.com`)는 막지만 Gmail API/OAuth/SMTP는 통과하는 환경에서
**로컬에서 직접 띄워 쓰는 개인용 Gmail 클라이언트**.

- 백엔드: Bun + Hono + Gmail/Calendar REST API (`*.googleapis.com`)
- 프론트: React + Vite
- 인증: OAuth2 (refresh token을 이 머신에만 로컬 저장)
- 메일: 라벨/받은편지함 조회, 검색(Gmail 문법), 본문/첨부 보기, 읽음·보관·삭제, 작성·답장·발송(첨부 포함)
- 캘린더: 월 그리드 / 목록 뷰, 캘린더별 표시 토글, 60초 자동 갱신 (Google 캘린더 읽기 전용)

> OAuth 셋업을 처음부터 다시 할 땐 [`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md) 참고 (실제로 헤맨 함정 정리됨).

토큰은 `server/.data/token.json` 에만 저장되며 `.gitignore` 처리되어 있다.

---

## 1. Google Cloud OAuth 클라이언트 만들기 (최초 1회)

웹 UI가 막혀도 `console.cloud.google.com` 과 `accounts.google.com` 은 열려 있으므로 진행 가능하다.
(혹시 콘솔도 막히면 망 밖 기기에서 클라이언트만 만들어 client id/secret만 가져오면 된다.)

1. **프로젝트 생성**: https://console.cloud.google.com → 상단 프로젝트 선택 → New Project.
2. **API 활성화**: APIs & Services → Library → "Gmail API" 및 "Google Calendar API" 검색 → 각각 Enable.
3. **OAuth 동의 화면 구성**: APIs & Services → OAuth consent screen
   - User Type: **External** 선택 → Create
   - 앱 이름/지원 이메일 등 필수값만 입력
   - **Scopes**: 굳이 추가 안 해도 됨(앱이 요청 시 동의받음). 넣을 거면 `.../auth/gmail.modify`
   - **Test users**: 본인 Gmail 주소 추가 ← *이거 안 하면 로그인 거부됨*
   - 앱은 "Testing" 상태로 두면 됨(개인용이라 게시/검수 불필요. refresh token이 7일마다 만료될 수 있는데, 만료되면 다시 로그인하면 됨)
4. **OAuth 클라이언트 ID 생성**: APIs & Services → Credentials → Create Credentials → OAuth client ID
   - Application type: **Web application**
   - Authorized redirect URIs 에 정확히 추가:
     ```
     http://localhost:8787/auth/callback
     ```
   - 생성 후 **Client ID** 와 **Client secret** 복사

## 2. 환경 변수 설정

```sh
cp .env.example .env
```

`.env` 를 열어 채운다:

```
GOOGLE_CLIENT_ID=복사한-client-id.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=복사한-client-secret
OAUTH_REDIRECT=http://localhost:8787/auth/callback
PORT=8787
```

> `OAUTH_REDIRECT` 의 포트는 `PORT` 및 위 콘솔의 redirect URI와 **반드시 일치**해야 한다.

## 3. 실행

```sh
bun install
```

**개발 모드** (Vite 5173 + API 8787, 핫리로드):

```sh
bun run dev
```

→ 브라우저에서 http://localhost:5173

**프로덕션 모드** (빌드 후 단일 서버가 SPA까지 서빙):

```sh
bun run build
bun run start
```

→ 브라우저에서 http://localhost:8787

## 4. 첫 로그인

1. 화면의 **"Gmail 연결하기"** 클릭
2. Google 동의 화면(`accounts.google.com`)에서 본인 계정 선택 → 권한 허용
   - "앱이 확인되지 않았습니다" 경고가 뜨면 *고급 → (안전하지 않음) 이동* (본인이 만든 앱이라 정상)
3. 콜백 후 받은편지함이 뜨면 성공. 이후 토큰 자동 갱신.

로그아웃하면 `token.json` 이 비워진다.

---

## 검색 문법

상단 검색창은 Gmail 검색 문법을 그대로 쓴다:

- `from:someone@x.com`
- `subject:송장`
- `has:attachment`
- `is:unread newer_than:7d`
- `label:work`

## 권한 범위

메일은 `gmail.modify` 하나만 사용 — 읽기 / 발송 / 라벨 / 읽음표시 / 보관 / 휴지통 이동 가능,
**영구 삭제는 불가**(안전장치). 휴지통의 메일은 Gmail 정책상 30일 후 자동 삭제된다.
캘린더는 `calendar.readonly` (조회 전용).

## 구조

```
server/
  auth.ts     OAuth2 + 토큰 저장/갱신
  gmail.ts    Gmail API 래퍼 (list/get/send/modify/trash/labels/attachments)
  calendar.ts Calendar API 래퍼 (events/calendars)
  index.ts    Hono 라우트 (/auth/*, /api/*) + 정적 서빙(프로덕션)
web/src/
  api.ts      프론트 API 클라이언트 + 타입
  App.tsx     전체 UI (사이드바/메일/캘린더/작성)
  styles.css
```
