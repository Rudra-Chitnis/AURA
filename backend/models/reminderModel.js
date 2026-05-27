const mongoose = require("mongoose");

// reminderService.js uses:
//   Reminder.create({ user, text, reminderTime, recurring })
//   Reminder.find({ user: userId, status: "pending" }).sort({ reminderTime: 1 })
//   Reminder.findOneAndUpdate({ _id, user }, { status: "cancelled" }, { new: true })
//   Reminder.findByIdAndUpdate(id, { status: "fired" }, { new: true })
//   Reminder.find({ status: "pending", reminderTime: { $lte: new Date() } })
//            .populate("user", "name email")

const reminderSchema = new mongoose.Schema(
  {
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },

    text: {
      type:     String,
      required: [true, "Reminder text is required"],
      trim:     true,
    },

    reminderTime: {
      type:     Date,
      required: [true, "Reminder time is required"],
      index:    true,
    },

    // Lifecycle state
    // pending  → scheduler fires it  → fired
    // fired    → voice.py pops it    → delivered
    // pending  → user cancels        → cancelled
    status: {
      type:    String,
      enum:    ["pending", "fired", "delivered", "cancelled"],
      default: "pending",
      index:   true,
    },

    // Whether this reminder should re-fire after firing
    recurring: {
      type:    Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

// Compound index for the scheduler's "due now" query
reminderSchema.index({ status: 1, reminderTime: 1 });

module.exports = mongoose.model("Reminder", reminderSchema);
