import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const bundlePrefix = "singbox-folder-sync-";
const bundleSuffix = "-release";

export function releaseBundlePaths(projectRoot) {
  const version = readReleaseVersion(projectRoot);
  const name = `${bundlePrefix}${version}${bundleSuffix}`;
  const directory = `dist/release-bundles/${name}`;
  const zip = `dist/release-bundles/${name}.zip`;
  return { version, name, directory, zip, sha256: `${zip}.sha256`, manifest: `${directory}/release-bundle-manifest.json` };
}

export function readReleaseVersion(projectRoot) {
  const packagePath = resolve(projectRoot, "package.json");
  if (existsSync(packagePath)) {
    try {
      const version = JSON.parse(readFileSync(packagePath, "utf8")).version;
      if (typeof version === "string" && version.trim()) return version.trim();
    } catch {
      // Report fixtures may intentionally omit package.json.
    }
  }
  const bundleRoot = resolve(projectRoot, "dist", "release-bundles");
  if (existsSync(bundleRoot)) {
    const versions = readdirSync(bundleRoot)
      .map(matchBundleVersion)
      .filter(Boolean);
    if (versions.length === 1) return versions[0];
  }
  throw new Error("Unable to determine release version from package.json or a single release bundle.");
}

function matchBundleVersion(name) {
  if (!name.startsWith(bundlePrefix) || !name.endsWith(bundleSuffix)) return "";
  return name.slice(bundlePrefix.length, -bundleSuffix.length);
}
