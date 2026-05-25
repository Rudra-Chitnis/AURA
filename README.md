<div align="center">

# 🔮 AURA
### Adaptive User Response Assistant

*A local, voice-first AI desktop assistant that listens, remembers, and talks back — running entirely on your machine.*

<br/>

![Python](https://img.shields.io/badge/Python-3.10–3.12-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Electron](https://img.shields.io/badge/Electron-28-47848F?style=for-the-badge&logo=electron&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Local-47A248?style=for-the-badge&logo=mongodb&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-Mistral_7B-black?style=for-the-badge&logo=ollama&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D4?style=for-the-badge&logo=windows&logoColor=white)
![Status](https://img.shields.io/badge/Status-Active_Development-brightgreen?style=for-the-badge)

<br/>

> 🚫 No cloud APIs. &nbsp;🔒 No subscriptions. &nbsp;💻 Everything runs locally on your machine.

</div>

---

## 📋 Table of Contents

- [What is AURA?](#-what-is-aura)
- [What AURA Can Do](#-what-aura-can-do)
- [Architecture Overview](#️-architecture-overview)
- [Voice Pipeline](#️-voice-pipeline)
- [Memory System](#-memory-system)
- [Timer & Reminder System](#️-timer--reminder-system)
- [Query Classifier](#-query-classifier)
- [Action System](#-action-system)
- [Tech Stack](#️-tech-stack)
- [Project Structure](#-project-structure)
- [Installation & Setup](#-installation--setup)
- [Desktop App Overview](#️-desktop-app-overview)
- [Sleep / Wake](#-sleep--wake)
- [API Reference](#-api-reference)
- [Troubleshooting](#-troubleshooting)
- [Known Limitations](#️-known-limitations)
- [Current Development Focus](#️-current-development-focus)
- [Roadmap](#️-roadmap)
- [Authors](#-authors)
- [License](#-license)

---

## 🧠 What is AURA?

AURA is a **personal AI voice assistant** you talk to through your microphone. It understands you, remembers things about you, answers questions, sets timers and reminders, opens apps, plays music, and speaks back in a natural neural voice — like a local, privacy-first Jarvis.

AURA runs as a native **Electron desktop application** on Windows. There is no web dashboard, no terminal interaction, and no manual process management. Everything — the backend, voice pipeline, timers, and reminders — is orchestrated automatically by the desktop app the moment you launch it.

---

## ✨ What AURA Can Do

| 🎤 You say | 🔮 AURA does |
|---|---|
| *"Who am I?"* | Pulls your identity from persistent memory and answers |
| *"What do I like to eat?"* | Retrieves your food preferences stored in MongoDB |
| *"Remember that I'm studying CS at VIT"* | Stores it as a memory with vector embeddings |
| *"Who is the Prime Minister of India?"* | Answers from Mistral's general knowledge |
| *"Set a timer for 10 minutes"* | Creates a live desktop countdown — Electron-native, survives restarts |
| *"Remind me to study at 9 PM"* | Schedules a desktop notification + spoken reminder |
| *"Play lofi on Spotify"* | Opens Spotify and navigates to the first result |
| *"Play Blinding Lights on YouTube"* | Fetches the direct watch URL and auto-plays in browser |
| *"Open WhatsApp"* | Launches the WhatsApp desktop app |
| *"Goodbye / Go to sleep"* | AURA stops listening and enters sleep mode |
| *"Wake up"* (or button press) | AURA resumes from sleep |
| *"Who created you?"* | *"You did."* |

---

## 🏗️ Architecture Overview

AURA is built on four layers with clear ownership boundaries:

```
┌─────────────────────────────────────────────────────────┐
│  Electron Desktop App  (main.js)                        │
│                                                         │
│  • Orchestrates the full runtime lifecycle              │
│  • Spawns + supervises backend (Node) + voice (Python)  │
│  • Owns timers  — Electron TimerManager (JSON-backed)   │
│  • Owns reminders — Electron ReminderManager            │
│  • Owns startup splash screen + phase progression       │
│  • IPC bridge between main process ↔ React renderer    │
└────────────────┬────────────────────────────────────────┘
                 │ spawns + supervises
    ┌────────────┴────────────────────────┐
    │                                     │
    ▼                                     ▼
┌──────────────────────┐    ┌─────────────────────────────┐
│  voice.py  (Python)  │    │  server.js  (Node/Express)  │
│                      │    │                             │
│  • VAD recording     │    │  • REST API  (:5000)        │
│  • Faster-Whisper    │    │  • WebSocket hub (:5001)    │
│  • Intent routing    │    │  • MongoDB memory           │
│  • Action execution  │    │  • JWT authentication       │
│  • edge-tts / SAPI   │    │  • Embedding service        │
│  • Signals Electron  │    │  • Ollama LLM routing       │
│    via stdout IPC    │    │  • Reminder history (DB)    │
│  • Receives PAUSE /  │    │                             │
│    RESUME / WAKE /   │    │                             │
│    SPEAK via stdin   │    │                             │
└──────────────────────┘    └─────────────────────────────┘
```

### State Flow

```
IDLE → LISTENING → TRANSCRIBING → THINKING → SPEAKING → IDLE
```

Only ONE subsystem owns audio playback at a time. The Electron process is the authoritative runtime supervisor — it is the source of truth for process state, timer state, and reminder state.

---

## 🎙️ Voice Pipeline

```
🎤  VAD-based recording — 100ms chunks, stops after 1.8s silence
         ↓
🔵  _normalize_transcript()  — strips leading filler words + Whisper punctuation
         ↓
🔍  _resolve_references()    — "play it again" → concrete entity
         ↓
📡  detect_intent()          — primarily regex-based routing with lightweight conversational normalization
         ↓
   ┌──────────────────────────────────────────────────────────────┐
   │  set_timer      → stdout AURA:SET_TIMER:secs:label          │
   │  set_reminder   → stdout AURA:SET_REMINDER:text:isoTime     │
   │  store_memory   → POST /api/memory                          │
   │  open_app       → local OS action (Spotify/YouTube/etc.)    │
   │  ask            → GET  /api/ai/ask-stream (SSE streaming)   │
   └──────────────────────────────────────────────────────────────┘
         ↓
🧮  Embedding + cosine memory search (for LLM queries)
         ↓
🤖  Mistral / TinyLlama streams tokens via Ollama
         ↓
🔊  edge-tts generates audio per sentence  →  sounddevice plays
         ↓
🔉  SAPI fallback (PowerShell) if edge-tts fails
```

**Perceived latency:** ~2–4 seconds from end of speech to first audio. AURA starts speaking the first sentence while generating the rest.

---

## 🧩 Memory System

AURA uses a lightweight **Retrieval Augmented Generation** memory system:

- When you share a fact, AURA generates a **384-dimension vector embedding** using `all-MiniLM-L6-v2` running locally via `@xenova/transformers`
- Embeddings and raw text are stored in **MongoDB**
- On every query, AURA embeds the question and runs **cosine similarity** against stored memories
- Memories are filtered using cosine similarity and query classification before prompt injection
- Broad queries like *"what do you know about me?"* take a fast path returning all memories sorted by confidence and recency

**Memory types:** `personal` · `schedule` · `preference` · `identity`

---

## ⏱️ Timer & Reminder System

Timers and reminders are **Electron-native** — owned entirely by the desktop runtime, not by the voice pipeline or backend server.

| Property | Timer | Reminder |
|---|---|---|
| Persistence | `%APPDATA%\AURA\timers.json` | `%APPDATA%\AURA\reminders.json` |
| Scheduling | `setTimeout` in Electron main | `setTimeout` in Electron main |
| Survives backend restart | ✅ | ✅ |
| Survives voice restart | ✅ | ✅ |
| On fire | OS notification + AURA speaks | OS notification + AURA speaks |
| UI | Live MM:SS countdown chip | Time-until chip |
| Startup recovery | Expired timers fire with 1.5s delay | 30-min missed-window recovery |

The voice pipeline signals Electron via stdout: `AURA:SET_TIMER:30:30 seconds`. Electron's TimerManager takes ownership from that point.

---

## 🤖 Query Classifier

Before calling the LLM, the backend classifies queries (zero latency) and routes accordingly:

| Type | Example | Behaviour |
|---|---|---|
| `personal` | *"Where do I live?"* | Prioritizes retrieved personal memories and avoids unsupported claims where possible |
| `general` | *"Who is Elon Musk?"* | Mistral training knowledge |
| `opinion` | *"Should I use React or Vue?"* | Measured perspective + personal context |
| `mixed` | *"What's a good laptop for me?"* | Memory for personal part, knowledge for the rest |
| `action` | *"Set a timer for 10 minutes"* | Confirm in one sentence |

Heavy queries route to **Mistral 7B**. Lightweight queries use **TinyLlama** for lower latency.

---

## 🎵 Action System

| Command | What happens |
|---|---|
| *"Play X on Spotify"* | Opens `spotify:search:X` URI → keyboard automation selects first track |
| *"Play X on YouTube"* | `yt-dlp` fetches the direct `/watch` URL → browser auto-plays |
| *"Open WhatsApp"* | Launches via `whatsapp:` URI or falls back to `web.whatsapp.com` |
| *"Open Maps"* | Opens Google Maps in browser |
| *"Open Settings"* | Opens Windows Settings |
| *"Play it again"* | Re-runs your last app action (entity context memory) |

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 28 — orchestrates all processes, owns timers/reminders |
| UI renderer | React 18 + Vite + Tailwind CSS — animated orb, transcript display |
| Voice capture | `sounddevice` — VAD-based, stops on 1.8s silence |
| Speech to text | `faster-whisper` — `small` model, CPU, int8, `vad_filter=True` |
| Text to speech | `edge-tts` — Microsoft `en-US-AriaNeural`; SAPI fallback |
| Audio playback | `sounddevice` (WAV/24kHz) → PowerShell SAPI fallback |
| Intent detection | Regex-based routing — zero latency, module-level compiled patterns |
| Backend server | Node.js + Express 5 (REST + SSE streaming) |
| WebSocket hub | `ws` — real-time state push to renderer |
| Authentication | JWT + bcryptjs — token persisted in `%APPDATA%\AURA\` via Electron |
| Database | MongoDB + Mongoose (local) |
| Embeddings | `@xenova/transformers` — `all-MiniLM-L6-v2`, pre-warmed at startup |
| Vector search | Custom cosine similarity |
| LLM | Mistral 7B (personal/mixed) + TinyLlama (general/action) via Ollama |
| LLM transport | SSE streaming → sentence-level TTS overlap |

---

## 📁 Project Structure

```
AURA/
├── backend/                         ← Node.js + Express API server
│   ├── config/
│   │   └── mongo.js                 # MongoDB connection + reconnect
│   ├── middleware/
│   │   ├── authMiddleware.js        # JWT verification
│   │   └── errorHandler.js         # Global error handler
│   ├── models/
│   │   ├── userModel.js
│   │   ├── memoryModel.js           # Memory + vector embeddings
│   │   ├── reminderModel.js         # Reminder history (DB)
│   │   └── logModel.js
│   ├── routes/
│   │   ├── authRoute.js             # POST /register, /login, GET /profile
│   │   ├── aiRoute.js               # POST /ask, GET /ask-stream (SSE)
│   │   ├── memoryRoute.js           # Memory CRUD
│   │   ├── reminderRoute.js         # Reminder CRUD (history only)
│   │   └── logRoute.js
│   ├── services/
│   │   ├── aiService.js             # Query classifier + prompt builder + Ollama
│   │   ├── memoryService.js         # RAG search + ABOUT_ME fast path
│   │   ├── embeddingService.js      # MiniLM-L6-v2 embeddings (pre-warmed)
│   │   ├── reminderService.js       # Reminder DB operations
│   │   ├── reminderScheduler.js     # Background poll (legacy, Electron now owns delivery)
│   │   └── logService.js
│   ├── utils/
│   │   ├── similarity.js            # Cosine similarity
│   │   └── token.js                 # JWT generation
│   ├── server.js                    # Express entry point (:5000) + wsHub (:5001)
│   ├── .env                         # Local config — NOT committed
│   └── .env.example                 # Template — safe to commit
│
├── desktop/                         ← Electron desktop app
│   ├── src/
│   │   ├── App.jsx                  # Root component — auth gate, startup, IPC listeners
│   │   ├── components/
│   │   │   ├── OrbCore.jsx          # Animated orb — state-responsive visual
│   │   │   ├── VoiceDisplay.jsx     # Orb + live transcript + ghost last-turn + mic controls
│   │   │   ├── CompactBar.jsx       # Bottom bar — typed input + drawer triggers
│   │   │   ├── CountdownPanel.jsx   # Live timer/reminder chip strip
│   │   │   ├── DrawerPanel.jsx      # Slide-out panel — chat, memory, reminders, settings
│   │   │   ├── TitleBar.jsx         # Custom title bar — drag region + window controls
│   │   │   ├── SplashScreen.jsx     # Startup splash — phase-driven loading UI
│   │   │   ├── ToastStack.jsx       # In-app toast notifications
│   │   │   └── ...                  # ChatPanel, MemoryPanel, RemindersPanel, SettingsPanel
│   │   ├── hooks/
│   │   │   └── useWebSocket.js      # WebSocket client — maps server events to store
│   │   ├── lib/
│   │   │   └── api.js               # Fetch wrapper with auth token injection
│   │   └── store/
│   │       └── useStore.js          # Zustand global state
│   ├── main.js                      # Electron main process — process orchestration
│   ├── preload.js                   # Context bridge — IPC channels exposed to renderer
│   ├── timerManager.js              # Electron-native timer system (JSON persistence)
│   ├── reminderManager.js           # Electron-native reminder system (JSON persistence)
│   ├── vite.config.js
│   └── package.json
│
├── voice/
│   ├── voice.py                     # Voice pipeline — STT, TTS, intent, actions, memory
│   └── requirements.txt             # Python dependencies
│
├── start.bat                        ← PRIMARY launcher — checks deps, builds if needed, starts AURA
├── start-dev.bat                    ← Dev launcher — hot reload (Vite + Electron dev mode)
├── create-shortcut.bat              ← One-time setup — builds frontend + creates Desktop shortcut
├── AURA.vbs                         ← Silent launcher — no terminal window (used by shortcut)
├── generate-icon.py                 ← Icon generator — creates .ico files (stdlib only)
├── .env.example                     ← (see backend/.env.example)
├── .gitignore
├── memory.md                        ← Engineering reference (session-persistent architecture notes)
└── README.md
```

---

## 🚀 Installation & Setup

### Prerequisites

Before cloning, install these system dependencies:

| Dependency | Version | Notes |
|---|---|---|
| [Python](https://python.org/downloads/) | **3.10 – 3.12** | ⚠️ 3.13+ NOT supported — `ctranslate2` has no wheels yet |
| [Node.js](https://nodejs.org) | 18+ | Includes npm |
| [MongoDB](https://www.mongodb.com/try/download/community) | 6+ | Community Edition — run `mongod` locally |
| [Ollama](https://ollama.com) | latest | Local LLM runtime |

> **Python 3.13+ warning:** `faster-whisper` depends on `ctranslate2`, which requires compiled C extensions. Binary wheels are not yet published for Python 3.13. Use Python 3.11 or 3.12.

---

### 1. Clone the repo

```bash
git clone https://github.com/Rudra-Chitnis/AURA.git
cd AURA
```

---

### 2. Pull the LLMs

```bash
ollama pull mistral        # Main model — ~4 GB — for personal/memory-heavy queries
ollama pull tinyllama      # Fast model — ~600 MB — for general/action queries
```

> 💡 On machines with less than 8 GB RAM, set both models to `tinyllama` in `backend/.env`.

---

### 3. Configure the backend environment

```bash
cd backend
copy .env.example .env
```

Edit `backend/.env` and replace the JWT secret with a real random value:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/aura
JWT_SECRET=<replace with output of command below>
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=mistral
OLLAMA_MODEL_FAST=tinyllama
```

Generate a secure JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

### 4. First-time setup (builds frontend + creates Desktop shortcut)

Run this **once** from the project root:

```bat
create-shortcut.bat
```

This will:
- Install backend npm dependencies
- Install desktop npm dependencies
- Build the Vite frontend (`desktop/dist/`)
- Generate app icons
- Create an **AURA** shortcut on your Windows Desktop

> Run `create-shortcut.bat` again after pulling updates to rebuild the frontend.

---

### 5. Launch AURA

**From the Desktop shortcut** (recommended after first-time setup):

Double-click **AURA** on your Desktop.

**From the project root:**

```bat
start.bat
```

`start.bat` performs pre-flight checks (Node, Python, Ollama), installs any missing dependencies, and launches the Electron app silently via `AURA.vbs`.

Everything else — the backend server, Ollama health check, and voice pipeline — starts automatically inside the app with a real-time splash screen showing each startup phase.

---

### 6. Register your account

On first launch, AURA shows a login/register screen inside the app. Create an account — credentials are stored locally in MongoDB.

---

### Dev mode (hot reload)

For development with Vite hot reload:

```bat
start-dev.bat
```

This opens three terminals: backend (nodemon), Vite dev server, and Electron (which waits for Vite to be ready).

---

## 🖥️ Desktop App Overview

The AURA window is a compact floating widget designed to stay out of your way.

```
┌─────────────────────────────────┐
│ ● ─ □ ×          AURA    [≡]   │  ← Custom title bar (draggable)
├─────────────────────────────────┤
│                                 │
│          ╭───────╮              │  ← Animated orb (state-responsive)
│          │  🔮   │              │
│          ╰───────╯              │
│                                 │
│   "set a timer for 30 seconds"  │  ← Live transcript (during turn)
│   You: set a timer...           │  ← Last-turn ghost (15s after idle)
│   AURA: Timer set for 30s.      │
│                                 │
├──── 🕐 30s timer  00:28  ✕ ─────┤  ← CountdownPanel (timers/reminders)
├─────────────────────────────────┤
│ ⏸ Pause   ● Mic on              │  ← Mic controls
│ [Ask AURA anything...]  ⌨  📋  │  ← Typed input + drawer triggers
└─────────────────────────────────┘
```

**Orb states:** Idle (blue) → Listening (green pulse) → Thinking (purple pulse) → Speaking (blue pulse) → Sleeping (dim grey)

**Mic controls:** Pause/Resume listening without stopping the process. Wake button replaces these when AURA is sleeping.

**CountdownPanel:** Appears automatically when timers or reminders are active. Each chip shows a live countdown. Click ✕ to cancel.

**Drawer (≡):** Chat history, Memory viewer, Reminders list, Settings.

---

## 🌙 Sleep / Wake

Say **"goodbye"**, **"go to sleep"**, or **"goodnight"** to put AURA into sleep mode. The orb dims and mic stops listening. Voice pipeline stays running — no restart overhead.

Wake by:
- Saying **"wake up"**
- Clicking the **Wake up** button in the UI

---

## 📡 API Reference

<details>
<summary><b>Auth Routes</b></summary>

```
POST /api/auth/register       { name, email, password }
POST /api/auth/login          { email, password }  →  { token }
GET  /api/auth/profile        Authorization: Bearer <token>  →  { user }
```

</details>

<details>
<summary><b>AI Routes</b></summary>

```
POST /api/ai/ask              { query, time_context? }  →  { answer, memories }
GET  /api/ai/ask-stream       ?query=...&token=...       →  SSE token stream
```

</details>

<details>
<summary><b>Memory Routes</b></summary>

```
POST /api/memory/store        { content, type }
GET  /api/memory/list         →  { memories }
POST /api/memory/search       { query }  →  { results }
```

</details>

<details>
<summary><b>Reminder Routes (history)</b></summary>

```
POST   /api/reminders                   { text, reminderTime }
GET    /api/reminders                   →  { reminders }
DELETE /api/reminders/:id
GET    /api/reminders/pending-voice     →  { fired }
```

Note: Active reminder scheduling is now owned by Electron (ReminderManager). The backend API stores reminder history.

</details>

---

## 🔧 Troubleshooting

### Backend offline banner appears

- Make sure MongoDB is running: `mongod`
- Check `backend/.env` has correct `MONGO_URI`
- The Electron app retries the backend health check every 12 seconds automatically

### "Voice pipeline stopped" toast

- Check Python 3.10–3.12 is installed: `python --version`
- Run `pip install -r voice/requirements.txt` manually
- Check `%APPDATA%\AURA\logs\` for the crash reason

### edge-tts fails / AURA speaks in a robotic voice

- `edge-tts` requires an active internet connection to the Microsoft TTS API
- AURA automatically falls back to Windows SAPI (via PowerShell) when edge-tts is unavailable
- If SAPI also fails: check Windows audio devices in Settings → Sound

### ctranslate2 / faster-whisper install fails

- You are likely on Python 3.13+. Downgrade to Python 3.11 or 3.12.
- Wheels: https://github.com/OpenNMT/CTranslate2/releases

### Ollama not found

- Install from https://ollama.com
- Run `ollama serve` once — `start.bat` auto-starts it on subsequent launches
- Run `ollama pull mistral` and `ollama pull tinyllama`

### Timer / reminder countdown never appears

- The CountdownPanel requires the voice pipeline to be running
- Say "set a timer for 30 seconds" clearly — avoid filler words if possible
- Check Electron logs: open DevTools (right-click titlebar → Inspect) → Console

### First run is slow

- The Whisper `small` model downloads (~250 MB) to `~/.cache/huggingface/` on first use
- The MiniLM embedding model also downloads on first backend start
- Both are cached after first run — subsequent starts are fast

---

## ⚠️ Known Limitations

- `edge-tts` requires internet — offline fallback is Windows SAPI (robotic voice)
- Tested on **Windows only** — Linux/macOS are unsupported (Electron + SAPI + path assumptions)
- Spotify automation uses keyboard simulation — may mis-navigate if Spotify UI changes layout
- `yt-dlp` must be installed separately for YouTube direct-play: `pip install yt-dlp`
- Python **3.13+** is not supported (no `ctranslate2` wheels)
- No wake-word detection — AURA listens only while the voice pipeline is active (not always-on)
- Timer/reminder state lives in `%APPDATA%\AURA\` — backing up this folder preserves them

---

---

## ⚠️ Current Development Focus

AURA is currently undergoing a stabilization pass focused on conversational consistency, context hygiene, and long-session reliability.

Active areas of work include:

- Preventing malformed assistant responses from contaminating rolling conversation history
- Improving personal vs general conversational query classification
- Separating conversational context between personal and general response modes
- Preventing stale-topic continuation after malformed generations
- Improving retry isolation and stream reset behavior
- Strengthening assistant-response sanitization before history insertion
- Reducing recursive context poisoning in long conversations

The current runtime architecture — including Electron orchestration, Python-owned action routing, STT/TTS, authentication, timers/reminders, and memory retrieval — is stable and operational.

Most remaining instability is isolated to the conversational generation pipeline, primarily within:

```text
backend/services/aiService.js
```

---

## 🗺️ Roadmap

**Completed:**
- [x] VAD-based recording — stops on silence
- [x] Faster-Whisper STT (small, int8, CPU)
- [x] Neural TTS — Microsoft AriaNeural via edge-tts
- [x] Sentence-level streaming TTS pipeline (~2–4s latency)
- [x] RAG-lite memory with local vector embeddings
- [x] JWT authentication with Electron token persistence
- [x] Electron desktop app — animated orb UI, system tray, startup splash
- [x] Pause / Resume mic from UI
- [x] Clean shutdown vs hide-to-tray
- [x] Electron-native timer system — persistent, live countdown UI
- [x] Electron-native reminder system — persistent, missed-window recovery
- [x] Session sleep / wake lifecycle
- [x] Persistent last-turn transcript display
- [x] Query classifier (personal / general / opinion / action / mixed)
- [x] App action system (Spotify, YouTube, WhatsApp, Maps, Settings)
- [x] Follow-up command memory ("play it again")
- [x] Background process management — no visible terminal windows

**Planned:**
- [ ] Wake word detection — always listening for "Hey AURA"
- [ ] Full vector database (FAISS / Chroma) for large memory sets
- [ ] Packaged Windows installer (.exe via electron-builder)
- [ ] React Native mobile companion
- [ ] Multi-device sync

---

## 👥 Authors

<div align="center">

**Rudra Chitnis** &nbsp;·&nbsp; **Sadgi Garg**

Built AURA as a project exploring voice AI, local LLMs, streaming pipelines, and desktop-native automation.

[![GitHub](https://img.shields.io/badge/GitHub-Rudra--Chitnis-181717?style=for-the-badge&logo=github)](https://github.com/Rudra-Chitnis)
[![GitHub](https://img.shields.io/badge/GitHub-Sadgi--Garg-181717?style=for-the-badge&logo=github)](https://github.com/Sadgi-Garg)

</div>

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.

---

<div align="center">

⭐ **If you found this interesting, give it a star!** ⭐

*Made with 🔮 by Rudra Chitnis & Sadgi Garg*

</div>
