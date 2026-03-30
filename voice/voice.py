import os
import re
import time
import threading
import requests
import sounddevice as sd
import numpy as np
import scipy.io.wavfile as wav
import pyttsx3
from faster_whisper import WhisperModel
from datetime import datetime, timedelta

# ─────────────────────────────────────────────
# CONFIG
# ─────────────────────────────────────────────
BACKEND = "http://localhost:5000"
TOKEN_FILE = os.path.expanduser("~/.aura_token")
POLL_INTERVAL = 30

# Global token — set ONCE at startup, never touched again during voice loop
_token = None


# ─────────────────────────────────────────────
# TOKEN MANAGEMENT
# ─────────────────────────────────────────────
def save_token(token):
    with open(TOKEN_FILE, "w") as f:
        f.write(token)


def load_token():
    if os.path.exists(TOKEN_FILE):
        tok = open(TOKEN_FILE).read().strip()
        return tok if tok else None
    return None


def do_login():
    """Prompt for credentials in terminal and return JWT. Only called at startup."""
    print("\n--- AURA Login ---")
    email = input("Email: ").strip()
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
    Called ONCE at startup before models load or threads start.
    Checks saved token, verifies it, prompts login if needed.
    Sets global _token — auth_headers() never prompts after this.
    """
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

    # No valid token — prompt NOW before anything else
    _token = do_login()


def auth_headers():
    """Returns auth header using global token. NEVER prompts for login."""
    return {"Authorization": f"Bearer {_token}"}


# ─────────────────────────────────────────────
# MODELS
# ─────────────────────────────────────────────
whisper_model = None
tts_engine = None


def load_models():
    global whisper_model
    print("Loading Whisper model (this may take a moment)...")
    whisper_model = WhisperModel("medium", device="cpu", compute_type="int8")
    print("Models ready.\n")


# ─────────────────────────────────────────────
# AUDIO
# ─────────────────────────────────────────────
def record_audio(duration=7, filename="input.wav"):
    print("Listening...")
    samplerate = 16000
    audio = sd.rec(
        int(duration * samplerate),
        samplerate=samplerate,
        channels=1,
        dtype="int16"
    )
    sd.wait()
    wav.write(filename, samplerate, audio)
    print("Recording done.")


def transcribe_audio(filename="input.wav"):
    print("Transcribing...")
    segments, _ = whisper_model.transcribe(filename, language="en")
    text = " ".join(seg.text for seg in segments)
    return text.strip().lower()


# ─────────────────────────────────────────────
# TTS
# ─────────────────────────────────────────────
def speak(text):
    print(f"AURA: {text}")
    try:
        engine = pyttsx3.init()
        engine.setProperty('rate', 175)
        engine.setProperty('volume', 1.0)
        engine.say(text)
        engine.runAndWait()
        engine.stop()
    except Exception as e:
        print(f"TTS error: {e}")
        # Fallback to PowerShell TTS if pyttsx3 fails
        try:
            import subprocess
            clean = text.replace('"', '').replace("'", "")
            subprocess.run([
                "powershell", "-Command",
                f'Add-Type -AssemblyName System.Speech; '
                f'$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; '
                f'$s.Speak("{clean}")'
            ], timeout=15)
        except Exception as e2:
            print(f"Fallback TTS error: {e2}")


# ─────────────────────────────────────────────
# INTENT DETECTION
# ─────────────────────────────────────────────
def detect_intent(text):
    reminder_triggers = ["remind me", "set a reminder", "remind me to", "set reminder"]

    # These must appear at the START or be clearly a storage command
    memory_triggers = [
        "remember that", "don't forget", "keep in mind",
        "my name is", "i live in", "i work at",
        "i am a ", "i study at", "i go to college",
        "my favourite is", "my favorite is",
        "my birthday is", "note that", "store this",
        "remember this"
    ]

    text_lower = text.lower().strip()

    # Check reminders first
    if any(text_lower.startswith(t) or f" {t}" in text_lower for t in reminder_triggers):
        return "set_reminder"

    # Memory triggers must match more strictly — full phrase, not partial word
    if any(t in text_lower for t in memory_triggers):
        return "store_memory"

    return "ask"

# ─────────────────────────────────────────────
# REMINDER PARSING
# ─────────────────────────────────────────────
def parse_reminder_time(text):
    now = datetime.now()

    m = re.search(r"in (\d+) minute", text)
    if m:
        return now + timedelta(minutes=int(m.group(1)))

    m = re.search(r"in (\d+) hour", text)
    if m:
        return now + timedelta(hours=int(m.group(1)))

    m = re.search(r"at (\d{1,2}):(\d{2})", text)
    if m:
        dt = now.replace(hour=int(m.group(1)), minute=int(m.group(2)), second=0, microsecond=0)
        return dt if dt > now else dt + timedelta(days=1)

    m = re.search(r"at (\d{1,2})\s*(am|pm)", text)
    if m:
        hour = int(m.group(1))
        if m.group(2) == "pm" and hour != 12:
            hour += 12
        elif m.group(2) == "am" and hour == 12:
            hour = 0
        dt = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        return dt if dt > now else dt + timedelta(days=1)

    m = re.search(r"at (\d{1,2})(?!\d|:)", text)
    if m:
        hour = int(m.group(1))
        if hour < 7:
            hour += 12  # assume PM for small numbers
        dt = now.replace(hour=hour, minute=0, second=0, microsecond=0)
        return dt if dt > now else dt + timedelta(days=1)

    return None


def parse_reminder_text(text):
    m = re.search(r"remind me to (.+?)(?:\s+at\s+|\s+in\s+)", text)
    if m:
        return m.group(1).strip()
    m = re.search(r"remind me to (.+)", text)
    if m:
        return m.group(1).strip()
    m = re.search(r"remind me (.+?)(?:\s+at\s+|\s+in\s+)", text)
    if m:
        return m.group(1).strip()
    m = re.search(r"remind me (.+)", text)
    if m:
        return m.group(1).strip()
    return text


# ─────────────────────────────────────────────
# BACKEND CALLS
# ─────────────────────────────────────────────
def send_ask(query):
    try:
        now = datetime.now()
        time_context = now.strftime("Today is %A, %B %d %Y. Current time is %I:%M %p.")

        # Send time as separate field, not glued to the user's query
        resp = requests.post(
            f"{BACKEND}/api/ai/ask",
            json={
                "query": query,
                "time_context": time_context
            },
            headers=auth_headers(),
            timeout=30
        )
        resp.raise_for_status()
        return resp.json().get("answer", "No answer received.")
    except requests.exceptions.ConnectionError:
        return "I can't reach the backend. Is the server running?"
    except Exception as e:
        print(f"Ask error: {e}")
        return "Something went wrong. Please try again."


def send_store_memory(content, memory_type=None):
    # Auto-detect type from content if not specified
    if memory_type is None:
        c = content.lower()
        if any(w in c for w in ["meeting", "class", "gym", "deadline", "schedule", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "am", "pm", "today", "tomorrow"]):
            memory_type = "schedule"
        elif any(w in c for w in ["prefer", "like", "love", "hate", "dislike", "favourite", "favorite", "always use", "i use"]):
            memory_type = "preference"
        elif any(w in c for w in ["i am", "my name", "i live", "i work", "i study", "i am a"]):
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
        return f"Got it, I'll remember that."
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
# REMINDER POLLER (background thread)
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
            fired = resp.json().get("fired", [])
            for reminder in fired:
                print(f"\n[Reminder] {reminder['text']}")
                speak(reminder["text"])
        except Exception:
            pass  # never crash the background thread


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
        else:
            return "I couldn't figure out the time. Try saying 'at 7pm' or 'in 10 minutes'."

    elif intent == "store_memory":
        # Strip trigger words so only the actual fact gets stored
        clean = text
        for trigger in ["remember that", "don't forget that", "don't forget", 
                        "keep in mind that", "keep in mind", "note that",
                        "store this", "remember"]:
            clean = clean.replace(trigger, "").strip()
        
        # Remove leading punctuation/spaces
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

    # 1. Authenticate FIRST — before models, before threads, before everything
    #    This is the ONLY place login prompts appear. Never during voice loop.
    ensure_authenticated()

    # 2. Load Whisper + TTS after auth is confirmed
    load_models()

    # 3. Start reminder poller in background
    poll_thread = threading.Thread(target=reminder_poll_loop, daemon=True)
    poll_thread.start()

    print("AURA is ready. Say anything after pressing Enter.\n")

    # 4. Main voice loop — no auth prompts can appear here
    while True:
        try:
            input("Press Enter to speak (Ctrl+C to quit)...")
        except KeyboardInterrupt:
            print("\nGoodbye.")
            break

        record_audio(7)
        text = transcribe_audio()
        print(f"You said: {text}")

        if not text:
            print("(Nothing detected — try again)")
            continue

        answer = process_command(text)
        speak(answer)