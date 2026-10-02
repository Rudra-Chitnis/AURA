"use strict";

// Maps the existing desktop IPC and voice adapter calls onto desktop Core.
// Electron primitives and native effects are supplied by main.js.
function createRuntimeIpcAdapter({ getRuntime, send }) {
  const runtime = () => getRuntime();

  return {
    dispatchAction(request) {
      const current = runtime();
      return current?.actions.dispatch(request);
    },

    setTimer({ label, seconds }) {
      const current = runtime();
      const { result: timer } = current.actions.dispatch({ type: "timer.create", label, seconds });
      send("timer-tick", current.timers.listTimers());
      return timer;
    },

    cancelTimer(id) {
      const current = runtime();
      current.actions.dispatch({ type: "timer.cancel", id });
      send("timer-tick", current.timers.listTimers());
      return true;
    },

    listTimers() {
      return runtime()?.timers.listTimers() || [];
    },

    sendTimerList() {
      const current = runtime();
      if (!current) return;
      send("timer-tick", current.timers.listTimers());
    },

    setReminder({ text, fireAt }) {
      const current = runtime();
      const { result } = current.actions.dispatch({ type: "reminder.create", text, fireAt });
      return result;
    },

    cancelReminder(id) {
      const current = runtime();
      current.actions.dispatch({ type: "reminder.cancel", id });
      return true;
    },

    listReminders() {
      return runtime()?.reminders.listReminders() || [];
    },
  };
}

function registerRuntimeIpcHandlers(ipcMain, adapter) {
  ipcMain.handle("set-timer", (_event, request) => adapter.setTimer(request));
  ipcMain.handle("cancel-timer", (_event, id) => adapter.cancelTimer(id));
  ipcMain.handle("list-timers", () => adapter.listTimers());
  ipcMain.handle("set-reminder", (_event, request) => adapter.setReminder(request));
  ipcMain.handle("cancel-reminder", (_event, id) => adapter.cancelReminder(id));
  ipcMain.handle("list-reminders", () => adapter.listReminders());
}

function bindRuntimeEvents(runtime, { send, notifyTimer, notifyReminder, speak }) {
  const onState = state => send("runtime-state", state);
  const onTimerTick = timers => send("timer-tick", timers);
  const onTimerFired = ({ timer, body }) => {
    notifyTimer(body);
    send("timer-fired", { id: timer.id, label: timer.label, text: body });
    send("timer-tick", runtime.timers.listTimers());
    speak(body);
  };
  const onReminderUpdated = reminders => send("reminder-updated", reminders);
  const onReminderFired = ({ reminder, body }) => {
    notifyReminder(body);
    send("reminder-fired", { id: reminder.id, text: reminder.text, body });
    speak(body);
  };

  runtime.on("runtime:state", onState);
  runtime.on("timer:tick", onTimerTick);
  runtime.on("timer:fired", onTimerFired);
  runtime.on("reminder:updated", onReminderUpdated);
  runtime.on("reminder:fired", onReminderFired);

  return () => {
    runtime.removeListener("runtime:state", onState);
    runtime.removeListener("timer:tick", onTimerTick);
    runtime.removeListener("timer:fired", onTimerFired);
    runtime.removeListener("reminder:updated", onReminderUpdated);
    runtime.removeListener("reminder:fired", onReminderFired);
  };
}

module.exports = {
  createRuntimeIpcAdapter,
  registerRuntimeIpcHandlers,
  bindRuntimeEvents,
};
