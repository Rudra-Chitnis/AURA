// ── API client — connects to existing Express backend ──────────────────────

let _token  = null;
let _baseUrl = "http://localhost:5000";

export const setToken   = (t) => { _token   = t; };
export const setBaseUrl = (u) => { _baseUrl = u; };
export const getToken   = ()  => _token;

// ── Internal fetch helper ─────────────────────────────────────────────────
const apiFetch = async (path, options = {}) => {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (_token) headers["Authorization"] = `Bearer ${_token}`;

  const res = await fetch(`${_baseUrl}${path}`, { ...options, headers });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.message || msg; } catch {}
    throw new Error(msg);
  }

  return res.json();
};

// ── Auth ──────────────────────────────────────────────────────────────────
export const login = (email, password) =>
  apiFetch("/api/auth/login", {
    method: "POST",
    body:   JSON.stringify({ email, password }),
  });

export const register = (name, email, password) =>
  apiFetch("/api/auth/register", {
    method: "POST",
    body:   JSON.stringify({ name, email, password }),
  });

export const getProfile = () => apiFetch("/api/auth/profile");

// ── AI — blocking ─────────────────────────────────────────────────────────
export const ask = (query, history = []) =>
  apiFetch("/api/ai/ask", {
    method: "POST",
    body:   JSON.stringify({
      query,
      history,
      time_context: new Date().toLocaleString(),
    }),
  });

// ── AI — streaming SSE ────────────────────────────────────────────────────
export const askStream = async (query, history = [], onToken, onDone) => {
  const res = await fetch(`${_baseUrl}/api/ai/ask-stream`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${_token}`,
    },
    body: JSON.stringify({
      query,
      history,
      time_context: new Date().toLocaleString(),
    }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.message || msg; } catch {}
    throw new Error(msg);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // hold incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") { onDone?.(); return; }
      try { onToken(JSON.parse(data)); } catch {}
    }
  }

  onDone?.();
};

// ── Memory ────────────────────────────────────────────────────────────────
export const getMemories = () => apiFetch("/api/memory/list");

export const storeMemory = (content, type = "general") =>
  apiFetch("/api/memory/store", {
    method: "POST",
    body:   JSON.stringify({ content, type }),
  });

export const searchMemory = (query) =>
  apiFetch("/api/memory/search", {
    method: "POST",
    body:   JSON.stringify({ query }),
  });

// ── Reminders ─────────────────────────────────────────────────────────────
export const getReminders = () => apiFetch("/api/reminders");

export const createReminder = (text, reminderTime, recurring = false) =>
  apiFetch("/api/reminders", {
    method: "POST",
    body:   JSON.stringify({ text, reminderTime, recurring }),
  });

export const cancelReminder = (id) =>
  apiFetch(`/api/reminders/${id}`, { method: "DELETE" });

// ── Logs ──────────────────────────────────────────────────────────────────
export const getLogs = () => apiFetch("/api/log");

// ── Health check ─────────────────────────────────────────────────────────
// Uses /api/health which verifies both Express AND MongoDB are ready.
// The root endpoint (/) only confirms Express is alive, not Mongo.
export const healthCheck = async () => {
  try {
    const res = await fetch(`${_baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const json = await res.json();
    return json?.ok === true;
  } catch {
    return false;
  }
};
