import { useEffect, useRef, useCallback, useState } from "react";
import OrbCore from "./OrbCore";
import useStore from "../store/useStore";

// ── Ambient background gradients per state ────────────────────────────────
const STATE_BG = {
  idle:      "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(74,158,255,0.055) 0%, transparent 70%)",
  listening: "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(52,211,153,0.07) 0%, transparent 70%)",
  thinking:  "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(129,140,248,0.065) 0%, transparent 70%)",
  speaking:  "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(96,165,250,0.07) 0%, transparent 70%)",
  executing: "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(251,191,36,0.08) 0%, transparent 70%)",
  sleeping:  "radial-gradient(ellipse 60% 40% at 50% 30%, rgba(85,85,102,0.04) 0%, transparent 70%)",
};

const STATE_STATUS = {
  idle:      { dot: "#4a9eff", label: "Ready",      pulse: false },
  listening: { dot: "#34d399", label: "Listening…", pulse: true  },
  thinking:  { dot: "#818cf8", label: "Thinking…",  pulse: true  },
  speaking:  { dot: "#60a5fa", label: "Speaking",   pulse: true  },
  executing: { dot: "#fbbf24", label: "Executing",  pulse: true  },
  sleeping:  { dot: "#555566", label: "Sleeping",   pulse: false },
};

// ── Icons ─────────────────────────────────────────────────────────────────
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

const WakeIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
    <circle cx="12" cy="12" r="4"/>
  </svg>
);

// ── Mic / sleep control strip ─────────────────────────────────────────────
const MicControls = ({ voicePaused, voiceProcess }) => {
  const { setVoicePaused, addToast } = useStore();

  const handlePause = useCallback(async () => {
    try {
      await window.aura?.pauseVoice();
      setVoicePaused(true);
    } catch {
      addToast({ type: "error", message: "Could not pause listening" });
    }
  }, []);

  const handleResume = useCallback(async () => {
    try {
      await window.aura?.resumeVoice();
      setVoicePaused(false);
    } catch {
      addToast({ type: "error", message: "Could not resume listening" });
    }
  }, []);

  const handleWake = useCallback(async () => {
    try {
      await window.aura?.voiceWake();
    } catch {
      addToast({ type: "error", message: "Could not wake voice pipeline" });
    }
  }, []);

  // Sleeping — show wake button only
  if (voiceProcess === "sleeping") {
    return (
      <div className="flex items-center gap-2" style={{ animation: "fade-in 0.25s ease-out" }}>
        <button
          onClick={handleWake}
          className="no-drag flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px]"
          style={{
            background:   "rgba(74,158,255,0.10)",
            border:       "1px solid rgba(74,158,255,0.30)",
            color:        "#4a9eff",
            cursor:       "pointer",
            transition:   "all 0.15s",
            letterSpacing:"0.03em",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(74,158,255,0.18)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "rgba(74,158,255,0.10)"; }}
          title="Wake AURA from sleep"
        >
          <WakeIcon />
          <span>Wake up</span>
        </button>
      </div>
    );
  }

  // Not running — nothing to show
  if (voiceProcess !== "running") return null;

  return (
    <div className="flex items-center gap-2" style={{ animation: "fade-in 0.2s ease-out" }}>
      {/* Pause / resume toggle */}
      <button
        onClick={voicePaused ? handleResume : handlePause}
        className="no-drag flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px]"
        style={{
          background:   voicePaused ? "rgba(251,191,36,0.12)" : "rgba(52,211,153,0.08)",
          border:       voicePaused ? "1px solid rgba(251,191,36,0.28)" : "1px solid rgba(52,211,153,0.2)",
          color:        voicePaused ? "#fbbf24" : "#34d399",
          cursor:       "pointer",
          transition:   "all 0.15s",
          letterSpacing:"0.02em",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.opacity = "0.8"; }}
        onMouseLeave={(e) => { e.currentTarget.style.opacity = "1"; }}
        title={voicePaused ? "Resume listening" : "Pause listening"}
      >
        {voicePaused ? <ResumeIcon /> : <PauseIcon />}
        <span>{voicePaused ? "Resume" : "Pause"}</span>
      </button>

      {/* Mic state indicator */}
      <div
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full"
        style={{ background: "rgba(12,12,15,0.6)", border: "1px solid rgba(42,42,56,0.5)" }}
      >
        <span style={{
          width:        6,
          height:       6,
          borderRadius: "50%",
          background:   voicePaused ? "#555566" : "#34d399",
          display:      "inline-block",
          flexShrink:   0,
          boxShadow:    voicePaused ? "none" : "0 0 5px #34d399",
          animation:    voicePaused ? "none" : "blink 1.4s ease-in-out infinite",
        }} />
        <span style={{
          fontSize:      11,
          color:         voicePaused ? "#444455" : "#34d399",
          letterSpacing: "0.03em",
          userSelect:    "none",
        }}>
          {voicePaused ? "Mic off" : "Mic on"}
        </span>
      </div>
    </div>
  );
};

