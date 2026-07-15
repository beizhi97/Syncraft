const UNIT_FACTORS = new Map([
  ["b", 1],
  ["byte", 1],
  ["bytes", 1],
  ["kb", 1000],
  ["kbyte", 1000],
  ["kbytes", 1000],
  ["mb", 1000 ** 2],
  ["mbyte", 1000 ** 2],
  ["mbytes", 1000 ** 2],
  ["gb", 1000 ** 3],
  ["gbyte", 1000 ** 3],
  ["gbytes", 1000 ** 3],
  ["tb", 1000 ** 4],
  ["tbyte", 1000 ** 4],
  ["tbytes", 1000 ** 4],
  ["kib", 1024],
  ["mib", 1024 ** 2],
  ["gib", 1024 ** 3],
  ["tib", 1024 ** 4]
]);

const VALUE_UNIT = "([0-9]+(?:\\.[0-9]+)?)\\s*([KMGT]?i?B|[KMGT]?Bytes?|Bytes?)";
const SPEED_RE = new RegExp(`${VALUE_UNIT}\\s*/s`, "gi");
const TRANSFERRED_RE = new RegExp(`Transferred:\\s*${VALUE_UNIT}\\s*/\\s*${VALUE_UNIT}`, "i");
const conflictFilesBySummary = new WeakMap();

export function parseRcloneStats(text, options = {}) {
  const lines = String(text || "").replace(/\r/g, "\n").split("\n");
  let latest = null;

  for (const line of lines) {
    const parsed = parseRcloneStatsLine(line, options);
    if (parsed) {
      latest = mergeParsedStats(latest, parsed);
    }
  }

  return latest;
}

export function parseRcloneStatsLine(line, options = {}) {
  const text = String(line || "").trimEnd();
  const phase = parsePhase(text);
  const speed = parseSpeed(text);
  const transferred = parseTransferred(text);
  const currentFile = parseCurrentFile(text);
  const conflict = parseConflict(text, options);
  const failure = parseRcloneFailure(text);

  if (!phase && !speed && !transferred && !currentFile && !conflict && !failure) {
    return null;
  }

  return removeUndefined({
    ...phase,
    ...speed,
    ...transferred,
    ...currentFile,
    ...conflict,
    ...failure,
    updatedAt: new Date().toISOString()
  });
}

function mergeParsedStats(existing, next) {
  const merged = {
    ...(existing || {}),
    ...next,
    updatedAt: next.updatedAt
  };
  if (existing?.conflicts || next.conflicts) {
    merged.conflicts = mergeRcloneConflictSummary(existing?.conflicts, next.conflicts);
  }
  return merged;
}

export function mergeRcloneConflictSummary(existing = null, next = null) {
  if (!next) {
    return existing || { count: 0, files: [], truncated: false };
  }
  const allUniqueFiles = new Set([
    ...trackedConflictFiles(existing),
    ...trackedConflictFiles(next)
  ]);
  const uniqueFiles = [...allUniqueFiles].slice(0, 10);
  const count = Math.max(
    allUniqueFiles.size,
    Number(existing?.count || 0),
    Number(next.count || 0)
  );
  const summary = {
    count,
    files: uniqueFiles,
    truncated: Boolean(existing?.truncated || next.truncated || count > uniqueFiles.length)
  };
  conflictFilesBySummary.set(summary, allUniqueFiles);
  return summary;
}

function trackedConflictFiles(summary) {
  if (!summary || typeof summary !== "object") {
    return [];
  }
  return conflictFilesBySummary.get(summary) || (summary.files || []).filter(Boolean);
}

export function mergeRcloneProgress(existing = {}, parsed = null) {
  if (!parsed) {
    return existing;
  }

  const wasTransferring = existing.phase === "transferring";
  const phase = wasTransferring || parsed.phase === "transferring"
    ? "transferring"
    : "scanning";
  const merged = {
    ...existing,
    ...parsed,
    phase
  };

  if (phase === "scanning") {
    return {
      ...merged,
      progressPercent: null,
      transferredText: "",
      transferredSizeText: "",
      transferredBytes: null,
      totalBytes: null,
      transferredObjects: null,
      totalObjects: null,
      eta: ""
    };
  }

  merged.progressPercent = maxFinite(existing.progressPercent, parsed.progressPercent);
  merged.totalBytes = wasTransferring && existing.totalBytes != null
    ? existing.totalBytes
    : parsed.totalBytes ?? existing.totalBytes ?? null;
  merged.totalObjects = wasTransferring && existing.totalObjects != null
    ? existing.totalObjects
    : parsed.totalObjects ?? existing.totalObjects ?? null;
  merged.transferredSizeText = stabilizeTransferredTotal(
    parsed.transferredSizeText ?? existing.transferredSizeText ?? "",
    wasTransferring ? existing.transferredSizeText : ""
  );
  merged.transferredText = stabilizeTransferredTotal(
    parsed.transferredText ?? existing.transferredText ?? "",
    wasTransferring ? existing.transferredText : ""
  );
  return merged;
}

export function bytesToMbps(bytesPerSecond) {
  const value = Number(bytesPerSecond || 0);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Number(((value * 8) / 1_000_000).toFixed(2));
}

function parseSpeed(text) {
  let match;
  let latest = null;

  SPEED_RE.lastIndex = 0;
  while ((match = SPEED_RE.exec(text))) {
    latest = {
      value: Number(match[1]),
      unit: match[2]
    };
  }

  if (!latest || !Number.isFinite(latest.value)) {
    return null;
  }

  const bytesPerSecond = latest.value * unitFactor(latest.unit);
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
    return null;
  }

  return {
    bytesPerSecond,
    speedMbps: bytesToMbps(bytesPerSecond),
    rawSpeed: `${latest.value} ${latest.unit}/s`
  };
}

