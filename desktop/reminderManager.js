// ─── ReminderManager — Electron-native persistent reminder system ─────────────
//
// Ownership: Electron desktop runtime.  voice.py signals "AURA:SET_REMINDER:text:isoTime"
// via stdout; Electron owns scheduling, persistence, delivery, and recovery.
//
// Relationship to existing MongoDB path:
//   - MongoDB / backend reminderScheduler still handles history and listing.
//   - This manager replaces the fragile schtasks/PS1 delivery path.
//   - The two paths are ADDITIVE for delivery; MongoDB is authoritative for history.
//
// Storage  : %APPDATA%\AURA\reminders.json
// Survives : Electron restart.  Fires missed reminders (within MISSED_WINDOW).
//
// Lifecycle:
//   set → stored + scheduled → setTimeout → fired → notify + callback + remove
//
// Recovery window: 30 minutes.  Reminders missed > 30 min are silently pruned.
// This prevents stale reminders from flooding on startup after a long absence.
//
// Callbacks (set via init()):
//   onFired(reminder, text)    — called on delivery
//   onUpdated(reminders[])     — called after any mutation (set/cancel/fire)

"use strict";

const { Notification, app } = require("electron");
const path = require("path");
const fs   = require("fs");

const MISSED_WINDOW_MS = 30 * 60 * 1000;  // fire reminders missed within 30 min

class ReminderManager {
  constructor() {
    this._dataPath  = null;
    this._reminders = [];    // [{ id, text, fireAt, createdAt }]
    this._handles   = {};    // { id: timeoutHandle }
    this._onFired   = null;
    this._onUpdated = null;
  }

  // ── Initialise after app.whenReady() ────────────────────────────────────
  init(onFired, onUpdated) {
    this._dataPath  = path.join(app.getPath("userData"), "reminders.json");
    this._onFired   = onFired;
    this._onUpdated = onUpdated;
    this._load();
    this._recover();
  }

  // ── Persistence ──────────────────────────────────────────────────────────
  _load() {
    try {
      if (fs.existsSync(this._dataPath)) {
        this._reminders = JSON.parse(fs.readFileSync(this._dataPath, "utf8")) || [];
      }
    } catch (e) {
      console.warn("[ReminderManager] Load failed:", e.message);
      this._reminders = [];
    }
  }

  _save() {
    try {
      fs.writeFileSync(this._dataPath, JSON.stringify(this._reminders, null, 2), "utf8");
    } catch (e) {
      console.warn("[ReminderManager] Save failed:", e.message);
    }
  }

  // ── Startup recovery ─────────────────────────────────────────────────────
  _recover() {
    const now    = Date.now();
    const toKeep = [];

    for (const reminder of this._reminders) {
      const fireTime = new Date(reminder.fireAt).getTime();
      const missedBy = now - fireTime;

      if (missedBy > 0 && missedBy <= MISSED_WINDOW_MS) {
        // Missed recently — fire with startup-settle delay
        console.log(`[ReminderManager] Recovering missed reminder: "${reminder.text}"`);
        setTimeout(() => this._fireReminder(reminder, true), 2000);
      } else if (missedBy > MISSED_WINDOW_MS) {
        // Too stale — prune silently
        console.log(`[ReminderManager] Pruning stale reminder: "${reminder.text}"`);
      } else {
        // Future — reschedule
        toKeep.push(reminder);
        this._scheduleHandle(reminder);
      }
    }

    this._reminders = toKeep;
    this._save();
    if (this._onUpdated) this._onUpdated(this.listReminders());
  }

  // ── Public API ───────────────────────────────────────────────────────────
  setReminder(text, fireAt) {
    // fireAt: ISO 8601 string or Date object
    const id       = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fireAtIso = typeof fireAt === "string" ? fireAt : new Date(fireAt).toISOString();
    const reminder  = {
      id,
      text,
      fireAt:    fireAtIso,
      createdAt: new Date().toISOString(),
    };

    this._reminders.push(reminder);
    this._save();
    this._scheduleHandle(reminder);
    if (this._onUpdated) this._onUpdated(this.listReminders());

    console.log(`[ReminderManager] Set: "${text}" at ${fireAtIso} (id=${id})`);
    return reminder;
  }

  cancelReminder(id) {
    const handle = this._handles[id];
    if (handle) { clearTimeout(handle); delete this._handles[id]; }
    this._reminders = this._reminders.filter(r => r.id !== id);
    this._save();
    if (this._onUpdated) this._onUpdated(this.listReminders());
    console.log(`[ReminderManager] Cancelled: ${id}`);
  }

  listReminders() {
    return this._reminders.map(r => ({ ...r }));
  }

  // ── Internal scheduling ──────────────────────────────────────────────────
  _scheduleHandle(reminder) {
    const delay  = Math.max(0, new Date(reminder.fireAt).getTime() - Date.now());
    const handle = setTimeout(() => this._onDue(reminder.id), delay);
    this._handles[reminder.id] = handle;
  }

  _onDue(id) {
    const reminder = this._reminders.find(r => r.id === id);
    if (!reminder) return;

    this._reminders = this._reminders.filter(r => r.id !== id);
    delete this._handles[id];
    this._save();
    if (this._onUpdated) this._onUpdated(this.listReminders());

    this._fireReminder(reminder, false);
  }

  _fireReminder(reminder, wasMissed) {
    const body = wasMissed
      ? `${reminder.text} (you may have missed this)`
      : reminder.text;

    // Native OS notification
    try {
      if (Notification.isSupported()) {
        new Notification({ title: "AURA Reminder", body, silent: false }).show();
      }
    } catch (e) {
      console.warn("[ReminderManager] Notification failed:", e.message);
    }

    if (this._onFired) this._onFired(reminder, body);
    console.log(`[ReminderManager] Fired: "${reminder.text}" (missed=${wasMissed})`);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────
  destroy() {
    for (const h of Object.values(this._handles)) clearTimeout(h);
  }
}

module.exports = { ReminderManager };
