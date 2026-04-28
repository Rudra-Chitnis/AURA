import useStore from "../store/useStore";

const NAV = [
  {
    id: "chat",
    label: "Chat",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </svg>
    ),
  },
  {
    id: "memory",
    label: "Memory",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a5 5 0 0 1 5 5c0 2.38-1.32 4.45-3.25 5.5a3 3 0 1 1-3.5 0A5 5 0 0 1 12 2z"/>
        <path d="M12 17v5"/>
        <path d="M8 22h8"/>
      </svg>
    ),
  },
  {
    id: "reminders",
    label: "Reminders",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
      </svg>
    ),
  },
  {
    id: "actions",
    label: "Actions",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
      </svg>
    ),
  },
  {
    id: "settings",
    label: "Settings",
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
      </svg>
    ),
  },
];

const Sidebar = () => {
  const { activeView, setActiveView, voiceProcess, recentActions } = useStore();

  return (
    <div
      className="flex flex-col items-center py-4 gap-1 flex-shrink-0"
      style={{
        width: 60,
        background: "rgba(8,8,14,0.95)",
        borderRight: "1px solid #1e1e35",
      }}
    >
      {/* AURA orb mini */}
      <div
        className="w-8 h-8 rounded-full mb-4 flex-shrink-0"
        style={{
          background: "radial-gradient(circle at 40% 35%, #00d4ff44, #7c3aed22)",
          border: "1px solid #00d4ff33",
          boxShadow: "0 0 12px #00d4ff22",
        }}
      />

      {/* Nav items */}
      {NAV.map((item) => {
        const active = activeView === item.id;
        const hasBadge = item.id === "actions" && recentActions.length > 0;

        return (
          <button
            key={item.id}
            onClick={() => setActiveView(item.id)}
            title={item.label}
            className="relative w-10 h-10 flex items-center justify-center rounded-lg transition-all"
            style={{
              color:      active ? "#00d4ff" : "#8888aa",
              background: active ? "rgba(0,212,255,0.1)" : "transparent",
              border:     active ? "1px solid rgba(0,212,255,0.2)" : "1px solid transparent",
            }}
            onMouseEnter={(e) => {
              if (!active) {
                e.currentTarget.style.color      = "#f0f0ff";
                e.currentTarget.style.background = "rgba(255,255,255,0.05)";
              }
            }}
            onMouseLeave={(e) => {
              if (!active) {
                e.currentTarget.style.color      = "#8888aa";
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <div className="w-5 h-5">{item.icon}</div>
            {hasBadge && (
              <span
                className="absolute top-1 right-1 w-2 h-2 rounded-full"
                style={{ background: "#f59e0b" }}
              />
            )}
          </button>
        );
      })}

      {/* Bottom: voice status indicator */}
      <div className="flex-1" />
      <div
        className="w-2.5 h-2.5 rounded-full mb-1"
        style={{
          background: voiceProcess === "running" ? "#10b981" : "#2a2a45",
          boxShadow:  voiceProcess === "running" ? "0 0 8px #10b98166" : "none",
        }}
        title={voiceProcess === "running" ? "Voice mode active" : "Voice mode off"}
      />
    </div>
  );
};

export default Sidebar;
