import { useEffect, useRef, useCallback } from "react";
import OrbCore from "./OrbCore";
import useStore from "../store/useStore";

// ── Ambient background gradients per state ────────────────────────────────
const STATE_BG = {
  idle:      "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(74,158,255,0.055) 0%, transparent 70%)",
  listening: "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(52,211,153,0.07) 0%, transparent 70%)",
  thinking:  "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(129,140,248,0.065) 0%, transparent 70%)",
  speaking:  "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(96,165,250,0.07) 0%, transparent 70%)",
  executing: "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(251,191,36,0.08) 0%, transparent 70%)",
};

const STATE_STATUS = {
  idle:      { dot: "#4a9eff", label: "Ready",      pulse: false },
  listening: { dot: "#34d399", label: "Listening…", pulse: true  },
  thinking:  { dot: "#818cf8", label: "Thinking…",  pulse: true  },
  speaking:  { dot: "#60a5fa", label: "Speaking",   pulse: true  },
  executing: { dot: "#fbbf24", label: "Executing",  pulse: true  },
};

// ── Pause / resume icon buttons ───────────────────────────────────────────
const PauseIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <rect x="6" y="4" width="4" height="16" rx="1" />
    <rect x="14" y="4" width="4" height="16" rx="1" />
  </svg>
);

const ResumeIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <polygon points="5,3 19,12 5,21" />
  </svg>
);

// ── Mic control strip ─────────────────────────────────────────────────────
const MicControls = ({ voicePaused, voiceProcess }) => {
  const { setVoicePaused, addToast } = useStore();

  const handlePause = useCallback(async () => {
    try {
      await window.aura?.pauseVoice();
      setVoicePaused(true);
    } catch (e) {
      addToast({ type: "error", message: "Could not pause listening" });
    }
  }, []);

  const handleResume = useCallback(async () => {
    try {
      await window.aura?.resumeVoice();
      setVoicePaused(false);
    } catch (e) {
      addToast({ type: "error", message: "Could not resume listening" });
    }
  }, []);

  if (voiceProcess !== "running") return null;

  return (
    <div
      className="flex items-center gap-2"
      style={{ animation: "fade-in 0.2s ease-out" }}
    >
      {/* Pause / resume toggle */}
      <button
        onClick={voicePaused ? handleResume : handlePause}
        className="no-drag flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px]"
        style={{
          background:   voicePaused
            ? "rgba(251,191,36,0.12)"
            : "rgba(52,211,153,0.08)",
          border:       voicePaused
            ? "1px solid rgba(251,191,36,0.28)"
            : "1px solid rgba(52,211,153,0.2)",
          color:        voicePaused ? "#fbbf24" : "#34d399",
          cursor:       "pointer",
          transition:   "all 0.15s",
          letterSpacing:"0.02em",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.opacity = "0.8";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.opacity = "1";
        }}
        title={voicePaused ? "Resume listening" : "Pause listening"}
      >
        {voicePaused ? <ResumeIcon /> : <PauseIcon />}
        <span>{voicePaused ? "Resume" : "Pause"}</span>
      </button>

      {/* Mic state indicator */}
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full"
        style={{
          background: "rgba(12,12,15,0.6)",
          border:     "1px solid rgba(42,42,56,0.5)",
        }}
      >
        <span
          style={{
            width:        6,
            height:       6,
            borderRadius: "50%",
            background:   voicePaused ? "#555566" : "#34d399",
            display:      "inline-block",
            flexShrink:   0,
            boxShadow:    voicePaused ? "none" : "0 0 5px #34d399",
            animation:    voicePaused ? "none" : "blink 1.4s ease-in-out infinite",
          }}
        />
        <span
          style={{
            fontSize:      11,
            color:         voicePaused ? "#444455" : "#34d399",
            letterSpacing: "0.03em",
            userSelect:    "none",
          }}
        >
          {voicePaused ? "Mic off" : "Mic on"}
        </span>
      </div>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────
const VoiceDisplay = () => {
  const {
    voiceState,
    voiceTranscript,
    currentResponse,
    isStreaming,
    voicePaused,
    voiceProcess,
  } = useStore();

  const transcriptRef = useRef(null);

  // Treat paused as a visual variant of idle
  const effectiveState = voicePaused && voiceState === "idle" ? "idle" : voiceState;

  const bg     = STATE_BG[effectiveState]     || STATE_BG.idle;
  const status = STATE_STATUS[effectiveState] || STATE_STATUS.idle;

  // Override label when paused
  const statusLabel = voicePaused
    ? "Paused"
    : status.label;
  const statusDot   = voicePaused ? "#555566" : status.dot;
  const statusPulse = voicePaused ? false : status.pulse;

  const displayText = (() => {
    if (voiceState === "listening" && voiceTranscript) return `"${voiceTranscript}"`;
    if ((voiceState === "thinking" || voiceState === "speaking") && currentResponse) {
      const trimmed = currentResponse.trim();
      return trimmed.length > 140 ? trimmed.slice(0, 137) + "…" : trimmed;
    }
    if (voiceState === "thinking" && voiceTranscript) return `"${voiceTranscript}"`;
    return null;
  })();

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center relative overflow-hidden"
      style={{
        background: bg,
        transition: "background 0.8s ease",
      }}
    >
      {/* Orb */}
      <div style={{ marginBottom: displayText ? 16 : 24 }}>
        <OrbCore size={188} />
      </div>

      {/* Transcript / response display */}
      {displayText && (
        <div
          ref={transcriptRef}
          className="px-8 text-center max-w-[340px] mb-3"
          style={{ animation: "slide-up 0.25s cubic-bezier(0.16,1,0.3,1)" }}
        >
          <p
            className="text-[13px] leading-relaxed"
            style={{ color: "#7a7a8e" }}
          >
            {displayText}
            {isStreaming && voiceState === "speaking" && (
              <span
                style={{
                  display:       "inline-block",
                  width:         6,
                  height:        13,
                  background:    "#60a5fa",
                  marginLeft:    3,
                  verticalAlign: "middle",
                  borderRadius:  1,
                  animation:     "blink 0.7s step-end infinite",
                }}
              />
            )}
          </p>
        </div>
      )}

      {/* ── Mic controls (pause/resume) ──────────────────────────────── */}
      <div
        className="absolute bottom-14 left-0 right-0 flex justify-center"
        style={{ pointerEvents: "auto" }}
      >
        <MicControls voicePaused={voicePaused} voiceProcess={voiceProcess} />
      </div>

      {/* ── Persistent status strip ──────────────────────────────────── */}
      <div
        className="absolute bottom-4 left-0 right-0 flex justify-center"
        style={{ pointerEvents: "none" }}
      >
        <div
          className="flex items-center gap-2 px-3 py-1.5 rounded-full"
          style={{
            background:     "rgba(12,12,15,0.72)",
            border:         "1px solid rgba(42,42,56,0.7)",
            backdropFilter: "blur(8px)",
          }}
        >
          <span
            style={{
              width:        7,
              height:       7,
              borderRadius: "50%",
              background:   statusDot,
              display:      "inline-block",
              flexShrink:   0,
              boxShadow:    statusPulse ? `0 0 6px ${statusDot}` : "none",
              animation:    statusPulse ? "blink 1.2s ease-in-out infinite" : "none",
            }}
          />
          <span
            style={{
              fontSize:      11,
              color:         "#9090aa",
              letterSpacing: "0.03em",
              userSelect:    "none",
            }}
          >
            {statusLabel}
          </span>
        </div>
      </div>
    </div>
  );
};

export default VoiceDisplay;
