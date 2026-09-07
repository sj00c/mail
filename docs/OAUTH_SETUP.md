# Google 연결 및 설치 안내

설치 방법이 두 군데에서 달라지지 않도록, 최신 안내는 **[README의 직접 설치하기](../README.md#-직접-설치하기-1회-약-10분)** 한 곳에서 관리합니다. Claude Code에 설치를 맡길 때는 **[Claude Code로 설치하기](../README.md#claude-code-install)**부터 시작합니다.

README에는 비개발자도 그대로 따라 할 수 있도록 다음 내용이 순서대로 정리되어 있습니다.

1. Google Cloud 프로젝트 만들기
2. Gmail·Calendar·Drive·People API 켜기
3. 로그인 허용 화면과 테스트 사용자 설정
4. 앱이 실제로 사용하는 권한 다섯 개 선택
5. 웹 애플리케이션용 Client ID와 Client Secret 발급
6. `.env`에 두 값 입력
7. **설치 스크립트 한 번으로** 실행 프로그램 설치·앱 빌드·자동 실행 등록
8. `http://localhost:8787`에서 첫 Google 로그인

## 반드시 같아야 하는 값

- 클라이언트 유형: **웹 애플리케이션**
- 승인된 리디렉션 URI: `http://localhost:8787/auth/callback`
- `.env`의 `OAUTH_REDIRECT`: `http://localhost:8787/auth/callback`
- `.env`의 `PORT`: `8787`
- 테스트 사용자: 실제로 로그인할 Gmail 주소

8787을 다른 프로그램이 쓰고 있으면 세 값의 포트를 같은 빈 번호로 바꾸면 됩니다 (README “포트 바꾸기” 참고).

## 설치 스크립트

Client ID와 Client Secret을 `.env`에 저장한 뒤 **[README의 설치 ③](../README.md#run-app)** 명령 하나만 실행합니다.

설치 스크립트는 `.env` 형식을 먼저 확인하고, Bun과 필요한 파일을 설치하고, 앱을 빌드하고, 로그인 시 자동으로 실행되도록 등록합니다. 마지막에는 `localhost:8787` 응답까지 확인합니다(최대 60초, 서버가 떠다 죽으면 로그를 바로 보여줌). 포트를 이미 다른 프로그램이 쓰고 있으면 그 이름을 알려 주고 멈춥니다.

Client Secret과 로그인 정보는 저장소에 포함되지 않으며 다른 사람과 공유하면 안 됩니다.