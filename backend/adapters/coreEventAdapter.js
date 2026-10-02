"use strict";

// Adapt backend Core events to the existing renderer-facing WebSocket event
// envelope. Broadcast mechanics remain supplied by the backend host.
function bindCoreEvents(runtime, broadcast) {
  const publish = (type, payload) => broadcast({ type, ...payload });
  const listeners = [
    ["runtime:state", state => publish("runtime-state", { state })],
    ["timer:tick", timers => publish("timer-tick", { timers })],
    ["timer:fired", ({ timer, body }) => {
      publish("timer-fired", { id: timer.id, label: timer.label, text: body });
      publish("timer-tick", { timers: runtime.timers.listTimers() });
    }],
    ["reminder:updated", reminders => publish("reminder-updated", { reminders })],
    ["reminder:fired", ({ reminder, body }) => publish("reminder-fired", { id: reminder.id, text: reminder.text, body })],
  ];

  for (const [event, listener] of listeners) runtime.on(event, listener);
  return () => listeners.forEach(([event, listener]) => runtime.removeListener(event, listener));
}

module.exports = { bindCoreEvents };
