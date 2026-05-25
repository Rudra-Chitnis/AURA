// Reminder Scheduler
// Polls MongoDB every 60 seconds for pending reminders that are due.
// When a reminder fires it marks it status:"fired" and pushes it to firedQueue.
// voice.py polls GET /api/reminders/pending-voice → popFiredForUser() to speak them.
// After a successful pop, markDelivered() advances status fired → delivered.
//
// Startup recovery (_recoverUndelivered): on backend restart, any reminder that
// was marked "fired" in the last 10 minutes but never delivered (e.g. backend crashed
// between fireReminder() and the voice client polling) is re-enqueued automatically.

const { getDueReminders, fireReminder, markDelivered } = require("../services/reminderService");
const { createLog }                                    = require("../services/logService");
const Reminder                                         = require("../models/reminderModel");

// In-memory queue of recently fired reminders the voice client can pull.
// Entries: { reminderId: ObjectId, userId: string, text: string, firedAt: Date }
const firedQueue = [];

// ─────────────────────────────────────────────
// STARTUP RECOVERY
// Re-enqueue any reminders that were fired (status:"fired") in the last 10 minutes
// but never popped by voice.py (i.e. backend restarted before delivery).
// This prevents reminders from silently disappearing after a crash-restart cycle.
// ─────────────────────────────────────────────
const _recoverUndelivered = async () => {
  try {
    const TEN_MINUTES_AGO = new Date(Date.now() - 10 * 60 * 1000);
    const undelivered = await Reminder.find({
      status:    "fired",
      updatedAt: { $gte: TEN_MINUTES_AGO },
    }).populate("user", "name email");

    if (undelivered.length === 0) return;

    console.log(`[Scheduler] Recovering ${undelivered.length} undelivered reminder(s) from last restart`);

    for (const r of undelivered) {
      // Avoid duplicates if somehow already in the queue (shouldn't happen on startup)
      const alreadyQueued = firedQueue.some(q => q.reminderId.toString() === r._id.toString());
      if (alreadyQueued) continue;

      firedQueue.push({
        reminderId: r._id,
        userId:     r.user._id.toString(),
        text:       r.text,
        firedAt:    r.updatedAt,
      });
      console.log(`[Scheduler] Re-enqueued reminder id=${r._id} text="${r.text}"`);
    }
  } catch (err) {
    console.error("[Scheduler] Recovery scan failed (non-fatal):", err.message);
  }
};


// ─────────────────────────────────────────────
// SCHEDULER ENTRY POINT
// ─────────────────────────────────────────────
const startReminderScheduler = async () => {
  console.log("[Scheduler] Reminder scheduler started — checking every 60s");

  // Run recovery once at startup before the first interval tick
  await _recoverUndelivered();

  setInterval(async () => {
    try {
      const due = await getDueReminders();

      for (const reminder of due) {
        // Atomic fire — returns null if reminder was already fired/cancelled
        const fired = await fireReminder(reminder._id);
        if (!fired) {
          // Already fired by a previous tick or concurrent process — skip
          console.warn(`[Scheduler] Reminder id=${reminder._id} already fired — skipping duplicate`);
          continue;
        }

        console.log(`[Scheduler] Fired reminder: "${reminder.text}" for user ${reminder.user._id}`);
        await createLog(`[SCHEDULER] Fired reminder id=${reminder._id} text="${reminder.text}"`);

        firedQueue.push({
          reminderId: reminder._id,
          userId:     reminder.user._id.toString(),
          text:       reminder.text,
          firedAt:    new Date(),
        });
      }

    } catch (err) {
      console.error("[Scheduler] Tick error:", err.message);
    }
  }, 60 * 1000);
};


// ─────────────────────────────────────────────
// POP FIRED REMINDERS FOR USER
// Returns all queued reminders for userId and removes them from firedQueue.
// Uses reverse-splice so in-place removal is index-stable.
// Fires markDelivered() for each popped reminder (fire-and-forget — voice.py
// should not block on the DB write; delivery is already guaranteed by the pop).
// ─────────────────────────────────────────────
const popFiredForUser = (userId) => {
  const popped = [];

  for (let i = firedQueue.length - 1; i >= 0; i--) {
    if (firedQueue[i].userId === userId) {
      popped.push(firedQueue[i]);
      firedQueue.splice(i, 1);
    }
  }

  // Advance status fired → delivered for each popped reminder (non-blocking)
  for (const r of popped) {
    markDelivered(r.reminderId).catch((err) =>
      console.warn(`[Scheduler] markDelivered failed for id=${r.reminderId}:`, err.message)
    );
  }

  return popped;
};


module.exports = { startReminderScheduler, popFiredForUser };
