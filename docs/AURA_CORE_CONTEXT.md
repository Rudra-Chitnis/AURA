# AURA Core — Architectural Context

> This document describes the current AURA implementation and the intended
> architectural direction of the `aura-core` branch.
>
> IMPORTANT:
> - The `aura-v2` branch is the stable reference implementation.
> - `aura-core` is an experimental architectural refactor.
> - Existing functionality should be preserved unless explicitly decided otherwise.
> - Do not perform broad rewrites without understanding the current runtime first.

---

# 1. Project Identity

AURA stands for Adaptive User Response Assistant.

AURA is a local-first personal AI assistant designed around:

- conversational interaction
- voice interaction
- persistent personal memory
- semantic retrieval
- deterministic command routing
- local LLM inference
- timers
- reminders
- desktop actions
- runtime diagnostics
- conversational history
- adaptive/semantic behavioral learning

The current implementation is Windows-oriented and uses:

- Node.js
- Express
- MongoDB / Mongoose
- Electron
- React
- Vite
- Tailwind CSS
- Python
- faster-whisper
- edge-tts
- sounddevice
- Ollama
- local embeddings through `@xenova/transformers`

The current stable implementation is tightly orchestrated by Electron.

The purpose of `aura-core` is NOT to create a completely different assistant.

The purpose is to extract the actual assistant runtime from the current desktop shell and turn it into a modular, client-independent architecture.

---

# 2. Current Repository Structure

Current major areas:

AURA/
├── backend/
├── desktop/
├── voice/
├── screenshots/
├── start.bat
├── start-dev.bat
├── AURA.vbs
├── create-shortcut.bat
├── generate-icon.py
├── README.md
├── memory.md
└── package-lock.json

---

# 3. Current Runtime Architecture

The current system is effectively composed of four major runtime domains:

1. Electron Desktop Runtime
2. Node.js Backend
3. Python Voice Runtime
4. Ollama / local model runtime

MongoDB provides persistent storage.

The Electron main process currently acts as the runtime supervisor.

Conceptually:

                    AURA
                      |
              Electron Main
                      |
          +-----------+-----------+
          |                       |
          v                       v
     Node Backend            Python Voice
          |                       |
          |                       |
      MongoDB                 Whisper
          |
       Embeddings
          |
        Ollama
          |
       LLM output

The React UI is hosted inside Electron and communicates with the Electron main
process through IPC and with the Node backend through HTTP/WebSocket.

---

# 4. Electron Main Process

Primary file:

desktop/main.js

Electron currently owns a large amount of system orchestration.

Responsibilities include:

- creating the BrowserWindow
- managing the application lifecycle
- enforcing single-instance behavior
- launching the backend process
- launching/supervising the voice process
- checking backend health
- checking Ollama availability
- checking required Ollama models
- startup phase management
- forwarding backend/voice logs
- persistent application logging
- tray integration
- native window behavior
- IPC
- timer management
- reminder management
- notifications
- voice process lifecycle
- backend process lifecycle
- restart/recovery behavior
- application settings/token persistence
- communication with the React renderer

Electron is therefore NOT currently just a UI shell.

It is effectively the supervisor/orchestrator of the entire AURA runtime.

This is one of the most important architectural facts.

---

# 5. React Desktop Client

Location:

desktop/src/

Main pieces include:

- App.jsx
- components/
- hooks/
- lib/
- store/

The renderer uses:

- React 18
- Vite
- Tailwind CSS
- Zustand

The React application currently handles:

- authentication UI
- startup splash
- voice state display
- transcript display
- typed chat
- drawers/panels
- timers/reminders UI
- settings
- debug UI
- toast notifications
- WebSocket event handling
- Electron IPC integration

The renderer is therefore aware of Electron-specific functionality through
`window.aura`.

The UI is not currently a generic browser client.

---

# 6. React State

Primary store:

desktop/src/store/useStore.js

The Zustand store contains client-side application state including:

- authentication state
- user state
- settings
- voice state
- transcript
- current response
- messages
- actions
- reminders
- startup phase
- debug state
- runtime-related UI state

The renderer receives backend/runtime events and converts them into UI state.

---

# 7. WebSocket Layer

Backend WebSocket implementation:

backend/wsHub.js

Current WebSocket server:

ws://127.0.0.1:5001

The WebSocket server is started by the Node backend.

Other runtime components can POST events to:

POST /api/events/push

The backend then broadcasts those events to connected WebSocket clients.

The React renderer has:

