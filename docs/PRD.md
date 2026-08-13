# PRD — mail-ui 점검 및 업데이트 (2026-07-10)

전체 레포 점검 결과: 현재 기능 인벤토리, 이번 업데이트로 반영된 수정사항, 확인된 데이터 이슈, 최적화 백로그.

## 1. 제품 개요

로컬 개인용 Gmail/Calendar/Drive 클라이언트.

- 서버: Bun + Hono (`server/`), Google API 프록시. `127.0.0.1:8787` 전용(LAN 노출 opt-in).
- 웹: React 18 + Vite SPA (`web/`). 프로덕션에서는 서버가 `dist/`를 직접 서빙.
- 배포: launchd(macOS) / Task Scheduler(Windows) 스크립트 (`deploy/`).

### 현재 기능 인벤토리

| 영역 | 기능 |
|---|---|
| 메일 | 목록(라벨/검색/페이지네이션), 스레드 보기, 새 메일·답장·전달·전체전달, 서명, 임시보관함 저장/재개, 첨부(인라인 cid 포함, 대용량은 Drive 공유링크), 일괄 읽음/별표/보관/삭제(shift-클릭 범위선택), 60초 폴링 + 데스크톱 알림 |
| 캘린더 | 월/목록 뷰, 다중 캘린더(색·표시 토글), 일정 CRUD(종일↔시간 전환), 반복일정 인스턴스 확장, 일정 검색 |
| 드라이브 | 탐색/브레드크럼, 검색, 업로드/다운로드, 폴더 생성, 이름변경/휴지통, 용량 표시 |
| 통합검색 | 일정 + 메일 + 드라이브 3컬럼 동시 검색 |
| 연락처 | 받는사람 자동완성 (주소록 + 자주 주고받은 주소 병합) |
| 인증 | OAuth2 (state CSRF 방어, 토큰 원자적 저장, 강제 리프레시 재시도) |

## 2. 이번 업데이트 반영 (수정 완료 + 검증)

### 2.1 [P0] 일정 편집기 종료시간 입력 잘림 — "시간 등록이 안됨"

- **증상**: 새 일정/수정 다이얼로그에서 종료 `datetime-local` 입력이 다이얼로그 오른쪽 밖으로 밀려나 시간 피커 아이콘이 잘려 클릭 불가.
- **원인**: `.ev-times`가 flex row인데 flex 아이템 기본값 `min-width: auto` 때문에 ko-KR 로케일 datetime-local의 고유 최소폭(~216px)이 축소를 거부 → 행이 460px 다이얼로그를 21px 초과(overflow) — 측정값 `end.right=971 > dialog.right=950`.
- **수정**: `web/src/styles.css` — `.ev-times .ev-input { min-width: 0 }`.
- **검증**: 수정 후 입력 우측단 707/930 ≤ 950 (다이얼로그 내부), 피커 아이콘 표시 확인. 백엔드 파이프라인은 원래 정상 — UI에서 13:30–14:45 일정 생성 → Google에 `dateTime` 정확 저장 E2E 확인(테스트 일정 삭제 완료).

### 2.2 [P1] 마우스 스크롤 동적 로딩 부재 (메일·캘린더)

기존에는 스크롤 기반 로딩이 전혀 없었음("더 보기" 버튼만 존재). 구현 내역:

- **메일 목록**: 스크롤이 바닥 300px 앞에 오면 다음 페이지 자동 로드(`MoreSentinel`, IntersectionObserver — root를 실제 스크롤 컨테이너로 잡아 조상 overflow 클리핑에 의한 rootMargin 무력화 방지). "더 보기" 버튼은 폴백으로 유지. 기존 중복제거·시퀀스 가드(`loadSeq`) 로직 그대로 활용.
- **통합검색 메일 컬럼**: 동일 센티널 적용.
- **캘린더 월 뷰(과거 2.2 동작, 현행 2.7에서 제거)**: 당시에는 휠/트랙패드로 월을 이동했으나, 모든 일정을 직접 표시하는 현행 화면에서는 휠이 긴 월 그리드를 스크롤한다. 월 이동은 이전·다음·오늘 버튼을 사용한다.
- **캘린더 목록(agenda) 뷰**: 바닥 도달 시 조회 범위 자동 확장 7→30→90→365일.
- **당시 검증 기록**: 2.2 릴리스에서는 메일 목록 자동 추가, 월 뷰 휠 이동, agenda 조회 범위 확장을 브라우저로 검증했다. 현행 월 뷰 검증은 2.7의 직접 일정 표시·패널 스크롤·버튼 월 이동 기준을 따른다.

