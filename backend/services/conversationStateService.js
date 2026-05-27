const TOPIC_TTL_MS = 6 * 60 * 1000;
const ENTITY_TTL_MS = 10 * 60 * 1000;
const MODE_TTL_MS = 4 * 60 * 1000;

const OWNER_NAMES = new Set(["rudra", "rudra chitnis", "chitnis"]);
const KNOWN_ENTITIES = [
  { key: "rudra", names: ["rudra chitnis", "rudra", "chitnis"], kind: "person", mode: "personal" },
  { key: "sadgi", names: ["sadgi garg", "sadgi"], kind: "person", mode: "personal" },
  { key: "medicaps", names: ["medicaps"], kind: "organization", mode: "personal" },
];

const REFERENTIAL_RE = /\b(he|him|his|she|her|hers|they|them|their|it|its|this|that|those|these|same|there)\b|^(?:and|also|what else|what about|how about|which|where|when|why|how|tell me more)\b/i;
const HARD_RESET_RE = /\b(forget that|never mind|new topic|change topic|switch topic|move on|stop talking about)\b/i;
const TOPIC_QUERY_RE = /\b(?:about|on|regarding|explain|describe|discuss|understand|compare)\s+([a-z][a-z0-9 .'-]{1,60})/i;
const QUESTION_ENTITY_RE = /\b(?:is|are|was|were|does|do|did|can|could|should|would)\s+([a-z][a-z0-9 .'-]{1,50})\b/i;
const GENERIC_WORDS = new Set([
  "the", "this", "that", "these", "those", "what", "which", "where", "when", "why", "how",
  "tell", "explain", "describe", "discuss", "about", "more", "else", "know", "think",
  "buy", "make", "good", "best", "better", "advice", "help", "please", "should",
]);

const _states = new Map();

const nowMs = () => Date.now();

const fresh = (entry, now = nowMs()) =>
  entry && typeof entry.expiresAt === "number" && entry.expiresAt > now;

const confidence = (entry, ttl, now = nowMs()) => {
  if (!fresh(entry, now)) return 0;
  const remaining = entry.expiresAt - now;
  return Math.max(0, Math.min(1, remaining / ttl));
};

const normalize = (text = "") =>
  text.toLowerCase().replace(/[^\w\s'-]/g, " ").replace(/\s+/g, " ").trim();

const titleCase = (text = "") =>
  text.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

const displayNameForKnown = (key) => {
  if (key === "rudra") return "Rudra";
  if (key === "sadgi") return "Sadgi";
  if (key === "medicaps") return "Medicaps";
  return titleCase(key);
};

const detectKnownEntity = (query) => {
  const q = normalize(query);
  for (const entity of KNOWN_ENTITIES) {
    if (entity.names.some(name => q.includes(name))) {
      return {
        key: entity.key,
        name: displayNameForKnown(entity.key),
        kind: entity.kind,
        mode: entity.mode,
        confidence: 1,
      };
    }
  }
  return null;
};

const extractCapitalizedEntity = (query) => {
  const matches = String(query).match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,3}\b/g) || [];
  const candidate = matches
    .map(s => s.trim())
    .find(s => !GENERIC_WORDS.has(s.toLowerCase()) && s.length > 2);
  if (!candidate) return null;
  return { key: candidate.toLowerCase(), name: candidate, kind: "entity", mode: "general", confidence: 0.72 };
};

const extractTopic = (query) => {
  const known = detectKnownEntity(query);
  if (known) return known;

  const cap = extractCapitalizedEntity(query);
  if (cap) return cap;

  const q = normalize(query);
  const match = q.match(TOPIC_QUERY_RE) || q.match(QUESTION_ENTITY_RE);
  if (!match) return null;

  const words = match[1]
    .split(/\s+/)
    .filter(w => w.length > 2 && !GENERIC_WORDS.has(w))
    .slice(0, 4);
  if (!words.length) return null;

  const key = words.join(" ");
  return { key, name: titleCase(key), kind: "topic", mode: "general", confidence: 0.62 };
};

const getState = (userId) => {
  const key = String(userId);
  const state = _states.get(key) || {
    activeTopic: null,
    activeEntity: null,
    activeMode: null,
    turn: 0,
    updatedAt: 0,
  };
  const now = nowMs();
  if (!fresh(state.activeTopic, now)) state.activeTopic = null;
  if (!fresh(state.activeEntity, now)) state.activeEntity = null;
  if (!fresh(state.activeMode, now)) state.activeMode = null;
  _states.set(key, state);
  return state;
};

const resetState = (userId) => {
  _states.delete(String(userId));
};

const buildPromptLine = ({ queryType, entity, topic, isReferential }) => {
  if (entity && (queryType === "personal" || isReferential)) return `About ${entity.name}.`;
  if (topic && isReferential) return `Topic: ${topic.name}.`;
  return "";
};

const beginTurn = (userId, query, baseType, { correction = false } = {}) => {
  const state = getState(userId);
  const now = nowMs();
  const q = normalize(query);

  if (correction || HARD_RESET_RE.test(q)) {
    state.activeTopic = null;
    state.activeEntity = null;
    state.activeMode = null;
  }

  const referential = REFERENTIAL_RE.test(query);
  const activeEntity = fresh(state.activeEntity, now) ? state.activeEntity : null;
  const activeTopic = fresh(state.activeTopic, now) ? state.activeTopic : null;
  const known = detectKnownEntity(query);
  const explicit = known || (!referential ? extractTopic(query) : null);

  let entity = null;
  let topic = null;
  let resolvedType = baseType;
  let memoryQuery = query;

  if (known) {
    entity = known;
    resolvedType = known.mode === "personal" ? "personal" : baseType;
  } else if (referential && activeEntity) {
    entity = activeEntity;
    resolvedType = activeEntity.mode || "personal";
    memoryQuery = `${activeEntity.name} ${query}`;
  } else if (referential && activeTopic) {
    topic = activeTopic;
    resolvedType = baseType === "general" ? activeTopic.mode || "general" : baseType;
    memoryQuery = `${activeTopic.name} ${query}`;
  } else if (explicit) {
    if (explicit.mode === "personal" || explicit.kind === "person") entity = explicit;
    else topic = explicit;
    resolvedType = explicit.mode === "personal" ? "personal" : baseType;
  }

  if (entity && entity.mode === "personal" && baseType === "general") {
    resolvedType = "personal";
  }

  const promptLine = buildPromptLine({ queryType: resolvedType, entity, topic, isReferential: referential });

  state.turn += 1;
  state.updatedAt = now;
  state.pending = { query, baseType, resolvedType, entity, topic, referential, at: now };
  _states.set(String(userId), state);

  return {
    query,
    baseType,
    queryType: resolvedType,
    memoryQuery,
    promptContext: promptLine ? { line: promptLine, entity, topic } : null,
    referential,
    entity,
    topic,
    state: snapshot(userId),
  };
};

const endTurn = (userId, turn) => {
  const state = getState(userId);
  const now = nowMs();
  const entity = turn?.entity || extractTopic(turn?.query || "");
  const topic = turn?.topic || (entity && entity.mode !== "personal" ? entity : null);

  if (entity && (entity.mode === "personal" || entity.kind === "person")) {
    state.activeEntity = {
      ...entity,
      expiresAt: now + ENTITY_TTL_MS,
      confidence: entity.confidence || 0.8,
    };
    state.activeMode = { value: entity.mode || "personal", expiresAt: now + MODE_TTL_MS };
  } else if (topic) {
    state.activeTopic = {
      ...topic,
      expiresAt: now + TOPIC_TTL_MS,
      confidence: topic.confidence || 0.65,
      mode: turn?.queryType || topic.mode || "general",
    };
    state.activeMode = { value: turn?.queryType || "general", expiresAt: now + MODE_TTL_MS };
  } else if (turn?.queryType && turn.queryType !== "general") {
    state.activeMode = { value: turn.queryType, expiresAt: now + MODE_TTL_MS };
  }

  state.pending = null;
  state.updatedAt = now;
  _states.set(String(userId), state);
  return snapshot(userId);
};

const snapshot = (userId) => {
  const state = getState(userId);
  const now = nowMs();
  return {
    activeTopic: state.activeTopic ? {
      name: state.activeTopic.name,
      mode: state.activeTopic.mode,
      confidence: confidence(state.activeTopic, TOPIC_TTL_MS, now),
    } : null,
    activeEntity: state.activeEntity ? {
      name: state.activeEntity.name,
      mode: state.activeEntity.mode,
      kind: state.activeEntity.kind,
      confidence: confidence(state.activeEntity, ENTITY_TTL_MS, now),
    } : null,
    activeMode: state.activeMode ? state.activeMode.value : null,
    turn: state.turn,
    updatedAt: state.updatedAt,
  };
};

module.exports = {
  beginTurn,
  endTurn,
  getState: snapshot,
  resetState,
  _private: { extractTopic, detectKnownEntity, REFERENTIAL_RE },
};
