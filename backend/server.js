require("dotenv").config();

const express = require("express");
const cors = require("cors");
const connectMongo = require("./config/mongo");

const logRoute = require("./routes/logRoute");
const authRoute = require("./routes/authRoute");
const memoryRoute = require("./routes/memoryRoute");
const aiRoutes = require("./routes/aiRoute");
const reminderRoute = require("./routes/reminderRoute");

const errorHandler = require("./middleware/errorHandler");
const { startReminderScheduler, popFiredForUser } = require("./services/reminderScheduler");
const protect = require("./middleware/authMiddleware");

const app = express();

connectMongo();

app.use(cors());
app.use(express.json());

app.use("/api/log", logRoute);
app.use("/api/auth", authRoute);
app.use("/api/memory", memoryRoute);
app.use("/api/ai", aiRoutes);
app.use("/api/reminders", reminderRoute);

// Voice client polls this every ~30s to check if any reminders fired
app.get("/api/reminders/pending-voice", protect, (req, res) => {
  const fired = popFiredForUser(req.user._id.toString());
  res.json({ fired });
});

app.get("/", (req, res) => {
  res.send("AURA backend running");
});

// Global error handler — must be AFTER all routes
app.use(errorHandler);

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`AURA backend running on port ${PORT}`);
  startReminderScheduler();
});