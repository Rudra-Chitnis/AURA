"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const test = require("node:test");
const { AuraRuntime } = require("../core/auraRuntime");
const { bindCoreEvents } = require("../adapters/coreEventAdapter");

function makeRuntime(dataDirectory, broadcastEvent = () => 0) {
  const diagnosticRecords = [];
  const recordDiagnostic = event => (diagnosticRecords.push(event), event);
  const runtime = new AuraRuntime({
    dataDirectory,
    diagnostics: { record: recordDiagnostic },
    recordDiagnostic,
    broadcastEvent,
  });
  return { runtime, diagnosticRecords };
}

test("backend Core composes and runs timer/reminder capabilities without Electron", async t => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "aura-core-"));
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }));
  const { runtime } = makeRuntime(dataDirectory);
  const stopEvents = bindCoreEvents(runtime, () => 0);
  t.after(() => { stopEvents(); runtime.stop(); });

  runtime.start();
  assert.equal(runtime.getState().state, "ready");
  const createdTimer = runtime.actions.dispatch({ type: "timer.create", label: "tea", seconds: 30 }).result;
  const createdReminder = runtime.actions.dispatch({
    type: "reminder.create", text: "tea", fireAt: new Date(Date.now() + 60_000).toISOString(),
  }).result;
  assert.equal(runtime.getState().timers[0].id, createdTimer.id);
  assert.equal(runtime.getState().reminders[0].id, createdReminder.id);

  assert.equal(runtime.actions.dispatch({ type: "timer.cancel", id: createdTimer.id }).result, true);
  assert.equal(runtime.actions.dispatch({ type: "reminder.cancel", id: createdReminder.id }).result, true);
  assert.deepEqual(runtime.getState().timers, []);
  assert.deepEqual(runtime.getState().reminders, []);

  const timerFired = once(runtime, "timer:fired");
  runtime.actions.dispatch({ type: "timer.create", label: "short", seconds: 0.03 });
  const [timerEvent] = await timerFired;
  assert.equal(timerEvent.timer.label, "short");
  assert.equal(timerEvent.wasMissed, false);

  const reminderFired = once(runtime, "reminder:fired");
  runtime.actions.dispatch({ type: "reminder.create", text: "short reminder", fireAt: new Date(Date.now() + 30).toISOString() });
  const [reminderEvent] = await reminderFired;
  assert.equal(reminderEvent.reminder.text, "short reminder");
  assert.equal(reminderEvent.body, "short reminder");

  assert.equal(fs.existsSync(path.join(dataDirectory, "timers.json")), true);
  assert.equal(fs.existsSync(path.join(dataDirectory, "reminders.json")), true);
  runtime.stop();
  assert.equal(runtime.getState().state, "stopped");
});

test("Core event adapter retains renderer-compatible WebSocket event envelopes", () => {
  const emitted = [];
  const { runtime } = makeRuntime(path.join(os.tmpdir(), "unused-aura-core"));
  runtime.timers = { listTimers: () => [{ id: "t1" }] };
  const unbind = bindCoreEvents(runtime, event => (emitted.push(event), 1));
  runtime.emit("timer:fired", { timer: { id: "t1", label: "tea" }, body: "Time's up: tea", wasMissed: false });
  runtime.emit("reminder:updated", [{ id: "r1", text: "tea" }]);
  runtime.emit("reminder:fired", { reminder: { id: "r1", text: "tea" }, body: "tea", wasMissed: false });
  unbind();

  assert.deepEqual(emitted, [
    { type: "timer-fired", id: "t1", label: "tea", text: "Time's up: tea" },
    { type: "timer-tick", timers: [{ id: "t1" }] },
    { type: "reminder-updated", reminders: [{ id: "r1", text: "tea" }] },
    { type: "reminder-fired", id: "r1", text: "tea", body: "tea" },
  ]);
});

test("Core facade routes diagnostics and exposes existing conversation/memory capabilities", () => {
  const { runtime, diagnosticRecords } = makeRuntime(path.join(os.tmpdir(), "unused-aura-core"), event => event);
  assert.equal(typeof runtime.conversation.runTurn, "function");
  assert.equal(typeof runtime.memory.search, "function");
  assert.equal(typeof runtime.semanticLearning.observeTurn, "function");
  runtime.diagnostics.record({ source: "test", type: "test_event" });
  assert.equal(diagnosticRecords[0].type, "test_event");
  const result = runtime.events.route({ event: { type: "voice", state: "idle" } });
  assert.deepEqual(result, { kind: "broadcast", clients: { type: "voice", state: "idle" } });
});
