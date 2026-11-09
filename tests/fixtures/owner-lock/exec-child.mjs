import { opendirSync, statSync } from "node:fs";

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function decimal(value) {
  return typeof value === "bigint" ? value.toString() : undefined;
}

const expected = {
  parentDev: argument("--parent-dev"),
  parentIno: argument("--parent-ino"),
  lockDev: argument("--lock-dev"),
  lockIno: argument("--lock-ino")
};
const argumentErrors = Object.entries(expected)
  .filter(([, value]) => typeof value !== "string"
    || !/^(?:0|[1-9][0-9]*)$/.test(value))
  .map(([name]) => name);

const fdNames = [];
const statErrors = [];
const matchingLockFds = [];
const matchingParentFds = [];
let enumerationError;
let closeError;
let directory;

try {
  directory = opendirSync("/proc/self/fd");
  let entry;
  while ((entry = directory.readSync()) !== null) {
    fdNames.push(entry.name);
  }
  for (const fdName of fdNames) {
    try {
      const metadata = statSync(`/proc/self/fd/${fdName}`, { bigint: true });
      const dev = decimal(metadata.dev);
      const ino = decimal(metadata.ino);
      if (dev === expected.lockDev && ino === expected.lockIno) {
        matchingLockFds.push(fdName);
      }
      if (dev === expected.parentDev && ino === expected.parentIno) {
        matchingParentFds.push(fdName);
      }
    } catch (error) {
      statErrors.push({
        fd: fdName,
        code: typeof error?.code === "string" ? error.code : "unknown"
      });
    }
  }
} catch (error) {
  enumerationError = typeof error?.code === "string" ? error.code : "unknown";
} finally {
  if (directory) {
    try {
      directory.closeSync();
    } catch (error) {
      closeError = typeof error?.code === "string" ? error.code : "unknown";
    }
  }
}

process.stdout.write(`${JSON.stringify({
  complete: argumentErrors.length === 0
    && enumerationError === undefined
    && closeError === undefined
    && statErrors.length === 0,
  lockIdentityVisible: matchingLockFds.length > 0,
  parentIdentityVisible: matchingParentFds.length > 0,
  matchingLockFds,
  matchingParentFds,
  statErrors,
  fdCount: fdNames.length,
  argumentErrors,
  enumerationError: enumerationError ?? null,
  closeError: closeError ?? null
})}\n`);
