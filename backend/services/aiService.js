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
const GENERAL_QUERY_RE  = /\b(what is|what are|who is|who was|when did|how do|how does|explain|tell me about|why does|where is|define)\b/i;
const OPINION_QUERY_RE  = /\b(what do you think|your opinion|should i|would you recommend|which is better|what'?s better|do you think|in your view|your thoughts|advise me|is it worth)\b/i;

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
  // If memory search already ran and found results, the question has personal
  // context — treat as personal so the LLM uses those facts.
  if (memories && memories.length > 0) {
    try { dbg.mode("personal", ["memories-fallback"], ["general"]); } catch (_) {}
    return "personal";
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
// Falls back to original content if all lines are structural — never injects
// an empty assistant turn (which could confuse the model more than a label).
// ─────────────────────────────────────────────
const _HIST_LABEL_RE  = /^(?:answer|response|spoken\s*response|aura\w*|assistant|ai|bot|[qa]|personal|general|opinion|mixed|action)\s*:\s*/i;
const _HIST_OPENER_RE = /^(?:sure\s+thing[!.]?|sure[!.]?|certainly[!.]?|of\s+course[!.]?|absolutely[!.]?|great[!.]?|got\s+it[!.]?|ok(?:ay)?[!.]?|no\s+problem[!.]?|happy\s+to\s+help[!.]?|that'?s\s+a\s+(?:great|good)\s+question[!.]?|i\s+can\s+help\s+(?:you\s+)?(?:with\s+that)?[!.]?)\s*/i;
const _HIST_LEAK_RE   = /^(?:(?:user|human|you)\s*:|query\s*type|thinking\s*step|recent\s*conversation|your\s*last\s*responses|spoken\s*response\s*:|what\s*you\s*know\s*about\s*the\s*user|question\s*:|context\s*:|instructions?\s*:|memory\s*:|facts?\s*:|route\s*[-:—]|here'?s\s+a\s+revised|revised\s+version\s+of|conversation\s*:|summary\s*:|recap\s*:|aura\s+said|you\s+said\s*:|i\s+said\s*:)/i;

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
    const subject = (m.person === "user") ? "You" : m.person;
    switch (m.attribute) {
      case "name":                 return `Your name is ${m.value}.`;
      case "lives_in":             return `${subject} live${m.person === "user" ? "" : "s"} in ${m.value}.`;
      case "works_at":             return `${subject} work${m.person === "user" ? "" : "s"} at ${m.value}.`;
      case "studies_at":           return `${subject} stud${m.person === "user" ? "y" : "ies"} at ${m.value}.`;
      case "occupation":           return `${subject} ${m.person === "user" ? "are" : "is"} a ${m.value}.`;
      case "likes":                return `${subject} like${m.person === "user" ? "" : "s"} ${m.value}.`;
      case "dislikes":             return `${subject} dislike${m.person === "user" ? "" : "s"} ${m.value}.`;
      case "birthday":             return `${subject} birthday is ${m.value}.`;
      case "relationship_to_user": return `${subject} is your ${m.value}.`;
      default:
        if (m.attribute.startsWith("favorite_"))
          return `${subject} favorite ${m.attribute.replace("favorite_", "")} is ${m.value}.`;
        return `${subject}: ${m.attribute} = ${m.value}.`;
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
  personal: "Answer using only the facts shown under 'What you know about the user' above. If a specific fact is not listed, say you don't have that record. Do not add biographical details, speculation, or world knowledge.",
  general:  "Answer from general knowledge. If uncertain, say you're not sure.",
  opinion:  "Give a measured perspective. Draw on what you know about the user if it's relevant.",
  mixed:    "Use the known user facts for the personal part of the answer, and general knowledge for the rest.",
};

const buildPrompt = (query, memories, time_context, history = []) => {
  const queryType    = classifyQuery(query, memories);
  const identityCtx  = detectIdentityEntities(query);
  const memoryText   = memories.length > 0
    ? memories.map(m => `- ${formatMemory(m)}`).join("\n")
    : "NONE";

  // ── IDENTITY GUARD ────────────────────────────────────────────────────────
  // Injected only when the query references a canonical identity entity
  // (owner name, known relationship, etc.).
  //
  // Two cases:
  //   memories > 0 — personal facts are known; block any public-knowledge
  //                  supplementation to prevent hallucination/contamination.
  //   memories = 0 — no records yet; explicitly block guessing and direct
  //                  LLM to admit uncertainty rather than fill gaps with
  //                  public figures who share the name.
  //
  // Not injected for general queries — would waste tokens and confuse small models.
  let identityGuard = "";
  if (identityCtx.isIdentity) {
    if (memories.length > 0) {
      identityGuard = "\nCRITICAL: These facts are about a real person you personally know. Use ONLY the facts listed above. Do NOT supplement with public knowledge, biographical speculation, career information, or any detail not in the listed facts. If asked for something not listed, say you don't have that record.";
    } else {
      identityGuard = "\nCRITICAL: You have no stored records about this person yet. Do NOT use public knowledge, make biographical guesses, or assume details about people with this name. Say you don't have detailed information about them yet and invite the user to share what you should know.";
    }
  }

  const timeLine = time_context ? `Time: ${time_context}` : "";

  // Last 6 entries = 3 Q+A pairs — enough for follow-up context, fewer tokens.
  // History is processed in three passes before injection:
  //   1. Sanitize assistant turns — drop action confirmations, structural garbage
  //      (sanitizeHistoryContent returns null → that turn is excluded entirely)
  //   2. Drop orphaned user turns — if the paired assistant turn was dropped,
  //      the user question alone adds noise without a clean answer to anchor it
  //   3. Deduplicate — skip assistant turns whose cleaned content is identical
  //      to the previous assistant turn (model loop / repeated output)
  const recentHistory = history.slice(-6);

  // Pass 1+2: sanitize assistant turns and pair-filter orphaned user entries.
  // Build an indexed list of (userTurn, assistantTurn) pairs, keeping only clean pairs.
  const cleanPairs = [];
  for (let i = 0; i < recentHistory.length - 1; i += 2) {
    const uTurn = recentHistory[i];
    const aTurn = recentHistory[i + 1];
    // Tolerate history arrays that don't align perfectly to user/assistant pairs
    if (!uTurn || !aTurn) continue;
    if (uTurn.role !== "user" || aTurn.role !== "assistant") continue;
    const cleanAssistant = sanitizeHistoryContent(aTurn.content);
    if (!cleanAssistant) continue;  // action turn or garbage — drop entire pair
    cleanPairs.push({ user: uTurn.content, assistant: cleanAssistant });
  }

  // Pass 3: deduplicate — remove consecutive pairs with identical assistant content.
  const dedupedPairs = cleanPairs.filter((pair, idx) =>
    idx === 0 || pair.assistant.toLowerCase().trim() !== cleanPairs[idx - 1].assistant.toLowerCase().trim()
  );

  // Trace context window assembly: raw history depth, clean pairs, dropped pairs
  try {
    if (dbg.DEBUG) {
      const droppedPairs = (recentHistory.length / 2) - dedupedPairs.length;
      dbg.contextWindow(recentHistory.length, dedupedPairs.length, droppedPairs);
    }
  } catch (_) {}

  const historyText = dedupedPairs.length > 0
    ? dedupedPairs
        .map(p => `User: ${p.user}\nAssistant: ${p.assistant}`)
        .join("\n")
    : "None";

  // Summary path: inject pre-extracted topic categories instead of asking the LLM
  // to scan raw history (which small models do poorly).
  let summaryInstruction = "";
  if (isSummaryRequest(query)) {
    const topics = extractTopicsFromHistory(history);
    summaryInstruction = topics
      ? `\nSUMMARY MODE — pre-extracted topics from this conversation:\n${topics}\nSpeak a 2–4 sentence summary of the above, grouped by category. Be specific.\n`
      : `\nSUMMARY MODE: We haven't talked about anything yet. Say so.\n`;
  }

  const typeInstruction = TYPE_INSTRUCTIONS[queryType] || TYPE_INSTRUCTIONS.general;

  const prompt = `You are AURA, a voice assistant. Output ONLY the spoken answer — no reasoning, no labels, no system text.
${timeLine}

What you know about the user:
${memoryText}

Recent conversation:
${historyText}
${summaryInstruction}
${identityGuard}
${typeInstruction}
If your answer contradicts the recent conversation, correct it.
Flag uncertainty with "I'm not certain."

Write 1–3 short sentences — 5 to 12 words each. One idea per sentence.
Use casual speech. Lead with the answer. Sound like a calm, smart friend.
No labels, headers, bullets, or markdown. No meta-commentary. Just answer.
Never say "I'm just an AI". You are AURA — speak as AURA.
Example: "Yeah, cortisol is basically your stress hormone — it spikes under pressure."
Example: "Jazz has a lot of texture — especially the improvisational side."
Address the user as "you" and "your". Never say their name.
"Who created you?" → "You did."
"Do you have feelings?" → "Something like them."

Question: ${query}

Answer:`;

  // Forensic prompt snapshot — written to debug/prompts/ when AURA_DEBUG=true.
  // Records the full assembled prompt + metadata for offline inspection.
  try {
    if (dbg.DEBUG) dbg.promptSnapshot(queryType, identityCtx.isIdentity, prompt, memories.length, dedupedPairs.length);
  } catch (_) {}

  return prompt;
};

// ─────────────────────────────────────────────
// BLOCKING — used by /ask endpoint (fallback path)
// ─────────────────────────────────────────────
const generateResponse = async (query, memories, time_context, history = []) => {
  const prompt     = buildPrompt(query, memories, time_context, history);
  const queryType  = classifyQuery(query, memories);
  const model      = selectModel(queryType);
  // personal/mixed need more tokens for nuanced memory-grounded answers;
  // general/opinion responses are short by design
  const maxTokens  = (queryType === "personal" || queryType === "mixed") ? 180 : 120;

  const response = await axios.post(`${OLLAMA_HOST}/api/generate`, {
    model,
    prompt,
    stream: false,
    options: {
      temperature: 0.1,
      top_p:       0.9,
      num_predict: maxTokens,
      num_ctx:     4096,
    }
  }, { timeout: 55000 });

  return response.data.response.trim();
};

// ─────────────────────────────────────────────
// STREAMING — used by /ask-stream endpoint
// ─────────────────────────────────────────────
const generateResponseStream = async (query, memories, time_context, history = [], onToken) => {
  const prompt    = buildPrompt(query, memories, time_context, history);
  const queryType = classifyQuery(query, memories);
  const model     = selectModel(queryType);
  // personal/mixed need more tokens for nuanced memory-grounded answers;
  // general/opinion responses are short by design
  const maxTokens = (queryType === "personal" || queryType === "mixed") ? 180 : 120;

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
      }
    },
    { responseType: "stream", timeout: 55000 }
  );

  let lineBuffer        = "";
  let firstToken        = false;
  let firstTokenTimeMs  = null;
  let tokenCount        = 0;
  let watchdog          = null;

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
          try {
            const data = JSON.parse(line);
            if (data.response) {
              tokenCount++;
              onToken(data.response);
            }
            if (data.done) {
              clearTimeout(watchdog);
              const totalMs = Date.now() - _streamStart;
              try { if (dbg.DEBUG) dbg.streamEvent("done", `tokens=${tokenCount}  model=${model}`, totalMs); } catch (_) {}
              resolve();
            }
          } catch {
            // malformed JSON line — skip
          }
        }
      });

      response.data.on("end", () => {
        clearTimeout(watchdog);
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
  classifyQuery,
  detectIdentityEntities,
  OWNER_ENTITY_NAMES,
};
