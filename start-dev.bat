@echo off
title AURA Dev Mode
color 0A
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║    AURA Dev Mode  (hot reload enabled)   ║
echo  ╚══════════════════════════════════════════╝
echo.
echo  Starting 3 processes:
echo    1. Backend  (Node.js + Express + MongoDB)
echo    2. Vite dev server  (React hot reload)
echo    3. Electron  (desktop window)
echo.

:: Backend in its own terminal
start "AURA Backend" cmd /k "cd /d %~dp0backend && npm run dev"

:: Desktop app (starts Vite + waits for it + opens Electron)
start "AURA Desktop Dev" cmd /k "cd /d %~dp0desktop && npm run dev"

echo  [OK] All processes started in separate terminals.
echo  [INFO] Electron window opens once Vite is ready (~5s).
echo  [INFO] Voice mode: use the mic button in the app (requires python + deps).
echo.
pause
