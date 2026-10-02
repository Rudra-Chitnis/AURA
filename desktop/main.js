const {
  app, BrowserWindow, Tray, Menu, ipcMain,
  shell, nativeTheme, globalShortcut, Notification,
} = require("electron");
const path  = require("path");
const os    = require("os");
const fs    = require("fs");
const { spawn, execFile,spawnSync } = require("child_process");

const { AuraRuntime } = require("./core/auraRuntime");

// ─── single instance lock ─────────────────────────────────────────────────────
// Prevents double-click from launching a second Electron instance.
// If a second instance starts, focus the existing window and exit immediately.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ─── env ─────────────────────────────────────────────────────────────────────
// isDev is ONLY true when the Vite dev server is explicitly running.
const isDev        = process.env.NODE_ENV === "development";
const BACKEND_PORT = parseInt(process.env.AURA_PORT || "5000", 10);
const OLLAMA_PORT  = 11434;

const projectFile = (...parts) =>
  app.isPackaged
    ? path.join(process.resourcesPath, ...parts)
    : path.join(__dirname, "..", ...parts);

// ─── state ───────────────────────────────────────────────────────────────────
let mainWindow   = null;
let tray         = null;
let backendProc  = null;
let voiceProc    = null;
let voicePaused  = false;
app.isQuitting   = false;

// The headless runtime is composed after Electron exposes its user data path.
let auraRuntime = null;

// ─── startup phase tracking ───────────────────────────────────────────────────
// Phases (in order): launching → starting-backend → checking-ollama →
//                    loading-voice → warming-models → ready
// We buffer the current phase so it can be replayed when the window loads.
let _windowReady  = false;   // true after did-finish-load fires

// ─── safe IPC send ────────────────────────────────────────────────────────────
// mainWindow?.webContents.send() only guards against null, not a destroyed window.
// safeSend() checks isDestroyed() and wraps in try/catch — safe to call at any time.
function safeSend(channel, ...args) {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  } catch (_) {
    // swallow — window already gone
  }
}

function emitPhase(phase) {
  auraRuntime.setStartupPhase(phase);
  console.log(`[AURA] Startup phase: ${phase}`);
  if (_windowReady) safeSend("startup-phase", phase);
}

// ─── file logging ─────────────────────────────────────────────────────────────
// Intercept all console output in the main process and tee it to a daily log
// file in %APPDATA%\AURA\logs\.  Because Electron already forwards backend and
// voice.py stdout through console.log("[backend]" / "[voice]"), one interceptor
// covers every subsystem.  Old logs older than 7 days are pruned on startup.
//
// Must be called after app is ready (app.getPath requires it).
function setupFileLogging() {
  let logStream = null;
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });

    const today   = new Date().toISOString().slice(0, 10);   // YYYY-MM-DD
    const logFile = path.join(logDir, `aura-${today}.log`);
    logStream = fs.createWriteStream(logFile, { flags: "a" });

    // Prune logs older than 7 days
    try {
      fs.readdirSync(logDir)
        .filter(f => /^aura-\d{4}-\d{2}-\d{2}\.log$/.test(f))
        .sort()
        .slice(0, -7)                      // keep latest 7, delete the rest
        .forEach(f => fs.unlinkSync(path.join(logDir, f)));
    } catch (_) {}

    console.log(`[AURA] Logging to: ${logFile}`);
  } catch (e) {
    console.warn("[AURA] Could not open log file:", e.message);
    return;  // non-fatal — app still works, just no file log
  }

  const _stamp = () => new Date().toISOString().slice(11, 23);  // HH:MM:SS.mmm
  const _write = (prefix, args) => {
    try {
      logStream.write(`[${_stamp()}] ${prefix}${args.join(" ")}\n`);
    } catch (_) {}
  };

  const _log   = console.log.bind(console);
  const _warn  = console.warn.bind(console);
  const _error = console.error.bind(console);

  console.log   = (...a) => { _write("",       a); _log(...a);   };
  console.warn  = (...a) => { _write("WARN  ", a); _warn(...a);  };
  console.error = (...a) => { _write("ERROR ", a); _error(...a); };
}

// ─── sizes ───────────────────────────────────────────────────────────────────
const COMPACT_W = 440;
const COMPACT_H = 580;
const EXPAND_W  = 1100;
const EXPAND_H  = 700;

