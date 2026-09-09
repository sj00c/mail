# Mail

Gmail·Google Calendar·Google Drive·Google Contacts를 한곳에서 사용하는 로컬 웹 앱입니다.
서버는 `127.0.0.1`에만 열리고 Google API에 직접 연결합니다.

- 기본 주소: <http://localhost:8787>
- 처음 설치한다면 **소스 ZIP을 먼저 설치·빌드한 뒤**, Google 연결 설정을 진행하세요.
- Client ID·Client Secret은 README나 채팅에 붙이지 말고 로컬 `.env`에만 저장하세요.

## 빠른 시작: 소스 ZIP 설치·빌드

아래 1~3단계는 OAuth 비밀값 없이 완료할 수 있습니다. 이 단계가 끝나면 의존성과 웹 화면이 설치·빌드된 상태이며, 아직 서버를 시작하거나 Google에 연결하지 않습니다.

### 1. ZIP 다운로드·압축 해제

[소스 ZIP 다운로드](https://github.com/sj00c/mail/archive/refs/heads/main.zip) → 압축 해제 → 계속 사용할 위치에 보관하세요. `package.json` 파일과 `deploy` 폴더가 있는 폴더를 엽니다. 폴더 이름은 바꿔도 됩니다.

**Windows (PowerShell)**

파일 탐색기에서 해당 폴더를 연 뒤 주소 표시줄에 `powershell`을 입력하고 Enter를 누릅니다. 그 폴더에서 PowerShell이 열립니다.

**macOS (Terminal)**

터미널을 열고 `cd `를 입력합니다(뒤에 공백 포함). Finder에서 압축을 푼 폴더를 터미널로 끌어 놓고 Enter를 누릅니다. 이후 명령은 모두 해당 폴더에서 실행합니다.

### 2. Bun 설치

[Bun 공식 설치 안내](https://bun.sh/docs/installation)의 Windows 또는 macOS 절차를 따라 Bun을 설치하세요. 설치 후 새 PowerShell/Terminal을 열고 다음으로 버전을 확인합니다.

```sh
bun --version
```

소스 설치에는 Bun **1.3.14 이상**이 필요합니다. 공식 안내에 따라 설치했는데 `bun`을 찾지 못하면 터미널을 새로 열어 PATH를 갱신하세요. 새 터미널에서도 1단계 방법으로 앱 폴더를 다시 여세요.

### 3. 의존성 설치·빌드

ZIP을 푼 최상위 폴더에서 다음을 순서대로 실행합니다.

```sh
bun install --frozen-lockfile
bun run build
```

`bun install`과 `bun run build`는 `.env`, OAuth Client ID·Secret 없이도 실행됩니다. `dist/index.html`이 만들어지면 설치·빌드가 완료된 것입니다. **서버를 시작하려면 다음 Google 연결 설정과 `.env`가 필요합니다.**

### 필요한 환경

- Windows 10 버전 1809 이상·Windows 11 또는 Bash와 `launchd`를 사용할 수 있는 macOS
- Google 계정·인터넷·웹 브라우저 (Google 연결 단계에서 필요)
- npm 대안을 사용할 때는 Node.js 22 이상도 필요

## Google 연결 준비 (나중에 해도 됨)

Google 계정으로 앱을 연결할 때 필요한 단계입니다. 위의 설치·빌드는 먼저 끝내고, 실제로 연결할 때 진행해도 됩니다. `deploy/install.ps1`과 `deploy/install.sh`는 `.env`와 실제 Client ID·Secret을 먼저 검사하므로 이 설정 전에 설치기를 실행하지 마세요.

### Google Cloud 프로젝트·OAuth 설정

1. [프로젝트 생성](https://console.cloud.google.com/projectcreate) 후 해당 프로젝트를 선택합니다.
2. 다음 API 4개를 사용 설정합니다.
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - [People API](https://console.cloud.google.com/apis/library/people.googleapis.com)
3. [Google Auth Platform](https://console.cloud.google.com/auth/overview)에서 앱을 설정합니다.
   - 앱 이름: `Mail`, 지원·연락처 이메일: 본인 주소
   - 사용자 유형: **외부(External)**, 게시 상태: **테스트 중(Testing)**
   - **대상(Audience) → 테스트 사용자**에 실제 로그인할 Gmail 주소 추가
4. [데이터 액세스](https://console.cloud.google.com/auth/scopes)에 다음 권한 5개를 추가합니다.
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/contacts.other.readonly`
5. [OAuth 클라이언트](https://console.cloud.google.com/auth/clients)를 만듭니다.
   - API Key가 아니라 웹 애플리케이션용 OAuth Client ID·Client Secret을 발급합니다.
   - 유형: **웹 애플리케이션**
   - 승인된 자바스크립트 원본: 비워 둠
   - 승인된 리디렉션 URI: `http://localhost:8787/auth/callback`
   - 발급된 Client ID·Client Secret은 아래 로컬 `.env`에만 입력

### 로컬 `.env` 만들기 (기존 파일은 덮어쓰지 않음)

앱 루트에서 운영체제에 맞는 명령을 실행하세요. 이미 `.env`가 있으면 두 명령 모두 그대로 보존합니다.

**Windows (PowerShell)**

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
notepad .env
```

**macOS (Terminal)**

```sh
test -e .env || cp .env.example .env
open -e .env
```

`.env`의 `GOOGLE_CLIENT_ID`와 `GOOGLE_CLIENT_SECRET`을 본인이 발급한 값으로 바꾸고 저장합니다. 값에 따옴표나 앞뒤 공백을 넣지 마세요. 기본 `PORT=8787`과 `OAUTH_REDIRECT=http://localhost:8787/auth/callback`은 그대로 두면 됩니다. 포트를 바꿀 때는 두 값의 포트와 Google Cloud의 승인된 리디렉션 URI를 모두 같은 번호로 바꾸세요. `HOST`는 기본값 `127.0.0.1`을 사용합니다.

## 앱 시작·로그인·자동 시작 (소스 설치기)

<a id="run-app"></a>

위 `.env`에 실제 Google 값을 저장한 다음에만 설치기를 실행하세요. 두 설치기는 설정을 먼저 검증한 뒤 Bun을 다시 확인하고, `bun install --frozen-lockfile`과 `bun run build`를 다시 실행해 현재 소스로 빌드합니다. 이어서 로그인 시 자동 실행을 등록하고 서버의 `/auth/status` 응답을 확인합니다. 따라서 **빌드 단계는 비밀값 없이 가능하지만, 설치기를 통한 시작·자동 실행에는 유효한 `.env`가 필요합니다.**

### Windows

앱 루트에서 PowerShell을 열고 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\install.ps1
```

설치 완료 시 브라우저가 열리며, 이후 로그인할 때는 `MailLocal` 예약 작업이 서버를 숨김 실행합니다.

### macOS

앱 루트의 Terminal에서 실행합니다.

```sh
bash deploy/install.sh
```

설치 완료 시 브라우저가 열리며, 이후 로그인할 때는 `launchd`가 서버를 실행합니다.

### 처음 연결하기

설치가 끝난 뒤 <http://localhost:8787>을 열고 **Gmail 연결하기**를 누릅니다. Google 테스트 사용자로 로그인하고 권한을 허용하세요. 본인이 만든 테스트 앱에 `Google에서 확인하지 않은 앱`이 표시되면 `고급 → Mail(으)로 이동`을 선택합니다.

설치 성공, Google 인증 성공, 각 Google API 접근 권한은 서로 별개입니다. 상태 확인 주소는 <http://127.0.0.1:8787/auth/status>입니다.

<a id="auto-start"></a>

### 자동 시작·업데이트·제거

- **자동 시작:** Windows `MailLocal` 예약 작업 또는 macOS `launchd`가 로그인할 때 이미 빌드된 앱을 실행합니다. 로그인할 때마다 다시 빌드하지는 않습니다.
- **업데이트:** 소스가 바뀌었거나 폴더를 옮겼다면 앱 루트에서 해당 운영체제 설치기를 다시 실행하세요. 설치기가 설정·Bun·의존성을 재확인하고 다시 빌드한 뒤 자동 실행 항목을 갱신합니다.
  - ZIP을 업데이트할 때는 새 폴더에 압축을 풀고 기존 `.env`와 필요하면 기존 `server/.data`를 옮긴 뒤, 새 폴더에서 설치기를 실행합니다. 새 버전이 정상 동작하는 것을 확인하기 전에는 이전 폴더를 지우지 마세요.
  - Git 체크아웃을 사용 중이라면 `git pull --ff-only origin main` 후 설치기를 다시 실행합니다.
- **자동 시작·서버 해제:** 이 명령은 자동 실행과 현재 서버를 해제하지만 `.env`, 토큰, 사용자 데이터를 삭제하지 않습니다.
  - Windows: `powershell -File deploy\uninstall.ps1`
  - macOS: `bash deploy/uninstall.sh`

## npm 대안 (현재 공개 여부 미확인)

현재 공개 npm 버전을 확인하지 못했으므로 위 ZIP 설치를 사용하세요. 아래 명령은 npm에 패키지가 공개된 뒤 사용할 수 있습니다.

npm 경로에는 Node.js **22 이상**과 Bun **1.3.14 이상**이 필요합니다. npm은 패키지를 설치·업데이트하고, Bun은 서버를 실행합니다. 원하는 위치에 빈 폴더를 만들고 그 폴더에서 터미널을 여세요. ZIP 소스 폴더에서 실행하는 명령이 아닙니다. Google 설정 없이 먼저 설치할 수 있습니다.

```sh
npx --package=@sj00c/mail sj-mail init
npm install
```

`@sj00c/mail`은 설치할 패키지의 이름일 뿐이며, 별도 npm 계정이나 가입은 필요 없습니다. `sj-mail init`은 현재 폴더에 `package.json`과 `.env` 템플릿을 만들며, 기존 파일을 덮어쓰지 않습니다. 설치 후 연결할 준비가 되면 `.env`에 Google 값을 입력하세요. Google Cloud 설정과 리디렉션 URI는 위와 같습니다. 그런 다음:

```sh
npm run start
```

`npm run start`는 Bun과 `.env` 파일을 확인한 뒤 서버를 실행합니다. `.env`가 없으면 시작하지 않으며 Google 연결에는 유효한 값이 필요합니다. 이 방식은 현재 터미널에서 수동으로 실행하며 터미널을 닫거나 `Ctrl+C`를 누르면 서버가 종료됩니다. 업데이트할 때는 서버를 먼저 중지하고 같은 사용자 폴더에서 다음을 실행합니다.

```sh
npm update
npm run start
```

npm 방식은 Windows 예약 작업이나 macOS `launchd`를 등록·수정하지 않습니다. npm 방식의 `.env`와 `.data/token.json`은 사용자 폴더에 보존되고, 소스 ZIP 방식의 토큰은 `server/.data/token.json`에 저장됩니다. 두 방식을 동시에 실행하면 기본 포트가 충돌할 수 있습니다.

## 주요 기능

- **메일:** 편지함·라벨·대화, Gmail 검색, 무한 스크롤, 읽음·보관·별표·휴지통·일괄 처리
- **작성:** 답장·전체답장, 서식·서명·기본 글꼴, 첨부파일, 보내기 취소
- **첨부:** Drive 저장, 25MB 초과 첨부의 Drive 링크 발송
- **화면:** 앱 다크·라이트 테마, 받은 메일 본문의 원래 배경색·글자색 유지
- **알림·개수:** 새 메일 알림, Google 제공 계정 메시지 수와 편지함 개수 구분
  - 계정 개수와 `ALL(전체메일)` 검색 개수는 다를 수 있음; 기준은 대화가 아닌 개별 메일
- **캘린더:** 월·목록 보기, 일정 생성·수정·삭제, 참석자·알림·Meet, 여러 캘린더 표시
- **Drive:** 폴더 탐색·검색, 업로드·다운로드, 새 폴더·이름 변경·휴지통
- **Contacts·검색:** 읽기 전용 연락처 자동완성, 메일·일정·Drive 통합 검색

<a id="reply-forward"></a>

### 답장·대화 전달

- 답장: 선택한 메일 인용
- 전체답장: 보낸사람·받는사람·참조 대상, 내 주소·send-as 별칭 제외
- 전달: **현재 대화 전체**를 최신 메일부터 전달, 메일별 정보·본문·첨부 포함
- 명확한 중복 인용만 축약, 불확실한 인용·대화 밖 원문·첨부·인라인 이미지 보존
- 받은편지함 전체나 다른 대화는 전달 범위에서 제외

<a id="bulk-cleanup"></a>

### 전체메일 정리

- 전체 선택 후 읽음·안읽음·휴지통 처리
- 화면에 불러온 목록을 넘어 서버에서 전체 대상 확정
- 확인창의 대상 개수 확인 후 실행, 확정 이후 도착한 메일 제외
- 영구 삭제가 아닌 휴지통 이동

## 문제 해결

- **`.env` 없음·placeholder 오류:** 소스 설치기와 npm 시작 명령은 설정이 없으면 서버를 시작하지 않습니다. 위의 안전한 생성 명령으로 `.env`를 만들고 실제 Client ID·Secret을 입력하세요.
- **`401 invalid_client`:** 같은 웹 클라이언트의 ID·Secret 쌍과 Secret 재발급 여부를 확인하고 `.env` 저장 후 소스 설치기를 다시 실행하세요.
- **`403 access_denied`:** 해당 프로젝트의 테스트 사용자 등록과 조직 관리자 정책을 확인하세요.
- **`redirect_uri_mismatch`:** Google Cloud URI와 `.env`의 `OAUTH_REDIRECT`가 완전히 같은지 확인하세요. `https`나 끝의 `/`를 추가하지 마세요.
- **`has not been used in project`:** Google API 4개가 같은 프로젝트에서 사용 설정됐는지 확인하세요.
- **반복 로그인:** `.env`의 공백·따옴표와 테스트 사용자 설정을 확인하세요. 테스트 앱은 약 7일마다 재로그인이 필요할 수 있습니다.
- **Bun 설치 실패·시간 초과:** 인터넷 및 `bun.com`·`bun.sh` 접근을 확인하세요. 시간 초과만으로 PC 성능이나 인증 오류를 단정하지 마세요.
- **Windows 작업 등록 권한 거부(`0x80070005`):** 같은 계정의 관리자 PowerShell에서 설치기를 다시 실행하고 회사 정책·작업 소유권은 관리자에게 확인하세요.
- **`.ps1` 경로 오류:** 현재 폴더에 `package.json`과 `deploy`가 있는지 확인하세요.
- **포트 충돌:** 점유 프로그램을 확인한 뒤 사용 가능한 포트로 바꾸세요. 예를 들어 `.env`의 `PORT=8788`, `OAUTH_REDIRECT=http://localhost:8788/auth/callback`으로 함께 바꾸고 Google Cloud에도 같은 URI를 추가합니다. 프로세스 이름이 `bun`이라는 이유만으로 임의 종료하지 마세요.
- **로그 위치:** 공유할 때 Secret·토큰·인증 코드·전체 OAuth URL을 제외하세요.
  - Windows 설치: `%LOCALAPPDATA%\MailLocal\install.log`
  - Windows 서버: `%LOCALAPPDATA%\MailLocal\mail.local.log`
  - macOS 서버: `~/Library/Logs/mail.local.log`
  - Windows 작업은 실패 시 최대 3회, 1분 간격으로 재시도합니다.

## 데이터·보안

- `.env`와 인증 토큰을 공유하거나 커밋하지 마세요. 로그아웃하면 저장된 토큰 내용이 비워집니다.
  - 소스 ZIP 설치: `server/.data/token.json`
  - npm 설치: 사용자 폴더의 `.data/token.json`
- 서버는 루프백 전용으로 실행되므로 LAN·인터넷에 공개하지 마세요.
- 메일 HTML은 스크립트가 차단된 격리 화면에서 표시합니다.
- 메일 본문의 외부 이미지는 해당 이미지 서버로 요청될 수 있습니다.
- Gmail 영구 삭제는 사용하지 않으며 연락처는 읽기 전용입니다.

## 개발자 참고

- CI의 npm resolver 회귀 검사는 `.github/workflows/ci.yml`에 고정한 Node/npm과 `package.json`의 Bun 도구 조합을 사용합니다. 로컬 재현 시에도 이 도구 조합을 맞추세요.
- 소스 설치·빌드는 저장소 루트에서 `bun install --frozen-lockfile` 후 `bun run build`를 사용하세요. 배포 가능한 아카이브는 `npm pack`으로 확인하고, 소비자 프로젝트 의존성 갱신에만 해당 프로젝트에서 `npm update`를 실행하세요.
- 환경 변수 예시는 [`.env.example`](.env.example)에서 확인하세요. 개발 서버는 `bun run dev`(웹 `5173`, API `8787`), 운영 빌드는 `bun run build && bun run start`입니다.
- 소스 구조와 설치 안전 지침은 [CLAUDE.md](CLAUDE.md)를 참고하세요.

<a id="claude-code-install"></a>

### Claude Code로 설치

Claude Code에서 설치할 때도 이 README 순서를 따르고 [CLAUDE.md](CLAUDE.md)의 안전 지침을 먼저 읽으세요. Client ID·Client Secret은 채팅에 보내지 말고 로컬 `.env`에 직접 입력합니다.

## 라이선스

MIT — [LICENSE](LICENSE). 배포에 포함된 React·React DOM·Scheduler·Vite 런타임 헬퍼의 고지는 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)에 있습니다. npm으로 별도 설치되는 서버 의존성의 라이선스는 각 패키지에 포함됩니다.
