"use strict";

const diagnostics = require("./services/runtimeDiagnosticsService");
const wsHub = require("./wsHub");
const path = require("path");
const os = require("os");
const { AuraRuntime } = require("./core/auraRuntime");

// Bind transport and persistence adapters once for the backend process.
module.exports = new AuraRuntime({
  dataDirectory: process.env.AURA_DATA_DIR || path.join(os.homedir(), ".aura-core"),
  diagnostics,
  recordDiagnostic: event => diagnostics.record(event),
  broadcastEvent: event => wsHub.broadcast(event),
});