desktop/src/hooks/useWebSocket.js

This connects to the WebSocket hub and translates incoming events into Zustand
state updates.

Current event categories include:

- voice
- action
- reminder
- memory
- diagnostic
- debug events

This is strategically important.

AURA already has the beginnings of a client-independent event architecture.

The future architecture should build upon this rather than replace it unnecessarily.

---

# 8. Node.js Backend

Location:

backend/

Entry point:

backend/server.js

Technology:

- Node.js
- Express 5
- Mongoose
- WebSocket (`ws`)
- JWT
- bcryptjs
- Axios
- local embedding runtime

Current server responsibilities include:

- REST API
- MongoDB connection
- embedding model initialization
- WebSocket hub startup
- authentication
- memory API
- AI API
- conversation API
- reminder API
- diagnostics API
- logging API
- reminder polling compatibility
- health checks
- runtime event broadcasting

Current HTTP port:

5000

Current WebSocket port:

5001

---

# 9. Backend Routes

Current route domains include:

- /api/auth
- /api/memory
- /api/ai
- /api/reminders
- /api/conversation
- /api/diagnostics
- /api/log

There is also:

GET /api/health

This reports backend readiness based on MongoDB connection state.

There is:

POST /api/events/push

This is the current bridge for runtime event broadcasting.

---

# 10. Backend Services

Important current services include:

- aiService.js
- authService.js
- conversationService.js
- conversationStateService.js
- embeddingService.js
- logService.js
- memoryConsolidationService.js
- memoryService.js
- reminderScheduler.js
- reminderService.js
- runtimeDiagnosticsService.js
- turnRuntime.js

The backend therefore already contains many logical pieces that can become
components of AURA Core.

The current problem is primarily ownership/coupling/orchestration rather than
a complete absence of modularity.

---

# 11. Conversation Runtime

backend/services/turnRuntime.js

The current turn runtime provides:

- per-user turn locking
- prompt history loading
- conversation history normalization
- bounded prompt history
- clean turn persistence
- removal of the last conversation pair

Current prompt history is bounded to a fixed number of turns.

The per-user lock is important because concurrent turns should not corrupt
conversation state.

This logic should survive the architectural refactor.

---

# 12. AI Runtime

Primary service:

backend/services/aiService.js

The current AI service handles substantial logic including:

- Ollama connection
- model selection
- query classification
- personal/general/opinion/mixed routing
- canonical identity detection
- prompt construction
- output sanitization
- malformed output detection
- streaming inference
- model-specific routing
- response validation

Current model configuration comes from environment variables.

Default models:

- main model: mistral
- fast model: tinyllama

Ollama normally runs at:

http://localhost:11434

The backend communicates with Ollama through HTTP.

The AI service currently contains significant business logic and is NOT merely
a thin Ollama wrapper.

This distinction must be preserved during migration.

---

# 13. Query Routing Philosophy

AURA already follows an important principle:

Deterministic routing should happen before LLM inference whenever possible.

Examples of commands handled before the LLM include:

- timers
- reminders
- application launching
- follow-up actions
- memory storage

Conversational queries are passed to the backend AI layer.

The intended future architecture should strengthen this principle.

The LLM should be used only when deterministic systems cannot reliably answer
or execute the request.

---

# 14. Memory System

Primary files:

backend/services/memoryService.js
backend/services/embeddingService.js
backend/models/memoryModel.js

Memory currently uses:

- MongoDB
- local embeddings
- cosine similarity
- structured memory parsing
- memory deduplication
- confidence levels
- recency scoring
- entity extraction
- owner identity mapping
- memory pruning

Memory records may contain structured fields such as:

- person
- attribute
- value
- type
- confidence
- embedding
- content

Structured memories include concepts such as:

- name
- location
- workplace
- university
- occupation
- birthday
- likes
- dislikes
- tools/platforms
- favorites
- relationships

Memory search combines semantic similarity with additional boosts such as:

- entity matching
- person matching
- recency
- confidence

Memory count is automatically pruned under a configured limit.

---

# 15. Embedding Runtime

AURA currently uses:

`@xenova/transformers`

with:

`all-MiniLM-L6-v2`

The embedding model is currently pre-warmed during backend startup.

This is important for latency but contributes to startup/runtime resource usage.

Future architecture should consider lazy-loading or isolated embedding workers
rather than automatically keeping every expensive model resident.

Do not remove embeddings merely to reduce resource usage.

First measure their actual cost and loading latency.

---

