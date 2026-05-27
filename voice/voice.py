import os
import sys
# Must be set before numpy / ctranslate2 are imported — limits MKL thread pools
# that can cause mkl_malloc failures on some systems.
os.environ.setdefault("OMP_NUM_THREADS", "1")
os.environ.setdefault("MKL_NUM_THREADS", "1")

import re
import io
import json
import time
import queue as _queue
import ctypes
import difflib
import asyncio
import threading
import tempfile
import subprocess
import webbrowser
import urllib.parse
import requests
import sounddevice as sd
import numpy as np
import scipy.io.wavfile as wav
import edge_tts
from collections import deque
from faster_whisper import WhisperModel
from datetime import datetime, timedelta
from debug_logger import dbg  # AURA forensic observability — no-op when AURA_DEBUG not set

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
# Read backend URL from environment (set by Electron main.js via AURA_BACKEND).
# Falls back to localhost:5000 for manual / terminal launches.
BACKEND        = os.environ.get("AURA_BACKEND", "http://localhost:5000").rstrip("/")
TOKEN_FILE     = os.path.expanduser("~/.aura_token")
POLL_INTERVAL  = 30

# TTS
TTS_VOICE     = "en-US-AriaNeural"
TTS_RATE      = "-10%"   # slightly slower → more natural
MAX_SENTENCES = 3        # S1 (core) + S2 (detail) + S3 (context) — aligns with prompt structure
MAX_TTS_CHARS = 600      # safety cap in case a single sentence is unusually long

# VAD recording
VAD_THRESHOLD      = 300    # RMS energy — catches quieter speech
VAD_SILENCE_CHUNKS = 25     # × 100 ms = 1.8 s silence → prevents mid-sentence cutoff
VAD_MAX_DURATION   = 25

# Whisper
WHISPER_MODEL_SIZE = "small"
# Noise gate: mean no_speech_prob threshold across all vad-surviving segments.
# If the average exceeds this value the recording is treated as background noise
# rather than speech and transcription is discarded (returns "").
# Conservative default (0.70) avoids rejecting low-energy but valid speech.
STT_NOISE_GATE = 0.70

# Known names for fuzzy STT correction
KNOWN_NAMES  = ["Chitnis", "Rudra", "AURA", "Sadgi", "Garg"]
_NAMES_LOWER = {n.lower(): n for n in KNOWN_NAMES}

# Short commands that must survive the word-count filter in clean_transcript().
# Without this whitelist, single-word replies like "yes", "no", "stop" are
# rejected as gibberish because they contain fewer than 2 words of length > 1.
_SHORT_COMMANDS = frozenset({
    "yes", "no", "stop", "pause", "resume", "quit", "cancel",
    "okay", "ok", "sure", "thanks", "bye", "hello", "hi",
    "repeat", "again", "louder", "quieter", "faster", "slower",
})

# ─────────────────────────────────────────────
# GLOBALS
# ─────────────────────────────────────────────
_token        = None
whisper_model = None

_speak_lock         = threading.Lock()   # prevents overlapping TTS (main + reminder threads)
_tts_fail_count     = 0                  # consecutive TTS failures — triggers device recovery at 2
_playback_interrupt = threading.Event()  # set by interrupt monitor when user speaks during TTS
_paused             = threading.Event()  # set by stdin monitor when Electron sends PAUSE command
_sleeping           = threading.Event()  # set when AURA enters sleep/goodbye idle — cleared by WAKE
_should_quit        = threading.Event()  # set by QUIT stdin command; checked in main loop for clean exit

# Short-term conversation memory — last 20 exchanges (10 Q+A pairs)
_conversation_history: deque = deque(maxlen=20)
_last_response: str = ""        # dedup guard: skip if identical to previous response
_correction_just_occurred: bool = False  # set by correction handler, consumed by get_answer_stream
_history_loaded_for_token: str | None = None
_history_persist_q = _queue.Queue()
_history_persist_worker_started = False
_history_persist_lock = threading.Lock()

# Stores the most recent open_app action so follow-up commands ("play it", "play the song")
# can resume the same action without the user restating the full command.
# Context expires after ACTION_CONTEXT_TTL seconds to prevent stale followup routing.
ACTION_CONTEXT_TTL    = 300        # 5 minutes — stale context is cleared automatically
_last_action_context: dict  = {}   # keys: "app_key", "query" (optional)
_last_action_ctx_time: float = 0.0 # monotonic timestamp of last context update

# ─────────────────────────────────────────────
# CONVERSATIONAL ENTITY CONTEXT (P2.A.2)
# Tracks recently referenced media/app entities so follow-up commands
# like "play this on youtube" or "open it again" resolve deterministically.
#
# Design:
#   • Entries are merged (not replaced) so multiple entity types coexist.
#     A YouTube action updates last_search but does NOT erase last_song
#     set by a prior Spotify action.
#   • TTL matches ACTION_CONTEXT_TTL — context expires after 5 minutes.
#   • Keys:
#       last_song   — specific song/track query played on Spotify (e.g. "lofi beats")
#       last_search — most recent YouTube/browser search query
#       last_app    — most recent app opened (app_key string)
#       last_url    — most recent URL opened (reserved for future use)
# ─────────────────────────────────────────────
ENTITY_CTX_TTL    = 300          # seconds — same as action context TTL
_entity_ctx: dict  = {}          # merged entity state
_entity_ctx_time: float = 0.0   # monotonic timestamp of last update

# ─────────────────────────────────────────────
# NATIVE OS ORCHESTRATION — TIMER / REMINDER (P2.A.3)
#
# AURA delegates countdown and reminder delivery to the Windows OS:
#   Timers   — opens ms-clock:timer (visible countdown UI) + detached PowerShell
#              balloon toast.  The PowerShell process owns the sleep and fires
#              independently of voice.py runtime state.
#   Reminders — writes a PS1 script to %APPDATA%\AURA\reminders\ and registers
#              a Windows Task Scheduler one-shot task (/sc ONCE /Z) that fires
#              the balloon notification at the exact reminder time, even when
#              AURA is not running.  MongoDB + reminder_poll_loop are preserved
#              as the in-session spoken-delivery fallback.
#
# What is NO LONGER Python-owned:
#   - threading.Timer countdown threads
#   - _active_timers registry + lock
#   - Timer lifecycle (start / fire / cleanup)
# ─────────────────────────────────────────────
_AURA_REMINDERS_DIR = os.path.join(
    os.environ.get("APPDATA", os.path.expanduser("~")), "AURA", "reminders"
)

# ─────────────────────────────────────────────
# PERSISTENT TTS EVENT LOOP
# One daemon thread owns a single asyncio event loop for ALL TTS coroutines.
# Both speak() and speak_stream()._generate() submit work via
# asyncio.run_coroutine_threadsafe() — thread-safe, no per-call loop overhead,
# and safe to call from any thread including daemon threads.
# ─────────────────────────────────────────────
_tts_loop: asyncio.AbstractEventLoop = None
_tts_loop_ready = threading.Event()


def _start_tts_loop():
    """Start the persistent TTS event loop in a dedicated daemon thread.
    Must be called exactly once at startup, before any speak() call."""
    global _tts_loop
    loop = asyncio.new_event_loop()
    _tts_loop = loop

    def _run():
        asyncio.set_event_loop(loop)
        _tts_loop_ready.set()   # signal that the loop is accepting work
        loop.run_forever()

    t = threading.Thread(target=_run, name="tts-event-loop", daemon=True)
    t.start()
    if not _tts_loop_ready.wait(timeout=5.0):
        print("[TTS] WARNING: persistent event loop did not start within 5s")


def _run_tts_coro(coro, timeout=None):
    """
    Submit a coroutine to the persistent TTS loop and block until complete.
    timeout: if set (seconds), wraps coro in asyncio.wait_for before submitting.
    Propagates all exceptions — including asyncio.TimeoutError — to the caller.
    Thread-safe: may be called from main thread or any worker thread.
    """
    if timeout is not None:
        coro = asyncio.wait_for(coro, timeout=timeout)
    future = asyncio.run_coroutine_threadsafe(coro, _tts_loop)
    return future.result()   # blocks; re-raises any coroutine exception


# ─────────────────────────────────────────────
# INTERRUPT MONITOR LIFECYCLE
# _monitor_stop is rebound each speaking turn (module-level rebind).
# The monitor thread holds its own reference via parameter — module rebind
# does NOT affect the already-running thread; the old thread sees its own event.
# Starts in "stopped" state (set = stop signal sent).
# ─────────────────────────────────────────────
_monitor_stop: threading.Event = threading.Event()
_monitor_stop.set()   # no monitor running at startup

# ─────────────────────────────────────────────
# ACTIVE SUBPROCESS TRACKING
# _active_subprocess holds the Popen handle for any MP3 subprocess player
# so _stop_all_playback() can terminate it immediately on interrupt.
# Protected by _subprocess_lock for cross-thread safety.
# ─────────────────────────────────────────────
_active_subprocess: subprocess.Popen = None
_subprocess_lock = threading.Lock()


# ─────────────────────────────────────────────
# TOKEN MANAGEMENT
# ─────────────────────────────────────────────
def save_token(token):
    with open(TOKEN_FILE, "w") as f:
        f.write(token)


def load_token():
    if os.path.exists(TOKEN_FILE):
        with open(TOKEN_FILE) as f:
            tok = f.read().strip()
        return tok if tok else None
    return None


def do_login():
    print("\n--- AURA Login ---")
    email    = input("Email: ").strip()
    password = input("Password: ").strip()
    try:
        resp = requests.post(
            f"{BACKEND}/api/auth/login",
            json={"email": email, "password": password},
            timeout=10
        )
        resp.raise_for_status()
        token = resp.json()["token"]
        save_token(token)
        print("Login successful.\n")
        return token

    except requests.exceptions.ConnectionError:
        print(f"\nERROR: Cannot connect to backend at {BACKEND}")
        print("Make sure the backend is running: npm run dev")
        raise SystemExit(1)
    except Exception as e:
        print(f"Login failed: {e}")
        raise SystemExit(1)


def ensure_authenticated():
    """
    Set the module-level _token used for all authenticated backend calls.

    Electron (AUTO_MODE) path:
      - stdin is a pipe when spawned by Electron → isatty() returns False.
      - Never call input() or do_login() — stdin is owned by the IPC monitor.
      - If a token file exists, use it as-is.  If it's expired the per-request
        401 from the backend is the natural degradation signal.
      - If no token exists, set _token=None and continue — TTS/audio still work;
        LLM calls will fail gracefully until the user logs in via the desktop UI.

    Terminal path:
      - Verify the saved token against the backend profile endpoint.
      - If expired or missing, prompt for login interactively.
    """
    global _token
    _is_electron = not sys.stdin.isatty()
    token = load_token()

    if _is_electron:
        # ── Electron / desktop mode ───────────────────────────────────────────
        # Must NEVER block on input() — stdin belongs to the IPC command monitor.
        # Validate the stored token against /api/auth/profile before trusting it.
        # Backend is guaranteed to be running before Electron spawns voice.py.
        # On 401/403: clear _token — voice.py will wait for TOKEN:<value> via stdin.
        # On connection error: trust the token (backend briefly unreachable).
        if token:
            try:
                resp = requests.get(
                    f"{BACKEND}/api/auth/profile",
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=3
                )
                if resp.status_code == 200:
                    _token = token
                    print("[AUTH] Session token verified.", flush=True)
                else:
                    _token = None
                    print(
                        f"[AUTH] Stored token rejected (HTTP {resp.status_code}) — "
                        "waiting for fresh token from Electron via TOKEN stdin command.",
                        flush=True,
                    )
            except requests.exceptions.ConnectionError:
                # Backend briefly unreachable — trust token, validate on first call.
                _token = token
                print("[AUTH] Backend unreachable at startup — using stored token.", flush=True)
            except Exception as e:
                _token = token
                print(f"[AUTH] Token validation skipped ({type(e).__name__}) — using stored token.", flush=True)
        else:
            _token = None
            print(
                "[AUTH] No token found — LLM features unavailable until login "
                "via the desktop app.",
                flush=True,
            )
        return

    # ── Terminal / developer mode ─────────────────────────────────────────────
    if token:
        try:
            resp = requests.get(
                f"{BACKEND}/api/auth/profile",
                headers={"Authorization": f"Bearer {token}"},
                timeout=5
            )
            if resp.status_code == 200:
                user = resp.json().get("user", {})
                print(f"Welcome back, {user.get('name', 'there')}!")
                _token = token
                return
            else:
                print("Saved session expired. Please log in again.")
        except requests.exceptions.ConnectionError:
            print(f"\nERROR: Cannot connect to backend at {BACKEND}")
            print("Make sure the backend is running: npm run dev")
            raise SystemExit(1)
    _token = do_login()


def auth_headers():
    """Return Authorization header dict. Empty dict if no valid token is set."""
    if not _token:
        return {}
    return {"Authorization": f"Bearer {_token}"}


def _try_reload_token() -> bool:
    """
    Try to reload a fresher JWT from disk after a 401 response.

    Returns True if a different (possibly valid) token was found and loaded.
    Called on 401 responses — Electron may have written a fresh token to disk
    since voice.py last read it (e.g. user re-logged in via the desktop UI).
    The next API call will then use the reloaded token automatically.
    """
    global _token
    fresh = load_token()
    if fresh and fresh != _token:
        _token = fresh
        print("[AUTH] Token reloaded from disk after 401.", flush=True)
        return True
    return False


# ─────────────────────────────────────────────
# UI EVENT PUSH  (non-blocking, best-effort)
# Posts state updates to the backend which broadcasts via WebSocket
# to the desktop UI.  All calls are fire-and-forget inside a daemon thread
# so a network blip never blocks the voice pipeline.
# ─────────────────────────────────────────────
# ── Serial event sender ───────────────────────────────────────────────────────
# A single daemon thread drains this queue so that rapid back-to-back
# _push_event() calls always reach the backend (and the UI) in call order.
# Replacing per-call thread spawns eliminates the race condition that previously
# allowed an immediately-following idle event to arrive before speaking.
_event_send_queue: _queue.Queue = _queue.Queue()


def _event_sender_loop() -> None:
    """Drain _event_send_queue, sending one HTTP POST at a time."""
    while True:
        event = _event_send_queue.get()
        try:
            requests.post(
                f"{BACKEND}/api/events/push",
                json=event,
                timeout=2,
            )
        except Exception:
            pass  # UI update is best-effort — never crash voice pipeline
        finally:
            _event_send_queue.task_done()


def _push_event(event: dict) -> None:
    """Enqueue a JSON event for ordered delivery to the desktop UI."""
    _event_send_queue.put(event)


def _push_diagnostic(event: dict) -> None:
    """Send a structured runtime diagnostic without blocking the voice loop."""
    event = event or {}
    _push_event({
        "type": "diagnostic",
        "diagnosticType": event.get("type", "voice_runtime_event"),
        "source": "voice",
        "severity": event.get("severity", "info"),
        "data": event.get("data", {}),
    })


# ─────────────────────────────────────────────
# MODELS
# ─────────────────────────────────────────────
def load_models():
    global whisper_model
    print(f"Loading Whisper '{WHISPER_MODEL_SIZE}' model...")
    # float32 avoids MKL quantized kernels that cause mkl_malloc failures on some CPUs.
    whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="float32")
    print("Models ready.\n")


# ─────────────────────────────────────────────
# STDIN COMMAND MONITOR
# Runs as a daemon thread in AUTO_MODE (Electron).
# Reads PAUSE / RESUME commands written by main.js to voice.py's stdin.
# ─────────────────────────────────────────────
def _stdin_monitor():
    """Read line commands from stdin (sent by Electron via voiceProc.stdin.write).

    Commands:
      PAUSE        — suspend the listen loop (no recording)
      RESUME       — resume the listen loop
      QUIT         — terminate voice.py
      WAKE         — exit sleep state, resume listening
      SPEAK:<text> — speak the given text via TTS (used for timer/reminder delivery)
    """
    try:
        for line in sys.stdin:
            raw = line.strip()           # preserve case for SPEAK text
            cmd = raw.upper()
            if cmd == "PAUSE":
                _paused.set()
                _push_event({"type": "voice", "state": "idle"})
                print("[voice] Paused by user.", flush=True)
            elif cmd == "RESUME":
                _paused.clear()
                print("[voice] Resumed by user.", flush=True)
            elif cmd == "QUIT":
                print("[voice] Quit command received.", flush=True)
                _should_quit.set()
                return
            elif cmd == "WAKE":
                _sleeping.clear()
                print("AURA:AWAKE", flush=True)
                _push_event({"type": "voice", "state": "idle"})
                print("[voice] Woke from sleep.", flush=True)
            elif cmd.startswith("TOKEN:"):
                new_token = raw[6:].strip()
                if new_token:
                    global _token
                    _token = new_token
                    print("[AUTH] Session token refreshed via Electron.", flush=True)
            elif raw.upper().startswith("SPEAK:"):
                speak_text = raw[6:].strip()
                if speak_text:
                    print(f"[voice] Speaking via Electron request: {speak_text!r}", flush=True)
                    threading.Thread(target=speak, args=(speak_text,), daemon=True).start()
    except (EOFError, OSError):
        pass  # stdin closed — normal on Electron shutdown


# ─────────────────────────────────────────────
# STT HELPERS
# ─────────────────────────────────────────────
def clean_transcript(text):
    if not text:
        return ""
    text = re.sub(r'\[.*?\]', '', text).strip()                          # strip [noise] tags
    text = re.sub(r'\b(\w+)(\s+\1){2,}\b', r'\1', text, flags=re.IGNORECASE)  # collapse repeats
    text = text.strip()
    # Allow known short commands through before the word-count gate.
    # Without this, "yes", "no", "stop", "pause" are silently dropped as gibberish.
    if text.lower() in _SHORT_COMMANDS:
        return text
    if len([w for w in text.split() if len(w) > 1]) < 2:
        return ""   # gibberish / too short
    return text


def correct_names(text):
    """Fuzzy-correct STT mishearings of known names (e.g. "chitness" → "Chitnis")."""
    words = []
    for word in text.split():
        clean = word.rstrip(".,!?;:")
        trail = word[len(clean):]
        cl    = clean.lower()
        if cl in _NAMES_LOWER:
            words.append(_NAMES_LOWER[cl] + trail)
            continue
        if len(cl) >= 4:
            close = difflib.get_close_matches(cl, _NAMES_LOWER.keys(), n=1, cutoff=0.75)
            if close:
                words.append(_NAMES_LOWER[close[0]] + trail)
                continue
        words.append(word)
    return " ".join(words)


# ─────────────────────────────────────────────
# SPEECH NATURALIZATION
# Converts LLM text → natural spoken audio chunks.
# Rule-based only — zero latency added.
# ─────────────────────────────────────────────

_FORMAL_TO_CASUAL = [
    (re.compile(r'\btherefore\b',     re.IGNORECASE), 'so'),
    (re.compile(r'\bhowever\b',       re.IGNORECASE), 'but'),
    (re.compile(r'\badditionally\b',  re.IGNORECASE), 'also'),
    (re.compile(r'\bfurthermore\b',   re.IGNORECASE), 'also'),
    (re.compile(r'\bmoreover\b',      re.IGNORECASE), 'and'),
    (re.compile(r'\bnevertheless\b',  re.IGNORECASE), 'still'),
    (re.compile(r'\bconsequently\b',  re.IGNORECASE), 'so'),
    (re.compile(r'\bin addition\b',   re.IGNORECASE), 'also'),
    (re.compile(r'\bas a result\b',   re.IGNORECASE), 'so'),
    (re.compile(r'\bfor instance\b',  re.IGNORECASE), 'like'),
    (re.compile(r'\bfor example\b',   re.IGNORECASE), 'like'),
    (re.compile(r'\bsubsequently\b',  re.IGNORECASE), 'then'),
    (re.compile(r'\bin conclusion\b', re.IGNORECASE), 'so'),
    (re.compile(r'\bto summarize\b',  re.IGNORECASE), 'basically'),
    (re.compile(r'\bin summary\b',    re.IGNORECASE), 'basically'),
    (re.compile(r'\butilize\b',       re.IGNORECASE), 'use'),
    (re.compile(r'\bfacilitate\b',    re.IGNORECASE), 'help'),
    (re.compile(r'\bimplementation\b',re.IGNORECASE), 'setup'),
]

