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

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
BACKEND        = "http://localhost:5000"
TOKEN_FILE     = os.path.expanduser("~/.aura_token")
POLL_INTERVAL  = 30

# TTS
TTS_VOICE     = "en-US-AriaNeural"
TTS_RATE      = "-10%"   # slightly slower → more natural
MAX_SENTENCES = 3        # S1 (core) + S2 (detail) + S3 (context) — aligns with prompt structure
MAX_TTS_CHARS = 600      # safety cap in case a single sentence is unusually long

# VAD recording
VAD_THRESHOLD      = 300    # RMS energy — catches quieter speech
VAD_SILENCE_CHUNKS = 18     # × 100 ms = 1.8 s silence → prevents mid-sentence cutoff
VAD_MAX_DURATION   = 12

# Whisper
WHISPER_MODEL_SIZE = "small"

# Known names for fuzzy STT correction
KNOWN_NAMES  = ["Chitnis", "Rudra", "AURA", "Sadgi", "Garg"]
_NAMES_LOWER = {n.lower(): n for n in KNOWN_NAMES}

# ─────────────────────────────────────────────
# GLOBALS
# ─────────────────────────────────────────────
_token        = None
whisper_model = None

_speak_lock         = threading.Lock()   # prevents overlapping TTS (main + reminder threads)
_tts_fail_count     = 0                  # consecutive TTS failures — triggers device recovery at 2
_playback_interrupt = threading.Event()  # set by interrupt monitor when user speaks during TTS
_paused             = threading.Event()  # set by stdin monitor when Electron sends PAUSE command

# Short-term conversation memory — last 20 exchanges (10 Q+A pairs)
_conversation_history: deque = deque(maxlen=20)
_last_response: str = ""        # dedup guard: skip if identical to previous response

# Stores the most recent open_app action so follow-up commands ("play it", "play the song")
# can resume the same action without the user restating the full command.
_last_action_context: dict = {}   # keys: "app_key", "query" (optional)


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
    global _token
    token = load_token()
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
    return {"Authorization": f"Bearer {_token}"}


# ─────────────────────────────────────────────
# UI EVENT PUSH  (non-blocking, best-effort)
# Posts state updates to the backend which broadcasts via WebSocket
# to the desktop UI.  All calls are fire-and-forget inside a daemon thread
# so a network blip never blocks the voice pipeline.
# ─────────────────────────────────────────────
def _push_event(event: dict):
    """Push a JSON event to the desktop UI via backend /api/events/push."""
    def _send():
        try:
            requests.post(
                f"{BACKEND}/api/events/push",
                json=event,
                timeout=2,
            )
        except Exception:
            pass  # UI update is best-effort — never crash voice pipeline
    threading.Thread(target=_send, daemon=True).start()


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
    """Read line commands from stdin (sent by Electron via voiceProc.stdin.write)."""
    try:
        for line in sys.stdin:
            cmd = line.strip().upper()
            if cmd == "PAUSE":
                _paused.set()
                _push_event({"type": "voice", "state": "idle"})
                print("[voice] Paused by user.", flush=True)
            elif cmd == "RESUME":
                _paused.clear()
                print("[voice] Resumed by user.", flush=True)
            elif cmd == "QUIT":
                print("[voice] Quit command received.", flush=True)
                raise SystemExit(0)
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

    print("Listening... (speak now)")
    audio_chunks = []
    silent_count = 0
    spoke        = False

    with sd.InputStream(samplerate=samplerate, channels=1, dtype="int16") as stream:
        for _ in range(max_chunks):
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

    wav.write(filename, samplerate, np.concatenate(audio_chunks, axis=0))
    print("Recording done.")