### 2.3 [해결 완료] "seokjuCho" 유니코드 오류 — 앱 버그 아님 (Google 측 원본 데이터를 수정)

- **진단**: 기본 캘린더(`kaja974546@gmail.com`)의 summary가 Google API 응답에서 문자 그대로 **`seokjuCH\ho`** (백슬래시 포함). 앱은 인코딩 변형 없이 받은 그대로 표시 중 — 서버는 JSON pass-through, UI는 React 텍스트 렌더링이라 어느 단계에서도 이스케이프 오염 없음.
- **조치**: Calendar API `calendars.patch`로 원본 이름을 `seokjuCho`로 직접 수정 완료(2026-07-10). 주의: `primary` 별칭으로는 PATCH가 404 — 명시적 calendarId를 써야 한다. Gmail sendAs displayName은 빈 값이라 보내는 메일에는 영향 없음(확인함).

### 2.4 [P1] 날짜 클릭 시 시간 입력이 보이지 않음

- **증상**: 월 뷰에서 날짜 칸을 클릭하면 "종일" 체크 상태로 열려 날짜 입력만 보임 — 시간 설정 UI가 없는 것으로 체감됨.
- **수정**: 날짜 클릭 시 해당 날짜 09:00–10:00 시간 일정이 기본으로 열리게 변경 (`createOnDay`). 종일은 체크박스로 전환 가능(기존 유지).
- **검증**: 날짜 클릭 → 종일 해제 + datetime 입력 09:00/10:00 표시 브라우저 E2E 확인.

## 2.5 기능 추가 릴리스 (2026-07-10 2차) — 전부 실계정 E2E 검증 완료

| 기능 | 구현 | 검증 |
|---|---|---|
| 일정 알림·참석자·Meet | `EventInput`에 `attendees`/`reminder`/`createMeet`; `events.insert/patch`에 `conferenceDataVersion=1`·`sendUpdates=all`; 편집기에 참석자 칩 입력(연락처 자동완성 공유)·알림 select·Meet 체크박스 | 생성: Meet 링크·참석자·30분 알림 확인, 수정: Meet 유지 + 알림 없음 전환 확인 |
| 서식(HTML) 서명 편집기 | 설정 모달의 textarea → `RichEditor`. HTML이 원본, text/plain은 `htmlToText` 파생. Gmail 가져오기 유지 | 서식 서명 저장 → 새 메일에 프리필 → 발송 메일 HTML/plain 양쪽에 서명 포함 확인 |
| 기본 글꼴 (작성·발송) | 설정에서 web-safe 글꼴/크기 선택 → 에디터 표시 + 발송 HTML을 `mail-font-wrap` 인라인 스타일로 래핑(중복 래핑 가드). 수신자에게 그대로 적용 | 발송 후 수신 메일에 `font-family:'Malgun Gothic'…;font-size:16px` 래퍼 확인 |
| 툴바 글꼴/크기 (부분 적용) | `RichEditor` 툴바에 글꼴·크기 select. select 클릭 시 selection 저장→복원 후 `execCommand(fontName/fontSize)` — 메일 클라이언트 호환 `<font face/size>` 마크업 | 선택 영역에 `<font face="Georgia…" size="5">` 생성 확인 |
| 보내기 취소 (undo send) | 발송을 설정 가능한 지연 큐(기본 5초, 0=끄기)에 넣고 토스트로 실행취소/지금 보내기 제공. 취소 시 작성창을 첨부 포함 원상 복원, 드래프트 정리는 실제 발송 시점 | 취소→작성창 복원(수신자·본문·폰트 래퍼), 재발송→지금 보내기→SENT 확인 |
| 첨부 → Drive 저장 | `POST /api/messages/:id/attachments/:aid/drive` (서버에서 Gmail→Drive 직행, 브라우저 왕복 없음). 첨부 칩에 ☁️ 버튼 | 242KB pkpass 업로드 → webViewLink 확인 (테스트 파일 휴지통 처리) |
| 메일 → 일정 만들기 | Reader 액션에 📅 일정 버튼 → 제목/보낸사람/스니펫 프리필된 일정 편집기 (캘린더 목록 lazy 로드) | 버튼 클릭 → 편집기 프리필 + 참석자/알림/Meet 필드 렌더 확인 |