_WORD_SPLIT_LIMIT = 25   # words — only split at genuinely long sentences

_SPLIT_CONJUNCTIONS = {'and', 'but', 'so', 'because', 'when', 'if', 'which', 'or', 'while'}


def _apply_casual_connectors(text):
    """Replace formal connectors with casual speech equivalents, preserving initial caps."""
    def _make_replacer(repl):
        def _inner(m):
            return repl.capitalize() if m.group(0)[0].isupper() else repl
        return _inner
    for pattern, replacement in _FORMAL_TO_CASUAL:
        text = pattern.sub(_make_replacer(replacement), text)
    return text


def _word_split(text, limit=_WORD_SPLIT_LIMIT):
    """
    Recursively split sentences longer than `limit` words at the most
    natural boundary: comma near midpoint → conjunction → hard midpoint.
    Returns a list of shorter sentence strings.
    """
    words = text.split()
    if len(words) <= limit:
        return [text]

    mid = len(words) // 2
    split_at = None

    # 1. Comma just before or at midpoint (±4 words)
    for i in range(mid, max(1, mid - 4), -1):
        if words[i - 1].endswith(','):
            split_at = i
            break

    # 2. Conjunction word near midpoint
    if split_at is None:
        for delta in range(0, 5):
            for i in [mid + delta, mid - delta]:
                if 0 < i < len(words) and words[i].lower() in _SPLIT_CONJUNCTIONS:
                    split_at = i
                    break
            if split_at is not None:
                break

    if split_at is None:
        split_at = mid

    part1 = ' '.join(words[:split_at]).rstrip(',')
    part2 = ' '.join(words[split_at:])

    if part1 and part1[-1] not in '.!?':
        part1 += '.'

    return _word_split(part1, limit) + _word_split(part2, limit)


def naturalize_for_speech(text):
    """
    Full speech preparation pipeline:
      1. Strip markdown artifacts
      2. Swap formal connectors → casual equivalents
      3. Ensure terminal punctuation
      4. Split by word count (≤14 words per TTS chunk)
    Returns a list of clean, TTS-ready strings.
    """
    if not text:
        return []

    # Strip markdown
    text = re.sub(r'\*+([^*]+)\*+', r'\1', text)
    text = re.sub(r'`[^`]*`', '', text)
    text = re.sub(r'^\s*[\-\*\•]\s+', '', text, flags=re.MULTILINE)
    text = re.sub(r'^\s*#+\s+', '', text, flags=re.MULTILINE)
    text = text.replace('\n', ' ')
    text = re.sub(r'\s{2,}', ' ', text).strip()

    if not text:
        return []

    # Casual connectors
    text = _apply_casual_connectors(text)

    # Terminal punctuation
    if text[-1] not in '.!?':
        text += '.'

    # Word-count split → list of chunks
    return [c.strip() for c in _word_split(text) if c.strip()]


# ─────────────────────────────────────────────
# AUDIO — VAD RECORDING
# ─────────────────────────────────────────────
def record_audio(filename="input.wav"):
    sd.stop()   # release any lingering playback before opening InputStream
    samplerate = 16000
    chunk_size = int(samplerate * 0.1)   # 100 ms per chunk
    max_chunks = int(VAD_MAX_DURATION * 10)
    # Pre-speech timeout: if no speech is detected in the first 5 seconds, stop
    # recording early and return the silent audio so the main loop can reset quickly.
    # This prevents 12-second dead cycles when no one speaks (e.g. between turns,
    # or when the microphone captures silence).
    PRE_SPEECH_TIMEOUT = 50   # 50 × 100ms = 5s

    print("Listening... (speak now)")
    audio_chunks = []
    silent_count = 0
    spoke        = False

    with sd.InputStream(samplerate=samplerate, channels=1, dtype="int16") as stream:
        for i in range(max_chunks):
            chunk, _ = stream.read(chunk_size)
            audio_chunks.append(chunk.copy())
            rms = int(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
            if rms > VAD_THRESHOLD:
                spoke        = True
                silent_count = 0
            elif spoke:
                silent_count += 1
                if silent_count >= VAD_SILENCE_CHUNKS:
                    break
            elif not spoke and i >= PRE_SPEECH_TIMEOUT:
                # No speech detected in 5s — exit early to keep the loop responsive
                break

    wav.write(filename, samplerate, np.concatenate(audio_chunks, axis=0))
    print("Recording done.")
    return spoke   # True if VAD detected speech, False if silent / pre-speech timeout


def _check_noise_gate(segments):
    """
    Return True if the segment list looks like background noise rather than speech.
    Computes mean no_speech_prob across all vad-surviving segments.
    A mean above STT_NOISE_GATE means Whisper's acoustic model disagrees with
    VAD's energy-based detection — the recording is likely noise, not speech.
    Returns False (pass) when segments is empty so the caller handles it normally.
    """
    if not segments:
        return False
    mean_nsp = sum(s.no_speech_prob for s in segments) / len(segments)
    if mean_nsp > STT_NOISE_GATE:
        print(f"[STT] Noise gate: mean no_speech_prob={mean_nsp:.2f} > {STT_NOISE_GATE} — discarding")
        return True
    return False


def transcribe_audio(filename="input.wav"):
    global whisper_model
    print("Transcribing...")

    # Guard: whisper_model is None when a previous OOM reload failed and left the
    # global unset. Without this guard the AttributeError from None.transcribe()
    # is not a RuntimeError, so the except clause below misses it — crashing the
    # entire process on the next listen cycle.
    # Attempt a fresh reload here so the session self-heals instead of dying.
    if whisper_model is None:
        print("[STT] Whisper model is None — attempting reload before transcription...")
        try:
            whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="float32")
            print("[STT] Whisper model reloaded successfully.")
        except Exception as load_err:
            print(f"[STT] Cannot reload Whisper model: {load_err}")
            return ""

    try:
        # Collect the generator to a list so we can check confidence before
        # joining text. faster_whisper returns a lazy generator — list() forces
        # all segment inference now (same work as before, just materialized).
        segments_gen, _ = whisper_model.transcribe(
            filename, language="en", beam_size=3, vad_filter=True
        )
        segments = list(segments_gen)

        if _check_noise_gate(segments):
            return ""

        text = " ".join(seg.text for seg in segments).strip().lower()
        return correct_names(clean_transcript(text))
    except RuntimeError as e:
        err = str(e)
        if "mkl_malloc" in err or "failed to allocate" in err or "out of memory" in err.lower():
            print("[STT] Memory error — reloading Whisper model and retrying...")
            try:
                import gc
                whisper_model = None
                gc.collect()
                whisper_model = WhisperModel(WHISPER_MODEL_SIZE, device="cpu", compute_type="float32")
                segments_gen, _ = whisper_model.transcribe(
                    filename, language="en", beam_size=3, vad_filter=True
                )
                segments = list(segments_gen)

                if _check_noise_gate(segments):
                    return ""

                text = " ".join(seg.text for seg in segments).strip().lower()
                return correct_names(clean_transcript(text))
            except Exception as reload_err:
                print(f"[STT] Reload failed: {reload_err}")
                return ""
        print(f"[STT] Transcription error: {e}")
        return ""


# ─────────────────────────────────────────────
# TTS — edge-tts + playback
# ─────────────────────────────────────────────
def speak(text, _report_failure=True):
    """
    Thread-safe TTS. Plays via sounddevice (WAV) or MCI (MP3).
    Fallback to PowerShell SAPI only if edge-tts completely fails.
    Tracks consecutive failures — resets audio device after 2 in a row.
    Returns True if audio was played, False if both paths failed.

    _report_failure=False: suppress the "audio unavailable" notice.
    speak_stream() passes False and prints its own single notice per turn.
    Direct callers (reminders, timers, short answers) leave it True.
    """
    global _tts_fail_count
    print(f"[TTS] called: {text[:60]}{'...' if len(text) > 60 else ''}")
    print(f"AURA: {text}")
    with _speak_lock:
        audio_played = False
        # Retry up to 3 times with brief backoff before falling back to SAPI.
        # Timeout reduced from 30s to 8s — edge-tts on a warm connection responds in
        # <1s; 8s is generous for a cold-start or congested network while still
        # failing fast enough for the desktop to feel responsive.
        for _try in range(3):
            try:
                _run_tts_coro(_speak_edge(text), timeout=8.0)
                audio_played = True
                break
            except asyncio.TimeoutError:
                print(f"[TTS] edge-tts timeout (attempt {_try+1}/3)")
            except Exception as e:
                print(f"[TTS] edge-tts error [{type(e).__name__}] (attempt {_try+1}/3): {e}")
            if _try < 2:
                time.sleep(0.2 * (_try + 1))   # 0.2 s → 0.4 s backoff
        if not audio_played:
            audio_played = _speak_fallback(text)
        if audio_played:
            _tts_fail_count = 0
        else:
            _tts_fail_count += 1
            if _report_failure:
                print("[AURA] audio unavailable")
            if _tts_fail_count >= 2:
                print("[AURA] reinitializing audio device")
                sd.stop()
                try:
                    sd.default.device = None
                except Exception:
                    pass
                _tts_fail_count = 0
        return audio_played


async def _speak_edge(text):
    # Timeout is applied by _run_tts_coro(timeout=30.0) — not here.
    # Retry logic lives in the callers (speak / _generate thread).
    audio_bytes = await _generate_tts_bytes(text)
    _play_audio_bytes(audio_bytes)


async def _generate_tts_bytes(text):
    """
    Generate TTS as WAV (RIFF/PCM) bytes via edge-tts.

    WAV-only: no MP3, no MCI.  MCI error 263 (MCIERR_CANNOT_LOAD_DRIVER) is
    caused by routing MP3 bytes to Windows MCI on systems without the MPEG
    audio driver registered — eliminating the MP3 path eliminates the error.

    If WAV cannot be produced (network fail, old edge-tts), raises RuntimeError
    so the caller falls back to PowerShell SAPI — which is always available.
    """
    # Attempt 1: explicit WAV PCM format (edge-tts >= 6.1)
    try:
        communicate = edge_tts.Communicate(
            text, TTS_VOICE, rate=TTS_RATE,
            output_format="riff-24khz-16bit-mono-pcm"
        )
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        if chunks:
            result = b"".join(chunks)
            if result[:4] == b'RIFF':
                print(f"[TTS] generated {len(result)} bytes (WAV/PCM)")
                return result
            print(f"[TTS] explicit WAV returned non-RIFF ({result[:4]!r}) — trying default format")
        else:
            print("[TTS] explicit WAV: no chunks — trying default format")
    except TypeError:
        pass   # output_format unsupported in this edge-tts version — try without it
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"[TTS] explicit WAV error [{type(e).__name__}]: {e}")

    # Attempt 2: default edge-tts format — accept whatever it returns (WAV or MP3).
    # _play_audio_bytes will route WAV to sounddevice, MP3 to subprocess player.
    # MCI is never used.
    try:
        communicate = edge_tts.Communicate(text, TTS_VOICE, rate=TTS_RATE)
        chunks = []
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                chunks.append(chunk["data"])
        if chunks:
            result = b"".join(chunks)
            fmt = "WAV/default" if result[:4] == b'RIFF' else f"MP3 ({result[:4]!r})"
            print(f"[TTS] generated {len(result)} bytes ({fmt})")
            return result
        print("[TTS] default format: no chunks")
    except asyncio.CancelledError:
        raise
    except Exception as e:
        print(f"[TTS] default format error [{type(e).__name__}]: {e}")

    raise RuntimeError("edge-tts returned no audio — falling back to SAPI")


