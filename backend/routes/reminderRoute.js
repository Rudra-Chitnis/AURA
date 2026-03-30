const express = require("express");
const router = express.Router();

const protect = require("../middleware/authMiddleware");
const {
  createReminder,
  getReminders,
  cancelReminder
} = require("../services/reminderService");
const { createLog } = require("../services/logService");


// CREATE REMINDER
// POST /api/reminders
// Body: { text, reminderTime, recurring }
// reminderTime can be an ISO string: "2025-05-01T19:00:00" or "today at 7pm"
// For voice parsing, send the resolved ISO time from the Python side
router.post("/", protect, async (req, res, next) => {
  try {
    const { text, reminderTime, recurring } = req.body;

    if (!text || !reminderTime) {
      return res.status(400).json({ message: "text and reminderTime are required" });
    }

    const reminder = await createReminder(req.user._id, text, reminderTime, recurring);

    await createLog(`[REMINDER] user=${req.user._id} set reminder: "${text}" at ${reminderTime}`);

    res.status(201).json({
      message: `Reminder set: "${text}"`,
      reminder
    });
  } catch (err) {
    next(err);
  }
});


// LIST PENDING REMINDERS
// GET /api/reminders
router.get("/", protect, async (req, res, next) => {
  try {
    const reminders = await getReminders(req.user._id);
    res.json({ reminders });
  } catch (err) {
    next(err);
  }
});


// CANCEL A REMINDER
// DELETE /api/reminders/:id
router.delete("/:id", protect, async (req, res, next) => {
  try {
    const reminder = await cancelReminder(req.user._id, req.params.id);
    res.json({ message: "Reminder cancelled", reminder });
  } catch (err) {
    next(err);
  }
});


module.exports = router;
