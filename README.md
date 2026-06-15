# Mail

**내 머신에서 `localhost`로 띄워 쓰는 개인용 Gmail + Google 캘린더 + Google 드라이브 클라이언트.**
사내 보안망이 Gmail 웹(`mail.google.com`)은 막아도 Gmail API / OAuth는 통과하는 환경을 위해 만들었다.

| | |
|---|---|
| **백엔드** | Bun · Hono · Gmail / Calendar / Drive REST API |
| **프론트** | React · Vite |
| **인증** | OAuth2 — refresh token은 **이 머신에만** 저장 (`server/.data/token.json`) |
| **외부 연결** | Google API 단 하나. 그 외 어떤 서버와도 통신하지 않는다 |

#### 기능

- **메일** — 받은편지함·라벨, 스레드 보기, HTML 본문(스크립트 차단 샌드박스)·인라인 이미지·첨부, 읽음·별표·스팸·보관·삭제, 작성·답장·전체답장·전달, 다중 수신자·참조·숨은참조·서명, 받는사람 자동완성(주소록 + 자주 주고받은 주소), 임시저장·드래프트 이어쓰기, 새 메일 데스크톱 알림
  - **큰 첨부 자동 Drive 전환** — MIME 한도(25MB)를 넘는 첨부는 발송 시 자동으로 Google Drive에 올라가 "링크 공유"로 본문에 삽입된다 (Gmail 웹이 25MB 초과 시 하는 동작과 동일). 인라인 이미지는 항상 본문에 직접 첨부된다.
- **드라이브** — 내 드라이브 폴더 탐색(브레드크럼)·전체 검색, 업로드·다운로드(Google 문서는 Office 형식으로 내보내기)·새 폴더·이름 변경·휴지통 이동, 저장용량 표시. 삭제는 휴지통(복구 가능)만 — 영구 삭제는 없다.
- **캘린더** — 월 그리드 / 목록 뷰, 캘린더별 표시 토글, 일정 생성·수정·삭제, 종일·멀티데이 일정, 60초 자동 갱신
- **통합 검색** — 검색하면 **일정 · 메일 · 드라이브 파일**이 세 칼럼 카드로 나란히 뜨고(검색어 하이라이트), `?q=검색어` URL로 바로 열 수도 있다
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

> 순서: **OAuth 클라이언트 발급 → Bun 설치 → 클론 → `.env` 작성 → 실행.** 한 번만 하면 된다.
> 발급(1단계)은 로컬에 코드가 없어도 되는 외부 작업이라 **먼저 해두고**, 받은 두 값을 4단계에서 `.env`에 붙여넣는 흐름이다.

시작 전에, **무엇을 발급받아 어디에 넣는지**부터. 직접 챙겨야 하는 값은 단 두 개다:

| 값 | 어떻게 얻나 | 어디에 넣나 | 비고 |
|---|---|---|---|
| **Client ID** | Google 콘솔에서 OAuth 클라이언트 생성 (아래 1단계) | `.env` → `GOOGLE_CLIENT_ID=` | 사람마다 다름, 레포에 안 올라감 |
| **Client Secret** | 위와 동시에 발급됨 | `.env` → `GOOGLE_CLIENT_SECRET=` | `GOCSPX-`로 시작 |
| 리디렉션 URI | ~~발급 아님~~ — 레포가 정해둔 고정값 | 반대로 **Google 콘솔에 등록**한다 | `http://localhost:8787/auth/callback` |
| 토큰 (refresh token) | 첫 로그인 때 자동 발급 | 자동 — `server/.data/token.json` | 직접 만질 일 없음 |

레포가 이미 해둔 것: `.env.example`(채우기만 하면 되는 틀), OAuth 콜백 처리·토큰 저장/갱신(서버가 알아서), 빌드/실행 스크립트. **즉 할 일은 "콘솔에서 ID/Secret 발급 → `.env`에 붙여넣기 → 실행"이 전부다.**

### 1. Google OAuth 클라이언트 발급 — 최초 1회, 약 5분

> 코드를 받기 전에 먼저. 이 단계의 결과물은 **Client ID / Secret 두 문자열**뿐이고, 4단계에서 `.env`에 붙여넣는다. 그때까지 메모장 등에 임시로 둬도 된다.

