import useStore from "../store/useStore";

const TOAST_STYLE = {
  success: { border: "rgba(16,185,129,0.3)",  icon: "✓",  color: "#10b981" },
  error:   { border: "rgba(239,68,68,0.3)",   icon: "✕",  color: "#f87171" },
  info:    { border: "rgba(0,212,255,0.2)",   icon: "·",  color: "#00d4ff" },
  reminder:{ border: "rgba(245,158,11,0.3)",  icon: "🔔", color: "#f59e0b" },
};

const ToastStack = () => {
  const { toasts } = useStore();

  if (!toasts.length) return null;

  return (
    <div
      className="fixed bottom-4 right-4 flex flex-col gap-2 z-50 pointer-events-none"
      style={{ maxWidth: 320 }}
    >
      {toasts.map((t) => {
        const s = TOAST_STYLE[t.type] || TOAST_STYLE.info;
        return (
          <div
            key={t.id}
            className="rounded-xl px-4 py-3 flex items-start gap-2.5 animate-[slide-up_0.2s_ease-out]"
            style={{
              background: "rgba(16,16,26,0.97)",
              border:     `1px solid ${s.border}`,
              backdropFilter: "blur(12px)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            }}
          >
            <span className="text-sm flex-shrink-0 mt-0.5" style={{ color: s.color }}>
              {s.icon}
            </span>
            <p className="text-sm leading-snug" style={{ color: "#e0e0f8" }}>{t.message}</p>
          </div>
        );
      })}
    </div>
  );
};

export default ToastStack;
