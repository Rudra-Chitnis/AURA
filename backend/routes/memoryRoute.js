const express = require("express");
const router = express.Router();

const protect = require("../middleware/authMiddleware");
const auraRuntime = require("../auraRuntime");


// STORE A MEMORY
router.post("/store", protect, async (req, res, next) => {
  try {
    const { content, type } = req.body;

    if (!content) {
      return res.status(400).json({ message: "content is required" });
    }

    const memory = await auraRuntime.memory.store(req.user._id, content, type);

    res.status(201).json({
      message: "Memory stored",
      memory
    });
  } catch (err) {
    next(err);
  }
});


// LIST ALL MEMORIES FOR USER
router.get("/list", protect, async (req, res, next) => {
  try {
    const memories = await auraRuntime.memory.list(req.user._id);
    res.json({ memories });
  } catch (err) {
    next(err);
  }
});


// LIST CONSOLIDATED SEMANTIC PATTERNS
router.get("/patterns", protect, async (req, res, next) => {
  try {
    const patterns = await auraRuntime.semanticLearning.getSummary(req.user._id);
    res.json({ patterns });
  } catch (err) {
    next(err);
  }
});


// SEARCH MEMORY BY QUERY
router.post("/search", protect, async (req, res, next) => {
  try {
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({ message: "query is required" });
    }

    const results = await auraRuntime.memory.search(req.user._id, query);
    res.json({ results });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
