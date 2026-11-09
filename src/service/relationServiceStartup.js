import { dirname, isAbsolute, join } from "node:path";

import {
  openRelationServiceBindingCatalog
} from "./relationServiceBindingCatalog.js";
import {
  createRelationServiceProductWiring,
  createSftpRelationServiceProductWiring
} from "./relationServiceProductWiring.js";
import {
  loadRelationRuntimePackage,
  loadSftpRelationRuntimePackage
} from "./relationRuntimePackage.js";

export const RELATION_SERVICE_RCLONE_PATH = "/usr/local/bin/rclone";
export const RELATION_SERVICE_CATALOG_DIRECTORY = "relation-service";
export const RELATION_SERVICE_CATALOG_FILE = "catalog.json";

const START_KEYS = Object.freeze([
  "expectedHandleDigest",
  "operationId",
  "relationId"
]);
const QUERY_KEYS = Object.freeze(["relationId"]);
const DISABLE_KEYS = Object.freeze([
  "handle",
  "identity",
  "operationId",
  "relationId"
]);

function requireNonEmptyAbsolutePath(value, label) {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value)) {
    throw new TypeError(`${label} must be a non-empty absolute path`);
  }
}

function requireFunction(value, label) {
  if (typeof value !== "function") {
    throw new TypeError(`${label} must be a function`);
  }
}

