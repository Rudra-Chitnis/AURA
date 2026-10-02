const http = require("http");

function createOllamaReadiness({
  port = 11434,
  primaryModel = "mistral",
  onStatus = () => {},
  onLog = () => {},
  pollIntervalMs = 5000,
}) {
  function checkServer(timeout = 5000) {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/`, (res) => {
        resolve(true);
        res.resume();
      });
      req.on("error", () => resolve(false));
      req.setTimeout(timeout, () => { req.destroy(); resolve(false); });
    });
  }

  function checkModels(timeout = 5000) {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/api/tags`, (res) => {
        let body = "";
        res.on("data", d => { body += d; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body);
            const names = (parsed.models || []).map(m => m.name || "");
            resolve(names);
          } catch { resolve(null); }
        });
      });
      req.on("error", () => resolve(null));
      req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    });
  }

  function modelAvailable(modelList) {
    if (!modelList) return false;
    return modelList.some(n => n.toLowerCase().startsWith(primaryModel.toLowerCase()));
  }

  async function waitForServer(timeout = 45000, interval = 1500, probeTimeout = 1500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, interval));
      if (await checkServer(probeTimeout)) return true;
    }
    return false;
  }

  function pollUntilServerReady(attempts, maxAttempts) {
    if (attempts >= maxAttempts) {
      onLog("warn", "[AURA] Ollama not responding after 6 minutes — marking unavailable.");
      onStatus("unavailable");
      return;
    }
    setTimeout(async () => {
      const up = await checkServer(3000);
      if (up) {
        onLog("log", `[AURA] Ollama became available after ~${45 + attempts * 5}s.`);
        const models = await checkModels(3000);
        if (modelAvailable(models)) {
          onStatus("running");
        } else {
          onStatus("loading-model");
          pollUntilModelReady(0, 36);
        }
      } else {
        pollUntilServerReady(attempts + 1, maxAttempts);
      }
    }, pollIntervalMs);
  }

  function pollUntilModelReady(attempts, maxAttempts) {
    if (attempts >= maxAttempts) {
      onLog("warn", `[AURA] Model '${primaryModel}' not found after polling. May need: ollama pull ${primaryModel}`);
      onStatus("unavailable");
      return;
    }
    setTimeout(async () => {
      const models = await checkModels(3000);
      if (modelAvailable(models)) {
        onLog("log", `[AURA] Model '${primaryModel}' now available.`);
        onStatus("running");
      } else {
        pollUntilModelReady(attempts + 1, maxAttempts);
      }
    }, pollIntervalMs);
  }

  return {
    checkServer,
    checkModels,
    modelAvailable,
    waitForServer,
    pollUntilServerReady,
    pollUntilModelReady,
  };
}

module.exports = { createOllamaReadiness };
