"use strict";

const fs = require("fs");
const path = require("path");

class TimerManager {
  constructor({ dataDirectory, events }) {
    this._dataPath = path.join(dataDirectory, "timers.json");
    this._events = events;
    this._timers = [];
    this._handles = {};
    this._tickTimer = null;
  }

  init() {
    this._load();
    this._recover();
    this._startTick();
  }

  _load() {
    try {
      if (fs.existsSync(this._dataPath)) {
        this._timers = JSON.parse(fs.readFileSync(this._dataPath, "utf8")) || [];
      }
    } catch (e) {
      console.warn("[TimerManager] Load failed:", e.message);
      this._timers = [];
    }
  }

  _save() {
    try {
      fs.writeFileSync(this._dataPath, JSON.stringify(this._timers, null, 2), "utf8");
    } catch (e) {
      console.warn("[TimerManager] Save failed:", e.message);
    }
  }

  _recover() {
    const now = Date.now();
    const toKeep = [];
    for (const timer of this._timers) {
      const remaining = new Date(timer.endsAt).getTime() - now;
      if (remaining <= 0) {
        console.log(`[TimerManager] Recovering expired timer: "${timer.label}"`);
        setTimeout(() => this._fireTimer(timer, true), 1500);
      } else {
        toKeep.push(timer);
        this._scheduleHandle(timer);
      }
    }
    this._timers = toKeep;
    this._save();
  }

  setTimer(label, seconds) {
    const id = `timer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const endsAt = new Date(Date.now() + seconds * 1000).toISOString();
    const timer = {
      id,
      label: label || `${Math.round(seconds / 60)} min timer`,
      durationSecs: seconds,
      endsAt,
      createdAt: new Date().toISOString(),
    };
    this._timers.push(timer);
    this._save();
    this._scheduleHandle(timer);
    console.log(`[TimerManager] Set: "${timer.label}" for ${seconds}s (id=${id})`);
    return timer;
  }

  cancelTimer(id) {
    const handle = this._handles[id];
    if (handle) { clearTimeout(handle); delete this._handles[id]; }
    this._timers = this._timers.filter(timer => timer.id !== id);
    this._save();
    console.log(`[TimerManager] Cancelled: ${id}`);
  }

  listTimers() {
    const now = Date.now();
    return this._timers.map(timer => ({
      ...timer,
      remainingSecs: Math.max(0, Math.round((new Date(timer.endsAt).getTime() - now) / 1000)),
    }));
  }

  _scheduleHandle(timer) {
    const delay = Math.max(0, new Date(timer.endsAt).getTime() - Date.now());
    this._handles[timer.id] = setTimeout(() => this._onComplete(timer.id), delay);
  }

  _onComplete(id) {
    const timer = this._timers.find(item => item.id === id);
    if (!timer) return;
    this._timers = this._timers.filter(item => item.id !== id);
    delete this._handles[id];
    this._save();
    this._fireTimer(timer, false);
  }

  _fireTimer(timer, wasMissed) {
    const body = wasMissed
      ? `Time's up: ${timer.label} (fired while AURA was closed)`
      : `Time's up: ${timer.label}`;
    this._events.emit("timer:fired", { timer, body, wasMissed });
    console.log(`[TimerManager] Fired: "${timer.label}" (missed=${wasMissed})`);
  }

  _startTick() {
    this._tickTimer = setInterval(() => this._events.emit("timer:tick", this.listTimers()), 1000);
  }

  destroy() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    for (const handle of Object.values(this._handles)) clearTimeout(handle);
  }
}

module.exports = { TimerManager };