// ─── inline error page ───────────────────────────────────────────────────────
function errorPage(title, body) {
  const html = `<!DOCTYPE html>
<html style="margin:0;height:100%;background:#0c0c0f;color:#f0f0f8;
  font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center">
<div style="text-align:center;padding:40px;max-width:420px">
  <div style="font-size:40px;margin-bottom:16px;opacity:0.6">◎</div>
  <h2 style="margin:0 0 12px;color:#f87171;font-size:15px;font-weight:600">${title}</h2>
  <p style="margin:0;color:#555;font-size:12px;line-height:1.7">${body}</p>
</div></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

// ─── create window ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:           COMPACT_W,
    height:          COMPACT_H,
    minWidth:        COMPACT_W,
    minHeight:       COMPACT_H,
    maxWidth:        EXPAND_W,
    maxHeight:       EXPAND_H,
    frame:           false,
    transparent:     false,
    backgroundColor: "#0c0c0f",
    show:            false,
    webPreferences: {
      preload:          path.join(__dirname, "preload.js"),
      nodeIntegration:  false,
      contextIsolation: true,
      spellcheck:       false,
    },
  });

  // ── Load the renderer ─────────────────────────────────────────────────────
  if (isDev) {
    mainWindow.loadURL("http://localhost:5173").catch(() => {
      mainWindow.loadURL(errorPage(
        "Vite dev server not running",
        "Start it with <b>npm run dev</b> in the <b>desktop/</b> folder, then relaunch."
      ));
    });
  } else {
    const distHtml = path.join(__dirname, "dist", "index.html");
    if (fs.existsSync(distHtml)) {
      mainWindow.loadFile(distHtml);
    } else {
      mainWindow.loadURL(errorPage(
        "App not built yet",
        "Run <b>create-shortcut.bat</b> — it builds the app automatically then creates your shortcut.<br><br>" +
        "Or manually: open a terminal in the <b>desktop/</b> folder and run <b>npm run build</b>, then relaunch."
      ));
    }
  }

  // ── Show when first paint is ready ────────────────────────────────────────
  let _windowShown = false;
  const _showWindow = () => {
    if (_windowShown || !mainWindow || mainWindow.isDestroyed()) return;
    _windowShown = true;
    mainWindow.show();
    mainWindow.focus();
  };
  mainWindow.once("ready-to-show", _showWindow);
  setTimeout(_showWindow, 2000);

  // ── Once the renderer is loaded, flush the current phase ─────────────────
  // Use .once() so this only fires on first load — not on renderer reload/crash-recovery.
  // The backend stdout listener is attached here once; subsequent reloads just re-send phase.
  let _backendLogAttached = false;
  mainWindow.webContents.on("did-finish-load", () => {
    _windowReady = true;
    // Re-send current phase on every load (handles renderer reload after crash)
    safeSend("startup-phase", auraRuntime.getStartupPhase());

    // Attach backend stdout → log panel forwarding exactly once.
    // Guard: backendProc must exist AND still have readable stdout.
    if (backendProc && !_backendLogAttached) {
      _backendLogAttached = true;
      backendProc.stdout.on("data", (d) =>
        safeSend("backend-log", d.toString().trimEnd())
      );
    }
  });

  mainWindow.webContents.on("did-fail-load", (_e, code, desc, url) => {
    if (url && url.startsWith("data:")) return;
    console.error(`[AURA] Renderer failed to load (${code}): ${desc} — ${url}`);
    mainWindow.loadURL(errorPage(
      `Renderer load failed (${code})`,
      `${desc}<br><br>` +
      (isDev
        ? "Make sure the Vite dev server is running."
        : "Re-run <b>create-shortcut.bat</b> to rebuild the app.")
    ));
  });

  mainWindow.webContents.on("render-process-gone", (_e, { reason }) => {
    console.error("[AURA] Renderer process gone:", reason);
    if (reason !== "clean-exit") {
      setTimeout(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
      }, 1500);
    }
  });

  // ── Minimize to tray on X — Quit option is in tray / title bar ───────────
  mainWindow.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on("maximize",   () => mainWindow.webContents.send("maximize-change", true));
  mainWindow.on("unmaximize", () => mainWindow.webContents.send("maximize-change", false));
}

// ─── Ollama health — three-tier check ────────────────────────────────────────
//
// Tier 1 — checkOllamaServer(timeout):
//   Pings the root endpoint (/). Returns true if Ollama is bound and listening.
//   Fast (≤ timeout ms). Never rejects.
//
// Tier 2 — checkOllamaModels(timeout):
//   Hits /api/tags to list locally downloaded models.  Returns the array of
//   model names if the call succeeds, or null on failure.
//   Used to confirm the required model (mistral) is actually downloaded before
//   declaring "running" — prevents false-positive "running" when Ollama server
//   is up but the target model was deleted or never pulled.
//
// UI states emitted on "ollama-status":
//   "starting"      — server not yet responding (spawned, waiting for bind)
//   "loading-model" — server up, but required model not found in /api/tags
//   "running"       — server up AND required model confirmed available
//   "unavailable"   — 6-minute timeout expired OR spawn failed (binary missing)
//
// Design: never emits "unavailable" just because startup is slow. Inference
// continues to work once the model finishes loading regardless of this status.
// ─────────────────────────────────────────────────────────────────────────────

const OLLAMA_PRIMARY_MODEL = process.env.OLLAMA_MODEL      || "mistral";

// ─── Ollama startup ───────────────────────────────────────────────────────────
// Ensures Ollama server is running and the primary model is available.
// Never rejects — AURA degrades gracefully without Ollama.
async function ensureOllama() {
  emitPhase("checking-ollama");

  // ── Fast path: server already running ───────────────────────────────────────
  const alreadyUp = await auraRuntime.ollamaReadiness.checkServer(4000);
  if (alreadyUp) {
    console.log("[AURA] Ollama server already running on :11434");
    // Check model availability while we're here
    const models = await auraRuntime.ollamaReadiness.checkModels(3000);
    if (auraRuntime.ollamaReadiness.modelAvailable(models)) {
      console.log(`[AURA] Model '${OLLAMA_PRIMARY_MODEL}' confirmed available.`);
      safeSend("ollama-status", "running");
    } else {
      // Server is up but model not found (not downloaded, or /api/tags slow).
      // Emit loading-model and let voice.py's first inference attempt load it.
      console.log(`[AURA] Ollama up — model '${OLLAMA_PRIMARY_MODEL}' not in /api/tags yet (may still be loading).`);
      safeSend("ollama-status", "loading-model");
      // Poll in background until model appears or 3-minute timeout
      auraRuntime.ollamaReadiness.pollUntilModelReady(0, 36);   // 36 × 5s = 3 min
    }
    return;
  }

  // ── Server not running — attempt to start ollama serve ──────────────────────
  console.log("[AURA] Ollama not detected — attempting to start `ollama serve`...");
  safeSend("ollama-status", "starting");

  try {
    const ollamaProc = spawn("ollama", ["serve"], {
      detached:    true,
      stdio:       "ignore",
      windowsHide: true,
    });
    ollamaProc.unref();
  } catch (e) {
    console.warn("[AURA] Could not start Ollama:", e.message);
    // Binary missing or PATH issue — check if another process has Ollama running
    // (user may have started it manually after launch). Degrade gracefully.
    safeSend("ollama-status", "unavailable");
    return;
  }

  // ── Wait up to 45s for server to bind ───────────────────────────────────────
  const serverReady = await auraRuntime.ollamaReadiness.waitForServer(45000, 1500, 1500);
  if (serverReady) {
    console.log("[AURA] Ollama server started.");
    // Now check model availability
    const models = await auraRuntime.ollamaReadiness.checkModels(3000);
    if (auraRuntime.ollamaReadiness.modelAvailable(models)) {
      console.log(`[AURA] Model '${OLLAMA_PRIMARY_MODEL}' confirmed available.`);
      safeSend("ollama-status", "running");
    } else {
      console.log(`[AURA] Ollama up — model '${OLLAMA_PRIMARY_MODEL}' not loaded yet. Polling...`);
      safeSend("ollama-status", "loading-model");
      auraRuntime.ollamaReadiness.pollUntilModelReady(0, 36);
    }
    return;
  }

  // ── 45s expired — still polling in background ────────────────────────────────
  // This is NOT a failure — Ollama may still be starting (cold boot, slow drive).
  // Voice.py's first inference call will hit the 12s first-token watchdog and retry,
  // so the user will eventually get a response.  Do NOT mark "unavailable" here.
  console.log("[AURA] Ollama still loading after 45s — polling in background.");
  safeSend("ollama-status", "starting");
  auraRuntime.ollamaReadiness.pollUntilServerReady(0, 72);   // 72 × 5s = 6 min total from spawn
}

// ─── find Python executable ───────────────────────────────────────────────────
// Try py (Windows launcher) → python → python3, return the first one that works.
// Falls back to "python" if none can be verified (spawn will fail later with a clear error).
function findPython() {
  // ─── AURA project virtual environment ─────────────────────────────────────
  // Prefer the project's own .venv so voice.py always runs with the exact
  // dependencies installed for AURA.
  if (process.platform === "win32") {
    const venvPython = path.join(__dirname, "..", ".venv", "Scripts", "python.exe");

    try {
      if (fs.existsSync(venvPython)) {
        const result = spawnSync(venvPython, ["--version"], {
          timeout: 3000,
          windowsHide: true,
        });

        if (result.status === 0) {
          console.log(`[AURA] Using AURA virtual environment: ${venvPython}`);
          return venvPython;
        }
      }
    } catch (err) {
      console.warn("[AURA] Failed to validate .venv Python:", err.message);
    }
  }

  // ─── Fallback to system Python ────────────────────────────────────────────
  // Keep the existing fallback for machines where .venv doesn't exist.
  const candidates = process.platform === "win32"
    ? ["py", "python", "python3"]
    : ["python3", "python"];

  for (const exe of candidates) {
    try {
      const result = spawnSync(exe, ["--version"], {
        timeout: 3000,
        windowsHide: true,
      });

      if (result.status === 0) {
        console.log(`[AURA] Python fallback found: ${exe}`);
        return exe;
      }
    } catch (_) {
      // try next
    }
  }

  console.warn(
    "[AURA] No Python found (tried AURA .venv, py, python, python3) — voice will fail."
  );

  return "python";
}

const _pythonExe = findPython();  // resolved once at startup

// ─── spawn backend ───────────────────────────────────────────────────────────
function startBackend() {
  const serverFile = projectFile("backend", "server.js");

  if (!fs.existsSync(serverFile)) {
    console.warn("[AURA] Backend not found at", serverFile, "— skipping.");
    return;
  }

  auraRuntime.processes.startBackend(serverFile);
}

function spawnBackendProcess(serverFile) {
  backendProc = spawn("node", [serverFile], {
    cwd:         path.dirname(serverFile),
    env:         { ...process.env, PORT: String(BACKEND_PORT) },
    stdio:       ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  backendProc.stdout.on("data", (d) => {
    const msg = d.toString().trimEnd();
    console.log("[backend]", msg);
    if (_windowReady) safeSend("backend-log", msg);
  });
  backendProc.stderr.on("data", (d) =>
    console.error("[backend]", d.toString().trimEnd())
  );

  backendProc.on("exit", (code) => {
    console.log("[backend] exited:", code);
    backendProc = null;
    safeSend("backend-status", "offline");
    auraRuntime.processes.backendExited(code);
  });

  console.log("[AURA] Backend spawned, PID", backendProc.pid);
}

// ─── spawn voice ─────────────────────────────────────────────────────────────
function startVoice() {
  const voiceFile = projectFile("voice", "voice.py");

  if (!fs.existsSync(voiceFile)) {
    console.warn("[AURA] voice.py not found — voice mode unavailable.");
    emitPhase("ready");   // skip voice phases — show ready anyway
    return null;
  }

  const proc = spawn(_pythonExe, [voiceFile], {
    cwd:  path.dirname(voiceFile),
    env:  {
      ...process.env,
      // Pass backend URL so voice.py doesn't need a hardcoded port
      AURA_BACKEND: `http://localhost:${BACKEND_PORT}`,
    },
    stdio:       ["pipe", "pipe", "pipe"],   // stdin must be pipe for PAUSE/RESUME commands
    windowsHide: true,
  });

  proc.stdout.on("data", (d) => {
    // Split raw chunk into individual lines so per-line signals are never missed
    // when Python buffers multiple print() calls into one data event.
    const lines = d.toString().split("\n");
    for (const line of lines) {
      const msg = line.trimEnd();
      if (!msg) continue;

      console.log("[voice]", msg);
      safeSend("voice-log", msg);

      // ── Startup phase detection from voice.py stdout ───────────────────────
      if (/loading whisper/i.test(msg)) {
        emitPhase("warming-models");
      }
      // voice.py prints "AURA:VOICE_READY" once greeting has played and
      // the listen loop is about to start.
      if (msg.includes("AURA:VOICE_READY")) {
        emitPhase("ready");
        auraRuntime.processes.voiceReady();
        // Push the current on-disk token to voice.py immediately.
        // voice.py validated the token at startup, but Electron may have a
        // fresher one (e.g. user logged in between voice restart and VOICE_READY).
        // This ensures voice.py always uses the Electron-confirmed token
        // before the user speaks their first utterance.
        try {
          const tok = fs.readFileSync(TOKEN_PATH, "utf8").trim();
          if (tok && proc.stdin && !proc.stdin.destroyed) {
            proc.stdin.write(`TOKEN:${tok}\n`);
          }
        } catch {}
      }

      // ── Timer signal — voice.py prints AURA:SET_TIMER:seconds:label ───────
      // Electron owns the timer from this point: countdown, notification, UI tick.
      const timerMatch = msg.match(/^AURA:SET_TIMER:(\d+):(.+)$/);
      if (timerMatch) {
        const secs  = parseInt(timerMatch[1], 10);
        const label = timerMatch[2].trim();
        auraRuntime?.actions.dispatch({ type: "timer.create", label, seconds: secs });
        if (auraRuntime) safeSend("timer-tick", auraRuntime.timers.listTimers());
        console.log(`[AURA] Timer registered via voice: "${label}" ${secs}s`);
      }

      // ── Reminder signal — voice.py prints AURA:SET_REMINDER:text:isoTime ──
      // Electron schedules delivery. MongoDB path (for history) is handled separately.
      const reminderMatch = msg.match(/^AURA:SET_REMINDER:(.+):(\d{4}-\d{2}-\d{2}T[\d:.Z+-]+)$/);
      if (reminderMatch) {
        const text   = reminderMatch[1].trim();
        const fireAt = reminderMatch[2].trim();
        auraRuntime?.actions.dispatch({ type: "reminder.create", text, fireAt });
        console.log(`[AURA] Reminder registered via voice: "${text}" at ${fireAt}`);
      }

      // ── Sleeping state — voice.py prints AURA:SLEEPING ────────────────────
      if (msg.includes("AURA:SLEEPING")) {
        safeSend("voice-status", "sleeping");
      }
      // ── Woke from sleep ────────────────────────────────────────────────────
      if (msg.includes("AURA:AWAKE")) {
        safeSend("voice-status", "running");
      }

      // ── Debug event from Python debug_logger.py ────────────────────────────
      // voice.py emits "AURA:DEBUG:<json>" when AURA_DEBUG=true.
      // Parse and forward to the renderer as an IPC "debug-event" message so
      // the DebugPanel can display Python-side events alongside Node.js events.
      if (msg.startsWith("AURA:DEBUG:")) {
        try {
          const payload = JSON.parse(msg.slice("AURA:DEBUG:".length));
          safeSend("debug-event", { source: "python", ...payload });
        } catch {
          // malformed JSON — log and skip
          console.warn("[AURA] malformed debug event from voice.py:", msg.slice(0, 120));
        }
      }
    }
  });

  proc.stderr.on("data", (d) =>
    console.error("[voice]", d.toString().trimEnd())
  );

  proc.on("exit", (code) => {
    console.log("[voice] exited:", code);
    safeSend("voice-status", "stopped");
    voiceProc    = null;
    voicePaused  = false;
    auraRuntime.processes.voiceExited(code);
  });

  // Hard timeout: if voice never signals VOICE_READY within 180s, unblock UI anyway.
  // 90s was too short on first-boot: Whisper model caching + TTS network warmup
  // can take 2-3 min on slower machines or cold network connections.
  // VOICE_READY is the correct signal — this timeout is a last-resort UI unblock only.
  setTimeout(() => {
    if (auraRuntime.getStartupPhase() !== "ready") {
      console.warn("[AURA] Voice startup timeout (180s) — unblocking UI. Voice may still be loading.");
      emitPhase("ready");
    }
  }, 180000);

  console.log("[AURA] Voice process spawned, PID", proc.pid);
  return proc;
}

