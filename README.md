# Mail

**내 머신에서 `localhost`로 띄워 쓰는 개인용 Gmail + Google 캘린더 클라이언트.**
사내 보안망이 Gmail 웹(`mail.google.com`)은 막아도 Gmail API / OAuth는 통과하는 환경을 위해 만들었다.

| | |
|---|---|
| **백엔드** | Bun · Hono · Gmail / Calendar REST API |
| **프론트** | React · Vite |
| **인증** | OAuth2 — refresh token은 **이 머신에만** 저장 (`server/.data/token.json`) |
| **외부 연결** | Google API 단 하나. 그 외 어떤 서버와도 통신하지 않는다 |

#### 기능

- **메일** — 받은편지함·라벨, 스레드 보기, HTML 본문(스크립트 차단 샌드박스)·인라인 이미지·첨부, 읽음·별표·스팸·보관·삭제, 작성·답장·전체답장·전달, 다중 수신자·참조·숨은참조·첨부(25MB)·서명, 임시저장·드래프트 이어쓰기, 새 메일 데스크톱 알림
- **캘린더** — 월 그리드 / 목록 뷰, 캘린더별 표시 토글, 일정 생성·수정·삭제, 종일·멀티데이 일정, 60초 자동 갱신
- **통합 검색** — 검색하면 **일정 카드 + 메일 카드**가 나란히 뜨고(검색어 하이라이트), `?q=검색어` URL로 바로 열 수도 있다
- **설정 자동 동기화** — 로그인하면 Gmail 서명을 자동으로 가져오고, 보내는 주소 별칭·기본 답장주소·휴가 자동응답 상태가 함께 딸려온다

## 화면

**받은편지함**

![받은편지함](docs/screenshots/main.png)

**통합 검색 — 일정과 메일이 카드로 나란히**

![통합 검색](docs/screenshots/search.png)

**캘린더 — 월 그리드**

![캘린더](docs/screenshots/calendar.png)

---

## 설치

> 전 과정은 **클론 → OAuth 클라이언트 발급 → 실행** 3단계다.
> Client ID / Secret / 토큰은 사람마다 다르고 레포에 올라가지 않는다 — 클론한 사람 각자 본인 것을 만든다.

### 요구사항

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Google 계정 (Google Cloud 콘솔 접근, 무료)

### 1. 클론 & 의존성

```sh
git clone <repo-url> && cd mail
bun install
```

### 2. Google OAuth 클라이언트 발급 — 최초 1회, 약 5분

