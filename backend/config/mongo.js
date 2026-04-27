const mongoose = require("mongoose");

const connectMongo = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,   // fail fast if Mongo is unreachable at startup
      heartbeatFrequencyMS:    10000,   // check connection health every 10s
      socketTimeoutMS:         45000,   // close idle sockets after 45s
    });
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection error:", error);
    process.exit(1);
  }
};

// Runtime disconnect handling — do NOT exit; mongoose will auto-reconnect.
mongoose.connection.on("disconnected", () => {
  console.warn("[MongoDB] Disconnected — will auto-reconnect");
});
mongoose.connection.on("reconnected", () => {
  console.log("[MongoDB] Reconnected successfully");
});
mongoose.connection.on("error", (err) => {
  // Log but don't crash — mongoose manages reconnect internally
  console.error("[MongoDB] Runtime error:", err.message);
});

module.exports = connectMongo;