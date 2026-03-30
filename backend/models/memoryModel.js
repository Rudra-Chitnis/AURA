const mongoose = require("mongoose");

const memorySchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true
  },

  content: {
    type: String,
    required: true
  },

  embedding: {
    type: [Number],
    required: true
  },

  // 🔥 NEW FIELD (YOU ADDED)
  type: {
    type: String,
    enum: ["personal", "schedule", "preference", "identity"],
    default: "personal"
  }

}, {
  timestamps: true
});

module.exports = mongoose.model("Memory", memorySchema);