"use strict";

const { EventEmitter } = require("events");
const { TimerManager } = require("./timerManager");
const { ReminderManager } = require("./reminderManager");

// Headless runtime composition used by the desktop shell. This module has no
// dependency on Electron; the host supplies its persistent data directory.
class AuraRuntime extends EventEmitter {
  constructor({ dataDirectory }) {
    super();
    if (!dataDirectory) throw new Error("AuraRuntime requires a dataDirectory");
    this.dataDirectory = dataDirectory;
    this.state = "stopped";
    this.timers = new TimerManager({ dataDirectory, events: this });
    this.reminders = new ReminderManager({ dataDirectory, events: this });
  }

  start() {
    if (this.state === "ready") return;
    this.state = "starting";
    this.emit("runtime:state", this.state);
    this.timers.init();
    this.reminders.init();
    this.state = "ready";
    this.emit("runtime:state", this.state);
  }

  stop() {
    if (this.state === "stopped") return;
    this.timers.destroy();
    this.reminders.destroy();
    this.state = "stopped";
    this.emit("runtime:state", this.state);
  }

  getState() {
    return {
      state: this.state,
      timers: this.timers.listTimers(),
      reminders: this.reminders.listReminders(),
    };
  }
}

module.exports = { AuraRuntime };
