# AURA Core Contracts — Current Implementation

This document records the operations and event shapes that exist in the
`aura-core` implementation today. It is a contract inventory, not a new schema
or a promise that every listed interface is already available to every client.
Where a value is inferred from current code rather than validated, it is
described as observed behavior.

`AURA_CORE_CONTEXT.md` describes the wider migration direction. This document
supersedes its older current-state statements that Electron itself owns timer
and reminder scheduling, and its proposed event names are not current
contracts unless listed below.

## Boundary and data flow

```text
Electron renderer
  ├─ window.aura IPC adapter ──> desktop/main.js ──HTTP──> backend/core/AuraRuntime
  └─ HTTP/SSE + WebSocket ──> backend routes/wsHub ──> backend/core/AuraRuntime

Python voice
  ├─ HTTP ──> backend Core turns/actions/events
  ├─ compatibility stdout markers ──> Electron main ──HTTP──> backend Core
  └─ process-control stdout/stdin ──> Electron main
```

The backend `AuraRuntime` is the application Core composition and is hosted by
`backend/server.js`, which can run without Electron. It composes conversation,
existing AI/memory/semantic-learning services, diagnostics, deterministic
actions, timer/reminder scheduling, and runtime state. Electron retains a
separate host lifecycle object for desktop startup phases and process
coordination; it does not own a second timer/reminder runtime.

Headless start command:

```sh
cd backend && npm start
```

The default backend Core data directory is `~/.aura-core`; Electron passes its
existing user-data directory through `AURA_DATA_DIR` to preserve existing JSON
timer/reminder files. The backend uses `PORT` (default 5000) and WebSocket port
5001.

The architectural direction remains:

```text
Client -> Core API/events
Core -> workers/providers
Core -> persistence/services
```

The existing adapters and implementations remain the source of truth until a
later migration changes them deliberately.

## Core/application operations

### Runtime lifecycle and startup phase

| Current interface | Current contract |
|---|---|
| Backend `AuraRuntime.start()` / `stop()` | Owns timer/reminder scheduling lifecycle and emits in-process `runtime:state` values `starting`, `ready`, and `stopped`; repeated start while ready and repeated stop while stopped are no-ops. |
| Backend `GET /api/runtime/state` | Returns `{ state, timers, reminders }`. Loopback requests are local-client accessible; non-loopback requests pass the existing authentication middleware. |
| `setStartupPhase(phase)` / `getStartupPhase()` | Stores and returns a host-provided string. No enum validation is enforced. |
| Runtime process coordinator callbacks | Coordinate backend/voice process startup, restart, readiness and shutdown through callbacks supplied by Electron. These are internal orchestration methods, not a client API. |

Electron currently emits IPC `startup-phase` with the phase string. Observed
sequence is `launching` → `starting-backend` → `checking-ollama` →
`loading-voice` → `warming-models` → `ready`, with degraded/fallback paths that
may skip or set `ready` early. Do not interpret it as a guaranteed state
machine sequence. The backend health endpoint is `GET /api/health`: HTTP 200
`{ ok: true }` when MongoDB is connected, otherwise HTTP 503
`{ ok: false, reason: "mongodb_not_ready" }`.

### Conversation / turn execution

Backend Core exposes `conversation.runTurn({ userId, query, timeContext,
correctionOccurred, onToken })`, backed by the existing serialized turn
service. It resolves to `{ answer, memories }`. Turns are serialized per user;
the current history is loaded and normalized before processing, then a clean
turn is persisted after a successful answer. The existing correction path
removes the last pair before loading history. `onToken`, when supplied, receives
the existing generated text chunks.

The HTTP adapter remains the public API:

| Request | Behavior |
|---|---|
| Authenticated `POST /api/ai/ask` with `{ query, time_context?, correction_occurred? }` | Missing/falsy `query` returns 400 `{ message: "query is required" }`; success returns `{ answer, memories }`. |
| Authenticated `POST /api/ai/ask-stream` with the same body | SSE data frames contain JSON-encoded token strings; completion is `data: [DONE]`. After headers are sent, failure uses `{ __error: true, message }` as a JSON data frame followed by `[DONE]`. |

Authentication, request/response handling and SSE framing are route concerns,
not conversation Core contracts.

### Deterministic actions, timers and desktop reminders

The current normalized action requests accepted by the backend Core router are:

| Request `type` | Inputs | Result |
|---|---|---|
| `timer.create` | `{ label, seconds }` | `{ handled: true, type, result: timer }`; timer is `{ id, label, durationSecs, endsAt, createdAt }`. |
| `timer.cancel` | `{ id }` | `{ handled: true, type, result: true }`. |
| `reminder.create` | `{ text, fireAt }` | `{ handled: true, type, result: reminder }`; reminder is `{ id, text, fireAt, createdAt }`. |
| `reminder.cancel` | `{ id }` | `{ handled: true, type, result: true }`. |

An absent request, a request without a string `type`, or an unknown `type`
returns `{ handled: false }`. The router does not validate action-specific
fields for recognized types. These remain in-process Core operation shapes.
`POST /api/runtime/actions` accepts the normalized request body and returns the
same dispatch result; Electron IPC and Python voice use that route for
timer/reminder operations.

The runtime persists desktop timers in `timers.json` and desktop reminders in
`reminders.json` under `AURA_DATA_DIR` (Electron sets this to the existing
user-data directory; standalone backend defaults to `~/.aura-core`). Timer list entries add
`remainingSecs`. Desktop Core emits these in-process events:

| Event | Payload |
|---|---|
| `timer:tick` | Array of timer list entries, emitted every second. |
| `timer:fired` | `{ timer, body, wasMissed }`. |
| `reminder:updated` | Array of current desktop reminder records. |
| `reminder:fired` | `{ reminder, body, wasMissed }`. |

The backend event adapter broadcasts renderer-compatible WebSocket envelopes.
Electron relays those events to IPC `timer-tick`, `timer-fired`, `reminder-updated`,
and `reminder-fired`. The fired IPC payloads are reduced to `{ id, label, text }`
for timers and `{ id, text, body }` for reminders. Notification display and
voice delivery are additional Electron-side effects. These in-process Core
event names and IPC event names are intentionally different layers.

There is also a separate authenticated MongoDB-backed `POST/GET/DELETE
/api/reminders` API and a voice polling route `GET /api/reminders/pending-voice`.
Those records are not the desktop `ReminderManager` records and are not
currently unified with its JSON persistence or scheduler.

### Diagnostics and runtime event ingress

Backend Core's `DiagnosticRuntime` accepts raw diagnostic records through
`record(raw)`, retains up to 120 recent entries per user/global scope in
memory, calls host-provided persistence, and asks the backend service adapter
to broadcast. The host service normalizes records to:

```js
{ user, source, type, severity, issue, cause, data, createdAt }
```

Data is sanitized and Mongo persistence is best effort; broadcast exceptions
are swallowed by the diagnostic runtime. The existing authenticated diagnostics
API remains `GET /api/diagnostics/recent`, `GET /api/diagnostics/summary`,
`POST /api/diagnostics/event`, and `POST /api/diagnostics/explain`; it is an
HTTP contract, not a Core transport.

For unauthenticated local event ingress, `POST /api/events/push` accepts the
event body as-is. If `type` is `diagnostic`, the route derives a diagnostic
record with `type` from `diagnosticType`, `diagnostic_type`, or
`runtime_event`; default `source` is `voice` and default `data` is `{}`. The
backend diagnostic broadcaster wraps normalized records for existing clients
as `{ ...record, diagnosticType: record.type, type: "diagnostic" }`. Other
events are passed unchanged to the WebSocket broadcast adapter.

`RuntimeEventRouter.route(...)` returns an internal result:
`{ kind: "diagnostic", event }` on successful diagnostic recording, otherwise
`{ kind: "broadcast", clients }`. If diagnostic recording throws, it falls
through and broadcasts the original event. The HTTP route responds with
`{ ok: true, clients: 0, event }` for recorded diagnostics and
`{ ok: true, clients }` for broadcast events.

## Transport event contracts

### WebSocket

The backend listens on `ws://127.0.0.1:5001`. A new client first receives
`{ type: "connected", message: "AURA WebSocket ready" }`. Broadcasts are JSON
serialization of the event object (or the original string when given a
string); the hub counts successful sends to open clients. It does not filter or
rename ordinary event payloads.

Observed event categories consumed by `desktop/src/hooks/useWebSocket.js` are:

| `type` | Observed fields / UI use |
|---|---|
| `voice` | `state`, optional `text`; renderer maps state/transcript/response into UI. |
| `action` | `action`, `app`, `query`, `timestamp`; renderer records the action. |
| `reminder` | `text`; renderer shows a toast and requests an Electron notification. |
| `memory` | `content`; renderer shows a saved-memory toast. |
| `diagnostic` | Diagnostic record plus `diagnosticType`; renderer stores an event using `issue` or fallback type and `source` or `runtime`. |
| `debug:*` | Existing debug logger event names; renderer strips the prefix and uses source `node`. |

The Python voice runtime currently pushes `voice`, `action`, and `diagnostic`
events. Other categories are existing consumers/contracts, not evidence that
the voice runtime currently emits each category through this ingress. Voice
event delivery is best effort and queued in call order before POSTing.

### Electron IPC

These are desktop adapter contracts, not transport-neutral Core event names:

| IPC channel | Current payload/operation |
|---|---|
| `runtime-state` | String state forwarded from Core `runtime:state`. |
| `startup-phase` | Startup phase string; renderer subscription is `window.aura.onStartupPhase`. |
| `backend-status` | Status string; current sends include `online`, `offline`, `failed`. |
| `voice-status` | Status string; current sends include `running`, `error`, `stopped`, `sleeping`, `failed`. |
| `ollama-status` | `starting`, `loading-model`, `running`, or `unavailable`. |
| `timer-tick`, `timer-fired`, `reminder-updated`, `reminder-fired` | Shapes described above. |
| `debug-event` | Parsed Python debug payload with `source: "python"`, or relayed backend debug event. |

Timer/reminder request IPC is `set-timer({ label, seconds })`,
`cancel-timer(id)`, `list-timers()`, `set-reminder({ text, fireAt })`,
`cancel-reminder(id)`, and `list-reminders()`. These handler names and payloads
remain Electron-specific. Voice process control, pause/resume/wake, notifications,
window controls and settings IPC are likewise host/UI concerns.

### Voice stdout protocol

The voice process posts timer/reminder operations directly to
`POST /api/runtime/actions`. It retains the `AURA:SET_TIMER:<seconds>:<label>`
and `AURA:SET_REMINDER:<text>:<ISO timestamp>` stdout markers as a fallback;
Electron still parses those compatibility lines. Other observed lifecycle
signals include `AURA:VOICE_READY`, `AURA:SLEEPING`, and `AURA:AWAKE`; they are
still interpreted by Electron. These line formats are a current process
protocol, not Core API events.

## Internal implementation details (not public contracts)

- EventEmitter names `runtime:state`, `timer:tick`, `timer:fired`,
  `reminder:updated`, and `reminder:fired` are local to the backend Core process.
- `RuntimeProcessCoordinator` methods/callbacks and startup retry counters are
  internal; they are not directly exposed to renderer or backend clients.
- `RuntimeLifecycle` stores arbitrary strings; the observed phase strings are
  conventions rather than an enforced enum.
- Backend `AuraRuntime` exposes composed capabilities in process; its runtime
  state and deterministic actions are exposed to clients by `/api/runtime`.
- Backend health reports both HTTP process and Mongo readiness as one probe;
  there is no distinct public worker-status event schema today.

## Known inconsistencies retained for compatibility

- Runtime phase strings, backend/voice/Ollama status strings, Core state strings,
  IPC channels, WebSocket `type` values, and Python stdout markers use separate
  naming conventions. This document records each current shape; it does not
  normalize them.
- Core timer/reminder events use colon names while their Electron IPC channels
  use hyphen names. Timer fired payloads also differ between internal Core and
  IPC, as documented above.
- Desktop JSON reminders and authenticated MongoDB reminders are separate
  systems with different lifecycle/storage behavior. A later unification needs
  an explicit compatibility plan.
- `reminder` and `memory` appear in the WebSocket renderer consumer, while the
  currently inspected Python `_push_event` call sites do not demonstrate those
  categories as emitted `/api/events/push` payloads.
- The dotted names in the former Event Architecture proposal in
  `AURA_CORE_CONTEXT.md` (for example `turn.started`, `timer.created`,
  `runtime.ready`) are aspirational only; current code does not emit them.

## Future independent-execution boundary

The current contracts offer a practical migration target: clients should call
Core operations and subscribe to Core application events; transport adapters
should map those contracts to HTTP/WebSocket, Electron IPC, or another client
transport. Core coordinates existing services and persistence through the
backend host; Electron remains responsible for desktop process creation and
host-specific effects. The backend server is independently runnable, although
MongoDB remains a required startup dependency and voice process supervision
remains desktop-owned.