**이번에 안 한 것 (명시적 보류)**: Google Tasks 패널 — `tasks` 스코프 추가로 재로그인(사용자 OAuth 동의)이 필요해 이 세션에서 검증 불가. 서명의 Gmail 쪽 역동기화(`sendAs.patch`)도 동일하게 `gmail.settings.basic` 스코프 필요 — 앱 내 서명은 로컬 저장으로 완결.

## 2.6 Gmail 대화·일괄처리 정비 (2026-07-13)

| 문제 | 해결 | 검증 |
|---|---|---|
| 대화의 최신 메일마다 과거 인용이 반복되어 상위 메일 아래에 하위 메일이 전부 붙어 보임 | 대화 뷰와 답장/단일 전달은 각 메시지의 직접 작성 본문만 추출. 인용만 있는 실제 전달 메일은 원문 fallback으로 내용 유실 방지 | 실계정 2개 메일 스레드에서 카드 2개·중복 인용 제거 확인 |
| 전체 전달이 하나의 큰 본문과 `---` 수준의 경계로 합쳐짐 | `forwardThread`를 단일 전달과 분리하고, 보낸사람·날짜·제목·받는사람을 가진 독립 `<section>` 카드로 구성 | 작성창에서 카드 2개, 제목 2개, 단일 전달 wrapper 0개, `---` separator 0개 확인 |
| 서로 다른 원본 메일의 inline image CID 충돌 가능 | 전체 전달 시 메시지별 UUID CID namespace 생성, HTML `cid:`와 MIME Content-ID를 함께 rewrite | 코드 경로/typecheck/build 검증 |
| send-as 별칭에서 보낸 메일의 답장이 본인에게 향할 수 있음 | 기본 주소 + 모든 verified send-as 주소를 own-address set으로 사용, Reply/Reply-all에서 본인 주소 전부 제외 | 타입·브라우저 회귀 확인 |
| 읽음/안읽음이 굵기 차이로만 표현됨 | 목록 pill + 대화 카드 텍스트 상태(`읽음`/`안읽음`) 추가 | 브라우저에서 읽음 20/안읽음 5 상태 렌더 확인 |
| 전체 선택이 현재 로드된 25개에만 적용됨 | `전체메일` 가상 뷰 + Gmail식 2단계 전체 선택. Prepare 단계가 전 페이지 ID를 먼저 고정·중복 제거하고 정확한 개수로 확인한 뒤 Confirm에서만 실행 | 실계정 전용 검색으로 2개 prepare→unread→trash, matched/succeeded=2·failed=0 확인 |
| 대량 휴지통 이동의 영구삭제/쿼터 위험 | `batchDelete` 금지, recoverable `messages.trash`만 10개 동시 실행. 읽음은 1000개 단위 batchModify. 작업은 계정·5분 TTL에 바인딩하고 1회 소비, 성공/실패 개수 반환 | API E2E + 작업 후 검색 결과 0건 확인 |

### Gmail 사용자 불편 조사 → 후보

공식 문서와 2026년 Gmail 사용자 커뮤니티에서 반복되는 불편을 제품 후보로 정리했다.

