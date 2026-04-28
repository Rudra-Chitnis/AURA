import { useEffect, useState } from "react";
import useStore from "../store/useStore";
import { getReminders, createReminder, cancelReminder } from "../lib/api";

const formatDate = (iso) => {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diff = d - now;
    if (diff < 0) return `Fired ${d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`;
    if (diff < 60000)       return "In less than a minute";
    if (diff < 3600000)     return `In ${Math.round(diff / 60000)} min`;
    if (diff < 86400000)    return `Today at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    if (diff < 172800000)   return `Tomorrow at ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
    return d.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
};

const statusColor = {
  pending:   { bg: "rgba(0,212,255,0.06)",  border: "rgba(0,212,255,0.15)",  dot: "#00d4ff" },
  fired:     { bg: "rgba(16,185,129,0.06)", border: "rgba(16,185,129,0.15)", dot: "#10b981" },
  cancelled: { bg: "rgba(68,68,102,0.06)",  border: "rgba(68,68,102,0.15)",  dot: "#444466" },
};

const ReminderCard = ({ reminder, onCancel }) => {
  const c = statusColor[reminder.status] || statusColor.pending;

  return (
    <div
      className="rounded-xl px-4 py-3 flex items-start gap-3 group"
      style={{ background: c.bg, border: `1px solid ${c.border}` }}
    >
      <div className="w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0" style={{ background: c.dot }} />
      <div className="flex-1 min-w-0">
        <p className="text-sm" style={{ color: "#e0e0f8" }}>{reminder.text}</p>
        <p className="text-xs mt-0.5" style={{ color: "#8888aa" }}>
          {formatDate(reminder.reminderTime)}
          {reminder.recurring && " · recurring"}
        </p>
      </div>
      {reminder.status === "pending" && (
        <button
          onClick={() => onCancel(reminder._id)}
          className="opacity-0 group-hover:opacity-100 transition-opacity btn-danger flex-shrink-0"
        >
          Cancel
        </button>
      )}
    </div>
  );
};

const RemindersPanel = () => {
  const { reminders, setReminders, remindersLoading, setRemindersLoading, removeReminder, addToast } = useStore();
  const [text, setText]       = useState("");
  const [time, setTime]       = useState("");
  const [saving, setSaving]   = useState(false);

  const load = async () => {
    setRemindersLoading(true);
    try {
      const data = await getReminders();
      setReminders(data.reminders || []);
    } catch (e) {
      addToast({ type: "error", message: `Reminders load failed: ${e.message}` });
    } finally {
      setRemindersLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!text.trim() || !time) return;
    setSaving(true);
    try {
      const res = await createReminder(text.trim(), new Date(time).toISOString());
      setReminders([res.reminder, ...reminders]);
      setText("");
      setTime("");
      addToast({ type: "success", message: `Reminder set: "${text.trim()}"` });
    } catch (e) {
      addToast({ type: "error", message: `Failed: ${e.message}` });
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = async (id) => {
    try {
      await cancelReminder(id);
      removeReminder(id);
      addToast({ type: "info", message: "Reminder cancelled" });
    } catch (e) {
      addToast({ type: "error", message: `Failed: ${e.message}` });
    }
  };

  const pending  = reminders.filter((r) => r.status === "pending");
  const past     = reminders.filter((r) => r.status !== "pending");

  return (
    <div className="flex flex-col h-full px-4 py-4 gap-4">
      <div>
        <h2 className="text-sm font-semibold" style={{ color: "#f0f0ff" }}>Reminders</h2>
        <p className="text-xs mt-0.5" style={{ color: "#8888aa" }}>
          {pending.length} pending · {past.length} past
        </p>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto space-y-2">
        {remindersLoading ? (
          <div className="flex items-center justify-center h-24">
            <p className="text-sm" style={{ color: "#444466" }}>Loading…</p>
          </div>
        ) : reminders.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32">
            <p className="text-sm" style={{ color: "#444466" }}>No reminders yet</p>
            <p className="text-xs mt-1" style={{ color: "#333355" }}>
              Say "Remind me at 8pm to…" or use the form below
            </p>
          </div>
        ) : (
          <>
            {pending.length > 0 && (
              <>
                <p className="text-xs font-medium px-1" style={{ color: "#8888aa" }}>UPCOMING</p>
                {pending.map((r) => <ReminderCard key={r._id} reminder={r} onCancel={handleCancel} />)}
              </>
            )}
            {past.length > 0 && (
              <>
                <p className="text-xs font-medium px-1 mt-4" style={{ color: "#444466" }}>PAST</p>
                {past.map((r) => <ReminderCard key={r._id} reminder={r} onCancel={handleCancel} />)}
              </>
            )}
          </>
        )}
      </div>

      {/* Create form */}
      <div className="flex flex-col gap-2 flex-shrink-0">
        <input
          className="aura-input"
          placeholder="Reminder text…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex gap-2">
          <input
            type="datetime-local"
            className="aura-input flex-1"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            style={{ colorScheme: "dark" }}
          />
          <button
            onClick={handleCreate}
            disabled={saving || !text.trim() || !time}
            className="btn-primary flex-shrink-0"
          >
            {saving ? "…" : "Set"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RemindersPanel;
