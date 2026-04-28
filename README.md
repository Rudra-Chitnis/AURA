<div align="center">

# 🔮 AURA
### Adaptive User Response Assistant

*A voice-driven ambient AI assistant that listens, remembers, and talks back — running fully on your machine.*

<br/>

![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![MongoDB](https://img.shields.io/badge/MongoDB-Local-47A248?style=for-the-badge&logo=mongodb&logoColor=white)
![Ollama](https://img.shields.io/badge/Ollama-Mistral_7B-black?style=for-the-badge&logo=ollama&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)
![Status](https://img.shields.io/badge/Status-Active_Development-brightgreen?style=for-the-badge)

<br/>

> 🚫 No cloud APIs. &nbsp;🔒 No subscriptions. &nbsp;💻 Everything runs locally on your machine.

</div>

---

## 🧠 What is AURA?

AURA is a **personal AI voice assistant** you talk to through your microphone. It understands you, remembers things about you, answers questions, sets reminders, opens apps, plays music, and speaks back in a natural neural voice — like a local, privacy-first Jarvis.

Instead of a chat interface, AURA is designed as a **background assistant** — press Enter, speak, and it responds out loud. No wake word required, no data sent to the cloud.

---

## ✨ What AURA Can Do

| 🎤 You say | 🔮 AURA does |
|---|---|
| *"Who am I?"* | Pulls your identity from memory and answers |
| *"What do I like to eat?"* | Retrieves your food preferences from memory |
| *"Remember that I'm studying CS at VIT"* | Stores it as a memory with vector embeddings |
| *"Who is the Prime Minister of India?"* | Answers from Mistral's general knowledge |
| *"Remind me to study at 9 PM"* | Parses the time, stores a reminder, speaks it aloud at 9 PM |
| *"Play lofi on Spotify"* | Opens Spotify and navigates to the first result |
| *"Play Blinding Lights on YouTube"* | Fetches the direct watch URL and auto-plays in browser |
| *"Open WhatsApp"* | Launches the WhatsApp desktop app |
| *"Play it again"* | Remembers your last app action and repeats it |
| *"Who created you?"* | *"You did."* |

---

## 🏗️ Project Structure

```
aura/
├── 📁 backend/
│   ├── 📁 config/
│   │   └── mongo.js                # MongoDB connection + reconnect handling
│   ├── 📁 middleware/
│   │   ├── authMiddleware.js        # JWT verification
│   │   └── errorHandler.js         # Global error handler
│   ├── 📁 models/
│   │   ├── userModel.js             # User schema
│   │   ├── memoryModel.js           # Memory + vector embeddings
│   │   ├── reminderModel.js         # Reminder schema
│   │   └── logModel.js              # Activity logs
│   ├── 📁 routes/
│   │   ├── authRoute.js             # Register / Login / Profile
│   │   ├── aiRoute.js               # POST /api/ai/ask  +  GET /api/ai/ask-stream
│   │   ├── memoryRoute.js           # Store / List / Search memories
│   │   ├── reminderRoute.js         # Create / List / Cancel / Pending-voice
│   │   └── logRoute.js              # Activity logs
│   ├── 📁 services/
│   │   ├── aiService.js             # Query classifier + prompt builder + Ollama calls
│   │   ├── authService.js           # Auth logic
│   │   ├── memoryService.js         # RAG search + isWorthStoring + ABOUT_ME fast path
│   │   ├── embeddingService.js      # MiniLM-L6-v2 local embeddings (pre-warmed)
│   │   ├── reminderService.js       # Reminder CRUD
│   │   ├── reminderScheduler.js     # Background scheduler (30s poll)
│   │   └── logService.js            # Log creation
│   ├── 📁 utils/
│   │   ├── similarity.js            # Cosine similarity
│   │   └── token.js                 # JWT generation
│   ├── .env.example
│   ├── package.json
│   └── server.js                    # Entry point
│
├── 📁 desktop/                      # Electron desktop app
│   ├── 📁 src/
│   │   ├── 📁 components/           # React UI (OrbCore, VoiceDisplay, SplashScreen, etc.)
│   │   ├── 📁 hooks/                # useWebSocket
│   │   ├── 📁 lib/                  # API client
│   │   └── 📁 store/                # Zustand global state
│   ├── main.js                      # Electron main process
│   ├── preload.js                   # Context bridge (IPC → renderer)
│   └── vite.config.js
│
├── 📁 voice/
│   ├── voice.py                     # Voice loop, TTS, STT, intent, action system
│   └── requirements.txt             # Python dependencies
│
├── start.bat                        # One-click Windows launcher
├── start-dev.bat                    # Dev mode (hot reload)
├── AURA.vbs                         # Silent launcher (no terminal window)
└── create-shortcut.bat              # Build frontend + Desktop shortcut
```

---

## ⚙️ How It Works

### 🎙️ Voice Pipeline (v2 — Streaming)

```
🎤  Press Enter and speak
         ↓
🔴  VAD recording — 100ms chunks, stops after 1.8s of silence
         ↓
🧠  faster-whisper (small, int8, CPU) — transcribes speech → text
         ↓
🧹  clean_transcript() — removes noise tags, collapses repetition
         ↓
🔍  Intent detection (regex-based, zero latency)
         ↓
   ┌─────────────────────────────────────────────────┐
   │  set_reminder  →  POST /api/reminders            │
   │  store_memory  →  POST /api/memory               │
   │  open_app      →  local action (Spotify/YT/etc.) │
   │  ask           →  GET  /api/ai/ask-stream (SSE)  │
   └─────────────────────────────────────────────────┘
         ↓
📦  Query embedding (MiniLM-L6-v2, pre-warmed)
         ↓
🔎  Cosine similarity search across stored memories
         ↓
🤖  Mistral streams tokens via Ollama  ←─── sentence boundary detection
         ↓                                        ↓
🔊  edge-tts generates audio (sentence N+1)    🔊  sounddevice plays sentence N
         ↓
🧵  SAPI fallback if edge-tts fails
```

**Perceived latency:** ~2–4 seconds (down from ~10–12s in v1). AURA starts speaking the first sentence while the rest of the response is still being generated.

---

### 🧩 Memory System (RAG-lite)

AURA uses a lightweight **Retrieval Augmented Generation** memory system — no external vector database needed.

- When you share something, AURA generates a **384-dimension vector embedding** using `all-MiniLM-L6-v2` running entirely locally via `@xenova/transformers`
- Embeddings and raw text are stored in **MongoDB**
- On every query, AURA embeds the question and runs **cosine similarity** against all stored memories
- Only semantically relevant memories (score > 0.2) are injected into the Mistral prompt
- Broad queries like *"what do you know about me?"* trigger a fast path that returns all memories sorted by confidence and recency

**Memory types:**

| Type | Examples |
|---|---|
| 🙍 `personal` | name, age, hometown, family |
| 📅 `schedule` | classes, gym, meetings, exams |
| ❤️ `preference` | music, food, apps, tools |
| 🎯 `identity` | projects, goals, skills |

---

### 🤖 Query Classifier

Before calling the LLM, AURA classifies your query in JavaScript (zero added latency) and routes accordingly:

| Type | Example | Behaviour |
|---|---|---|
| `personal` | *"Where do I live?"* | Use memory only — never invent facts |
| `general` | *"Who is Elon Musk?"* | Answer from Mistral's training knowledge |
| `opinion` | *"Should I use React or Vue?"* | Measured perspective, uses your context if relevant |
| `mixed` | *"What's a good laptop for someone like me?"* | Memory for personal part, knowledge for the rest |
| `action` | *"Set a timer for 10 minutes"* | Confirm in one sentence |

Heavy queries (`personal` / `mixed`) route to the full Mistral model. Everything else uses the fast model (`tinyllama` by default) for lower latency.

---

### 🎵 Action System

AURA can control apps on your machine through intent detection + OS-level automation:

| Command | What happens |
|---|---|
| *"Play X on Spotify"* | Opens `spotify:search:X` URI → keyboard automation selects first track |
| *"Play X on YouTube"* | `yt-dlp` fetches the direct `/watch` URL → browser auto-plays |
| *"Open WhatsApp"* | Launches via `whatsapp:` URI or falls back to `web.whatsapp.com` |
| *"Open Maps"* | Opens Google Maps in browser |
| *"Open Settings"* | Opens Windows Settings |
| *"Play it again"* | Re-runs your last app action (follow-up memory) |

---

### ⏰ Reminder System

```
You say "Remind me to call mom at 9:06 PM"
         ↓
Natural language time parser → 21:06 today (or tomorrow if past)
         ↓
Reminder stored in MongoDB with ISO timestamp
         ↓
Backend scheduler checks every 30 seconds
         ↓
At 9:06 PM → reminder marked as fired
         ↓
Voice client polls /api/reminders/pending-voice every 30s
         ↓
🔊 AURA speaks "Call mom" aloud automatically
```

Supports: *"in 30 minutes"*, *"in 2 hours"*, *"at 9:06 PM"*, *"at 10 AM"*, bare *"at 7"*

---

## 🛠️ Tech Stack

| Layer | Technology |
|---|---|
| 🎤 Voice capture | `sounddevice` — VAD-based, stops on 1.8s silence |
| 🗣️ Speech to text | `faster-whisper` — `small` model, CPU, int8, `vad_filter=True` |
| 🔊 Text to speech | `edge-tts` — Microsoft `en-US-AriaNeural` (neural, natural voice) |
| 🔉 Audio playback | `sounddevice` (WAV/24kHz) → PowerShell SAPI fallback |
| 🔍 Intent detection | Regex-based routing, zero latency, module-level compiled patterns |
| 🖥️ Backend server | Node.js + Express 5 |
| 🔐 Authentication | JWT + bcryptjs — token saved to `~/.aura_token` |
| 🗄️ Database | MongoDB + Mongoose (with reconnect handling) |
| 🧮 Embeddings | `@xenova/transformers` — `all-MiniLM-L6-v2`, pre-warmed at startup |
| 📐 Vector search | Custom cosine similarity |
| 🤖 LLM | Mistral 7B (full) + TinyLlama (fast) via Ollama — fully local |
| 🌐 LLM transport | SSE streaming (`/api/ai/ask-stream`) — sentence-level TTS overlap |

---

## 🚀 Setup & Installation

### One-click launch (Windows)

After cloning and configuring `.env` (see below), just double-click **`start.bat`** in the project root. It automatically:

- Checks Node.js, Python, and Ollama are present
- Installs backend and desktop npm dependencies (first run only)
- Installs Python voice dependencies from `voice/requirements.txt`
- Launches the Electron desktop app

Everything else — backend, voice pipeline, model warmup — starts automatically inside the app.

---

### Manual setup

### Prerequisites

- Python **3.10 – 3.12** (⚠️ Python 3.13+ is **not supported** — `faster-whisper` requires compiled C wheels that are not yet available for 3.13)
- Node.js 18+
- MongoDB running locally (`mongod`)
- [Ollama](https://ollama.ai) installed

---

### 1. Clone the repo

```bash
git clone https://github.com/Rudra-Chitnis/AURA.git
cd AURA
```

### 2. Configure the backend

```bash
cd backend
cp .env.example .env
```

Edit `.env`:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/aura
JWT_SECRET=your_random_secret_here
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=mistral
OLLAMA_MODEL_FAST=tinyllama
```

Generate a secure JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### 3. Pull the LLMs

```bash
ollama pull mistral       # main model — ~4GB
ollama pull tinyllama     # fast model for general/action queries — ~600MB
```

> 💡 On low-RAM machines, set both `OLLAMA_MODEL` and `OLLAMA_MODEL_FAST` to `tinyllama`.

### 4. Start Ollama + backend

```bash
# Terminal 1
ollama serve

# Terminal 2
cd backend
npm run dev
```

### 5. Register your account

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d "{\"name\": \"Your Name\", \"email\": \"you@email.com\", \"password\": \"yourpassword\"}"
```

### 6. Start the voice client

```bash
cd voice
pip install -r requirements.txt
python voice.py
```

First run prompts for your email + password once. The JWT token is saved automatically to `~/.aura_token` and never asked again.

---

## 🎤 Usage

Press **Enter** to start speaking. AURA listens until you stop talking (1.8s silence threshold), then responds aloud.

```
🟢  Questions
    "Who am I?"
    "What are my hobbies?"
    "Who is the CEO of Apple?"
    "What time is it?"

🟣  Storing memories
    "Remember that I'm studying at VIT Bhopal"
    "I love lo-fi music"
    "My favourite food is biryani"

🔴  Reminders
    "Remind me to study at 9 PM"
    "Remind me to call mom in 30 minutes"
    "Remind me to drink water at 8 AM"

🎵  App actions
    "Play lofi hip hop on Spotify"
    "Play Blinding Lights on YouTube"
    "Open WhatsApp"
    "Play it again"
```

---

## 📡 API Reference

<details>
<summary><b>Auth Routes</b></summary>

```
POST /api/auth/register       { name, email, password }
POST /api/auth/login          { email, password }  →  { token }
GET  /api/auth/profile        →  { user }
```

</details>

<details>
<summary><b>AI Routes</b></summary>

```
POST /api/ai/ask              { query, time_context? }  →  { answer, memories }
GET  /api/ai/ask-stream       { query, time_context? }  →  SSE token stream
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
<summary><b>Reminder Routes</b></summary>

```
POST   /api/reminders                   { text, reminderTime }
GET    /api/reminders                   →  { reminders }
DELETE /api/reminders/:id
GET    /api/reminders/pending-voice     →  { fired }
```

</details>

---

## ⚠️ Known Limitations

- `edge-tts` requires an internet connection — offline fallback is robotic Windows SAPI
- Reminder polling is pull-based (30s interval) — reminders can fire up to 30s late
- Spotify automation uses keyboard simulation — may mis-navigate if Spotify UI changes
- `yt-dlp` must be installed separately for YouTube direct-play (`pip install yt-dlp`)
- Tested on Windows only

---

## 🗺️ Roadmap

- [x] VAD-based recording — stops on silence
- [x] faster-whisper STT (small, int8, CPU)
- [x] Neural TTS — Microsoft AriaNeural via edge-tts
- [x] Sentence-level streaming TTS pipeline (~2–4s latency)
- [x] RAG-lite memory with vector embeddings
- [x] JWT authentication with auto token management
- [x] Reminder system with natural language time parsing
- [x] Query classifier (personal / general / opinion / action / mixed)
- [x] App action system (Spotify, YouTube, WhatsApp, Maps, Settings)
- [x] Follow-up command memory ("play it again")
- [x] Electron desktop app — animated orb UI, system tray, real startup splash screen
- [x] Pause / Resume mic from UI and system tray
- [x] Clean shutdown (Quit AURA vs hide-to-tray distinguished)
- [x] Auth gate in desktop app with auto token persistence
- [ ] 🔜 Wake word detection — always listening for "Hey AURA"
- [ ] 🔜 Full vector database (FAISS / Chroma)
- [ ] 🔜 React Native mobile companion
- [ ] 🔜 Multi-device sync
- [ ] 🔜 Packaged Windows installer (.exe via electron-builder)

---

## 👥 Authors

<div align="center">

**Rudra Chitnis** &nbsp;·&nbsp; **Sadgi Garg**

Built AURA as a project exploring voice AI, local LLMs, streaming pipelines, and vector memory systems.

[![GitHub](https://img.shields.io/badge/GitHub-Rudra--Chitnis-181717?style=for-the-badge&logo=github)](https://github.com/Rudra-Chitnis)

</div>

---

<div align="center">

⭐ **If you found this interesting, give it a star!** ⭐

*Made with 🔮 by Rudra Chitnis & Sadgi Garg*

</div>
