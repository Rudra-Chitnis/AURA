const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aura", {
  // ── window controls ─────────────────────────────────────────────────────
  minimize:      ()     => ipcRenderer.send("window-minimize"),
  maximize:      ()     => ipcRenderer.send("window-maximize"),
  close:         ()     => ipcRenderer.send("window-close"),
  quit:          ()     => ipcRenderer.send("window-quit"),
  isMaximized:   ()     => ipcRenderer.invoke("window-is-maximized"),
  onMaximize: (cb)      => {
    ipcRenderer.on("maximize-change", (_, val) => cb(val));
    return () => ipcRenderer.removeAllListeners("maximize-change");
  },

  // ── window size ──────────────────────────────────────────────────────────
  expandWindow:  ()     => ipcRenderer.invoke("window-expand"),
  compactWindow: ()     => ipcRenderer.invoke("window-compact"),

  // ── system ───────────────────────────────────────────────────────────────
  openExternal: (url)   => ipcRenderer.invoke("open-external", url),
  platform:     ()      => ipcRenderer.invoke("get-platform"),

  // ── auth token (shared with voice.py via ~/.aura_token) ─────────────────
  getToken:     ()      => ipcRenderer.invoke("get-token"),
  saveToken:    (token) => ipcRenderer.invoke("save-token", token),
  clearToken:   ()      => ipcRenderer.invoke("clear-token"),

  // ── voice process ────────────────────────────────────────────────────────
  voiceStart:  ()       => ipcRenderer.invoke("voice-start"),
  voiceStop:   ()       => ipcRenderer.invoke("voice-stop"),
  voiceStatus: ()       => ipcRenderer.invoke("voice-status"),
  onVoiceStatus: (cb)   => {
    ipcRenderer.on("voice-status", (_, val) => cb(val));
    return () => ipcRenderer.removeAllListeners("voice-status");
  },
  onVoiceLog: (cb)      => {
    ipcRenderer.on("voice-log", (_, val) => cb(val));
    return () => ipcRenderer.removeAllListeners("voice-log");
  },

  // ── voice pause / resume ─────────────────────────────────────────────────
  pauseVoice:   ()      => ipcRenderer.invoke("voice-pause"),
  resumeVoice:  ()      => ipcRenderer.invoke("voice-resume"),
  voiceIsPaused: ()     => ipcRenderer.invoke("voice-paused"),
  onVoicePaused: (cb)   => {
    ipcRenderer.on("voice-paused", (_, val) => cb(val));
    return () => ipcRenderer.removeAllListeners("voice-paused");
  },

  // ── startup phase ────────────────────────────────────────────────────────
  // Emitted by main.js as AURA boots: launching → starting-backend →
  // checking-ollama → loading-voice → warming-models → ready
  onStartupPhase: (cb)  => {
    ipcRenderer.on("startup-phase", (_, phase) => cb(phase));
    return () => ipcRenderer.removeAllListeners("startup-phase");
  },

  // ── backend logs ─────────────────────────────────────────────────────────
  onBackendLog: (cb)    => {
    ipcRenderer.on("backend-log", (_, val) => cb(val));
    return () => ipcRenderer.removeAllListeners("backend-log");
  },
  onBackendStatus: (cb) => {
    ipcRenderer.on("backend-status", (_, val) => cb(val));
    return () => ipcRenderer.removeAllListeners("backend-status");
  },

  // ── ollama status ─────────────────────────────────────────────────────────
  // "starting"      — server not yet responding
  // "loading-model" — server up, required model not yet in /api/tags
  // "running"       — server up, model confirmed available
  // "unavailable"   — 6-minute timeout or binary not found
  onOllamaStatus: (cb) => {
    ipcRenderer.on("ollama-status", (_, val) => cb(val));
    return () => ipcRenderer.removeAllListeners("ollama-status");
  },

  // ── settings persistence ──────────────────────────────────────────────────
  // Settings stored in ~/.aura_settings — survive Electron restarts.
  loadSettings: ()           => ipcRenderer.invoke("load-settings"),
  saveSettings: (settings)   => ipcRenderer.invoke("save-settings", settings),

  // ── notifications ────────────────────────────────────────────────────────
  notify: ({ title, body }) =>
    ipcRenderer.send("show-notification", { title, body }),

  // ── timers ────────────────────────────────────────────────────────────────
  setTimer:    (label, seconds) => ipcRenderer.invoke("set-timer",    { label, seconds }),
  cancelTimer: (id)             => ipcRenderer.invoke("cancel-timer", id),
  listTimers:  ()               => ipcRenderer.invoke("list-timers"),
  onTimerTick: (cb) => {
    const handler = (_, timers) => cb(timers);
    ipcRenderer.on("timer-tick", handler);
    return () => ipcRenderer.removeListener("timer-tick", handler);
  },
  onTimerFired: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("timer-fired", handler);
    return () => ipcRenderer.removeListener("timer-fired", handler);
  },

  // ── desktop reminders ─────────────────────────────────────────────────────
  setDesktopReminder:    (text, fireAt) => ipcRenderer.invoke("set-reminder",    { text, fireAt }),
  cancelDesktopReminder: (id)           => ipcRenderer.invoke("cancel-reminder", id),
  listDesktopReminders:  ()             => ipcRenderer.invoke("list-reminders"),
  onReminderFired: (cb) => {
    const handler = (_, data) => cb(data);
    ipcRenderer.on("reminder-fired", handler);
    return () => ipcRenderer.removeListener("reminder-fired", handler);
  },
  onReminderUpdated: (cb) => {
    const handler = (_, reminders) => cb(reminders);
    ipcRenderer.on("reminder-updated", handler);
    return () => ipcRenderer.removeListener("reminder-updated", handler);
  },

  // ── wake voice from sleep ─────────────────────────────────────────────────
  voiceWake: () => ipcRenderer.invoke("voice-wake"),

  // ── debug mode / observability ────────────────────────────────────────────
  // Returns true when AURA_DEBUG=true is set in the Electron environment.
  // The renderer uses this to conditionally mount the DebugPanel overlay.
  getDebugMode: () => ipcRenderer.invoke("get-debug-mode"),

  // Subscribe to debug events forwarded from both Python (via stdout AURA:DEBUG:)
  // and from the Node.js backend (via WebSocket debug:* messages relayed by App.jsx).
  // Returns an unsubscribe function.
  onDebugEvent: (cb) => {
    const handler = (_, payload) => cb(payload);
    ipcRenderer.on("debug-event", handler);
    return () => ipcRenderer.removeListener("debug-event", handler);
  },
});
