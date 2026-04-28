import { create } from "zustand";

const useStore = create((set, get) => ({
  // ── Auth ───────────────────────────────────────────────────────────────
  token:           null,
  user:            null,
  isAuthenticated: false,

  setToken: (token) => set({ token, isAuthenticated: !!token }),
  setUser:  (user)  => set({ user }),
  logout:   ()      => {
    set({ token: null, user: null, isAuthenticated: false });
    window.aura?.clearToken();
  },

  // ── Startup ────────────────────────────────────────────────────────────
  // Truthful sequential phases from Electron main.js:
  // launching → starting-backend → loading-voice → warming-models → ready
  startupPhase: "launching",
  setStartupPhase: (phase) => set({ startupPhase: phase }),

  // ── Voice ──────────────────────────────────────────────────────────────
  // idle | listening | thinking | speaking | executing
  voiceState:      "idle",
  voiceProcess:    "stopped",   // stopped | running | error
  voicePaused:     false,       // true when user has paused the listen loop
  voiceTranscript: "",
  currentResponse: "",          // latest AURA text response

  setVoiceState:      (s) => set({ voiceState: s }),
  setVoiceProcess:    (s) => set({ voiceProcess: s }),
  setVoicePaused:     (b) => set({ voicePaused: b }),
  setVoiceTranscript: (t) => set({ voiceTranscript: t }),
  setCurrentResponse: (t) => set({ currentResponse: t }),

  // ── Chat ───────────────────────────────────────────────────────────────
  messages:    [],   // { id, role, content, timestamp, streaming? }
  isStreaming: false,
  streamingId: null,

  addMessage: (msg) =>
    set((s) => ({ messages: [...s.messages, msg] })),

  startStreaming: (id) =>
    set({ isStreaming: true, streamingId: id }),

  appendStream: (token) =>
    set((s) => ({
      messages: s.messages.map((m) =>
        m.id === s.streamingId ? { ...m, content: m.content + token } : m
      ),
      // Keep currentResponse in sync for VoiceDisplay
      currentResponse: (s.messages.find((m) => m.id === s.streamingId)?.content ?? "") + token,
    })),

  finalizeStream: () =>
    set((s) => ({
      isStreaming:  false,
      streamingId:  null,
      messages:     s.messages.map((m) =>
        m.id === s.streamingId ? { ...m, streaming: false } : m
      ),
    })),

  clearMessages: () =>
    set({ messages: [], isStreaming: false, streamingId: null, currentResponse: "" }),

  // ── Memory ─────────────────────────────────────────────────────────────
  memories:        [],
  memoriesLoading: false,

  setMemories:        (memories) => set({ memories }),
  setMemoriesLoading: (b)        => set({ memoriesLoading: b }),
  removeMemory: (id) =>
    set((s) => ({ memories: s.memories.filter((m) => m._id !== id) })),

  // ── Reminders ──────────────────────────────────────────────────────────
  reminders:        [],
  remindersLoading: false,

  setReminders:        (reminders) => set({ reminders }),
  setRemindersLoading: (b)         => set({ remindersLoading: b }),
  removeReminder: (id) =>
    set((s) => ({ reminders: s.reminders.filter((r) => r._id !== id) })),
  addReminder: (r) =>
    set((s) => ({ reminders: [r, ...s.reminders] })),

  // ── Actions feed ───────────────────────────────────────────────────────
  recentActions: [],  // { id, type, app, query, timestamp }

  addAction: (action) =>
    set((s) => ({
      recentActions: [
        { ...action, id: Date.now() },
        ...s.recentActions,
      ].slice(0, 50),
    })),

  // ── Toasts ─────────────────────────────────────────────────────────────
  toasts: [],

  addToast: ({ type = "info", message, duration = 3500 }) => {
    const id = Date.now();
    set((s) => ({ toasts: [...s.toasts, { id, type, message }] }));
    setTimeout(
      () => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
      duration,
    );
  },

  // ── Navigation (drawer-based) ──────────────────────────────────────────
  // null = closed; 'chat' | 'memory' | 'reminders' | 'actions' | 'settings'
  activeDrawer: null,
  setActiveDrawer: (d) =>
    set((s) => ({ activeDrawer: s.activeDrawer === d ? null : d })),
  closeDrawer: () => set({ activeDrawer: null }),

  // Legacy activeView — kept so existing panel components don't break
  activeView: "chat",
  setActiveView: (v) => set({ activeView: v }),

  // ── Expanded mode ──────────────────────────────────────────────────────
  isExpanded: false,
  setIsExpanded: (b) => {
    set({ isExpanded: b });
    if (b) window.aura?.expandWindow();
    else   window.aura?.compactWindow();
  },

  // ── Settings ───────────────────────────────────────────────────────────
  settings: {
    backendUrl:      "http://localhost:5000",
    wsUrl:           "ws://localhost:5001",
    model:           "mistral",
    ttsVoice:        "en-US-AriaNeural",
    theme:           "dark",
    hotkey:          "Ctrl+Shift+A",
    launchOnStartup: false,
    autoStartVoice:  false,
  },

  updateSettings: (patch) =>
    set((s) => ({ settings: { ...s.settings, ...patch } })),
}));

export default useStore;
