const errorHandler = (err, req, res, next) => {
  console.error("AURA Error:", err.message);

  // Known user-facing errors (thrown manually) get a 400
  const statusCode = err.statusCode || (err.message.includes("already exists") || err.message.includes("not found") || err.message.includes("Invalid") ? 400 : 500);

  res.status(statusCode).json({
    message: err.message || "Internal server error"
  });
};

module.exports = errorHandler;