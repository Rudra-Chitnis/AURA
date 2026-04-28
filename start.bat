@echo off
title AURA Launcher
color 0B
echo.
echo  ╔═══════════════════════════════════╗
echo  ║      AURA — Local AI Assistant    ║
echo  ║      github.com/Rudra-Chitnis     ║
echo  ╚═══════════════════════════════════╝
echo.

:: ── Check Node.js ────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found.
    echo  [INFO]  Download from https://nodejs.org  (v18 or higher)
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK]  Node.js %NODE_VER% found.

:: ── Check Python ─────────────────────────────
where python >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python not found.
    echo  [INFO]  Download Python 3.11 or 3.12 from https://python.org/downloads/
    echo  [INFO]  During install, check "Add Python to PATH".
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('python --version 2^>^&1') do set PY_VER=%%v
echo  [OK]  %PY_VER% found.

:: ── Check Ollama ──────────────────────────────
where ollama >nul 2>&1
if errorlevel 1 (
    echo  [WARN] Ollama not found — AI responses will fail.
    echo  [INFO]  Install from https://ollama.com and run: ollama pull mistral
) else (
    echo  [OK]  Ollama found.
)

:: ── Install backend Node deps ─────────────────
if not exist "%~dp0backend\node_modules" (
    echo  [INFO] Installing backend dependencies...
    cd /d "%~dp0backend"
    call npm install --silent
    if errorlevel 1 (
        echo  [ERROR] Backend npm install failed.
        pause & exit /b 1
    )
    cd /d "%~dp0"
    echo  [OK]  Backend dependencies installed.
)

:: ── Install desktop Node deps ─────────────────
if not exist "%~dp0desktop\node_modules" (
    echo  [INFO] Installing desktop dependencies...
    cd /d "%~dp0desktop"
    call npm install --silent
    if errorlevel 1 (
        echo  [ERROR] Desktop npm install failed.
        pause & exit /b 1
    )
    cd /d "%~dp0"
    echo  [OK]  Desktop dependencies installed.
)

:: ── Install Python deps ───────────────────────
if exist "%~dp0voice\requirements.txt" (
    echo  [INFO] Checking Python dependencies...
    python -m pip install -r "%~dp0voice\requirements.txt" --quiet --disable-pip-version-check
    if errorlevel 1 (
        echo  [WARN] Some Python packages failed to install.
        echo  [INFO]  Try manually: pip install -r voice\requirements.txt
    ) else (
        echo  [OK]  Python dependencies ready.
    )
)

echo.
echo  [OK]  Starting AURA Desktop...
echo  [INFO] Backend and voice will auto-launch inside the app.
echo.

:: ── Launch Electron ───────────────────────────
cd /d "%~dp0desktop"
start "" npm run start

echo  [OK] AURA launched. Check your system tray.
timeout /t 3 >nul
