const axios = require("axios");
const mongoose = require("mongoose");
const DiagnosticEvent = require("../models/diagnosticEventModel");
const wsHub = require("../wsHub");

const MAX_RECENT_PER_SCOPE = 120;
const DEFAULT_LIMIT = 80;
const PERSIST_LIMIT = 500;
const OLLAMA_URL = process.env.OLLAMA_URL || process.env.OLLAMA_HOST || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_DIAGNOSTIC_MODEL || process.env.OLLAMA_MODEL || "mistral";

const _recent = new Map();

const scopeKey = (userId) => userId ? String(userId) : "__global__";

const sanitizeData = (data = {}) => {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value == null) continue;
    if (typeof value === "string") out[key] = value.slice(0, 220);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value)) out[key] = value.slice(0, 8).map(v => String(v).slice(0, 80));
    else if (typeof value === "object") {
      out[key] = Object.fromEntries(
        Object.entries(value).slice(0, 12).map(([k, v]) => [k, String(v).slice(0, 120)])
      );
    }
  }
  return out;
};

const infer = (event) => {
  const type = event.type || "runtime_event";
  const data = event.data || {};

  switch (type) {
    case "semantic_resolution_failure":
      return { issue: "continuity_break", cause: "missing_active_referent", severity: "warn" };
    case "classification_context_override":
      return { issue: "classification_adjusted_by_state", cause: "semantic_state_override", severity: "info" };
    case "classification_conflict":
      return { issue: "classification_instability", cause: "base_and_state_disagree", severity: "warn" };
    case "memory_search_failed":
      return { issue: "memory_retrieval_failure", cause: data.error || "search_exception", severity: "warn" };
    case "memory_consolidation_failed":
      return { issue: "semantic_learning_failure", cause: data.error || "consolidation_exception", severity: "warn" };
    case "prompt_leakage_attempt":
    case "scaffold_leak_terminated":
      return { issue: "prompt_contamination_blocked", cause: "model_continued_prompt_scaffold", severity: "warn" };
    case "malformed_output_dropped":
      return { issue: "malformed_generation_blocked", cause: data.reason || "stream_validation", severity: "warn" };
    case "llm_no_speakable_text":
      return { issue: "generation_suppressed", cause: "no_valid_stream_chunks", severity: "warn" };
    case "generation_timeout":
      return { issue: "generation_stall", cause: data.code || "ollama_timeout", severity: "error" };
    case "tts_queue_overflow":
      return { issue: "tts_backpressure", cause: "playback_queue_full", severity: "warn" };
    case "tts_audio_failure":
      return { issue: "tts_playback_failure", cause: data.error || "audio_device_or_tts_error", severity: "warn" };
    case "stream_abort":
      return { issue: "stream_interrupted", cause: data.reason || "runtime_abort", severity: "info" };
    case "stt_ambiguity":
      return { issue: "speech_recognition_ambiguity", cause: "low_confidence_transcription", severity: "warn" };
    default:
      return { issue: event.issue || type, cause: event.cause || "observed_runtime_event", severity: event.severity || "info" };
  }
};

const pushRecent = (event) => {
  const key = scopeKey(event.user);
  const list = _recent.get(key) || [];
  list.unshift(event);
  _recent.set(key, list.slice(0, MAX_RECENT_PER_SCOPE));
  if (key !== "__global__") {
    const global = _recent.get("__global__") || [];
    global.unshift(event);
    _recent.set("__global__", global.slice(0, MAX_RECENT_PER_SCOPE));
  }
};

const persistEvent = async (event) => {
  try {
    if (mongoose.connection.readyState !== 1) return;
    await DiagnosticEvent.create({
      user: event.user || null,
      source: event.source,
      type: event.type,
      severity: event.severity,
      issue: event.issue,
      cause: event.cause,
      data: event.data,
    });

    const count = await DiagnosticEvent.countDocuments(event.user ? { user: event.user } : {});
    if (count > PERSIST_LIMIT) {
      const overflow = count - PERSIST_LIMIT;
      const old = await DiagnosticEvent.find(event.user ? { user: event.user } : {})
        .sort({ createdAt: 1 })
        .limit(overflow)
        .select("_id");
      if (old.length) await DiagnosticEvent.deleteMany({ _id: { $in: old.map(d => d._id) } });
    }
  } catch (err) {
    console.warn("[Diagnostics] persist failed:", err.message);
  }
};