function parseTransferred(text) {
  if (!text.includes("Transferred:")) {
    return null;
  }

  const result = {
    transferredText: text.replace(/^Transferred:\s*/i, "").trim(),
    progressPercent: parseProgressPercent(text),
    eta: parseEta(text)
  };

  const byteMatch = text.match(TRANSFERRED_RE);
  if (byteMatch) {
    const transferredBytes = Number(byteMatch[1]) * unitFactor(byteMatch[2]);
    const totalBytes = Number(byteMatch[3]) * unitFactor(byteMatch[4]);
    result.transferredBytes = Number.isFinite(transferredBytes) ? transferredBytes : undefined;
    result.totalBytes = Number.isFinite(totalBytes) ? totalBytes : undefined;
    result.transferredSizeText = `${byteMatch[1]} ${byteMatch[2]} / ${byteMatch[3]} ${byteMatch[4]}`;
  }

  const countMatch = text.match(/Transferred:\s*([0-9]+)\s*\/\s*([0-9]+),/i);
  if (countMatch) {
    result.transferredObjects = Number(countMatch[1]);
    result.totalObjects = Number(countMatch[2]);
  }

  return result;
}

function parseCurrentFile(text) {
  const match = text.match(/^\s*\*\s+(.+):\s+([0-9]+(?:\.[0-9]+)?)%\s*(?:\/\s*([^,]+))?/);
  if (!match) {
    return null;
  }

  return {
    currentFile: match[1].trim(),
    currentFileProgressPercent: Number(match[2]),
    currentFileSizeText: match[3] ? match[3].trim() : ""
  };
}

function parsePhase(text) {
  if (/^\s*(?:Checks|Checking):/i.test(text)) {
    return { phase: "scanning" };
  }
  if (/^\s*Transferring:\s*$/i.test(text) || /^\s*\*\s+.+:\s+[0-9]+(?:\.[0-9]+)?%/.test(text)) {
    return { phase: "transferring" };
  }
  return null;
}

function parseConflict(text, options = {}) {
  if (options.direction !== "bidirectional") {
    return null;
  }
  const renameFile = extractBisyncConflictRenameFile(text);
  const reliableSignal = /\bfile changed on both sides\b.*\bconflict\b/i.test(text)
    || /\bbisync conflict detected\b/i.test(text)
    || Boolean(renameFile);
  if (!reliableSignal) {
    return null;
  }
  const file = renameFile || extractConflictFile(text);
  return {
    conflicts: {
      count: 1,
      files: file ? [file] : [],
      truncated: false
    }
  };
}

export function parseRcloneFailure(text) {
  if (/\bHTTP\s+507\b/i.test(text) && /\bXMinioStorageFull\b/i.test(text)) {
    return {
      errorCode: "storage_full",
      error: "服务器存储空间不足，请联系管理员清理空间或迁移存储后重试。"
    };
  }
  return null;
}

export function appendRcloneOutputContext(existing, next, maxLength = 4096) {
  const limit = Number.isFinite(Number(maxLength)) ? Math.max(256, Number(maxLength)) : 4096;
  return `${String(existing || "")}${String(next || "")}`.slice(-limit);
}

function extractBisyncConflictRenameFile(text) {
  const match = String(text || "").match(
    /\bRenaming Path[12] copy\b.*?-\s*Path[12][\\/]([^\r\n]+?)\s*$/i
  );
  if (!match || !/\.conflict\d+(?:\.|$)/i.test(match[1])) {
    return "";
  }
  return match[1].trim();
}

function extractConflictFile(text) {
  const cleaned = String(text || "")
    .replace(/^\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s+(?:ERROR|INFO|NOTICE|WARNING)\s+:\s+/i, "")
    .replace(/^(?:ERROR|INFO|NOTICE|WARNING)\s+:\s+/i, "")
    .trim();
  const beforeColon = cleaned.match(/^(.+?):\s+.*\bconflict\b/i);
  if (beforeColon) {
    return beforeColon[1].trim();
  }
  const quoted = cleaned.match(/["']([^"']+)["']/);
  return quoted ? quoted[1].trim() : "";
}

function parseProgressPercent(text) {
  const match = String(text || "").match(/([0-9]+(?:\.[0-9]+)?)%/);
  if (!match) {
    return null;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function parseEta(text) {
  const match = String(text || "").match(/ETA\s+([^,\s]+)/i);
  return match ? match[1] : "";
}

function maxFinite(previous, next) {
  const values = [previous, next].map(Number).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function stabilizeTransferredTotal(nextText, lockedText) {
  const next = String(nextText || "");
  const locked = String(lockedText || "");
  if (!next || !locked || !next.includes("/") || !locked.includes("/")) {
    return next;
  }
  const nextSeparator = next.indexOf("/");
  const lockedSeparator = locked.indexOf("/");
  const lockedTail = locked.slice(lockedSeparator + 1).split(",", 1)[0].trim();
  const nextSuffix = next.slice(nextSeparator + 1);
  const suffixComma = nextSuffix.indexOf(",");
  const suffix = suffixComma >= 0 ? nextSuffix.slice(suffixComma) : "";
  return `${next.slice(0, nextSeparator).trimEnd()} / ${lockedTail}${suffix}`;
}

function unitFactor(unit) {
  const key = String(unit || "").toLowerCase();
  return UNIT_FACTORS.get(key) || 1;
}

function removeUndefined(input) {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}
