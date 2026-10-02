"use strict";

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { runConversationTurn } = require("./conversationTurn");
const { RuntimeEventRouter } = require("./runtimeEventRouter");
const { TimerManager } = require("./timerManager");
const { DesktopReminderManager } = require("./desktopReminderManager");
const { DeterministicActionRouter } = require("./deterministicActionRouter");
const aiCapability = require("./aiCapability");
const memoryService = require("../services/memoryService");
const memoryConsolidation = require("../services/memoryConsolidationService");

// Backend-process composition of Core capabilities. Persistence and broadcast
// mechanics are supplied by the backend host adapter.
class AuraRuntime extends EventEmitter {
  constructor({ dataDirectory, diagnostics, recordDiagnostic, broadcastEvent }) {
    super();
    if (!dataDirectory) throw new Error("AuraRuntime requires a dataDirectory");
    this.dataDirectory = dataDirectory;
    this.state = "stopped";
    this.timers = new TimerManager({ dataDirectory, events: this });
    this.reminders = new DesktopReminderManager({ dataDirectory, events: this });
    this.actions = new DeterministicActionRouter({ timers: this.timers, reminders: this.reminders });
    this.conversation = Object.freeze({ runTurn: runConversationTurn });
    this.ai = Object.freeze({
      classifyQuery: aiCapability.classifyQuery,
      generateResponse: aiCapability.generateResponse,
      generateResponseStream: aiCapability.generateResponseStream,
    });
    this.memory = Object.freeze({
      store: memoryService.storeMemory,
      list: memoryService.getMemories,
      search: memoryService.searchMemory,
    });
    this.semanticLearning = Object.freeze({
      observeTurn: memoryConsolidation.observeTurn,
      getSummary: memoryConsolidation.getConsolidationSummary,
    });
    this.diagnostics = Object.freeze(diagnostics || { record: recordDiagnostic });
    this.events = new RuntimeEventRouter({ recordDiagnostic, broadcastEvent });
  }

  start() {
    if (this.state === "ready") return;
    fs.mkdirSync(this.dataDirectory, { recursive: true });
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
