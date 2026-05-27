const ConversationHistory = require("../models/conversationModel");

const MAX_HISTORY_TURNS = ConversationHistory.schema.statics.MAX_HISTORY_TURNS;

// ─────────────────────────────────────────────
// saveHistory
//
// Append `newTurns` to the user's history document and atomically trim the
// array to the last MAX_HISTORY_TURNS entries.
//
// Uses $push with $each + $slice (negative) — a single atomic MongoDB
// operation that appends and truncates in one round-trip.  No separate prune
// step is required.  Concurrent calls to saveHistory for the same user are
// serialised by MongoDB's document-level write lock, so insertion order is
// always preserved.
//
// newTurns: array of { role: "user"|"assistant", content: string }
// ─────────────────────────────────────────────
const saveHistory = async (userId, newTurns) => {
  if (!newTurns || newTurns.length === 0) return;

  const stamped = newTurns.map(t => ({
    role:    t.role,
    content: t.content,
    savedAt: new Date(),
  }));

  await ConversationHistory.findOneAndUpdate(
    { user: userId },
    {
      $push:      { turns: { $each: stamped, $slice: -MAX_HISTORY_TURNS } },
      $set:       { updatedAt: new Date() },
    },
    { upsert: true, new: false }   // upsert: create document if missing
  );
};


// ─────────────────────────────────────────────
// loadHistory
//
// Return the last `limit` turns for the user, in chronological order
// (oldest-first, matching the order they were appended).
//
// Returns an array of { role, content } objects — `savedAt` is stripped
// before returning so callers never accidentally inject timestamps into
// the LLM prompt.
//
// If no history exists for the user, returns an empty array (graceful
// degradation — voice.py starts with an empty deque, which is correct).
// ─────────────────────────────────────────────
const loadHistory = async (userId, limit = 20) => {
  const doc = await ConversationHistory.findOne({ user: userId }).lean();
  if (!doc || !doc.turns || doc.turns.length === 0) return [];

  // Slice to last `limit` turns, then strip savedAt before returning
  return doc.turns
    .slice(-limit)
    .map(t => ({ role: t.role, content: t.content }));
};

const removeLastPair = async (userId) => {
  const doc = await ConversationHistory.findOne({ user: userId });
  if (!doc || !Array.isArray(doc.turns) || doc.turns.length === 0) return 0;

  let removed = 0;
  while (doc.turns.length && removed < 2) {
    doc.turns.pop();
    removed++;
  }
  doc.updatedAt = new Date();
  await doc.save();
  return removed;
};

module.exports = { saveHistory, loadHistory, removeLastPair };
