import { create } from "zustand";

const ASSISTANT_SCAFFOLD_RE = /(?:^(?:assistant|aura|output|narration|recent\s+conversation|question|user|human)\s*:\s*\S|^\[(?:user|human|you|assistant|aura)\]\s*:\s*\S|use\s+these\s+private\s+facts|use\s+this\s+recent\s+context|private\s+facts\s+only\s+when\s+relevant|recent\s+context\s+only\s+when\s+it\s+helps|the\s+user\s+asks\s*:|your\s+answer\s*:|here'?s?\s+(?:an?\s+)?example\s+(?:response|answer|reply)|questions?\s+and\s+answers?\s+for\s+you\s+to\s+practice|sample\s+(?:response|answer|question)|practice\s+question)/im;
const ASSISTANT_LABEL_RE = /^(?:\[(?:user|human|you|assistant|aura)\]|answer|response|spoken\s*response|output|narration|aura\w*|assistant|ai|bot|[qa]|personal|general|opinion|mixed|action)\s*:\s*/i;

const cleanAssistantMessage = (text) => {
  const cleaned = (text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(ASSISTANT_LABEL_RE, "")
    .trim();
  if (!cleaned || ASSISTANT_SCAFFOLD_RE.test(cleaned) || !/[A-Za-z]/.test(cleaned)) return "";
  return cleaned;
};

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
      messages:     s.messages
        .map((m) => {
          if (m.id !== s.streamingId) return m;
          const content = cleanAssistantMessage(m.content);
          return content ? { ...m, content, streaming: false } : null;
        })
        .filter(Boolean),
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

  // ── Debug / Observability ──────────────────────────────────────────────
  // Only populated when AURA_DEBUG=true.  Kept at max 50 events so the
  // panel never grows unbounded.
  debugEnabled: false,
  debugState: {
    intent:         null,   // last detected intent
    mode:           null,   // last classifyQuery mode
    memoriesCount:  null,   // last memory search result count
    contextPairs:   null,   // last deduped history pairs count
    ollamaState:    null,   // last Ollama event
    firstTokenMs:   null,   // last first-token latency (ms)
    sanitizerCount: 0,      // cumulative sanitizer triggers this session
    retryCount:     0,      // cumulative retries this session
    loopState:      null,   // last loop state (IDLE/LISTENING/THINKING/SPEAKING)
  },
  debugEvents: [],          // rolling 50-event log

  setDebugEnabled: (b) => set({ debugEnabled: b }),

  addDebugEvent: (evt) =>
    set((s) => {
      // Update live stat fields from the event
      const patch = {};
      const ds    = s.debugState;
      switch (evt.type) {
        case "intent":        patch.debugState = { ...ds, intent:        evt.resolved || evt.intent }; break;
        case "mode":          patch.debugState = { ...ds, mode:          evt.selected }; break;
        case "memory":        patch.debugState = { ...ds, memoriesCount: evt.count };   break;
        case "memory_gate":   patch.debugState = { ...ds, memoriesCount: evt.gatePass ? (ds.memoriesCount ?? 0) : 0 }; break;
        case "context":       patch.debugState = { ...ds, contextPairs:  evt.pairs };   break;
        case "ollama":        patch.debugState = { ...ds, ollamaState:   evt.event };   break;
        case "stream_event":
          if (evt.event === "first-token" && evt.ms != null)
            patch.debugState = { ...ds, firstTokenMs: evt.ms };
          break;
        case "sanitizer":     patch.debugState = { ...ds, sanitizerCount: (ds.sanitizerCount || 0) + (evt.count || 1) }; break;
        case "retry":         patch.debugState = { ...ds, retryCount: (ds.retryCount || 0) + 1 }; break;
        case "loop_state":    patch.debugState = { ...ds, loopState: evt.state }; break;
        default: break;
      }
      return {
        ...patch,
        debugEvents: [evt, ...s.debugEvents].slice(0, 50),
      };
    }),

  clearDebugEvents: () =>
    set({ debugEvents: [], debugState: {
      intent: null, mode: null, memoriesCount: null, contextPairs: null,
      ollamaState: null, firstTokenMs: null, sanitizerCount: 0, retryCount: 0, loopState: null,
    }}),

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

  updateSettings: (patch) => {
    set((s) => {
      const next = { ...s.settings, ...patch };
      // Persist to ~/.aura_settings via Electron IPC (best-effort)
      window.aura?.saveSettings(next);
      return { settings: next };
    });
  },

  // Hydrate settings from disk on startup — called once in App.jsx
  hydrateSettings: (saved) => {
    if (saved && typeof saved === "object") {
      set((s) => ({ settings: { ...s.settings, ...saved } }));
    }
  },
}));

export default useStore;
