# Mail

Gmail, Google 캘린더, Google Drive를 한 화면에서 쓰는 앱이에요.
내 컴퓨터 안에서만 돌아가고, 브라우저에서 <http://localhost:8787> 로 열어요.

설치는 두 단계예요.

1. Google에서 **열쇠 2개** 받기 (처음 한 번, 10분 정도)
2. **설치 명령** 한 줄 붙여넣기 (2분 정도)

---

## 1단계. Google에서 열쇠 받기

이 앱이 내 Gmail을 읽고 보내려면 Google이 내주는 열쇠가 필요해요.
열쇠는 **Client ID**와 **Client Secret** 두 개예요. 아래 순서대로 하면 받을 수 있어요.

> 처음 한 번만 하면 돼요. 이미 받아 둔 열쇠가 있으면 2단계로 넘어가세요.

### ① 프로젝트 만들기

1. [여기](https://console.cloud.google.com/projectcreate)를 열어요. (Gmail 계정으로 로그인)
2. 프로젝트 이름은 아무거나 (예: `Mail`) 쓰고 **만들기**를 눌러요.
3. 화면 위쪽에 방금 만든 프로젝트 이름이 보이는지 확인해요. 다른 이름이면 눌러서 바꿔 주세요.

<a id="google-apis"></a>

### ② 기능 켜기

아래 링크를 하나씩 열고, 파란 **사용** 버튼을 눌러요.

- [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com) — 메일
- [Google Calendar API](https://console.cloud.google.com/apis/library/calendar-json.googleapis.com) — 캘린더
- [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) — Drive
- [People API](https://console.cloud.google.com/apis/library/people.googleapis.com) — 받는사람 이름 자동완성 (안 켜도 돼요)

<a id="google-consent"></a>

### ③ 앱 정보 등록

1. [여기](https://console.cloud.google.com/auth/overview)를 열고 **시작하기**를 눌러요.
2. 순서대로 채워요.
   - 앱 이름: `Mail`
   - 사용자 지원 이메일: 내 이메일
   - 대상: **외부**
   - 연락처 이메일: 내 이메일
   - 약관 동의 체크 → **만들기**
3. 왼쪽 메뉴 **대상** → **테스트 사용자** 아래 **+ Add users** → 이 앱으로 로그인할 Gmail 주소를 넣고 **저장**해요.

> 테스트 사용자에 없는 계정은 로그인할 수 없어요.

### ④ 권한 등록

1. [여기](https://console.cloud.google.com/auth/scopes)를 열고 **범위 추가 또는 삭제**를 눌러요.
2. 오른쪽 창 맨 아래 **직접 범위 추가** 칸에 아래 5줄을 통째로 붙여넣어요.

   ```
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/calendar
   https://www.googleapis.com/auth/drive
   https://www.googleapis.com/auth/contacts.readonly
   https://www.googleapis.com/auth/contacts.other.readonly
   ```

3. **테이블에 추가** → **업데이트** → 화면 맨 아래 **저장**을 눌러요.

<a id="google-client"></a>

### ⑤ 열쇠 만들기

1. [여기](https://console.cloud.google.com/auth/clients)를 열고 **+ 클라이언트 만들기**를 눌러요.
2. 애플리케이션 유형은 **웹 애플리케이션**을 골라요.
3. 아래쪽 **승인된 리디렉션 URI**에서 **+ URI 추가**를 누르고 이 주소를 그대로 넣어요.

   ```
   http://localhost:8787/auth/callback
   ```

4. **만들기**를 누르면 **클라이언트 ID**와 **클라이언트 보안 비밀번호**가 나와요.
   이 두 개가 열쇠예요. 바로 메모장 등에 복사해 두세요.

> 보안 비밀번호는 이 창을 닫으면 다시 못 볼 수 있어요. 그때는 같은 화면에서 새로 만들면 돼요.
> 열쇠는 다른 사람에게 보내지 마세요.

---

## 2단계. 설치하기

### Windows

1. 키보드의 **Windows 키**를 누르고 `PowerShell`을 입력한 뒤 **Windows PowerShell**을 열어요.
2. 아래 한 줄을 복사해서 붙여넣고 **Enter**를 눌러요. (붙여넣기는 마우스 오른쪽 클릭)

   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.ps1 | iex"
   ```

### macOS

1. **Command + Space**를 누르고 `터미널`을 입력해 열어요.
2. 아래 한 줄을 복사해서 붙여넣고 **Return**을 눌러요.

   ```sh
   curl -fsSL https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.sh | bash
   ```

### 설치 중에 할 일

설치가 진행되다가 열쇠를 물어봐요.

```
Client ID: 
```

1. 1단계에서 받은 **클라이언트 ID**를 붙여넣고 Enter
2. 이어서 `Client Secret:`이 나오면 **클라이언트 보안 비밀번호**를 붙여넣고 Enter
   - 비밀번호는 화면에 `*****`로만 보여요. 정상이에요.
   - 잘못 넣으면 무엇이 틀렸는지 알려 주고 다시 물어봐요.

열쇠는 자동으로 저장돼요. 파일을 직접 열 필요는 없어요.

### 마지막으로 로그인

1. 설치가 끝나면 브라우저가 열려요. **Gmail 연결하기**를 눌러요.
2. 테스트 사용자로 등록한 Google 계정으로 로그인해요.
3. **Google에서 확인하지 않은 앱**이라는 화면이 나오면 **계속**을 눌러요.
   (버튼이 안 보이면 **고급** → **Mail(으)로 이동**)
4. 권한을 모두 허용하면 끝이에요.

이제 컴퓨터를 켤 때마다 앱이 저절로 실행돼요. 브라우저에서 <http://localhost:8787> 만 열면 돼요.

> Google 규칙상 일주일에 한 번쯤 다시 로그인하라고 할 수 있어요. 고장 난 게 아니에요.

---

## 업데이트

2단계의 설치 명령을 그대로 다시 실행하면 돼요.
열쇠와 로그인은 그대로 남아 있어서 다시 물어보지 않아요.

---

## 필요할 때 쓰는 명령

PowerShell(Windows)이나 터미널(macOS)에 붙여넣어 쓰세요.

| 이럴 때 | 이 명령 |
|---|---|
| 열쇠를 바꾸고 싶어요 | `bunx @sj00c/mail config` |
| 뭔가 이상해요 | `bunx @sj00c/mail doctor` |
| 껐다 켜고 싶어요 | `bunx @sj00c/mail restart` |
| 잠깐 끄고 싶어요 (다음에 컴퓨터 켜면 다시 켜져요) | `bunx @sj00c/mail stop` |
| 다시 켜고 싶어요 | `bunx @sj00c/mail start` |
| 자동 실행을 그만하고 싶어요 | `bunx @sj00c/mail uninstall` |

> `bunx`를 찾을 수 없다고 나오면 창을 닫고 새로 열어서 다시 해 보세요.

---

## 문제가 생겼을 때

먼저 이 명령을 실행해 보세요. 무엇이 문제인지, 어떻게 고치는지 알려 줘요.

```sh
bunx @sj00c/mail doctor
```

누군가에게 도움을 요청할 때는 이 결과를 그대로 보내 주세요. 열쇠 값은 결과에 나오지 않아요.

자주 나오는 문제:

| 이런 말이 보이면 | 이렇게 하세요 |
|---|---|
| `credentials are still needed` | 열쇠를 아직 안 넣었어요. `bunx @sj00c/mail config`로 넣은 뒤 설치 명령을 다시 실행해요. |
| `invalid_client` | 열쇠가 틀렸어요. `bunx @sj00c/mail config`로 다시 넣어요. |
| `access_denied` | 로그인한 계정이 테스트 사용자에 없어요. [1단계 ③](#google-consent)에서 추가해요. |
| `redirect_uri_mismatch` | [1단계 ⑤](#google-client)의 주소가 `http://localhost:8787/auth/callback`과 똑같은지 확인해요. |
| `has not been used in project` | 기능이 꺼져 있어요. [1단계 ②](#google-apis)에서 **사용**을 눌러요. |
| `0x80070005` | PowerShell을 마우스 오른쪽 클릭 → **관리자 권한으로 실행**한 뒤 설치 명령을 다시 실행해요. |
| `Port 8787 is occupied` | 다른 프로그램이 같은 자리를 쓰고 있어요. 아래 [포트 바꾸기](#port)를 보세요. |

---

## 더 알아보기

### 예전 버전을 쓰고 있었다면

설치 명령만 실행하세요. 열쇠와 로그인을 새 버전으로 알아서 옮겨요.
예전 폴더는 지우지 않으니, 새 버전이 잘 되는 걸 확인한 뒤 직접 지우면 돼요.

예전 버전이 꺼져 있었다면 예전 폴더 위치를 알려 줘야 해요. 설치 명령 대신 아래를 쓰세요.

- Windows: `& ([scriptblock]::Create((irm https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.ps1))) --from "예전 폴더"`
- macOS: `curl -fsSL https://raw.githubusercontent.com/sj00c/mail/main/deploy/bootstrap.sh | bash -s -- --from "예전 폴더"`

### 자동 실행 없이 쓰고 싶다면

회사 컴퓨터처럼 자동 실행이 막힌 경우예요. 위 명령에서 `--from "예전 폴더"` 대신 `--no-autostart`를 붙여 설치하세요.
쓸 때마다 `bunx @sj00c/mail run`을 실행하면 돼요. (그 창을 닫으면 앱도 꺼져요)

Linux도 이 방법으로 쓸 수 있어요. (macOS 설치 명령 사용)

<a id="port"></a>

### 포트 바꾸기

8787번을 다른 프로그램이 이미 쓰고 있을 때만 필요해요.

1. `bunx @sj00c/mail config`를 실행하고 Enter를 두 번 누르면 마지막 줄에 설정 파일 위치가 나와요.
2. 그 파일을 메모장으로 열어 `8787`을 모두 `8788`로 바꾸고 저장해요.
3. [1단계 ⑤](#google-client) 화면에서 리디렉션 URI에 `http://localhost:8788/auth/callback`도 추가해요.
4. `bunx @sj00c/mail restart`를 실행하고, 이제부터 <http://localhost:8788> 로 열어요.

### 내 정보는 안전한가요?

- 메일은 내 컴퓨터와 Google 사이에서만 오가요. 다른 곳으로 보내지 않아요.
- 내 컴퓨터에서만 열 수 있어요. 같은 와이파이의 다른 기기에서도 못 열어요.
- 열쇠와 로그인 정보는 내 컴퓨터 사용자 폴더에만 저장돼요.
- 메일을 완전히 지우지 않아요. 삭제하면 Gmail 휴지통으로 가요.
- 연락처는 읽기만 해요.
- 메일 속 사진은 보낸 사람 쪽 서버에서 불러올 수 있어요. (일반 메일 앱과 같아요)

### 할 수 있는 것

- **메일:** 받은편지함·라벨·대화 보기, 검색, 읽음·보관·별표·삭제, 여러 개 한꺼번에 정리
- **메일 쓰기:** 답장·전체답장·전달, 글꼴·서명, 파일 첨부 (25MB가 넘으면 Drive 링크로), 보내기 취소
- **캘린더:** 월·목록 보기, 일정 만들기·고치기·지우기, 참석자·알림·Meet
- **Drive:** 폴더 보기·검색, 올리기·내려받기, 새 폴더·이름 바꾸기·삭제
- **그 밖에:** 새 메일 알림, 어두운 화면, 메일·일정·Drive 한 번에 검색

---

## 개발자용

- 빌드: `bun install --frozen-lockfile` → `bun run build`
- 개발 서버: `bun run dev` (웹 `5173`, API `8787`), 설정 예시는 [`.env.example`](.env.example)
- 패키지 검증: `npm pack` → `bun run check:package` → `node scripts/package-smoke.mjs <tgz>`
  - smoke 검사는 Mail 자동 실행이 설치된 PC에서는 실행을 거부해요.
  - `SJ_MAIL_PACKAGE_SPEC=file:<tgz>`를 주면 설치가 npm 대신 그 파일을 써요.
- 열쇠를 앱에 넣어 배포하기 (선택, 사용자가 1단계를 건너뜀)
  - Google Cloud에서 **데스크톱 앱** 유형 클라이언트를 만들어요.
  - 저장소 `.env` 또는 GitHub 저장소 secret에 `BUNDLED_GOOGLE_CLIENT_ID`, `BUNDLED_GOOGLE_CLIENT_SECRET`을 넣어요.
  - 패키지에 `dist/oauth-client.json`으로 들어가고, 설치할 때 사용자 설정에 채워져요. 사용자가 직접 넣은 열쇠가 우선이에요.
  - 사용자는 그 프로젝트의 테스트 사용자로 등록해야 해요 (최대 100명). 그 이상은 Google 앱 검증이 필요해요.
- 배포: GitHub Release를 만들면 `.github/workflows/release.yml`이 npm에 올려요. (npmjs.com trusted publisher 설정 필요)

## 라이선스

- MIT — [LICENSE](LICENSE)
- 포함된 React·Vite 런타임 고지: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES)
