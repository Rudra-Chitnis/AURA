import { useCallback, useEffect, useRef, useState } from "react";
import { getHealthStatus, getRecentDiagnostics, getRuntimeState } from "../lib/api";

const MAX_ACTIVITY = 180;

function describeEvent(event) {
  switch (event.type) {
    case "connected": return { title: "Event stream connected", category: "connection", tone: "good" };
    case "runtime-state": return { title: `Core ${event.state || "state updated"}`, category: "runtime", tone: "good" };
    case "timer-tick": return null;
    case "timer-fired": return { title: `Timer finished · ${event.label || "Timer"}`, detail: event.text, category: "timer", tone: "good" };
    case "reminder-updated": return null;
    case "reminder-fired": return { title: `Reminder · ${event.text || "Reminder"}`, detail: event.body, category: "reminder", tone: "good" };
    case "action": return { title: `Action · ${event.action || "completed"}`, detail: [event.app, event.query].filter(Boolean).join(" · "), category: "action", tone: "good" };
    case "voice": return { title: `Voice · ${event.state || "activity"}`, detail: event.text, category: "voice", tone: "neutral" };
    case "diagnostic": return { title: event.issue || event.diagnosticType || "Runtime diagnostic", detail: event.cause || event.source, category: "diagnostic", tone: event.severity === "error" ? "danger" : "warning" };
    case "memory": return { title: "Memory saved", detail: event.content, category: "memory", tone: "neutral" };
    case "reminder": return { title: "Reminder", detail: event.text, category: "reminder", tone: "neutral" };
    default:
      if (typeof event.type === "string" && event.type.startsWith("debug:")) {
        const category = event.type.slice("debug:".length);
        return { title: `Runtime · ${category.replaceAll("_", " ")}`, detail: event.detail || event.reason || event.event, category: "debug", tone: category.includes("error") ? "danger" : "neutral" };
      }
      if (event.type) return { title: `Event · ${event.type}`, detail: event.message || event.detail, category: "event", tone: "neutral" };
      return null;
  }
}

export default function useBrowserRuntime(wsUrl, authenticated, apiBaseUrl) {
  const [backend, setBackend] = useState({ status: "checking", body: null });
  const [socket, setSocket] = useState("connecting");
  const [runtime, setRuntime] = useState({ state: "unknown", timers: [], reminders: [] });
  const [activity, setActivity] = useState([]);
  const [diagnostics, setDiagnostics] = useState([]);
  const [lastVoice, setLastVoice] = useState(null);
  const [ollama, setOllama] = useState({ status: "unknown", detail: "No separate Ollama health endpoint is exposed." });
  const retryRef = useRef(null);
  const retryCount = useRef(0);
  const socketRef = useRef(null);
  const mountedRef = useRef(false);
  const lastRuntimeError = useRef("");

  const addActivity = useCallback((event, override) => {
    const description = override || describeEvent(event);
    if (!description) return;
    const createdAt = event.createdAt || event.timestamp || new Date().toISOString();
    const id = `${createdAt}-${event.type || description.category}-${Math.random().toString(36).slice(2, 7)}`;
    setActivity(current => [{ id, ...description, createdAt, payload: event }, ...current].slice(0, MAX_ACTIVITY));
  }, []);

  const refreshRuntime = useCallback(async () => {
    if (!authenticated) return;
    try {
      const state = await getRuntimeState();
      if (!state || typeof state.state !== "string" || !Array.isArray(state.timers) || !Array.isArray(state.reminders)) {
        throw new Error("Core returned an invalid runtime state response.");
      }
      lastRuntimeError.current = "";
      setRuntime(current => ({ ...current, ...state }));
    } catch (error) {
      if (lastRuntimeError.current !== error.message) {
        lastRuntimeError.current = error.message;
        addActivity({ type: "error", message: error.message }, { title: "Could not refresh runtime state", detail: error.message, category: "error", tone: "danger" });
      }
    }
  }, [authenticated, addActivity]);

  const refreshDiagnostics = useCallback(async () => {
    if (!authenticated) return;
    try {
      const result = await getRecentDiagnostics(100);
      setDiagnostics(Array.isArray(result.events) ? result.events : []);
    } catch (error) {
      addActivity({ type: "error", message: error.message }, { title: "Diagnostics unavailable", detail: error.message, category: "error", tone: "warning" });
    }
  }, [authenticated, addActivity]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      const next = await getHealthStatus();
      if (!cancelled) setBackend(next);
    };
    check();
    const interval = setInterval(check, 8000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!authenticated) return undefined;
    refreshRuntime();
    refreshDiagnostics();
    const interval = setInterval(refreshRuntime, 5000);
    return () => clearInterval(interval);
  }, [authenticated, refreshRuntime, refreshDiagnostics]);

  useEffect(() => {
    mountedRef.current = true;
    let closedByCleanup = false;

    const connect = () => {
      if (!mountedRef.current || closedByCleanup) return;
      setSocket(retryCount.current ? "reconnecting" : "connecting");
      let ws;
      try { ws = new WebSocket(wsUrl); }
      catch (error) {
        setSocket("offline");
        addActivity({ type: "error", message: error.message }, { title: "Event stream could not start", detail: error.message, category: "connection", tone: "danger" });
        scheduleReconnect();
        return;
      }
      socketRef.current = ws;

      ws.onopen = () => {
        retryCount.current = 0;
        clearTimeout(retryRef.current);
        setSocket("online");
        addActivity({ type: "connected" });
      };
      ws.onmessage = message => {
        let event;
        try {
          event = JSON.parse(message.data);
          if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("Unexpected event payload");
        } catch {
          addActivity({ type: "error", message: "The event stream returned an unreadable message." }, { title: "Malformed event received", category: "error", tone: "warning" });
          return;
        }

        if (event.type === "runtime-state") setRuntime(current => ({ ...current, state: event.state || current.state }));
        if (event.type === "timer-tick") setRuntime(current => ({ ...current, timers: Array.isArray(event.timers) ? event.timers : [] }));
        if (event.type === "reminder-updated") setRuntime(current => ({ ...current, reminders: Array.isArray(event.reminders) ? event.reminders : [] }));
        if (event.type === "voice") setLastVoice(event);
        if (event.type === "diagnostic") setDiagnostics(current => [event, ...current].slice(0, 100));
        if (event.type === "debug:ollama" || (event.type?.startsWith("debug:") && event.type.includes("ollama"))) {
          setOllama({ status: event.event || "active", detail: event.detail || "Reported by runtime debug events." });
        }
        addActivity(event);
      };
      ws.onerror = () => { setSocket("reconnecting"); ws.close(); };
      ws.onclose = () => {
        if (socketRef.current === ws) socketRef.current = null;
        if (closedByCleanup || !mountedRef.current) return;
        setSocket("offline");
        scheduleReconnect();
      };
    };

    const scheduleReconnect = () => {
      if (closedByCleanup || !mountedRef.current) return;
      const delay = Math.min(1000 * (1.7 ** retryCount.current), 30000);
      retryCount.current += 1;
      retryRef.current = setTimeout(connect, delay);
    };

    connect();
    return () => {
      closedByCleanup = true;
      mountedRef.current = false;
      clearTimeout(retryRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [wsUrl, addActivity]);

  return {
    backend, socket, runtime, activity, diagnostics, lastVoice, ollama,
    addActivity, refreshRuntime, refreshDiagnostics,
    clearActivity: () => setActivity([]),
  };
}
