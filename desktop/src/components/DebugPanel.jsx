/**
 * DebugPanel.jsx
 *
 * Live forensic debug overlay for AURA.
 * Only rendered when AURA_DEBUG=true (checked via window.aura.getDebugMode()).
 *
 * Data sources:
 *   Node.js backend  → WebSocket "debug:*" events → useStore debugEvents
 *   Python voice.py  → stdout AURA:DEBUG: → Electron IPC "debug-event" → useStore
 *
 * Displays:
 *   - Live stat tiles: intent, mode, memories, context, Ollama, latency,
 *     sanitizer trigger count, retry count, loop state
 *   - Rolling 50-event log with type-coded color badges
 *   - Clear button
 */

import { useEffect, useRef } from "react";
import useStore from "../store/useStore";

// ─────────────────────────────────────────────────────────────────────────────
// COLOR MAP — badge colors per event type
// ─────────────────────────────────────────────────────────────────────────────
const TYPE_COLORS = {
  mode:           "#a855f7",   // purple
  intent:         "#06b6d4",   // cyan
  identity:       "#e879f9",   // pink-purple
  memory:         "#22c55e",   // green
  memory_gate:    "#facc15",   // yellow
  memory_search:  "#4ade80",   // light green
  context:        "#94a3b8",   // slate
  prompt:         "#3b82f6",   // blue
  llm_raw:        "#60a5fa",   // light blue
  sanitizer:      "#ef4444",   // red
  contamination:  "#dc2626",   // dark red
  stream_event:   "#22d3ee",   // cyan
  stream_start:   "#67e8f9",   // light cyan
  ollama:         "#86efac",   // light green
  action_route:   "#fdba74",   // orange
  passive_intent: "#fb923c",   // orange-red
  history_filter: "#fbbf24",   // amber
  loop_state:     "#f8fafc",   // white
  malformed:      "#f87171",   // light red
  retry:          "#fca5a5",   // pink-red
  stt:            "#a5f3fc",   // light cyan
  vad:            "#d1fae5",   // mint
  py_session_start: "#bbf7d0", // green-tint
  py_session_end:   "#fecaca", // red-tint
  session_start:    "#bbf7d0",
};

const badgeColor = (type) => TYPE_COLORS[type] || "#64748b";

