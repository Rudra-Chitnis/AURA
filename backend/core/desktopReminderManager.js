"use strict";

const fs = require("fs");
const path = require("path");

const MISSED_WINDOW_MS = 30 * 60 * 1000;

class DesktopReminderManager {
  constructor({ dataDirectory, events }) {
    this._dataPath = path.join(dataDirectory, "reminders.json");
    this._events = events;
    this._reminders = [];
    this._handles = {};
  }

  init() { this._load(); this._recover(); }

  _load() {
    try {
      if (fs.existsSync(this._dataPath)) this._reminders = JSON.parse(fs.readFileSync(this._dataPath, "utf8")) || [];
    } catch (e) { console.warn("[ReminderManager] Load failed:", e.message); this._reminders = []; }
  }

  _save() {
    try { fs.writeFileSync(this._dataPath, JSON.stringify(this._reminders, null, 2), "utf8"); }
    catch (e) { console.warn("[ReminderManager] Save failed:", e.message); }
  }

  _recover() {
    const now = Date.now(); const toKeep = [];
    for (const reminder of this._reminders) {
      const missedBy = now - new Date(reminder.fireAt).getTime();
      if (missedBy > 0 && missedBy <= MISSED_WINDOW_MS) {
        console.log(`[ReminderManager] Recovering missed reminder: "${reminder.text}"`);
        setTimeout(() => this._fireReminder(reminder, true), 2000);
      } else if (missedBy > MISSED_WINDOW_MS) {
        console.log(`[ReminderManager] Pruning stale reminder: "${reminder.text}"`);
      } else { toKeep.push(reminder); this._scheduleHandle(reminder); }
    }
    this._reminders = toKeep; this._save(); this._emitUpdated();
  }

  setReminder(text, fireAt) {
    const id = `reminder-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fireAtIso = typeof fireAt === "string" ? fireAt : new Date(fireAt).toISOString();
    const reminder = { id, text, fireAt: fireAtIso, createdAt: new Date().toISOString() };
    this._reminders.push(reminder); this._save(); this._scheduleHandle(reminder); this._emitUpdated();
    console.log(`[ReminderManager] Set: "${text}" at ${fireAtIso} (id=${id})`);
    return reminder;
  }

  cancelReminder(id) {
    const handle = this._handles[id];
    if (handle) { clearTimeout(handle); delete this._handles[id]; }
    this._reminders = this._reminders.filter(reminder => reminder.id !== id);
    this._save(); this._emitUpdated(); console.log(`[ReminderManager] Cancelled: ${id}`);
  }

  listReminders() { return this._reminders.map(reminder => ({ ...reminder })); }
  _emitUpdated() { this._events.emit("reminder:updated", this.listReminders()); }
  _scheduleHandle(reminder) {
    const delay = Math.max(0, new Date(reminder.fireAt).getTime() - Date.now());
    this._handles[reminder.id] = setTimeout(() => this._onDue(reminder.id), delay);
  }
  _onDue(id) {
    const reminder = this._reminders.find(item => item.id === id);
    if (!reminder) return;
    this._reminders = this._reminders.filter(item => item.id !== id);
    delete this._handles[id]; this._save(); this._emitUpdated(); this._fireReminder(reminder, false);
  }
  _fireReminder(reminder, wasMissed) {
    const body = wasMissed ? `${reminder.text} (you may have missed this)` : reminder.text;
    this._events.emit("reminder:fired", { reminder, body, wasMissed });
    console.log(`[ReminderManager] Fired: "${reminder.text}" (missed=${wasMissed})`);
  }
  destroy() { for (const handle of Object.values(this._handles)) clearTimeout(handle); }
}

module.exports = { DesktopReminderManager };
