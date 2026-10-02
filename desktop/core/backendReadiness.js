const http = require("http");

// Resolve when the backend health endpoint reports ready (HTTP 200).
// HTTP 503 means Express is up but MongoDB is not ready yet, so keep polling.
function waitForBackend(port, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeout;
    const attempt = () => {
      const req = http.get(`http://localhost:${port}/api/health`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else if (Date.now() >= deadline) {
          reject(new Error(`Backend health check timed out (last status: ${res.statusCode})`));
        } else {
          setTimeout(attempt, 600);
        }
        res.resume();
      });
      req.on("error", () => {
        if (Date.now() >= deadline) {
          reject(new Error("Backend health check timed out"));
        } else {
          setTimeout(attempt, 600);
        }
      });
      req.setTimeout(500, () => req.destroy());
    };
    attempt();
  });
}

module.exports = { waitForBackend };
