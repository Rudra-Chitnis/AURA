const mongoose = require("mongoose");

// ─────────────────────────────────────────────
// ConversationHistory model
//
// One document per user.  Each document holds an array of turns (user +
// assistant messages) bounded by MAX_HISTORY_TURNS via MongoDB's
// $push.$slice operator — no separate prune step required.
//
// This is the persistence tier for voice.py's _conversation_history deque.
// It provides restart continuity without changing the in-session deque logic.
//
// Relationship to Memory collection:
//   - Memory:  long-term facts about the user (persistent, semantic retrieval)
//   - History: recent conversational exchanges (bounded, restart continuity)
//   These are intentionally separate collections and must not be merged.
//
// Future integration note:
//   A future reflection / world-model system can read this collection to
//   periodically summarise history into Memory entries.  The `savedAt` field
//   on each turn provides the temporal boundary for that summarisation pass.
// ─────────────────────────────────────────────

const MAX_HISTORY_TURNS = 40; // 20 Q+A pairs stored in MongoDB per user

const turnSchema = new mongoose.Schema(
  {
    role:    { type: String, enum: ["user", "assistant"], required: true },
    content: { type: String, required: true },
    savedAt: { type: Date,   default: Date.now },
  },
  { _id: false }   // sub-documents — no individual _id needed
);

const conversationHistorySchema = new mongoose.Schema(
  {
    user: {
      type:     mongoose.Schema.Types.ObjectId,
      ref:      "User",
      required: true,
      unique:   true,   // one document per user, always upserted
      index:    true,
    },

    // Bounded array of recent turns.  Truncated server-side via $push.$slice
    // so the document never exceeds MAX_HISTORY_TURNS entries.
    turns: {
      type:    [turnSchema],
      default: [],
    },

    updatedAt: { type: Date, default: Date.now },
  },
  { timestamps: false }   // manual updatedAt to avoid confusion with sub-doc timestamps
);

conversationHistorySchema.statics.MAX_HISTORY_TURNS = MAX_HISTORY_TURNS;

module.exports = mongoose.model("ConversationHistory", conversationHistorySchema);
