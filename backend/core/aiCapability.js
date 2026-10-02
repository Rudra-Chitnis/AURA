"use strict";

// Core-facing AI capability. The existing service remains the active
// implementation (including its current Ollama routing and fallbacks).
const aiService = require("../services/aiService");

module.exports = Object.freeze({
  classifyQuery: aiService.classifyQuery,
  generateResponse: aiService.generateResponse,
  generateResponseStream: aiService.generateResponseStream,
  isSummaryRequest: aiService.isSummaryRequest,
  detectIdentityEntities: aiService.detectIdentityEntities,
});
