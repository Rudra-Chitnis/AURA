"use strict";

const { EventEmitter } = require("events");
const { RuntimeLifecycle } = require("./runtimeLifecycle");
const { waitForBackend } = require("./backendReadiness");
const { createOllamaReadiness } = require("./ollamaReadiness");
const { RuntimeProcessCoordinator } = require("./runtimeProcessCoordinator");

// Headless runtime composition used by the desktop shell. This module has no
// dependency on Electron; the host supplies its persistent data directory.
class AuraRuntime extends EventEmitter {
  constructor({ lifecycle = new RuntimeLifecycle(), ollama = {}, processes = null }) {
    super();
    this.lifecycle = lifecycle;
    this.state = "stopped";
    this.backendReadiness = Object.freeze({ waitForBackend });
    this.ollamaReadiness = createOllamaReadiness(ollama);
    this.processes = processes ? new RuntimeProcessCoordinator(processes) : null;
  }

  start() {
    if (this.state === "ready") return;
    this.state = "starting";
    this.emit("runtime:state", this.state);
    this.state = "ready";
    this.emit("runtime:state", this.state);
  }

  stop() {
    if (this.state === "stopped") return;
    this.state = "stopped";
    this.emit("runtime:state", this.state);
  }

  getState() {
    return {
      state: this.state,
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
