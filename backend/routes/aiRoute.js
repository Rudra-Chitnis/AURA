const express = require("express");
const router  = express.Router();

const { generateResponse, generateResponseStream, classifyQuery, isSummaryRequest, detectIdentityEntities } = require("../services/aiService");
const { searchMemory }                             = require("../services/memoryService");
const { withUserTurnLock, loadPromptHistory, persistCleanTurn, removeLastPair } = require("../services/turnRuntime");
const conversationState                            = require("../services/conversationStateService");
const memoryConsolidation                         = require("../services/memoryConsolidationService");
const diagnostics                                  = require("../services/runtimeDiagnosticsService");
const { createLog }                                = require("../services/logService");
const protect                                      = require("../middleware/authMiddleware");
const dbg                                          = require("../utils/debugLogger");

const keepPromptMemory = (queryType, query, memory) => {
  if (queryType === "personal") return true;
  const q = (query || "").toLowerCase();
  const score = memory.score || 0;
  if (score >= (queryType === "opinion" ? 0.68 : 0.62)) return true;
  return [memory.person, memory.attribute, memory.value]
    .filter(Boolean)
    .some(v => q.includes(String(v).toLowerCase()));
};

const recordTurnDiagnostics = (userId, query, baseType, semanticTurn, gatePass, memories) => {
  if (baseType !== semanticTurn.queryType) {
    diagnostics.record({
      user: userId,
      source: "backend",
      type: "classification_context_override",
      data: { query, baseType, queryType: semanticTurn.queryType },
    });
  }
  if (semanticTurn.referential && !semanticTurn.entity && !semanticTurn.topic) {
    diagnostics.record({
      user: userId,
      source: "backend",
      type: "semantic_resolution_failure",
      data: { query, baseType, queryType: semanticTurn.queryType },
    });
  }
  diagnostics.record({
    user: userId,
    source: "backend",
    type: "turn_routing",
    severity: "info",
    data: {
      query,
      baseType,
      queryType: semanticTurn.queryType,
      gatePass,
      memories: memories.length,
      entity: semanticTurn.entity?.name || "",
      topic: semanticTurn.topic?.name || "",
    },
  });
};

const observeSemanticLearning = async (userId, query, queryType, semanticTurn) => {
  try {
    await memoryConsolidation.observeTurn({ userId, query, queryType, semanticTurn });
  } catch (err) {
    diagnostics.record({
      user: userId,
      source: "backend",
      type: "memory_consolidation_failed",
      data: { error: err.message },
    });
  }
};

