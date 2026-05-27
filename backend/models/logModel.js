const mongoose = require("mongoose");

// logService.js uses:
//   new Log({ message })
//   Log.find().sort({ time: -1 }).limit(limit)
// so the timestamp field must be named "time".

const logSchema = new mongoose.Schema({
  message: {
    type:     String,
    required: true,
    trim:     true,
  },
  time: {
    type:    Date,
    default: Date.now,
    index:   true,
  },
});

module.exports = mongoose.model("Log", logSchema);
