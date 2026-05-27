<div align="center">

# AURA
### Adaptive User Response Assistant

*A local-first AI voice assistant built around deterministic runtime orchestration, long-term semantic memory, and interruption-safe conversational infrastructure.*

[![Python](https://img.shields.io/badge/Python-3.10+-3776AB?style=for-the-badge&logo=python&logoColor=white)](https://python.org)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://electronjs.org)
[![MongoDB](https://img.shields.io/badge/MongoDB-Local-47A248?style=for-the-badge&logo=mongodb&logoColor=white)](https://mongodb.com)
[![Ollama](https://img.shields.io/badge/Ollama-Mistral_7B-black?style=for-the-badge)](https://ollama.ai)
[![License](https://img.shields.io/badge/License-MIT-yellow?style=for-the-badge)](LICENSE)

> **No cloud APIs. No subscriptions. No data leaves your machine.**

</div>

---

## What AURA Is

AURA is a personal voice assistant that runs entirely on your local machine. You speak to it through your microphone and it responds out loud — no latency from cloud roundtrips, no external API calls, no data exfiltration.

What makes AURA more than a local Ollama wrapper is its **runtime architecture**. The conversational intelligence is not embedded inside the LLM prompt. It exists as a set of deterministic runtime systems that operate alongside the model — classifying queries, maintaining entity continuity across turns, managing memory lifecycle, sanitizing history, detecting scaffold contamination, and emitting structured observability events. The LLM is one component inside that runtime, not the runtime itself.

---

## Architecture Overview

AURA is organized into four loosely coupled runtime layers:

```
┌─────────────────────────────────────────────────────────────┐
│  Electron Desktop                                           │
│  Floating orb UI · WebSocket consumer · IPC bridge         │
└────────────────────────┬────────────────────────────────────┘
                         │ WebSocket (ws://127.0.0.1:5001)
┌────────────────────────▼────────────────────────────────────┐
│  Node.js Backend                                            │
│  Express API · Auth · Memory · Diagnostics · Reminders      │
│  conversationStateService · memoryConsolidationService      │
│  runtimeDiagnosticsService · aiService · memoryService      │
└────────────┬────────────────────────────────┬───────────────┘
             │ HTTP SSE stream                │ MongoDB
┌────────────▼────────────┐    ┌──────────────▼───────────────┐
│  voice.py               │    │  Ollama                      │
│  VAD → STT → intent     │    │  Local LLM inference         │
│  routing → speak_stream │    │  Mistral / TinyLlama         │
└─────────────────────────┘    └──────────────────────────────┘
```

The backend and voice client are always-running processes. The Electron desktop app provides the UI shell and communicates with both over WebSocket. Ollama runs as a separate sidecar process.

---

## Core Runtime Systems

### 1. Conversational State System (`conversationStateService`)

A session-level semantic runtime that tracks the active state of the conversation independently of the LLM. It maintains:

- **Active entity** — the person, topic, or concept currently in focus (e.g. "Rudra", "India", "the meeting")
- **Active mode** — the current classification (`personal`, `general`, `mixed`, `opinion`)
- **Semantic freshness** — a per-signal decay that weakens mode inheritance when no referential anchor exists in the current query

This is what allows AURA to correctly continue personal context across follow-up turns ("What about his schedule?") without requiring the LLM to infer it from raw history. It also gates mode inheritance — a query with no entity reference cannot silently inherit `personal` routing from a prior turn. The decay is semantic, not purely time-based.

### 2. Memory Consolidation System (`memoryConsolidationService`)

An asynchronous background system that observes validated completed turns and extracts recurring semantic patterns from the user side of the conversation. It does not store raw transcripts. It does not use assistant outputs as evidence. It does not inject directly into prompts.

What it does:
- Detects recurring interests, workflows, topics, and behavioral patterns across sessions
- Applies reinforcement accumulation — a signal seen once does not become permanent memory
- Applies confidence decay — stale or contradicted patterns weaken over time
- Consolidates stable patterns into compact long-term semantic inferences ("User strongly engages with AI systems engineering topics")
- These inferences improve memory retrieval ranking and classification bias without contaminating prompt text

This is the distinction between *explicit fact recall* (standard memory retrieval) and *inferred semantic identity* (consolidation). Both systems coexist.

### 3. Runtime Diagnostics + Introspection System (`runtimeDiagnosticsService`)

A structured observability layer that converts runtime behavior into typed diagnostic events. It separates deterministic diagnosis from LLM explanation rendering — the runtime itself determines what happened, then the model optionally explains it in human-readable form.

Events emitted:
- STT confidence anomalies
- Semantic resolution failures (missing active entity for a referential follow-up)
- TTS queue overflow
- Generation timeout / stream abort
- Scaffold leakage termination
- Malformed response drops
- History contamination guard firings
- Classification overrides and conflicts
- Memory retrieval anomalies

These events are stored in MongoDB with bounded history, exposed via REST endpoints, broadcast to the Electron debug stream, and available for LLM-rendered explanation on demand. AURA can answer "why were you behaving strangely?" with structured introspective reasoning rather than a hallucinated guess.

### 4. Query Classification Pipeline (`classifyQuery` in `aiService.js`)

A zero-latency JS-side classifier that runs before every LLM call. Routing order:

1. **Canonical entity detection** — hard-pins owner/relationship queries regardless of linguistic form
2. **AURA self-identity** — routes identity questions to the personal branch
3. **About-me patterns** — explicit self-reference queries
4. **Opinion signals** — preference/recommendation queries
5. **Personal + General marker intersection** — produces `mixed` routing
6. **Memory fallback** — if search returned high-confidence results (score ≥ 0.45), routes as `personal` for purely personal phrasing or `mixed` for encyclopedic phrasing
7. **General fallback** — conversational phrasing patterns including "talk about X", "let's discuss Y", "help me understand Z"

The classifier gates memory search — embedding calls only run when the query has genuine personal relevance. General world-knowledge queries never trigger memory retrieval.

---

## Voice Pipeline

The voice client (`voice/voice.py`) is a long-running Python process managing the full audio lifecycle.

```
VAD Recording (sounddevice)
         │
         ▼
Noise gate check (Whisper no_speech_prob)
         │
         ▼
Faster-Whisper transcription (small model, int8, CPU)
         │
         ▼
_normalize_transcript()   ← strips hesitation fillers
         │
         ▼
_resolve_references()     ← pronoun/entity resolution
         │
         ▼
detect_intent()           ← deterministic action routing
    │         │
    │         └── open_app / set_timer / set_reminder / store_memory
    │              → handled locally, no LLM call
    │
    ▼
_assess_query(normalized_text)  ← word count + emotional gate
    │
    ▼
Correction handler        ← detects "you're wrong" / "change topic"
    │                        trims stale history pair before LLM call
    │
    ▼
get_answer_stream()       ← HTTP SSE to backend /ask-stream
    │
    ▼
Three-stage TTS pipeline (speak_stream):
  Stage A: _fill()        ← naturalize LLM sentences → sentence_q
  Stage B: _generate()    ← edge-tts audio bytes → audio_q (maxsize=2)
  Stage C: main thread    ← play audio chunks + SAPI fallback
```

### Interruption Handling

Playback is interruptible at any point. The interrupt state is captured before `_stop_all_playback()` clears the flag, so interrupted partial responses never enter `_conversation_history` or MongoDB. A clean per-turn lifecycle is guaranteed regardless of when the user interrupts.

### Stream Integrity

Every sentence yielded by the LLM stream passes through:
- `_clean_llm_output()` — strips label prefixes, structural garbage, opener phrases
- `_SCAFFOLD_LEAK_RE` — drops sentences that indicate the model is continuing prompt scaffolding ("Here's an example response...", "Practice question:", new User:/Question: pairs)
- `_MALFORMED_RESPONSE_RE` — blocks full responses containing action-confirmation strings, identity drift prose, error messages, and clarify artifacts from entering history

Partial responses from interrupted streams, clarify turns ("I didn't quite catch that"), and system error messages are never stored in history or persisted to MongoDB.

### Queue Overflow Recovery

When the TTS audio queue fills under load, Stage B drops the overflowing chunk and signals Stage C to terminate. Chunks that were collected by Stage A but dropped by Stage B are detected at cleanup time (`len(spoken) < len(collected)`) and spoken via SAPI fallback, ensuring the complete response is always audible and that `_conversation_history` receives the full text.

---

## Memory Architecture

### Explicit Fact Memory (Long-Term)

Stored in MongoDB with 384-dimension vector embeddings (`all-MiniLM-L6-v2`, running locally via `@xenova/transformers`).

Storage is structured: AURA parses memory utterances into typed records (person/attribute/value) rather than storing raw text. Relationship patterns support multi-word names. Scalar facts are deduplicated by attribute. Confidence scoring drives retrieval ranking.

Retrieval scoring:
- Base cosine similarity against query embedding
- Entity boost (+0.15) when query terms appear in memory entity fields
- Person boost (+0.15/+0.20) for owner-reference queries
- Recency boost (+0.05 for recent entries)
- Quality gate: if 3+ results score above 0.55, weak results below 0.45 are discarded

Memory gate threshold for `classifyQuery` fallback: score ≥ 0.45. Results scoring 0.35–0.44 (typically pushed over the line by recency alone) do not trigger personal routing.

### Semantic Pattern Memory (Consolidation Layer)

Managed by `memoryConsolidationService`. Backed by `semanticPatternModel` in MongoDB. Distinct from explicit memory — these are distilled behavioral inferences, not stored facts. They improve retrieval bias and classification sensitivity over time without appearing in prompt text.

### Rolling Conversation History

A `deque(maxlen=20)` in the voice client, synchronized to MongoDB via fire-and-forget background persist after each turn. On startup, the last 20 turns are reloaded and cleaned through `_clean_llm_output`. The last 6 entries are injected into each prompt as `[user]/[aura]` pairs (not `User:/Assistant:` format — the bracket notation avoids triggering text-completion template continuation in small models).

---

## Prompting Philosophy

AURA's prompts are intentionally thin. The goal is to give local models (Mistral 7B, TinyLlama) the minimum necessary context to produce a correct, natural response — not to stuff the prompt with instructions the model will partially ignore or continue as scaffolding.

What the prompt contains:
- Time context (single line)
- User memory block (relevant facts only, scored and filtered)
- Conversation history (last 3 Q+A pairs, sanitized, deduped)
- Summary instruction (only for explicit summary requests)
- Identity guard (only for canonical entity queries)
- Type instruction (single sentence, routing-type-specific)
- Optional correction hint (one line, only when user corrected a prior answer)

What the prompt explicitly does not contain:
- `Example: "..."` lines (scaffold continuation triggers)
- `Question: / Answer:` format (worksheet completion pattern)
- `User: / Assistant:` role labels (chat template continuation)
- Hardcoded Q&A arrow pairs
- Educational scaffolding
- Multi-paragraph instruction blocks

The prompt ends with `[user]: {query}\n\n[aura]:` — an unconventional termination that works with small models without training them to continue the prompt structure.

---

## Backend Architecture

The Node.js/Express backend is the central coordination layer.

```
backend/
├── config/
│   └── mongo.js                    # MongoDB connection
├── middleware/
│   ├── authMiddleware.js           # JWT verification
│   └── errorHandler.js            # Global error boundary
├── models/
│   ├── userModel.js
│   ├── memoryModel.js              # Memory + vector embeddings
│   ├── conversationModel.js        # Rolling history persistence
│   ├── reminderModel.js
│   ├── logModel.js
│   ├── semanticPatternModel.js     # Consolidation patterns
│   └── diagnosticEventModel.js    # Runtime diagnostic events
├── routes/
│   ├── authRoute.js
│   ├── aiRoute.js                  # /ask + /ask-stream SSE
│   ├── memoryRoute.js
│   ├── conversationRoute.js        # History load/persist
│   ├── reminderRoute.js
│   ├── logRoute.js
│   └── diagnosticsRoute.js        # Runtime observability API
├── services/
│   ├── aiService.js                # classifyQuery · buildPrompt · generateResponseStream
│   ├── authService.js
│   ├── memoryService.js            # Embedding search · scoring · retrieval
│   ├── conversationService.js      # saveHistory · loadHistory
│   ├── memoryConsolidationService.js  # Semantic pattern learning
│   ├── runtimeDiagnosticsService.js   # Structured observability
│   ├── reminderService.js
│   ├── reminderScheduler.js        # 60s background checker
│   └── logService.js
├── utils/
│   ├── token.js                    # JWT generation
│   └── debugLogger.js              # Structured debug event emission
├── wsHub.js                        # WebSocket hub (ws://127.0.0.1:5001)
└── server.js
```

### SSE Streaming

The `/api/ai/ask-stream` endpoint streams Ollama tokens as Server-Sent Events. JSON-encoded token payloads handle newlines and special characters safely. Two-layer watchdog timers bound the stream:
- **First-token timeout** (12s) — model must begin generating within this window
- **Token-gap timeout** (20s) — max silence between consecutive chunks mid-stream

On timeout, a structured `{__error: true, message}` SSE event is sent followed by `[DONE]`, giving the voice client a clean speakable error message. The voice client handles this without hanging.

### WebSocket Hub (`wsHub.js`)

A local WebSocket server on `ws://127.0.0.1:5001` that the Electron desktop app subscribes to. Used to push:
- Voice state events (`listening`, `speaking`, `idle`)
- Transcript text for display
- Runtime diagnostic events
- Debug stream data (when `AURA_DEBUG=true`)

The voice client also connects to this hub to push structured diagnostic events from the Python side.

### Reminder Scheduler

A 60-second background timer checks MongoDB for pending reminders. When a reminder fires, it is queued for voice delivery. The voice client polls `/api/reminders/pending-voice` every 30 seconds to pick up queued reminders and speak them aloud.

---

## Electron Desktop Architecture

The desktop app is an Electron shell that wraps a React/Vite frontend. It provides:
- A floating orb UI that reflects voice state in real time
- WebSocket subscription to the backend hub for live state updates
- IPC bridge between the Electron main process and renderer
- Login/auth flow with persisted JWT
- Debug overlay (available in development mode)

The Electron process does not directly manage voice capture or LLM calls — it is a display and coordination shell. All runtime intelligence lives in the backend and voice client.

---

## Runtime Diagnostics API

```
GET  /api/diagnostics/recent     → last N structured diagnostic events
GET  /api/diagnostics/summary    → aggregated failure categories + severity counts
POST /api/diagnostics/event      → ingest a diagnostic event (used by voice client)
POST /api/diagnostics/explain    → LLM-rendered explanation of a structured summary
```

The `/explain` endpoint is the only place the LLM is used for diagnostics. It receives a pre-structured summary (not raw logs) and renders a concise human-readable explanation. This prevents hallucinated debugging while keeping explanations natural.

---

## Deterministic Action Routing

Before any LLM call is made, `detect_intent()` in `voice.py` checks the normalized transcript against a hierarchy of deterministic patterns:

| Intent | Examples |
|--------|---------|
| `open_app` | "open spotify", "launch youtube", "play some music" |
| `set_timer` | "set a timer for 5 minutes", "30 second countdown" |
| `set_reminder` | "remind me to study at 7pm", "reminder tomorrow at 9" |
| `store_memory` | "remember that I have an exam Friday" |

Conversational phrasing is handled through a filler-strip + gerund-normalization layer applied before intent matching. "Could you set a timer for 20 seconds" → strips "could you" → "set a timer for 20 seconds" → matches. "Would you mind opening Spotify" → strips "would you mind" → "opening spotify" → gerund normalized → "open spotify" → matches.

LLM calls only happen when no deterministic intent fires. The LLM never handles timer setting, app launching, or memory storage.

---

## Correction Handling

When the user says "you're wrong", "that's not what I asked", "change the topic", or similar correction phrases, AURA:
1. Detects the correction before the LLM path runs
2. Trims the most recent Q+A pair from `_conversation_history` (removing the stale topic anchor)
3. If a follow-up query follows in the same utterance ("that's wrong, tell me about inflation"), routes the remainder as the real query with a `correction_occurred` signal sent to `buildPrompt`
4. If no follow-up exists, acknowledges and loops back without touching the LLM or storing anything

The correction utterance is never stored in history.

---

## Current Capabilities

| Capability | Status |
|------------|--------|
| Voice capture with VAD | ✅ |
| faster-whisper STT (small, int8, CPU) | ✅ |
| edge-tts + SAPI fallback TTS | ✅ |
| Interruption-safe streaming | ✅ |
| Deterministic action routing | ✅ |
| Conversational filler normalization | ✅ |
| Query classification (personal/general/mixed/opinion) | ✅ |
| Canonical entity grounding | ✅ |
| Rolling conversation history | ✅ |
| Long-term semantic memory (RAG-lite) | ✅ |
| Conversational state system | ✅ |
| Memory consolidation + semantic learning | ✅ |
| Runtime diagnostics + introspection | ✅ |
| History contamination guards | ✅ |
| Scaffold leakage detection | ✅ |
| Correction/topic-reset handling | ✅ |
| Reminder scheduling | ✅ |
| Electron desktop UI | ✅ |
| JWT authentication | ✅ |
| Debug observability (AURA_DEBUG) | ✅ |

---

## Current Limitations

**Model-side limitations** (not architecture issues):

- Small local models (Mistral 7B, TinyLlama) have bounded world knowledge and can produce stale or imprecise general-knowledge answers. This is a base model capability limit, not a routing or prompt failure.
- Ollama inference latency is hardware-dependent. On CPU-only machines expect 5–20 seconds per response.
- Very long or grammatically complex speech can confuse faster-whisper transcription, especially with background noise.

**Architecture limitations currently in scope:**

- Semantic-gated mode inheritance needs further tuning — queries with no referential anchor can still occasionally inherit personal routing from a prior turn under aggressive session continuity
- Memory normalization does not fully strip conversational wrapper phrases ("I want you to remember that...") before storage, occasionally creating slightly verbose memory entries
- Ollama health detection can mark the model unavailable during slow but successful long-generation cycles

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Voice capture | `sounddevice` + VAD (RMS energy) |
| Speech-to-text | `faster-whisper` — small model, int8, CPU |
| Text-to-speech | `edge-tts` (primary) + Windows SAPI via PowerShell (fallback) |
| Voice client | Python 3.10+ |
| Backend | Node.js 18+ · Express 5 |
| Desktop UI | Electron · React · Vite |
| Database | MongoDB (local) · Mongoose |
| Embeddings | `@xenova/transformers` · `all-MiniLM-L6-v2` (local, 384-dim) |
| Vector search | Custom cosine similarity with scoring pipeline |
| LLM inference | Ollama — Mistral 7B (default) · TinyLlama (low-RAM option) |
| Auth | JWT · bcryptjs |
| Real-time | WebSocket hub (ws, Node.js) |

---

## Repository Structure

```
AURA/
├── backend/
│   ├── config/
│   │   └── mongo.js
│   ├── middleware/
│   │   ├── authMiddleware.js
│   │   └── errorHandler.js
│   ├── models/
│   │   ├── userModel.js
│   │   ├── memoryModel.js
│   │   ├── conversationModel.js
│   │   ├── reminderModel.js
│   │   ├── logModel.js
│   │   ├── semanticPatternModel.js
│   │   └── diagnosticEventModel.js
│   ├── routes/
│   │   ├── authRoute.js
│   │   ├── aiRoute.js
│   │   ├── memoryRoute.js
│   │   ├── conversationRoute.js
│   │   ├── reminderRoute.js
│   │   ├── logRoute.js
│   │   └── diagnosticsRoute.js
│   ├── services/
│   │   ├── aiService.js
│   │   ├── authService.js
│   │   ├── memoryService.js
│   │   ├── conversationService.js
│   │   ├── memoryConsolidationService.js
│   │   ├── runtimeDiagnosticsService.js
│   │   ├── reminderService.js
│   │   ├── reminderScheduler.js
│   │   └── logService.js
│   ├── utils/
│   │   ├── token.js
│   │   └── debugLogger.js
│   ├── wsHub.js
│   ├── server.js
│   ├── .env.example
│   └── package.json
│
├── voice/
│   ├── voice.py
│   └── requirements.txt
│
├── desktop/                        # Electron + React UI
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   │   └── useWebSocket.js
│   │   └── main/
│   └── package.json
│
└── screenshots/
```

---

## Installation

### Prerequisites

- Node.js 18+
- Python 3.10+
- MongoDB running locally (`mongod`)
- [Ollama](https://ollama.ai) installed

### 1. Clone

```bash
git clone https://github.com/Rudra-Chitnis/AURA.git
cd AURA
```

### 2. Backend

```bash
cd backend
npm install
cp .env.example .env
```

Edit `.env`:

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/aura
JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
OLLAMA_HOST=http://localhost:11434
OLLAMA_MODEL=mistral
OLLAMA_MODEL_FAST=mistral
```

On machines with less than 8GB RAM, use TinyLlama:

```env
OLLAMA_MODEL=tinyllama
OLLAMA_MODEL_FAST=tinyllama
```

### 3. Pull the model

```bash
ollama pull mistral
# or
ollama pull tinyllama
```

### 4. Desktop app (optional)

```bash
cd desktop
npm install
npm run build   # or npm run dev for development mode
```

### 5. Voice client

```bash
cd voice
pip install -r requirements.txt
```

---

## Running AURA

Start all components in separate terminals:

```bash
# Terminal 1 — Ollama
ollama serve

# Terminal 2 — Backend
cd backend
npm run dev

# Terminal 3 — Voice client
cd voice
python voice.py

# Terminal 4 — Desktop UI (optional, development mode)
cd desktop
npm run dev
```

First run of `voice.py` will prompt for email and password. The JWT token is saved automatically to `~/.aura_token` and reused on subsequent runs.

### Register your account

```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"name": "Your Name", "email": "you@email.com", "password": "yourpassword"}'
```

### Debug mode

Set `AURA_DEBUG=true` in the backend environment to enable structured debug event emission, prompt snapshots, and runtime observability broadcast to the WebSocket hub.

---

## API Reference

**Auth**
```
POST /api/auth/register    { name, email, password }
POST /api/auth/login       { email, password } → { token }
GET  /api/auth/profile
```

**AI**
```
POST /api/ai/ask           { query, time_context?, history? } → { answer, memories }
POST /api/ai/ask-stream    { query, time_context?, history?, correction_occurred? } → SSE
```

**Memory**
```
POST /api/memory/store     { content, type }
GET  /api/memory/list
POST /api/memory/search    { query } → { results }
```

**Conversation History**
```
GET  /api/conversation/history          → { turns }
POST /api/conversation/history          { turns }
```

**Reminders**
```
POST   /api/reminders                   { text, reminderTime }
GET    /api/reminders
DELETE /api/reminders/:id
GET    /api/reminders/pending-voice
```

**Diagnostics**
```
GET  /api/diagnostics/recent            → recent diagnostic events
GET  /api/diagnostics/summary           → aggregated failure summary
POST /api/diagnostics/event             { type, cause, severity, ... }
POST /api/diagnostics/explain           { summary } → { explanation }
```

---

## Design Principles

These principles have guided every architectural decision in AURA and are documented in the project's engineering standards:

**Deterministic systems over prompt-only behavior.** Reliability belongs in runtime logic, not LLM instructions.

**One authoritative lifecycle owner per subsystem.** No duplicated ownership paths, no hidden fallbacks.

**All waits, reads, queues, and network calls must be bounded.** Every blocking path requires timeout + cleanup + recovery.

**Explicit state over fragmented implicit flags.** Avoid runtime desynchronization and hidden transitions.

**Stability before autonomy.** Build infrastructure before autonomous cognition systems.

**Realtime interaction always has priority over background processing.** Protect listening, speaking, and interaction loops from background work.

**Learning is downstream of stability.** Memory consolidation only observes clean validated turns — never malformed outputs or recursive contamination.

---

## Roadmap

The following areas are under active development or planned:

- **Semantic-gated mode inheritance** — prevent general queries from inheriting personal routing when no referential anchor exists
- **Memory normalization refinement** — strip conversational wrapper phrases before consolidation
- **Smarter Ollama health detection** — separate slow generation from dead backend
- **Wake word detection** — passive "Hey AURA" trigger
- **Mobile companion** — React Native app for non-desktop contexts
- **Multi-device history sync** — shared conversation state across machines

---

## Author

**Rudra Chitnis**

[![GitHub](https://img.shields.io/badge/GitHub-Rudra--Chitnis-181717?style=for-the-badge&logo=github)](https://github.com/Rudra-Chitnis)

---

<div align="center">

*AURA is an ongoing exploration of what a local-first personal AI assistant looks like when the conversational intelligence lives in the runtime, not the prompt.*

⭐ **Star the repository if you find this useful** ⭐

</div>