const record = (raw = {}) => {
  const inferred = infer(raw);
  const event = {
    user: raw.user || raw.userId || null,
    source: raw.source || "backend",
    type: raw.type || "runtime_event",
    severity: raw.severity || inferred.severity,
    issue: raw.issue || inferred.issue,
    cause: raw.cause || inferred.cause,
    data: sanitizeData(raw.data || {}),
    createdAt: new Date().toISOString(),
  };

  pushRecent(event);
  persistEvent(event);

  try {
    wsHub.broadcast({ ...event, diagnosticType: event.type, type: "diagnostic" });
  } catch (_) {
    // Diagnostics must never affect runtime behavior.
  }

  return event;
};

const recent = async (userId, limit = DEFAULT_LIMIT) => {
  const userEvents = _recent.get(scopeKey(userId)) || [];
  const globalEvents = userId ? (_recent.get("__global__") || []).filter(e => !e.user) : (_recent.get("__global__") || []);
  const inMemory = [...userEvents, ...globalEvents]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (inMemory.length >= Math.min(limit, 20)) return inMemory.slice(0, limit);

  try {
    const query = userId ? { $or: [{ user: userId }, { user: null }] } : {};
    return await DiagnosticEvent.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();
  } catch (_) {
    return inMemory.slice(0, limit);
  }
};

const summarize = async (userId, limit = DEFAULT_LIMIT) => {
  const events = await recent(userId, limit);
  const counts = {};
  const causes = {};
  const severities = { info: 0, warn: 0, error: 0 };

  for (const event of events) {
    counts[event.issue || event.type] = (counts[event.issue || event.type] || 0) + 1;
    causes[event.cause || "unknown"] = (causes[event.cause || "unknown"] || 0) + 1;
    severities[event.severity || "info"] = (severities[event.severity || "info"] || 0) + 1;
  }

  const topIssues = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([issue, count]) => ({ issue, count }));

  const topCauses = Object.entries(causes)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([cause, count]) => ({ cause, count }));

  return {
    windowSize: events.length,
    severities,
    topIssues,
    topCauses,
    latest: events.slice(0, 8).map(event => ({
      type: event.type,
      issue: event.issue,
      cause: event.cause,
      severity: event.severity,
      source: event.source,
      createdAt: event.createdAt,
    })),
  };
};

const renderDeterministicExplanation = (summary) => {
  if (!summary || summary.windowSize === 0) {
    return "I do not have recent runtime issues recorded.";
  }
  const main = summary.topIssues[0];
  const cause = summary.topCauses[0];
  const warnings = summary.severities.warn || 0;
  const errors = summary.severities.error || 0;
  const severityText = errors ? `${errors} error-level event${errors === 1 ? "" : "s"}` :
    warnings ? `${warnings} warning${warnings === 1 ? "" : "s"}` : "mostly informational events";
  return `I saw ${severityText}. The main issue was ${main.issue.replace(/_/g, " ")} (${main.count}x), most likely from ${cause.cause.replace(/_/g, " ")}.`;
};

const renderExplanationWithLLM = async (summary) => {
  const compact = JSON.stringify(summary).slice(0, 1600);
  const prompt = [
    "AURA runtime diagnostics.",
    "Explain briefly in first person. Do not mention JSON or logs.",
    compact,
    "AURA:",
  ].join("\n");

  try {
    const response = await axios.post(
      `${OLLAMA_URL}/api/generate`,
      {
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        options: { temperature: 0.2, num_predict: 80, stop: ["User:", "Assistant:", "AURA:"] },
      },
      { timeout: 12000 }
    );
    const text = String(response.data?.response || "").trim();
    return text || renderDeterministicExplanation(summary);
  } catch (_) {
    return renderDeterministicExplanation(summary);
  }
};

module.exports = {
  record,
  recent,
  summarize,
  renderExplanationWithLLM,
  renderDeterministicExplanation,
};
