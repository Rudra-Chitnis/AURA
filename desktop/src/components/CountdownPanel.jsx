import { useEffect, useState, useCallback } from "react";

// ── Helpers ───────────────────────────────────────────────────────────────

/** Format seconds → MM:SS or HH:MM:SS for timers */
function fmtSecs(secs) {
  const s = Math.max(0, Math.round(secs));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/** Format a future ISO datetime → "in X min" / "in X hr Y min" */
function fmtReminder(fireAt) {
  const diffMs  = new Date(fireAt).getTime() - Date.now();
  const diffSec = Math.max(0, Math.floor(diffMs / 1000));
  if (diffSec < 60)  return "< 1 min";
  const mins = Math.floor(diffSec / 60);
  const hrs  = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs > 0) return `${hrs}h ${remM}m`;
  return `${mins}m`;
}

// ── Timer chip ────────────────────────────────────────────────────────────

const TimerChip = ({ timer, onCancel }) => {
  const urgent = timer.remainingSecs != null && timer.remainingSecs <= 30;

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
      style={{
        background: urgent
          ? "rgba(251,113,133,0.10)"
          : "rgba(96,165,250,0.07)",
        border: urgent
          ? "1px solid rgba(251,113,133,0.28)"
          : "1px solid rgba(96,165,250,0.18)",
        transition: "all 0.3s ease",
      }}
    >
      {/* Clock icon */}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
        stroke={urgent ? "#fb7185" : "#60a5fa"} strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>

      {/* Label */}
      <span style={{
        fontSize:      10,
        color:         urgent ? "#fb7185" : "#7a9fc2",
        letterSpacing: "0.02em",
        maxWidth:      80,
        overflow:      "hidden",
        textOverflow:  "ellipsis",
        whiteSpace:    "nowrap",
      }}>
        {timer.label}
      </span>

      {/* Countdown */}
      <span style={{
        fontSize:    10,
        fontVariantNumeric: "tabular-nums",
        fontWeight:  600,
        color:       urgent ? "#fb7185" : "#60a5fa",
        minWidth:    36,
        textAlign:   "right",
      }}>
        {fmtSecs(timer.remainingSecs ?? 0)}
      </span>

      {/* Cancel */}
      <button
        onClick={() => onCancel(timer.id)}
        style={{
          background:   "none",
          border:       "none",
          cursor:       "pointer",
          color:        "#444455",
          padding:      "0 1px",
          display:      "flex",
          alignItems:   "center",
          lineHeight:   1,
          fontSize:     10,
          transition:   "color 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#aaaacc")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "#444455")}
        title="Cancel timer"
      >
        ✕
      </button>
    </div>
  );
};

// ── Reminder chip ─────────────────────────────────────────────────────────

const ReminderChip = ({ reminder, onCancel }) => {
  const [label, setLabel] = useState(() => fmtReminder(reminder.fireAt));

  // Refresh label every 15s
  useEffect(() => {
    const id = setInterval(() => setLabel(fmtReminder(reminder.fireAt)), 15000);
    return () => clearInterval(id);
  }, [reminder.fireAt]);

  return (
    <div
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full"
      style={{
        background: "rgba(167,139,250,0.07)",
        border:     "1px solid rgba(167,139,250,0.18)",
      }}
    >
      {/* Bell icon */}
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none"
        stroke="#a78bfa" strokeWidth="2.5"
        strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      </svg>

      {/* Text */}
      <span style={{
        fontSize:      10,
        color:         "#9a85cc",
        letterSpacing: "0.02em",
        maxWidth:      90,
        overflow:      "hidden",
        textOverflow:  "ellipsis",
        whiteSpace:    "nowrap",
      }}>
        {reminder.text}
      </span>

      {/* Time until */}
      <span style={{
        fontSize:   10,
        fontWeight: 600,
        color:      "#a78bfa",
        minWidth:   28,
        textAlign:  "right",
      }}>
        {label}
      </span>

      {/* Cancel */}
      <button
        onClick={() => onCancel(reminder.id)}
        style={{
          background:   "none",
          border:       "none",
          cursor:       "pointer",
          color:        "#444455",
          padding:      "0 1px",
          display:      "flex",
          alignItems:   "center",
          lineHeight:   1,
          fontSize:     10,
          transition:   "color 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.color = "#aaaacc")}
        onMouseLeave={(e) => (e.currentTarget.style.color = "#444455")}
        title="Cancel reminder"
      >
        ✕
      </button>
    </div>
  );
};

// ── Main component ────────────────────────────────────────────────────────

const CountdownPanel = () => {
  const [timers,    setTimers]    = useState([]);
  const [reminders, setReminders] = useState([]);

  // Subscribe to IPC events from Electron TimerManager + ReminderManager
  useEffect(() => {
    if (!window.aura) return;

    // Seed on mount
    window.aura.listTimers?.().then(setTimers).catch(() => {});
    window.aura.listDesktopReminders?.().then(setReminders).catch(() => {});

    const cleanupTimer    = window.aura.onTimerTick?.(setTimers);
    const cleanupReminder = window.aura.onReminderUpdated?.(setReminders);

    // Also clear a timer from local state immediately when fired
    const cleanupFired = window.aura.onTimerFired?.((data) => {
      setTimers((prev) => prev.filter((t) => t.id !== data.id));
    });

    return () => {
      cleanupTimer?.();
      cleanupReminder?.();
      cleanupFired?.();
    };
  }, []);

  const cancelTimer = useCallback(async (id) => {
    try {
      await window.aura?.cancelTimer(id);
      setTimers((prev) => prev.filter((t) => t.id !== id));
    } catch {}
  }, []);

  const cancelReminder = useCallback(async (id) => {
    try {
      await window.aura?.cancelDesktopReminder(id);
      setReminders((prev) => prev.filter((r) => r.id !== id));
    } catch {}
  }, []);

  const hasItems = timers.length > 0 || reminders.length > 0;
  if (!hasItems) return null;

  return (
    <div
      style={{
        display:        "flex",
        alignItems:     "center",
        gap:            6,
        flexWrap:       "nowrap",
        overflowX:      "auto",
        padding:        "5px 14px",
        background:     "rgba(10,10,14,0.7)",
        borderTop:      "1px solid rgba(36,36,50,0.6)",
        scrollbarWidth: "none",
        flexShrink:     0,
        animation:      "fade-in 0.2s ease-out",
      }}
    >
      {timers.map((t) => (
        <TimerChip key={t.id} timer={t} onCancel={cancelTimer} />
      ))}
      {reminders.map((r) => (
        <ReminderChip key={r.id} reminder={r} onCancel={cancelReminder} />
      ))}
    </div>
  );
};

export default CountdownPanel;
