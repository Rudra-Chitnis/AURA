// ─── TimerManager — Electron-native persistent timer system ──────────────────
//
// Ownership: Electron desktop runtime.  voice.py sends "AURA:SET_TIMER:secs"
// via stdout; Electron owns the countdown, persistence, and notification.
//
// Storage  : %APPDATA%\AURA\timers.json
// Survives : Electron restart, voice.py restart, app reopen.
//
// Timer lifecycle:
//   set → stored + scheduled → 1-second ticks → fired → notify + callback
//
// Recovery: on startup, expired timers fire immediately; future timers
// reschedule their remaining delay.
//
// Callbacks (set via init()):
//   onTick(timers[])      — called every 1s with current timer list + remainingSecs
//   onFired(timer, text)  — called when a timer fires

"use strict";

const { Notification, app } = require("electron");
const path = require("path");
const fs   = require("fs");

class TimerManager {
  constructor() {
    this._dataPath  = null;      // set in init() after app is ready
    this._timers    = [];        // [{ id, label, durationSecs, endsAt, createdAt }]
    this._handles   = {};        // { id: timeoutHandle }
    this._tickTimer = null;
    this._onTick    = null;
    this._onFired   = null;
  }

  // ── Initialise after app.whenReady() ────────────────────────────────────
  init(onTick, onFired) {
    this._dataPath = path.join(app.getPath("userData"), "timers.json");
    this._onTick   = onTick;
    this._onFired  = onFired;
    this._load();
    this._recover();
    this._startTick();
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(this._dataPath)) {
        const raw = fs.readFileSync(this._dataPath, "utf8");
        this._timers = JSON.parse(raw) || [];
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

  // ── Startup recovery ─────────────────────────────────────────────────────
  // Expired timers fire immediately (with a 1.5s delay for startup settle).
  // Future timers are rescheduled for their remaining delay.
  _recover() {
    const now    = Date.now();
    const toKeep = [];

    for (const timer of this._timers) {
      const remaining = new Date(timer.endsAt).getTime() - now;

      if (remaining <= 0) {
        // Fired while AURA was closed — notify immediately
        console.log(`[TimerManager] Recovering expired timer: "${timer.label}"`);
        setTimeout(() => this._fireTimer(timer, true), 1500);
      } else {
        // Still pending — reschedule
        toKeep.push(timer);
        this._scheduleHandle(timer);
      }
    }

    this._timers = toKeep;
    this._save();
  }

  // ── Public API ───────────────────────────────────────────────────────────
  setTimer(label, seconds) {
    const id     = `timer-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const endsAt = new Date(Date.now() + seconds * 1000).toISOString();
    const timer  = {
      id,
      label:       label || `${Math.round(seconds / 60)} min timer`,
      durationSecs: seconds,
      endsAt,
      createdAt:   new Date().toISOString(),
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
    this._timers = this._timers.filter(t => t.id !== id);
    this._save();
    console.log(`[TimerManager] Cancelled: ${id}`);
  }

  listTimers() {
    const now = Date.now();
    return this._timers.map(t => ({
      ...t,
      remainingSecs: Math.max(0, Math.round((new Date(t.endsAt).getTime() - now) / 1000)),
    }));
  }

  // ── Internal scheduling ──────────────────────────────────────────────────
  _scheduleHandle(timer) {
    const delay  = Math.max(0, new Date(timer.endsAt).getTime() - Date.now());
    const handle = setTimeout(() => this._onComplete(timer.id), delay);
    this._handles[timer.id] = handle;
  }

  _onComplete(id) {
    const timer = this._timers.find(t => t.id === id);
    if (!timer) return;

    this._timers = this._timers.filter(t => t.id !== id);
    delete this._handles[id];
    this._save();

    this._fireTimer(timer, false);
  }

  _fireTimer(timer, wasMissed) {
    const body = wasMissed
      ? `Time's up: ${timer.label} (fired while AURA was closed)`
      : `Time's up: ${timer.label}`;

    // Native OS notification — always fires regardless of AURA window state
    try {
      if (Notification.isSupported()) {
        new Notification({ title: "AURA Timer", body, silent: false }).show();
      }
    } catch (e) {
      console.warn("[TimerManager] Notification failed:", e.message);
    }

    // Callback to main.js for IPC relay to UI + voice delivery
    if (this._onFired) this._onFired(timer, body);
    console.log(`[TimerManager] Fired: "${timer.label}" (missed=${wasMissed})`);
  }

  // ── 1-second countdown tick ──────────────────────────────────────────────
  _startTick() {
    this._tickTimer = setInterval(() => {
      if (this._onTick) this._onTick(this.listTimers());
    }, 1000);
  }

  // ── Cleanup on app quit ──────────────────────────────────────────────────
  destroy() {
    if (this._tickTimer) clearInterval(this._tickTimer);
    for (const h of Object.values(this._handles)) clearTimeout(h);
  }
}

module.exports = { TimerManager };
