const mongoose = require("mongoose");

const diagnosticEventSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },
    source: {
      type: String,
      enum: ["backend", "voice", "electron", "frontend", "system"],
      default: "backend",
      index: true,
    },
    type: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    severity: {
      type: String,
      enum: ["info", "warn", "error"],
      default: "info",
      index: true,
    },
    issue: {
      type: String,
      default: null,
      trim: true,
    },
    cause: {
      type: String,
      default: null,
      trim: true,
    },
    data: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

diagnosticEventSchema.index({ user: 1, createdAt: -1 });
diagnosticEventSchema.index({ createdAt: -1 });

module.exports = mongoose.model("DiagnosticEvent", diagnosticEventSchema);
