# Mail

내 컴퓨터에서 돌아가는 Gmail·캘린더·Drive 앱. 브라우저로 <http://localhost:8787> 에서 씀.

## 설치하기

처음 설치와 업데이트 모두 같은 방법.

**1. Google 키 2개 준비** (처음 한 번만)

- Client ID, Client Secret
- 받는 법: 아래 [Google 키 받기](#google-setup)

**2. 설치 명령 붙여넣기**

- Windows: 시작 메뉴에서 **PowerShell** 열기 → 붙여넣기 → Enter

  ```powershell
  powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.ps1 | iex"
  ```

- macOS: **터미널** 열기 → 붙여넣기 → Enter

  ```sh
  curl -fsSL https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.sh | bash
  ```

**3. 키 입력**

- 설치 창이 `Client ID:` 를 물으면 붙여넣기 → Enter
- `Client Secret:` 도 똑같이 (화면에는 `*` 로 보임)
- 잘못 넣으면 이유를 알려 주고 다시 물어봄

**4. 로그인**

- 브라우저가 열리면 **Gmail 연결하기** → Google 계정으로 로그인
- `Google에서 확인하지 않은 앱` 화면 → **고급** → **Mail(으)로 이동**

끝.

- 컴퓨터를 켤 때마다 자동으로 실행됨
- 설치 위치는 신경 쓸 필요 없음
- 업데이트: 2번 명령을 다시 실행 (키·로그인 유지)
- 약 7일마다 다시 로그인해야 할 수 있음 (Google 테스트 앱 규칙)

<a id="google-setup"></a>

## Google 키 받기

처음 한 번, 약 10분. 링크를 위에서부터 차례로 열면 됨.

1. [프로젝트 만들기](https://console.cloud.google.com/projectcreate) → 이름 아무거나 → 만들기
2. 아래 3개를 각각 열고 **사용** 클릭
   - [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
   - [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com)
   - [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
   - (선택) [People API](https://console.cloud.google.com/apis/library/people.googleapis.com): 받는사람 이름 자동완성용
3. [앱 정보 설정](https://console.cloud.google.com/auth/overview) → **시작하기**
   - 앱 이름 `Mail`, 이메일 칸에는 내 이메일
   - 대상: **외부**
   - 왼쪽 **대상** 메뉴 → **테스트 사용자**에 로그인할 Gmail 주소 추가
4. [권한 추가](https://console.cloud.google.com/auth/scopes) → **범위 추가 또는 삭제** → 아래 5줄을 붙여넣어 추가 → 저장
   ```
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/calendar
   https://www.googleapis.com/auth/drive
   https://www.googleapis.com/auth/contacts.readonly
   https://www.googleapis.com/auth/contacts.other.readonly
   ```
5. [클라이언트 만들기](https://console.cloud.google.com/auth/clients) → **클라이언트 만들기**
   - 애플리케이션 유형: **웹 애플리케이션**
   - 승인된 리디렉션 URI에 추가: `http://localhost:8787/auth/callback`
   - 만들기 → 화면에 나온 **클라이언트 ID**와 **클라이언트 보안 비밀번호**가 설치 때 넣을 2개
   - 보안 비밀번호는 다른 사람에게 보내지 않기

## 자주 쓰는 명령

PowerShell이나 터미널에 붙여넣기.

| 하고 싶은 일 | 명령 |
|---|---|
| Google 키 바꾸기 | `bunx @sj00c/mail config` |
| 문제 확인 | `bunx @sj00c/mail doctor` |
| 껐다 켜기 | `bunx @sj00c/mail restart` |
| 끄기 (다음 컴퓨터 로그인 때 다시 켜짐) | `bunx @sj00c/mail stop` |
| 켜기 | `bunx @sj00c/mail start` |
| 지금 상태 | `bunx @sj00c/mail status` |
| 자동 실행 해제 | `bunx @sj00c/mail uninstall` |

- `bunx` 를 찾을 수 없다고 나오면: 창을 닫고 새로 열기

## 문제가 생기면

먼저 `bunx @sj00c/mail doctor` 실행. 무엇이 문제이고 어떻게 고치는지 알려 줌. 물어볼 때는 그 결과를 그대로 보내기 (키 값은 표시되지 않음).

| 화면에 나온 말 | 할 일 |
|---|---|
| `credentials are still needed` | `bunx @sj00c/mail config` 로 키 입력 → 설치 명령 다시 실행 |
| `invalid_client` | 키를 잘못 넣음 → `bunx @sj00c/mail config` 로 다시 입력 |
| `access_denied` | [테스트 사용자](#google-setup)에 그 Gmail 주소 추가 |
| `redirect_uri_mismatch` | 리디렉션 URI가 정확히 `http://localhost:8787/auth/callback` 인지 확인 |
| `has not been used in project` | 그 API를 **사용** 으로 켜기 (2단계) |
| `0x80070005` | PowerShell을 **관리자 권한으로 실행** 후 설치 명령 다시 |
| `Port 8787 is occupied` | 8787번을 쓰는 다른 프로그램이 있음 → 아래 [포트 바꾸기](#port) |
| 계속 다시 로그인하라고 함 | 테스트 사용자 등록 확인. 7일마다 한 번은 정상 |

## 그 밖에

<a id="migrate-zip"></a>

- **예전 버전에서 넘어오기**: 설치 명령만 실행하면 키·로그인을 자동으로 옮김
  - 예전 폴더는 그대로 둠 → 새 버전이 잘 되면 직접 삭제
  - 자동 실행이 꺼져 있던 예전 설치는 위치를 알려 주기: 설치 명령 끝에 `--from <예전 폴더>`
- **설치 명령에 옵션 붙이기**
  - Windows: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.ps1))) <옵션>`
  - macOS: `curl -fsSL https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.sh | bash -s -- <옵션>`
  - `--from <폴더>` 예전 설치 위치 / `--dir <폴더>` 설치 위치 지정 / `--no-autostart` 자동 실행 없이
- **자동 실행 없이 쓰기** (회사 PC 등): `--no-autostart` 로 설치 → 쓸 때마다 `bunx @sj00c/mail run` (창을 닫으면 꺼짐)
- **Linux**: macOS 명령으로 설치 → `bunx @sj00c/mail run` (자동 실행 없음)

<a id="port"></a>

- **포트 바꾸기** (8787을 다른 프로그램이 쓸 때)
  - `bunx @sj00c/mail config` 끝에 나오는 설정 파일 열기
  - `PORT=8788`, `OAUTH_REDIRECT=http://localhost:8788/auth/callback` 으로 수정
  - Google 클라이언트의 리디렉션 URI에도 `http://localhost:8788/auth/callback` 추가
  - `bunx @sj00c/mail restart`

<a id="logs"></a>

- **기록 파일 위치**: `bunx @sj00c/mail doctor` 맨 아래 줄. 공유할 때는 키·토큰이 없는지 확인

## 기능

- 메일: 편지함·라벨·대화 보기, 검색, 읽음·보관·별표·휴지통, 여러 개 한꺼번에 처리
- 쓰기: 답장·전체답장·전달, 서식·서명, 첨부 (25MB 넘으면 Drive 링크), 보내기 취소
- 캘린더: 월·목록 보기, 일정 만들기·수정·삭제, 참석자·알림·Meet
- Drive: 폴더·검색, 올리기·내려받기, 새 폴더·이름 바꾸기·휴지통
- 그 밖에: 새 메일 알림, 다크 테마, 메일·일정·Drive 통합 검색

<a id="reply-forward"></a>
<a id="bulk-cleanup"></a>

- 전체 선택 후 정리: 화면에 안 보이는 메일까지 처리, 확인창에 개수 표시, 영구 삭제 없음 (휴지통으로)
- 전달: 대화 전체를 메일별 정보·첨부와 함께 전달

## 데이터·보안

- 메일은 Google과 내 컴퓨터 사이에서만 오감. 이 앱은 다른 서버로 보내지 않음
- 내 컴퓨터에서만 접속 가능 (다른 기기·인터넷에서 접속 불가)
- 키와 로그인 정보는 내 사용자 폴더에만 저장. 다른 사람에게 보내지 않기
- 로그아웃하면 로그인 정보 삭제
- 메일을 영구 삭제하지 않음, 연락처는 읽기만 함
- 메일 속 외부 이미지는 보낸 쪽 서버에서 불러올 수 있음

## 개발자용

- 빌드: `bun install --frozen-lockfile` → `bun run build`
- 개발 서버: `bun run dev` (웹 `5173`, API `8787`), 설정 예시 [`.env.example`](.env.example)
- 패키지 검증: `npm pack` → `bun run check:package` → `node scripts/package-smoke.mjs <tgz>`
  - smoke 검사는 Mail 자동 실행이 설치된 PC에서는 실행 거부
  - `SJ_MAIL_PACKAGE_SPEC=file:<tgz>`: 설치가 레지스트리 대신 이 파일을 씀
- 키를 앱에 넣어 배포하기 (선택, 사용자가 키를 받을 필요 없어짐)
  - Google Cloud에서 **데스크톱 앱** 유형 클라이언트 생성
  - 저장소 `.env` 또는 GitHub 저장소 secret에 `BUNDLED_GOOGLE_CLIENT_ID`, `BUNDLED_GOOGLE_CLIENT_SECRET`
  - 패키지에 `dist/oauth-client.json` 으로 들어가고, 설치가 사용자 설정에 채움 (사용자가 넣은 키가 우선)
  - 사용자는 그 프로젝트의 테스트 사용자로 등록 (최대 100명) 또는 Google 앱 검증
- 배포: GitHub Release → `.github/workflows/release.yml` 이 npm에 게시 (npmjs.com trusted publisher 설정 필요)

## 라이선스

- MIT — [LICENSE](LICENSE)
- 포함된 React·Vite 런타임 고지: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)
