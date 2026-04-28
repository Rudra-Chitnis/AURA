import useStore from "../store/useStore";

const ACTION_ICONS = {
  open:    "🚀",
  play:    "🎵",
  search:  "🔍",
  browse:  "🌐",
  youtube: "▶️",
  spotify: "🎧",
  maps:    "🗺️",
  whatsapp: "💬",
  files:   "📁",
  remind:  "🔔",
  default: "⚡",
};

const getIcon = (action) => {
  const app  = (action.app  || "").toLowerCase();
  const type = (action.type || "").toLowerCase();
  if (app.includes("spotify"))  return ACTION_ICONS.spotify;
  if (app.includes("youtube"))  return ACTION_ICONS.youtube;
  if (app.includes("whatsapp")) return ACTION_ICONS.whatsapp;
  if (app.includes("maps"))     return ACTION_ICONS.maps;
  if (app.includes("files") || app.includes("explorer")) return ACTION_ICONS.files;
  if (type === "play")   return ACTION_ICONS.play;
  if (type === "search") return ACTION_ICONS.search;
  if (type === "browse") return ACTION_ICONS.browse;
  if (type === "remind") return ACTION_ICONS.remind;
  if (type === "open")   return ACTION_ICONS.open;
  return ACTION_ICONS.default;
};

const formatRelTime = (iso) => {
  try {
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 5000)   return "just now";
    if (diff < 60000)  return `${Math.round(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.round(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.round(diff / 3600000)}h ago`;
    return new Date(iso).toLocaleDateString();
  } catch { return ""; }
};

const ActionCard = ({ action }) => (
  <div
    className="flex items-start gap-3 rounded-xl px-4 py-3 animate-[slide-up_0.2s_ease-out]"
    style={{
      background: "rgba(245,158,11,0.05)",
      border: "1px solid rgba(245,158,11,0.12)",
    }}
  >
    <span className="text-xl flex-shrink-0 mt-0.5" role="img">{getIcon(action)}</span>
    <div className="flex-1 min-w-0">
      <p className="text-sm font-medium capitalize" style={{ color: "#e0e0f8" }}>
        {action.type} {action.app}
      </p>
      {action.query && (
        <p className="text-xs truncate mt-0.5" style={{ color: "#8888aa" }}>
          "{action.query}"
        </p>
      )}
      <p className="text-xs mt-1" style={{ color: "#444466" }}>
        {formatRelTime(action.timestamp)}
      </p>
    </div>
  </div>
);

const ActionsPanel = () => {
  const { recentActions } = useStore();

  return (
    <div className="flex flex-col h-full px-4 py-4 gap-4">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "#f0f0ff" }}>Recent Actions</h2>
        <p className="text-xs mt-0.5" style={{ color: "#8888aa" }}>
          What AURA has done for you
        </p>
      </div>

      <div className="flex-1 overflow-y-auto space-y-2">
        {recentActions.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <span className="text-2xl">⚡</span>
            <p className="text-sm" style={{ color: "#444466" }}>No actions yet</p>
            <p className="text-xs text-center max-w-xs" style={{ color: "#333355" }}>
              Ask AURA to open apps, play music, or search the web — actions will appear here.
            </p>
          </div>
        ) : (
          recentActions.map((a) => <ActionCard key={a.id} action={a} />)
        )}
      </div>
    </div>
  );
};

export default ActionsPanel;