# 16. Semantic / Behavioral Learning

AURA contains a semantic consolidation system.

Important files:

- backend/services/memoryConsolidationService.js
- backend/models/semanticPatternModel.js

The system observes conversational turns and extracts recurring signals such as:

- AI engineering interest
- software development workflows
- PC hardware
- productivity/reminders
- health/hydration
- DSA/university learning
- preferences
- recurring topics

Patterns accumulate evidence and confidence.

Confidence decays over time.

Sufficiently strong recurring patterns can be consolidated into memory.

This system is distinct from explicit user memories.

It represents inferred behavioral patterns.

This functionality should be preserved during architectural migration.

---

# 17. Python Voice Runtime

Primary file:

voice/voice.py

The voice runtime currently combines several responsibilities:

- microphone capture
- VAD
- speech-to-text
- transcript normalization
- reference resolution
- intent detection
- action routing
- HTTP communication with backend
- event publishing
- text-to-speech
- audio playback
- authentication
- voice state signaling
- system interaction

The current STT implementation uses:

faster-whisper

The current audio input/output uses:

sounddevice

The current TTS path uses:

edge-tts

with Windows SAPI fallback.

The Python runtime communicates with the Node backend through HTTP.

It also communicates with Electron through stdin/stdout conventions.

---

# 18. Voice → Electron Coupling

The current voice runtime emits signals such as:

AURA:SET_TIMER:...

AURA:SET_REMINDER:...

Electron listens to these signals.

Electron then takes ownership of scheduling and delivery.

Therefore the current voice process is not autonomous.

There is a direct protocol coupling:

Python voice
    |
    | stdout protocol
    v
Electron main
    |
    +--> TimerManager
    |
    +--> ReminderManager

This is one of the most important boundaries to eliminate or redesign.

---

# 19. Timer / Reminder Ownership

Current timer and reminder systems are Electron-native.

Files:

desktop/timerManager.js
desktop/reminderManager.js

Electron currently owns:

- timer persistence
- timer scheduling
- reminder scheduling
- startup recovery
- notification delivery
- UI synchronization

This creates an architectural dependency:

Core functionality depends on Electron even though timers and reminders are
conceptually application/runtime services rather than UI services.

Future AURA Core should own the logical timer/reminder service.

A client should only display timer/reminder state and notifications.

---

# 20. Authentication

Current authentication uses:

- JWT
- bcryptjs
- MongoDB

The Electron layer persists the authentication token locally.

The React renderer uses the token for backend API access.

Authentication logic should eventually become part of the Core/API boundary
rather than an Electron-specific concern.

---

# 21. Startup Lifecycle

Current startup is highly orchestrated.

The launcher:

start.bat
    |
    +--> checks Node
    +--> checks Python
    +--> checks Ollama
    +--> may start Ollama
    +--> installs backend dependencies if missing
    +--> installs desktop dependencies if missing
    +--> installs Python dependencies
    +--> builds desktop if necessary
    +--> launches AURA.vbs
             |
             v
         Electron

Electron then:

    launching
        ↓
    starting-backend
        ↓
    checking-ollama
        ↓
    loading-voice
        ↓
    warming-models
        ↓
    ready

This startup chain is one of the major sources of perceived complexity and
failure risk.

Future Core startup should be explicit and observable.

---

# 22. Current Resource-Heavy Components

Potentially expensive components include:

1. Ollama / LLM
2. faster-whisper
3. embedding model
4. Electron/Chromium
5. MongoDB
6. Python voice runtime
7. React/Electron renderer

Do NOT assume the relative cost without measurement.

The first optimization task should establish actual:

- RAM
- VRAM
- CPU
- startup time
- model load time
- inference latency
- STT latency
- embedding latency
- TTS latency

before aggressively optimizing.

---

# 23. Important Existing Contradiction

The project describes itself as fully local/no cloud APIs.

However:

`voice/requirements.txt`

currently uses `edge-tts`, which requires an active internet connection.

Therefore the current architecture is not strictly offline.

Future AURA Core should treat TTS as a provider interface so that a fully local
TTS provider can be used later.

Do not silently remove edge-tts until an equivalent local provider is selected
and tested.

---

# 24. Current Major Architectural Problem

The biggest problem is NOT simply "Electron is heavy."

The deeper problem is that Electron currently acts as:

- UI host
- process supervisor
- startup manager
- runtime coordinator
- timer owner
- reminder owner
- notification owner
- authentication storage layer
- IPC broker
- lifecycle manager
- log aggregator

