const mongoose = require("mongoose");

const semanticPatternSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    key: {
      type: String,
      required: true,
      trim: true,
    },
    label: {
      type: String,
      required: true,
      trim: true,
    },
    category: {
      type: String,
      enum: ["interest", "workflow", "preference", "habit", "project", "topic"],
      default: "interest",
    },
    memoryText: {
      type: String,
      default: "",
      trim: true,
    },
    confidence: {
      type: Number,
      default: 0,
      min: 0,
      max: 1,
    },
    evidenceCount: {
      type: Number,
      default: 0,
      min: 0,
    },
    status: {
      type: String,
      enum: ["candidate", "consolidated", "decayed", "contradicted"],
      default: "candidate",
      index: true,
    },
    signalTerms: {
      type: [String],
      default: [],
    },
    firstSeenAt: {
      type: Date,
      default: Date.now,
    },
    lastSeenAt: {
      type: Date,
      default: Date.now,
      index: true,
    },
    consolidatedMemory: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Memory",
      default: null,
    },
  },
  { timestamps: true }
);

semanticPatternSchema.index({ user: 1, key: 1 }, { unique: true });
semanticPatternSchema.index({ user: 1, status: 1, confidence: -1 });

module.exports = mongoose.model("SemanticPattern", semanticPatternSchema);