def _play_mp3_subprocess(filepath):
    """
    Play an MP3 file via subprocess (ffplay or PowerShell MediaPlayer).
    Uses Popen instead of run() so the handle is stored in _active_subprocess
    and _stop_all_playback() can terminate it immediately on interrupt.
    MCI is never used.
    """
    global _active_subprocess

    # Try ffplay (part of ffmpeg — widely installed on dev systems)
    try:
        proc = subprocess.Popen(
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", filepath],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        with _subprocess_lock:
            _active_subprocess = proc
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.terminate()
            proc.wait()
        with _subprocess_lock:
            if _active_subprocess is proc:
                _active_subprocess = None
        if proc.returncode == 0:
            return True
    except FileNotFoundError:
        pass   # ffplay not installed — try next
    except Exception as e:
        print(f"[TTS] ffplay error: {e}")

    # Try PowerShell MediaPlayer (WPF-based, available on all modern Windows without extra installs)
    try:
        # Convert Windows path to a proper file:/// URI so [uri] cast succeeds
        file_uri = "file:///" + filepath.replace("\\", "/")
        ps_script = (
            f"Add-Type -AssemblyName PresentationCore; "
            f"$mp = New-Object System.Windows.Media.MediaPlayer; "
            f"$mp.Open([uri]'{file_uri}'); "
            f"Start-Sleep -Milliseconds 800; "
            f"$mp.Play(); "
            f"$dur = 0; $wait = 0; "
            f"while ($mp.NaturalDuration.HasTimeSpan -eq $false -and $wait -lt 30) "
            f"{{ Start-Sleep -Milliseconds 100; $wait++ }}; "
            f"if ($mp.NaturalDuration.HasTimeSpan) "
            f"{{ $dur = [math]::Ceiling($mp.NaturalDuration.TimeSpan.TotalSeconds) }}; "
            f"Start-Sleep -Seconds ($dur + 1); "
            f"$mp.Close()"
        )
        proc = subprocess.Popen(
            ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", ps_script],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        with _subprocess_lock:
            _active_subprocess = proc
        try:
            proc.wait(timeout=120)
        except subprocess.TimeoutExpired:
            proc.terminate()
            proc.wait()
        with _subprocess_lock:
            if _active_subprocess is proc:
                _active_subprocess = None
        if proc.returncode == 0:
            return True
    except Exception as e:
        print(f"[TTS] PowerShell MediaPlayer error: {e}")

    return False


def _play_mp3_bytes(mp3_bytes):
    """
    Write MP3 bytes to a temp file and play via pygame → subprocess.
    MCI was removed: it does not support MP3 on systems without the MPEG
    DirectShow audio filter and produced error 263 (MCIERR_CANNOT_LOAD_DRIVER).
    The subprocess path (ffplay / PowerShell MediaPlayer) is more reliable
    on modern Windows and covers all cases MCI handled.
    """
    tmp_path = None
    try:
        with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as f:
            f.write(mp3_bytes)
            tmp_path = f.name

        # 1st attempt: pygame (pip install pygame — reliable cross-platform MP3)
        try:
            import pygame
            if not pygame.mixer.get_init():
                pygame.mixer.init()
            pygame.mixer.music.load(tmp_path)
            pygame.mixer.music.play()
            while pygame.mixer.music.get_busy():
                time.sleep(0.05)
            pygame.mixer.music.unload()
            return True
        except ImportError:
            pass   # pygame not installed — try next
        except Exception as e:
            print(f"[TTS] pygame error: {e}")

        # 2nd attempt: subprocess (ffplay / PowerShell MediaPlayer)
        if _play_mp3_subprocess(tmp_path):
            return True

        return False
    except Exception as e:
        print(f"[TTS] MP3 temp write error: {e}")
        return False
    finally:
        if tmp_path:
            try:
                time.sleep(0.1)   # brief pause to allow subprocess to release the file handle
                os.unlink(tmp_path)
            except Exception:
                pass


def _play_audio_bytes(audio_bytes):
    """
    Route audio bytes to the right player.
    WAV (RIFF header) → sounddevice (handles 24kHz PCM from edge-tts).
    MP3 (anything else) → subprocess player (ffplay or PowerShell MediaPlayer).
    MCI is never used.
    """
    if audio_bytes[:4] == b'RIFF':
        print(f"[TTS] playing WAV ({len(audio_bytes)} bytes)")
        _play_wav_sounddevice(audio_bytes)
    else:
        print(f"[TTS] playing MP3 ({len(audio_bytes)} bytes) via subprocess")
        if not _play_mp3_bytes(audio_bytes):
            raise RuntimeError("MP3 playback failed — no working player found (ffplay/PowerShell)")


def _play_wav_sounddevice(wav_bytes):
    """
    Play raw WAV bytes.
    Primary:  sounddevice  — handles arbitrary sample rates (e.g. 24kHz from edge-tts PCM).
    Fallback: winsound     — built-in Windows, but may not support non-standard rates reliably.
    """
    # sounddevice first — correctly handles 24kHz PCM returned by edge-tts
    try:
        rate, audio_data = wav.read(io.BytesIO(wav_bytes))
        duration = len(audio_data) / rate
        sd.play(audio_data, samplerate=rate)
        t = threading.Thread(target=sd.wait, daemon=True)
        t.start()
        t.join(timeout=duration + 3.0)
        if t.is_alive():
            sd.stop()
            raise RuntimeError("sounddevice playback timed out")
        print("[TTS] sounddevice playback complete")
        return
    except Exception as e:
        print(f"[TTS] sounddevice error: {e} — trying winsound")

    # winsound fallback
    try:
        import winsound
        winsound.PlaySound(wav_bytes, winsound.SND_MEMORY)
        print("[TTS] winsound playback complete")
        return
    except Exception as e:
        print(f"[TTS] winsound error: {e}")
        raise RuntimeError("both WAV playback methods failed")


def _play_mp3_mci(filepath):
    """
    DEPRECATED — no longer called (removed from _play_mp3_bytes() in P2.6 / T1 fix).
    MCI produced error 263 (MCIERR_CANNOT_LOAD_DRIVER) on systems without the
    MPEG DirectShow audio filter. Subprocess path covers this case reliably.
    Safe to delete in P3.1 modularization pass.

    Original purpose: Play an MP3 synchronously using Windows MCI (winmm.dll).
    Raises RuntimeError if MCI open or play command fails so the fallback chain activates.
    Does NOT use 'type mpegvideo' — lets Windows auto-detect from file extension,
    which is more reliable on systems without DirectShow MPEG audio filter registered.
    """
    winmm = ctypes.windll.winmm
    path  = os.path.abspath(filepath).replace("\\", "/")
    winmm.mciSendStringW('close _aura_audio', None, 0, None)   # clear any stale alias

    err = winmm.mciSendStringW(f'open "{path}" alias _aura_audio', None, 0, None)
    if err:
        raise RuntimeError(f"[MCI] open failed (err={err})")

    winmm.mciSendStringW('set _aura_audio time format milliseconds', None, 0, None)
    winmm.mciSendStringW('setaudio _aura_audio volume to 1000', None, 0, None)
    time.sleep(0.15)
    winmm.mciSendStringW('seek _aura_audio to start', None, 0, None)

    play_result = [0]
    play_done   = threading.Event()
    def _do_play():
        play_result[0] = winmm.mciSendStringW('play _aura_audio wait', None, 0, None)
        play_done.set()

    t = threading.Thread(target=_do_play, daemon=True)
    t.start()
    t.join(timeout=30.0)
    winmm.mciSendStringW('close _aura_audio', None, 0, None)

    if not play_done.is_set():
        raise RuntimeError("[MCI] playback timed out after 30s")
    if play_result[0]:
        raise RuntimeError(f"[MCI] play command failed (err={play_result[0]})")


def _speak_fallback(text):
    """
    PowerShell System.Speech fallback — returns True if audio was played.
    Writes text to a temp file so special characters can't break the PS command.
    """
    tmp_path = None
    try:
        # Write text to temp file — avoids PS injection via $, `, ", etc.
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt",
                                         delete=False, encoding="utf-8") as f:
            f.write(text)
            tmp_path = f.name
        result = subprocess.run([
            "powershell", "-NoProfile", "-NonInteractive", "-Command",
            f"Add-Type -AssemblyName System.Speech; "
            f"$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
            f"$s.Speak([System.IO.File]::ReadAllText('{tmp_path}'))"
        ], timeout=30)
        return result.returncode == 0
    except Exception as e:
        print(f"[SAPI] fallback error: {e}")
        return False
    finally:
        if tmp_path:
            try: os.unlink(tmp_path)
            except Exception: pass


# ─────────────────────────────────────────────
# INTERRUPT MONITOR + PLAYBACK STOP
# Lets the user cut AURA off mid-sentence by speaking.
# ─────────────────────────────────────────────

def _interrupt_monitor(stop_event: threading.Event):
    """
    Samples the microphone in 50ms chunks while AURA is speaking.
    Sets _playback_interrupt if ~400ms of sustained speech is detected
    (8 consecutive chunks above 2.5× VAD threshold to avoid speaker bleed-through).

    stop_event: per-turn threading.Event. When set, the monitor exits cleanly.
    This eliminates the thread-accumulation bug: the caller sets the previous
    turn's stop_event before creating a new one, guaranteeing exactly one monitor
    thread is alive during the speaking phase.

    The monitor is started only during speak_stream() — NOT before record_audio() —
    so there is no InputStream device conflict with VAD recording.

    Runs as a daemon thread; silently exits if mic is unavailable.
    """
    samplerate     = 16000
    chunk_size     = int(samplerate * 0.05)       # 50 ms
    THRESHOLD      = int(VAD_THRESHOLD * 2.5)     # 750 RMS — well above speaker bleed-through
    TRIGGER_NEEDED = 8                             # 8 × 50ms = 400ms sustained speech
    trigger_count  = 0

    try:
        with sd.InputStream(samplerate=samplerate, channels=1,
                            dtype='int16', latency='low') as stream:
            while not stop_event.is_set() and not _playback_interrupt.is_set():
                chunk, _ = stream.read(chunk_size)
                rms = int(np.sqrt(np.mean(chunk.astype(np.float64) ** 2)))
                if rms > THRESHOLD:
                    trigger_count += 1
                    if trigger_count >= TRIGGER_NEEDED:
                        _playback_interrupt.set()
                        return
                else:
                    trigger_count = max(0, trigger_count - 1)
    except Exception:
        pass   # mic unavailable or stop_event triggered stream close — exit silently


def _stop_all_playback():
    """
    Immediately halt ALL active audio output:
      - sounddevice (WAV via sd.play)
      - winsound    (WAV via SND_MEMORY)
      - subprocess  (ffplay / PowerShell MediaPlayer — tracked in _active_subprocess)
      - pygame      (MP3 via mixer.music)
    Without subprocess + pygame termination, interrupt during MP3 playback
    leaves a zombie process that continues playing audio over the next recording.
    """
    try:
        sd.stop()
    except Exception:
        pass
    try:
        import winsound
        winsound.PlaySound(None, winsound.SND_PURGE)
    except Exception:
        pass
    # Terminate any tracked MP3 subprocess — ffplay or PowerShell MediaPlayer.
    with _subprocess_lock:
        proc = _active_subprocess
    if proc is not None:
        try:
            proc.terminate()
        except Exception:
            pass
    # Stop pygame music if it was loaded for this chunk.
    try:
        import pygame
        if pygame.mixer.get_init() and pygame.mixer.music.get_busy():
            pygame.mixer.music.stop()
    except Exception:
        pass


# ─────────────────────────────────────────────
# PROMPT LEAKAGE FILTER
# Hard-drop any line that is a prompt label or internal reasoning step.
# ─────────────────────────────────────────────

# Lines whose first word(s) match these keywords are prompt echo — discard them.
# IMPORTANT: only match true prompt labels, NOT normal conversational words.
# "you", "aura", "memory" etc. are valid sentence starters — only block them
# when followed by ":" (role-label format) or as multi-word prompt headers.
_LEAK_KEYWORDS = re.compile(
    r'^(?:'
    # Role labels — model echoing prompt structure
    r'(?:user|human|you|assistant|aura)\s*:'
    r'|\[(?:user|human|you|assistant|aura)\]\s*:'
    r'|output\s*:'
    r'|narration\s*:'
    r'|query\s*type'
    r'|thinking\s*step'
    r'|recent\s*conversation'
    r'|your\s*last\s*responses'
    r'|spoken\s*response\s*:'
    r'|what\s*you\s*know\s*about\s*the\s*user'
    # Prompt-internal question/instruction patterns leaking through LLM
    r'|question\s*:'              # "Question: ..." prompt echo
    r'|\(says\s*["\']'           # "(says "..." meta-instruction
    r'|no\s+personal\s+data'     # prompt rule leaking verbatim
    r'|no\s+need\s+to\s+say'    # prompt rule leaking verbatim
    r'|context\s*:'              # prompt section header
    r'|instructions?\s*:'        # prompt section header
    r'|memory\s*:'               # prompt section header
    r'|facts?\s*:'               # prompt section header
    r'|route\s*[:\-—]'          # "route: ..." routing instruction
    # Structural rewrite / summary patterns that indicate context collapse
    r"|here'?s\s+a\s+revised"    # "Here's a revised version of..." edit hallucination
    r'|here\s+is\s+a\s+revised'  # same, uncontracted
    r'|revised\s+version\s+of'   # "Revised version of the conversation..."
    r'|conversation\s*:'         # "Conversation: ..." structural echo
    r'|summary\s*:'              # "Summary: ..." collapsed into conversation
    r'|recap\s*:'                # "Recap: ..."
    r'|aura\s*said'              # "AURA said: ..." meta-commentary
    r'|you\s+said\s*:'           # "You said: ..." transcript echo
    r'|i\s+said\s*:'             # "I said: ..." transcript echo
    r')',
    re.IGNORECASE
)

# Numbered reasoning lines: single digit + "." or ")" at line start (e.g. "1. First...")
# Uses \d (single digit) NOT \d+ — avoids false positives like "20 minutes..."
_NUMBERED_STEP_RE = re.compile(r'^\d[\.\)]\s')

# Bullet reasoning lines: "•", "-", "*" followed by a routing keyword
_BULLET_LEAK_RE = re.compile(
    r'^[•\-\*]\s*(?:personal|general|opinion|mixed|action|high|partial|low)\b',
    re.IGNORECASE
)

# Leading labels stripped from otherwise valid responses:
# "Answer:", "Response:", "AURA:", "Aurax:", "Assistant:" etc.
# Also covers query-type labels that small models echo from the prompt:
# "Personal:", "General:", "Opinion:", "Mixed:", "Action:"
_LEADING_LABEL_RE = re.compile(
    r'^(?:\[(?:user|human|you|assistant|aura)\]|answer|response|spoken\s*response|output|narration|aura\w*|assistant|ai|bot|[qa]'
    r'|personal|general|opinion|mixed|action'
    r')\s*:\s*',
    re.IGNORECASE
)

# Bad openers that survive the label check — strip from response start.
# These are stock phrases small models fall back to (TinyLlama training data bias).
# Positive instruction ("No openers like Sure") doesn't suppress them reliably.
_OPENER_STRIP_RE = re.compile(
    r'^(?:sure\s+thing[!.]?|sure[!.]?|certainly[!.]?|of\s+course[!.]?'
    r'|absolutely[!.]?|great[!.]?|got\s+it[!.]?|ok(?:ay)?[!.]?'
    r'|no\s+problem[!.]?|happy\s+to\s+help[!.]?'
    # Common TinyLlama preamble phrases that survived previous filter passes.
    # These appear at the START of a response before the actual answer, making
    # them safe to strip without risk of removing substantive content.
    r"|that'?s\s+a\s+(?:great|good)\s+question[!.]?"
    r'|i\s+can\s+help\s+(?:you\s+)?(?:with\s+that)?[!.]?'
    r')\s*',
    re.IGNORECASE
)

def _is_leak_line(line):
    s = line.strip()
    if not s:
        return True   # blank
    if _LEAK_KEYWORDS.match(s):
        return True
    if _NUMBERED_STEP_RE.match(s):
        return True
    if _BULLET_LEAK_RE.match(s):
        return True
    return False


# ── Post-response malformed guard ─────────────────────────────────────────────
# Checks the FULL collected response for patterns that indicate the LLM produced
# structural garbage (action confirmations, transcript echoes, context collapse).
# Applied AFTER speak_stream() returns — prevents corrupted turns from entering
# _conversation_history and feeding the contamination loop.
#
# Note: these patterns should already be stripped by _clean_llm_output() per
# sentence. This is a belt-and-suspenders full-response check for anything that
# survived the per-sentence filter or was assembled from multiple partial sentences
# that each appeared clean individually.
_MALFORMED_RESPONSE_RE = re.compile(
    r'(?:'
    # Action confirmation strings that should never appear in conversational output
    r'opening\s+(?:spotify|youtube|amazon|chrome|browser|whatsapp|maps|notepad|calculator)'
    r'|playing\s+.{1,60}on\s+spotify'
    r'|searching\s+(?:amazon|youtube|google)\s+for\b'
    r'|timer\s+set\s+for\b'
    r'|reminder\s+set\s+for\b'
    r'|got\s+it,?\s+i\'?ll\s+remember\s+that'
    # Structural contamination patterns
    r"|here'?s\s+a\s+revised\s+version"
    r'|revised\s+version\s+of\s+the\s+conversation'
    r'|just\s+say\s+["‘’“”]'    # 'Just say "X"' action instruction
    r"|say\s+['\"]"                                  # 'Say "X"' action instruction
    # Prose-level meta-commentary: semantically well-formed sentences that encode
    # LLM identity drift, transcript analysis, or context-collapse.  These pass
    # all line-start filters because they contain no label prefixes, yet they
    # must never be stored as behavioral examples for subsequent turns.
    r"|i\s+don'?t\s+have\s+(?:access\s+to|information\s+about)\s+the\s+user'?s?"
    r'|based\s+on\s+(?:the\s+)?(?:given\s+|above\s+)?conversation'
    r'|as\s+an?\s+ai(?:\s+(?:assistant|language\s+model|system))?\b'
    r'|i\s+(?:am|m)\s+an?\s+ai(?:\s+(?:assistant|language\s+model))?\b'
    r'|i\s+cannot\s+(?:access|retrieve|read|see)\s+(?:the\s+)?(?:user|your\s+personal)'
    r"|i\s+don'?t\s+have\s+(?:the\s+ability|access)\s+to\s+(?:access|retrieve|read)"
    r'|(?:the\s+)?(?:user|human)\s+(?:has\s+(?:not\s+)?(?:mentioned|provided|given|shared)|asked\s+(?:me\s+)?(?:to|about))'
    # Non-conversational system artifacts: error messages, clarify responses, and
    # empathize pre-speaks produced by voice.py itself.  These are exact hard-coded
    # strings that are never valid LLM outputs and must never be stored as behavioral
    # examples.  Matched as substrings (not anchored) so trailing punctuation variants
    # ("I'm having trouble thinking right now. Try again in a moment.") are caught.
    r"|i didn'?t\s+(?:quite\s+)?catch\s+that"
    r'|that sounds tough\.?'
    r"|i'?m having trouble thinking right now"
    r'|something went wrong on my end'
    # Auth-failure message yielded by get_answer_stream on a 401 response.
    # Must not be stored as a behavioral example in history.
    r'|i need to sign in again'
    r')',
    re.IGNORECASE,
)

# Sentence-level scaffold continuation detector.
# Applied per-sentence in get_answer_stream BEFORE yielding to speak_stream.
# Catches the model generating new examples, Q&A pairs, or role-continuation
# from the prompt structure -- patterns that escape _clean_llm_output because
# they are syntactically valid prose with no label prefix.
#
# Why sentence-level is required: _MALFORMED_RESPONSE_RE runs on the FULL
# assembled response AFTER speak_stream returns -- too late to prevent the
# scaffold sentence from being spoken.  This filter runs per-sentence before
# TTS, so scaffold phrases are silently dropped before audio generation.
_SCAFFOLD_LEAK_RE = re.compile(
    r'(?:'
    # Direct continuation of prompt/transcript scaffolding
    r'^(?:assistant|aura|output|narration|recent\s+conversation)\s*:\s*\S'
    r'|^\[(?:user|human|you|assistant|aura)\]\s*:\s*\S'
    # Model generating new examples after the real answer
    r"|here'?s?\s+(?:an?\s+)?example\s+(?:response|answer|reply)"
    r'|here\s+(?:are\s+)?(?:some\s+)?(?:questions?\s+and\s+answers?|q&a|practice)'
    r'|questions?\s+and\s+answers?\s+for\s+you\s+to\s+practice'
    r'|sample\s+(?:response|answer|question)'
    r'|practice\s+question'
    # Model generating "you might say" meta-commentary
    r'|(?:you\s+might|you\s+could)\s+say[:\s]'
    r"|here'?s?\s+how\s+you\s+(?:could|might|would|should)\s+(?:answer|respond|reply)"
    # Model continuing with a new User:/Question: prompt pair
    r'|^(?:question|user|human|assistant|aura|output|narration)\s*:\s*\S'
    r')',
    re.IGNORECASE | re.MULTILINE,
)


def _is_malformed_response(text: str) -> bool:
    """
    Return True if the full collected response contains action-confirmation
    strings or structural garbage that should not be stored in history.
    These patterns indicate the LLM produced action-contaminated output despite
    the per-sentence filter — the response must not be stored as a behavioral
    example for subsequent turns.
    """
    return bool(_MALFORMED_RESPONSE_RE.search(text or ""))


def _is_speakable_stream_chunk(text: str, *, final_fragment: bool = False) -> bool:
    """
    Final gate before streamed text reaches TTS.

    Normal chunks must be valid, non-scaffold assistant prose. Final-buffer
    leftovers are stricter so token tails like "softwa" or ", you!" are dropped.
    """
    if not _is_valid_response(text):
        return False
    if _SCAFFOLD_LEAK_RE.search(text or ""):
        return False
    if _is_malformed_response(text):
        return False

    if final_fragment:
        stripped = (text or "").strip()
        if not stripped:
            return False
        if re.match(r'^[,;:\)\]\}]+', stripped):
            return False
        words = re.findall(r"[A-Za-z][A-Za-z']*", stripped)
        if len(words) < 3:
            return bool(re.match(
                r"^(?:yes|no|okay|ok|sure|maybe|nope|yep|thanks|not sure|it depends)\.?$",
                stripped,
                re.IGNORECASE
            ))
        if stripped[-1] not in ".!?":
            return False
    return True

def _clean_llm_output(text):
    """
    Hard-filter prompt leakage from raw LLM output.
    Drops every line that is a prompt label or internal reasoning step.
    Strips leading Answer:/Response:/Personal:/General: prefixes.
    Strips stock openers (Sure thing!, Certainly!, etc.) from small-model outputs.
    Returns empty string if nothing clean survives.
    """
    if not text:
        return ""
    lines  = text.splitlines()
    kept   = [l for l in lines if not _is_leak_line(l)]
    result = ' '.join(kept).strip()
    result = _LEADING_LABEL_RE.sub('', result).strip()
    result = _OPENER_STRIP_RE.sub('', result).strip()

    # Trace sanitizer actions when something was actually removed.
    # Wrapped in try/except: debug infrastructure must never crash the sanitizer.
    try:
        if dbg.DEBUG and result != (text or "").strip():
            dropped_lines = [l for l in lines if _is_leak_line(l)]
            removed = [l.strip() for l in dropped_lines if l.strip()]
            if not removed and result != text.strip():
                # Label/opener strip changed output — record what was removed
                removed = [text.strip()[:80]]
            dbg.sanitizer(text, result, removed)
    except Exception:
        pass  # observability must never interrupt output cleaning

    return result


def _is_valid_response(text):
    """
    Guard: returns False only for confirmed prompt leakage or empty output.
    Conservative — avoids blocking normal conversational sentences.
    Short replies like "Yes." or "No, thanks." are valid and must pass.
    """
    if not text:
        return False

    # Strip any leading label before checking (e.g. "Aurax: Yes." → "Yes.")
    text = _LEADING_LABEL_RE.sub('', text).strip()
    if not text:
        return False

    # Must contain at least one letter — catches pure punctuation / whitespace
    if not re.search(r'[a-zA-Z]', text):
        return False

    low = text.lower()
    # Only block phrases that NEVER appear in natural assistant speech
    for kw in (
        "thinking step", "query type", "route —",
        "output rules", "recent conversation",
        "what you know about the user:",
        "no personal data", "no need to say",
    ):
        if kw in low:
            return False
    # Catch ALL-CAPS section labels at the start ("MEMORY:", "ROUTE:", "FACTS:")
    if re.match(r'^[A-Z][A-Z\s]{2,}:', text):
        return False
    return True


# ─────────────────────────────────────────────
# OVERLAPPED STREAMING PIPELINE
# Three-stage concurrent pipeline:
#   Stage A (thread) — filter + naturalize LLM sentences → sentence_q
#   Stage B (thread) — generate TTS audio bytes → audio_q (pre-generates ahead)
#   Stage C (main)   — play audio chunks as they arrive
#
# Stage B overlaps Stage C: while sentence N plays, sentence N+1 TTS is
# already being generated. Cuts perceived per-sentence wait to near zero.
# ─────────────────────────────────────────────
def speak_stream(sentence_iter):
    """
    Three-stage concurrent pipeline:
      Stage A (_fill)     — naturalize LLM sentences → sentence_q
      Stage B (_generate) — TTS audio bytes per chunk → audio_q (pre-generates ahead)
      Stage C (main)      — play audio chunks as they arrive

    Sentences from get_answer_stream are already cleaned by _clean_llm_output.
    Stage A does NOT re-filter them — only splits into TTS-friendly chunks.

    Guarantees: if the LLM produced any text at all, something will be spoken
    (edge-tts WAV/MP3 → subprocess player → SAPI — in that order).
    """
    sentence_q = _queue.Queue()
    audio_q    = _queue.Queue(maxsize=2)  # pre-generate up to 2 chunks ahead
    _DONE      = object()                 # sentinel
    _abort     = threading.Event()        # set on persistent playback failure

    spoken    = []    # chunks successfully spoken (any TTS method)
    collected = []    # all chunks from LLM — used as SAPI fallback if nothing played

    # ── Stage A: split LLM sentences into TTS-sized chunks ─────────────
    def _fill():
        count = 0
        chars = 0
        try:
            for s in sentence_iter:
                if _abort.is_set():
                    for _ in sentence_iter: pass   # drain HTTP connection
                    break
                s = s.strip()
                if not s:
                    continue
                # Sentences are pre-cleaned by get_answer_stream/_clean_llm_output.
                # No re-filtering here — just split into TTS-friendly chunks.
                for chunk in naturalize_for_speech(s):
                    if chunk:
                        collected.append(chunk)
                        sentence_q.put(chunk)
                        chars += len(chunk)
                count += 1
                if count >= MAX_SENTENCES or chars >= MAX_TTS_CHARS:
                    for _ in sentence_iter: pass   # drain cleanly
                    break
        except Exception as e:
            print(f"[fill] error: {e}")
        finally:
            sentence_q.put(_DONE)

    # ── Stage B: chunks → TTS audio bytes (overlaps with playback) ──────
    def _generate():
        while True:
            if _abort.is_set():
                # Stage C may have already stopped consuming — use put_nowait so
                # this thread doesn't block indefinitely waiting to put the sentinel.
                try:
                    audio_q.put_nowait(_DONE)
                except _queue.Full:
                    pass   # Stage C already exited; DONE sentinel not needed
                return
            try:
                # 35 s matches the tightest JS-side timeout (12 s first-token +
                # propagation overhead). If the stream dies, Stage A puts _DONE in
                # sentence_q well within this window.
                item = sentence_q.get(timeout=35)
            except _queue.Empty:
                print("[generate] sentence queue timeout — LLM/stream stalled >35s")
                try:
                    # Blocking put so Stage C always receives the sentinel.
                    # put_nowait fails silently when audio_q is full (maxsize=2),
                    # leaving Stage C to block on audio_q.get() for 75s.
                    # 10s is generous for an error-abort path — Stage C drains fast
                    # when the session is already stalling.
                    audio_q.put(_DONE, timeout=10.0)
                except _queue.Full:
                    pass
                return
            if item is _DONE:
                try:
                    # Blocking put so Stage C always receives the sentinel.
                    # put_nowait fails silently when audio_q is full (maxsize=2) —
                    # the common case on 3-sentence responses where both slots are
                    # occupied when LLM finishes. Stage C then blocks on
                    # audio_q.get(timeout=75), producing the TTS stall.
                    # 30s: covers worst-case playback of 2 queued audio chunks
                    # (SAPI cap is 30s per sentence; typical edge-tts is 2-5s).
                    audio_q.put(_DONE, timeout=30.0)
                except _queue.Full:
                    pass   # Stage C already exited via abort path — sentinel not needed
                return
            audio_bytes = None
            # Retry up to 3 times per chunk.
            # 10s timeout: edge-tts is pre-warmed at startup so the connection should
            # already be established; 10s covers transient service hiccups while
            # keeping streaming latency bounded for the desktop UX.
            for _try in range(3):
                try:
                    audio_bytes = _run_tts_coro(_generate_tts_bytes(item), timeout=10.0)
                    break   # success — exit retry loop
                except asyncio.TimeoutError:
                    print(f"[generate] TTS timeout (attempt {_try+1}/3)")
                except Exception as e:
                    print(f"[generate] TTS error (attempt {_try+1}/3) [{type(e).__name__}]: {e}")
                if _try < 2:
                    time.sleep(0.8 * (_try + 1))   # 0.8 s → 1.6 s backoff
            if audio_bytes is None:
                print("[generate] All 3 TTS attempts failed — SAPI will cover this chunk")
            # Use a timed put so Stage B can't block forever if Stage C stops consuming.
            # maxsize=2 means the queue can fill quickly if playback stalls.
            try:
                audio_q.put((item, audio_bytes), timeout=5.0)
            except _queue.Full:
                print("[generate] audio queue full after 5s — Stage C is slow; signaling exit")
                _push_diagnostic({
                    "type": "tts_queue_overflow",
                    "severity": "warn",
                    "data": {
                        "queueDepth": audio_q.qsize(),
                        "stage": "stage_b_to_stage_c",
                    },
                })
                # Without a _DONE sentinel Stage C will block on audio_q.get(timeout=75)
                # after draining existing items — producing the [stream] audio queue timeout
                # — TTS stalled hang. Wait up to 15s for Stage C to finish its current
                # playback call and consume one slot, then push _DONE.
                # 15s covers the worst-case SAPI call (30s subprocess cap is the hard
                # ceiling, but typical SAPI sentences finish in 1–5s).
                # If Stage C already exited (3-failure abort), the put times out and
                # pass is fine — the outer loop is already broken.
                try:
                    audio_q.put(_DONE, timeout=15.0)
                except _queue.Full:
                    pass   # Stage C exited via abort path — sentinel not needed
                return

    t_fill = threading.Thread(target=_fill,     daemon=True)
    t_gen  = threading.Thread(target=_generate, daemon=True)
    t_fill.start()
    t_gen.start()

    # ── Stage C: play audio as it arrives ──────────────────────────────
    global _tts_fail_count
    consecutive_fail = 0

    while True:
        try:
            item = audio_q.get(timeout=5)
        except _queue.Empty:
            # Poll instead of one long 75s wait.
            # If Stage B (_generate thread) has exited without sending _DONE
            # (sentinel dropped due to put_nowait on a full queue, or crash),
            # detect it within 5s rather than hanging for 75s.
            if not t_gen.is_alive():
                print("[stream] Stage B exited without sentinel — Stage C cleaning up")
                break
            # Stage B is still alive (TTS generation in progress) — keep waiting
            continue

        if item is _DONE:
            break

        chunk, audio_bytes = item

        if _playback_interrupt.is_set():
            break

        print(f"AURA: {chunk}")

        with _speak_lock:
            played = False

            # Path 1: edge-tts bytes (WAV via sounddevice, MP3 via subprocess)
            if audio_bytes:
                try:
                    _play_audio_bytes(audio_bytes)
                    played = True
                except Exception as e:
                    print(f"[stream] edge-tts playback failed: {e}")
                    # Release sounddevice before trying SAPI — device conflict prevention
                    try: sd.stop()
                    except Exception: pass

            # Path 2: PowerShell SAPI (always-available Windows TTS)
            if not played:
                played = _speak_fallback(chunk)
                if played:
                    print("[stream] spoke via SAPI fallback")

        if played:
            spoken.append(chunk)
            _tts_fail_count  = 0
            consecutive_fail = 0
        else:
            _tts_fail_count  += 1
            consecutive_fail += 1
            print(f"[stream] audio failed for chunk ({consecutive_fail} consecutive)")
            # After 3 back-to-back total failures, audio device is likely unavailable.
            # Stop the pipeline — final SAPI fallback below will still speak the text.
            if consecutive_fail >= 3:
                print("[stream] 3 consecutive audio failures — stopping pipeline early")
                _abort.set()
                try: sd.stop()
                except Exception: pass
                try: sd.default.device = None
                except Exception: pass
                _tts_fail_count = 0
                break

        if _playback_interrupt.is_set():
            break

    # ── Cleanup: shut down Stage A and Stage B threads ──────────────────
    # Stage A: give it 2s to drain the HTTP connection before we move on.
    t_fill.join(timeout=2.0)

    # Stage B: signal abort so it stops waiting on sentence_q or audio_q.put().
    # Then drain audio_q so put_nowait / the timed put can complete, allowing
    # _generate() to reach its return statement and the thread to exit.
    _abort.set()
    try:
        while not audio_q.empty():
            audio_q.get_nowait()
    except Exception:
        pass
    t_gen.join(timeout=4.0)   # wait for Stage B to exit cleanly

    # ── Final guarantee: if nothing was spoken but LLM produced text ────
    # Speak the full collected text via SAPI — ensures response is ALWAYS audible.
    if _playback_interrupt.is_set() or _abort.is_set():
        return " ".join(spoken)

    if not spoken and collected:
        # Nothing played via edge-tts -- speak all collected text via SAPI.
        full_text = " ".join(collected)
        print(f"[stream] edge-tts unavailable -- speaking via SAPI: {full_text[:80]}")
        _speak_fallback(full_text)
        return full_text

    # Queue-overflow dropout recovery: Stage B drops the current chunk when
    # audio_q is full after 5s timeout.  The chunk text is in collected[] but
    # never entered spoken[] because Stage B sent _DONE before processing it.
    # The existing 'not spoken and collected' guard above only fires when
    # NOTHING was spoken -- it misses the partial-dropout case where some
    # chunks played successfully before the overflow.
    # Here we detect that mismatch and speak the dropped chunks via SAPI
    # so the complete response is always audible.
    if spoken and len(spoken) < len(collected) and not _playback_interrupt.is_set() and not _abort.is_set():
        # Some chunks were dropped by Stage B overflow -- speak the rest via SAPI.
        spoken_set = set(spoken)
        dropped = [c for c in collected if c not in spoken_set]
        if dropped:
            dropped_text = " ".join(dropped)
            print(f"[stream] {len(dropped)} chunk(s) dropped by overflow -- SAPI recovery: {dropped_text[:80]}")
            _speak_fallback(dropped_text)
            # Extend spoken with recovered chunks so the full response enters history.
            spoken.extend(dropped)

    if not spoken:
        # Genuinely no LLM output at all -- pipeline produced nothing
        print("[stream] LLM produced no speakable text")
        return ""

    return " ".join(spoken)


def get_answer_stream(query):
    """
    Stream the LLM answer from the backend as complete sentences.

    Failure handling (in priority order):
      1. Backend sends {__error: true, message: ...} SSE event (Ollama timeout/failure).
         Yield the message directly and return — no fallback needed, the error is already
         user-facing and the backend terminated cleanly.
      2. Stream closes without [DONE] (unexpected disconnect, backend crash).
         Flush any partial sentence still in the buffer before returning.
      3. No content yielded at all (stream never started, or closed with nothing):
         Fall back to send_ask() blocking call. This consolidation handles both
         exception paths AND clean-close-with-no-content paths.

    Timeout ownership:
      JS side (aiService.js) owns first-token and inter-token watchdogs (12s / 20s).
      These destroy the stream and send the __error SSE event before this function
      would ever hit its own 60s per-chunk requests timeout.

    Anti-repetition:
      _seen_sentences tracks normalized sentence text within this stream to prevent
      the same sentence from being yielded (and spoken) twice in one turn.  This
      catches model loops ("The capital is Paris. The capital is Paris.") before
      they reach TTS.  The set is local — does not persist across turns.
    """
    now          = datetime.now()
    time_context = now.strftime("Today is %A, %B %d %Y. Current time is %I:%M %p.")
    # Consume and reset the correction flag -- applies to this turn only.
    global _correction_just_occurred
    _local_correction = _correction_just_occurred
    _correction_just_occurred = False

    started        = False
    yielded_any_speakable = False
    _seen_sentences: set = set()   # anti-repetition: track sentences within this turn
    _stream_start_ms     = int(time.monotonic() * 1000)
    _first_token_logged  = False
    _token_count         = 0

    dbg.stream_start(query)

    try:
        with requests.post(
            f"{BACKEND}/api/ai/ask-stream",
            json={
                "query": query,
                "time_context": time_context,
                "correction_occurred": _local_correction,
            },
            headers=auth_headers(),
            stream=True,
            timeout=60
        ) as resp:
            if resp.status_code == 401:
                # Stale/invalid token — attempt reload from disk for next call.
                # Return a user-facing message so voice pipeline stays alive.
                _try_reload_token()
                dbg.stream_event("auth-error", detail="401 — token expired, reloading")
                yield "I need to sign in again. Please use the desktop app to log in."
                return
            resp.raise_for_status()
            buffer = ""

            for raw_line in resp.iter_lines(decode_unicode=True):
                if not raw_line:
                    continue
                if not raw_line.startswith("data: "):
                    continue

                payload = raw_line[6:]

                if payload == "[DONE]":
                    # Flush any partial sentence still in the buffer
                    if buffer.strip():
                        remainder = _clean_llm_output(buffer.strip())
                        if remainder and _SCAFFOLD_LEAK_RE.search(remainder):
                            dbg.stream_event("scaffold-terminated", detail=remainder[:80])
                            _push_diagnostic({
                                "type": "scaffold_leak_terminated",
                                "severity": "warn",
                                "data": {"sample": remainder[:120]},
                            })
                            return
                        if remainder and _is_speakable_stream_chunk(remainder, final_fragment=True):
                            norm = remainder.lower().strip(" .")
                            if norm not in _seen_sentences:
                                yielded_any_speakable = True
                                yield remainder
                    elapsed = int(time.monotonic() * 1000) - _stream_start_ms
                    dbg.stream_event("done", ms=elapsed, token_count=_token_count,
                                     detail="[DONE] received from backend")
                    return

                try:
                    token = json.loads(payload)
                except (json.JSONDecodeError, ValueError):
                    token = payload

                # Structured error event from backend (Ollama timeout / unexpected failure).
                # The backend already composed a user-facing sentence — yield it and
                # terminate cleanly. Do NOT fall back to send_ask: the backend handled
                # the Ollama failure; a second Ollama call would hit the same stall.
                if isinstance(token, dict) and token.get("__error"):
                    msg = token.get("message", "I'm having trouble thinking right now.")
                    elapsed = int(time.monotonic() * 1000) - _stream_start_ms
                    dbg.stream_event("backend-error", ms=elapsed,
                                     detail=f"Ollama/backend error: {msg[:80]}")
                    yield msg
                    return

                buf_token = token if isinstance(token, str) else str(token)
                buffer   += buf_token
                _token_count += 1
                started   = True

                # Log first-token latency once
                if not _first_token_logged:
                    _first_token_logged = True
                    elapsed = int(time.monotonic() * 1000) - _stream_start_ms
                    dbg.stream_event("first-token", ms=elapsed,
                                     detail="Python received first token from SSE")

                # Yield complete sentences as they arrive
                while True:
                    best_idx, best_sep = -1, ""
                    for sep in [". ", "! ", "? ", ".\n", "!\n", "?\n"]:
                        idx = buffer.find(sep)
                        if idx != -1 and (best_idx == -1 or idx < best_idx):
                            best_idx, best_sep = idx, sep
                    if best_idx == -1:
                        break
                    sentence = _clean_llm_output(buffer[: best_idx + len(best_sep)].strip())
                    buffer   = buffer[best_idx + len(best_sep):]
                    if sentence:
                        if _SCAFFOLD_LEAK_RE.search(sentence):
                            dbg.stream_event("scaffold-terminated", detail=sentence[:80])
                            _push_diagnostic({
                                "type": "scaffold_leak_terminated",
                                "severity": "warn",
                                "data": {"sample": sentence[:120]},
                            })
                            return
                        if not _is_speakable_stream_chunk(sentence):
                            dbg.stream_event("malformed-dropped", detail=sentence[:80])
                            _push_diagnostic({
                                "type": "malformed_output_dropped",
                                "severity": "warn",
                                "data": {"sample": sentence[:120], "reason": "stream_chunk_validation"},
                            })
                            return
                        # Anti-repetition: skip sentences already spoken this turn
                        norm = sentence.lower().strip(" .")
                        if norm not in _seen_sentences:
                            _seen_sentences.add(norm)
                            yielded_any_speakable = True
                            yield sentence

            # Stream closed without [DONE] (server closed connection, backend crash,
            # or network reset). Flush whatever is left in the buffer.
            if buffer.strip():
                remainder = _clean_llm_output(buffer.strip())
                if remainder and _SCAFFOLD_LEAK_RE.search(remainder):
                    dbg.stream_event("scaffold-terminated", detail=remainder[:80])
                    _push_diagnostic({
                        "type": "scaffold_leak_terminated",
                        "severity": "warn",
                        "data": {"sample": remainder[:120]},
                    })
                    return
                if remainder and _is_speakable_stream_chunk(remainder, final_fragment=True):
                    started = True
                    norm = remainder.lower().strip(" .")
                    if norm not in _seen_sentences:
                        yielded_any_speakable = True
                        yield remainder
            elapsed = int(time.monotonic() * 1000) - _stream_start_ms
            dbg.stream_event("closed-no-done", ms=elapsed, token_count=_token_count,
                             detail="stream closed without [DONE]")

    except Exception as e:
        elapsed = int(time.monotonic() * 1000) - _stream_start_ms
        dbg.stream_event("exception", ms=elapsed, detail=f"{type(e).__name__}: {str(e)[:80]}")
        print(f"[stream] error: {e}")

    # Fallback — consolidated: catches both exception paths AND a clean stream-close
    # that produced no content (e.g. backend up but Ollama not running at all).
    # Only fires when nothing was yielded — never mixes with partial streaming content.
    #
    # IMPORTANT: apply _clean_llm_output() here too.  The blocking /ask endpoint
    # returns raw LLM text — no streaming filter ran on it.  Without cleaning,
    # label leakage ("Personal: ...", "General: ...") and bad openers ("Sure thing!")
    # survive to TTS and get stored in conversation history, poisoning future turns.
    if not yielded_any_speakable:
        dbg.stream_event("fallback-blocking", detail="streaming produced nothing — falling back to /ask")
        _push_diagnostic({
            "type": "llm_no_speakable_text",
            "severity": "warn",
            "data": {"query": query[:120]},
        })
        raw     = send_ask(query)
        cleaned = _clean_llm_output(raw)
        if cleaned and _is_speakable_stream_chunk(cleaned, final_fragment=True):
            yield cleaned
        else:
            _push_diagnostic({
                "type": "malformed_output_dropped",
                "severity": "warn",
                "data": {"sample": cleaned[:120] if cleaned else "", "reason": "fallback_validation"},
            })
            yield "I'm having trouble thinking right now."


# ─────────────────────────────────────────────
# DECISION ENGINE
# Rule-based pre-LLM assessment — runs in microseconds, zero network cost.
# Handles obvious cases locally; routes complex queries to LLM.
# ─────────────────────────────────────────────

_EMOTIONAL_RE = re.compile(
    r'\b(sad|stressed|tired|exhausted|frustrated|worried|anxious|overwhelmed|'
    r'scared|upset|angry|nervous|depressed|lonely|rough|struggling|'
    r'not okay|feel(?:ing)?\s+(?:bad|terrible|awful|low|down|lost))\b',
    re.IGNORECASE
)

# Correction / topic-reset detection.
# Matched BEFORE the LLM path so the most recent stale history pair can be
# trimmed before the next prompt is assembled.  Prevents a wrong answer from
# surviving in the 6-entry context window and continuing to anchor future turns.
# Trim depth: exactly 1 Q+A pair (2 deque entries) -- enough to break stale
# topic momentum without destroying legitimate earlier context.
_CORRECTION_RE = re.compile(
    r'\b('
    r"you'?re\s+wrong"
    r"|that'?s\s+(?:wrong|incorrect|not\s+right|not\s+what\s+i\s+(?:asked|said|wanted|meant))"
    r'|that\s+was\s+wrong'
    r'|you\s+got\s+(?:that\s+)?wrong'
    r'|(?:change|switch)\s+(?:the\s+)?topic'
    r'|stop\s+talking\s+about\s+(?:this|that)'
    r"|let'?s?\s+(?:talk|discuss|chat)\s+about\s+something\s+else"
    r'|forget\s+(?:that|what\s+(?:i|you)\s+said)'
    r'|never\s+mind\s+(?:that|what\s+i\s+said)'
    r'|not\s+what\s+i\s+(?:asked|said|meant)'
    r'|move\s+on\s+from\s+(?:this|that)'
    r')\b',
    re.IGNORECASE,
)

# Separators between the correction clause and a follow-up query.
# "that's wrong, tell me about X" -- after stripping, only "tell me about X" remains.
_CORRECTION_LINK_RE = re.compile(
    r'\s*[,;]\s*(?:and\s+|but\s+)?|\s+and\s+|\s+but\s+',
    re.IGNORECASE,
)


def _extract_correction_remainder(text: str) -> str:
    """
    Strip the correction clause from `text` and return the remainder.
    If the whole utterance is the correction, returns empty string.
    Example: 'that is wrong, what is inflation?' -> 'what is inflation?'
    """
    m = _CORRECTION_RE.search(text)
    if not m:
        return text
    after = text[m.end():].strip()
    after = _CORRECTION_LINK_RE.sub('', after, count=1).strip()
    return after


def _assess_query(text):
    """
    Returns query mode:
      'clarify'  — too short/ambiguous, handle locally without LLM
      'empathize'— emotional content detected, speak acknowledgment first
      'ask'      — normal LLM path
    """
    if len(text.split()) < 3:
        return 'clarify'
    if _EMOTIONAL_RE.search(text):
        return 'empathize'
    return 'ask'


# ─────────────────────────────────────────────
# INTENT DETECTION
#
# Design principles (P2.5):
#   1. Command-position-first: action verbs/triggers at the START of the utterance
#      (or after a short polite filler) are treated as commands.  The same words
#      mid-sentence are treated as conversational and route to the LLM.
#   2. Word-boundary matching: app names are matched with \b to prevent substring
#      collisions (e.g. "notepad" in "notepad paper").
#   3. Context TTL: followup context expires after ACTION_CONTEXT_TTL seconds.
#   4. Explicit-target priority: an explicit app name in the utterance beats any
#      stale followup context — avoids "resume that in Chrome" reopening Spotify.
#   5. No mid-sentence triggers: removed all f" {trigger}" substring checks.
#
# Future integration note:
#   _get_action_context() / _set_action_context() are the natural attachment points
#   for a future AssistantState system to override or inspect routing decisions.
#   _is_at_command_start() is the natural input to a future confidence scorer.
# ─────────────────────────────────────────────

# Polite filler words/phrases that prefix commands without changing intent.
# Sorted longest-first so we strip the most specific match before fallback.
# "i want to", "i'd like to", "let me" added: these first-person intent phrases
# were missing, causing "I want to play lofi on Spotify" to never strip to
# "play ..." and therefore miss the open_app / media routing path entirely.
_COMMAND_FILLERS = (
    # Longest/most-specific first so greedy prefix stripping is unambiguous
    "i need you to ", "i want you to ", "i would like you to ",
    "i'd like you to ", "i want to ", "i would like to ",
    "i'd like to ", "i need to ", "would you mind ", "will you please ",
    "let me ", "go ahead and ", "would you please ",
    "can you please ", "could you please ", "would you ", "could you ",
    "will you ", "can you ", "please ", "just ",
    "hey aura ", "aura ", "hey ",
    "ok ", "okay ",
)

# Compiled once — followup phrases that reference a previous media action.
# Anchored to word boundaries; requires a stale-context guard before use.
_FOLLOWUP_RE = re.compile(
    r'\b(?:play|resume|continue|start)\s+(?:it|that|the\s+song|the\s+video|the\s+music|again|this)\b',
    re.IGNORECASE
)

# ── Timer intent ──────────────────────────────────────────────────────────────
# "set a timer", "start timer", "timer for N", "countdown", "count down"
# All must appear at command position to avoid false positives like
# "the timer for the oven just went off" or "what is the final countdown".
_TIMER_COMMAND_PHRASES = (
    "set a timer", "set timer", "start a timer", "start timer",
    "timer for", "countdown", "count down",
)

# ── Reminder intent ───────────────────────────────────────────────────────────
# Must be at command position — prevents "don't remind me" / "you remind me of"
# from creating spurious reminders.
_REMINDER_COMMAND_PHRASES = (
    "remind me", "set a reminder", "set reminder",
)

# ── Memory intent ─────────────────────────────────────────────────────────────
# Split into two groups:
#   EXPLICIT — direct memory commands ("remember that", "note that") — command-start required
#   STATEMENT — first-person identity/preference statements ("i like", "my name is")
#              — command-start required AND utterance must NOT be a question
_MEMORY_EXPLICIT_PHRASES = (
    "remember that", "don't forget", "keep in mind",
    "note that", "store this", "remember this",
)
_MEMORY_STATEMENT_PHRASES = (
    "my name is", "i live in", "i work at", "i work for",
    "i am a ", "i'm a ", "i am an ", "i'm an ",
    "i study at", "i go to college", "i'm studying", "i am studying",
    "i'm from", "i am from", "i'm based in", "i am based in",
    "my favourite is", "my favorite is", "my birthday is",
    "i like ", "i love ", "i enjoy ", "i prefer ",
    "i hate ", "i dislike ", "i use ", "i don't like ",
)


def _is_at_command_start(text_lower: str, trigger: str) -> bool:
    """
    Return True if `trigger` appears at the commanding start of the utterance:
    either as the very first words, or immediately after one or two polite fillers.

    This is the core command-position check (P2.5).  It replaces the old
    `f" {trigger}" in text_lower` pattern that matched verbs mid-sentence and
    caused false-positive action routing.

    Strips up to 2 consecutive filler layers so compound openers like
    "hey can you set a timer" and "aura please open spotify" are handled
    without an exhaustive compound-filler list.

    Examples:
        _is_at_command_start("open chrome please", "open ") → True
        _is_at_command_start("please open chrome",  "open ") → True
        _is_at_command_start("hey can you set a timer", "set") → True
        _is_at_command_start("aura please open spotify", "open ") → True
        _is_at_command_start("i always open chrome in the morning", "open ") → False
        _is_at_command_start("what is the set of primes", "set") → False
    """
    stripped = text_lower.strip()
    # Strip up to 2 leading filler layers — handles "hey aura please ...",
    # "ok can you ..." without needing an exhaustive compound-filler list.
    for _ in range(2):
        for filler in _COMMAND_FILLERS:
            if stripped.startswith(filler):
                stripped = stripped[len(filler):].lstrip()
                break
        else:
            break   # no filler matched this round — stop stripping
    return stripped.startswith(trigger)


def _get_action_context() -> dict:
    """
    Return the stored action context if it has not expired, else empty dict.
    TTL prevents stale contexts from triggering followup actions hours later.
    """
    if time.monotonic() - _last_action_ctx_time > ACTION_CONTEXT_TTL:
        return {}
    return _last_action_context


def _set_action_context(app_key: str, query: str = "") -> None:
    """Update the action context and reset the TTL clock."""
    global _last_action_context, _last_action_ctx_time
    _last_action_context    = {"app_key": app_key, "query": query}
    _last_action_ctx_time   = time.monotonic()


# ─────────────────────────────────────────────
# ENTITY CONTEXT — P2.A.2
# ─────────────────────────────────────────────

def _get_entity_ctx() -> dict:
    """Return entity context dict if within TTL, else empty dict."""
    if time.monotonic() - _entity_ctx_time > ENTITY_CTX_TTL:
        return {}
    return _entity_ctx


def _set_entity_ctx(**kwargs) -> None:
    """
    Merge new entity values into the context and reset the TTL clock.
    Merge (not replace) so a YouTube action doesn't erase last_song set
    by a prior Spotify action — both coexist until TTL expires.
    """
    global _entity_ctx, _entity_ctx_time
    _entity_ctx      = {**_entity_ctx, **kwargs}
    _entity_ctx_time = time.monotonic()


def _update_entity_ctx_from_action(app_key: str, resolved_text: str) -> None:
    """
    Populate entity context after an app action executes successfully.
    Called from the main loop after process_open_app() returns.
    Uses resolved_text (post-reference-resolution) so extracted values
    are always concrete — never pronoun literals like 'this' or 'it'.

    Field population per app:
      spotify / music → last_song, last_search, last_app
      youtube         → last_search, last_app
      browser / etc.  → last_search, last_app
      all others      → last_app only
    """
    q_spotify = _extract_spotify_query(resolved_text)
    q_search  = _extract_search_query(resolved_text)

    if app_key in ("spotify", "music"):
        q = q_spotify or q_search
        if q:
            _set_entity_ctx(last_app=app_key, last_song=q, last_search=q)
        else:
            _set_entity_ctx(last_app=app_key)
    elif app_key == "youtube":
        if q_search:
            _set_entity_ctx(last_app=app_key, last_search=q_search)
        else:
            _set_entity_ctx(last_app=app_key)
    elif app_key in ("browser", "chrome", "google"):
        if q_search:
            _set_entity_ctx(last_app=app_key, last_search=q_search)
        else:
            _set_entity_ctx(last_app=app_key)
    else:
        # clock, calculator, notepad, etc. — track app only, no media entity
        _set_entity_ctx(last_app=app_key)


def _normalize_transcript(text_lower: str) -> str:
    """
    Strip leading hesitation words and Whisper-added punctuation before routing.

    Faster-Whisper commonly adds comma-punctuation after filler words:
        "um, set a timer for 30 seconds"   → "set a timer for 30 seconds"
        "okay, play some music"            → "play some music"
        "hey, what time is it"             → "what time is it"
        "uh, open chrome"                  → "open chrome"

    Without this, _is_at_command_start() fails because _COMMAND_FILLERS
    contains "okay " (with space) but not "okay," (with comma), so the
    filler is NOT stripped and the trigger is not found at position 0.

    This is applied BEFORE _resolve_references() so the combined pipeline is:
        STT output → _normalize_transcript() → _resolve_references() → detect_intent()
    """
    # Strip repeated filler words with any trailing punctuation/spaces
    _FILLER_RE = re.compile(
        r'^(?:um|uh|oh|hmm|hm|ah|er|well|so|alright|right|okay|ok|hey|yo)'
        r'[,. !]*\s*',
        re.IGNORECASE,
    )
    result = text_lower
    # Allow stripping up to 2 consecutive filler layers (mirrors _is_at_command_start)
    for _ in range(2):
        stripped = _FILLER_RE.sub("", result)
        if stripped == result:
            break
        result = stripped
    # Also strip any orphaned leading punctuation left behind
    result = result.lstrip(",. !?")

    # Gerund normalization: convert action-verb gerunds to base form so that
    # _is_at_command_start() can match them against _OPEN_VERBS / _TIMER_COMMAND_PHRASES.
    # Only fires when the gerund is the FIRST word after filler stripping — i.e. when
    # "would you mind opening spotify" strips "would you mind " and leaves "opening spotify".
    # Restricted to known action verbs to avoid mangling conversational sentences
    # like "I've been playing guitar" or "She was opening the door".
    _GERUND_MAP = (
        ("opening ",   "open "),
        ("playing ",   "play "),
        ("launching ", "launch "),
        ("starting ",  "start "),
        ("setting ",   "set "),
        ("watching ",  "watch "),
        ("searching ", "search "),
        ("browsing ",  "browse "),
        ("buying ",    "buy "),
        ("ordering ",  "order "),
    )
    for gerund, base in _GERUND_MAP:
        if result.startswith(gerund):
            result = base + result[len(gerund):]
            break

    return result.strip() if result.strip() else text_lower


def _resolve_references(text_lower: str) -> str:
    """
    Replace conversational reference pronouns with known entity values.
    Called BEFORE detect_intent() so routing and query extraction both
    operate on concrete text rather than literal pronouns.

    Resolves (examples — requires entity context within TTL):
      "play this on youtube"      → "play {last_song} on youtube"
      "watch that on youtube"     → "watch {entity} on youtube"
      "listen to it"              → "listen to {entity}"
      "the same thing / same one" → "{entity}"
      "this song / that video"    → "{entity}"
      "open it [again]"           → "open {last_app}"
      "launch it / start it"      → "open {last_app}"

    If the resolved text still has no app name after entity substitution,
    last_app is appended ("... on {last_app}") so detect_intent() can
    route the action without falling through to the LLM.

    Never uses the LLM. Purely deterministic string substitution.
    No-ops when entity context is empty or expired.
    """
    ctx = _get_entity_ctx()
    if not ctx:
        return text_lower

    resolved = text_lower
    entity   = ctx.get("last_song") or ctx.get("last_search") or ""
    last_app = ctx.get("last_app", "")

    if entity:
        # ── "the same X" / "same X" forms ────────────────────────────────────
        resolved = re.sub(
            r'\bthe\s+same\s+(?:one|song|video|track|thing)\b|\bthe\s+same\b',
            entity, resolved, flags=re.IGNORECASE
        )
        resolved = re.sub(
            r'\bsame\s+(?:one|song|video|track|thing)\b',
            entity, resolved, flags=re.IGNORECASE
        )

        # ── Demonstrative + noun: "this song", "that video", "this one" ───────
        resolved = re.sub(
            r'\b(?:this|that)\s+(?:song|video|track|one)\b',
            entity, resolved, flags=re.IGNORECASE
        )

        # ── Verb-anchored pronouns ─────────────────────────────────────────────
        # Only substitute when the pronoun directly follows the verb — avoids
        # replacing "this" in "is this correct?" or "that" in "I know that".
        resolved = re.sub(r'\bplay\s+(?:it|this|that)\b',
                          f'play {entity}', resolved, flags=re.IGNORECASE)
        resolved = re.sub(r'\bwatch\s+(?:it|this|that)\b',
                          f'watch {entity}', resolved, flags=re.IGNORECASE)
        resolved = re.sub(r'\blisten\s+to\s+(?:it|this|that)\b',
                          f'listen to {entity}', resolved, flags=re.IGNORECASE)

    if last_app:
        # ── App pronoun: "open it [again]", "open that" ───────────────────────
        resolved = re.sub(
            r'\bopen\s+(?:it|that)(?:\s+again)?\b',
            f'open {last_app}', resolved, flags=re.IGNORECASE
        )
        # "launch it / start it / launch that" → normalise to open verb
        resolved = re.sub(
            r'\b(?:launch|start)\s+(?:it|that)\b',
            f'open {last_app}', resolved, flags=re.IGNORECASE
        )

    # ── App anchoring ─────────────────────────────────────────────────────────
    # If a reference WAS resolved (text changed) but still has no explicit app
    # name, append last_app so detect_intent() can route without falling through
    # to the LLM.  Only fires when:
    #   • both entity and last_app are known
    #   • the resolved text starts with a command verb (guards against
    #     "i like that song" → "i like {entity} on {last_app}" false-positive
    #     which would mis-route an informational sentence to store_memory)
    if resolved != text_lower and last_app and entity:
        has_app = any(
            re.search(r'\b' + re.escape(app) + r'\b', resolved, re.IGNORECASE)
            for app in _APP_COMMANDS
        )
        if not has_app:
            # Only anchor when the resolved text is actually a command utterance
            _is_cmd = any(_is_at_command_start(resolved, v) for v in _OPEN_VERBS)
            if _is_cmd:
                resolved = resolved.rstrip() + f' on {last_app}'

    if resolved != text_lower:
        print(f"[ref] '{text_lower}' -> '{resolved}'")

    return resolved


# ── Passive media intent ──────────────────────────────────────────────────────
# Handles desire expressions with no explicit command verb at utterance start.
#
# Gap these cover:
#   "I want some music"      — no "to play", filler "i want to" doesn't match
#   "I could use some music" — "i could use" not in _COMMAND_FILLERS
#   "I feel like some jazz"  — "i feel like" not in _COMMAND_FILLERS
#   "I'd like some music"    — "i'd like some" strips nothing; no verb remains
#
# These are NOT handled by _OPEN_VERBS + _is_at_command_start because the
# intent is implicit (desire expression + content noun; no action verb).
#
# Does NOT duplicate routes already covered by _OPEN_VERBS:
#   "I want to play music"   → "i want to " strips → "play music" → _OPEN_VERBS ✓
#   "Can you play music"     → "can you " strips → "play music" → _OPEN_VERBS ✓
# ─────────────────────────────────────────────────────────────────────────────
_PASSIVE_MUSIC_RE = re.compile(
    r"\b(?:want|need|like|love|could use|feel like|fancy|craving)\s+(?:some\s+|a\s+|any\s+|to\s+hear\s+)?"
    r"(?:music|songs?|tunes?|playlist|lofi|lo-fi|jazz|classical|rock|pop|hip.?hop|chill|beats?|audio)\b",
    re.IGNORECASE,
)
_PASSIVE_VIDEO_RE = re.compile(
    r"\b(?:want|like|need|love|feel like)\s+(?:to\s+)?(?:watch|see)\s+(?:a\s+|some\s+)?(?:video|movie|clip|film)\b",
    re.IGNORECASE,
)

def _detect_passive_media_intent(text_lower: str):
    """
    Detect implicit media intent from desire expressions with no command verb.
    Returns app key ("music" or "youtube") or None.

    Runs AFTER _detect_open_app fails — only activates when no explicit
    command verb was found at command position.
    """
    if _PASSIVE_MUSIC_RE.search(text_lower):
        return "music"
    if _PASSIVE_VIDEO_RE.search(text_lower):
        return "youtube"
    return None


def _is_timer_command(text_lower: str) -> bool:
    """True only when the timer trigger appears at command position."""
    return any(_is_at_command_start(text_lower, t) for t in _TIMER_COMMAND_PHRASES)


def _is_reminder_command(text_lower: str) -> bool:
    """True only when a reminder trigger appears at command position."""
    return any(_is_at_command_start(text_lower, t) for t in _REMINDER_COMMAND_PHRASES)


def _is_memory_command(text_lower: str) -> bool:
    """
    True when the utterance is an explicit memory command OR a first-person
    statement at command position that is NOT a question.

    Questions are excluded because "what movies do i like?" / "tell me what
    i enjoy" should go to the LLM, not be stored as memories.
    """
    # Explicit commands ("remember that X") must be at command position
    if any(_is_at_command_start(text_lower, t) for t in _MEMORY_EXPLICIT_PHRASES):
        return True
    # Statement forms ("i like X", "my name is X") must be at command position
    # and the utterance must not end in a question mark
    if text_lower.rstrip().endswith("?"):
        return False
    return any(_is_at_command_start(text_lower, t) for t in _MEMORY_STATEMENT_PHRASES)


def detect_intent(text: str) -> str:
    """
    Route a user utterance to one of:
        "set_timer"           — local timer, no LLM
        "open_app:{key}"      — open/control an app, no LLM
        "open_app:{key}:followup" — followup to last app action, no LLM
        "set_reminder"        — parse time + store via backend, no LLM
        "store_memory"        — store fact via backend, no LLM
        "ask"                 — general LLM query

    Routing is deterministic: command-position checks prevent mid-sentence
    verbs from triggering actions.  Priority order:

        1. Timer   — most unambiguous command form
        2. App open (explicit target) — explicit target beats stale context
        3. Followup  — only after explicit-target check, with TTL guard
        4. Reminder  — command-position only
        5. Memory    — command-position + question guard
        6. Ask       — default LLM path

    Future integration note:
        Return value is the authoritative routing token for this turn.
        A future AssistantState system should read this token to update
        state transitions (THINKING → ACTING vs THINKING → SPEAKING).
    """
    text_lower = text.lower().strip()

    # 1. Timer — "set a timer for 5 minutes", "countdown from 10"
    if _is_timer_command(text_lower):
        resolved = "set_timer"
        dbg.intent(text, resolved, stage=1, reason="timer command at command position")
        return resolved

    # 2. Explicit app target — checked BEFORE followup so "resume that in Chrome"
    #    routes to Chrome, not to whatever _last_action_context holds.
    app_key = _detect_open_app(text_lower)
    if app_key:
        resolved = f"open_app:{app_key}"
        dbg.intent(text, resolved, stage=2, app=app_key, reason="explicit app target")
        return resolved

    # 2b. Passive media intent — desire expressions with no command verb.
    #     "I want some music" / "I feel like some jazz" / "I could use some music"
    #     Only checked when _detect_open_app found nothing — avoids double-routing.
    passive_app = _detect_passive_media_intent(text_lower)
    dbg.passive_intent(text_lower, passive_app)
    if passive_app:
        resolved = f"open_app:{passive_app}"
        dbg.intent(text, resolved, stage=2, app=passive_app, reason="passive media intent")
        return resolved

    # 3. Followup — "play it", "resume that" — only if context is fresh
    ctx = _get_action_context()
    if _FOLLOWUP_RE.search(text_lower) and ctx.get("app_key"):
        resolved = f"open_app:{ctx['app_key']}:followup"
        dbg.intent(text, resolved, stage=3, app=ctx["app_key"], reason="followup context match")
        return resolved

    # 4. Reminder — "remind me to call mom at 7pm"
    if _is_reminder_command(text_lower):
        resolved = "set_reminder"
        dbg.intent(text, resolved, stage=4, reason="reminder command at command position")
        return resolved

    # 5. Memory — "I like Italian food", "remember that my gym is at 6am"
    if _is_memory_command(text_lower):
        resolved = "store_memory"
        dbg.intent(text, resolved, stage=5, reason="memory command/statement at command position")
        return resolved

    # 6. Default — send to LLM
    dbg.intent(text, "ask", stage=6, reason="no command matched — LLM fallback")
    return "ask"


# ─────────────────────────────────────────────
# REMINDER PARSING
# ─────────────────────────────────────────────
def parse_reminder_time(text):
    now = datetime.now()

    # Shared number pattern: digits OR number words (inc. "one hour", "thirty minutes")
    _NUM_PAT = (
        r'(\d+|(?:twenty|thirty|forty|fifty|sixty|ninety|hundred)[\s\-]'
        r'(?:one|two|three|four|five|six|seven|eight|nine)|'
        r'(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|'
        r'thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|'
        r'twenty|thirty|forty|fifty|sixty|ninety|hundred))'
    )

    # "in N minutes / hours" — relative offsets (digits or words)
    m = re.search(r"in " + _NUM_PAT + r"\s*minute", text, re.IGNORECASE)
    if m:
        val = _word_num_to_int(m.group(1))
        if val:
            return now + timedelta(minutes=val)
    m = re.search(r"in " + _NUM_PAT + r"\s*hour", text, re.IGNORECASE)
    if m:
        val = _word_num_to_int(m.group(1))
        if val:
            return now + timedelta(hours=val)

    # "at H:MM [am/pm]" — MUST capture AM/PM here or "9:06 PM" → wrongly treated as 9:06
    m = re.search(r"at (\d{1,2}):(\d{2})\s*(am|pm)?", text, re.IGNORECASE)
    if m:
        hour   = int(m.group(1))
        minute = int(m.group(2))
        ampm   = (m.group(3) or "").lower()
        if ampm == "pm" and hour != 12:
            hour += 12
        elif ampm == "am" and hour == 12:
            hour = 0
        # If no am/pm given and hour is ambiguous (< 7), assume PM
        elif not ampm and hour < 7:
            hour += 12
        dt = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        return dt if dt > now else dt + timedelta(days=1)

    # "at N am/pm" — bare hour with explicit meridiem
    m = re.search(r"at (\d{1,2})\s*(am|pm)", text, re.IGNORECASE)
    if m:
        hour = int(m.group(1))
        ampm = m.group(2).lower()
        if ampm == "pm" and hour != 12:
            hour += 12
        elif ampm == "am" and hour == 12:
            hour = 0
        dt = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        return dt if dt > now else dt + timedelta(days=1)

    # "at N" — bare hour, no meridiem — assume PM if ambiguous
    m = re.search(r"at (\d{1,2})(?!\d|:|\s*[ap]m)", text, re.IGNORECASE)
    if m:
        hour = int(m.group(1))
        if hour < 7:
            hour += 12
        dt = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        return dt if dt > now else dt + timedelta(days=1)

    return None


def parse_reminder_text(text):
    m = re.search(r"remind me to (.+?)(?:\s+at\s+|\s+in\s+)", text)
    if m: return m.group(1).strip()
    m = re.search(r"remind me to (.+)", text)
    if m: return m.group(1).strip()
    m = re.search(r"remind me (.+?)(?:\s+at\s+|\s+in\s+)", text)
    if m: return m.group(1).strip()
    m = re.search(r"remind me (.+)", text)
    if m: return m.group(1).strip()
    return text


# ─────────────────────────────────────────────
# TIMER / REMINDER — NATIVE OS ORCHESTRATION (P2.A.3)
#
# Helper layer: PS1 script builder + launcher + schtasks registration.
# All helpers are pure orchestration — no countdown state is held in Python.
# ─────────────────────────────────────────────

# ── Number-word → digit map ───────────────────────────────────────────────────
# Used by timer and reminder parsers so spoken forms like "thirty seconds"
# and "one hour" are handled without requiring Whisper to produce digits.
# Covers cardinal words up to the values meaningful for timers/reminders.
_WORD_NUMS: dict = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "ninety": 90, "hundred": 100,
    # Compound tens+ones are NOT in this map — they are handled by a regex
    # that matches "twenty five", "forty five", etc. in _word_num_to_int().
}

