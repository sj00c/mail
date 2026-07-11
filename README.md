# 📮 Mail

**내 컴퓨터에서 조용히 돌아가는 나만의 Gmail + 캘린더 + 드라이브.**

회사 보안망이 Gmail 웹사이트를 막아도, 이 앱은 내 컴퓨터(`localhost`)에서 Google과 직접 통신하기 때문에 메일·일정·파일을 평소처럼 쓸 수 있어요. 내 데이터는 Google과 내 컴퓨터 사이만 오갑니다 — 그 사이에 다른 서버는 없습니다.

> 처음이라면 **[처음 설치하기](#-처음-설치하기-1회-약-10분)** 부터. 이미 설치했다면 브라우저에서 **http://localhost:8787** 을 여세요.

---

## 목차

1. [화면 미리보기](#-화면-미리보기)
2. [무엇을 할 수 있나요](#-무엇을-할-수-있나요)
3. [처음 설치하기 (1회, 약 10분)](#-처음-설치하기-1회-약-10분)
4. [매일 쓰는 법](#-매일-쓰는-법)
5. [알아두면 좋은 기능들](#-알아두면-좋은-기능들)
6. [자주 묻는 질문 · 문제 해결](#-자주-묻는-질문--문제-해결)
7. [내 데이터는 안전한가요](#-내-데이터는-안전한가요)
8. [개발자를 위한 정보](#-개발자를-위한-정보)

---

## 🖼 화면 미리보기

**받은편지함**

![받은편지함](docs/screenshots/main.png)

**통합 검색 — 한 번 검색하면 일정 · 메일 · 파일이 나란히**

![통합 검색](docs/screenshots/search.png)

**캘린더 — 월 그리드**

![캘린더](docs/screenshots/calendar.png)

## ✨ 무엇을 할 수 있나요

### ✉️ 메일
- 받은편지함·라벨·대화(스레드) 보기, 스크롤만 내리면 이전 메일이 계속 이어져요
- 답장 · 전체답장 · 전달 · **대화 전체 전달**, 임시저장하고 나중에 이어쓰기
- 받는사람 자동완성 (주소록 + 자주 주고받은 사람)
- **보내기 취소** — 보내기를 눌러도 몇 초간 붙잡아 둡니다. "실행취소"를 누르면 작성창이 그대로 돌아와요
- **서식 있는 서명** — 굵게, 글꼴, 링크가 들어간 서명을 만들어 두면 모든 메일 끝에 자동으로 붙어요
- **나만의 기본 글꼴** — 설정에서 글꼴·크기를 고르면 받는 사람에게도 그 글꼴로 보여요
- 첨부가 25MB를 넘으면 자동으로 Drive 링크로 바꿔서 보내줘요 (Gmail 웹과 동일)
- 받은 첨부는 클릭 한 번(☁️)으로 **내 Drive에 바로 저장**
- 새 메일이 오면 데스크톱 알림

### 📅 캘린더
- 월 보기 / 목록 보기, **마우스 휠로 이전·다음 달 넘기기**
- 날짜를 클릭하면 바로 일정 만들기 — **참석자 초대, 알림(10분 전 등), Google Meet 화상회의**까지 한 화면에서
- 메일을 읽다가 **"📅 일정" 버튼**을 누르면 그 메일 내용으로 일정이 만들어져요
- 캘린더별로 보이기/숨기기 토글

### 🗂 드라이브
- 폴더 탐색, 검색, 업로드 · 다운로드, 새 폴더, 이름 바꾸기
- 삭제는 항상 휴지통으로만 — 실수로 영구 삭제될 일이 없어요

### 🔍 통합 검색
- 검색 한 번에 **일정 · 메일 · 드라이브 파일**이 세 칼럼으로 나란히
- Gmail 검색 문법 그대로: `from:aaa@x.com` `has:attachment` `is:unread newer_than:7d`

---

## 🚀 처음 설치하기 (1회, 약 10분)

딱 세 가지만 하면 됩니다: **① Google 열쇠 발급 → ② 프로그램 설치 → ③ 로그인.**

### ① Google에서 열쇠(Client ID/Secret) 발급 — 약 5분

이 앱은 "내가 만든 나만의 Google 앱"으로 내 계정에 연결됩니다. 그래서 Google 콘솔에서 열쇠 두 개를 먼저 발급받아요. 결과물은 **문자열 두 줄**이 전부입니다.

<details>
<summary><b>👉 발급 순서 펼쳐보기 (링크 클릭하며 5단계)</b></summary>

먼저 본인 Google 계정으로 로그인해 두세요 → [accounts.google.com](https://accounts.google.com)

**1. 프로젝트 만들기**
🔗 https://console.cloud.google.com/projectcreate
→ 이름은 아무거나(예: `mail`) → **만들기**

**2. API 4개 켜기** — 각 링크에서 파란 **사용** 버튼 한 번씩
- 🔗 [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
- 🔗 [Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
- 🔗 [Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
- 🔗 [People API](https://console.cloud.google.com/apis/library/people.googleapis.com) *(받는사람 자동완성용)*

**3. 동의 화면 + 테스트 사용자**
🔗 https://console.cloud.google.com/auth/overview
→ **시작하기**: 앱 이름·이메일 입력, 대상은 **외부(External)** → 완료
→ **대상(Audience)** 탭 → **테스트 사용자**에 **본인 Gmail 주소** 추가 *(게시 상태는 "테스트" 그대로)*

**4. OAuth 클라이언트 만들기**
🔗 https://console.cloud.google.com/auth/clients
→ **+ 클라이언트 만들기** → 유형: **웹 애플리케이션**
→ **승인된 리디렉션 URI**에 아래를 정확히 붙여넣기:
```
http://localhost:8787/auth/callback
```
→ **만들기**

**5. 두 값 복사해 두기**
방금 만든 클라이언트의 **Client ID**와 **Client Secret**(`GOCSPX-`로 시작)을 복사 → ③단계에서 씁니다.

> 화면이 다르게 보이면 왼쪽 메뉴 **API 및 서비스 → 사용자 인증 정보**에서 같은 작업을 할 수 있어요.
> 더 자세한 그림 설명: [docs/OAUTH_SETUP.md](docs/OAUTH_SETUP.md)

</details>

### ② 프로그램 설치

터미널을 열고 순서대로 붙여넣기:

```sh
# 1) Bun 설치 (실행 엔진) — 이미 있으면 건너뛰기
curl -fsSL https://bun.sh/install | bash     # macOS/Linux
# Windows는 PowerShell에서: powershell -c "irm bun.sh/install.ps1 | iex"

# 2) 앱 받기 (터미널 새로 연 뒤)
git clone https://github.com/SeokjuCh0/mail.git
cd mail
bun install

# 3) 열쇠 넣기
cp .env.example .env
```

`.env` 파일을 열어 ①에서 복사한 두 값을 붙여넣으세요 (따옴표·공백 없이):

```dotenv
GOOGLE_CLIENT_ID=1234567890-abcdefg.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxxxxxx
```

나머지 줄은 그대로 두면 됩니다.

### ③ 실행하고 로그인

```sh
bun run build && bun run start
```

브라우저에서 **http://localhost:8787** → **Gmail 연결하기** → 내 계정 선택 → 허용.

- *"Google에서 확인하지 않은 앱"* 경고가 떠도 괜찮아요 → **고급 → 이동**. 방금 내가 만든 테스트 앱이라 뜨는 정상 안내입니다.
- **받은편지함이 보이면 끝!** 로그인은 저장되어 재시작해도 유지됩니다.

### ➕ 추천: 자동 시작 등록

컴퓨터를 켜면 알아서 실행되고, 문제가 생겨도 스스로 재시작합니다. 한 번만 등록하세요:

| 내 컴퓨터 | 등록 | 해제 |
|---|---|---|
| **macOS** | `bash deploy/install.sh` | `bash deploy/uninstall.sh` |
| **Windows** | `powershell -ExecutionPolicy Bypass -File deploy\install.ps1` | `powershell -File deploy\uninstall.ps1` |

등록 후에는 터미널 없이 **http://localhost:8787 북마크만 열면** 됩니다.

---

## 📌 매일 쓰는 법

- 접속 주소는 항상 → **http://localhost:8787** (북마크 추천)
- 노트북을 닫았다 열어도, Wi-Fi를 바꿔도 그대로 이어집니다
- 앱을 업데이트하려면: 폴더에서 `git pull` → 자동 시작을 등록했다면 다음 재시작 때 반영, 아니면 `bun run build && bun run start`

## 💡 알아두면 좋은 기능들

| 하고 싶은 것 | 이렇게 하세요 |
|---|---|
| 서명 만들기 | 왼쪽 아래 **⚙ 설정** → 서명 칸에 입력 (굵게·글꼴·링크 툴바 지원) → 저장 |
| Gmail에 있던 서명 가져오기 | ⚙ 설정 → **Gmail 서명 가져오기** → 저장 |
| 기본 글꼴 바꾸기 | ⚙ 설정 → **기본 글꼴**에서 글꼴·크기 선택 → 저장. 받는 사람에게도 똑같이 보여요 |
| 잘못 보낸 메일 붙잡기 | 보내기를 누르면 화면 아래 **"실행취소"** 토스트가 몇 초간 떠요. 대기시간은 ⚙ 설정에서 0~20초 |
| 문장 일부만 글꼴 바꾸기 | 작성창에서 문장을 드래그 → 툴바의 글꼴/크기 선택 |
| 사람 초대하는 일정 | 일정 만들 때 **참석자** 칸에 이메일 입력 → 저장하면 초대 메일이 자동 발송 |
| 화상회의 잡기 | 일정 만들 때 **Meet 추가** 체크 → 저장하면 Meet 링크가 생겨요 |
| 메일을 일정으로 | 메일 읽는 화면의 **📅 일정** 버튼 |
| 첨부를 Drive에 보관 | 첨부 이름 옆 **☁️** 버튼 |
| 다음 달 일정 훑기 | 캘린더 월 화면에서 **마우스 휠** 위/아래 |
| 지난 메일 더 보기 | 목록을 그냥 아래로 스크롤 — 자동으로 이어서 불러와요 |
| 여러 메일 한꺼번에 정리 | 목록에서 체크박스 선택 (Shift-클릭으로 범위 선택) → 읽음/별표/보관/삭제 |
| 정교하게 검색 | `from:` `subject:` `has:attachment` `is:unread` `newer_than:7d` `label:업무` 등 Gmail 문법 그대로 |

## ❓ 자주 묻는 질문 · 문제 해결

<details>
<summary><b>로그인하려는데 "403 access_denied"가 떠요</b></summary>

Google 콘솔의 **테스트 사용자**에 본인 Gmail 주소를 추가하지 않았을 때 나는 오류예요. [설치 ①-3단계](#-처음-설치하기-1회-약-10분)를 확인하세요.
</details>

<details>
<summary><b>"redirect_uri_mismatch"가 떠요</b></summary>

콘솔에 등록한 리디렉션 URI가 `http://localhost:8787/auth/callback` 과 한 글자라도 다르면 나는 오류입니다 (`https`나 끝의 `/` 주의).
</details>

<details>
<summary><b>"has not been used in project" 403이 떠요</b></summary>

API 4개(Gmail·Calendar·Drive·People) 중 켜지 않은 게 있어요. 설치 ①-2단계의 링크에서 **사용** 버튼을 눌러주세요.
</details>

<details>
<summary><b>자꾸 로그인 화면으로 돌아가요</b></summary>

보안상 토큰이 만료되거나 회수된 경우예요. **Gmail 연결하기**로 다시 로그인하면 됩니다. 예전에 로그인했는데 캘린더 수정이나 드라이브가 안 될 때도 로그아웃 → 재로그인 한 번이면 해결돼요 (새 권한으로 재발급).
</details>

<details>
<summary><b>페이지가 안 열려요 (localhost:8787)</b></summary>

서버가 꺼져 있는 상태예요. 앱 폴더에서 `bun run build && bun run start`로 켜거나, [자동 시작](#-추천-자동-시작-등록)을 등록해 두세요.
</details>

<details>
<summary><b>다른 기기(폰 등)에서도 접속할 수 있나요?</b></summary>

기본적으로 안 됩니다 — 이 앱에는 별도의 비밀번호가 없어서, 일부러 내 컴퓨터 안에서만 열리게 잠가뒀어요. 그게 안전합니다.
</details>

## 🔒 내 데이터는 안전한가요

- **중간 서버가 없어요.** 이 앱은 내 컴퓨터에서 Google API와 직접 통신합니다. 메일 내용이 다른 곳으로 가지 않아요.
- **로그인 열쇠는 내 컴퓨터에만** 저장됩니다 (`server/.data/token.json`). 로그아웃하면 지워져요.
- **외부에서 접속 불가** — 서버가 내 컴퓨터 안(`127.0.0.1`)에만 열립니다.
- **메일 영구 삭제 불가** — 권한 자체를 휴지통까지만 받아서, 실수로도 완전 삭제는 일어나지 않아요.
- **악성 메일 방어** — 메일 속 HTML은 스크립트가 차단된 격리 화면에서만 열리고, 위험한 링크·자동이동은 제거됩니다.
- 요청하는 Google 권한: Gmail(읽기·발송·정리), 캘린더(일정 관리), 드라이브(파일 관리), 주소록(**읽기만** — 자동완성용).

---

## 🛠 개발자를 위한 정보

<details>
<summary>펼쳐보기 — 스택, 환경 변수, 프로젝트 구조</summary>

### 스택

| | |
|---|---|
| 백엔드 | Bun · Hono · Gmail / Calendar / Drive / People REST API |
| 프론트 | React 18 · Vite |
| 인증 | OAuth2 (state 검증, 토큰 원자적 저장/자동 갱신) |

### 실행 모드

| 모드 | 명령 | 주소 | 용도 |
|---|---|---|---|
| 개발 | `bun run dev` | `localhost:5173` | 핫리로드 (Vite + API 서버) |
| 프로덕션 | `bun run build && bun run start` | `localhost:8787` | 일상 사용 — 단일 프로세스가 SPA까지 서빙 |

### 환경 변수 (`.env`)

| 변수 | 기본값 | 설명 |
|---|---|---|
| `GOOGLE_CLIENT_ID` | *(필수)* | OAuth 클라이언트 ID |
| `GOOGLE_CLIENT_SECRET` | *(필수)* | OAuth 클라이언트 시크릿 |
| `OAUTH_REDIRECT` | `http://localhost:8787/auth/callback` | 콘솔 등록값과 정확히 일치해야 함 |
| `PORT` | `8787` | API 서버 포트 — 바꾸면 `OAUTH_REDIRECT`·콘솔 URI도 함께 |
| `HOST` | `127.0.0.1` | 바인드 주소. 요청 인증이 없으므로 LAN 노출 금지 |

### 권한 범위 (scope)

| Scope | 범위 |
|---|---|
| `gmail.modify` | 읽기·발송·라벨·보관·휴지통 (영구 삭제 불가) |
| `calendar` | 일정 CRUD (참석자 초대 `sendUpdates`, Meet 생성 `conferenceData`) |
| `drive` | 탐색·업로드·다운로드·휴지통 + 대용량 첨부 링크 공유 |
| `contacts.readonly` + `contacts.other.readonly` | 읽기 전용 자동완성 |

### 프로젝트 구조

```
server/
  index.ts     Hono 라우트 (/auth/*, /api/*) + 프로덕션 정적 서빙
  auth.ts      OAuth2 + 토큰 저장/갱신
  gmail.ts     Gmail API 래퍼 (목록/스레드/발송/드래프트/라벨/첨부/설정)
  calendar.ts  Calendar API 래퍼 (일정 CRUD/검색/참석자·알림·Meet)
  drive.ts     Drive API 래퍼 (탐색/검색/업로드/다운로드/휴지통/공유)
web/src/
  App.tsx      전체 UI (메일/캘린더/드라이브/통합 검색/작성/설정)
  api.ts       프론트 API 클라이언트 + 타입
  styles.css   디자인 토큰 + 전체 스타일
docs/
  OAUTH_SETUP.md   OAuth 셋업 상세 가이드
  PRD.md           점검 리포트 · 릴리스 노트 · 백로그
deploy/
  install.sh / install.ps1     자동 시작 등록 (launchd / 작업 스케줄러)
  run.sh / run.cmd             빌드 후 서버 기동 진입점
```

CI(`.github/workflows/ci.yml`)가 push/PR마다 `typecheck` + `build`를 검증한다.

</details>