def transcribe_audio(filename="input.wav"):
    global whisper_model
    print("Transcribing...")
    try:
        segments, _ = whisper_model.transcribe(
            filename, language="en", beam_size=3, vad_filter=True
        )
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
                segments, _ = whisper_model.transcribe(
                    filename, language="en", beam_size=3, vad_filter=True
                )
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
        # Retry up to 3 times with increasing backoff before falling back to SAPI.
        # Handles transient network blips, edge-tts cold-start failures, and brief
        # Microsoft TTS service hiccups — which are the primary cause of random fallbacks.
        for _try in range(3):
            try:
                asyncio.run(_speak_edge(text))
                audio_played = True
                break
            except asyncio.TimeoutError:
                print(f"[TTS] edge-tts timeout (attempt {_try+1}/3)")
            except Exception as e:
                print(f"[TTS] edge-tts error [{type(e).__name__}] (attempt {_try+1}/3): {e}")
            if _try < 2:
                time.sleep(0.6 * (_try + 1))   # 0.6 s → 1.2 s backoff
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
    # 30s covers edge-tts cold-start latency on slower connections.
    # Retry logic lives in the callers (speak / _generate thread).
    audio_bytes = await asyncio.wait_for(_generate_tts_bytes(text), timeout=30.0)
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
    """Play an MP3 file via subprocess. MCI is never used."""
    # Try ffplay (part of ffmpeg — widely installed on dev systems)
    try:
        result = subprocess.run(
            ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", filepath],
            timeout=60
        )
        if result.returncode == 0:
            return True
    except FileNotFoundError:
        pass   # ffplay not installed — try next
    except subprocess.TimeoutExpired:
        pass
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
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-STA", "-Command", ps_script],
            timeout=120
        )
        if result.returncode == 0:
            return True
    except Exception as e:
        print(f"[TTS] PowerShell MediaPlayer error: {e}")

    return False


def _play_mp3_bytes(mp3_bytes):
    """Write MP3 bytes to a temp file and play via MCI → subprocess → return False."""
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

        # 2nd attempt: Windows MCI (built-in)
        try:
            _play_mp3_mci(tmp_path)
            return True
        except Exception as e:
            print(f"[TTS] MCI error: {e}")

        # 3rd attempt: subprocess (ffplay / PowerShell MediaPlayer)
        if _play_mp3_subprocess(tmp_path):
            return True

        return False
    except Exception as e:
        print(f"[TTS] MP3 temp write error: {e}")
        return False
    finally:
        if tmp_path:
            try:
                time.sleep(0.2)   # let MCI finish releasing the file handle
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


def _play_mp3_mci_bytes(mp3_bytes):
    """Write MP3 bytes to a temp file and play via Windows MCI."""
    tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
    tmp.write(mp3_bytes)
    tmp.close()
    try:
        _play_mp3_mci(tmp.name)
    finally:
        try:
            os.unlink(tmp.name)
        except Exception:
            pass