// ─── system tray ─────────────────────────────────────────────────────────────
function createTray() {
  const iconName   = process.platform === "win32" ? "tray-icon.ico" : "tray-icon.png";
  const candidates = [
    path.join(__dirname, "assets", iconName),
    path.join(__dirname, "assets", "icon.ico"),
    path.join(__dirname, "assets", "icon.png"),
    path.join(process.resourcesPath || "", "assets", iconName),
  ];
  const iconPath = candidates.find(p => fs.existsSync(p));

  if (!iconPath) {
    console.warn("[AURA] No tray icon found — run generate-icon.py once to create assets/icon.ico");
    try {
      const assetsDir = path.join(__dirname, "assets");
      if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
    } catch {}
  }

  try {
    tray = new Tray(iconPath || candidates[0]);
  } catch (e) {
    console.warn("[AURA] Tray icon unavailable:", e.message, "— app still accessible via Ctrl+Shift+A");
    return;
  }

  const rebuildTrayMenu = () => {
    const menu = Menu.buildFromTemplate([
      {
        label: "Show AURA",
        click: () => { mainWindow.show(); mainWindow.focus(); },
      },
      { type: "separator" },
      {
        label: voicePaused ? "Resume Listening" : "Pause Listening",
        enabled: !!voiceProc,
        click: () => {
          if (!voiceProc) return;
          if (voicePaused) {
            voiceProc.stdin.write("RESUME\n");
            voicePaused = false;
            safeSend("voice-paused", false);
          } else {
            voiceProc.stdin.write("PAUSE\n");
            voicePaused = true;
            safeSend("voice-paused", true);
          }
          rebuildTrayMenu();
        },
      },
      {
        label: voiceProc ? "Stop Voice Mode" : "Start Voice Mode",
        click: () => {
          if (voiceProc) {
            voiceProc.kill();
            voiceProc    = null;
            voicePaused  = false;
            safeSend("voice-status", "stopped");
            safeSend("voice-paused", false);
          } else {
            voiceProc = auraRuntime.processes.startVoiceManually();
            safeSend("voice-status", voiceProc ? "running" : "error");
          }
          rebuildTrayMenu();
        },
      },
      { type: "separator" },
      {
        label: "Quit AURA",
        click: () => { app.isQuitting = true; app.quit(); },
      },
    ]);
    tray.setContextMenu(menu);
  };

  rebuildTrayMenu();
  tray.setToolTip("AURA — Local AI Assistant");
  tray.on("click",        () => { mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show(); });
  tray.on("double-click", () => { mainWindow.show(); mainWindow.focus(); });
}

