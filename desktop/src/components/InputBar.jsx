import { useState, useRef, useCallback, useEffect } from "react";
import useStore from "../store/useStore";
import { askStream } from "../lib/api";

const SUGGESTIONS = [
  "What do you know about me?",
  "Set a reminder for tomorrow at 9am",
  "Play lofi on Spotify",
  "Open YouTube",
  "What's on my mind lately?",
];

const InputBar = () => {
  const [text, setText]         = useState("");
  const [loading, setLoading]   = useState(false);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const inputRef = useRef(null);

  const {
    messages,
    isStreaming,
    addMessage,
    startStreaming,
    appendStream,
    finalizeStream,
    voiceProcess,
    setVoiceProcess,
    addToast,
    voiceState,
  } = useStore();

  const send = useCallback(async (query) => {
    const q = (query || text).trim();
    if (!q || loading || isStreaming) return;
    setText("");

    const userMsgId = `user-${Date.now()}`;
    const auraMsgId = `aura-${Date.now() + 1}`;

    // Add user message
    addMessage({
      id:        userMsgId,
      role:      "user",
      content:   q,
      timestamp: new Date().toISOString(),
    });

    // Add empty AURA message for streaming
    addMessage({
      id:        auraMsgId,
      role:      "assistant",
      content:   "",
      timestamp: new Date().toISOString(),
      streaming: true,
    });
    startStreaming(auraMsgId);
    setLoading(true);

    // Build history (last 6 messages, skip the empty streaming one)
    const history = messages
      .filter((m) => m.content && !m.streaming)
      .slice(-6)
      .map((m) => ({ role: m.role, content: m.content }));

    try {
      await askStream(
        q,
        history,
        (token) => appendStream(token),
        ()      => { finalizeStream(); setLoading(false); }
      );
    } catch (err) {
      finalizeStream();
      setLoading(false);
      // Replace empty AURA message with error
      addToast({ type: "error", message: `Error: ${err.message}`, duration: 5000 });
    }
  }, [text, loading, isStreaming, messages, addMessage, startStreaming, appendStream, finalizeStream, addToast]);

  const handleKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const toggleVoice = async () => {
    if (voiceProcess === "running") {
      await window.aura?.voiceStop();
      setVoiceProcess("stopped");
      addToast({ type: "info", message: "Voice mode stopped" });
    } else {
      const result = await window.aura?.voiceStart();
      if (result === "started") {
        setVoiceProcess("running");
        addToast({ type: "success", message: "Voice mode started — press Enter in terminal to speak" });
      } else {
        addToast({ type: "error", message: "Could not start voice mode. Is voice.py present?" });
      }
    }
  };

  // Focus on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  const isVoiceOn   = voiceProcess === "running";
  const isBusy      = loading || isStreaming;
  const voiceActive = voiceState === "listening" || voiceState === "speaking" || voiceState === "thinking";

  return (
    <div className="flex-shrink-0 px-4 pb-4 pt-2">
      {/* Quick suggestions (only when empty + not busy) */}
      {!text && !isBusy && (
        <div className="flex gap-2 mb-3 flex-wrap">
          {SUGGESTIONS.slice(0, 3).map((s) => (
            <button
              key={s}
              onClick={() => send(s)}
              className="px-3 py-1 rounded-full text-xs transition-all"
              style={{
                background: "rgba(0,212,255,0.06)",
                border: "1px solid rgba(0,212,255,0.12)",
                color: "#8888aa",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.color = "#00d4ff";
                e.currentTarget.style.borderColor = "rgba(0,212,255,0.3)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.color = "#8888aa";
                e.currentTarget.style.borderColor = "rgba(0,212,255,0.12)";
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {/* Input row */}
      <div
        className="flex items-end gap-2 rounded-2xl p-1"
        style={{
          background: "rgba(10,10,20,0.9)",
          border: isBusy
            ? "1px solid rgba(0,212,255,0.35)"
            : "1px solid rgba(30,30,53,0.9)",
          boxShadow: isBusy ? "0 0 12px rgba(0,212,255,0.1)" : "none",
          transition: "border-color 0.3s, box-shadow 0.3s",
        }}
      >
        {/* Textarea */}
        <textarea
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKey}
          placeholder={isBusy ? "AURA is responding…" : "Ask AURA anything…"}
          disabled={isBusy}
          rows={1}
          className="flex-1 bg-transparent outline-none resize-none px-3 py-2.5"
          style={{
            color: "#f0f0ff",
            fontSize: 14,
            lineHeight: "1.5",
            maxHeight: 120,
            minHeight: 40,
            overflow: "auto",
            caretColor: "#00d4ff",
          }}
          onInput={(e) => {
            e.target.style.height = "auto";
            e.target.style.height = Math.min(e.target.scrollHeight, 120) + "px";
          }}
        />

        {/* Voice toggle button */}
        <button
          onClick={toggleVoice}
          title={isVoiceOn ? "Stop voice mode" : "Start voice mode"}
          className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl mb-0.5 transition-all"
          style={{
            background: isVoiceOn
              ? voiceActive
                ? "rgba(16,185,129,0.25)"
                : "rgba(16,185,129,0.15)"
              : "rgba(255,255,255,0.04)",
            border: isVoiceOn
              ? "1px solid rgba(16,185,129,0.4)"
              : "1px solid rgba(255,255,255,0.06)",
            color: isVoiceOn ? "#10b981" : "#555577",
          }}
        >
          {/* Mic icon */}
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" y1="19" x2="12" y2="23"/>
            <line x1="8"  y1="23" x2="16" y2="23"/>
          </svg>
          {/* Pulse ring when listening */}
          {voiceActive && (
            <span
              className="absolute inset-0 rounded-xl"
              style={{ animation: "orb-ripple 1.5s ease-out infinite", border: "1px solid #10b981" }}
            />
          )}
        </button>

        {/* Send button */}
        <button
          onClick={() => send()}
          disabled={!text.trim() || isBusy}
          className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-xl mb-0.5 transition-all"
          style={{
            background: text.trim() && !isBusy
              ? "linear-gradient(135deg, rgba(0,212,255,0.25), rgba(124,58,237,0.2))"
              : "rgba(255,255,255,0.03)",
            border: text.trim() && !isBusy
              ? "1px solid rgba(0,212,255,0.35)"
              : "1px solid rgba(255,255,255,0.06)",
            color: text.trim() && !isBusy ? "#00d4ff" : "#333355",
            cursor: text.trim() && !isBusy ? "pointer" : "default",
          }}
        >
          {isBusy ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "ring-spin-cw 1s linear infinite" }}>
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25"/>
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2"/>
            </svg>
          )}
        </button>
      </div>

      <p className="text-center mt-2" style={{ fontSize: 10, color: "#333355" }}>
        Enter to send · Shift+Enter for newline · Ctrl+Shift+A to show AURA
      </p>
    </div>
  );
};

export default InputBar;