이 앱은 "각자 자기가 만든 Google 앱"으로 본인 계정에 붙는 구조다. 먼저 본인 Google 계정으로 로그인해 둔다 → [accounts.google.com](https://accounts.google.com).
아래 ①~⑤를 순서대로. 각 단계의 **🔗 링크를 클릭하면 그 화면으로 바로 이동**한다 (①에서 만든 프로젝트가 자동으로 선택된 채 열린다).

**① 프로젝트 생성**
🔗 https://console.cloud.google.com/projectcreate
→ **프로젝트 이름**에 아무거나 입력(예: `mail`) → **만들기** → 생성될 때까지 10초쯤 기다린다.

**② Gmail · Calendar · Drive · People API 켜기** *(각 링크에서 파란 **사용**(Enable) 버튼 한 번씩)*
🔗 Gmail API → https://console.cloud.google.com/apis/library/gmail.googleapis.com → **사용**
🔗 Calendar API → https://console.cloud.google.com/apis/library/calendar-json.googleapis.com → **사용**
🔗 Drive API → https://console.cloud.google.com/apis/library/drive.googleapis.com → **사용**
🔗 People API → https://console.cloud.google.com/apis/library/people.googleapis.com → **사용** *(받는사람 자동완성용 주소록 읽기)*

**③ OAuth 동의 화면 + 테스트 사용자**
🔗 https://console.cloud.google.com/auth/overview
→ 처음이면 **시작하기(Get started)**: 앱 이름·지원 이메일만 채우고, 대상(Audience)은 **외부(External)** 선택 → 완료.
→ 그다음 왼쪽 **대상(Audience)** 탭 → **테스트 사용자(Test users)** 항목의 **+ 사용자 추가**에 **본인 Gmail 주소**를 넣는다. *(게시 상태는 "테스트"로 그대로 둔다 — 개인용이라 검수 불필요)*

**④ OAuth 클라이언트 ID 만들기**
🔗 https://console.cloud.google.com/auth/clients
→ **+ 클라이언트 만들기(Create client)** → **애플리케이션 유형: 웹 애플리케이션(Web application)** 선택
→ **승인된 리디렉션 URI(Authorized redirect URIs)** 의 **+ URI 추가**에 아래를 정확히 붙여넣기:
```
http://localhost:8787/auth/callback
```
→ **만들기(Create)**.

**⑤ 두 값 복사**
만들기 직후 뜨는 창(또는 ④ 목록에서 방금 만든 클라이언트 클릭)에서 **클라이언트 ID**와 **클라이언트 보안 비밀번호(Client secret)** 를 복사해 둔다 → 다음 4단계에서 `.env`에 붙여넣는다.

> 💡 콘솔 UI가 위 화면과 다르게 보이면 (구버전), 왼쪽 메뉴 **API 및 서비스 → OAuth 동의 화면 / 사용자 인증 정보**로 가면 같은 자리다. 막히면 → [`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md)
>
> ⚠️ 빠뜨리면 나는 에러 3종 — **②** 안 켬 → `403 ... has not been used in project` · **③** 테스트 사용자 안 넣음 → `403 access_denied` · **④** URI 한 글자라도 다름(`http`/끝 `/`) → `redirect_uri_mismatch`

### 2. Bun 설치

| OS | 설치 명령 |
|---|---|
| macOS / Linux | `curl -fsSL https://bun.sh/install \| bash` |
| Windows (PowerShell) | `powershell -c "irm bun.sh/install.ps1 \| iex"` |

설치 후 **터미널을 새로 열고** 확인:

```sh
bun --version        # 1.x 가 출력되면 OK
```

### 3. 클론 & 의존성

```sh
git clone https://github.com/SeokjuCh0/mail.git
cd mail
bun install
```

### 4. `.env` 작성

```sh
cp .env.example .env
```

`.env`를 열어 **윗줄 두 개만** ⑤에서 복사한 값으로 바꾼다. 완성 예시:

```dotenv
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx
OAUTH_REDIRECT=http://localhost:8787/auth/callback
PORT=8787
```

> 따옴표·앞뒤 공백 없이 붙여넣는다. 정상 Secret은 `GOCSPX-`로 시작한다. 아래 두 줄은 그대로 둔다.

### 5. 실행 & 첫 로그인

```sh
bun run dev
```

브라우저에서 **http://localhost:5173** 접속 → **"Gmail 연결하기"** → 본인 계정 선택 → 허용.
(`5173`은 방금 켠 개발 서버 주소다 — 평소 사용 주소는 ⑥의 `8787`.)

- *"Google에서 확인하지 않은 앱"* 경고가 뜨면 → **고급 → 이동(안전하지 않음)**. ③에서 직접 만든 테스트 앱이라 정상이다.
- **받은편지함이 보이면 설치 끝.** 토큰이 `server/.data/token.json`에 저장돼 재시작해도 로그인이 유지된다.

잘 됐는지 터미널로도 확인할 수 있다:

```sh
curl -s localhost:8787/auth/status     # {"authed":true} 면 성공
```

### 6. 평소 사용 — 프로덕션 모드 권장

| 모드 | 명령 | 주소 | 용도 |
|---|---|---|---|
| 개발 | `bun run dev` | `localhost:5173` | 코드 수정·핫리로드 (Vite + API 서버 2개 프로세스) |
| **프로덕션** | `bun run build && bun run start` | `localhost:8787` | **일상 사용** — 프로세스 하나가 SPA까지 서빙 (gzip, 장기 캐시) |

> **평소 접속 주소는 http://localhost:8787 이다.** `5173`은 `bun run dev`를 켜둔 동안만 뜨는
> 개발용 포트라, 아래 자동 시작을 등록해도 `5173`은 열리지 않는다 — 북마크는 `8787`로.

### 자동 시작 — 켜두면 알아서 돌아가게 (선택)

매번 터미널에서 켜기 싫다면 OS에 등록해 두면 **로그인 시 자동 시작 + 죽으면 자동 재시작**된다.
한 번만 등록하면 재부팅·크래시에도 알아서 켜진다.

> sleep(노트북 닫기)은 프로세스를 멈췄다 깨우는 것뿐이라 자동으로 이어진다 — 등록과 무관하게 잘 된다.
> WiFi↔랜 전환도 영향 없다(서버는 `localhost`에 묶여 있음). 등록은 **재부팅·완전 종료·크래시**를 위한 것.

| OS | 등록 | 해제 |
|---|---|---|
| **macOS** (launchd) | `bash deploy/install.sh` | `bash deploy/uninstall.sh` |
| **Windows** (작업 스케줄러) | `powershell -ExecutionPolicy Bypass -File deploy\install.ps1` | `powershell -File deploy\uninstall.ps1` |

> 등록 스크립트는 자동으로 빌드 후 `localhost:8787`에 띄운다. 로그(macOS): `~/Library/Logs/mail.local.log`.
> 코드를 업데이트(`git pull`)하면 다음 자동 재시작 때 새로 빌드되어 반영된다.

한 번만 임시로 띄우려면:

```sh
bun run build && bun run start     # 끄기: Ctrl-C (또는 lsof -ti:8787 | xargs kill)
```

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

상단 검색창은 Gmail 문법을 그대로 지원하고, 결과 페이지에 **일정 · 메일 · 드라이브 파일**이 세 칼럼 카드로 나란히 표시된다. (드라이브는 파일명 + 본문 전문(fullText) 검색)

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
  | `drive` | 드라이브 파일 조회 · 업로드 · 다운로드 · 휴지통 · 큰 첨부 링크 공유. 기존 파일까지 탐색해야 해서 `drive.file`이 아닌 전체 `drive` |
  | `contacts.readonly` · `contacts.other.readonly` | **읽기 전용** — 받는사람 자동완성 (주소록 + 자주 주고받은 주소). 연락처 수정은 불가 |

- **서명·계정 설정** — 브라우저 localStorage에 저장되며, 다른 계정으로 로그인하면 이전 계정의 서명은 자동으로 지워진다.

## 트러블슈팅

| 증상 | 원인 / 해결 |
|---|---|
| `403 access_denied` | OAuth 동의 화면의 **테스트 사용자**에 본인 Gmail이 없음 |
| `redirect_uri_mismatch` | `PORT` / `OAUTH_REDIRECT` / 콘솔 리디렉션 URI 불일치 |
| `403 ... has not been used in project` | Gmail / Calendar / Drive API 중 사용 설정 안 한 것이 있음 (②) |
| 로그인 화면으로 자꾸 돌아감 | 토큰 만료·회수 — 다시 "Gmail 연결하기" |
| 캘린더 쓰기가 안 됨 / 드라이브 탭이 비거나 로그인으로 튕김 | 구버전(드라이브·쓰기 scope 없는) 토큰 — 로그아웃 후 재로그인하면 새 권한으로 재발급된다 |

더 자세한 표는 [`docs/OAUTH_SETUP.md`](docs/OAUTH_SETUP.md) 하단 참고.

## 프로젝트 구조

```
server/
  index.ts     Hono 라우트 (/auth/*, /api/*) + 프로덕션 정적 서빙
  auth.ts      OAuth2 + 토큰 저장/갱신 (state 검증, 원자적 쓰기)
  gmail.ts     Gmail API 래퍼 (목록/스레드/발송/드래프트/라벨/첨부/설정)
  calendar.ts  Calendar API 래퍼 (일정 CRUD/검색/캘린더 목록)
  drive.ts     Drive API 래퍼 (탐색/검색/업로드/다운로드/휴지통 + 큰 첨부 링크 공유)
web/src/
  App.tsx      전체 UI (사이드바 / 메일 / 캘린더 / 드라이브 / 통합 검색 / 작성)
  api.ts       프론트 API 클라이언트 + 타입
  styles.css   디자인 토큰 + 전체 스타일
docs/
  OAUTH_SETUP.md   클론한 사람용 처음부터 따라하는 셋업 가이드
deploy/
  install.sh / uninstall.sh    macOS 자동 시작 (launchd)
  install.ps1 / uninstall.ps1  Windows 자동 시작 (작업 스케줄러)
  run.sh / run.cmd             빌드 후 서버 기동 진입점
```

> CI(`.github/workflows/ci.yml`)가 push/PR마다 `typecheck` + `build`를 검증한다.