1. **긴 대화의 순서/맥락 파악** — 최신 메일이 아래에 있고 과거 인용이 중첩되어 답장 대상과 현재 내용을 찾기 어려움. 이번 릴리스에서 직접 본문 카드화까지 해결; 남은 후보는 대화 타임라인/메시지 접기.
2. **검색 결과의 정확성 불신** — Gmail은 메시지에 라벨을 붙이지만 대화 단위 결과를 보여, `-label:` 같은 제외 검색도 같은 스레드의 다른 메시지 때문에 다시 나타날 수 있음. 후보: 검색 결과에 “왜 매칭됐는지”와 실제 매칭 메시지 표시.
3. **스레드 전체 첨부 모아보기 부재** — 오래된 대화에서 첨부가 어느 답장에 있는지 찾기 어려움. 후보: 대화 상단의 첨부 갤러리 + 파일명/종류 필터 + 일괄 Drive 저장.
4. **라벨이 많아질수록 탐색 불편** — 모바일 Gmail의 라벨 선택기에 검색이 없어 수백 개 라벨 사용자가 긴 목록을 스크롤. 후보: 라벨 검색·최근 라벨·드래그 적용.
5. **저장공간 정리의 불투명성** — 큰 첨부 메일을 지워도 Drive/Photos 또는 휴지통 때문에 용량이 바로 줄지 않아 혼란. 후보: Gmail/Drive 용량 분해 + `larger:`/`older_than:` 기반 정리 도우미.
6. **모바일/웹 검색 결과 차이** — 동기화·캐시 영향으로 오래된 메일이나 정확 문구를 모바일에서 못 찾았다는 보고. 이 앱은 서버 API 검색 결과와 raw Gmail query를 그대로 표시하되, 향후 `in:anywhere` 토글과 Spam/Trash 포함 여부를 명시.

근거:
- Google Gmail Help — 대화 보기: https://support.google.com/mail/answer/5900
- Google Gmail Help — 검색 연산자와 메시지/대화 차이: https://support.google.com/mail/answer/7190
- Google Gmail Help — 검색 기본값은 Spam/Trash 제외: https://support.google.com/mail/answer/6593
- Gmail Community — 스레드 첨부 전체보기 요구: https://support.google.com/mail/thread/422934286
## 2.7 성능·캘린더·검증 릴리스 (2026-08-05)

- Gmail 목록의 상세 메시지 조회는 multipart batch 요청으로 묶어 브라우저와 Gmail 사이의 외부 HTTP 왕복을 줄인다. 각 하위 Gmail 요청 자체의 비용 또는 쿼터 절감은 주장하지 않는다.
- `web/src/hooks`로 Mailbox 상태 훅을 분리하고 캘린더·드라이브·통합검색 화면은 `React.lazy`로 첫 사용 시 불러온다. 로드 실패 중에도 앱 셸과 메일 탐색은 유지된다.
- 모든 캘린더를 기본 표시하고 사용자가 명시적으로 숨긴 브라우저 상태만 적용한다. 기본 캘린더(`primary: true`)는 목록과 새 일정 선택의 첫 항목이며 새 일정의 기본값이다. 기본 빨강색은 브라우저 로컬 설정이고, 다른 캘린더처럼 숨기거나 다시 보일 수 있다. 색 변경·초기화는 Calendar API를 변경하지 않는다.
- 월 그리드는 4·5·6주와 일정 수에 맞춰 높이가 늘어나며, 일정 칩을 `더보기`로 접지 않고 모두 직접 표시한다. 각 칩은 캘린더 색, 12px 이상의 글자, 27px 이상의 높이를 유지하고 셀에서 잘리지 않는다.
- 검증 기반을 Vitest/jsdom/Testing Library와 Chromium Playwright로 추가했다. 브라우저 fixture는 인증과 API를 모두 모의하며, `dist`를 SPA fallback으로 제공하는 정적 서버에서 해시된 프로덕션 자산을 시험한다. CI는 Google 계정·토큰·실서비스에 연결하지 않고 unit → typecheck → build → e2e 순서로 실행한다.

## 2.8 캘린더 UI/UX 재설계 (2026-08-06)

