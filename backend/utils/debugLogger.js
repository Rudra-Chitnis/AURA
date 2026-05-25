'use strict';

/**
 * AURA Debug Logger — backend/utils/debugLogger.js
 *
 * Provides structured, color-coded observability for the entire AURA
 * inference pipeline. Activated by the environment variable:
 *
 *   AURA_DEBUG=true   (or AURA_DEBUG=1)
 *
 * When enabled:
 *   • Every pipeline decision is logged to console with ANSI color + prefix.
 *   • Every prompt is saved to  debug/prompts/<ts>_<type>.txt
 *   • Every session is saved to debug/sessions/session_<id>.json
 *   • Debug events are broadcast via wsHub to the Electron debug panel.
 *
 * When disabled (default): all calls are no-ops — zero performance impact.
 *
 * Usage:
 *   const dbg = require('../utils/debugLogger');
 *   dbg.intent("detect_intent", "open_app:spotify", "matched verb 'play' + app 'spotify'");
 *   dbg.promptSnapshot(queryType, identityActive, promptText, memoriesCount, historyPairs);
 */

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// GLOBAL DEBUG FLAG
// ─────────────────────────────────────────────────────────────────────────────
const DEBUG = process.env.AURA_DEBUG === 'true' || process.env.AURA_DEBUG === '1';

// ─────────────────────────────────────────────────────────────────────────────
// FILE PATHS
// ─────────────────────────────────────────────────────────────────────────────
const DEBUG_ROOT  = path.resolve(__dirname, '../../debug');
const PROMPT_DIR  = path.join(DEBUG_ROOT, 'prompts');
const SESSION_DIR = path.join(DEBUG_ROOT, 'sessions');

