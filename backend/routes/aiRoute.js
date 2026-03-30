const express = require("express");
const router = express.Router();

const { generateResponse } = require("../services/aiService");
const { searchMemory, correctQueryWithMemory } = require("../services/memoryService");
const { createLog } = require("../services/logService");
const protect = require("../middleware/authMiddleware");


router.post("/ask", protect, async (req, res, next) => {
  try {
    const { query, time_context } = req.body;

    if (!query) {
      return res.status(400).json({ message: "query is required" });
    }

    const memories = await searchMemory(req.user._id, query);
    const filteredMemories = memories;

    const correctedQuery = correctQueryWithMemory(query, filteredMemories);

    console.log("Query:", query);
    console.log("Memories found:", filteredMemories.length);

    const answer = await generateResponse(correctedQuery, filteredMemories, time_context);

    await createLog(`[ASK] user=${req.user._id} query="${query}" memories=${filteredMemories.length}`);

    res.json({ answer, memories: filteredMemories });

  } catch (err) {
    next(err);
  }
});

module.exports = router;
