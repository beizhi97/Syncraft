export function describeSchedule(schedule = {}) {
  const normalized = normalizeSchedule(schedule);
  if (normalized.mode === "manual") {
    return "Manual only";
  }

  if (normalized.mode === "interval") {
    return `Every ${normalized.intervalMinutes} minutes`;
  }

  if (normalized.mode === "daily") {
    return `Daily at ${normalized.time}`;
  }

  if (normalized.mode === "startup") {
    return "Run on client startup";
  }

  return "Custom schedule";
}

export function computeNextRun(schedule = {}, now = new Date()) {
  const normalized = normalizeSchedule(schedule);
  if (normalized.mode === "manual") {
    return null;
  }

  if (normalized.mode === "interval") {
    return new Date(now.getTime() + normalized.intervalMinutes * 60 * 1000);
  }

  if (normalized.mode === "daily") {
    const [hour, minute] = normalized.time.split(":").map(Number);
    const next = new Date(now);
    next.setHours(hour || 0, minute || 0, 0, 0);
    if (next <= now) {
      next.setDate(next.getDate() + 1);
    }
    return next;
  }

  if (normalized.mode === "startup") {
    return "on-startup";
  }

  return null;
}

export function normalizeSchedule(schedule = {}) {
  const mode = String(schedule?.mode || "manual").trim().toLowerCase();
  if (mode === "manual") {
    return { mode: "manual" };
  }

  if (mode === "interval") {
    return {
      mode,
      intervalMinutes: normalizeIntervalMinutes(schedule.intervalMinutes)
    };
  }

  if (mode === "daily") {
    return {
      mode,
      time: normalizeDailyTime(schedule.time || "02:00")
    };
  }

  if (mode === "startup") {
    return { mode };
  }

  throw new Error("Schedule mode must be manual, interval, daily, or startup");
}

function normalizeIntervalMinutes(input) {
  const value = Number(input === undefined || input === null || input === "" ? 30 : input);
  if (!Number.isInteger(value) || value < 1 || value > 1440) {
    throw new Error("Schedule interval minutes must be between 1 and 1440");
  }
  return value;
}

function normalizeDailyTime(input) {
  const text = String(input || "").trim();
  const match = text.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    throw new Error("Schedule daily time must use HH:MM 24-hour format");
  }
  return `${match[1]}:${match[2]}`;
}
