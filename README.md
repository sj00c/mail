# Mail

- Gmail·Google Calendar·Google Drive·Google Contacts 통합 로컬 웹 앱
- 기본 주소: <http://localhost:8787>
- 서버: `127.0.0.1` 전용, 외부 중계 서버 없이 Google API 직접 연결

## 기능

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

## 요구 사항

- Windows 10 1809 이상·Windows 11 또는 Bash·`launchd` 사용 가능한 macOS
- Google 계정·인터넷·웹 브라우저
- 웹 애플리케이션용 OAuth Client ID·Client Secret 필요 — API Key 아님
- Bun은 설치기에서 확인·설치

## npm 패키지로 설치·업데이트

`@sj00c/mail`의 첫 npm 릴리즈가 게시된 뒤 사용할 수 있습니다.
Node.js 22 이상과 Bun 1.3.14 이상을 먼저 설치하세요. npm은 패키지 설치·업데이트를,
Bun은 서버 실행을 담당합니다. 사용자가 소스를 빌드할 필요는 없습니다.

```sh
npx --package=@sj00c/mail sj-mail init my-mail
cd my-mail
npm install
```

생성된 `.env`에 아래 Google Cloud 설정의 Client ID와 Secret을 입력한 뒤:

```sh
npm run start
```

<http://localhost:8787>에서 사용합니다. 수동 실행이므로 이 터미널을 닫으면 서버도
종료됩니다. 업데이트할 때는 먼저 `Ctrl+C`로 서버를 종료한 뒤 같은 사용자 폴더에서:

```sh
npm update
npm run start
```

- 사용자 폴더의 `package.json`이 `@sj00c/mail`을 의존성으로 설치합니다.
  GitHub 체크아웃 폴더에서 `npm update`를 실행해 앱 소스를 갱신하는 방식은 아닙니다.
- 업데이트 범위는 설치 당시 버전 이상의 안정 릴리즈입니다. 메이저 업데이트도
  포함하므로 새 릴리즈 안내를 확인하세요.
- `.env`와 `.data/token.json`은 사용자 폴더에 있고 `node_modules` 밖에 보존됩니다.
- 기존 소스 설치의 자동 실행 서버와 동시에 실행하면 기본 포트가 충돌합니다.
  아래 운영체제별 자동 시작 해제 명령으로 기존 서버를 중지하고 전환하세요.
- 아래 Windows/macOS 설치기는 GitHub 소스에서 설치하고 로그인 시 자동 실행하는
  별도 방식입니다. npm 수동 실행은 예약 작업을 등록하거나 수정하지 않습니다.

## 1. Google Cloud 설정

