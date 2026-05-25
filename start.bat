@echo off
title AURA Launcher
color 0B
echo.
echo  ╔═══════════════════════════════════╗
echo  ║      AURA — Local AI Assistant    ║
echo  ║      github.com/Rudra-Chitnis     ║
echo  ╚═══════════════════════════════════╝
echo.

:: ── Check Node.js ────────────────────────────────────────────────────────────
where node >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Node.js not found.
    echo  [INFO]  Download from https://nodejs.org  (v18 or higher)
    pause & exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK]  Node.js %NODE_VER% found.

:: ── Check Python ─────────────────────────────────────────────────────────────
where py >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%v in ('py --version 2^>^&1') do set PY_VER=%%v
    echo  [OK]  %PY_VER% found (py launcher).
    goto python_ok
)
where python >nul 2>&1
if not errorlevel 1 (
    for /f "tokens=*" %%v in ('python --version 2^>^&1') do set PY_VER=%%v
    echo  [OK]  %PY_VER% found.
    goto python_ok
)
echo  [ERROR] Python not found.
echo  [INFO]  Download Python 3.11 or 3.12 from https://python.org/downloads/
echo  [INFO]  During install, check "Add Python to PATH".
pause & exit /b 1
:python_ok

:: ── Check Ollama binary ───────────────────────────────────────────────────────
where ollama >nul 2>&1
if errorlevel 1 (
    echo  [WARN] Ollama not found in PATH.
    echo  [INFO]  Install from https://ollama.com then run: ollama pull mistral
    echo  [INFO]  AI responses will fail without Ollama.
    goto ollama_done
)
echo  [OK]  Ollama binary found.

:: ── Check if Ollama server is actually running ────────────────────────────────
:: Electron will also do this check — this BAT attempt gives faster startup.
powershell -NoProfile -NonInteractive -Command ^
  "try { $r = Invoke-WebRequest -Uri 'http://localhost:11434/' -TimeoutSec 2 -ErrorAction Stop; exit 0 } catch { exit 1 }" ^
  >nul 2>&1
if not errorlevel 1 (
    echo  [OK]  Ollama is running on :11434.
    goto ollama_done
)

echo  [INFO] Ollama is installed but not running — starting it now...
start /B ollama serve >nul 2>&1
echo  [OK]  Ollama serve started in background.
echo  [INFO] Waiting briefly for Ollama to initialise...
timeout /t 3 >nul

:ollama_done

:: ── Install backend Node deps ─────────────────────────────────────────────────
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

:: ── Install desktop Node deps ─────────────────────────────────────────────────
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

:: ── Install Python deps ───────────────────────────────────────────────────────
if exist "%~dp0voice\requirements.txt" (
    echo  [INFO] Checking Python dependencies...
    py -m pip install -r "%~dp0voice\requirements.txt" --quiet --disable-pip-version-check 2>nul
    if errorlevel 1 (
        python -m pip install -r "%~dp0voice\requirements.txt" --quiet --disable-pip-version-check 2>nul
    )
    if errorlevel 1 (
        echo  [WARN] Some Python packages failed to install.
        echo  [INFO]  Try manually: pip install -r voice\requirements.txt
    ) else (
        echo  [OK]  Python dependencies ready.
    )
)

echo.
echo  [OK]  Starting AURA Desktop...
echo  [INFO] Backend, Ollama check, and voice will auto-launch inside the app.
echo.

:: ── Check desktop build exists ────────────────────────────────────────────────
if not exist "%~dp0desktop\dist\index.html" (
    echo  [WARN] Desktop not built yet. Run create-shortcut.bat first for best experience.
    echo  [INFO] Attempting to build now...
    cd /d "%~dp0desktop"
    call npm run build --silent
    cd /d "%~dp0"
)

:: ── Launch Electron silently via VBScript ──────────────────────────────────────
:: AURA.vbs uses WshShell.Run with windowStyle=0 so no console window appears.
:: This is the same path used by the desktop shortcut — consistent behaviour.
wscript.exe "%~dp0AURA.vbs"

echo  [OK] AURA launched. Check your system tray.
timeout /t 3 >nul
