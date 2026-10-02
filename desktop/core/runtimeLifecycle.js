"use strict";

// Transport-neutral storage for the startup phase chosen by the host.
class RuntimeLifecycle {
  constructor(initialPhase = "launching") {
    this._phase = initialPhase;
  }

  setPhase(phase) {
    this._phase = phase;
    return this._phase;
  }

  getPhase() {
    return this._phase;
  }
}

module.exports = { RuntimeLifecycle };
