# 설치 & OAuth 셋업 가이드 (클론한 사람이 처음부터 따라하면 됨)

이 레포를 클론한 **각자**가 **자기 Google 계정 / 자기 Google Cloud 프로젝트**로 셋업해서
**자기 머신에서** 띄워 쓴다. 함정(★)은 실제로 한 번씩 헤맨 지점이라 그대로 박제해둠.

> **공유되는 건 코드뿐이다.** Client ID/Secret/토큰은 사람마다 다르고, `.env` 와
> `server/.data/token.json` 은 `.gitignore` 처리되어 **레포에 올라가지 않는다.**
> 클론해도 인증 정보는 안 따라오니, 아래대로 본인 것을 새로 만들어야 한다.
>
> *Google Cloud Console은 한국어 UI 기준으로 적었다. 영어 UI면 괄호 안 영문을 보면 된다.*

---

## 0줄 요약 (5분)

1. `git clone … && cd mail && bun install`
2. Google Cloud Console에서 **새 프로젝트** 생성
3. **Gmail API + Google Calendar API** 둘 다 **사용**(Enable)
4. **OAuth 동의 화면**: 외부(External) + **테스트 사용자에 본인 Gmail 추가**
5. **OAuth 클라이언트 ID**(웹 애플리케이션) 생성 + 리디렉션 URI `http://localhost:8787/auth/callback`
6. `cp .env.example .env` → Client ID/Secret 채우기 (따옴표 X)
7. `bun run dev` → http://localhost:5173 → "Gmail 연결하기"

