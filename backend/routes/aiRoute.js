const express = require("express");
const router  = express.Router();

const { generateResponse, generateResponseStream, classifyQuery, isSummaryRequest, detectIdentityEntities } = require("../services/aiService");
const { searchMemory }                             = require("../services/memoryService");
const { createLog }                                = require("../services/logService");
const protect                                      = require("../middleware/authMiddleware");
const dbg                                          = require("../utils/debugLogger");


// ─────────────────────────────────────────────
// POST /ask  — blocking, full response (fallback path)
// ─────────────────────────────────────────────
router.post("/ask", protect, async (req, res, next) => {
  try {
    const { query, time_context, history = [] } = req.body;

    if (!query) {
      return res.status(400).json({ message: "query is required" });
    }

    // Memory search gate — run search only when the query has personal relevance.
    //
    // Pure general queries ("what time is it?", "who invented TCP?") produce
    // cosine similarity > 0.35 against temporally-adjacent personal memories,
    // causing the LLM to hallucinate connections between unrelated facts.
    //
    // Gate conditions (any one is sufficient):
    //   1. classifyQuery returns non-"general" — covers personal/mixed/opinion queries
    //      and — critically — identity entity queries ("What do you know about Rudra
    //      Chitnis?") which classifyQuery now correctly classifies as "personal" via
    //      canonical entity detection (Section 44 fix).
    //   2. detectIdentityEntities finds a canonical name — defense-in-depth: even if
    //      classifyQuery somehow returned "general" for an identity query, this check
    //      guarantees memory search still runs for any canonical entity mention.
    //   3. isSummaryRequest — summary requests need memory regardless of type.
    let memories = [];
    const queryType      = classifyQuery(query, []);
    const { isIdentity } = detectIdentityEntities(query);
    const isSummary      = isSummaryRequest(query);
    const gatePass       = queryType !== "general" || isIdentity || isSummary;

    try { if (dbg.DEBUG) dbg.memoryGate(query, queryType, isIdentity, isSummary, gatePass); } catch (_) {}

    if (gatePass) {
      try {
        memories = await searchMemory(req.user._id, query);
      } catch (memErr) {
        console.warn("[Memory] Search failed (non-fatal):", memErr.message);
      }
    }

    console.log("Query:", query, "| QueryType:", queryType, "| Memories:", memories.length, "| History:", history.length);

    const answer = await generateResponse(query, memories, time_context, history);

    await createLog(`[ASK] user=${req.user._id} query="${query}" memories=${memories.length}`);

    res.json({ answer, memories });

  } catch (err) {
    next(err);
  }
});


// ─────────────────────────────────────────────
// POST /ask-stream  — SSE streaming endpoint
//
// Streams Ollama tokens as SSE. Token values are JSON-encoded so
// newlines / special chars survive the SSE wire format safely.
// Final event: "data: [DONE]\n\n"
// ─────────────────────────────────────────────
router.post("/ask-stream", protect, async (req, res, next) => {
  try {
    const { query, time_context, history = [] } = req.body;

    if (!query) {
      return res.status(400).json({ message: "query is required" });
    }

    // Flush headers immediately so the client starts listening
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.flushHeaders();

    // Only search memory when the query has personal relevance.
    // See /ask endpoint comment above for full reasoning.
    // NOTE: detectIdentityEntities guard added here (mirrors /ask) — the original
    // /ask-stream gate was missing the isIdentity failsafe (Section 45 fix).
    let memories = [];
    const queryType      = classifyQuery(query, []);
    const { isIdentity } = detectIdentityEntities(query);
    const isSummary      = isSummaryRequest(query);
    const gatePass       = queryType !== "general" || isIdentity || isSummary;

    try { if (dbg.DEBUG) dbg.memoryGate(query, queryType, isIdentity, isSummary, gatePass); } catch (_) {}

    if (gatePass) {
      try {
        memories = await searchMemory(req.user._id, query);
      } catch (memErr) {
        console.warn("[Memory] Search failed (non-fatal):", memErr.message);
      }
    }

    console.log("Stream query:", query, "| QueryType:", queryType, "| Memories:", memories.length, "| History:", history.length);

    await generateResponseStream(query, memories, time_context, history, (token) => {
      res.write(`data: ${JSON.stringify(token)}\n\n`);
      if (typeof res.flush === "function") res.flush();
    });

    res.write("data: [DONE]\n\n");
    res.end();

  } catch (err) {
    const OLLAMA_CODES = new Set(["OLLAMA_FIRST_TOKEN_TIMEOUT", "OLLAMA_TOKEN_GAP_TIMEOUT"]);
    const isOllama     = OLLAMA_CODES.has(err.code);
    console.error(`[AI Stream] ${isOllama ? "Ollama" : "Unexpected"} error: ${err.message}`);

    if (res.headersSent) {
      // SSE headers are already sent — we cannot change the HTTP status code.
      // Send a structured error event so voice.py gets a speakable message,
      // then always send [DONE] so the client gets a clean stream termination.
      const msg = isOllama
        ? "I'm having trouble thinking right now. Try again in a moment."
        : "Something went wrong on my end.";
      try {
        res.write(`data: ${JSON.stringify({ __error: true, message: msg })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } catch { /* client already disconnected — ignore */ }
    } else {
      next(err);
    }
  }
});


module.exports = router;
