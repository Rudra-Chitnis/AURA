"""
AURA Debug Logger — voice/debug_logger.py

Provides structured, color-coded observability for the Python voice pipeline.
Activated by the same environment variable as the Node.js logger:

    AURA_DEBUG=true   (or AURA_DEBUG=1)

When enabled:
  • Every pipeline decision is logged to stderr with ANSI color + prefix.
  • Debug events are also emitted to stdout as  AURA:DEBUG:<json>  lines,
    which Electron's main.js parses and forwards to the renderer via IPC.
  • Session lifecycle events are written to  debug/sessions/  (Node.js owns
    the primary session file; Python appends its events to a sidecar JSON).

When disabled (default): all calls are no-ops — zero performance impact.

Usage:
    from debug_logger import dbg
    dbg.intent("detect_intent", "open_app:spotify", stage=2, verb="play", app="spotify")
    dbg.stream_event("first-token", detail="backend connected", ms=340)
"""

from __future__ import annotations

import os
import sys
import json
import time
from datetime import datetime, timezone
from typing import Any, Optional

# ─────────────────────────────────────────────────────────────────────────────
# GLOBAL DEBUG FLAG
# ─────────────────────────────────────────────────────────────────────────────
_DEBUG_ENV = os.environ.get("AURA_DEBUG", "").lower()
DEBUG: bool = _DEBUG_ENV in ("true", "1")

# ─────────────────────────────────────────────────────────────────────────────
# FILE PATHS — mirrors Node.js debugLogger path resolution
# debug/ is at the project root (two levels above voice/)
# ─────────────────────────────────────────────────────────────────────────────
_VOICE_DIR   = os.path.dirname(os.path.abspath(__file__))
_PROJECT_DIR = os.path.dirname(_VOICE_DIR)
_DEBUG_ROOT  = os.path.join(_PROJECT_DIR, "debug")
_SESSION_DIR = os.path.join(_DEBUG_ROOT, "sessions")

# ─────────────────────────────────────────────────────────────────────────────
# ANSI COLOR PALETTE — matches Node.js debugLogger colors exactly
# ─────────────────────────────────────────────────────────────────────────────
class _C:
    MODE          = "\x1b[35m"     # magenta
    INTENT        = "\x1b[36m"     # cyan
    ENTITY        = "\x1b[33m"     # yellow
    MEMORY        = "\x1b[32m"     # green
    PROMPT        = "\x1b[34m"     # blue
    LLM           = "\x1b[94m"     # bright blue
    SANITIZER     = "\x1b[91m"     # bright red
    STREAM        = "\x1b[96m"     # bright cyan
    ACTION        = "\x1b[36m"     # cyan
    RETRY         = "\x1b[91m"     # bright red
    CONTEXT       = "\x1b[90m"     # dark gray
    HISTORY       = "\x1b[93m"     # bright yellow
    IDENTITY      = "\x1b[95m"     # bright magenta
    OLLAMA        = "\x1b[92m"     # bright green
    FILTER        = "\x1b[31m"     # red
    GATE          = "\x1b[33m"     # yellow
    CONTAMINATION = "\x1b[41m\x1b[97m"  # red background, white text
    SESSION       = "\x1b[97m"     # bright white
    DIM           = "\x1b[2m"
    BOLD          = "\x1b[1m"
    RESET         = "\x1b[0m"


# ─────────────────────────────────────────────────────────────────────────────
# INTERNAL UTILITIES
# ─────────────────────────────────────────────────────────────────────────────

def _ts() -> str:
    """Human-readable timestamp for log lines."""
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _ensure_dirs() -> None:
    """Create debug directories if they don't exist. Non-fatal on failure."""
    try:
        os.makedirs(_SESSION_DIR, exist_ok=True)
    except OSError:
        pass


def _log(prefix: str, color: str, *lines: str) -> None:
    """Core stderr writer — all public API routes through this."""
    if not DEBUG:
        return
    ts    = _ts()
    label = f"{color}[{prefix.upper():<14}]{_C.RESET}"
    head  = f"{_C.DIM}{ts}{_C.RESET} {label}"
    for line in lines:
        if line is not None and line != "":
            print(f"{head} {line}", file=sys.stderr, flush=True)