def _word_num_to_int(word: str) -> int | None:
    """
    Convert a spoken number word (or numeral string) to int.
    Handles:
      - plain digits: "5", "30"
      - single words: "five", "thirty"
      - compound tens+ones: "twenty five" (space or hyphen)
    Returns None if not parseable.
    """
    w = word.strip().lower().replace("-", " ")
    if w.isdigit():
        return int(w)
    if w in _WORD_NUMS:
        return _WORD_NUMS[w]
    # "twenty five" → 25, "forty five" → 45, etc.
    parts = w.split()
    if len(parts) == 2 and parts[0] in _WORD_NUMS and parts[1] in _WORD_NUMS:
        return _WORD_NUMS[parts[0]] + _WORD_NUMS[parts[1]]
    return None


def parse_timer_duration(text):
    """
    Return duration in seconds, or None if not found.
    Handles both digit forms ("5 minutes") and word forms ("five minutes",
    "thirty seconds", "one hour").
    """
    # Build a pattern that matches either digits or number words (inc. compounds)
    _NUM_PAT = r'(\d+|(?:twenty|thirty|forty|fifty|sixty|ninety|hundred)[\s\-](?:one|two|three|four|five|six|seven|eight|nine)|(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|ninety|hundred))'

    for unit, factor in (('hour', 3600), ('min', 60), ('sec', 1)):
        m = re.search(_NUM_PAT + r'\s*' + unit, text, re.IGNORECASE)
        if m:
            val = _word_num_to_int(m.group(1))
            if val is not None:
                return val * factor
    return None


