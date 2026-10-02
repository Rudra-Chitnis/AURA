"use strict";

const MAX_RECENT_PER_SCOPE = 120;
const DEFAULT_LIMIT = 80;

// Coordinates diagnostic event state with host-provided persistence and
// broadcast callbacks. Event interpretation and transport mechanics stay out.
class DiagnosticRuntime {
  constructor({ createEvent, persistEvent, loadPersistedEvents, broadcastEvent }) {
    this._createEvent = createEvent;
    this._persistEvent = persistEvent;
    this._loadPersistedEvents = loadPersistedEvents;
    this._broadcastEvent = broadcastEvent;
    this._recent = new Map();
  }

  _scopeKey(userId) {
    return userId ? String(userId) : "__global__";
  }

  _pushRecent(event) {
    const key = this._scopeKey(event.user);
    const list = this._recent.get(key) || [];
    list.unshift(event);
    this._recent.set(key, list.slice(0, MAX_RECENT_PER_SCOPE));
    if (key !== "__global__") {
      const global = this._recent.get("__global__") || [];
      global.unshift(event);
      this._recent.set("__global__", global.slice(0, MAX_RECENT_PER_SCOPE));
    }
  }

  record(raw = {}) {
    const event = this._createEvent(raw);
    this._pushRecent(event);
    this._persistEvent(event);

    try {
      this._broadcastEvent(event);
    } catch (_) {
      // Diagnostics must never affect runtime behavior.
    }

    return event;
  }

  async recent(userId, limit = DEFAULT_LIMIT) {
    const userEvents = this._recent.get(this._scopeKey(userId)) || [];
    const globalEvents = userId
      ? (this._recent.get("__global__") || []).filter(event => !event.user)
      : (this._recent.get("__global__") || []);
    const inMemory = [...userEvents, ...globalEvents]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    if (inMemory.length >= Math.min(limit, 20)) return inMemory.slice(0, limit);

    try {
      return await this._loadPersistedEvents(userId, limit);
    } catch (_) {
      return inMemory.slice(0, limit);
    }
  }
}

module.exports = { DiagnosticRuntime };
