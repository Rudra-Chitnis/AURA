const express = require("express");
const router = express.Router();

const { createLog, getLogs } = require("../services/logService");
const protect = require("../middleware/authMiddleware");

// GET recent logs (protected — dev/debug use)
router.get("/", protect, async (req, res, next) => {
  try {
    const logs = await getLogs();
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// POST a manual log entry
router.post("/", protect, async (req, res, next) => {
  try {
    const { message } = req.body;
    const log = await createLog(message || "manual log entry");
    res.status(201).json({ message: "Log stored", data: log });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
