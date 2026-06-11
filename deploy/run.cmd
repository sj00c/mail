@echo off
rem Windows: 작업 스케줄러가 실행하는 진입점. 프로젝트 루트에서 빌드 후 서버 기동.
cd /d "%~dp0.."
set NODE_ENV=production
call bun run build
bun server\index.ts
