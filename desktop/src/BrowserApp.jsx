import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  askStream, dispatchRuntimeAction, getConversationHistory, getProfile,
  getToken, login, register, setBaseUrl, setToken,
} from "./lib/api";
import useBrowserRuntime from "./hooks/useBrowserRuntime";
import "./browser.css";

const NAV_ITEMS = [
  { id: "chat", label: "Assistant", icon: "✳" },
  { id: "activity", label: "Activity", icon: "◷" },
  { id: "routines", label: "Timers & reminders", icon: "◴" },
  { id: "diagnostics", label: "Diagnostics", icon: "⌁" },
  { id: "settings", label: "Settings", icon: "⚙" },
];

const SUGGESTIONS = [
  "What do you know about me?",
  "Give me a quick focus reset",
  "What have we been working on?",
];

const shortTime = value => {
  if (!value) return "Just now";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Just now" : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
};

const localDateTime = offset => {
  const date = new Date(Date.now() + offset);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};

function StatusDot({ status }) {
  const tone = status === "online" || status === "ready" || status === "running"
    ? "good" : status === "degraded" || status === "connecting" || status === "reconnecting"
      ? "warn" : status === "offline" || status === "failed" ? "bad" : "quiet";
  return <span className={`web-status-dot ${tone}`} aria-hidden="true" />;
}

function BrandMark() {
  return <span className="web-brand-mark" aria-hidden="true"><i /><i /><i /></span>;
}

function BrowserAuth({ onAuthenticated, backendStatus, initialError = "" }) {
  const [mode, setMode] = useState("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);

  useEffect(() => { if (initialError) setError(initialError); }, [initialError]);

  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      let result;
      if (mode === "register") {
        await register(name.trim(), email.trim(), password);
        result = await login(email.trim(), password);
      } else {
        result = await login(email.trim(), password);
      }
      if (!result?.token || !result?.user) throw new Error("The Core returned an incomplete sign-in response.");
      setToken(result.token);
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError.message || "Sign-in failed. Check the Core connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="browser-auth-wrap">
      <section className="browser-auth-card">
        <div className="browser-auth-brand"><BrandMark /><span>AURA <b>CORE</b></span></div>
        <div className="browser-auth-art" aria-hidden="true"><span /><span /><span /><i>✳</i></div>
        <p className="browser-eyebrow">YOUR LOCAL ASSISTANT</p>
        <h1>{mode === "login" ? "Good to see you." : "Make space for better ideas."}</h1>
        <p className="browser-muted">Sign in to continue your conversations and connect to your AURA Core.</p>
        <div className="browser-auth-status"><StatusDot status={backendStatus} /> Core {backendStatus === "online" ? "is ready" : backendStatus === "degraded" ? "is waiting on a service" : backendStatus === "offline" ? "is unreachable" : "is connecting"}</div>
        <form onSubmit={submit} className="browser-form">
          {mode === "register" && <label>Your name<input autoComplete="name" required value={name} onChange={event => setName(event.target.value)} placeholder="How should AURA address you?" /></label>}
          <label>Email address<input autoComplete="email" type="email" required value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" /></label>
          <label>Password<input autoComplete={mode === "login" ? "current-password" : "new-password"} type="password" minLength={6} required value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 6 characters" /></label>
          {error && <p role="alert" className="browser-inline-error">{error}</p>}
          <button className="web-button primary wide" type="submit" disabled={busy || backendStatus === "offline"}>
            {busy ? <><span className="web-spinner" /> Connecting…</> : mode === "login" ? "Sign in to AURA" : "Create account"}
          </button>
        </form>
        <p className="browser-auth-switch">{mode === "login" ? "New to AURA?" : "Already have an account?"} <button onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "Create an account" : "Sign in"}</button></p>
      </section>
      <p className="browser-auth-foot">Private by design <span>·</span> Runs on your AURA Core</p>
    </main>
  );
}

function ActivityRow({ item, onInspect }) {
  return (
    <button className="web-event-row" onClick={() => onInspect(item)}>
      <span className={`web-event-mark ${item.tone || "neutral"}`} />
      <span className="web-event-copy"><strong>{item.title}</strong><small>{item.detail || item.category} <i>·</i> {shortTime(item.createdAt)}</small></span>
      <span className="web-event-arrow">›</span>
    </button>
  );
}

