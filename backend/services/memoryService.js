const Memory = require("../models/memoryModel");
const { generateEmbedding } = require("./embeddingService");
const cosineSimilarity = require("../utils/similarity");


// STORE MEMORY
const storeMemory = async (userId, content, type) => {
  const embedding = await generateEmbedding(content);

  const memory = await Memory.create({
    user: userId,
    content,
    embedding,
    type: type || "personal"
  });

  return memory;
};


// GET ALL MEMORIES FOR A USER (no embedding returned — saves bandwidth)
const getMemories = async (userId) => {
  return await Memory.find({ user: userId })
    .select("-embedding")
    .sort({ createdAt: -1 });
};


// SEARCH MEMORY — cosine similarity against query embedding
const searchMemory = async (userId, query) => {
  const queryEmbedding = await generateEmbedding(query);
  const memories = await Memory.find({ user: userId });

  const results = memories
    .filter(mem => mem.embedding && mem.embedding.length > 0)
    .map(mem => ({
      content: mem.content,
      type: mem.type,
      score: cosineSimilarity(queryEmbedding, mem.embedding)
    }))
    .filter(result => result.score > 0.2)  // lowered from 0.3 — catches more relevant memories
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  return results;
};


// CONTEXT-AWARE QUERY CORRECTION
// Single source of truth — backend only. voice.py no longer does this.
const correctQueryWithMemory = (query, memories) => {
  if (!memories || memories.length === 0) return query;

  const topMemory = memories[0].content.toLowerCase();
  let correctedQuery = query.toLowerCase();

  if (correctedQuery.includes("day") && topMemory.includes("date")) {
    correctedQuery = correctedQuery.replace("day", "date");
  }
  if (correctedQuery.includes("data") && topMemory.includes("date")) {
    correctedQuery = correctedQuery.replace("data", "date");
  }

  return correctedQuery;
};


module.exports = {
  storeMemory,
  getMemories,
  searchMemory,
  correctQueryWithMemory
};


