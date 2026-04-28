import { useEffect, useRef } from "react";
import useStore from "../store/useStore";

// ── Per-state config ──────────────────────────────────────────────────────
const STATE = {
  idle: {
    color:       "#4a9eff",
    colorRgb:    "74,158,255",
    dark:        "#0a1628",
    mid:         "#0f2040",
    glowAnim:    "orb-breathe 4s ease-in-out infinite",
    label:       "Ready",
    labelColor:  "#555566",
    ringOpacity: 0.22,
  },
  listening: {
    color:       "#34d399",
    colorRgb:    "52,211,153",
    dark:        "#041a12",
    mid:         "#07281c",
    glowAnim:    "orb-listen 1.5s ease-in-out infinite",
    label:       "Listening",
    labelColor:  "#34d399",
    ringOpacity: 0.32,
  },
  thinking: {
    color:       "#818cf8",
    colorRgb:    "129,140,248",
    dark:        "#0d0b24",
    mid:         "#160f38",
    glowAnim:    "orb-think 2s ease-in-out infinite",
    label:       "Thinking",
    labelColor:  "#818cf8",
    ringOpacity: 0.28,
  },
  speaking: {
    color:       "#60a5fa",
    colorRgb:    "96,165,250",
    dark:        "#060e22",
    mid:         "#0b1a38",
    glowAnim:    "orb-speak 0.75s ease-in-out infinite",
    label:       "Speaking",
    labelColor:  "#60a5fa",
    ringOpacity: 0.35,
  },
  executing: {
    color:       "#fbbf24",
    colorRgb:    "251,191,36",
    dark:        "#190e00",
    mid:         "#2a1800",
    glowAnim:    "orb-execute 0.5s ease-out forwards",
    label:       "Executing",
    labelColor:  "#fbbf24",
    ringOpacity: 0.4,
  },
};

// ── Waveform (speaking) ────────────────────────────────────────────────────
const Waveform = ({ color }) => (
  <div className="flex items-end justify-center gap-[3px]" style={{ height: 28 }}>
    {[...Array(10)].map((_, i) => (
      <div
        key={i}
        className="waveform-bar rounded-full"
        style={{
          width: 2.5,
          height: "100%",
          background: color,
          opacity: 0.75,
        }}
      />
    ))}
  </div>
);

// ── Ripple rings (listening) ───────────────────────────────────────────────
const Ripples = ({ color, size }) => (
  <>
    {[0, 0.7, 1.4].map((delay, i) => (
      <div
        key={i}
        style={{
          position:    "absolute",
          inset:       0,
          borderRadius: "50%",
          border:      `1px solid ${color}`,
          animation:   `orb-ripple 2.2s ease-out ${delay}s infinite`,
          pointerEvents: "none",
        }}
      />
    ))}
  </>
);

// ── Fast thinking arc (DOM element, avoids SVG transform-origin issues) ────
const ThinkArc = ({ color }) => (
  <div
    style={{
      position:     "absolute",
      inset:        -10,
      borderRadius: "50%",
      border:       "2px solid transparent",
      borderTopColor:   color,
      borderRightColor: `${color}55`,
      animation:    "ring-cw 0.85s linear infinite",
      pointerEvents: "none",
    }}
  />
);

