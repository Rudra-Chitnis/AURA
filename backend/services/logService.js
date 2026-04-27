const Log = require("../models/logModel");

const createLog = async (message) => {
  const log = new Log({ message });
  return await log.save();
};

const getLogs = async (limit = 50) => {
  return await Log.find().sort({ time: -1 }).limit(limit);
};

module.exports = {
  createLog,
  getLogs
};