def _play_mp3_mci(filepath):
    """
    Play an MP3 synchronously using Windows MCI (winmm.dll).
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

def _interrupt_monitor():
    """
    Samples the microphone in 50ms chunks while AURA is speaking.
    Sets _playback_interrupt if ~200ms of sustained speech is detected
    (4 consecutive chunks above threshold × 1.5 to avoid speaker bleed).
    Runs as a daemon thread — silently exits if mic is unavailable.
    """
    samplerate     = 16000
    chunk_size     = int(samplerate * 0.05)       # 50 ms
    THRESHOLD      = int(VAD_THRESHOLD * 2.5)     # 750 RMS — well above speaker bleed-through
    TRIGGER_NEEDED = 8                             # 8 × 50ms = 400ms sustained speech
    trigger_count  = 0

    try:
        with sd.InputStream(samplerate=samplerate, channels=1,
                            dtype='int16', latency='low') as stream:
            while not _playback_interrupt.is_set():
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
        pass   # mic unavailable or device conflict — interrupt monitoring skipped silently


def _stop_all_playback():
    """Immediately halt all active audio output (sounddevice + winsound)."""
    try:
        sd.stop()
    except Exception:
        pass
    try:
        import winsound
        winsound.PlaySound(None, winsound.SND_PURGE)
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
    r'(?:user|human|you)\s*:'
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
_LEADING_LABEL_RE = re.compile(
    r'^(?:answer|response|spoken\s*response|aura\w*|assistant|ai|bot|[qa])\s*:\s*',
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

def _clean_llm_output(text):
    """
    Hard-filter prompt leakage from raw LLM output.
    Drops every line that is a prompt label or internal reasoning step.
    Strips leading Answer:/Response: prefixes.
    Returns empty string if nothing clean survives.
    """
    if not text:
        return ""
    lines  = text.splitlines()
    kept   = [l for l in lines if not _is_leak_line(l)]
    result = ' '.join(kept).strip()
    result = _LEADING_LABEL_RE.sub('', result).strip()
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
                audio_q.put(_DONE)
                return
            try:
                item = sentence_q.get(timeout=80)
            except _queue.Empty:
                print("[generate] sentence queue timeout — LLM took >80s")
                audio_q.put(_DONE)
                return
            if item is _DONE:
                audio_q.put(_DONE)
                return
            audio_bytes = None
            # Retry up to 3 times per chunk — same rationale as speak().
            # 28s timeout: edge-tts cold-start on a congested connection can be 10-15s.
            for _try in range(3):
                try:
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    try:
                        audio_bytes = loop.run_until_complete(
                            asyncio.wait_for(_generate_tts_bytes(item), timeout=28.0)
                        )
                    finally:
                        loop.close()
                        asyncio.set_event_loop(None)
                    break   # success — exit retry loop
                except asyncio.TimeoutError:
                    print(f"[generate] TTS timeout (attempt {_try+1}/3)")
                except Exception as e:
                    print(f"[generate] TTS error (attempt {_try+1}/3) [{type(e).__name__}]: {e}")
                if _try < 2:
                    time.sleep(0.8 * (_try + 1))   # 0.8 s → 1.6 s backoff
            if audio_bytes is None:
                print("[generate] All 3 TTS attempts failed — SAPI will cover this chunk")
            audio_q.put((item, audio_bytes))

    t_fill = threading.Thread(target=_fill,     daemon=True)
    t_gen  = threading.Thread(target=_generate, daemon=True)
    t_fill.start()
    t_gen.start()

    # ── Stage C: play audio as it arrives ──────────────────────────────
    global _tts_fail_count
    consecutive_fail = 0

    while True:
        try:
            item = audio_q.get(timeout=75)
        except _queue.Empty:
            print("[stream] audio queue timeout — TTS stalled")
            break

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

    # Let fill thread finish draining the HTTP connection
    t_fill.join(timeout=2.0)

    # ── Final guarantee: if nothing was spoken but LLM produced text ────
    # Speak the full collected text via SAPI — ensures response is ALWAYS audible.
    if not spoken and collected:
        full_text = " ".join(collected)
        print(f"[stream] edge-tts unavailable — speaking via SAPI: {full_text[:80]}")
        _speak_fallback(full_text)
        return full_text

    if not spoken:
        # Genuinely no LLM output at all — pipeline produced nothing
        print("[stream] LLM produced no speakable text")
        return ""

    return " ".join(spoken)


def get_answer_stream(query):
    """
    Stream the LLM answer from the backend as complete sentences.
    Passes conversation history so the LLM can handle follow-ups correctly.
    Falls back to blocking send_ask() ONLY if the stream never started
    (prevents mixing a partial stream with a full fallback response).
    """
    now          = datetime.now()
    time_context = now.strftime("Today is %A, %B %d %Y. Current time is %I:%M %p.")
    history      = list(_conversation_history)[-6:]    # last 3 Q+A pairs — keeps prompt lean on CPU

    started = False
    try:
        with requests.post(
            f"{BACKEND}/api/ai/ask-stream",
            json={"query": query, "time_context": time_context, "history": history},
            headers=auth_headers(),
            stream=True,
            timeout=60
        ) as resp:
            resp.raise_for_status()
            buffer = ""

            for raw_line in resp.iter_lines(decode_unicode=True):
                if not raw_line:
                    continue
                if not raw_line.startswith("data: "):
                    continue

                payload = raw_line[6:]

                if payload == "[DONE]":
                    remainder = _clean_llm_output(buffer.strip())
                    if remainder:
                        yield remainder
                    return

                try:
                    token = json.loads(payload)
                except (json.JSONDecodeError, ValueError):
                    token = payload

                buffer  += token
                started  = True

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
                        yield sentence

    except Exception as e:
        print(f"Stream error: {e}")
        if not started:
            # Nothing was yielded yet — safe to fall back to blocking call
            yield send_ask(query)
        # If streaming partially succeeded, do NOT add the fallback — it would
        # mix duplicate content with what was already collected.


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
# ─────────────────────────────────────────────

# Compiled once at module load — not inside detect_intent() to avoid per-call recompilation.
# Matches follow-up play commands regardless of trailing words ("play it please", "play that again").
_FOLLOWUP_RE = re.compile(
    r'\b(?:play|resume|continue|start)\s+(?:it|that|the\s+song|the\s+video|the\s+music|again|this)\b',
    re.IGNORECASE
)

_TIMER_TRIGGERS    = ("set a timer", "set timer", "start a timer", "start timer",
                      "timer for", "countdown", "count down")
_REMINDER_TRIGGERS = ("remind me", "set a reminder", "remind me to", "set reminder")
_MEMORY_TRIGGERS   = (
    "remember that", "don't forget", "keep in mind",
    "my name is", "i live in", "i work at", "i work for",
    "i am a ", "i'm a ", "i am an ", "i'm an ",
    "i study at", "i go to college", "i'm studying", "i am studying",
    "i'm from", "i am from", "i'm based in", "i am based in",
    "my favourite is", "my favorite is",
    "my birthday is", "note that", "store this", "remember this",
    "i like ", "i love ", "i enjoy ", "i prefer ",
    "i hate ", "i dislike ", "i use ", "i don't like "
)


def detect_intent(text):
    text_lower = text.lower().strip()

    if any(t in text_lower for t in _TIMER_TRIGGERS):
        return "set_timer"

    # Follow-up: "play it", "play that", "play the song" etc.
    # Uses search() (not match()) so "play it please" and "resume that" also match.
    if _FOLLOWUP_RE.search(text_lower) and _last_action_context.get("app_key"):
        return f"open_app:{_last_action_context['app_key']}:followup"

    app_key = _detect_open_app(text_lower)
    if app_key:
        return f"open_app:{app_key}"

    if any(text_lower.startswith(t) or f" {t}" in text_lower for t in _REMINDER_TRIGGERS):
        return "set_reminder"

    if any(t in text_lower for t in _MEMORY_TRIGGERS):
        return "store_memory"

    return "ask"


# ─────────────────────────────────────────────
# REMINDER PARSING
# ─────────────────────────────────────────────
def parse_reminder_time(text):
    now = datetime.now()

    # "in N minutes / hours" — relative offsets
    m = re.search(r"in (\d+)\s*minute", text, re.IGNORECASE)
    if m:
        return now + timedelta(minutes=int(m.group(1)))
    m = re.search(r"in (\d+)\s*hour", text, re.IGNORECASE)
    if m:
        return now + timedelta(hours=int(m.group(1)))

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
# LOCAL TIMER
# ─────────────────────────────────────────────
def parse_timer_duration(text):
    """Return duration in seconds, or None if not found."""
    m = re.search(r'(\d+)\s*hour', text, re.IGNORECASE)
    if m: return int(m.group(1)) * 3600
    m = re.search(r'(\d+)\s*min', text, re.IGNORECASE)
    if m: return int(m.group(1)) * 60
    m = re.search(r'(\d+)\s*sec', text, re.IGNORECASE)
    if m: return int(m.group(1))
    return None


def set_local_timer(seconds):
    """Fire-and-forget timer that speaks when done."""
    def _fire():
        mins, secs = divmod(seconds, 60)
        if mins and secs:
            label = f"{mins} minute{'s' if mins > 1 else ''} and {secs} second{'s' if secs > 1 else ''}"
        elif mins:
            label = f"{mins} minute{'s' if mins > 1 else ''}"
        else:
            label = f"{seconds} second{'s' if seconds > 1 else ''}"
        speak(f"Time's up — {label}.")
    threading.Timer(seconds, _fire).start()
    mins, secs = divmod(seconds, 60)
    if mins and secs:
        return f"Timer set for {mins} minute{'s' if mins > 1 else ''} and {secs} second{'s' if secs > 1 else ''}."
    elif mins:
        return f"Timer set for {mins} minute{'s' if mins > 1 else ''}."
    else:
        return f"Timer set for {seconds} second{'s' if seconds > 1 else ''}."


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

_OPEN_VERBS = ("open ", "launch ", "start ", "show ", "play ")

def _detect_open_app(text_lower):
    """Return app key if the utterance is an open-app command, else None."""
    if not any(text_lower.startswith(v) or f" {v}" in text_lower for v in _OPEN_VERBS):
        return None
    for app in _APP_COMMANDS:
        if app in text_lower:
            return app
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
    Handles 'play lofi on spotify', 'open spotify and play X', 'play X'.
    Returns empty string if no specific query found (caller uses generic play).
    """
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

    # "play X" as entire command (e.g. "play lofi" while spotify is implied)
    m = re.search(r'^play\s+(.+)', text_lower)
    if m:
        q = re.sub(r'\s+(?:on|in|via)\s+(?:spotify|music).*$', '', m.group(1)).strip()
        # Skip pure filler
        if q and q not in ('music', 'something', 'songs', 'a song'):
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
                # Opens Spotify at search results + keyboard automation to press play
                _spotify_open_and_play(q, delay=3.0)
                return f"Playing {q} on Spotify."
            # No specific query — open Spotify and trigger media play key
            _APP_COMMANDS[app_key]()
            if any(w in text_lower for w in ("play", "music", "song", "resume")):
                time.sleep(1.5)
                _press_media_play()
                return "Opening Spotify and playing."
            return "Opening Spotify."

        # ── YouTube ───────────────────────────────────────────────────────────
        if app_key == "youtube":
            q = _extract_search_query(text_lower)
            if q:
                # Try yt-dlp (gets direct video URL → browser auto-plays)
                if _youtube_play(q):
                    return f"Playing {q} on YouTube."
                # Fallback: open search results page
                webbrowser.open(
                    f"https://www.youtube.com/results?search_query={urllib.parse.quote_plus(q)}"
                )
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

        # ── WhatsApp ──────────────────────────────────────────────────────────
        if app_key == "whatsapp":
            _APP_COMMANDS[app_key]()
            return "Opening WhatsApp."

        # ── Maps ──────────────────────────────────────────────────────────────
        if app_key == "maps":
            q = _extract_search_query(text_lower)
            if q:
                webbrowser.open(f"https://maps.google.com/search/{urllib.parse.quote_plus(q)}")
                return f"Searching maps for {q}."
            _APP_COMMANDS[app_key]()
            return "Opening Maps."

        # ── Default ───────────────────────────────────────────────────────────
        _APP_COMMANDS[app_key]()
        label = app_key.capitalize()
        return f"Opening {label}."

    except Exception as e:
        print(f"Open app error [{app_key}]: {e}")
        return f"I couldn't open {app_key}."