function StatusCard({ backend, socket, runtime, ollama, lastVoice }) {
  return (
    <section className="web-card status-card">
      <div className="web-card-heading"><div><p className="browser-eyebrow">SYSTEM</p><h3>Core status</h3></div><span className="web-live-tag"><i /> LIVE</span></div>
      <div className="web-status-list">
        <div><span><StatusDot status={backend.status} /> Backend</span><b className={`status-${backend.status}`}>{backend.status}</b></div>
        <div><span><StatusDot status={socket} /> Event stream</span><b className={`status-${socket}`}>{socket}</b></div>
        <div><span><StatusDot status={runtime.state} /> Runtime</span><b className={`status-${runtime.state}`}>{runtime.state || "unknown"}</b></div>
        <div><span><StatusDot status={ollama.status} /> AI provider</span><b title={ollama.detail}>{ollama.status === "unknown" ? "not reported" : ollama.status}</b></div>
      </div>
      {backend.status === "degraded" && <p className="web-status-note">Backend is reachable, but its health check reports a dependency is not ready.</p>}
      {lastVoice && <p className="web-voice-note"><span className="voice-wave"><i /><i /><i /></span> Voice worker: <b>{lastVoice.state || "active"}</b>{lastVoice.text ? <span className="voice-transcript">“{lastVoice.text}”</span> : null}</p>}
      <p className="web-provider-note">AI provider availability is shown when a runtime debug event reports it.</p>
    </section>
  );
}

function QuickRuntime({ runtime, onNavigate }) {
  const timers = runtime.timers || [];
  const reminders = runtime.reminders || [];
  return (
    <section className="web-card quick-runtime">
      <div className="web-card-heading"><div><p className="browser-eyebrow">UP NEXT</p><h3>Timers & reminders</h3></div><button className="web-text-button" onClick={() => onNavigate("routines")}>Manage</button></div>
      {!timers.length && !reminders.length ? <div className="web-mini-empty"><span>◷</span><p>Nothing scheduled.<br /><button onClick={() => onNavigate("routines")}>Create a timer or reminder</button></p></div> : (
        <div className="web-mini-list">
          {timers.slice(0, 2).map(timer => <div className="web-mini-item" key={timer.id}><span className="mini-icon timer-icon">◴</span><span><b>{timer.label}</b><small>Timer</small></span><strong>{Math.ceil(timer.remainingSecs || 0)}s</strong></div>)}
          {reminders.slice(0, 2).map(reminder => <div className="web-mini-item" key={reminder.id}><span className="mini-icon reminder-icon">⌁</span><span><b>{reminder.text}</b><small>{new Date(reminder.fireAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</small></span></div>)}
        </div>
      )}
    </section>
  );
}

function MessageBubble({ message }) {
  return (
    <article className={`web-message ${message.role === "user" ? "user" : "assistant"}`}>
      {message.role !== "user" && <div className="web-message-avatar"><BrandMark /></div>}
      <div className="web-message-main">
        <div className="web-message-meta"><b>{message.role === "user" ? "You" : "AURA"}</b><time>{message.timestamp ? shortTime(message.timestamp) : "History"}</time>{message.streaming && <span className="web-thinking"><i /> composing</span>}</div>
        <div className={`web-message-bubble ${message.error ? "error" : ""}`}>
          {message.content ? <p>{message.content}</p> : message.streaming ? <span className="web-thinking-dots"><i /><i /><i /></span> : <p className="browser-muted">No response was returned.</p>}
        </div>
        {message.error && <p className="web-message-error">{message.error}</p>}
        {message.metrics && <div className="web-message-metrics">{message.metrics.firstTokenMs == null ? "No first token" : `First token ${message.metrics.firstTokenMs} ms`} <span>·</span> Total {message.metrics.durationMs} ms</div>}
      </div>
    </article>
  );
}

function ChatView({ messages, historyLoading, historyError, sendMessage, streaming, abortTurn, user }) {
  const [draft, setDraft] = useState("");
  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const hasMessages = messages.length > 0;

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" }); }, [messages]);

  const submit = async event => {
    event.preventDefault();
    const value = draft.trim();
    if (!value || streaming) return;
    setDraft("");
    await sendMessage(value);
    inputRef.current?.focus();
  };

  return (
    <div className="browser-chat-layout">
      <main className="browser-chat-main">
        <div className="browser-page-header chat-header"><div><p className="browser-eyebrow">AURA · PERSONAL ASSISTANT</p><h1>{hasMessages ? `Welcome back${user?.name ? `, ${user.name.split(" ")[0]}` : ""}.` : "A little more clarity, on demand."}</h1><p className="browser-muted">A local assistant that learns from your conversations and helps you move forward.</p></div><div className="browser-session-chip"><span className="session-orb">✳</span><span><b>Private session</b><small>Connected to your Core</small></span></div></div>
        <section className="browser-conversation" aria-label="Conversation">
          <div className="browser-message-scroll" aria-live="polite">
            {historyLoading ? <div className="browser-history-loading"><span className="web-spinner" /> Restoring your conversation…</div> : !hasMessages ? (
              <div className="browser-welcome">
                <div className="welcome-orb"><span>✳</span><i /><i /></div>
                <p className="browser-eyebrow">HERE WHEN YOU NEED IT</p>
                <h2>What’s on your mind?</h2>
                <p>Ask a question, pick up a thread, or let AURA help organize what comes next.</p>
                <div className="browser-suggestions">{SUGGESTIONS.map(suggestion => <button key={suggestion} onClick={() => sendMessage(suggestion)} disabled={streaming}><span>↗</span>{suggestion}</button>)}</div>
              </div>
            ) : <div className="browser-message-list">{messages.map(message => <MessageBubble key={message.id} message={message} />)}<div ref={bottomRef} /></div>}
          </div>
          <form className="browser-composer" onSubmit={submit}>
            <label className="sr-only" htmlFor="aura-prompt">Message AURA</label>
            <textarea id="aura-prompt" ref={inputRef} value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(event); } }} placeholder={streaming ? "AURA is thinking…" : "Message AURA…"} rows={1} disabled={streaming} />
            {streaming ? <button type="button" className="web-button stop" onClick={abortTurn} aria-label="Stop response">Stop</button> : <button type="submit" className="web-send" disabled={!draft.trim()} aria-label="Send message">↑</button>}
            <div className="browser-composer-hint"><span>↵ Send <i>·</i> Shift + ↵ New line</span><span><span className="privacy-lock">◆</span> Your messages stay on your Core</span></div>
          </form>
        </section>
      </main>
      {historyError && <p role="status" className="browser-history-error">History could not be restored: {historyError}</p>}
    </div>
  );
}

