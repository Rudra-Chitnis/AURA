const express = require("express");
const router = express.Router();

const protect = require("../middleware/authMiddleware");
const diagnostics = require("../services/runtimeDiagnosticsService");

router.get("/recent", protect, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 80, 200);
  const events = await diagnostics.recent(req.user._id, limit);
  res.json({ events });
});

router.get("/summary", protect, async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 80, 200);
  const summary = await diagnostics.summarize(req.user._id, limit);
  res.json({ summary });
});

router.post("/event", protect, async (req, res) => {
  const event = diagnostics.record({
    ...req.body,
    user: req.user._id,
    source: req.body?.source || "frontend",
  });
  res.json({ ok: true, event });
});

router.post("/explain", protect, async (req, res) => {
  const limit = Math.min(Number(req.body?.limit) || 80, 200);
  const summary = await diagnostics.summarize(req.user._id, limit);
  const explanation = await diagnostics.renderExplanationWithLLM(summary);
  res.json({ summary, explanation });
});

module.exports = router;
