import { useEffect, useRef, useCallback } from "react";
import useStore from "../store/useStore";

// Connects to the AURA WebSocket hub (port 5001)
// and dispatches events into Zustand store.

export default function useWebSocket() {
  const wsRef        = useRef(null);
  const retryRef     = useRef(null);
  const retryCount   = useRef(0);

  const {
    settings,
    setVoiceState,
    setVoiceTranscript,
    setCurrentResponse,
    addMessage,
    startStreaming,
    addAction,
    addToast,
    reminders,
    setReminders,
    addDebugEvent,
  } = useStore();

  const handleEvent = useCallback((event) => {
    try {
      const msg = JSON.parse(event.data);

      switch (msg.type) {
        case "voice": {
          setVoiceState(msg.state || "idle");
          if (msg.text) setVoiceTranscript(msg.text);

          // When voice picks up a transcript → add as user message in chat
          if (msg.state === "thinking" && msg.text) {
            addMessage({
              id:        `voice-user-${Date.now()}`,
              role:      "user",
              content:   msg.text,
              timestamp: new Date().toISOString(),
            });
          }

          // When voice starts speaking → add AURA message + update display
          if (msg.state === "speaking" && msg.text) {
            setCurrentResponse(msg.text);
            const id = `voice-aura-${Date.now()}`;
            addMessage({
              id,
              role:      "assistant",
              content:   msg.text,
              timestamp: new Date().toISOString(),
            });
          }

          // When going idle → clear the response display
          if (msg.state === "idle") {
            setCurrentResponse("");
            setVoiceTranscript("");
          }
          break;
        }

        case "action": {
          setVoiceState("executing");
          addAction({
            type:      msg.action || "open",
            app:       msg.app    || "unknown",
            query:     msg.query  || "",
            timestamp: msg.timestamp || new Date().toISOString(),
          });
          // Reset to idle after brief delay
          setTimeout(() => setVoiceState("idle"), 2000);
          break;
        }

        case "reminder": {
          addToast({ type: "reminder", message: `🔔 Reminder: ${msg.text}`, duration: 6000 });
          window.aura?.notify({ title: "AURA Reminder", body: msg.text });
          break;
        }

        case "memory": {
          addToast({ type: "info", message: `💾 Saved: "${msg.content}"` });
          break;
        }

        // ── Debug events from Node.js backend (via wsHub broadcast) ──────
        // These are emitted by debugLogger.js _broadcast() calls.
        // Type prefix is "debug:" (e.g. "debug:mode", "debug:memory").
        default:
          if (msg.type && msg.type.startsWith("debug:")) {
            // Strip the "debug:" prefix so the store handler sees the plain type
            addDebugEvent({ ...msg, type: msg.type.slice("debug:".length), source: "node" });
          }
          break;
      }
    } catch (e) {
      console.warn("[WS] parse error:", e);
    }
  }, [setVoiceState, setVoiceTranscript, setCurrentResponse, addMessage, startStreaming, addAction, addToast, setReminders, addDebugEvent]);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const wsUrl = settings.wsUrl || "ws://localhost:5001";
    try {
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        retryCount.current = 0;
        clearTimeout(retryRef.current);
        console.log("[WS] Connected to AURA hub");
      };

      ws.onmessage = handleEvent;

      ws.onclose = () => {
        wsRef.current = null;
        // Retry with backoff up to 30s
        const delay = Math.min(1000 * Math.pow(1.6, retryCount.current), 30000);
        retryCount.current++;
        retryRef.current = setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();

      wsRef.current = ws;
    } catch (e) {
      console.warn("[WS] connect error:", e);
    }
  }, [settings.wsUrl, handleEvent]);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(retryRef.current);
      wsRef.current?.close();
    };
  }, [connect]);
}
