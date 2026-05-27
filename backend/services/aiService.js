const axios = require("axios");
const dbg   = require("../utils/debugLogger");

const OLLAMA_HOST       = process.env.OLLAMA_HOST       || "http://localhost:11434";
const OLLAMA_MODEL      = process.env.OLLAMA_MODEL      || "mistral";
const OLLAMA_MODEL_FAST = process.env.OLLAMA_MODEL_FAST || process.env.OLLAMA_MODEL || "mistral";

// ─────────────────────────────────────────────
// OLLAMA TIMEOUT CONSTANTS
//
// Two-layer watchdog for streaming responses:
//   FIRST_TOKEN_MS — time allowed from stream-open to first token byte.
//     Covers model loading, Ollama queue, cold-start. 12s is generous for a
//     loaded model but tight enough to fail fast when Ollama is actually down.
//   TOKEN_GAP_MS   — max silence between consecutive data chunks mid-stream.
//     Covers stalled inference (CPU overload, swap pressure). Resets on every
//     data event, not every token — so partial JSON lines keep the watchdog fed.
//
// Both timeouts call response.data.destroy(err), which emits an "error" event
// on the Node.js Readable and rejects the Promise via the on("error") handler.
// The route's catch block then sends a structured SSE error event to voice.py.
// ─────────────────────────────────────────────
const FIRST_TOKEN_MS = 12_000;   // 12 s — model must start within this window
const TOKEN_GAP_MS   = 20_000;   // 20 s — max silence between chunks mid-stream
const STOP_SEQUENCES = [
  "\nUser:",
  "\nAssistant:",
  "\nAURA:",
  "\n[user]:",
  "\n[aura]:",
  "\nOutput:",
  "\nNarration:",
  "\nRecent conversation:",
  "\nThe user asks:",
  "\nYour answer:",
  "\nUse these private facts",
  "\nUse this recent context",
  "\nKnown facts",
  "\nRecent user topics",
  "\nCurrent time",
];

/**
 * Destroy a Node.js Readable stream with a named error.
 * The "error" event fires synchronously on the same tick, so the
 * Promise rejection happens before any further event-loop work.
 */
const _killStream = (stream, msg, code) => {
  const err  = new Error(msg);
  err.code   = code;
  stream.destroy(err);
};

