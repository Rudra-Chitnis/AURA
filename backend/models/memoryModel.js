const mongoose = require("mongoose");

// memoryService.js uses these fields:
//   user         ObjectId ref User     — query filter, required
//   content      String                — plain-text memory content
//   embedding    [Number]              — vector for cosine similarity search
//   type         String                — "personal" | "preference" | "general"
//   confidence   String                — "high" | "medium" | "low"
//   person       String                — "user" or a name (null for plain-text)
//   attribute    String                — e.g. "name", "likes", "lives_in"
//   value        String                — the attribute value
//   createdAt    Date                  — used for recency boost + pruning order

const memorySchema = new mongoose.Schema(
  {
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      index:    true,
    },

    // Primary text content (always present)
    content: {
      type:     String,
      required: true,
      trim:     true,
    },

    // Sentence embedding — array of floats (384-dim for all-MiniLM-L6-v2)
    embedding: {
      type:    [Number],
      default: [],
    },

    // Memory category — used by the LLM routing logic
    type: {
      type:    String,
      enum:    ["personal", "preference", "general"],
      default: "personal",
    },

    // Extraction confidence
    confidence: {
      type:    String,
      enum:    ["high", "medium", "low"],
      default: "high",
    },

    // Structured fields — set when parseStructuredMemory() succeeds
    // person:    "user" or a specific name (e.g. "sadgi")
    // attribute: normalized attribute key (e.g. "likes", "lives_in", "name")
    // value:     the extracted value (e.g. "coffee", "Mumbai")
    person: {
      type:    String,
      default: null,
    },
    attribute: {
      type:    String,
      default: null,
    },
    value: {
      type:    String,
      default: null,
    },
  },
  {
    timestamps: true,   // provides createdAt used by recency scoring + pruning
  }
);

// Index for fast per-user retrieval and deduplication queries
memorySchema.index({ user: 1, person: 1, attribute: 1 });
memorySchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model("Memory", memorySchema);
