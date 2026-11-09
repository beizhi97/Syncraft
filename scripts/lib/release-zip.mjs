import { deflateRawSync } from "node:zlib";
import { lstat, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const UTF8_FLAG = 0x0800;
const COMPRESSION_DEFLATE = 8;
const UNIX_CREATOR = 3;
const FILE_TYPE_REGULAR = 0o100000;
const FILE_TYPE_DIRECTORY = 0o040000;
const EXECUTABLE_PATHS = new Set(["server/runtime/sfsc-runtime-launcher"]);

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
  }
  return value >>> 0;
});

function crc32(data) {
  let value = 0xffffffff;
  for (const byte of data) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function zipPath(value) {
  return value.split(sep).join("/").replaceAll("\\", "/");
}

function assertZip32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`${label} exceeds the supported ZIP32 range`);
  }
}

function modeFor(path, directory, payload) {
  if (directory) return FILE_TYPE_DIRECTORY | 0o755;
  const isShebang = payload.length >= 2 && payload[0] === 0x23 && payload[1] === 0x21;
  const isNativeExecutable = path.startsWith("server/runtime/native/") && !path.endsWith(".node") && !path.endsWith(".json");
  return FILE_TYPE_REGULAR | (EXECUTABLE_PATHS.has(path) || isShebang || isNativeExecutable ? 0o755 : 0o644);
}

async function listTree(root, current = root) {
  const results = [];
  const children = await readdir(current, { withFileTypes: true });
  children.sort((left, right) => left.name.localeCompare(right.name, "en"));
  for (const child of children) {
    const fullPath = join(current, child.name);
    const relativePath = zipPath(relative(root, fullPath));
    const info = await lstat(fullPath);
    if (info.isSymbolicLink()) {
      throw new Error(`Release ZIP source contains a symbolic link: ${relativePath}`);
    }
    if (info.isDirectory()) {
      results.push({ path: `${relativePath}/`, sourcePath: fullPath, directory: true });
      results.push(...await listTree(root, fullPath));
    } else if (info.isFile()) {
      results.push({ path: relativePath, sourcePath: fullPath, directory: false });
    } else {
      throw new Error(`Release ZIP source contains an unsupported filesystem entry: ${relativePath}`);
    }
  }
  return results;
}

function writeLocalEntry(name, payload, compressed, checksum, offset) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30 + nameBytes.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(UTF8_FLAG, 6);
  header.writeUInt16LE(COMPRESSION_DEFLATE, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12); // 1980-01-01, 00:00:00 UTC
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(payload.length, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28);
  nameBytes.copy(header, 30);
  return { data: Buffer.concat([header, compressed]), offset };
}

function writeCentralEntry(name, compressed, payload, checksum, offset, mode, directory) {
  const nameBytes = Buffer.from(name, "utf8");
  const header = Buffer.alloc(46 + nameBytes.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE((UNIX_CREATOR << 8) | 20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(UTF8_FLAG, 8);
  header.writeUInt16LE(COMPRESSION_DEFLATE, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(payload.length, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE((((mode << 16) >>> 0) | (directory ? 0x10 : 0)) >>> 0, 38);
  header.writeUInt32LE(offset, 42);
  nameBytes.copy(header, 46);
  return header;
}

export async function createReleaseZip({ sourceDirectory, outputFile, archiveRoot }) {
  const root = resolve(sourceDirectory);
  const output = resolve(outputFile);
  const top = zipPath(archiveRoot || "").replace(/^\/+|\/+$/g, "");
  if (!top || top.includes("..")) {
    throw new Error("archiveRoot must be a safe non-empty directory name");
  }
  const sourceInfo = await lstat(root);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) {
    throw new Error(`Release ZIP source must be a real directory: ${root}`);
  }

  const entries = [{ path: `${top}/`, sourcePath: null, directory: true }, ...await listTree(root)];
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const fullName = entry.path.startsWith(`${top}/`) ? entry.path : `${top}/${entry.path}`;
    const payload = entry.directory ? Buffer.alloc(0) : await readFile(entry.sourcePath);
    const compressed = deflateRawSync(payload, { level: 9 });
    const checksum = crc32(payload);
    assertZip32(compressed.length, `${fullName} compressed size`);
    assertZip32(payload.length, `${fullName} size`);
    assertZip32(localOffset, `${fullName} local header offset`);
    const mode = modeFor(entry.path.replace(/\/$/, ""), entry.directory, payload);
    const local = writeLocalEntry(fullName, payload, compressed, checksum, localOffset);
    localParts.push(local.data);
    centralParts.push(writeCentralEntry(fullName, compressed, payload, checksum, localOffset, mode, entry.directory));
    localOffset += local.data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  assertZip32(centralDirectory.length, "central directory size");
  assertZip32(localOffset, "central directory offset");
  if (entries.length > 0xffff) {
    throw new Error("Release ZIP contains too many entries for ZIP32");
  }
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  await writeFile(output, Buffer.concat([...localParts, centralDirectory, end]));
  return { outputFile: output, entries: entries.length };
}

export function readZipEntryUnixMetadata(zipData, targetName) {
  const endOffset = findEndOfCentralDirectory(zipData);
  if (endOffset < 0) throw new Error("ZIP end of central directory not found");
  const count = zipData.readUInt16LE(endOffset + 10);
  const start = zipData.readUInt32LE(endOffset + 16);
  const size = zipData.readUInt32LE(endOffset + 12);
  const end = start + size;
  let offset = start;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > end || zipData.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error("ZIP central directory entry is invalid");
    }
    const nameLength = zipData.readUInt16LE(offset + 28);
    const extraLength = zipData.readUInt16LE(offset + 30);
    const commentLength = zipData.readUInt16LE(offset + 32);
    const name = zipData.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name === targetName) {
      const creatorPlatform = zipData.readUInt16LE(offset + 4) >>> 8;
      const externalAttributes = zipData.readUInt32LE(offset + 38);
      const unixMode = externalAttributes >>> 16;
      return {
        creatorPlatform,
        unixMode,
        fileType: unixMode & 0o170000,
        permissions: unixMode & 0o777
      };
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function findEndOfCentralDirectory(data) {
  const minOffset = Math.max(0, data.length - 22 - 0xffff);
  for (let offset = data.length - 22; offset >= minOffset; offset -= 1) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sourceDirectory, outputFile, archiveRoot] = process.argv.slice(2);
  if (!sourceDirectory || !outputFile || !archiveRoot) {
    process.stderr.write("Usage: node scripts/lib/release-zip.mjs <source-dir> <output-zip> <archive-root>\n");
    process.exitCode = 2;
  } else {
    createReleaseZip({ sourceDirectory, outputFile, archiveRoot })
      .then(({ outputFile: path, entries }) => process.stdout.write(`[sfsc-zip] ${entries} entries -> ${path}\n`))
      .catch((error) => {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      });
  }
}
