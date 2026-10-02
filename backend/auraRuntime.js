"use strict";

const diagnostics = require("./services/runtimeDiagnosticsService");
const wsHub = require("./wsHub");
const { AuraRuntime } = require("./core/auraRuntime");

// Bind transport and persistence adapters once for the backend process.
module.exports = new AuraRuntime({
  recordDiagnostic: event => diagnostics.record(event),
  broadcastEvent: event => wsHub.broadcast(event),
});
