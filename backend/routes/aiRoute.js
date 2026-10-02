const express = require("express");
const router  = express.Router();

const { runConversationTurn }                     = require("../core/conversationTurn");
const diagnostics                                  = require("../services/runtimeDiagnosticsService");
const { createLog }                                = require("../services/logService");
const protect                                      = require("../middleware/authMiddleware");

// ─────────────────────────────────────────────
// POST /ask  — blocking, full response (fallback path)
// ─────────────────────────────────────────────
router.post("/ask", protect, async (req, res, next) => {
  try {
    const { query, time_context, correction_occurred = false } = req.body;

    if (!query) {
      return res.status(400).json({ message: "query is required" });
    }

    const result = await runConversationTurn({
      userId: req.user._id,
      query,
      timeContext: time_context,
      correctionOccurred: correction_occurred,
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

    await runConversationTurn({
      userId: req.user._id,
      query,
      timeContext: time_context,
      correctionOccurred: correction_occurred,
      onToken: token => {
        res.write(`data: ${JSON.stringify(token)}\n\n`);
        if (typeof res.flush === "function") res.flush();
      },
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
