"use strict";

// Routes normalized runtime events through host-provided diagnostic and
// broadcast handlers without depending on either transport.
class RuntimeEventRouter {
  constructor({ recordDiagnostic, broadcastEvent }) {
    this._recordDiagnostic = recordDiagnostic;
    this._broadcastEvent = broadcastEvent;
  }

  route({ event, diagnosticEvent = null }) {
    if (diagnosticEvent) {
      try {
        return { kind: "diagnostic", event: this._recordDiagnostic(diagnosticEvent) };
      } catch (_) {
        // A diagnostic failure must not prevent the original event reaching clients.
      }
    }

    return { kind: "broadcast", clients: this._broadcastEvent(event) };
  }
}

module.exports = { RuntimeEventRouter };