1. [프로젝트 생성](https://console.cloud.google.com/projectcreate) 후 해당 프로젝트 선택
2. API 4개 사용 설정
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - [People API](https://console.cloud.google.com/apis/library/people.googleapis.com)
3. [Google Auth Platform](https://console.cloud.google.com/auth/overview) 설정
   - 앱 이름: `Mail`, 지원·연락처 이메일: 본인 주소
   - 사용자 유형: **외부(External)**, 게시 상태: **테스트 중(Testing)**
   - **대상(Audience) → 테스트 사용자**에 실제 로그인할 Gmail 주소 추가
4. [데이터 액세스](https://console.cloud.google.com/auth/scopes)에 권한 5개 추가
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/contacts.other.readonly`
5. [OAuth 클라이언트 생성](https://console.cloud.google.com/auth/clients)
   - 유형: **웹 애플리케이션**, 승인된 자바스크립트 원본: 비워 두기
   - 승인된 리디렉션 URI: `http://localhost:8787/auth/callback`
   - 발급된 Client ID·Client Secret은 로컬 `.env`에만 입력

<a id="run-app"></a>

## 2. 직접 설치하기

### Windows

1. [최신 ZIP](https://github.com/sj00c/mail/archive/refs/heads/main.zip) 다운로드·압축 해제 후 계속 사용할 위치로 이동
2. `package.json`과 `deploy`가 있는 폴더에서 PowerShell 실행
3. 기존 `.env`를 보존하며 설정 파일 열기

   ```powershell
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   notepad .env
   ```

4. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 입력 후 **저장**
   - 대괄호·따옴표·앞뒤 공백 없이 입력, `PORT`·`OAUTH_REDIRECT` 기본값 유지
5. 같은 앱 폴더에서 설치기 실행

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\deploy\install.ps1
   ```

### macOS

- 앱 폴더에서 기존 `.env`를 보존하며 설정 파일 열기

  ```sh
  test -e .env || cp .env.example .env
  open -e .env
  ```

- Google Client ID·Client Secret 입력 후 **저장**, 설치기 실행

  ```sh
  bash deploy/install.sh
  ```

### 설치 완료 후

- 설치기 처리: 설정 형식 확인 → Bun·의존성 설치 → 빌드 → 자동 시작 등록 → 로컬 응답 확인
- <http://localhost:8787> 접속 → **Gmail 연결하기** → 테스트 사용자 계정 로그인·권한 허용
- 본인이 만든 앱에 `Google에서 확인하지 않은 앱` 표시 시: `고급 → Mail(으)로 이동`
- 상태 확인: <http://127.0.0.1:8787/auth/status>
- 설치 성공과 Google 인증·API 접근 성공은 별개

<a id="claude-code-install"></a>

### Claude Code로 설치

- 저장소를 연 Claude Code에 아래 요청 사용; [설치 안전 지침](CLAUDE.md) 준수
- Secret은 채팅 대신 로컬 `.env`에 입력

  ```text
  이 저장소를 설치해줘.
  README.md, CLAUDE.md, .env.example과 내 운영체제의 설치기를 먼저 읽어.
  Google Cloud 설정을 안내하고 Client ID와 Secret은 로컬 .env에 직접 입력하게 해.
  .env 저장 확인 후 해당 설치기로 설치하고 빌드·auth/status 응답을 확인해.
  ```

<a id="auto-start"></a>

## 시작·업데이트·제거

- **자동 시작:** Windows `MailLocal` 작업 또는 macOS `launchd`가 로그인 시 기존 빌드 실행
- **Windows 실행 창:** 설치 완료 후 CMD·PowerShell 창을 열어 둘 필요 없이 숨김 실행됩니다. 재부팅 후 사용자 로그인 시 서버가 시작되며, 로그인할 때 다시 빌드하지 않습니다.
- **Windows 서버 종료:** 예약 작업을 중지하면 연결된 Bun 서버도 함께 종료되어 포트가 해제됩니다.
- **업데이트·폴더 이동:** 해당 앱 폴더에서 운영체제별 설치기 재실행
  - Git: `git pull --ff-only origin main`으로 소스 갱신 후 설치
  - ZIP: 새 폴더에 압축 해제, 기존 `.env`와 필요 시 `server/.data` 이전 후 설치
  - 정상 동작 확인 전 기존 폴더 보관, 토큰·데이터 외부 전송 금지
- **자동 시작·서버 해제:** `.env`·토큰·사용자 데이터는 보존
  - Windows: `powershell -File deploy\uninstall.ps1`
  - macOS: `bash deploy/uninstall.sh`

## 문제 해결

- **`401 invalid_client`:** 같은 웹 클라이언트의 ID·Secret 쌍과 Secret 재발급 여부 확인 → `.env` 저장 → 설치기 재실행
- **`403 access_denied`:** 해당 프로젝트의 테스트 사용자 등록과 조직 관리자 정책 확인
- **`redirect_uri_mismatch`:** 콘솔 URI와 `OAUTH_REDIRECT` 완전 일치 확인; `https`·끝의 `/` 추가 금지
- **`has not been used in project`:** 해당 프로젝트의 Google API 4개 사용 설정 확인
- **반복 로그인:** `.env` 저장·공백·따옴표 확인; 테스트 앱은 약 7일마다 재로그인 필요할 수 있음
- **Bun 설치 실패·시간 초과:** 인터넷 및 `bun.com`·`bun.sh` 접근 확인; 시간 초과만으로 PC 성능·인증 오류 단정 금지
- **Windows 작업 등록 권한 거부(`0x80070005`):** 같은 계정의 관리자 PowerShell에서 설치기 재실행; 회사 정책·작업 소유권은 관리자 확인
- **`.ps1` 경로 오류:** 현재 폴더에 `package.json`과 `deploy`가 있는지 확인
- **포트 충돌:** 점유 프로그램 확인 후 사용 가능한 포트로 변경·재설치
  - 예: `PORT=8788`, `OAUTH_REDIRECT=http://localhost:8788/auth/callback`
  - Google OAuth 클라이언트에도 같은 URI 추가, 접속·상태 확인 주소의 포트도 변경
  - 프로세스 이름이 `bun`이라는 이유만으로 임의 종료 금지
- **로그 위치:** 공유 시 Secret·토큰·인증 코드·전체 OAuth URL 제외
  - Windows 설치: `%LOCALAPPDATA%\MailLocal\install.log`
  - Windows 서버: `%LOCALAPPDATA%\MailLocal\mail.local.log`
  - macOS 서버: `~/Library/Logs/mail.local.log`
  - Windows 작업 실패 시 최대 3회, 1분 간격 재시도

## 데이터·보안

- `.env`와 인증 토큰 공유·커밋 금지; 로그아웃 시 저장된 토큰 내용 비우기
  - 소스 설치: `server/.data/token.json`
  - npm 설치: 사용자 폴더의 `.data/token.json`
- 루프백 전용 실행, LAN·인터넷에 서버 공개 금지
- 메일 HTML은 스크립트가 차단된 격리 화면에서 표시
- 메일 본문의 외부 이미지는 해당 이미지 서버로 요청될 수 있음
- Gmail 영구 삭제 미사용, 연락처 읽기 전용

## 개발

- 환경 변수: [`.env.example`](.env.example)
  - 필수: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  - 선택: `PORT`(기본 `8787`, 범위 `1024–65535`), `OAUTH_REDIRECT`, `HOST`(기본 `127.0.0.1`)
  - 리디렉션 URI의 포트와 서버 `PORT` 일치 필수
- 의존성: `bun install`; 개발: `bun run dev` — 웹 `5173`, API `8787`
- 운영: `bun run build && bun run start`
- 검증: **실행 중인 앱·인증 자료와 분리한 사본에서 수행**
  - 단위 시험: `bun run test:unit`, 타입 검사: `bun run typecheck`
  - 빌드: `bun run build` — 해당 사본의 `dist/` 덮어쓰기
  - 브라우저 시험: 빌드 후 `CI=1 bun run test:e2e --retries=0` — 기존 테스트 서버 재사용 금지
- 구조
  - `web/src/views/`: 메일·캘린더·Drive·검색·설정 화면
  - `web/src/ui/`, `hooks/`, `lib/`: 공통 UI·상태·연락처·서식 처리
  - `server/index.ts`, `app.ts`: 서버 시작·환경 검사·보안·인증·라우트 조립·정적 파일 제공
  - `server/routes/`: 메일·캘린더·Drive HTTP 처리
  - `server/{auth,gmail,calendar,drive,contacts}.ts`: Google 인증·API 연동
  - `deploy/`: 양 운영체제 설치·자동 시작·제거
  - `e2e/`, `docs/`: 모의 브라우저 회귀 시험, 제품 기록·화면 자료

## 릴리즈 관리

- 공개 패키지: `@sj00c/mail`; 소스: <https://github.com/sj00c/mail>.
- CI는 테스트·타입 검사·브라우저 빌드와 배포 tarball의 분리 설치·실행을 검사합니다.
- `package.json` 버전과 같은 `vX.Y.Z` 태그로 안정 GitHub Release를 발행합니다.
  `.github/workflows/release.yml`이 해당 태그를 검증하고, 빌드된 동일 tarball을
  Windows/macOS/Linux에서 시험한 후 npm에 공개 배포합니다.
- GitHub Release 자체가 npm 업데이트 소스는 아닙니다. 이 워크플로가 npm에
  게시한 새 버전을 사용자 폴더의 `npm update`가 받습니다.
- `.env`, 인증 토큰, 로그, 테스트, 설치기와 개발 소스는 패키지에서 제외합니다.
  실행용 `server` 소스와 빌드된 `dist`, CLI, 라이선스 고지만 배포합니다.

### npm 계정에서 한 번 설정

1. `sj00c` 계정으로 로그인하고 `@sj00c/mail`의 최초 게시 권한을 준비합니다.
   패키지가 아직 없어서 Trusted Publisher를 등록할 수 없다면 검증된 첫 tarball을
   소유자 계정의 `npm publish <tarball> --access public`으로 먼저 게시해야 합니다.
   계정 인증·2FA는 소유자가 수행하며 토큰을 레포에 넣지 않습니다.
2. npm 패키지 Settings → Trusted Publisher에서 GitHub Actions를 선택합니다.
   User: `sj00c`, Repository: `mail`, Workflow filename: `release.yml`.
   **직접 `npm publish` 허용**도 선택합니다.
3. 이후 새 버전의 GitHub Release부터 OIDC로 자동 게시합니다. 이미 게시된 버전은
   다시 게시할 수 없으므로 첫 수동 게시 후에는 버전을 올려 릴리즈하세요.

Node 24와 npm 11.5.1 이상의 GitHub-hosted runner를 사용하고,
게시 작업에만 `id-token: write` 권한을 부여합니다. 장기 npm 토큰은 사용하지 않습니다.
GitHub 계정 권한과 npm 패키지 권한은 별개입니다.

## 라이선스

MIT — [LICENSE](LICENSE). 배포에 포함된 React·React DOM·Scheduler·Vite 런타임 헬퍼의 고지는
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)에 있습니다. npm으로 별도 설치되는
서버 의존성의 라이선스는 각 패키지에 포함됩니다.
