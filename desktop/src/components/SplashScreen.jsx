import { useEffect, useRef, useState } from "react";

// ── Phase metadata ─────────────────────────────────────────────────────────
const PHASES = {
  "launching":        { label: "Launching",            pct: 5  },
  "starting-backend": { label: "Starting services",    pct: 30 },
  "loading-voice":    { label: "Loading voice engine", pct: 55 },
  "warming-models":   { label: "Warming up AI models", pct: 78 },
  "connecting":       { label: "Connecting",           pct: 92 },
  "ready":            { label: "Ready",                pct: 100 },
};

// ── Animated orb for the splash (self-contained, no store dep) ────────────
const SplashOrb = ({ phase }) => {
  const isPre = phase !== "ready";
  const color     = isPre ? "#4a9eff" : "#34d399";
  const colorRgb  = isPre ? "74,158,255" : "52,211,153";
  const dark      = isPre ? "#0a1628" : "#041a12";
  const mid       = isPre ? "#0f2040" : "#07281c";
  const size = 120;
  const c = size / 2;
  const r = size * 0.42;
  const ringR = size * 0.48;

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      {/* Ripple rings — always shown on splash */}
      {[0, 0.8, 1.6].map((delay, i) => (
        <div
          key={i}
          style={{
            position:     "absolute",
            inset:        0,
            borderRadius: "50%",
            border:       `1px solid rgba(${colorRgb},0.4)`,
            animation:    `orb-ripple 2.4s ease-out ${delay}s infinite`,
            pointerEvents:"none",
          }}
        />
      ))}

      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        style={{
          overflow:  "visible",
          animation: "orb-breathe-splash 3s ease-in-out infinite",
        }}
      >
        <defs>
          <radialGradient id="sp-sphere" cx="36%" cy="30%" r="68%">
            <stop offset="0%"   stopColor={color} stopOpacity="0.55" />
            <stop offset="35%"  stopColor={mid}   stopOpacity="1" />
            <stop offset="75%"  stopColor={dark}  stopOpacity="1" />
            <stop offset="100%" stopColor={dark}  stopOpacity="1" />
          </radialGradient>
          <radialGradient id="sp-specular" cx="30%" cy="22%" r="38%">
            <stop offset="0%"   stopColor="white" stopOpacity="0.22" />
            <stop offset="100%" stopColor="white" stopOpacity="0" />
          </radialGradient>
          <filter id="sp-glow" x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feComposite in="SourceGraphic" in2="blur" operator="over" />
          </filter>
        </defs>

        {/* Halo */}
        <circle
          cx={c} cy={c} r={size * 0.46}
          fill={`rgba(${colorRgb},0.07)`}
          filter="url(#sp-glow)"
        />

        {/* Outer ring */}
        <circle
          cx={c} cy={c} r={ringR}
          fill="none"
          stroke={`rgba(${colorRgb},0.35)`}
          strokeWidth="1"
          strokeDasharray="20 14 6 18"
          style={{ transformOrigin: `${c}px ${c}px`, animation: "ring-cw 8s linear infinite" }}
        />

        {/* Inner ring */}
        <circle
          cx={c} cy={c} r={ringR * 0.86}
          fill="none"
          stroke={color}
          strokeWidth="0.6"
          strokeDasharray="10 28"
          strokeOpacity="0.18"
          style={{ transformOrigin: `${c}px ${c}px`, animation: "ring-ccw 13s linear infinite" }}
        />

        {/* Core */}
        <circle cx={c} cy={c} r={r} fill="url(#sp-sphere)" />
        <circle cx={c} cy={c} r={r} fill="url(#sp-specular)" />

        {/* Centre pulse */}
        <circle
          cx={c} cy={c} r={3}
          fill={color}
          opacity="0.75"
          style={{ animation: "ring-pulse 2.6s ease-in-out infinite" }}
        />
      </svg>
    </div>
  );
};

