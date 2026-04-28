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
  // loading-voice → warming-models → ready
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

  // ── notifications ────────────────────────────────────────────────────────
  notify: ({ title, body }) =>
    ipcRenderer.send("show-notification", { title, body }),
});
