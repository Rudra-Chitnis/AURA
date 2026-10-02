require("dotenv").config();

const express = require("express");
const cors = require("cors");
const connectMongo = require("./config/mongo");
const wsHub = require("./wsHub");

const logRoute          = require("./routes/logRoute");
const authRoute         = require("./routes/authRoute");
const memoryRoute       = require("./routes/memoryRoute");
const aiRoutes          = require("./routes/aiRoute");
const reminderRoute     = require("./routes/reminderRoute");
const conversationRoute = require("./routes/conversationRoute");
const diagnosticsRoute  = require("./routes/diagnosticsRoute");
const eventRoute        = require("./routes/eventRoute");
const { createRuntimeRouter } = require("./routes/runtimeRoute");

const errorHandler = require("./middleware/errorHandler");
const { startReminderScheduler, stopReminderScheduler, popFiredForUser } = require("./services/reminderScheduler");
const protect = require("./middleware/authMiddleware");
const auraRuntime = require("./auraRuntime");
const { bindCoreEvents } = require("./adapters/coreEventAdapter");

const app = express();

// Connect to MongoDB, then pre-warm the embedding model so the first
// real user query doesn't pay the cold-load penalty (~1-2 s).
connectMongo().then(async () => {
  try {
    const { generateEmbedding } = require("./services/embeddingService");
    await generateEmbedding("warmup");
    console.log("Embedding model warm and ready.");
  } catch (e) {
    console.warn("Embedding warmup failed (non-fatal):", e.message);
  }
});

app.use(cors());
app.use(express.json());

app.use("/api/log",          logRoute);
app.use("/api/auth",         authRoute);
app.use("/api/memory",       memoryRoute);
app.use("/api/ai",           aiRoutes);
app.use("/api/reminders",    reminderRoute);
app.use("/api/conversation", conversationRoute);
app.use("/api/diagnostics",  diagnosticsRoute);
app.use("/api/events",       eventRoute);
app.use("/api/runtime",      createRuntimeRouter(auraRuntime));

// Voice client polls this every ~30s to check if any reminders fired
app.get("/api/reminders/pending-voice", protect, (req, res) => {
  const fired = popFiredForUser(req.user._id.toString());
  res.json({ fired });
});

app.get("/", (req, res) => {
  res.send("AURA backend running");
});

// Health probe — used by Electron main.js to know when the backend is ready.
// Returns 200 only when both Express AND MongoDB are connected.
// Electron polls this before starting voice.py, so voice.py can authenticate immediately.
app.get("/api/health", (_req, res) => {
  const mongoose = require("mongoose");
  // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  if (mongoose.connection.readyState === 1) {
    res.json({ ok: true });
  } else {
    res.status(503).json({ ok: false, reason: "mongodb_not_ready" });
  }
});

// Global error handler — must be AFTER all routes
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

const unbindCoreEvents = bindCoreEvents(auraRuntime, event => wsHub.broadcast(event));
auraRuntime.start();
const server = app.listen(PORT, () => {
  console.log(`AURA backend running on port ${PORT}`);
  startReminderScheduler();
  wsHub.start(5001);   // start WebSocket hub for real-time UI updates
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  unbindCoreEvents();
  auraRuntime.stop();
  stopReminderScheduler();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await wsHub.stop();
  const mongoose = require("mongoose");
  if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
}

if (require.main === module) {
  const stop = () => shutdown().then(() => process.exit(0)).catch(error => {
    console.error("[AURA] Shutdown failed:", error);
    process.exit(1);
  });
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

module.exports = { app, server, shutdown };