// ─────────────────────────────────────────────────────────────────────────────
// STAT TILE
// ─────────────────────────────────────────────────────────────────────────────
function StatTile({ label, value, color = "#94a3b8", mono = false }) {
  return (
    <div style={{
      background: "rgba(15,23,42,0.85)",
      border:     "1px solid rgba(148,163,184,0.15)",
      borderRadius: 6,
      padding:    "6px 10px",
      minWidth:   90,
    }}>
      <div style={{ fontSize: 9, color: "#64748b", textTransform: "uppercase", letterSpacing: 1 }}>
        {label}
      </div>
      <div style={{
        fontSize:   13,
        color:      color,
        fontFamily: mono ? "monospace" : "inherit",
        fontWeight: 600,
        marginTop:  2,
        overflow:   "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        maxWidth:   130,
      }}>
        {value ?? "—"}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT ROW
// ─────────────────────────────────────────────────────────────────────────────
function EventRow({ evt }) {
  const color = badgeColor(evt.type);
  const ts    = evt.ts
    ? evt.ts.split(" ")[1]?.slice(0, 12) ?? evt.ts
    : "";

  // Build a one-line summary from the most useful fields
  let summary = "";
  switch (evt.type) {
    case "mode":         summary = `${evt.selected}  triggers=[${(evt.triggers||[]).join(",")}]`; break;
    case "intent":       summary = `${evt.resolved || evt.intent}  stage=${evt.stage ?? "?"}${evt.reason ? "  " + evt.reason : ""}`; break;
    case "identity":     summary = `entities=${evt.entityCount}  owner=${evt.isOwnerQuery}`; break;
    case "memory":       summary = `count=${evt.count}  ownerRef=${evt.ownerRef}  threshold=${evt.threshold}`; break;
    case "memory_gate":  summary = `${evt.gatePass ? "SEARCH" : "SKIP"}  type=${evt.queryType}  identity=${evt.isIdentity}`; break;
    case "context":      summary = `pairs_kept=${evt.pairs}  dropped=${evt.dropped}`; break;
    case "prompt":       summary = `type=${evt.queryType}  identity=${evt.identityActive}  mem=${evt.memoriesCount}  tokens≈${evt.tokenEst}`; break;
    case "ollama":       summary = `${evt.event}${evt.ms != null ? "  " + evt.ms + "ms" : ""}${evt.detail ? "  " + evt.detail : ""}`; break;
    case "stream_event": summary = `${evt.event}${evt.ms != null ? "  " + evt.ms + "ms" : ""}${evt.tokenCount != null ? "  tokens=" + evt.tokenCount : ""}${evt.detail ? "  " + evt.detail : ""}`; break;
    case "stream_start": summary = `query=${repr(evt.query, 40)}`; break;
    case "sanitizer":    summary = `removed=${evt.count}`; break;
    case "contamination":summary = `${evt.type_}  location=${evt.location}  match=${repr(evt.match, 40)}`; break;
    case "history_filter":summary= `[${evt.action}] ${evt.reason}  "${(evt.preview||"").slice(0,40)}"`; break;
    case "loop_state":   summary = `${evt.state}${evt.detail ? "  " + evt.detail : ""}`; break;
    case "malformed":    summary = `${evt.reason}  "${(evt.preview||"").slice(0,40)}"`; break;
    case "retry":        summary = `attempt=${evt.attempt}/${evt.maxAttempts}  ${evt.reason}`; break;
    case "stt":          summary = `raw="${(evt.raw||"").slice(0,40)}"${evt.dropped ? "  DROPPED" : ""}`; break;
    case "action_route": summary = `stage=${evt.stage}  app=${evt.appKey}  ${evt.reason}`; break;
    default:             summary = JSON.stringify(evt).slice(0, 80);
  }

  return (
    <div style={{
      display:       "flex",
      alignItems:    "baseline",
      gap:           6,
      padding:       "2px 0",
      borderBottom:  "1px solid rgba(255,255,255,0.04)",
      fontFamily:    "monospace",
      fontSize:      11,
    }}>
      <span style={{ color: "#475569", minWidth: 70, flexShrink: 0 }}>{ts}</span>
      <span style={{
        background:   color + "22",
        color,
        border:       `1px solid ${color}44`,
        borderRadius: 3,
        padding:      "0 4px",
        fontSize:     9,
        fontWeight:   700,
        textTransform: "uppercase",
        minWidth:     80,
        textAlign:    "center",
        flexShrink:   0,
      }}>
        {evt.source === "python" ? "py" : "js"}:{evt.type}
      </span>
      <span style={{ color: "#cbd5e1", flexShrink: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {summary}
      </span>
    </div>
  );
}

function repr(s, max = 60) {
  if (!s) return "—";
  const t = String(s);
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PANEL
// ─────────────────────────────────────────────────────────────────────────────
export default function DebugPanel() {
  const { debugState, debugEvents, clearDebugEvents, addDebugEvent } = useStore();
  const scrollRef = useRef(null);

  // Subscribe to Electron IPC debug-event (from Python voice.py via main.js)
  useEffect(() => {
    if (!window.aura?.onDebugEvent) return;
    const unsub = window.aura.onDebugEvent((payload) => {
      addDebugEvent(payload);
    });
    return unsub;
  }, [addDebugEvent]);

  // Auto-scroll event log to top on new events
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [debugEvents.length]);

  const ds = debugState;

  return (
    <div style={{
      position:      "fixed",
      bottom:        0,
      right:         0,
      width:         480,
      maxHeight:     "60vh",
      background:    "rgba(2,6,23,0.97)",
      border:        "1px solid rgba(99,102,241,0.4)",
      borderBottom:  "none",
      borderRight:   "none",
      borderRadius:  "8px 0 0 0",
      zIndex:        9999,
      display:       "flex",
      flexDirection: "column",
      fontFamily:    "'Inter', system-ui, sans-serif",
      fontSize:      12,
      color:         "#e2e8f0",
      boxShadow:     "0 -4px 32px rgba(99,102,241,0.15)",
      userSelect:    "text",
    }}>

      {/* Header */}
      <div style={{
        display:        "flex",
        alignItems:     "center",
        justifyContent: "space-between",
        padding:        "6px 12px",
        borderBottom:   "1px solid rgba(99,102,241,0.25)",
        background:     "rgba(99,102,241,0.12)",
        flexShrink:     0,
      }}>
        <span style={{ fontWeight: 700, fontSize: 11, color: "#818cf8", letterSpacing: 1 }}>
          ⬡ AURA DEBUG
        </span>
        <button
          onClick={clearDebugEvents}
          style={{
            background:   "transparent",
            border:       "1px solid rgba(148,163,184,0.2)",
            color:        "#64748b",
            borderRadius: 4,
            padding:      "1px 8px",
            fontSize:     10,
            cursor:       "pointer",
          }}
        >
          clear
        </button>
      </div>

      {/* Live stat tiles */}
      <div style={{
        display:    "flex",
        flexWrap:   "wrap",
        gap:        6,
        padding:    "8px 10px",
        borderBottom: "1px solid rgba(255,255,255,0.06)",
        flexShrink: 0,
      }}>
        <StatTile label="State"     value={ds.loopState}      color="#f8fafc" />
        <StatTile label="Intent"    value={ds.intent}         color="#06b6d4" mono />
        <StatTile label="Mode"      value={ds.mode}           color="#a855f7" mono />
        <StatTile label="Memories"  value={ds.memoriesCount}  color="#22c55e" />
        <StatTile label="Ctx Pairs" value={ds.contextPairs}   color="#94a3b8" />
        <StatTile label="Ollama"    value={ds.ollamaState}    color="#86efac" mono />
        <StatTile label="1st Token" value={ds.firstTokenMs != null ? `${ds.firstTokenMs}ms` : null} color="#22d3ee" />
        <StatTile label="Sanitizer" value={ds.sanitizerCount || 0} color="#ef4444" />
        <StatTile label="Retries"   value={ds.retryCount     || 0} color="#fca5a5" />
      </div>

      {/* Event log */}
      <div
        ref={scrollRef}
        style={{
          overflowY:  "auto",
          flex:       1,
          padding:    "4px 10px",
          minHeight:  0,
        }}
      >
        {debugEvents.length === 0 ? (
          <div style={{ color: "#475569", padding: "12px 0", textAlign: "center", fontSize: 11 }}>
            Waiting for debug events… (AURA_DEBUG=true)
          </div>
        ) : (
          debugEvents.map((evt, i) => <EventRow key={i} evt={evt} />)
        )}
      </div>
    </div>
  );
}
