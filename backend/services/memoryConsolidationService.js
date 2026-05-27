const Memory = require("../models/memoryModel");
const mongoose = require("mongoose");
const SemanticPattern = require("../models/semanticPatternModel");

const DAY_MS = 86_400_000;
const CONSOLIDATE_MIN_EVIDENCE = 3;
const CONSOLIDATE_CONFIDENCE = 0.62;
const MAX_SIGNAL_TERMS = 12;

const DOMAIN_PATTERNS = [
  {
    key: "ai_engineering",
    label: "AI engineering and local AI systems",
    category: "interest",
    terms: ["ai", "llm", "ollama", "whisper", "prompt", "prompts", "model", "models", "embedding", "embeddings", "agent", "agents", "machine learning", "neural"],
    memory: "User frequently works with AI engineering and local AI systems.",
  },
  {
    key: "coding_workflows",
    label: "software development workflows",
    category: "workflow",
    terms: ["code", "coding", "repo", "repository", "bug", "debug", "backend", "frontend", "api", "electron", "python", "node", "react", "javascript", "typescript", "runtime"],
    memory: "User frequently uses software development workflows.",
  },
  {
    key: "pc_hardware",
    label: "PC hardware and system building",
    category: "interest",
    terms: ["pc", "cpu", "gpu", "motherboard", "ram", "ssd", "hardware", "build", "cooler", "power supply", "psu"],
    memory: "User is interested in PC hardware and system building.",
  },
  {
    key: "productivity_tools",
    label: "productivity tools and reminders",
    category: "workflow",
    terms: ["reminder", "timer", "schedule", "workflow", "productivity", "focus", "calendar", "task", "tasks"],
    memory: "User often uses productivity tools and reminder workflows.",
  },
  {
    key: "health_hydration",
    label: "health and hydration habits",
    category: "habit",
    terms: ["hydration", "water", "sleep", "workout", "exercise", "health", "medicine", "diet"],
    memory: "User has recurring interest in health and hydration habits.",
  },
  {
    key: "learning_dsa",
    label: "learning, DSA, and university work",
    category: "interest",
    terms: ["dsa", "algorithm", "algorithms", "data structure", "data structures", "university", "college", "study", "exam", "assignment"],
    memory: "User is interested in learning, DSA, and university work.",
  },
];

const PREFERENCE_RE = /\b(?:i\s+(?:like|love|enjoy|prefer|am into|use)|my\s+favou?rite)\s+(.{3,80})/i;
const NEGATIVE_RE = /\b(?:i\s+(?:hate|dislike|do not like|don't like|cannot stand|can't stand))\s+(.{3,80})/i;

