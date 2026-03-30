// Reminder Scheduler
// Polls MongoDB every 60 seconds for pending reminders that are due.
// When a reminder fires, it logs it and marks it as fired.
// The voice layer (voice.py) polls GET /api/reminders/due to play fired reminders aloud.

const { getDueReminders, fireReminder } = require("../services/reminderService");
const { createLog } = require("../services/logService");

// In-memory list of recently fired reminders the voice client can pull
const firedQueue = [];

const startReminderScheduler = () => {
  console.log("Reminder scheduler started — checking every 60s");

  setInterval(async () => {
    try {
      const due = await getDueReminders();

      for (const reminder of due) {
        console.log(`Firing reminder: "${reminder.text}" for user ${reminder.user._id}`);

        await fireReminder(reminder._id);
        await createLog(`[SCHEDULER] Fired reminder id=${reminder._id} text="${reminder.text}"`);

        // Push to the voice-client queue
        firedQueue.push({
          reminderId: reminder._id,
          userId: reminder.user._id.toString(),
          text: reminder.text,
          firedAt: new Date()
        });
      }

    } catch (err) {
      console.error("Scheduler error:", err.message);
    }
  }, 60 * 1000); // every 60 seconds
};


// Returns and clears fired reminders for a specific user
// Called by GET /api/reminders/pending-voice
const popFiredForUser = (userId) => {
  const forUser = firedQueue.filter(r => r.userId === userId);
  // Remove from queue
  forUser.forEach(r => {
    const idx = firedQueue.indexOf(r);
    if (idx > -1) firedQueue.splice(idx, 1);
  });
  return forUser;
};


module.exports = { startReminderScheduler, popFiredForUser };