Therefore Electron is effectively part of AURA's application core.

This creates high coupling.

When Electron has a lifecycle problem, multiple apparently unrelated AURA
features can become affected.

---

# 25. Target Architecture

The desired architecture is:

                         AURA CLIENT
                    Browser / PWA / future apps
                              |
                       HTTP / WebSocket
                              |
                              v
                       ┌─────────────┐
                       │  AURA CORE  │
                       │             │
                       │ Conversation│
                       │ Routing     │
                       │ Memory      │
                       │ Actions     │
                       │ Scheduler   │
                       │ Diagnostics │
                       │ API         │
                       └──────┬──────┘
                              |
                  +-----------+-----------+
                  |                       |
                  v                       v
            AI WORKER                 VOICE WORKER
                  |                       |
              Ollama                  Whisper
              Embeddings              TTS
                                      Audio

The Core must not depend on a particular UI.

The Core must not know whether its client is:

- Chrome
- Edge
- Electron
- Android
- iOS
- CLI
- another computer

---

# 26. Target AURA Core Responsibilities

AURA Core should eventually own:

- conversation orchestration
- query routing
- memory
- semantic learning
- conversation history
- action orchestration
- timers
- reminders
- scheduling
- diagnostics
- authentication
- runtime state
- provider interfaces
- API
- WebSocket/event protocol

AURA Core should NOT directly own:

- React components
- Electron BrowserWindow
- Electron IPC
- browser DOM
- UI animation
- visual state rendering

---

# 27. Target Client Responsibilities

The browser client should own:

- UI
- animations
- conversation rendering
- microphone permissions
- audio presentation
- settings UI
- runtime visualization
- notifications where appropriate
- WebSocket connection
- HTTP requests

The client should consume events rather than reconstructing backend logic.

---

# 28. Target AI Worker

The AI layer should eventually become provider-based.

Conceptually:

AIProvider
    |
    +-- OllamaProvider
    +-- future local provider
    +-- future remote provider

AURA Core should request:

- generate
- stream
- health
- model availability

without knowing the implementation details.

---

# 29. Target Voice Worker

The voice layer should eventually expose a clean interface around:

STT
TTS
audio input
audio output

The Core should not need to understand:

- Python implementation
- sounddevice
- Whisper internals
- edge-tts
- SAPI

Voice should communicate through explicit events/API contracts.

---

# 30. Target Provider Abstractions

Potential provider interfaces:

- AIProvider
- STTProvider
- TTSProvider
- EmbeddingProvider

Initially, existing implementations can remain:

AIProvider       -> Ollama
STTProvider      -> faster-whisper
TTSProvider      -> edge-tts / SAPI
EmbeddingProvider -> Xenova Transformers

The goal is abstraction, not immediate replacement.

---

# 31. LLM Usage Principle

AURA should become increasingly LLM-last.

Examples:

"Set a timer for 20 minutes"
    -> deterministic timer service
    -> no LLM

"Open VS Code"
    -> deterministic action service
    -> no LLM

"What university do I attend?"
    -> memory retrieval
    -> potentially no LLM

"What is TCP's three-way handshake?"
    -> LLM

"Compare these technologies for my project."
    -> memory + LLM

The LLM should be used when reasoning/generation is actually required.

---

# 32. Lazy Resource Strategy

Expensive resources should not necessarily be loaded permanently.

Potential future behavior:

AURA Core starts
    ↓
cheap services ready
    ↓
AI worker idle
    ↓
voice worker idle
    ↓
request requires AI
    ↓
load/wake AI model
    ↓
process request
    ↓
remain warm or unload according to measured cost

Same principle may apply to:

- Whisper
- embeddings
- TTS

Do not implement automatic unloading until latency/resource measurements
justify it.

---

# 33. Event Architecture

The existing WebSocket event system should evolve into a canonical event
protocol.

Potential event families:

turn.started
turn.completed
turn.failed

semantic.classified

memory.search.started
memory.search.completed
memory.created
memory.updated

ai.started
ai.token
ai.completed
ai.failed

voice.listening
voice.transcribing
voice.speaking
voice.idle

action.started
action.completed
action.failed

timer.created
timer.completed

reminder.created
reminder.fired

runtime.started
runtime.ready
runtime.warning
runtime.error

The exact protocol must be designed before implementation.

---

# 34. Migration Principles

The refactor MUST follow these principles:

