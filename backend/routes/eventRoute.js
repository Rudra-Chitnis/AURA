const express = require("express");
const router = express.Router();

const auraRuntime = require("../auraRuntime");

// POST /api/events/push — local runtime event ingress.
router.post("/push", (req, res) => {
  const event = req.body;
  const diagnosticEvent = event && event.type === "diagnostic"
    ? {
      ...event,
      type: event.diagnosticType || event.diagnostic_type || "runtime_event",
      source: event.source || "voice",
      data: event.data || {},
    }
    : null;

  const result = auraRuntime.events.route({ event, diagnosticEvent });
  if (result.kind === "diagnostic") {
    return res.json({ ok: true, clients: 0, event: result.event });
  }
  return res.json({ ok: true, clients: result.clients });
});

module.exports = router;
