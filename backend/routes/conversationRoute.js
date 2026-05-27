const express  = require("express");
const router   = express.Router();
const protect  = require("../middleware/authMiddleware");
const { saveHistory, loadHistory } = require("../services/conversationService");
const {
  sanitizeAssistantOutput,
  isMalformedAssistantOutput,
  isSpeakableFinalOutput,
} = require("../services/aiService");


// ─────────────────────────────────────────────
// GET /api/conversation/history
//
// Returns the last 20 persisted turns for the authenticated user.
// Called once by voice.py on startup to restore _conversation_history.
//
// Response: { turns: [{ role, content }, ...] }
// ─────────────────────────────────────────────
router.get("/history", protect, async (req, res, next) => {
  try {
    const turns = await loadHistory(req.user._id, 20);
    res.json({ turns });
  } catch (err) {
    next(err);
  }
});


// ─────────────────────────────────────────────
// POST /api/conversation/history
//
// Appends one or more turns to the user's persisted history.
// Called by voice.py after each Q+A turn, fire-and-forget from a daemon thread.
//
// Body: { turns: [{ role: "user"|"assistant", content: string }, ...] }
// Response: { ok: true, stored: N }
// ─────────────────────────────────────────────
router.post("/history", protect, async (req, res, next) => {
  try {
    const { turns } = req.body;

    if (!Array.isArray(turns) || turns.length === 0) {
      return res.status(400).json({ message: "turns array required" });
    }

    // Validate each turn before writing — reject malformed entries
    const structurallyValid = turns.filter(
      t => t && (t.role === "user" || t.role === "assistant") && typeof t.content === "string" && t.content.trim()
    );

    const valid = [];
    for (const turn of structurallyValid) {
      if (turn.role === "assistant") {
        const clean = sanitizeAssistantOutput(turn.content);
        if (!clean || isMalformedAssistantOutput(clean) || !isSpeakableFinalOutput(clean)) {
          if (valid.length && valid[valid.length - 1].role === "user") valid.pop();
          continue;
        }
        valid.push({ role: "assistant", content: clean });
      } else {
        valid.push({ role: "user", content: turn.content.trim() });
      }
    }

    if (valid.length === 0) {
      return res.status(400).json({ message: "no valid turns in request" });
    }

    await saveHistory(req.user._id, valid);
    res.json({ ok: true, stored: valid.length });

  } catch (err) {
    next(err);
  }
});


module.exports = router;
