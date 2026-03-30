const mongoose = require("mongoose");

const reminderSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  text: {
    type: String,
    required: true
  },

  // ISO datetime string for when to fire
  reminderTime: {
    type: Date,
    required: true
  },

  status: {
    type: String,
    enum: ["pending", "fired", "cancelled"],
    default: "pending"
  },

  recurring: {
    type: Boolean,
    default: false
  }

}, {
  timestamps: true
});

module.exports = mongoose.model("Reminder", reminderSchema);