def _balloon_script(title: str, body: str, delay_seconds: int = 0,
                    self_path: str = "") -> str:
    """
    Build a self-contained PowerShell balloon-tip script.

    - Optionally sleeps delay_seconds before showing (used by timers).
    - Shows a System.Windows.Forms.NotifyIcon balloon — works on all modern
      Windows without external packages.
    - Self-deletes the script file (self_path) after completion so no temp
      files accumulate.
    """
    safe_title = title.replace("'", "''")
    safe_body  = body.replace("'",  "''")
    lines = []
    if delay_seconds > 0:
        lines.append(f"Start-Sleep -Seconds {delay_seconds}")
    lines += [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$n = New-Object System.Windows.Forms.NotifyIcon",
        "$n.Icon = [System.Drawing.SystemIcons]::Information",
        "$n.Visible = $true",
        f"$n.ShowBalloonTip(12000, '{safe_title}', '{safe_body}', "
        "[System.Windows.Forms.ToolTipIcon]::Info)",
        "Start-Sleep -Seconds 13",
        "$n.Dispose()",
    ]
    if self_path:
        ps_path = self_path.replace("\\", "/")
        lines.append(
            f"Remove-Item -Path '{ps_path}' -Force -ErrorAction SilentlyContinue"
        )
    return "\n".join(lines)


