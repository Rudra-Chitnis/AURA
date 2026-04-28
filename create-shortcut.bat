@echo off
title AURA — Desktop Setup
color 0B
echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   AURA — Desktop Shortcut Setup          ║
echo  ╚══════════════════════════════════════════╝
echo.

set "ROOT=%~dp0"
set "BACKEND=%ROOT%backend"
set "DESKTOP=%ROOT%desktop"

:: ── Step 1: Check Node.js ────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found.
    echo         Install it from https://nodejs.org then run this again.
    pause & exit /b 1
)

:: ── Step 2: Install backend dependencies ────────────────────────────────────
if not exist "%BACKEND%\node_modules" (
    echo  [INFO] Installing backend dependencies...
    pushd "%BACKEND%"
    call npm install
    if errorlevel 1 ( echo  [ERROR] Backend npm install failed. & popd & pause & exit /b 1 )
    popd
    echo  [OK]  Backend dependencies installed.
) else (
    echo  [OK]  Backend dependencies already present.
)

:: ── Step 3: Install desktop dependencies ────────────────────────────────────
if not exist "%DESKTOP%\node_modules" (
    echo  [INFO] Installing desktop dependencies...
    pushd "%DESKTOP%"
    call npm install
    if errorlevel 1 ( echo  [ERROR] Desktop npm install failed. & popd & pause & exit /b 1 )
    popd
    echo  [OK]  Desktop dependencies installed.
) else (
    echo  [OK]  Desktop dependencies already present.
)

:: ── Step 4: Build the Vite frontend (REQUIRED for production launch) ─────────
echo.
echo  [INFO] Building frontend...
echo         (This takes 10-30s on first run — please wait)
echo.
pushd "%DESKTOP%"
call npm run build
if errorlevel 1 (
    echo.
    echo  [ERROR] Frontend build FAILED.
    echo         Check the error above. Common causes:
    echo           - Missing import in a component
    echo           - Syntax error in JSX
    echo           - npm install not completed
    popd
    pause & exit /b 1
)
popd
echo  [OK]  Frontend built successfully.

:: ── Step 5: Generate icons ───────────────────────────────────────────────────
echo.
echo  [INFO] Generating AURA icon...
python "%ROOT%generate-icon.py" >nul 2>&1
if errorlevel 1 (
    echo  [WARN] Icon generation skipped (Python not found or error — app still works).
) else (
    echo  [OK]  Icons generated.
)

:: ── Step 6: Create Desktop shortcut ─────────────────────────────────────────
echo.
echo  [INFO] Creating desktop shortcut...

set "VBS=%ROOT%AURA.vbs"
set "ICON=%DESKTOP%\assets\icon.ico"

powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command ^
  "$ws  = New-Object -ComObject WScript.Shell;" ^
  "$lnk = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\AURA.lnk');" ^
  "$lnk.TargetPath      = '%VBS:\=\\%';" ^
  "$lnk.Description     = 'AURA - Local AI Assistant';" ^
  "$lnk.WorkingDirectory = '%ROOT:\=\\%';" ^
  "if (Test-Path '%ICON:\=\\%') { $lnk.IconLocation = '%ICON:\=\\%,0' };" ^
  "$lnk.Save()"

if errorlevel 1 (
    echo  [WARN] Shortcut creation had an issue.
    echo         You can still launch AURA by double-clicking AURA.vbs directly.
) else (
    echo  [OK]  Desktop shortcut created.
)

:: ── Done ─────────────────────────────────────────────────────────────────────
echo.
echo  ════════════════════════════════════════════════
echo.
echo    AURA is ready!
echo.
echo    Launch:   double-click AURA on your Desktop
echo    Hotkey:   Ctrl + Shift + A
echo    Tray:     right-click the AURA icon in taskbar
echo.
echo    NOTE: Run this bat again if you update the app
echo          so the frontend is rebuilt.
echo.
echo  ════════════════════════════════════════════════
echo.
pause
