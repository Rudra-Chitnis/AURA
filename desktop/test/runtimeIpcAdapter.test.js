"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createRuntimeIpcAdapter,
  registerRuntimeIpcHandlers,
} = require("../adapters/runtimeIpcAdapter");

test("IPC operations use the Core HTTP contract and preserve IPC return values", async () => {
  const requests = [];
  const sent = [];
  const timer = { id: "timer-1", label: "tea", durationSecs: 60 };
  const reminder = { id: "reminder-1", text: "tea", fireAt: "2030-01-01T00:00:00Z" };
  const request = async (url, options = {}) => {
    requests.push([url, options]);
    if (url.endsWith("/actions")) {
      const action = options.body;
      return { handled: true, type: action.type, result: action.type === "timer.create" ? timer : reminder };
    }
    return { timers: [timer], reminders: [reminder] };
  };
  const adapter = createRuntimeIpcAdapter({
    request,
    send: (...args) => sent.push(args),
    notifyTimer() {}, notifyReminder() {}, speak() {},
  });
  const handlers = new Map();
  registerRuntimeIpcHandlers({
    handle: (channel, handler) => handlers.set(channel, handler),
    on() {},
  }, adapter);

  assert.equal(await handlers.get("set-timer")({}, { label: "tea", seconds: 60 }), timer);
  assert.deepEqual(sent.pop(), ["timer-tick", [timer]]);
  assert.equal(await handlers.get("cancel-timer")({}, timer.id), true);
  assert.equal(await handlers.get("set-reminder")({}, { text: "tea", fireAt: reminder.fireAt }), reminder);
  assert.equal(await handlers.get("cancel-reminder")({}, reminder.id), true);
  assert.deepEqual(await handlers.get("list-timers")(), [timer]);
  assert.deepEqual(await handlers.get("list-reminders")(), [reminder]);
  assert.deepEqual(requests.filter(([url]) => url.endsWith("/actions")).map(([, options]) => options.body.type), [
    "timer.create", "timer.cancel", "reminder.create", "reminder.cancel",
  ]);
});

test("legacy voice markers use the same Core action endpoint", async () => {
  const actions = [];
  const adapter = createRuntimeIpcAdapter({
    request: async (url, options) => {
      assert.equal(url, "/api/runtime/actions");
      actions.push(options.body);
      return { handled: true };
    },
    send() {}, notifyTimer() {}, notifyReminder() {}, speak() {},
  });

  await adapter.dispatchAction({ type: "timer.create", label: "tea", seconds: 60 });
  assert.deepEqual(actions, [{ type: "timer.create", label: "tea", seconds: 60 }]);
});

test("Core events map to the existing IPC names and payloads", () => {
  const sent = [];
  const notifications = [];
  const spoken = [];
  const adapter = createRuntimeIpcAdapter({
    request: async () => ({}),
    send: (...args) => sent.push(args),
    notifyTimer: body => notifications.push(["timer", body]),
    notifyReminder: body => notifications.push(["reminder", body]),
    speak: body => spoken.push(body),
  });

  adapter.forwardCoreEvent({ type: "timer-tick", timers: [{ id: "t1" }] });
  adapter.forwardCoreEvent({ type: "timer-fired", id: "t1", label: "tea", text: "Time's up: tea" });
  adapter.forwardCoreEvent({ type: "reminder-updated", reminders: [{ id: "r1" }] });
  adapter.forwardCoreEvent({ type: "reminder-fired", id: "r1", text: "tea", body: "tea" });

  assert.deepEqual(sent, [
    ["timer-tick", [{ id: "t1" }]],
    ["timer-fired", { id: "t1", label: "tea", text: "Time's up: tea" }],
    ["reminder-updated", [{ id: "r1" }]],
    ["reminder-fired", { id: "r1", text: "tea", body: "tea" }],
  ]);
  assert.deepEqual(notifications, [["timer", "Time's up: tea"], ["reminder", "tea"]]);
  assert.deepEqual(spoken, ["Time's up: tea", "tea"]);
});
