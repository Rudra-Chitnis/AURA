"use strict";

const express = require("express");
const protect = require("../middleware/authMiddleware");

const isLoopback = address => address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";

function createRuntimeRouter(runtime) {
  const router = express.Router();
  router.use((req, res, next) => {
    if (isLoopback(req.socket?.remoteAddress)) return next();
    return protect(req, res, next);
  });

  router.get("/state", (_req, res) => res.json(runtime.getState()));
  router.post("/actions", (req, res, next) => {
    try { res.json(runtime.actions.dispatch(req.body)); }
    catch (error) { next(error); }
  });
  return router;
}

module.exports = { createRuntimeRouter };
