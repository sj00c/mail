# Mail

- Gmail·Calendar·Drive·Contacts 로컬 웹 앱
- 주소: <http://localhost:8787> (`127.0.0.1` 전용)
- 배포: npm [`@sj00c/mail`](https://www.npmjs.com/package/@sj00c/mail)

## 설치·업데이트

- 지원: Windows 10(1809)+/11, macOS
- 사전 설치: 없음 (Bun 자동 설치)
- 설치·업데이트 같은 명령

**Windows** — 시작 메뉴 → PowerShell (`Win+R`은 끝나면 창이 닫혀 결과를 못 봄)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.ps1 | iex"
```

**macOS** — Terminal

```sh
curl -fsSL https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.sh | bash
```

- 설치 후 브라우저 → **Gmail 연결하기** → 로그인
- Google Client ID·Secret을 묻는 경우: [Google 연결 준비](#google-setup) → 열린 편집기에 입력·저장 → 설치 창에서 Enter
  - 앱에 Google 클라이언트가 내장된 배포판이면 묻지 않음
- 업데이트: 설정·로그인 정보 유지
- 스크립트·AI 에이전트(터미널 없음): 묻지 않고 종료 → `bunx @sj00c/mail config`로 입력 → 같은 명령 재실행

### 옵션

| 옵션 | 용도 |
|---|---|
| `--from <폴더>` | 예전 설치 폴더 직접 지정 |
| `--dir <폴더>` | 다른 위치에 설치 |
| `--no-autostart` | 자동 실행 없이 설치 (`bunx @sj00c/mail run`으로 실행) |

- 한 줄 설치에 옵션 붙이기
  - Windows: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.ps1))) --no-autostart`
  - macOS: `curl -fsSL https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.sh | bash -s -- --no-autostart`

<a id="migrate-zip"></a>

### 상황별

| 상황 | 할 일 |
|---|---|
| 새 PC | 한 줄 설치 |
| 업데이트 | 한 줄 설치 |
| 예전 설치(ZIP·git·AI 에이전트·이전 npm 버전), 자동 실행 동작 중 | 한 줄 설치 (자동으로 옮김) |
| 예전 폴더는 있고 자동 실행 없음 | 한 줄 설치 + `--from <예전 폴더>` |
| 예전 폴더를 지움 | 한 줄 설치 → Client ID·Secret 재입력(묻는 경우) → 재로그인 |
| Google Cloud 설정 전 | 한 줄 설치 → 입력 단계에서 대기 또는 `Ctrl+C` 후 나중에 재실행 |
| 회사 PC, 예약 작업 권한 거부 | 관리자 PowerShell로 재실행 → 안 되면 `--no-autostart` |
| Linux | macOS 명령 → `bunx @sj00c/mail run` (자동 실행 미지원) |

- 옮기기 동작
  - 설정(`.env`)·로그인 정보 복사, 기존 값은 덮어쓰지 않음
  - 기존 자동 실행 교체 (예전 폴더가 지워졌어도)
  - 예전 폴더는 그대로 둠 → 확인 후 직접 삭제
  - 예전 서버를 손으로 켜 뒀다면 먼저 종료 (포트 충돌)

## 관리

- 아무 터미널에서 실행 (새 터미널 필요할 수 있음: Bun 설치 직후)

```sh
bunx @sj00c/mail doctor      # 전체 점검 + 해결 방법 (Secret 미출력)
bunx @sj00c/mail status      # 실행·자동 실행 상태, 마지막 시작·종료 기록
bunx @sj00c/mail config      # 설정(.env) 편집기로 열기
bunx @sj00c/mail restart     # 재시작 (설정 변경 반영)
bunx @sj00c/mail stop        # 다음 로그인까지 끄기
bunx @sj00c/mail start       # 다시 켜기
bunx @sj00c/mail uninstall   # 자동 실행 해제 (설정·로그인 정보 유지)
bunx @sj00c/mail run         # 현재 터미널에서 실행 (창 닫으면 종료)
```

- 상시 실행
  - 로그인·재부팅 시 자동 시작
  - 비정상 종료 시 재시작: Windows 1분 이내, macOS 약 10초
  - `stop`은 다음 로그인까지만 유지

<a id="logs"></a>

### 로그

- 위치: `doctor` 출력 마지막 줄
- Windows 서버 로그: 시작(`Starting Mail`)·종료(`Mail exited: <코드>`) 누적, 5MB 초과 시 이전 파일로 넘김
- 공유 시 Secret·토큰·인증 코드·전체 OAuth URL 삭제

<a id="google-setup"></a>

## Google 연결 준비

- 설치 중 Client ID·Secret을 물을 때만 필요

1. [프로젝트 생성](https://console.cloud.google.com/projectcreate) → 선택
2. API 사용 설정
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - (선택) [People API](https://console.cloud.google.com/apis/library/people.googleapis.com) — 받는사람 자동완성. 없으면 자동완성만 빔
3. [Google Auth Platform](https://console.cloud.google.com/auth/overview)
   - 앱 이름 `Mail`, 지원·연락처 이메일: 본인
   - 사용자 유형 **외부(External)**, 게시 상태 **테스트 중(Testing)**
   - **대상 → 테스트 사용자**: 로그인할 Gmail 주소 추가
4. [데이터 액세스](https://console.cloud.google.com/auth/scopes) 권한 5개
   - `https://www.googleapis.com/auth/gmail.modify`
   - `https://www.googleapis.com/auth/calendar`
   - `https://www.googleapis.com/auth/drive`
   - `https://www.googleapis.com/auth/contacts.readonly`
   - `https://www.googleapis.com/auth/contacts.other.readonly`
5. [OAuth 클라이언트](https://console.cloud.google.com/auth/clients) (API Key 아님)
   - 유형: **웹 애플리케이션**
   - 자바스크립트 원본: 비움
   - 리디렉션 URI: `http://localhost:8787/auth/callback`
6. 입력
   - 설치 창이 열어 준 편집기, 또는 `bunx @sj00c/mail config`
   - `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` 교체 (따옴표·공백 없이)
   - 저장 → 설치 창에서 Enter, 창이 닫혔으면 설치 명령 재실행 (설치 후 변경은 `bunx @sj00c/mail restart`)
   - 포트 변경 시 `PORT`·`OAUTH_REDIRECT`·Google Cloud 리디렉션 URI를 같은 번호로

## 첫 로그인

- <http://localhost:8787> → **Gmail 연결하기**
- 테스트 사용자 계정으로 로그인·권한 허용
- `Google에서 확인하지 않은 앱` → `고급 → Mail(으)로 이동`
- 테스트 모드 앱은 약 7일마다 재로그인

## 주요 기능

- **메일:** 편지함·라벨·대화, Gmail 검색, 무한 스크롤, 읽음·보관·별표·휴지통·일괄 처리
- **작성:** 답장·전체답장, 서식·서명·기본 글꼴, 첨부, 보내기 취소
- **첨부:** Drive 저장, 25MB 초과는 Drive 링크로 발송
- **화면:** 다크·라이트 테마, 받은 메일의 원래 배경·글자색 유지
  - 창 축소·확대 시 사이드바·목록 폭 자동 조정
  - 긴 수신자·참조 목록 요약, 따로 펼치기·접기
  - 내 주소·발신 별칭은 `나`로 강조 (본문 원문은 그대로)
  - 선택 도구 높이 고정, 일괄 작업은 `⋯` 메뉴 (화살표·Enter·Escape)
- **알림·개수:** 새 메일 알림, 계정 메시지 수와 편지함 개수 구분 (`ALL` 검색은 메일 단위)
- **캘린더:** 월·목록 보기, 일정 생성·수정·삭제, 참석자·알림·Meet, 여러 캘린더
- **Drive:** 폴더 탐색·검색, 업로드·다운로드, 새 폴더·이름 변경·휴지통
- **연락처·검색:** 읽기 전용 자동완성, 메일·일정·Drive 통합 검색

<a id="reply-forward"></a>

### 답장·전달

- 답장: 선택한 메일 인용
- 전체답장: 보낸사람·받는사람·참조 (내 주소·send-as 별칭 제외)
- 전달: 현재 대화 전체를 최신순으로, 메일별 정보·본문·첨부 포함
- 명확한 중복 인용만 축약, 불확실한 인용·첨부·인라인 이미지는 보존

<a id="bulk-cleanup"></a>

### 전체메일 정리

- 전체 선택 → 읽음·안읽음·휴지통
- 화면 밖 메일까지 서버에서 대상 확정, 확인창에 개수 표시
- 확정 이후 도착한 메일 제외
- 영구 삭제 없음 (휴지통 이동)

## 문제 해결

- 먼저 `bunx @sj00c/mail doctor` → 출력 결과를 그대로 문의에 첨부

| 증상 | 조치 |
|---|---|
| Client ID·Secret 미입력 | `bunx @sj00c/mail config` → 입력 → 설치 명령 재실행 |
| `401 invalid_client` | ID·Secret이 같은 클라이언트 것인지, Secret 재발급 여부 확인 → `bunx @sj00c/mail restart` |
| `403 access_denied` | 테스트 사용자 등록, 조직 정책 확인 |
| `redirect_uri_mismatch` | Google Cloud URI와 `OAUTH_REDIRECT` 완전 일치 (`https`·끝 `/` 금지) |
| `has not been used in project` | 해당 API 사용 설정 (People API만 꺼졌으면 자동완성만 비활성) |
| 반복 로그인 | `.env` 공백·따옴표, 테스트 사용자 확인. 테스트 앱은 약 7일마다 재로그인 |
| `bunx`를 찾을 수 없음 | 새 터미널 열기 (Bun 설치 직후 PATH 미반영) |
| Bun 설치 실패 | `bun.sh`·`registry.npmjs.org` 접근 확인 후 재실행 |
| `0x80070005` (작업 등록 거부) | 같은 계정의 관리자 PowerShell로 재실행 |
| `Port 8787 is occupied` | 점유 프로그램 종료, 또는 `PORT=8788`·`OAUTH_REDIRECT=http://localhost:8788/auth/callback` + Google Cloud URI 추가. `bun`이라는 이름만 보고 종료하지 않기 |
| 서버가 자꾸 꺼짐 | `status`의 마지막 종료 기록, 서버 로그의 `Mail exited`·`Mail launch failed` |

## 데이터·보안

- 설정(`.env`)·로그인 토큰은 OS 사용자 앱 데이터 폴더에 저장, 공유·커밋 금지
- 로그아웃 시 토큰 내용 삭제
- 서버는 루프백 전용, LAN·인터넷 공개 금지
- 메일 HTML은 스크립트 차단된 격리 화면에 표시
- 메일 본문의 외부 이미지는 해당 서버로 요청될 수 있음
- Gmail 영구 삭제 없음, 연락처 읽기 전용

## 개발

- 빌드: `bun install --frozen-lockfile` → `bun run build`
- 개발 서버: `bun run dev` (웹 `5173`, API `8787`)
- 환경 변수 예시: [`.env.example`](.env.example)
- 패키지 검증: `npm pack` → `bun run check:package` → `node scripts/package-smoke.mjs <tgz>`
  - smoke 검사는 Mail 자동 실행이 설치된 PC에서 실행 거부 (자동 실행은 사용자 단위라 격리 불가)
  - `SJ_MAIL_PACKAGE_SPEC=file:<tgz>`: setup이 레지스트리 대신 tarball 설치
- 내장 Google 클라이언트 (선택)
  - Google Cloud에서 **데스크톱 앱** 유형 OAuth 클라이언트 생성 (Google은 설치형 앱의 Secret을 비밀로 취급하지 않음)
  - 로컬 배포: 저장소 `.env`에 `BUNDLED_GOOGLE_CLIENT_ID`·`BUNDLED_GOOGLE_CLIENT_SECRET` → `npm pack`/`npm publish` 시 `dist/oauth-client.json`으로 포함
  - CI 배포: 같은 이름의 저장소 secret
  - 사용자는 그 프로젝트의 테스트 사용자로 등록 (최대 100명) 또는 Google 검증 필요
- CI npm resolver 검사: `.github/workflows/ci.yml`의 Node/npm + `package.json`의 Bun 조합
- 배포: GitHub Release → `.github/workflows/release.yml`이 npm trusted publishing으로 게시 (npmjs.com trusted publisher 설정 필요)

## 라이선스

- MIT — [LICENSE](LICENSE)
- 번들된 React·React DOM·Scheduler·Vite 런타임 헬퍼 고지: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)
- npm으로 설치되는 서버 의존성 라이선스: 각 패키지에 포함