// ── Main orb ──────────────────────────────────────────────────────────────
const OrbCore = ({ size = 180 }) => {
  const { voiceState, voiceTranscript, voicePaused } = useStore();
  const cfg  = STATE[voiceState] || STATE.idle;

  // Overlay label when paused — keep orb colours as-is (idle/blue) but
  // relabel so the user knows the mic is off.
  const displayLabel = voicePaused && voiceState === "idle"
    ? "Paused"
    : cfg.label;
  const displayLabelColor = voicePaused && voiceState === "idle"
    ? "#555566"
    : cfg.labelColor;
  const svgRef = useRef(null);

  // Swap glow animation on state change
  useEffect(() => {
    if (svgRef.current) {
      svgRef.current.style.animation = "none";
      // Force reflow to restart animation
      void svgRef.current.offsetWidth;
      svgRef.current.style.animation = cfg.glowAnim;
    }
  }, [voiceState, cfg.glowAnim]);

  const c = size / 2;
  const r = size * 0.42;   // sphere radius
  const ringR = size * 0.48; // outer ring radius

  // Unique gradient IDs per render (avoids conflicts if multiple orbs)
  const uid = "orb";

  return (
    <div
      className="flex flex-col items-center gap-3 select-none"
      style={{ animation: "float 7s ease-in-out infinite" }}
    >
      {/* Orb wrapper */}
      <div style={{ position: "relative", width: size, height: size }}>

        {/* Ripple rings — listening only */}
        {voiceState === "listening" && <Ripples color={cfg.color} size={size} />}

        {/* Thinking arc — DOM layer */}
        {voiceState === "thinking" && <ThinkArc color={cfg.color} />}

        {/* SVG orb */}
        <svg
          ref={svgRef}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{ overflow: "visible", animation: cfg.glowAnim }}
          aria-hidden="true"
        >
          <defs>
            {/* ─── Sphere gradient: light comes from top-left ─────────────── */}
            <radialGradient id={`${uid}-sphere`} cx="36%" cy="30%" r="68%">
              <stop offset="0%"   stopColor={cfg.color} stopOpacity="0.55" />
              <stop offset="35%"  stopColor={cfg.mid}   stopOpacity="1" />
              <stop offset="75%"  stopColor={cfg.dark}  stopOpacity="1" />
              <stop offset="100%" stopColor={cfg.dark}  stopOpacity="1" />
            </radialGradient>

            {/* ─── Specular highlight (glass shine) ─────────────────────── */}
            <radialGradient id={`${uid}-specular`} cx="30%" cy="22%" r="38%">
              <stop offset="0%"   stopColor="white" stopOpacity="0.22" />
              <stop offset="60%"  stopColor="white" stopOpacity="0.05" />
              <stop offset="100%" stopColor="white" stopOpacity="0" />
            </radialGradient>

            {/* ─── Rim light (subtle bottom-right edge) ────────────────── */}
            <radialGradient id={`${uid}-rim`} cx="72%" cy="78%" r="40%">
              <stop offset="0%"   stopColor={cfg.color} stopOpacity="0.18" />
              <stop offset="100%" stopColor={cfg.color} stopOpacity="0" />
            </radialGradient>

            {/* ─── Ambient inner glow ──────────────────────────────────── */}
            <radialGradient id={`${uid}-inner`} cx="50%" cy="50%" r="50%">
              <stop offset="0%"   stopColor={cfg.color} stopOpacity="0.08" />
              <stop offset="100%" stopColor={cfg.color} stopOpacity="0" />
            </radialGradient>

            {/* ─── Outer ring gradient ─────────────────────────────────── */}
            <linearGradient id={`${uid}-ring`} x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%"   stopColor={cfg.color} stopOpacity={cfg.ringOpacity * 2} />
              <stop offset="40%"  stopColor={cfg.color} stopOpacity={cfg.ringOpacity * 0.4} />
              <stop offset="100%" stopColor={cfg.color} stopOpacity={cfg.ringOpacity} />
            </linearGradient>

            {/* ─── Subtle glow filter ──────────────────────────────────── */}
            <filter id={`${uid}-glow`} x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feComposite in="SourceGraphic" in2="blur" operator="over" />
            </filter>
          </defs>

          {/* ── Ambient background halo ───────────────────────────────── */}
          <circle
            cx={c} cy={c} r={size * 0.46}
            fill={`rgba(${cfg.colorRgb},0.06)`}
            filter={`url(#${uid}-glow)`}
          />

          {/* ── Outer ring — slow CW ─────────────────────────────────── */}
          <circle
            cx={c} cy={c} r={ringR}
            fill="none"
            stroke={`url(#${uid}-ring)`}
            strokeWidth="1"
            strokeDasharray="30 18 8 24"
            style={{
              transformOrigin: `${c}px ${c}px`,
              animation: "ring-cw 9s linear infinite",
            }}
          />

          {/* ── Inner ring — slow CCW ─────────────────────────────────── */}
          <circle
            cx={c} cy={c} r={ringR * 0.88}
            fill="none"
            stroke={cfg.color}
            strokeWidth="0.6"
            strokeDasharray="12 36"
            strokeOpacity={cfg.ringOpacity * 0.6}
            style={{
              transformOrigin: `${c}px ${c}px`,
              animation: "ring-ccw 14s linear infinite",
            }}
          />

          {/* ── Core sphere ───────────────────────────────────────────── */}
          <circle
            cx={c} cy={c} r={r}
            fill={`url(#${uid}-sphere)`}
          />

          {/* ── Inner ambient glow overlay ──────────────────────────── */}
          <circle
            cx={c} cy={c} r={r}
            fill={`url(#${uid}-inner)`}
          />

          {/* ── Rim light ─────────────────────────────────────────────── */}
          <circle
            cx={c} cy={c} r={r}
            fill={`url(#${uid}-rim)`}
          />

          {/* ── Specular highlight ────────────────────────────────────── */}
          <circle
            cx={c} cy={c} r={r}
            fill={`url(#${uid}-specular)`}
          />

          {/* ── Center pulse dot ─────────────────────────────────────── */}
          <circle
            cx={c} cy={c} r={3.5}
            fill={cfg.color}
            opacity="0.7"
            style={{ animation: "ring-pulse 2.8s ease-in-out infinite" }}
          />
        </svg>
      </div>

      {/* Waveform — speaking only */}
      {voiceState === "speaking" && (
        <div style={{ animation: "fade-in 0.2s ease-out" }}>
          <Waveform color={cfg.color} />
        </div>
      )}

      {/* State label */}
      <div className="text-center" style={{ animation: "fade-in 0.2s ease-out" }}>
        <p
          className="text-[11px] font-medium tracking-[0.18em] uppercase"
          style={{ color: displayLabelColor, transition: "color 0.3s" }}
        >
          {displayLabel}
        </p>
      </div>
    </div>
  );
};

export default OrbCore;
