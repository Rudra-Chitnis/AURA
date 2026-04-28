import { useEffect, useState } from "react";
import useStore from "../store/useStore";
import { getMemories, storeMemory } from "../lib/api";

const MemoryCard = ({ memory, onDelete }) => {
  const content =
    memory.person && memory.attribute && memory.value
      ? `${memory.attribute}: ${memory.value}`
      : memory.content;

  const typeColors = {
    personal:  { bg: "rgba(0,212,255,0.08)",  border: "rgba(0,212,255,0.18)",  text: "#00d4ff" },
    preference: { bg: "rgba(124,58,237,0.08)", border: "rgba(124,58,237,0.18)", text: "#a855f7" },
    general:   { bg: "rgba(136,136,170,0.06)", border: "rgba(136,136,170,0.12)", text: "#8888aa" },
  };
  const c = typeColors[memory.type] || typeColors.general;

  return (
    <div
      className="rounded-xl px-4 py-3 flex items-start gap-3 group transition-all"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}
    >
      <div
        className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0"
        style={{ background: c.text }}
      />
      <div className="flex-1 min-w-0">
        <p className="text-sm leading-relaxed" style={{ color: "#e0e0f8", wordBreak: "break-word" }}>
          {content}
        </p>
        <p className="text-xs mt-1" style={{ color: "#444466" }}>
          {memory.type || "general"}
          {memory.confidence != null && ` · ${Math.round(memory.confidence * 100)}%`}
          {memory.createdAt && ` · ${new Date(memory.createdAt).toLocaleDateString()}`}
        </p>
      </div>
      <button
        onClick={() => onDelete(memory._id)}
        className="opacity-0 group-hover:opacity-100 transition-opacity w-6 h-6 flex items-center justify-center rounded"
        style={{ color: "#f87171", flexShrink: 0 }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "rgba(239,68,68,0.15)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
        title="Delete memory"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <line x1="18" y1="6"  x2="6"  y2="18"/>
          <line x1="6"  y1="6"  x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  );
};

const MemoryPanel = () => {
  const { memories, setMemories, memoriesLoading, setMemoriesLoading, removeMemory, addToast } = useStore();
  const [search,   setSearch]   = useState("");
  const [newMemory, setNewMemory] = useState("");
  const [adding, setAdding]     = useState(false);

  const load = async () => {
    setMemoriesLoading(true);
    try {
      const data = await getMemories();
      setMemories(data.memories || []);
    } catch (e) {
      addToast({ type: "error", message: `Memory load failed: ${e.message}` });
    } finally {
      setMemoriesLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleDelete = async (id) => {
    removeMemory(id);
    // Note: no DELETE endpoint yet — we remove client-side only
    // If you add DELETE /api/memory/:id, call it here
    addToast({ type: "info", message: "Memory removed from view" });
  };

  const handleAdd = async () => {
    if (!newMemory.trim()) return;
    setAdding(true);
    try {
      await storeMemory(newMemory.trim());
      addToast({ type: "success", message: "Memory saved" });
      setNewMemory("");
      load();
    } catch (e) {
      addToast({ type: "error", message: `Failed: ${e.message}` });
    } finally {
      setAdding(false);
    }
  };

  const filtered = memories.filter((m) => {
    const text = m.content || `${m.attribute}: ${m.value}` || "";
    return text.toLowerCase().includes(search.toLowerCase());
  });

  return (
    <div className="flex flex-col h-full px-4 py-4 gap-4">
      {/* Header */}
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "#f0f0ff" }}>Memory</h2>
        <p className="text-xs mt-0.5" style={{ color: "#8888aa" }}>
          {memories.length} {memories.length === 1 ? "fact" : "facts"} stored about you
        </p>
      </div>

      {/* Search */}
      <input
        className="aura-input"
        placeholder="Search memories…"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />

      {/* Memory list */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {memoriesLoading ? (
          <div className="flex items-center justify-center h-24">
            <p className="text-sm" style={{ color: "#444466" }}>Loading…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <p className="text-sm" style={{ color: "#444466" }}>
              {search ? "No matches" : "No memories yet"}
            </p>
            {!search && (
              <p className="text-xs text-center max-w-xs" style={{ color: "#333355" }}>
                AURA learns about you as you chat. You can also add memories manually below.
              </p>
            )}
          </div>
        ) : (
          filtered.map((m) => (
            <MemoryCard key={m._id} memory={m} onDelete={handleDelete} />
          ))
        )}
      </div>

      {/* Add memory form */}
      <div className="flex gap-2 flex-shrink-0">
        <input
          className="aura-input"
          placeholder="Add a memory manually…"
          value={newMemory}
          onChange={(e) => setNewMemory(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleAdd()}
        />
        <button
          onClick={handleAdd}
          disabled={adding || !newMemory.trim()}
          className="btn-primary flex-shrink-0"
        >
          {adding ? "…" : "Save"}
        </button>
      </div>
    </div>
  );
};

export default MemoryPanel;
