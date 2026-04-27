const Memory = require("../models/memoryModel");
const { generateEmbedding } = require("./embeddingService");
const cosineSimilarity = require("../utils/similarity");


// ─────────────────────────────────────────────
// FILTER — only store meaningful declarative facts
// ─────────────────────────────────────────────
const QUESTION_STARTERS = /^(what|who|where|when|how|why|is|are|was|were|do|does|did|can|could|would|should|have|has)\b/i;
const FILLER_PHRASES    = /^(ok|okay|yes|no|sure|thanks|thank you|got it|alright|right|yeah|yep|nope|cool|great|fine|whatever|hmm|uh|um)\b/i;

const isWorthStoring = (content) => {
  if (!content || typeof content !== "string") return false;
  const text = content.trim();
  if (text.split(/\s+/).length < 3) return false;
  if (text.endsWith("?")) return false;
  if (QUESTION_STARTERS.test(text)) return false;
  if (FILLER_PHRASES.test(text)) return false;
  return true;
};


// ─────────────────────────────────────────────
// ATTRIBUTE NORMALIZATION
// Merges semantic synonyms so "loves" and "likes" don't create separate facts.
// ─────────────────────────────────────────────
const ATTRIBUTE_ALIASES = {
  loves:        "likes",
  enjoys:       "likes",
  is_into:      "likes",
  hates:        "dislikes",
  cannot_stand: "dislikes",
};
const normalizeAttribute = (attr) => ATTRIBUTE_ALIASES[attr] || attr;

// Attributes where a person can hold only ONE value (scalar).
// On insert: if the same person+attribute already exists with a different value,
// update in place rather than creating a duplicate.
const SCALAR_ATTRIBUTES = new Set([
  "name", "lives_in", "works_at", "studies_at", "occupation", "birthday"
]);


// ─────────────────────────────────────────────
// CONTENT NORMALIZATION — used for plain-text deduplication
// ─────────────────────────────────────────────
const normalizeContent = (text) =>
  (text || "").toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();