// ─────────────────────────────────────────────────────────────────────────────
// ANSI COLOR PALETTE
// Each prefix has a dedicated color for instant visual scanning.
// ─────────────────────────────────────────────────────────────────────────────
const C = {
  MODE:          '\x1b[35m',    // magenta
  INTENT:        '\x1b[36m',    // cyan
  ENTITY:        '\x1b[33m',    // yellow
  MEMORY:        '\x1b[32m',    // green
  PROMPT:        '\x1b[34m',    // blue
  LLM:           '\x1b[94m',    // bright blue
  SANITIZER:     '\x1b[91m',    // bright red
  STREAM:        '\x1b[96m',    // bright cyan
  ACTION:        '\x1b[36m',    // cyan
  RETRY:         '\x1b[91m',    // bright red
  CONTEXT:       '\x1b[90m',    // dark gray
  HISTORY:       '\x1b[93m',    // bright yellow
  IDENTITY:      '\x1b[95m',    // bright magenta
  OLLAMA:        '\x1b[92m',    // bright green
  FILTER:        '\x1b[31m',    // red
  GATE:          '\x1b[33m',    // yellow
  CONTAMINATION: '\x1b[41m\x1b[97m', // red background, white text
  SESSION:       '\x1b[97m',    // bright white
  DIM:           '\x1b[2m',
  BOLD:          '\x1b[1m',
  RESET:         '\x1b[0m',
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION STATE
// One session = one AURA runtime lifetime (from voice process start to stop).
// ─────────────────────────────────────────────────────────────────────────────
let _session = {
  id:        null,
  startedAt: null,
  events:    [],
  turnCount: 0,
  promptCount: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// INTERNAL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

function _ts() {
  return new Date().toISOString().replace('T', ' ').substring(0, 23);
}

function _tsFile() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').substring(0, 19);
}

function _ensureDirs() {
  try {
    [DEBUG_ROOT, PROMPT_DIR, SESSION_DIR].forEach(d => {
      if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
    });
  } catch { /* non-fatal */ }
}

/** Core console writer — all public API routes through this. */
function _log(prefix, colorCode, ...lines) {
  if (!DEBUG) return;
  const ts    = _ts();
  const label = `${colorCode}[${prefix.toUpperCase().padEnd(14)}]${C.RESET}`;
  const head  = `${C.DIM}${ts}${C.RESET} ${label}`;
  for (const line of lines) {
    if (line !== undefined && line !== '') console.log(`${head} ${line}`);
  }
}

/** Append to session event log (written to disk on endSession). */
function _record(type, data) {
  if (!DEBUG || !_session.id) return;
  _session.events.push({ ts: _ts(), type, ...data });
}

/** Broadcast a debug event to the Electron debug panel via wsHub. */
function _broadcast(type, payload) {
  if (!DEBUG) return;
  try {
    // Lazy-require wsHub to avoid circular deps and startup-order issues.
    const wsHub = require('../wsHub');
    wsHub.broadcast({ type: `debug:${type}`, ...payload, _ts: _ts() });
  } catch { /* wsHub not yet started or unavailable — silently skip */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call once when AURA starts to initialize a new debug session.
 */
function startSession() {
  if (!DEBUG) return;
  try {
    _ensureDirs();
    _session = {
      id:          Date.now().toString(36),
      startedAt:   _ts(),
      events:      [],
      turnCount:   0,
      promptCount: 0,
    };
    _log('SESSION', C.SESSION,
      `${C.BOLD}Debug session started${C.RESET}  id=${C.BOLD}${_session.id}${C.RESET}`,
      `Logs → ${DEBUG_ROOT}`
    );
    _broadcast('session_start', { id: _session.id });
  } catch (_) {}
}

/**
 * Call when AURA shuts down to write the full session JSON to disk.
 */
function endSession() {
  if (!DEBUG || !_session.id) return;
  try {
    _ensureDirs();
    const filePath = path.join(SESSION_DIR, `session_${_session.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify({
      id:          _session.id,
      startedAt:   _session.startedAt,
      endedAt:     _ts(),
      turns:       _session.turnCount,
      prompts:     _session.promptCount,
      events:      _session.events,
    }, null, 2));
    _log('SESSION', C.SESSION, `Session saved → ${filePath}`);
  } catch (_) {}
}

/**
 * Increment the turn counter and return the new count.
 * Call once per complete user→AURA exchange.
 */
function incrementTurn() {
  try { _session.turnCount = (_session.turnCount || 0) + 1; } catch (_) {}
  return _session.turnCount || 0;
}

function getSessionId() { try { return _session.id; } catch (_) { return null; } }

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 1 — MODE TRACING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log which prompt mode was selected and why.
 * @param {string} selected  - final mode (e.g. "personal", "general", "summary")
 * @param {string[]} triggers - conditions that triggered this mode
 * @param {string[]} [alternatives] - other modes that were considered
 */
function mode(selected, triggers, alternatives = []) {
  if (!DEBUG) return;
  try {
    _log('MODE', C.MODE,
      `selected=${C.BOLD}${selected}${C.RESET}`,
      `triggers=[${triggers.join(', ')}]`,
      alternatives.length ? `alternatives=[${alternatives.join(', ')}]` : ''
    );
    _record('mode', { selected, triggers, alternatives });
    _broadcast('mode', { selected, triggers });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 2 — IDENTITY ENTITY TRACING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log canonical identity entity detection results.
 * @param {string}   query        - the original query
 * @param {Object[]} entities     - array of { name, type }
 * @param {boolean}  isOwnerQuery - true if owner entity matched
 */
function identity(query, entities, isOwnerQuery) {
  if (!DEBUG) return;
  try {
    const label  = entities.length
      ? entities.map(e => `${C.BOLD}${e.name}${C.RESET}(${e.type})`).join(', ')
      : 'none';
    const effect = entities.length
      ? (isOwnerQuery
          ? 'classify→personal, boost person:user memories'
          : 'classify→personal')
      : 'no identity entities — normal classification continues';
    _log('IDENTITY', C.IDENTITY,
      `query="${query.slice(0, 60)}"`,
      `entities=[${label}]`,
      `effect: ${effect}`
    );
    _record('identity', { query: query.slice(0, 60), entities, isOwnerQuery, effect });
    _broadcast('identity', { isIdentity: entities.length > 0, isOwnerQuery, entityCount: entities.length });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 3 — MEMORY RETRIEVAL TRACING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log the memory search gate decision (in aiRoute.js).
 * @param {string}  query      - user query
 * @param {string}  queryType  - classifyQuery result
 * @param {boolean} isIdentity - canonical entity found
 * @param {boolean} isSummary  - summary request
 * @param {boolean} gatePass   - whether memory search will run
 */
function memoryGate(query, queryType, isIdentity, isSummary, gatePass) {
  if (!DEBUG) return;
  try {
    const decision = gatePass ? `${C.BOLD}SEARCH${C.RESET}` : `${C.FILTER}SKIP${C.RESET}`;
    const reasons  = [];
    if (queryType !== 'general') reasons.push(`queryType=${queryType}`);
    if (isIdentity)              reasons.push('identity entity');
    if (isSummary)               reasons.push('summary request');
    if (!gatePass)               reasons.push('queryType=general, no identity, no summary');
    _log('GATE', C.GATE,
      `${decision} memory search`,
      `query="${query.slice(0, 60)}"  queryType=${queryType}  identity=${isIdentity}`,
      `reason: ${reasons.join(', ')}`
    );
    _record('memory_gate', { query: query.slice(0, 60), queryType, isIdentity, isSummary, gatePass });
    _broadcast('memory_gate', { queryType, isIdentity, gatePass });
  } catch (_) {}
}

/**
 * Log memory search results with full score breakdown.
 * @param {string}   query      - search query
 * @param {boolean}  ownerRef   - owner name detected in query
 * @param {number}   threshold  - score threshold used
 * @param {Object[]} allScored  - all scored candidates before filtering
 * @param {Object[]} accepted   - memories that passed threshold
 * @param {Object[]} rejected   - memories that failed threshold
 */
function memorySearch(query, ownerRef, threshold, allScored, accepted, rejected) {
  if (!DEBUG) return;
  try {
    _log('MEMORY', C.MEMORY,
      `query="${query.slice(0, 60)}"`,
      `ownerRef=${ownerRef}  threshold=${threshold}  candidates=${allScored.length}`,
      `accepted=${accepted.length}  rejected=${rejected.length}`
    );
    if (accepted.length > 0) {
      _log('MEMORY', C.MEMORY,
        'accepted: ' + accepted.map(m =>
          `${m.score.toFixed(3)}[${m.attribute || m.type || '?'}${m.person ? ':' + m.person : ''}]`
        ).join('  ')
      );
    }
    if (rejected.length > 0) {
      _log('MEMORY', C.MEMORY,
        `${C.DIM}rejected: ` + rejected.map(m => `${m.score.toFixed(3)}`).join(' ') + C.RESET
      );
    }
    _record('memory_search', {
      query:     query.slice(0, 60),
      ownerRef,
      threshold,
      total:     allScored.length,
      accepted:  accepted.length,
      rejected:  rejected.length,
      topScores: accepted.map(m => ({ score: m.score.toFixed(3), attr: m.attribute, person: m.person })),
    });
    _broadcast('memory', { count: accepted.length, ownerRef, threshold });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 4 — CONTEXT WINDOW / HISTORY TRACING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log a history filter action (DROP, SANITIZE, or KEEP).
 * @param {{ role: string, content: string }} turn
 * @param {string} action   - "DROP" | "SANITIZE" | "KEEP"
 * @param {string} reason   - human-readable reason
 */
function historyFilter(turn, action, reason) {
  if (!DEBUG) return;
  try {
    const preview = (turn.content || '').slice(0, 70).replace(/\n/g, '↵');
    const color   = action === 'DROP'     ? C.FILTER
                  : action === 'SANITIZE' ? C.SANITIZER
                  : C.CONTEXT;
    const sym     = action === 'DROP'     ? '✂'
                  : action === 'SANITIZE' ? '~'
                  : '✓';
    _log('HISTORY', color,
      `[${action}] ${sym} role=${turn.role}  "${preview}${(turn.content||'').length > 70 ? '…' : ''}"`,
      `  reason: ${reason}`
    );
    _record('history_filter', {
      role:    turn.role,
      action,
      reason,
      preview: preview.slice(0, 60),
    });
  } catch (_) {}
}

/**
 * Log the context state after history processing.
 * @param {number} totalRaw    - turns before processing
 * @param {number} pairsKept   - pairs after sanitization
 * @param {number} pairsDropped - pairs dropped
 */
function contextWindow(totalRaw, pairsKept, pairsDropped) {
  if (!DEBUG) return;
  try {
    _log('CONTEXT', C.CONTEXT,
      `raw=${totalRaw}  pairs_kept=${pairsKept}  pairs_dropped=${pairsDropped}`
    );
    _record('context_window', { totalRaw, pairsKept, pairsDropped });
    _broadcast('context', { pairs: pairsKept, dropped: pairsDropped });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 5 — PROMPT SNAPSHOT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Write the full prompt to disk and log a summary.
 * File: debug/prompts/<ts>_<queryType>[_IDENTITY].txt
 *
 * @param {string}  queryType      - classifyQuery result
 * @param {boolean} identityActive - identity guard injected
 * @param {string}  prompt         - complete prompt string sent to Ollama
 * @param {number}  memoriesCount  - number of memories injected
 * @param {number}  historyPairs   - number of history pairs injected
 */
function promptSnapshot(queryType, identityActive, prompt, memoriesCount, historyPairs) {
  if (!DEBUG) return;
  try {
    _ensureDirs();
    _session.promptCount = (_session.promptCount || 0) + 1;
    const tokenEst = Math.ceil(prompt.length / 4);
    const suffix   = identityActive ? '_IDENTITY' : '';
    const filename = `${_tsFile()}_${queryType}${suffix}_p${_session.promptCount}.txt`;
    const filePath = path.join(PROMPT_DIR, filename);

    const header = [
      '═'.repeat(80),
      'AURA PROMPT SNAPSHOT',
      `Session:       ${_session.id || 'N/A'}`,
      `Timestamp:     ${_ts()}`,
      `QueryType:     ${queryType}`,
      `IdentityGuard: ${identityActive}`,
      `Memories:      ${memoriesCount}`,
      `HistoryPairs:  ${historyPairs}`,
      `Tokens (est):  ~${tokenEst}`,
      '═'.repeat(80),
      '',
    ].join('\n');

    try { fs.writeFileSync(filePath, header + prompt + '\n'); } catch (_) {}

    _log('PROMPT', C.PROMPT,
      `type=${queryType}  identity=${identityActive}  mem=${memoriesCount}  hist=${historyPairs}  tokens≈${tokenEst}`,
      `  → ${filename}`
    );
    _record('prompt_snapshot', { queryType, identityActive, memoriesCount, historyPairs, tokenEst, file: filename });
    _broadcast('prompt', { queryType, identityActive, memoriesCount, historyPairs, tokenEst });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 6 — RESPONSE VALIDATION / SANITIZER TRACING
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log raw LLM output before any cleaning.
 * @param {string} raw - raw LLM text
 */
function llmRaw(raw) {
  if (!DEBUG) return;
  try {
    const preview = (raw || '').slice(0, 120).replace(/\n/g, '↵');
    _log('LLM', C.LLM, `raw="${preview}${(raw||'').length > 120 ? '…' : ''}"`);
    _record('llm_raw', { preview });
  } catch (_) {}
}

/**
 * Log sanitizer modifications (output filter).
 * Only logs when something was actually removed.
 * @param {string}   input    - text before sanitization
 * @param {string}   output   - text after sanitization
 * @param {string[]} removed  - list of removed fragments
 */
function sanitizerAction(input, output, removed) {
  if (!DEBUG) return;
  if (!removed || removed.length === 0) return;
  try {
    _log('SANITIZER', C.SANITIZER,
      `removed ${removed.length} fragment(s) from output:`,
      ...removed.map(r => `  ✂ "${r.slice(0, 80)}"`)
    );
    _record('sanitizer', { removed: removed.map(r => r.slice(0, 80)) });
    _broadcast('sanitizer', { count: removed.length });
  } catch (_) {}
}

/**
 * Log a detected contamination event.
 * @param {string} type     - contamination type label
 * @param {string} match    - matched text fragment
 * @param {string} location - where it was detected (history/output/memory)
 */
function contamination(type, match, location) {
  if (!DEBUG) return;
  try {
    _log('CONTAMINATION', C.CONTAMINATION,
      `TYPE=${type}  LOCATION=${location}`,
      `  match="${(match || '').slice(0, 80)}"`
    );
    _record('contamination', {
      type,
      location,
      match: (match || '').slice(0, 80),
    });
    _broadcast('contamination', { type, location });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 7 — ACTION ROUTING TRACE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log an action routing decision.
 * @param {string}  text    - user utterance (truncated)
 * @param {string}  stage   - routing stage (1, 2, 3, passive, gate)
 * @param {string}  verb    - matched verb (if any)
 * @param {string}  appKey  - resolved app key (if any)
 * @param {string}  reason  - why this decision was made
 */
function actionRoute(text, stage, verb, appKey, reason) {
  if (!DEBUG) return;
  try {
    const dst = appKey ? `${C.BOLD}→ ${appKey}${C.RESET}` : '→ none';
    _log('ACTION', C.ACTION,
      `stage=${stage}  verb="${verb || '—'}"  ${dst}`,
      `  text="${text.slice(0, 60)}"`,
      `  reason: ${reason}`
    );
    _record('action_route', {
      text:   text.slice(0, 60),
      stage,
      verb:   verb || null,
      appKey: appKey || null,
      reason,
    });
  } catch (_) {}
}

/**
 * Log the final intent resolution for a user utterance.
 * @param {string} text   - user utterance
 * @param {string} intent - resolved intent (set_timer, open_app:X, ask, etc.)
 */
function intentResult(text, intent) {
  if (!DEBUG) return;
  try {
    _log('INTENT', C.INTENT,
      `"${text.slice(0, 70)}"`,
      `  ${C.BOLD}→ ${intent}${C.RESET}`
    );
    _record('intent', { text: text.slice(0, 70), intent });
    _broadcast('intent', { intent, query: text.slice(0, 60) });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 8 — OLLAMA FORENSICS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log an Ollama lifecycle event.
 * @param {string}  event  - event name (server_ping, model_check, first_token, timeout, etc.)
 * @param {string}  [detail] - additional context
 * @param {number}  [ms]   - elapsed milliseconds (for timing events)
 */
function ollamaEvent(event, detail, ms) {
  if (!DEBUG) return;
  try {
    const timing = ms !== undefined ? `  ${ms}ms` : '';
    _log('OLLAMA', C.OLLAMA, `${event}${timing}${detail ? '  ' + detail : ''}`);
    _record('ollama', { event, detail: detail || null, ms: ms || null });
    _broadcast('ollama', { event, ms, detail });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 9 — STREAM / INFERENCE EVENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log a streaming inference event.
 * @param {string}  event   - event name (start, first_token, sentence, done, error, fallback)
 * @param {string}  [detail] - additional context
 * @param {number}  [ms]    - elapsed milliseconds
 */
function streamEvent(event, detail, ms) {
  if (!DEBUG) return;
  try {
    const timing = ms !== undefined ? `  ${ms}ms` : '';
    _log('STREAM', C.STREAM, `${event}${timing}${detail ? '  ' + detail : ''}`);
    _record('stream_event', { event, detail: detail || null, ms: ms || null });
    _broadcast('stream_event', { event, ms, detail });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 10 — RETRY EVENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Log a retry trigger.
 * @param {string} reason      - why a retry was triggered
 * @param {number} attempt     - current attempt number
 * @param {number} maxAttempts - maximum attempts
 */
function retryEvent(reason, attempt, maxAttempts) {
  if (!DEBUG) return;
  try {
    _log('RETRY', C.RETRY,
      `attempt=${attempt}/${maxAttempts}  reason="${reason}"`
    );
    _record('retry', { reason, attempt, maxAttempts });
    _broadcast('retry', { reason, attempt });
  } catch (_) {}
}

// ─────────────────────────────────────────────────────────────────────────────
// LAYER 11 — CONTAMINATION DETECTION HELPERS
// These regex patterns mirror voice.py's contamination patterns so the JS
// pipeline can independently detect the same contamination classes.
// ─────────────────────────────────────────────────────────────────────────────

const _CONTAMINATION_PATTERNS = {
  recap_mode:         /\b(?:here'?s\s+a\s+(?:revised|recap|summary)|revised\s+version\s+of|conversation\s*:|recap\s*:)/i,
  transcript_leakage: /\b(?:user\s*:|assistant\s*:|human\s*:|\[user\]|\[assistant\])/i,
  action_confirmation:/\b(?:opening\s+(?:spotify|youtube|amazon)|timer\s+set\s+for|reminder\s+set\s+for|playing\s+.{0,40}on\s+spotify)/i,
  meta_commentary:    /\b(?:as\s+an\s+ai|as\s+a\s+language\s+model|i(?:'m|\s+am)\s+just\s+an\s+ai|just\s+say\s+["'])/i,
};

/**
 * Scan a text string for known contamination patterns.
 * Returns array of { type, match } for all matches found.
 * @param {string} text
 * @returns {{ type: string, match: string }[]}
 */
function detectContamination(text) {
  if (!text) return [];
  const found = [];
  for (const [type, re] of Object.entries(_CONTAMINATION_PATTERNS)) {
    const m = re.exec(text);
    if (m) found.push({ type, match: m[0] });
  }
  return found;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  DEBUG,

  // Session lifecycle
  startSession,
  endSession,
  incrementTurn,
  getSessionId,

  // Tracing layers
  mode,
  identity,
  memoryGate,
  memorySearch,
  historyFilter,
  contextWindow,
  promptSnapshot,
  llmRaw,
  sanitizerAction,
  contamination,
  actionRoute,
  intentResult,
  ollamaEvent,
  streamEvent,
  retryEvent,

  // Contamination detection
  detectContamination,
};
