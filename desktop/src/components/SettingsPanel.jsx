import { useState } from "react";
import useStore from "../store/useStore";
import { setBaseUrl } from "../lib/api";
import { login, register } from "../lib/api";

const Section = ({ title, children }) => (
  <div className="space-y-3">
    <p className="text-xs font-semibold tracking-widest uppercase" style={{ color: "#444466" }}>
      {title}
    </p>
    <div className="space-y-2">{children}</div>
  </div>
);

const Row = ({ label, children }) => (
  <div className="flex items-center justify-between gap-4">
    <p className="text-sm flex-shrink-0" style={{ color: "#8888aa" }}>{label}</p>
    <div className="flex-1 text-right">{children}</div>
  </div>
);

const Toggle = ({ value, onChange }) => (
  <button
    onClick={() => onChange(!value)}
    className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
    style={{
      background: value ? "rgba(0,212,255,0.4)" : "rgba(30,30,53,0.9)",
      border: `1px solid ${value ? "rgba(0,212,255,0.4)" : "rgba(30,30,53,1)"}`,
    }}
  >
    <span
      className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
      style={{
        background: value ? "#00d4ff" : "#555577",
        left: value ? "calc(100% - 18px)" : "2px",
      }}
    />
  </button>
);

const SettingsPanel = () => {
  const {
    settings, updateSettings,
    user, token, isAuthenticated,
    setToken, setUser, logout,
    addToast,
  } = useStore();

  // Auth form
  const [authMode,  setAuthMode]  = useState("login");   // login | register
  const [email,     setEmail]     = useState("");
  const [password,  setPassword]  = useState("");
  const [name,      setName]      = useState("");
  const [authLoading, setAuthLoading] = useState(false);

  const handleAuth = async () => {
    if (!email || !password) return;
    setAuthLoading(true);
    try {
      let res;
      if (authMode === "login") {
        res = await login(email, password);
      } else {
        res = await register(name, email, password);
        addToast({ type: "success", message: "Account created! Please log in." });
        setAuthMode("login");
        setAuthLoading(false);
        return;
      }
      setToken(res.token);
      setUser(res.user);
      await window.aura?.saveToken(res.token);
      addToast({ type: "success", message: `Welcome back, ${res.user?.name || "Rudra"}!` });
    } catch (e) {
      addToast({ type: "error", message: e.message });
    } finally {
      setAuthLoading(false);
    }
  };

  const handleLogout = () => {
    logout();
    addToast({ type: "info", message: "Logged out" });
  };

  return (
    <div className="flex flex-col h-full overflow-y-auto px-4 py-4 gap-6">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "#f0f0ff" }}>Settings</h2>
        <p className="text-xs mt-0.5" style={{ color: "#8888aa" }}>Configure AURA</p>
      </div>

      {/* Auth section */}
      <Section title="Account">
        {isAuthenticated ? (
          <div className="rounded-xl px-4 py-3 flex items-center justify-between"
            style={{ background: "rgba(0,212,255,0.06)", border: "1px solid rgba(0,212,255,0.12)" }}>
            <div>
              <p className="text-sm font-medium" style={{ color: "#f0f0ff" }}>{user?.name || "User"}</p>
              <p className="text-xs" style={{ color: "#8888aa" }}>{user?.email}</p>
            </div>
            <button onClick={handleLogout} className="btn-danger">Sign out</button>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex gap-1 rounded-lg p-0.5" style={{ background: "rgba(10,10,20,0.8)", border: "1px solid #1e1e35" }}>
              {["login", "register"].map((m) => (
                <button
                  key={m}
                  onClick={() => setAuthMode(m)}
                  className="flex-1 py-1.5 text-xs rounded-md transition-all capitalize"
                  style={{
                    background: authMode === m ? "rgba(0,212,255,0.15)" : "transparent",
                    color:      authMode === m ? "#00d4ff" : "#8888aa",
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
            {authMode === "register" && (
              <input className="aura-input" placeholder="Name" value={name}
                onChange={(e) => setName(e.target.value)} />
            )}
            <input className="aura-input" placeholder="Email" type="email" value={email}
              onChange={(e) => setEmail(e.target.value)} />
            <input className="aura-input" placeholder="Password" type="password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAuth()} />
            <button
              onClick={handleAuth}
              disabled={authLoading}
              className="btn-primary w-full"
            >
              {authLoading ? "…" : authMode === "login" ? "Sign in" : "Create account"}
            </button>
          </div>
        )}
      </Section>

      {/* Backend */}
      <Section title="Backend">
        <div className="space-y-2">
          <Row label="Backend URL">
            <input
              className="aura-input text-right"
              value={settings.backendUrl}
              onChange={(e) => {
                updateSettings({ backendUrl: e.target.value });
                setBaseUrl(e.target.value);
              }}
              style={{ maxWidth: 220 }}
            />
          </Row>
          <Row label="WebSocket URL">
            <input
              className="aura-input text-right"
              value={settings.wsUrl}
              onChange={(e) => updateSettings({ wsUrl: e.target.value })}
              style={{ maxWidth: 220 }}
            />
          </Row>
        </div>
      </Section>

      {/* Model */}
      <Section title="AI Model">
        <Row label="Ollama model">
          <select
            className="aura-input"
            value={settings.model}
            onChange={(e) => updateSettings({ model: e.target.value })}
            style={{ maxWidth: 160, cursor: "pointer" }}
          >
            {["mistral", "llama2", "llama3", "gemma", "phi3", "codellama"].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </Row>
        <Row label="TTS voice">
          <select
            className="aura-input"
            value={settings.ttsVoice}
            onChange={(e) => updateSettings({ ttsVoice: e.target.value })}
            style={{ maxWidth: 200, cursor: "pointer" }}
          >
            {[
              "en-US-AriaNeural",
              "en-US-JennyNeural",
              "en-US-GuyNeural",
              "en-GB-SoniaNeural",
              "en-AU-NatashaNeural",
            ].map((v) => (
              <option key={v} value={v}>{v}</option>
            ))}
          </select>
        </Row>
      </Section>

      {/* App behavior */}
      <Section title="App Behavior">
        <Row label="Launch on startup">
          <Toggle value={settings.launchOnStartup} onChange={(v) => updateSettings({ launchOnStartup: v })} />
        </Row>
        <Row label="Auto-start voice">
          <Toggle value={settings.autoStartVoice} onChange={(v) => updateSettings({ autoStartVoice: v })} />
        </Row>
        <Row label="Global hotkey">
          <code className="text-xs px-2 py-1 rounded" style={{ background: "#1e1e35", color: "#00d4ff" }}>
            {settings.hotkey}
          </code>
        </Row>
      </Section>

      {/* About */}
      <Section title="About">
        <div className="rounded-xl px-4 py-3 space-y-1" style={{ background: "rgba(16,16,26,0.6)", border: "1px solid #1e1e35" }}>
          <p className="text-xs" style={{ color: "#8888aa" }}>AURA Desktop v1.0.0</p>
          <p className="text-xs" style={{ color: "#444466" }}>Built by Rudra Chitnis & Sadgi Garg</p>
          <p className="text-xs" style={{ color: "#444466" }}>Privacy-first · Local-only · Open source</p>
        </div>
      </Section>

      {/* Danger zone */}
      {isAuthenticated && (
        <Section title="Danger Zone">
          <button
            onClick={() => {
              if (confirm("Clear all chat messages?")) {
                useStore.getState().clearMessages();
                addToast({ type: "info", message: "Chat cleared" });
              }
            }}
            className="btn-danger w-full py-2"
          >
            Clear chat history
          </button>
        </Section>
      )}

      <div className="h-4" />
    </div>
  );
};

export default SettingsPanel;