1. Do not rewrite everything at once.
2. Preserve current functionality.
3. Preserve behavior before improving behavior.
4. Extract boundaries before changing internals.
5. Prefer moving existing code over rewriting working algorithms.
6. Every architectural change must remain testable.
7. One logical migration per commit.
8. Avoid cosmetic restructuring during functional migrations.
9. Do not remove Electron until its responsibilities have been replaced.
10. Do not remove the current voice runtime until a replacement exists.
11. Do not replace Ollama until the provider boundary exists.
12. Do not optimize based on assumptions.
13. Measure resource usage before optimization.
14. Keep `aura-v2` untouched.
15. `aura-core` must always remain independently recoverable.

---

# 35. What NOT To Do

Do NOT:

- rewrite the entire backend
- rewrite the AI service from scratch
- replace MongoDB without reason
- replace Ollama without reason
- remove semantic learning
- remove memory
- remove diagnostics
- delete Electron before extracting its responsibilities
- introduce a cloud backend merely to reduce local resource usage
- introduce microservices everywhere just because they sound architectural
- create unnecessary abstractions
- move files only for aesthetic reasons
- change functionality and architecture simultaneously without need
- blindly trust generated code
- perform massive multi-file changes without verification

---

# 36. First Refactoring Goal

The first goal is NOT:

"Make AURA beautiful."

The first goal is:

"Make the AURA runtime independent from its current desktop shell."

Before removing Electron, identify and extract its responsibilities.

The target should be a headless AURA Core that can run without a graphical
interface.

---

# 37. First Architectural Milestones

Recommended order:

PHASE 0
Current-state documentation
    ↓
PHASE 1
Define Core boundaries
    ↓
PHASE 2
Define event/API contracts
    ↓
PHASE 3
Extract runtime logic from Electron
    ↓
PHASE 4
Move timers/reminders into Core
    ↓
PHASE 5
Make Core independently runnable
    ↓
PHASE 6
Create browser client
    ↓
PHASE 7
Switch client to Core
    ↓
PHASE 8
Remove Electron dependency
    ↓
PHASE 9
Isolate AI worker
    ↓
PHASE 10
Isolate voice worker
    ↓
PHASE 11
Provider abstractions
    ↓
PHASE 12
Performance optimization
    ↓
PHASE 13
UI redesign
    ↓
PHASE 14
Feature development

---

# 38. Definition of Success

AURA Core is successful when:

1. The Core can start without Electron.
2. The Core can operate without a graphical UI.
3. A browser can connect to the Core.
4. The browser can perform the same major functions as the current UI.
5. Timers/reminders are not owned by Electron.
6. AI inference is accessed through a provider boundary.
7. Voice is accessed through a worker boundary.
8. Memory remains persistent.
9. Semantic learning remains functional.
10. Diagnostics remain functional.
11. The system is easier to start, inspect and debug.
12. A failure in the UI does not kill the Core.
13. A failure in Ollama does not kill the Core.
14. A failure in voice does not kill the Core.
15. Individual workers can restart independently.
16. AURA remains local-first.

---

# 39. Codex Operating Rules

Any coding agent working on this repository must:

- inspect before modifying
- explain intended changes before broad refactors
- preserve behavior unless explicitly instructed otherwise
- avoid unrelated cleanup
- avoid dependency upgrades unless required
- avoid deleting working functionality
- avoid modifying `aura-v2`
- work only on `aura-core`
- prefer small, reversible commits
- run appropriate tests/builds after changes
- report failures honestly
- never assume a component is unused merely because it looks redundant
- trace imports/callers before deleting or moving a component
- treat Electron dependencies as migration targets, not immediate deletion targets
- treat existing diagnostics/logging as valuable infrastructure

---

# 40. Current Architectural Thesis

The current AURA implementation is not fundamentally lacking in functionality.

It is suffering from orchestration and ownership coupling.

The desired refactor is therefore:

CURRENT:

Electron
    ├── UI
    ├── lifecycle
    ├── process management
    ├── timers
    ├── reminders
    ├── IPC
    └── runtime supervision

TARGET:

AURA Core
    ├── conversation
    ├── routing
    ├── memory
    ├── semantic learning
    ├── actions
    ├── timers
    ├── reminders
    ├── diagnostics
    └── API/event protocol

Clients
    └── presentation

Workers
    ├── AI
    └── Voice

Providers
    ├── LLM
    ├── STT
    ├── TTS
    └── Embeddings

The objective is separation of responsibility, independent failure domains,
observability, testability, and future client/provider flexibility.