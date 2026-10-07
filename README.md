# Mail

Gmail·Google Calendar·Google Drive·Google Contacts를 한곳에서 사용하는 로컬 웹 앱입니다.
서버는 `127.0.0.1`에만 열리고 Google API에 직접 연결합니다.

- 기본 주소: <http://localhost:8787>
- 배포는 npm 패키지 [`@sj00c/mail`](https://www.npmjs.com/package/@sj00c/mail) 하나입니다. 소스 ZIP으로 설치했다면 아래 [ZIP 설치에서 옮기기](#migrate-zip)를 따르세요.
- Client ID·Client Secret은 README나 채팅에 붙이지 말고 로컬 `.env`에만 저장하세요.

## 설치

필요한 것: Windows 10(1809)+/11 또는 macOS, [Node.js](https://nodejs.org) 22 이상(npm 포함), 인터넷.

```sh
npx @sj00c/mail@latest setup
```

Windows·macOS 같은 명령입니다. 작업 폴더 `~/sj-mail`(Windows는 `%USERPROFILE%\sj-mail`)에 앱을 설치하고, 서버 실행에 쓰는 Bun이 없으면 공식 설치기로 함께 설치합니다. 화면에 단계별 로그를 보여 주며 같은 내용을 파일에 남깁니다.

- 처음에는 `.env` 템플릿을 만들고 멈춥니다. [Google 연결 준비](#google-setup)대로 Client ID·Secret을 넣고 **같은 명령을 다시 실행**하면 로그인 시 자동 실행을 등록하고 서버 응답까지 확인한 뒤 브라우저를 엽니다.
- 업데이트도 같은 명령입니다. `.env`와 로그인 정보는 그대로 유지됩니다.
- 다른 폴더: `--dir <폴더>`, 자동 실행 없이 설치만: `--no-autostart`

<a id="migrate-zip"></a>

### ZIP 설치에서 옮기기

기존 ZIP(또는 git) 설치에서도 위 명령을 그대로 실행하면 됩니다. `setup`이 기존 자동 실행 항목에서 이전 폴더를 찾아 다음을 처리합니다.

- `.env`와 `server/.data`(로그인 정보)를 새 작업 폴더로 복사 — 이미 있는 파일은 덮어쓰지 않음
- 이전 자동 실행(Windows `MailLocal` 예약 작업, macOS `launchd`)을 새 설치로 교체
- 이전 폴더는 건드리지 않음 — 새 설치가 정상인지 확인한 뒤 직접 지우세요.

자동 실행을 등록하지 않았거나 해제했다면 이전 폴더를 직접 지정합니다.

```sh
npx @sj00c/mail@latest setup --from "<이전 ZIP 폴더>"
```

### 관리

작업 폴더에서 실행합니다(`cd ~/sj-mail`).

```sh
npm run status      # 상태 확인
npm run restart     # 재시작 (start / stop도 가능, stop은 다음 로그인까지 유지)
npm run uninstall   # 자동 실행 해제 (.env·로그인 정보는 남음, 폴더를 지우면 완전 삭제)
npm run serve       # 자동 실행 없이 이 터미널에서 실행 (Ctrl+C로 종료)
```

<a id="logs"></a>

### 로그

| | Windows (`%LOCALAPPDATA%\MailLocal\`) | macOS |
|---|---|---|
| 설치 화면 기록 | `setup.log` | `~/Library/Logs/sj-mail/setup.log` |
| 자동 실행 등록 상세 | `install.log` | (설치 화면 기록에 포함) |
| 서버 | `mail.local.log` | `~/Library/Logs/mail.local.log` |

설치가 실패하면 화면 마지막에 실패한 단계와 로그 경로가 표시됩니다. 로그를 공유할 때는 Secret·토큰·인증 코드·전체 OAuth URL을 지우세요.

<a id="google-setup"></a>

## Google 연결 준비

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
   - 발급된 Client ID·Client Secret은 작업 폴더의 `.env`에만 입력

### `.env` 입력

```powershell
notepad "$HOME\sj-mail\.env"     # Windows
```

```sh
open -e ~/sj-mail/.env             # macOS
```

`GOOGLE_CLIENT_ID`와 `GOOGLE_CLIENT_SECRET`을 본인이 발급한 값으로 바꾸고 저장한 뒤 `npx @sj00c/mail@latest setup`을 다시 실행합니다. 값에 따옴표나 앞뒤 공백을 넣지 마세요. 포트를 바꿀 때는 `PORT`, `OAUTH_REDIRECT`, Google Cloud의 승인된 리디렉션 URI를 모두 같은 번호로 바꾸세요.

## 처음 연결하기

설치가 끝난 뒤 <http://localhost:8787>을 열고 **Gmail 연결하기**를 누릅니다. Google 테스트 사용자로 로그인하고 권한을 허용하세요. 본인이 만든 테스트 앱에 `Google에서 확인하지 않은 앱`이 표시되면 `고급 → Mail(으)로 이동`을 선택합니다.

설치 성공, Google 인증 성공, 각 Google API 접근 권한은 서로 별개입니다. 상태 확인 주소는 <http://127.0.0.1:8787/auth/status>입니다.

## 주요 기능

- **메일:** 편지함·라벨·대화, Gmail 검색, 무한 스크롤, 읽음·보관·별표·휴지통·일괄 처리
- **작성:** 답장·전체답장, 서식·서명·기본 글꼴, 첨부파일, 보내기 취소
- **첨부:** Drive 저장, 25MB 초과 첨부의 Drive 링크 발송
- **화면:** 앱 다크·라이트 테마, 받은 메일 본문의 원래 배경색·글자색 유지
  - 창 축소·브라우저 확대 시 사이드바와 메일 목록 폭을 유동적으로 줄여 본문 공간 우선 확보
  - 긴 수신자·참조 목록은 요약 표시하고 본문과 별도로 펼치기·접기
  - 메일 헤더에서 로그인 주소·발신 별칭과 일치하는 이름과 주소는 `나` 표시로 강조; 메일 본문 원문은 변경하지 않음
  - 메일 선택 도구는 높이를 고정해 클릭 위치 유지. 읽음·보관·휴지통·전체 결과 선택은 `⋯` 작업 메뉴에서 실행
  - 작업 메뉴: 아래/위 화살표로 이동, Enter로 실행, Escape로 닫기. 메뉴가 열린 동안 목록 단축키는 실행되지 않음
  - 긴 주소 목록은 펼칠 때만 렌더링하고, 메일·작성·설정·캘린더·Drive는 같은 네이비/코발트 디자인 사용
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

- **`.env` placeholder:** `setup`은 실제 Client ID·Secret이 들어가기 전에는 자동 실행을 등록하지 않습니다. [`.env` 입력](#google-setup) 후 다시 실행하세요.
- **`401 invalid_client`:** 같은 웹 클라이언트의 ID·Secret 쌍과 Secret 재발급 여부를 확인하고 `.env` 저장 후 `npm run restart`하세요.
- **`403 access_denied`:** 해당 프로젝트의 테스트 사용자 등록과 조직 관리자 정책을 확인하세요.
- **`redirect_uri_mismatch`:** Google Cloud URI와 `.env`의 `OAUTH_REDIRECT`가 완전히 같은지 확인하세요. `https`나 끝의 `/`를 추가하지 마세요.
- **`has not been used in project`:** Google API 4개가 같은 프로젝트에서 사용 설정됐는지 확인하세요.
- **반복 로그인:** `.env`의 공백·따옴표와 테스트 사용자 설정을 확인하세요. 테스트 앱은 약 7일마다 재로그인이 필요할 수 있습니다.
- **`npx`를 찾을 수 없음:** Node.js 설치 후 터미널을 새로 여세요. Bun 자동 설치가 실패하면 인터넷과 `bun.sh`·`registry.npmjs.org` 접근을 확인하세요.
- **Windows 작업 등록 권한 거부(`0x80070005`):** 같은 계정의 관리자 PowerShell에서 `setup`을 다시 실행하고 회사 정책·작업 소유권은 관리자에게 확인하세요.
- **포트 충돌:** 점유 프로그램을 확인한 뒤 사용 가능한 포트로 바꾸세요. 예를 들어 `.env`의 `PORT=8788`, `OAUTH_REDIRECT=http://localhost:8788/auth/callback`으로 함께 바꾸고 Google Cloud에도 같은 URI를 추가합니다. 프로세스 이름이 `bun`이라는 이유만으로 임의 종료하지 마세요.
- **로그:** [로그](#logs) 표를 참고하세요. Windows 작업은 서버가 종료되면 1분 간격으로 다시 시작합니다.

## 데이터·보안

- `.env`와 인증 토큰을 공유하거나 커밋하지 마세요. 로그아웃하면 저장된 토큰 내용이 비워집니다.
  - 위치: 작업 폴더의 `.data/token.json` (ZIP 설치는 `server/.data/token.json`)
- 서버는 루프백 전용으로 실행되므로 LAN·인터넷에 공개하지 마세요.
- 메일 HTML은 스크립트가 차단된 격리 화면에서 표시합니다.
- 메일 본문의 외부 이미지는 해당 이미지 서버로 요청될 수 있습니다.
- Gmail 영구 삭제는 사용하지 않으며 연락처는 읽기 전용입니다.

## 개발자 참고

- CI의 npm resolver 회귀 검사는 `.github/workflows/ci.yml`에 고정한 Node/npm과 `package.json`의 Bun 도구 조합을 사용합니다. 로컬 재현 시에도 이 도구 조합을 맞추세요.
- 소스 빌드는 `bun install --frozen-lockfile` 후 `bun run build`입니다. 패키지는 `npm pack`으로 만들고 `bun run check:package`·`node scripts/package-smoke.mjs <tgz>`로 검증합니다. `SJ_MAIL_PACKAGE_SPEC=file:<tgz>`를 주면 `setup`이 레지스트리 대신 그 tarball을 설치합니다.
- 배포: GitHub Release를 만들면 `.github/workflows/release.yml`이 npm trusted publishing으로 게시합니다(npmjs.com에서 trusted publisher 설정 필요).
- 환경 변수 예시는 [`.env.example`](.env.example)에서 확인하세요. 개발 서버는 `bun run dev`(웹 `5173`, API `8787`), 운영 빌드는 `bun run build && bun run start`입니다.
- 소스 구조와 설치 안전 지침은 [CLAUDE.md](CLAUDE.md)를 참고하세요.

<a id="claude-code-install"></a>

### Claude Code로 설치

Claude Code에서 설치할 때도 이 README 순서를 따르고 [CLAUDE.md](CLAUDE.md)의 안전 지침을 먼저 읽으세요. Client ID·Client Secret은 채팅에 보내지 말고 로컬 `.env`에 직접 입력합니다.

## 라이선스

MIT — [LICENSE](LICENSE). 배포에 포함된 React·React DOM·Scheduler·Vite 런타임 헬퍼의 고지는 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)에 있습니다. npm으로 별도 설치되는 서버 의존성의 라이선스는 각 패키지에 포함됩니다.
