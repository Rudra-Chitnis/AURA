"use strict";

class DeterministicActionRouter {
  constructor({ timers, reminders }) {
    this._timers = timers;
    this._reminders = reminders;
  }

  dispatch(request) {
    if (!request || typeof request.type !== "string") {
      return { handled: false };
    }

    switch (request.type) {
      case "timer.create":
        return {
          handled: true,
          type: request.type,
          result: this._timers.setTimer(request.label, request.seconds),
        };
      case "timer.cancel":
        this._timers.cancelTimer(request.id);
        return { handled: true, type: request.type, result: true };
      case "reminder.create":
        return {
          handled: true,
          type: request.type,
          result: this._reminders.setReminder(request.text, request.fireAt),
        };
      case "reminder.cancel":
        this._reminders.cancelReminder(request.id);
        return { handled: true, type: request.type, result: true };
      default:
        return { handled: false };
    }
  }
}

module.exports = { DeterministicActionRouter };