막히면 맨 아래 [트러블슈팅 표](#트러블슈팅-빠른표) 참고.

---

## 0. 클론 & 설치

```sh
git clone <이 레포 URL>
cd mail
bun install
```

- [Bun](https://bun.sh) 필요 (`curl -fsSL https://bun.sh/install | bash`).
- 아직 실행하지 말고 먼저 아래 OAuth부터 만든다 (`.env` 없으면 로그인 안 됨).

---

## 1. "API 키" 아님 — OAuth 2.0 클라이언트를 만든다

Gmail/Calendar API는 사용자 인증이 필요해서 **API 키가 아니라 OAuth 2.0 클라이언트(ID + Secret)** 를 쓴다.
콘솔의 "API 키 만들기"는 무시. 우리가 만드는 건 **OAuth 클라이언트 ID(웹 애플리케이션)** 다.

흐름: `프로젝트 생성 → API 2개 사용 → OAuth 동의 화면 → OAuth 클라이언트 ID(웹) → .env → 실행 → 로그인`

> 사내 보안망 때문에 `console.cloud.google.com` 이 막혔다면, 망 밖 기기(폰 핫스팟 등)에서
> 클라이언트만 만들어 **Client ID/Secret 두 값만** 가져와도 된다.

---

## 2. 프로젝트 생성 + API 사용 설정 (Gmail + Calendar)

1. https://console.cloud.google.com → 상단 프로젝트 선택 → **새 프로젝트**(New Project) (이름 아무거나)
2. **API 및 서비스**(APIs & Services) → **라이브러리**(Library) 에서 각각 검색 후 **사용**(Enable):
   - **Gmail API**
   - **Google Calendar API**  ← 캘린더 탭용. **"CalDAV API" 아님!**
- ★ 둘 다 먼저 안 켜면 클라이언트를 만들어도 호출이 막힌다.
  - 캘린더에서 `403 ... Calendar API has not been used in project` 가 뜨면 이 단계를 빼먹은 것.

---

## 3. OAuth 동의 화면 (OAuth consent screen / 새 UI는 "대상(Audience)")

- **API 및 서비스 → OAuth 동의 화면**
- 사용자 유형(User Type): **외부**(External) → 만들기
- 앱 이름 / 지원 이메일 등 필수값만 입력
- **테스트 사용자**(Test users) → **사용자 추가**(+ ADD USERS) 에 **로그인할 본인 Gmail 주소** 추가
  - ★ 이거 안 하면 로그인 시 `403 access_denied` (앱이 "테스트" 상태라 등록된 사용자만 허용)
  - ★ 주소 오타 나면 똑같이 막힌다. 정확히 입력.
- 앱은 **"테스트"(Testing) 상태로 그냥 둔다** (개인용이라 게시·검수 불필요)
  - 참고: 테스트 상태에선 refresh token이 7일마다 만료될 수 있음 → 만료되면 다시 로그인하면 됨.

---

## 4. OAuth 클라이언트 ID 생성 (+ 리디렉션 URI)

- **API 및 서비스 → 사용자 인증 정보**(Credentials) → **사용자 인증 정보 만들기**(Create Credentials) → **OAuth 클라이언트 ID**
- 애플리케이션 유형(Application type): **웹 애플리케이션**(Web application) ← ★ 반드시 이거
  - ★ 데스크톱/TV 등으로 만들면 **승인된 리디렉션 URI 입력칸이 아예 안 나온다**
    (이름만 수정 가능한 화면이 뜸). 유형은 생성 후 변경 불가 → 잘못 만들었으면 삭제하고 새로 생성.
- **승인된 리디렉션 URI**(Authorized redirect URIs) → **URI 추가**(+ ADD URI) 에 정확히:
  ```
  http://localhost:8787/auth/callback
  ```
  - ★ `https` 아님 **`http`**
  - ★ 끝에 슬래시 `/` 붙이지 말 것
  - ★ "승인된 자바스크립트 원본"(JavaScript origins)이 아니라 "승인된 **리디렉션 URI**" 칸
  - ★ 포트를 바꿀 거면(아래 6번 `PORT`) 여기 URI 포트도 **똑같이** 바꿔야 한다.
- **만들기**(Create) → 뜨는 팝업(또는 다운로드 JSON)에서 **Client ID** 와 **Client secret** 복사

---

## 5. .env 작성

```sh
cp .env.example .env
```

`.env` 를 채운다 (이 파일은 git에 안 올라간다):
```
GOOGLE_CLIENT_ID=<클라이언트ID>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<시크릿>
OAUTH_REDIRECT=http://localhost:8787/auth/callback
PORT=8787
```

- ★ **따옴표 붙이지 말 것.** `GOOGLE_CLIENT_SECRET="GOCSPX-..."` 처럼 쓰면 따옴표까지 값으로
  들어가서 인증 실패. 따옴표 없이 raw 값만. (정상 시크릿은 `GOCSPX-` 로 시작, 35자)
- ★ `OAUTH_REDIRECT` 포트 = `PORT` = 콘솔 리디렉션 URI 포트, **세 군데가 글자 하나까지 동일**해야 함.
  안 맞으면 `redirect_uri_mismatch`.

빠른 검증 (시크릿 노출 없이):
```sh
awk -F= '/^GOOGLE_CLIENT_SECRET=/{v=$2; \
  print "starts_GOCSPX:", (v ~ /^GOCSPX-/ ? "yes" : "NO"); \
  print "len:", length(v); \
  print "has_quote:", (v ~ /["\x27]/ ? "YES(문제)" : "no")}' .env
```

---

## 6. 실행 & 첫 로그인

**개발 모드** (핫리로드):
```sh
bun run dev        # Vite(5173) + API(8787)
```
→ 브라우저 **http://localhost:5173**

**프로덕션 모드** (단일 서버가 SPA까지 서빙):
```sh
bun run build && bun run start
```
→ 브라우저 **http://localhost:8787**

로그인:
1. **"Gmail 연결하기"** 클릭
2. 본인 Google 계정 선택 → 권한 허용
   - "앱이 확인되지 않았습니다" 경고 → **고급 → (안전하지 않음) 이동** (본인이 만든 앱이라 정상)
3. 받은편지함이 뜨면 성공. 토큰은 `server/.data/token.json` 에 **이 머신에만** 저장된다.

서버만으로 상태 확인:
```sh
curl -s localhost:8787/auth/status     # {"authed":true} 면 성공
curl -s localhost:8787/api/profile     # 내 이메일
```

---

## 트러블슈팅 빠른표

| 증상 | 원인 | 해결 |
|---|---|---|
| 리디렉션 URI 입력칸이 안 보임 | 클라이언트 유형이 "웹"이 아님 | 웹 애플리케이션으로 새로 생성 |
| `403 access_denied` | 테스트 사용자 미등록 | 동의 화면 테스트 사용자에 본인 주소 추가 |
| `redirect_uri_mismatch` | 콘솔/.env/PORT 불일치 | 세 군데 `http://localhost:8787/auth/callback` 통일 |
| `Calendar API has not been used` (403) | Calendar API 미사용 설정 | 라이브러리에서 Google Calendar API 사용 |
| 인증은 되는데 토큰 교환 실패 | .env 시크릿에 따옴표/공백 | 따옴표 제거, raw 값만 |
| OAuth 후 빈 페이지/8787로 튕김 | dev인데 8787로 떨어짐 | 정상. dev는 콜백 후 5173으로 자동 복귀 (안 되면 `bun run dev` 재시작) |
| 7일 후 갑자기 로그인 풀림 | 테스트 앱 refresh token 만료 | "Gmail 연결하기" 다시 클릭 |
| 캘린더 권한만 없다고 나옴 | 캘린더 scope 추가 전 토큰 | 로그아웃 후 다시 로그인 (동의 화면에서 캘린더 권한까지 허용) |

---

## 권한 범위(scope)

- `gmail.modify` — 읽기 / 발송(첨부 포함) / 라벨 / 읽음표시 / 보관 / 휴지통. **영구 삭제 불가**(안전장치).
- `calendar.readonly` — 캘린더 / 일정 **조회 전용**. (생성·수정하려면 코드의 scope를 `calendar`로 올리고 재로그인)
- scope를 바꾸면 기존 토큰엔 새 권한이 없으므로 **로그아웃 후 다시 로그인**해야 적용된다.

---

## 포트를 바꾸고 싶다면

`.env` 의 `PORT` 와 `OAUTH_REDIRECT`, 그리고 **콘솔의 승인된 리디렉션 URI** 세 군데를
같은 포트로 맞추면 된다. dev에서 Vite(5173)는 그대로 두고 API 포트만 바뀐다.