const normalize = (value) =>
  String(value || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const compactTerm = (value) =>
  normalize(value).split(" ").slice(0, 5).join(" ");

const hasTerm = (text, term) => {
  const low = normalize(text);
  const needle = normalize(term);
  if (!needle) return false;
  if (needle.includes(" ")) return low.includes(needle);
  return new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(low);
};

const signalFromRuntimeState = (semanticTurn) => {
  const signals = [];
  const topic = semanticTurn?.topic?.name;
  if (topic && semanticTurn?.topic?.confidence >= 0.65) {
    signals.push({
      key: `topic_${normalize(topic).replace(/\s+/g, "_").slice(0, 48)}`,
      label: topic,
      category: "topic",
      terms: [compactTerm(topic)],
      memory: `User repeatedly discusses ${topic}.`,
      weight: 0.10,
    });
  }
  return signals;
};

const detectSignals = ({ query, semanticTurn }) => {
  const text = query || "";
  const signals = [];

  for (const pattern of DOMAIN_PATTERNS) {
    const matched = pattern.terms.filter(term => hasTerm(text, term));
    if (matched.length > 0) {
      signals.push({
        ...pattern,
        terms: matched.slice(0, 5),
        weight: matched.length >= 2 ? 0.20 : 0.15,
      });
    }
  }

  const positive = text.match(PREFERENCE_RE);
  if (positive) {
    const value = compactTerm(positive[1]);
    if (value) {
      signals.push({
        key: `preference_${value.replace(/\s+/g, "_").slice(0, 48)}`,
        label: value,
        category: "preference",
        terms: [value],
        memory: `User repeatedly shows preference for ${value}.`,
        weight: 0.18,
      });
    }
  }

  const negative = text.match(NEGATIVE_RE);
  if (negative) {
    const value = compactTerm(negative[1]);
    if (value) {
      signals.push({
        key: `avoid_${value.replace(/\s+/g, "_").slice(0, 48)}`,
        label: value,
        category: "preference",
        terms: [value],
        memory: `User repeatedly avoids or dislikes ${value}.`,
        weight: 0.18,
      });
    }
  }

  signals.push(...signalFromRuntimeState(semanticTurn));

  const seen = new Set();
  return signals.filter((signal) => {
    if (!signal.key || seen.has(signal.key)) return false;
    seen.add(signal.key);
    return true;
  });
};

const applyDecay = (confidence, lastSeenAt, now) => {
  if (!lastSeenAt) return confidence;
  const ageDays = Math.max(0, (now.getTime() - new Date(lastSeenAt).getTime()) / DAY_MS);
  if (ageDays < 7) return confidence;
  const decay = Math.min(0.35, Math.floor(ageDays / 7) * 0.04);
  return Math.max(0, confidence - decay);
};

const confidenceLabel = (value) => value >= 0.78 ? "high" : value >= 0.55 ? "medium" : "low";

const consolidatePattern = async (userId, pattern) => {
  const { generateEmbedding } = require("./embeddingService");
  const content = pattern.memoryText || `User repeatedly discusses ${pattern.label}.`;
  const existingMemory = pattern.consolidatedMemory
    ? await Memory.findById(pattern.consolidatedMemory)
    : await Memory.findOne({
        user: userId,
        person: "user",
        attribute: `semantic_${pattern.category}`,
        value: pattern.label,
      });

  const embedding = await generateEmbedding(content);
  const payload = {
    user: userId,
    content,
    embedding,
    type: pattern.category === "preference" ? "preference" : "general",
    confidence: confidenceLabel(pattern.confidence),
    person: "user",
    attribute: `semantic_${pattern.category}`,
    value: pattern.label,
  };

  let memory = existingMemory;
  if (memory) {
    Object.assign(memory, payload);
    await memory.save();
  } else {
    memory = await Memory.create(payload);
  }

  pattern.status = "consolidated";
  pattern.consolidatedMemory = memory._id;
  await pattern.save();
  return memory;
};

const reinforcePattern = async (userId, signal) => {
  const now = new Date();
  let pattern = await SemanticPattern.findOne({ user: userId, key: signal.key });

  if (!pattern) {
    pattern = new SemanticPattern({
      user: userId,
      key: signal.key,
      label: signal.label,
      category: signal.category || "interest",
      memoryText: signal.memory || "",
      confidence: Math.min(0.35, signal.weight || 0.15),
      evidenceCount: 1,
      signalTerms: signal.terms || [],
      firstSeenAt: now,
      lastSeenAt: now,
    });
  } else {
    const decayed = applyDecay(pattern.confidence, pattern.lastSeenAt, now);
    const reinforcement = signal.weight || 0.15;
    const repeatBonus = pattern.evidenceCount >= 2 ? 0.04 : 0;
    pattern.confidence = Math.min(1, decayed + reinforcement + repeatBonus);
    pattern.evidenceCount += 1;
    pattern.lastSeenAt = now;
    if (signal.memory) pattern.memoryText = signal.memory;
    pattern.status = pattern.status === "decayed" ? "candidate" : pattern.status;
    pattern.signalTerms = [...new Set([...(pattern.signalTerms || []), ...(signal.terms || [])])]
      .filter(Boolean)
      .slice(0, MAX_SIGNAL_TERMS);
  }

  await pattern.save();

  if (
    pattern.status !== "contradicted" &&
    pattern.evidenceCount >= CONSOLIDATE_MIN_EVIDENCE &&
    pattern.confidence >= CONSOLIDATE_CONFIDENCE
  ) {
    await consolidatePattern(userId, pattern);
  }

  return pattern;
};

const observeTurn = async ({ userId, query, queryType, semanticTurn }) => {
  if (!userId || !query || typeof query !== "string") return [];
  if (queryType === "action") return [];
  if (mongoose.connection.readyState !== 1) return [];

  const signals = detectSignals({ query, semanticTurn });
  if (signals.length === 0) return [];

  const results = [];
  for (const signal of signals.slice(0, 4)) {
    try {
      results.push(await reinforcePattern(userId, signal));
    } catch (err) {
      console.warn("[MemoryConsolidation] reinforce failed:", err.message);
    }
  }
  return results;
};

const getConsolidationSummary = async (userId, limit = 12) => {
  return SemanticPattern.find({ user: userId })
    .sort({ confidence: -1, evidenceCount: -1, lastSeenAt: -1 })
    .limit(limit)
    .select("-__v");
};

module.exports = {
  observeTurn,
  detectSignals,
  getConsolidationSummary,
};
