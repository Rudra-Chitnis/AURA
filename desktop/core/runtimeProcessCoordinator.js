"use strict";

class RuntimeProcessCoordinator {
  constructor({
    backendPort,
    waitForBackend,
    ensureOllama,
    spawnBackend,
    startVoice,
    hasBackend,
    hasVoice,
    isQuitting,
    emitPhase,
    sendBackendStatus,
    sendVoiceStatus,
    log,
    sendVoiceQuit,
    killVoice,
    killBackend,
    schedule = setTimeout,
  }) {
    this._backendPort = backendPort;
    this._waitForBackend = waitForBackend;
    this._ensureOllama = ensureOllama;
    this._spawnBackend = spawnBackend;
    this._startVoice = startVoice;
    this._hasBackend = hasBackend;
    this._hasVoice = hasVoice;
    this._isQuitting = isQuitting;
    this._emitPhase = emitPhase;
    this._sendBackendStatus = sendBackendStatus;
    this._sendVoiceStatus = sendVoiceStatus;
    this._log = log;
    this._sendVoiceQuit = sendVoiceQuit;
    this._killVoice = killVoice;
    this._killBackend = killBackend;
    this._schedule = schedule;
    this._backendRestartCount = 0;
    this._voiceRestartCount = 0;
    this._backendFile = null;
  }

  startBackend(serverFile) {
    this._backendFile = serverFile;
    this._emitPhase("starting-backend");
    this._backendRestartCount = 0;
    this._spawnBackend(serverFile);

    this._waitForBackend(this._backendPort, 40000)
      .then(async () => {
        this._log("log", "[AURA] Backend health check passed.");
        this._backendRestartCount = 0;
        this._sendBackendStatus("online");

        await this._ensureOllama();
        this._startVoiceAfterBackend();
      })
      .catch(err => {
        this._log("warn", "[AURA] Backend health check failed:", err.message);
        // Preserve degraded startup: Ollama and voice are still attempted even
        // when backend health does not pass its initial readiness window.
        this._ensureOllama().then(() => this._startVoiceAfterBackend());
      });
  }

  backendExited(code) {
    if (!this._isQuitting() && this._backendRestartCount < 3) {
      const delay = Math.min(5000 * Math.pow(2, this._backendRestartCount), 30000);
      this._backendRestartCount++;
      this._log("log", `[AURA] Backend restart ${this._backendRestartCount}/3 in ${delay / 1000}s...`);
      this._schedule(() => {
        if (!this._hasBackend() && !this._isQuitting()) {
          this._spawnBackend(this._backendFile);
          this._waitForBackend(this._backendPort, 20000)
            .then(() => {
              this._log("log", "[AURA] Backend recovered — health check passed.");
              this._sendBackendStatus("online");
            })
            .catch(() => this._log("warn", "[AURA] Backend recovery health check failed."));
        }
      }, delay);
    } else if (!this._isQuitting()) {
      this._log("error", "[AURA] Backend failed to recover after 3 restarts. Manual intervention required.");
      this._sendBackendStatus("failed");
    }
  }

  startVoiceManually() {
    this._voiceRestartCount = 0;
    return this._startVoice();
  }

  voiceReady() {
    this._voiceRestartCount = 0;
  }

  voiceExited(code) {
    if (code !== 0 && !this._isQuitting()) {
      if (this._voiceRestartCount < 5) {
        const delay = Math.min(6000 * Math.pow(1.8, this._voiceRestartCount), 60000);
        this._voiceRestartCount++;
        this._log("log", `[AURA] Voice exited (code ${code}) — restart ${this._voiceRestartCount}/5 in ${Math.round(delay / 1000)}s...`);
        this._schedule(() => {
          if (!this._hasVoice() && !this._isQuitting()) {
            const proc = this._startVoice();
            this._sendVoiceStatus(proc ? "running" : "error");
          }
        }, delay);
      } else {
        this._log("error", "[AURA] Voice process failed 5 times — giving up. Check logs for root cause.");
        this._sendVoiceStatus("failed");
        this._emitPhase("ready");
      }
    } else if (code === 0) {
      this._log("log", "[AURA] Voice exited cleanly.");
    }
  }

  shutdown() {
    this._sendVoiceQuit();
    this._schedule(() => {
      this._killVoice();
      this._schedule(() => this._killBackend(), 500);
    }, 2000);
  }

  _startVoiceAfterBackend() {
    this._emitPhase("loading-voice");
    if (!this._hasVoice() && !this._isQuitting()) {
      const proc = this._startVoice();
      this._sendVoiceStatus(proc ? "running" : "error");
    }
  }
}

module.exports = { RuntimeProcessCoordinator };