// ─── IPC handlers ────────────────────────────────────────────────────────────
ipcMain.on("window-minimize", () => mainWindow?.minimize());
ipcMain.on("window-maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on("window-close", () => mainWindow?.hide());
ipcMain.on("window-quit",  () => { app.isQuitting = true; app.quit(); });

ipcMain.handle("window-is-maximized", () => mainWindow?.isMaximized() ?? false);
ipcMain.handle("open-external",       (_, url) => shell.openExternal(url));
ipcMain.handle("get-platform",        ()        => process.platform);

// ── token ─────────────────────────────────────────────────────────────────────
const TOKEN_PATH = path.join(os.homedir(), ".aura_token");
ipcMain.handle("get-token",   ()         => { try { return fs.readFileSync(TOKEN_PATH, "utf8").trim(); } catch { return null; } });
ipcMain.handle("save-token",  (_, token) => {
    fs.writeFileSync(TOKEN_PATH, token, "utf8");
    // Push fresh token to voice.py so it picks it up without a restart.
    // voice.py's _stdin_monitor handles TOKEN:<value> and updates _token.
    if (voiceProc && voiceProc.stdin && !voiceProc.stdin.destroyed) {
        try { voiceProc.stdin.write(`TOKEN:${token}\n`); } catch {}
    }
});
ipcMain.handle("clear-token", ()         => { try { fs.unlinkSync(TOKEN_PATH); } catch {} });

// ── settings persistence ──────────────────────────────────────────────────────
// Settings are stored as JSON in ~/.aura_settings so they survive Electron restarts.
// Using the home dir (same as token) avoids any packaging/path issues.
const SETTINGS_PATH = path.join(os.homedir(), ".aura_settings");
ipcMain.handle("load-settings", () => {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;  // first run — renderer uses defaults
  }
});
ipcMain.handle("save-settings", (_, settings) => {
  try {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
    return true;
  } catch (e) {
    console.warn("[AURA] Failed to save settings:", e.message);
    return false;
  }
});

