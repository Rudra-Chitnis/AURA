"use strict";

// Electron IPC is retained as a client contract. Runtime operations now cross
// the process boundary through the backend's local HTTP adapter.
function createRuntimeIpcAdapter({ request, send, notifyTimer, notifyReminder, speak }) {
  async function sendTimerList() {
    const state = await request("/api/runtime/state");
    send("timer-tick", state.timers || []);
  }

  return {
    async dispatchAction(action) {
      return request("/api/runtime/actions", { method: "POST", body: action });
    },

    async setTimer({ label, seconds }) {
      const { result: timer } = await this.dispatchAction({ type: "timer.create", label, seconds });
      await sendTimerList();
      return timer;
    },
    async cancelTimer(id) {
      await this.dispatchAction({ type: "timer.cancel", id });
      await sendTimerList();
      return true;
    },
    async listTimers() { return (await request("/api/runtime/state")).timers || []; },
    sendTimerList,
    async setReminder({ text, fireAt }) {
      const { result } = await this.dispatchAction({ type: "reminder.create", text, fireAt });
      return result;
    },
    async cancelReminder(id) {
      await this.dispatchAction({ type: "reminder.cancel", id });
      return true;
    },
    async listReminders() { return (await request("/api/runtime/state")).reminders || []; },

    forwardCoreEvent(event) {
      if (!event || typeof event.type !== "string") return;
      switch (event.type) {
        case "runtime-state": send("runtime-state", event.state); break;
        case "timer-tick": send("timer-tick", event.timers || []); break;
        case "timer-fired":
          notifyTimer(event.text);
          send("timer-fired", { id: event.id, label: event.label, text: event.text });
          speak(event.text);
          break;
        case "reminder-updated": send("reminder-updated", event.reminders || []); break;
        case "reminder-fired":
          notifyReminder(event.body);
          send("reminder-fired", { id: event.id, text: event.text, body: event.body });
          speak(event.body);
          break;
        default: break;
      }
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
  ipcMain.on("core-runtime-event", (_event, payload) => adapter.forwardCoreEvent(payload));
}

module.exports = { createRuntimeIpcAdapter, registerRuntimeIpcHandlers };