def _write_ps1(path: str, script: str) -> bool:
    """Write script to path. Returns True on success."""
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(script)
        return True
    except OSError as e:
        print(f"[OS] Cannot write PS1 to {path}: {e}")
        return False


def _launch_ps1_detached(path: str) -> bool:
    """
    Launch a PS1 file in a hidden, detached PowerShell process.
    The process is fully independent of voice.py — it survives voice.py
    crash or restart.  Returns True if the process was started.
    """
    try:
        subprocess.Popen(
            ["powershell.exe", "-WindowStyle", "Hidden",
             "-ExecutionPolicy", "Bypass", "-File", path],
            creationflags=subprocess.CREATE_NO_WINDOW | subprocess.DETACHED_PROCESS,
            close_fds=True,
        )
        return True
    except Exception as e:
        print(f"[OS] PS1 launch failed ({path}): {e}")
        return False


def set_native_timer(seconds: int) -> str:
    """
    Delegate timer ownership to Electron desktop runtime.

    Emits AURA:SET_TIMER:<seconds>:<label> on stdout.  Electron's TimerManager
    handles persistence, countdown, OS notification, and voice delivery — completely
    independent of voice.py's lifecycle.

    No Python thread, no in-process countdown, no PowerShell dependency.
    """
    mins, secs = divmod(seconds, 60)
    if mins and secs:
        label = (f"{mins} minute{'s' if mins != 1 else ''} "
                 f"and {secs} second{'s' if secs != 1 else ''}")
    elif mins:
        label = f"{mins} minute{'s' if mins != 1 else ''}"
    else:
        label = f"{seconds} second{'s' if seconds != 1 else ''}"

    # Signal Electron — TimerManager owns scheduling, notification, and recovery
    print(f"AURA:SET_TIMER:{seconds}:{label}", flush=True)

    return f"Timer set for {label}."


def _ensure_reminders_dir() -> bool:
    """Create %APPDATA%\\AURA\\reminders\\ if it does not exist."""
    try:
        os.makedirs(_AURA_REMINDERS_DIR, exist_ok=True)
        return True
    except OSError as e:
        print(f"[Reminder] Cannot create reminders dir: {e}")
        return False


def _schedule_reminder_task(reminder_id: str, reminder_time: "datetime",
                             reminder_text: str) -> bool:
    """
    Register a Windows Task Scheduler one-shot task for OS-owned reminder delivery
    (P2.A.3).

    The task fires a PS1 balloon notification at the exact reminder_time,
    independent of whether AURA is running.  The task auto-deletes after firing
    (/Z flag).  The PS1 script self-deletes after execution.

    This is additive to the existing MongoDB + reminder_poll_loop path.  If
    schtasks fails, the in-session polling system remains the fallback.

    Returns True if the OS task was registered successfully.
    """
    if not _ensure_reminders_dir():
        return False

    task_name = f"AURA_Reminder_{reminder_id}"
    ps_path   = os.path.join(_AURA_REMINDERS_DIR, f"{reminder_id}.ps1")
    script    = _balloon_script(
        title="AURA Reminder",
        body=reminder_text,
        delay_seconds=0,          # schtasks fires at the right time; no internal sleep
        self_path=ps_path,
    )

    if not _write_ps1(ps_path, script):
        return False

    time_str = reminder_time.strftime("%H:%M")
    date_str = reminder_time.strftime("%m/%d/%Y")
    tr_cmd   = (
        f'powershell.exe -WindowStyle Hidden '
        f'-ExecutionPolicy Bypass -File "{ps_path}"'
    )

    try:
        result = subprocess.run(
            [
                "schtasks", "/create",
                "/tn", task_name,
                "/tr", tr_cmd,
                "/sc", "ONCE",
                "/st", time_str,
                "/sd", date_str,
                "/f",               # overwrite if task name already exists
                "/Z",               # auto-delete task after it runs (no clutter)
                "/rl", "LIMITED",   # standard user privileges — no UAC prompt
            ],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            print(f"[Reminder] OS task '{task_name}' scheduled for {date_str} {time_str}")
            return True
        else:
            print(f"[Reminder] schtasks error (rc={result.returncode}): "
                  f"{result.stderr.strip()}")
            try: os.unlink(ps_path)
            except OSError: pass
            return False
    except Exception as e:
        print(f"[Reminder] schtasks exception: {e}")
        try: os.unlink(ps_path)
        except OSError: pass
        return False


# ─────────────────────────────────────────────
# LOCAL APP / ACTION ROUTING
# ─────────────────────────────────────────────

def _open_whatsapp():
    """Open WhatsApp Desktop if installed (whatsapp: URI), else fall back to web."""
    try:
        os.startfile("whatsapp:")
    except Exception:
        webbrowser.open("https://web.whatsapp.com")


_APP_COMMANDS = {
    "browser":    lambda: webbrowser.open("https://www.google.com"),
    "chrome":     lambda: webbrowser.open("https://www.google.com"),
    "google":     lambda: webbrowser.open("https://www.google.com"),
    "youtube":    lambda: webbrowser.open("https://www.youtube.com"),
    "spotify":    lambda: os.startfile("spotify:"),
    "music":      lambda: os.startfile("spotify:"),
    "amazon":     lambda: webbrowser.open("https://www.amazon.com"),
    "whatsapp":   lambda: _open_whatsapp(),
    "maps":       lambda: webbrowser.open("https://maps.google.com"),
    "clock":      lambda: os.startfile("ms-clock:"),
    "calculator": lambda: os.startfile("calc.exe"),
    "notepad":    lambda: os.startfile("notepad.exe"),
    "calendar":   lambda: webbrowser.open("https://calendar.google.com"),
    "settings":   lambda: os.startfile("ms-settings:"),
    "files":      lambda: os.startfile("explorer"),
    "explorer":   lambda: os.startfile("explorer"),
}

# Open-app command verbs — used with command-position check (P2.5).
# These are the verbs that indicate the user wants to launch/control an app.
# Note: plain "play" alone is too broad; it is checked via _is_at_command_start
# so mid-sentence "the role play" or "let's play" never reaches app routing.
# Verbs are grouped by what Stage 3 of _detect_open_app infers from them:
#   Standard open verbs  — require explicit app name (Stage 2) or fall through
#   Media verbs          — verb-specific default app applied in Stage 3
#   Search/browse verbs  — default to browser in Stage 3
#   Grab verbs           — require explicit app name; too ambiguous without one
_OPEN_VERBS = (
    # Standard app-open verbs — explicit app name required for routing
    "open ", "launch ", "start ", "show ",
    # Media verbs — default app inferred by Stage 3 when no app name present
    "play ", "watch ", "listen to ", "put on ",
    # Search/browse verbs — fall back to browser in Stage 3
    "search ", "browse ", "navigate to ",
    # Grab verbs — require explicit app name (Stage 3 returns None without one)
    "pull up ", "turn on ",
    # Shopping verbs — Stage 2 must find "amazon" (or other app); no Stage 3 fallback
    "buy ", "order ", "purchase ", "shop for ",
)

# Pre-compiled word-boundary patterns for each app key — avoids per-call
# re.search() overhead and prevents substring collisions like "notepad paper".
_APP_KEY_RE: dict = {
    app: re.compile(r'\b' + re.escape(app) + r'\b', re.IGNORECASE)
    for app in _APP_COMMANDS
}


def _detect_open_app(text_lower: str):
    """
    Return the app key if the utterance is an open-app command, else None.

    Three-stage check (P2.A.1):
      1. Command-position: an open/media/search verb must appear at utterance
         start (or after a polite filler).  Blocks mid-sentence verb matches
         such as "I start my day with music" or "tell me how to open a file".
         Tracks which verb matched so Stage 3 can apply the right fallback.
      2. Word-boundary app name: app names matched with \\b to prevent
         substring collisions ("notepad paper", "calculator on my desk").
         If an explicit app name is found it wins — always.
      3. Verb-based fallback: when no explicit app name is present but the
         matched verb has a near-certain app implication, route to that app.
         "play" alone is too broad — requires music-content words.
         "open/launch/pull up/turn on" without an app name — unresolvable.
    """
    # Stage 1 — require verb at command position; track which verb matched
    matched_verb = next(
        (v for v in _OPEN_VERBS if _is_at_command_start(text_lower, v)),
        None
    )
    if matched_verb is None:
        return None

    # Stage 2 — find the first explicit app name with a word boundary
    for app, pattern in _APP_KEY_RE.items():
        if pattern.search(text_lower):
            return app

    # Stage 3 — verb-based default when no explicit app name found.
    # Applied only for verbs with a near-certain destination implication.
    _MUSIC_WORDS = frozenset({
        "music", "song", "songs", "lofi", "lo-fi", "playlist", "track", "tracks",
        "album", "beat", "beats", "audio", "jazz", "classical", "rock", "pop",
        "rap", "hip", "hop", "chill", "remix", "radio", "tune", "tunes",
    })
    _VIDEO_WORDS = frozenset({"video", "videos", "movie", "movies", "clip", "clips", "stream"})
    words = set(text_lower.split())

    if matched_verb in ("listen to ", "put on "):
        # "listen to lofi" / "put on some music" — near-certain Spotify intent
        return "music"

    if matched_verb == "watch ":
        # "watch a video" / "watch something" — near-certain YouTube intent
        return "youtube"

    if matched_verb in ("search ", "browse ", "navigate to "):
        # "search for X" / "browse to X" / "navigate to youtube.com" → browser
        return "browser"

    if matched_verb in ("play ", "start ", "show "):
        # "play" is broad — require content-type words before routing blindly
        if words & _MUSIC_WORDS:
            return "music"
        if words & _VIDEO_WORDS:
            return "youtube"

    if matched_verb in ("buy ", "order ", "purchase ", "shop for "):
        # Shopping without explicit store → default to Amazon.
        # "I want to buy shoes" → amazon (search for "shoes").
        # This fires only when Stage 2 found no explicit store name, so
        # "buy from Flipkart" still routes correctly via Stage 2.
        return "amazon"

    # "open", "launch", "pull up", "turn on" without an explicit app name
    # are unresolvable — fall through to LLM or clarify path.
    return None


def _press_media_play():
    """Send VK_MEDIA_PLAY_PAUSE (0xB3) via WinAPI — no extra dependencies."""
    try:
        user32 = ctypes.windll.user32
        user32.keybd_event(0xB3, 0, 0, 0)        # key down
        time.sleep(0.05)
        user32.keybd_event(0xB3, 0, 0x0002, 0)   # key up
    except Exception as e:
        print(f"Media key error: {e}")


def _set_clipboard_text(text):
    """
    Write text to the Windows clipboard using ctypes — no external deps.
    Used to paste search queries into apps via Ctrl+V.
    """
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE  = 0x0002
    try:
        kernel32 = ctypes.windll.kernel32
        user32   = ctypes.windll.user32
        encoded  = text.encode('utf-16-le')
        size     = len(encoded) + 2         # +2 for UTF-16 null terminator
        if not user32.OpenClipboard(0):
            return False
        user32.EmptyClipboard()
        h = kernel32.GlobalAlloc(GMEM_MOVEABLE, size)
        p = kernel32.GlobalLock(h)
        ctypes.memmove(p, encoded, len(encoded))
        kernel32.GlobalUnlock(h)
        user32.SetClipboardData(CF_UNICODETEXT, h)
        user32.CloseClipboard()
        return True
    except Exception as e:
        print(f"[clipboard] error: {e}")
        return False


def _spotify_open_and_play(query, delay=3.0):
    """
    Open Spotify at search results for `query` and attempt keyboard automation to play.

    Automation sequence (runs in background thread after Spotify loads):
      1. Enter → plays if Spotify auto-focused the top result (works in many versions)
      2. Tab×2 + Enter → navigates past header to first playable track, plays it
    No Spotify API or external deps required.
    """
    uri = f"spotify:search:{urllib.parse.quote(query)}"
    try:
        os.startfile(uri)
    except Exception:
        webbrowser.open(f"https://open.spotify.com/search/{urllib.parse.quote_plus(query)}")
        return

    def _automate():
        time.sleep(delay)
        user32    = ctypes.windll.user32
        VK_RETURN = 0x0D
        VK_TAB    = 0x09

        def _press(vk):
            user32.keybd_event(vk, 0, 0, 0)
            time.sleep(0.06)
            user32.keybd_event(vk, 0, 0x0002, 0)

        try:
            # Step 1: Enter — plays if a track is auto-selected in this Spotify version
            _press(VK_RETURN)
            time.sleep(0.4)
            # Step 2: Tab to first clickable result, Tab again to first song, Enter to play
            _press(VK_TAB)
            time.sleep(0.1)
            _press(VK_TAB)
            time.sleep(0.1)
            _press(VK_RETURN)
            print(f"[Spotify] keyboard play sequence sent for: {query}")
        except Exception as e:
            print(f"[Spotify] keyboard automation error: {e}")

    threading.Thread(target=_automate, daemon=True).start()


def _youtube_play(query):
    """
    Try to open the direct video URL for the first YouTube search result.
    If yt-dlp is installed, it fetches the URL (which auto-plays in browser).
    Returns True if a direct URL was opened, False if falling back to search.
    """
    try:
        r = subprocess.run(
            ["yt-dlp", f"ytsearch1:{query}", "--print", "webpage_url",
             "--no-playlist", "--quiet", "--no-warnings"],
            capture_output=True, text=True, timeout=15
        )
        url = r.stdout.strip()
        if url and url.startswith("https://www.youtube.com/watch"):
            webbrowser.open(url)
            print(f"[YouTube] playing: {url}")
            return True
    except FileNotFoundError:
        pass   # yt-dlp not installed — silent fallback
    except Exception as e:
        print(f"[YouTube] yt-dlp error: {e}")
    return False


def _extract_search_query(text_lower):
    """
    Pull search terms for YouTube / browser.
    Handles 'play X on youtube', 'open youtube and play X', 'watch X',
    'search for X', 'find X', 'look up X', 'google X'.
    """
    # "play X on youtube" / "open youtube and play X" / "watch X on youtube"
    m = re.search(r'(?:play|watch)\s+(.+?)(?:\s+on\s+(?:youtube|google|browser|chrome))?$',
                  text_lower)
    if m:
        q = m.group(1).strip()
        q = re.sub(r'\s+(?:on|in)\s+(?:youtube|google|browser|chrome).*$', '', q).strip()
        if q:
            return q

    # standard search verbs
    m = re.search(
        r'(?:search\s+for|search|find|look\s+up|google)\s+(.+?)(?:\s+on\s+\w+)?$',
        text_lower, re.IGNORECASE
    )
    if m:
        return m.group(1).strip()
    return ""


def _extract_spotify_query(text_lower):
    """
    Pull search terms for Spotify.
    Handles 'play X on spotify', 'open spotify and play X', 'play X',
    'listen to X', 'put on X'.
    Returns empty string if no specific query found (caller uses generic play).
    """
    # Filler words that are too generic to be a useful search query.
    # Reject if the extracted term is exactly one of these or starts with one.
    _QUERY_FILLERS = frozenset({
        'music', 'something', 'songs', 'a song', 'anything',
        'it', 'that', 'this', 'me', 'us', 'them', 'now',
    })

    def _clean_q(raw):
        """Strip trailing app references and reject filler-only terms."""
        q = re.sub(r'\s+(?:on|in|via)\s+(?:spotify|music).*$', '', raw).strip()
        words = q.split()
        if q and q not in _QUERY_FILLERS and (not words or words[0] not in _QUERY_FILLERS):
            return q
        return ""

    # "play X on spotify"
    m = re.search(r'play\s+(.+?)\s+on\s+spotify', text_lower)
    if m:
        return m.group(1).strip()

    # "spotify ... play X" / "open spotify and play X"
    m = re.search(r'spotify.*?(?:and\s+)?play\s+(.+?)$', text_lower)
    if m:
        q = re.sub(r'\s+(?:on|in)\s+spotify.*$', '', m.group(1)).strip()
        if q:
            return q

    # "listen to X" / "listen to some X" — explicit media-listen verb (P2.A.1)
    # Handles: "listen to lofi", "listen to some jazz", "listen to hip hop"
    m = re.search(r'listen\s+to\s+(?:some\s+)?(.+?)$', text_lower)
    if m:
        q = _clean_q(m.group(1).strip())
        if q:
            return q

    # "put on X" / "put on some X" — implicit play request (P2.A.1)
    # Handles: "put on some chill music", "put on lofi"
    m = re.search(r'put\s+on\s+(?:some\s+)?(.+?)$', text_lower)
    if m:
        q = _clean_q(m.group(1).strip())
        if q:
            return q

    # "play X" as entire command (e.g. "play lofi" while spotify is implied)
    m = re.search(r'^play\s+(.+)', text_lower)
    if m:
        q = _clean_q(re.sub(r'\s+(?:on|in|via)\s+(?:spotify|music).*$', '', m.group(1)).strip())
        # Reject: empty, exact filler match, or starts with a pronoun/filler word
        # "play it back" → first_word="it" → rejected (routes to generic media play)
        # "play me a song" → first_word="me" → rejected
        # "play lofi beats" → first_word="lofi" → accepted
        if q:
            return q

    return ""


def process_open_app(app_key, text_lower=""):
    """
    Open the app and perform a secondary action when the utterance implies one.

    Spotify / music  → spotify:search:QUERY URI (deep search) if query found,
                        else open + media-play key
    YouTube          → YouTube search results if play/watch/search query found
    Browser / Chrome → Google search if search query found
    WhatsApp         → native app via whatsapp: URI, web fallback
    Others           → open only
    """
    try:
        # ── Spotify ──────────────────────────────────────────────────────────
        if app_key in ("spotify", "music"):
            q = _extract_spotify_query(text_lower)
            if q:
                # Opens Spotify at search results + keyboard automation to press play.
                # _spotify_open_and_play() fires os.startfile() and returns immediately;
                # the keyboard automation runs in a background thread after `delay`.
                try:
                    _spotify_open_and_play(q, delay=3.0)
                except OSError as e:
                    print(f"[Spotify] startfile error: {e}")
                    webbrowser.open(f"https://open.spotify.com/search/{urllib.parse.quote_plus(q)}")
                return f"Playing {q} on Spotify."
            # No specific query — open Spotify and trigger media play key.
            # time.sleep(1.5) is moved to a background thread so the voice
            # pipeline is not blocked while waiting for Spotify to focus.
            try:
                _APP_COMMANDS[app_key]()
            except OSError as e:
                print(f"[Spotify] startfile error: {e}")
                webbrowser.open("https://open.spotify.com")
            if any(w in text_lower for w in ("play", "music", "song", "resume")):
                def _delayed_media_key():
                    time.sleep(1.5)
                    _press_media_play()
                threading.Thread(target=_delayed_media_key, daemon=True).start()
                return "Opening Spotify and playing."
            return "Opening Spotify."

        # ── YouTube ───────────────────────────────────────────────────────────
        if app_key == "youtube":
            q = _extract_search_query(text_lower)
            if q:
                # Open search results immediately so the user gets feedback right away.
                # Then try yt-dlp in a background thread (3s timeout) to open the
                # direct video URL if available — avoids blocking the voice pipeline
                # for up to 15s while yt-dlp resolves.
                search_url = f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(q)}"
                webbrowser.open(search_url)
                def _try_direct_video():
                    try:
                        r = subprocess.run(
                            ["yt-dlp", f"ytsearch1:{q}", "--print", "webpage_url",
                             "--no-playlist", "--quiet", "--no-warnings"],
                            capture_output=True, text=True, timeout=3
                        )
                        url = r.stdout.strip()
                        if url and url.startswith("https://www.youtube.com/watch"):
                            webbrowser.open(url)
                            print(f"[YouTube] direct play: {url}")
                    except FileNotFoundError:
                        pass   # yt-dlp not installed — search page already open
                    except Exception as e:
                        print(f"[YouTube] yt-dlp error: {e}")
                threading.Thread(target=_try_direct_video, daemon=True).start()
                return f"Searching YouTube for {q}."
            _APP_COMMANDS[app_key]()
            return "Opening YouTube."

        # ── Browser / Chrome / Google ─────────────────────────────────────────
        if app_key in ("browser", "chrome", "google"):
            q = _extract_search_query(text_lower)
            if q:
                webbrowser.open(f"https://www.google.com/search?q={urllib.parse.quote_plus(q)}")
                return f"Searching for {q}."
            _APP_COMMANDS[app_key]()
            return "Opening browser."

        # ── Amazon ────────────────────────────────────────────────────────────
        if app_key == "amazon":
            q = _extract_search_query(text_lower)
            # Also try "buy X", "order X", "purchase X" forms
            if not q:
                m = re.search(r'(?:buy|order|purchase|shop for|get me|find me)\s+(.+?)(?:\s+on\s+amazon|$)', text_lower)
                if m:
                    q = m.group(1).strip()
            if q:
                webbrowser.open(f"https://www.amazon.com/s?k={urllib.parse.quote_plus(q)}")
                return f"Searching Amazon for {q}."
            _APP_COMMANDS[app_key]()
            return "Opening Amazon."

        # ── WhatsApp ──────────────────────────────────────────────────────────
        if app_key == "whatsapp":
            try:
                _APP_COMMANDS[app_key]()
            except OSError:
                webbrowser.open("https://web.whatsapp.com")
            return "Opening WhatsApp."

        # ── Maps ──────────────────────────────────────────────────────────────
        if app_key == "maps":
            q = _extract_search_query(text_lower)
            if q:
                webbrowser.open(f"https://maps.google.com/search/{urllib.parse.quote_plus(q)}")
                return f"Searching maps for {q}."
            _APP_COMMANDS[app_key]()
            return "Opening Maps."

        # ── Default (clock, calculator, notepad, calendar, settings, files) ───
        try:
            _APP_COMMANDS[app_key]()
        except OSError as e:
            print(f"[App] startfile error for '{app_key}': {e}")
            return f"I couldn't open {app_key}. It may not be installed."
        label = app_key.capitalize()
        return f"Opening {label}."

    except Exception as e:
        print(f"[App] Unexpected error [{app_key}]: {e}")
        return f"I couldn't open {app_key}."