// ── Last-turn transcript block ─────────────────────────────────────────────
// Shows the final user utterance and AURA's response for 15s after idle,
// then fades out.  Refreshed on every new completed speaking turn.

const GHOST_TTL = 15000;  // ms to show last-turn text after returning to idle

const LastTurnDisplay = ({ userText, auraText, visible }) => {
  if (!userText && !auraText) return null;

  return (
    <div
      className="px-8 w-full max-w-[380px] flex flex-col gap-2"
      style={{
        opacity:    visible ? 1 : 0,
        transition: "opacity 0.8s ease",
        pointerEvents: "none",
      }}
    >
      {userText && (
        <div className="flex items-start gap-2">
          {/* "You" label */}
          <span style={{
            fontSize:      9,
            letterSpacing: "0.08em",
            color:         "#34d399",
            textTransform: "uppercase",
            paddingTop:    2,
            flexShrink:    0,
            opacity:       0.7,
          }}>
            You
          </span>
          <p style={{
            fontSize:   12,
            lineHeight: 1.55,
            color:      "#6a6a7e",
            margin:     0,
            textAlign:  "left",
          }}>
            {userText}
          </p>
        </div>
      )}
      {auraText && (
        <div className="flex items-start gap-2">
          {/* "AURA" label */}
          <span style={{
            fontSize:      9,
            letterSpacing: "0.08em",
            color:         "#4a9eff",
            textTransform: "uppercase",
            paddingTop:    2,
            flexShrink:    0,
            opacity:       0.7,
          }}>
            AURA
          </span>
          <p style={{
            fontSize:   12,
            lineHeight: 1.55,
            color:      "#7a7a8e",
            margin:     0,
            textAlign:  "left",
          }}>
            {auraText.length > 160 ? auraText.slice(0, 157) + "…" : auraText}
          </p>
        </div>
      )}
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

  // ── Last-turn persistent display ────────────────────────────────────────
  // We capture the user's utterance when we enter thinking/speaking,
  // and the assistant's response when we leave speaking → idle.
  // The pair is shown for GHOST_TTL ms after idle starts.
  const [lastUser,    setLastUser]    = useState("");
  const [lastAura,    setLastAura]    = useState("");
  const [ghostVisible, setGhostVisible] = useState(false);
  const ghostTimer = useRef(null);

  // Capture user transcript when thinking starts
  const prevState = useRef(voiceState);
  useEffect(() => {
    const prev = prevState.current;
    const curr = voiceState;
    prevState.current = curr;

    if (curr === "thinking" && voiceTranscript) {
      setLastUser(voiceTranscript);
    }

    // When speaking ends → idle: capture response and start ghost timer
    if (prev === "speaking" && curr === "idle") {
      if (currentResponse?.trim()) {
        setLastAura(currentResponse.trim());
      }
      setGhostVisible(true);
      clearTimeout(ghostTimer.current);
      ghostTimer.current = setTimeout(() => setGhostVisible(false), GHOST_TTL);
    }

    // New listening cycle resets the ghost immediately
    if (curr === "listening") {
      clearTimeout(ghostTimer.current);
      setGhostVisible(false);
    }
  }, [voiceState, voiceTranscript, currentResponse]);

  useEffect(() => () => clearTimeout(ghostTimer.current), []);

  // Sleeping overrides everything
  const isSleeping = voiceProcess === "sleeping";

  // Effective visual state
  const effectiveState = isSleeping
    ? "sleeping"
    : (voicePaused && voiceState === "idle" ? "idle" : voiceState);

  const bg     = STATE_BG[effectiveState]     || STATE_BG.idle;
  const status = STATE_STATUS[effectiveState] || STATE_STATUS.idle;

  const statusLabel = isSleeping ? "Sleeping" : voicePaused ? "Paused" : status.label;
  const statusDot   = isSleeping ? "#555566"  : voicePaused ? "#555566" : status.dot;
  const statusPulse = isSleeping ? false       : voicePaused ? false     : status.pulse;

  // ── Live display text (active turn only) ────────────────────────────────
  const liveText = (() => {
    if (voiceState === "listening" && voiceTranscript) return `"${voiceTranscript}"`;
    if ((voiceState === "thinking" || voiceState === "speaking") && currentResponse) {
      const trimmed = currentResponse.trim();
      return trimmed.length > 140 ? trimmed.slice(0, 137) + "…" : trimmed;
    }
    if (voiceState === "thinking" && voiceTranscript) return `"${voiceTranscript}"`;
    return null;
  })();

  const showLive  = !!liveText;
  const showGhost = !showLive && !isSleeping && (lastUser || lastAura);

  return (
    <div
      className="flex-1 flex flex-col items-center justify-center relative overflow-hidden"
      style={{ background: bg, transition: "background 0.8s ease" }}
    >
      {/* Orb */}
      <div style={{ marginBottom: (showLive || showGhost) ? 14 : 24 }}>
        <OrbCore size={188} />
      </div>

      {/* ── Live transcript / response (active turn) ──────────────────── */}
      {showLive && (
        <div
          className="px-8 text-center max-w-[340px] mb-3"
          style={{ animation: "slide-up 0.25s cubic-bezier(0.16,1,0.3,1)" }}
        >
          <p className="text-[13px] leading-relaxed" style={{ color: "#7a7a8e" }}>
            {liveText}
            {isStreaming && voiceState === "speaking" && (
              <span style={{
                display:       "inline-block",
                width:         6,
                height:        13,
                background:    "#60a5fa",
                marginLeft:    3,
                verticalAlign: "middle",
                borderRadius:  1,
                animation:     "blink 0.7s step-end infinite",
              }} />
            )}
          </p>
        </div>
      )}

      {/* ── Persistent last-turn display (fades after GHOST_TTL) ─────── */}
      {showGhost && (
        <div className="mb-2 w-full flex justify-center" style={{ animation: "slide-up 0.3s ease-out" }}>
          <LastTurnDisplay
            userText={lastUser}
            auraText={lastAura}
            visible={ghostVisible}
          />
        </div>
      )}

      {/* ── Mic / wake controls ──────────────────────────────────────── */}
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
          <span style={{
            width:        7,
            height:       7,
            borderRadius: "50%",
            background:   statusDot,
            display:      "inline-block",
            flexShrink:   0,
            boxShadow:    statusPulse ? `0 0 6px ${statusDot}` : "none",
            animation:    statusPulse ? "blink 1.2s ease-in-out infinite" : "none",
          }} />
          <span style={{
            fontSize:      11,
            color:         "#9090aa",
            letterSpacing: "0.03em",
            userSelect:    "none",
          }}>
            {statusLabel}
          </span>
        </div>
      </div>
    </div>
  );
};

export default VoiceDisplay;
