"use strict";

const { runConversationTurn } = require("./conversationTurn");
const { RuntimeEventRouter } = require("./runtimeEventRouter");

// Backend-process composition of Core capabilities. Persistence and broadcast
// mechanics are supplied by the backend host adapter.
class AuraRuntime {
  constructor({ recordDiagnostic, broadcastEvent }) {
    this.conversation = Object.freeze({ runTurn: runConversationTurn });
    this.diagnostics = Object.freeze({ record: recordDiagnostic });
    this.events = new RuntimeEventRouter({ recordDiagnostic, broadcastEvent });
  }
}

module.exports = { AuraRuntime };