function ActivityView({ activity, onClear, onInspect }) {
  return (
    <section className="browser-page-body">
      <div className="browser-page-header"><div><p className="browser-eyebrow">OBSERVABILITY</p><h1>Activity stream</h1><p className="browser-muted">A readable timeline of events arriving from your AURA Core.</p></div><button className="web-button secondary" onClick={onClear} disabled={!activity.length}>Clear timeline</button></div>
      <div className="browser-content-card"><div className="browser-list-toolbar"><span>{activity.length} recent events</span><span><span className="web-live-tag"><i /> LIVE</span> &nbsp; Most recent first</span></div>{!activity.length ? <EmptyPanel icon="◷" title="Waiting for activity" detail="Runtime transitions, timer events, actions, voice, and diagnostics will appear here." /> : <div className="browser-event-list">{activity.map(item => <ActivityRow key={item.id} item={item} onInspect={onInspect} />)}</div>}</div>
    </section>
  );
}

function TimerCard({ timer, now, onCancel }) {
  const duration = Math.max(1, Number(timer.durationSecs) || 1);
  const remaining = Math.max(0, (new Date(timer.endsAt).getTime() - now) / 1000);
  const progress = Math.min(100, Math.max(0, ((duration - remaining) / duration) * 100));
  return <article className="routine-card"><div className="routine-icon timer-icon">◴</div><div className="routine-card-copy"><div><b>{timer.label || "Timer"}</b><span className="routine-state">RUNNING</span></div><strong>{formatCountdown(remaining)}</strong><div className="routine-progress"><i style={{ width: `${progress}%` }} /></div><small>Ends {new Date(timer.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</small></div><button className="web-icon-button danger" onClick={() => onCancel(timer.id)} aria-label={`Cancel ${timer.label || "timer"}`} title="Cancel timer">×</button></article>;
}

function formatCountdown(seconds) {
  const value = Math.ceil(Math.max(0, seconds));
  const h = Math.floor(value / 3600);
  const m = Math.floor((value % 3600) / 60);
  const s = value % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function ReminderCard({ reminder, onCancel }) {
  return <article className="routine-card"><div className="routine-icon reminder-icon">⌁</div><div className="routine-card-copy"><div><b>{reminder.text}</b><span className="routine-state reminder-state">UPCOMING</span></div><strong className="reminder-when">{new Date(reminder.fireAt).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</strong><small>Scheduled in AURA Core</small></div><button className="web-icon-button danger" onClick={() => onCancel(reminder.id)} aria-label={`Cancel reminder ${reminder.text}`} title="Cancel reminder">×</button></article>;
}

function EmptyPanel({ icon, title, detail }) {
  return <div className="browser-empty-panel"><span>{icon}</span><b>{title}</b><p>{detail}</p></div>;
}

function RoutinesView({ runtime, now, dispatchAction, activity, onInspect }) {
  const [timerLabel, setTimerLabel] = useState("");
  const [timerMinutes, setTimerMinutes] = useState("5");
  const [reminderText, setReminderText] = useState("");
  const [reminderAt, setReminderAt] = useState(() => localDateTime(60 * 60 * 1000));
  const [pending, setPending] = useState("");
  const [error, setError] = useState("");
  const timers = runtime.timers || [];
  const reminders = runtime.reminders || [];
  const completed = activity.filter(event => event.category === "timer" || event.category === "reminder").slice(0, 5);

  const submitTimer = async event => {
    event.preventDefault();
    const minutes = Number(timerMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return setError("Choose a timer duration greater than zero.");
    setPending("timer"); setError("");
    try {
      const result = await performAction({ type: "timer.create", label: timerLabel.trim() || `${minutes} minute timer`, seconds: Math.round(minutes * 60) });
      if (result) { setTimerLabel(""); }
    } catch (actionError) { setError(actionError.message); }
    finally { setPending(""); }
  };

  const submitReminder = async event => {
    event.preventDefault();
    const fireAt = new Date(reminderAt);
    if (!reminderText.trim()) return setError("Add a reminder message.");
    if (Number.isNaN(fireAt.getTime()) || fireAt.getTime() <= Date.now()) return setError("Choose a future date and time.");
    setPending("reminder"); setError("");
    try {
      await performAction({ type: "reminder.create", text: reminderText.trim(), fireAt: fireAt.toISOString() });
      setReminderText(""); setReminderAt(localDateTime(60 * 60 * 1000));
    } catch (actionError) { setError(actionError.message); }
    finally { setPending(""); }
  };

  const cancel = async (type, id) => {
    setPending(id); setError("");
    try { await performAction({ type: `${type}.cancel`, id }); }
    catch (actionError) { setError(actionError.message); }
    finally { setPending(""); }
  };

  async function performAction(action) {
    const response = await dispatchAction(action);
    if (!response?.handled) throw new Error("Core did not recognize this action.");
    if (response.type?.endsWith(".create")) return response.result;
    return true;
  }

  return (
    <section className="browser-page-body">
      <div className="browser-page-header"><div><p className="browser-eyebrow">CORE OPERATIONS</p><h1>Timers & reminders</h1><p className="browser-muted">AURA Core schedules these and keeps them running independently of the browser.</p></div><div className="browser-count-pills"><span><b>{timers.length}</b> active timers</span><span><b>{reminders.length}</b> reminders</span></div></div>
      <div className="routines-layout">
        <div className="routines-lists">
          <section className="browser-content-card"><div className="browser-section-title"><div><p className="browser-eyebrow">COUNTDOWN</p><h2>Active timers</h2></div><span className="web-number-pill">{timers.length}</span></div>{timers.length ? <div className="routine-list">{timers.map(timer => <TimerCard key={timer.id} timer={timer} now={now} onCancel={id => cancel("timer", id)} />)}</div> : <EmptyPanel icon="◴" title="No active timers" detail="Start one here, or ask AURA to set it in chat." />}</section>
          <section className="browser-content-card"><div className="browser-section-title"><div><p className="browser-eyebrow">UPCOMING</p><h2>Reminders</h2></div><span className="web-number-pill violet">{reminders.length}</span></div>{reminders.length ? <div className="routine-list">{reminders.map(reminder => <ReminderCard key={reminder.id} reminder={reminder} onCancel={id => cancel("reminder", id)} />)}</div> : <EmptyPanel icon="⌁" title="Nothing on the calendar" detail="Create a reminder and Core will notify connected clients when it fires." />}</section>
          {!!completed.length && <section className="browser-content-card"><div className="browser-section-title"><div><p className="browser-eyebrow">RECENTLY COMPLETED</p><h2>Recent events</h2></div></div><div className="browser-event-list compact">{completed.map(item => <ActivityRow key={item.id} item={item} onInspect={onInspect} />)}</div></section>}
        </div>
        <aside className="routine-forms">
          <form className="browser-content-card browser-form-card" onSubmit={submitTimer}><p className="browser-eyebrow">NEW TIMER</p><h2>Start a countdown</h2><p className="browser-muted">Core handles the timer lifecycle and persistence.</p><label>Label <input maxLength={60} value={timerLabel} onChange={event => setTimerLabel(event.target.value)} placeholder="Tea, focus session…" /></label><label>Duration <div className="duration-input"><input type="number" min="0.1" step="0.1" required value={timerMinutes} onChange={event => setTimerMinutes(event.target.value)} /><span>minutes</span></div></label><button type="submit" className="web-button primary wide" disabled={pending === "timer" || !runtime.state || runtime.state !== "ready"}>{pending === "timer" ? "Starting…" : "Start timer"}</button></form>
          <form className="browser-content-card browser-form-card" onSubmit={submitReminder}><p className="browser-eyebrow">NEW REMINDER</p><h2>Keep it on your radar</h2><label>Reminder <input maxLength={180} required value={reminderText} onChange={event => setReminderText(event.target.value)} placeholder="What should AURA remind you?" /></label><label>Date & time <input type="datetime-local" min={localDateTime(60_000)} required value={reminderAt} onChange={event => setReminderAt(event.target.value)} /></label><button type="submit" className="web-button secondary wide" disabled={pending === "reminder" || runtime.state !== "ready"}>{pending === "reminder" ? "Scheduling…" : "Schedule reminder"}</button></form>
          {error && <p className="browser-inline-error" role="alert">{error}</p>}
          {runtime.state !== "ready" && <p className="web-runtime-warning">Core runtime is {runtime.state || "unavailable"}. Scheduling will be available when it is ready.</p>}
        </aside>
      </div>
    </section>
  );
}

function DiagnosticsView({ diagnostics, activity, onRefresh, onInspect }) {
  const liveItems = activity
    .filter(item => ["diagnostic", "error", "debug"].includes(item.category))
    .map(item => ({ ...item, detail: [item.detail, "Live"].filter(Boolean).join(" · ") }));
  const storedItems = diagnostics.map(item => ({
    id: item._id || `${item.type}-${item.createdAt}`,
    title: item.issue || item.type || "Diagnostic",
    detail: [item.cause || item.source || item.severity, "Core record"].filter(Boolean).join(" · "),
    category: "diagnostic",
    tone: item.severity === "error" ? "danger" : "warning",
    createdAt: item.createdAt,
    payload: item,
  }));
  const seen = new Set();
  const items = [...liveItems, ...storedItems].filter(item => {
    const key = `${item.title}|${item.createdAt || item.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
  return (
    <section className="browser-page-body">
      <div className="browser-page-header"><div><p className="browser-eyebrow">DEVELOPER VIEW</p><h1>Diagnostics</h1><p className="browser-muted">Inspect recent Core diagnostics and the live transport state without cluttering chat.</p></div><button className="web-button secondary" onClick={onRefresh}>Refresh diagnostics</button></div>
      <div className="diagnostics-summary"><div><span>Persisted diagnostics</span><b>{diagnostics.length}</b><small>from the current API result</small></div><div><span>Live debug events</span><b>{activity.filter(item => item.category === "debug").length}</b><small>received over WebSocket</small></div><div><span>Current stream</span><b className="diagnostic-connection">{activity.length ? "Receiving" : "Waiting"}</b><small>events retained in this session</small></div></div>
      <div className="browser-content-card"><div className="browser-list-toolbar"><span>{items.length} recent diagnostic / debug events</span><span>Click an event to inspect its payload</span></div>{items.length ? <div className="browser-event-list">{items.map((item, index) => <ActivityRow key={item.id || `${item.createdAt}-${index}`} item={item} onInspect={onInspect} />)}</div> : <EmptyPanel icon="⌁" title="No recent diagnostics" detail="Runtime diagnostics will appear here when the backend records them." />}</div>
    </section>
  );
}

function SettingsView({ backendUrl, wsUrl, setEndpoints, user, onLogout }) {
  const [httpDraft, setHttpDraft] = useState(backendUrl);
  const [wsDraft, setWsDraft] = useState(wsUrl);
  const [saved, setSaved] = useState(false);
  const save = event => {
    event.preventDefault();
    setEndpoints(httpDraft.replace(/\/$/, ""), wsDraft);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };
  return (
    <section className="browser-page-body">
      <div className="browser-page-header"><div><p className="browser-eyebrow">PREFERENCES</p><h1>Settings</h1><p className="browser-muted">Connect this browser to the Core instance you want to work with.</p></div></div>
      <div className="settings-grid"><form className="browser-content-card browser-form-card" onSubmit={save}><p className="browser-eyebrow">CONNECTION</p><h2>Core endpoints</h2><p className="browser-muted">Changes are saved in this browser only. Use the Core HTTP and WebSocket ports.</p><label>Backend HTTP URL<input required type="url" value={httpDraft} onChange={event => setHttpDraft(event.target.value)} placeholder="http://localhost:5000" /></label><label>WebSocket URL<input required type="url" value={wsDraft} onChange={event => setWsDraft(event.target.value)} placeholder="ws://localhost:5001" /></label><button className="web-button primary" type="submit">{saved ? "Saved · reconnecting" : "Save connection"}</button></form>
        <section className="browser-content-card account-card"><p className="browser-eyebrow">ACCOUNT</p><h2>{user?.name || "Your AURA account"}</h2><p className="browser-muted">{user?.email || "Signed in to this Core instance."}</p><div className="account-security"><span>◆</span><p><b>Token stored in this browser</b><small>Authentication uses AURA's existing JWT API.</small></p></div><button className="web-button danger-outline" onClick={onLogout}>Sign out</button></section>
        <section className="browser-content-card about-card"><p className="browser-eyebrow">ABOUT THIS CLIENT</p><h2>Browser client</h2><p className="browser-muted">Chat history is loaded from Core. Runtime timers, reminders, activity, and diagnostics use the existing AURA API/event contracts.</p><div className="about-contracts"><span>HTTP + SSE</span><span>WebSocket</span><span>JWT auth</span></div><p className="web-voice-note-static">Voice control and native notifications remain in the desktop host. Voice worker events are still visible here when Core receives them.</p></section>
      </div>
    </section>
  );
}

function AppActivityRail({ activity, onNavigate, onInspect }) {
  return <section className="web-card rail-activity"><div className="web-card-heading"><div><p className="browser-eyebrow">HAPPENING NOW</p><h3>Live activity</h3></div><button className="web-text-button" onClick={() => onNavigate("activity")}>View all</button></div>{activity.length ? <div className="rail-event-list">{activity.slice(0, 5).map(item => <ActivityRow key={item.id} item={item} onInspect={onInspect} />)}</div> : <p className="rail-placeholder">Runtime events, actions, and diagnostics appear here as AURA works.</p>}</section>;
}

function BrowserApp() {
  const [tokenPresent, setTokenPresent] = useState(Boolean(getToken()));
  const [user, setUser] = useState(null);
  const [authChecking, setAuthChecking] = useState(Boolean(getToken()));
  const [authError, setAuthError] = useState("");
  const [backendUrl, setBackendUrl] = useState(() => localStorage.getItem("aura_browser_backend") || "http://localhost:5000");
  const [wsUrl, setWsUrl] = useState(() => localStorage.getItem("aura_browser_ws") || "ws://localhost:5001");
  const [view, setView] = useState("chat");
  const [messages, setMessages] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [turnController, setTurnController] = useState(null);
  const [selectedActivity, setSelectedActivity] = useState(null);
  const [toast, setToast] = useState("");
  const abortRef = useRef(null);
  const { backend, socket, runtime, activity, diagnostics, lastVoice, ollama, addActivity, refreshRuntime, refreshDiagnostics, clearActivity } = useBrowserRuntime(wsUrl, tokenPresent, backendUrl);

  useEffect(() => { setBaseUrl(backendUrl); }, [backendUrl]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const saved = localStorage.getItem("aura_browser_messages");
    if (saved && tokenPresent) {
      try { setMessages(JSON.parse(saved).slice(-100)); } catch { localStorage.removeItem("aura_browser_messages"); }
    }
  }, [tokenPresent]);
  useEffect(() => {
    if (messages.length) localStorage.setItem("aura_browser_messages", JSON.stringify(messages.slice(-100)));
  }, [messages]);

  useEffect(() => {
    if (!getToken()) { setAuthChecking(false); return; }
    let cancelled = false;
    getProfile().then(result => {
      if (!cancelled) { setUser(result.user); setTokenPresent(true); }
    }).catch(error => {
      if (cancelled) return;
      if (/401|not authorized/i.test(error.message)) {
        setToken(null); setTokenPresent(false); setAuthError("Your session expired. Sign in again to continue.");
      } else setAuthError(error.message || "Could not validate your AURA session.");
    }).finally(() => { if (!cancelled) setAuthChecking(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!tokenPresent || !user) return undefined;
    let cancelled = false;
    setHistoryLoading(true); setHistoryError("");
    getConversationHistory().then(result => {
      if (cancelled) return;
      const turns = Array.isArray(result.turns) ? result.turns : [];
      setMessages(turns.map((turn, index) => ({ id: `history-${index}-${turn.role}`, role: turn.role, content: turn.content, timestamp: null })));
    }).catch(error => {
      if (!cancelled) setHistoryError(error.message || "Conversation history could not be loaded.");
    }).finally(() => { if (!cancelled) setHistoryLoading(false); });
    return () => { cancelled = true; };
  }, [tokenPresent, user]);

  const notify = useCallback(message => {
    setToast(message);
    window.clearTimeout(notify.timer);
    notify.timer = window.setTimeout(() => setToast(""), 3200);
  }, []);

  const sendMessage = useCallback(async query => {
    if (!query.trim() || streaming) return;
    const startedAt = performance.now();
    const userMessage = { id: `user-${Date.now()}`, role: "user", content: query, timestamp: new Date().toISOString() };
    const assistantId = `assistant-${Date.now() + 1}`;
    setMessages(current => [...current, userMessage, { id: assistantId, role: "assistant", content: "", timestamp: new Date().toISOString(), streaming: true }].slice(-100));
    setStreaming(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setTurnController(controller);
    addActivity({ type: "turn.started", query }, { title: "Conversation turn started", detail: query, category: "conversation", tone: "neutral", createdAt: new Date().toISOString() });
    try {
      const metrics = await askStream(query, [], token => {
        setMessages(current => current.map(message => message.id === assistantId ? { ...message, content: message.content + String(token) } : message));
      }, undefined, { signal: controller.signal });
      setMessages(current => current.map(message => message.id === assistantId ? { ...message, streaming: false, metrics } : message));
      addActivity({ type: "turn.completed", durationMs: metrics.durationMs, firstTokenMs: metrics.firstTokenMs }, { title: "AURA responded", detail: `${metrics.firstTokenMs == null ? "No first token" : `First token in ${metrics.firstTokenMs} ms`} · ${metrics.durationMs} ms total`, category: "conversation", tone: "good", createdAt: new Date().toISOString() });
    } catch (error) {
      const message = error.name === "AbortError" ? "Response stopped." : error.message || "AURA could not complete this response.";
      setMessages(current => current.map(item => item.id === assistantId ? { ...item, content: error.name === "AbortError" ? item.content : "", streaming: false, error: error.name === "AbortError" ? null : message } : item));
      if (error.name !== "AbortError") {
        addActivity({ type: "error", message }, { title: "Conversation request failed", detail: message, category: "error", tone: "danger", createdAt: new Date().toISOString() });
        notify(message);
        if (/401|not authorized/i.test(message)) { setToken(null); setTokenPresent(false); setUser(null); }
      }
    } finally {
      setStreaming(false);
      setTurnController(null);
      abortRef.current = null;
      if (performance.now() - startedAt > 0) setTimeout(() => document.getElementById("aura-prompt")?.focus(), 0);
    }
  }, [streaming, addActivity, notify]);

  const runAction = useCallback(async action => {
    const startedAt = performance.now();
    try {
      const result = await dispatchRuntimeAction(action);
      addActivity({ type: "action", action: action.type, result: result.result }, { title: action.type.replaceAll(".", " · "), detail: `${result.handled ? "Completed" : "Not handled"} · ${Math.round(performance.now() - startedAt)} ms`, category: "action", tone: result.handled ? "good" : "warning", createdAt: new Date().toISOString(), payload: { request: action, result } });
      await refreshRuntime();
      return result;
    } catch (error) {
      addActivity({ type: "error", message: error.message }, { title: `${action.type} failed`, detail: error.message, category: "error", tone: "danger", createdAt: new Date().toISOString() });
      throw error;
    }
  }, [addActivity, refreshRuntime]);

  const inspectActivity = item => setSelectedActivity(item);
  const saveEndpoints = (nextBackend, nextWs) => {
    localStorage.setItem("aura_browser_backend", nextBackend);
    localStorage.setItem("aura_browser_ws", nextWs);
    setBaseUrl(nextBackend);
    setBackendUrl(nextBackend);
    setWsUrl(nextWs);
    notify("Core endpoints saved. Reconnecting…");
  };

  const logout = () => {
    abortRef.current?.abort();
    setToken(null); setTokenPresent(false); setUser(null); setMessages([]); localStorage.removeItem("aura_browser_messages");
    notify("Signed out of AURA Core.");
  };

  const pageTitle = NAV_ITEMS.find(item => item.id === view)?.label || "Assistant";
  const connectionStatus = useMemo(() => backend.status === "online" && socket === "online" ? "All systems connected" : backend.status === "offline" ? "Core connection lost" : "Reconnecting to Core", [backend.status, socket]);

  if (authChecking) return <main className="browser-loading-screen"><BrandMark /><span>Connecting to your AURA Core…</span></main>;
  if (!tokenPresent || !user) return <BrowserAuth onAuthenticated={nextUser => { setUser(nextUser); setTokenPresent(true); setAuthError(""); }} backendStatus={backend.status} initialError={authError} />;

  return (
    <div className={`browser-shell ${view === "chat" ? "has-chat-rail" : ""}`}>
      <aside className="browser-sidebar">
        <div className="browser-brand"><BrandMark /><span>AURA</span><small>CORE</small></div>
        <div className="browser-workspace"><span className="workspace-avatar">{(user.name || user.email || "A").slice(0, 1).toUpperCase()}</span><span><b>{user.name || "AURA workspace"}</b><small>Personal assistant</small></span><span className="workspace-menu">⌄</span></div>
        <p className="browser-nav-label">WORKSPACE</p>
        <nav className="browser-nav" aria-label="Main navigation">{NAV_ITEMS.map(item => <button key={item.id} className={view === item.id ? "selected" : ""} onClick={() => setView(item.id)}><span className="nav-glyph">{item.icon}</span><span>{item.label}</span>{item.id === "activity" && activity.length > 0 && <i className="nav-count">{Math.min(activity.length, 99)}</i>}</button>)}</nav>
        <div className="browser-sidebar-spacer" />
        <div className="browser-sidebar-core"><StatusDot status={backend.status} /><span><b>{backend.status === "online" ? "Core is online" : backend.status === "degraded" ? "Core is degraded" : backend.status === "offline" ? "Core is offline" : "Connecting"}</b><small>{connectionStatus}</small></span></div>
        <button className="browser-profile" onClick={logout}><span className="profile-avatar">{(user.name || user.email || "A").slice(0, 1).toUpperCase()}</span><span><b>{user.name || user.email}</b><small>Sign out</small></span><span className="profile-more">···</span></button>
      </aside>
      <main className="browser-main">
        <header className="browser-topbar"><div className="mobile-brand"><BrandMark /><b>AURA</b></div><div className="browser-breadcrumb"><span>Workspace</span><i>/</i><b>{pageTitle}</b></div><div className="browser-top-status"><span className="top-connection"><StatusDot status={backend.status} /> Core <b>{backend.status}</b></span><span className="top-connection"><StatusDot status={socket} /> Events <b>{socket}</b></span><button className="web-icon-button settings-shortcut" onClick={() => setView("settings")} aria-label="Open settings">⚙</button></div></header>
        <div className="browser-page-content">
          {view === "chat" && <ChatView messages={messages} historyLoading={historyLoading} historyError={historyError} sendMessage={sendMessage} streaming={streaming} abortTurn={() => turnController?.abort()} user={user} />}
          {view === "activity" && <ActivityView activity={activity} onClear={clearActivity} onInspect={inspectActivity} />}
          {view === "routines" && <RoutinesView runtime={runtime} now={now} dispatchAction={runAction} activity={activity} onInspect={inspectActivity} />}
          {view === "diagnostics" && <DiagnosticsView diagnostics={diagnostics} activity={activity} onRefresh={refreshDiagnostics} onInspect={inspectActivity} />}
          {view === "settings" && <SettingsView backendUrl={backendUrl} wsUrl={wsUrl} setEndpoints={saveEndpoints} user={user} onLogout={logout} />}
        </div>
        <footer className="browser-footer"><span><StatusDot status={socket} /> {connectionStatus}</span><span>{backend.body?.ok ? "MongoDB ready" : backend.status === "degraded" ? backend.body?.reason || "Backend degraded" : "Core health from /api/health"}</span><span className="footer-right">AURA · browser client</span></footer>
      </main>
      {view === "chat" && <aside className="browser-chat-rail"><StatusCard backend={backend} socket={socket} runtime={runtime} ollama={ollama} lastVoice={lastVoice} /><QuickRuntime runtime={runtime} onNavigate={setView} /><AppActivityRail activity={activity} onNavigate={setView} onInspect={inspectActivity} /><section className="browser-voice-card web-card"><div className="browser-voice-mark"><span>◖</span><i /><i /></div><div><b>Voice is on desktop</b><p>Voice worker events show up here; browser microphone control is not available.</p></div></section></aside>}
      {selectedActivity && <div className="web-inspector-backdrop" role="presentation" onClick={() => setSelectedActivity(null)}><section className="web-inspector" role="dialog" aria-modal="true" aria-label="Activity details" onClick={event => event.stopPropagation()}><div className="web-inspector-head"><div><p className="browser-eyebrow">{selectedActivity.category || "EVENT"} · {shortTime(selectedActivity.createdAt)}</p><h2>{selectedActivity.title}</h2><p className="browser-muted">{selectedActivity.detail}</p></div><button className="web-icon-button" onClick={() => setSelectedActivity(null)} aria-label="Close details">×</button></div><pre>{JSON.stringify(selectedActivity.payload || selectedActivity, null, 2)}</pre></section></div>}
      {toast && <div role="status" className="browser-toast"><span>!</span>{toast}</div>}
    </div>
  );
}

export default BrowserApp;
