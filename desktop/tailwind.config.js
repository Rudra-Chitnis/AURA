/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // ── Backgrounds ────────────────────────────────────────────────────
        base:    "#0c0c0f",   // window root
        panel:   "#111116",   // panel bg
        surface: "#18181f",   // card / elevated surface
        hover:   "#222230",   // hover state
        border:  "#2a2a38",   // default border
        // ── Text ───────────────────────────────────────────────────────────
        primary:   "#f0f0f8",
        secondary: "#888899",
        muted:     "#555566",
        dim:       "#333344",
        // ── Orb accent colors (calm, not neon) ────────────────────────────
        blue: {
          DEFAULT: "#4a9eff",
          dim:     "rgba(74,158,255,0.12)",
          soft:    "rgba(74,158,255,0.35)",
          glow:    "rgba(74,158,255,0.55)",
        },
        emerald: {
          DEFAULT: "#34d399",
          dim:     "rgba(52,211,153,0.12)",
          soft:    "rgba(52,211,153,0.35)",
          glow:    "rgba(52,211,153,0.55)",
        },
        indigo: {
          DEFAULT: "#818cf8",
          dim:     "rgba(129,140,248,0.12)",
          soft:    "rgba(129,140,248,0.35)",
          glow:    "rgba(129,140,248,0.55)",
        },
        sky: {
          DEFAULT: "#60a5fa",
          dim:     "rgba(96,165,250,0.12)",
          soft:    "rgba(96,165,250,0.35)",
        },
        amber: {
          DEFAULT: "#fbbf24",
          dim:     "rgba(251,191,36,0.12)",
          soft:    "rgba(251,191,36,0.35)",
        },
        // ── Status ─────────────────────────────────────────────────────────
        danger: "#f87171",
        success: "#34d399",
      },
      fontFamily: {
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "monospace"],
      },
      animation: {
        // Orb
        "orb-breathe":    "orb-breathe 4s ease-in-out infinite",
        "orb-listen":     "orb-listen 1.4s ease-in-out infinite",
        "orb-think":      "orb-think 2s ease-in-out infinite",
        "orb-speak":      "orb-speak 0.7s ease-in-out infinite",
        // Rings
        "ring-cw":        "ring-cw 8s linear infinite",
        "ring-ccw":       "ring-ccw 12s linear infinite",
        "ring-fast-cw":   "ring-cw 1s linear infinite",
        "ring-pulse":     "ring-pulse 2s ease-in-out infinite",
        // Ripples (listening)
        "ripple-1":       "orb-ripple 2.2s ease-out 0s infinite",
        "ripple-2":       "orb-ripple 2.2s ease-out 0.7s infinite",
        "ripple-3":       "orb-ripple 2.2s ease-out 1.4s infinite",
        // Waveform (speaking)
        "wave":           "wave 1.1s ease-in-out infinite",
        // Utility
        "float":          "float 7s ease-in-out infinite",
        "slide-up":       "slide-up 0.28s cubic-bezier(0.16,1,0.3,1)",
        "fade-in":        "fade-in 0.18s ease-out",
        "drawer-in":      "drawer-in 0.32s cubic-bezier(0.16,1,0.3,1)",
      },
      keyframes: {
        // Orb glow states
        "orb-breathe": {
          "0%,100%": { filter: "drop-shadow(0 0 14px rgba(74,158,255,0.3)) drop-shadow(0 0 32px rgba(74,158,255,0.1))" },
          "50%":      { filter: "drop-shadow(0 0 26px rgba(74,158,255,0.5)) drop-shadow(0 0 56px rgba(74,158,255,0.18))" },
        },
        "orb-listen": {
          "0%,100%": { filter: "drop-shadow(0 0 18px rgba(52,211,153,0.45)) drop-shadow(0 0 40px rgba(52,211,153,0.2))" },
          "50%":      { filter: "drop-shadow(0 0 32px rgba(52,211,153,0.7)) drop-shadow(0 0 70px rgba(52,211,153,0.35))" },
        },
        "orb-think": {
          "0%,100%": { filter: "drop-shadow(0 0 18px rgba(129,140,248,0.4)) drop-shadow(0 0 40px rgba(129,140,248,0.18))" },
          "50%":      { filter: "drop-shadow(0 0 30px rgba(129,140,248,0.65)) drop-shadow(0 0 64px rgba(129,140,248,0.3))" },
        },
        "orb-speak": {
          "0%,100%": { filter: "drop-shadow(0 0 16px rgba(96,165,250,0.5)) drop-shadow(0 0 36px rgba(96,165,250,0.25))" },
          "50%":      { filter: "drop-shadow(0 0 28px rgba(96,165,250,0.8)) drop-shadow(0 0 60px rgba(96,165,250,0.4))" },
        },
        // Rings
        "ring-cw": {
          from: { transform: "rotate(0deg)" },
          to:   { transform: "rotate(360deg)" },
        },
        "ring-ccw": {
          from: { transform: "rotate(360deg)" },
          to:   { transform: "rotate(0deg)" },
        },
        "ring-pulse": {
          "0%,100%": { opacity: "0.4", transform: "scale(1)" },
          "50%":     { opacity: "0.8", transform: "scale(1.04)" },
        },
        // Ripple
        "orb-ripple": {
          "0%":   { transform: "scale(1)",   opacity: "0.6" },
          "100%": { transform: "scale(2.4)", opacity: "0" },
        },
        // Waveform
        "wave": {
          "0%,100%": { transform: "scaleY(0.25)" },
          "50%":     { transform: "scaleY(1)" },
        },
        // Layout
        "float": {
          "0%,100%": { transform: "translateY(0px)" },
          "50%":     { transform: "translateY(-7px)" },
        },
        "slide-up": {
          from: { transform: "translateY(12px)", opacity: "0" },
          to:   { transform: "translateY(0)",    opacity: "1" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to:   { opacity: "1" },
        },
        "drawer-in": {
          from: { transform: "translateY(100%)", opacity: "0.6" },
          to:   { transform: "translateY(0)",    opacity: "1" },
        },
      },
      boxShadow: {
        "orb-blue":    "0 0 40px rgba(74,158,255,0.2), 0 0 80px rgba(74,158,255,0.08)",
        "orb-emerald": "0 0 40px rgba(52,211,153,0.25), 0 0 80px rgba(52,211,153,0.1)",
        "orb-indigo":  "0 0 40px rgba(129,140,248,0.25), 0 0 80px rgba(129,140,248,0.1)",
        "panel":       "0 8px 32px rgba(0,0,0,0.6), 0 2px 8px rgba(0,0,0,0.4)",
        "card":        "0 2px 12px rgba(0,0,0,0.5)",
        "drawer":      "0 -8px 40px rgba(0,0,0,0.7), 0 -2px 12px rgba(0,0,0,0.5)",
        "input":       "0 0 0 2px rgba(74,158,255,0.25)",
      },
    },
  },
  plugins: [],
};
