const {
  app, BrowserWindow, Tray, Menu, ipcMain,
  shell, nativeTheme, globalShortcut, Notification,
} = require("electron");
const path  = require("path");
const os    = require("os");
const fs    = require("fs");
const http  = require("http");
const { spawn } = require("child_process");

// ─── env ─────────────────────────────────────────────────────────────────────
// isDev is ONLY true when the Vite dev server is explicitly running.
const isDev        = process.env.NODE_ENV === "development";
const BACKEND_PORT = process.env.AURA_PORT || 5000;

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

// ─── startup phase tracking ───────────────────────────────────────────────────
// Phases (in order): launching → starting-backend → loading-voice →
//                    warming-models → ready
// We buffer the current phase so it can be replayed when the window loads.
let _currentPhase = "launching";
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
  _currentPhase = phase;
  console.log(`[AURA] Startup phase: ${phase}`);
  if (_windowReady) safeSend("startup-phase", phase);
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
    safeSend("startup-phase", _currentPhase);

    // Attach backend stdout → log panel forwarding exactly once
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

// ─── backend health check ─────────────────────────────────────────────────────
// Returns a Promise that resolves when the backend HTTP server is accepting
// connections (or rejects after `timeout` ms).
function waitForBackend(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const attempt = () => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        resolve();
        res.resume();
      });
      req.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error("Backend health check timed out"));
        } else {
          setTimeout(attempt, 600);
        }
      });
      req.setTimeout(500, () => req.destroy());
    };
    attempt();
  });
}

// ─── spawn backend ───────────────────────────────────────────────────────────
function startBackend() {
  const serverFile = projectFile("backend", "server.js");

  if (!fs.existsSync(serverFile)) {
    console.warn("[AURA] Backend not found at", serverFile, "— skipping.");
    return;
  }

  emitPhase("starting-backend");

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
    safeSend("backend-status", "offline");
  });

  console.log("[AURA] Backend spawned, PID", backendProc.pid);

  // Wait for backend to be truly accepting HTTP connections, then start voice.
  // Log signals can fire before the server socket is bound, so we HTTP-poll.
  emitPhase("loading-voice");
  waitForBackend(BACKEND_PORT, 40000)
    .then(() => {
      console.log("[AURA] Backend health check passed — starting voice.");
      voiceProc = startVoice();
      safeSend("voice-status", voiceProc ? "running" : "error");
    })
    .catch((err) => {
      console.warn("[AURA] Backend health check failed:", err.message, "— starting voice anyway.");
      if (!voiceProc) {
        voiceProc = startVoice();
        safeSend("voice-status", voiceProc ? "running" : "error");
      }
    });
}

// ─── spawn voice ─────────────────────────────────────────────────────────────
function startVoice() {
  const voiceFile = projectFile("voice", "voice.py");

  if (!fs.existsSync(voiceFile)) {
    console.warn("[AURA] voice.py not found — voice mode unavailable.");
    emitPhase("ready");   // skip voice phases — show ready anyway
    return null;
  }

  const pythonExe = process.platform === "win32" ? "py" : "python3";
  const proc = spawn(pythonExe, [voiceFile], {
    cwd:         path.dirname(voiceFile),
    stdio:       ["pipe", "pipe", "pipe"],   // stdin must be pipe for PAUSE/RESUME commands
    windowsHide: true,
  });

  proc.stdout.on("data", (d) => {
    const msg = d.toString().trimEnd();
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

    if (code !== 0 && !app.isQuitting) {
      console.log(`[AURA] Voice exited with code ${code} — retrying in 6 s...`);
      setTimeout(() => {
        if (!voiceProc && !app.isQuitting) {
          voiceProc = startVoice();
          safeSend("voice-status", voiceProc ? "running" : "error");
        }
      }, 6000);
    }
  });

  // Hard timeout: if voice never signals ready within 60 s, show ready anyway
  setTimeout(() => {
    if (_currentPhase !== "ready") emitPhase("ready");
  }, 60000);

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
            voiceProc = startVoice();
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
ipcMain.handle("save-token",  (_, token) => { fs.writeFileSync(TOKEN_PATH, token, "utf8"); });
ipcMain.handle("clear-token", ()         => { try { fs.unlinkSync(TOKEN_PATH); } catch {} });

// ── voice process control ─────────────────────────────────────────────────────
ipcMain.handle("voice-start",  () => {
  if (voiceProc) return "already_running";
  voiceProc = startVoice();
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

// ── notifications ─────────────────────────────────────────────────────────────
ipcMain.on("show-notification", (_, { title, body }) => {
  if (Notification.isSupported()) new Notification({ title: title || "AURA", body }).show();
});

// ─── app lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  nativeTheme.themeSource = "dark";
  emitPhase("launching");
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
  // Send quit signal to voice.py for clean shutdown before killing
  if (voiceProc && voiceProc.stdin && !voiceProc.stdin.destroyed) {
    try { voiceProc.stdin.write("QUIT\n"); } catch {}
  }
  setTimeout(() => {
    if (backendProc) try { backendProc.kill(); } catch {}
    if (voiceProc)   try { voiceProc.kill();   } catch {}
  }, 400);
});

app.on("window-all-closed", () => {
  // Stay in system tray — don't quit
});

app.on("activate", () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});
