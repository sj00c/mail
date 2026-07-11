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
- **캘린더 월 뷰**: 휠/트랙패드 스크롤로 이전·다음 달 이동. 누적 임계값(100) + 450ms 쿨다운으로 트랙패드 관성이 여러 달을 한 번에 넘기지 않게 제한.
- **캘린더 목록(agenda) 뷰**: 바닥 도달 시 조회 범위 자동 확장 7→30→90→365일.
- **검증**: 메일 목록 스크롤 시 행 자동 추가(DOM 257→512), 월 뷰 휠 7월→8월→6월 양방향, agenda 30일→90일 자동 확장(61개 날짜 그룹) 브라우저 E2E 확인. `tsc --noEmit` + `vite build` 통과.

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

## 3. 최적화 백로그 (우선순위순)

이미 적용돼 있는 것: 응답 gzip(`compress()`), 캘린더 목록 5분 캐시, 프론트 SWR 캐시(`calCache` 30s), 목록 부분 패치(전체 리로드 회피), 요청 시퀀스 가드, `fields` 파라미터로 응답 축소.

1. **[P1] 메일 목록 N+1**: `messages.list` 후 페이지당 25회 `messages.get`(병렬이지만 26 API 왕복/쿼터). Gmail batch HTTP 엔드포인트(`/batch/gmail/v1`)로 1왕복 묶음 처리 → 목록 로딩 지연·쿼터 소모 감소. 무한 스크롤 도입으로 호출 빈도가 늘어 체감 효과 큼.
2. **[P1] 라벨 unread 카운트 N+1**: `labels.list` 후 표시 라벨마다 `labels.get`. 동일하게 batch 묶음 대상.
3. **[P2] 메일 목록 windowing**: 무한 스크롤로 DOM이 무한 증식 가능(500행+). 행 높이 고정이라 가상 스크롤 도입 용이.
4. **[P2] `App.tsx` 분할**: 단일 파일 4,800줄/161KB. 뷰 단위(mail/calendar/drive/search) 모듈 분리 + `React.lazy` 코드 스플리팅. 현재 번들 222KB(gzip 71KB)로 성능보다 유지보수성 이슈.
5. **[P3] 캘린더 fan-out**: 캘린더 5개 × 최대 4페이지 `events.list` 병렬 호출. 현 규모에선 문제없음 — 캘린더 수가 늘면 batch 검토.

## 4. 기능 백로그 (제안)

- Google Tasks 패널 (스코프 추가 + 재로그인 1회 필요 — 다음 릴리스 후보 1순위).
- 캘린더 주(week) 뷰.
- 메일 스누즈 / 보내기 예약 (Gmail API 미지원 — 로컬 스케줄러로 자체 구현 필요. launchd 상시 구동이라 가능).
- 키보드 단축키 (j/k 탐색, e 보관 등).
- Drive 공유 설정 UI(`permissions.*`) / 버전 히스토리(`revisions.*`) / 파일 이동·복사.
- `server/.data/`의 QA 프로브 스크립트(e2e-*.ts, qa-*.sh)를 `scripts/` 로 승격해 회귀 테스트로 정례화.

## 5. 이번 변경 파일

- `server/calendar.ts` — `EventInput` 확장(attendees/reminder/createMeet), `getEvent` reminder 노출, Meet 생성.
- `server/index.ts` — 첨부→Drive 저장 라우트.
- `web/src/api.ts` — 타입 확장 + `attachmentToDrive`.
- `web/src/styles.css` — `.ev-times min-width` 수정; 툴바 select·서명 에디터·undo 토스트·chip 래퍼 스타일.
- `web/src/App.tsx` — `MoreSentinel`(무한 스크롤); 월 뷰 휠 내비; agenda 자동 확장; 날짜 클릭 기본 시간 일정; 서식 서명 편집기; 기본 글꼴 + 툴바 글꼴; 보내기 취소 큐; 첨부→Drive 버튼; 메일→일정; 일정 편집기 참석자/알림/Meet.
