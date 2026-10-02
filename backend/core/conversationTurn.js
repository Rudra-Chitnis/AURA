"use strict";

// Conversation-turn orchestration composed from the existing backend runtime
// services. HTTP and SSE transport concerns remain in aiRoute.
const {
  generateResponse,
  generateResponseStream,
  classifyQuery,
  isSummaryRequest,
  detectIdentityEntities,
} = require("./aiCapability");
const { searchMemory } = require("../services/memoryService");
const {
  withUserTurnLock,
  loadPromptHistory,
  persistCleanTurn,
  removeLastPair,
} = require("../services/turnRuntime");
const conversationState = require("../services/conversationStateService");
const memoryConsolidation = require("../services/memoryConsolidationService");
const diagnostics = require("../services/runtimeDiagnosticsService");
const dbg = require("../utils/debugLogger");

const keepPromptMemory = (queryType, query, memory) => {
  if (queryType === "personal") return true;
  const q = (query || "").toLowerCase();
  const score = memory.score || 0;
  if (score >= (queryType === "opinion" ? 0.68 : 0.62)) return true;
  return [memory.person, memory.attribute, memory.value]
    .filter(Boolean)
    .some(value => q.includes(String(value).toLowerCase()));
};

const recordTurnDiagnostics = (userId, query, baseType, semanticTurn, gatePass, memories) => {
  if (baseType !== semanticTurn.queryType) {
    diagnostics.record({
      user: userId,
      source: "backend",
      type: "classification_context_override",
      data: { query, baseType, queryType: semanticTurn.queryType },
    });
  }
  if (semanticTurn.referential && !semanticTurn.entity && !semanticTurn.topic) {
    diagnostics.record({
      user: userId,
      source: "backend",
      type: "semantic_resolution_failure",
      data: { query, baseType, queryType: semanticTurn.queryType },
    });
  }
  diagnostics.record({
    user: userId,
    source: "backend",
    type: "turn_routing",
    severity: "info",
    data: {
      query,
      baseType,
      queryType: semanticTurn.queryType,
      gatePass,
      memories: memories.length,
      entity: semanticTurn.entity?.name || "",
      topic: semanticTurn.topic?.name || "",
    },
  });
};

const observeSemanticLearning = async (userId, query, queryType, semanticTurn) => {
  try {
    await memoryConsolidation.observeTurn({ userId, query, queryType, semanticTurn });
  } catch (err) {
    diagnostics.record({
      user: userId,
      source: "backend",
      type: "memory_consolidation_failed",
      data: { error: err.message },
    });
  }
};

/**
 * Run one serialized conversation turn.
 * Pass onToken to use the existing streaming AI path; the callback receives
 * generated chunks, while the returned answer is the concatenated text.
 */
const runConversationTurn = async ({
  userId,
  query,
  timeContext,
  correctionOccurred = false,
  onToken = null,
}) => withUserTurnLock(userId, async () => {
  if (correctionOccurred) await removeLastPair(userId);
  const history = await loadPromptHistory(userId);

  // Keep the existing memory-search gate: general queries avoid irrelevant
  // personal memory, while identity and summary requests still search it.
  let memories = [];
  const baseType = classifyQuery(query, []);
  const semanticTurn = conversationState.beginTurn(userId, query, baseType, { correction: correctionOccurred });
  const queryType = semanticTurn.queryType;
  const memoryQuery = semanticTurn.memoryQuery || query;
  const { isIdentity } = detectIdentityEntities(memoryQuery);
  const isSummary = isSummaryRequest(query);
  const gatePass = queryType !== "general" || isIdentity || isSummary || Boolean(semanticTurn.entity?.mode === "personal");

  try { if (dbg.DEBUG) dbg.memoryGate(query, queryType, isIdentity, isSummary, gatePass); } catch (_) {}

  if (gatePass) {
    try {
      memories = (await searchMemory(userId, memoryQuery))
        .filter(memory => keepPromptMemory(queryType, memoryQuery, memory));
    } catch (memErr) {
      console.warn("[Memory] Search failed (non-fatal):", memErr.message);
      diagnostics.record({
        user: userId,
        source: "backend",
        type: "memory_search_failed",
        data: { query: memoryQuery, error: memErr.message },
      });
    }
  }

  recordTurnDiagnostics(userId, query, baseType, semanticTurn, gatePass, memories);
  console.log(
    onToken ? "Stream query:" : "Query:", query,
    "| QueryType:", queryType, "| Memories:", memories.length, "| History:", history.length
  );

  let answer;
  if (typeof onToken === "function") {
    answer = "";
    await generateResponseStream(query, memories, timeContext, history, token => {
      answer += token;
      onToken(token);
    }, correctionOccurred, semanticTurn);
  } else {
    answer = await generateResponse(query, memories, timeContext, history, semanticTurn);
  }

  await persistCleanTurn(userId, query, answer);
  conversationState.endTurn(userId, { ...semanticTurn, queryType });
  await observeSemanticLearning(userId, query, queryType, semanticTurn);
  return { answer, memories };
});

module.exports = { runConversationTurn };