const _OUTPUT_LABEL_RE = /^(?:\[(?:user|human|you|assistant|aura)\]|answer|response|spoken\s*response|output|narration|aura\w*|assistant|ai|bot|[qa]|personal|general|opinion|mixed|action)\s*:\s*/i;
const _OUTPUT_OPENER_RE = /^(?:sure\s+thing[!.]?|sure[!.]?|certainly[!.]?|of\s+course[!.]?|absolutely[!.]?|great[!.]?|got\s+it[!.]?|ok(?:ay)?[!.]?|no\s+problem[!.]?|happy\s+to\s+help[!.]?|that'?s\s+a\s+(?:great|good)\s+question[!.]?|i\s+can\s+help\s+(?:you\s+)?(?:with\s+that)?[!.]?)\s*/i;
const _OUTPUT_SCAFFOLD_RE = /(?:^(?:assistant|aura|output|narration|recent\s+conversation|question|user|human|facts|preference|topic)\s*:\s*\S|^about\s+[a-z][a-z0-9 .'-]{1,40}\.$|^\[(?:user|human|you|assistant|aura)\]\s*:\s*\S|short\s+natural\s+answer|natural\s+spoken\s+answer|no\s+lists|no\s+labels|fresh\s+answer|only\s+those\s+facts|no\s+saved\s+facts|if\s+missing|use\s+these\s+private\s+facts|use\s+this\s+recent\s+context|draw\s+on\s+what\s+you\s+know|given\s+the\s+context|possible\s+response|private\s+facts\s+only\s+when\s+relevant|recent\s+context\s+only\s+when\s+it\s+helps|known\s+facts\s+-|recent\s+user\s+topics\s+-|the\s+user\s+asks\s*:|your\s+answer\s*:|here'?s?\s+(?:an?\s+)?example\s+(?:response|answer|reply)|questions?\s+and\s+answers?\s+for\s+you\s+to\s+practice|sample\s+(?:response|answer|question)|practice\s+question|(?:you\s+might|you\s+could)\s+say[:\s]|here'?s?\s+how\s+you\s+(?:could|might|would|should)\s+(?:answer|respond|reply))/im;
const _OUTPUT_MALFORMED_RE = /(?:opening\s+(?:spotify|youtube|amazon|chrome|browser|whatsapp|maps|notepad|calculator)|playing\s+.{1,60}on\s+spotify|searching\s+(?:amazon|youtube|google)\s+for\b|timer\s+set\s+for\b|reminder\s+set\s+for\b|got\s+it,?\s+i'?ll\s+remember\s+that|here'?s\s+a\s+revised\s+version|revised\s+version\s+of\s+the\s+conversation|based\s+on\s+(?:the\s+)?(?:given\s+|above\s+)?conversation|as\s+an?\s+ai(?:\s+(?:assistant|language\s+model|system))?\b|i\s+(?:am|'?m)\s+an?\s+ai(?:\s+(?:assistant|language\s+model))?\b|i\s+cannot\s+(?:access|retrieve|read|see)\s+(?:the\s+)?(?:user|your\s+personal)|i\s+don'?t\s+have\s+(?:the\s+ability|access)\s+to\s+(?:access|retrieve|read)|(?:the\s+)?(?:user|human)\s+(?:has\s+(?:not\s+)?(?:mentioned|provided|given|shared)|asked\s+(?:me\s+)?(?:to|about))|i\s+didn'?t\s+(?:quite\s+)?catch\s+that|that\s+sounds\s+tough\.?|i'?m\s+having\s+trouble\s+thinking\s+right\s+now|something\s+went\s+wrong\s+on\s+my\s+end)/i;

const sanitizeAssistantOutput = (text) => {
  if (!text || typeof text !== "string") return "";
  const kept = text
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l && !_HIST_LEAK_RE.test(l));
  let result = kept.join(" ").trim();
  result = result.replace(_OUTPUT_LABEL_RE, "").trim();
  result = result.replace(_OUTPUT_OPENER_RE, "").trim();
  return result;
};

const isMalformedAssistantOutput = (text) => {
  const t = (text || "").trim();
  if (!t) return true;
  if (!/[A-Za-z]/.test(t)) return true;
  return _OUTPUT_SCAFFOLD_RE.test(t) || _OUTPUT_MALFORMED_RE.test(t);
};

const isSpeakableFinalOutput = (text) => {
  const t = (text || "").trim();
  if (isMalformedAssistantOutput(t)) return false;
  if (/^[,;:\)\]\}]+/.test(t)) return false;
  const words = t.match(/[A-Za-z][A-Za-z']*/g) || [];
  if (words.length < 3) {
    return /^(?:yes|no|okay|ok|sure|maybe|nope|yep|thanks|not sure|it depends)\.?$/i.test(t);
  }
  return /[.!?]$/.test(t);
};

// Route heavy personal/mixed queries to the full model; fast model for everything else.
const selectModel = (queryType) =>
  (queryType === "personal" || queryType === "mixed") ? OLLAMA_MODEL : OLLAMA_MODEL_FAST;

// ─────────────────────────────────────────────
// SHARED PROMPT BUILDER
// history: array of { role: "user" | "assistant", content: string }
// ─────────────────────────────────────────────
// Detect if the user is asking for a conversation summary
const isSummaryRequest = (query) => {
  const q = query.toLowerCase();
  return q.includes("what did we talk about") ||
         q.includes("what have we discussed") ||
         q.includes("summarize our conversation") ||
         q.includes("what topics did we cover") ||
         q.includes("what have you remembered");
};

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL IDENTITY REGISTRY
//
// Deterministic hard-pin of entities that ALWAYS trigger personal classification
// and identity-grounded prompt instructions, regardless of linguistic form.
//
// Problem this solves:
//   "What do you know about Rudra Chitnis?" contains no first-person markers
//   (no "my", "I", "me") so PERSONAL_QUERY_RE never fires.  GENERAL_QUERY_RE
//   also doesn't fire ("what do you know" ≠ "what is").  Result: classifyQuery
//   fallback returns "general" → memory search gate skips → 0 memories →
//   LLM fills gap from public/world knowledge → hallucinated identity.
//
//   Adding canonical entity detection before all other patterns breaks this
//   chain: any query that names an owner, known relationship, or key place
//   immediately routes as "personal" and memory search is guaranteed to run.
//
// Design notes:
//   - Full names are checked before partial names (Map iteration order preserved)
//   - "owner" type = person:"user" in MongoDB (the user's own structured facts)
//   - "relationship" type = person:"<name>" in MongoDB
//   - "personal" type = institution/place with personal relevance
//   - AURA self-identity is handled deterministically in the prompt, not here
//   - Partial name entries handle STT last-name drops ("Rudra" alone)
// ─────────────────────────────────────────────────────────────────────────────
const CANONICAL_ENTITIES = new Map([
  // Full names first — matched before partials for specificity
  ["rudra chitnis",  "owner"],
  ["sadgi garg",     "relationship"],
  // Partial names — STT often drops the surname
  ["rudra",          "owner"],
  ["chitnis",        "owner"],
  ["sadgi",          "relationship"],
  // Key personal places
  ["medicaps",       "personal"],
]);

// Owner name variants — the set of strings that mean "the user themselves".
// Exported so memoryService can apply the owner→user identity mapping
// when boosting person:"user" memories for owner-name queries.
const OWNER_ENTITY_NAMES = new Set(["rudra chitnis", "rudra", "chitnis"]);

/**
 * detectIdentityEntities(query)
 * Scan query string for canonical identity entity names.
 *
 * Returns:
 *   isIdentity   — true if any canonical entity found
 *   entities     — array of { name, type } for matched entities
 *   isOwnerQuery — true if any matched entity is type "owner"
 *
 * Zero-latency: pure string scan, no regex, no async.
 */
const detectIdentityEntities = (query) => {
  const q = query.toLowerCase();
  const found = [];
  for (const [name, type] of CANONICAL_ENTITIES) {
    if (q.includes(name)) {
      found.push({ name, type });
    }
  }
  const result = {
    isIdentity:   found.length > 0,
    entities:     found,
    isOwnerQuery: found.some(e => e.type === "owner"),
  };
  // Log identity detection whenever it fires
  try { if (dbg.DEBUG && found.length > 0) dbg.identity(query, found, result.isOwnerQuery); } catch (_) {}
  return result;
};


// ─────────────────────────────────────────────
// QUERY TYPE CLASSIFIER
// Runs in JS before the LLM call — zero latency.
// Gives the model explicit routing instructions so it doesn't have to infer
// what kind of reasoning to apply from the question alone.
//
// Design contract: by the time a query reaches this classifier, voice.py's
// detect_intent() has already intercepted and handled ALL real action commands
// (open_app, set_timer, set_reminder, store_memory).  Every query arriving here
// is an LLM-bound conversational turn — never a local action.
//
// Therefore there is NO "action" query type.  An "action" classification
// would instruct the LLM to describe how to trigger a command rather than
// answer the question — producing outputs like "Just say 'X' and I'll get
// that started for you."  Since detect_intent() already decided the query is
// not a local action, this instruction is always wrong and produces garbage.
// ─────────────────────────────────────────────
const PERSONAL_QUERY_RE = /\b(my |i am|who am i|where do i|what do i|do i |am i |when is my|what'?s my|what is my|tell me about me)\b/i;
// GENERAL_QUERY_RE covers two classes of pattern:
//   1. Formal question openers:  "what is", "how does", "explain", etc.
//   2. Conversational speech patterns that voice users naturally produce but
//      that old narrow regex missed, causing them to fall to the unclassified
//      "general (fallback)" path with no TYPE_INSTRUCTIONS and no model signal.
//
// The conversational additions ("talk about", "let's discuss", "i want to know",
// "i'm curious", etc.) capture the majority of open-ended speech-style queries
// without touching action routing (detect_intent already handled those) or
// personal queries (PERSONAL_QUERY_RE / CANONICAL_ENTITIES fire first).
//
// "what do you know about" is intentionally included: for non-canonical-entity
// queries ("what do you know about smartwatches") this correctly routes as
// "general". For canonical entities ("what do you know about Rudra") the
// canonical entity check at step 1 fires first and returns "personal" —
// GENERAL_QUERY_RE is never reached.
const GENERAL_QUERY_RE  = /\b(what is|what are|who is|who was|when did|how do|how does|explain|tell me about|why does|where is|define|talk (?:to me )?about|tell me (?:how|why|when|where)|let'?s? (?:talk|discuss|chat)(?: about)?|i want to (?:know|learn|understand|hear)(?: (?:about|more about))?|i'?m curious(?: about)?|discuss|give me (?:some |an? )?(?:info|details?|overview|summary|rundown)(?: (?:about|on))?|help me understand|what (?:do you know|can you tell me) about)\b/i;
const OPINION_QUERY_RE  = /\b(what do you think|your opinion|should i|would you recommend|which is better|what'?s better|do you think|in your view|your thoughts|advise me|is it worth)\b/i;
const SELF_REFERENCE_RE = /\b(i|me|my|mine|myself|about me|who am i|what do you know about me|remember about me)\b/i;

// AURA self-identity patterns — routes to personal so the identity-aware prompt branch
// applies. "Who created you?" / "Do you have feelings?" etc.  These answers are
// delivered via hardcoded prompt examples, not memory retrieval, but they MUST use the
// personal prompt branch (not the stateless general branch) to get the right tone.
const AURA_SELF_RE = /\b(who\s+(?:created|made|built|designed|programmed)\s+you|(?:your|aura'?s)\s+(?:creator|maker|developer|origin)|do\s+you\s+(?:have\s+(?:feelings?|emotions?)|remember\s+things|think|dream)|what\s+(?:are|is)\s+(?:you|aura)\b|who\s+are\s+you|what\s+kind\s+of\s+ai)\b/i;

const classifyQuery = (query, memories) => {
  const q = query.toLowerCase();

  // ── 1. CANONICAL IDENTITY CHECK ───────────────────────────────────────────
  // Must run FIRST — before all other pattern matching.
  // Any query naming an owner, relationship, or key personal place is ALWAYS
  // personal. Memory search must run; LLM must not improvise identity facts.
  const { isIdentity } = detectIdentityEntities(query);
  if (isIdentity) {
    try { dbg.mode("personal", ["canonical-identity-entity"], ["general", "mixed"]); } catch (_) {}
    return "personal";
  }

  // ── 2. AURA SELF-IDENTITY ─────────────────────────────────────────────────
  // "Who created you?", "Do you have feelings?" — routes to personal so
  // identity-aware prompt examples apply instead of the bare general branch.
  if (AURA_SELF_RE.test(q)) {
    try { dbg.mode("personal", ["aura-self-identity"], ["general"]); } catch (_) {}
    return "personal";
  }

  // ── 3. BROAD SELF-QUERY ───────────────────────────────────────────────────
  if (/\babout me\b|\bknow (about )?me\b|\bwho am i\b|\bremember about me\b/i.test(q)) {
    try { dbg.mode("personal", ["about-me-pattern"]); } catch (_) {}
    return "personal";
  }

  // ── 4. OPINION ────────────────────────────────────────────────────────────
  if (OPINION_QUERY_RE.test(q)) {
    try { dbg.mode("opinion", ["OPINION_QUERY_RE"]); } catch (_) {}
    return "opinion";
  }

  // ── 5. PERSONAL + GENERAL MARKERS ────────────────────────────────────────
  const isPersonal = PERSONAL_QUERY_RE.test(q);
  const isGeneral  = GENERAL_QUERY_RE.test(q);
  if (isPersonal && isGeneral) {
    try { dbg.mode("mixed", ["PERSONAL_QUERY_RE", "GENERAL_QUERY_RE"]); } catch (_) {}
    return "mixed";
  }
  if (isPersonal) {
    try { dbg.mode("personal", ["PERSONAL_QUERY_RE"]); } catch (_) {}
    return "personal";
  }
  if (isGeneral) {
    try { dbg.mode("general", ["GENERAL_QUERY_RE"]); } catch (_) {}
    return "general";
  }

  // ── 6. MEMORY FALLBACK ────────────────────────────────────────────────────
  // If memory search already ran and found results with sufficient confidence,
  // the question has personal context — treat as personal so the LLM uses those facts.
  //
  // Threshold: score >= 0.45 (not just > 0).  searchMemory's base threshold is 0.35,
  // meaning a memory scoring 0.35-0.44 can pass the search gate but represents weak
  // semantic overlap — often just recencyBoost (0.05) carrying it over the line.
  // A score this low indicates incidental domain adjacency, not genuine personal
  // relevance.  Reclassifying as "personal" for such a result would constrain the LLM
  // to answer "only from facts shown" for a question where those facts don't apply,
  // producing bizarre or unhelpful responses.
  //
  // Score >= 0.45 ensures only genuinely relevant memories trigger the personal branch.
  // ownerRef queries already use the 0.25 threshold in searchMemory and score higher
  // due to personBoost (+0.20), so they comfortably exceed 0.45 — this gate doesn't
  // suppress legitimate personal queries.
  //
  // MIXED ROUTING: if the query ALSO matches GENERAL_QUERY_RE (e.g. "tell me about India"
  // with a personal India-related memory), route as "mixed" rather than "personal".
  // TYPE_INSTRUCTIONS.personal ("Answer ONLY from facts") is too prohibitive for queries
  // that are partly encyclopedic — the LLM either ignores the instruction (producing
  // unconstrained output) or over-complies (producing 1-sentence personal-only answers).
  // TYPE_INSTRUCTIONS.mixed ("use facts for personal part, general knowledge for rest")
  // produces coherent responses that blend both dimensions correctly.
  const hasExplicitPersonalSignal =
    PERSONAL_QUERY_RE.test(q) ||
    SELF_REFERENCE_RE.test(q) ||
    detectIdentityEntities(query).isIdentity ||
    /\babout me\b|\bknow (about )?me\b|\bwho am i\b|\bremember about me\b/i.test(q);

  if (memories && hasExplicitPersonalSignal && memories.some(m => (m.score || 0) >= 0.45)) {
    const routeType = GENERAL_QUERY_RE.test(q) ? "mixed" : "personal";
    try { dbg.mode(routeType, ["memories-fallback", `score>=${(memories.find(m=>(m.score||0)>=0.45)||{}).score?.toFixed(2)}`, GENERAL_QUERY_RE.test(q) ? "general-re-also-matched" : "personal-only"], ["general"]); } catch (_) {}
    return routeType;
  }

  try { dbg.mode("general", ["fallback-no-signals"]); } catch (_) {}
  return "general";
};


// ─────────────────────────────────────────────
// HISTORY CONTEXT SANITIZER
//
// Applied to assistant turns BEFORE they are injected into buildPrompt().
// Mirrors the output-layer filtering in voice.py _clean_llm_output().
//
// Design contract:
//   The output filter in voice.py is applied to every LLM sentence as it
//   streams out.  What survives reaches TTS and is stored in history.
//   However, turns from sessions before the output filter was tightened
//   (pre-Section-40) may still be in MongoDB and get loaded at startup.
//   Additionally, any pattern that escapes the output filter (novel model
//   behavior, edge cases) would otherwise accumulate in context and be
//   treated as a valid example by the model — amplifying contamination.
//
//   This function closes the loop: history assistant content passes through
//   the same quality gate as output, so contamination cannot self-reinforce
//   regardless of how it entered the stored history.
//
// Kept conservative: drops only confirmed structural contamination.
// Drops assistant content if all lines are structural — never resurrects
// the original contaminated text as a future behavioral example.
// ─────────────────────────────────────────────
const _HIST_LABEL_RE  = /^(?:\[(?:user|human|you|assistant|aura)\]|answer|response|spoken\s*response|output|narration|aura\w*|assistant|ai|bot|[qa]|personal|general|opinion|mixed|action)\s*:\s*/i;
const _HIST_OPENER_RE = /^(?:sure\s+thing[!.]?|sure[!.]?|certainly[!.]?|of\s+course[!.]?|absolutely[!.]?|great[!.]?|got\s+it[!.]?|ok(?:ay)?[!.]?|no\s+problem[!.]?|happy\s+to\s+help[!.]?|that'?s\s+a\s+(?:great|good)\s+question[!.]?|i\s+can\s+help\s+(?:you\s+)?(?:with\s+that)?[!.]?)\s*/i;
const _HIST_LEAK_RE   = /^(?:(?:user|human|you|assistant|aura)\s*:|\[(?:user|human|you|assistant|aura)\]\s*:|output\s*:|narration\s*:|query\s*type|thinking\s*step|recent\s*conversation|your\s*last\s*responses|spoken\s*response\s*:|what\s*you\s*know\s*about\s*the\s*user|question\s*:|context\s*:|instructions?\s*:|memory\s*:|facts?\s*:|route\s*[-:—]|here'?s\s+a\s+revised|revised\s+version\s+of|conversation\s*:|summary\s*:|recap\s*:|aura\s+said|you\s+said\s*:|i\s+said\s*:)/i;

// Prose-level contamination guard — mirrors voice.py _MALFORMED_RESPONSE_RE prose section.
// Applied to the FULL turn content (not per-line) inside sanitizeHistoryContent.
// These phrases are semantically well-formed prose so they pass all line-start filters,
// but they encode LLM identity drift, transcript analysis, or context-collapse and must
// never be fed back as behavioral examples in a future prompt's history block.
// Also includes exact non-conversational system artifact strings (clarify responses,
// error messages, empathize pre-speaks) that may exist in pre-fix MongoDB sessions.
const _HIST_PROSE_RE  = /i\s+don'?t\s+have\s+(?:access\s+to|information\s+about)\s+the\s+user'?s?|based\s+on\s+(?:the\s+)?(?:given\s+|above\s+)?conversation|questions?\s+and\s+answers?\s+for\s+you\s+to\s+practice|here'?s?\s+(?:an?\s+)?example\s+(?:response|answer|reply)|as\s+an?\s+ai(?:\s+(?:assistant|language\s+model|system))?\b|i\s+(?:am|m)\s+an?\s+ai(?:\s+(?:assistant|language\s+model))?\b|i\s+cannot\s+(?:access|retrieve|read|see)\s+(?:the\s+)?(?:user|your\s+personal)|i\s+don'?t\s+have\s+(?:the\s+ability|access)\s+to\s+(?:access|retrieve|read)|(?:the\s+)?(?:user|human)\s+(?:has\s+(?:not\s+)?(?:mentioned|provided|given|shared)|asked\s+(?:me\s+)?(?:to|about))|i\s+didn'?t\s+(?:quite\s+)?catch\s+that|that\s+sounds\s+tough\.?|i'?m\s+having\s+trouble\s+thinking\s+right\s+now|something\s+went\s+wrong\s+on\s+my\s+end/i;

// Action-confirmation strings that should never appear in conversational history.
// These are exact outputs from voice.py action branches — deterministic, short, and safe
// to filter completely.  If an assistant history turn matches this pattern it means a
// pre-fix session stored an action confirmation in MongoDB; it must not be fed back as a
// conversational example.
const _HIST_ACTION_RE = /^(?:opening\s+(?:spotify|youtube|amazon|chrome|browser|whatsapp|maps|notepad|calculator|clock)|playing\s+.{0,60}on\s+spotify|searching\s+(?:amazon|youtube|google|for)\b|timer\s+set\s+for\b|reminder\s+set\s+for\b|got\s+it,?\s+i.?ll\s+remember\s+that|just\s+say\s+['""]|say\s+['""])/i;

// sanitizeHistoryContent — clean one assistant history turn before prompt injection.
//
// Returns:
//   null    — turn is an action confirmation or pure structural garbage; DROP IT entirely
//             from the history block rather than injecting anything.
//   string  — cleaned content ready to inject (may equal original if already clean).
//
// Null return is intentional: it lets buildPrompt() filter out the entire turn pair
// (user question + action answer) rather than injecting "Assistant: " with empty content,
// which confuses small models.
const sanitizeHistoryContent = (content) => {
  if (!content) return null;

  // Fast path: drop entire action-confirmation turns before any other processing.
  // These are deterministic outputs from voice.py action branches stored in pre-fix
  // MongoDB sessions. They are never valid conversational examples for the LLM.
  const trimmed = content.trim();
  if (_HIST_ACTION_RE.test(trimmed)) {
    try {
      if (dbg.DEBUG) {
        dbg.historyFilter({ role: 'assistant', content }, 'DROP', 'action-confirmation pattern');
        const hits = dbg.detectContamination(trimmed);
        hits.forEach(h => dbg.contamination(h.type, h.match, 'history-assistant-turn'));
      }
    } catch (_) {}
    return null;
  }

  // Prose contamination guard: full-turn scan for identity-drift / transcript-analysis
  // phrases that are syntactically valid prose but behaviorally malformed.  These pass
  // the per-line _HIST_LEAK_RE check but must never re-enter the prompt as examples.
  // Mirrors the voice.py _MALFORMED_RESPONSE_RE prose section.
  if (_HIST_PROSE_RE.test(trimmed)) {
    try { if (dbg.DEBUG) dbg.historyFilter({ role: 'assistant', content }, 'DROP', 'prose-contamination pattern'); } catch (_) {}
    return null;
  }

  // Drop structural prompt-echo lines (role labels, section headers, revision patterns)
  const lines = content.split('\n').filter(l => {
    const t = l.trim();
    if (!t) return false;
    if (_HIST_LEAK_RE.test(t)) {
      try { if (dbg.DEBUG) dbg.historyFilter({ role: 'assistant', content: t }, 'DROP', 'structural-leak pattern'); } catch (_) {}
      return false;
    }
    return true;
  });

  // If ALL lines were structural (nothing left), drop this turn entirely.
  if (lines.length === 0) {
    try { if (dbg.DEBUG) dbg.historyFilter({ role: 'assistant', content }, 'DROP', 'all lines structural'); } catch (_) {}
    return null;
  }

  let result = lines.join(' ').trim();
  // Strip leading label prefix (Personal:, Answer:, etc.)
  result = result.replace(_HIST_LABEL_RE, '').trim();
  // Strip stock opener phrases that survived output filtering
  result = result.replace(_HIST_OPENER_RE, '').trim();

  // If the result is now empty after all stripping, drop the turn.
  if (!result) {
    try { if (dbg.DEBUG) dbg.historyFilter({ role: 'assistant', content }, 'DROP', 'empty after label+opener strip'); } catch (_) {}
    return null;
  }

  // Scan for contamination in content we're keeping
  try {
    if (dbg.DEBUG) {
      const hits = dbg.detectContamination(result);
      hits.forEach(h => dbg.contamination(h.type, h.match, 'history-assistant-turn-kept'));
    }
  } catch (_) {}

  return result;
};

// ─────────────────────────────────────────────
// TOPIC EXTRACTION — pre-process history into categories before the LLM sees it.
// This keeps the summary prompt grounded rather than asking the LLM to parse raw
// conversation text, which it's unreliable at on a small local model.
// ─────────────────────────────────────────────
const PERSONAL_RE  = /\b(my name|i live|i work|i am a|i'm a|i study|i like|i love|i prefer|i enjoy|birthday|i'm from|i use|i'm into|fan of)\b/i;
const ACTION_RE    = /\b(remind|reminder|timer|countdown|set a|note that|remember that)\b/i;
const KNOWLEDGE_RE = /\b(what is|who is|who was|when did|how do|how does|explain|tell me|what are|why does|where is)\b/i;

const extractTopicsFromHistory = (history) => {
  if (!history || history.length === 0) return null;

  const personal  = [];
  const actions   = [];
  const knowledge = [];
  const other     = [];

  for (const entry of history) {
    if (entry.role !== "user") continue;
    const msg = entry.content;
    // Each message can match multiple categories — test all independently
    let matched = false;
    if (PERSONAL_RE.test(msg))  { personal.push(msg);  matched = true; }
    if (ACTION_RE.test(msg))    { actions.push(msg);   matched = true; }
    if (KNOWLEDGE_RE.test(msg)) { knowledge.push(msg); matched = true; }
    if (!matched)               { other.push(msg); }
  }

  const lines = [];
  if (personal.length)  lines.push(`Personal info shared: ${personal.join(" | ")}`);
  if (knowledge.length) lines.push(`Knowledge questions:  ${knowledge.join(" | ")}`);
  if (actions.length)   lines.push(`Actions requested:    ${actions.join(" | ")}`);
  if (other.length)     lines.push(`Other topics:         ${other.join(" | ")}`);

  return lines.length ? lines.join("\n") : null;
};

// Format a memory entry for the prompt.
// If the memory has structured fields, render a clean human-readable fact.
// Falls back to raw content for unstructured memories.
const formatMemory = (m) => {
  if (m.person && m.attribute && m.value) {
    const subject = (m.person === "user") ? "user" : m.person;
    switch (m.attribute) {
      case "name":                 return `user name=${m.value}`;
      case "lives_in":             return `${subject} lives_in=${m.value}`;
      case "works_at":             return `${subject} works_at=${m.value}`;
      case "studies_at":           return `${subject} studies_at=${m.value}`;
      case "occupation":           return `${subject} occupation=${m.value}`;
      case "likes":                return `${subject} likes=${m.value}`;
      case "dislikes":             return `${subject} dislikes=${m.value}`;
      case "birthday":             return `${subject} birthday=${m.value}`;
      case "relationship_to_user": return `${subject} relationship=${m.value}`;
      default:
        if (m.attribute.startsWith("favorite_"))
          return `${subject} favorite_${m.attribute.replace("favorite_", "")}=${m.value}`;
        return `${subject} ${m.attribute}=${m.value}`;
    }
  }
  return m.content;
};

// Per-type instructions — single sentence, no label prefix, no "If {type}:" format.
// Small models (TinyLlama) echo label-prefix forms verbatim ("Personal: I'm doing well.")
// so instructions are written as plain directives without mentioning the type name.
//
// "action" type is intentionally absent: voice.py's detect_intent() intercepts all
// real action commands before the LLM is called.  Any query that reaches here is
// a conversational turn, never a local action.
const TYPE_INSTRUCTIONS = {
  personal: "facts-only",
  general:  "plain",
  opinion:  "opinion",
  mixed:    "blend",
};

const FOLLOWUP_RE = /\b(that|this|it|they|them|he|she|her|him|those|these|same|there)\b|^(?:and|also|what about|how about|why|how so|tell me more)\b/i;

const compactMemoryText = (memories, limit = 4) =>
  memories
    .filter(m => (m.score || 0) >= 0.62 || m.person || m.attribute)
    .slice(0, limit)
    .map(formatMemory)
    .filter(Boolean)
    .join("; ");

const lastUserTopic = (history = []) => {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]?.role === "user" && history[i].content) {
      return history[i].content.trim();
    }
  }
  return "";
};

const buildPromptCompact = (query, memories, time_context, history = [], correctionOccurred = false, runtimeContext = null) => {
  const queryType   = runtimeContext?.queryType || classifyQuery(query, memories);
  const identityCtx = detectIdentityEntities(query);
  const mode        = TYPE_INSTRUCTIONS[queryType] || TYPE_INSTRUCTIONS.general;
  const facts       = compactMemoryText(memories, queryType === "personal" ? 6 : 2);
  const priorTopic  = runtimeContext?.promptContext?.line ? "" : (FOLLOWUP_RE.test(query) ? lastUserTopic(history) : "");
  const topics      = isSummaryRequest(query) ? extractTopicsFromHistory(history) : "";
  const lines       = ["AURA. Short natural answer."];

  if (correctionOccurred) lines.push("Fresh answer.");
  if (runtimeContext?.promptContext?.line) lines.push(runtimeContext.promptContext.line);
  if (topics) lines.push(`Summarize: ${topics.replace(/\s+/g, " ")}`);
  else if (priorTopic) lines.push(`Earlier: ${priorTopic}`);

  if (queryType === "personal") {
    if (facts) {
      lines.push(`Facts: ${facts}`);
      if (identityCtx.isIdentity) lines.push("Only those facts for that person.");
    } else {
      lines.push("No saved facts.");
    }
  } else if (queryType === "mixed") {
    if (facts) lines.push(`Facts: ${facts}`);
  } else if (queryType === "opinion") {
    const preferenceFacts = compactMemoryText(
      memories.filter(m =>
        (m.score || 0) >= 0.68 ||
        ["likes", "dislikes", "favorite"].some(k => String(m.attribute || "").includes(k))
      ),
      1
    );
    if (preferenceFacts) lines.push(`Preference: ${preferenceFacts}`);
  }

  if (mode === "facts-only") lines.push("If missing, say you do not have that saved.");

  const prompt = `${lines.join("\n")}\n\n${query}\nAURA:`;

  try {
    if (dbg.DEBUG) dbg.promptSnapshot(queryType, identityCtx.isIdentity, prompt, memories.length, priorTopic ? 1 : 0);
  } catch (_) {}

  return prompt;
};

const buildPrompt = buildPromptCompact;

// ─────────────────────────────────────────────
// BLOCKING — used by /ask endpoint (fallback path)
// ─────────────────────────────────────────────
const generateResponse = async (query, memories, time_context, history = [], runtimeContext = null) => {
  const queryType  = runtimeContext?.queryType || classifyQuery(query, memories);
  const prompt     = buildPromptCompact(query, memories, time_context, history, false, runtimeContext);
  const model      = selectModel(queryType);
  // Align with generateResponseStream token budgets so blocking-fallback responses
  // are never truncated relative to what the streaming path would produce.
  // A truncated response stored in history looks like a complete answer to buildPrompt
  // but may end mid-sentence, causing the next LLM call to "continue" it — stale
  // continuation. Matching budgets eliminates this discrepancy.
  const maxTokens  = (queryType === "personal") ? 220 : (queryType === "mixed") ? 300 : 280;

  const response = await axios.post(`${OLLAMA_HOST}/api/generate`, {
    model,
    prompt,
    stream: false,
    options: {
      temperature: 0.1,
      top_p:       0.9,
      num_predict: maxTokens,
      num_ctx:     4096,
      stop:        STOP_SEQUENCES,
    }
  }, { timeout: 55000 });

  const cleaned = sanitizeAssistantOutput(response.data.response || "");
  return isSpeakableFinalOutput(cleaned) ? cleaned : "";
};

// ─────────────────────────────────────────────
// STREAMING — used by /ask-stream endpoint
// ─────────────────────────────────────────────
const generateResponseStream = async (query, memories, time_context, history = [], onToken, correctionOccurred = false, runtimeContext = null) => {
  const queryType = runtimeContext?.queryType || classifyQuery(query, memories);
  const prompt    = buildPromptCompact(query, memories, time_context, history, correctionOccurred, runtimeContext);
  const model     = selectModel(queryType);
  // personal/mixed need more tokens for nuanced memory-grounded answers;
  // general/opinion responses are short by design
  const maxTokens = (queryType === "personal") ? 220 : (queryType === "mixed") ? 300 : 280;

  try { if (dbg.DEBUG) dbg.ollamaEvent("stream-open", `model=${model}  queryType=${queryType}  maxTokens=${maxTokens}  mem=${memories.length}`); } catch (_) {}

  const _streamStart = Date.now();

  const response = await axios.post(
    `${OLLAMA_HOST}/api/generate`,
    {
      model,
      prompt,
      stream: true,
      options: {
        temperature: 0.1,
        top_p:       0.9,
        num_predict: maxTokens,
        num_ctx:     4096,
        stop:        STOP_SEQUENCES,
      }
    },
    { responseType: "stream", timeout: 55000 }
  );

  let lineBuffer        = "";
  let firstToken        = false;
  let firstTokenTimeMs  = null;
  let tokenCount        = 0;
  let watchdog          = null;
  let outputBuffer      = "";
  let terminated        = false;

  const emitCleanUnit = (unit, final = false) => {
    const cleaned = sanitizeAssistantOutput(unit);
    if (!cleaned) return true;
    if (isMalformedAssistantOutput(cleaned)) {
      terminated = true;
      try { if (dbg.DEBUG) dbg.streamEvent("backend-scaffold-terminated", cleaned.slice(0, 100)); } catch (_) {}
      return false;
    }
    if (final && !isSpeakableFinalOutput(cleaned)) {
      try { if (dbg.DEBUG) dbg.streamEvent("backend-final-discarded", cleaned.slice(0, 100)); } catch (_) {}
      return true;
    }
    onToken(cleaned + (/[.!?]$/.test(cleaned) ? " " : ""));
    return true;
  };

  const flushCompleteUnits = () => {
    while (!terminated) {
      const match = outputBuffer.match(/[.!?](?:\s+|$)/);
      if (!match) break;
      const end = match.index + 1;
      const unit = outputBuffer.slice(0, end).trim();
      outputBuffer = outputBuffer.slice(match.index + match[0].length);
      if (!emitCleanUnit(unit, false)) return false;
    }
    return true;
  };

  // Arm the watchdog immediately after the stream opens.
  // Before first token:  FIRST_TOKEN_MS deadline.
  // After first token:   TOKEN_GAP_MS resets on every data event (any chunk keeps it alive).
  const armWatchdog = () => {
    clearTimeout(watchdog);
    if (!firstToken) {
      watchdog = setTimeout(
        () => _killStream(response.data,
          `Ollama first-token timeout (${FIRST_TOKEN_MS / 1000}s) — model loading or not running`,
          "OLLAMA_FIRST_TOKEN_TIMEOUT"),
        FIRST_TOKEN_MS
      );
    } else {
      watchdog = setTimeout(
        () => _killStream(response.data,
          `Ollama token-gap timeout (${TOKEN_GAP_MS / 1000}s) — inference stalled`,
          "OLLAMA_TOKEN_GAP_TIMEOUT"),
        TOKEN_GAP_MS
      );
    }
  };

  armWatchdog();   // start first-token countdown

  try {
    await new Promise((resolve, reject) => {
      response.data.on("data", (chunk) => {
        if (!firstToken) {
          firstToken       = true;
          firstTokenTimeMs = Date.now() - _streamStart;
          try { if (dbg.DEBUG) dbg.streamEvent("first-token", `model=${model}`, firstTokenTimeMs); } catch (_) {}
          // Transition: first token received — switch to inter-token gap watchdog
        }
        armWatchdog();   // reset watchdog on every data event

        lineBuffer += chunk.toString();
        const lines = lineBuffer.split("\n");
        lineBuffer  = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          let data;
          try {
            data = JSON.parse(line);
          } catch {
            continue;
          }
          if (terminated) {
              clearTimeout(watchdog);
              response.data.destroy();
              resolve();
              return;
            }
          if (data.response) {
              tokenCount++;
              outputBuffer += data.response;
              if (_OUTPUT_SCAFFOLD_RE.test(outputBuffer)) {
                terminated = true;
                clearTimeout(watchdog);
                response.data.destroy();
                resolve();
                return;
              }
              if (!flushCompleteUnits()) {
                clearTimeout(watchdog);
                response.data.destroy();
                resolve();
                return;
              }
            }
          if (data.done) {
              clearTimeout(watchdog);
              if (outputBuffer.trim()) emitCleanUnit(outputBuffer, true);
              outputBuffer = "";
              const totalMs = Date.now() - _streamStart;
              try { if (dbg.DEBUG) dbg.streamEvent("done", `tokens=${tokenCount}  model=${model}`, totalMs); } catch (_) {}
              resolve();
            }
            // malformed JSON line — skip
        }
      });

      response.data.on("end", () => {
        clearTimeout(watchdog);
        if (outputBuffer.trim()) emitCleanUnit(outputBuffer, true);
        outputBuffer = "";
        try { if (dbg.DEBUG) dbg.streamEvent("end", `tokens=${tokenCount}  model=${model}`, Date.now() - _streamStart); } catch (_) {}
        resolve();
      });

      response.data.on("error", (err) => {
        clearTimeout(watchdog);
        try { if (dbg.DEBUG) dbg.ollamaEvent("stream-error", `model=${model}  code=${err.code}  ${err.message}`, Date.now() - _streamStart); } catch (_) {}
        reject(err);
      });
    });
  } finally {
    // Belt-and-suspenders: clear watchdog even if an exception escapes the Promise
    clearTimeout(watchdog);
  }
};

module.exports = {
  generateResponse,
  generateResponseStream,
  isSummaryRequest,
  buildPrompt,
  classifyQuery,
  detectIdentityEntities,
  sanitizeAssistantOutput,
  isMalformedAssistantOutput,
  isSpeakableFinalOutput,
  OWNER_ENTITY_NAMES,
};