// ─────────────────────────────────────────────
// STRUCTURED PARSING
// Returns { person, attribute, value, confidence } or null.
//   person     = "user" (fact about the speaker) or a name (fact about someone else)
//   confidence = "high" (explicit, direct statement) | "medium" (informal / inferred)
// ─────────────────────────────────────────────
const parseStructuredMemory = (raw) => {
  const text = raw.toLowerCase().trim();
  let m;

  // ── IDENTITY ─────────────────────────────────────────────────────────────
  m = text.match(/^(?:my name is|i am called|call me|i go by)\s+(.+)$/);
  if (m) return { person: m[1].trim(), attribute: "name", value: m[1].trim(), confidence: "high" };

  m = text.match(/^(?:i live in|i'm from|i am from|i stay in|i'm based in|i am based in)\s+(.+)$/);
  if (m) return { person: "user", attribute: "lives_in", value: m[1].trim(), confidence: "high" };

  m = text.match(/^(?:i work at|i work for|i work in)\s+(.+)$/);
  if (m) return { person: "user", attribute: "works_at", value: m[1].trim(), confidence: "high" };

  m = text.match(/^(?:i study at|i go to|i attend|i'm studying|i am studying)\s+(.+)$/);
  if (m) return { person: "user", attribute: "studies_at", value: m[1].trim(), confidence: "high" };

  m = text.match(/^(?:i am a|i'm a|i am an|i'm an)\s+(.+)$/);
  if (m) return { person: "user", attribute: "occupation", value: m[1].trim(), confidence: "high" };

  m = text.match(/^my birthday is(?:\s+on)?\s+(.+)$/);
  if (m) return { person: "user", attribute: "birthday", value: m[1].trim(), confidence: "high" };

  // ── PREFERENCES — direct ──────────────────────────────────────────────────
  m = text.match(/^(?:i like|i love|i enjoy|i prefer)\s+(.+)$/);
  if (m) return { person: "user", attribute: "likes", value: m[1].trim(), confidence: "high" };

  m = text.match(/^(?:i hate|i dislike|i don't like|i do not like)\s+(.+)$/);
  if (m) return { person: "user", attribute: "dislikes", value: m[1].trim(), confidence: "high" };

  // ── PREFERENCES — informal (medium confidence) ────────────────────────────
  m = text.match(/^i(?:'m| am)(?: really| very)? into\s+(.+)$/);
  if (m) return { person: "user", attribute: "likes", value: m[1].trim(), confidence: "medium" };

  m = text.match(/^i(?:'m| am)(?: a)?(?: big)? fan of\s+(.+)$/);
  if (m) return { person: "user", attribute: "likes", value: m[1].trim(), confidence: "medium" };

  m = text.match(/^(?:i can't stand|i cannot stand)\s+(.+)$/);
  if (m) return { person: "user", attribute: "dislikes", value: m[1].trim(), confidence: "medium" };

  m = text.match(/^i(?:'m| am) not(?: a)? fan of\s+(.+)$/);
  if (m) return { person: "user", attribute: "dislikes", value: m[1].trim(), confidence: "medium" };

  // ── TOOL / PLATFORM ───────────────────────────────────────────────────────
  m = text.match(/^i use\s+(.+)$/);
  if (m) return { person: "user", attribute: "uses", value: m[1].trim(), confidence: "high" };

  // ── FAVORITES ────────────────────────────────────────────────────────────
  m = text.match(/^my favou?rite\s+(\w+)\s+is\s+(.+)$/);
  if (m) return { person: "user", attribute: `favorite_${m[1].trim()}`, value: m[2].trim(), confidence: "high" };

  // ── RELATIONSHIPS ─────────────────────────────────────────────────────────
  m = text.match(/^([a-z]+)\s+is\s+my\s+(.+)$/);
  if (m) return { person: m[1].trim(), attribute: "relationship_to_user", value: m[2].trim(), confidence: "high" };

  // ── GENERIC "my X is Y" catch-all (medium confidence) ────────────────────
  // e.g. "my phone is iPhone 15", "my laptop is a MacBook"
  m = text.match(/^my\s+(\w+)\s+is\s+(.+)$/);
  if (m) return { person: "user", attribute: m[1].trim(), value: m[2].trim(), confidence: "medium" };

  return null;
};


// ─────────────────────────────────────────────
// DEDUPLICATION
// Returns { skip: bool, existing: doc | null }
//   skip=true  → identical fact already stored, do nothing
//   existing   → same scalar attribute, different value → caller should update
// ─────────────────────────────────────────────
const checkDuplicate = async (userId, content, structured) => {
  if (structured) {
    const normAttr = normalizeAttribute(structured.attribute);

    if (SCALAR_ATTRIBUTES.has(normAttr)) {
      // Scalar: only one value allowed per person+attribute
      const existing = await Memory.findOne({
        user:      userId,
        person:    structured.person,
        attribute: normAttr
      });
      if (existing) {
        if (normalizeContent(existing.value || "") === normalizeContent(structured.value)) {
          return { skip: true, existing: null };   // identical — skip entirely
        }
        return { skip: false, existing };           // same attribute, new value — update it
      }
    } else {
      // List-type (likes, dislikes, etc.): check for exact same triple
      const dup = await Memory.findOne({
        user:      userId,
        person:    structured.person,
        attribute: normalizeAttribute(structured.attribute),
        value:     structured.value
      });
      if (dup) return { skip: true, existing: null };
    }
    return { skip: false, existing: null };
  }

  // Plain-text: normalize and compare against all unstructured memories
  const norm     = normalizeContent(content);
  const allPlain = await Memory.find({ user: userId, person: null }).select("content");
  if (allPlain.some(m => normalizeContent(m.content) === norm)) {
    return { skip: true, existing: null };
  }
  return { skip: false, existing: null };
};


// ─────────────────────────────────────────────
// STORE MEMORY — filtered + structured + deduplicated + confidence
// ─────────────────────────────────────────────
const storeMemory = async (userId, content, type) => {
  if (!isWorthStoring(content)) return null;

  const structured              = parseStructuredMemory(content);
  const { skip, existing }      = await checkDuplicate(userId, content, structured);

  if (skip) return null;   // exact duplicate — silently drop

  const embedding   = await generateEmbedding(content);
  const confidence  = structured?.confidence || "high";

  // Scalar attribute update: overwrite the existing record in place
  if (existing) {
    existing.content    = content;
    existing.value      = structured.value;
    existing.embedding  = embedding;
    existing.confidence = confidence;
    await existing.save();
    return existing;
  }

  // New memory
  const created = await Memory.create({
    user:       userId,
    content,
    embedding,
    type:       type || "personal",
    confidence,
    ...(structured && {
      person:    structured.person,
      attribute: normalizeAttribute(structured.attribute),
      value:     structured.value
    })
  });

  // Async prune — fire-and-forget, zero latency impact on the caller
  pruneMemories(userId).catch(err => console.warn("[Memory] Prune error:", err.message));

  return created;
};


// GET ALL MEMORIES FOR A USER (no embedding returned — saves bandwidth)
const getMemories = async (userId) => {
  return await Memory.find({ user: userId })
    .select("-embedding")
    .sort({ createdAt: -1 });
};


// ─────────────────────────────────────────────
// PRUNING — keep memory count per user under MEMORY_LIMIT.
// Deletes oldest low/medium-confidence records first.
// High-confidence memories are never deleted by automatic pruning.
// Called fire-and-forget after each storeMemory — no latency impact.
// ─────────────────────────────────────────────
const MEMORY_LIMIT = 100;

const pruneMemories = async (userId) => {
  const count = await Memory.countDocuments({ user: userId });
  if (count <= MEMORY_LIMIT) return;

  const overflow = count - MEMORY_LIMIT;

  const toDelete = await Memory.find({
    user:       userId,
    confidence: { $in: ["medium", "low"] }
  })
  .sort({ createdAt: 1 })   // oldest first
  .limit(overflow)
  .select("_id");

  if (toDelete.length > 0) {
    await Memory.deleteMany({ _id: { $in: toDelete.map(d => d._id) } });
    console.log(`[Memory] Pruned ${toDelete.length} old memories for user ${userId}`);
  }
};


// ─────────────────────────────────────────────
// NAME VARIANT TABLE — STT mishearing normalization
// Supplements voice.py's fuzzy correction for anything that slips through.
// ─────────────────────────────────────────────
const NAME_VARIANTS = {
  rudra:   ["rudra", "ruda", "rudhra", "ruddha"],
  chitnis: ["chitnis", "chitness", "cheetnis", "chitniss", "chit-nis"],
  sadgi:   ["sadgi", "sadgee", "sadhgi", "sadge"],
  garg:    ["garg", "gaarg", "gargh"],
  aura:    ["aura", "ora", "auro", "aara"]
};

const VARIANT_TO_CANONICAL = {};
for (const [canonical, variants] of Object.entries(NAME_VARIANTS)) {
  for (const v of variants) VARIANT_TO_CANONICAL[v] = canonical;
}

const extractEntities = (text) => {
  const cap    = (text.match(/\b[A-Z][a-z]{2,}\b/g) || []).map(w => w.toLowerCase());
  const long   = text.toLowerCase().match(/\b[a-z]{5,}\b/g) || [];
  const canon  = text.toLowerCase().split(/\s+/).map(t => VARIANT_TO_CANONICAL[t] || null).filter(Boolean);
  return [...new Set([...cap, ...long, ...canon])];
};


// ─────────────────────────────────────────────
// SEARCH MEMORY
// Score = cosine similarity
//       + entity match boost      (+0.08 per matching entity word in content)
//       + person field boost      (+0.15 if query names this memory's person)
//       + recency bonus           (+0.05 < 7 days, +0.02 < 30 days)
//       + confidence adjustment   (-0.03 for medium, -0.07 for low)
// Only results > 0.35 are returned, capped at top 5.
// ─────────────────────────────────────────────
const ABOUT_ME_RE = /\babout me\b|\bknow (about )?me\b|\bwho am i\b|\bremember about me\b/i;

const searchMemory = async (userId, query) => {
  // Broad self-query ("what do you know about me?", "tell me about me") —
  // semantic search won't match specific facts, so return all memories directly.
  if (ABOUT_ME_RE.test(query)) {
    const all = await Memory.find({ user: userId })
      .select("-embedding")
      .sort({ confidence: -1, createdAt: -1 })
      .limit(30);  // fetch more, then deduplicate before returning

    // Deduplicate: for each attribute, keep only the most recent entry.
    // Non-scalar attributes (likes, dislikes, uses) are capped at 3 entries.
    const seen       = new Map();   // attribute → count
    const dedupedRaw = [];
    for (const m of all) {
      const attr  = m.attribute || "__plain__";
      const count = seen.get(attr) || 0;
      const cap   = SCALAR_ATTRIBUTES.has(attr) ? 1 : 3;
      if (count < cap) {
        dedupedRaw.push(m);
        seen.set(attr, count + 1);
      }
      if (dedupedRaw.length >= 8) break;   // hard cap
    }

    return dedupedRaw.map(m => ({
      content:    m.content,
      type:       m.type,
      person:     m.person     || null,
      attribute:  m.attribute  || null,
      value:      m.value      || null,
      confidence: m.confidence || "high",
      score:      1.0
    }));
  }

  const queryEmbedding = await generateEmbedding(query);
  const memories       = await Memory.find({ user: userId });
  const entities       = extractEntities(query);
  const queryLow       = query.toLowerCase();
  const now            = Date.now();

  const results = memories
    .filter(mem => mem.embedding && mem.embedding.length > 0)
    .map(mem => {
      const base   = cosineSimilarity(queryEmbedding, mem.embedding);
      const memLow = mem.content.toLowerCase();

      const entityBoost = entities.reduce(
        (acc, e) => acc + (memLow.includes(e) ? 0.08 : 0), 0
      );

      let personBoost = 0;
      if (mem.person) {
        const pLow = mem.person.toLowerCase();
        if (queryLow.includes(pLow) || entities.includes(pLow)) personBoost = 0.15;
      }

      const ageDays     = (now - new Date(mem.createdAt).getTime()) / 86_400_000;
      const recencyBoost = ageDays < 7 ? 0.05 : ageDays < 30 ? 0.02 : 0;

      const confidenceAdj = mem.confidence === "medium" ? -0.03
                          : mem.confidence === "low"    ? -0.07 : 0;

      return {
        content:    mem.content,
        type:       mem.type,
        person:     mem.person     || null,
        attribute:  mem.attribute  || null,
        value:      mem.value      || null,
        confidence: mem.confidence || "high",
        score:      Math.min(1, base + entityBoost + personBoost + recencyBoost + confidenceAdj)
      };
    })
    .filter(r => r.score > 0.35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  // Quality gate: if 3+ results are strong (>0.55), drop any weak stragglers (<0.45).
  // A mediocre match adds noise — it's better to give the LLM 3 confident facts
  // than 5 where the last two are weakly related guesses.
  const strong = results.filter(r => r.score > 0.55);
  return strong.length >= 3 ? strong.slice(0, 5) : results;
};


// ─────────────────────────────────────────────
// CONTEXT-AWARE QUERY CORRECTION
// ─────────────────────────────────────────────
const correctQueryWithMemory = (query, memories) => {
  if (!memories || memories.length === 0) return query;
  const topMemory    = memories[0].content.toLowerCase();
  let correctedQuery = query.toLowerCase();
  if (correctedQuery.includes("day")  && topMemory.includes("date"))
    correctedQuery = correctedQuery.replace("day",  "date");
  if (correctedQuery.includes("data") && topMemory.includes("date"))
    correctedQuery = correctedQuery.replace("data", "date");
  return correctedQuery;
};


module.exports = {
  storeMemory,
  getMemories,
  searchMemory,
  correctQueryWithMemory,
  isWorthStoring,
  parseStructuredMemory
};
