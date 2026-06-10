사용자 직접 지시(승인 완료): 메일을 열었을 때 본문 내부 링크가 안 보이는 버그를 고치고, 프론트/서버 최적화까지 끝까지 해결한다.

공통 제약:
- 레포: ~/dev/mail (Bun + Hono 서버, React + Vite 프론트). dev 서버가 8787(bun --watch) / 5173(vite)으로 떠 있음 — 죽이지 말 것.
- 검증: `bun run typecheck` + `bun run build` + 라이브 서버(localhost:8787, 인증됨) 대상 실측.
- 기존 컨벤션 유지, 과한 추상화 금지.

@goal: 메일 본문 링크 가시성·동작 수정
근거(조사 완료):
(a) plain-text 메일(bodyHtml 없음)은 web/src/App.tsx ThreadMessage가 <pre className="text-body">로 그대로 출력 → URL/이메일 주소가 클릭 불가능한 일반 텍스트로 보임.
(b) HTML 메일은 prepareEmailHtml()이 모든 a[href]에 target="_blank" + <base target="_blank"> 강제 → href="#fragment" 문서 내부 앵커(뉴스레터 목차 등)가 about:srcdoc 새 탭으로 빠져 동작 불능. HtmlBody 클릭 인터셉터는 https?:/mailto:만 처리.
수정:
- plain-text 본문을 URL/메일주소 자동 링크화(linkify)해 새 탭(noopener,noreferrer)으로 열리는 안전한 React 엘리먼트로 렌더 (dangerouslySetInnerHTML 금지).
- prepareEmailHtml: 순수 fragment(#...) 링크에는 target=_blank를 걸지 않음. HtmlBody 클릭 인터셉터에 #fragment 분기 추가 — iframe 문서 내부에서 해당 id/name 요소로 스크롤.
완료 기준: typecheck/build 통과 + 두 케이스(plain-text URL, HTML 내부 앵커) 실제 렌더 동작 검증.

@goal: 서버 API 호출 최적화
근거(조사 완료):
(a) server/gmail.ts listLabels가 labels.list 후 모든 라벨에 labels.get N+1 호출(라벨 20개면 21회) — 사이드바 로드·메일 조작 후 refreshLabels마다 반복. UI가 실제 표시하는 라벨은 SYSTEM_ORDER(INBOX/STARRED/SENT/DRAFT/SPAM/TRASH) + user 라벨뿐인데 CATEGORY_*, CHAT 등 미표시 시스템 라벨까지 전부 unread 카운트를 조회.
(b) server/calendar.ts listEvents가 60초 자동갱신마다 calendarList.list를 매번 호출.
수정:
- listLabels: 표시 대상 라벨(SYSTEM_ORDER 시스템 라벨 + user 라벨)만 labels.get으로 unread 조회, 나머지는 unread 0으로 즉시 반환. fields 파라미터로 응답 슬림화.
- calendar: calendarList.list 결과를 서버 메모리에 짧은 TTL(5분)로 캐시, listEvents/listCalendars가 공유. listCalendars 직접 호출 시(캘린더 뷰 첫 진입) 캐시 갱신.
완료 기준: typecheck 통과 + 라이브 서버에서 /api/labels, /api/calendar/events 응답 정상·동작 동일 확인, 호출 수 감소 근거 제시.

@goal: 프론트 렌더·페치 최적화
근거(조사 완료):
(a) web/src/App.tsx HtmlBody가 렌더마다 prepareEmailHtml(html)을 재실행(DOMParser 풀 파싱) — srcDoc prop이 매 렌더 새로 계산됨.
(b) Reader가 메일 클릭 시 api.message(id) + api.thread(threadId) 두 번 풀 페치 — 스레드 응답에 같은 메시지가 또 포함돼 단일 메시지 스레드(대부분)는 페이로드/지연 2배. MessageSummary에 threadId가 이미 있으므로 thread 한 번만 페치해 클릭 메시지를 골라내면 1 round-trip.
(c) ThreadMessage가 memo 없이 부모 상태 변경(별표 토글 등)마다 전체 재렌더 → iframe srcDoc 재계산 연쇄.
수정:
- HtmlBody: useMemo로 srcDoc 캐시. ThreadMessage: React.memo.
- Reader에 threadId를 prop으로 전달, api.thread 단일 페치로 통합(첫 페인트 동작 유지하되 중복 메시지 페치 제거). 읽음 처리 로직 동일 유지.
완료 기준: typecheck/build 통과 + 메일 열람 시 네트워크 요청이 thread 1회로 줄었는지 실측, 별표 토글 시 본문 iframe 리로드 없음 확인.