# ─────────────────────────────────────────────
# BACKEND CALLS
# ─────────────────────────────────────────────
def send_ask(query):
    """Blocking LLM call — used as fallback when streaming fails."""
    try:
        now     = datetime.now()
        history = list(_conversation_history)
        resp    = requests.post(
            f"{BACKEND}/api/ai/ask",
            json={
                "query":        query,
                "time_context": now.strftime("Today is %A, %B %d %Y. Current time is %I:%M %p."),
                "history":      history,
            },
            headers=auth_headers(),
            timeout=60
        )
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
            memory_type = "schedule"
        elif any(w in c for w in ["prefer", "like", "love", "hate", "dislike",
                                   "favourite", "favorite", "always use", "i use"]):
            memory_type = "preference"
        elif any(w in c for w in ["i am", "my name", "i live", "i work",
                                   "i study", "i am a"]):
            memory_type = "identity"
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
        return f"Reminder set for {time_str}."
    except Exception as e:
        print(f"Reminder error: {e}")
        return "I couldn't set that reminder right now."


# ─────────────────────────────────────────────
# REMINDER POLLER (background daemon)
# ─────────────────────────────────────────────
def reminder_poll_loop():
    while True:
        time.sleep(POLL_INTERVAL)
        try:
            resp = requests.get(
                f"{BACKEND}/api/reminders/pending-voice",
                headers=auth_headers(),
                timeout=5
            )
            if resp.status_code != 200:
                continue
            for reminder in resp.json().get("fired", []):
                print(f"\n[Reminder] {reminder['text']}")
                speak(reminder["text"])
        except Exception:
            pass


