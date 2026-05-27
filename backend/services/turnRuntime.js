const { loadHistory, saveHistory, removeLastPair } = require("./conversationService");

const MAX_PROMPT_TURNS = 8;
const _userLocks = new Map();

const withUserTurnLock = async (userId, fn) => {
  const key = String(userId);
  const previous = _userLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise(resolve => { release = resolve; });
  const tail = previous.then(() => current, () => current);
  _userLocks.set(key, tail);

  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (_userLocks.get(key) === tail) _userLocks.delete(key);
  }
};

const normalizeTurn = (turn) => {
  if (!turn || typeof turn.content !== "string") return null;
  if (turn.role !== "user" && turn.role !== "assistant") return null;
  const content = turn.content.trim();
  if (!content) return null;
  return { role: turn.role, content };
};

const toPromptHistory = (turns = []) => {
  const normalized = turns.map(normalizeTurn).filter(Boolean);
  const pairs = [];

  for (let i = 0; i < normalized.length - 1; i++) {
    const user = normalized[i];
    const assistant = normalized[i + 1];
    if (user.role !== "user" || assistant.role !== "assistant") continue;
    pairs.push(user, assistant);
    i += 1;
  }

  return pairs.slice(-MAX_PROMPT_TURNS);
};

const loadPromptHistory = async (userId) => {
  const persisted = await loadHistory(userId, MAX_PROMPT_TURNS * 2);
  return toPromptHistory(persisted);
};

const persistCleanTurn = async (userId, query, answer) => {
  const user = (query || "").trim();
  const assistant = (answer || "").trim();
  if (!user || !assistant) return false;
  await saveHistory(userId, [
    { role: "user", content: user },
    { role: "assistant", content: assistant },
  ]);
  return true;
};

module.exports = {
  withUserTurnLock,
  loadPromptHistory,
  persistCleanTurn,
  removeLastPair,
};