**[`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md) 를 그대로 따라가면 된다.** 요약:

1. [console.cloud.google.com](https://console.cloud.google.com) → 새 프로젝트
2. **Gmail API** + **Google Calendar API** 사용 설정
3. OAuth 동의 화면: 유형 **외부**, **테스트 사용자에 본인 Gmail 추가** *(빠뜨리면 403)*, 앱은 "테스트" 상태 유지
4. OAuth 클라이언트 ID 생성: 유형 **웹 애플리케이션**, 승인된 리디렉션 URI에 정확히
   ```
   http://localhost:8787/auth/callback
   ```
5. 발급된 **Client ID / Client Secret** 복사

```sh
cp .env.example .env    # 복사한 두 값 채우기 (따옴표 없이)
```

### 3. 실행

```sh
bun run dev             # → http://localhost:5173 열기
```

첫 화면에서 **"Gmail 연결하기"** → 본인 계정 선택 → 권한 허용.
*"앱이 확인되지 않았습니다"* 경고가 뜨면 **고급 → 이동** (본인이 만든 앱이라 정상이다).
받은편지함이 뜨면 끝 — 이후 재시작해도 로그인은 유지된다.

---

## 실행 모드

| 모드 | 명령 | 주소 | 설명 |
|---|---|---|---|
| 개발 | `bun run dev` | `localhost:5173` | Vite 핫리로드 + API 서버(8787) 동시 기동 |
| 프로덕션 | `bun run build && bun run start` | `localhost:8787` | 단일 서버가 빌드된 SPA까지 서빙 (gzip, 장기 캐시) |

평소에 쓸 때는 **프로덕션 모드**를 권장한다 — 프로세스 하나, 포트 하나.

## 환경 변수 (`.env`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | *(필수)* | OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | *(필수)* | OAuth 클라이언트 시크릿 (`GOCSPX-`로 시작) |
| `OAUTH_REDIRECT` | `http://localhost:8787/auth/callback` | 콘솔에 등록한 리디렉션 URI와 **정확히 일치**해야 함 |
| `PORT` | `8787` | API 서버 포트 |
| `HOST` | `127.0.0.1` | 바인드 주소. **이 앱은 요청 인증이 없다 — LAN에 노출하지 말 것** |

> 포트를 바꾸면 `PORT` · `OAUTH_REDIRECT` · 콘솔의 리디렉션 URI **세 군데**를 함께 바꿔야 한다 (불일치 시 `redirect_uri_mismatch`).

---

## 검색

상단 검색창은 Gmail 문법을 그대로 지원하고, 결과 페이지에 일정과 메일이 카드로 나란히 표시된다.

```
from:someone@x.com   subject:송장   has:attachment   is:unread newer_than:7d   label:work
```

## 데이터 & 보안

- **토큰** — `server/.data/token.json`에만 저장된다 (gitignore됨). 로그아웃하면 파일이 비워진다.
- **바인딩** — 서버는 기본적으로 `127.0.0.1`에만 묶인다. 같은 네트워크의 다른 기기에서는 접근할 수 없다.
- **메일 HTML** — 스크립트가 차단된 샌드박스 iframe에서 렌더링되고, `javascript:` 링크·meta refresh 등은 제거된다.
- **권한 범위(scope)**

  | Scope | 허용 범위 |
  |---|---|
  | `gmail.modify` | 읽기 · 발송 · 라벨 · 읽음표시 · 보관 · 휴지통. **영구 삭제는 불가** (안전장치) |
  | `calendar` | 캘린더 / 일정 조회 · 생성 · 수정 · 삭제 |

- **서명·계정 설정** — 브라우저 localStorage에 저장되며, 다른 계정으로 로그인하면 이전 계정의 서명은 자동으로 지워진다.

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `403 access_denied` | OAuth 동의 화면의 **테스트 사용자**에 본인 Gmail이 없음 |
| `redirect_uri_mismatch` | `PORT` / `OAUTH_REDIRECT` / 콘솔 리디렉션 URI 불일치 |
| `403 ... has not been used in project` | Gmail API 또는 Calendar API 사용 설정 안 함 |
| 로그인 화면으로 자꾸 돌아감 | 토큰 만료·회수 — 다시 "Gmail 연결하기" |
| 캘린더 쓰기가 안 됨 | 구버전(읽기 전용 scope) 토큰 — 로그아웃 후 재로그인 |

더 자세한 표는 [`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md) 하단 참고.

## 프로젝트 구조

```
server/
  index.ts     Hono 라우트 (/auth/*, /api/*) + 프로덕션 정적 서빙
  auth.ts      OAuth2 + 토큰 저장/갱신 (state 검증, 원자적 쓰기)
  gmail.ts     Gmail API 래퍼 (목록/스레드/발송/드래프트/라벨/첨부/설정)
  calendar.ts  Calendar API 래퍼 (일정 CRUD/검색/캘린더 목록)
web/src/
  App.tsx      전체 UI (사이드바 / 메일 / 캘린더 / 통합 검색 / 작성)
  api.ts       프론트 API 클라이언트 + 타입
  styles.css   디자인 토큰 + 전체 스타일
docs/
  OAUTH_SETUP.md   클론한 사람용 처음부터 따라하는 셋업 가이드
```

> CI(`.github/workflows/ci.yml`)가 push/PR마다 `typecheck` + `build`를 검증한다.