// ── voice process control ─────────────────────────────────────────────────────
ipcMain.handle("voice-start",  () => {
  if (voiceProc) return "already_running";
  voiceProc = auraRuntime.processes.startVoiceManually();
  return voiceProc ? "started" : "error";
});
ipcMain.handle("voice-stop",   () => {
  if (voiceProc) {
    voiceProc.kill();
    voiceProc    = null;
    voicePaused  = false;
  }
  return "stopped";
});
ipcMain.handle("voice-status", () => (voiceProc ? "running" : "stopped"));

// ── voice pause / resume ──────────────────────────────────────────────────────
ipcMain.handle("voice-pause", () => {
  if (voiceProc && voiceProc.stdin && !voiceProc.stdin.destroyed) {
    voiceProc.stdin.write("PAUSE\n");
    voicePaused = true;
    safeSend("voice-paused", true);
  }
  return voicePaused;
});
ipcMain.handle("voice-resume", () => {
  if (voiceProc && voiceProc.stdin && !voiceProc.stdin.destroyed) {
    voiceProc.stdin.write("RESUME\n");
    voicePaused = false;
    safeSend("voice-paused", false);
  }
  return voicePaused;
});
ipcMain.handle("voice-paused", () => voicePaused);

// ── window size ───────────────────────────────────────────────────────────────
ipcMain.handle("window-expand", () => {
  if (!mainWindow) return;
  mainWindow.setMinimumSize(COMPACT_W, COMPACT_H);
  mainWindow.setMaximumSize(EXPAND_W, EXPAND_H);
  mainWindow.setSize(EXPAND_W, EXPAND_H, true);
  mainWindow.center();
});
ipcMain.handle("window-compact", () => {
  if (!mainWindow) return;
  mainWindow.setSize(COMPACT_W, COMPACT_H, true);
  mainWindow.center();
});