# ─────────────────────────────────────────────
# BACKEND CALLS
# ─────────────────────────────────────────────
def send_ask(query):
    """
    Blocking LLM call — fallback when streaming fails before any token arrives.

    Timeout is 30s (down from 60s): the stream already burned up to 12s on the
    first-token watchdog before this fires, so we don't need an additional 60s.
    If Ollama is stalled the blocking call will likely fail too, but at least it
    fails quickly rather than leaving the user in silence for two full minutes.
    """
    try:
        now     = datetime.now()
        # Slice to [-6:] (3 Q+A pairs) — same window as get_answer_stream().
        # JS buildPrompt() also slices to -6, so sending more entries is wasteful.
        # This aligns both LLM paths to the same authoritative 3-pair window.
        resp    = requests.post(
            f"{BACKEND}/api/ai/ask",
            json={
                "query":        query,
                "time_context": now.strftime("Today is %A, %B %d %Y. Current time is %I:%M %p."),
            },
            headers=auth_headers(),
            timeout=30
        )
        if resp.status_code == 401:
            _try_reload_token()  # best-effort reload for next call
            return "I need to sign in again. Please use the desktop app to log in."
        resp.raise_for_status()
        return resp.json().get("answer", "No answer received.")
    except requests.exceptions.ConnectionError:
        return "I can't reach the backend. Is the server running?"
    except Exception as e:
        print(f"Ask error: {e}")
        return "Something went wrong. Please try again."


def send_store_memory(content, memory_type=None):
    if memory_type is None:
        c = content.lower()
        if any(w in c for w in ["meeting", "class", "gym", "deadline", "schedule",
                                  "monday", "tuesday", "wednesday", "thursday",
                                  "friday", "saturday", "sunday", "am", "pm",
                                  "today", "tomorrow"]):
            # "schedule" is not a valid memoryModel enum value — map to "personal".
            # Schedule/calendar facts are personal facts; the distinction is
            # not used anywhere in the search or retrieval pipeline.
            memory_type = "personal"
        elif any(w in c for w in ["prefer", "like", "love", "hate", "dislike",
                                   "favourite", "favorite", "always use", "i use"]):
            memory_type = "preference"
        elif any(w in c for w in ["i am", "my name", "i live", "i work",
                                   "i study", "i am a"]):
            # "identity" is not a valid memoryModel enum value — map to "personal".
            memory_type = "personal"
        else:
            memory_type = "personal"
    try:
        resp = requests.post(
            f"{BACKEND}/api/memory/store",
            json={"content": content, "type": memory_type},
            headers=auth_headers(),
            timeout=15
        )
        resp.raise_for_status()
        return "Got it, I'll remember that."
    except Exception as e:
        print(f"Memory error: {e}")
        return "I couldn't save that memory right now."


def send_set_reminder(reminder_text, reminder_time):
    try:
        resp = requests.post(
            f"{BACKEND}/api/reminders",
            json={"text": reminder_text, "reminderTime": reminder_time.isoformat()},
            headers=auth_headers(),
            timeout=10
        )
        resp.raise_for_status()
        time_str = reminder_time.strftime("%I:%M %p").lstrip("0")

        # Delegate delivery to Electron ReminderManager — owns persistence, notification,
        # and recovery independent of voice.py lifecycle.  MongoDB path preserved for history.
        try:
            print(f"AURA:SET_REMINDER:{reminder_text}:{reminder_time.isoformat()}", flush=True)
        except Exception as sig_err:
            print(f"[Reminder] Electron signal failed (non-fatal): {sig_err}")

        return f"Reminder set for {time_str}."
    except Exception as e:
        print(f"Reminder error: {e}")
        return "I couldn't set that reminder right now."


# ─────────────────────────────────────────────
# CONVERSATION HISTORY PERSISTENCE (P2.4)
#
# Two-tier history design:
#   Tier 1 (in-session):  _conversation_history deque — authoritative for the
#                          current session.  Fast, no latency.
#   Tier 2 (across sessions): MongoDB ConversationHistory document — loaded on
#                          startup, written after each turn.
#
# Persistence is always fire-and-forget (background daemon thread).  The main
# voice loop is never blocked.  If the backend is unreachable, history for
# the current session is still correct in-memory; only restart continuity
# is affected.
#
# Ownership rules:
#   - _conversation_history is the authoritative in-session state.
#   - MongoDB is loaded exactly once on startup, then written incrementally.
#   - Neither system is a substitute for the other.
#   - Memory (MongoDB 'memories' collection) and history are distinct systems;
#     they must not be merged or confused.
#
# Future integration note:
#   A future reflection / world-model system should read from
#   GET /api/conversation/history to periodically summarise turns into Memory.
#   The `savedAt` timestamps on persisted turns provide the temporal boundary.
#   _persist_turn_async() is the natural hook for a future write-audit trail.
# ─────────────────────────────────────────────

# How many turns to load on startup (matches deque maxlen)
_HISTORY_LOAD_LIMIT = 20


def _load_history_on_startup() -> None:
    """
    Restore conversation continuity after a restart.

    Calls GET /api/conversation/history to retrieve the last _HISTORY_LOAD_LIMIT
    turns from MongoDB and populates _conversation_history.  Must be called
    after ensure_authenticated() so auth_headers() is valid.

    Failure modes (all degrade gracefully — voice.py starts with empty history):
      - Backend unreachable  → logged, empty history, normal startup continues
      - HTTP error           → logged, empty history
      - Malformed response   → logged, empty history
      - Invalid turn entries → silently skipped (role/content validation)
    """
    global _history_loaded_for_token
    try:
        resp = requests.get(
            f"{BACKEND}/api/conversation/history",
            headers=auth_headers(),
            timeout=5
        )
        if resp.status_code != 200:
            print(f"[History] Load failed: HTTP {resp.status_code} — starting with empty history")
            return

        turns = resp.json().get("turns", [])
        loaded = 0
        _conversation_history.clear()
        for turn in turns:
            role    = turn.get("role", "")
            content = turn.get("content", "")
            if role in ("user", "assistant") and content:
                # Sanitize assistant content before loading into the deque.
                # Sessions before the Section-40 prompt integrity fix may have stored
                # contaminated responses (label echoes, stock openers, meta-commentary).
                # Without this clean pass, those turns inject structural contamination
                # into every subsequent prompt as a behavioral example for the LLM.
                # User turns are not sanitized — they're raw STT and should be preserved.
                if role == "assistant":
                    cleaned = _clean_llm_output(content)
                    if not cleaned or _is_malformed_response(cleaned) or _SCAFFOLD_LEAK_RE.search(cleaned):
                        if _conversation_history and _conversation_history[-1].get("role") == "user":
                            _conversation_history.pop()
                        continue
                    content = cleaned
                _conversation_history.append({"role": role, "content": content})
                loaded += 1

        if loaded:
            print(f"[History] Restored {loaded} turns from previous session.")
        else:
            print("[History] No prior history found — starting fresh.")

    except requests.exceptions.ConnectionError:
        print("[History] Backend unreachable — starting with empty history")
    except Exception as e:
        print(f"[History] Load error: {e} — starting with empty history")


def _load_history_if_needed(force: bool = False) -> None:
    global _history_loaded_for_token
    if not _token:
        return
    if force or _history_loaded_for_token != _token:
        _load_history_on_startup()
        _history_loaded_for_token = _token


def _persist_turn_async(user_content: str, assistant_content: str) -> None:
    """
    Persist one Q+A turn to MongoDB in a background daemon thread.

    Fire-and-forget: the main voice loop is never blocked.  The in-memory
    _conversation_history deque is already updated before this is called;
    this function only provides restart continuity.

    Failure handling:
      - Network/backend failure → logged, not retried (in-memory state is correct)
      - HTTP error response     → logged, not retried
    Not retrying is intentional: a single missed persist is acceptable; retry
    logic would require a queue and adds complexity out of P2.4 scope.

    Ordering: MongoDB serialises concurrent $push operations on the same
    document at the document level, so turn order is preserved even if two
    turns complete in rapid succession.
    """
    def _write():
        try:
            with _history_persist_lock:
                # Sanitize assistant content before persisting.  speak_stream() assembles
                # the response from per-sentence-cleaned chunks, but any prose contamination
                # that survived _clean_llm_output at the sentence level is caught here as a
                # final pass before it enters MongoDB.  _load_history_on_startup() also runs
                # _clean_llm_output on load, but cleaning at write-time ensures MongoDB is
                # the ground truth rather than relying on the read-time pass alone.
                clean_assistant = _clean_llm_output(assistant_content)
                if (
                    not clean_assistant
                    or _is_malformed_response(clean_assistant)
                    or _SCAFFOLD_LEAK_RE.search(clean_assistant)
                ):
                    print("[History] Skipping malformed assistant turn persist")
                    return
                resp = requests.post(
                    f"{BACKEND}/api/conversation/history",
                    json={"turns": [
                        {"role": "user",      "content": user_content},
                        {"role": "assistant", "content": clean_assistant},
                    ]},
                    headers=auth_headers(),
                    timeout=5
                )
                if resp.status_code not in (200, 201):
                    print(f"[History] Persist failed: HTTP {resp.status_code}")
        except requests.exceptions.ConnectionError:
            pass   # backend not running — in-memory state is fine
        except Exception as e:
            print(f"[History] Persist error: {e}")

    threading.Thread(target=_write, daemon=True, name="history-persist").start()


# ─────────────────────────────────────────────
# REMINDER POLLER (background daemon)
# ─────────────────────────────────────────────
def reminder_poll_loop():
    """
    Background daemon: polls backend every POLL_INTERVAL seconds for fired reminders.
    Exceptions are logged — never silently swallowed — so polling failures are visible
    in the console rather than causing silent delivery gaps.
    """
    while True:
        time.sleep(POLL_INTERVAL)
        try:
            resp = requests.get(
                f"{BACKEND}/api/reminders/pending-voice",
                headers=auth_headers(),
                timeout=5
            )
            if resp.status_code != 200:
                print(f"[Reminder] Poll returned HTTP {resp.status_code} — skipping tick")
                continue
            for reminder in resp.json().get("fired", []):
                print(f"\n[Reminder] Speaking: \"{reminder['text']}\"")
                speak(reminder["text"])
        except requests.exceptions.ConnectionError:
            # Expected when backend is not running — log once per failure, not every tick
            print("[Reminder] Backend unreachable — will retry next poll")
        except requests.exceptions.Timeout:
            print("[Reminder] Poll request timed out — will retry next poll")
        except Exception as exc:
            print(f"[Reminder] Unexpected poll error: {exc}")


# ─────────────────────────────────────────────
# COMMAND PROCESSOR
# ─────────────────────────────────────────────
def process_command(text, intent: str | None = None):
    """
    Execute a pre-classified action command.

    `intent` should be the value already computed by detect_intent() in the
    main loop.  If omitted (legacy callers), detect_intent() is called once
    here.  Passing the pre-computed intent eliminates the double-dispatch that
    previously ran detect_intent() twice for every reminder/memory command.

    Note: the `else: send_ask(text)` branch below is retained for safety (a
    caller could theoretically pass intent="ask") but is never reached from
    the main loop — the main loop only calls this function for
    "set_reminder" and "store_memory" intents.
    """
    if not text:
        return "I didn't catch that. Could you say it again?"

    if intent is None:
        intent = detect_intent(text)

    if intent == "set_reminder":
        reminder_text = parse_reminder_text(text)
        reminder_time = parse_reminder_time(text)
        if reminder_time:
            return send_set_reminder(reminder_text, reminder_time)
        return "I couldn't figure out the time. Try saying 'at 7pm' or 'in 10 minutes'."

    elif intent == "store_memory":
        clean = text
        for trigger in ["remember that", "don't forget that", "don't forget",
                        "keep in mind that", "keep in mind", "note that",
                        "store this", "remember"]:
            clean = clean.replace(trigger, "").strip()
        clean = clean.strip(" .,")
        if not clean:
            return "What would you like me to remember?"
        print(f"Storing memory: '{clean}'")
        return send_store_memory(clean)

    else:
        return send_ask(text)