# ─────────────────────────────────────────────
# COMMAND PROCESSOR
# ─────────────────────────────────────────────
def process_command(text):
    if not text:
        return "I didn't catch that. Could you say it again?"

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

    ensure_authenticated()
    load_models()

    # Detect whether we're running inside Electron (no interactive terminal).
    # When spawned by Electron, stdin is a pipe — isatty() returns False.
    AUTO_MODE = not sys.stdin.isatty()

    poll_thread = threading.Thread(target=reminder_poll_loop, daemon=True)
    poll_thread.start()

    # ── Pre-warm edge-tts connection ─────────────────────────────────────────
    # The first edge-tts call in a session opens a new HTTPS connection to Microsoft
    # TTS servers (DNS + TCP + TLS = ~300-800 ms, sometimes longer).  Pre-warming
    # here — before the greeting — ensures every subsequent call reuses a warm
    # connection, eliminating cold-start failures that cause SAPI fallbacks.
    print("[TTS] Warming up edge-tts connection...")
    _warm_ok = False
    try:
        _wloop = asyncio.new_event_loop()
        asyncio.set_event_loop(_wloop)
        try:
            _warm_bytes = _wloop.run_until_complete(
                asyncio.wait_for(_generate_tts_bytes("hi"), timeout=14.0)
            )
            _warm_ok = bool(_warm_bytes)
        finally:
            _wloop.close()
            asyncio.set_event_loop(None)
    except Exception as _we:
        print(f"[TTS] pre-warm error ({type(_we).__name__}): {_we}")
    print(f"[TTS] edge-tts {'ready ✓' if _warm_ok else 'unavailable — SAPI fallback active'}.")

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
            time.sleep(0.4)
            continue

        # ── Clear interrupt state for this turn ─────────────────────
        _playback_interrupt.clear()

        # ── Wait for trigger (Enter in terminal, auto-loop in Electron) ─
        if not _was_interrupted:
            if AUTO_MODE:
                time.sleep(0.3)   # brief pause between continuous listening cycles
            else:
                try:
                    input("Press Enter to speak (Ctrl+C to quit)...")
                except KeyboardInterrupt:
                    print("\nGoodbye.")
                    _push_event({"type": "voice", "state": "idle"})
                    break
                except EOFError:
                    # stdin was closed (e.g. pipe from Electron) — switch to auto mode
                    AUTO_MODE = True
                    time.sleep(0.3)
        else:
            print("(Interrupted — listening...)")
        _was_interrupted = False

        # ── Start interrupt monitor before recording ─────────────────
        # Arms the monitor early; it will fire only when RMS > threshold
        # while TTS is playing (INPUT device ≠ OUTPUT device on most systems).
        threading.Thread(target=_interrupt_monitor, daemon=True).start()

        _push_event({"type": "voice", "state": "listening"})
        record_audio()
        _push_event({"type": "voice", "state": "thinking"})
        text = transcribe_audio()

        if not text:
            print("(Nothing clear detected — try again)")
            _push_event({"type": "voice", "state": "idle"})
            speak("I didn't catch that... try again.")
            continue

        print(f"You said: {text}")
        _push_event({"type": "voice", "state": "thinking", "text": text})

        intent = detect_intent(text)

        # ── Actions — never touch LLM ────────────────────────────────
        if intent == "set_timer":
            duration = parse_timer_duration(text)
            answer   = set_local_timer(duration) if duration else \
                       "How long? Try saying 'set a timer for 5 minutes'."
            _push_event({"type": "voice", "state": "speaking", "text": answer})
            speak(answer)
            _push_event({"type": "voice", "state": "idle"})
            _conversation_history.append({"role": "user",      "content": text})
            _conversation_history.append({"role": "assistant", "content": answer})

        elif intent.startswith("open_app:"):
            parts    = intent.split(":")
            app_key  = parts[1]
            followup = len(parts) > 2 and parts[2] == "followup"

            if followup:
                # Re-use stored context — repeat the last action (e.g. "play the song" → Spotify)
                stored_q   = _last_action_context.get("query", "")
                replay_txt = f"play {stored_q} on {app_key}" if stored_q else f"play on {app_key}"
                answer     = process_open_app(app_key, replay_txt)
            else:
                answer = process_open_app(app_key, text.lower())
                # Save context for follow-up commands
                q = _extract_spotify_query(text.lower()) or _extract_search_query(text.lower())
                _last_action_context.update({"app_key": app_key, "query": q})

            # Push action event to UI before speaking
            q_push = _extract_spotify_query(text.lower()) or _extract_search_query(text.lower()) or ""
            _push_event({"type": "action", "action": "open", "app": app_key,
                         "query": q_push, "timestamp": datetime.now().isoformat()})
            _push_event({"type": "voice", "state": "speaking", "text": answer})
            speak(answer)
            _push_event({"type": "voice", "state": "idle"})
            _conversation_history.append({"role": "user",      "content": text})
            _conversation_history.append({"role": "assistant", "content": answer})

        elif intent in ("set_reminder", "store_memory"):
            answer = process_command(text)
            _push_event({"type": "voice", "state": "speaking", "text": answer})
            speak(answer)
            _push_event({"type": "voice", "state": "idle"})
            _conversation_history.append({"role": "user",      "content": text})
            _conversation_history.append({"role": "assistant", "content": answer})

        # ── LLM path — with decision engine pre-filter ───────────────
        else:
            mode = _assess_query(text)

            if mode == 'clarify':
                # Too short / ambiguous — ask for more detail without touching LLM
                answer = "I didn't quite catch that... could you be a bit more specific?"
                speak(answer)
                _conversation_history.append({"role": "user",      "content": text})
                _conversation_history.append({"role": "assistant", "content": answer})

            else:
                if mode == 'empathize':
                    # Speak immediate acknowledgment while LLM generates in background
                    speak("That sounds tough.")

                _push_event({"type": "voice", "state": "thinking", "text": text})
                try:
                    response = speak_stream(get_answer_stream(text))
                except Exception as e:
                    print(f"Pipeline error: {e}")
                    response = ""
                finally:
                    _push_event({"type": "voice", "state": "idle"})

                # Handle interrupt: skip Enter next turn
                if _playback_interrupt.is_set():
                    _stop_all_playback()
                    _was_interrupted = True

                if response and response.strip() != _last_response.strip():
                    _last_response = response
                    # Push completed response to UI chat
                    _push_event({"type": "voice", "state": "speaking", "text": response})
                    _conversation_history.append({"role": "user",      "content": text})
                    _conversation_history.append({"role": "assistant", "content": response})
