"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const {
  bindRuntimeEvents,
  createRuntimeIpcAdapter,
  registerRuntimeIpcHandlers,
} = require("../adapters/runtimeIpcAdapter");

test("desktop IPC requests map to existing Core actions and payloads", async () => {
  const calls = [];
  const sent = [];
  const timer = { id: "timer-1", label: "tea", durationSecs: 60 };
  const reminder = { id: "reminder-1", text: "tea", fireAt: "2030-01-01T00:00:00Z" };
  const runtime = {
    actions: {
      dispatch(request) {
        calls.push(request);
        return { handled: true, result: request.type === "timer.create" ? timer : reminder };
      },
    },
    timers: { listTimers: () => [timer] },
    reminders: { listReminders: () => [reminder] },
  };
  const adapter = createRuntimeIpcAdapter({ getRuntime: () => runtime, send: (...args) => sent.push(args) });
  const handlers = new Map();
  registerRuntimeIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, adapter);

  assert.equal(await handlers.get("set-timer")({}, { label: "tea", seconds: 60 }), timer);
  assert.deepEqual(sent.pop(), ["timer-tick", [timer]]);
  assert.equal(await handlers.get("cancel-timer")({}, timer.id), true);
  assert.equal(await handlers.get("set-reminder")({}, { text: "tea", fireAt: reminder.fireAt }), reminder);
  assert.equal(await handlers.get("cancel-reminder")({}, reminder.id), true);
  assert.deepEqual(await handlers.get("list-timers")(), [timer]);
  assert.deepEqual(await handlers.get("list-reminders")(), [reminder]);
  assert.deepEqual(calls.map(call => call.type), [
    "timer.create", "timer.cancel", "reminder.create", "reminder.cancel",
  ]);
});

test("voice marker adapter dispatches the same normalized Core action", () => {
  const requests = [];
  const adapter = createRuntimeIpcAdapter({
    getRuntime: () => ({ actions: { dispatch: request => (requests.push(request), { handled: true }) } }),
    send() {},
  });

  adapter.dispatchAction({ type: "timer.create", label: "tea", seconds: 60 });
  assert.deepEqual(requests, [{ type: "timer.create", label: "tea", seconds: 60 }]);
  assert.equal(createRuntimeIpcAdapter({ getRuntime: () => null, send() {} }).dispatchAction({ type: "timer.create" }), undefined);
});

test("Core runtime events retain existing IPC event names and payload mappings", () => {
  const runtime = new EventEmitter();
  runtime.timers = { listTimers: () => [{ id: "timer-2" }] };
  const sent = [];
  const notifications = [];
  const spoken = [];
  const unbind = bindRuntimeEvents(runtime, {
    send: (...args) => sent.push(args),
    notifyTimer: body => notifications.push(["timer", body]),
    notifyReminder: body => notifications.push(["reminder", body]),
    speak: body => spoken.push(body),
  });

  runtime.emit("runtime:state", "ready");
  runtime.emit("timer:tick", [{ id: "timer-2", remainingSecs: 60 }]);
  runtime.emit("timer:fired", { timer: { id: "timer-2", label: "tea" }, body: "Time's up: tea", wasMissed: true });
  runtime.emit("reminder:updated", [{ id: "reminder-2", text: "tea" }]);
  runtime.emit("reminder:fired", { reminder: { id: "reminder-2", text: "tea" }, body: "tea", wasMissed: false });

  assert.deepEqual(sent, [
    ["runtime-state", "ready"],
    ["timer-tick", [{ id: "timer-2", remainingSecs: 60 }]],
    ["timer-fired", { id: "timer-2", label: "tea", text: "Time's up: tea" }],
    ["timer-tick", [{ id: "timer-2" }]],
    ["reminder-updated", [{ id: "reminder-2", text: "tea" }]],
    ["reminder-fired", { id: "reminder-2", text: "tea", body: "tea" }],
  ]);
  assert.deepEqual(notifications, [["timer", "Time's up: tea"], ["reminder", "tea"]]);
  assert.deepEqual(spoken, ["Time's up: tea", "tea"]);
  unbind();
  assert.equal(runtime.listenerCount("timer:fired"), 0);
});
