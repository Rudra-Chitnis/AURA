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


// MARK REMINDER AS FIRED (used by scheduler)
const fireReminder = async (reminderId) => {
  return await Reminder.findByIdAndUpdate(
    reminderId,
    { status: "fired" },
    { new: true }
  );
};


// GET ALL PENDING REMINDERS DUE NOW OR EARLIER (used by scheduler)
const getDueReminders = async () => {
  return await Reminder.find({
    status: "pending",
    reminderTime: { $lte: new Date() }
  }).populate("user", "name email");
};


module.exports = {
  createReminder,
  getReminders,
  cancelReminder,
  fireReminder,
  getDueReminders
};
