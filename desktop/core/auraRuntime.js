"use strict";

const { EventEmitter } = require("events");
const { TimerManager } = require("./timerManager");
const { ReminderManager } = require("./reminderManager");
const { RuntimeLifecycle } = require("./runtimeLifecycle");
const { DeterministicActionRouter } = require("./deterministicActionRouter");
const { waitForBackend } = require("./backendReadiness");
const { createOllamaReadiness } = require("./ollamaReadiness");

// Headless runtime composition used by the desktop shell. This module has no
// dependency on Electron; the host supplies its persistent data directory.
class AuraRuntime extends EventEmitter {
  constructor({ dataDirectory, lifecycle = new RuntimeLifecycle(), ollama = {} }) {
    super();
    if (!dataDirectory) throw new Error("AuraRuntime requires a dataDirectory");
    this.dataDirectory = dataDirectory;
    this.lifecycle = lifecycle;
    this.state = "stopped";
    this.timers = new TimerManager({ dataDirectory, events: this });
    this.reminders = new ReminderManager({ dataDirectory, events: this });
    this.actions = new DeterministicActionRouter({
      timers: this.timers,
      reminders: this.reminders,
    });
    this.backendReadiness = Object.freeze({ waitForBackend });
    this.ollamaReadiness = createOllamaReadiness(ollama);
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

  setStartupPhase(phase) {
    return this.lifecycle.setPhase(phase);
  }

  getStartupPhase() {
    return this.lifecycle.getPhase();
  }
}

module.exports = { AuraRuntime };