// ── Progress dots ──────────────────────────────────────────────────────────
const ProgressDots = ({ phase }) => {
  const keys = Object.keys(PHASES).filter(k => k !== "ready");
  const currentIdx = keys.indexOf(phase);

  return (
    <div className="flex items-center gap-2">
      {keys.map((k, i) => {
        const done    = i < currentIdx;
        const current = i === currentIdx;
        return (
          <div
            key={k}
            style={{
              width:        current ? 18 : 6,
              height:       6,
              borderRadius: 3,
              background:   done    ? "rgba(74,158,255,0.6)"
                          : current ? "#4a9eff"
                          : "rgba(42,42,56,0.8)",
              transition:   "all 0.4s cubic-bezier(0.16,1,0.3,1)",
              boxShadow:    current ? "0 0 8px rgba(74,158,255,0.5)" : "none",
            }}
          />
        );
      })}
    </div>
  );
};

// ── Main SplashScreen ──────────────────────────────────────────────────────
const SplashScreen = ({ phase }) => {
  const [visible, setVisible]     = useState(true);
  const [fadingOut, setFadingOut] = useState(false);
  const [displayPhase, setDisplayPhase] = useState(phase);
  const [labelKey, setLabelKey]   = useState(0);  // used to retrigger fade-in

  // Animate label changes
  useEffect(() => {
    if (phase !== displayPhase) {
      setLabelKey(k => k + 1);
      setDisplayPhase(phase);
    }
  }, [phase]);

  // Trigger fade-out when ready
  useEffect(() => {
    if (phase === "ready") {
      // Small delay so user sees "Ready" for a moment
      const t = setTimeout(() => setFadingOut(true), 650);
      return () => clearTimeout(t);
    }
  }, [phase]);

  // Unmount after fade-out animation completes
  useEffect(() => {
    if (fadingOut) {
      const t = setTimeout(() => setVisible(false), 600);
      return () => clearTimeout(t);
    }
  }, [fadingOut]);

  if (!visible) return null;

  const meta = PHASES[displayPhase] || PHASES["launching"];

  return (
    <div
      style={{
        position:       "fixed",
        inset:          0,
        zIndex:         9999,
        background:     "#0c0c0f",
        display:        "flex",
        flexDirection:  "column",
        alignItems:     "center",
        justifyContent: "center",
        gap:            0,
        opacity:        fadingOut ? 0 : 1,
        transition:     fadingOut ? "opacity 0.55s cubic-bezier(0.4,0,1,1)" : "none",
        pointerEvents:  "none",
      }}
    >
      {/* Ambient radial glow behind orb */}
      <div
        style={{
          position:     "absolute",
          top:          "30%",
          left:         "50%",
          transform:    "translate(-50%, -50%)",
          width:        320,
          height:       320,
          borderRadius: "50%",
          background:   "radial-gradient(ellipse, rgba(74,158,255,0.06) 0%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* Orb */}
      <div style={{ animation: "float 6s ease-in-out infinite", marginBottom: 32 }}>
        <SplashOrb phase={displayPhase} />
      </div>

      {/* AURA wordmark */}
      <div
        className="text-center"
        style={{ marginBottom: 8 }}
      >
        <span
          style={{
            fontSize:      13,
            fontWeight:    700,
            letterSpacing: "0.3em",
            color:         "#4a9eff",
            textTransform: "uppercase",
          }}
        >
          AURA
        </span>
      </div>

      {/* Phase label — fades in on change */}
      <div style={{ height: 20, overflow: "hidden", marginBottom: 28 }}>
        <p
          key={labelKey}
          style={{
            fontSize:      12,
            color:         "#555566",
            letterSpacing: "0.04em",
            animation:     "fade-in 0.3s ease-out",
            textAlign:     "center",
          }}
        >
          {meta.label}
        </p>
      </div>

      {/* Progress dots */}
      <ProgressDots phase={displayPhase} />
    </div>
  );
};

export default SplashScreen;
