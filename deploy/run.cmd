@echo off
rem Windows: 작업 스케줄러가 실행하는 진입점. 프로젝트 루트에서 빌드 후 서버 기동.
rem 소스가 dist보다 새로울 때만 재빌드한다 (로그인 직후 빌드 지연으로 포트가 늦게 열리는 것 방지).
cd /d "%~dp0.."
set NODE_ENV=production

if not exist dist\index.html goto build
powershell -NoProfile -Command "$d=(Get-Item dist/index.html).LastWriteTime; if ((Get-ChildItem web -Recurse -File | Where-Object {$_.LastWriteTime -gt $d} | Select-Object -First 1) -or (Get-Item vite.config.ts).LastWriteTime -gt $d -or (Get-Item package.json).LastWriteTime -gt $d) {exit 1}"
if not errorlevel 1 goto run

:build
call bun run build

:run
bun server\index.ts
