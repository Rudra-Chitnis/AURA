const Reminder = require("../models/reminderModel");


// CREATE REMINDER
const createReminder = async (userId, text, reminderTime, recurring = false) => {
  const reminder = await Reminder.create({
    user: userId,
    text,
    reminderTime: new Date(reminderTime),
    recurring
  });

  return reminder;
};


// GET ALL PENDING REMINDERS FOR USER
const getReminders = async (userId) => {
  return await Reminder.find({ user: userId, status: "pending" })
    .sort({ reminderTime: 1 });
};


// CANCEL A REMINDER
const cancelReminder = async (userId, reminderId) => {
  const reminder = await Reminder.findOneAndUpdate(
    { _id: reminderId, user: userId },
    { status: "cancelled" },
    { new: true }
  );

  if (!reminder) {
    throw new Error("Reminder not found");
  }

  return reminder;
};


// MARK REMINDER AS FIRED — atomic guard prevents double-fire.
// Uses findOneAndUpdate with status:"pending" condition so a second concurrent
// scheduler tick (e.g. after a crash-restart) cannot fire the same reminder twice.
// Returns null if the reminder was already fired/cancelled/delivered.
const fireReminder = async (reminderId) => {
  return await Reminder.findOneAndUpdate(
    { _id: reminderId, status: "pending" },  // atomic: only fires if still pending
    { status: "fired" },
    { new: true }
  );
};


// MARK REMINDER AS DELIVERED — called after voice.py successfully pops and speaks it.
// Transitions fired → delivered so the lifecycle is fully auditable in MongoDB.
// No-op if already delivered (idempotent).
const markDelivered = async (reminderId) => {
  return await Reminder.findOneAndUpdate(
    { _id: reminderId, status: "fired" },    // only advance if still in fired state
    { status: "delivered" },
    { new: true }
  );
};


// GET ALL PENDING REMINDERS DUE NOW OR EARLIER (used by scheduler)
// Limit to 50 to prevent runaway batch after extended offline period.
const getDueReminders = async () => {
  return await Reminder.find({
    status: "pending",
    reminderTime: { $lte: new Date() }
  })
    .populate("user", "name email")
    .limit(50);
};


module.exports = {
  createReminder,
  getReminders,
  cancelReminder,
  fireReminder,
  markDelivered,
  getDueReminders
};