def _emit(event_type: str, payload: dict[str, Any]) -> None:
    """
    Emit a debug event to stdout in the AURA:DEBUG: protocol.
    Electron main.js watches for this prefix and forwards events to the
    renderer process via IPC  channel  'debug-event'.

    Format:  AURA:DEBUG:<json>\n
    """
    if not DEBUG:
        return
    try:
        data = {"type": event_type, "ts": _ts(), **payload}
        print(f"AURA:DEBUG:{json.dumps(data, separators=(',', ':'))}", flush=True)
    except Exception:
        pass  # never crash on observability failures


# ─────────────────────────────────────────────────────────────────────────────
# PUBLIC TRACING API
# All methods are unconditionally safe to call — they return immediately
# with no side effects when DEBUG is False, and silently swallow all
# exceptions when DEBUG is True so debug infrastructure NEVER crashes
# the runtime pipeline.
# ─────────────────────────────────────────────────────────────────────────────

class _DebugLogger:
    """
    Singleton debug logger for the voice pipeline.
    Import via:  from debug_logger import dbg

    KEY SAFETY CONTRACT:
      • dbg.DEBUG   — always safe to read (instance attribute, never raises)
      • dbg.*()     — every method is internally try/except guarded; exceptions
                       are silently discarded.  After _MAX_FAILURES consecutive
                       failures the logger self-disables to avoid log spam.
    """

    _MAX_FAILURES = 5  # auto-disable after this many consecutive errors

    def __init__(self) -> None:
        # Expose the module-level DEBUG flag as an instance attribute so that
        # external callers can safely write  `if dbg.DEBUG:`  without an
        # AttributeError.  This was the primary runtime crash vector.
        self.DEBUG: bool = DEBUG
        self._disabled: bool = False
        self._failure_count: int = 0

    # ── Internal safety wrapper ───────────────────────────────────────────────

    def _safe(self, fn, *args, **kwargs):
        """
        Execute fn(*args, **kwargs) inside a try/except.
        If it raises, increment the failure counter; after _MAX_FAILURES
        consecutive failures disable the logger entirely and log one warning.
        Successes reset the counter.
        """
        try:
            fn(*args, **kwargs)
            self._failure_count = 0  # reset on success
        except Exception as exc:
            self._failure_count += 1
            if self._failure_count >= self._MAX_FAILURES:
                self._disabled = True
                try:
                    print(
                        f"[AURA DEBUG] Logger disabled after {self._MAX_FAILURES} "
                        f"consecutive failures (last: {exc!r}). "
                        "Runtime is unaffected.",
                        file=sys.stderr, flush=True,
                    )
                except Exception:
                    pass

    def _active(self) -> bool:
        """Return True only when debug output should be produced."""
        return self.DEBUG and not self._disabled

    # ── Intent routing ────────────────────────────────────────────────────────

    def intent(
        self,
        text: str,
        resolved: str,
        *,
        stage: Optional[int] = None,
        verb: Optional[str] = None,
        app: Optional[str] = None,
        reason: Optional[str] = None,
    ) -> None:
        """Log the final resolved intent for a user utterance."""
        if not self._active():
            return
        def _inner():
            stage_str  = f"stage={stage}  " if stage is not None else ""
            verb_str   = f"verb={repr(verb)}  " if verb else ""
            app_str    = f"app={repr(app)}  " if app else ""
            reason_str = f"reason: {reason}" if reason else ""
            _log("INTENT", _C.INTENT,
                 f'"{text[:70]}"',
                 f"  {stage_str}{verb_str}{app_str}{_C.BOLD}→ {resolved}{_C.RESET}",
                 f"  {reason_str}" if reason_str else "")
            _emit("intent", {"text": text[:60], "resolved": resolved,
                             "stage": stage, "verb": verb, "app": app, "reason": reason})
        self._safe(_inner)

    def action_stage(
        self,
        text: str,
        stage: int,
        verb: Optional[str],
        app_key: Optional[str],
        reason: str,
    ) -> None:
        """Log an intermediate action routing decision at a specific stage."""
        if not self._active():
            return
        def _inner():
            dst = f"{_C.BOLD}→ {app_key}{_C.RESET}" if app_key else "→ no match"
            _log("ACTION", _C.ACTION,
                 f"stage={stage}  verb={repr(verb) if verb else '—'}  {dst}",
                 f"  text={repr(text[:60])}",
                 f"  reason: {reason}")
            _emit("action_route", {"text": text[:60], "stage": stage,
                                   "verb": verb, "app": app_key, "reason": reason})
        self._safe(_inner)

    def passive_intent(self, text: str, result: Optional[str]) -> None:
        """Log passive media intent detection result."""
        if not self._active():
            return
        def _inner():
            if result:
                _log("ACTION", _C.ACTION,
                     f"passive-media  → {_C.BOLD}{result}{_C.RESET}",
                     f"  text={repr(text[:60])}")
            else:
                _log("ACTION", _C.ACTION,
                     "passive-media  → no match",
                     f"  text={repr(text[:60])}")
            _emit("passive_intent", {"text": text[:60], "result": result})
        self._safe(_inner)

    # ── Stream / LLM lifecycle ────────────────────────────────────────────────

    def stream_start(self, query: str) -> None:
        """Log that get_answer_stream() is about to open the SSE connection."""
        if not self._active():
            return
        def _inner():
            _log("STREAM", _C.STREAM, f"opening  query={repr(query[:60])}")
            _emit("stream_start", {"query": query[:60]})
        self._safe(_inner)

    def stream_event(
        self,
        event: str,
        *,
        detail: Optional[str] = None,
        ms: Optional[int] = None,
        token_count: Optional[int] = None,
    ) -> None:
        """Log a streaming inference lifecycle event."""
        if not self._active():
            return
        def _inner():
            timing  = f"  {ms}ms" if ms is not None else ""
            tokens  = f"  tokens={token_count}" if token_count is not None else ""
            detail_ = f"  {detail}" if detail else ""
            _log("STREAM", _C.STREAM, f"{event}{timing}{tokens}{detail_}")
            _emit("stream_event", {"event": event, "ms": ms,
                                   "tokenCount": token_count, "detail": detail})
        self._safe(_inner)

    def llm_raw(self, text: str) -> None:
        """Log raw LLM text before any cleaning."""
        if not self._active():
            return
        def _inner():
            preview  = (text or "")[:120].replace("\n", "↵")
            ellipsis = "…" if len(text or "") > 120 else ""
            _log("LLM", _C.LLM, f'raw="{preview}{ellipsis}"')
            _emit("llm_raw", {"preview": preview})
        self._safe(_inner)

    def sanitizer(
        self,
        input_text: str,
        output_text: str,
        removed: list,
    ) -> None:
        """Log sanitizer modifications — only logs when something was removed."""
        if not self._active() or not removed:
            return
        def _inner():
            _log("SANITIZER", _C.SANITIZER,
                 f"removed {len(removed)} fragment(s):",
                 *[f"  ✂ {repr(r[:80])}" for r in removed])
            _emit("sanitizer", {"count": len(removed),
                                 "removed": [r[:80] for r in removed]})
        self._safe(_inner)

    def malformed(self, text: str, reason: str) -> None:
        """Log a malformed/contaminated response that was rejected."""
        if not self._active():
            return
        def _inner():
            preview = (text or "")[:80].replace("\n", "↵")
            _log("FILTER", _C.FILTER,
                 f"MALFORMED — {reason}",
                 f"  text={repr(preview)}")
            _emit("malformed", {"reason": reason, "preview": preview})
        self._safe(_inner)

    # ── Contamination ─────────────────────────────────────────────────────────

    def contamination(
        self,
        ctype: str,
        match: str,
        location: str,
    ) -> None:
        """Log a contamination pattern hit."""
        if not self._active():
            return
        def _inner():
            _log("CONTAMINATION", _C.CONTAMINATION,
                 f"TYPE={ctype}  LOCATION={location}",
                 f"  match={repr((match or '')[:80])}")
            _emit("contamination", {"type": ctype, "match": (match or "")[:80],
                                    "location": location})
        self._safe(_inner)

    # ── VAD / recording lifecycle ─────────────────────────────────────────────

    def vad_event(self, event: str, detail: Optional[str] = None) -> None:
        """Log a VAD recording lifecycle event (start, speech, silence, end)."""
        if not self._active():
            return
        def _inner():
            detail_ = f"  {detail}" if detail else ""
            _log("STREAM", _C.STREAM, f"vad:{event}{detail_}")
            _emit("vad", {"event": event, "detail": detail})
        self._safe(_inner)

    # ── STT ───────────────────────────────────────────────────────────────────

    def stt_result(
        self,
        raw: str,
        cleaned: str,
        noise_gate: Optional[float] = None,
        dropped: bool = False,
    ) -> None:
        """Log a Whisper STT transcription result."""
        if not self._active():
            return
        def _inner():
            gate_str = f"  noise_prob={noise_gate:.2f}" if noise_gate is not None else ""
            if dropped:
                _log("FILTER", _C.FILTER,
                     f"STT dropped (noise gate{gate_str})",
                     f"  raw={repr(raw[:60])}")
            else:
                _log("INTENT", _C.INTENT,
                     f"STT  raw={repr(raw[:60])}",
                     f"     → cleaned={repr(cleaned[:60])}{gate_str}")
            _emit("stt", {"raw": raw[:60], "cleaned": cleaned[:60],
                          "dropped": dropped, "noiseGate": noise_gate})
        self._safe(_inner)

    # ── Main loop / session lifecycle ─────────────────────────────────────────

    def loop_state(self, state: str, detail: Optional[str] = None) -> None:
        """
        Log the main loop state machine transition.
        state: IDLE | LISTENING | TRANSCRIBING | THINKING | SPEAKING
        """
        if not self._active():
            return
        def _inner():
            detail_ = f"  {detail}" if detail else ""
            _log("SESSION", _C.SESSION,
                 f"STATE → {_C.BOLD}{state}{_C.RESET}{detail_}")
            _emit("loop_state", {"state": state, "detail": detail})
        self._safe(_inner)

    def session_start(self) -> None:
        """Log voice.py startup — called once in main()."""
        if not self._active():
            return
        def _inner():
            _ensure_dirs()
            _log("SESSION", _C.SESSION,
                 f"{_C.BOLD}AURA voice debug session started{_C.RESET}",
                 f"AURA_DEBUG=true  pid={os.getpid()}",
                 f"debug root: {_DEBUG_ROOT}")
            _emit("py_session_start", {"pid": os.getpid()})
        self._safe(_inner)

    def session_end(self, reason: str = "normal") -> None:
        """Log voice.py shutdown."""
        if not self._active():
            return
        def _inner():
            _log("SESSION", _C.SESSION,
                 f"{_C.BOLD}AURA voice session ending{_C.RESET}  reason={reason}")
            _emit("py_session_end", {"reason": reason})
        self._safe(_inner)

    # ── Retry events ──────────────────────────────────────────────────────────

    def retry(self, reason: str, attempt: int, max_attempts: int) -> None:
        """Log a retry trigger."""
        if not self._active():
            return
        def _inner():
            _log("RETRY", _C.RETRY,
                 f"attempt={attempt}/{max_attempts}  reason={repr(reason)}")
            _emit("retry", {"reason": reason, "attempt": attempt,
                            "maxAttempts": max_attempts})
        self._safe(_inner)


# ─────────────────────────────────────────────────────────────────────────────
# SINGLETON EXPORT
# ─────────────────────────────────────────────────────────────────────────────
dbg = _DebugLogger()
