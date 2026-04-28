import { useEffect, useState } from "react";
import useStore from "./store/useStore";
import { setToken as apiSetToken, setBaseUrl, healthCheck, login, register } from "./lib/api";
import useWebSocket from "./hooks/useWebSocket";

import TitleBar    from "./components/TitleBar";
import VoiceDisplay from "./components/VoiceDisplay";
import CompactBar  from "./components/CompactBar";
import DrawerPanel from "./components/DrawerPanel";
import ToastStack  from "./components/ToastStack";
import SplashScreen from "./components/SplashScreen";

// ── Auth card (shown when not logged in) ──────────────────────────────────
const AuthCard = () => {
  const { setToken, setUser, addToast } = useStore();
  const [mode, setMode]   = useState("login");
  const [name, setName]   = useState("");
  const [email, setEmail] = useState("");
  const [pass, setPass]   = useState("");
  const [busy, setBusy]   = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      let data;
      if (mode === "login") {
        data = await login(email, pass);
      } else {
        data = await register(name, email, pass);
      }
      await window.aura?.saveToken(data.token);
      apiSetToken(data.token);
      setToken(data.token);
      setUser(data.user);
    } catch (err) {
      addToast({ type: "error", message: err.message || "Auth failed" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="absolute inset-0 flex items-center justify-center z-50"
      style={{ background: "rgba(8,8,12,0.92)", backdropFilter: "blur(8px)" }}
    >
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-3 w-72"
        style={{
          background:   "rgba(18,18,25,0.98)",
          border:       "1px solid rgba(42,42,56,0.9)",
          borderRadius: 16,
          padding:      "28px 24px",
          boxShadow:    "0 8px 40px rgba(0,0,0,0.7)",
          animation:    "slide-up 0.3s cubic-bezier(0.16,1,0.3,1)",
        }}
      >
        <div className="flex flex-col items-center gap-1 mb-2">
          <span className="text-[13px] font-semibold tracking-[0.24em] uppercase"
            style={{ color: "#4a9eff" }}>
            AURA
          </span>
          <p className="text-[11px]" style={{ color: "#555566" }}>
            {mode === "login" ? "Sign in to continue" : "Create your account"}
          </p>
        </div>

        {mode === "register" && (
          <input
            className="aura-input no-drag"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        )}
        <input
          className="aura-input no-drag"
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoFocus={mode === "login"}
        />
        <input
          className="aura-input no-drag"
          type="password"
          placeholder="Password"
          value={pass}
          onChange={(e) => setPass(e.target.value)}
          required
          minLength={6}
        />

        <button
          type="submit"
          disabled={busy}
          className="btn-primary no-drag mt-1"
          style={{ width: "100%", justifyContent: "center" }}
        >
          {busy ? "…" : mode === "login" ? "Sign in" : "Create account"}
        </button>

        <button
          type="button"
          onClick={() => setMode(mode === "login" ? "register" : "login")}
          className="no-drag text-center text-[11px] transition-colors"
          style={{ background: "none", border: "none", color: "#555566", cursor: "pointer" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "#888899"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "#555566"; }}
        >
          {mode === "login" ? "No account? Register" : "Already have one? Sign in"}
        </button>
      </form>
    </div>
  );
};

// ── Backend offline banner ─────────────────────────────────────────────────
const OfflineBanner = ({ online }) => {
  if (online !== false) return null;
  return (
    <div
      className="flex items-center justify-center gap-1.5 flex-shrink-0 text-[11px]"
      style={{
        height:     24,
        background: "rgba(239,68,68,0.1)",
        borderBottom: "1px solid rgba(239,68,68,0.18)",
        color:      "#f87171",
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full bg-red-400 animate-pulse" />
      Backend offline — start Node.js server
    </div>
  );
};

// ── Main App ──────────────────────────────────────────────────────────────
export default function App() {
  const {
    settings,
    token,
    isAuthenticated,
    setToken,
    setUser,
    setVoiceProcess,
    setVoicePaused,
    startupPhase,
    setStartupPhase,
  } = useStore();

  const [backendOnline, setBackendOnline] = useState(null);

  // Connect WebSocket event hub
  useWebSocket();

  // Restore token from ~/.aura_token on launch
  useEffect(() => {
    (async () => {
      try {
        const saved = await window.aura?.getToken();
        if (saved) {
          setToken(saved);
          apiSetToken(saved);
        }
      } catch {}
    })();
  }, []);

  // Keep API lib in sync with token
  useEffect(() => { apiSetToken(token); }, [token]);

  // Sync backend URL
  useEffect(() => { setBaseUrl(settings.backendUrl); }, [settings.backendUrl]);

  // Backend health check every 12s (only after splash is done)
  useEffect(() => {
    const check = async () => setBackendOnline(await healthCheck());
    check();
    const id = setInterval(check, 12000);
    return () => clearInterval(id);
  }, [settings.backendUrl]);

  // ── Listen for startup phase events from Electron main process ─────────
  useEffect(() => {
    if (!window.aura) {
      // Running in browser / dev without Electron — skip splash immediately
      setStartupPhase("ready");
      return;
    }
    const cleanup = window.aura.onStartupPhase((phase) => {
      setStartupPhase(phase);
    });
    // Safety net: if Electron never sends "ready" within 90 s, unblock UI
    const timeout = setTimeout(() => setStartupPhase("ready"), 90000);
    return () => {
      cleanup?.();
      clearTimeout(timeout);
    };
  }, []);

  // ── Listen for voice process status from Electron main ────────────────
  useEffect(() => {
    const cleanup = window.aura?.onVoiceStatus((status) => setVoiceProcess(status));
    return cleanup;
  }, []);

  // ── Listen for voice paused state changes from Electron ───────────────
  useEffect(() => {
    const cleanup = window.aura?.onVoicePaused((paused) => setVoicePaused(paused));
    return cleanup;
  }, []);

  // Auto-start voice if configured (after authentication)
  useEffect(() => {
    if (settings.autoStartVoice && isAuthenticated) {
      window.aura?.voiceStart().then((r) => {
        if (r === "started" || r === "already_running") setVoiceProcess("running");
      });
    }
  }, [isAuthenticated]);

  return (
    <div
      className="flex flex-col"
      style={{
        height:     "100vh",
        width:      "100vw",
        overflow:   "hidden",
        background: "#0c0c0f",
        position:   "relative",
      }}
    >
      {/* Titlebar */}
      <TitleBar />

      {/* Optional offline banner */}
      <OfflineBanner online={backendOnline} />

      {/* Voice display (orb + transcript) */}
      <VoiceDisplay />

      {/* Bottom bar (text input + drawer triggers) */}
      <CompactBar />

      {/* Drawer overlay — rendered inside the window bounds */}
      <DrawerPanel />

      {/* Auth gate overlay — rendered on top of everything */}
      {!isAuthenticated && <AuthCard />}

      {/* Toast notifications */}
      <ToastStack />

      {/* Splash screen — shown during startup, disappears when ready */}
      <SplashScreen phase={startupPhase} />
    </div>
  );
}