// ── debug mode IPC ───────────────────────────────────────────────────────────
// Returns whether AURA_DEBUG is active in the Electron process environment.
// The renderer uses this to conditionally render the DebugPanel on load.
ipcMain.handle("get-debug-mode", () =>
  process.env.AURA_DEBUG === "true" || process.env.AURA_DEBUG === "1"
);

// ── voice delivery helper ─────────────────────────────────────────────────────
// Writes a SPEAK command to voice.py stdin so it speaks the text aloud.
// Safe to call even when voiceProc is null or stdin is closed.
function _speakViaVoice(text) {
  if (!text || !voiceProc || !voiceProc.stdin || voiceProc.stdin.destroyed) return;
  try {
    voiceProc.stdin.write(`SPEAK:${text}\n`);
  } catch (e) {
    console.warn("[AURA] SPEAK write failed:", e.message);
  }
}

// ── timer IPC handlers ────────────────────────────────────────────────────────
ipcMain.handle("set-timer", (_, { label, seconds }) => {
  const { result: timer } = auraRuntime.actions.dispatch({ type: "timer.create", label, seconds });
  safeSend("timer-tick", auraRuntime.timers.listTimers());
  return timer;
});
ipcMain.handle("cancel-timer", (_, id) => {
  auraRuntime.actions.dispatch({ type: "timer.cancel", id });
  safeSend("timer-tick", auraRuntime.timers.listTimers());
  return true;
});
ipcMain.handle("list-timers", () => auraRuntime?.timers.listTimers() || []);

