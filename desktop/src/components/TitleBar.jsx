import useStore from "../store/useStore";

// Voice process indicator dot
const VoiceDot = ({ status, paused }) => {
  const dotColor = paused
    ? "#555566"
    : {
        running: "#34d399",
        error:   "#f87171",
        stopped: "#333344",
      }[status] || "#333344";

  const pulse = status === "running" && !paused;

  return (
    <span
      style={{
        display:      "inline-block",
        width:        6,
        height:       6,
        borderRadius: "50%",
        background:   dotColor,
        animation:    pulse ? "ring-pulse 2s ease-in-out infinite" : "none",
        boxShadow:    pulse ? `0 0 6px ${dotColor}` : "none",
        transition:   "background 0.3s, box-shadow 0.3s",
      }}
    />
  );
};

// Generic window control button
const WinBtn = ({ children, onClick, title, hoverBg = "#222230", hoverColor }) => (
  <button
    onClick={onClick}
    title={title}
    style={{
      width:          26,
      height:         24,
      display:        "flex",
      alignItems:     "center",
      justifyContent: "center",
      borderRadius:   6,
      border:         "none",
      background:     "transparent",
      color:          "#555566",
      cursor:         "pointer",
      transition:     "background 0.12s, color 0.12s",
    }}
    onMouseEnter={(e) => {
      e.currentTarget.style.background = hoverBg;
      e.currentTarget.style.color = hoverColor || "#c8c8d8";
    }}
    onMouseLeave={(e) => {
      e.currentTarget.style.background = "transparent";
      e.currentTarget.style.color = "#555566";
    }}
  >
    {children}
  </button>
);

const TitleBar = () => {
  const { voiceProcess, voicePaused } = useStore();

  return (
    <div
      className="drag-region flex items-center justify-between flex-shrink-0"
      style={{
        height:       32,
        paddingLeft:  14,
        paddingRight: 8,
        background:   "rgba(8,8,12,0.97)",
        borderBottom: "1px solid rgba(42,42,56,0.6)",
      }}
    >
      {/* Left: wordmark + voice status */}
      <div className="no-drag flex items-center gap-2">
        <span
          className="text-[11px] font-semibold tracking-[0.22em] uppercase"
          style={{ color: "#4a9eff", letterSpacing: "0.22em" }}
        >
          AURA
        </span>
        <VoiceDot status={voiceProcess} paused={voicePaused} />
      </div>

      {/* Center: drag zone */}
      <div className="flex-1" />

      {/* Right: window controls */}
      <div className="no-drag flex items-center gap-0.5">
        {/* Minimize */}
        <WinBtn
          title="Minimize"
          onClick={() => window.aura?.minimize()}
          hoverBg="#222230"
        >
          <svg width="10" height="1.5" viewBox="0 0 10 1.5" fill="currentColor">
            <rect width="10" height="1.5" rx="0.75" />
          </svg>
        </WinBtn>

        {/* Hide to tray (X) */}
        <WinBtn
          title="Hide to tray"
          onClick={() => window.aura?.close()}
          hoverBg="#222230"
          hoverColor="#c8c8d8"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <line x1="1" y1="1" x2="9" y2="9" />
            <line x1="9" y1="1" x2="1" y2="9" />
          </svg>
        </WinBtn>

        {/* Divider */}
        <div
          style={{
            width:      1,
            height:     16,
            background: "rgba(42,42,56,0.8)",
            margin:     "0 3px",
          }}
        />

        {/* Quit AURA — power icon, clearly distinguished from hide-to-tray */}
        <WinBtn
          title="Quit AURA"
          onClick={() => window.aura?.quit()}
          hoverBg="rgba(239,68,68,0.18)"
          hoverColor="#f87171"
        >
          {/* Power icon */}
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18.36 6.64A9 9 0 1 1 5.64 6.64" />
            <line x1="12" y1="2" x2="12" y2="12" />
          </svg>
        </WinBtn>
      </div>
    </div>
  );
};

export default TitleBar;