function requirePlainObject(value, label) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, expectedKeys, label) {
  requirePlainObject(value, label);
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length
    || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${label} has unsupported fields`);
  }
}

function assertAllowedKeys(value, allowedKeys, label) {
  requirePlainObject(value, label);
  const allowed = new Set(allowedKeys);
  const unexpected = Object.keys(value).filter(key => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new TypeError(`${label} has unsupported fields`);
  }
}

function requireCatalogCapabilities(catalog) {
  requireFunction(catalog?.getForStart, "catalog.getForStart");
  requireFunction(catalog?.withStartBinding, "catalog.withStartBinding");
  return catalog;
}

function normalizeCatalogOpenError(error) {
  if (error?.code === "relation_service_binding_catalog_missing") {
    return error;
  }
  if (error?.code === "relation_service_binding_catalog_file_invalid"
    && error?.cause?.code === "ENOENT") {
    const normalized = new Error(
      "relation-service binding catalog is missing",
      { cause: error }
    );
    normalized.name = "RelationServiceBindingCatalogError";
    normalized.code = "relation_service_binding_catalog_missing";
    return normalized;
  }
  return error;
}

export function relationServiceCatalogPath(managerStatePath) {
  requireNonEmptyAbsolutePath(managerStatePath, "managerStatePath");
  return join(
    dirname(managerStatePath),
    RELATION_SERVICE_CATALOG_DIRECTORY,
    RELATION_SERVICE_CATALOG_FILE
  );
}

/**
 * Keep catalog opening outside startup admission. A successful open is reused
 * for the lifetime of the proxy; a failed open is retried on the next call.
 */
export function createLazyRelationServiceCatalog({
  catalogPath,
  catalogOpener = openRelationServiceBindingCatalog
} = {}) {
  requireNonEmptyAbsolutePath(catalogPath, "catalogPath");
  requireFunction(catalogOpener, "catalogOpener");

  let openedCatalog = null;
  let pendingOpen = null;

  async function getCatalog() {
    if (openedCatalog) {
      return openedCatalog;
    }
    if (!pendingOpen) {
      pendingOpen = Promise.resolve()
        .then(() => catalogOpener({
          mode: "require-existing",
          path: catalogPath
        }))
        .catch(error => {
          throw normalizeCatalogOpenError(error);
        })
        .then(catalog => {
          openedCatalog = requireCatalogCapabilities(catalog);
          return openedCatalog;
        })
        .finally(() => {
          pendingOpen = null;
        });
    }
    return pendingOpen;
  }

  const catalog = Object.freeze({
    async getForStart(relationId) {
      return (await getCatalog()).getForStart(relationId);
    },
    async withStartBinding(relationId, task) {
      return (await getCatalog()).withStartBinding(relationId, task);
    }
  });

  return Object.freeze({
    catalog,
    getCatalog
  });
}

export function createRelationServiceFacade({ manager, wiring } = {}) {
  for (const method of ["start", "query", "disable", "reconcile"]) {
    requireFunction(manager?.[method], `manager.${method}`);
  }
  requireFunction(wiring?.makeStartRequest, "wiring.makeStartRequest");

  return Object.freeze({
    async start(input = {}) {
      assertExactKeys(input, START_KEYS, "relation service start request");
      const request = await wiring.makeStartRequest(input);
      return manager.start(request);
    },

    async query(input = {}) {
      assertExactKeys(input, QUERY_KEYS, "relation service query request");
      return manager.query(input);
    },

    async disable(input = {}) {
      assertAllowedKeys(input, DISABLE_KEYS, "relation service disable request");
      return manager.disable(input);
    },

    async reconcile(input = {}) {
      assertExactKeys(input, QUERY_KEYS, "relation service reconcile request");
      return manager.reconcile(input);
    }
  });
}

export async function createRelationServiceStartup({
  root,
  managerStatePath,
  rclonePath = RELATION_SERVICE_RCLONE_PATH,
  runtimePackageLoader = loadRelationRuntimePackage,
  catalogOpener = openRelationServiceBindingCatalog,
  wiringFactory = createRelationServiceProductWiring
} = {}) {
  requireNonEmptyAbsolutePath(root, "root");
  requireNonEmptyAbsolutePath(managerStatePath, "managerStatePath");
  requireNonEmptyAbsolutePath(rclonePath, "rclonePath");
  requireFunction(runtimePackageLoader, "runtimePackageLoader");
  requireFunction(catalogOpener, "catalogOpener");
  requireFunction(wiringFactory, "wiringFactory");

  const runtimePackage = await runtimePackageLoader({
    directory: join(
      root,
      "server",
      "runtime",
      "native",
      "linux-arm64",
      "relation"
    )
  });
  const lazyCatalog = createLazyRelationServiceCatalog({
    catalogPath: relationServiceCatalogPath(managerStatePath),
    catalogOpener
  });
  const wiring = wiringFactory({
    catalog: lazyCatalog.catalog,
    rclonePath,
    runtimePackage
  });

  return Object.freeze({
    runtime: wiring.runtime,
    protection: wiring.protection,
    createFacade(manager) {
      return createRelationServiceFacade({ manager, wiring });
    }
  });
}

export async function createSftpRelationServiceStartup({
  root,
  managerStatePath,
  runtimePackageLoader = loadSftpRelationRuntimePackage,
  catalogOpener = openRelationServiceBindingCatalog,
  wiringFactory = createSftpRelationServiceProductWiring
} = {}) {
  assertAllowedKeys(
    arguments[0],
    ["root", "managerStatePath", "runtimePackageLoader", "catalogOpener", "wiringFactory"],
    "SFTP relation service startup options"
  );
  requireNonEmptyAbsolutePath(root, "root");
  requireNonEmptyAbsolutePath(managerStatePath, "managerStatePath");
  requireFunction(runtimePackageLoader, "runtimePackageLoader");
  requireFunction(catalogOpener, "catalogOpener");
  requireFunction(wiringFactory, "wiringFactory");

  const runtimePackage = await runtimePackageLoader({
    directory: join(
      root,
      "server",
      "runtime",
      "native",
      "linux-arm64",
      "relation-v2"
    )
  });
  const lazyCatalog = createLazyRelationServiceCatalog({
    catalogPath: relationServiceCatalogPath(managerStatePath),
    catalogOpener
  });
  const wiring = wiringFactory({
    catalog: lazyCatalog.catalog,
    runtimePackage
  });

  return Object.freeze({
    runtime: wiring.runtime,
    protection: wiring.protection,
    createFacade(manager) {
      return createRelationServiceFacade({ manager, wiring });
    }
  });
}
