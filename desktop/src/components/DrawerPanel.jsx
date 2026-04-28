import { useEffect, useRef } from "react";
import useStore from "../store/useStore";
import MemoryPanel    from "./MemoryPanel";
import RemindersPanel from "./RemindersPanel";
import ActionsPanel   from "./ActionsPanel";
import SettingsPanel  from "./SettingsPanel";
import ChatPanel      from "./ChatPanel";

// ── Drawer content map ─────────────────────────────────────────────────────
const DRAWER_CONTENT = {
  chat:      { title: "Chat",       Panel: ChatPanel },
  memory:    { title: "Memory",     Panel: MemoryPanel },
  reminders: { title: "Reminders",  Panel: RemindersPanel },
  actions:   { title: "Activity",   Panel: ActionsPanel },
  settings:  { title: "Settings",   Panel: SettingsPanel },
};

// ── Close icon ─────────────────────────────────────────────────────────────
const CloseIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round">
    <line x1="18" y1="6" x2="6" y2="18" />
    <line x1="6"  y1="6" x2="18" y2="18" />
  </svg>
);

// ── DrawerPanel ────────────────────────────────────────────────────────────
const DrawerPanel = () => {
  const { activeDrawer, closeDrawer } = useStore();
  const backdropRef = useRef(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape" && activeDrawer) closeDrawer();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeDrawer, closeDrawer]);

  if (!activeDrawer) return null;

  const config = DRAWER_CONTENT[activeDrawer];
  if (!config) return null;

  const { title, Panel } = config;

  return (
    <>
      {/* ── Backdrop ──────────────────────────────────────────────────── */}
      <div
        ref={backdropRef}
        onClick={closeDrawer}
        style={{
          position:   "absolute",
          inset:      0,
          background: "rgba(8,8,12,0.55)",
          backdropFilter: "blur(2px)",
          zIndex:     40,
          animation:  "fade-in 0.18s ease-out",
        }}
      />

      {/* ── Panel ─────────────────────────────────────────────────────── */}
      <div
        style={{
          position:     "absolute",
          left:         0,
          right:        0,
          bottom:       0,
          // Occupy ~60% of window height, leaving orb visible above
          height:       "62%",
          zIndex:       50,
          display:      "flex",
          flexDirection: "column",
          background:   "rgba(14,14,20,0.98)",
          borderTop:    "1px solid rgba(42,42,56,0.9)",
          borderTopLeftRadius:  16,
          borderTopRightRadius: 16,
          boxShadow:    "0 -8px 40px rgba(0,0,0,0.7), 0 -2px 12px rgba(0,0,0,0.5)",
          animation:    "drawer-in 0.3s cubic-bezier(0.16,1,0.3,1)",
          backdropFilter: "blur(20px)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Handle ──────────────────────────────────────────────────── */}
        <div className="flex justify-center pt-2.5 pb-1 flex-shrink-0">
          <div
            style={{
              width: 36, height: 4,
              borderRadius: 2,
              background: "rgba(60,60,80,0.8)",
            }}
          />
        </div>

        {/* ── Header ──────────────────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-4 py-2 flex-shrink-0"
          style={{ borderBottom: "1px solid rgba(42,42,56,0.5)" }}
        >
          <span
            className="text-[13px] font-semibold"
            style={{ color: "#c8c8d8", letterSpacing: "0.01em" }}
          >
            {title}
          </span>
          <button
            onClick={closeDrawer}
            className="icon-btn no-drag"
            style={{ width: 26, height: 26 }}
            title="Close"
          >
            <CloseIcon />
          </button>
        </div>

        {/* ── Scrollable content ───────────────────────────────────────── */}
        <div className="flex-1 overflow-hidden no-drag">
          <Panel />
        </div>
      </div>
    </>
  );
};

export default DrawerPanel;
