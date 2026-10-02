"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const test = require("node:test");
const { createRuntimeRouter } = require("../routes/runtimeRoute");

test("local runtime HTTP adapter maps state and normalized actions", async t => {
  const calls = [];
  const runtime = {
    getState: () => ({ state: "ready", timers: [], reminders: [] }),
    actions: { dispatch: action => (calls.push(action), { handled: true, type: action.type, result: "created" }) },
  };
  const app = express();
  app.use(express.json(), createRuntimeRouter(runtime));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => new Promise(resolve => server.close(resolve)));
  await new Promise(resolve => server.once("listening", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;

  const stateResponse = await fetch(`${origin}/state`);
  assert.deepEqual(await stateResponse.json(), { state: "ready", timers: [], reminders: [] });
  const actionResponse = await fetch(`${origin}/actions`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "timer.create", label: "tea", seconds: 60 }),
  });
  assert.deepEqual(await actionResponse.json(), { handled: true, type: "timer.create", result: "created" });
  assert.deepEqual(calls, [{ type: "timer.create", label: "tea", seconds: 60 }]);
});
