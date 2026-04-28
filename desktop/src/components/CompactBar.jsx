import { useState, useRef, useCallback } from "react";
import useStore from "../store/useStore";
import { askStream } from "../lib/api";

// ── SVG Icons ─────────────────────────────────────────────────────────────
const Icons = {
  Chat: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  ),
  Memory: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a10 10 0 1 0 10 10" />
      <path d="M12 6v6l4 2" />
      <circle cx="18" cy="6" r="4" fill="currentColor" fillOpacity="0.2" />
      <path d="M17 6h2M18 5v2" />
    </svg>
  ),
  Bell: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  ),
  Bolt: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  Settings: () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  Mic: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8"  y1="23" x2="16" y2="23" />
    </svg>
  ),
  MicOff: () => (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8"  y1="23" x2="16" y2="23" />
    </svg>
  ),
  Send: () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  ),
};

// ── Drawer button ─────────────────────────────────────────────────────────
const DrawerBtn = ({ id, icon: Icon, label, activeDrawer, onClick }) => {
  const isActive = activeDrawer === id;
  return (
    <button
      className={`icon-btn ${isActive ? "active" : ""}`}
      onClick={() => onClick(id)}
      title={label}
      aria-label={label}
    >
      <Icon />
    </button>
  );
};

// ── Main component ────────────────────────────────────────────────────────
const CompactBar = () => {
  const {
    activeDrawer,
    setActiveDrawer,
    voiceProcess,
    setVoiceProcess,
    isStreaming,
    addMessage,
    startStreaming,
    appendStream,
    finalizeStream,
    addToast,
  } = useStore();

  const [text, setText]           = useState("");
  const [inputFocused, setInputFocused] = useState(false);
  const inputRef = useRef(null);

  const voiceRunning = voiceProcess === "running";

  // ── Send text message via SSE stream ────────────────────────────────────
  const handleSend = useCallback(async () => {
    const msg = text.trim();
    if (!msg || isStreaming) return;

    setText("");

    const userMsg = { id: Date.now(), role: "user", content: msg, timestamp: new Date().toISOString() };
    addMessage(userMsg);

    const auraId = Date.now() + 1;
    addMessage({ id: auraId, role: "assistant", content: "", timestamp: new Date().toISOString(), streaming: true });
    startStreaming(auraId);

    // Build recent history (last 6 exchanges)
    const history = useStore.getState().messages
      .filter((m) => m.content && !m.streaming)
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      await askStream(
        msg,
        history,
        (token) => appendStream(token),
        ()      => finalizeStream(),
      );
    } catch (e) {
      finalizeStream();
      addToast({ type: "error", message: e.message || "Request failed" });
    }
  }, [text, isStreaming]);

  // ── Voice toggle ─────────────────────────────────────────────────────────
  const handleVoiceToggle = useCallback(async () => {
    if (voiceRunning) {
      await window.aura?.voiceStop();
      setVoiceProcess("stopped");
    } else {
      const result = await window.aura?.voiceStart();
      setVoiceProcess(result === "started" || result === "already_running" ? "running" : "error");
    }
  }, [voiceRunning]);

  const drawerButtons = [
    { id: "chat",      icon: Icons.Chat,     label: "Chat history" },
    { id: "memory",    icon: Icons.Memory,   label: "Memory" },
    { id: "reminders", icon: Icons.Bell,     label: "Reminders" },
    { id: "actions",   icon: Icons.Bolt,     label: "Recent actions" },
    { id: "settings",  icon: Icons.Settings, label: "Settings" },
  ];

  return (
    <div
      className="flex-shrink-0 px-3 pt-2 pb-3"
      style={{
        background:   "rgba(11,11,15,0.96)",
        borderTop:    "1px solid rgba(42,42,56,0.7)",
        backdropFilter: "blur(12px)",
      }}
    >
      {/* ── Text input row ─────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-2 mb-2 rounded-xl px-3"
        style={{
          background:   inputFocused ? "rgba(20,20,28,0.95)" : "rgba(16,16,22,0.8)",
          border:       inputFocused
            ? "1px solid rgba(74,158,255,0.35)"
            : "1px solid rgba(42,42,56,0.8)",
          transition:   "border-color 0.15s, background 0.15s",
          boxShadow:    inputFocused ? "0 0 0 2px rgba(74,158,255,0.08)" : "none",
        }}
      >
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            // Auto-resize
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 96) + "px";
          }}
          onFocus={() => setInputFocused(true)}
          onBlur={() => setInputFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder="Ask AURA anything…"
          rows={1}
          className="flex-1 resize-none bg-transparent outline-none py-2.5 text-[13px] leading-relaxed no-drag"
          style={{
            color:       "#d0d0e0",
            maxHeight:   96,
            fontFamily:  "inherit",
            overflowY:   "auto",
          }}
        />

        {/* Mic button */}
        <button
          onClick={handleVoiceToggle}
          className="no-drag flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-all"
          style={{
            background: voiceRunning
              ? "rgba(52,211,153,0.15)"
              : "transparent",
            color: voiceRunning ? "#34d399" : "#555566",
            border: voiceRunning
              ? "1px solid rgba(52,211,153,0.3)"
              : "1px solid transparent",
          }}
          title={voiceRunning ? "Stop voice" : "Start voice"}
        >
          {voiceRunning ? <Icons.MicOff /> : <Icons.Mic />}
        </button>

        {/* Send button — only when text present */}
        {text.trim() && (
          <button
            onClick={handleSend}
            disabled={isStreaming}
            className="no-drag flex-shrink-0 w-7 h-7 flex items-center justify-center rounded-lg transition-all"
            style={{
              background:  "rgba(74,158,255,0.18)",
              color:       "#4a9eff",
              border:      "1px solid rgba(74,158,255,0.3)",
            }}
            title="Send (Enter)"
          >
            <Icons.Send />
          </button>
        )}
      </div>

      {/* ── Drawer icon row ────────────────────────────────────────────── */}
      <div className="flex items-center justify-center gap-1 no-drag">
        {drawerButtons.map((btn) => (
          <DrawerBtn
            key={btn.id}
            {...btn}
            activeDrawer={activeDrawer}
            onClick={setActiveDrawer}
          />
        ))}
      </div>
    </div>
  );
};

export default CompactBar;
