# Gmail OAuth 셋업 가이드 (재사용용)

이 프로젝트(로컬 Gmail 클라이언트)를 새 머신/새 계정에서 다시 띄울 때 따라 하면 되는
**검증된 순서**. 실제로 한 번 헤맨 지점(★ 함정)들을 그대로 박제해둠.

---

## 0. 큰 그림 — "API 키" 아님

Gmail API는 사용자 인증이 필요해서 **API 키가 아니라 OAuth 2.0 클라이언트(ID + Secret)** 를 쓴다.
콘솔에서 "API 키 만들기" 메뉴는 무시해도 된다. 우리가 만드는 건 **OAuth client ID**.

흐름: `Gmail API 활성화 → OAuth 동의 화면 → OAuth client ID(Web) 생성 → .env 작성 → bun run dev → 브라우저 로그인`

---

## 1. API 활성화 (Gmail + Calendar)

- Google Cloud Console → **APIs & Services → Library**
- "Gmail API" 검색 → **Enable**
- "Google Calendar API" 검색 → **Enable** (캘린더 탭용. CalDAV API 아님!)
- ★ 둘 다 먼저 안 켜면 클라이언트 만들어도 호출이 막힌다.
  - 캘린더가 `403 ... Calendar API has not been used in project` 뜨면 이 단계 누락한 것.

## 2. OAuth 동의 화면 (OAuth consent screen / 새 UI는 "Audience")

- APIs & Services → **OAuth consent screen**
- User Type: **External** → Create
- 앱 이름 / 지원 이메일 등 필수값만 입력
- **Test users → + ADD USERS** 에 로그인할 본인 Gmail 주소 추가
  - ★ 함정: 이거 안 하면 로그인 시 `403 access_denied` (앱이 Testing 상태라 등록 테스터만 허용)
  - ★ 주소 오타 나면 똑같이 막힘. 정확히 입력.
- 앱은 "Testing" 상태로 그냥 둔다 (개인용이라 게시/검수 불필요)
  - 참고: Testing 상태는 refresh token이 7일마다 만료될 수 있음 → 만료되면 다시 로그인

## 3. OAuth client ID 생성

- APIs & Services → **Credentials → Create Credentials → OAuth client ID**
- Application type: **Web application** ← ★ 반드시 이거
  - ★ 함정: Desktop / TV 등 다른 타입으로 만들면 **Authorized redirect URIs 입력칸이 아예 안 나오고**
    이름만 수정 가능한 화면이 뜬다. 타입은 생성 후 변경 불가 → 잘못 만들었으면 새로 생성.
- **Authorized redirect URIs → + ADD URI** 에 정확히:
  ```
  http://localhost:8787/auth/callback
  ```
  - ★ `https` 아님 `http`
  - ★ 끝에 슬래시 `/` 붙이지 말 것
  - ★ "Authorized JavaScript origins"가 아니라 "Authorized **redirect URIs**" 칸
- **Create** → 뜨는 팝업/다운로드 JSON에서 **Client ID** 와 **Client secret** 복사

## 4. .env 작성

```sh
cp .env.example .env
```

`.env` 를 채운다:
```
GOOGLE_CLIENT_ID=<클라이언트ID>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<시크릿>
OAUTH_REDIRECT=http://localhost:8787/auth/callback
PORT=8787
```

- ★ 함정: 값에 **따옴표 붙이지 말 것.** `GOOGLE_CLIENT_SECRET="GOCSPX-..."` 처럼 쓰면
  따옴표까지 값으로 들어가서 인증 실패. 따옴표 없이 raw 값만.
  - 정상 시크릿은 `GOCSPX-` 로 시작하고 35자.
- ★ `OAUTH_REDIRECT` 의 포트(`8787`)는 `PORT` 및 콘솔 redirect URI와 **세 군데가 글자 하나까지 동일**해야 함.
  안 맞으면 `redirect_uri_mismatch`.

빠르게 검증 (시크릿 노출 없이):
```sh
awk -F= '/^GOOGLE_CLIENT_SECRET=/{v=$2; \
  print "starts_GOCSPX:", (v ~ /^GOCSPX-/ ? "yes" : "NO"); \
  print "len:", length(v); \
  print "has_quote:", (v ~ /["\x27]/ ? "YES(문제)" : "no")}' .env
```

## 5. 실행 & 로그인

```sh
bun install     # 최초 1회
bun run dev     # Vite(5173) + API(8787) 핫리로드
```

- 브라우저 http://localhost:5173 → **"Gmail 연결하기"**
- 동의 화면에서 본인 계정 선택 → 권한 허용
  - "앱이 확인되지 않았습니다" 경고 → **고급 → (안전하지 않음) 이동** (본인 앱이라 정상)
- 콜백 후 받은편지함 뜨면 성공. 토큰은 `server/.data/token.json` 에 로컬 저장(gitignore).

서버만으로 상태 확인:
```sh
curl -s localhost:8787/auth/status          # {"authed":true} 면 성공
curl -s localhost:8787/api/profile          # 내 이메일
```

---

## 트러블슈팅 빠른표

| 증상 | 원인 | 해결 |
|---|---|---|
| redirect URI 입력칸이 안 보임 | 클라이언트 타입이 Web이 아님 | Web application으로 새로 생성 |
| `403 access_denied` | Test users 미등록 | 동의화면 Test users에 본인 주소 추가 |
| `redirect_uri_mismatch` | 콘솔/.env/PORT 불일치 | 세 군데 `http://localhost:8787/auth/callback` 통일 |
| 인증은 되는데 토큰 교환 실패 | .env 시크릿에 따옴표/공백 | 따옴표 제거, raw 값만 |
| 7일 후 갑자기 로그인 풀림 | Testing 앱 refresh token 만료 | "Gmail 연결하기" 다시 클릭 |

## 권한 범위(scope)

- `gmail.modify` — 읽기/발송/라벨/읽음표시/보관/휴지통 가능, **영구 삭제 불가**(안전장치).
- `calendar.readonly` — 캘린더/일정 **조회 전용**. (생성·수정하려면 `calendar`로 올리고 재로그인)
- scope를 바꾸면 기존 토큰엔 새 권한이 없으므로 **로그아웃 후 다시 로그인** 필요.
