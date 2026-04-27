const axios = require("axios");

const OLLAMA_HOST       = process.env.OLLAMA_HOST       || "http://localhost:11434";
const OLLAMA_MODEL      = process.env.OLLAMA_MODEL      || "mistral";
const OLLAMA_MODEL_FAST = process.env.OLLAMA_MODEL_FAST || process.env.OLLAMA_MODEL || "mistral";

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

// ─────────────────────────────────────────────
// QUERY TYPE CLASSIFIER
// Runs in JS before the LLM call — zero latency.
// Gives the model explicit routing instructions so it doesn't have to infer
// what kind of reasoning to apply from the question alone.
// ─────────────────────────────────────────────
const PERSONAL_QUERY_RE = /\b(my |i am|who am i|where do i|what do i|do i |am i |when is my|what'?s my|what is my|tell me about me)\b/i;
const ACTION_QUERY_RE   = /\b(set|start|create|open|send|search|browse|run|play|remind|timer|countdown|download)\b/i;
const GENERAL_QUERY_RE  = /\b(what is|what are|who is|who was|when did|how do|how does|explain|tell me about|why does|where is|define)\b/i;
const OPINION_QUERY_RE  = /\b(what do you think|your opinion|should i|would you recommend|which is better|what'?s better|do you think|in your view|your thoughts|advise me|is it worth)\b/i;

const classifyQuery = (query, memories) => {
  const q = query.toLowerCase();
  // Action: requests to DO something — check first, it overrides everything
  if (ACTION_QUERY_RE.test(q))  return "action";
  // Opinion/advice: subjective questions directed at AURA
  if (OPINION_QUERY_RE.test(q)) return "opinion";
  // Broad self-queries: "what do you know about me?", "tell me about me", "who am i?"
  if (/\babout me\b|\bknow (about )?me\b|\bwho am i\b|\bremember about me\b/i.test(q)) return "personal";
  // Mixed: question spans both personal context AND general knowledge
  const isPersonal = PERSONAL_QUERY_RE.test(q);
  const isGeneral  = GENERAL_QUERY_RE.test(q);
  if (isPersonal && isGeneral)  return "mixed";
  if (isPersonal)               return "personal";
  if (isGeneral)                return "general";
  // Fallback: if memories were retrieved, the question likely has personal context
  return (memories && memories.length > 0) ? "personal" : "general";
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

const buildPrompt = (query, memories, time_context, history = []) => {
  const queryType  = classifyQuery(query, memories);
  const memoryText = memories.length > 0
    ? memories.map(m => `- ${formatMemory(m)}`).join("\n")
    : "NONE";

  const timeLine = time_context ? `Time: ${time_context}` : "";

  // Last 6 entries = 3 Q+A pairs — enough for follow-up context, fewer tokens
  const recentHistory = history.slice(-6);
  // Use User/Assistant markers — already caught by _LEADING_LABEL_RE if echoed back
  const historyText = recentHistory.length > 0
    ? recentHistory
        .map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`)
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

  return `You are AURA, a voice assistant. Output ONLY the spoken answer — no reasoning, no labels, no system text.
${timeLine}

What you know about the user:
${memoryText}

Recent conversation:
${historyText}
${summaryInstruction}
This is a ${queryType} question.

If personal: answer only from what you know about the user. If missing, say "I don't have that information."
If general: answer from knowledge; say "I'm not certain" when unsure.
If opinion: give a measured perspective, use what you know about the user if relevant.
If mixed: use user knowledge for the personal part, general knowledge for the rest.
If action: confirm what was done in one sentence.
If your answer contradicts the recent conversation, correct it first.
If something is uncertain, flag it with "I'm not certain".
Timers and app opening work. Web browsing and sending messages do not.

Write 1–3 short sentences — 5 to 12 words each. One idea per sentence.
Use casual speech: "So" not "Therefore", "But" not "However", "Like" not "For instance".
Lead with the answer. Sound like a smart, calm friend — not a manual.
No labels, headers, bullets, or markdown.
No openers like "Sure" or "Certainly". No meta-commentary. Just answer.
Address the user as "you" and "your". Never say their name.
"Who created you?" → "You did."
Missing personal data → "I don't have that."

Question: ${query}

Answer:`;
};

// ─────────────────────────────────────────────
// BLOCKING — used by /ask endpoint (fallback path)
// ─────────────────────────────────────────────
const generateResponse = async (query, memories, time_context, history = []) => {
  const prompt     = buildPrompt(query, memories, time_context, history);
  const queryType  = classifyQuery(query, memories);
  const model      = selectModel(queryType);
  // personal/mixed need more tokens for nuanced memory-grounded answers;
  // general/opinion/action responses are short by design
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
  const maxTokens = (queryType === "personal" || queryType === "mixed") ? 180 : 120;

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

  let lineBuffer = "";

  await new Promise((resolve, reject) => {
    response.data.on("data", (chunk) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split("\n");
      lineBuffer  = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.response) onToken(data.response);
          if (data.done)     resolve();
        } catch {
          // malformed JSON — skip
        }
      }
    });
    response.data.on("end",   resolve);
    response.data.on("error", reject);
  });
};

module.exports = { generateResponse, generateResponseStream, isSummaryRequest };