// ─────────────────────────────────────────────
// POST /ask  — blocking, full response (fallback path)
// ─────────────────────────────────────────────
router.post("/ask", protect, async (req, res, next) => {
  try {
    const { query, time_context, correction_occurred = false } = req.body;

    if (!query) {
      return res.status(400).json({ message: "query is required" });
    }

    const result = await withUserTurnLock(req.user._id, async () => {
      if (correction_occurred) await removeLastPair(req.user._id);
      const history = await loadPromptHistory(req.user._id);

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
    //      NOTE: GENERAL_QUERY_RE now also covers conversational phrasing like
    //      "talk about X", "let's discuss Y", "i want to know about Z" — these
    //      still return "general", keeping the gate CLOSED (correct: no personal
    //      memory search needed for open-ended general topic queries).
    //   2. detectIdentityEntities finds a canonical name — defense-in-depth: even if
    //      classifyQuery somehow returned "general" for an identity query, this check
    //      guarantees memory search still runs for any canonical entity mention.
    //   3. isSummaryRequest — summary requests need memory regardless of type.
    let memories = [];
    const baseType       = classifyQuery(query, []);
    const semanticTurn   = conversationState.beginTurn(req.user._id, query, baseType, { correction: correction_occurred });
    const queryType      = semanticTurn.queryType;
    const memoryQuery    = semanticTurn.memoryQuery || query;
    const { isIdentity } = detectIdentityEntities(memoryQuery);
    const isSummary      = isSummaryRequest(query);
    const gatePass       = queryType !== "general" || isIdentity || isSummary || Boolean(semanticTurn.entity?.mode === "personal");

    try { if (dbg.DEBUG) dbg.memoryGate(query, queryType, isIdentity, isSummary, gatePass); } catch (_) {}

    if (gatePass) {
      try {
        memories = (await searchMemory(req.user._id, memoryQuery))
          .filter(m => keepPromptMemory(queryType, memoryQuery, m));
      } catch (memErr) {
        console.warn("[Memory] Search failed (non-fatal):", memErr.message);
        diagnostics.record({
          user: req.user._id,
          source: "backend",
          type: "memory_search_failed",
          data: { query: memoryQuery, error: memErr.message },
        });
      }
    }

      recordTurnDiagnostics(req.user._id, query, baseType, semanticTurn, gatePass, memories);
      console.log("Query:", query, "| QueryType:", queryType, "| Memories:", memories.length, "| History:", history.length);

      const answer = await generateResponse(query, memories, time_context, history, semanticTurn);
      await persistCleanTurn(req.user._id, query, answer);
      conversationState.endTurn(req.user._id, { ...semanticTurn, queryType });
      await observeSemanticLearning(req.user._id, query, queryType, semanticTurn);
      return { answer, memories };
    });

    await createLog(`[ASK] user=${req.user._id} query="${query}" memories=${result.memories.length}`);

    res.json(result);

  } catch (err) {
    diagnostics.record({
      user: req.user?._id,
      source: "backend",
      type: err.code && String(err.code).startsWith("OLLAMA_") ? "generation_timeout" : "stream_abort",
      severity: err.code && String(err.code).startsWith("OLLAMA_") ? "error" : "warn",
      data: { code: err.code || "", error: err.message },
    });
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
    const { query, time_context, correction_occurred = false } = req.body;

    if (!query) {
      return res.status(400).json({ message: "query is required" });
    }

    // Flush headers immediately so the client starts listening
    res.setHeader("Content-Type",  "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection",    "keep-alive");
    res.flushHeaders();

    await withUserTurnLock(req.user._id, async () => {
    if (correction_occurred) await removeLastPair(req.user._id);
    const history = await loadPromptHistory(req.user._id);

    // Only search memory when the query has personal relevance.
    // See /ask endpoint comment above for full reasoning.
    // NOTE: detectIdentityEntities guard added here (mirrors /ask) — the original
    // /ask-stream gate was missing the isIdentity failsafe (Section 45 fix).
    // NOTE: GENERAL_QUERY_RE expansion (conversational phrasing) still returns
    // "general" for open-ended topic queries — gate stays closed for those, which
    // is correct (no personal memory search needed for "talk about geopolitics").
    let memories = [];
    const baseType       = classifyQuery(query, []);
    const semanticTurn   = conversationState.beginTurn(req.user._id, query, baseType, { correction: correction_occurred });
    const queryType      = semanticTurn.queryType;
    const memoryQuery    = semanticTurn.memoryQuery || query;
    const { isIdentity } = detectIdentityEntities(memoryQuery);
    const isSummary      = isSummaryRequest(query);
    const gatePass       = queryType !== "general" || isIdentity || isSummary || Boolean(semanticTurn.entity?.mode === "personal");

    try { if (dbg.DEBUG) dbg.memoryGate(query, queryType, isIdentity, isSummary, gatePass); } catch (_) {}

    if (gatePass) {
      try {
        memories = (await searchMemory(req.user._id, memoryQuery))
          .filter(m => keepPromptMemory(queryType, memoryQuery, m));
      } catch (memErr) {
        console.warn("[Memory] Search failed (non-fatal):", memErr.message);
        diagnostics.record({
          user: req.user._id,
          source: "backend",
          type: "memory_search_failed",
          data: { query: memoryQuery, error: memErr.message },
        });
      }
    }

    recordTurnDiagnostics(req.user._id, query, baseType, semanticTurn, gatePass, memories);
    console.log("Stream query:", query, "| QueryType:", queryType, "| Memories:", memories.length, "| History:", history.length);

    let assistantText = "";
    await generateResponseStream(query, memories, time_context, history, (token) => {
      assistantText += token;
      res.write(`data: ${JSON.stringify(token)}\n\n`);
      if (typeof res.flush === "function") res.flush();
    }, correction_occurred, semanticTurn);

    await persistCleanTurn(req.user._id, query, assistantText);
    conversationState.endTurn(req.user._id, { ...semanticTurn, queryType });
    await observeSemanticLearning(req.user._id, query, queryType, semanticTurn);
    });

    res.write("data: [DONE]\n\n");
    res.end();

  } catch (err) {
    const OLLAMA_CODES = new Set(["OLLAMA_FIRST_TOKEN_TIMEOUT", "OLLAMA_TOKEN_GAP_TIMEOUT"]);
    const isOllama     = OLLAMA_CODES.has(err.code);
    diagnostics.record({
      user: req.user?._id,
      source: "backend",
      type: isOllama ? "generation_timeout" : "stream_abort",
      severity: isOllama ? "error" : "warn",
      data: { code: err.code || "", error: err.message },
    });
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
