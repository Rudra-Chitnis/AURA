// ── API client — connects to existing Express backend ──────────────────────

let _token  = typeof window !== "undefined" ? window.localStorage?.getItem("aura_token") : null;
const _usesViteProxy = typeof window !== "undefined" && !window.aura && window.location.port === "5173";
const _savedBrowserBackend = typeof window !== "undefined" ? window.localStorage?.getItem("aura_browser_backend") : null;
let _baseUrl = typeof window !== "undefined" && !window.aura
  ? (_usesViteProxy && window.location.protocol === "https:" && /^http:\/\/(localhost|127\.0\.0\.1):5000\/?$/i.test(_savedBrowserBackend || "")
    ? window.location.origin
    : _savedBrowserBackend || (_usesViteProxy ? window.location.origin : "http://localhost:5000"))
  : "http://localhost:5000";

export const setToken   = (t) => {
  _token = t;
  if (typeof window !== "undefined") {
    if (t) window.localStorage?.setItem("aura_token", t);
    else window.localStorage?.removeItem("aura_token");
  }
};
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
export const ask = (query) =>
  apiFetch("/api/ai/ask", {
    method: "POST",
    body:   JSON.stringify({
      query,
      time_context: new Date().toLocaleString(),
    }),
  });

// ── AI — streaming SSE ────────────────────────────────────────────────────
export const askStream = async (query, _history = [], onToken, onDone, { signal } = {}) => {
  const startedAt = performance.now();
  let firstTokenMs = null;
  const res = await fetch(`${_baseUrl}/api/ai/ask-stream`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${_token}`,
    },
    body: JSON.stringify({
      query,
      time_context: new Date().toLocaleString(),
    }),
    signal,
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); msg = j.message || msg; } catch {}
    throw new Error(msg);
  }

  if (!res.body?.getReader) throw new Error("The Core response did not include a readable stream.");
  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer    = "";
  let tokenCount = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // hold incomplete line

    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") {
        if (tokenCount === 0) throw new Error("AURA returned an empty response stream.");
        const metrics = { durationMs: Math.round(performance.now() - startedAt), firstTokenMs };
        onDone?.(metrics);
        return metrics;
      }
      let token;
      try { token = JSON.parse(data); } catch { continue; }
      if (token && typeof token === "object" && token.__error) {
        throw new Error(token.message || "AURA could not complete this response.");
      }
      if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
      tokenCount += 1;
      onToken?.(token);
    }
  }

  const metrics = { durationMs: Math.round(performance.now() - startedAt), firstTokenMs };
  onDone?.(metrics);
  return metrics;
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

// Local desktop-runtime capabilities are hosted by backend Core.
export const getRuntimeState = () => apiFetch("/api/runtime/state");

export const getConversationHistory = () => apiFetch("/api/conversation/history");

export const getRecentDiagnostics = (limit = 100) =>
  apiFetch(`/api/diagnostics/recent?limit=${encodeURIComponent(limit)}`);

export const getHealthStatus = async () => {
  try {
    const response = await fetch(`${_baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = await response.json().catch(() => ({}));
    return response.ok && body?.ok
      ? { status: "online", body }
      : { status: response.status === 503 ? "degraded" : "offline", body };
  } catch (error) {
    return { status: "offline", body: null, error };
  }
};

export const dispatchRuntimeAction = (action) =>
  apiFetch("/api/runtime/actions", {
    method: "POST",
    body: JSON.stringify(action),
  });
