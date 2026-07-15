const UNIT_ALIASES = new Map([
  ["k", "k"],
  ["kb", "k"],
  ["kb/s", "k"],
  ["m", "M"],
  ["mb", "M"],
  ["mb/s", "M"],
  ["g", "G"],
  ["gb", "G"],
  ["gb/s", "G"]
]);

export function normalizeBandwidthLimit(input = "off") {
  if (input && typeof input === "object" && !Array.isArray(input)) {
    if (!input.enabled) {
      return "off";
    }
    if (input.mode === "schedule") {
      return serializeBandwidthTimetable(input);
    }
    return serializeBandwidthLimit(input.value, input.unit);
  }

  const text = String(input || "").trim();
  if (!text || /^off$/i.test(text)) {
    return "off";
  }

  if (isBandwidthTimetable(text)) {
    return normalizeBandwidthTimetable(text);
  }

  const match = text.match(/^([1-9]\d*)\s*([kKmMgG])$/);
  if (!match) {
    throw new Error("Bandwidth limit must be off or a positive value with k, M, or G unit");
  }
  return serializeBandwidthLimit(match[1], match[2]);
}

export function parseBandwidthLimit(input = "off") {
  const normalized = normalizeBandwidthLimit(input);
  if (normalized === "off") {
    return {
      enabled: false,
      mode: "fixed",
      value: "",
      unit: "M",
      startTime: "08:00",
      endTime: "18:00"
    };
  }

  const timetable = normalized.match(/^(\d{2}:\d{2}),([1-9]\d*)([kMG])\s+(\d{2}:\d{2}),off$/);
  if (timetable) {
    return {
      enabled: true,
      mode: "schedule",
      value: Number(timetable[2]),
      unit: timetable[3],
      startTime: timetable[1],
      endTime: timetable[4]
    };
  }

  const match = normalized.match(/^([1-9]\d*)([kMG])$/);
  return {
    enabled: true,
    mode: "fixed",
    value: Number(match[1]),
    unit: match[2],
    startTime: "08:00",
    endTime: "18:00"
  };
}

function serializeBandwidthLimit(value, unit) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error("Bandwidth limit value must be a positive integer");
  }

  const normalizedUnit = normalizeUnit(unit);
  return `${number}${normalizedUnit}`;
}

function serializeBandwidthTimetable(input) {
  const startTime = normalizeTime(input.startTime);
  const endTime = normalizeTime(input.endTime);
  if (startTime === endTime) {
    throw new Error("Bandwidth limit schedule start and end time must differ");
  }
  return `${startTime},${serializeBandwidthLimit(input.value, input.unit)} ${endTime},off`;
}

function isBandwidthTimetable(text) {
  return /^\d{2}:\d{2},[1-9]\d*[kKmMgG]\s+\d{2}:\d{2},off$/i.test(text);
}

function normalizeBandwidthTimetable(text) {
  const match = text.trim().match(/^(\d{2}:\d{2}),([1-9]\d*[kKmMgG])\s+(\d{2}:\d{2}),off$/i);
  const startTime = normalizeTime(match[1]);
  const endTime = normalizeTime(match[3]);
  if (startTime === endTime) {
    throw new Error("Bandwidth limit schedule start and end time must differ");
  }
  return `${startTime},${normalizeBandwidthLimit(match[2])} ${endTime},off`;
}

function normalizeTime(value) {
  const text = String(value || "").trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(text)) {
    throw new Error("Bandwidth limit schedule time must use HH:MM 24-hour format");
  }
  return text;
}

function normalizeUnit(unit) {
  const text = String(unit || "").trim().toLowerCase();
  const normalized = UNIT_ALIASES.get(text);
  if (!normalized) {
    throw new Error("Bandwidth limit unit must be KB/s, MB/s, or GB/s");
  }
  return normalized;
}