- 캘린더 화면을 Notion·Linear 계열의 차분한 정보 구조로 재설계했다. 화면 제목·설명, 월/목록 세그먼트, 새 일정, 월 탐색을 명확한 위계로 배치하고 캘린더 필터와 기본 색상 제어를 독립된 사이드바 카드로 정돈했다.
- 월과 목록 보기는 같은 날짜 앵커를 공유한다. 미래 달에서 목록으로 전환하면 그 달부터 시작하고, 목록에서 선택한 날짜는 월로 돌아갈 때 유지된다.
- 모든 일정은 직접 표시한다. 밀집 날짜는 글자를 12px 미만으로 줄이거나 `더보기`·날짜 칸 내부 스크롤을 만들지 않고 해당 주 행과 캘린더 화면을 확장한다.
- 일정 선택은 기존 중앙 상세 모달을 유지하며 dialog 의미, Escape 닫기, Tab 초점 순환, 호출 요소 초점 복귀를 보강했다.
- 1280·1024·768px 반응형 레이아웃, 44px 주요 조작 표적, 명확한 `:focus-visible`, WCAG AA 대비, `prefers-reduced-motion`을 수용 기준으로 삼는다. 새 대형 UI 의존성이나 장식용 애니메이션은 추가하지 않는다.
- 기준 스크린샷은 `docs/screenshots/calendar.png`, `calendar-1024.png`, `calendar-768.png`에 보관한다.

## 3. 최적화 백로그 (우선순위순)

이미 적용돼 있는 것: 응답 gzip(`compress()`), 캘린더 목록 5분 캐시, 프론트 SWR 캐시(`calCache` 30s), 목록 부분 패치(전체 리로드 회피), 요청 시퀀스 가드, `fields` 파라미터로 응답 축소, Gmail 상세 조회 multipart batch.

1. ~~**[P1] 메일 목록 N+1**~~ — 적용됨: 목록 상세 조회는 multipart batch로 외부 HTTP 왕복을 묶는다. Gmail 하위 요청 비용·쿼터가 줄어든다고 가정하지 않는다.
2. **[P1] 라벨 unread 카운트 N+1**: `labels.list` 후 표시 라벨마다 `labels.get`. 동일하게 batch 묶음 대상.
3. **[P2] 메일 목록 windowing**: 무한 스크롤로 DOM이 무한 증식 가능(500행+). 행 높이 고정이라 가상 스크롤 도입 용이.
4. ~~**[P2] `App.tsx` 분할**~~ — 적용됨: 화면 모듈과 `web/src/hooks`의 Mailbox 훅으로 분리하고 캘린더·드라이브·통합검색은 첫 사용 시 lazy 로드한다.
5. **[P3] 캘린더 fan-out**: 캘린더 5개 × 최대 4페이지 `events.list` 병렬 호출. 현 규모에선 문제없음 — 캘린더 수가 늘면 batch 검토.

## 4. 기능 백로그 (제안)

- Google Tasks 패널 (스코프 추가 + 재로그인 1회 필요 — 다음 릴리스 후보 1순위).
- 캘린더 주(week) 뷰.
- 메일 스누즈 / 보내기 예약 (Gmail API 미지원 — 로컬 스케줄러로 자체 구현 필요. launchd 상시 구동이라 가능).
- ~~키보드 단축키~~ — 적용됨: j/k 이전·다음 메일, e 보관, # 휴지통, c 새 메일, / 검색, u·Esc 목록으로 (메일 뷰 한정, 입력 중·모달 오픈 시 무시, j 끝에서 다음 페이지 자동 로드).
- Drive 공유 설정 UI(`permissions.*`) / 버전 히스토리(`revisions.*`) / 파일 이동·복사.
- `server/.data/`의 QA 프로브 스크립트(e2e-*.ts, qa-*.sh)를 `scripts/` 로 승격해 회귀 테스트로 정례화.

## 5. 이번 변경 파일

- `server/calendar.ts` — `EventInput` 확장(attendees/reminder/createMeet), `getEvent` reminder 노출, Meet 생성.
- `server/index.ts` — 첨부→Drive 저장 라우트.
- `web/src/api.ts` — 타입 확장 + `attachmentToDrive`.
- `web/src/styles.css` — `.ev-times min-width` 수정; 툴바 select·서명 에디터·undo 토스트·chip 래퍼 스타일.
- `web/src/App.tsx` — `MoreSentinel`(무한 스크롤); 당시 월 뷰 휠 내비(현행 2.7에서 제거); agenda 자동 확장; 날짜 클릭 기본 시간 일정; 서식 서명 편집기; 기본 글꼴 + 툴바 글꼴; 보내기 취소 큐; 첨부→Drive 버튼; 메일→일정; 일정 편집기 참석자/알림/Meet.