// ── reminder IPC handlers ─────────────────────────────────────────────────────
ipcMain.handle("set-reminder",    (_, { text, fireAt }) => {
  const { result: r } = auraRuntime.actions.dispatch({ type: "reminder.create", text, fireAt });
  return r;
});
ipcMain.handle("cancel-reminder", (_, id) => {
  auraRuntime.actions.dispatch({ type: "reminder.cancel", id });
  return true;
});
ipcMain.handle("list-reminders",  () => auraRuntime?.reminders.listReminders() || []);

// ── wake voice from sleep ─────────────────────────────────────────────────────
ipcMain.handle("voice-wake", () => {
  if (voiceProc && voiceProc.stdin && !voiceProc.stdin.destroyed) {
    try { voiceProc.stdin.write("WAKE\n"); } catch {}
  }
  return "ok";
});

// ── notifications ─────────────────────────────────────────────────────────────
ipcMain.on("show-notification", (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title: title || "AURA", body }).show();
});

// ─── app lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  setupFileLogging();
  nativeTheme.themeSource = "dark";

  // The runtime owns scheduling and persistence; this shell adapter preserves
  // the existing IPC, OS notification, and voice delivery behavior.
  auraRuntime = new AuraRuntime({
    dataDirectory: app.getPath("userData"),
    ollama: {
      port: OLLAMA_PORT,
      primaryModel: OLLAMA_PRIMARY_MODEL,
      onStatus: status => safeSend("ollama-status", status),
      onLog: (level, message) => console[level](message),
    },
    processes: {
      backendPort: BACKEND_PORT,
      waitForBackend: (...args) => auraRuntime.backendReadiness.waitForBackend(...args),
      ensureOllama: () => ensureOllama(),
      spawnBackend: serverFile => spawnBackendProcess(serverFile),
      startVoice: () => {
        voiceProc = startVoice();
        return voiceProc;
      },
      hasBackend: () => Boolean(backendProc),
      hasVoice: () => Boolean(voiceProc),
      isQuitting: () => app.isQuitting,
      emitPhase,
      sendBackendStatus: status => safeSend("backend-status", status),
      sendVoiceStatus: status => safeSend("voice-status", status),
      log: (level, ...args) => console[level](...args),
      sendVoiceQuit: () => {
        if (voiceProc && voiceProc.stdin && !voiceProc.stdin.destroyed) {
          try { voiceProc.stdin.write("QUIT\n"); } catch {}
        }
      },
      killVoice: () => { if (voiceProc) try { voiceProc.kill(); } catch {} },
      killBackend: () => { if (backendProc) try { backendProc.kill(); } catch {} },
    },
  });
  auraRuntime.on("runtime:state", state => safeSend("runtime-state", state));
  auraRuntime.on("timer:tick", timers => safeSend("timer-tick", timers));
  auraRuntime.on("timer:fired", ({ timer, body }) => {
    try {
      if (Notification.isSupported()) new Notification({ title: "AURA Timer", body, silent: false }).show();
    } catch (e) { console.warn("[TimerManager] Notification failed:", e.message); }
    safeSend("timer-fired", { id: timer.id, label: timer.label, text: body });
    safeSend("timer-tick", auraRuntime.timers.listTimers());
    _speakViaVoice(body);
  });
  auraRuntime.on("reminder:updated", reminders => safeSend("reminder-updated", reminders));
  auraRuntime.on("reminder:fired", ({ reminder, body }) => {
    try {
      if (Notification.isSupported()) new Notification({ title: "AURA Reminder", body, silent: false }).show();
    } catch (e) { console.warn("[ReminderManager] Notification failed:", e.message); }
    safeSend("reminder-fired", { id: reminder.id, text: reminder.text, body });
    _speakViaVoice(body);
  });
  emitPhase("launching");
  auraRuntime.start();

  startBackend();
  createWindow();
  createTray();
  globalShortcut.register("CommandOrControl+Shift+A", () => {
    if (!mainWindow) return;
    mainWindow.isVisible() ? mainWindow.focus() : mainWindow.show();
  });
});

app.on("before-quit", () => {
  app.isQuitting = true;
  globalShortcut.unregisterAll();

  // Clean up manager intervals/handles before exit
  auraRuntime?.stop();
  auraRuntime?.processes?.shutdown();
});

app.on("window-all-closed", () => {
  // Stay in system tray — don't quit
});

app.on("activate", () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});