# ─────────────────────────────────────────────
# ENTRY POINT
# ─────────────────────────────────────────────
if __name__ == "__main__":

    # ── Force UTF-8 stdout/stderr — prevent cp1252 crashes on Windows ─────────
    # When spawned by Electron the stdio streams inherit the Windows console
    # code page (cp1252 by default). Any print() containing a character outside
    # cp1252 — e.g. check marks, arrows, curly quotes — raises UnicodeEncodeError
    # and crashes voice.py before it can even reach the listening loop.
    # reconfigure() is Python 3.7+ and is a no-op on UTF-8 systems.
    if hasattr(sys.stdout, "reconfigure"):
        # line_buffering=True: flush after every newline so signals like
        # AURA:SET_TIMER: are never held in the block buffer until the OS
        # decides to flush the pipe — critical when stdout is not a TTY.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")

    # ── Detect Electron mode FIRST ────────────────────────────────────────────
    # Must happen before ensure_authenticated() so that function never calls
    # input() when stdin is an Electron IPC pipe.
    AUTO_MODE = not sys.stdin.isatty()

    ensure_authenticated()
    load_models()

    # ── Restore conversation history (P2.4) ──────────────────────────────────
    # Load the last session's turns from MongoDB before the greeting plays.
    # If the backend is unavailable, voice.py proceeds with an empty history.
    # This call is synchronous at startup — it happens before any voice activity,
    # so the 5s timeout does not impact first-audio latency.

    poll_thread = threading.Thread(target=reminder_poll_loop, daemon=True)
    poll_thread.start()

    # ── Start serial event sender ─────────────────────────────────────────────
    # Single daemon thread that drains _event_send_queue in FIFO order.
    # Must be started before any _push_event() call (including the greeting).
    threading.Thread(target=_event_sender_loop, name="event-sender", daemon=True).start()

    # ── Start persistent TTS event loop ──────────────────────────────────────
    # One daemon thread runs an asyncio loop for all TTS coroutines.
    # Must be started before any speak() or pre-warm call.
    print("[TTS] Starting persistent TTS event loop...")
    _start_tts_loop()

    # ── Pre-warm edge-tts connection ──────────────────────────────────────────
    # The first edge-tts call opens a new HTTPS connection to Microsoft TTS servers
    # (DNS + TCP + TLS = ~300-800ms, sometimes longer). Pre-warming before the
    # greeting ensures subsequent calls reuse a warm connection, eliminating
    # cold-start failures that trigger SAPI fallbacks.
    print("[TTS] Warming up edge-tts connection...")
    _warm_ok = False
    try:
        # 6s timeout — enough for cold-start DNS+TCP+TLS+request on a normal connection.
        # If TTS network is unavailable, SAPI fallback activates on first speak() call.
        _warm_bytes = _run_tts_coro(_generate_tts_bytes("hi"), timeout=6.0)
        _warm_ok = bool(_warm_bytes)
    except Exception as _we:
        print(f"[TTS] pre-warm error ({type(_we).__name__}): {_we}")
    print(f"[TTS] edge-tts {'ready' if _warm_ok else 'unavailable - SAPI fallback active'}.")

    # ── Startup greeting ─────────────────────────────────────────────────────
    _greeting = "Welcome back, Rudra."
    print(f"AURA: {_greeting}")
    _push_event({"type": "voice", "state": "speaking", "text": _greeting})
    speak(_greeting, _report_failure=False)
    _push_event({"type": "voice", "state": "idle"})

    # ── Signal Electron that AURA is fully ready ─────────────────────────────
    # Electron's main.js watches for this exact line on stdout to transition
    # the UI from the splash screen to the ready state.
    print("AURA:VOICE_READY", flush=True)

    # ── Start debug session ───────────────────────────────────────────────────
    # No-op when AURA_DEBUG is not set — zero overhead in production.
    dbg.session_start()

    if AUTO_MODE:
        print("AURA is ready. Running in continuous listening mode.\n", flush=True)
        # Start stdin monitor so Electron can send PAUSE / RESUME commands
        threading.Thread(target=_stdin_monitor, daemon=True).start()
    else:
        print("AURA is ready. Press Enter to speak (Ctrl+C to quit).\n")

    _was_interrupted = False   # True = skip Enter keypress, go straight to recording

    while True:
        # ── Pause support — Electron can suspend the listen loop ─────────────
        if _paused.is_set():
            # Check quit inside the pause branch — _should_quit check below is
            # never reached while paused, so we must honor it here too.
            if _should_quit.is_set():
                print("[voice] Exiting cleanly (from paused state).", flush=True)
                dbg.session_end("quit-while-paused")
                break
            time.sleep(0.4)
            continue

        # ── Sleep support — AURA is in idle/goodbye state, waiting for WAKE ──
        # Triggered by goodbye/sleep phrases detected below.
        # Cleared by WAKE stdin command from Electron (voiceWake IPC).
        #
        # SLEEP ≠ QUIT:  saying "goodbye" ONLY sets _sleeping — voice.py stays
        # alive and the Electron app keeps running.  _should_quit is set ONLY
        # when Electron explicitly sends "QUIT\n" to stdin (via before-quit
        # handler when the user closes the app from the tray or title bar).
        # This separation is intentional and must not be collapsed.
        if _sleeping.is_set():
            # Check quit inside the sleep branch — _should_quit check below is
            # never reached while sleeping, so we must honor it here too.
            if _should_quit.is_set():
                print("[voice] Exiting cleanly (from sleep state).", flush=True)
                dbg.session_end("quit-while-sleeping")
                break
            time.sleep(0.5)
            continue

        # ── Clean quit — QUIT command received from Electron ────────────────
        # _should_quit is set by _stdin_monitor when Electron sends QUIT.
        # Breaking here keeps process exit in the main thread, avoiding
        # SystemExit-in-daemon-thread issues on Windows Python 3.10-3.12.
        if _should_quit.is_set():
            print("[voice] Exiting cleanly.", flush=True)
            dbg.session_end("quit-signal")
            break

        # ── Stop previous interrupt monitor + clear interrupt state ─────────
        # Signal the previous turn's monitor to exit before clearing the event,
        # so no old monitor can set _playback_interrupt after we clear it.
        _monitor_stop.set()          # terminate previous monitor (no-op if already stopped)
        _playback_interrupt.clear()  # clear interrupt flag for this turn

        # ── Reset state at top of each cycle ────────────────────────────────────
        # Makes the listening lifecycle deterministic: idle → listening → thinking
        # → speaking → idle (loop).  Pushed here so the orb always shows idle
        # during the brief inter-turn pause — regardless of how the previous turn
        # ended (normal, interrupted, error, or transcript-delivery overwrite).
        _push_event({"type": "voice", "state": "idle"})

        # ── Wait for trigger (Enter in terminal, auto-loop in Electron) ─
        if not _was_interrupted:
            if AUTO_MODE:
                time.sleep(0.3)   # brief pause between continuous listening cycles
            else:
                try:
                    input("Press Enter to speak (Ctrl+C to quit)...")
                except KeyboardInterrupt:
                    print("\nGoodbye.")
                    dbg.session_end("keyboard-interrupt")
                    _push_event({"type": "voice", "state": "idle"})
                    break
                except EOFError:
                    # stdin was closed (e.g. pipe from Electron) — switch to auto mode
                    AUTO_MODE = True
                    time.sleep(0.3)
        else:
            print("(Interrupted — listening...)")
        _was_interrupted = False

        dbg.loop_state("LISTENING")
        _push_event({"type": "voice", "state": "listening"})
        speech_detected = record_audio()

        if not speech_detected:
            # VAD saw no energy above threshold — pre-speech timeout fired.
            # Reset silently without a "thinking" flash or "I didn't catch that" response.
            dbg.loop_state("IDLE", "VAD: no speech energy detected")
            _push_event({"type": "voice", "state": "idle"})
            continue

        # Speech detected — now transcribe
        dbg.loop_state("TRANSCRIBING")
        _push_event({"type": "voice", "state": "thinking"})
        text = transcribe_audio()

        if not text:
            print("(Nothing clear detected — try again)")
            dbg.stt_result("", "", dropped=True)
            _push_event({"type": "voice", "state": "idle"})
            speak("I didn't catch that... try again.")
            continue

        dbg.stt_result(text, text)   # raw == cleaned at this stage; _clean_transcript ran inside transcribe_audio
        print(f"You said: {text}", flush=True)
        _push_event({"type": "voice", "state": "thinking", "text": text})

        # ── Sleep/goodbye detection ───────────────────────────────────────────
        # Recognised phrases put AURA into controlled idle sleep.
        # Voice loop spins silently until Electron sends WAKE (via voiceWake IPC
        # or the sleep button in the UI).  The app stays running — no shutdown.
        _SLEEP_PHRASES = (
            "goodbye", "good bye", "bye aura", "see you", "see ya",
            "go to sleep", "sleep now", "goodnight", "good night",
            "stop listening", "that's all", "that's all for now",
        )
        if any(phrase in text.lower() for phrase in _SLEEP_PHRASES):
            answer = "Okay, going to sleep. Say wake up or press the button to resume."
            _push_event({"type": "voice", "state": "speaking", "text": answer})
            speak(answer)
            _push_event({"type": "voice", "state": "idle"})
            _sleeping.set()
            print("AURA:SLEEPING", flush=True)
            print("[voice] Entered sleep state.", flush=True)
            continue

        # ── Transcript normalization ──────────────────────────────────────────
        # Strip leading hesitation words + Whisper comma-punctuation BEFORE
        # reference resolution and routing.
        # e.g. "um, set a timer for 30 seconds" → "set a timer for 30 seconds"
        # This must run before _resolve_references so fillers don't confuse
        # pronoun resolution either.
        normalized_text = _normalize_transcript(text.lower())

        # ── Reference resolution (P2.A.2) ────────────────────────────────────
        # Resolve conversational references BEFORE intent detection so that:
        #   "play this on youtube" → "play {entity} on youtube" → routes correctly
        #   "open it again"        → "open {last_app}"          → routes correctly
        # `text` (original STT output) is preserved for history + display.
        # `resolved_text` is used for all execution: routing, extraction, context.
        resolved_text = _resolve_references(normalized_text)

        intent = detect_intent(resolved_text)

        # ── Actions — never touch LLM ────────────────────────────────
        # Action confirmations ("Playing rock music on Spotify.", "Timer set for 30
        # seconds.") are NOT stored in _conversation_history.  Injecting action
        # outputs into the LLM's context causes the model to produce action-aware
        # responses on unrelated subsequent queries ("Opening Spotify..." leaking
        # into conversational turns).  _persist_turn_async() still records the
        # turn in MongoDB for historical purposes — it just never feeds LLM prompts.
        if intent == "set_timer":
            duration = parse_timer_duration(text)
            answer   = set_native_timer(duration) if duration else \
                       "How long? Try saying 'set a timer for 5 minutes'."
            _push_event({"type": "voice", "state": "speaking", "text": answer})
            speak(answer)
            _push_event({"type": "voice", "state": "idle"})

        elif intent.startswith("open_app:"):
            parts    = intent.split(":")
            app_key  = parts[1]
            followup = len(parts) > 2 and parts[2] == "followup"

            if followup:
                # Re-use stored context — repeat the last action (e.g. "play the song" → Spotify)
                ctx        = _get_action_context()
                stored_q   = ctx.get("query", "")
                replay_txt = f"play {stored_q} on {app_key}" if stored_q else f"play on {app_key}"
                answer     = process_open_app(app_key, replay_txt)
                # Refresh context timestamp so TTL restarts from now
                _set_action_context(app_key, stored_q)
            else:
                # Use resolved_text so extraction works on concrete queries,
                # never on pronoun literals like "this" or "the same thing".
                answer = process_open_app(app_key, resolved_text)
                # Save action context and entity context (both use resolved query)
                q = _extract_spotify_query(resolved_text) or _extract_search_query(resolved_text)
                _set_action_context(app_key, q)
                _update_entity_ctx_from_action(app_key, resolved_text)  # P2.A.2

            # Push action event to UI before speaking
            q_push = _extract_spotify_query(resolved_text) or _extract_search_query(resolved_text) or ""
            _push_event({"type": "action", "action": "open", "app": app_key,
                         "query": q_push, "timestamp": datetime.now().isoformat()})
            _push_event({"type": "voice", "state": "speaking", "text": answer})
            speak(answer)
            _push_event({"type": "voice", "state": "idle"})

        elif intent in ("set_reminder", "store_memory"):
            # Pass pre-computed intent to avoid running detect_intent() a second time
            answer = process_command(text, intent=intent)
            _push_event({"type": "voice", "state": "speaking", "text": answer})
            speak(answer)
            _push_event({"type": "voice", "state": "idle"})

        # ── LLM path — with decision engine pre-filter ───────────────
        else:
            # ---- Correction / topic-reset handling ----
            # Runs before _assess_query so the stale history pair is already gone
            # when the LLM path assembles the next prompt.
            #
            # When a correction is detected:
            #   1. Pop the most recent Q+A pair (2 entries) from _conversation_history.
            #      This removes the stale topic anchor before the next prompt is built.
            #   2. If the utterance contains a follow-up query after the correction
            #      clause ("that's wrong, tell me about inflation"), route the remainder
            #      as the real query -- so AURA trims history AND answers in one turn.
            #   3. If the utterance is ONLY a correction, acknowledge and loop back
            #      without invoking the LLM or storing anything.
            #   The correction utterance itself is NEVER stored in history.
            _was_correction = bool(_CORRECTION_RE.search(normalized_text))
            if _was_correction:
                # Trim the most recent pair from history if present
                if len(_conversation_history) >= 2:
                    _conversation_history.pop()   # assistant turn
                    _conversation_history.pop()   # user turn
                    print("[correction] Trimmed 1 stale Q+A pair from history")
                # Check for a follow-up query in the same utterance
                _correction_remainder = _extract_correction_remainder(normalized_text)
                if _correction_remainder and len(_correction_remainder.split()) >= 3:
                    # Route the follow-up as the real query for this turn
                    normalized_text = _correction_remainder
                    text = _correction_remainder  # history stores the follow-up, not the correction
                    _correction_just_occurred = True  # consumed by get_answer_stream this turn
                    print("[correction] Routing remainder: %r" % _correction_remainder[:60])
                else:
                    # Pure correction with no follow-up: acknowledge, skip LLM, skip history
                    _ack = "Got it, I'll move on."
                    _push_event({"type": "voice", "state": "speaking", "text": _ack})
                    speak(_ack)
                    _push_event({"type": "voice", "state": "idle"})
                    continue  # no history append, no persist

            # Run _assess_query on normalized_text (hesitation fillers stripped)
            # rather than raw `text`. Without this, Whisper-added fillers inflate
            # word count: "um smartwatch" = 2 words -> 'ask' instead of 'clarify'.
            # Using normalized_text means the word-count gate sees the same input
            # as detect_intent, keeping routing and assess_query in sync.
            mode = _assess_query(normalized_text)

            if mode == 'clarify':
                # Too short / ambiguous — ask for more detail without touching LLM.
                # IMPORTANT: clarify turns are NEVER stored in _conversation_history
                # or persisted to MongoDB.  They are noise-gate artifacts — the STT
                # captured something too short to be a real query (garbled audio,
                # background noise, a single word).  Storing them creates topic
                # anchors: a future LLM call would see e.g. "User: smartwatch /
                # Assistant: I didn't catch that" and treat "smartwatch" as prior
                # conversational context, causing cross-topic bleed.
                answer = "I didn't quite catch that... could you be a bit more specific?"
                _push_event({"type": "voice", "state": "speaking", "text": answer})
                speak(answer)
                _push_event({"type": "voice", "state": "idle"})
                # Intentionally no _conversation_history.append() and no _persist_turn_async().

            else:
                if mode == 'empathize':
                    # Speak immediate acknowledgment while LLM generates in background
                    _push_event({"type": "voice", "state": "speaking", "text": "That sounds tough."})
                    speak("That sounds tough.")
                    _push_event({"type": "voice", "state": "thinking"})

                _push_event({"type": "voice", "state": "thinking", "text": text})

                # ── Arm interrupt monitor for speaking phase only ──────────────
                # Moved here from before record_audio() to:
                #   1. Eliminate device conflict with VAD recording InputStream
                #   2. Ensure exactly one monitor thread per speaking turn
                # The monitor receives its own stop_event (module-level _monitor_stop
                # is rebound to a fresh Event each turn; old thread holds old ref).
                _monitor_stop = threading.Event()
                threading.Thread(
                    target=_interrupt_monitor,
                    args=(_monitor_stop,),
                    name="interrupt-monitor",
                    daemon=True
                ).start()

                dbg.loop_state("THINKING", f"mode={mode}  query={repr(text[:60])}")
                try:
                    # Switch orb to "speaking" before playback starts so the UI
                    # reflects reality during TTS generation + audio output.
                    dbg.loop_state("SPEAKING")
                    _push_event({"type": "voice", "state": "speaking"})
                    response = speak_stream(get_answer_stream(text))
                except Exception as e:
                    print(f"Pipeline error: {e}")
                    dbg.stream_event("pipeline-exception", detail=f"{type(e).__name__}: {str(e)[:80]}")
                    response = ""
                finally:
                    _monitor_stop.set()                              # speaking phase done — stop monitor
                    dbg.loop_state("IDLE", "speaking phase complete")
                    _push_event({"type": "voice", "state": "idle"})

                # Handle interrupt: skip Enter next turn.
                # Record interrupt state BEFORE _stop_all_playback() clears the flag.
                # This snapshot is used below to prevent partial/interrupted responses
                # from entering _conversation_history or MongoDB.
                _interrupted_this_turn = _playback_interrupt.is_set()
                if _interrupted_this_turn:
                    _stop_all_playback()
                    _was_interrupted = True

                if response and not _interrupted_this_turn and response.strip() != _last_response.strip():
                    _last_response = response
                    # Push completed response to UI chat — text delivery for transcript display.
                    # NOTE: uses state:"speaking" so the UI receives the text; an idle event
                    # is pushed immediately after to restore orb state.
                    _push_event({"type": "voice", "state": "speaking", "text": response})
                    _push_event({"type": "voice", "state": "idle"})
                    # Malformed-response guard: if the full response contains action-
                    # confirmation strings or structural garbage, do NOT store it in
                    # history.  It was already spoken (can't un-play audio), but we
                    # prevent it from poisoning subsequent LLM prompts as a behavioral
                    # example.  Log for visibility.
                    if _is_malformed_response(response) or _SCAFFOLD_LEAK_RE.search(response) or not _is_valid_response(response):
                        print(f"[guard] Malformed response discarded from history: "
                              f"{response[:80]!r}")
                        dbg.malformed(response, "action-confirmation or structural garbage matched _MALFORMED_RESPONSE_RE")
                        _push_diagnostic({
                            "type": "malformed_output_dropped",
                            "severity": "warn",
                            "data": {"sample": response[:120], "reason": "history_guard"},
                        })
                    else:
                        pass
                        # Persist only what was actually appended to _conversation_history.
                        # Malformed responses are excluded from both the in-memory deque and
                        # MongoDB — preventing cross-session contamination on restart.
