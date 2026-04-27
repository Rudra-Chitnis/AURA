const express = require("express");
const router  = express.Router();

const { generateResponse, generateResponseStream } = require("../services/aiService");
const { searchMemory, correctQueryWithMemory }     = require("../services/memoryService");
const { createLog }                                = require("../services/logService");
const protect                                      = require("../middleware/authMiddleware");


// ─────────────────────────────────────────────
// POST /ask  — blocking, full response (fallback path)
// ─────────────────────────────────────────────
router.post("/ask", protect, async (req, res, next) => {
  try {
    const { query, time_context, history = [] } = req.body;

    if (!query) {
      return res.status(400).json({ message: "query is required" });
    }

    let memories = [], correctedQuery = query;
    try {
      memories       = await searchMemory(req.user._id, query);
      correctedQuery = correctQueryWithMemory(query, memories);
    } catch (memErr) {
      console.warn("[Memory] Search failed (non-fatal):", memErr.message);
    }

    console.log("Query:", query, "| Memories:", memories.length, "| History:", history.length);

    const answer = await generateResponse(correctedQuery, memories, time_context, history);

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

    let memories = [], correctedQuery = query;
    try {
      memories       = await searchMemory(req.user._id, query);
      correctedQuery = correctQueryWithMemory(query, memories);
    } catch (memErr) {
      console.warn("[Memory] Search failed (non-fatal):", memErr.message);
    }

    console.log("Stream query:", query, "| Memories:", memories.length, "| History:", history.length);

    await generateResponseStream(correctedQuery, memories, time_context, history, (token) => {
      res.write(`data: ${JSON.stringify(token)}\n\n`);
      if (typeof res.flush === "function") res.flush();
    });

    res.write("data: [DONE]\n\n");
    res.end();

  } catch (err) {
    if (res.headersSent) {
      console.error("Stream error after headers sent:", err.message);
      try { res.end(); } catch {}
    } else {
      next(err);
    }
  }
});


module.exports = router;
