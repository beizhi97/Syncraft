import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { runInNewContext } from "node:vm";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADMIN_STATE_VERSION,
  autoFillTunnelConfig,
  buildClientSingboxConfig,
  buildJobFromProfile,
  buildRclonePreview,
  buildMinioPolicyName,
  buildMinioPrefixPolicy,
  buildRuntimeDiagnostics,
  buildSingboxServerConfig,
  buildServerFolderRemotePath,
  buildStorageRemotePath,
  buildVlessUri,
  CLAIM_REDEEM_ERROR_CODES,
  compactAdminState,
  createClaim,
  createSyncSpace,
  createHttpError,
  createDefaultAdminState,
  createManagedUser,
  createStorageBucket,
  deleteManagedUser,
  computeNextRun,
  compareRuntimeDiagnostics,
  CLAIM_CODE_PATTERN,
  createHeartbeatAuth,
  decodeClaimToken,
  decodeImportProfile,
  describeSchedule,
  encodeClaimToken,
  encodeImportProfile,
  isClaimRedeemErrorCode,
  markStorageBucketCleared,
  markSingboxApplied,
  MAX_JSON_BODY_BYTES,
  normalizeBandwidthLimit,
  normalizeSyncSafety,
  normalizeAdminState,
  normalizeHttpError,
  normalizeRuntimeDiagnostics,
  normalizeImportProfile,
  normalizeSchedule,
  normalizeDeviceSync,
  normalizeSyncRun,
  parseProtocolRequest,
  parseBandwidthLimit,
  parseVlessUri,
  PROFILE_VERSION,
  PROTOCOL_REQUESTS,
  recordDeviceHeartbeat,
  readJson,
  redeemClaim,
  removeStorageBucket,
  setManagedUserEnabled,
  setStorageBucketEnabled,
  summarizeAdminState,
  summarizeImportProfile,
  summarizeDevice,
  updateStorageConfig,
  updateTunnelConfig,
  verifyHeartbeatAuth
} from "../src/core/index.js";
import { ensureMinioClaimAccess, removeMinioDeviceAccess, setMinioDeviceAccessEnabled } from "../src/minioProvisioner.js";
import {
  assertAdminClaimSummaryContract,
  assertAdminAuthCheckResponseContract,
  assertAdminDefaultsSummaryContract,
  assertAdminSettingsSummaryContract,
  assertAdminSingboxMarkAppliedResponseContract,
  assertAdminSingboxConfigPreviewContract,
  assertAdminSingboxWriteResponseContract,
  assertAdminStateSummaryContract,
  assertAdminStorageSaveResponseContract,
  assertAdminStorageBucketClearResponseContract,
  assertAdminStorageBucketCreateResponseContract,
  assertAdminStorageBucketDeleteEmptyResponseContract,
  assertAdminStorageBucketsRefreshResponseContract,
  assertAdminStorageBucketToggleResponseContract,
  assertAdminStorageSummaryContract,
  assertAdminTunnelAutofillResponseContract,
  assertAdminTunnelGenerateResponseContract,
  assertAdminTunnelSummaryContract,
  assertAdminUserDeleteResponseContract,
  assertAdminUserWriteResponseContract,
  assertAdminUserSummaryContract,
  assertAdminWriteStateResponseContract,
  assertClaimCreateResponseContract,
  assertClaimRedeemResponseContract,
  assertClientBinariesCheckContract,
  assertClientHealthContract,
  assertClientJobsReadContract,
  assertClientJobSaveResponseContract,
  assertClientJobSummaryContract,
  assertClientLogsContract,
  assertClientStatusContract,
  assertClientProfileImportResponseContract,
  assertClientShutdownResponseContract,
  assertClientSyncHistoryContract,
  assertClientSingboxProcessResponseContract,
  assertClientSyncRunResponseContract,
  assertDiagnosticBundleContract,
  assertDiagnosticExportContract,
  assertDiagnosticLogMetaContract,
  assertHeartbeatContract,
  assertHttpErrorResponseContract,
  assertJobsPreviewResponseContract,
  assertProfileEncodeResponseContract,
  assertServerDeviceSummaryContract,
  assertServerHeartbeatResponseContract,
  assertServerHealthResponseContract,
  assertSingboxClientConfigResponseContract,
  assertVlessParseResponseContract
} from "./helpers/contracts.js";
import { assertReportSafe, stringifyReportJson } from "../scripts/lib/reportSecrets.mjs";

test("Protocol v1 baseline freezes runtime versions, confirmation policy, and evidence gates", async () => {
  const [baselineSource, baselineDoc] = await Promise.all([
    readFile(join(projectRoot, "docs", "protocol", "schemas", "protocol-v1-baseline.json"), "utf8"),
    readFile(join(projectRoot, "docs", "protocol", "PROTOCOL_V1_BASELINE.md"), "utf8")
  ]);
  const baseline = JSON.parse(baselineSource);

  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.protocolBaseline, "SFSC Protocol v1");
  assert.equal(baseline.status, "frozen");
  assert.deepEqual(baseline.protocols, {
    claim: 1,
    profile: 1,
    adminState: 1,
    clientStatus: 1,
    heartbeat: 1
  });
  assert.deepEqual(baseline.compatibility, {
    onMismatch: "warn_and_confirm",
    heartbeat: "allow",
    profileIssue: "warn",
    syncRun: "warn",
    silentAllow: false
  });
  assert.equal(baseline.breakingChangePolicy, "increment_protocol_version");
  assert.ok(baseline.requiredEvidence.includes("source-fingerprint-alignment"));
  assert.match(baselineDoc, /must introduce a later protocol version/);
  assert.match(baselineDoc, /restartRequired=false/);
});

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const uri = "vless://8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21@pass.971223.xyz:45678?encryption=none&flow=&security=reality&sni=www.microsoft.com&fp=chrome&type=tcp&pbk=SERVER_PUBLIC_KEY&sid=abcd1234#home-sync";
const REALITY_PUBLIC_KEY = "A".repeat(43);
const REALITY_PRIVATE_KEY = "B".repeat(43);
const REALITY_SHORT_ID = "abcd1234abcd1234";
const FAKE_SOURCE_TREE_HASH = "a".repeat(64);
const FAKE_BUILD_ID = `sfsc-${FAKE_SOURCE_TREE_HASH.slice(0, 12)}`;

test("report secret scanner allows benign redacted reports", () => {
  const body = stringifyReportJson({
    ok: true,
    type: "safe-report",
    storage: {
      secretAccessKey: "redacted",
      secretRef: "n1/minio/user"
    },
    heartbeatSecret: "***",
    heartbeat: {
      "heartbeat.secret": "secretRef:server/device"
    },
    notes: [
      "SyncKey plaintext is not stored.",
      "sfsc import URI is referenced only by type, not value."
    ]
  }, "safe report");
  assert.match(body, /"type": "safe-report"/);
});

test("report secret scanner blocks known sensitive report values", () => {
  const cases = [
    ["full SyncKey", { tKey: "SFSC1-abcdefghijklmnopqrstuvwxyz0123456789" }],
    ["sfsc import URI", { importUri: "sfsc://import/v1#payload" }],
    ["VLESS URI", { tunnel: "vless://00000000-0000-4000-8000-000000000000@example.invalid:443" }],
    ["raw secretAccessKey field", { storage: { secretAccessKey: "plain-storage-secret" } }],
    ["raw heartbeatSecret field", { heartbeatSecret: "plain-heartbeat-secret" }],
    ["admin-token-env", ["SFSC_ADMIN_TOKEN", "plain-admin-token"].join("=")],
    ["s3-secret-env", ["S3_SECRET_ACCESS_KEY", "plain-s3-secret"].join("=")]
  ];

  for (const [name, payload] of cases) {
    assert.throws(
      () => assertReportSafe(payload, name),
      /contains sensitive-looking/
    );
  }
});

test("PowerShell report secret scanner blocks sensitive report writes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-ps-report-secret-"));
  try {
    const helperPath = join(projectRoot, "scripts", "lib", "report-secrets.ps1").replaceAll("'", "''");
    const reportPath = join(tempRoot, "report.json").replaceAll("'", "''");
    const script = [
      `. '${helperPath}'`,
      `$payload = [ordered]@{ schemaVersion = 1; app = "singbox-folder-sync"; tKey = "SFSC1-abcdefghijklmnopqrstuvwxyz0123456789" }`,
      `Write-SafeJsonReport '${reportPath}' $payload "sensitive fixture" 6`
    ].join("\n");
    const result = await new Promise((resolve) => {
      execFile("powershell", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script
      ], { cwd: tempRoot }, (error, stdout, stderr) => {
        resolve({ code: error?.code ?? 0, stdout, stderr });
      });
    });
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /sensitive-looking SyncKey/);
    await assert.rejects(() => readFile(join(tempRoot, "report.json"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function signHeartbeatForState(state, input) {
  const clientName = input.clientName || input.deviceName || "";
  const user = state.users.find((item) => item.clientName === clientName && !item.deletedAt);
  if (!user?.heartbeatSecret) {
    return input;
  }
  const { remoteAddress: _remoteAddress, ...authPayload } = input;
  return {
    ...input,
    auth: createHeartbeatAuth(authPayload, user.heartbeatSecret)
  };
}

test("legacy handover docs redirect to canonical product docs", async () => {
  const files = [
    "README.md",
    "api-spec.md",
    "software-design-spec.md",
    "migration-checklist.md",
    "deployment-guide.md",
    "operations-runbook.md",
    "release-notes.md"
  ];

  for (const file of files) {
    const text = await readFile(join(projectRoot, "docs", "handover", file), "utf8");
    assert.match(text, /历史/);
    assert.match(text, /docs\/PROJECT_HANDOFF\.md/);
  }

  const apiSpec = await readFile(join(projectRoot, "docs", "handover", "api-spec.md"), "utf8");
  assert.match(apiSpec, /docs\/INTERFACE_CONTRACT\.md/);

  const designSpec = await readFile(join(projectRoot, "docs", "handover", "software-design-spec.md"), "utf8");
  assert.match(designSpec, /docs\/SOFTWARE_DESIGN_SPEC\.md/);
});

test("top-level docs present the productized contract baseline", async () => {
  const [
    readme,
    clientReadme,
    pkgText,
    serverSource,
    serverDesign,
    clientDesign,
    softwareDesignSpec,
    storageSource
  ] = await Promise.all([
    readFile(join(projectRoot, "README.md"), "utf8"),
    readFile(join(projectRoot, "client", "README.md"), "utf8"),
    readFile(join(projectRoot, "package.json"), "utf8"),
    readFile(join(projectRoot, "src", "server.js"), "utf8"),
    readFile(join(projectRoot, "docs", "server-design.md"), "utf8"),
    readFile(join(projectRoot, "docs", "client-design.md"), "utf8"),
    readFile(join(projectRoot, "docs", "SOFTWARE_DESIGN_SPEC.md"), "utf8"),
    readFile(join(projectRoot, "src", "core", "storage.js"), "utf8")
  ]);
  const pkg = JSON.parse(pkgText);

  assert.match(readme, /产品化基线/);
  assert.match(readme, /docs\/INTERFACE_CONTRACT\.md/);
  assert.match(readme, /docs\/API_MATRIX\.md/);
  assert.match(readme, /必须同步更新 `docs\/INTERFACE_CONTRACT\.md`、`docs\/API_MATRIX\.md` 和对应合同测试/);
  assert.match(readme, /pnpm run smoke:client/);
  assert.match(readme, /pnpm run ci:verify/);
  assert.match(readme, /pnpm run bundle:release/);
  assert.match(readme, /dist\/release-bundles/);
  assert.match(readme, /release-bundle-manifest\.json/);
  assert.match(readme, /manifest 的 `preflightVerified` 和 `preflightVerification` 字段是发布放行判断入口/);
  assert.match(readme, /preflightVerification\.mode: "external"/);
  assert.match(readme, /交付自证明/);
  assert.match(readme, /排除 `\.env`、`server\/data`、真实 `server\/sing-box\/config\.json`/);
  assert.match(readme, /\.github\/workflows\/ci\.yml/);
  assert.match(readme, /\.github\/workflows\/release\.yml/);
  assert.match(readme, /显式检查 `releaseOk: true`、`skipped: 0` 和双包 smoke 报告/);
  assert.match(readme, /上传 ZIP、`\.sha256`、`release-manifest\.json`、`reports\/release\/\*\*` 和 `dist\/release-bundles\/\*\*`/);
  assert.match(readme, /node scripts\/smoke-client\.mjs --base-url http:\/\/127\.0\.0\.1:5188 --json-report reports\/client-smoke\.json/);
  assert.match(readme, /`smoke:client` 检查已经运行的客户端本地服务；`smoke:client-package` 检查已经构建出的发行包目录/);
  assert.doesNotMatch(readme.split("\n").slice(0, 5).join("\n"), /MVP/);
  assert.match(clientReadme, /Windows portable client/);
  assert.match(clientReadme, /\.\.\/docs\/INTERFACE_CONTRACT\.md/);
  assert.match(clientReadme, /pnpm run smoke:client/);
  assert.match(clientReadme, /node scripts\/smoke-client\.mjs --base-url http:\/\/127\.0\.0\.1:5188 --json-report reports\/client-smoke\.json/);
  assert.match(clientReadme, /`smoke:client` verifies the already-running local runtime through `\/api\/health`, `\/api\/client\/status`, `\/api\/profile`, `\/api\/jobs`, `\/api\/sync\/history`, `\/api\/logs`, and `\/api\/diagnostics\/export`/);
  assert.match(clientReadme, /protocol map alignment/);
  assert.match(clientReadme, /profile\/job\/history read APIs match `\/api\/client\/status`/);
  assert.match(clientReadme, /`smoke:client-package` verifies a built release package directory/);
  assert.doesNotMatch(clientReadme.split("\n").slice(0, 5).join("\n"), /MVP/);
  assert.equal(pkg.name, "singbox-folder-sync");
  assert.match(pkg.description, /stable interface contract/);
  assert.doesNotMatch(pkg.description, /MVP/i);
  assert.match(serverSource, /Syncraft server/);
  assert.doesNotMatch(serverSource, /Folder Sync MVP/);
  for (const text of [serverDesign, clientDesign, softwareDesignSpec, storageSource]) {
    assert.doesNotMatch(text, /\bMVP\b|\bdemo\b|\bprototype\b|proof of concept|\bPOC\b|演示版|样例版|试用版/i);
  }
  assert.match(storageSource, /Only S3-compatible MinIO storage is supported/);
});

test("N1 smoke report is framed as historical and points to revalidation", async () => {
  const report = await readFile(join(projectRoot, "docs", "N1_SMOKE_REPORT.md"), "utf8");

  assert.match(report, /Status: historical observation/);
  assert.match(report, /not proof of the current N1 state/);
  assert.match(report, /Before using N1 as the productization acceptance environment/);
  assert.match(report, /scripts\/smoke-server\.mjs/);
  assert.match(report, /Treat the latest smoke output as authoritative/);
});

test("API matrix covers implemented routes and UI consumers", async () => {
  const [
    matrix,
    serverSource,
    clientServerSource,
    serverUiSource,
    clientUiSource,
    profileImportSource
  ] = await Promise.all([
    readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8"),
    readFile(join(projectRoot, "src", "server.js"), "utf8"),
    readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8"),
    readFile(join(projectRoot, "public", "app.js"), "utf8"),
    readFile(join(projectRoot, "client", "public", "app.js"), "utf8"),
    readFile(join(projectRoot, "client", "src", "profileImport.js"), "utf8")
  ]);

  for (const route of extractImplementedRoutes(serverSource)) {
    assert.match(matrix, routeRowPattern(route), `missing server route in API matrix: ${route.method} ${route.path}`);
  }

  for (const route of extractImplementedRoutes(clientServerSource)) {
    assert.match(matrix, routeRowPattern(route), `missing client local route in API matrix: ${route.method} ${route.path}`);
  }

  for (const path of extractApiPaths(`${serverUiSource}\n${clientUiSource}\n${profileImportSource}`)) {
    assert.match(matrix, pathPattern(path), `missing consumed API path in API matrix: ${path}`);
  }

  assert.match(matrix, /客户端本地运行时、服务端控制台测试兑换入口/);
  assert.match(matrix, /脱敏 `device\.sync` 摘要/);
  assert.match(matrix, /消费者分类采用固定词汇/);
  assert.match(matrix, /`服务端控制台` \/ `客户端 UI` 表示用户可见产品界面/);
  assert.match(matrix, /`smoke` 表示验收脚本会直接调用/);
  assert.match(
    matrix,
    /\| POST \| `\/api\/admin\/users\/create` \| 管理 token \| 调试\/运维入口 \| 低层创建或登记设备；服务端控制台生成设备应使用 `\/api\/claims\/create` \|/
  );
  assert.doesNotMatch(
    matrix,
    /\| POST \| `\/api\/admin\/users\/create` \| 管理 token \| 服务端控制台 \|/
  );
  assert.match(matrix, /\| GET \| `\/api\/admin\/singbox\/config` \| 管理 token \| 服务端控制台、smoke、运维只读入口 \|/);
  assert.match(matrix, /\| POST \| `\/api\/vless\/parse` \| 管理 token \| smoke、调试\/兼容入口 \|/);
  assert.match(matrix, /\| POST \| `\/api\/singbox\/client-config` \| 管理 token \| smoke、调试\/兼容入口 \|/);
  assert.match(matrix, /\| POST \| `\/api\/profile\/encode` \| 管理 token \| smoke、调试\/兼容入口 \|/);
  assert.match(matrix, /\| POST \| `\/api\/jobs\/preview` \| 管理 token \| smoke、调试\/兼容入口 \|/);
  assert.match(matrix, /\| GET \| `\/api\/profile` \| smoke、调试\/兼容入口 \|/);
  assert.match(matrix, /\| GET \| `\/api\/jobs` \| smoke、调试\/兼容入口 \|/);
  assert.match(matrix, /\| GET \| `\/api\/logs` \| 客户端 UI、smoke \|/);
  assert.match(matrix, /\| GET \| `\/api\/diagnostics\/export` \| 客户端 UI、smoke \|/);
  assert.match(matrix, /smoke 脚本新增直接调用时，对应 API 行的“当前消费者”必须包含 `smoke`/);
  assert.match(matrix, /HTTP 2xx 但非 JSON、空 body、缺少成功契约字段、`diagnostics\.role\/protocols` 非服务端协议/);
  assert.match(matrix, /`syncState` 与 `sync\.state` 不一致或 `speedMbps` 与 `sync\.speedMbps` 不一致/);
  assert.match(matrix, /不得更新 `lastSuccessfulHeartbeat`/);
});

test("server console UI API wraps non-JSON responses in stable request errors", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");

  assert.match(app, /async function readJsonOrFallback\(response\)/);
  assert.match(app, /JSON\.parse\(text\)/);
  assert.match(app, /buildNonJsonApiResponse\(response, text\)/);
  assert.match(app, /errorCode: "server_error"/);
  assert.doesNotMatch(app, /["']request_failed["']/);
  assert.match(app, /nonJson: true/);
  assert.match(app, /const json = await readJsonOrFallback\(response\)/);
  assert.match(app, /json\?\.nonJson === true/);
  assert.doesNotMatch(app, /await response\.json\(\)/);

  const context = buildServerConsoleApiContext(app);
  const parsed = await context.readJsonOrFallback({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "{\"ok\":true,\"adminAuth\":{\"enabled\":false}}"
  });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.adminAuth.enabled, false);

  const fallback = await context.readJsonOrFallback({
    ok: false,
    status: 503,
    statusText: "Service Unavailable",
    text: async () => "<html><head><style>body{}</style></head><body><h1>Service Unavailable</h1><p>upstream reset</p></body></html>"
  });
  assert.equal(fallback.ok, false);
  assert.equal(fallback.status, 503);
  assert.equal(fallback.errorCode, "server_error");
  assert.equal(fallback.code, "server_error");
  assert.equal(fallback.nonJson, true);
  assert.match(fallback.message, /HTTP 503 Service Unavailable: Service Unavailable upstream reset/);
  assert.equal(fallback.message.includes("<html"), false);
  assert.equal(fallback.message.includes("body{}"), false);
  assert.equal(fallback.message.length < 240, true);

  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "reverse proxy returned a plain-text maintenance page"
  });
  await assert.rejects(
    () => context.api("/api/admin/state"),
    (error) => {
      assert.equal(error.code, "server_error");
      assert.equal(error.status, 200);
      assert.match(error.message, /HTTP 200 OK: reverse proxy returned a plain-text maintenance page/);
      return true;
    }
  );
});

test("client local API is loopback-only and tracked manifest source paths exist in the repo", async () => {
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
  const clientServerSource = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

  assert.match(contract, /客户端本地 HTTP 只监听 `127\.0\.0\.1:5188`/);
  assert.match(clientServerSource, /127\.0\.0\.1/);
  assert.doesNotMatch(clientServerSource, /process\.env\.HOST/);

  const manifestPaths = [...clientServerSource.matchAll(/\["[^"]+",\s*"([^"]+)"\]/g)]
    .map((match) => match[1]);
  assert.ok(manifestPaths.length > 0);
  assert.doesNotMatch(manifestPaths.join("\n"), /syncRunner\.js/);
  assert.equal(manifestPaths.includes("resources/bin/win32/sing-box.exe"), true);
  assert.equal(manifestPaths.includes("resources/bin/win32/rclone.exe"), true);

  function sourcePathForManifestPath(manifestPath) {
    if (manifestPath === "Syncraft.exe") {
      return "";
    }
    if (manifestPath === "app/package.json" || manifestPath === "resources/app/package.json") {
      return "package.json";
    }
    if (manifestPath.startsWith("app/")) {
      return manifestPath.slice("app/".length);
    }
    if (manifestPath.startsWith("resources/app/")) {
      return manifestPath.slice("resources/app/".length);
    }
    if (manifestPath.startsWith("resources/bin/")) {
      if (manifestPath.endsWith(".exe")) {
        return "";
      }
      return `client/resources/bin/${manifestPath.slice("resources/bin/".length)}`;
    }
    return "";
  }

  const missing = [];
  for (const manifestPath of [...new Set(manifestPaths)]) {
    const sourcePath = sourcePathForManifestPath(manifestPath);
    if (!sourcePath) {
      continue;
    }
    try {
      await access(join(projectRoot, ...sourcePath.split("/")));
    } catch {
      missing.push(`${manifestPath} -> ${sourcePath}`);
    }
  }
  assert.deepEqual(missing, []);
});

test("interface contract documents heartbeat response fields used by the client", async () => {
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");

  assert.match(contract, /通用错误响应/);
  assert.match(contract, /http error response contract/);
  assert.match(contract, /assertHttpErrorResponseContract/);
  assert.match(contract, /`404 not_found`/);
  assert.match(contract, /`400 invalid_path`/);
  assert.match(contract, /不得只返回裸 `\{ "error": "Not found" \}`/);
  assert.match(contract, /POST \/api\/devices\/heartbeat/);
  assert.match(contract, /heartbeat\.serverDiagnostics/);
  assert.match(contract, /heartbeat\.compatibility/);
  assert.match(contract, /`heartbeat\.ok` 必须是布尔值/);
  assert.match(contract, /成功心跳必须包含 `heartbeat\.serverDiagnostics`、`heartbeat\.compatibility` 和脱敏 `heartbeat\.device`/);
  assert.match(contract, /HTTP 2xx 只有在响应是 JSON object 且满足该成功契约时才算成功/);
  assert.match(contract, /若 2xx 响应不是 JSON、为空 body、缺少 `ok: true`、顶层 `diagnostics`、`device\.compatibility`、`device\.sync`/);
  assert.match(contract, /`heartbeat\.serverDiagnostics\.role` 必须为 `server`/);
  assert.match(contract, /`heartbeat\.serverDiagnostics\.protocols\.claim\/profile\/adminState\/clientStatus\/heartbeat` 必须都是正整数/);
  assert.match(contract, /`device\.compatibility\.ok\/status\/action\/severity\/localRole\/remoteRole`/);
  assert.match(contract, /客户端必须把本次结果记录为 `heartbeat_failed`/);
  assert.match(contract, /不得写入或覆盖 `lastSuccessfulHeartbeat`/);
  assert.match(contract, /client heartbeat device summary contract/);
  assert.match(contract, /`heartbeat\.device\.syncState` 必须与 `heartbeat\.device\.sync\.state` 完全一致/);
  assert.match(contract, /`heartbeat\.device\.speedMbps` 必须与 `heartbeat\.device\.sync\.speedMbps` 保持一致/);
  assert.match(contract, /失败心跳必须包含 `heartbeat\.errorCode: "heartbeat_failed"`/);
  assert.match(contract, /device\.compatibility/);
  assert.match(contract, /device\.sync/);
  assert.match(contract, /device\.sync\.currentFile/);
  assert.match(contract, /客户端保存 `heartbeat\.device\.sync\.lastRun` 时也必须保留这些稳定字段/);
  assert.match(contract, /`id`、`status`、`trigger`、`startedAt`、`finishedAt`、`job`、`localPath`、`exitCode`/);
  assert.match(contract, /客户端保存 `heartbeat\.device\.sync\.scheduler` 时也必须保留 `intervalMs`、`lastTriggeredAt` 和 `jobs\[\]`/);
  assert.match(contract, /对象 `schedule`/);
  assert.match(contract, /server health response contract/);
  assert.match(contract, /admin auth check response contract/);
  assert.match(contract, /admin tunnel autofill response contract/);
  assert.match(contract, /admin tunnel generate response contract/);
  assert.match(contract, /admin sing-box write response contract/);
  assert.match(contract, /admin sing-box mark-applied response contract/);
  assert.match(contract, /admin user write response contract/);
  assert.match(contract, /admin user delete response contract/);
  assert.match(contract, /admin storage buckets refresh response contract/);
  assert.match(contract, /admin storage bucket create response contract/);
  assert.match(contract, /admin storage bucket toggle response contract/);
  assert.match(contract, /admin storage bucket clear response contract/);
  assert.match(contract, /admin storage bucket delete-empty response contract/);
  assert.match(contract, /claim redeem response contract/);
  assert.match(contract, /assertClaimRedeemResponseContract/);
  assert.match(contract, /client health response contract/);
  assert.match(contract, /client shutdown response contract/);
  assert.match(contract, /client binaries check response contract/);
  assert.match(contract, /client profile import response contract/);
  assert.match(contract, /client job save response contract/);
  assert.match(contract, /client singbox process response contract/);
  assert.match(contract, /client sync history contract/);
  assert.match(contract, /client sync run response contract/);
  assert.match(contract, /vless parse response contract/);
  assert.match(contract, /singbox client config response contract/);
  assert.match(contract, /jobs preview response contract/);
  assert.match(contract, /server heartbeat response contract/);
  assert.match(contract, /不得保存服务端返回的 `vlessUri`/);
  assert.match(contract, /device\.syncState/);
  assert.match(contract, /device\.speedMbps/);
  assert.match(contract, /device\.bucket/);
  assert.match(contract, /device\.prefix/);
  assert.match(contract, /device\.clientVersion/);
  assert.match(contract, /device\.lastRemoteAddress/);
});

test("HTTP contract tests cover heartbeat device sync summary redaction", async () => {
  const [
    clientHttpContract,
    contractHttpContract,
    helperContract,
    runtimeContract
  ] = await Promise.all([
    readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8"),
    readFile(join(projectRoot, "tests", "contract-http.test.js"), "utf8"),
    readFile(join(projectRoot, "tests", "helpers", "contracts.js"), "utf8"),
    readFile(join(projectRoot, "scripts", "lib", "runtimeContracts.mjs"), "utf8")
  ]);

  assert.match(clientHttpContract, /client imports a real server-issued SyncKey into local jobs and sync preview/);
  assert.match(clientHttpContract, /const n1StorageEndpoint = "http:\/\/n1-minio\.sfsc:9000"/);
  assert.match(clientHttpContract, /createdClaim\.profile\.storage\.endpoint, n1StorageEndpoint/);
  assert.match(clientHttpContract, /savedJob\.job\.s3Endpoint, n1StorageEndpoint/);
  assert.match(clientHttpContract, /remoteConfigArgs\[remoteConfigArgs\.indexOf\("endpoint"\) \+ 1\], n1StorageEndpoint/);
  assert.match(clientHttpContract, /createdClaim\.profile\.defaults\.localProxyPort, 18092/);
  assert.match(clientHttpContract, /imported\.profile\.importMode, "claim-redeem"/);
  assert.match(clientHttpContract, /savedJob\.job\.remotePrefix, "devices\/e2e-pc"/);
  assert.match(clientHttpContract, /preview\.rclone\.env\.ALL_PROXY, "socks5:\/\/127\.0\.0\.1:18092"/);
  assert.match(clientHttpContract, /client status preserves server heartbeat device sync summary without VLESS secrets/);
  assert.match(clientHttpContract, /assertClientLogsContract/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(payload, "clientMissingRoute"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(await escapedStatic\.json\(\), "clientEscapedStatic"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(emptyImportPayload, "emptyImport"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(await missingVaultPreview\.json\(\), "missingVaultPreview"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(await corruptHistoryRun\.json\(\), "corruptHistoryRun"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(await run\.json\(\), "spawnFailRun"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(await firstImport\.json\(\), "firstImport"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(await runDestructiveWithoutConfirmation\.json\(\), "runDestructiveWithoutConfirmation"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(oversizedImportPayload, "clientOversizedImport"/);
  assert.match(clientHttpContract, /assertHttpErrorResponseContract\(await invalidJsonImport\.json\(\), "clientInvalidJsonImport"/);
  assert.doesNotMatch(clientHttpContract, /assert\.equal\(\(await [A-Za-z0-9]+\.json\(\)\)\.errorCode,/);
  assert.match(clientHttpContract, /assertClientStatusContract/);
  assert.match(clientHttpContract, /assertClientBinariesCheckContract/);
  assert.match(clientHttpContract, /assertClientHealthContract/);
  assert.match(clientHttpContract, /assertClientShutdownResponseContract/);
  assert.match(clientHttpContract, /assertClientProfileImportResponseContract/);
  assert.match(clientHttpContract, /assertClientJobSaveResponseContract/);
  assert.match(clientHttpContract, /assertClientSingboxProcessResponseContract/);
  assert.match(clientHttpContract, /assertClientSyncHistoryContract/);
  assert.match(clientHttpContract, /assertClientSyncRunResponseContract/);
  assert.match(clientHttpContract, /assertDiagnosticExportContract/);
  assert.match(clientHttpContract, /assertHeartbeatContract/);
  assert.match(clientHttpContract, /assertSyncPreviewContract/);
  assert.match(clientHttpContract, /from "\.\/helpers\/contracts\.js"/);
  assert.match(clientHttpContract, /assertSyncPreviewContract\(preview/);
  assert.match(clientHttpContract, /preview\.schedule\.text\.trim\(\)/);
  assert.match(clientHttpContract, /preview\.rclone\.remotePath\.trim\(\)/);
  assert.match(clientHttpContract, /rcloneRemoteConfigSecretEnvValues\(preview\.rclone\)\.includes\(rawStorageSecret\)/);
  assert.match(clientHttpContract, /const missingVaultSave = await fetch\(`\$\{baseUrl\}\/api\/jobs\/save`/);
  assert.match(clientHttpContract, /const missingVaultRun = await fetch\(`\$\{baseUrl\}\/api\/sync\/run`/);
  assert.match(clientHttpContract, /assertClientLogsContract\(logsPayload/);
  assert.match(clientHttpContract, /assertDiagnosticExportContract\(diagnosticPayload/);
  assert.match(clientHttpContract, /assertHeartbeatContract\(status\.heartbeat\)/);
  assert.doesNotMatch(clientHttpContract, /function assertClientStatusContract/);
  assert.doesNotMatch(clientHttpContract, /function assertHeartbeatContract/);
  assert.match(clientHttpContract, /\/api\/devices\/heartbeat/);
  assert.match(clientHttpContract, /status\.heartbeat\.device\.sync\.currentFile, "projects\/current\.iso"/);
  assert.match(clientHttpContract, /status\.heartbeat\.device\.sync\.lastRun\.id, "sync-run-1"/);
  assert.match(clientHttpContract, /status\.heartbeat\.device\.sync\.lastRun\.transferredSizeText, "1\.2 GiB"/);
  assert.match(clientHttpContract, /status\.heartbeat\.device\.sync\.scheduler\.intervalMs, 15000/);
  assert.match(clientHttpContract, /status\.heartbeat\.device\.sync\.scheduler\.jobs\[0\]\.scheduleText, "Every 15 minutes"/);
  assert.match(clientHttpContract, /diagnostics\.bundle\.status\.heartbeat\.device\.sync\.scheduler\.intervalMs, 15000/);
  assert.match(clientHttpContract, /diagnostics\.bundle\.status\.heartbeat\.device\.sync\.scheduler\.jobs\[0\]\.scheduleText, "Every 15 minutes"/);
  assert.match(clientHttpContract, /status\.heartbeat\.serverDiagnostics\.protocols\.heartbeat, 1/);
  assert.match(clientHttpContract, /status\.heartbeat\.compatibility\.policy\.heartbeat, "allow"/);
  assert.match(clientHttpContract, /status\.heartbeat\.device\.vlessUri, undefined/);
  assert.match(clientHttpContract, /heartbeatDeviceCurrentFile, "redacted"/);
  assert.match(contractHttpContract, /assertClientHeartbeatDeviceSummaryContract\(heartbeat\.device, "heartbeat\.device"\)/);
  assert.match(contractHttpContract, /assertServerHealthResponseContract\(health, "health"\)/);
  assert.match(contractHttpContract, /assertAdminAuthCheckResponseContract\(authenticatedCheck, "authenticatedCheck"\)/);
  assert.match(contractHttpContract, /assertAdminSingboxConfigPreviewContract\(configPreview, autofill\.state, "configPreview"\)/);
  assert.match(contractHttpContract, /assertAdminSingboxWriteResponseContract\(directWritten, "directWritten"\)/);
  assert.match(contractHttpContract, /assertAdminSingboxMarkAppliedResponseContract\(directMarkedApplied, "directMarkedApplied"\)/);
  assert.match(contractHttpContract, /assertAdminTunnelAutofillResponseContract\(autofill, "autofill"\)/);
  assert.match(contractHttpContract, /assertAdminTunnelGenerateResponseContract\(generated, "generated"\)/);
  assert.match(contractHttpContract, /assertAdminSingboxWriteResponseContract\(written, "written"\)/);
  assert.match(contractHttpContract, /assertAdminSingboxMarkAppliedResponseContract\(markedApplied, "markedApplied"\)/);
  assert.match(contractHttpContract, /assertAdminUserWriteResponseContract\(userCreate, "userCreate"/);
  assert.match(contractHttpContract, /assertAdminUserWriteResponseContract\(disabledUser, "disabledUser"\)/);
  assert.match(contractHttpContract, /assertAdminUserWriteResponseContract\(disabledAgain, "disabledAgain"\)/);
  assert.match(contractHttpContract, /assertAdminUserWriteResponseContract\(enabledAgain, "enabledAgain"\)/);
  assert.match(contractHttpContract, /assertAdminUserDeleteResponseContract\(deletedUser, "deletedUser"\)/);
  assert.match(contractHttpContract, /assertAdminUserWriteResponseContract\(disabledIncompatible, "disabledIncompatible"\)/);
  assert.match(contractHttpContract, /assertAdminUserWriteResponseContract\(enabledIncompatible, "enabledIncompatible"\)/);
  assert.match(contractHttpContract, /assertAdminStorageBucketCreateResponseContract\(archiveBucket, "archiveBucket"\)/);
  assert.match(contractHttpContract, /assertAdminStorageBucketCreateResponseContract\(createdBucket, "nonEmptyBucket\.createdBucket"\)/);
  assert.match(contractHttpContract, /assertAdminStorageBucketToggleResponseContract\(disabledArchiveBucket, "disabledArchiveBucket"\)/);
  assert.match(contractHttpContract, /assertAdminStorageBucketsRefreshResponseContract\(refreshedBuckets, "refreshedBuckets"\)/);
  assert.match(contractHttpContract, /assertAdminStorageBucketClearResponseContract\(clearedBucket, "nonEmptyBucket\.clearedBucket"\)/);
  assert.match(contractHttpContract, /assertAdminStorageBucketDeleteEmptyResponseContract\(deletedEmptyBucket, "nonEmptyBucket\.deletedEmptyBucket"\)/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await failedGenerate\.json\(\), "failedGenerate"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await failedSave\.json\(\), "failedSave"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await invalidJson\.json\(\), "serverInvalidJson"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await oversizedJson\.json\(\), "serverOversizedJson"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await unknownApi\.json\(\), "serverUnknownApi"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await missingStatic\.json\(\), "serverMissingStatic"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await escapedStatic\.json\(\), "serverEscapedStatic"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await unauthenticatedState\.json\(\), "unauthenticatedState"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await deleteMissingBucket\.json\(\), "deleteMissingBucket"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await invalidVlessParse\.json\(\), "invalidVlessParse"/);
  assert.match(contractHttpContract, /assertHttpErrorResponseContract\(await response\.json\(\), "validationFailedResponse"/);
  assert.doesNotMatch(contractHttpContract, /assert\.equal\(\(await [A-Za-z0-9]+\.json\(\)\)\.errorCode,/);
  assert.match(contractHttpContract, /assertClaimRedeemResponseContract\(rawRedeemed, "rawRedeemed"/);
  assert.match(contractHttpContract, /assertServerHeartbeatResponseContract\(heartbeat, "heartbeat"/);
  assert.match(contractHttpContract, /Object\.hasOwn\(heartbeat\.device, "vlessUri"\), false/);
  assert.match(contractHttpContract, /assertServerDeviceSummaryContract\(adminDevice, "adminDevice"\)/);
  assert.match(contractHttpContract, /Object\.hasOwn\(adminDevice, "vlessUri"\), false/);
  assert.match(contractHttpContract, /assertAdminDeviceVlessUriRevealContract\(revealedAdminDeviceVless/);
  assert.match(contractHttpContract, /assertAdminWriteStateResponseContract/);
  assert.match(helperContract, /from "\.\.\/\.\.\/scripts\/lib\/runtimeContracts\.mjs"/);
  assert.match(helperContract, /assertAdminAuthCheckResponseContract/);
  assert.match(helperContract, /assertClaimCreateResponseContract/);
  assert.match(helperContract, /assertClaimRedeemResponseContract/);
  assert.match(helperContract, /assertClientBinariesCheckContract/);
  assert.match(helperContract, /assertClientHealthContract/);
  assert.match(helperContract, /assertClientShutdownResponseContract/);
  assert.match(helperContract, /assertClientHeartbeatDeviceSummaryContract/);
  assert.match(helperContract, /assertClientJobsReadContract/);
  assert.match(helperContract, /assertClientJobSaveResponseContract/);
  assert.match(helperContract, /assertClientJobSummaryContract/);
  assert.match(helperContract, /assertClientLogsContract/);
  assert.match(helperContract, /assertClientProfileImportResponseContract/);
  assert.match(helperContract, /assertClientStatusContract/);
  assert.match(helperContract, /assertClientSingboxProcessResponseContract/);
  assert.match(helperContract, /assertClientSyncHistoryContract/);
  assert.match(helperContract, /assertClientSyncRunResponseContract/);
  assert.match(helperContract, /assertDiagnosticExportContract/);
  assert.match(helperContract, /assertDiagnosticLogMetaContract/);
  assert.match(helperContract, /assertProfileEncodeResponseContract/);
  assert.match(helperContract, /assertAdminClaimSummaryContract/);
  assert.match(helperContract, /assertAdminDefaultsSummaryContract/);
  assert.match(helperContract, /assertAdminSettingsSummaryContract/);
  assert.match(helperContract, /assertAdminSingboxMarkAppliedResponseContract/);
  assert.match(helperContract, /assertAdminSingboxConfigPreviewContract/);
  assert.match(helperContract, /assertAdminSingboxWriteResponseContract/);
  assert.match(helperContract, /assertAdminStateSummaryContract/);
  assert.match(helperContract, /assertAdminStorageSaveResponseContract/);
  assert.match(helperContract, /assertAdminStorageBucketClearResponseContract/);
  assert.match(helperContract, /assertAdminStorageBucketCreateResponseContract/);
  assert.match(helperContract, /assertAdminStorageBucketDeleteEmptyResponseContract/);
  assert.match(helperContract, /assertAdminStorageBucketsRefreshResponseContract/);
  assert.match(helperContract, /assertAdminStorageBucketToggleResponseContract/);
  assert.match(helperContract, /assertAdminStorageSummaryContract/);
  assert.match(helperContract, /assertAdminTunnelAutofillResponseContract/);
  assert.match(helperContract, /assertAdminTunnelGenerateResponseContract/);
  assert.match(helperContract, /assertAdminTunnelSummaryContract/);
  assert.match(helperContract, /assertAdminUserDeleteResponseContract/);
  assert.match(helperContract, /assertAdminUserWriteResponseContract/);
  assert.match(helperContract, /assertAdminUserSummaryContract/);
  assert.match(helperContract, /assertAdminWriteStateResponseContract/);
  assert.match(helperContract, /assertHeartbeatContract/);
  assert.match(helperContract, /assertHttpErrorResponseContract/);
  assert.match(helperContract, /assertJobsPreviewResponseContract/);
  assert.match(helperContract, /assertServerDeviceSummaryContract/);
  assert.match(helperContract, /assertServerHeartbeatResponseContract/);
  assert.match(helperContract, /assertServerIssuedProfileContract/);
  assert.match(helperContract, /assertSingboxClientConfigResponseContract/);
  assert.match(helperContract, /assertSyncPreviewContract/);
  assert.match(helperContract, /assertVlessParseResponseContract/);
  assert.match(runtimeContract, /export function assertAdminClaimSummaryContract/);
  assert.match(runtimeContract, /export function assertAdminDefaultsSummaryContract/);
  assert.match(runtimeContract, /export function assertAdminSettingsSummaryContract/);
  assert.match(runtimeContract, /export function assertAdminStateSummaryContract/);
  assert.match(runtimeContract, /export function assertAdminStorageSummaryContract/);
  assert.match(runtimeContract, /export function assertAdminTunnelAutofillResponseContract/);
  assert.match(runtimeContract, /export function assertAdminTunnelGenerateResponseContract/);
  assert.match(runtimeContract, /export function assertAdminTunnelSummaryContract/);
  assert.match(runtimeContract, /export function assertAdminUserDeleteResponseContract/);
  assert.match(runtimeContract, /export function assertAdminUserWriteResponseContract/);
  assert.match(runtimeContract, /export function assertAdminUserSummaryContract/);
  assert.match(runtimeContract, /export function assertAdminWriteStateResponseContract/);
  assert.match(runtimeContract, /export function assertAdminAuthCheckResponseContract/);
  assert.match(runtimeContract, /export function assertAdminSingboxMarkAppliedResponseContract/);
  assert.match(runtimeContract, /export function assertAdminSingboxConfigPreviewContract/);
  assert.match(runtimeContract, /export function assertAdminSingboxWriteResponseContract/);
  assert.match(runtimeContract, /export function assertAdminStorageSaveResponseContract/);
  assert.match(runtimeContract, /export function assertAdminStorageBucketClearResponseContract/);
  assert.match(runtimeContract, /export function assertAdminStorageBucketCreateResponseContract/);
  assert.match(runtimeContract, /export function assertAdminStorageBucketDeleteEmptyResponseContract/);
  assert.match(runtimeContract, /export function assertAdminStorageBucketsRefreshResponseContract/);
  assert.match(runtimeContract, /export function assertAdminStorageBucketToggleResponseContract/);
  assert.match(runtimeContract, /export function assertClaimCreateResponseContract/);
  assert.match(runtimeContract, /export function assertClaimRedeemResponseContract/);
  assert.match(runtimeContract, /export function assertClientBinariesCheckContract/);
  assert.match(runtimeContract, /export function assertClientHealthContract/);
  assert.match(runtimeContract, /export function assertClientShutdownResponseContract/);
  assert.match(runtimeContract, /export function assertClientJobsReadContract/);
  assert.match(runtimeContract, /export function assertClientJobSaveResponseContract/);
  assert.match(runtimeContract, /export function assertClientJobSummaryContract/);
  assert.match(runtimeContract, /export function assertClientStatusContract/);
  assert.match(runtimeContract, /export function assertClientSingboxProcessResponseContract/);
  assert.match(runtimeContract, /export function assertClientSyncHistoryContract/);
  assert.match(runtimeContract, /export function assertClientSyncRunResponseContract/);
  assert.match(runtimeContract, /export function assertClientLogsContract/);
  assert.match(runtimeContract, /export function assertClientProfileImportResponseContract/);
  assert.match(runtimeContract, /export function assertDiagnosticExportContract/);
  assert.match(runtimeContract, /export function assertDiagnosticBundleContract/);
  assert.match(runtimeContract, /export function assertDiagnosticLogMetaContract/);
  assert.match(runtimeContract, /export function assertProfileEncodeResponseContract/);
  assert.match(runtimeContract, /export function assertClientHeartbeatDeviceSummaryContract/);
  assert.match(runtimeContract, /export function assertHeartbeatContract/);
  assert.match(runtimeContract, /export function assertHttpErrorResponseContract/);
  assert.match(runtimeContract, /export function assertJobsPreviewResponseContract/);
  assert.match(runtimeContract, /export function assertServerDeviceSummaryContract/);
  assert.match(runtimeContract, /export function assertServerHeartbeatResponseContract/);
  assert.match(runtimeContract, /export function assertServerHealthResponseContract/);
  assert.match(runtimeContract, /export function assertServerIssuedProfileContract/);
  assert.match(runtimeContract, /export function assertSingboxClientConfigResponseContract/);
  assert.match(runtimeContract, /export function assertSyncPreviewContract/);
  assert.match(runtimeContract, /export function assertVlessParseResponseContract/);
  assert.match(runtimeContract, /assertNonEmptyString\(preview\.schedule\.text, `\$\{label\}\.schedule\.text`\)/);
  assert.match(runtimeContract, /assertNonEmptyString\(rclone\.displayCommand, `\$\{label\}\.displayCommand`\)/);
  assert.match(runtimeContract, /assertNonEmptyString\(rclone\.remoteConfig\.displayCommand, `\$\{label\}\.remoteConfig\.displayCommand`\)/);
  assert.match(runtimeContract, /assertNonEmptyString\(rclone\.remotePath, `\$\{label\}\.remotePath`\)/);
  assert.match(runtimeContract, /forbidVlessUri/);
  assert.match(runtimeContract, /leaked raw vlessUri/);
  assert.match(runtimeContract, /assertObject\(job\.schedule, `\$\{jobLabel\}\.schedule`\)/);
  assert.match(runtimeContract, /assert\(Object\.hasOwn\(sync, "lastRun"\), `\$\{label\}\.lastRun`\)/);
  assert.match(runtimeContract, /assert\(Object\.hasOwn\(sync, "scheduler"\), `\$\{label\}\.scheduler`\)/);
  assert.match(runtimeContract, /assert\(Object\.hasOwn\(run, "job"\), `\$\{label\}\.job`\)/);
  assert.match(runtimeContract, /assertEqual\(device\.syncState, device\.sync\.state/);
  assert.match(runtimeContract, /assertEqual\(device\.speedMbps, device\.sync\.speedMbps/);
  assert.match(runtimeContract, /secretAccessKey/);
  assert.match(runtimeContract, /privateKey/);
  assert.match(runtimeContract, /tKey/);
  assert.match(runtimeContract, /tKeyUri/);
  assert.match(runtimeContract, /claimCode/);
  assert.match(runtimeContract, /sfsc:\/\/import\/v1#/);
});

test("runtime contracts forbid VLESS URI on client heartbeat device snapshots", () => {
  const device = buildRuntimeContractDeviceFixture();
  device.vlessUri = "vless://server-secret@example.com:443";
  assert.doesNotThrow(() => assertServerDeviceSummaryContract(device, "adminDevice"));
  assert.throws(
    () => assertHeartbeatContract({
      ok: true,
      server: "http://server.example",
      sentAt: "2026-07-04T12:00:00.000Z",
      status: 200,
      serverDiagnostics: buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" }),
      compatibility: {
        ok: true,
        status: "compatible",
        action: "none",
        severity: "ok",
        policy: {
          heartbeat: "allow",
          profileIssue: "allow",
          syncRun: "allow",
          adminActions: "allow",
          reason: "none"
        },
        localRole: "server",
        remoteRole: "client",
        issues: []
      },
      device
    }),
    /vlessUri/
  );
});

test("runtime client status contract hardens exact keys and derived fields", () => {
  const status = buildRuntimeContractClientStatusFixture();
  assert.doesNotThrow(() => assertClientStatusContract(status, "clientStatus"));

  assert.throws(
    () => assertClientStatusContract({
      ...buildRuntimeContractClientStatusFixture(),
      extra: true
    }, "clientStatusExtra"),
    /clientStatusExtra keys/
  );

  const versionMismatch = buildRuntimeContractClientStatusFixture();
  versionMismatch.clientVersion = "0.2.0";
  assert.throws(
    () => assertClientStatusContract(versionMismatch, "clientStatusVersionMismatch"),
    /clientStatusVersionMismatch\.clientVersion/
  );

  const lastSyncMismatch = buildRuntimeContractClientStatusFixture();
  lastSyncMismatch.lastSync = {
    ...lastSyncMismatch.syncHistory[0],
    id: "run-mismatch"
  };
  assert.throws(
    () => assertClientStatusContract(lastSyncMismatch, "clientStatusLastSyncMismatch"),
    /clientStatusLastSyncMismatch\.lastSync/
  );

  const failedLastSuccessfulHeartbeat = buildRuntimeContractClientStatusFixture();
  failedLastSuccessfulHeartbeat.lastSuccessfulHeartbeat = buildRuntimeContractHeartbeatFixture({ ok: false });
  assert.throws(
    () => assertClientStatusContract(failedLastSuccessfulHeartbeat, "clientStatusFailedLastSuccessfulHeartbeat"),
    /clientStatusFailedLastSuccessfulHeartbeat\.lastSuccessfulHeartbeat\.ok/
  );
});

test("runtime client status contract rejects raw secrets in allowed fields", () => {
  for (const { label, mutate, expected } of [
    {
      label: "clientStatusRawSecret",
      mutate(status) {
        status.safeguards.secretVault.path = "C:\\SFSC\\raw-secret\\secrets.json";
      },
      expected: /clientStatusRawSecret\.safeguards\.secretVault\.path leaked raw secret/
    },
    {
      label: "clientStatusVlessLeak",
      mutate(status) {
        status.paths.root = "vless://raw-secret@example.com:443";
      },
      expected: /clientStatusVlessLeak\.paths\.root leaked VLESS URI/
    },
    {
      label: "clientStatusTKeyLeak",
      mutate(status) {
        status.paths.dataRoot = "C:\\SFSC\\SFSC1-raw-secret";
      },
      expected: /clientStatusTKeyLeak\.paths\.dataRoot leaked SyncKey/
    },
    {
      label: "clientStatusImportUriLeak",
      mutate(status) {
        status.paths.binRoot = "sfsc://import/v1#raw-secret";
      },
      expected: /clientStatusImportUriLeak\.paths\.binRoot leaked import URI/
    }
  ]) {
    const status = buildRuntimeContractClientStatusFixture();
    mutate(status);
    assert.throws(
      () => assertClientStatusContract(status, label, { rawSecrets: ["raw-secret"] }),
      expected
    );
  }
});

test("runtime client logs and diagnostic export contracts enforce exact top-level keys", () => {
  const logs = {
    singbox: "sing-box log ok",
    rclone: "rclone log ok"
  };
  assert.doesNotThrow(() => assertClientLogsContract(logs, "clientLogs"));
  assert.throws(
    () => assertClientLogsContract({ ...logs, electron: "electron log ok" }, "clientLogsExtra"),
    /clientLogsExtra keys/
  );

  const diagnosticExport = buildRuntimeContractDiagnosticExportFixture();
  assert.doesNotThrow(() => assertDiagnosticExportContract(diagnosticExport, "diagnosticExport"));
  assert.throws(
    () => assertDiagnosticExportContract({
      ...buildRuntimeContractDiagnosticExportFixture(),
      status: "ready"
    }, "diagnosticExportExtra"),
    /diagnosticExportExtra keys/
  );
});

test("runtime diagnostic bundle contracts enforce exact keys and strict logs", () => {
  const logMeta = buildRuntimeContractDiagnosticLogMetaFixture("rclone");
  assert.doesNotThrow(() => assertDiagnosticLogMetaContract(logMeta, "diagnosticLog"));
  assert.throws(
    () => assertDiagnosticLogMetaContract({ ...logMeta, tailBytes: 512 }, "diagnosticLogExtra"),
    /diagnosticLogExtra keys/
  );

  const bundle = buildRuntimeContractDiagnosticBundleFixture();
  assert.doesNotThrow(() => assertDiagnosticBundleContract(bundle, "diagnosticBundle"));
  assert.throws(
    () => assertDiagnosticBundleContract({
      ...buildRuntimeContractDiagnosticBundleFixture(),
      source: "manual"
    }, "diagnosticBundleExtra"),
    /diagnosticBundleExtra keys/
  );

  const bundleWithExtraLog = buildRuntimeContractDiagnosticBundleFixture();
  bundleWithExtraLog.logs.debug = buildRuntimeContractDiagnosticLogMetaFixture("debug");
  assert.throws(
    () => assertDiagnosticBundleContract(bundleWithExtraLog, "diagnosticBundleStrictLogs"),
    /diagnosticBundleStrictLogs\.logs keys/
  );
});

test("runtime contracts redact admin claim summary secrets", () => {
  const claim = {
    id: "claim-1",
    code: "ABCD-2345",
    userId: "user-1",
    clientName: "pc1",
    bucketName: "home-sync",
    profileId: "profile-1",
    used: false,
    createdAt: "2026-07-04T12:00:00.000Z",
    expiresAt: "2026-07-04T13:00:00.000Z",
    redeemedAt: null,
    server: "https://server.example"
  };

  assert.doesNotThrow(() => assertAdminClaimSummaryContract(claim));
  assert.throws(
    () => assertAdminClaimSummaryContract({ ...claim, used: true, redeemedAt: null }),
    /redeemedAt/
  );

  for (const field of ["profile", "tKey", "tKeyUri", "claimCode", "token", "uri", "secretAccessKey", "vlessUri"]) {
    assert.throws(
      () => assertAdminClaimSummaryContract({ ...claim, [field]: "secret" }),
      new RegExp(field)
    );
  }

  for (const leakedText of ["SFSC1-secret", "sfsc://import/v1#secret", "vless://secret@example.com"]) {
    assert.throws(
      () => assertAdminClaimSummaryContract({ ...claim, clientName: leakedText }),
      /leaked/
    );
  }
});

test("runtime contracts enforce admin state summary shape", () => {
  const state = createDefaultAdminState();
  const summary = summarizeAdminState(state);

  assert.doesNotThrow(() => assertAdminStateSummaryContract(summary, "summary"));
  assert.doesNotThrow(() => assertAdminSettingsSummaryContract(summary.settings, "summary.settings"));
  assert.doesNotThrow(() => assertAdminTunnelSummaryContract(summary.tunnel, "summary.tunnel"));
  assert.doesNotThrow(() => assertAdminStorageSummaryContract(summary.storage, "summary.storage"));
  assert.doesNotThrow(() => assertAdminDefaultsSummaryContract(summary.defaults, "summary.defaults"));
  assert.doesNotThrow(() => assertAdminAuthCheckResponseContract({ ok: true, adminAuth: { enabled: false } }, "adminAuthCheck"));
  assert.doesNotThrow(() => assertServerHealthResponseContract({
    ok: true,
    app: "singbox-folder-sync",
    version: "0.3.0-rc.1",
    diagnostics: buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" }),
    mode: "server-admin",
    pathsConfigured: {
      serverDataRoot: true,
      singboxConfigPath: true
    },
    architecture: {
      serverServices: ["sync-server", "sing-box", "minio"],
      clientKernel: "sing-box",
      syncEngine: "rclone",
      storageBackend: "MinIO/S3"
    },
    safeguards: {
      tun: false,
      systemProxy: false,
      routeMutation: false,
      muxDefault: false
    },
    serviceHealth: {
      ok: true,
      apiReachable: true,
      restartRequired: false
    },
    adminAuth: { enabled: false }
  }, "serverHealth"));
  assert.doesNotThrow(() => assertAdminSingboxConfigPreviewContract({
    path: "C:\\sfsc\\sing-box\\config.json",
    config: buildSingboxServerConfig(state)
  }, summary, "singboxConfigPreview"));

  const adminWriteState = createDefaultAdminState();
  autoFillTunnelConfig(adminWriteState, {
    protocol: "vless-tcp-none",
    remark: "contract",
    publicHost: "contract.example.com",
    publicPort: 45678,
    listenPort: 45678
  });
  const autofillSummary = summarizeAdminState(adminWriteState);
  const autofillResponse = {
    tunnel: autofillSummary.tunnel,
    state: autofillSummary
  };
  assert.doesNotThrow(() => assertAdminTunnelAutofillResponseContract(autofillResponse, "tunnelAutofill"));

  adminWriteState.tunnel.lastConfigWrittenAt = new Date().toISOString();
  const tunnelConfig = buildSingboxServerConfig(adminWriteState);
  const generatedSummary = summarizeAdminState(adminWriteState);
  const generateResponse = {
    tunnel: generatedSummary.tunnel,
    config: tunnelConfig,
    state: generatedSummary
  };
  assert.doesNotThrow(() => assertAdminTunnelGenerateResponseContract(generateResponse, "tunnelGenerate"));
  assert.doesNotThrow(() => assertAdminSingboxWriteResponseContract({
    path: "C:\\sfsc\\sing-box\\config.json",
    restartRequired: true,
    config: tunnelConfig,
    state: generatedSummary
  }, "singboxWrite"));

  markSingboxApplied(adminWriteState, { confirmMarkApplied: true });
  assert.doesNotThrow(() => assertAdminSingboxMarkAppliedResponseContract({
    state: summarizeAdminState(adminWriteState)
  }, "singboxMarkApplied"));

  const userWriteState = createDefaultAdminState();
  const rawUser = createManagedUser(userWriteState, { clientName: "contract-pc1" });
  userWriteState.tunnel.lastConfigWrittenAt = new Date().toISOString();
  const userWriteSummary = summarizeAdminState(userWriteState);
  const userWriteResponse = {
    user: userWriteSummary.users.find((user) => user.id === rawUser.id),
    config: buildSingboxServerConfig(userWriteState),
    state: userWriteSummary
  };
  assert.doesNotThrow(() => assertAdminUserWriteResponseContract(userWriteResponse, "userWrite"));

  setManagedUserEnabled(userWriteState, { userId: rawUser.id, enabled: false });
  userWriteState.tunnel.lastConfigWrittenAt = new Date().toISOString();
  const disabledUserSummary = summarizeAdminState(userWriteState);
  assert.doesNotThrow(() => assertAdminUserWriteResponseContract({
    user: disabledUserSummary.users.find((user) => user.id === rawUser.id),
    config: buildSingboxServerConfig(userWriteState),
    state: disabledUserSummary
  }, "userDisable"));

  const userDeleteState = createDefaultAdminState();
  const rawDeletedUser = createManagedUser(userDeleteState, { clientName: "contract-pc2" });
  deleteManagedUser(userDeleteState, { userId: rawDeletedUser.id });
  userDeleteState.tunnel.lastConfigWrittenAt = new Date().toISOString();
  const userDeleteSummary = summarizeAdminState(userDeleteState);
  const userDeleteResponse = {
    ok: true,
    deletedUserId: rawDeletedUser.id,
    config: buildSingboxServerConfig(userDeleteState),
    state: userDeleteSummary
  };
  assert.doesNotThrow(() => assertAdminUserDeleteResponseContract(userDeleteResponse, "userDelete"));

  const bucketCreateState = createDefaultAdminState();
  const createdBucket = createStorageBucket(bucketCreateState, { bucket: "archive-sync" });
  const bucketCreateSummary = summarizeAdminState(bucketCreateState);
  assert.doesNotThrow(() => assertAdminStorageBucketCreateResponseContract({
    bucket: createdBucket,
    provision: {
      ok: false,
      errorCode: "storage_request_failed",
      warning: "MinIO unavailable"
    },
    state: bucketCreateSummary
  }, "bucketCreate"));
  assert.doesNotThrow(() => assertAdminStorageBucketsRefreshResponseContract({
    ok: false,
    errorCode: "storage_request_failed",
    warning: "MinIO unavailable",
    buckets: bucketCreateState.storage.buckets,
    state: bucketCreateSummary
  }, "bucketsRefresh"));
  const bucketToggleState = createDefaultAdminState();
  createStorageBucket(bucketToggleState, { bucket: "archive-sync" });
  const disabledBucket = setStorageBucketEnabled(bucketToggleState, {
    bucket: "archive-sync",
    enabled: false
  });
  assert.doesNotThrow(() => assertAdminStorageBucketToggleResponseContract({
    bucket: disabledBucket,
    state: summarizeAdminState(bucketToggleState)
  }, "bucketToggle"));
  const bucketClearState = createDefaultAdminState();
  createStorageBucket(bucketClearState, { bucket: "archive-sync" });
  const clearedBucket = markStorageBucketCleared(bucketClearState, "archive-sync");
  assert.doesNotThrow(() => assertAdminStorageBucketClearResponseContract({
    ok: true,
    bucket: clearedBucket,
    result: {
      deleted: 0,
      rounds: 1
    },
    state: summarizeAdminState(bucketClearState)
  }, "bucketClear"));
  const bucketDeleteState = createDefaultAdminState();
  createStorageBucket(bucketDeleteState, { bucket: "archive-sync" });
  removeStorageBucket(bucketDeleteState, { bucket: "archive-sync" });
  const bucketDeleteSummary = summarizeAdminState(bucketDeleteState);
  assert.doesNotThrow(() => assertAdminStorageBucketDeleteEmptyResponseContract({
    ok: true,
    storage: bucketDeleteSummary.storage,
    result: {
      deletedBucket: "archive-sync"
    },
    state: bucketDeleteSummary
  }, "bucketDeleteEmpty"));

  const claimCreateState = createDefaultAdminState({
    publicServerUrl: "https://server.example"
  });
  const createdClaim = createClaim(claimCreateState, {
    clientName: "claim-contract-pc",
    server: "https://server.example"
  });
  claimCreateState.tunnel.lastConfigWrittenAt = new Date().toISOString();
  const claimCreateSummary = summarizeAdminState(claimCreateState);
  const claimCreateResponse = {
    code: createdClaim.claim.code,
    tKey: createdClaim.token,
    tKeyUri: createdClaim.uri,
    claimCode: createdClaim.token,
    uri: createdClaim.uri,
    claim: claimCreateSummary.claims.find((claim) => claim.id === createdClaim.claim.id),
    profile: createdClaim.profile,
    compatibility: createdClaim.compatibility,
    state: claimCreateSummary
  };
  assert.doesNotThrow(() => assertClaimCreateResponseContract(claimCreateResponse, "claimCreate"));
  const { compatibility: _missingCompatibility, ...claimCreateWithoutCompatibility } = claimCreateResponse;
  assert.throws(
    () => assertClaimCreateResponseContract(claimCreateWithoutCompatibility, "claimCreate"),
    /claimCreate keys/
  );
  assert.throws(
    () => assertClaimCreateResponseContract({
      ...claimCreateResponse,
      config: buildSingboxServerConfig(claimCreateState)
    }, "claimCreate"),
    /claimCreate keys/
  );
  assert.throws(
    () => assertClaimCreateResponseContract({
      ...claimCreateResponse,
      state: {
        ...claimCreateResponse.state,
        tunnel: {
          ...claimCreateResponse.state.tunnel,
          lastConfigWrittenAt: null
        }
      }
    }, "claimCreate"),
    /claimCreate\.state\.tunnel\.lastConfigWrittenAt/
  );
  assert.throws(
    () => assertClaimRedeemResponseContract({
      ...createdClaim.profile,
      source: {
        type: "claim",
        server: "https://server.example",
        token: "raw-token"
      }
    }, "claimRedeemProfileSourceExtra"),
    /claimRedeemProfileSourceExtra keys/
  );
  assert.throws(
    () => assertClaimRedeemResponseContract({
      ...createdClaim.profile,
      heartbeat: {
        ...createdClaim.profile.heartbeat,
        secretVersion: 1
      }
    }, "claimRedeemProfileHeartbeatExtra"),
    /claimRedeemProfileHeartbeatExtra\.heartbeat keys/
  );
  assert.throws(
    () => assertClaimRedeemResponseContract({
      ...createdClaim.profile,
      storage: {
        ...createdClaim.profile.storage,
        region: "us-east-1"
      }
    }, "claimRedeemProfileStorageExtra"),
    /claimRedeemProfileStorageExtra\.storage keys/
  );
  assert.throws(
    () => assertClaimRedeemResponseContract({
      ...createdClaim.profile,
      defaults: {
        ...createdClaim.profile.defaults,
        deleteExcluded: false
      }
    }, "claimRedeemProfileDefaultsExtra"),
    /claimRedeemProfileDefaultsExtra\.defaults keys/
  );
  const profileEncodeProfile = normalizeImportProfile({
    ...createdClaim.profile,
    source: {
      type: "profile",
      server: "https://server.example"
    }
  });
  const profileEncodeResponse = {
    profile: profileEncodeProfile,
    summary: summarizeImportProfile(profileEncodeProfile),
    code: "SFSC1-profile-code",
    uri: "sfsc://import/v1#profile-code"
  };
  assert.doesNotThrow(() => assertProfileEncodeResponseContract(profileEncodeResponse, "profileEncode"));
  assert.throws(
    () => assertProfileEncodeResponseContract({
      ...profileEncodeResponse,
      profile: {
        ...profileEncodeProfile,
        source: {
          ...profileEncodeProfile.source,
          token: "raw-token"
        }
      }
    }, "profileEncodeSourceExtra"),
    /profileEncodeSourceExtra\.profile\.source keys/
  );
  assert.throws(
    () => assertProfileEncodeResponseContract({
      ...profileEncodeResponse,
      profile: {
        ...profileEncodeProfile,
        tunnel: {
          ...profileEncodeProfile.tunnel,
          publicKey: "leaked-public-key"
        }
      }
    }, "profileEncodeTunnelExtra"),
    /profileEncodeTunnelExtra\.profile\.tunnel keys/
  );

  assert.throws(
    () => assertAdminSettingsSummaryContract({ ...summary.settings, publicServerUrl: `${summary.settings.publicServerUrl}/` }),
    /publicServerUrl/
  );
  assert.throws(
    () => assertAdminTunnelSummaryContract({ ...summary.tunnel, sampleUri: "vless://bad@example.com:443?security=none&type=tcp", userCount: 1 }),
    /sampleUri/
  );
  assert.throws(
    () => assertAdminStorageSummaryContract({ ...summary.storage, secretAccessKey: "raw-secret" }),
    /secretAccessKey/
  );
  assert.doesNotThrow(() => assertAdminWriteStateResponseContract({ ok: true, state: summary }, "adminWrite"));
  assert.throws(
    () => assertAdminWriteStateResponseContract({ ok: true }, "adminWrite"),
    /adminWrite\.state/
  );
  assert.throws(
    () => assertAdminWriteStateResponseContract({ ok: true, state: summary, secretAccessKey: "raw-secret" }, "adminWrite"),
    /secretAccessKey/
  );
  assert.throws(
    () => assertAdminWriteStateResponseContract({ ok: true, state: summary, tKey: "SFSC1-secret" }, "adminWrite"),
    /tKey/
  );
  assert.doesNotThrow(() => assertAdminStorageSaveResponseContract({
    storage: summary.storage,
    state: summary
  }, "storageSave"));
  assert.throws(
    () => assertAdminStorageSaveResponseContract({
      ok: true,
      storage: summary.storage,
      state: summary
    }, "storageSave"),
    /storageSave keys/
  );
  assert.throws(
    () => assertAdminAuthCheckResponseContract({ ok: true, adminAuth: { enabled: "yes" } }, "adminAuthCheck"),
    /adminAuthCheck\.adminAuth\.enabled/
  );
  assert.throws(
    () => assertServerHealthResponseContract({
      ok: true,
      app: "singbox-folder-sync",
      version: "0.3.0-rc.1",
      diagnostics: buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" }),
      mode: "server-admin",
      pathsConfigured: {
        serverDataRoot: true,
        singboxConfigPath: true
      },
      architecture: {
        serverServices: ["sync-server", "sing-box", "minio"],
        clientKernel: "sing-box",
        syncEngine: "rclone",
        storageBackend: "MinIO/S3"
      },
      safeguards: {
        tun: false,
        systemProxy: false,
        routeMutation: false,
        muxDefault: false
      },
      serviceHealth: {
        ok: true,
        apiReachable: true,
        restartRequired: false
      },
      adminAuth: { enabled: false },
      state: summary
    }, "serverHealth"),
    /serverHealth keys/
  );
  assert.throws(
    () => assertServerHealthResponseContract({
      ok: true,
      app: "singbox-folder-sync",
      version: "0.3.0-rc.1",
      diagnostics: buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" }),
      mode: "server-admin",
      serverDataRoot: "C:\\sfsc\\data",
      singboxConfigPath: "C:\\sfsc\\sing-box\\config.json",
      architecture: {
        serverServices: ["sync-server", "sing-box", "minio"],
        clientKernel: "sing-box",
        syncEngine: "rclone",
        storageBackend: "MinIO/S3"
      },
      safeguards: {
        tun: false,
        systemProxy: false,
        routeMutation: false,
        muxDefault: false
      },
      serviceHealth: {
        ok: true,
        apiReachable: true,
        restartRequired: false
      },
      adminAuth: { enabled: false }
    }, "serverHealth"),
    /serverHealth keys/
  );
  const mismatchedConfig = structuredClone(buildSingboxServerConfig(state));
  mismatchedConfig.inbounds[0].listen_port = summary.tunnel.listenPort + 1;
  assert.throws(
    () => assertAdminSingboxConfigPreviewContract({
      path: "C:\\sfsc\\sing-box\\config.json",
      config: mismatchedConfig
    }, summary, "singboxConfigPreview"),
    /singboxConfigPreview\.config\.inbounds\[0\]\.listen_port/
  );
  assert.throws(
    () => assertAdminTunnelAutofillResponseContract({ ...autofillResponse, config: tunnelConfig }, "tunnelAutofill"),
    /tunnelAutofill keys/
  );
  assert.throws(
    () => {
      const notRestartRequiredSummary = {
        ...generatedSummary,
        tunnel: {
          ...generatedSummary.tunnel,
          restartRequired: false
        }
      };
      assertAdminTunnelGenerateResponseContract({
        ...generateResponse,
        tunnel: notRestartRequiredSummary.tunnel,
        state: notRestartRequiredSummary
      }, "tunnelGenerate");
    },
    /tunnelGenerate\.state\.tunnel\.restartRequired/
  );
  assert.throws(
    () => assertAdminSingboxWriteResponseContract({
      path: "C:\\sfsc\\sing-box\\config.json",
      restartRequired: false,
      config: tunnelConfig,
      state: generatedSummary
    }, "singboxWrite"),
    /singboxWrite\.restartRequired/
  );
  assert.throws(
    () => assertAdminSingboxMarkAppliedResponseContract({
      state: generatedSummary
    }, "singboxMarkApplied"),
    /singboxMarkApplied\.state\.tunnel\.restartRequired/
  );
  assert.throws(
    () => assertAdminUserWriteResponseContract({
      ...userWriteResponse,
      user: {
        ...userWriteResponse.user,
        clientName: "different-pc"
      }
    }, "userWrite"),
    /userWrite\.user/
  );
  assert.throws(
    () => assertAdminUserDeleteResponseContract({
      ...userDeleteResponse,
      ok: false
    }, "userDelete"),
    /userDelete\.ok/
  );
  assert.throws(
    () => assertAdminUserDeleteResponseContract({
      ok: true,
      deletedUserId: rawUser.id,
      config: buildSingboxServerConfig(createDefaultAdminState()),
      state: userWriteSummary
    }, "userDelete"),
    /userDelete\.state\.users\.deleted\.enabled/
  );
  assert.throws(
    () => assertAdminStorageBucketCreateResponseContract({
      bucket: { name: "archive-sync", source: "managed" },
      provision: { ok: true },
      state: bucketCreateSummary
    }, "bucketCreate"),
    /bucketCreate\.bucket keys/
  );
  assert.throws(
    () => assertAdminStorageBucketsRefreshResponseContract({
      ok: false,
      errorCode: "storage_request_failed",
      buckets: bucketCreateState.storage.buckets,
      state: bucketCreateSummary
    }, "bucketsRefresh"),
    /bucketsRefresh keys/
  );
  assert.throws(
    () => assertAdminStorageBucketToggleResponseContract({
      bucket: { ...disabledBucket, disabledAt: null },
      state: summarizeAdminState(bucketToggleState)
    }, "bucketToggle"),
    /bucketToggle\.bucket\.disabledAt/
  );
  assert.throws(
    () => assertAdminStorageBucketClearResponseContract({
      ok: true,
      bucket: clearedBucket,
      result: { deleted: -1, rounds: 1 },
      state: summarizeAdminState(bucketClearState)
    }, "bucketClear"),
    /bucketClear\.result\.deleted/
  );
  assert.throws(
    () => assertAdminStorageBucketDeleteEmptyResponseContract({
      ok: true,
      storage: bucketCreateSummary.storage,
      result: { deletedBucket: "archive-sync" },
      state: bucketCreateSummary
    }, "bucketDeleteEmpty"),
    /bucketDeleteEmpty\.state\.storage\.buckets/
  );
});

test("runtime contracts enforce common HTTP error response shape", () => {
  assert.doesNotThrow(() => assertHttpErrorResponseContract({
    ok: false,
    error: "not_found",
    errorCode: "not_found",
    message: "Not found"
  }, "httpError", {
    errorCode: "not_found",
    message: "Not found"
  }));

  assert.throws(
    () => assertHttpErrorResponseContract({
      ok: false,
      error: "not_found",
      errorCode: "not_found",
      message: "Not found",
      status: 404
    }, "httpError"),
    /httpError keys/
  );
  assert.throws(
    () => assertHttpErrorResponseContract({
      ok: false,
      error: "legacy_not_found",
      errorCode: "not_found",
      message: "Not found"
    }, "httpError"),
    /httpError\.error/
  );
  assert.throws(
    () => assertHttpErrorResponseContract({
      ok: false,
      error: "",
      errorCode: "",
      message: "Not found"
    }, "httpError"),
    /httpError\.errorCode/
  );
  assert.throws(
    () => assertHttpErrorResponseContract({
      ok: false,
      error: "not-found",
      errorCode: "not-found",
      message: "Not found"
    }, "httpError"),
    /httpError\.errorCode/
  );
  assert.throws(
    () => assertHttpErrorResponseContract({
      ok: false,
      error: "not_found",
      errorCode: "not_found",
      message: ""
    }, "httpError"),
    /httpError\.message/
  );
  assert.throws(
    () => assertHttpErrorResponseContract({
      ok: false,
      error: "not_found",
      errorCode: "not_found",
      message: "Not found"
    }, "httpError", {
      errorCode: "invalid_json"
    }),
    /httpError\.errorCode expected invalid_json/
  );
});

test("protocol request schemas normalize key client and server request envelopes", () => {
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_REDEEM, {
    tKey: "  SFSC1-example  ",
    clientRedeemId: "redeem-1",
    clientInstallId: "install-1",
    ignored: "drop-me"
  }), {
    tKey: "SFSC1-example",
    clientRedeemId: "redeem-1",
    clientInstallId: "install-1"
  });

  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_REDEEM, {}),
    (error) => error.code === "import_code_invalid"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_REDEEM, { code: 123 }),
    (error) => error.code === "validation_failed"
  );

  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE, {
    clientName: " claim-pc ",
    server: " https://server.example/sfsc/ ",
    bucketName: " home-sync ",
    syncSpaceId: " space-team-documents ",
    requestedRole: " writer ",
    expiresInHours: 1,
    defaults: { schedule: { mode: "manual" } },
    confirmCompatibilityWarning: true,
    ignored: "drop-me"
  }), {
    clientName: "claim-pc",
    server: "https://server.example/sfsc/",
    bucketName: "home-sync",
    syncSpaceId: "space-team-documents",
    requestedRole: "writer",
    expiresInHours: 1,
    defaults: { schedule: { mode: "manual" } },
    confirmCompatibilityWarning: true
  });
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE, []),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE, { confirmCompatibilityWarning: "yes" }),
    (error) => error.code === "validation_failed"
  );

  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_SAVE, {
    endpoint: " http://minio:9000 ",
    internalEndpoint: null,
    bucket: " home-sync ",
    accessKeyId: " minioadmin ",
    secretAccessKey: " secret ",
    prefixRoot: " devices ",
    ignored: "drop-me"
  }), {
    endpoint: "http://minio:9000",
    internalEndpoint: "",
    bucket: "home-sync",
    accessKeyId: "minioadmin",
    secretAccessKey: "secret",
    prefixRoot: "devices"
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_CREATE, {
    bucket: " archive-sync ",
    source: " managed ",
    ignored: "drop-me"
  }), {
    bucket: "archive-sync",
    source: "managed"
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_REFRESH, {}), {});
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_ENABLE, {
    bucket: " archive-sync ",
    ignored: true
  }), {
    bucket: "archive-sync"
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_CLEAR, {
    bucket: " archive-sync ",
    confirmBucket: " archive-sync ",
    confirmText: " archive-sync ",
    ignored: true
  }), {
    bucket: "archive-sync",
    confirmBucket: "archive-sync",
    confirmText: "archive-sync"
  });
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_SAVE, { endpoint: 123 }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_DISABLE, { bucket: 123 }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_REFRESH, { ignored: true }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_STORAGE_BUCKET_DELETE_EMPTY, []),
    (error) => error.code === "validation_failed"
  );

  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_GENERATE, {
    protocol: " vless-reality-tcp ",
    publicHost: " pass.971223.xyz ",
    publicPort: 45678,
    listenPort: "45678",
    remark: " sfsc-home ",
    confirmGenerateTunnel: true,
    reality: { serverName: "www.microsoft.com" },
    ignored: "drop-me"
  }), {
    protocol: "vless-reality-tcp",
    publicHost: "pass.971223.xyz",
    publicPort: 45678,
    listenPort: "45678",
    remark: "sfsc-home",
    confirmGenerateTunnel: true,
    reality: { serverName: "www.microsoft.com" }
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_AUTOFILL, {
    protocol: " vless-reality-tcp ",
    publicHost: " pass.971223.xyz ",
    publicPort: "45678",
    listenPort: 45678,
    serverName: " www.microsoft.com ",
    fingerprint: " chrome ",
    shortId: " abcdef1234567890 ",
    forceRealityKeys: true,
    confirmRotateRealityKeys: false,
    ignored: "drop-me"
  }), {
    protocol: "vless-reality-tcp",
    publicHost: "pass.971223.xyz",
    publicPort: "45678",
    listenPort: 45678,
    serverName: "www.microsoft.com",
    fingerprint: "chrome",
    shortId: "abcdef1234567890",
    forceRealityKeys: true,
    confirmRotateRealityKeys: false
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_WRITE, {
    confirmWriteSingbox: true,
    ignored: "drop-me"
  }), {
    confirmWriteSingbox: true
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_MARK_APPLIED, {
    confirmMarkApplied: true,
    ignored: "drop-me"
  }), {
    confirmMarkApplied: true
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_APPLY, {
    confirmApplySingbox: true,
    ignored: "drop-me"
  }), {
    confirmApplySingbox: true
  });
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_GENERATE, { confirmGenerateTunnel: "true" }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_GENERATE, { reality: [] }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_AUTOFILL, { forceRealityKeys: "yes" }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_WRITE, []),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_MARK_APPLIED, { confirmMarkApplied: "true" }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_SINGBOX_APPLY, { confirmApplySingbox: "true" }),
    (error) => error.code === "validation_failed"
  );

  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_CREATE, {
    clientName: " admin-pc ",
    bucketName: " home-sync ",
    id: " user-id ",
    uuid: " 00000000-0000-4000-8000-000000000000 ",
    heartbeatSecret: " heartbeat-secret ",
    enabled: false,
    forceNew: true,
    accessKeyId: " access ",
    secretAccessKey: " secret ",
    prefix: " devices/admin-pc ",
    ignored: "drop-me"
  }), {
    clientName: "admin-pc",
    bucketName: "home-sync",
    id: "user-id",
    uuid: "00000000-0000-4000-8000-000000000000",
    heartbeatSecret: "heartbeat-secret",
    enabled: false,
    forceNew: true,
    accessKeyId: "access",
    secretAccessKey: "secret",
    prefix: "devices/admin-pc"
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_ENABLE, {
    userId: " user-1 ",
    confirmCompatibilityWarning: true,
    ignored: true
  }), {
    userId: "user-1",
    confirmCompatibilityWarning: true
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_DISABLE, {
    id: " user-1 ",
    confirmCompatibilityWarning: true
  }), {
    id: "user-1"
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_DELETE, {
    userId: " user-1 ",
    confirmText: " admin-pc ",
    confirmBucket: "admin-pc"
  }), {
    userId: "user-1",
    confirmText: "admin-pc"
  });
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_CREATE, { forceNew: "yes" }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_ENABLE, { confirmCompatibilityWarning: "true" }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_DISABLE, { userId: 123 }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_USER_DELETE, []),
    (error) => error.code === "validation_failed"
  );

  const heartbeat = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_DEVICE_HEARTBEAT, {
    clientName: " pc-1 ",
    profileId: "profile-pc-1",
    clientVersion: "0.3.0-rc.1",
    diagnostics: { role: "client" },
    storage: { bucket: "home-sync" },
    sync: { syncState: "idle" },
    syncState: "syncing",
    speedMbps: 50,
    currentFile: "projects/current.iso",
    auth: { scheme: "sfsc-hmac-sha256-v1" },
    extra: "drop-me"
  });
  assert.deepEqual(Object.keys(heartbeat).sort(), [
    "auth",
    "clientName",
    "clientVersion",
    "currentFile",
    "diagnostics",
    "profileId",
    "speedMbps",
    "storage",
    "sync",
    "syncState"
  ].sort());
  assert.equal(heartbeat.clientName, "pc-1");
  assert.equal(heartbeat.syncState, "syncing");
  assert.equal(heartbeat.speedMbps, 50);

  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_PROFILE_IMPORT, {
    code: " SFSC1-example ",
    junk: true
  }), {
    code: "SFSC1-example"
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_PROFILE_IMPORT, {
    uri: " vless://example ",
    clientName: " legacy-pc ",
    options: {
      localProxyPort: "18082",
      localProxyHost: "0.0.0.0",
      ignored: "drop-me"
    }
  }), {
    uri: "vless://example",
    clientName: "legacy-pc",
    options: {
      localProxyPort: 18082
    }
  });
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_PROFILE_IMPORT, {}),
    (error) => error.code === "import_code_required"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_PROFILE_IMPORT, {
      uri: "vless://example",
      options: {
        localProxyPort: 70000
      }
    }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, { job: {}, confirmCompatibilityWarning: "yes" }),
    (error) => error.code === "validation_failed"
  );
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, {
    job: {
      id: " job-1 ",
      name: " Home Sync ",
      localPath: " D:\\Work ",
      direction: " download ",
      remoteFolder: " projects ",
      serverSpace: " device ",
      transfers: "6",
      streams: 9,
      checkers: 11,
      s3UploadConcurrency: 5,
      s3ChunkSize: " 32M ",
      chunkSize: " 64M ",
      cutoff: " 128M ",
      retries: 4,
      lowLevelRetries: 12,
      dryRun: true,
      destructiveSync: false,
      bandwidthLimit: " 20M ",
      schedule: { mode: "manual" },
      localProxyPort: 18082,
      clientName: "evil-pc",
      remoteName: "evil-minio",
      bucketName: "evil-bucket",
      remotePrefix: "shared/evil",
      s3Endpoint: "http://evil.invalid:9000",
      accessKeyId: "evil-access",
      secretAccessKey: "evil-secret",
      s3SecretAccessKey: "evil-s3-secret",
      uri: "vless://evil.invalid",
      ignored: "drop-me"
    },
    confirmCompatibilityWarning: true,
    confirmDestructiveSync: false
  }), {
    job: {
      id: "job-1",
      name: "Home Sync",
      localPath: "D:\\Work",
      direction: "download",
      remoteFolder: "projects",
      serverSpace: "device",
      transfers: "6",
      streams: 9,
      checkers: 11,
      s3UploadConcurrency: 5,
      s3ChunkSize: "32M",
      chunkSize: "64M",
      cutoff: "128M",
      retries: 4,
      lowLevelRetries: 12,
      dryRun: true,
      destructiveSync: false,
      bandwidthLimit: "20M",
      schedule: { mode: "manual" },
      localProxyPort: 18082
    },
    confirmCompatibilityWarning: true,
    confirmDestructiveSync: false
  });
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_RUN, { job: { dryRun: "true" } }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_SYNC_PREVIEW, { job: { schedule: [] } }),
    (error) => error.code === "validation_failed"
  );
  for (const requestName of [
    PROTOCOL_REQUESTS.CLIENT_BINARIES_CHECK,
    PROTOCOL_REQUESTS.CLIENT_SHUTDOWN,
    PROTOCOL_REQUESTS.CLIENT_SINGBOX_START,
    PROTOCOL_REQUESTS.CLIENT_SINGBOX_STOP,
    PROTOCOL_REQUESTS.CLIENT_SYNC_STOP
  ]) {
    assert.deepEqual(parseProtocolRequest(requestName, {}), {});
    assert.throws(
      () => parseProtocolRequest(requestName, { ignored: true }),
      (error) => error.code === "validation_failed"
    );
  }
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_PROFILE_ENCODE, {
    clientName: " encode-pc ",
    uri: " vless://example ",
    endpoint: " http://minio:9000 ",
    bucket: " home-sync ",
    secretAccessKey: " profile-secret ",
    defaults: { localProxyPort: 18082 },
    schedule: { mode: "manual" },
    localProxyPort: 18083,
    ignored: "drop-me"
  }), {
    clientName: "encode-pc",
    uri: "vless://example",
    endpoint: "http://minio:9000",
    bucket: "home-sync",
    secretAccessKey: "profile-secret",
    defaults: { localProxyPort: 18082 },
    schedule: { mode: "manual" },
    localProxyPort: 18083
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_PROFILE_ENCODE, {
    uri: " vless://example ",
    accessKeyId: " ",
    secretAccessKey: null,
    heartbeatSecret: " ",
    bucket: null
  }), {
    uri: "vless://example",
    accessKeyId: "",
    secretAccessKey: "",
    heartbeatSecret: "",
    bucket: ""
  });
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_PROFILE_ENCODE, { defaults: [] }),
    (error) => error.code === "validation_failed"
  );
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_VLESS_PARSE, {
    uri: " vless://example ",
    ignored: "drop-me"
  }), {
    uri: "vless://example"
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_SINGBOX_CLIENT_CONFIG, {
    uri: " vless://example ",
    options: {
      localProxyPort: 18082,
      localProxyHost: "0.0.0.0",
      logLevel: "debug",
      ignored: "drop-me"
    },
    ignored: "drop-me"
  }), {
    uri: "vless://example",
    options: { localProxyPort: 18082 }
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_JOBS_PREVIEW, {
    uri: " vless://example ",
    options: {
      localProxyPort: 18082,
      rcloneBin: " rclone-custom ",
      rcloneConfigPath: " C:\\sfsc\\rclone.conf ",
      ignored: "drop-me"
    },
    job: {
      id: " preview-job ",
      name: " Preview ",
      direction: " upload ",
      localPath: " D:\\Work ",
      remoteName: " home-minio ",
      bucketName: " home-sync ",
      bucket: " home-sync ",
      clientName: " auth-pc1 ",
      remoteFolder: " projects ",
      serverSpace: " shared ",
      remotePrefix: " shared/projects ",
      storageBackend: " s3 ",
      s3Endpoint: " http://minio:9000 ",
      endpoint: " http://minio-client:9000 ",
      s3Region: " us-east-1 ",
      region: " us-west-2 ",
      accessKeyId: " access ",
      s3AccessKeyId: " s3-access ",
      secretAccessKey: " secret ",
      s3SecretAccessKey: " s3-secret ",
      remotePath: " home-minio:home-sync/shared/projects ",
      transfers: "4",
      streams: 8,
      checkers: 10,
      s3UploadConcurrency: 5,
      s3ChunkSize: " 32M ",
      chunkSize: " 64M ",
      cutoff: " 128M ",
      retries: 3,
      lowLevelRetries: 9,
      dryRun: true,
      destructiveSync: false,
      bandwidthLimit: " 20M ",
      schedule: { mode: "manual" },
      ignored: "drop-me"
    },
    ignored: "drop-me"
  }), {
    uri: "vless://example",
    options: {
      localProxyPort: 18082,
      rcloneBin: "rclone-custom",
      rcloneConfigPath: "C:\\sfsc\\rclone.conf"
    },
    job: {
      id: "preview-job",
      name: "Preview",
      direction: "upload",
      localPath: "D:\\Work",
      remoteName: "home-minio",
      bucketName: "home-sync",
      bucket: "home-sync",
      clientName: "auth-pc1",
      remoteFolder: "projects",
      serverSpace: "shared",
      remotePrefix: "shared/projects",
      storageBackend: "s3",
      s3Endpoint: "http://minio:9000",
      endpoint: "http://minio-client:9000",
      s3Region: "us-east-1",
      region: "us-west-2",
      accessKeyId: "access",
      s3AccessKeyId: "s3-access",
      secretAccessKey: "secret",
      s3SecretAccessKey: "s3-secret",
      remotePath: "home-minio:home-sync/shared/projects",
      transfers: "4",
      streams: 8,
      checkers: 10,
      s3UploadConcurrency: 5,
      s3ChunkSize: "32M",
      chunkSize: "64M",
      cutoff: "128M",
      retries: 3,
      lowLevelRetries: 9,
      dryRun: true,
      destructiveSync: false,
      bandwidthLimit: "20M",
      schedule: { mode: "manual" }
    }
  });
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_VLESS_PARSE, []),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_VLESS_PARSE, { uri: 123 }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_SINGBOX_CLIENT_CONFIG, { options: [] }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_JOBS_PREVIEW, { options: [] }),
    (error) => error.code === "validation_failed"
  );
  assert.throws(
    () => parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_JOBS_PREVIEW, { job: { secretAccessKey: 123 } }),
    (error) => error.code === "validation_failed"
  );
});

test("protocol request schemas whitelist nested objects and reject smuggled structures", () => {
  // CORE-3: nested-object whitelists drop unknown nested fields.
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE, {
    clientName: "pc-1",
    defaults: {
      transfers: 6,
      chunkSize: "32M",
      bandwidthLimit: "08:00,10M 18:00,off",
      schedule: { mode: "daily", time: "02:00", injected: "drop-me" },
      injected: { nested: true }
    }
  }), {
    clientName: "pc-1",
    defaults: {
      transfers: 6,
      chunkSize: "32M",
      bandwidthLimit: "08:00,10M 18:00,off",
      schedule: { mode: "daily", time: "02:00" }
    }
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_GENERATE, {
    reality: { serverName: "www.microsoft.com", privateKey: "***", injected: "drop-me" }
  }), {
    reality: { serverName: "www.microsoft.com", privateKey: "***" }
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, {
    job: {
      schedule: { mode: "interval", intervalMinutes: 30, injected: "drop-me" },
      safety: {
        recoveryRetentionDays: 30,
        deleteLimit: { maxFiles: 100, maxPercent: 10, injected: "drop-me" },
        bidirectional: { initialMode: "newer", injected: "drop-me" },
        injected: { nested: true }
      }
    }
  }), {
    job: {
      schedule: { mode: "interval", intervalMinutes: 30 },
      safety: {
        recoveryRetentionDays: 30,
        deleteLimit: { maxFiles: 100, maxPercent: 10 },
        bidirectional: { initialMode: "newer" }
      }
    }
  });
  assert.deepEqual(parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_PROFILE_ENCODE, {
    uri: "vless://example",
    heartbeat: { scheme: "sfsc-hmac-sha256-v1", secret: "hb-secret", injected: "drop-me" },
    bandwidthLimit: { enabled: true, mode: "fixed", value: 20, unit: "M", injected: "drop-me" },
    defaults: { localProxyPort: 18082, schedule: { mode: "manual", injected: "drop-me" }, injected: true }
  }), {
    uri: "vless://example",
    heartbeat: { scheme: "sfsc-hmac-sha256-v1", secret: "hb-secret" },
    bandwidthLimit: { enabled: true, mode: "fixed", value: 20, unit: "M" },
    defaults: { localProxyPort: 18082, schedule: { mode: "manual" } }
  });

  // Scalar slots must reject smuggled objects/arrays.
  for (const [name, body] of [
    [PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE, { clientName: "pc", defaults: { transfers: { valueOf: 1 } } }],
    [PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE, { clientName: "pc", expiresInHours: [1] }],
    [PROTOCOL_REQUESTS.SERVER_CLAIM_CREATE, { clientName: "pc", defaults: [] }],
    [PROTOCOL_REQUESTS.SERVER_ADMIN_TUNNEL_GENERATE, { publicPort: { port: 443 } }],
    [PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, { job: { transfers: { nested: true } } }],
    [PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, { job: { safety: { deleteLimit: [] } } }],
    [PROTOCOL_REQUESTS.SERVER_JOBS_PREVIEW, { job: { retries: ["3"] } }],
    [PROTOCOL_REQUESTS.SERVER_PROFILE_ENCODE, { uri: "vless://x", bandwidthLimit: [] }],
    [PROTOCOL_REQUESTS.SERVER_PROFILE_ENCODE, { uri: "vless://x", localProxyPort: { port: 18081 } }]
  ]) {
    assert.throws(
      () => parseProtocolRequest(name, body),
      (error) => error.code === "validation_failed",
      `${name} must reject smuggled non-scalar: ${JSON.stringify(body)}`
    );
  }

  // Negative control: device heartbeat nested payloads pass through in
  // arrival form because the heartbeat HMAC signature covers the whole body.
  const heartbeat = parseProtocolRequest(PROTOCOL_REQUESTS.SERVER_DEVICE_HEARTBEAT, {
    clientName: "pc-1",
    sync: { state: "syncing", currentJob: { direction: "upload" } },
    scheduler: { enabled: true, jobs: [{ id: "job-1" }] },
    lastRun: { job: { direction: "upload" } },
    currentJob: { name: "job" },
    lastExit: { ok: true },
    conflicts: { count: 0, files: [] },
    auth: { scheme: "sfsc-hmac-sha256-v1", nonce: "nonce-value", timestamp: "t", signature: "s" }
  });
  assert.deepEqual(heartbeat.sync, { state: "syncing", currentJob: { direction: "upload" } });
  assert.deepEqual(heartbeat.scheduler, { enabled: true, jobs: [{ id: "job-1" }] });
  assert.deepEqual(heartbeat.lastRun, { job: { direction: "upload" } });
  assert.deepEqual(heartbeat.currentJob, { name: "job" });
  assert.deepEqual(heartbeat.lastExit, { ok: true });
  assert.deepEqual(heartbeat.conflicts, { count: 0, files: [] });
  assert.deepEqual(heartbeat.auth, { scheme: "sfsc-hmac-sha256-v1", nonce: "nonce-value", timestamp: "t", signature: "s" });
});

test("shared JSON body reader preserves split UTF-8 and enforces the byte limit", async () => {
  const payload = Buffer.from(JSON.stringify({ clientName: "同步😀电脑" }), "utf8");
  const emoji = Buffer.from("😀", "utf8");
  const emojiOffset = payload.indexOf(emoji);
  const requestFromChunks = (chunks) => ({
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    }
  });

  const parsed = await readJson(requestFromChunks([
    payload.subarray(0, emojiOffset + 1),
    payload.subarray(emojiOffset + 1, emojiOffset + 3),
    payload.subarray(emojiOffset + 3)
  ]));
  assert.deepEqual(parsed, { clientName: "同步😀电脑" });

  await assert.rejects(
    readJson(requestFromChunks([Buffer.alloc(MAX_JSON_BODY_BYTES + 1, 0x20)])),
    (error) => error.code === "request_body_too_large" && error.status === 413
  );
});

test("runtime contracts enforce claim redeem and server heartbeat responses", () => {
  const state = createDefaultAdminState({
    publicServerUrl: "https://pass.971223.xyz:2025"
  });
  const created = createClaim(state, {
    clientName: "contract-pc1",
    server: "https://pass.971223.xyz:2025"
  });
  const redeemed = redeemClaim(state, { tKey: created.token });
  assert.doesNotThrow(() => assertClaimRedeemResponseContract(redeemed, "claimRedeem", {
    expectedClientName: "contract-pc1"
  }));

  const heartbeatUser = recordDeviceHeartbeat(state, signHeartbeatForState(state, {
    clientName: redeemed.clientName,
    profileId: redeemed.profileId,
    clientVersion: "0.3.0-rc.1",
    diagnostics: buildRuntimeDiagnostics({ role: "client", version: "0.3.0-rc.1" }),
    sync: { syncState: "idle" }
  }));
  const device = summarizeDevice(state, heartbeatUser, { includeVlessUri: false });
  const heartbeat = {
    ok: true,
    diagnostics: buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" }),
    device
  };
  assert.doesNotThrow(() => assertServerHeartbeatResponseContract(heartbeat, "serverHeartbeat"));
  const forgedCompatibility = structuredClone(heartbeat);
  forgedCompatibility.device.compatibility = {
    ok: false,
    status: "mismatch",
    action: "none",
    severity: "warning",
    policy: {
      heartbeat: "allow",
      profileIssue: "allow",
      syncRun: "allow",
      adminActions: "allow",
      reason: "none"
    },
    localRole: "server",
    remoteRole: "client",
    issues: [{
      field: "heartbeat",
      type: "remote_older",
      local: 2,
      remote: 1,
      message: "heartbeat protocol mismatch: local v2, remote v1"
    }]
  };
  assert.throws(
    () => assertServerHeartbeatResponseContract(forgedCompatibility, "forgedCompatibility"),
    /forgedCompatibility\.device\.compatibility\.(action|policy)/
  );
  assert.throws(
    () => assertServerHeartbeatResponseContract({
      ...heartbeat,
      diagnostics: {
        ...heartbeat.diagnostics,
        protocols: { ...heartbeat.diagnostics.protocols, heartbeat: "1" }
      }
    }, "stringProtocol"),
    /stringProtocol\.diagnostics\.protocols\.heartbeat/
  );
  assert.throws(
    () => assertClaimRedeemResponseContract({ profile: redeemed }, "claimRedeem"),
    /claimRedeem keys/
  );
  assert.throws(
    () => assertServerHeartbeatResponseContract({ ...heartbeat, extra: true }, "serverHeartbeat"),
    /serverHeartbeat keys/
  );
  assert.throws(
    () => assertServerHeartbeatResponseContract({
      ...heartbeat,
      device: {
        ...heartbeat.device,
        vlessUri: "vless://secret@example.com"
      }
    }, "serverHeartbeat"),
    /vlessUri/
  );
});

test("runtime contracts enforce display-safe client job summaries", () => {
  const job = {
    id: "job-1",
    name: "Folder sync",
    localPath: "D:\\Work",
    direction: "upload",
    remoteFolder: "projects",
    serverSpace: "device",
    transfers: 4,
    streams: 8,
    dryRun: false,
    destructiveSync: false,
    bandwidthLimit: "off",
    schedule: { mode: "interval", intervalMinutes: 30 },
    checkers: 8,
    s3UploadConcurrency: 8,
    s3ChunkSize: "16M",
    cutoff: "16M",
    retries: 3,
    lowLevelRetries: 10,
    localProxyPort: 18081,
    clientName: "pc1",
    remoteName: "home-minio",
    bucketName: "home-sync",
    remotePrefix: "devices/pc1/projects",
    s3Endpoint: "http://minio:9000"
  };

  assert.doesNotThrow(() => assertClientJobSummaryContract(job, "job"));
  assert.doesNotThrow(() => assertClientJobsReadContract({ jobs: [job] }, "jobsRead"));
  const scheduler = {
    enabled: true,
    intervalMs: 15000,
    updatedAt: "2026-07-04T12:00:00.000Z",
    nextRun: null,
    lastTriggeredAt: null,
    lastError: "",
    jobs: [
      {
        id: job.id,
        name: job.name,
        schedule: job.schedule,
        scheduleText: "Every 30 minutes",
        nextRun: "2026-07-04T12:30:00.000Z",
        lastTriggeredAt: null,
        lastError: ""
      }
    ]
  };
  assert.doesNotThrow(() => assertClientJobSaveResponseContract({
    job,
    scheduler
  }, "jobSave"));
  assert.doesNotThrow(() => assertClientSyncHistoryContract({
    history: [
      normalizeSyncRun({
        id: "sync-1",
        status: "success",
        startedAt: "2026-07-04T12:00:00.000Z",
        finishedAt: "2026-07-04T12:01:00.000Z",
        job: {
          name: "Folder sync",
          direction: "upload",
          bucketName: "home-sync",
          remotePrefix: "devices/pc1/projects"
        },
        localPath: "D:\\Work",
        exitCode: 0
      })
    ]
  }, "syncHistory"));
  assert.doesNotThrow(() => assertClientSyncRunResponseContract({
    sync: {
      name: "rclone-sync",
      running: true,
      pid: 1234,
      startedAt: "2026-07-04T12:00:00.000Z",
      lastExit: null
    }
  }, "syncRun"));
  assert.doesNotThrow(() => assertClientSingboxProcessResponseContract({
    singbox: {
      name: "sing-box",
      running: false,
      pid: null,
      startedAt: null,
      lastExit: null
    }
  }, "singboxProcess"));
  assert.doesNotThrow(() => assertClientBinariesCheckContract({
    ok: false,
    singbox: {
      path: "C:\\app\\sing-box.exe",
      exists: false,
      ok: false,
      errorCode: "missing_singbox_binary",
      message: "Missing bundled sing-box",
      version: null
    },
    rclone: {
      path: "C:\\app\\rclone.exe",
      exists: true,
      ok: false,
      errorCode: "binary_version_check_failed",
      message: "Binary version check failed",
      version: {
        executable: "C:\\app\\rclone.exe",
        args: ["version"],
        startedAt: "2026-07-04T12:00:00.000Z",
        finishedAt: "2026-07-04T12:00:01.000Z",
        stdout: "",
        stderr: "bad exe",
        ok: false,
        exitCode: 1
      }
    }
  }, "binariesCheck"));
  const health = {
    ok: true,
    mode: "client-exe-runtime",
    version: "0.3.0-rc.1",
    clientVersion: "0.3.0-rc.1",
    diagnostics: buildRuntimeDiagnostics({ role: "client", version: "0.3.0-rc.1" })
  };
  assert.doesNotThrow(() => assertClientHealthContract(health, "clientHealth"));
  assert.doesNotThrow(() => assertClientShutdownResponseContract({ ok: true }, "clientShutdown"));
  const profileImport = {
    profile: {
      version: 1,
      profileId: "profile-1",
      clientName: "pc1",
      importMode: "offline-profile",
      summary: {
        profileId: "profile-1",
        clientName: "pc1",
        server: "pass.971223.xyz",
        storage: "home-minio/home-sync",
        endpoint: "http://minio:9000",
        localProxyPort: 18081
      },
      tunnel: {
        type: "vless",
        parsed: {
          server: "pass.971223.xyz",
          port: 45678
        }
      },
      heartbeat: {
        scheme: "sfsc-hmac-sha256-v1",
        configured: true
      },
      storage: {
        type: "s3",
        remoteName: "home-minio",
        endpoint: "http://minio:9000",
        bucket: "home-sync",
        prefix: "devices/pc1"
      },
      defaults: {}
    }
  };
  assert.doesNotThrow(() => assertClientProfileImportResponseContract(profileImport, "profileImport"));

  for (const leaked of [
    { secretAccessKey: "secret" },
    { nested: { secretRef: "job:1:secretAccessKey" } },
    { name: "SFSC1-secret" },
    { remotePrefix: "sfsc://import/v1#secret" },
    { localPath: "vless://secret@example.com" }
  ]) {
    assert.throws(
      () => assertClientJobSummaryContract({ ...job, ...leaked }, "job"),
      /leaked|secret/
    );
  }

  assert.throws(
    () => assertClientJobSaveResponseContract({ job }, "jobSave"),
    /scheduler/
  );
  assert.throws(
    () => assertClientJobSaveResponseContract({ job, scheduler, extra: true }, "jobSave"),
    /jobSave keys/
  );
  assert.throws(
    () => assertClientJobSaveResponseContract({ job, scheduler: { ...scheduler, secretAccessKey: "raw-secret" } }, "jobSave"),
    /secretAccessKey/
  );
  assert.throws(
    () => assertClientSyncHistoryContract({ history: "bad" }, "syncHistory"),
    /history/
  );
  const safeSyncRun = normalizeSyncRun({
    id: "sync-safe",
    status: "success",
    startedAt: "2026-07-04T12:00:00.000Z",
    finishedAt: "2026-07-04T12:01:00.000Z",
    job: {
      name: "Folder sync",
      direction: "upload",
      bucketName: "home-sync",
      remotePrefix: "devices/pc1/projects"
    },
    localPath: "D:\\Work",
    exitCode: 0
  });
  assert.throws(
    () => assertClientSyncHistoryContract({ history: [], extra: true }, "syncHistory"),
    /syncHistory keys/
  );
  assert.throws(
    () => assertClientSyncHistoryContract({ history: [{ ...safeSyncRun, secretAccessKey: "raw-secret" }] }, "syncHistory"),
    /keys/
  );
  assert.throws(
    () => assertClientSyncHistoryContract({ history: [{ ...safeSyncRun, debug: { tKey: "SFSC1-secret" } }] }, "syncHistory"),
    /keys/
  );
  assert.throws(
    () => assertClientSyncHistoryContract({ history: [{ ...safeSyncRun, errorCode: "rclone_sync_failed" }] }, "syncHistory"),
    /errorCode/
  );
  assert.throws(
    () => assertClientSyncRunResponseContract({ sync: { name: "sing-box", running: false, pid: null, startedAt: null, lastExit: null } }, "syncRun"),
    /sync\.name/
  );
  assert.throws(
    () => assertClientSyncRunResponseContract({ sync: { name: "rclone-sync", running: false, pid: null, startedAt: null, lastExit: null, extra: true } }, "syncRun"),
    /syncRun\.sync unexpected key extra/
  );
  assert.throws(
    () => assertClientSingboxProcessResponseContract({ singbox: { name: "rclone-sync", running: false, pid: null, startedAt: null, lastExit: null } }, "singboxProcess"),
    /singbox\.name/
  );
  assert.throws(
    () => assertClientSingboxProcessResponseContract({ singbox: { name: "sing-box", running: false, pid: null, startedAt: null, lastExit: null }, sync: {} }, "singboxProcess"),
    /singboxProcess keys/
  );
  assert.throws(
    () => assertClientBinariesCheckContract({
      ok: false,
      singbox: { path: "x", exists: false, ok: false, errorCode: "missing_singbox_binary", message: "missing" },
      rclone: { path: "x", exists: false, ok: false, errorCode: "missing_rclone_binary", message: "missing", version: null }
    }, "binariesCheck"),
    /binariesCheck\.singbox keys/
  );
  assert.throws(
    () => assertClientHealthContract({ ...health, paths: {} }, "clientHealth"),
    /clientHealth keys/
  );
  assert.throws(
    () => assertClientShutdownResponseContract({ ok: true, status: "closing" }, "clientShutdown"),
    /clientShutdown keys/
  );
  assert.throws(
    () => assertClientShutdownResponseContract({ ok: false }, "clientShutdown"),
    /clientShutdown\.ok/
  );
  assert.throws(
    () => assertClientProfileImportResponseContract({ profile: null }, "profileImport"),
    /profileImport\.profile/
  );
  assert.throws(
    () => assertClientProfileImportResponseContract({ ...profileImport, extra: true }, "profileImport"),
    /profileImport keys/
  );
  assert.throws(
    () => assertClientSyncRunResponseContract({ sync: { name: "rclone-sync", running: false, pid: null, startedAt: null, lastExit: null }, extra: true }, "syncRun"),
    /syncRun keys/
  );
  assert.throws(
    () => assertClientSyncRunResponseContract({
      sync: {
        name: "rclone-sync",
        running: false,
        pid: null,
        startedAt: null,
        lastExit: {
          ok: false,
          errorCode: "rclone_sync_failed",
          error: "SFSC1-secret",
          at: "2026-07-04T12:00:00.000Z"
        }
      }
    }, "syncRun"),
    /SyncKey/
  );
});

test("interface contract documents client status health and diagnostic fields", async () => {
  const [contract, design, matrix, clientServer, clientHttp] = await Promise.all([
    readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8"),
    readFile(join(projectRoot, "docs", "SOFTWARE_DESIGN_SPEC.md"), "utf8"),
    readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8"),
    readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8"),
    readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8")
  ]);

  assert.match(contract, /GET \/api\/health` 是客户端本地轻量探活/);
  assert.match(contract, /不得只看 `\/api\/health` 的 HTTP 200/);
  assert.match(contract, /HTTP 200 但不是 client health response contract/);
  assert.match(contract, /不得返回 `paths`、`profileSummary`、`jobs`、`safeguards`/);
  assert.match(design, /轻量 `GET \/api\/health`/);
  assert.match(design, /不读取完整本地状态、profile、任务或密钥库/);
  assert.match(design, /客户端 `\/api\/health` 仅用于本机 readiness 和版本\/协议探活/);
  assert.match(design, /不得返回 paths、profile、jobs、safeguards 或密钥派生字段/);
  assert.match(design, /GET \/api\/profile/);
  assert.match(design, /GET \/api\/jobs/);
  assert.match(design, /GET \/api\/sync\/history/);
  assert.match(design, /POST \/api\/sync\/preview/);
  assert.match(design, /GET \/api\/diagnostics\/export/);
  assert.match(matrix, /\| GET \| `\/api\/health` \| 启动器、smoke、运维探活 \| 客户端本地健康、版本和协议诊断 \|/);
  assert.match(matrix, /\| GET \| `\/api\/client\/status` \| 客户端 UI、smoke \| 本机状态、profile、任务、心跳、诊断、发布 manifest \|/);
  assert.match(contract, /GET \/api\/client\/status/);
  assert.match(contract, /`ok: true`/);
  assert.match(contract, /`mode: "client-exe-runtime"`/);
  assert.match(contract, /`paths`/);
  assert.match(contract, /`root`/);
  assert.match(contract, /`binRoot`/);
  assert.match(contract, /`dataRoot`/);
  assert.match(contract, /`releaseManifest`/);
  assert.match(contract, /`supportDocuments`/);
  assert.match(contract, /`INTERFACE_CONTRACT`/);
  assert.match(contract, /`API_MATRIX`/);
  assert.match(contract, /`valid` 要求该 manifest 条目的 `size > 0`/);
  assert.match(contract, /`sha256` 是 64 位小写十六进制/);
  assert.match(contract, /releaseManifestSupportDocsMissing` 应列出缺失或无效的支持文档名称/);
  assert.match(contract, /合同文档登记状态/);
  assert.match(contract, /UI 必须直接提示缺少的合同文档名称/);
  assert.match(contract, /`binaries`/);
  assert.match(contract, /`binary_version_check_failed` \| 503 \| 客户端组件存在但版本命令无法成功运行/);
  assert.match(contract, /响应顶层必须且只包含 `ok`、`singbox` 和 `rclone`/);
  assert.match(clientServer, /ok: Boolean\(singbox\.ok && rclone\.ok\)/);
  assert.match(clientHttp, /missingBinaryCheckPayload\.ok, false/);
  assert.match(clientHttp, /placeholderBinaryCheckPayload\.ok, false/);
  assert.match(contract, /POST \/api\/singbox\/start` 启动本地 sing-box 代理/);
  assert.match(contract, /缺少 `sing-box\.exe` 时返回 `503 missing_singbox_binary`/);
  assert.match(contract, /尚未导入 profile 或 profile 缺少可用 tunnel URI 时返回 `409 profile_not_imported`/);
  assert.match(contract, /若 sing-box 已经运行，该接口必须幂等返回当前进程状态/);
  assert.match(contract, /不得写入同步历史，不得修改 profile、jobs、secret vault 或 scheduler 状态/);
  assert.match(clientServer, /if \(!await fileExists\(paths\.singboxExe\)\)/);
  assert.match(clientServer, /throw missingBinaryError\("sing-box", paths\.singboxExe, "missing_singbox_binary"\)/);
  assert.match(clientServer, /throw createHttpError\("profile_not_imported", 409/);
  assert.match(clientHttp, /assertHttpErrorResponseContract\(startWithoutSingboxPayload, "startWithoutSingbox"/);
  assert.match(clientHttp, /assertHttpErrorResponseContract\(startWithoutProfilePayload, "startWithoutProfile"/);
  assert.match(contract, /`scheduler`/);
  assert.match(contract, /`scheduler\.enabled` 必须是布尔值/);
  assert.match(contract, /`scheduler\.intervalMs` 必须是非负整数/);
  assert.match(contract, /`scheduler\.updatedAt`、`scheduler\.nextRun` 和 `scheduler\.lastTriggeredAt` 必须为 `null` 或字符串/);
  assert.match(contract, /`scheduler\.lastError` 和 `scheduler\.jobs\[\]\.lastError` 必须为空字符串或稳定 snake_case 错误码/);
  assert.match(contract, /`processes\.singbox`/);
  assert.match(contract, /`processes\.sync`/);
  assert.match(contract, /`processes\.singbox\.name` 必须为 `sing-box`/);
  assert.match(contract, /`processes\.sync\.name` 必须为 `rclone-sync`/);
  assert.match(contract, /`processes\.sync\.metrics\.syncState` 必须为 `idle`、`syncing`、`error`、`stopping` 或 `offline`/);
  assert.match(contract, /客户端页面顶部状态、body 状态 class、进度区和停止中样式必须以 `processes\.sync\.metrics\.syncState` 为当前状态来源/);
  assert.match(contract, /`processes\.sync\.running` 只能辅助判断同步中，不能覆盖 `stopping` 或 `error`/);
  assert.match(contract, /`syncHistory`/);
  assert.match(contract, /`lastSync`/);
  assert.match(contract, /`safeguards\.secretVault`/);
  assert.match(contract, /`safeguards\.localState`/);
  assert.match(contract, /`safeguards\.tun`、`safeguards\.systemProxy`、`safeguards\.routeMutation` 和 `safeguards\.dnsMutation` 必须固定为 `false`/);
  assert.match(contract, /`safeguards\.rcloneConfigScope` 必须是指向 app-scoped `rclone\.conf` 的非空字符串/);
  assert.match(contract, /`profileImported` 必须是布尔值/);
  assert.match(contract, /未导入 profile 时 `profileSummary` 必须为 `null`/);
  assert.match(contract, /协议版本必须与 `GET \/api\/client\/status\.diagnostics\.protocols` 完全一致/);
  assert.match(contract, /客户端 smoke 应输出 `protocols=aligned`/);
  assert.match(contract, /本机协议漂移失败/);
  assert.match(contract, /缺失引用/);
  assert.match(contract, /local state\/vault 健康/);
  assert.match(contract, /`\/api\/profile\/import`、`\/api\/jobs\/save` 和 `\/api\/sync\/run`/);
  assert.match(contract, /不得在损坏的状态文件上继续写入或覆盖既有 profile\/jobs\/secrets\/sync-history/);
  assert.match(clientServer, /url\.pathname === "\/api\/health"/);
  assert.match(clientServer, /function buildHealth/);
  assert.match(clientServer, /http\.get\(`\$\{clientUrl\(\)\}api\/health`/);
  assert.match(clientServer, /function isSfscClientHealth/);
  assert.match(clientServer, /payload\?\.mode === "client-exe-runtime"/);
  assert.match(clientServer, /payload\?\.diagnostics\?\.role === "client"/);
  assert.match(clientHttp, /healthPayload\.diagnostics\.role, "client"/);
  assert.match(clientHttp, /healthPayload\.paths, undefined/);
  assert.match(clientHttp, /client runtime refuses occupied port unless health belongs to SFSC client/);
});

test("interface contract documents profile import and job save contracts", async () => {
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
  const matrix = await readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8");
  const tKeyProtocol = await readFile(join(projectRoot, "docs", "T_KEY_PROTOCOL.md"), "utf8");
  const clientDesign = await readFile(join(projectRoot, "docs", "client-design.md"), "utf8");

  assert.match(contract, /POST \/api\/profile\/import/);
  assert.match(contract, /`claimCode`/);
  assert.match(contract, /`claim_redeem_failed`/);
  assert.match(contract, /`400 profile_storage_required`/);
  assert.match(contract, /POST \/api\/profile\/import[\s\S]*?- `404 claim_not_found`[\s\S]*?### 保存同步任务/);
  assert.match(contract, /POST \/api\/profile\/import[\s\S]*?- `409 local_state_corrupt`[\s\S]*?### 保存同步任务/);
  assert.match(contract, /POST \/api\/profile\/import[\s\S]*?- `410 claim_expired`[\s\S]*?### 保存同步任务/);
  assert.match(contract, /`\/api\/claims\/create` 响应中的 `code` 是 `AAAA-AAAA` 短码/);
  assert.match(contract, /客户端本地 `\/api\/profile\/import` 直接收到该短码时必须返回 `400 import_code_invalid`/);
  assert.match(matrix, /短码直传返回 `import_code_invalid` 且不消耗 SyncKey/);
  for (const expected of [
    /短时绑定重放/,
    /pending recovery stash/,
    /同一客户端绑定/,
    /不同客户端/,
    /`clientRedeemId`/,
    /`clientInstallId`/,
    /`claim-recovery\.json`/,
    /`claim_already_used`/,
    /不得保存一次性短码/,
    /导入未完成/
  ]) {
    assert.match(contract, expected);
  }
  assert.match(contract, /字符集为 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`/);
  assert.match(contract, /不得包含易混字符 `0`、`1`、`I` 或 `O`/);
  assert.match(contract, /兑换解析可以继续接受历史 `\[A-Z0-9\]\{4\}-\[A-Z0-9\]\{4\}` 短码/);
  assert.match(contract, /客户端本地运行时请求远端 `\/api\/claims\/redeem` 必须设置超时/);
  assert.match(contract, /默认 15 秒/);
  assert.match(contract, /`SFSC_CLAIM_REDEEM_TIMEOUT_MS`/);
  assert.match(contract, /远端仅返回未登记的 `error` \/ `errorCode`/);
  assert.match(contract, /同时保留已收到的远端 HTTP status/);
  assert.match(contract, /没有得到 HTTP 响应[\s\S]*?`502 claim_redeem_failed`/);
  assert.match(contract, /远端 HTTP 2xx 但响应不是 JSON、不是对象、返回 `ok:false`/);
  assert.match(contract, /保留 pending recovery stash/);
  assert.match(contract, /服务端在首次兑换和短时绑定重放返回 profile 前，必须重新校验/);
  assert.match(contract, /不得设置 `claim\.used`、`redeemedAt`、`redeemedBy` 或 `replayUntil`/);
  assert.match(contract, /终态错误 `claim_not_found`、`claim_already_used`、`claim_expired` 或 `validation_failed`/);
  assert.match(contract, /`claim_redeem_rate_limited`、`server_state_write_failed`、本地降级为 `claim_redeem_failed`/);
  assert.match(contract, /远端成功后本地校验发现服务端签发 profile 缺少必要材料/);
  assert.match(contract, /`profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required`/);
  assert.match(contract, /应检查服务端配置后重新生成 SyncKey/);
  assert.match(contract, /`server_state_write_failed`、本地降级为 `claim_redeem_failed`/);
  assert.match(contract, /`profile\.storage\.secretAccessKey`/);
  assert.match(contract, /`secretRef`/);
  assert.match(contract, /原密钥字段中保存引用对象/);
  assert.match(contract, /`profile\.storage\.secretAccessKey: \{ "secretRef": "profile:\.\.\.:storage\.secretAccessKey" \}`/);
  assert.match(contract, /`job\.secretAccessKey: \{ "secretRef": "job:\.\.\.:secretAccessKey:\.\.\." \}`/);
  assert.match(contract, /Job 密钥引用必须是不可变引用/);
  assert.match(contract, /`readProfile\(\)` \/ `readJobs\(\)` 对运行时返回水合后的完整对象/);
  assert.match(contract, /`GET \/api\/profile` 返回本地已导入 profile 的展示安全摘要/);
  assert.match(contract, /不得包含原始 `tunnel\.uri`、`storage\.accessKeyId`、`storage\.secretAccessKey`、`heartbeat\.secret`/);
  assert.match(contract, /本地 HTTP `GET \/api\/jobs` 和 `POST \/api\/jobs\/save` 响应只返回展示安全 job 摘要/);
  assert.match(contract, /不得返回水合密钥/);
  assert.match(contract, /调试\/兼容入口也必须使用通用结构化错误响应/);
  assert.match(contract, /`400 invalid_vless_uri`/);
  assert.match(contract, /`400 profile_tunnel_required`/);
  assert.match(contract, /`POST \/api\/profile\/encode` 用于把服务端签发的完整离线 profile 编码为导入码/);
  assert.match(contract, /`profile\.heartbeat\.scheme: "sfsc-hmac-sha256-v1"`/);
  assert.match(contract, /非空 `profile\.heartbeat\.secret`/);
  assert.match(contract, /完整 S3 存储字段 `storage\.remoteName`、`storage\.endpoint`、`storage\.bucket`、`storage\.accessKeyId`、`storage\.secretAccessKey` 和 `storage\.prefix`/);
  assert.match(contract, /缺少存储凭据或必要存储字段必须返回 `400 profile_storage_required`/);
  assert.match(contract, /`code` \/ `uri` 解码后必须保留同一份心跳密钥/);
  assert.match(matrix, /编码包含 heartbeat 和 storage credentials 的完整 profile 导入码/);
  assert.match(contract, /控制台调试 JSON 不得直接展示完整 SyncKey/);
  assert.match(contract, /legacy `claimCode` \/ `token`/);
  assert.match(contract, /VLESS URI/);
  assert.match(contract, /DNS、连接拒绝、超时等网络异常/);
  assert.match(contract, /只有服务端成功持久化兑换状态后，才算消耗该 SyncKey/);
  assert.match(contract, /该 SyncKey 不得被视为已消耗/);
  assert.match(contract, /SyncKey 创建只有在服务端成功持久化 claim 和设备状态后才算发布/);
  assert.match(contract, /不得显示或复制一个尚未持久化的“幽灵 SyncKey”/);
  assert.match(contract, /`500 server_state_write_failed`/);
  assert.match(contract, /POST \/api\/jobs\/save/);
  assert.match(contract, /POST \/api\/jobs\/save[\s\S]*?- `400 danger_confirmation_required`[\s\S]*?### 同步预览/);
  assert.match(contract, /`buildJobFromProfile\(\)`/);
  assert.match(contract, /`direction: "bidirectional"`/);
  assert.match(contract, /`destructiveSync`/);
  assert.match(contract, /`job\.secretAccessKey: \{ "secretRef": "job:\.\.\.:secretAccessKey:\.\.\." \}`/);
  assert.match(contract, /"secretRef": "job:\.\.\.:secretAccessKey:\.\.\."/);
  assert.match(contract, /`GET \/api\/jobs` 返回本地已保存任务的展示安全摘要列表/);
  assert.match(contract, /不得包含 `accessKeyId`、`secretAccessKey`、`s3SecretAccessKey`/);
  assert.match(contract, /`local_state_corrupt`/);
  assert.match(contract, /`secret_vault_missing`/);
  assert.match(contract, /\/api\/profile\/import`、`\/api\/jobs\/save` 和 `\/api\/sync\/run/);
  assert.match(contract, /profile\/jobs\/secrets\/sync-history/);
  assert.match(matrix, /`SFSC_CLAIM_REDEEM_TIMEOUT_MS`/);
  assert.match(matrix, /远端成功但签发 profile 缺少 heartbeat\/storage\/tunnel 材料返回 `profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required` 并清理 recovery/);
  assert.match(matrix, /客户端导入后必须补齐 source\.server/);
  assert.match(matrix, /heartbeat、storage credentials 或 tunnel/);
  assert.match(matrix, /远端非结构化失败、未登记错误码、超时，或 HTTP 2xx 但响应不是 JSON\/profile 对象、返回 `ok:false` 时使用 `claim_redeem_failed`/);
  assert.match(matrix, /收到远端 HTTP 响应时保留 status，无 HTTP 响应使用 502/);
  assert.match(matrix, /远端 HTTP 2xx 但响应不是 JSON\/profile 对象或返回 `ok:false` 也降级为 `claim_redeem_failed` 并保留 recovery/);
  assert.match(matrix, /兑换前必须重新校验 claim 指向的设备和 bucket 仍未删除、未停用/);
  assert.match(matrix, /失效时返回 `validation_failed` 且不得消耗 SyncKey/);
  assert.match(matrix, /远端终态错误 `claim_not_found`、`claim_already_used`、`claim_expired`、`validation_failed` 清理 pending recovery stash/);
  assert.match(matrix, /`claim_redeem_rate_limited`、`server_state_write_failed`、`claim_redeem_failed` 和本地提交失败保留 recovery/);
  assert.match(matrix, /同一客户端绑定/);
  assert.match(matrix, /不同客户端/);
  assert.match(matrix, /`clientRedeemId`/);
  assert.match(matrix, /`clientInstallId`/);
  assert.match(matrix, /`claim-recovery\.json`/);
  assert.match(matrix, /导入未完成/);
  assert.match(matrix, /读取本地 profile 的展示安全摘要/);
  assert.match(matrix, /响应展示安全 profile 摘要/);
  assert.match(clientDesign, /Remote SyncKey redemption requests use a default 15 second timeout/);
  assert.match(clientDesign, /missing server-issued storage credentials use `profile_storage_required`/);
  assert.match(clientDesign, /SFSC_CLAIM_REDEEM_TIMEOUT_MS/);
  assert.match(clientDesign, /timed-out, and malformed successful responses become `claim_redeem_failed`/);
  assert.match(clientDesign, /HTTP 2xx responses that are not JSON/);
  assert.match(clientDesign, /UI wrapper call to `\/api\/profile\/import` uses a 60 second timeout/);
  assert.match(clientDesign, /GET \/api\/profile/);
  assert.match(clientDesign, /raw VLESS URIs/);
  assert.match(tKeyProtocol, /pending recovery stash/);
  assert.match(tKeyProtocol, /`profile_storage_required`/);
  assert.match(tKeyProtocol, /`CHANGE_ME_CLIENT_SECRET`/);
  assert.match(tKeyProtocol, /`claim-recovery\.json`/);
  assert.match(tKeyProtocol, /不得保存一次性短码/);
  assert.match(tKeyProtocol, /导入未完成/);
  assert.match(tKeyProtocol, /服务端兑换前必须重新校验 claim 指向的设备和 bucket 仍未删除、未停用/);
  assert.match(tKeyProtocol, /服务端返回 `validation_failed` 且不得把 SyncKey 标记为 used/);
  assert.match(tKeyProtocol, /收到远端 HTTP 响应时保留 status，无 HTTP 响应使用 502/);
  assert.match(tKeyProtocol, /HTTP 2xx 但不是 JSON\/profile 对象、返回 `ok:false` 的坏成功响应统一降级为 `claim_redeem_failed`/);
  assert.match(tKeyProtocol, /坏成功响应统一使用 `claim_redeem_failed`/);
  assert.match(tKeyProtocol, /终态结构化错误 `claim_not_found`、`claim_already_used`、`claim_expired` 或 `validation_failed`/);
  assert.match(tKeyProtocol, /远端返回 `claim_redeem_rate_limited`/);
  assert.match(tKeyProtocol, /`profile_heartbeat_required`、`profile_storage_required` 或 `profile_tunnel_required`/);
  assert.match(tKeyProtocol, /清理 pending recovery stash/);
});

test("interface contract documents sync preview and run execution contracts", async () => {
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");

  assert.match(contract, /POST \/api\/sync\/preview/);
  assert.match(contract, /POST \/api\/jobs\/save/);
  assert.match(contract, /confirmCompatibilityWarning: true/);
  assert.match(contract, /confirmDestructiveSync: true/);
  assert.match(contract, /400 danger_confirmation_required/);
  assert.match(contract, /`POST \/api\/sync\/preview` 是只读预览，不要求这些确认/);
  assert.match(contract, /`503 missing_rclone_binary`/);
  assert.match(contract, /`rclone\.args`/);
  assert.match(contract, /`rclone\.remoteConfig\.args`/);
  assert.match(contract, /`displayCommand`/);
  assert.match(contract, /`remoteConfig\.displayCommand`/);
  assert.match(contract, /sync preview contract/);
  assert.match(contract, /不得启动 sing-box/);
  assert.match(contract, /不得写同步历史/);
  assert.match(contract, /`bisync`/);
  assert.match(contract, /`safety\.deleteProtection`/);
  assert.match(contract, /POST \/api\/sync\/run/);
  assert.match(contract, /POST \/api\/sync\/run[\s\S]*?- `400 danger_confirmation_required`[\s\S]*?### 停止同步/);
  assert.match(contract, /本地 JSON 状态可写/);
  assert.match(contract, /`409 local_state_corrupt`/);
  assert.match(contract, /app-scoped rclone config/);
  assert.match(contract, /启动前失败/);
  assert.match(contract, /不得写入同步历史/);
  assert.match(contract, /`500 rclone_config_failed`/);
  assert.match(contract, /rclone config 写入成功后，若 sing-box 尚未运行，才自动启动本地 sing-box/);
  assert.match(contract, /不得启动 rclone sync，若 sing-box 原本未运行也不得留下新启动的 sing-box 进程/);
  assert.match(contract, /`processes\.sync\.metrics\.syncState` 必须保持 `idle`/);
  assert.match(contract, /错误 message 中的 stdout\/stderr\/detail 必须脱敏/);
  assert.match(contract, /`status: "running"`/);
  assert.match(contract, /`rclone_sync_failed`/);
  assert.match(contract, /`status: "stopped"`/);
  assert.match(contract, /服务端控制台设备列表的“同步中 \/ 空闲 \/ 出错”筛选必须使用当前 `device\.sync\.state` \/ `device\.syncState`/);
  assert.match(contract, /不得用 `sync\.lastRun\.status` 替代当前同步状态/);
  assert.match(contract, /只返回该合同登记的展示安全字段/);
  assert.match(contract, /未知扩展字段、`lastExit` 运行细节、`secretAccessKey`、SyncKey、导入 URI、VLESS URI、profile 或调试对象不得透传/);
  assert.match(contract, /只有 `status: "error"` 可以携带非空 `errorCode` 和 `error`/);
  assert.match(contract, /非法的远端路径字段不得导致心跳接口整体失败/);
  assert.match(contract, /服务端应清空非法路径字段/);
  assert.match(contract, /继续规范化 `syncState`、进度、速度、最近运行摘要/);
  assert.match(contract, /`scheduler\.lastError` 以及 `jobs\[\]\.lastError` 必须只保存稳定 snake_case 错误码/);
  assert.match(contract, /不能上传英文异常文本/);
  assert.match(contract, /只有在成功持久化心跳状态后/);
  assert.match(contract, /不得显示一个尚未持久化的“假在线”状态/);
});

test("interface contract documents sync stop and logs contracts", async () => {
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
  const processRunner = await readFile(join(projectRoot, "client", "src", "processRunner.js"), "utf8");

  assert.match(contract, /POST \/api\/sync\/stop/);
  assert.match(contract, /`processes\.sync\.metrics\.syncState`/);
  assert.match(contract, /`stopping`/);
  assert.match(contract, /`stopped` 记录不得在顶层或嵌套字段中暴露 `rclone_sync_failed`/);
  assert.match(contract, /幂等操作/);
  assert.match(contract, /GET \/api\/logs/);
  assert.match(contract, /"singbox": "recent sing-box log text"/);
  assert.match(contract, /"rclone": "recent rclone log text"/);
  assert.match(contract, /最近 20000 字符/);
  assert.match(contract, /日志文件不存在时对应字段返回空字符串/);
  assert.match(contract, /`bundle\.logs\.\*`/);
  assert.match(contract, /递归脱敏密钥、token、SyncKey、VLESS URI/);
  assert.match(processRunner, /SFSC1-\[A-Za-z0-9_-\]\+/);
  assert.match(processRunner, /sfsc:\\\/\\\/import\\\/v1#/);
  assert.match(processRunner, /vless:\\\/\\\//);
});

test("interface contract documents bucket dangerous operation guards", async () => {
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
  const design = await readFile(join(projectRoot, "docs", "SOFTWARE_DESIGN_SPEC.md"), "utf8");
  const server = await readFile(join(projectRoot, "src", "server.js"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");

  assert.match(contract, /POST \/api\/admin\/storage\/buckets\/clear/);
  assert.match(contract, /POST \/api\/admin\/storage\/buckets\/delete-empty/);
  assert.match(design, /POST \/api\/admin\/storage\/save/);
  assert.match(design, /POST \/api\/admin\/storage\/buckets\/refresh/);
  assert.match(design, /`enable`、`disable`、`clear`、`delete-empty`/);
  assert.match(contract, /`storage\/buckets\/refresh`/);
  assert.match(contract, /响应必须包含 `ok: false`、`errorCode: "storage_request_failed"`、`warning`/);
  assert.match(contract, /`storage\/buckets\/create` 登记同步仓库/);
  assert.match(contract, /`provision` 必须包含 `ok: false`、`errorCode: "storage_request_failed"` 和 `warning`/);
  assert.match(design, /provision\.errorCode: "storage_request_failed"/);
  assert.match(server, /errorCode: "storage_request_failed"/);
  assert.match(app, /errorCode: result\.errorCode \|\| ""/);
  assert.match(app, /result\.provision\?\.ok === false/);
  assert.match(app, /formatBucketProvisionWarning/);
  assert.match(app, /已登记，但远端 MinIO\/S3 创建未确认/);
  assert.match(contract, /`confirmBucket`/);
  assert.match(contract, /`danger_confirmation_required`/);
  assert.match(contract, /`bucket_not_found` \/ `bucket_disabled`/);
  assert.match(contract, /已停用 bucket 不得继续触碰 MinIO/);
  assert.match(contract, /`last_bucket_delete_blocked`/);
  assert.match(contract, /`last_active_bucket_disable_blocked`/);
});

test("interface contract documents server admin state corruption guards", async () => {
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
  const design = await readFile(join(projectRoot, "docs", "SOFTWARE_DESIGN_SPEC.md"), "utf8");
  const deployment = await readFile(join(projectRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), "utf8");
  const server = await readFile(join(projectRoot, "src", "server.js"), "utf8");
  const stateLock = await readFile(join(projectRoot, "src", "core", "serverStateLock.js"), "utf8");

  assert.match(contract, /`server_state_corrupt` \| 500 \| 服务端 `sfsc-state\.json` 损坏/);
  assert.match(contract, /`server_state_locked` \| 409 \| 服务端数据目录已有写入者持有 `sfsc-state\.lock`/);
  assert.match(contract, /`server_state_write_failed` \| 500 \| 服务端 `sfsc-state\.json` 写入失败/);
  assert.match(contract, /`SERVER_DATA_ROOT\/sfsc-state\.lock`/);
  assert.match(contract, /`409 server_state_locked`/);
  assert.match(contract, /同一个 `SERVER_DATA_ROOT` 在任意时刻只能有一个 sync-server 写入者/);
  assert.match(contract, /`instanceId`、PID、`processStartedAt` 和 `heartbeatAt`/);
  assert.match(contract, /心跳超过陈旧阈值后自动接管/);
  assert.match(contract, /确认没有活动 sync-server 进程后手工清理/);
  assert.match(contract, /文件存在但不是合法 JSON 时必须失败并报告 `server_state_corrupt`/);
  assert.match(contract, /不得用默认状态覆盖原文件/);
  assert.match(contract, /临时文件和原子 rename/);
  assert.match(contract, /若状态文件写入失败，接口必须返回 `500 server_state_write_failed`/);
  assert.match(design, /`sfsc-state\.json` 存在但损坏时必须失败并保留原文件/);
  assert.match(design, /`SERVER_DATA_ROOT\/sfsc-state\.lock`/);
  assert.match(design, /`processStartedAt` 识别旧进程/);
  assert.match(design, /心跳超时后接管/);
  assert.match(design, /写入失败返回 `server_state_write_failed`/);
  assert.match(deployment, /## 3\. 服务端状态恢复/);
  assert.match(deployment, /`server_state_corrupt`/);
  assert.match(deployment, /不得覆盖为默认状态/);
  assert.match(deployment, /`server_state_locked`/);
  assert.match(deployment, /`processStartedAt`/);
  assert.match(deployment, /心跳超时后才会自动接管/);
  assert.match(deployment, /确认没有活动进程/);
  assert.match(deployment, /`server_state_write_failed`/);
  assert.match(deployment, /重试 SyncKey 创建、兑换或心跳/);
  assert.match(deployment, /`server_singbox_config_write_failed`/);
  assert.match(deployment, /`SINGBOX_CONFIG_PATH`/);
  assert.match(server, /createHttpError\("server_state_corrupt"/);
  assert.match(stateLock, /createHttpError\("server_state_locked"/);
  assert.match(stateLock, /lockPath/);
  assert.match(stateLock, /isServerStateLockOwnerStale/);
  assert.match(stateLock, /heartbeatAt/);
  assert.match(stateLock, /processStartedAt/);
  assert.match(stateLock, /createHttpError\("server_state_write_failed"/);
  assert.match(server, /async function writeJsonFileAtomic/);
  assert.match(server, /await rename\(tempFile, file\)/);
  assert.match(contract, /必须串行执行从内存修改到持久化完成的整个写事务/);
  assert.match(server, /let adminStateWriteQueue = Promise\.resolve\(\)/);
  assert.match(server, /function shouldSerializeAdminStateWrite\(req, url\)/);
  assert.match(server, /async function acquireAdminStateWriteLock\(\)/);
  assert.match(server, /releaseAdminStateWriteLock\(\)/);
  assert.match(server, /process\.exit\(1\)/);
});

test("interface contract documents sing-box config write guards", async () => {
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
  const design = await readFile(join(projectRoot, "docs", "SOFTWARE_DESIGN_SPEC.md"), "utf8");
  const server = await readFile(join(projectRoot, "src", "server.js"), "utf8");

  assert.match(contract, /POST \/api\/admin\/tunnel\/generate/);
  assert.match(design, /GET \/api\/admin\/singbox\/config/);
  assert.match(design, /POST \/api\/admin\/singbox\/write/);
  assert.match(design, /POST \/api\/admin\/singbox\/mark-applied/);
  assert.match(design, /POST \/api\/vless\/parse/);
  assert.match(design, /POST \/api\/jobs\/preview/);
  assert.match(contract, /POST \/api\/admin\/singbox\/write/);
  assert.match(contract, /`confirmWriteSingbox`/);
  assert.match(contract, /`500 server_singbox_config_write_failed`/);
  assert.match(contract, /回滚本次请求对内存中 `adminState` 的修改/);
  assert.match(contract, /不得让 `\/api\/admin\/state` 显示一个尚未成功写入配置文件/);
  assert.match(design, /server_singbox_config_write_failed/);
  assert.match(server, /function shouldRollbackAdminStateOnError/);
  assert.match(server, /adminState = adminStateSnapshot/);
  assert.match(contract, /POST \/api\/admin\/singbox\/mark-applied/);
  assert.match(contract, /`confirmMarkApplied`/);
  assert.match(contract, /`400 danger_confirmation_required`/);
  assert.match(contract, /配置文件已更新，不表示 sing-box 进程已加载/);
});

test("runtime diagnostics expose app and protocol versions", () => {
  const diagnostics = buildRuntimeDiagnostics({
    role: "server",
    version: "0.3.0-rc.1-test",
    buildId: "build-123",
    buildTime: "2026-07-04T00:00:00.000Z"
  });

  assert.equal(diagnostics.app, "singbox-folder-sync");
  assert.equal(diagnostics.role, "server");
  assert.equal(diagnostics.version, "0.3.0-rc.1-test");
  assert.equal(diagnostics.buildId, "build-123");
  assert.equal(diagnostics.buildTime, "2026-07-04T00:00:00.000Z");
  assert.deepEqual(diagnostics.protocols, {
    claim: 1,
    profile: 1,
    adminState: 1,
    clientStatus: 1,
    heartbeat: 1
  });
});

test("runtime diagnostics compare protocol compatibility", () => {
  const server = buildRuntimeDiagnostics({ role: "server", version: "1.0.0" });
  const client = buildRuntimeDiagnostics({ role: "client", version: "1.0.0" });
  assert.deepEqual(compareRuntimeDiagnostics(server, client), {
    ok: true,
    status: "compatible",
    action: "none",
    severity: "ok",
    policy: {
      heartbeat: "allow",
      profileIssue: "allow",
      syncRun: "allow",
      adminActions: "allow",
      reason: "none"
    },
    localRole: "server",
    remoteRole: "client",
    issues: []
  });

  const olderClient = {
    ...client,
    protocols: {
      ...client.protocols,
      heartbeat: 0
    }
  };
  const mismatch = compareRuntimeDiagnostics(server, olderClient);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.action, "diagnostics_missing");
  assert.equal(mismatch.severity, "warning");
  assert.deepEqual(mismatch.policy, {
    heartbeat: "allow",
    profileIssue: "warn",
    syncRun: "warn",
    adminActions: "allow",
    reason: "diagnostics_missing"
  });
  assert.equal(mismatch.issues[0].field, "heartbeat");
  assert.equal(mismatch.issues[0].type, "remote_missing");
  assert.equal(mismatch.issues[0].local, 1);

  const newerClient = {
    ...client,
    protocols: {
      ...client.protocols,
      heartbeat: 2
    }
  };
  const serverTooOld = compareRuntimeDiagnostics(server, newerClient);
  assert.equal(serverTooOld.action, "upgrade_local");
  assert.equal(serverTooOld.issues[0].type, "remote_newer");

  const olderProtocolClient = {
    ...client,
    protocols: {
      ...client.protocols,
      heartbeat: 0,
      clientStatus: 0
    }
  };
  const missingDiagnostics = compareRuntimeDiagnostics(server, olderProtocolClient);
  assert.equal(missingDiagnostics.action, "diagnostics_missing");
  assert.deepEqual(new Set(missingDiagnostics.issues.map((issue) => issue.type)), new Set(["remote_missing"]));

  const olderVersionClient = {
    ...client,
    protocols: {
      ...client.protocols,
      heartbeat: 1,
      clientStatus: 1
    }
  };
  const newerServer = {
    ...server,
    protocols: {
      ...server.protocols,
      heartbeat: 2,
      clientStatus: 2
    }
  };
  const remoteOlder = compareRuntimeDiagnostics(newerServer, olderVersionClient);
  assert.equal(remoteOlder.action, "upgrade_remote");
  assert.deepEqual(new Set(remoteOlder.issues.map((issue) => issue.type)), new Set(["remote_older"]));

  const mixedVersionClient = {
    ...client,
    protocols: {
      ...client.protocols,
      heartbeat: 1,
      clientStatus: 3
    }
  };
  const mixedOlderNewer = compareRuntimeDiagnostics(newerServer, mixedVersionClient);
  assert.equal(mixedOlderNewer.action, "manual_check");
  assert.deepEqual(new Set(mixedOlderNewer.issues.map((issue) => issue.type)), new Set(["remote_older", "remote_newer"]));

  const contractActions = new Set([
    mismatch.action,
    missingDiagnostics.action,
    serverTooOld.action,
    remoteOlder.action,
    mixedOlderNewer.action
  ]);
  assert.deepEqual(
    contractActions,
    new Set(["diagnostics_missing", "upgrade_local", "upgrade_remote", "manual_check"])
  );
});

test("runtime diagnostics treat partial protocol diagnostics as missing", () => {
  const server = buildRuntimeDiagnostics({ role: "server", version: "1.0.0" });
  const partialLegacyClient = {
    app: "singbox-folder-sync",
    role: "client",
    version: "0.0.9",
    buildId: "legacy-client",
    buildTime: null,
    protocols: {
      claim: 1,
      profile: 1
    }
  };

  const compatibility = compareRuntimeDiagnostics(server, partialLegacyClient);

  assert.equal(compatibility.ok, false);
  assert.equal(compatibility.action, "diagnostics_missing");
  assert.equal(compatibility.policy.profileIssue, "warn");
  assert.equal(compatibility.policy.syncRun, "warn");
  assert.equal(compatibility.policy.reason, "diagnostics_missing");
  assert.deepEqual(
    compatibility.issues.map((issue) => [issue.field, issue.type, issue.remote]),
    [
      ["adminState", "remote_missing", null],
      ["clientStatus", "remote_missing", null],
      ["heartbeat", "remote_missing", null]
    ]
  );
});

test("runtime diagnostics reject coerced versions and invalid roles", () => {
  const server = buildRuntimeDiagnostics({ role: "server", version: "1.0.0" });
  const client = buildRuntimeDiagnostics({ role: "client", version: "1.0.0" });
  const stringVersion = {
    ...client,
    protocols: { ...client.protocols, heartbeat: "1" }
  };
  assert.equal(normalizeRuntimeDiagnostics(stringVersion, "client"), null);
  const stringMismatch = compareRuntimeDiagnostics(server, stringVersion);
  assert.equal(stringMismatch.action, "diagnostics_missing");
  assert.deepEqual(
    stringMismatch.issues.map((issue) => [issue.field, issue.type]),
    [["heartbeat", "remote_missing"]]
  );

  const wrongRole = { ...client, role: "server" };
  assert.equal(normalizeRuntimeDiagnostics(wrongRole, "client"), null);
  const roleMismatch = compareRuntimeDiagnostics(server, wrongRole);
  assert.equal(roleMismatch.ok, false);
  assert.equal(roleMismatch.action, "diagnostics_missing");
  assert.equal(roleMismatch.issues.length, 5);

  const wrongApp = { ...client, app: "other-product" };
  assert.equal(normalizeRuntimeDiagnostics(wrongApp, "client"), null);
  assert.equal(compareRuntimeDiagnostics(server, wrongApp).issues.length, 5);
  assert.equal(normalizeRuntimeDiagnostics({ ...client, extra: true }, "client"), null);
});

test("admin state and profile producers use shared protocol versions", () => {
  const state = createDefaultAdminState();
  assert.equal(state.version, ADMIN_STATE_VERSION);
  assert.throws(
    () => normalizeAdminState({ version: ADMIN_STATE_VERSION + 1 }),
    (error) => error.code === "server_state_corrupt"
  );
  const issued = createClaim(state, { clientName: "version-source-pc" });
  assert.equal(issued.profile.version, PROFILE_VERSION);
});

test("legacy devices migrate to private sync spaces without changing their storage target", () => {
  const state = normalizeAdminState({
    users: [{
      id: "user-legacy-device",
      clientName: "legacy-device",
      uuid: "11111111-1111-4111-8111-111111111111",
      storage: {
        bucket: "home-sync",
        prefix: "devices/legacy-device"
      }
    }]
  });

  assert.deepEqual(state.syncSpaces, [{
    id: "space-user-legacy-device",
    syncId: "legacy-legacy-device",
    storageTarget: {
      bucket: "home-sync",
      prefix: "devices/legacy-device"
    },
    policy: {
      multiWriter: false
    },
    status: "active",
    version: 1,
    createdAt: state.users[0].createdAt
  }]);
  assert.deepEqual(state.syncSpaceMemberships, [{
    syncSpaceId: "space-user-legacy-device",
    deviceId: "user-legacy-device",
    role: "owner",
    credentialId: null,
    accessKeyId: null,
    secretAccessKey: null,
    createdAt: state.users[0].createdAt,
    revokedAt: null
  }]);
});

test("SyncKey claims bind a device to its active private sync space", () => {
  const state = createDefaultAdminState();
  const issued = createClaim(state, { clientName: "space-bound-device" });
  const membership = state.syncSpaceMemberships.find((item) => item.deviceId === issued.claim.userId);

  assert.ok(membership);
  assert.equal(membership.role, "owner");
  assert.equal(issued.claim.syncSpaceId, membership.syncSpaceId);
  assert.equal(issued.claim.requestedRole, "owner");
  assert.throws(
    () => createClaim(state, { userId: issued.claim.userId, syncSpaceId: "space-not-authorized" }),
    (error) => error?.code === "sync_space_access_denied"
  );
});

test("an admin-issued SyncKey adds a new device to one selected sync space", () => {
  const state = createDefaultAdminState();
  const owner = createManagedUser(state, { clientName: "space-owner" });
  const space = createSyncSpace(state, {
    ownerUserId: owner.id,
    syncId: "team-documents"
  });

  const issued = createClaim(state, {
    clientName: "space-member",
    syncSpaceId: space.id,
    requestedRole: "writer"
  });
  const member = state.users.find((user) => user.id === issued.claim.userId);
  const membership = state.syncSpaceMemberships.find((item) => item.deviceId === member.id && item.syncSpaceId === space.id);

  assert.equal(issued.claim.syncSpaceId, space.id);
  assert.equal(issued.claim.requestedRole, "writer");
  assert.deepEqual(member.storage.bucket, space.storageTarget.bucket);
  assert.deepEqual(member.storage.prefix, space.storageTarget.prefix);
  assert.equal(issued.profile.storage.bucket, space.storageTarget.bucket);
  assert.equal(issued.profile.storage.prefix, space.storageTarget.prefix);
  assert.equal(membership.role, "writer");
  assert.equal(state.syncSpaceMemberships.some((item) => item.deviceId === member.id && item.syncSpaceId !== space.id), false);
});

test("MinIO policies confine each device role to its assigned sync space prefix", () => {
  const reader = buildMinioPrefixPolicy({
    bucket: "home-sync",
    prefix: "shared/space-team-documents",
    role: "reader"
  });
  const writer = buildMinioPrefixPolicy({
    bucket: "home-sync",
    prefix: "shared/space-team-documents",
    role: "writer"
  });
  const readerActions = reader.Statement[1].Action;
  const writerActions = writer.Statement[1].Action;

  assert.deepEqual(reader.Statement[0].Resource, ["arn:aws:s3:::home-sync"]);
  assert.deepEqual(reader.Statement[0].Condition.StringLike["s3:prefix"], ["shared/space-team-documents", "shared/space-team-documents/*"]);
  assert.deepEqual(reader.Statement[1].Resource, ["arn:aws:s3:::home-sync/shared/space-team-documents/*"]);
  assert.equal(readerActions.includes("s3:PutObject"), false);
  assert.equal(readerActions.includes("s3:DeleteObject"), false);
  assert.equal(writerActions.includes("s3:PutObject"), true);
  assert.equal(writerActions.includes("s3:DeleteObject"), false);
  assert.equal(buildMinioPolicyName({ syncSpaceId: "space-team-documents", role: "writer" }), "sfsc-space-team-documents-writer");
  assert.throws(
    () => buildMinioPrefixPolicy({ bucket: "home-sync", prefix: "../other-space", role: "reader" }),
    /prefix/
  );
});

test("scoped storage mode provisions a device identity without retaining MinIO admin config", async () => {
  const state = createDefaultAdminState();
  updateStorageConfig(state, { accessKeyMode: "per-device-space" });
  const owner = createManagedUser(state, { clientName: "scoped-owner" });
  const space = createSyncSpace(state, { ownerUserId: owner.id, syncId: "scoped-space" });
  const issued = createClaim(state, {
    clientName: "scoped-member",
    syncSpaceId: space.id,
    requestedRole: "writer"
  });
  const temp = await mkdtemp(join(tmpdir(), "sfsc-minio-provision-"));
  const calls = [];
  try {
    const result = await ensureMinioClaimAccess(state, issued.claim, {
      configDir: join(temp, "mc"),
      policyDir: join(temp, "policies"),
      run: async (args, env) => {
        calls.push({ args, env });
        if (args.slice(0, 3).join(" ") === "admin user info" || args.slice(0, 3).join(" ") === "admin policy info") {
          throw new Error("not found");
        }
      }
    });
    const member = state.syncSpaceMemberships.find((item) => item.deviceId === issued.claim.userId && item.syncSpaceId === space.id);

    assert.deepEqual(result, { mode: "per-device-space", provisioned: true, policyName: `sfsc-${space.id}-writer` });
    assert.match(member.accessKeyId, /^sfsc-[a-f0-9]{24}$/);
    assert.equal(calls.some(({ args }) => args.slice(0, 3).join(" ") === "admin user add"), true);
    assert.equal(calls.some(({ args }) => args.slice(0, 3).join(" ") === "admin policy attach"), true);
    // MinIO root credentials must travel in MC_HOST_sfsc, never in argv.
    assert.equal(calls.some(({ args }) => args.slice(0, 2).join(" ") === "alias set"), false);
    assert.equal(calls.some(({ args }) => args.includes(state.storage.secretAccessKey)), false);
    for (const { env } of calls) {
      assert.equal(
        env.MC_HOST_sfsc,
        `http://${encodeURIComponent(state.storage.accessKeyId)}:${encodeURIComponent(state.storage.secretAccessKey)}@minio:9000`
      );
    }
    await assert.rejects(access(join(temp, "mc")));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("one device receives distinct credentials for each authorized sync space", () => {
  const state = createDefaultAdminState();
  updateStorageConfig(state, { accessKeyMode: "per-device-space" });
  const owner = createManagedUser(state, { clientName: "multi-space-owner" });
  const first = createSyncSpace(state, { ownerUserId: owner.id, syncId: "first-space" });
  const second = createSyncSpace(state, { ownerUserId: owner.id, syncId: "second-space" });

  const firstClaim = createClaim(state, { userId: owner.id, syncSpaceId: first.id });
  const secondClaim = createClaim(state, { userId: owner.id, syncSpaceId: second.id });
  const firstMembership = state.syncSpaceMemberships.find((item) => item.syncSpaceId === first.id && item.deviceId === owner.id);
  const secondMembership = state.syncSpaceMemberships.find((item) => item.syncSpaceId === second.id && item.deviceId === owner.id);

  assert.notEqual(firstMembership.credentialId, secondMembership.credentialId);
  assert.notEqual(firstMembership.accessKeyId, secondMembership.accessKeyId);
  assert.notEqual(firstClaim.profile.storage.accessKeyId, secondClaim.profile.storage.accessKeyId);
});

test("disabling a scoped device disables every membership credential", async () => {
  const state = createDefaultAdminState();
  updateStorageConfig(state, { accessKeyMode: "per-device-space" });
  const owner = createManagedUser(state, { clientName: "credential-disable-owner" });
  const first = createSyncSpace(state, { ownerUserId: owner.id, syncId: "credential-disable-first" });
  const second = createSyncSpace(state, { ownerUserId: owner.id, syncId: "credential-disable-second" });
  createClaim(state, { userId: owner.id, syncSpaceId: first.id });
  createClaim(state, { userId: owner.id, syncSpaceId: second.id });
  const calls = [];

  const result = await setMinioDeviceAccessEnabled(state, owner.id, false, {
    run: async (args, env) => calls.push({ args, env })
  });

  assert.equal(result.changed, 2);
  assert.equal(calls.filter(({ args }) => args.slice(0, 4).join(" ") === "admin user disable sfsc").length, 2);
  assert.equal(calls.some(({ args }) => args.includes(state.storage.secretAccessKey)), false);
  assert.equal(calls.every(({ env }) => typeof env.MC_HOST_sfsc === "string" && env.MC_HOST_sfsc.length > 0), true);
});

test("deleting a scoped device removes every membership credential", async () => {
  const state = createDefaultAdminState();
  updateStorageConfig(state, { accessKeyMode: "per-device-space" });
  const owner = createManagedUser(state, { clientName: "credential-remove-owner" });
  const space = createSyncSpace(state, { ownerUserId: owner.id, syncId: "credential-remove-space" });
  createClaim(state, { userId: owner.id, syncSpaceId: space.id });
  const calls = [];

  const result = await removeMinioDeviceAccess(state, owner.id, {
    run: async (args, env) => calls.push({ args, env })
  });

  assert.equal(result.removed, 1);
  assert.equal(calls.some(({ args }) => args.slice(0, 4).join(" ") === "admin user remove sfsc"), true);
  assert.equal(calls.some(({ args }) => args.includes(state.storage.secretAccessKey)), false);
  assert.equal(calls.every(({ env }) => typeof env.MC_HOST_sfsc === "string" && env.MC_HOST_sfsc.length > 0), true);
});

test("SyncKey redemption fails after the sync space membership is revoked", () => {
  const state = createDefaultAdminState();
  const owner = createManagedUser(state, { clientName: "revocation-owner" });
  const space = createSyncSpace(state, {
    ownerUserId: owner.id,
    syncId: "revocation-space"
  });
  const issued = createClaim(state, {
    clientName: "revocation-member",
    syncSpaceId: space.id,
    requestedRole: "reader"
  });
  const membership = state.syncSpaceMemberships.find((item) => item.deviceId === issued.claim.userId && item.syncSpaceId === space.id);
  membership.revokedAt = new Date().toISOString();

  assert.throws(
    () => redeemClaim(state, { tKey: issued.token }),
    (error) => error?.code === "sync_space_access_denied" && error?.status === 403
  );
});


test("parseVlessUri reads a VLESS long URI", () => {
  const profile = parseVlessUri(uri);
  assert.equal(profile.uuid, "8f3f4f94-7d7a-4d7e-a88f-30d5c76a9b21");
  assert.equal(profile.server, "pass.971223.xyz");
  assert.equal(profile.port, 45678);
  assert.equal(profile.security, "reality");
  assert.equal(profile.sni, "www.microsoft.com");
  assert.equal(profile.fingerprint, "chrome");
  assert.equal(profile.publicKey, "SERVER_PUBLIC_KEY");
  assert.equal(profile.shortId, "abcd1234");
  assert.equal(profile.name, "home-sync");
});

test("runtime contracts enforce VLESS parse and sing-box client config responses", () => {
  const profile = parseVlessUri(uri);
  const config = buildClientSingboxConfig(profile, { localProxyPort: 18082 });

  assert.doesNotThrow(() => assertVlessParseResponseContract({ profile }, "vlessParse"));
  assert.doesNotThrow(() => assertSingboxClientConfigResponseContract({ profile, config }, "clientConfig", { localProxyPort: 18082 }));
  assert.throws(
    () => assertVlessParseResponseContract({ profile, extra: true }, "vlessParse"),
    /vlessParse keys/
  );
  assert.throws(
    () => assertSingboxClientConfigResponseContract({ profile, config: {
      ...config,
      outbounds: [
        {
          ...config.outbounds[0],
          multiplex: { enabled: true }
        },
        config.outbounds[1]
      ]
    } }, "clientConfig", { localProxyPort: 18082 }),
    /multiplex\.enabled/
  );
});

test("runtime contracts enforce server jobs preview responses", () => {
  const profile = parseVlessUri(uri);
  const singbox = buildClientSingboxConfig(profile, { localProxyPort: 18082 });
  const previewSecret = "preview-secret-for-contract";
  const rclone = buildRclonePreview({
    direction: "upload",
    localPath: "D:\\Work\\Projects",
    remoteName: "home-minio",
    bucketName: "home-sync",
    clientName: "auth-pc1",
    remoteFolder: "projects",
    storageBackend: "s3",
    streams: 8,
    transfers: 4,
    accessKeyId: "auth-pc1",
    secretAccessKey: previewSecret,
    dryRun: true
  }, { localProxyPort: 18082 });
  const response = {
    profile,
    singbox,
    rclone,
    schedule: {
      text: "Manual",
      nextRun: null
    }
  };

  assert.doesNotThrow(() => assertJobsPreviewResponseContract(response, "jobsPreview", {
    rawSecrets: [previewSecret],
    remoteConfigSecret: previewSecret,
    localProxyPort: 18082
  }));
  assert.doesNotThrow(() => assertJobsPreviewResponseContract({
    ...response,
    profile: null,
    singbox: null
  }, "jobsPreviewNoUri", {
    rawSecrets: [previewSecret],
    remoteConfigSecret: previewSecret,
    localProxyPort: 18082
  }));
  assert.throws(
    () => assertJobsPreviewResponseContract({ ...response, extra: true }, "jobsPreview", { localProxyPort: 18082 }),
    /jobsPreview keys/
  );
  assert.throws(
    () => assertJobsPreviewResponseContract({ ...response, singbox: null }, "jobsPreview", { localProxyPort: 18082 }),
    /jobsPreview\.singbox/
  );
  assert.throws(
    () => assertJobsPreviewResponseContract({
      ...response,
      singbox: {
        ...singbox,
        outbounds: [
          {
            ...singbox.outbounds[0],
            multiplex: { enabled: true }
          },
          singbox.outbounds[1]
        ]
      }
    }, "jobsPreview", { localProxyPort: 18082 }),
    /multiplex\.enabled/
  );
});

test("import profile, SyncKey, and VLESS parsers throw stable product error codes", () => {
  assertErrorCode(() => parseVlessUri("https://example.com"), "invalid_vless_uri");
  assertErrorCode(() => decodeImportProfile("not-a-token"), "import_code_invalid");
  assertErrorCode(() => decodeImportProfile("SFSC1-not-json"), "import_code_invalid");
  assertErrorCode(() => normalizeImportProfile({ version: 99, tunnel: { uri } }), "unsupported_profile_version");
  assertErrorCode(() => normalizeImportProfile({ version: 1, clientName: "company-pc1" }), "profile_tunnel_required");
  assertErrorCode(() => normalizeImportProfile({
    version: 1,
    type: "claim",
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  }), "import_code_invalid");
  assertErrorCode(() => decodeClaimToken(`SFSC1-${base64UrlJson({
    version: 99,
    type: "claim",
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  })}`), "unsupported_profile_version");
  assertErrorCode(() => decodeClaimToken(`SFSC1-${base64UrlJson({
    version: 1,
    type: "claim",
    server: "not-a-url",
    code: "C7KD-92PQ"
  })}`), "import_code_invalid");
});

test("profile import reports client name length separately from character validation", () => {
  assert.throws(
    () => normalizeImportProfile({ clientName: "a".repeat(64), tunnel: { uri } }),
    /Client name must be 1-63 characters/
  );
  assert.throws(
    () => normalizeImportProfile({ clientName: "-bad", tunnel: { uri } }),
    /Client name can only contain letters, numbers, _ and -/
  );
});

test("server console presents SyncKey short code and separate copy actions", async () => {
  const html = await readFile(join(projectRoot, "public", "index.html"), "utf8");
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");
  const css = await readFile(join(projectRoot, "public", "styles.css"), "utf8");

  assert.match(html, /id="claimShortCode"/);
  assert.match(html, /id="claimResult"/);
  assert.match(html, /id="applyNotice"/);
  assert.match(html, /id="refreshSingboxConfigBtn"[^>]*>刷新配置预览/);
  assert.match(html, /id="copyClaimBtn"[^>]*>复制完整 SyncKey/);
  assert.match(html, /id="copyClaimUriBtn"[^>]*>复制导入 URI/);
  assert.match(app, /latestClaimTKey/);
  assert.match(app, /latestClaimUri/);
  assert.match(app, /function renderClaimResult/);
  assert.doesNotMatch(html, /<option value="startup">/);
  assert.match(app, /function readDefaultSchedule/);
  assert.match(app, /function renderApplyNotice/);
  assert.match(app, /byId\("refreshSingboxConfigBtn"\)\.addEventListener\("click", refreshSingboxConfigPreview\)/);
  assert.match(app, /async function refreshSingboxConfigPreview/);
  assert.match(app, /api\("\/api\/admin\/singbox\/config"\)/);
  assert.match(app, /async function readSingboxConfigPreview/);
  assert.match(app, /async function renderLatestSingboxConfigPreview/);
  assert.match(app, /function renderSingboxConfigPreview/);
  assert.match(app, /function renderTunnelJson/);
  assert.match(app, /await renderLatestSingboxConfigPreview\(result\.config\)/);
  assert.match(app, /await renderLatestSingboxConfigPreview\(\)/);
  assert.match(app, /操作已完成，但配置预览刷新失败/);
  assert.match(app, /user: result\.user \|\| result\.deletedUserId[\s\S]*renderState\(\);\n    await renderLatestSingboxConfigPreview\(result\.config\);/);
  assert.match(app, /renderClaimResult\(result\);[\s\S]*renderState\(\);\n  await renderLatestSingboxConfigPreview\(\);/);
  assert.match(app, /sing-box 配置已写入但尚未生效/);
  assert.match(app, /重启并应用 sing-box/);
  assert.match(app, /confirmApplySingbox: true/);
  assert.match(app, /button\.disabled = true/);
  assert.match(app, /function renderBucketActionButton/);
  assert.match(app, /function bucketActionDisabledReason/);
  assert.match(app, /action === "disable" && activeBuckets\.length <= 1/);
  assert.match(app, /\["clear", "delete-empty"\]\.includes\(action\) && bucket\.disabledAt/);
  assert.match(app, /action === "delete-empty" && buckets\.length <= 1/);
  assert.match(app, /至少需要保留一个启用的同步仓库/);
  assert.match(app, /该同步仓库已停用，请先启用后再操作/);
  assert.match(app, /最近写入时间: \$\{formatTime\(tunnel\.lastConfigWrittenAt\)\}/);
  assert.match(app, /最近应用时间: \$\{formatTime\(tunnel\.lastAppliedAt\)\}/);
  assert.match(app, /schedule: readDefaultSchedule\(\)/);
  assert.match(app, /intervalMinutes < 1 \|\| intervalMinutes > 1440/);
  assert.match(app, /rclone_sync_failed: "同步失败，请查看客户端 rclone 日志。"/);
  assert.match(app, /import_code_invalid: "SyncKey 格式不正确，请重新复制。"/);
  assert.match(app, /invalid_vless_uri: "VLESS 链接格式不正确，请检查参数。"/);
  assert.match(app, /profile_tunnel_required: "profile 缺少隧道 URI，请重新生成 SyncKey。"/);
  assert.match(app, /profile_storage_required: "服务端签发 profile 缺少存储凭据，请重新生成 SyncKey。"/);
  assert.match(app, /device_disabled: "该设备已被停用，请在服务端重新启用后再继续。"/);
  assert.match(app, /device_not_found: "当前客户端未在服务端登记，请重新生成并导入 SyncKey。"/);
  assert.match(app, /heartbeat_failed: "无法接收客户端心跳，设备在线状态可能延迟。"/);
  assert.match(app, /request_timeout: "请求服务超时，请稍后重试。"/);
  assert.match(app, /server_singbox_config_write_failed: "服务端 sing-box 配置写入失败，请检查配置路径和权限。"/);
  assert.match(app, /server_state_corrupt: "服务端状态文件损坏，请先备份并修复 sfsc-state\.json。"/);
  assert.match(app, /server_state_locked: "服务端数据目录已有运行中的写入者，请检查是否重复启动 sync-server。"/);
  assert.match(app, /server_state_write_failed: "服务端状态文件写入失败，请检查数据目录权限和磁盘空间。"/);
  assert.match(app, /const defaultRequestTimeoutMs = 15000/);
  assert.match(app, /timedOut \? "request_timeout" : "network_error"/);
  assert.match(app, /function formatActionError\(error\)/);
  assert.match(app, /function recoverySuggestion\(error = \{\}\)/);
  assert.match(app, /const formatter = options\.errorFormatter \|\| formatActionError/);
  assert.match(app, /setAction\(formatter\(error\), "bad"\)/);
  assert.match(app, /bucket_not_empty: "确认 bucket 内数据已备份/);
  assert.match(app, /storage_request_failed: "检查 MinIO 容器、endpoint、access key\/secret，以及 bucket 权限。"/);
  assert.match(app, /request_timeout: "等待当前操作完成后刷新页面/);
  assert.match(app, /setAction\(formatBucketProvisionWarning\(result\.provision, result\.bucket\?\.name\), "warn"\)/);
  assert.match(css, /\.notice\.warn/);
  assert.match(html, /id="diagnosticsStatus"/);
  assert.match(html, /id="deviceStatusFilter"/);
  assert.match(html, /id="deviceSyncFilter"/);
  assert.match(html, /<option value="syncing">同步中<\/option>/);
  assert.match(html, /<option value="idle">空闲<\/option>/);
  assert.match(html, /<option value="error">出错<\/option>/);
  assert.match(html, /id="deviceCompatFilter"/);
  assert.match(html, /<option value="mismatch">不兼容<\/option>/);
  assert.match(html, /id="deviceSearch"/);
  assert.match(html, /id="deviceFilterSummary"/);
  assert.match(app, /formatRuntimeDiagnostics\(result\.diagnostics\)/);
  assert.match(app, /fields\.deviceStatusFilter\.addEventListener\("change", renderDevices\)/);
  assert.match(app, /function filterDevices/);
  assert.match(app, /function renderDeviceFilterSummary/);
  assert.match(app, /function deviceMatchesStatus/);
  assert.match(app, /function deviceMatchesSync/);
  assert.match(app, /function currentDeviceSyncState\(device = \{\}\)/);
  assert.match(app, /const syncState = currentDeviceSyncState\(device\);/);
  assert.match(app, /if \(sync === "syncing" \|\| sync === "running"\) return syncState === "syncing" \|\| lastRunStatus === "running";/);
  assert.match(app, /if \(sync === "idle"\) return syncState === "idle";/);
  assert.match(app, /if \(sync === "error"\) return syncState === "error" \|\| lastRunStatus === "error";/);
  assert.match(app, /function deviceMatchesCompatibility/);
  assert.match(app, /if \(compat === "compatible"\) return device\.compatibility\?\.status === "compatible";/);
  assert.match(app, /if \(compat === "mismatch"\) return device\.compatibility\?\.status === "mismatch";/);
  assert.doesNotMatch(app, /compat === "warning"/);
  assert.match(app, /function deviceSearchText/);
  assert.match(app, /没有匹配的设备/);
  assert.match(app, /function formatProtocolVersions\(protocols = \{\}\)/);
  assert.match(app, /\["SyncKey", protocols\.claim\]/);
  assert.match(app, /\["profile", protocols\.profile\]/);
  assert.match(app, /\["admin", protocols\.adminState\]/);
  assert.match(app, /\["status", protocols\.clientStatus\]/);
  assert.match(app, /\["heartbeat", protocols\.heartbeat\]/);
  assert.match(app, /客户端协议: \$\{escapeHtml\(formatProtocolVersions\(device\.diagnostics\?\.protocols\)\)\}/);
  assert.match(app, /兼容状态: \$\{escapeHtml\(formatCompatibility\(device\.compatibility\)\)\}/);
  assert.match(app, /兼容策略: \$\{escapeHtml\(formatCompatibilityPolicy\(device\.compatibility\?\.policy\)\)\}/);
  assert.match(app, /客户端构建: \$\{escapeHtml\(formatBuildInfo\(device\.diagnostics\)\)\}/);
  assert.match(app, /function formatCompatibility\(compatibility\)/);
  assert.match(app, /function formatCompatibilityPolicy\(policy = \{\}\)/);
  assert.match(app, /function compatibilityActionText\(compatibility = \{\}\)/);
  assert.match(app, /客户端过旧/);
  assert.match(app, /服务端过旧/);
  assert.match(app, /诊断信息缺失/);
  assert.match(app, /来源地址: \$\{escapeHtml\(device\.lastRemoteAddress \|\| "-"\)\}/);
  assert.match(app, /当前文件: \$\{escapeHtml\(formatCurrentFile\(device\.sync\)\)\}/);
  assert.match(app, /function formatCurrentFile\(sync = \{\}\)/);
  assert.match(app, /sync\.currentFile/);
  assert.match(app, /run\.errorCode \? formatError/);
  assert.match(app, /function renderDebugJson/);
  assert.match(app, /maskSensitiveForDisplay/);
  assert.match(app, /\^\(secret\|secretAccessKey\|secret_access_key\|heartbeatSecret\|heartbeatAuthNonces\|privateKey\|private_key\|tKey\|tKeyUri\|claimCode\|token\)\$/);
  assert.match(app, /function maskSensitiveString/);
  assert.match(app, /SFSC1-\[A-Za-z0-9_-\]\+/);
  assert.match(app, /sfsc:\\\/\\\/import\\\/v1#/);
  assert.match(app, /vless:\\\/\\\//);
  assert.match(app, /profile: result\.profile/);
  const maskSnippet = app.slice(
    app.indexOf("function maskSensitiveForDisplay"),
    app.indexOf("function clearAdminToken")
  );
  const maskSensitiveForDisplay = Function(`${maskSnippet}; return maskSensitiveForDisplay;`)();
  const debugPayload = {
    profile: {
      heartbeat: {
        scheme: "sfsc-hmac-sha256-v1",
        secret: "heartbeat-debug-secret"
      },
      storage: {
        secretAccessKey: "storage-debug-secret"
      },
      tunnel: {
        uri: "vless://server-secret@example.com:443?security=reality"
      }
    },
    tKey: "SFSC1-secret-token"
  };
  const maskedDebugText = JSON.stringify(maskSensitiveForDisplay(debugPayload));
  assert.equal(maskedDebugText.includes("heartbeat-debug-secret"), false);
  assert.equal(maskedDebugText.includes("storage-debug-secret"), false);
  assert.equal(maskedDebugText.includes("vless://server-secret"), false);
  assert.equal(maskedDebugText.includes("SFSC1-secret-token"), false);
  assert.match(maskedDebugText, /"secret":"[^"]*\*{3}[^"]*"/);
  assert.match(app, /data-device-action/);
  assert.match(app, /\/api\/admin\/users\/enable/);
  assert.match(app, /\/api\/admin\/users\/disable/);
  assert.match(app, /\/api\/admin\/users\/delete/);
  assert.match(app, /已启用，配置已写入；请点击“重启并应用”。/);
  assert.match(app, /已停用，配置已写入；请点击“重启并应用”。/);
  assert.match(app, /已删除，配置已写入；请点击“重启并应用”。/);
  assert.doesNotMatch(app, /已启用，需重新生成并应用 sing-box 配置。/);
  assert.match(app, /local_state_corrupt: "客户端本地状态文件损坏，请先导出诊断包，备份并修复或隔离损坏 JSON 后再按需重新导入 SyncKey。"/);
  assert.match(app, /确认启用不兼容设备/);
  assert.match(app, /findDeviceById\(userId\)/);
  assert.match(app, /findDeviceByName\(fields\.deviceName\.value\)/);
  assert.match(app, /targetDevice\?\.enabled === false/);
  assert.match(app, /已停用。请先在设备列表中重新启用，再生成 SyncKey。/);
  assert.match(app, /errorCode: "device_disabled"/);
  assert.match(app, /confirmCompatibilityWarning: Boolean\(compatibilityConfirmation\)/);
  assert.match(app, /确认向不兼容设备下发 SyncKey/);
  assert.match(app, /requiredText: clientName/);
  assert.match(app, /function formatDeviceImpact/);
  assert.match(app, /function deviceImpactClass/);
  assert.match(app, /function deviceCardClass/);
  assert.match(app, /function getDeviceConflictSummary/);
  assert.match(app, /class="item device-card \$\{deviceCardClass\(device\)\}"/);
  assert.match(app, /设备已停用：旧客户端心跳和新 SyncKey 生成都会被拒绝/);
  assert.match(app, /最近同步失败：/);
  assert.match(app, /最近同步检测到冲突/);
  assert.match(app, /请让用户暂停继续双向同步/);
  assert.match(app, /function formatConflictSummary/);
  assert.match(app, /计划: \$\{escapeHtml\(formatScheduler\(device\.sync\?\.scheduler\)\)\}/);
  assert.match(app, /function formatScheduler/);
  assert.match(app, /设备离线：若长时间未恢复/);
  assert.match(app, /function tunnelImpactSummary/);
  assert.match(app, /function realityRotationImpactSummary/);
  assert.match(app, /function formatAffectedDeviceNames/);
  assert.match(app, /当前设备：共 \$\{devices\.length\} 个，启用 \$\{enabledDevices\.length\} 个，在线 \$\{onlineCount\} 个/);
  assert.match(app, /协议兼容性警告/);
  assert.match(app, /需要重新生成 SyncKey 并重新导入客户端/);
  assert.match(css, /white-space:\s*pre-line/);
  assert.match(css, /\.device-filters/);
  assert.match(css, /\.filter-summary/);
  assert.match(css, /\.device-card\.warn/);
  assert.match(css, /\.device-card\.bad/);
});

test("server console SyncKey generation errors show retry guidance", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");

  assert.match(app, /async function runAction\(pendingText, successText, action, options = \{\}\)/);
  assert.match(app, /const formatter = options\.errorFormatter \|\| formatActionError/);
  assert.match(app, /\{ errorFormatter: formatClaimCreateError \}/);
  assert.match(app, /function formatClaimCreateError\(error\)/);
  assert.match(app, /function claimCreateErrorGuidance\(code\)/);
  assert.match(app, /return `SyncKey 未生成：\$\{item\.message\} \$\{item\.action\}`/);

  for (const code of [
    "server_state_write_failed",
    "network_error",
    "request_timeout",
    "storage_request_failed",
    "server_error"
  ]) {
    assert.match(app, new RegExp(`${code}: \\{[\\s\\S]*?retryable: true`));
  }
  assert.match(app, /可重试：请检查 sfsc-state\.json 数据目录权限和磁盘空间/);
  assert.match(app, /确认 sync-server 容器、反代和端口可访问/);
  assert.match(app, /检查 N1 负载和 sync-server 日志/);
  assert.match(app, /检查 MinIO\/S3 endpoint、密钥和 bucket 权限/);

  for (const code of [
    "danger_confirmation_required",
    "device_disabled",
    "bucket_disabled",
    "bucket_not_found",
    "user_not_found",
    "validation_failed"
  ]) {
    assert.match(app, new RegExp(`${code}: \\{[\\s\\S]*?retryable: false`));
  }
  assert.match(app, /请按弹窗确认兼容性风险后再生成 SyncKey/);
  assert.match(app, /请先在设备列表中重新启用并应用 sing-box 配置/);
  assert.match(app, /选择其他启用的同步仓库后重新生成 SyncKey/);
  assert.match(app, /刷新仓库列表并选择仍存在的仓库后重新生成 SyncKey/);
  assert.match(app, /检查设备名、SyncKey 服务地址、有效期、同步参数和仓库选择/);
});

test("server console SyncKey redeem preview errors show safety guidance", async () => {
  const app = await readFile(join(projectRoot, "public", "app.js"), "utf8");

  assert.match(app, /\{ errorFormatter: formatClaimRedeemPreviewError \}/);
  assert.match(app, /function formatClaimRedeemPreviewError\(error\)/);
  assert.match(app, /function claimRedeemPreviewErrorGuidance\(code\)/);
  assert.match(app, /return `SyncKey 测试兑换失败：\$\{item\.message\} \$\{item\.action\}`/);

  for (const code of [
    "claim_not_found",
    "claim_already_used",
    "claim_expired",
    "validation_failed",
    "import_code_invalid"
  ]) {
    assert.match(app, new RegExp(`function claimRedeemPreviewErrorGuidance\\(code\\)[\\s\\S]*?${code}: \\{[\\s\\S]*?retryable: false`));
  }
  assert.match(app, /不可重试当前 SyncKey/);
  assert.match(app, /不可重试当前内容/);
  assert.match(app, /重新复制完整 SyncKey/);

  assert.match(app, new RegExp("function claimRedeemPreviewErrorGuidance\\(code\\)[\\s\\S]*?server_state_write_failed: \\{[\\s\\S]*?retryable: true"));
  assert.match(app, /兑换状态未成功持久化/);
  assert.match(app, /SyncKey 不应视为已消耗/);
  assert.match(app, /修复后用同一个 SyncKey 再试/);

  for (const code of [
    "network_error",
    "request_timeout",
    "server_error",
    "claim_redeem_failed"
  ]) {
    assert.match(app, new RegExp(`function claimRedeemPreviewErrorGuidance\\(code\\)[\\s\\S]*?${code}: \\{[\\s\\S]*?retryable: false`));
  }
  assert.match(app, /结果未知：请先刷新管理状态查看 claim 是否已 used\/redeemedAt/);
  assert.match(app, /不要把这个 SyncKey 交给客户端/);
  assert.match(app, /无法确认时重新生成 SyncKey/);
});

test("server smoke script covers deployment health and management checks", async () => {
  const pkg = await readFile(join(projectRoot, "package.json"), "utf8");
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
  const deployment = await readFile(join(projectRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), "utf8");
  const smoke = await readFile(join(projectRoot, "scripts", "smoke-server.mjs"), "utf8");
  const clientSmoke = await readFile(join(projectRoot, "scripts", "smoke-client.mjs"), "utf8");
  const clientHttp = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
  const server = await readFile(join(projectRoot, "src", "server.js"), "utf8");
  const serverAdmin = await readFile(join(projectRoot, "src", "core", "serverAdmin.js"), "utf8");
  const deploy = await readFile(join(projectRoot, "scripts", "deploy-n1.ps1"), "utf8");
  const applyN1 = await readFile(join(projectRoot, "scripts", "apply-n1-singbox.ps1"), "utf8");
  const postDeploy = await readFile(join(projectRoot, "scripts", "post-deploy-n1.ps1"), "utf8");
  const bundle = await readFile(join(projectRoot, "scripts", "build-release-bundle.ps1"), "utf8");
  const preflight = await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8");
  const buildClient = await readFile(join(projectRoot, "client", "scripts", "build-client.ps1"), "utf8");
  const downloadBinaries = await readFile(join(projectRoot, "client", "scripts", "download-binaries.ps1"), "utf8");
  const binaryLock = JSON.parse(await readFile(join(projectRoot, "client", "resources", "bin", "win32", "binaries.lock.json"), "utf8"));
  const ciVerify = await readFile(join(projectRoot, "scripts", "ci-verify.ps1"), "utf8");
  const ciWorkflow = await readFile(join(projectRoot, ".github", "workflows", "ci.yml"), "utf8");
  const releaseWorkflow = await readFile(join(projectRoot, ".github", "workflows", "release.yml"), "utf8");

  assert.match(pkg, /"smoke:server": "node scripts\/smoke-server\.mjs"/);
  assert.match(pkg, /"packageManager": "pnpm@9\.15\.4"/);
  assert.match(pkg, /"ci:verify": "powershell -ExecutionPolicy Bypass -File scripts\/ci-verify\.ps1"/);
  assert.match(pkg, /"smoke:client": "node scripts\/smoke-client\.mjs"/);
  assert.match(pkg, /"deploy:n1": "powershell -ExecutionPolicy Bypass -File scripts\/deploy-n1-appliance\.ps1"/);
  assert.match(pkg, /"deploy:n1:legacy": "powershell -ExecutionPolicy Bypass -File scripts\/deploy-n1\.ps1"/);
  assert.match(pkg, /"apply:n1": "powershell -ExecutionPolicy Bypass -File scripts\/apply-n1-singbox\.ps1"/);
  assert.match(pkg, /"bundle:release": "powershell -ExecutionPolicy Bypass -File scripts\/build-release-bundle\.ps1"/);
  assert.match(pkg, /"release:status": "node scripts\/release-status\.mjs"/);
  assert.match(pkg, /"preflight:release": "powershell -ExecutionPolicy Bypass -File scripts\/preflight-release\.ps1"/);
  assert.match(pkg, /"postdeploy:n1": "powershell -ExecutionPolicy Bypass -File scripts\/post-deploy-n1\.ps1"/);
  assert.match(pkg, /"preflight:release:quick": "powershell -ExecutionPolicy Bypass -File scripts\/preflight-release\.ps1 -SkipTests -AllowSkips"/);
  assert.match(ciVerify, /\[switch\]\$RunStrictPreflight/);
  assert.match(ciVerify, /scripts\/audit-release\.mjs/);
  assert.match(ciVerify, /\$node --test "tests\/\*\.test\.js"/);
  assert.match(ciVerify, /scripts\/preflight-release\.ps1/);
  assert.match(ciVerify, /CI verification passed/);
  assert.match(ciWorkflow, /name: CI/);
  assert.match(ciWorkflow, /pull_request:/);
  assert.match(ciWorkflow, /actions\/setup-node@v4/);
  assert.match(ciWorkflow, /node-version: "24"/);
  assert.match(ciWorkflow, /pnpm\/action-setup@v4/);
  assert.match(ciWorkflow, /pnpm install --frozen-lockfile/);
  assert.match(ciWorkflow, /pnpm run ci:verify/);
  assert.match(ciWorkflow, /run_strict_preflight/);
  assert.match(ciWorkflow, /scripts\/ci-verify\.ps1 -RunStrictPreflight/);
  assert.match(releaseWorkflow, /name: Release/);
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.match(releaseWorkflow, /runs-on: windows-latest/);
  assert.match(releaseWorkflow, /actions\/setup-node@v4/);
  assert.match(releaseWorkflow, /node-version: "24"/);
  assert.match(releaseWorkflow, /pnpm install --frozen-lockfile/);
  assert.match(releaseWorkflow, /pnpm run client:download-binaries/);
  assert.match(releaseWorkflow, /pnpm run client:desktop-package/);
  assert.match(releaseWorkflow, /pnpm run client:package/);
  assert.match(releaseWorkflow, /scripts\/preflight-release\.ps1 -ReportPath reports\/release\/preflight\.txt -JsonReportPath reports\/release\/preflight\.json/);
  assert.match(releaseWorkflow, /Assert release preflight JSON/);
  assert.match(releaseWorkflow, /\$report\.releaseOk -ne \$true/);
  assert.match(releaseWorkflow, /\$report\.summary\.failed -ne 0 -or \$report\.summary\.skipped -ne 0/);
  assert.match(releaseWorkflow, /\$report\.clientPackageSmokeReports/);
  assert.match(releaseWorkflow, /desktop and portable client package smoke reports/);
  assert.match(releaseWorkflow, /\$item\.exists -ne \$true -or \$item\.ok -ne \$true/);
  assert.match(releaseWorkflow, /Build release bundle/);
  assert.match(releaseWorkflow, /scripts\/build-release-bundle\.ps1 -SkipPreflight/);
  assert.match(releaseWorkflow, /-PreflightReportPath reports\/release\/preflight\.txt -PreflightJsonReportPath reports\/release\/preflight\.json/);
  assert.match(releaseWorkflow, /actions\/upload-artifact@v4/);
  assert.match(releaseWorkflow, /dist\/SyncraftDesktop\.zip/);
  assert.match(releaseWorkflow, /dist\/SyncraftDesktop\.zip\.sha256/);
  assert.match(releaseWorkflow, /dist\/SyncraftDesktop\/release-manifest\.json/);
  assert.match(releaseWorkflow, /dist\/SyncraftClient\.zip/);
  assert.match(releaseWorkflow, /dist\/SyncraftClient\.zip\.sha256/);
  assert.match(releaseWorkflow, /dist\/SyncraftClient\/release-manifest\.json/);
  assert.match(releaseWorkflow, /dist\/release-bundles\/\*\*/);
  assert.match(releaseWorkflow, /reports\/release\/\*\*/);
  assert.match(buildClient, /\$nodeExe = \$env:SFSC_NODE/);
  assert.match(buildClient, /Get-Command node/);
  assert.match(buildClient, /Node\.js not found\. Install Node\.js or set SFSC_NODE to node\.exe\./);
  assert.match(buildClient, /WriteAllText\(\(Join-Path \$distRootFull "app\\package\.json"\), \$appPackageJson\.Replace\("__APP_VERSION__", \$appVersion\), \[System\.Text\.UTF8Encoding\]::new\(\$false\)\)/);
  assert.match(buildClient, /WriteAllText\(\(Join-Path \$distRootFull "release-manifest\.json"\), \$releaseManifestJson, \[System\.Text\.UTF8Encoding\]::new\(\$false\)\)/);
  assert.doesNotMatch(buildClient, /\$nodeExe = "C:\\Users\\Tong_hp/);
  assert.equal(binaryLock.schemaVersion, 1);
  assert.equal(binaryLock.platform, "win32-x64");
  assert.equal(binaryLock.tools["sing-box"].version, "1.13.14");
  assert.equal(binaryLock.tools["sing-box"].tag, "v1.13.14");
  assert.match(binaryLock.tools["sing-box"].sha256, /^[a-f0-9]{64}$/);
  assert.equal(binaryLock.tools.rclone.version, "1.74.3");
  assert.equal(binaryLock.tools.rclone.tag, "v1.74.3");
  assert.match(binaryLock.tools.rclone.sha256, /^[a-f0-9]{64}$/);
  assert.match(downloadBinaries, /\[string\]\$LockFile = ""/);
  assert.match(downloadBinaries, /\[switch\]\$Force/);
  assert.match(downloadBinaries, /binaries\.lock\.json/);
  assert.match(downloadBinaries, /already exists and matches binaries\.lock\.json/);
  assert.match(downloadBinaries, /does not match binaries\.lock\.json\. Use -Force/);
  assert.match(downloadBinaries, /releases\/tags\/\$tag/);
  assert.match(downloadBinaries, /\$SingBoxVersion/);
  assert.match(downloadBinaries, /\$RcloneVersion/);
  // D-2: a version override drops out of the SHA-256 pin, so it must be an
  // explicit opt-in that fails loudly by default and never a silent skip.
  assert.match(downloadBinaries, /\[switch\]\$AllowUnverified/);
  assert.match(downloadBinaries, /bypasses binaries\.lock\.json SHA-256 pinning/);
  assert.match(downloadBinaries, /if \(!\$AllowUnverified\) \{\s*\n\s*throw/);
  assert.match(downloadBinaries, /UNVERIFIED: record this sha256/);
  assert.doesNotMatch(downloadBinaries, /no lock hash is available, skipping/);
  // D-3: the binary lock participates in the source fingerprint so a different
  // set of pinned third-party binaries can never share a buildId; the exe blobs
  // themselves stay excluded because the lock records their identity.
  const fingerprintHelper = await readFile(join(projectRoot, "scripts", "lib", "build-fingerprint.ps1"), "utf8");
  assert.match(fingerprintHelper, /"client\\resources\\bin\\win32\\binaries\.lock\.json",/);
  assert.match(fingerprintHelper, /\^client\/resources\/bin\/\(\?!win32\/binaries\\\.lock\\\.json\$\)/);
  assert.doesNotMatch(fingerprintHelper, /\^client\/resources\/bin\(\/\|\$\)/);
  assert.match(smoke, /SFSC_SMOKE_BASE_URL/);
  assert.match(smoke, /from "\.\/lib\/runtimeContracts\.mjs"/);
  assert.match(deploy, /scripts\/lib\/runtimeContracts\.mjs/);
  assert.match(deployment, /scripts\/lib\/runtimeContracts\.mjs/);
  assert.match(applyN1, /app = "singbox-folder-sync"/);
  assert.match(applyN1, /type = "n1-singbox-apply-report"/);
  assert.match(applyN1, /docker compose -f docker-compose\.n1\.yml restart sing-box/);
  assert.match(applyN1, /\/api\/admin\/singbox\/mark-applied/);
  assert.match(applyN1, /confirmMarkApplied = \$true/);
  assert.match(applyN1, /server smoke still reports restartRequired=true after mark-applied/);
  assert.match(applyN1, /\[switch\]\$AllowMismatchedSmokeBaseUrl/);
  assert.match(applyN1, /RemoteHost and SmokeBaseUrl must point to the same host/);
  assert.match(applyN1, /RemoteRoot must be an absolute POSIX path/);
  assert.match(applyN1, /Join-Path \$repoRoot "scripts\\smoke-server\.mjs"/);
  assert.doesNotMatch(applyN1, /Get-Content .*\.env/);
  assert.match(deploy, /for attempt in \$\(seq 1 30\)/);
  assert.match(deploy, /curl -fsS --max-time 5 http:\/\/127\.0\.0\.1:5177\/api\/health/);
  assert.match(deploy, /\/api\/health was not ready after/);
  assert.match(smoke, /SFSC_SMOKE_JSON_REPORT/);
  assert.match(smoke, /--json-report/);
  assert.match(smoke, /SFSC_SMOKE_TIMEOUT_MS/);
  assert.match(smoke, /--timeout-ms/);
  assert.match(smoke, /SFSC_SMOKE_CLEANUP_CLAIM_LIFECYCLE/);
  assert.match(smoke, /--cleanup-claim-lifecycle/);
  assert.match(deploy, /\[switch\]\$ExerciseClaimLifecycle/);
  assert.match(deploy, /\[switch\]\$CleanupClaimLifecycle/);
  assert.match(deploy, /if \(\$ExerciseClaimLifecycle\) \{\s*\$args \+= "--exercise-claim-lifecycle"\s*\}/);
  assert.match(deploy, /if \(\$CleanupClaimLifecycle\) \{\s*\$args \+= "--cleanup-claim-lifecycle"\s*\}/);
  assert.match(smoke, /AbortController/);
  assert.match(smoke, /signal: controller\?\.signal/);
  assert.match(smoke, /Request timed out after/);
  assert.match(smoke, /function runCheck/);
  assert.match(smoke, /function writeSmokeJsonReport/);
  assert.match(smoke, /type: "server-smoke-report"/);
  assert.match(smoke, /adminAuthProvided: Boolean\(adminToken\)/);
  assert.match(smoke, /writeJsonReportSync\(reportPath, payload, "server smoke report"\)/);
  assert.match(smoke, /SFSC server smoke JSON report written/);
  assert.match(smoke, /Failed check: \$\{error\.check \|\| currentCheck\}/);
  assert.match(smoke, /HTTP \$\{response\.status\} \$\{path\}/);
  assert.match(smoke, /SFSC_ADMIN_TOKEN/);
  assert.match(smoke, /\/api\/health/);
  assert.match(smoke, /\/api\/admin\/auth\/check/);
  assert.match(smoke, /\/api\/admin\/state/);
  assert.match(smoke, /\/api\/admin\/singbox\/config/);
  assert.match(smoke, /\/api\/profile\/encode/);
  assert.match(smoke, /\/api\/vless\/parse/);
  assert.match(smoke, /\/api\/singbox\/client-config/);
  assert.match(smoke, /\/api\/jobs\/preview/);
  assert.match(smoke, /function postJson/);
  assert.match(smoke, /clientRedeemId/);
  assert.match(smoke, /clientInstallId/);
  assert.match(smoke, /profile-encode/);
  assert.match(smoke, /vless-parse/);
  assert.match(smoke, /singbox-client-config/);
  assert.match(smoke, /jobs-preview/);
  assert.match(smoke, /assertProfileEncodeResponseContract\(encodedProfile, "profileEncode"/);
  assert.match(smoke, /assertClaimCreateResponseContract\(created, "claimLifecycle\.create"/);
  assert.match(smoke, /assertClaimRedeemResponseContract\(redeemed, "claimLifecycle\.redeemedProfile"/);
  assert.match(smoke, /assertClaimRedeemResponseContract\(replayed, "claimLifecycle\.replayedProfile"/);
  assert.match(smoke, /assertVlessParseResponseContract\(parsedVless, "vlessParse"\)/);
  assert.match(smoke, /assertSingboxClientConfigResponseContract\(clientConfig, "singboxClientConfig"/);
  assert.match(smoke, /assertJobsPreviewResponseContract\(jobsPreview, "jobsPreview"/);
  assert.match(smoke, /assertServerHeartbeatResponseContract\(value, "claimLifecycle\.heartbeat"\)/);
  assert.match(smoke, /function expectJsonError/);
  assert.match(smoke, /admin-auth-required/);
  assert.match(smoke, /admin_auth_required/);
  assert.match(smoke, /protocol=\$\{health\.diagnostics\?\.protocols\?\.profile \|\| "unknown"\}/);
  assert.match(smoke, /assertServerHealthResponseContract\(health\)/);
  assert.match(smoke, /assertAdminAuthCheckResponseContract\(auth\)/);
  assert.match(smoke, /assertJobsPreviewResponseContract/);
  assert.match(smoke, /const adminAuthEnabled = health\.adminAuth\.enabled/);
  assert.match(smoke, /assertAdminStateSummaryContract\(state, "adminState"\)/);
  assert.match(smoke, /function requireProtocolMapMatch/);
  assert.match(smoke, /Server health\/state diagnostics protocol mismatch/);
  assert.match(smoke, /assertAdminSingboxConfigPreviewContract\(config, state, "singboxConfig"\)/);
  assert.match(smoke, /assertServerDeviceSummaryContract\(device, "claimLifecycle\.adminState\.device"\)/);
  assert.match(smoke, /assertAdminClaimSummaryContract\(claim, "claimLifecycle\.adminState\.claim"\)/);
  assert.match(smoke, /assertAdminWriteStateResponseContract\(cleaned, "claimLifecycle\.cleanup"\)/);
  assert.match(smoke, /claim-lifecycle-bound-replay/);
  assert.match(smoke, /same client binding replay accepted/);
  assert.match(smoke, /claim-lifecycle-duplicate-redeem/);
  assert.match(smoke, /claim-lifecycle-different-binding-redeem/);
  assert.match(smoke, /different client binding rejected/);
  assert.match(smoke, /claim-lifecycle-cleanup-device/);
  assert.match(smoke, /protocols=aligned/);
  assert.match(smoke, /version=\$\{state\.appVersion \|\| "unknown"\}/);
  assert.match(smoke, /restartRequired/);
  assert.match(smoke, /function requireMaskedSecret/);
  assert.match(smoke, /state\.storage\?\.secretAccessKey/);
  assert.match(smoke, /state\.users\[\$\{index\}\]\.storage\.secretAccessKey/);
  assert.match(smoke, /tls\?\.reality\?\.private_key/);
  assert.match(smoke, /function requireNoKnownSensitiveValues/);
  assert.match(smoke, /Management responses exposed a known secret value/);
  assert.match(contract, /\/api\/health\.diagnostics\.protocols` 必须与 `\/api\/admin\/state\.diagnostics\.protocols` 完全一致/);
  assert.match(contract, /`--cleanup-claim-lifecycle`/);
  assert.match(contract, /保留已使用 claim 摘要作为审计记录/);
  assert.match(contract, /`context\.cleanupClaimLifecycle\*`/);
  assert.match(contract, /summary\.restartRequired=false/);
  assert.match(contract, /apply 报告不得记录真实管理 token/);
  assert.match(contract, /`adminAuth\.enabled` 必须是布尔值/);
  assert.match(contract, /admin state summary contract/);
  assert.match(contract, /admin write state response contract/);
  assert.match(contract, /管理摘要的 `settings` 是服务端控制台全局设置合同/);
  assert.match(contract, /admin settings summary contract/);
  assert.match(contract, /`settings\.publicServerUrl` 不等同于 VLESS\/sing-box 的 `tunnel\.publicHost`/);
  assert.match(contract, /管理摘要的 `tunnel` 是服务端 VLESS\/sing-box 配置状态合同/);
  assert.match(contract, /admin tunnel summary contract/);
  assert.match(contract, /当 `userCount === 0` 时 `sampleUri` 必须为 `null`/);
  assert.match(contract, /`\/api\/admin\/state` 默认不得返回完整 VLESS URI/);
  assert.match(contract, /`GET \/api\/admin\/devices\/\{id\}\/vless-uri`/);
  assert.match(contract, /admin sing-box config preview contract/);
  assert.match(contract, /`config\.inbounds\[0\]\.type` 必须为 `vless`/);
  assert.match(contract, /`users\[\]` 必须且只包含 `state\.users\[\]` 中启用且未删除的用户/);
  assert.match(contract, /恢复本次请求前的 sing-box config 文件内容/);
  assert.match(contract, /删除本次新写出的 config 文件/);
  assert.match(contract, /幽灵设备或幽灵 SyncKey 配置/);
  assert.match(contract, /sing-box config 文件写入必须使用临时文件和原子 rename/);
  assert.match(server, /async function saveAdminStateWithSingboxConfig\(\)/);
  assert.match(server, /const previousConfig = await readExistingSingboxConfigFile\(\)/);
  assert.match(server, /restoreSingboxConfigFile\(previousConfig\)/);
  assert.match(server, /async function writeFileAtomic\(file, body, encoding\)/);
  assert.match(server, /await rename\(tempFile, file\)/);
  assert.match(contract, /管理摘要的 `storage` 是服务端 SyncKey 默认存储目标和 bucket 运维状态合同/);
  assert.match(contract, /admin storage summary contract/);
  assert.match(contract, /`storage\.bucket` 必须出现在 `storage\.buckets\[\]` 中/);
  assert.match(contract, /管理摘要的 `defaults` 是服务端 SyncKey\/profile 默认同步参数合同/);
  assert.match(contract, /admin defaults summary contract/);
  assert.match(contract, /管理摘要的 `users\[\]` 是服务端控制台管理设备凭据和 sing-box 用户的运维列表合同/);
  assert.match(contract, /admin user summary contract/);
  assert.match(contract, /`users\[\]` 可以包含已删除用户/);
  assert.match(contract, /`POST \/api\/admin\/users\/create` 是低层调试\/运维入口/);
  assert.match(contract, /当前服务端控制台的产品化创建设备入口是 `POST \/api\/claims\/create`/);
  assert.match(contract, /避免出现“已登记但没有可导入 SyncKey”的半成品设备/);
  assert.match(contract, /管理摘要的 `devices\[\]` 是服务端控制台和客户端心跳回显共同使用的设备摘要合同/);
  assert.match(contract, /顶层 `syncState` 必须与 `sync\.state` 完全一致/);
  assert.match(contract, /admin device summary contract/);
  assert.match(contract, /管理摘要的 `claims\[\]` 是服务端控制台展示 SyncKey 生命周期的只读摘要合同/);
  assert.match(contract, /admin claim summary contract/);
  assert.match(contract, /已兑换 claim 继续保留审计摘要/);
  assert.match(contract, /过期未使用 claim 在保留期后删除/);
  assert.match(contract, /过期的短时重放绑定只保留 `firstRedeemedAt`/);
  assert.match(contract, /不得包含完整 `profile`、完整 `tKey`、`tKeyUri`/);
  assert.match(serverAdmin, /export function compactAdminState\(state, options = \{\}\)/);
  assert.match(serverAdmin, /function compactClaimReplayBinding\(claim, nowMs\)/);
  assert.match(contract, /同一客户端绑定短时重放成功/);
  assert.match(contract, /不同客户端绑定的重复 redeem 返回 `409 claim_already_used`/);
  assert.match(deployment, /claim-lifecycle-bound-replay/);
  assert.match(deployment, /claim-lifecycle-different-binding-redeem/);
  assert.match(deployment, /同一客户端绑定短时重放成功/);
  assert.match(deployment, /不同客户端绑定的重复 redeem 返回 `409 claim_already_used`/);
  assert.match(deployment, /--cleanup-claim-lifecycle/);
  assert.match(deployment, /SFSC_SMOKE_CLEANUP_CLAIM_LIFECYCLE=1/);
  assert.match(deployment, /保留已使用 claim 摘要作为审计记录/);
  assert.match(deployment, /-ExerciseClaimLifecycle -CleanupClaimLifecycle/);
  assert.match(contract, /验收脚本可以把 lifecycle flags 暴露为 `-ExerciseClaimLifecycle` \/ `-CleanupClaimLifecycle`/);
  assert.match(contract, /`claim`: 本次 SyncKey 的生命周期摘要/);
  assert.match(contract, /`claim` 必须是展示安全摘要/);
  assert.match(contract, /不得嵌入 `claim`/);
  assert.match(contract, /smoke 应在 `admin-state` 检查中输出 `protocols=aligned`/);
  assert.match(contract, /协议漂移失败/);
  assert.match(contract, /`\/api\/vless\/parse` 必须遵守 vless parse response contract/);
  assert.match(contract, /`\/api\/singbox\/client-config` 必须遵守 singbox client config response contract/);
  assert.match(contract, /`vlessParse\.\*`、`singboxClientConfig\.\*` 或 `jobsPreview\.\*` 字段路径/);
  assert.match(clientSmoke, /SFSC_CLIENT_SMOKE_BASE_URL/);
  assert.match(clientSmoke, /from "\.\/lib\/runtimeContracts\.mjs"/);
  assert.match(clientSmoke, /SFSC_CLIENT_SMOKE_JSON_REPORT/);
  assert.match(clientSmoke, /SFSC_CLIENT_SMOKE_TIMEOUT_MS/);
  assert.match(clientSmoke, /--json-report/);
  assert.match(clientSmoke, /--timeout-ms/);
  assert.match(clientSmoke, /\/api\/health/);
  assert.match(clientSmoke, /\/api\/client\/status/);
  assert.match(clientSmoke, /\/api\/profile/);
  assert.match(clientSmoke, /\/api\/jobs/);
  assert.match(clientSmoke, /\/api\/logs/);
  assert.match(clientSmoke, /\/api\/diagnostics\/export/);
  assert.match(clientSmoke, /function requireHealthDoesNotExposeFullState/);
  assert.match(clientSmoke, /"heartbeat"/);
  assert.match(clientSmoke, /Client health endpoint exposed full local state fields: \$\{exposed\.join/);
  assert.match(clientSmoke, /function requireProtocolMapMatch/);
  assert.match(clientSmoke, /Client health\/status diagnostics protocol mismatch/);
  assert.match(clientSmoke, /protocols=aligned/);
  assert.match(clientSmoke, /assertClientHealthContract\(health\)/);
  assert.match(clientSmoke, /assertRuntimeDiagnosticsContract\(status\.diagnostics, "client"\)/);
  assert.match(clientSmoke, /assertClientStatusContract\(status\)/);
  assert.match(clientSmoke, /assertClientProfileReadContract\(profileRead, "clientProfile"\)/);
  assert.match(clientSmoke, /assertClientJobsReadContract\(jobsRead, "clientJobs"\)/);
  assert.match(clientSmoke, /assertClientSyncHistoryContract\(syncHistory, "syncHistory"\)/);
  assert.match(clientSmoke, /assertHeartbeatContract\(status\.heartbeat\)/);
  assert.match(clientSmoke, /assertClientLogsContract\(logs, "clientLogs"\)/);
  assert.match(clientSmoke, /assertDiagnosticExportContract\(diagnosticExport, "diagnosticExport"\)/);
  assert.match(clientSmoke, /client-profile/);
  assert.match(clientSmoke, /client-jobs/);
  assert.match(clientSmoke, /client-sync-history/);
  assert.match(clientSmoke, /client-logs/);
  assert.match(clientSmoke, /diagnostic-export/);
  assert.match(contract, /客户端 smoke 还必须覆盖 `\/api\/logs` 的 client logs contract 和 `\/api\/diagnostics\/export` 的 diagnostic export contract/);
  assert.doesNotMatch(clientSmoke, /function requireClientStatusContract/);
  assert.doesNotMatch(clientSmoke, /function requireSafeguardsContract/);
  assert.doesNotMatch(clientSmoke, /function requireLocalStateFilesContract/);
  assert.match(clientSmoke, /function requireProcessesContract/);
  assert.match(clientSmoke, /requireProcessStatus\(value\.singbox, "processes\.singbox", "sing-box"\)/);
  assert.match(clientSmoke, /requireProcessStatus\(value\.sync, "processes\.sync", "rclone-sync"\)/);
  assert.match(clientSmoke, /Expected processes\.sync\.metrics\.syncState to be a known state/);
  assert.doesNotMatch(clientSmoke, /function requireSchedulerContract/);
  assert.doesNotMatch(clientSmoke, /function requireHeartbeatContract/);
  assert.doesNotMatch(clientSmoke, /function requireHeartbeatDeviceContract/);
  assert.match(clientSmoke, /function requireReleaseManifestContract/);
  assert.match(clientSmoke, /releaseManifest\.supportDocuments/);
  assert.match(clientSmoke, /releaseManifest\.requiredFiles/);
  assert.match(clientSmoke, /release_manifest_missing/);
  assert.match(clientSmoke, /function requireManifestFileGroup/);
  assert.match(clientSmoke, /type: "client-smoke-report"/);
  assert.match(clientSmoke, /SFSC client smoke JSON report written/);
  assert.match(deployment, /\/api\/health\.diagnostics\.protocols` 与 `\/api\/admin\/state\.diagnostics\.protocols` 完全一致/);
  assert.match(deployment, /`admin-state` 检查输出 `protocols=aligned`/);
  assert.match(deployment, /pnpm run ci:verify/);
  assert.match(deployment, /scripts\/ci-verify\.ps1/);
  assert.match(deployment, /\.github\/workflows\/ci\.yml/);
  assert.match(deployment, /\.github\/workflows\/release\.yml/);
  assert.match(deployment, /pnpm run client:download-binaries/);
  assert.match(deployment, /binaries\.lock\.json/);
  assert.match(deployment, /校验 SHA256/);
  assert.match(deployment, /-SingBoxVersion/);
  assert.match(deployment, /-RcloneVersion/);
  assert.match(deployment, /pnpm run client:desktop-package/);
  assert.match(deployment, /pnpm run client:package/);
  assert.match(deployment, /reports\/release\/preflight\.json/);
  assert.match(deployment, /releaseOk: true/);
  assert.match(deployment, /summary\.skipped == 0/);
  assert.match(deployment, /clientPackageSmokeReports\[\]/);
  assert.match(deployment, /client-package-smoke-desktop\.json/);
  assert.match(deployment, /client-package-smoke-portable\.json/);
  assert.match(deployment, /dist\/release-bundles\/\*\*/);
  assert.match(deployment, /统一交付 bundle/);
  assert.match(deployment, /pnpm run bundle:release/);
  assert.match(deployment, /scripts\/build-release-bundle\.ps1/);
  assert.match(deployment, /release-bundle-manifest\.json/);
  assert.match(deployment, /以 `preflightVerified` 和 `preflightVerification` 作为放行入口/);
  assert.match(deployment, /preflightVerification\.mode/);
  assert.match(deployment, /`preflight` 证据区块/);
  assert.match(deployment, /legacy `strictPreflight` 只表示预检是否由 bundle 脚本本次直接运行/);
  assert.match(deployment, /源报告 SHA256/);
  assert.match(deployment, /dist\/release-bundles\/singbox-folder-sync-<version>-release/);
  assert.match(deployment, /`-SkipPreflight` 只用于测试夹具/);
  assert.match(deployment, /-PreflightReportPath reports\/release\/preflight\.txt -PreflightJsonReportPath reports\/release\/preflight\.json/);
  assert.match(deployment, /run_strict_preflight/);
  assert.match(deployment, /\/api\/health\.diagnostics\.protocols` 与 `\/api\/client\/status\.diagnostics\.protocols` 完全一致/);
  assert.match(deployment, /校验 `\/api\/profile` 返回 `\{ profile: null \}` 或展示安全 profile 摘要/);
  assert.match(contract, /客户端 smoke 必须覆盖 `\/api\/profile` 展示安全合同/);
  assert.match(deployment, /Windows 客户端本地状态恢复/);
  assert.match(deployment, /`profile\.json`、`jobs\.json`、`secrets\.json`、`sync-history\.json` 和 `claim-recovery\.json`/);
  assert.match(deployment, /`local_state_corrupt`/);
  assert.match(deployment, /`secret_vault_missing`/);
  assert.match(deployment, /GET \/api\/diagnostics\/export/);
  assert.match(deployment, /不要在损坏状态上继续保存任务、导入 profile 或运行同步/);
  assert.match(deployment, /`safeguards\.localState\.files\[\]`/);
  assert.match(deployment, /-ReportPath reports\/n1\/deploy\.txt -JsonReportPath reports\/n1\/deploy\.json/);
  assert.match(deployment, /n1-deploy-report/);
  assert.match(deployment, /结构化校验 `ok: true`、`diagnostics\.protocols` 和 `adminAuth\.enabled: true`/);
  assert.match(deployment, /失败信息会指出缺失字段/);
  assert.match(deployment, /-PostDeploySmoke/);
  assert.match(deployment, /-SmokeBaseUrl http:\/\/192\.168\.1\.254:5177/);
  assert.match(deployment, /-SmokeJsonReportPath reports\/n1\/server-smoke\.json/);
  assert.match(deployment, /scripts\/deploy-n1\.ps1 -RollbackLatest/);
  assert.match(deployment, /scripts\/deploy-n1\.ps1 -Apply -RollbackLatest/);
  assert.match(deployment, /source-before-\*\.tgz/);
  assert.match(deployment, /source-before-rollback-\*\.tgz/);
  assert.match(deployment, /rollback-runtime-contracts=not-present-in-backup/);
  assert.match(deployment, /结构化 `\/api\/health` JSON 校验/);
  assert.match(deployment, /rollback-health=passed/);
  assert.match(deployment, /scripts\/post-deploy-n1\.ps1 -Apply/);
  assert.match(deployment, /scripts\/apply-n1-singbox\.ps1 -Apply/);
  assert.match(deployment, /restartRequired=false/);
  assert.match(deployment, /-ReleaseBundleManifestPath dist\/release-bundles\/<bundle>\/release-bundle-manifest\.json/);
  assert.match(deployment, /preflightVerified: true/);
  assert.match(deployment, /versionAlignment\.ok: true/);
  assert.match(deployment, /-AllowUnverifiedReleaseBundle/);
  assert.match(deployment, /failure\.releaseBundlePreflightVerified/);
  assert.match(deployment, /failure\.versionAlignment/);
  assert.match(deployment, /reports\/n1\/<UTC-run-id>\//);
  assert.match(deployment, /post-deploy-summary\.json/);
  assert.match(deployment, /latest-post-deploy\.json/);
  assert.match(deployment, /acceptance\.delivery\.releaseBundle/);
  assert.match(deployment, /bundle 名称、版本、预检摘要、bundle ZIP\/manifest SHA256/);
  assert.match(deployment, /acceptance\.delivery\.releaseBundle\.clientPackages\.desktop/);
  assert.match(deployment, /acceptance\.delivery\.versionAlignment/);
  assert.match(deployment, /n1-post-deploy-report/);
  assert.match(deployment, /deploy JSON 和 server smoke JSON 都 `ok: true`/);
  assert.match(deployment, /context\.adminAuthProvided: true/);
  assert.match(deployment, /不会把真实管理 Token 写入部署 JSON/);
  assert.match(clientHttp, /runClientSmoke/);
  assert.match(clientHttp, /client-smoke-report/);
  assert.match(deploy, /param\(/);
  assert.match(deploy, /\[switch\]\$Apply/);
  assert.match(deploy, /\[switch\]\$BuildArchive/);
  assert.match(deploy, /\[switch\]\$PostDeploySmoke/);
  assert.match(deploy, /\[switch\]\$ExerciseClaimLifecycle/);
  assert.match(deploy, /\[switch\]\$CleanupClaimLifecycle/);
  assert.match(deploy, /\[switch\]\$RollbackLatest/);
  assert.match(deploy, /\[switch\]\$AllowMismatchedSmokeBaseUrl/);
  assert.match(deploy, /\[string\]\$SmokeBaseUrl = "http:\/\/192\.168\.1\.254:5177"/);
  assert.match(deploy, /\[string\]\$ReportPath = ""/);
  assert.match(deploy, /\[string\]\$JsonReportPath = ""/);
  assert.match(deploy, /\[string\]\$SmokeJsonReportPath = ""/);
  assert.match(deploy, /-CleanupClaimLifecycle requires -ExerciseClaimLifecycle/);
  assert.match(deploy, /type = "n1-deploy-report"/);
  assert.match(deploy, /ExerciseClaimLifecycle = \[bool\]\$ExerciseClaimLifecycle/);
  assert.match(deploy, /CleanupClaimLifecycle = \[bool\]\$CleanupClaimLifecycle/);
  assert.match(deploy, /ExerciseClaimLifecycle: \$\(\$context\.ExerciseClaimLifecycle\)/);
  assert.match(deploy, /CleanupClaimLifecycle: \$\(\$context\.CleanupClaimLifecycle\)/);
  assert.match(deploy, /function Write-DeployReport/);
  assert.match(deploy, /function Invoke-PostDeploySmoke/);
  assert.match(deploy, /function Assert-RemoteRootSafe/);
  assert.match(deploy, /function Assert-DeployTargets/);
  assert.match(deploy, /lib\\build-fingerprint\.ps1/);
  assert.match(deploy, /Get-SourceTreeFingerprint \$repoRoot/);
  assert.match(deploy, /SourceTreeHash = \$sourceTreeHash/);
  assert.match(deploy, /BuildId = \$sourceBuildId/);
  assert.match(deploy, /SFSC_BUILD_ID=\$sourceBuildId/);
  assert.match(deploy, /SFSC_BUILD_TIME=\$sourceBuildTime/);
  assert.match(deploy, /deploy-build-id=passed/);
  assert.match(deploy, /RemoteHost and SmokeBaseUrl must point to the same host/);
  assert.match(deploy, /RemoteRoot must be an absolute POSIX path/);
  assert.match(deploy, /if \(-not \$BuildArchive\) \{\s*Run-Step "Build source archive"/);
  assert.doesNotMatch(deploy, /if \(-not \(Test-Path -LiteralPath \$archivePath\)\) \{\s*Run-Step "Build source archive"/);
  assert.match(deploy, /Join-Path \$repoRoot "scripts\\smoke-server\.mjs"/);
  assert.match(deploy, /\$args = @\(\$smokeScript, "--base-url", \$SmokeBaseUrl\)/);
  assert.match(deploy, /"--json-report", \$smokeJsonReport/);
  assert.match(deploy, /Post-deploy server smoke/);
  assert.match(deploy, /Mode: dry-run/);
  assert.match(deploy, /rollback dry-run/);
  assert.match(deploy, /\$localScriptPath = Join-Path \$archiveDir "sfsc-remote-\$scriptId\.sh"/);
  assert.match(deploy, /\$remoteScriptPath = "\/tmp\/sfsc-remote-\$scriptId\.sh"/);
  assert.match(deploy, /UTF8Encoding\]::new\(\$false\)/);
  assert.match(deploy, /TrimStart\(\[char\]0xfeff\)/);
  assert.match(deploy, /Invoke-Scp \$localScriptPath \$remoteScriptPath/);
  assert.match(deploy, /\$RemoteHost "sh" \$remoteScriptPath/);
  assert.match(deploy, /\$RemoteHost "rm" "-f" \$remoteScriptPath/);
  assert.doesNotMatch(deploy, /\$RemoteHost \$command/);
  assert.doesNotMatch(deploy, /RedirectStandardInput = \$true/);
  assert.match(deploy, /deploy health check/);
  assert.match(deploy, /deploy-health=passed/);
  assert.match(deploy, /require_health_field\(\)/);
  assert.match(deploy, /grep -Eq "\$pattern" \/tmp\/sfsc-health\.json/);
  assert.match(deploy, /cat \/tmp\/sfsc-health\.json/);
  assert.match(deploy, /source-before-\*\.tgz/);
  assert.match(deploy, /source-before-rollback-/);
  assert.match(deploy, /rollback-runtime-contracts=not-present-in-backup/);
  assert.match(deploy, /\$rollback_stage\/scripts\/lib\/runtimeContracts\.mjs/);
  assert.match(deploy, /rollback-health=passed/);
  assert.match(deploy, /\/api\/health ok=true missing/);
  assert.match(deploy, /\/api\/health diagnostics missing/);
  assert.match(deploy, /\/api\/health diagnostics\.protocols missing/);
  assert.match(deploy, /\/api\/health adminAuth missing/);
  assert.match(deploy, /\/api\/health adminAuth\.enabled=true missing/);
  assert.doesNotMatch(deploy, /grep -q '"ok"/);
  assert.doesNotMatch(deploy, /grep -q '"diagnostics"/);
  assert.doesNotMatch(deploy, /grep -q '"adminAuth"/);
  assert.match(deploy, /Post-deploy server smoke requires SFSC_ADMIN_TOKEN or ADMIN_TOKEN/);
  assert.match(deploy, /function Show-ArchiveContents/);
  assert.match(deploy, /function Test-ArchiveContents/);
  assert.match(deploy, /Archive validation passed/);
  assert.match(deploy, /Archive validation failed: missing required entry/);
  assert.match(deploy, /Archive validation failed: blocked entry/);
  assert.match(deploy, /server\/docker-compose\.n1\.yml/);
  assert.ok(deploy.includes("'^\\.env$'"));
  assert.match(deploy, /\^server\/data\(\/\|\$\)/);
  assert.match(deploy, /\^server\/sing-box\(\/\|\$\)/);
  assert.match(deploy, /\(\^\|\/\)node_modules\(\/\|\$\)/);
  assert.match(deploy, /\^dist\(\/\|\$\)/);
  assert.ok(deploy.includes("'^\\.tmp(/|$)'"));
  assert.match(deploy, /server\/data/);
  assert.match(deploy, /server\/sing-box/);
  assert.match(deploy, /server\/\.env\.example/);
  assert.match(deploy, /SFSC_ADMIN_TOKEN is missing or empty/);
  assert.doesNotMatch(deploy, /\|\| true/);
  assert.doesNotMatch(deploy, /AdminToken/);
  assert.match(deploy, /lib\\report-secrets\.ps1/);
  assert.match(deploy, /Write-SafeTextReport \$resolvedReportPath \$lines "N1 deploy text report"/);
  assert.match(deploy, /Write-SafeJsonReport \$resolvedJsonReportPath \$payload "N1 deploy JSON report" 6/);
  assert.match(deploy, /Assert-ReportFileSafe \$smokeJsonReport "N1 deploy server smoke report"/);
  assert.match(postDeploy, /\[switch\]\$Apply/);
  assert.match(postDeploy, /\[switch\]\$ExerciseClaimLifecycle/);
  assert.match(postDeploy, /\[switch\]\$CleanupClaimLifecycle/);
  assert.match(postDeploy, /-CleanupClaimLifecycle requires -ExerciseClaimLifecycle/);
  assert.match(postDeploy, /requires SFSC_ADMIN_TOKEN or ADMIN_TOKEN/);
  assert.match(postDeploy, /scripts\\deploy-n1\.ps1/);
  assert.match(postDeploy, /-PostDeploySmoke/);
  assert.match(postDeploy, /if \(\$ExerciseClaimLifecycle\) \{\s*\$deployArgs \+= "-ExerciseClaimLifecycle"\s*\}/);
  assert.match(postDeploy, /if \(\$CleanupClaimLifecycle\) \{\s*\$deployArgs \+= "-CleanupClaimLifecycle"\s*\}/);
  assert.match(postDeploy, /post-deploy-summary\.json/);
  assert.match(postDeploy, /latest-post-deploy\.json/);
  assert.match(postDeploy, /\[string\]\$ReleaseBundleManifestPath = ""/);
  assert.match(postDeploy, /\[string\]\$FinalSmokeJsonPath = ""/);
  assert.match(postDeploy, /\[switch\]\$ReleaseAcceptance/);
  assert.match(postDeploy, /\[string\]\$ClientRealSyncJsonPath/);
  assert.match(postDeploy, /\[string\]\$SsdObjectVerificationJsonPath/);
  assert.match(postDeploy, /\[string\]\$TestDataCleanupJsonPath/);
  assert.match(postDeploy, /\[switch\]\$AllowMismatchedSmokeBaseUrl/);
  assert.match(postDeploy, /\[switch\]\$AllowUnverifiedReleaseBundle/);
  assert.match(postDeploy, /function Get-TargetAlignmentSnapshot/);
  assert.match(postDeploy, /function Assert-RemoteRootSafe/);
  assert.match(postDeploy, /\$deployArgs \+= "-AllowMismatchedSmokeBaseUrl"/);
  assert.match(postDeploy, /targetHostsMatch/);
  assert.match(postDeploy, /releaseBundleManifest/);
  assert.match(postDeploy, /Get-ReleaseBundleSnapshot/);
  assert.match(postDeploy, /Get-ReleaseAcceptanceSnapshot/);
  assert.match(postDeploy, /clientRealSyncVerified/);
  assert.match(postDeploy, /ssdObjectVerified/);
  assert.match(postDeploy, /testDataCleanupVerified/);
  assert.match(postDeploy, /finalRestartClear/);
  assert.match(postDeploy, /finalServerSmokeJson/);
  assert.match(postDeploy, /lifecycleSmokeOk/);
  assert.match(postDeploy, /finalSmokeOk/);
  assert.match(postDeploy, /releaseBundlePreflightVerified/);
  assert.match(postDeploy, /releaseAcceptance/);
  assert.match(postDeploy, /allowUnverifiedReleaseBundle/);
  assert.match(postDeploy, /type = "n1-post-deploy-report"/);
  assert.match(postDeploy, /type = "n1-post-deploy-latest"/);
  assert.match(postDeploy, /smokeAdminAuthProvided/);
  assert.match(postDeploy, /Use -Apply to run N1 deployment, or provide both -DeployJsonPath and -SmokeJsonPath/);
  assert.match(postDeploy, /lib\\report-secrets\.ps1/);
  assert.match(postDeploy, /Write-SafeJsonReport \$path \$payload "N1 post-deploy JSON report" 12/);
  assert.match(postDeploy, /Copy-SafeReport \$source \$destination "N1 post-deploy copied report"/);
  assert.match(bundle, /\[switch\]\$SkipPreflight/);
  assert.match(bundle, /\[string\]\$PreflightReportPath = ""/);
  assert.match(bundle, /\[string\]\$PreflightJsonReportPath = ""/);
  assert.match(bundle, /scripts\\preflight-release\.ps1/);
  assert.match(bundle, /preflightVerified/);
  assert.match(bundle, /preflightVerification/);
  assert.match(bundle, /strictPreflightRanInBundleBuild/);
  assert.match(bundle, /release-bundle-manifest/);
  assert.match(bundle, /preflight = \$preflightEvidence/);
  assert.match(bundle, /Assert-PreflightReleaseOk/);
  assert.match(bundle, /Test-ZipChecksum/);
  assert.match(bundle, /Assert-NoBlockedBundleEntries/);
  assert.match(bundle, /server\/sing-box\/config\\.json/);
  assert.match(bundle, /server\/data/);
  assert.match(bundle, /client\/data/);
  assert.match(bundle, /release-artifacts\/windows-client/);
  assert.match(bundle, /SyncraftDesktop\.zip/);
  assert.match(bundle, /SyncraftClient\.zip/);
  assert.match(bundle, /Compress-Archive/);
  assert.match(bundle, /lib\\report-secrets\.ps1/);
  assert.match(bundle, /Assert-ReportFileSafe \$source "release bundle report \$relativeDestination"/);
  assert.match(bundle, /Assert-StagedReportsSafe/);
  assert.match(bundle, /Write-SafeJsonReport \$bundleManifestPath \$bundleManifest "release bundle manifest" 6/);
  assert.match(preflight, /scripts\/audit-release\.mjs/);
  assert.match(preflight, /SFSC_NODE/);
  assert.match(preflight, /Node\.js not found/);
  assert.match(preflight, /\[switch\]\$SkipTests/);
  assert.match(preflight, /\[switch\]\$AllowSkips/);
  assert.match(preflight, /\[string\]\$ReportPath = ""/);
  assert.match(preflight, /\[string\]\$JsonReportPath = ""/);
  assert.match(preflight, /\$stepResults = @\(\)/);
  assert.match(preflight, /function Add-StepResult/);
  assert.match(preflight, /function Get-StepErrorCode/);
  assert.match(preflight, /function Skip-Step/);
  assert.match(preflight, /function Fail-Step/);
  assert.match(preflight, /function Write-PreflightReport/);
  assert.match(preflight, /function Get-PreflightContext/);
  assert.match(preflight, /function Write-JsonReport/);
  assert.match(preflight, /function Resolve-ReportPath/);
  assert.match(preflight, /function Resolve-ClientPackageJsonReportPath/);
  assert.match(preflight, /Write-SafeTextReport \$resolvedReportPath \$lines "preflight text report"/);
  assert.match(preflight, /Preflight report written/);
  assert.match(preflight, /Preflight JSON report written/);
  assert.match(preflight, /ClientPackageSmokeJsonReportPath/);
  assert.match(preflight, /ClientPackageSmokeJsonReportPaths/);
    assert.match(preflight, /clientPackageSmokeReports/);
    assert.match(preflight, /failureCheck/);
    assert.match(preflight, /releaseOk/);
    assert.match(preflight, /\$summary\.failed -eq 0 -and \$summary\.skipped -eq 0/);
    assert.match(preflight, /function Read-ClientPackageSmokeReports/);
  assert.match(preflight, /client_package_smoke_report_missing/);
  assert.match(preflight, /client_package_smoke_report_invalid/);
  assert.match(preflight, /schemaVersion = 1/);
  assert.match(preflight, /type = "preflight-report"/);
  assert.match(preflight, /lib\\report-secrets\.ps1/);
  assert.match(preflight, /Write-SafeJsonReport \$path \$payload "preflight JSON report" 6/);
  assert.match(preflight, /Preflight report/);
  assert.match(preflight, /GeneratedAt/);
  assert.match(preflight, /RepoRoot/);
  assert.match(preflight, /SkipTests/);
  assert.match(preflight, /AllowSkips/);
  assert.match(preflight, /ReportPath/);
  assert.match(preflight, /DurationSeconds/);
  assert.match(preflight, /errorCode = \$_\.ErrorCode/);
  assert.match(preflight, /preflight_\$\{slug\}_failed/);
  assert.match(preflight, /preflight_step_skipped/);
  assert.match(preflight, /passed/);
  assert.match(preflight, /skipped/);
  assert.match(preflight, /failed/);
  assert.match(preflight, /scripts\/deploy-n1\.ps1/);
  assert.match(preflight, /-BuildArchive/);
  assert.match(preflight, /dist\\SyncraftDesktop/);
  assert.match(preflight, /dist\\SyncraftClient/);
  assert.match(preflight, /client-package-smoke-\$packageName\.json/);
  assert.match(preflight, /Client package smoke/);
  assert.match(preflight, /Built client package not found/);
  assert.match(preflight, /\$AllowSkips -or \$SkipTests/);
  assert.match(preflight, /Client package smoke \(\$\(\$clientPackage\.Name\)\)/);
  assert.match(preflight, /SFSC_CLIENT_PACKAGE_SKIP_LAUNCH=1 is not allowed during strict release preflight/);
  assert.match(preflight, /\$env:SFSC_CLIENT_PACKAGE_SKIP_LAUNCH -eq "1"/);
  assert.match(preflight, /scripts\/smoke-client-package\.mjs/);
  assert.match(preflight, /SFSC_CLIENT_PACKAGE_DIR/);
  assert.match(preflight, /\$hadClientPackageDir = Test-Path Env:SFSC_CLIENT_PACKAGE_DIR/);
  assert.match(preflight, /\$previousClientPackageDir = \$env:SFSC_CLIENT_PACKAGE_DIR/);
  assert.match(preflight, /Remove-Item Env:SFSC_CLIENT_PACKAGE_DIR -ErrorAction SilentlyContinue/);
  assert.match(preflight, /--json-report \$clientPackageJsonReportPath/);
  assert.match(preflight, /client:desktop-package/);
  assert.match(preflight, /client:package/);
  assert.match(preflight, /--test/);
  assert.doesNotMatch(preflight, /-Apply/);
});

test("N1 deploy writes reports without running post-deploy smoke during dry-run or archive validation", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-n1-deploy-report-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "deploy-n1.ps1"),
      await readFile(join(projectRoot, "scripts", "deploy-n1.ps1"), "utf8"),
      "utf8"
    );

    const dryRun = await runDeploy(tempRoot, [
      "-PostDeploySmoke",
      "-ReportPath",
      "reports/deploy.txt",
      "-JsonReportPath",
      "reports/deploy.json"
    ]);
    assert.equal(dryRun.code, 0);
    assert.match(dryRun.stdout, /N1 deploy report written/);
    assert.match(dryRun.stdout, /N1 deploy JSON report written/);
    assert.doesNotMatch(dryRun.stdout, /Post-deploy server smoke/);
    const dryRunReport = JSON.parse(await readFile(join(tempRoot, "reports", "deploy.json"), "utf8"));
    assert.equal(dryRunReport.schemaVersion, 1);
    assert.equal(dryRunReport.type, "n1-deploy-report");
    assert.equal(dryRunReport.ok, true);
    assert.equal(dryRunReport.context.Apply, false);
    assert.equal(dryRunReport.context.BuildArchive, false);
    assert.equal(dryRunReport.context.PostDeploySmoke, true);
    assert.equal(dryRunReport.summary.failed, 0);
    assert.deepEqual(
      dryRunReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [["Plan", "passed", ""]]
    );

    const rollbackDryRun = await runDeploy(tempRoot, [
      "-RollbackLatest",
      "-PostDeploySmoke",
      "-ReportPath",
      "reports/rollback.txt",
      "-JsonReportPath",
      "reports/rollback.json"
    ]);
    assert.equal(rollbackDryRun.code, 0);
    assert.match(rollbackDryRun.stdout, /rollback dry-run/);
    assert.doesNotMatch(rollbackDryRun.stdout, /Rolling back N1 source/);
    assert.doesNotMatch(rollbackDryRun.stdout, /Post-rollback server smoke/);
    const rollbackDryRunReport = JSON.parse(await readFile(join(tempRoot, "reports", "rollback.json"), "utf8"));
    assert.equal(rollbackDryRunReport.type, "n1-deploy-report");
    assert.equal(rollbackDryRunReport.ok, true);
    assert.equal(rollbackDryRunReport.context.Apply, false);
    assert.equal(rollbackDryRunReport.context.RollbackLatest, true);
    assert.equal(rollbackDryRunReport.context.PostDeploySmoke, true);
    assert.deepEqual(
      rollbackDryRunReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [["Plan", "passed", ""]]
    );

    for (const rel of [
      "package.json",
      "src/server.js",
      "src/core/index.js",
      "public/index.html",
      "public/app.js",
      "public/styles.css",
      "server/Dockerfile",
      "server/sing-box.Dockerfile",
      "server/sing-box-supervisor.sh",
      "server/.env.example",
      "server/Caddyfile",
      "server/sfscctl",
      "server/docker-compose.yml",
      "server/docker-compose.n1.yml"
    ]) {
      await mkdir(join(tempRoot, ...rel.split("/").slice(0, -1)), { recursive: true });
      await writeFile(join(tempRoot, ...rel.split("/")), "ok\n", "utf8");
    }
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      "console.error('post-deploy smoke should not run without -Apply'); process.exit(31);\n",
      "utf8"
    );
    await mkdir(join(tempRoot, "scripts", "lib"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      "export function assertRuntimeDiagnosticsContract() {}\nexport function assertServerDeviceSummaryContract() {}\n",
      "utf8"
    );

    const archiveRun = await runDeploy(tempRoot, [
      "-BuildArchive",
      "-PostDeploySmoke",
      "-SmokeBaseUrl",
      "http://example.invalid:5177",
      "-SmokeJsonReportPath",
      "reports/n1/server-smoke.json",
      "-ReportPath",
      "reports/n1/deploy.txt",
      "-JsonReportPath",
      "reports/n1/deploy.json"
    ]);
    assert.equal(archiveRun.code, 0);
    assert.match(archiveRun.stdout, /Archive validation passed/);
    assert.doesNotMatch(archiveRun.stdout, /post-deploy smoke should not run/);
    await assert.rejects(
      readFile(join(tempRoot, "reports", "n1", "server-smoke.json"), "utf8"),
      /ENOENT/
    );

    const archiveReport = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "deploy.json"), "utf8"));
    assert.equal(archiveReport.ok, true);
    assert.equal(archiveReport.context.Apply, false);
    assert.equal(archiveReport.context.BuildArchive, true);
    assert.equal(archiveReport.context.PostDeploySmoke, true);
    assert.equal(archiveReport.context.SmokeBaseUrl, "http://example.invalid:5177");
    assert.match(archiveReport.context.SmokeJsonReportPath, /reports[\\/]n1[\\/]server-smoke\.json$/);
    assert.equal(archiveReport.summary.passed, 4);
    assert.equal(archiveReport.summary.failed, 0);
    assert.deepEqual(
      archiveReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [
        ["Plan", "passed", ""],
        ["Build source archive", "passed", ""],
        ["List archive contents", "passed", ""],
        ["Archive validation", "passed", ""]
      ]
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("N1 sing-box apply writes a dry-run report without remote changes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-n1-apply-report-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "apply-n1-singbox.ps1"),
      await readFile(join(projectRoot, "scripts", "apply-n1-singbox.ps1"), "utf8"),
      "utf8"
    );

    const dryRun = await runApply(tempRoot, [
      "-ReportPath",
      "reports/apply.txt",
      "-JsonReportPath",
      "reports/apply.json"
    ]);
    assert.equal(dryRun.code, 0, dryRun.stderr || dryRun.stdout);
    assert.match(dryRun.stdout, /Dry-run mode only writes the apply plan report/);
    assert.match(dryRun.stdout, /N1 sing-box apply JSON report written/);
    assert.doesNotMatch(dryRun.stdout, /restart sing-box/);
    const report = JSON.parse(await readFile(join(tempRoot, "reports", "apply.json"), "utf8"));
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.app, "singbox-folder-sync");
    assert.equal(report.type, "n1-singbox-apply-report");
    assert.equal(report.ok, true);
    assert.equal(report.context.apply, false);
    assert.equal(report.context.adminAuthProvided, false);
    assert.equal(report.context.remoteHostName, "192.168.1.254");
    assert.equal(report.context.smokeBaseUrlHost, "192.168.1.254");
    assert.equal(report.context.targetHostsMatch, true);
    assert.equal(report.context.allowMismatchedSmokeBaseUrl, false);
    assert.equal(report.summary.remoteRestarted, false);
    assert.equal(report.summary.markApplied, false);
    assert.equal(report.summary.preRestartRequired, null);
    assert.equal(report.summary.postRestartRequired, null);
    assert.deepEqual(
      report.steps.map((step) => [step.Name, step.Status, step.ErrorCode]),
      [["Plan N1 sing-box apply", "passed", ""]]
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("N1 sing-box apply rejects mismatched remote and smoke targets before remote changes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-n1-apply-target-mismatch-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "apply-n1-singbox.ps1"),
      await readFile(join(projectRoot, "scripts", "apply-n1-singbox.ps1"), "utf8"),
      "utf8"
    );

    const result = await runApply(tempRoot, [
      "-SmokeBaseUrl",
      "http://127.0.0.1:5177",
      "-JsonReportPath",
      "reports/apply.json"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /RemoteHost and SmokeBaseUrl must point to the same host/);
    assert.doesNotMatch(result.stdout, /restart sing-box/);

    const report = JSON.parse(await readFile(join(tempRoot, "reports", "apply.json"), "utf8"));
    assert.equal(report.ok, false);
    assert.equal(report.context.apply, false);
    assert.equal(report.context.remoteHostName, "192.168.1.254");
    assert.equal(report.context.smokeBaseUrlHost, "127.0.0.1");
    assert.equal(report.context.targetHostsMatch, false);
    assert.deepEqual(
      report.steps.map((step) => [step.Name, step.Status, step.ErrorCode]),
      [["Plan N1 sing-box apply", "failed", "apply_n1_plan_n1_sing_box_apply_failed"]]
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("N1 post-deploy aggregator writes summary and latest pointer from existing reports", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-n1-postdeploy-"));
  try {
    await writeReleaseBundleFixture(tempRoot);
    await writeFakePreflightReports(tempRoot);
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "post-deploy-n1.ps1"),
      await readFile(join(projectRoot, "scripts", "post-deploy-n1.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ version: "0.3.0-rc.1" }), "utf8");
    await mkdir(join(tempRoot, "server"), { recursive: true });
    await writeFile(
      join(tempRoot, "server", ".env.example"),
      [
        "SING_BOX_IMAGE_TAG=v1.13.14",
        "MINIO_IMAGE_TAG=RELEASE.2025-09-07T16-13-09Z",
        "MINIO_MC_IMAGE_TAG=RELEASE.2025-08-13T08-35-41Z",
        ""
      ].join("\n"),
      "utf8"
    );
    await refreshFakeReleaseBatch(tempRoot);
    await writeFakePreflightReports(tempRoot);
    const bundleResult = await runReleaseBundle(tempRoot, [
      "-SkipPreflight",
      "-PreflightReportPath",
      "reports/release/preflight.txt",
      "-PreflightJsonReportPath",
      "reports/release/preflight.json",
      "-OutputDir",
      "dist/release-bundles",
      "-BundleName",
      "fixture-release"
    ]);
    assert.equal(bundleResult.code, 0, bundleResult.stderr || bundleResult.stdout);
    const fixtureReleaseManifest = JSON.parse(await readFile(
      join(tempRoot, "dist", "release-bundles", "fixture-release", "release-bundle-manifest.json"),
      "utf8"
    ));
    const evidenceBuildId = fixtureReleaseManifest.buildId;
    const evidenceSourceTreeHash = fixtureReleaseManifest.sourceTreeHash;
    const desktopReleaseManifestPath = join(
      tempRoot,
      "dist",
      "release-bundles",
      "fixture-release",
      "release-artifacts",
      "windows-client",
      "SyncraftDesktop.release-manifest.json"
    );
    const desktopReleaseManifestBytes = await readFile(desktopReleaseManifestPath);
    const desktopReleaseManifest = JSON.parse(desktopReleaseManifestBytes.toString("utf8"));
    const desktopExecutableSha256 = desktopReleaseManifest.files.find(
      (entry) => entry.name === "Syncraft.exe"
    ).sha256;
    const desktopReleaseManifestSha256 = createHash("sha256").update(desktopReleaseManifestBytes).digest("hex");
    const desktopPackageZipSha256 = createHash("sha256").update(await readFile(join(
      tempRoot,
      "dist",
      "release-bundles",
      "fixture-release",
      "release-artifacts",
      "windows-client",
      "SyncraftDesktop.zip"
    ))).digest("hex");
    await mkdir(join(tempRoot, "input"), { recursive: true });
    await writeFile(join(tempRoot, "input", "deploy.json"), JSON.stringify({
      schemaVersion: 1,
      type: "n1-deploy-report",
      ok: true,
      context: { RemoteHost: "root@n1", RemoteRoot: "/opt/sfsc-test", PostDeploySmoke: true },
      summary: { passed: 7, failed: 0 },
      steps: []
    }), "utf8");
    await writeFile(join(tempRoot, "input", "server-smoke.json"), JSON.stringify({
      schemaVersion: 1,
      type: "server-smoke-report",
      ok: true,
      context: {
        baseUrl: "http://n1:5177",
        adminAuthProvided: true,
        requestTimeoutMs: 15000,
        exerciseClaimLifecycle: true,
        claimLifecycleClientName: "sfsc-smoke-client-fixture",
        claimLifecycleDeviceName: "sfsc-smoke-device-fixture",
        cleanupClaimLifecycle: true,
        cleanupClaimLifecycleUserDeleted: true,
        cleanupClaimLifecycleClaimRetained: true,
        cleanupClaimLifecycleRestartRequired: true
      },
      summary: {
        passed: 6,
        failed: 0,
        appVersion: "0.3.0-rc.1",
        buildId: evidenceBuildId,
        protocolsAligned: true,
        restartRequired: false,
        userCount: 1,
        deviceCount: 1,
        claimCount: 2
      },
      checks: [
        { name: "health", detail: "ok=true, version=0.3.0-rc.1, protocol=1, adminAuth=true, timeout=15000ms" },
        { name: "admin-state", detail: "version=0.3.0-rc.1, protocols=aligned, users=1, devices=1, claims=2, restartRequired=false" },
        { name: "singbox-config", detail: "inbounds=1" }
      ]
    }), "utf8");
    await writeFile(join(tempRoot, "input", "client-real-sync.json"), JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      type: "client-trial-runner-report",
      ok: true,
      mode: "real-sync",
      context: {
        dryRun: false,
        runSync: true,
        clientPackage: {
          packageType: "desktop",
          package: "SyncraftDesktop",
          version: "0.3.0-rc.1",
          buildId: evidenceBuildId,
          sourceTreeHash: evidenceSourceTreeHash,
          executableSha256: desktopExecutableSha256,
          releaseManifestSha256: desktopReleaseManifestSha256,
          packageZipSha256: desktopPackageZipSha256
        }
      },
      summary: { passed: 9, failed: 0 },
      checks: []
    }), "utf8");
    await writeFile(join(tempRoot, "input", "ssd-object-verification.json"), JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      type: "n1-ssd-object-verification",
      ok: true,
      buildId: evidenceBuildId,
      expectedSize: 34,
      actualSize: 34,
      expectedSha256: "4".repeat(64),
      actualSha256: "4".repeat(64),
      minioMountSource: "/ssd/sfsc-test/minio",
      minioContainerPath: "/data"
    }), "utf8");
    await writeFile(join(tempRoot, "input", "test-data-cleanup.json"), JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      type: "n1-test-data-cleanup-report",
      ok: true,
      buildId: evidenceBuildId,
      version: "0.3.0-rc.1",
      remainingTestUsers: 0,
      remainingTestClaims: 0,
      remainingTestObjectPrefixes: 0,
      restartRequired: false,
      minioMountSource: "/ssd/sfsc-test/minio",
      minioTrashBytes: 0,
      unexpectedSfscContainers: []
    }), "utf8");

    const result = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-run",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke.json",
      "-ReleaseBundleManifestPath",
      "dist/release-bundles/fixture-release/release-bundle-manifest.json"
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /N1 post-deploy summary written/);
    const summary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-run", "post-deploy-summary.json"), "utf8"));
    assert.equal(summary.schemaVersion, 1);
    assert.equal(summary.type, "n1-post-deploy-report");
    assert.equal(summary.ok, true);
    assert.equal(summary.runId, "fixture-run");
    assert.equal(summary.deploy.ok, true);
    assert.equal(summary.serverSmoke.ok, true);
    assert.equal(summary.failure, null);
    assert.equal(summary.target.remoteHost, "root@n1");
    assert.equal(summary.target.remoteRoot, "/opt/sfsc-test");
    assert.equal(summary.target.smokeBaseUrl, "http://n1:5177");
    assert.equal(summary.target.remoteHostName, "n1");
    assert.equal(summary.target.smokeBaseUrlHost, "n1");
    assert.equal(summary.target.targetHostsMatch, true);
    assert.equal(summary.target.allowMismatchedSmokeBaseUrl, false);
    assert.equal(summary.acceptance.ok, true);
    assert.equal(summary.acceptance.releaseAcceptance.enabled, false);
    assert.equal(summary.acceptance.releaseAcceptance.ok, true);
    assert.equal(summary.acceptance.releaseAcceptance.releaseBundleProvided, true);
    assert.equal(summary.acceptance.releaseAcceptance.finalRestartClear, true);
    assert.equal(summary.acceptance.delivery.appVersion, "0.3.0-rc.1");
    assert.equal(summary.acceptance.delivery.releaseBundle.name, "fixture-release");
    assert.equal(summary.acceptance.delivery.releaseBundle.version, "0.3.0-rc.1");
    assert.equal(summary.acceptance.delivery.releaseBundle.preflightVerified, true);
    assert.equal(summary.acceptance.delivery.releaseBundle.preflightVerification.mode, "external");
    assert.equal(summary.acceptance.delivery.releaseBundle.sourceManifest.sha256, createHash("sha256").update(await readFile(join(tempRoot, "dist", "release-bundles", "fixture-release", "release-bundle-manifest.json"))).digest("hex"));
    assert.equal(summary.acceptance.delivery.releaseBundle.bundledManifest.sha256, createHash("sha256").update(await readFile(join(tempRoot, "reports", "n1", "fixture-run", "release-bundle-manifest.json"))).digest("hex"));
    assert.equal(summary.acceptance.delivery.releaseBundle.bundleZip.sha256, createHash("sha256").update(await readFile(join(tempRoot, "dist", "release-bundles", "fixture-release.zip"))).digest("hex"));
    assert.match(summary.acceptance.delivery.releaseBundle.desktopZip.sha256, /^[a-f0-9]{64}$/);
    assert.match(summary.acceptance.delivery.releaseBundle.portableManifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(summary.acceptance.delivery.releaseBundle.clientPackages.desktop.package, "SyncraftDesktop");
    assert.equal(summary.acceptance.delivery.releaseBundle.clientPackages.desktop.version, "0.3.0-rc.1");
    assert.equal(summary.acceptance.delivery.releaseBundle.clientPackages.desktop.fileCount, 1);
    assert.match(summary.acceptance.delivery.releaseBundle.clientPackages.desktop.zip.sha256, /^[a-f0-9]{64}$/);
    assert.match(summary.acceptance.delivery.releaseBundle.clientPackages.desktop.checksum.sha256, /^[a-f0-9]{64}$/);
    assert.match(summary.acceptance.delivery.releaseBundle.clientPackages.desktop.manifest.sha256, /^[a-f0-9]{64}$/);
    assert.equal(summary.acceptance.delivery.releaseBundle.clientPackages.portable.package, "SyncraftClient");
    assert.equal(summary.acceptance.delivery.releaseBundle.clientPackages.portable.version, "0.3.0-rc.1");
    assert.equal(summary.acceptance.delivery.versionAlignment.ok, true);
    assert.equal(summary.acceptance.delivery.versionAlignment.appVersion, "0.3.0-rc.1");
    assert.equal(summary.acceptance.delivery.versionAlignment.releaseBundleVersion, "0.3.0-rc.1");
    assert.equal(summary.acceptance.delivery.versionAlignment.desktopVersion, "0.3.0-rc.1");
    assert.equal(summary.acceptance.delivery.versionAlignment.portableVersion, "0.3.0-rc.1");
    assert.equal(summary.acceptance.delivery.sourceAlignment.n1BuildId, evidenceBuildId);
    assert.equal(summary.acceptance.delivery.sourceAlignment.n1BuildMatches, true);
    assert.equal(summary.acceptance.delivery.images.singBox.tag, "v1.13.14");
    assert.equal(summary.acceptance.delivery.images.minio.tag, "RELEASE.2025-09-07T16-13-09Z");
    assert.equal(summary.acceptance.delivery.images.minioClient.tag, "RELEASE.2025-08-13T08-35-41Z");
    assert.equal(summary.acceptance.target.remoteHost, "root@n1");
    assert.equal(summary.acceptance.target.remoteRoot, "/opt/sfsc-test");
    assert.equal(summary.acceptance.target.smokeBaseUrl, "http://n1:5177");
    assert.equal(summary.acceptance.target.remoteHostName, "n1");
    assert.equal(summary.acceptance.target.smokeBaseUrlHost, "n1");
    assert.equal(summary.acceptance.target.targetHostsMatch, true);
    assert.equal(summary.acceptance.target.allowMismatchedSmokeBaseUrl, false);
    assert.equal(summary.acceptance.deploy.postDeploySmoke, true);
    assert.equal(summary.acceptance.smoke.adminAuthProvided, true);
    assert.equal(summary.acceptance.smoke.requestTimeoutMs, 15000);
    assert.equal(summary.acceptance.smoke.protocols.aligned, true);
    assert.match(summary.acceptance.smoke.protocols.adminStateDetail, /protocols=aligned/);
    assert.equal(summary.acceptance.smoke.state.appVersion, "0.3.0-rc.1");
    assert.equal(summary.acceptance.smoke.state.restartRequired, false);
    assert.equal(summary.acceptance.smoke.state.userCount, 1);
    assert.equal(summary.acceptance.smoke.state.deviceCount, 1);
    assert.equal(summary.acceptance.smoke.state.claimCount, 2);
    assert.equal(summary.acceptance.smoke.lifecycle.exercised, true);
    assert.equal(summary.acceptance.smoke.lifecycle.clientName, "sfsc-smoke-client-fixture");
    assert.equal(summary.acceptance.smoke.lifecycle.deviceName, "sfsc-smoke-device-fixture");
    assert.equal(summary.acceptance.smoke.lifecycle.cleanupRequested, true);
    assert.equal(summary.acceptance.smoke.lifecycle.cleanupUserDeleted, true);
    assert.equal(summary.acceptance.smoke.lifecycle.cleanupClaimRetained, true);
    assert.equal(summary.acceptance.smoke.lifecycle.cleanupRestartRequired, true);
    assert.deepEqual(summary.acceptance.smoke.checks.names, ["health", "admin-state", "singbox-config"]);
    assert.equal(summary.acceptance.smoke.checks.count, 3);
    assert.equal(summary.reports.deployJson.endsWith("deploy.json"), true);
    assert.equal(summary.reports.serverSmokeJson.endsWith("server-smoke.json"), true);
    assert.equal(summary.reports.releaseBundleManifest.endsWith("release-bundle-manifest.json"), true);
    const latest = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "latest-post-deploy.json"), "utf8"));
    assert.equal(latest.type, "n1-post-deploy-latest");
    assert.equal(latest.ok, true);
    assert.equal(latest.runId, "fixture-run");
    assert.equal(latest.acceptance.target.targetHostsMatch, true);
    assert.equal(latest.acceptance.delivery.releaseBundle.name, "fixture-release");
    assert.equal(latest.acceptance.delivery.versionAlignment.ok, true);
    assert.equal(latest.acceptance.delivery.images.minio.tag, "RELEASE.2025-09-07T16-13-09Z");
    assert.equal(latest.acceptance.smoke.state.claimCount, 2);
    assert.equal(latest.acceptance.smoke.lifecycle.clientName, "sfsc-smoke-client-fixture");
    assert.equal(latest.acceptance.smoke.lifecycle.cleanupUserDeleted, true);
    assert.deepEqual(latest.acceptance.smoke.checks.names, ["health", "admin-state", "singbox-config"]);

    const printed = await runPostDeploy(tempRoot, [
      "-ReportRoot",
      "reports/n1",
      "-PrintLatest"
    ]);
    assert.equal(printed.code, 0, printed.stderr || printed.stdout);
    assert.match(printed.stdout, /N1 latest post-deploy summary/);
    assert.match(printed.stdout, /RunId: fixture-run/);
    assert.match(printed.stdout, /Ok: True/);
    assert.match(printed.stdout, /Target: root@n1 \/opt\/sfsc-test http:\/\/n1:5177/);
    assert.match(printed.stdout, /ReleaseBundle: fixture-release/);
    assert.match(printed.stdout, /ClientPackages: desktop=0\.3\.0-rc\.1, portable=0\.3\.0-rc\.1/);
    assert.match(printed.stdout, /VersionAlignment: True/);
    assert.match(printed.stdout, /Images: sing-box=v1\.13\.14/);
    assert.match(printed.stdout, /SmokeState: restartRequired=False, users=1, devices=1, claims=2/);
    assert.match(printed.stdout, /SmokeLifecycle: exercised=True, client=sfsc-smoke-client-fixture, device=sfsc-smoke-device-fixture, cleanupRequested=True, cleanupUserDeleted=True, cleanupClaimRetained=True/);
    assert.match(printed.stdout, /ProtocolsAligned: True/);
    assert.match(printed.stdout, /Checks: health, admin-state, singbox-config/);

    const releaseAcceptance = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-release-acceptance",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke.json",
      "-ReleaseBundleManifestPath",
      "dist/release-bundles/fixture-release/release-bundle-manifest.json",
      "-ClientRealSyncJsonPath",
      "input/client-real-sync.json",
      "-SsdObjectVerificationJsonPath",
      "input/ssd-object-verification.json",
      "-TestDataCleanupJsonPath",
      "input/test-data-cleanup.json",
      "-ReleaseAcceptance"
    ]);
    const releaseAcceptancePath = join(tempRoot, "reports", "n1", "fixture-release-acceptance", "post-deploy-summary.json");
    const releaseAcceptanceFailure = releaseAcceptance.code === 0
      ? ""
      : await readFile(releaseAcceptancePath, "utf8").catch(() => releaseAcceptance.stderr || releaseAcceptance.stdout);
    assert.equal(releaseAcceptance.code, 0, releaseAcceptanceFailure);
    const releaseAcceptanceSummary = JSON.parse(await readFile(releaseAcceptancePath, "utf8"));
    assert.equal(releaseAcceptanceSummary.ok, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.enabled, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.releaseBundleRequired, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.releaseBundleProvided, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.lifecycleRequired, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.lifecycleExercised, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.cleanupRequired, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.cleanupRequested, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.cleanupUserDeleted, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.cleanupClaimRetained, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.finalRestartClear, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.clientRealSyncVerified, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.ssdObjectVerified, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.testDataCleanupVerified, true);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.evidence.clientRealSync.source.sha256.length, 64);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.evidence.clientRealSync.artifactHashesAligned, true);
    assert.deepEqual(
      releaseAcceptanceSummary.acceptance.releaseAcceptance.evidence.clientRealSync.releaseBundleArtifactHashes,
      {
        executableSha256: desktopExecutableSha256,
        releaseManifestSha256: desktopReleaseManifestSha256,
        packageZipSha256: desktopPackageZipSha256
      }
    );
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.evidence.clientRealSync.clientPackage.executableSha256, desktopExecutableSha256);
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.evidence.ssdObjectVerification.minioMountSource, "/ssd/sfsc-test/minio");
    assert.equal(releaseAcceptanceSummary.acceptance.releaseAcceptance.evidence.testDataCleanup.remainingTestUsers, 0);

    const validClientRealSync = JSON.parse(await readFile(join(tempRoot, "input", "client-real-sync.json"), "utf8"));
    for (const field of ["executableSha256", "releaseManifestSha256", "packageZipSha256"]) {
      const mismatchedClientRealSync = structuredClone(validClientRealSync);
      mismatchedClientRealSync.context.clientPackage[field] = "f".repeat(64);
      const mismatchedEvidencePath = join(tempRoot, "input", `client-real-sync-mismatched-${field}.json`);
      await writeFile(mismatchedEvidencePath, JSON.stringify(mismatchedClientRealSync), "utf8");
      const mismatchedArtifactHash = await runPostDeploy(tempRoot, [
        "-RunId",
        `fixture-release-acceptance-mismatched-${field}`,
        "-ReportRoot",
        "reports/n1",
        "-DeployJsonPath",
        "input/deploy.json",
        "-SmokeJsonPath",
        "input/server-smoke.json",
        "-ReleaseBundleManifestPath",
        "dist/release-bundles/fixture-release/release-bundle-manifest.json",
        "-ClientRealSyncJsonPath",
        `input/client-real-sync-mismatched-${field}.json`,
        "-SsdObjectVerificationJsonPath",
        "input/ssd-object-verification.json",
        "-TestDataCleanupJsonPath",
        "input/test-data-cleanup.json",
        "-ReleaseAcceptance"
      ]);
      assert.notEqual(mismatchedArtifactHash.code, 0, `${field} mismatch must fail ReleaseAcceptance`);
      const mismatchedArtifactHashSummary = JSON.parse(await readFile(
        join(tempRoot, "reports", "n1", `fixture-release-acceptance-mismatched-${field}`, "post-deploy-summary.json"),
        "utf8"
      ));
      assert.equal(mismatchedArtifactHashSummary.ok, false);
      assert.equal(mismatchedArtifactHashSummary.failure.releaseAcceptance.clientRealSyncVerified, false);
      assert.equal(
        mismatchedArtifactHashSummary.failure.releaseAcceptance.evidence.clientRealSync.artifactHashesAligned,
        false
      );
    }

    const releaseAcceptanceMissingBundle = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-release-acceptance-missing-bundle",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke.json",
      "-ReleaseAcceptance"
    ]);
    assert.notEqual(releaseAcceptanceMissingBundle.code, 0);
    assert.match(releaseAcceptanceMissingBundle.stderr, /N1 post-deploy verification failed/);
    const missingBundleSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-release-acceptance-missing-bundle", "post-deploy-summary.json"), "utf8"));
    assert.equal(missingBundleSummary.ok, false);
    assert.equal(missingBundleSummary.failure.releaseAcceptance.enabled, true);
    assert.equal(missingBundleSummary.failure.releaseAcceptance.releaseBundleProvided, false);
    assert.equal(missingBundleSummary.failure.releaseAcceptance.lifecycleExercised, true);
    assert.equal(missingBundleSummary.failure.releaseAcceptance.finalRestartClear, true);
    assert.equal(missingBundleSummary.failure.releaseAcceptance.clientRealSyncVerified, false);
    assert.equal(missingBundleSummary.failure.releaseAcceptance.ssdObjectVerified, false);
    assert.equal(missingBundleSummary.failure.releaseAcceptance.testDataCleanupVerified, false);

    await writeFile(join(tempRoot, "input", "server-smoke-lifecycle-restart-required.json"), JSON.stringify({
      schemaVersion: 1,
      type: "server-smoke-report",
      ok: true,
      context: {
        baseUrl: "http://n1:5177",
        adminAuthProvided: true,
        requestTimeoutMs: 15000,
        exerciseClaimLifecycle: true,
        claimLifecycleClientName: "sfsc-smoke-client-fixture",
        claimLifecycleDeviceName: "sfsc-smoke-device-fixture",
        cleanupClaimLifecycle: true,
        cleanupClaimLifecycleUserDeleted: true,
        cleanupClaimLifecycleClaimRetained: true,
        cleanupClaimLifecycleRestartRequired: true
      },
      summary: {
        passed: 6,
        failed: 0,
        appVersion: "0.3.0-rc.1",
        buildId: evidenceBuildId,
        protocolsAligned: true,
        restartRequired: true,
        userCount: 1,
        deviceCount: 1,
        claimCount: 2
      },
      checks: [
        { name: "health", detail: "ok=true, version=0.3.0-rc.1, protocol=1, adminAuth=true, timeout=15000ms" },
        { name: "admin-state", detail: "version=0.3.0-rc.1, protocols=aligned, users=1, devices=1, claims=2, restartRequired=true" }
      ]
    }), "utf8");
    await writeFile(join(tempRoot, "input", "server-smoke-final.json"), JSON.stringify({
      schemaVersion: 1,
      type: "server-smoke-report",
      ok: true,
      context: { baseUrl: "http://n1:5177", adminAuthProvided: true, requestTimeoutMs: 15000 },
      summary: {
        passed: 10,
        failed: 0,
        appVersion: "0.3.0-rc.1",
        buildId: evidenceBuildId,
        protocolsAligned: true,
        restartRequired: false,
        userCount: 1,
        deviceCount: 1,
        claimCount: 2
      },
      checks: [
        { name: "health", detail: "ok=true, version=0.3.0-rc.1, protocol=1, adminAuth=true, timeout=15000ms" },
        { name: "admin-state", detail: "version=0.3.0-rc.1, protocols=aligned, users=1, devices=1, claims=2, restartRequired=false" },
        { name: "singbox-config", detail: "inbounds=1" }
      ]
    }), "utf8");
    const releaseAcceptanceWithFinalSmoke = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-release-acceptance-final-smoke",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke-lifecycle-restart-required.json",
      "-FinalSmokeJsonPath",
      "input/server-smoke-final.json",
      "-ReleaseBundleManifestPath",
      "dist/release-bundles/fixture-release/release-bundle-manifest.json",
      "-ClientRealSyncJsonPath",
      "input/client-real-sync.json",
      "-SsdObjectVerificationJsonPath",
      "input/ssd-object-verification.json",
      "-TestDataCleanupJsonPath",
      "input/test-data-cleanup.json",
      "-ReleaseAcceptance"
    ]);
    assert.equal(releaseAcceptanceWithFinalSmoke.code, 0, releaseAcceptanceWithFinalSmoke.stderr || releaseAcceptanceWithFinalSmoke.stdout);
    const finalSmokeSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-release-acceptance-final-smoke", "post-deploy-summary.json"), "utf8"));
    assert.equal(finalSmokeSummary.ok, true);
    assert.equal(finalSmokeSummary.reports.serverSmokeJson.endsWith("server-smoke.json"), true);
    assert.equal(finalSmokeSummary.reports.finalServerSmokeJson.endsWith("final-server-smoke.json"), true);
    assert.equal(finalSmokeSummary.serverSmoke.summary.restartRequired, true);
    assert.equal(finalSmokeSummary.finalServerSmoke.summary.restartRequired, false);
    assert.equal(finalSmokeSummary.acceptance.smoke.lifecycle.exercised, true);
    assert.equal(finalSmokeSummary.acceptance.smoke.lifecycle.cleanupRequested, true);
    assert.equal(finalSmokeSummary.acceptance.smoke.lifecycle.cleanupUserDeleted, true);
    assert.equal(finalSmokeSummary.acceptance.smoke.state.restartRequired, false);
    assert.equal(finalSmokeSummary.acceptance.smoke.lifecycleSmokeOk, true);
    assert.equal(finalSmokeSummary.acceptance.smoke.finalSmokeOk, true);
    assert.equal(finalSmokeSummary.acceptance.releaseAcceptance.finalRestartClear, true);

    await writeFile(join(tempRoot, "input", "server-smoke-wrong-target.json"), JSON.stringify({
      schemaVersion: 1,
      type: "server-smoke-report",
      ok: true,
      context: { baseUrl: "http://other-n1:5177", adminAuthProvided: true },
      summary: { passed: 6, failed: 0, buildId: evidenceBuildId },
      checks: []
    }), "utf8");
    const mismatchedTarget = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-target-mismatch",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke-wrong-target.json"
    ]);
    assert.notEqual(mismatchedTarget.code, 0);
    assert.match(mismatchedTarget.stderr, /N1 post-deploy verification failed/);
    const mismatchedTargetSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-target-mismatch", "post-deploy-summary.json"), "utf8"));
    assert.equal(mismatchedTargetSummary.ok, false);
    assert.equal(mismatchedTargetSummary.failure.target.remoteHostName, "n1");
    assert.equal(mismatchedTargetSummary.failure.target.smokeBaseUrlHost, "other-n1");
    assert.equal(mismatchedTargetSummary.failure.target.targetHostsMatch, false);

    await writeFile(join(tempRoot, "input", "server-smoke-restart-required.json"), JSON.stringify({
      schemaVersion: 1,
      type: "server-smoke-report",
      ok: true,
      context: { baseUrl: "http://n1:5177", adminAuthProvided: true, requestTimeoutMs: 15000 },
      summary: { passed: 6, failed: 0, restartRequired: true },
      checks: [
        { name: "admin-state", detail: "version=0.3.0-rc.1, protocols=aligned, users=1, devices=1, claims=2, restartRequired=true" }
      ]
    }), "utf8");
    const restartRequired = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-restart-required",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke-restart-required.json"
    ]);
    assert.notEqual(restartRequired.code, 0);
    assert.match(restartRequired.stderr, /N1 post-deploy verification failed/);
    const restartRequiredSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-restart-required", "post-deploy-summary.json"), "utf8"));
    assert.equal(restartRequiredSummary.ok, false);
    assert.equal(restartRequiredSummary.failure.releaseAcceptance.enabled, false);
    assert.equal(restartRequiredSummary.failure.releaseAcceptance.restartRequired, true);
    assert.equal(restartRequiredSummary.failure.releaseAcceptance.finalRestartClear, false);

    await writeFile(join(tempRoot, "input", "server-smoke-failed.json"), JSON.stringify({
      schemaVersion: 1,
      type: "server-smoke-report",
      ok: false,
      context: { baseUrl: "http://n1:5177", adminAuthProvided: true },
      summary: { passed: 1, failed: 1 },
      failure: { check: "admin-state", message: "bad state" }
    }), "utf8");
    const failed = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-failed",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke-failed.json"
    ]);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /N1 post-deploy verification failed/);
    const failedSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-failed", "post-deploy-summary.json"), "utf8"));
    assert.equal(failedSummary.ok, false);
    assert.equal(failedSummary.failure.deployOk, true);
    assert.equal(failedSummary.failure.smokeOk, false);
    assert.equal(failedSummary.failure.smokeAdminAuthProvided, true);
    assert.equal(failedSummary.failure.smokeFailure.check, "admin-state");

    const portableManifestPath = join(
      tempRoot,
      "dist",
      "release-bundles",
      "fixture-release",
      "release-artifacts",
      "windows-client",
      "SyncraftClient.release-manifest.json"
    );
    const originalPortableManifest = await readFile(portableManifestPath, "utf8");
    await writeFile(portableManifestPath, JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      package: "SyncraftClient",
      version: "9.9.9",
      files: []
    }), "utf8");
    const mismatchedVersion = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-version-mismatch",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke.json",
      "-ReleaseBundleManifestPath",
      "dist/release-bundles/fixture-release/release-bundle-manifest.json"
    ]);
    assert.notEqual(mismatchedVersion.code, 0);
    assert.match(mismatchedVersion.stderr, /N1 post-deploy verification failed/);
    const mismatchedSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-version-mismatch", "post-deploy-summary.json"), "utf8"));
    assert.equal(mismatchedSummary.ok, false);
    assert.equal(mismatchedSummary.failure.versionAlignment.ok, false);
    assert.equal(mismatchedSummary.failure.versionAlignment.appVersion, "0.3.0-rc.1");
    assert.equal(mismatchedSummary.failure.versionAlignment.releaseBundleVersion, "0.3.0-rc.1");
    assert.equal(mismatchedSummary.failure.versionAlignment.desktopVersion, "0.3.0-rc.1");
    assert.equal(mismatchedSummary.failure.versionAlignment.portableVersion, "9.9.9");
    await writeFile(portableManifestPath, originalPortableManifest, "utf8");

    await writeFile(join(tempRoot, "input", "server-smoke-unauthenticated.json"), JSON.stringify({
      schemaVersion: 1,
      type: "server-smoke-report",
      ok: true,
      context: { baseUrl: "http://n1:5177", adminAuthProvided: false },
      summary: { passed: 6, failed: 0, buildId: evidenceBuildId },
      checks: []
    }), "utf8");
    const unauthenticated = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-unauthenticated",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke-unauthenticated.json"
    ]);
    assert.notEqual(unauthenticated.code, 0);
    const unauthenticatedSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-unauthenticated", "post-deploy-summary.json"), "utf8"));
    assert.equal(unauthenticatedSummary.ok, false);
    assert.equal(unauthenticatedSummary.failure.deployOk, true);
    assert.equal(unauthenticatedSummary.failure.smokeOk, true);
    assert.equal(unauthenticatedSummary.failure.smokeAdminAuthProvided, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("N1 post-deploy rejects unverified release bundle unless explicitly allowed", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-n1-postdeploy-unverified-bundle-"));
  try {
    await writeReleaseBundleFixture(tempRoot);
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "post-deploy-n1.ps1"),
      await readFile(join(projectRoot, "scripts", "post-deploy-n1.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ version: "0.3.0-rc.1" }), "utf8");
    await mkdir(join(tempRoot, "server"), { recursive: true });
    await writeFile(
      join(tempRoot, "server", ".env.example"),
      [
        "SING_BOX_IMAGE_TAG=v1.13.14",
        "MINIO_IMAGE_TAG=RELEASE.2025-09-07T16-13-09Z",
        "MINIO_MC_IMAGE_TAG=RELEASE.2025-08-13T08-35-41Z",
        ""
      ].join("\n"),
      "utf8"
    );
    await refreshFakeReleaseBatch(tempRoot);
    const bundleResult = await runReleaseBundle(tempRoot, [
      "-SkipPreflight",
      "-OutputDir",
      "dist/release-bundles",
      "-BundleName",
      "fixture-unverified"
    ]);
    assert.equal(bundleResult.code, 0, bundleResult.stderr || bundleResult.stdout);
    const unverifiedManifest = JSON.parse(await readFile(
      join(tempRoot, "dist", "release-bundles", "fixture-unverified", "release-bundle-manifest.json"),
      "utf8"
    ));
    await mkdir(join(tempRoot, "input"), { recursive: true });
    await writeFile(join(tempRoot, "input", "deploy.json"), JSON.stringify({
      schemaVersion: 1,
      type: "n1-deploy-report",
      ok: true,
      context: { RemoteHost: "root@n1", RemoteRoot: "/opt/sfsc-test", PostDeploySmoke: true },
      summary: { passed: 7, failed: 0 },
      steps: []
    }), "utf8");
    await writeFile(join(tempRoot, "input", "server-smoke.json"), JSON.stringify({
      schemaVersion: 1,
      type: "server-smoke-report",
      ok: true,
      context: { baseUrl: "http://n1:5177", adminAuthProvided: true, requestTimeoutMs: 15000 },
      summary: { passed: 6, failed: 0, buildId: unverifiedManifest.buildId },
      checks: []
    }), "utf8");

    const rejected = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-rejected",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke.json",
      "-ReleaseBundleManifestPath",
      "dist/release-bundles/fixture-unverified/release-bundle-manifest.json"
    ]);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /N1 post-deploy verification failed/);
    const rejectedSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-rejected", "post-deploy-summary.json"), "utf8"));
    assert.equal(rejectedSummary.ok, false);
    assert.equal(rejectedSummary.acceptance.ok, false);
    assert.equal(rejectedSummary.failure.releaseBundlePreflightVerified, false);
    assert.equal(rejectedSummary.failure.allowUnverifiedReleaseBundle, false);

    const allowed = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-allowed",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke.json",
      "-ReleaseBundleManifestPath",
      "dist/release-bundles/fixture-unverified/release-bundle-manifest.json",
      "-AllowUnverifiedReleaseBundle"
    ]);
    assert.equal(allowed.code, 0, allowed.stderr || allowed.stdout);
    const allowedSummary = JSON.parse(await readFile(join(tempRoot, "reports", "n1", "fixture-allowed", "post-deploy-summary.json"), "utf8"));
    assert.equal(allowedSummary.ok, true);
    assert.equal(allowedSummary.acceptance.delivery.releaseBundle.preflightVerified, false);

    const releaseAcceptanceOverride = await runPostDeploy(tempRoot, [
      "-RunId",
      "fixture-release-acceptance-override",
      "-ReportRoot",
      "reports/n1",
      "-DeployJsonPath",
      "input/deploy.json",
      "-SmokeJsonPath",
      "input/server-smoke.json",
      "-ReleaseBundleManifestPath",
      "dist/release-bundles/fixture-unverified/release-bundle-manifest.json",
      "-ReleaseAcceptance",
      "-AllowUnverifiedReleaseBundle"
    ]);
    assert.notEqual(releaseAcceptanceOverride.code, 0);
    assert.match(
      releaseAcceptanceOverride.stderr,
      /-ReleaseAcceptance cannot be combined with -AllowUnverifiedReleaseBundle\./
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("N1 post-deploy print latest fails when latest report is missing", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-n1-postdeploy-print-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "post-deploy-n1.ps1"),
      await readFile(join(projectRoot, "scripts", "post-deploy-n1.ps1"), "utf8"),
      "utf8"
    );

    const result = await runPostDeploy(tempRoot, [
      "-ReportRoot",
      "reports/n1",
      "-PrintLatest"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /latest post-deploy JSON report not found/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release bundle script packages delivery artifacts and excludes runtime secrets", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-release-bundle-"));
  try {
    await writeReleaseBundleFixture(tempRoot);
    const result = await runReleaseBundle(tempRoot, [
      "-SkipPreflight",
      "-OutputDir",
      "out",
      "-BundleName",
      "fixture-release"
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Release bundle directory/);
    assert.match(result.stdout, /Release bundle ZIP/);
    const buildBundle = await readFile(join(tempRoot, "scripts", "build-release-bundle.ps1"), "utf8");
    assert.match(buildBundle, /foreach \(\$stalePath in @\(\$stageRoot, \$zipPath, \$checksumPath\)\)/);
    assert.match(buildBundle, /Remove-Item -LiteralPath \$stalePath -Recurse -Force/);

    const bundleRoot = join(tempRoot, "out", "fixture-release");
    const bundleZip = join(tempRoot, "out", "fixture-release.zip");
    const bundleSha = join(tempRoot, "out", "fixture-release.zip.sha256");
    const manifest = JSON.parse(await readFile(join(bundleRoot, "release-bundle-manifest.json"), "utf8"));
    assert.equal(manifest.schemaVersion, 1);
    assert.equal(manifest.type, "release-bundle-manifest");
    assert.equal(manifest.version, "0.3.0-rc.1");
    assert.equal(manifest.strictPreflight, false);
    assert.equal(manifest.preflightVerified, false);
    assert.equal(manifest.preflightVerification.verified, false);
    assert.equal(manifest.preflightVerification.mode, "skipped");
    assert.equal(manifest.preflightVerification.strictPreflightRanInBundleBuild, false);
    assert.equal(manifest.preflight.mode, "skipped");
    assert.equal(manifest.preflight.releaseOk, false);
    assert.deepEqual(
      manifest.artifacts.map((artifact) => artifact.path),
      [
        "release-artifacts/windows-client/SyncraftDesktop.zip",
        "release-artifacts/windows-client/SyncraftDesktop.zip.sha256",
        "release-artifacts/windows-client/SyncraftDesktop.release-manifest.json",
        "release-artifacts/windows-client/SyncraftClient.zip",
        "release-artifacts/windows-client/SyncraftClient.zip.sha256",
        "release-artifacts/windows-client/SyncraftClient.release-manifest.json"
      ]
    );
    assert.equal(manifest.excludedRuntimePaths.includes("server/data"), true);
    assert.equal(manifest.excludedRuntimePaths.includes("server/sing-box/config.json"), true);

    assert.equal(await fileExists(bundleZip), true);
    assert.equal(await fileExists(bundleSha), true);
    assert.equal(await fileExists(join(bundleRoot, "README.md")), true);
    assert.equal(await fileExists(join(bundleRoot, "docs", "INTERFACE_CONTRACT.md")), true);
    assert.equal(await fileExists(join(bundleRoot, "server", "sing-box", "config.example.json")), true);
    assert.equal(await fileExists(join(bundleRoot, "server", "sing-box", "config.json")), false);
    assert.equal(await fileExists(join(bundleRoot, "server", "data", "sfsc-state.json")), false);
    assert.equal(await fileExists(join(bundleRoot, "client", "data", "profile.json")), false);
    assert.equal(await fileExists(join(bundleRoot, ".tmp", "scratch.txt")), false);
    assert.equal(await fileExists(join(bundleRoot, "node_modules", "bad.txt")), false);

    const checksum = (await readFile(bundleSha, "utf8")).trim().split(/\s+/)[0];
    const actual = createHash("sha256").update(await readFile(bundleZip)).digest("hex");
    assert.equal(checksum, actual);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release bundle manifest records external preflight evidence", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-release-bundle-preflight-"));
  try {
    await writeReleaseBundleFixture(tempRoot);
    await writeFakePreflightReports(tempRoot);
    const result = await runReleaseBundle(tempRoot, [
      "-SkipPreflight",
      "-PreflightReportPath",
      "reports/release/preflight.txt",
      "-PreflightJsonReportPath",
      "reports/release/preflight.json",
      "-OutputDir",
      "out",
      "-BundleName",
      "fixture-release"
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);

    const bundleRoot = join(tempRoot, "out", "fixture-release");
    const manifest = JSON.parse(await readFile(join(bundleRoot, "release-bundle-manifest.json"), "utf8"));
    assert.equal(manifest.strictPreflight, false);
    assert.equal(manifest.preflightVerified, true);
    assert.equal(manifest.preflightVerification.verified, true);
    assert.equal(manifest.preflightVerification.mode, "external");
    assert.equal(manifest.preflightVerification.strictPreflightRanInBundleBuild, false);
    assert.equal(manifest.preflightVerification.releaseOk, true);
    assert.deepEqual(manifest.preflightVerification.summary, { passed: 6, failed: 0, skipped: 0 });
    assert.equal(manifest.preflight.mode, "external");
    assert.equal(manifest.preflight.releaseOk, true);
    assert.deepEqual(manifest.preflight.summary, { passed: 6, failed: 0, skipped: 0 });
    assert.deepEqual(
      manifest.preflight.bundledReports.map((report) => report.path),
      [
        "reports/release-bundle/preflight.json",
        "reports/release-bundle/preflight.txt",
        "reports/release-bundle/client-package-smoke-desktop.json",
        "reports/release-bundle/client-package-smoke-portable.json"
      ]
    );
    for (const report of manifest.preflight.bundledReports) {
      assert.match(report.sha256, /^[a-f0-9]{64}$/);
      assert.equal(report.size > 0, true);
      assert.equal(await fileExists(join(bundleRoot, ...report.path.split("/"))), true);
    }
    assert.deepEqual(
      manifest.preflight.sourceReports.map((report) => report.path),
      [
        "reports/release/preflight.json",
        "reports/release/preflight.txt",
        "reports/release/client-package-smoke-desktop.json",
        "reports/release/client-package-smoke-portable.json"
      ]
    );
    const bundledPreflight = JSON.parse(await readFile(join(bundleRoot, "reports", "release-bundle", "preflight.json"), "utf8"));
    assert.equal(bundledPreflight.releaseOk, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("binary downloader verifies locked hashes before skipping existing tools", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-binaries-lock-"));
  try {
    const outDir = join(tempRoot, "bin");
    await mkdir(outDir, { recursive: true });
    const singBox = Buffer.from("sing-box fixture", "utf8");
    const rclone = Buffer.from("rclone fixture", "utf8");
    await writeFile(join(outDir, "sing-box.exe"), singBox);
    await writeFile(join(outDir, "rclone.exe"), rclone);
    const lockPath = join(tempRoot, "binaries.lock.json");
    await writeFile(lockPath, JSON.stringify(binaryLockFixture({
      singBoxSha256: createHash("sha256").update(singBox).digest("hex"),
      rcloneSha256: createHash("sha256").update(rclone).digest("hex")
    }), null, 2), "utf8");

    const ok = await runDownloadBinaries([
      "-OutDir",
      outDir,
      "-LockFile",
      lockPath
    ]);
    assert.equal(ok.code, 0, ok.stderr || ok.stdout);
    assert.match(ok.stdout, /sing-box\.exe already exists and matches binaries\.lock\.json/);
    assert.match(ok.stdout, /rclone\.exe already exists and matches binaries\.lock\.json/);

    await writeFile(lockPath, JSON.stringify(binaryLockFixture({
      singBoxSha256: "0".repeat(64),
      rcloneSha256: createHash("sha256").update(rclone).digest("hex")
    }), null, 2), "utf8");
    const mismatch = await runDownloadBinaries([
      "-OutDir",
      outDir,
      "-LockFile",
      lockPath
    ]);
    assert.notEqual(mismatch.code, 0);
    assert.match(mismatch.stderr, /sing-box\.exe exists but does not match binaries\.lock\.json/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preflight prints a report when a step fails", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-preflight-failure-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "preflight-release.ps1"),
      await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      "console.error('audit fixture failed'); process.exit(23);\n",
      "utf8"
    );

    const reportPath = join(tempRoot, "reports", "failed-preflight.txt");
    const jsonReportPath = join(tempRoot, "reports", "failed-preflight.json");
    const result = await runPreflight(tempRoot, [
      "-SkipTests",
      "-ReportPath",
      reportPath,
      "-JsonReportPath",
      jsonReportPath
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /Release audit/);
    assert.match(result.stdout, /Preflight report/);
    assert.match(result.stdout, /failed: Release audit/);
    assert.match(result.stdout, /exit code 23/);
    assert.match(result.stdout, /Preflight report written/);
    assert.match(result.stdout, /Preflight JSON report written/);
    assert.match(result.stderr, /Preflight step failed: Release audit/);

    const report = await readFile(reportPath, "utf8");
    assert.match(report, /Preflight report/);
    assert.match(report, /GeneratedAt:/);
    assert.match(report, /RepoRoot:/);
    assert.match(report, /Node:/);
    assert.match(report, /SkipTests: True/);
    assert.match(report, /ReportPath:/);
    assert.match(report, /failed: Release audit/);
    assert.match(report, /exit code 23/);

    const jsonReport = JSON.parse(await readFile(jsonReportPath, "utf8"));
    assert.equal(jsonReport.schemaVersion, 1);
    assert.equal(jsonReport.type, "preflight-report");
    assert.equal(jsonReport.ok, false);
    assert.equal(jsonReport.summary.failed, 1);
    assert.equal(jsonReport.steps[0].name, "Release audit");
    assert.equal(jsonReport.steps[0].status, "failed");
    assert.equal(jsonReport.steps[0].errorCode, "preflight_release_audit_failed");
    assert.match(jsonReport.steps[0].detail, /exit code 23/);
    assert.equal(jsonReport.context.skipTests ?? jsonReport.context.SkipTests, true);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preflight writes a report file on successful quick checks", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-preflight-report-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "preflight-release.ps1"),
      await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "deploy-n1.ps1"),
      "Write-Host '[fixture] deploy check passed'\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      "console.log('Release audit passed.');\n",
      "utf8"
    );

    const reportPath = "reports/preflight.txt";
    const jsonReportPath = "reports/preflight.json";
    const result = await runPreflight(tempRoot, [
      "-SkipTests",
      "-ReportPath",
      reportPath,
      "-JsonReportPath",
      jsonReportPath
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Preflight report written/);
    assert.match(result.stdout, /Preflight JSON report written/);
    const report = await readFile(join(tempRoot, "reports", "preflight.txt"), "utf8");
    assert.match(report, /GeneratedAt:/);
    assert.match(report, /RepoRoot:/);
    assert.match(report, /Node:/);
    assert.match(report, /SkipTests: True/);
    assert.match(report, /ReportPath:/);
    assert.match(report, /passed: Release audit/);
    assert.match(report, /passed: N1 deploy dry-run/);
    assert.match(report, /passed: N1 deploy archive validation/);
    assert.match(report, /skipped: Client package smoke \(desktop\)/);
    assert.match(report, /skipped: Client package smoke \(portable\)/);
    assert.match(report, /skipped: Node test suite/);

    const jsonReport = JSON.parse(await readFile(join(tempRoot, "reports", "preflight.json"), "utf8"));
    assert.equal(jsonReport.schemaVersion, 1);
    assert.equal(jsonReport.app, "singbox-folder-sync");
    assert.equal(jsonReport.type, "preflight-report");
    assert.equal(jsonReport.ok, false);
    assert.equal(jsonReport.releaseOk, false);
    assert.equal(jsonReport.summary.failed, 0);
    assert.equal(jsonReport.summary.passed, 3);
    assert.equal(jsonReport.summary.skipped, 3);
    assert.equal(jsonReport.context.SkipTests, true);
    assert.match(jsonReport.context.JsonReportPath, /reports[\\/]preflight\.json$/);
    assert.match(jsonReport.context.ClientPackageSmokeJsonReportPath, /reports[\\/]client-package-smoke-desktop\.json$/);
    assert.deepEqual(
      jsonReport.context.ClientPackageSmokeJsonReportPaths.map((path) => path.replaceAll("\\", "/").split("/").pop()),
      ["client-package-smoke-desktop.json", "client-package-smoke-portable.json"]
    );
    assert.deepEqual(
      jsonReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [
        ["Release audit", "passed", ""],
        ["N1 deploy dry-run", "passed", ""],
        ["N1 deploy archive validation", "passed", ""],
        ["Client package smoke (desktop)", "skipped", "preflight_step_skipped"],
        ["Client package smoke (portable)", "skipped", "preflight_step_skipped"],
        ["Node test suite", "skipped", "preflight_step_skipped"]
      ]
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("strict preflight fails when no client package was built", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-preflight-strict-missing-package-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "preflight-release.ps1"),
      await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "deploy-n1.ps1"),
      "Write-Host '[fixture] deploy check passed'\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      "console.log('Release audit passed.');\n",
      "utf8"
    );

    const reportPath = "reports/preflight-strict.txt";
    const jsonReportPath = "reports/preflight-strict.json";
    const result = await runPreflight(tempRoot, [
      "-ReportPath",
      reportPath,
      "-JsonReportPath",
      jsonReportPath
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /passed: Release audit/);
    assert.match(result.stdout, /passed: N1 deploy dry-run/);
    assert.match(result.stdout, /passed: N1 deploy archive validation/);
    assert.match(result.stdout, /failed: Client package smoke \(desktop\)/);
    assert.match(result.stderr, /Preflight step failed: Client package smoke \(desktop\)/);

    const jsonReport = JSON.parse(await readFile(join(tempRoot, "reports", "preflight-strict.json"), "utf8"));
    assert.equal(jsonReport.ok, false);
    assert.equal(jsonReport.summary.failed, 1);
    assert.equal(jsonReport.summary.skipped, 0);
    assert.equal(jsonReport.context.SkipTests, false);
    assert.equal(jsonReport.context.AllowSkips, false);
    assert.deepEqual(
      jsonReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [
        ["Release audit", "passed", ""],
        ["N1 deploy dry-run", "passed", ""],
        ["N1 deploy archive validation", "passed", ""],
        ["Client package smoke (desktop)", "failed", "preflight_client_package_smoke_desktop_failed"]
      ]
    );
    assert.match(jsonReport.steps[3].detail, /Built client package not found/);
    assert.match(jsonReport.steps[3].detail, /SyncraftDesktop/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("strict preflight fails when only one client package was built", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-preflight-strict-one-package-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await mkdir(join(tempRoot, "dist", "SyncraftDesktop"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "preflight-release.ps1"),
      await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "deploy-n1.ps1"),
      "Write-Host '[fixture] deploy check passed'\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      "console.log('Release audit passed.');\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "smoke-client-package.mjs"),
      "console.log('client package fixture smoke passed');\n",
      "utf8"
    );

    const result = await runPreflight(tempRoot, [
      "-JsonReportPath",
      "reports/preflight.json"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /passed: Client package smoke \(desktop\)/);
    assert.match(result.stdout, /failed: Client package smoke \(portable\)/);
    assert.match(result.stderr, /Preflight step failed: Client package smoke \(portable\)/);
    const jsonReport = JSON.parse(await readFile(join(tempRoot, "reports", "preflight.json"), "utf8"));
    assert.equal(jsonReport.releaseOk, false);
    assert.deepEqual(
      jsonReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [
        ["Release audit", "passed", ""],
        ["N1 deploy dry-run", "passed", ""],
        ["N1 deploy archive validation", "passed", ""],
        ["Client package smoke (desktop)", "passed", ""],
        ["Client package smoke (portable)", "failed", "preflight_client_package_smoke_portable_failed"]
      ]
    );
    assert.match(jsonReport.steps.at(-1).detail, /SyncraftClient/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preflight passes a derived JSON report path to client package smoke", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-preflight-client-smoke-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await mkdir(join(tempRoot, "dist", "SyncraftDesktop"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "preflight-release.ps1"),
      await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "deploy-n1.ps1"),
      "Write-Host '[fixture] deploy check passed'\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      "console.log('Release audit passed.');\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "smoke-client-package.mjs"),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const index = process.argv.indexOf('--json-report');",
        "if (index === -1 || !process.argv[index + 1]) {",
        "  console.error('missing --json-report');",
        "  process.exit(31);",
        "}",
        "const reportPath = process.argv[index + 1];",
        "mkdirSync(dirname(reportPath), { recursive: true });",
        "writeFileSync(reportPath, JSON.stringify({ ok: true, type: 'client-package-smoke-report', packageRoot: process.env.SFSC_CLIENT_PACKAGE_DIR }, null, 2), 'utf8');",
        "console.log(`client package fixture report written: ${reportPath}`);"
      ].join("\n"),
      "utf8"
    );

    const result = await runPreflight(tempRoot, [
      "-SkipTests",
      "-JsonReportPath",
      "reports/preflight.json"
    ]);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /Client package smoke/);
    assert.match(result.stdout, /client package fixture report written/);
    const preflightReport = JSON.parse(await readFile(join(tempRoot, "reports", "preflight.json"), "utf8"));
    assert.equal(preflightReport.ok, false);
    assert.equal(preflightReport.releaseOk, false);
    assert.equal(preflightReport.summary.passed, 4);
    assert.equal(preflightReport.summary.skipped, 2);
    assert.match(preflightReport.context.ClientPackageSmokeJsonReportPath, /reports[\\/]client-package-smoke-desktop\.json$/);
    assert.deepEqual(
      preflightReport.context.ClientPackageSmokeJsonReportPaths.map((path) => path.replaceAll("\\", "/").split("/").pop()),
      ["client-package-smoke-desktop.json", "client-package-smoke-portable.json"]
    );
    assert.deepEqual(
      preflightReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [
        ["Release audit", "passed", ""],
        ["N1 deploy dry-run", "passed", ""],
        ["N1 deploy archive validation", "passed", ""],
        ["Client package smoke (desktop)", "passed", ""],
        ["Client package smoke (portable)", "skipped", "preflight_step_skipped"],
        ["Node test suite", "skipped", "preflight_step_skipped"]
      ]
    );
    assert.equal(preflightReport.clientPackageSmokeReports.length, 2);
    assert.equal(preflightReport.clientPackageSmokeReports[0].exists, true);
    assert.equal(preflightReport.clientPackageSmokeReports[0].ok, true);
    assert.equal(preflightReport.clientPackageSmokeReports[0].failureCheck, "");
    assert.equal(preflightReport.clientPackageSmokeReports[0].report.type, "client-package-smoke-report");
    assert.match(preflightReport.clientPackageSmokeReports[0].report.packageRoot, /dist[\\/]SyncraftDesktop$/);
    assert.equal(preflightReport.clientPackageSmokeReports[1].exists, false);
    assert.equal(preflightReport.clientPackageSmokeReports[1].failureCheck, "");
    assert.equal(preflightReport.clientPackageSmokeReports[1].errorCode, "client_package_smoke_report_missing");
    const childReport = JSON.parse(await readFile(join(tempRoot, "reports", "client-package-smoke-desktop.json"), "utf8"));
    assert.equal(childReport.ok, true);
    assert.equal(childReport.type, "client-package-smoke-report");
    assert.match(childReport.packageRoot, /dist[\\/]SyncraftDesktop$/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preflight promotes client package smoke failure check into the summary report", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-preflight-client-smoke-failure-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await mkdir(join(tempRoot, "dist", "SyncraftDesktop"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "preflight-release.ps1"),
      await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "deploy-n1.ps1"),
      "Write-Host '[fixture] deploy check passed'\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      "console.log('Release audit passed.');\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "smoke-client-package.mjs"),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const index = process.argv.indexOf('--json-report');",
        "const reportPath = process.argv[index + 1];",
        "mkdirSync(dirname(reportPath), { recursive: true });",
        "writeFileSync(reportPath, JSON.stringify({ ok: false, type: 'client-package-smoke-report', failure: { check: 'release-manifest', message: 'bad manifest hash' } }, null, 2), 'utf8');",
        "console.error('bad manifest hash');",
        "process.exit(41);"
      ].join("\n"),
      "utf8"
    );

    const result = await runPreflight(tempRoot, [
      "-SkipTests",
      "-JsonReportPath",
      "reports/preflight.json"
    ]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Preflight step failed: Client package smoke \(desktop\)/);
    const preflightReport = JSON.parse(await readFile(join(tempRoot, "reports", "preflight.json"), "utf8"));
    assert.equal(preflightReport.ok, false);
    assert.equal(preflightReport.summary.failed, 1);
    assert.deepEqual(
      preflightReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [
        ["Release audit", "passed", ""],
        ["N1 deploy dry-run", "passed", ""],
        ["N1 deploy archive validation", "passed", ""],
        ["Client package smoke (desktop)", "failed", "preflight_client_package_smoke_desktop_failed"]
      ]
    );
    assert.equal(preflightReport.clientPackageSmokeReports.length, 2);
    assert.equal(preflightReport.clientPackageSmokeReports[0].exists, true);
    assert.equal(preflightReport.clientPackageSmokeReports[0].ok, false);
    assert.equal(preflightReport.clientPackageSmokeReports[0].failureCheck, "release-manifest");
    assert.equal(preflightReport.clientPackageSmokeReports[0].report.failure.check, "release-manifest");
    assert.equal(preflightReport.clientPackageSmokeReports[1].exists, false);
    assert.equal(preflightReport.clientPackageSmokeReports[1].errorCode, "client_package_smoke_report_missing");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preflight restores client package environment before running later steps", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-preflight-client-env-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await mkdir(join(tempRoot, "dist", "SyncraftDesktop"), { recursive: true });
    await mkdir(join(tempRoot, "dist", "SyncraftClient"), { recursive: true });
    await mkdir(join(tempRoot, "tests"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "preflight-release.ps1"),
      await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "deploy-n1.ps1"),
      "Write-Host '[fixture] deploy check passed'\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      "console.log('Release audit passed.');\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "smoke-client-package.mjs"),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "if (!/Syncraft(Desktop|Client)$/.test((process.env.SFSC_CLIENT_PACKAGE_DIR || '').replaceAll('\\\\', '/'))) {",
        "  console.error(`unexpected package dir in smoke: ${process.env.SFSC_CLIENT_PACKAGE_DIR || ''}`);",
        "  process.exit(42);",
        "}",
        "const index = process.argv.indexOf('--json-report');",
        "if (index !== -1 && process.argv[index + 1]) {",
        "  mkdirSync(dirname(process.argv[index + 1]), { recursive: true });",
        "  writeFileSync(process.argv[index + 1], JSON.stringify({ ok: true, type: 'client-package-smoke-report' }, null, 2), 'utf8');",
        "}",
        "console.log('client package fixture report written');"
      ].join("\n"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "tests", "env.test.js"),
      [
        "import test from 'node:test';",
        "import assert from 'node:assert/strict';",
        "test('preflight restores client package env', () => {",
        "  assert.equal(process.env.SFSC_CLIENT_PACKAGE_DIR, 'original-client-package-dir');",
        "});"
      ].join("\n"),
      "utf8"
    );

    const result = await runPreflight(tempRoot, [
      "-JsonReportPath",
      "reports/preflight.json"
    ], {
      SFSC_CLIENT_PACKAGE_DIR: "original-client-package-dir"
    });
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /client package fixture report written/);
    const preflightReport = JSON.parse(await readFile(join(tempRoot, "reports", "preflight.json"), "utf8"));
    assert.equal(preflightReport.ok, true);
    assert.equal(preflightReport.releaseOk, true);
    assert.equal(preflightReport.summary.failed, 0);
    assert.equal(preflightReport.steps.at(-1).name, "Node test suite");
    assert.equal(preflightReport.steps.at(-1).status, "passed");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("preflight runs client package smoke for desktop and portable packages when both exist", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-preflight-two-client-smokes-"));
  try {
    await mkdir(join(tempRoot, "scripts"), { recursive: true });
    await mkdir(join(tempRoot, "dist", "SyncraftDesktop"), { recursive: true });
    await mkdir(join(tempRoot, "dist", "SyncraftClient"), { recursive: true });
    await writeFile(
      join(tempRoot, "scripts", "preflight-release.ps1"),
      await readFile(join(projectRoot, "scripts", "preflight-release.ps1"), "utf8"),
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "deploy-n1.ps1"),
      "Write-Host '[fixture] deploy check passed'\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      "console.log('Release audit passed.');\n",
      "utf8"
    );
    await writeFile(
      join(tempRoot, "scripts", "smoke-client-package.mjs"),
      [
        "import { mkdirSync, writeFileSync } from 'node:fs';",
        "import { dirname } from 'node:path';",
        "const index = process.argv.indexOf('--json-report');",
        "if (index === -1 || !process.argv[index + 1]) process.exit(31);",
        "const reportPath = process.argv[index + 1];",
        "mkdirSync(dirname(reportPath), { recursive: true });",
        "writeFileSync(reportPath, JSON.stringify({ ok: true, type: 'client-package-smoke-report', packageRoot: process.env.SFSC_CLIENT_PACKAGE_DIR }, null, 2), 'utf8');",
        "console.log(`client package fixture report written: ${reportPath}`);"
      ].join("\n"),
      "utf8"
    );

    const result = await runPreflight(tempRoot, [
      "-SkipTests",
      "-JsonReportPath",
      "reports/preflight.json"
    ]);
    assert.equal(
      result.code,
      0,
      `two-package preflight failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
    assert.match(result.stdout, /Client package smoke \(desktop\)/);
    assert.match(result.stdout, /Client package smoke \(portable\)/);
    const preflightReport = JSON.parse(await readFile(join(tempRoot, "reports", "preflight.json"), "utf8"));
    assert.equal(preflightReport.summary.passed, 5);
    assert.equal(preflightReport.summary.skipped, 1);
    assert.deepEqual(
      preflightReport.steps.map((step) => [step.name, step.status, step.errorCode]),
      [
        ["Release audit", "passed", ""],
        ["N1 deploy dry-run", "passed", ""],
        ["N1 deploy archive validation", "passed", ""],
        ["Client package smoke (desktop)", "passed", ""],
        ["Client package smoke (portable)", "passed", ""],
        ["Node test suite", "skipped", "preflight_step_skipped"]
      ]
    );
    const desktopReport = JSON.parse(await readFile(join(tempRoot, "reports", "client-package-smoke-desktop.json"), "utf8"));
    const portableReport = JSON.parse(await readFile(join(tempRoot, "reports", "client-package-smoke-portable.json"), "utf8"));
    assert.match(desktopReport.packageRoot, /dist[\\/]SyncraftDesktop$/);
    assert.match(portableReport.packageRoot, /dist[\\/]SyncraftClient$/);
    assert.equal(preflightReport.clientPackageSmokeReports.length, 2);
    assert.deepEqual(
      preflightReport.clientPackageSmokeReports.map((item) => [item.exists, item.ok, item.report.type]),
      [
        [true, true, "client-package-smoke-report"],
        [true, true, "client-package-smoke-report"]
      ]
    );
    assert.match(preflightReport.clientPackageSmokeReports[0].report.packageRoot, /dist[\\/]SyncraftDesktop$/);
    assert.match(preflightReport.clientPackageSmokeReports[1].report.packageRoot, /dist[\\/]SyncraftClient$/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client package smoke script validates desktop package shape and runtime state leaks", async () => {
  const pkg = await readFile(join(projectRoot, "package.json"), "utf8");
  const smoke = await readFile(join(projectRoot, "scripts", "smoke-client-package.mjs"), "utf8");
  const buildClient = await readFile(join(projectRoot, "client", "scripts", "build-client.ps1"), "utf8");
  const buildDesktop = await readFile(join(projectRoot, "client", "scripts", "build-desktop.ps1"), "utf8");
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-package-"));
  const packageRoot = join(tempRoot, "SyncraftDesktop");

  try {
    await createFakeClientPackage(packageRoot);
    const passedReportPath = join(tempRoot, "reports", "client-package-smoke-pass.json");
    const passed = await runClientPackageSmoke(packageRoot, { jsonReportPath: passedReportPath });
    assert.equal(passed.code, 0);
    assert.match(passed.stdout, /SFSC client package smoke passed/);
    assert.match(passed.stdout, /SFSC client package smoke JSON report written/);
    const passedReport = JSON.parse(await readFile(passedReportPath, "utf8"));
    assert.equal(passedReport.schemaVersion, 1);
    assert.equal(passedReport.app, "singbox-folder-sync");
    assert.equal(passedReport.type, "client-package-smoke-report");
    assert.equal(passedReport.ok, true);
    assert.equal(passedReport.context.packageRoot, packageRoot);
    assert.equal(passedReport.context.rootPackageVersion, JSON.parse(pkg).version);
    assert.equal(passedReport.context.packageName, "SyncraftDesktop");
    assert.equal(passedReport.context.manifestVersion, JSON.parse(pkg).version);
    assert.equal(passedReport.context.manifestBuiltAt, "2026-07-04T00:00:00.000Z");
    assert.equal(passedReport.context.manifestFileCount, 27);
    assert.equal(passedReport.summary.failed, 0);
    assert.ok(passedReport.summary.passed > 0);
    assert.equal(passedReport.failure, null);
    assert.ok(passedReport.checks.some((check) => check.includes("release manifest version")));

    const portablePackageRoot = join(tempRoot, "SyncraftClient");
    await createFakePortableClientPackage(portablePackageRoot);
    const portableReportPath = join(tempRoot, "reports", "client-package-smoke-portable.json");
    const portablePassed = await runClientPackageSmoke(portablePackageRoot, { jsonReportPath: portableReportPath });
    assert.equal(portablePassed.code, 0);
    assert.match(portablePassed.stdout, /SFSC client package smoke passed/);
    const portableReport = JSON.parse(await readFile(portableReportPath, "utf8"));
    assert.equal(portableReport.ok, true);
    assert.equal(portableReport.context.packageRoot, portablePackageRoot);
    assert.equal(portableReport.context.packageName, "SyncraftClient");
    assert.equal(portableReport.context.manifestVersion, JSON.parse(pkg).version);
    assert.equal(portableReport.context.manifestFileCount, 25);
    assert.ok(portableReport.checks.some((check) => check.includes("portable node runtime")));
    assert.ok(portableReport.checks.some((check) => check.includes("local health readiness endpoint verified")));

    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version, {
      "resources/app/client/src/clientServer.js": "0".repeat(64)
    });
    const failedReportPath = join(tempRoot, "reports", "client-package-smoke-fail.json");
    const staleManifest = await runClientPackageSmoke(packageRoot, { jsonReportPath: failedReportPath });
    assert.notEqual(staleManifest.code, 0);
    assert.match(staleManifest.stderr, /Failed check: release-manifest/);
    assert.match(staleManifest.stderr, /Release manifest sha256 mismatch/);
    assert.match(staleManifest.stdout, /SFSC client package smoke JSON report written/);
    const failedReport = JSON.parse(await readFile(failedReportPath, "utf8"));
    assert.equal(failedReport.schemaVersion, 1);
    assert.equal(failedReport.type, "client-package-smoke-report");
    assert.equal(failedReport.ok, false);
    assert.equal(failedReport.summary.failed, 1);
    assert.equal(failedReport.failure.check, "release-manifest");
    assert.match(failedReport.failure.message, /Release manifest sha256 mismatch/);
    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version);

    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version, {}, { builtAt: "not-a-date" });
    const invalidBuiltAtManifest = await runClientPackageSmoke(packageRoot);
    assert.notEqual(invalidBuiltAtManifest.code, 0);
    assert.match(invalidBuiltAtManifest.stderr, /release manifest builtAt/);
    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version);

    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version, {}, {
      extraFiles: [{
        name: "data/secrets.json",
        size: 2,
        sha256: "1".repeat(64)
      }]
    });
    const runtimeManifestEntry = await runClientPackageSmoke(packageRoot);
    assert.notEqual(runtimeManifestEntry.code, 0);
    assert.match(runtimeManifestEntry.stderr, /runtime state or secret file entry: data\/secrets\.json/);
    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version);

    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version, {}, {
      extraFiles: [{
        name: "resources/app/client/src/clientServer.js",
        size: 2,
        sha256: "2".repeat(64)
      }]
    });
    const duplicateManifestEntry = await runClientPackageSmoke(packageRoot);
    assert.notEqual(duplicateManifestEntry.code, 0);
    assert.match(duplicateManifestEntry.stderr, /duplicate file entry: resources\/app\/client\/src\/clientServer\.js/);
    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version);

    const binRoot = join(packageRoot, "resources", "bin", "win32");
    const rclone = await readFile(join(binRoot, "rclone.exe"));
    await writeFile(join(binRoot, "binaries.lock.json"), JSON.stringify(binaryLockFixture({
      singBoxSha256: "0".repeat(64),
      rcloneSha256: createHash("sha256").update(rclone).digest("hex")
    }), null, 2), "utf8");
    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version);
    const binaryLockMismatch = await runClientPackageSmoke(packageRoot);
    assert.notEqual(binaryLockMismatch.code, 0);
    assert.match(binaryLockMismatch.stderr, /Failed check: bundled-binaries/);
    assert.match(binaryLockMismatch.stderr, /sing-box\.exe does not match binaries\.lock\.json SHA256/);
    await writeFakePackageBinaryLock(binRoot);
    await writeFakeReleaseManifest(packageRoot, JSON.parse(pkg).version);

    await mkdir(join(packageRoot, "resources", "app", "data"), { recursive: true });
    await writeFile(join(packageRoot, "resources", "app", "data", "secrets.json"), "{}", "utf8");
    const appDataLeak = await runClientPackageSmoke(packageRoot);
    assert.notEqual(appDataLeak.code, 0);
    assert.match(appDataLeak.stderr, /resources\/app\/data/);
    assert.match(appDataLeak.stderr, /runtime state or secrets/);
    await rm(join(packageRoot, "resources", "app", "data"), { recursive: true, force: true });

    await mkdir(join(packageRoot, "data"), { recursive: true });
    await writeFile(join(packageRoot, "data", "secrets.json"), "{}", "utf8");
    const failed = await runClientPackageSmoke(packageRoot);
    assert.notEqual(failed.code, 0);
    assert.match(failed.stderr, /runtime state or secrets/);

    assert.match(pkg, /"smoke:client-package": "node scripts\/smoke-client-package\.mjs"/);
    assert.match(smoke, /SFSC_CLIENT_PACKAGE_DIR/);
    assert.match(smoke, /SFSC_CLIENT_PACKAGE_JSON_REPORT/);
    assert.match(smoke, /--json-report/);
    assert.match(smoke, /Syncraft\.exe/);
    assert.match(smoke, /release-manifest\.json/);
    assert.match(smoke, /requireReleaseManifest/);
    assert.match(smoke, /function writeClientPackageJsonReport/);
    assert.match(smoke, /package-launch/);
    assert.match(smoke, /function requirePackageLaunch/);
    assert.match(smoke, /getRandomPort/);
    assert.match(smoke, /SFSC_CLIENT_DATA_ROOT/);
    assert.match(smoke, /SFSC_PACKAGE_SMOKE/);
    assert.match(smoke, /\/api\/health/);
    assert.match(smoke, /\/api\/client\/status/);
    assert.match(smoke, /\/api\/client\/shutdown/);
    assert.match(smoke, /releaseManifest\?\.ok !== true/);
    assert.match(smoke, /type: "client-package-smoke-report"/);
    assert.match(smoke, /writeJsonReportSync\(reportPath, payload, "client package smoke report"\)/);
    assert.match(smoke, /SFSC client package smoke JSON report written/);
    assert.match(smoke, /Failed check: \$\{error\?\.check \|\| currentCheck\}/);
    assert.match(smoke, /let releaseManifestSummary = null/);
    assert.match(smoke, /let currentCheck = "startup"/);
    assert.match(smoke, /async function runCheck/);
    assert.match(smoke, /check: error\?\.check \|\| currentCheck/);
    assert.match(smoke, /packageName: releaseManifestSummary\?\.package/);
    assert.match(smoke, /manifestVersion: releaseManifestSummary\?\.version/);
    assert.match(smoke, /manifestBuiltAt: releaseManifestSummary\?\.builtAt/);
    assert.match(smoke, /manifestFileCount: releaseManifestSummary\?\.fileCount/);
    assert.match(smoke, /release manifest version/);
    assert.match(smoke, /release manifest builtAt/);
    assert.match(smoke, /createHash\("sha256"\)/);
    assert.match(smoke, /Release manifest sha256 mismatch/);
    assert.match(smoke, /validateManifestFileList/);
    assert.match(smoke, /duplicate file entry/);
    assert.match(smoke, /runtime state or secret file entry/);
    assert.match(smoke, /client\/src\/paths\.js/);
    assert.match(smoke, /client\/src\/store\.js/);
    assert.match(smoke, /client\/src\/diagnosticBundle\.js/);
    assert.match(smoke, /client\/src\/processRunner\.js/);
    assert.match(smoke, /client\/src\/rcloneStats\.js/);
    assert.match(smoke, /client\/src\/profileImport\.js/);
    assert.match(smoke, /client\/src\/launcher\.cjs/);
    assert.match(smoke, /client\/src\/Launcher\.cs/);
    assert.match(smoke, /client\/public\/app\.js/);
    assert.match(smoke, /client\/public\/styles\.css/);
    assert.match(smoke, /src\/core\/index\.js/);
    assert.match(smoke, /resources\/app\/docs\/INTERFACE_CONTRACT\.md/);
    assert.match(smoke, /resources\/app\/docs\/API_MATRIX\.md/);
    assert.match(smoke, /resources\/app\/docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md/);
    assert.match(smoke, /resources\/app\/docs\/INTERNAL_TRIAL_CHECKLIST\.md/);
    assert.match(smoke, /resources\/app\/docs\/PILOT_RUNBOOK\.md/);
    assert.match(smoke, /resources\/app\/docs\/PILOT_ACCEPTANCE_CRITERIA\.md/);
    assert.match(smoke, /resources\/app\/docs\/PILOT_SUPPORT_GUIDE\.md/);
    assert.match(smoke, /resources\/bin\/win32\/binaries\.lock\.json/);
    assert.match(smoke, /isPortablePackage/);
    assert.match(smoke, /SyncraftClient/);
    assert.match(smoke, /portable node runtime/);
    assert.match(smoke, /health-readiness/);
    assert.match(smoke, /requireHealthReadiness/);
    assert.match(smoke, /local health readiness endpoint verified/);
    assert.match(smoke, /validate SFSC client health/);
    assert.match(smoke, /client-exe-runtime mode/);
    assert.match(smoke, /client diagnostics role/);
    assert.match(smoke, /Client launchers must not use \/api\/client\/status for readiness checks/);
    assert.match(smoke, /supportRoot/);
    assert.match(smoke, /"interface contract", "INTERFACE_CONTRACT\.md"/);
    assert.match(smoke, /"internal trial checklist", "INTERNAL_TRIAL_CHECKLIST\.md"/);
    assert.match(smoke, /"pilot runbook", "PILOT_RUNBOOK\.md"/);
    assert.match(smoke, /"pilot acceptance criteria", "PILOT_ACCEPTANCE_CRITERIA\.md"/);
    assert.match(smoke, /"pilot support guide", "PILOT_SUPPORT_GUIDE\.md"/);
    assert.match(smoke, /resources\/app\/data/);
    assert.match(smoke, /resources\/app\/client\/data/);
    assert.match(smoke, /native folder picker bridge verified/);
    assert.match(smoke, /contextIsolation/);
    assert.match(smoke, /sfscDesktop/);
    assert.match(smoke, /sing-box\.exe/);
    assert.match(smoke, /rclone\.exe/);
    assert.match(smoke, /function requireBinaryLockContract/);
    assert.match(smoke, /binary lock hashes verified/);
    assert.match(smoke, /does not match binaries\.lock\.json SHA256/);
    assert.match(buildDesktop, /smoke-client-package\.mjs/);
    assert.match(buildDesktop, /SFSC_CLIENT_PACKAGE_DIR/);
    assert.match(buildDesktop, /\$nodeExe = \$env:SFSC_NODE/);
    assert.match(buildDesktop, /Get-Command node/);
    assert.match(buildDesktop, /Node\.js not found\. Install Node\.js or set SFSC_NODE to node\.exe\./);
    assert.match(buildDesktop, /WriteAllText\(\(Join-Path \$appRoot "package\.json"\), \$appPackageJson\.Replace\("__APP_VERSION__", \$appVersion\), \[System\.Text\.UTF8Encoding\]::new\(\$false\)\)/);
    assert.match(buildDesktop, /WriteAllText\(\(Join-Path \$distRootFull "release-manifest\.json"\), \$releaseManifestJson, \[System\.Text\.UTF8Encoding\]::new\(\$false\)\)/);
    assert.doesNotMatch(buildDesktop, /skipped client package smoke check/);
    assert.match(buildDesktop, /release-manifest\.json/);
    assert.match(buildDesktop, /docs\\INTERFACE_CONTRACT\.md/);
    assert.match(buildDesktop, /docs\\API_MATRIX\.md/);
    assert.match(buildDesktop, /docs\\INTERNAL_TRIAL_CHECKLIST\.md/);
    assert.match(buildDesktop, /docs\\PILOT_RUNBOOK\.md/);
    assert.match(buildDesktop, /docs\\PILOT_ACCEPTANCE_CRITERIA\.md/);
    assert.match(buildDesktop, /docs\\PILOT_SUPPORT_GUIDE\.md/);
    assert.match(buildDesktop, /resources\/app\/client\/src\/paths\.js/);
    assert.match(buildDesktop, /resources\/app\/client\/src\/store\.js/);
    assert.match(buildDesktop, /resources\/app\/client\/src\/diagnosticBundle\.js/);
    assert.match(buildDesktop, /resources\/app\/client\/src\/processRunner\.js/);
    assert.match(buildDesktop, /resources\/app\/client\/src\/rcloneStats\.js/);
    assert.match(buildDesktop, /resources\/app\/client\/src\/profileImport\.js/);
    assert.match(buildDesktop, /resources\/app\/client\/src\/launcher\.cjs/);
    assert.match(buildDesktop, /resources\/app\/client\/src\/Launcher\.cs/);
    assert.match(buildDesktop, /resources\/app\/client\/public\/app\.js/);
    assert.match(buildDesktop, /resources\/app\/client\/public\/styles\.css/);
    assert.match(buildDesktop, /resources\/app\/src\/core\/index\.js/);
    assert.match(buildDesktop, /resources\/app\/docs\/INTERFACE_CONTRACT\.md/);
    assert.match(buildDesktop, /resources\/app\/docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md/);
    assert.match(buildDesktop, /resources\/app\/docs\/INTERNAL_TRIAL_CHECKLIST\.md/);
    assert.match(buildDesktop, /resources\/app\/docs\/PILOT_RUNBOOK\.md/);
    assert.match(buildDesktop, /resources\/app\/docs\/PILOT_ACCEPTANCE_CRITERIA\.md/);
    assert.match(buildDesktop, /resources\/app\/docs\/PILOT_SUPPORT_GUIDE\.md/);
    assert.match(buildDesktop, /resources\/bin\/win32\/binaries\.lock\.json/);
    assert.match(buildDesktop, /\$releaseManifest/);
    assert.match(buildDesktop, /SyncraftDesktop\.zip/);
    assert.match(buildDesktop, /Compress-Archive/);
    assert.match(buildDesktop, /SyncraftDesktop\.zip\.sha256/);
    assert.match(buildDesktop, /Get-Sha256HexFromFile \$zipPathFull/);
    assert.match(buildDesktop, /Set-Content -LiteralPath \$checksumPathFull -Encoding ASCII/);
    assert.match(buildDesktop, /Remove-Item -LiteralPath \$zipPathFull -Force/);
    assert.match(buildClient, /smoke-client-package\.mjs/);
    assert.match(buildClient, /SFSC_CLIENT_PACKAGE_DIR/);
    assert.match(buildClient, /release-manifest\.json/);
    assert.match(buildClient, /docs\\INTERFACE_CONTRACT\.md/);
    assert.match(buildClient, /docs\\API_MATRIX\.md/);
    assert.match(buildClient, /docs\\INTERNAL_TRIAL_CHECKLIST\.md/);
    assert.match(buildClient, /docs\\PILOT_RUNBOOK\.md/);
    assert.match(buildClient, /docs\\PILOT_ACCEPTANCE_CRITERIA\.md/);
    assert.match(buildClient, /docs\\PILOT_SUPPORT_GUIDE\.md/);
    assert.match(buildClient, /app\/client\/src\/paths\.js/);
    assert.match(buildClient, /app\/client\/src\/store\.js/);
    assert.match(buildClient, /app\/client\/src\/diagnosticBundle\.js/);
    assert.match(buildClient, /app\/client\/src\/processRunner\.js/);
    assert.match(buildClient, /app\/client\/src\/rcloneStats\.js/);
    assert.match(buildClient, /app\/client\/src\/profileImport\.js/);
    assert.match(buildClient, /app\/client\/src\/launcher\.cjs/);
    assert.match(buildClient, /app\/client\/src\/Launcher\.cs/);
    assert.match(buildClient, /app\/client\/public\/app\.js/);
    assert.match(buildClient, /app\/client\/public\/styles\.css/);
    assert.match(buildClient, /app\/src\/core\/index\.js/);
    assert.match(buildClient, /resources\\app\\docs\\INTERFACE_CONTRACT\.md/);
    assert.match(buildClient, /resources\/app\/docs\/INTERFACE_CONTRACT\.md/);
    assert.match(buildClient, /resources\\app\\docs\\DEPLOYMENT_AND_MIGRATION_GUIDE\.md/);
    assert.match(buildClient, /resources\/app\/docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md/);
    assert.match(buildClient, /resources\\app\\docs\\INTERNAL_TRIAL_CHECKLIST\.md/);
    assert.match(buildClient, /resources\/app\/docs\/INTERNAL_TRIAL_CHECKLIST\.md/);
    assert.match(buildClient, /resources\\app\\docs\\PILOT_RUNBOOK\.md/);
    assert.match(buildClient, /resources\/app\/docs\/PILOT_RUNBOOK\.md/);
    assert.match(buildClient, /resources\\app\\docs\\PILOT_ACCEPTANCE_CRITERIA\.md/);
    assert.match(buildClient, /resources\/app\/docs\/PILOT_ACCEPTANCE_CRITERIA\.md/);
    assert.match(buildClient, /resources\\app\\docs\\PILOT_SUPPORT_GUIDE\.md/);
    assert.match(buildClient, /resources\/app\/docs\/PILOT_SUPPORT_GUIDE\.md/);
    assert.match(buildClient, /resources\/bin\/win32\/binaries\.lock\.json/);
    assert.match(buildClient, /package = "SyncraftClient"/);
    assert.match(buildClient, /Get-Sha256HexFromFile \$_.path/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("repository ignore rules exclude runtime state and secrets", async () => {
  const attributes = await readFile(join(projectRoot, ".gitattributes"), "utf8");
  const ignore = await readFile(join(projectRoot, ".gitignore"), "utf8");
  const pkg = await readFile(join(projectRoot, "package.json"), "utf8");
  const audit = await readFile(join(projectRoot, "scripts", "audit-release.mjs"), "utf8");

  assert.match(attributes, /^\* text=auto eol=lf$/m);
  assert.match(ignore, /node_modules\//);
  assert.match(ignore, /^dist\//m);
  assert.match(ignore, /^\.tmp\//m);
  assert.match(ignore, /^server\/\.env$/m);
  assert.match(ignore, /^!server\/\.env\.example$/m);
  assert.match(ignore, /^server\/data\//m);
  assert.match(ignore, /^server\/sing-box\/config\.json$/m);
  assert.match(ignore, /^dist\/\*\*\/data\//m);
  assert.match(pkg, /"audit:compose": "node scripts\/audit-compose\.mjs"/);
  assert.match(pkg, /"audit:release": "node scripts\/audit-release\.mjs"/);
  assert.match(audit, /auditComposeConfig/);
  assert.match(audit, /Blocked runtime path exists/);
  assert.match(audit, /function auditSingboxPlaceholderConfig/);
  assert.match(audit, /function auditClientPackageChecksum/);
  assert.match(audit, /function auditProductContractDocs/);
  assert.match(audit, /function auditProductIdentity/);
  assert.match(audit, /function auditSmokeContractDocs/);
  assert.match(audit, /function auditOperationalRecoveryDocs/);
  assert.match(audit, /function auditPilotDocs/);
  assert.match(audit, /function auditStableErrorCodeContract/);
  assert.match(audit, /function auditStableErrorCodeUiMessages/);
  assert.match(audit, /function auditRuntimeDiagnosticsContract/);
  assert.match(audit, /function auditHeartbeatSchedulerContract/);
  assert.match(audit, /function auditHeartbeatRemoteErrorCodeContract/);
  assert.match(audit, /function auditCompatibilityWarningContract/);
  assert.match(audit, /function auditDestructiveSyncConfirmationContract/);
  assert.match(audit, /function auditLocalStateCorruptionContract/);
  assert.match(audit, /function auditInterfaceRouteContract/);
  assert.match(audit, /function auditApiMatrixContract/);
  assert.match(audit, /function auditProtocolRequestSchemaCoverage/);
  assert.match(audit, /allowedBareReadJsonRoutes/);
  assert.match(audit, /SERVER_CLAIM_CREATE/);
  assert.match(audit, /SERVER_PROFILE_ENCODE/);
  assert.match(audit, /has unclassified bare readJson\(req\)/);
  assert.match(audit, /protocol schema debt allowlist entry is stale/);
  assert.match(audit, /function extractBareReadJsonUsages/);
  assert.match(audit, /function auditProductizedLanguage/);
  assert.match(audit, /DEFAULT_STATUS_BY_CODE/);
  assert.match(audit, /must document stable errorCode/);
  assert.match(audit, /extractFormatErrorCodes/);
  assert.match(audit, /formatError must map stable errorCode/);
  assert.match(audit, /diagnostics\.protocols\.\$\{field\} version \$\{version\}/);
  assert.match(audit, /schedule: normalizeScheduledJobSchedule\(input\.schedule\)/);
  assert.match(audit, /schedule: summarizeHeartbeatSchedule\(job\.schedule\)/);
  assert.match(audit, /Confirm protocol compatibility warning before saving or running sync\./);
  assert.match(audit, /Confirm mirror sync before saving or running sync\./);
  assert.match(audit, /确认向不兼容设备下发 SyncKey/);
  assert.match(audit, /safeguards\.localState/);
  assert.match(audit, /local_state_corrupt/);
  assert.match(audit, /Windows 客户端本地状态恢复/);
  assert.match(audit, /secret_vault_missing/);
  assert.match(audit, /shortCodeImport/);
  assert.match(audit, /createdClaim\.code/);
  assert.match(audit, /短码直传返回 `import_code_invalid`/);
  assert.match(audit, /missingVaultSave/);
  assert.match(audit, /missingVaultRun/);
  assert.match(audit, /assertNonEmptyString\(preview\.schedule\.text/);
  assert.match(audit, /assertNonEmptyString\(rclone\.remotePath/);
  assert.match(audit, /GET \/api\/diagnostics\/export/);
  assert.match(audit, /scripts\/lib\/runtimeContracts\.mjs/);
  assert.match(audit, /export function assertClientStatusContract/);
  assert.match(audit, /safeguards\.localState\.files/);
  assert.match(audit, /async function readSyncHistoryForWrite/);
  assert.match(audit, /async function importProfile\(body = \{\}\) \{\\n  return withClientStateLock\(paths, async \(\) => \{\\n    await ensureLocalStateWritable\(\);/);
  assert.match(audit, /\/api\/jobs\/save/);
  assert.match(audit, /const saveJobRouteSource = sourceWindow/);
  assert.match(audit, /"const body = parseProtocolRequest\(PROTOCOL_REQUESTS\.CLIENT_JOB_SAVE, await readJson\(req\)\);"/);
  assert.match(audit, /"requireSyncCompatibilityConfirmation\(body\);"/);
  assert.match(audit, /"requireDestructiveSyncConfirmation\(body\);"/);
  assert.match(audit, /"await ensureLocalStateWritable\(\);"/);
  assert.match(audit, /\/api\/jobs\/save must validate the shared protocol schema and confirmations before writing local state/);
  assert.match(audit, /let syncRunInFlight = null/);
  assert.match(audit, /const runPlan = await buildSyncRunPlan\(job\);/);
  assert.match(audit, /async function runSyncExclusive\(runPlan, options = \{\}\) \{\\n  const \{ normalizedJob, tunnelUri \} = runPlan;/);
  assert.match(audit, /must not read profile again inside runSyncExclusive/);
  assert.match(audit, /extractNumberConstant/);
  assert.match(audit, /routeMentionPattern/);
  assert.match(audit, /must document API route \$\{route\.method\} \$\{route\.path\}/);
  assert.match(audit, /extractImplementedRoutes/);
  assert.match(audit, /must document API route/);
  assert.match(audit, /must document consumed API path/);
  assert.match(audit, /extractOutboundApiPaths/);
  assert.match(audit, /crossRuntimePathPattern/);
  assert.match(audit, /cross-runtime table must document client outbound API path/);
  assert.match(audit, /requireText\(readme, "README\.md", "产品化基线"\)/);
  assert.match(audit, /`\$\{label\} must mention \$\{expected\}`/);
  assert.match(audit, /docs\/INTERFACE_CONTRACT\.md/);
  assert.match(audit, /src\/core\/errors\.js/);
  assert.match(audit, /docs\/API_MATRIX\.md/);
  assert.match(audit, /docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md/);
  assert.match(audit, /docs\/INTERNAL_TRIAL_CHECKLIST\.md/);
  assert.match(audit, /docs\/PILOT_RUNBOOK\.md/);
  assert.match(audit, /docs\/PILOT_ACCEPTANCE_CRITERIA\.md/);
  assert.match(audit, /docs\/PILOT_SUPPORT_GUIDE\.md/);
  assert.match(audit, /Server health\/state diagnostics protocol mismatch/);
  assert.match(audit, /Client health\/status diagnostics protocol mismatch/);
  assert.match(audit, /protocols=aligned/);
  assert.match(audit, /health-readiness/);
  assert.match(audit, /server_state_corrupt/);
  assert.match(audit, /server_state_locked/);
  assert.match(audit, /server_state_write_failed/);
  assert.match(audit, /server_singbox_config_write_failed/);
  assert.match(audit, /SINGBOX_CONFIG_PATH/);
  assert.match(audit, /nonProductLanguagePattern/);
  assert.match(audit, /proof of concept/);
  assert.match(audit, /演示版/);
  assert.match(audit, /package\.json name must match src\/core\/diagnostics\.js APP_ID/);
  assert.match(audit, /must emit app id/);
  assert.match(audit, /app id \$\{value\} must match \$\{appId\}/);
  assert.match(audit, /stable interface contract/);
  assert.match(audit, /package\.json name must use productized wording instead of MVP\/demo language/);
  assert.match(audit, /package\.json description must not describe the product as an MVP\/demo/);
  assert.match(audit, /must use productized wording instead of MVP\/demo language/);
  assert.match(audit, /createHash\("sha256"\)/);
  assert.match(audit, /function auditZipChecksum\(packageName\)/);
  assert.match(audit, /function auditClientPackageZipEntries\(packageName, relZip, zipData\)/);
  assert.match(audit, /function auditClientPackageManifestContractConsistency/);
  assert.match(audit, /function extractRuntimeRequiredManifestPaths/);
  assert.match(audit, /function comparePathSets/);
  assert.match(audit, /is missing required manifest path/);
  assert.match(audit, /contains unexpected manifest path/);
  assert.match(audit, /function listZipEntries\(zipData\)/);
  assert.match(audit, /function findEndOfCentralDirectory\(zipData\)/);
  assert.match(audit, /ZIP central directory/);
  assert.match(audit, /exists without \$\{relZip\}/);
  assert.match(audit, /\$\{relZip\} is missing \$\{relChecksum\}/);
  assert.match(audit, /does not match \$\{relZip\}/);
  assert.match(audit, /missing packaged entry/);
  assert.match(audit, /contains blocked runtime entry/);
  assert.match(audit, /SyncraftClient/);
  assert.match(audit, /server\/sing-box\/config\.json contains a REALITY private_key/);
  assert.match(audit, /server\/sing-box\/config\.json contains a non-placeholder UUID/);
  assert.match(audit, /looks like a real admin token/);
  assert.match(audit, /looks like a real private\/storage secret/);
});

test("source fingerprint hashing does not require Get-FileHash", async () => {
  const helperPath = join(projectRoot, "scripts", "lib", "build-fingerprint.ps1").replaceAll("'", "''");
  const repoPath = projectRoot.replaceAll("'", "''");
  const command = [
    `. '${helperPath}'`,
    "Set-Item Function:\\Get-FileHash -Value { throw 'Get-FileHash disabled by portability test' } -Force",
    `$fingerprint = Get-SourceTreeFingerprint -RepoRoot '${repoPath}'`,
    "if ($fingerprint.hash -notmatch '^[a-f0-9]{64}$') { throw 'invalid source fingerprint hash' }"
  ].join("; ");

  const result = await new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      command
    ], { cwd: projectRoot }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });

  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test("release PowerShell scripts use the portable SHA-256 helper", async () => {
  const runtimeScripts = [
    "scripts/build-release-bundle.ps1",
    "scripts/post-deploy-n1.ps1",
    "client/scripts/build-client.ps1",
    "client/scripts/build-desktop.ps1",
    "client/scripts/download-binaries.ps1"
  ];

  for (const relativePath of runtimeScripts) {
    const source = await readFile(join(projectRoot, ...relativePath.split("/")), "utf8");
    assert.doesNotMatch(source, /\bGet-FileHash\b/, `${relativePath} must not depend on Get-FileHash`);
    assert.match(source, /Get-Sha256HexFromFile/, `${relativePath} must use the portable SHA-256 helper`);
  }
});

test("compose config audit enforces fixed image tags", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-compose-audit-"));
  try {
    await writeComposeAuditFixture(tempRoot);
    const valid = await runComposeAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Compose config audit passed/);

    await writeFile(
      join(tempRoot, "server", "docker-compose.n1.yml"),
      (await readFile(join(tempRoot, "server", "docker-compose.n1.yml"), "utf8"))
        .replace("quay.io/minio/minio:${MINIO_IMAGE_TAG:-RELEASE.2025-09-07T16-13-09Z}", "quay.io/minio/minio:latest"),
      "utf8"
    );
    const latest = await runComposeAudit(tempRoot);
    assert.notEqual(latest.code, 0);
    assert.match(latest.stderr, /server\/docker-compose\.n1\.yml must not use :latest image tags/);
    assert.match(latest.stderr, /service minio must use image quay\.io\/minio\/minio:\$\{MINIO_IMAGE_TAG:-RELEASE\.2025-09-07T16-13-09Z\}/);

    await writeComposeAuditFixture(tempRoot);
    await writeFile(
      join(tempRoot, "server", ".env.example"),
      (await readFile(join(tempRoot, "server", ".env.example"), "utf8"))
        .replace("MINIO_MC_IMAGE_TAG=RELEASE.2025-08-13T08-35-41Z", "MINIO_MC_IMAGE_TAG=latest"),
      "utf8"
    );
    const envDrift = await runComposeAudit(tempRoot);
    assert.notEqual(envDrift.code, 0);
    assert.match(envDrift.stderr, /server\/\.env\.example must set MINIO_MC_IMAGE_TAG=RELEASE\.2025-08-13T08-35-41Z/);

    await writeComposeAuditFixture(tempRoot);
    await writeFile(
      join(tempRoot, "server", ".env.example"),
      (await readFile(join(tempRoot, "server", ".env.example"), "utf8"))
        .replace("S3_ENDPOINT=http://minio:9000", "S3_ENDPOINT=http://other-minio:9000"),
      "utf8"
    );
    const envEndpointDrift = await runComposeAudit(tempRoot);
    assert.notEqual(envEndpointDrift.code, 0);
    assert.match(envEndpointDrift.stderr, /server\/\.env\.example must set S3_ENDPOINT=http:\/\/minio:9000/);

    await writeComposeAuditFixture(tempRoot);
    await writeFile(
      join(tempRoot, "server", "docker-compose.yml"),
      (await readFile(join(tempRoot, "server", "docker-compose.yml"), "utf8"))
        .replace("SFSC_REQUIRE_ADMIN_TOKEN: \"1\"", "SFSC_REQUIRE_ADMIN_TOKEN: \"0\""),
      "utf8"
    );
    const adminRequireDrift = await runComposeAudit(tempRoot);
    assert.notEqual(adminRequireDrift.code, 0);
    assert.match(adminRequireDrift.stderr, /server\/docker-compose\.yml must include SFSC_REQUIRE_ADMIN_TOKEN: "1"/);

    // CORE-4: reintroducing the weak placeholder MinIO password default must fail.
    await writeComposeAuditFixture(tempRoot);
    await writeFile(
      join(tempRoot, "server", "docker-compose.yml"),
      (await readFile(join(tempRoot, "server", "docker-compose.yml"), "utf8"))
        .replaceAll(
          "MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD before starting the server}",
          "MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:-change-this-minio-root-password}"
        ),
      "utf8"
    );
    const weakMinioDefaultDrift = await runComposeAudit(tempRoot);
    assert.notEqual(weakMinioDefaultDrift.code, 0);
    assert.match(weakMinioDefaultDrift.stderr, /server\/docker-compose\.yml must not fall back to the placeholder MinIO password/);

    await writeComposeAuditFixture(tempRoot);
    await writeFile(
      join(tempRoot, "server", "docker-compose.n1.yml"),
      (await readFile(join(tempRoot, "server", "docker-compose.n1.yml"), "utf8"))
        .replace("SFSC_ADMIN_TOKEN: ${SFSC_ADMIN_TOKEN:?set SFSC_ADMIN_TOKEN before starting the server}", "SFSC_ADMIN_TOKEN: ${SFSC_ADMIN_TOKEN:-}"),
      "utf8"
    );
    const adminTokenRequiredDrift = await runComposeAudit(tempRoot);
    assert.notEqual(adminTokenRequiredDrift.code, 0);
    assert.match(adminTokenRequiredDrift.stderr, /server\/docker-compose\.n1\.yml must include SFSC_ADMIN_TOKEN: \$\{SFSC_ADMIN_TOKEN:\?set SFSC_ADMIN_TOKEN before starting the server\}/);

    await writeComposeAuditFixture(tempRoot);
    await writeFile(
      join(tempRoot, "server", "docker-compose.n1.yml"),
      (await readFile(join(tempRoot, "server", "docker-compose.n1.yml"), "utf8"))
        .replace("S3_ENDPOINT: http://minio:9000", "S3_ENDPOINT: http://n1-minio.sfsc:9000"),
      "utf8"
    );
    const n1InternalEndpointDrift = await runComposeAudit(tempRoot);
    assert.notEqual(n1InternalEndpointDrift.code, 0);
    assert.match(n1InternalEndpointDrift.stderr, /server\/docker-compose\.n1\.yml must include S3_ENDPOINT: http:\/\/minio:9000/);

    await writeComposeAuditFixture(tempRoot);
    await writeFile(
      join(tempRoot, "server", "docker-compose.n1.yml"),
      (await readFile(join(tempRoot, "server", "docker-compose.n1.yml"), "utf8"))
        .replace("S3_CLIENT_ENDPOINT: http://n1-minio.sfsc:9000", "S3_CLIENT_ENDPOINT: http://minio:9000"),
      "utf8"
    );
    const n1EndpointDrift = await runComposeAudit(tempRoot);
    assert.notEqual(n1EndpointDrift.code, 0);
    assert.match(n1EndpointDrift.stderr, /server\/docker-compose\.n1\.yml must include S3_CLIENT_ENDPOINT: http:\/\/n1-minio\.sfsc:9000/);

    await writeComposeAuditFixture(tempRoot);
    await writeFile(
      join(tempRoot, "server", "docker-compose.n1.yml"),
      (await readFile(join(tempRoot, "server", "docker-compose.n1.yml"), "utf8"))
        .replace("/ssd/sfsc-test/minio:/data", "./data/minio:/data"),
      "utf8"
    );
    const n1StorageMountDrift = await runComposeAudit(tempRoot);
    assert.notEqual(n1StorageMountDrift.code, 0);
    assert.match(n1StorageMountDrift.stderr, /server\/docker-compose\.n1\.yml must include - \/ssd\/sfsc-test\/minio:\/data/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("server request body size errors use an explicit stable code", async () => {
  const server = await readFile(join(projectRoot, "src", "server.js"), "utf8");
  const clientServer = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");
  const sharedHttp = await readFile(join(projectRoot, "src", "core", "httpJson.js"), "utf8");
  const contractHttp = await readFile(join(projectRoot, "tests", "contract-http.test.js"), "utf8");
  const clientHttp = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
  const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
  const matrix = await readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8");

  assert.match(server, /readJson/);
  assert.match(server, /createHttpError\("profile_tunnel_required", 400, "Profile tunnel\.uri is required"\)/);
  assert.match(clientServer, /readJson/);
  assert.match(clientServer, /createHttpError\("local_write_forbidden", 403/);
  assert.match(sharedHttp, /createHttpError\("request_body_too_large", 413, "Request body too large"\)/);
  assert.match(sharedHttp, /Buffer\.concat\(chunks, size\)\.toString\("utf8"\)/);
  assert.match(sharedHttp, /createHttpError\("invalid_json", 400, "Invalid JSON"\)/);
  assert.match(sharedHttp, /createHttpError\("unsupported_media_type", 415/);
  assert.match(contractHttp, /oversizedJson/);
  assert.match(contractHttp, /request_body_too_large/);
  assert.match(clientHttp, /oversizedImport/);
  assert.match(clientHttp, /request_body_too_large/);
  assert.match(clientHttp, /local_write_forbidden/);
  assert.match(clientHttp, /unsupported_media_type/);
  assert.match(contract, /`403 local_write_forbidden`/);
  assert.match(contract, /`415 unsupported_media_type`/);
  assert.match(matrix, /`403 local_write_forbidden`/);
  assert.match(matrix, /`415 unsupported_media_type`/);
});

test("static file serving uses directory-boundary path checks", async () => {
  const server = await readFile(join(projectRoot, "src", "server.js"), "utf8");
  const clientServer = await readFile(join(projectRoot, "client", "src", "clientServer.js"), "utf8");

  for (const source of [server, clientServer]) {
    assert.match(source, /function isPathInside\(baseDir, targetPath\)/);
    assert.match(source, /target === base \|\| target\.startsWith\(`\$\{base\}\$\{sep\}`\)/);
    assert.match(source, /decodeURIComponent\(requested\)/);
  }

  assert.doesNotMatch(server, /fullPath\.startsWith\(publicDir\)/);
  assert.doesNotMatch(clientServer, /fullPath\.startsWith\(paths\.publicDir\)/);
});

test("release audit validates client ZIP checksum sidecar", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-checksum-"));
  try {
    await writeReleaseAuditFixture(tempRoot);
    await mkdir(join(tempRoot, "dist"), { recursive: true });
    const zipContent = fakeClientZipContent("SyncraftDesktop");
    const zipPath = join(tempRoot, "dist", "SyncraftDesktop.zip");
    const checksumPath = join(tempRoot, "dist", "SyncraftDesktop.zip.sha256");
    await writeFile(checksumPath, `${"0".repeat(64)}  SyncraftDesktop.zip\n`, "utf8");
    const orphanChecksum = await runReleaseAudit(tempRoot);
    assert.notEqual(orphanChecksum.code, 0);
    assert.match(orphanChecksum.stderr, /sha256 exists without dist\/SyncraftDesktop\.zip/);
    await rm(checksumPath, { force: true });

    await writeFile(zipPath, zipContent);

    const missingChecksum = await runReleaseAudit(tempRoot);
    assert.notEqual(missingChecksum.code, 0);
    assert.match(missingChecksum.stderr, /missing dist\/SyncraftDesktop\.zip\.sha256/);

    await writeFile(checksumPath, `${"0".repeat(64)}  SyncraftDesktop.zip\n`, "utf8");
    const mismatchedChecksum = await runReleaseAudit(tempRoot);
    assert.notEqual(mismatchedChecksum.code, 0);
    assert.match(mismatchedChecksum.stderr, /does not match dist\/SyncraftDesktop\.zip/);

    const actual = createHash("sha256").update(zipContent).digest("hex");
    await writeFile(checksumPath, `${actual}  SyncraftDesktop.zip\n`, "utf8");
    const validChecksum = await runReleaseAudit(tempRoot);
    assert.equal(validChecksum.code, 0);
    assert.match(validChecksum.stdout, /Release audit passed/);

    await writeFile(zipPath, fakeClientZipContent("SyncraftDesktop", { omit: "resources/app/docs/API_MATRIX.md" }));
    const missingZipEntryHash = createHash("sha256").update(await readFile(zipPath)).digest("hex");
    await writeFile(checksumPath, `${missingZipEntryHash}  SyncraftDesktop.zip\n`, "utf8");
    const missingZipEntry = await runReleaseAudit(tempRoot);
    assert.notEqual(missingZipEntry.code, 0);
    assert.match(missingZipEntry.stderr, /missing packaged entry SyncraftDesktop\/resources\/app\/docs\/API_MATRIX\.md/);

    await writeFile(zipPath, fakeClientZipContent("SyncraftDesktop", { extra: "data/secrets.json" }));
    const blockedZipEntryHash = createHash("sha256").update(await readFile(zipPath)).digest("hex");
    await writeFile(checksumPath, `${blockedZipEntryHash}  SyncraftDesktop.zip\n`, "utf8");
    const blockedZipEntry = await runReleaseAudit(tempRoot);
    assert.notEqual(blockedZipEntry.code, 0);
    assert.match(blockedZipEntry.stderr, /contains blocked runtime entry SyncraftDesktop\/data\//);

    await writeFile(zipPath, zipContent);
    await writeFile(checksumPath, `${actual}  SyncraftDesktop.zip\n`, "utf8");

    const portableZipPath = join(tempRoot, "dist", "SyncraftClient.zip");
    const portableChecksumPath = join(tempRoot, "dist", "SyncraftClient.zip.sha256");
    const portableZipContent = fakeClientZipContent("SyncraftClient");
    await writeFile(portableZipPath, portableZipContent);
    const missingPortableChecksum = await runReleaseAudit(tempRoot);
    assert.notEqual(missingPortableChecksum.code, 0);
    assert.match(missingPortableChecksum.stderr, /missing dist\/SyncraftClient\.zip\.sha256/);

    await writeFile(portableChecksumPath, `${"0".repeat(64)}  SyncraftClient.zip\n`, "utf8");
    const mismatchedPortableChecksum = await runReleaseAudit(tempRoot);
    assert.notEqual(mismatchedPortableChecksum.code, 0);
    assert.match(mismatchedPortableChecksum.stderr, /does not match dist\/SyncraftClient\.zip/);

    const portableActual = createHash("sha256").update(portableZipContent).digest("hex");
    await writeFile(portableChecksumPath, `${portableActual}  SyncraftClient.zip\n`, "utf8");
    const validBothChecksums = await runReleaseAudit(tempRoot);
    assert.equal(validBothChecksums.code, 0);
    assert.match(validBothChecksums.stdout, /Release audit passed/);

    const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
    await writeFile(join(tempRoot, "package.json"), JSON.stringify({
      ...rootPackage,
      description: "MVP wrapper"
    }, null, 2), "utf8");
    const mvpDescription = await runReleaseAudit(tempRoot);
    assert.notEqual(mvpDescription.code, 0);
    assert.match(mvpDescription.stderr, /description must mention the stable interface contract/);
    assert.match(mvpDescription.stderr, /description must not describe the product as an MVP\/demo/);

    await writeFile(join(tempRoot, "package.json"), JSON.stringify({
      ...rootPackage,
      description: "Stable interface contract proof of concept"
    }, null, 2), "utf8");
    const pocDescription = await runReleaseAudit(tempRoot);
    assert.notEqual(pocDescription.code, 0);
    assert.match(pocDescription.stderr, /description must not describe the product as an MVP\/demo/);

    await writeFile(join(tempRoot, "package.json"), JSON.stringify({
      ...rootPackage,
      name: "singbox-folder-sync-mvp"
    }, null, 2), "utf8");
    const mvpPackageName = await runReleaseAudit(tempRoot);
    assert.notEqual(mvpPackageName.code, 0);
    assert.match(mvpPackageName.stderr, /package\.json name must use productized wording instead of MVP\/demo language/);

    await writeFile(join(tempRoot, "package.json"), JSON.stringify({
      ...rootPackage,
      name: "singbox-folder-sync-poc"
    }, null, 2), "utf8");
    const pocPackageName = await runReleaseAudit(tempRoot);
    assert.notEqual(pocPackageName.code, 0);
    assert.match(pocPackageName.stderr, /package\.json name must use productized wording instead of MVP\/demo language/);

    await writeFile(join(tempRoot, "package.json"), JSON.stringify(rootPackage, null, 2), "utf8");
    await writeFile(join(tempRoot, "src", "core", "storage.js"), "export const label = 'demo runtime';\n", "utf8");
    const demoRuntimeLanguage = await runReleaseAudit(tempRoot);
    assert.notEqual(demoRuntimeLanguage.code, 0);
    assert.match(demoRuntimeLanguage.stderr, /src\/core\/storage\.js:1 must use productized wording instead of MVP\/demo language/);

    await writeFile(join(tempRoot, "src", "core", "storage.js"), "export const label = '演示版 runtime';\n", "utf8");
    const chineseDemoRuntimeLanguage = await runReleaseAudit(tempRoot);
    assert.notEqual(chineseDemoRuntimeLanguage.code, 0);
    assert.match(chineseDemoRuntimeLanguage.stderr, /src\/core\/storage\.js:1 must use productized wording instead of MVP\/demo language/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit validates release bundle ZIP evidence", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-bundle-"));
  try {
    await writeReleaseAuditFixture(tempRoot);
    await writeFakeReleaseBundleZip(tempRoot, "fixture-release");
    const validBundle = await runReleaseAudit(tempRoot);
    assert.equal(validBundle.code, 0, validBundle.stderr || validBundle.stdout);

    await writeFakeReleaseBundleZip(tempRoot, "fixture-release", {
      omit: "scripts/smoke-client.mjs"
    });
    const missingScript = await runReleaseAudit(tempRoot);
    assert.notEqual(missingScript.code, 0);
    assert.match(missingScript.stderr, /missing release bundle entry fixture-release\/scripts\/smoke-client\.mjs/);

    await writeFakeReleaseBundleZip(tempRoot, "fixture-release", {
      corruptReport: "reports/release-bundle/client-package-smoke-desktop.json"
    });
    const corruptReport = await runReleaseAudit(tempRoot);
    assert.notEqual(corruptReport.code, 0);
    assert.match(
      corruptReport.stderr,
      /bundled report reports\/release-bundle\/client-package-smoke-desktop\.json does not match release-bundle-manifest\.json SHA256/
    );

    await writeFakeReleaseBundleZip(tempRoot, "fixture-release", {
      omit: "reports/release-bundle/client-package-smoke-portable.json"
    });
    const missingSmokeReport = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSmokeReport.code, 0);
    assert.match(
      missingSmokeReport.stderr,
      /missing release bundle preflight report fixture-release\/reports\/release-bundle\/client-package-smoke-portable\.json/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client trial runner imports, saves, previews, and keeps SyncKey out of reports", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-trial-runner-"));
  const localPath = join(tempRoot, "SFSC Trial Folder");
  const reportPath = join(tempRoot, "client-trial-runner.json");
  const packageManifestPath = join(tempRoot, "release-manifest.json");
  const clientExecutablePath = join(tempRoot, "SFSC Client.exe");
  const packageZipPath = join(tempRoot, "SyncraftDesktop.zip");
  const tKey = "SFSC1-secret-client-trial-runner-token";
  const requests = [];
  let profileImported = false;
  let savedJob = null;

  await mkdir(localPath, { recursive: true });
  await writeFile(join(localPath, "hello.txt"), "hello\n", "utf8");
  await writeFile(clientExecutablePath, "fixture executable", "utf8");
  await writeFile(packageZipPath, "fixture package zip", "utf8");
  await writeFile(packageManifestPath, JSON.stringify({
    package: "SyncraftDesktop",
    version: "0.3.0-rc.1",
    buildId: "sfsc-aaaaaaaaaaaa",
    sourceTreeHash: "a".repeat(64)
  }), "utf8");

  const server = createServer(async (req, res) => {
    const body = await readJsonRequest(req);
    requests.push({ method: req.method, url: req.url, body });
    res.setHeader("content-type", "application/json");

    if (req.method === "GET" && req.url === "/api/health") {
      res.end(JSON.stringify({ ok: true, clientVersion: "0.3.0-rc.1" }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/client/status") {
      res.end(JSON.stringify({
        ok: true,
        profileImported,
        profileSummary: profileImported ? { clientName: "trial-pc" } : null,
        jobs: savedJob ? [savedJob] : []
      }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/profile/import") {
      assert.equal(body.code, tKey);
      profileImported = true;
      res.end(JSON.stringify({ profile: { clientName: "trial-pc" } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/jobs/save") {
      savedJob = body.job;
      res.end(JSON.stringify({ job: body.job, scheduler: { enabled: false } }));
      return;
    }
    if (req.method === "POST" && req.url === "/api/sync/preview") {
      res.end(JSON.stringify({
        rclone: {
          remotePath: "trial-bucket/devices/trial-pc/internal-trial",
          displayCommand: "rclone sync <local> <remote>",
          remoteConfig: { displayCommand: "rclone config create trial" }
        },
        schedule: { text: "manual", nextRun: null },
        singbox: {}
      }));
      return;
    }
    if (req.method === "GET" && req.url === "/api/diagnostics/export") {
      res.end(JSON.stringify({
        filename: "sfsc-client-diagnostics-trial.json",
        bundle: {
          app: "singbox-folder-sync",
          summary: { releaseManifestOk: true },
          status: {},
          logs: {
            rclone: { text: "redacted", meta: {} },
            singbox: { text: "", meta: {} }
          }
        }
      }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, errorCode: "not_found" }));
  });

  try {
    await listen(server);
    const address = server.address();
    const result = await runClientTrialRunner([
      "--base-url", `http://127.0.0.1:${address.port}`,
      "--t-key", tKey,
      "--local-path", localPath,
      "--remote-folder", "internal-trial",
      "--json-report", reportPath,
      "--client-package-type", "desktop",
      "--client-package-manifest", packageManifestPath,
      "--client-executable", clientExecutablePath,
      "--client-package-zip", packageZipPath,
      "--timeout-ms", "2000",
      "--wait-timeout-ms", "2000"
    ]);

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const reportText = await readFile(reportPath, "utf8");
    assert.equal(reportText.includes(tKey), false);
    const report = JSON.parse(reportText);
    assert.equal(report.ok, true);
    assert.equal(report.mode, "profile-preview");
    assert.equal(report.context.tKeySha256, createHash("sha256").update(tKey).digest("hex"));
    assert.equal(report.context.tKeyLength, tKey.length);
    assert.equal(report.context.clientPackage.packageType, "desktop");
    assert.equal(report.context.clientPackage.package, "SyncraftDesktop");
    assert.equal(report.context.clientPackage.buildId, "sfsc-aaaaaaaaaaaa");
    assert.equal(report.context.clientPackage.executableSha256, createHash("sha256").update("fixture executable").digest("hex"));
    assert.equal(report.context.clientPackage.releaseManifestSha256, createHash("sha256").update(await readFile(packageManifestPath)).digest("hex"));
    assert.equal(report.context.clientPackage.packageZipSha256, createHash("sha256").update("fixture package zip").digest("hex"));
    assert.equal(report.checks.some((check) => check.name === "sync-run-skipped"), true);
    assert.equal(requests.some((request) => request.url === "/api/sync/run"), false);
    assert.equal(savedJob.localPath, localPath);
    assert.equal(savedJob.remoteFolder, "internal-trial");
  } finally {
    await closeServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("client trial runner refuses real sync without explicit acknowledgement", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-client-trial-runner-refuse-"));
  const localPath = join(tempRoot, "trial");
  const reportPath = join(tempRoot, "client-trial-runner-refuse.json");
  const tKey = "SFSC1-refuse-real-sync-token";
  try {
    await mkdir(localPath, { recursive: true });
    const result = await runClientTrialRunner([
      "--run-sync",
      "--t-key", tKey,
      "--local-path", localPath,
      "--json-report", reportPath
    ]);

    assert.notEqual(result.code, 0);
    const reportText = await readFile(reportPath, "utf8");
    assert.equal(reportText.includes(tKey), false);
    const report = JSON.parse(reportText);
    assert.equal(report.ok, false);
    assert.match(report.failure.message, /Refusing to run real sync without --i-understand-real-sync/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("internal trial prepare writes command sheet and sample files without storing SyncKey", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-internal-trial-prepare-"));
  const localPath = join(tempRoot, "SFSC 测试 A");
  const markdownPath = join(tempRoot, "internal-trial-command-sheet.md");
  const jsonPath = join(tempRoot, "internal-trial-command-sheet.json");
  const tKey = "SFSC1-prepare-should-not-be-stored";
  try {
    const result = await runInternalTrialPrepare([
      "--output", markdownPath,
      "--json-output", jsonPath,
      "--local-path", localPath,
      "--remote-folder", "internal-trial-prepare",
      "--tester", "QA"
    ], {
      SFSC_TRIAL_T_KEY: tKey
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    const markdown = await readFile(markdownPath, "utf8");
    const jsonText = await readFile(jsonPath, "utf8");
    assert.equal(markdown.includes(tKey), false);
    assert.equal(jsonText.includes(tKey), false);
    assert.match(markdown, /internal-trial-prepare/);
    assert.match(markdown, /\$env:SFSC_TRIAL_T_KEY="<完整 SyncKey>"/);
    assert.match(markdown, /pnpm run trial:create-t-key/);
    assert.match(markdown, /--i-understand-real-sync/);
    assert.match(markdown, /pnpm run trial:record:update/);

    const report = JSON.parse(jsonText);
    assert.equal(report.type, "internal-trial-command-sheet");
    assert.equal(report.safety.tKeyPlaintextStored, false);
    assert.equal(report.environment.tester, "QA");
    assert.equal(report.trial.localPath, localPath);
    assert.equal(report.trial.remoteFolder, "internal-trial-prepare");
    assert.match(report.commands.updateEnvironment, /trial:record:update/);
    assert.match(report.commands.createTrialTKey, /trial:create-t-key/);
    assert.equal(report.trial.sampleFiles.length, 3);
    await access(join(localPath, "hello.txt"));
    await access(join(localPath, "中文 空格.txt"));
    await access(join(localPath, "nested", "notes.md"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release status summarizes preflight bundle and N1 evidence without secrets", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-release-status-"));
  const sourceTreeHash = "b".repeat(64);
  const buildId = `sfsc-${sourceTreeHash.slice(0, 12)}`;
  const bundleSha = "c".repeat(64);
  try {
    await mkdir(join(tempRoot, "reports", "release"), { recursive: true });
    await mkdir(join(tempRoot, "reports", "n1", "latest-run"), { recursive: true });
    await mkdir(join(tempRoot, "dist", "release-bundles", "singbox-folder-sync-0.3.0-rc.1-release"), { recursive: true });
    await writeFile(join(tempRoot, "dist", "release-bundles", "singbox-folder-sync-0.3.0-rc.1-release.zip"), "zip", "utf8");
    await writeFile(
      join(tempRoot, "dist", "release-bundles", "singbox-folder-sync-0.3.0-rc.1-release.zip.sha256"),
      `${bundleSha}  singbox-folder-sync-0.3.0-rc.1-release.zip\n`,
      "utf8"
    );
    await writeFile(join(tempRoot, "reports", "release", "preflight.json"), JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      type: "preflight-report",
      ok: true,
      releaseOk: true,
      context: {
        SourceTreeHash: sourceTreeHash,
        BuildId: buildId
      },
      summary: { passed: 6, failed: 0, skipped: 0 }
    }, null, 2), "utf8");
    await writeFile(
      join(tempRoot, "dist", "release-bundles", "singbox-folder-sync-0.3.0-rc.1-release", "release-bundle-manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        app: "singbox-folder-sync",
        type: "release-bundle-manifest",
        version: "0.3.0-rc.1",
        generatedAt: "2026-07-09T00:00:00.000Z",
        sourceTreeHash,
        buildId,
        preflightVerified: true,
        preflightVerification: {
          summary: { passed: 6, failed: 0, skipped: 0 }
        }
      }, null, 2),
      "utf8"
    );
    const n1SummaryPath = join(tempRoot, "reports", "n1", "latest-run", "post-deploy-summary.json");
    await writeFile(n1SummaryPath, JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      type: "n1-post-deploy-report",
      ok: true,
      runId: "latest-run",
      acceptance: {
        target: { targetHostsMatch: true },
        releaseAcceptance: {
          ok: true,
          releaseBundleVerified: true,
          finalRestartClear: true,
          restartRequired: false
        },
        delivery: {
          releaseBundle: {
            buildId,
            sourceTreeHash
          }
        }
      }
    }, null, 2), "utf8");
    await writeFile(join(tempRoot, "reports", "n1", "latest-post-deploy.json"), JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      type: "n1-post-deploy-latest",
      ok: true,
      runId: "latest-run",
      summaryJson: n1SummaryPath
    }, null, 2), "utf8");

    const text = await runReleaseStatus(["--repo-root", tempRoot]);
    assert.equal(text.code, 0, text.stderr || text.stdout);
    assert.match(text.stdout, /SFSC release status/);
    assert.match(text.stdout, /ok=true/);
    assert.match(text.stdout, new RegExp(`bundle=verified buildId=${buildId} sha256=${bundleSha}`));
    assert.match(text.stdout, /n1=ok runId=latest-run releaseAcceptance=ok finalRestartClear=true/);
    assert.match(text.stdout, /currentSource=not-checked buildId=n\/a/);
    assert.match(text.stdout, new RegExp(`sourceAlignment=ok buildId=${buildId}`));
    assert.doesNotMatch(text.stdout, /SFSC1-|sfsc:\/\/import\/v1#|vless:\/\/|secretAccessKey|ADMIN_TOKEN/);

    const json = await runReleaseStatus(["--repo-root", tempRoot, "--json", "--fail-on-not-ready"]);
    assert.equal(json.code, 0, json.stderr || json.stdout);
    const report = JSON.parse(json.stdout);
    assert.equal(report.type, "release-status-summary");
    assert.equal(report.ok, true);
    assert.equal(report.releaseBundle.sha256, bundleSha);
    assert.equal(report.n1.runId, "latest-run");
    assert.equal(report.currentSource.checked, false);
    assert.equal(report.sourceAlignment.ok, true);

    await writeFile(join(tempRoot, "package.json"), "{\"name\":\"changed-source\"}\n", "utf8");
    const drift = await runReleaseStatus(["--repo-root", tempRoot, "--json", "--fail-on-not-ready"]);
    assert.equal(drift.code, 1, drift.stderr || drift.stdout);
    const driftReport = JSON.parse(drift.stdout);
    assert.equal(driftReport.ok, false);
    assert.equal(driftReport.currentSource.checked, true);
    assert.equal(driftReport.currentSource.ok, false);
    assert.equal(driftReport.sourceAlignment.ok, false);
    await rm(join(tempRoot, "package.json"), { force: true });

    await writeFile(join(tempRoot, "package.json"), JSON.stringify({ version: "0.3.0-rc.1" }), "utf8");
    await mkdir(join(tempRoot, "dist", "release-bundles", "singbox-folder-sync-0.3.0-rc.1-release"), { recursive: true });
    const nextVersion = await runReleaseStatus(["--repo-root", tempRoot, "--json"]);
    assert.equal(nextVersion.code, 0, nextVersion.stderr || nextVersion.stdout);
    const nextVersionReport = JSON.parse(nextVersion.stdout);
    assert.equal(nextVersionReport.releaseBundle.version, "0.3.0-rc.1");
    assert.equal(nextVersionReport.releaseBundle.zipPath, "dist/release-bundles/singbox-folder-sync-0.3.0-rc.1-release.zip");

    const preflight = JSON.parse(await readFile(join(tempRoot, "reports", "release", "preflight.json"), "utf8"));
    preflight.summary.failed = 1;
    preflight.releaseOk = false;
    await writeFile(join(tempRoot, "reports", "release", "preflight.json"), JSON.stringify(preflight, null, 2), "utf8");
    const notReady = await runReleaseStatus(["--repo-root", tempRoot, "--fail-on-not-ready"]);
    assert.notEqual(notReady.code, 0);
    assert.match(notReady.stdout, /ok=false/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("pilot wave tools prepare participant records and summarize without storing secrets", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-pilot-wave-"));
  const cohortDir = join(tempRoot, "pilot-wave");
  const summaryPath = join(cohortDir, "pilot-summary.json");
  const tKey = "SFSC1-pilot-should-not-be-stored";
  try {
    const prepare = await runPilotPrepare([
      "--cohort-id", "pilot-test",
      "--output-dir", cohortDir,
      "--server-base-url", "https://sync.example.test",
      "--participant", "pilot-001:Alice:PC-A",
      "--participant", "pilot-002:Bob:PC-B"
    ], {
      SFSC_TRIAL_T_KEY: tKey
    });

    assert.equal(prepare.code, 0, prepare.stderr || prepare.stdout);
    const waveText = await readFile(join(cohortDir, "pilot-wave.json"), "utf8");
    const commandSheet = await readFile(join(cohortDir, "pilot-wave-command-sheet.md"), "utf8");
    const dailyHealthText = await readFile(join(cohortDir, "pilot-daily-health.json"), "utf8");
    const participantRecordPath = join(cohortDir, "pilot-001", "participant-record.json");
    const participantRecordText = await readFile(participantRecordPath, "utf8");
    assert.equal(waveText.includes(tKey), false);
    assert.equal(commandSheet.includes(tKey), false);
    assert.equal(dailyHealthText.includes(tKey), false);
    assert.equal(participantRecordText.includes(tKey), false);
    assert.match(commandSheet, /pnpm run pilot:summary/);

    const dailyHealth = JSON.parse(dailyHealthText);
    assert.equal(dailyHealth.type, "pilot-daily-health");
    assert.equal(dailyHealth.cohortId, "pilot-test");
    assert.equal(dailyHealth.records.length, 3);
    assert.equal(dailyHealth.records[0].n1HealthOk, null);
    assert.equal(dailyHealth.records[0].restartRequired, null);
    assert.equal(dailyHealth.safety.plaintextTKeyStored, false);

    const insecure = await runPilotPrepare([
      "--cohort-id", "pilot-http-test",
      "--output-dir", join(tempRoot, "pilot-http-test"),
      "--server-base-url", "http://192.168.1.254:5177"
    ]);
    assert.notEqual(insecure.code, 0);
    assert.match(insecure.stderr, /Pilot waves require an HTTPS/);

    const participantRecord = JSON.parse(participantRecordText);
    assert.equal(participantRecord.type, "pilot-participant-record");
    assert.equal(participantRecord.cohortId, "pilot-test");
    assert.equal(participantRecord.participant.participantId, "pilot-001");
    assert.equal(participantRecord.safety.plaintextTKeyStored, false);
    assert.deepEqual(participantRecord.syncEvidence, {
      expectedRemoteFolder: "pilot/pilot-test/pilot-001",
      actualRemoteFolderConfirmed: "",
      prefixEvidenceArtifact: "",
      prefixCheckAt: "",
      checkedBy: ""
    });
    assert.deepEqual(participantRecord.rollbackDrill, {
      performed: false,
      packageType: "",
      fromVersion: "",
      toVersion: "",
      dataBackupConfirmed: false,
      verificationArtifact: "",
      recoveredAt: "",
      owner: ""
    });

    for (const participantId of ["pilot-001", "pilot-002"]) {
      const path = join(cohortDir, participantId, "participant-record.json");
      const record = JSON.parse(await readFile(path, "utf8"));
      record.metrics.installOk = true;
      record.metrics.importOk = true;
      record.metrics.firstSyncOk = participantId === "pilot-001";
      record.metrics.diagnosticsOk = true;
      record.metrics.rollbackDrillOk = participantId === "pilot-001";
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    }

    const missingPrefixSummary = await runPilotSummary([
      "--cohort-dir", cohortDir,
      "--output", summaryPath
    ]);
    assert.equal(missingPrefixSummary.code, 0, missingPrefixSummary.stderr || missingPrefixSummary.stdout);
    const missingPrefixReport = JSON.parse(await readFile(summaryPath, "utf8"));
    assert.equal(missingPrefixReport.metrics.firstSyncOk, 0);
    assert.deepEqual(missingPrefixReport.metrics.firstSyncEvidenceMissing, ["pilot-001"]);
    assert.equal(missingPrefixReport.metrics.rollbackDrillOk, 0);
    assert.deepEqual(missingPrefixReport.metrics.completedRollbackDrills, []);
    assert.equal(missingPrefixReport.dailyHealth.exists, true);
    assert.equal(missingPrefixReport.dailyHealth.ready, false);
    assert.equal(missingPrefixReport.dailyHealth.completeRecordCount, 0);
    assert.ok(missingPrefixReport.blockers.includes("participant pilot-001 first sync must confirm the expected pilot remote folder"));
    assert.ok(missingPrefixReport.blockers.includes("at least one rollback drill must be completed"));
    assert.ok(missingPrefixReport.blockers.includes("pilot daily health must include at least 3 complete daily records"));

    const pilotOnePath = join(cohortDir, "pilot-001", "participant-record.json");
    const pilotOne = JSON.parse(await readFile(pilotOnePath, "utf8"));
    pilotOne.syncEvidence.actualRemoteFolderConfirmed = pilotOne.syncEvidence.expectedRemoteFolder;
    pilotOne.syncEvidence.prefixEvidenceArtifact = "reports/pilot/pilot-test/pilot-001/object-prefix-check.json";
    pilotOne.syncEvidence.prefixCheckAt = "2026-07-09T08:00:00.000Z";
    pilotOne.syncEvidence.checkedBy = "support";
    pilotOne.rollbackDrill = {
      performed: true,
      packageType: "desktop",
      fromVersion: "0.3.0-rc.1-next",
      toVersion: "0.3.0-rc.1",
      dataBackupConfirmed: true,
      verificationArtifact: "reports/pilot/pilot-test/pilot-001/rollback-smoke.json",
      recoveredAt: "2026-07-09T08:30:00.000Z",
      owner: "support"
    };
    await writeFile(pilotOnePath, `${JSON.stringify(pilotOne, null, 2)}\n`, "utf8");

    const dailyHealthPath = join(cohortDir, "pilot-daily-health.json");
    const filledDailyHealth = JSON.parse(await readFile(dailyHealthPath, "utf8"));
    filledDailyHealth.ok = true;
    filledDailyHealth.records = [1, 2, 3].map((day) => ({
      day,
      date: `2026-07-${String(8 + day).padStart(2, "0")}`,
      checkedAt: `2026-07-${String(8 + day).padStart(2, "0")}T09:00:00.000Z`,
      checkedBy: "support",
      n1HealthOk: true,
      n1PostDeployOk: true,
      restartRequired: false,
      finalRestartClear: true,
      activeParticipants: 2,
      successfulHeartbeats24h: 2,
      heartbeatWindowOk: true,
      openP1Count: 0,
      openP2Count: 0,
      diagnosticSampleArtifact: `reports/pilot/pilot-test/daily/day-${day}-diagnostics-sample.json`,
      prefixSampleArtifact: `reports/pilot/pilot-test/daily/day-${day}-prefix-sample.json`,
      notes: ""
    }));
    await writeFile(dailyHealthPath, `${JSON.stringify(filledDailyHealth, null, 2)}\n`, "utf8");

    const summary = await runPilotSummary([
      "--cohort-dir", cohortDir,
      "--output", summaryPath
    ]);
    assert.equal(summary.code, 0, summary.stderr || summary.stdout);
    const reportText = await readFile(summaryPath, "utf8");
    assert.equal(reportText.includes(tKey), false);
    const report = JSON.parse(reportText);
    assert.equal(report.type, "pilot-summary");
    assert.equal(report.cohortId, "pilot-test");
    assert.equal(report.participantCount, 2);
    assert.equal(report.metrics.installRate, 1);
    assert.equal(report.metrics.firstSyncOk, 1);
    assert.equal(report.metrics.firstSyncRate, 0.5);
    assert.deepEqual(report.metrics.firstSyncEvidenceMissing, []);
    assert.equal(report.metrics.rollbackDrillOk, 1);
    assert.equal(report.dailyHealth.ready, true);
    assert.equal(report.dailyHealth.completeRecordCount, 3);
    assert.equal(report.dailyHealth.recentCompleteRecords[0].heartbeatSuccessRate, 1);
    assert.deepEqual(report.metrics.incompleteRollbackDrills, []);
    assert.deepEqual(report.metrics.completedRollbackDrills, [{
      participantId: "pilot-001",
      packageType: "desktop",
      fromVersion: "0.3.0-rc.1-next",
      toVersion: "0.3.0-rc.1",
      verificationArtifact: "reports/pilot/pilot-test/pilot-001/rollback-smoke.json",
      recoveredAt: "2026-07-09T08:30:00.000Z",
      owner: "support"
    }]);
    assert.equal(report.recommendation, "continue-observation");
    assert.ok(report.blockers.includes("participantCount must be at least 5 for small pilot exit criteria"));
    assert.deepEqual(report.metrics.duplicateErrorCodes, []);
    assert.deepEqual(report.metrics.p2MissingFollowup, []);
    assert.deepEqual(report.metrics.p1p2MissingDiagnosticArtifacts, []);
    assert.deepEqual(report.metrics.supportResponseMissing, []);
    assert.deepEqual(report.metrics.supportResponseBreaches, []);

    for (const participantId of ["pilot-001", "pilot-002"]) {
      const path = join(cohortDir, participantId, "participant-record.json");
      const record = JSON.parse(await readFile(path, "utf8"));
      record.issues = [{
        id: `ticket-${participantId}`,
        severity: "P2",
        status: "open",
        errorCode: "client_port_in_use",
        owner: participantId === "pilot-001" ? "support" : "",
        nextAction: participantId === "pilot-001" ? "Ask user to close the old local runtime" : "",
        diagnosticArtifact: participantId === "pilot-001" ? "reports/pilot/pilot-test/pilot-001/diagnostics-redacted.json" : "",
        issueStartedAt: "2026-07-09T08:00:00.000Z",
        firstResponseAt: participantId === "pilot-001" ? "2026-07-09T08:30:00.000Z" : "2026-07-10T09:00:00.000Z"
      }];
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    }

    const duplicateSummary = await runPilotSummary([
      "--cohort-dir", cohortDir,
      "--output", summaryPath
    ]);
    assert.equal(duplicateSummary.code, 0, duplicateSummary.stderr || duplicateSummary.stdout);
    const duplicateReport = JSON.parse(await readFile(summaryPath, "utf8"));
    assert.deepEqual(duplicateReport.metrics.duplicateErrorCodes, [{
      errorCode: "client_port_in_use",
      participantCount: 2,
      participantIds: ["pilot-001", "pilot-002"]
    }]);
    assert.deepEqual(duplicateReport.metrics.p2MissingFollowup, ["ticket-pilot-002"]);
    assert.deepEqual(duplicateReport.metrics.p1p2MissingDiagnosticArtifacts, ["ticket-pilot-002"]);
    assert.deepEqual(duplicateReport.metrics.supportResponseMissing, []);
    assert.deepEqual(duplicateReport.metrics.supportResponseBreaches, [{
      id: "ticket-pilot-002",
      participantId: "pilot-002",
      severity: "P2",
      limitMinutes: 1440,
      responseMinutes: 1500,
      missing: false,
      breached: true
    }]);
    assert.ok(duplicateReport.blockers.includes("stable error code client_port_in_use affects 2 participants"));
    assert.ok(duplicateReport.blockers.includes("P2 issue ticket-pilot-002 must have owner and nextAction before signoff"));
    assert.ok(duplicateReport.blockers.includes("P1/P2 issue ticket-pilot-002 must include a redacted diagnostic artifact"));
    assert.ok(duplicateReport.blockers.includes("P2 issue ticket-pilot-002 first response must be within 1440 minutes"));
    assert.equal(duplicateReport.participants[0].issues[0].diagnosticArtifact, "reports/pilot/pilot-test/pilot-001/diagnostics-redacted.json");
    assert.equal(duplicateReport.participants[0].issues[0].responseMinutes, 30);
    assert.equal(duplicateReport.recommendation, "continue-observation");

    const maliciousPath = join(cohortDir, "pilot-002", "participant-record.json");
    const malicious = JSON.parse(await readFile(maliciousPath, "utf8"));
    malicious.notes = "do not store SFSC1-malicious-secret";
    await writeFile(maliciousPath, `${JSON.stringify(malicious, null, 2)}\n`, "utf8");
    const rejected = await runPilotSummary(["--cohort-dir", cohortDir, "--output", summaryPath]);
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /sensitive-looking/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("trial SyncKey helper creates safe report and prints plaintext only when requested", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-trial-t-key-"));
  const reportPath = join(tempRoot, "trial-t-key-report.json");
  const adminToken = "unit-test-admin-token";
  const tKey = "SFSC1-mock-trial-t-key-secret";
  const tKeyUri = "sfsc://import/v1#mock-trial-t-key-secret";
  const requests = [];
  const server = createServer(async (req, res) => {
    const body = await readJsonRequest(req);
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body
    });
    res.setHeader("content-type", "application/json");
    if (req.method !== "POST" || req.url !== "/api/claims/create") {
      res.statusCode = 404;
      res.end(JSON.stringify({ errorCode: "not_found", message: "not found" }));
      return;
    }
    if (req.headers.authorization !== `Bearer ${adminToken}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ errorCode: "admin_auth_required", message: "Admin token is required" }));
      return;
    }
    res.end(JSON.stringify({
      code: "ABCD-2345",
      tKey,
      tKeyUri,
      claimCode: tKey,
      uri: tKeyUri,
      claim: {
        code: "ABCD-2345",
        clientName: body.clientName,
        bucketName: "trial-bucket",
        profileId: "profile-trial",
        createdAt: "2026-07-08T16:00:00.000Z",
        expiresAt: "2026-07-08T18:00:00.000Z",
        server: body.server,
        used: false
      },
      profile: { profileId: "profile-trial" },
      compatibility: {},
      state: {}
    }));
  });

  try {
    await listen(server);
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const result = await runTrialTKeyHelper([
      "--base-url", baseUrl,
      "--client-name", "trial-helper-pc",
      "--expires-in-hours", "2",
      "--json-report", reportPath,
      "--print-t-key"
    ], {
      SFSC_ADMIN_TOKEN: adminToken
    });

    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].authorization, `Bearer ${adminToken}`);
    assert.equal(requests[0].body.clientName, "trial-helper-pc");
    assert.equal(requests[0].body.server, baseUrl);
    assert.equal(requests[0].body.expiresInHours, 2);
    assert.match(result.stdout, /ONE-TIME PLAINTEXT SyncKey/);
    assert.match(result.stdout, new RegExp(tKey));

    const reportText = await readFile(reportPath, "utf8");
    assert.equal(reportText.includes(tKey), false);
    assert.equal(reportText.includes(tKeyUri), false);
    assert.equal(reportText.includes(adminToken), false);
    const report = JSON.parse(reportText);
    assert.equal(report.type, "trial-t-key-report");
    assert.equal(report.claim.clientName, "trial-helper-pc");
    assert.equal(report.claim.code, "ABCD-2345");
    assert.equal(report.tKey.length, tKey.length);
    assert.equal(report.tKey.sha256, createHash("sha256").update(tKey).digest("hex"));
    assert.equal(report.tKey.printedToStdout, true);
    assert.equal(report.safety.tKeyPlaintextStored, false);
    assert.match(report.nextCommands.recordTKeyProfile, /trial:record:update/);
  } finally {
    await closeServer(server);
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("trial SyncKey helper refuses to run without admin token", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-trial-t-key-no-token-"));
  const reportPath = join(tempRoot, "trial-t-key-report.json");
  try {
    const result = await runTrialTKeyHelper([
      "--base-url", "http://127.0.0.1:9",
      "--json-report", reportPath
    ], {
      SFSC_ADMIN_TOKEN: "",
      ADMIN_TOKEN: ""
    });

    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Missing admin token/);
    await assert.rejects(readFile(reportPath, "utf8"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("internal trial record update writes human evidence and rejects sensitive notes", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-internal-trial-record-"));
  const recordPath = join(tempRoot, "internal-trial-record.json");
  const artifactPath = join(tempRoot, "release-evidence.txt");
  try {
    await writeFile(artifactPath, "release evidence checked\n", "utf8");
    await writeInternalTrialRecordFixture(tempRoot, recordPath);

    const update = await runInternalTrialRecord([
      "--update",
      "--allow-pending",
      "--preserve-evidence",
      "--output", recordPath,
      "--tester", "QA",
      "--date", "2026-07-08",
      "--windows-version", "Windows 11 24H2",
      "--machine", "trial-pc",
      "--section", "release-evidence",
      "--status", "passed",
      "--notes", "release bundle and N1 latest evidence checked",
      "--artifact", artifactPath
    ]);
    assert.equal(update.code, 0, update.stderr || update.stdout);

    const updated = JSON.parse(await readFile(recordPath, "utf8"));
    assert.equal(updated.environment.tester, "QA");
    assert.equal(updated.environment.windowsVersion, "Windows 11 24H2");
    const releaseSection = updated.sections.find((section) => section.id === "release-evidence");
    assert.equal(releaseSection.status, "passed");
    assert.match(releaseSection.notes, /release bundle/);
    assert.equal(releaseSection.artifacts.some((artifact) => artifact.endsWith("release-evidence.txt")), true);

    const rejectSensitive = await runInternalTrialRecord([
      "--update",
      "--allow-pending",
      "--preserve-evidence",
      "--output", recordPath,
      "--section", "t-key-profile",
      "--status", "failed",
      "--notes", "bad note SFSC1-secret-token"
    ]);
    assert.notEqual(rejectSensitive.code, 0);
    assert.match(rejectSensitive.stderr, /sensitive-looking SyncKey/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when client package manifest required file lists drift", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-client-manifest-lists-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const buildDesktop = await readFile(join(tempRoot, "client", "scripts", "build-desktop.ps1"), "utf8");
    await writeFile(
      join(tempRoot, "client", "scripts", "build-desktop.ps1"),
      buildDesktop.replace(/\r?\n\s*@\{ name = "resources\/app\/client\/src\/store\.js"; path = Join-Path \$appRoot "client\\src\\store\.js" \},/, ""),
      "utf8"
    );
    const missingBuildManifestPath = await runReleaseAudit(tempRoot);
    assert.notEqual(missingBuildManifestPath.code, 0);
    assert.match(
      missingBuildManifestPath.stderr,
      /client\/scripts\/build-desktop\.ps1 manifest files is missing required manifest path resources\/app\/client\/src\/store\.js/
    );

    await writeFile(join(tempRoot, "client", "scripts", "build-desktop.ps1"), buildDesktop, "utf8");
    const packageSmoke = await readFile(join(tempRoot, "scripts", "smoke-client-package.mjs"), "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-client-package.mjs"),
      packageSmoke.replace(/\r?\n\s*"app\/client\/src\/diagnosticBundle\.js",/, ""),
      "utf8"
    );
    const missingSmokeManifestPath = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSmokeManifestPath.code, 0);
    assert.match(
      missingSmokeManifestPath.stderr,
      /scripts\/smoke-client-package\.mjs portable manifest files is missing required manifest path app\/client\/src\/diagnosticBundle\.js/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-client-package.mjs"), packageSmoke, "utf8");
    const audit = await readFile(join(tempRoot, "scripts", "audit-release.mjs"), "utf8");
    await writeFile(
      join(tempRoot, "scripts", "audit-release.mjs"),
      audit.replace(/\r?\n\s*`\$\{packageName\}\/resources\/bin\/win32\/binaries\.lock\.json`,/, ""),
      "utf8"
    );
    const missingZipAuditPath = await runReleaseAudit(tempRoot);
    assert.notEqual(missingZipAuditPath.code, 0);
    assert.match(
      missingZipAuditPath.stderr,
      /scripts\/audit-release\.mjs portable ZIP entries is missing required manifest path resources\/bin\/win32\/binaries\.lock\.json/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when product app identifiers drift", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-app-id-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const diagnostics = await readFile(join(tempRoot, "src", "core", "diagnostics.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "diagnostics.js"),
      diagnostics.replace('APP_ID = "singbox-folder-sync"', 'APP_ID = "wrong-product-id"'),
      "utf8"
    );
    const diagnosticsDrift = await runReleaseAudit(tempRoot);
    assert.notEqual(diagnosticsDrift.code, 0);
    assert.match(diagnosticsDrift.stderr, /package\.json name must match src\/core\/diagnostics\.js APP_ID wrong-product-id/);
    assert.match(diagnosticsDrift.stderr, /src\/server\.js app id singbox-folder-sync must match wrong-product-id/);

    await writeFile(join(tempRoot, "src", "core", "diagnostics.js"), diagnostics, "utf8");
    const smokeClient = await readFile(join(tempRoot, "scripts", "smoke-client.mjs"), "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-client.mjs"),
      smokeClient.replace('app: "singbox-folder-sync"', 'app: "wrong-product-id"'),
      "utf8"
    );
    const reportDrift = await runReleaseAudit(tempRoot);
    assert.notEqual(reportDrift.code, 0);
    assert.match(reportDrift.stderr, /scripts\/smoke-client\.mjs app id wrong-product-id must match singbox-folder-sync/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when heartbeat scheduler schedule preservation drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-heartbeat-scheduler-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const serverSync = await readFile(join(tempRoot, "src", "core", "syncRun.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "syncRun.js"),
      serverSync.replace("schedule: normalizeScheduledJobSchedule(input.schedule),", ""),
      "utf8"
    );
    const missingServerSchedule = await runReleaseAudit(tempRoot);
    assert.notEqual(missingServerSchedule.code, 0);
    assert.match(
      missingServerSchedule.stderr,
      /src\/core\/syncRun\.js must mention schedule: normalizeScheduledJobSchedule\(input\.schedule\)/
    );

    await writeFile(join(tempRoot, "src", "core", "syncRun.js"), serverSync, "utf8");
    const clientServer = await readFile(join(tempRoot, "client", "src", "clientServer.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("schedule: summarizeHeartbeatSchedule(job.schedule),", ""),
      "utf8"
    );
    const missingClientSchedule = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientSchedule.code, 0);
    assert.match(
      missingClientSchedule.stderr,
      /client\/src\/clientServer\.js must mention schedule: summarizeHeartbeatSchedule\(job\.schedule\)/
    );

    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const diagnosticBundle = await readFile(join(tempRoot, "client", "src", "diagnosticBundle.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "diagnosticBundle.js"),
      diagnosticBundle.replace("jobs: Array.isArray(scheduler.jobs) ? scheduler.jobs.map(summarizeDiagnosticSchedulerJob) : []", "jobs: []"),
      "utf8"
    );
    const missingDiagnosticSchedulerJobs = await runReleaseAudit(tempRoot);
    assert.notEqual(missingDiagnosticSchedulerJobs.code, 0);
    assert.match(
      missingDiagnosticSchedulerJobs.stderr,
      /client\/src\/diagnosticBundle\.js must mention jobs: Array\.isArray\(scheduler\.jobs\) \? scheduler\.jobs\.map\(summarizeDiagnosticSchedulerJob\) : \[\]/
    );

    await writeFile(join(tempRoot, "client", "src", "diagnosticBundle.js"), diagnosticBundle, "utf8");
    const runtimeContracts = await readFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), "utf8");
    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace("assertExactKeys(scheduler, [\"enabled\", \"intervalMs\", \"jobs\", \"lastError\", \"lastTriggeredAt\", \"nextRun\"], label)", "assertExactKeys(scheduler, [\"lastError\", \"nextRun\"], label)"),
      "utf8"
    );
    const missingDiagnosticSchedulerContract = await runReleaseAudit(tempRoot);
    assert.notEqual(missingDiagnosticSchedulerContract.code, 0);
    assert.match(
      missingDiagnosticSchedulerContract.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertExactKeys\(scheduler, \["enabled", "intervalMs", "jobs", "lastError", "lastTriggeredAt", "nextRun"\], label\)/
    );

    await writeFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), runtimeContracts, "utf8");
    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("`jobs[]` 中每项必须保留对象 `schedule`", "`jobs[]` 中每项必须保留 `scheduleText`"),
      "utf8"
    );
    const missingContractSchedule = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractSchedule.code, 0);
    assert.match(missingContractSchedule.stderr, /docs\/INTERFACE_CONTRACT\.md must mention jobs\[\]` 中每项必须保留对象 `schedule`/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when heartbeat remote error code filtering drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-heartbeat-remote-error-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const clientServer = await readFile(join(tempRoot, "client", "src", "clientServer.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("errorCode: normalizeHeartbeatRemoteErrorCode(rawErrorCode)", "errorCode: rawErrorCode"),
      "utf8"
    );
    const missingHeartbeatRemoteErrorFilter = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHeartbeatRemoteErrorFilter.code, 0);
    assert.match(
      missingHeartbeatRemoteErrorFilter.stderr,
      /client\/src\/clientServer\.js must mention errorCode: normalizeHeartbeatRemoteErrorCode\(rawErrorCode\)/
    );

    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const runtimeContracts = await readFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), "utf8");
    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace("assertStableErrorCode(heartbeat.remoteErrorCode, `${label}.remoteErrorCode`);", "assertEqual(typeof heartbeat.remoteErrorCode, \"string\", `${label}.remoteErrorCode`);"),
      "utf8"
    );
    const missingHeartbeatRemoteErrorContract = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHeartbeatRemoteErrorContract.code, 0);
    assert.match(
      missingHeartbeatRemoteErrorContract.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertStableErrorCode\(heartbeat\.remoteErrorCode, `\$\{label\}\.remoteErrorCode`\)/
    );

    await writeFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), runtimeContracts, "utf8");
    const clientHttp = await readFile(join(tempRoot, "tests", "client-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replaceAll('  assert.equal(Object.hasOwn(status.heartbeat, "remoteErrorCode"), false);\n', ""),
      "utf8"
    );
    const missingHeartbeatRemoteErrorBehaviorTest = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHeartbeatRemoteErrorBehaviorTest.code, 0);
    assert.match(
      missingHeartbeatRemoteErrorBehaviorTest.stderr,
      /tests\/client-http\.test\.js must mention assert\.equal\(Object\.hasOwn\(status\.heartbeat, "remoteErrorCode"\), false\)/
    );

    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttp, "utf8");
    const diagnosticBundle = await readFile(join(tempRoot, "client", "src", "diagnosticBundle.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "diagnosticBundle.js"),
      diagnosticBundle.replace("const successfulHeartbeat = currentSuccessfulHeartbeat(status);", "const successfulHeartbeat = null;"),
      "utf8"
    );
    const missingDiagnosticFallback = await runReleaseAudit(tempRoot);
    assert.notEqual(missingDiagnosticFallback.code, 0);
    assert.match(
      missingDiagnosticFallback.stderr,
      /client\/src\/diagnosticBundle\.js must mention const successfulHeartbeat = currentSuccessfulHeartbeat\(status\);/
    );

    await writeFile(join(tempRoot, "client", "src", "diagnosticBundle.js"), diagnosticBundle, "utf8");
    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttp, "utf8");
    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("若服务端返回了共享稳定错误码表登记的错误码", "若服务端返回了结构化错误码"),
      "utf8"
    );
    const missingHeartbeatRemoteErrorDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHeartbeatRemoteErrorDoc.code, 0);
    assert.match(
      missingHeartbeatRemoteErrorDoc.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention 若服务端返回了共享稳定错误码表登记的错误码/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when heartbeat HTTP 2xx success contract validation drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-heartbeat-success-contract-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("HTTP 2xx 只有在响应是 JSON object 且满足该成功契约时才算成功", "HTTP 2xx 默认视为心跳成功"),
      "utf8"
    );
    const missingContractDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractDoc.code, 0);
    assert.match(
      missingContractDoc.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention HTTP 2xx 只有在响应是 JSON object 且满足该成功契约时才算成功/
    );

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const matrix = await readFile(join(tempRoot, "docs", "API_MATRIX.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      matrix.replace(
        "HTTP 2xx 但非 JSON、空 body、缺少成功契约字段、`diagnostics.role/protocols` 非服务端协议",
        "HTTP 2xx 按成功心跳处理"
      ),
      "utf8"
    );
    const missingMatrixDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingMatrixDoc.code, 0);
    assert.match(
      missingMatrixDoc.stderr,
      /docs\/API_MATRIX\.md must mention HTTP 2xx 但非 JSON、空 body、缺少成功契约字段、`diagnostics\.role\/protocols` 非服务端协议/
    );

    await writeFile(join(tempRoot, "docs", "API_MATRIX.md"), matrix, "utf8");
    const clientServer = await readFile(join(tempRoot, "client", "src", "clientServer.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("validateHeartbeatSuccessResponse(responseBody)", "responseBody"),
      "utf8"
    );
    const missingClientValidation = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientValidation.code, 0);
    assert.match(
      missingClientValidation.stderr,
      /client\/src\/clientServer\.js must mention validateHeartbeatSuccessResponse\(responseBody\)/
    );

    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const clientHttp = await readFile(join(tempRoot, "tests", "client-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace(
        "client heartbeat treats malformed successful responses as heartbeat_failed",
        "client heartbeat records successful responses"
      ),
      "utf8"
    );
    const missingClientHttpCoverage = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientHttpCoverage.code, 0);
    assert.match(
      missingClientHttpCoverage.stderr,
      /tests\/client-http\.test\.js must mention client heartbeat treats malformed successful responses as heartbeat_failed/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when heartbeat and diagnostic protocol schema docs drift", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-protocol-schema-docs-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const heartbeatSchemaPath = join(tempRoot, "docs", "protocol", "schemas", "heartbeat-device-sync.json");
    const heartbeatSchema = await readFile(heartbeatSchemaPath, "utf8");
    await writeFile(
      heartbeatSchemaPath,
      heartbeatSchema.replace('"schedulerJobKeys": ["id", "lastError", "lastTriggeredAt", "name", "nextRun", "schedule", "scheduleText"]', '"schedulerJobKeys": ["id", "name"]'),
      "utf8"
    );
    const missingSchedulerKeys = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSchedulerKeys.code, 0);
    assert.match(
      missingSchedulerKeys.stderr,
      /docs\/protocol\/schemas\/heartbeat-device-sync\.json schedulerJobKeys must equal/
    );

    await writeFile(heartbeatSchemaPath, heartbeatSchema, "utf8");
    const diagnosticSchemaPath = join(tempRoot, "docs", "protocol", "schemas", "diagnostic-bundle.json");
    const diagnosticSchema = await readFile(diagnosticSchemaPath, "utf8");
    await writeFile(
      diagnosticSchemaPath,
      diagnosticSchema.replace('"diagnosticDeviceSyncKeys": ["currentFile", "lastRun", "scheduler", "speedMbps", "state", "syncState"]', '"diagnosticDeviceSyncKeys": ["state", "syncState"]'),
      "utf8"
    );
    const missingDiagnosticSyncKeys = await runReleaseAudit(tempRoot);
    assert.notEqual(missingDiagnosticSyncKeys.code, 0);
    assert.match(
      missingDiagnosticSyncKeys.stderr,
      /docs\/protocol\/schemas\/diagnostic-bundle\.json diagnosticDeviceSyncKeys must equal/
    );

    await writeFile(diagnosticSchemaPath, diagnosticSchema, "utf8");
    const diagnosticDoc = await readFile(join(tempRoot, "docs", "protocol", "03-diagnostic-bundle.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "protocol", "03-diagnostic-bundle.md"),
      diagnosticDoc.replace("current successful heartbeat if available; otherwise they fall back to `lastSuccessfulHeartbeat`", "current heartbeat only"),
      "utf8"
    );
    const missingFallbackDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingFallbackDoc.code, 0);
    assert.match(
      missingFallbackDoc.stderr,
      /docs\/protocol\/03-diagnostic-bundle\.md must mention current successful heartbeat if available; otherwise they fall back to `lastSuccessfulHeartbeat`/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when claim and profile protocol schema docs drift", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-claim-profile-protocol-docs-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const claimSchemaPath = join(tempRoot, "docs", "protocol", "schemas", "claim-lifecycle.json");
    const claimSchema = await readFile(claimSchemaPath, "utf8");
    await writeFile(
      claimSchemaPath,
      claimSchema.replace('"claimCodePrefix": "SFSC1-"', '"claimCodePrefix": "SFSC2-"'),
      "utf8"
    );
    const mismatchedClaimPrefix = await runReleaseAudit(tempRoot);
    assert.notEqual(mismatchedClaimPrefix.code, 0);
    assert.match(
      mismatchedClaimPrefix.stderr,
      /docs\/protocol\/schemas\/claim-lifecycle\.json claimCodePrefix must match src\/core\/claimProtocol\.js CLAIM_CODE_PREFIX/
    );

    await writeFile(claimSchemaPath, claimSchema, "utf8");
    await writeFile(
      claimSchemaPath,
      claimSchema.replace('"claimCreateResponseKeys": ["claim", "claimCode", "code", "compatibility", "profile", "state", "tKey", "tKeyUri", "uri"]', '"claimCreateResponseKeys": ["claim", "code"]'),
      "utf8"
    );
    const missingClaimCreateKeys = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClaimCreateKeys.code, 0);
    assert.match(
      missingClaimCreateKeys.stderr,
      /docs\/protocol\/schemas\/claim-lifecycle\.json claimCreateResponseKeys must equal/
    );

    await writeFile(claimSchemaPath, claimSchema, "utf8");
    const profileSchemaPath = join(tempRoot, "docs", "protocol", "schemas", "profile-import.json");
    const profileSchema = await readFile(profileSchemaPath, "utf8");
    await writeFile(
      profileSchemaPath,
      profileSchema.replace('"serverIssuedProfileDefaultsKeys": ["bandwidthLimit", "checkers", "chunkSize", "localProxyPort", "lowLevelRetries", "retries", "schedule", "streams", "transfers"]', '"serverIssuedProfileDefaultsKeys": ["localProxyPort"]'),
      "utf8"
    );
    const missingProfileDefaults = await runReleaseAudit(tempRoot);
    assert.notEqual(missingProfileDefaults.code, 0);
    assert.match(
      missingProfileDefaults.stderr,
      /docs\/protocol\/schemas\/profile-import\.json serverIssuedProfileDefaultsKeys must equal/
    );

    await writeFile(profileSchemaPath, profileSchema, "utf8");
    const claimDoc = await readFile(join(tempRoot, "docs", "protocol", "04-claim-lifecycle.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "protocol", "04-claim-lifecycle.md"),
      claimDoc.replace("A repeated redeem from the same client binding is accepted within `claim.replayUntil`.", "A repeated redeem is rejected."),
      "utf8"
    );
    const missingReplayDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingReplayDoc.code, 0);
    assert.match(
      missingReplayDoc.stderr,
      /docs\/protocol\/04-claim-lifecycle\.md must mention A repeated redeem from the same client binding is accepted within `claim\.replayUntil`\./
    );

    await writeFile(join(tempRoot, "docs", "protocol", "04-claim-lifecycle.md"), claimDoc, "utf8");
    const profileDoc = await readFile(join(tempRoot, "docs", "protocol", "05-profile-import.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "protocol", "05-profile-import.md"),
      profileDoc.replace('It does not accept a raw `{ "profile": { ... } }` object.', "It accepts raw profile objects."),
      "utf8"
    );
    const missingRawProfileBoundary = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRawProfileBoundary.code, 0);
    assert.match(
      missingRawProfileBoundary.stderr,
      /docs\/protocol\/05-profile-import\.md must mention It does not accept a raw `\{ "profile": \{ \.\.\. \} \}` object\./
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when HTTP and runtime diagnostics protocol docs drift", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-http-runtime-protocol-docs-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);

    const httpSchemaPath = join(tempRoot, "docs", "protocol", "schemas", "http-basics.json");
    const httpSchema = await readFile(httpSchemaPath, "utf8");
    await writeFile(httpSchemaPath, httpSchema.replace('"maxJsonBodyBytes": 2097152', '"maxJsonBodyBytes": 1048576'), "utf8");
    const wrongBodyLimit = await runReleaseAudit(tempRoot);
    assert.notEqual(wrongBodyLimit.code, 0);
    assert.match(wrongBodyLimit.stderr, /docs\/protocol\/schemas\/http-basics\.json maxJsonBodyBytes must be 2097152/);

    await writeFile(httpSchemaPath, httpSchema, "utf8");
    await writeFile(
      httpSchemaPath,
      httpSchema.replace('"clientWriteGuardOrder": ["browserOrigin", "contentType", "requestSchema", "handler"]', '"clientWriteGuardOrder": ["contentType", "browserOrigin", "requestSchema", "handler"]'),
      "utf8"
    );
    const wrongClientGuardOrder = await runReleaseAudit(tempRoot);
    assert.notEqual(wrongClientGuardOrder.code, 0);
    assert.match(wrongClientGuardOrder.stderr, /docs\/protocol\/schemas\/http-basics\.json clientWriteGuardOrder must equal/);

    await writeFile(httpSchemaPath, httpSchema, "utf8");
    const diagnosticsSchemaPath = join(tempRoot, "docs", "protocol", "schemas", "runtime-diagnostics.json");
    const diagnosticsSchema = await readFile(diagnosticsSchemaPath, "utf8");
    await writeFile(
      diagnosticsSchemaPath,
      diagnosticsSchema.replace('"heartbeat": 1\n  },', '"heartbeat": 2\n  },'),
      "utf8"
    );
    const wrongProtocolVersion = await runReleaseAudit(tempRoot);
    assert.notEqual(wrongProtocolVersion.code, 0);
    assert.match(wrongProtocolVersion.stderr, /docs\/protocol\/schemas\/runtime-diagnostics\.json protocolVersions must match runtime protocol constants exactly/);

    await writeFile(diagnosticsSchemaPath, diagnosticsSchema, "utf8");
    const diagnosticsDocPath = join(tempRoot, "docs", "protocol", "06-runtime-diagnostics.md");
    const diagnosticsDoc = await readFile(diagnosticsDocPath, "utf8");
    await writeFile(
      diagnosticsDocPath,
      diagnosticsDoc.replace("Partial legacy diagnostics are not treated as compatible.", "Partial legacy diagnostics are accepted."),
      "utf8"
    );
    const missingLegacyBoundary = await runReleaseAudit(tempRoot);
    assert.notEqual(missingLegacyBoundary.code, 0);
    assert.match(missingLegacyBoundary.stderr, /docs\/protocol\/06-runtime-diagnostics\.md must mention Partial legacy diagnostics are not treated as compatible\./);

    await writeFile(diagnosticsDocPath, diagnosticsDoc, "utf8");
    const httpJsonPath = join(tempRoot, "src", "core", "httpJson.js");
    const httpJson = await readFile(httpJsonPath, "utf8");
    await writeFile(
      httpJsonPath,
      httpJson.replace('Buffer.concat(chunks, size).toString("utf8")', 'Buffer.concat(chunks).toString("utf8")'),
      "utf8"
    );
    const missingByteAwareDecode = await runReleaseAudit(tempRoot);
    assert.notEqual(missingByteAwareDecode.code, 0);
    assert.match(missingByteAwareDecode.stderr, /src\/core\/httpJson\.js must mention Buffer\.concat\(chunks, size\)\.toString\("utf8"\)/);

    await writeFile(httpJsonPath, httpJson, "utf8");
    const clientServerPath = join(tempRoot, "client", "src", "clientServer.js");
    const clientServer = await readFile(clientServerPath, "utf8");
    await writeFile(
      clientServerPath,
      clientServer.replace("isDeepStrictEqual(compatibility, expectedCompatibility)", "isDeepStrictEqual(compatibility, {})"),
      "utf8"
    );
    const missingCompatibilityDerivation = await runReleaseAudit(tempRoot);
    assert.notEqual(missingCompatibilityDerivation.code, 0);
    assert.match(missingCompatibilityDerivation.stderr, /client\/src\/clientServer\.js must mention isDeepStrictEqual\(compatibility, expectedCompatibility\)/);

    await writeFile(clientServerPath, clientServer, "utf8");
    const serverAdminPath = join(tempRoot, "src", "core", "serverAdmin.js");
    const serverAdmin = await readFile(serverAdminPath, "utf8");
    await writeFile(
      serverAdminPath,
      serverAdmin.replace("version: PROFILE_VERSION", "version: 1"),
      "utf8"
    );
    const missingSharedProfileVersion = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSharedProfileVersion.code, 0);
    assert.match(missingSharedProfileVersion.stderr, /src\/core\/serverAdmin\.js must mention version: PROFILE_VERSION/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when sync run trigger contract drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-sync-trigger-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const syncRun = await readFile(join(tempRoot, "src", "core", "syncRun.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "syncRun.js"),
      syncRun.replace("trigger: normalizeSyncRunTrigger(input.trigger),", ""),
      "utf8"
    );
    const missingSharedTrigger = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSharedTrigger.code, 0);
    assert.match(
      missingSharedTrigger.stderr,
      /src\/core\/syncRun\.js must mention trigger: normalizeSyncRunTrigger\(input\.trigger\)/
    );

    await writeFile(join(tempRoot, "src", "core", "syncRun.js"), syncRun, "utf8");
    const clientServer = await readFile(join(tempRoot, "client", "src", "clientServer.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace('runSync(due.job, { trigger: "scheduler" })', "runSync(due.job)"),
      "utf8"
    );
    const missingSchedulerTrigger = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSchedulerTrigger.code, 0);
    assert.match(
      missingSchedulerTrigger.stderr,
      /client\/src\/clientServer\.js must mention runSync\(due\.job, \{ trigger: "scheduler" \}\)/
    );

    const processRunner = await readFile(join(tempRoot, "client", "src", "processRunner.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "processRunner.js"),
      processRunner.replace(
        "this.child && this.child.exitCode == null && this.child.signalCode == null",
        "this.child && this.child.exitCode == null && !this.child.killed && this.child.signalCode == null"
      ),
      "utf8"
    );
    const killedChildNotActive = await runReleaseAudit(tempRoot);
    assert.notEqual(killedChildNotActive.code, 0);
    assert.match(
      killedChildNotActive.stderr,
      /client\/src\/processRunner\.js must treat a killed-but-not-closed child process as active/
    );

    await writeFile(join(tempRoot, "client", "src", "processRunner.js"), processRunner, "utf8");
    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const clientHttp = await readFile(join(tempRoot, "tests", "client-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace('  assert.equal(history.history[0].trigger, "scheduler");\n', ""),
      "utf8"
    );
    const missingSchedulerTriggerBehavior = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSchedulerTriggerBehavior.code, 0);
    assert.match(
      missingSchedulerTriggerBehavior.stderr,
      /tests\/client-http\.test\.js must mention history\.history\[0\]\.trigger, "scheduler"/
    );

    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttp, "utf8");
    const contractHttp = await readFile(join(tempRoot, "tests", "contract-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "contract-http.test.js"),
      contractHttp.replace('  assert.equal(heartbeatWithInvalidPaths.device.sync.lastRun.trigger, "manual");\n', ""),
      "utf8"
    );
    const missingLegacyHeartbeatTriggerDefault = await runReleaseAudit(tempRoot);
    assert.notEqual(missingLegacyHeartbeatTriggerDefault.code, 0);
    assert.match(
      missingLegacyHeartbeatTriggerDefault.stderr,
      /tests\/contract-http\.test\.js must mention heartbeatWithInvalidPaths\.device\.sync\.lastRun\.trigger, "manual"/
    );

    await writeFile(join(tempRoot, "tests", "contract-http.test.js"), contractHttp, "utf8");
    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttp, "utf8");
    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("`trigger` 取值为 `manual` 或 `scheduler`", "`trigger` 取值为 `manual`"),
      "utf8"
    );
    const missingTriggerDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingTriggerDoc.code, 0);
    assert.match(
      missingTriggerDoc.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention `trigger` 取值为 `manual` 或 `scheduler`/
    );

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const clientUiHtml = await readFile(join(tempRoot, "client", "public", "index.html"), "utf8");
    await writeFile(
      join(tempRoot, "client", "public", "index.html"),
      clientUiHtml.replace('          <option value="running">运行中</option>\n', ""),
      "utf8"
    );
    const missingRunningHistoryFilter = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRunningHistoryFilter.code, 0);
    assert.match(
      missingRunningHistoryFilter.stderr,
      /client\/public\/index\.html must mention <option value="running">运行中<\/option>/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when heartbeat auth contract drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-heartbeat-auth-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("拒绝重复 nonce", "接受重复 nonce"),
      "utf8"
    );
    const missingReplayDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingReplayDoc.code, 0);
    assert.match(
      missingReplayDoc.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention 拒绝重复 nonce/
    );

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const heartbeatAuth = await readFile(join(tempRoot, "src", "core", "heartbeatAuth.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "heartbeatAuth.js"),
      heartbeatAuth.replace("stableStringify(toJsonValue(stripHeartbeatAuth(payload)))", "stableStringify(toJsonValue(payload))"),
      "utf8"
    );
    const missingAuthStripping = await runReleaseAudit(tempRoot);
    assert.notEqual(missingAuthStripping.code, 0);
    assert.match(
      missingAuthStripping.stderr,
      /src\/core\/heartbeatAuth\.js must mention stableStringify\(toJsonValue\(stripHeartbeatAuth\(payload\)\)\)/
    );

    await writeFile(join(tempRoot, "src", "core", "heartbeatAuth.js"), heartbeatAuth, "utf8");
    const serverAdmin = await readFile(join(tempRoot, "src", "core", "serverAdmin.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "serverAdmin.js"),
      serverAdmin.replace("    rememberHeartbeatAuthNonce(user, authPayload.auth);\n", ""),
      "utf8"
    );
    const missingNonceMemory = await runReleaseAudit(tempRoot);
    assert.notEqual(missingNonceMemory.code, 0);
    assert.match(
      missingNonceMemory.stderr,
      /src\/core\/serverAdmin\.js must mention rememberHeartbeatAuthNonce\(user, authPayload\.auth\);/
    );

    await writeFile(join(tempRoot, "src", "core", "serverAdmin.js"), serverAdmin, "utf8");
    const contractHttp = await readFile(join(tempRoot, "tests", "contract-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "contract-http.test.js"),
      contractHttp.replace('  assertHttpErrorResponseContract(replayedHeartbeatError, "replayedHeartbeat", {\n', '  assertHttpErrorResponseContract(replayedHeartbeatError, "heartbeatReplay", {\n'),
      "utf8"
    );
    const missingReplayHttpContract = await runReleaseAudit(tempRoot);
    assert.notEqual(missingReplayHttpContract.code, 0);
    assert.match(
      missingReplayHttpContract.stderr,
      /tests\/contract-http\.test\.js must mention assertHttpErrorResponseContract\(replayedHeartbeatError, "replayedHeartbeat"/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when client local state corruption safeguards drift", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-local-state-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const clientServer = await readFile(join(tempRoot, "client", "src", "clientServer.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace(
        "async function importProfile(body = {}) {\n  return withClientStateLock(paths, async () => {\n    await ensureLocalStateWritable();",
        "async function importProfile(body = {}) {\n  return withClientStateLock(paths, async () => {"
      ),
      "utf8"
    );
    const missingImportGuard = await runReleaseAudit(tempRoot);
    assert.notEqual(missingImportGuard.code, 0);
    assert.match(
      missingImportGuard.stderr,
      /client\/src\/clientServer\.js must mention async function importProfile\(body = \{\}\) \{\s+return withClientStateLock\(paths, async \(\) => \{\s+await ensureLocalStateWritable\(\);/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace(
        "if (req.method === \"POST\" && url.pathname === \"/api/jobs/save\") {\n      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, await readJson(req));\n      requireSyncCompatibilityConfirmation(body);\n      requireDestructiveSyncConfirmation(body);\n      requireManualScheduleForRiskySync(body.job || {});\n      const payload = await withClientStateLock(paths, async () => {\n        await ensureLocalStateWritable();",
        "if (req.method === \"POST\" && url.pathname === \"/api/jobs/save\") {\n      const body = parseProtocolRequest(PROTOCOL_REQUESTS.CLIENT_JOB_SAVE, await readJson(req));\n      requireSyncCompatibilityConfirmation(body);\n      requireDestructiveSyncConfirmation(body);\n      requireManualScheduleForRiskySync(body.job || {});\n      const payload = await withClientStateLock(paths, async () => {"
      ),
      "utf8"
    );
    const missingJobsSaveGuard = await runReleaseAudit(tempRoot);
    assert.notEqual(missingJobsSaveGuard.code, 0);
    assert.match(
      missingJobsSaveGuard.stderr,
      /client\/src\/clientServer\.js \/api\/jobs\/save must keep order for \/api\/jobs\/save must validate the shared protocol schema and confirmations before writing local state: await ensureLocalStateWritable\(\);/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace(
        "    syncRunInFlight = null;\n    syncRunInFlightJobFingerprint = \"\";",
        "    syncRunInFlight = null;"
      ),
      "utf8"
    );
    const missingSingleFlightCleanup = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSingleFlightCleanup.code, 0);
    assert.match(
      missingSingleFlightCleanup.stderr,
      /client\/src\/clientServer\.js must mention syncRunInFlight = null;\s+syncRunInFlightJobFingerprint = ""/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("async function ensureSyncRunBinaries()", "async function ensureSyncRunComponents()"),
      "utf8"
    );
    const missingSyncBinaryGuard = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSyncBinaryGuard.code, 0);
    assert.match(
      missingSyncBinaryGuard.stderr,
      /client\/src\/clientServer\.js must mention async function ensureSyncRunBinaries\(\)/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("normalizedJob.localProxyPort || 18081", "job.localProxyPort || 18081"),
      "utf8"
    );
    const missingNormalizedProxyPort = await runReleaseAudit(tempRoot);
    assert.notEqual(missingNormalizedProxyPort.code, 0);
    assert.match(
      missingNormalizedProxyPort.stderr,
      /client\/src\/clientServer\.js must not start sing-box from raw job\.localProxyPort \|\| 18081 during sync runs/
    );

    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const clientHttp = await readFile(join(tempRoot, "tests", "client-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace(
        "const history = await waitForSyncHistoryStatus(secondBaseUrl, \"success\");\n  assert.equal(history.history.length, 1);",
        "const history = await waitForSyncHistoryStatus(secondBaseUrl, \"success\");"
      ),
      "utf8"
    );
    const missingSchedulerManualSingleFlightHistory = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSchedulerManualSingleFlightHistory.code, 0);
    assert.match(
      missingSchedulerManualSingleFlightHistory.stderr,
      /tests\/client-http\.test\.js must keep order for scheduler\/manual sync collision must share the rclone config\/start single-flight/
    );

    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace("client sync run fails rclone config before starting sing-box or history", "client sync run handles rclone config error"),
      "utf8"
    );
    const missingConfigFailureTest = await runReleaseAudit(tempRoot);
    assert.notEqual(missingConfigFailureTest.code, 0);
    assert.match(
      missingConfigFailureTest.stderr,
      /tests\/client-http\.test\.js must mention client sync run fails rclone config before starting sing-box or history/
    );

    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace(
        "client scheduler sync run aligns legacy job proxy port with profile defaults",
        "client scheduler sync run starts legacy jobs"
      ),
      "utf8"
    );
    const missingProxyPortAlignmentTest = await runReleaseAudit(tempRoot);
    assert.notEqual(missingProxyPortAlignmentTest.code, 0);
    assert.match(
      missingProxyPortAlignmentTest.stderr,
      /tests\/client-http\.test\.js must mention client scheduler sync run aligns legacy job proxy port with profile defaults/
    );

    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttp, "utf8");
    const store = await readFile(join(tempRoot, "client", "src", "store.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "store.js"),
      store.replace('createHttpError("local_state_corrupt", 409', 'createHttpError("invalid_local_state", 409'),
      "utf8"
    );
    const missingStoreErrorCode = await runReleaseAudit(tempRoot);
    assert.notEqual(missingStoreErrorCode.code, 0);
    assert.match(
      missingStoreErrorCode.stderr,
      /client\/src\/store\.js must mention createHttpError\("local_state_corrupt", 409/
    );

    await writeFile(join(tempRoot, "client", "src", "store.js"), store, "utf8");
    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("safeguards.localState", "safeguards.localFiles"),
      "utf8"
    );
    const missingContractSafeguard = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractSafeguard.code, 0);
    assert.match(
      missingContractSafeguard.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention safeguards\.localState/
    );

    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace(
        "同一次 `/api/sync/run` 必须以归一化后的 job `localProxyPort` 为单一来源",
        "同步运行可使用请求中的 localProxyPort"
      ),
      "utf8"
    );
    const missingProxyPortContract = await runReleaseAudit(tempRoot);
    assert.notEqual(missingProxyPortContract.code, 0);
    assert.match(
      missingProxyPortContract.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention 同一次 `\/api\/sync\/run` 必须以归一化后的 job `localProxyPort` 为单一来源/
    );

    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace(
        "同一次 `/api/sync/run` 必须只生成一个 normalized job 快照",
        "同步运行可以重新读取 profile 默认值"
      ),
      "utf8"
    );
    const missingRunPlanContract = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRunPlanContract.code, 0);
    assert.match(
      missingRunPlanContract.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention 同一次 `\/api\/sync\/run` 必须只生成一个 normalized job 快照/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace(
        "async function runSyncExclusive(runPlan, options = {}) {\n  const { normalizedJob, tunnelUri } = runPlan;",
        "async function runSyncExclusive(runPlan, options = {}) {\n  const { normalizedJob, tunnelUri } = runPlan;\n  await readProfile(paths);"
      ),
      "utf8"
    );
    const runExclusiveReadsProfile = await runReleaseAudit(tempRoot);
    assert.notEqual(runExclusiveReadsProfile.code, 0);
    assert.match(
      runExclusiveReadsProfile.stderr,
      /client\/src\/clientServer\.js must not read profile again inside runSyncExclusive/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when claim redeem recovery contract drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-claim-recovery-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replaceAll("短时绑定重放", "短时重放说明"),
      "utf8"
    );
    const missingReplayDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingReplayDoc.code, 0);
    assert.match(
      missingReplayDoc.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention 短时绑定重放/
    );

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const serverAdmin = await readFile(join(tempRoot, "src", "core", "serverAdmin.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "serverAdmin.js"),
      serverAdmin.replace("const CLAIM_REPLAY_WINDOW_MS", "const CLAIM_REPLAY_TTL_MS"),
      "utf8"
    );
    const missingReplayWindow = await runReleaseAudit(tempRoot);
    assert.notEqual(missingReplayWindow.code, 0);
    assert.match(
      missingReplayWindow.stderr,
      /src\/core\/serverAdmin\.js must mention const CLAIM_REPLAY_WINDOW_MS/
    );

    await writeFile(
      join(tempRoot, "src", "core", "serverAdmin.js"),
      serverAdmin.replace("function assertClaimRedeemStillValid", "function assertClaimRedeemStateStillValid"),
      "utf8"
    );
    const missingRedeemTimeValidation = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRedeemTimeValidation.code, 0);
    assert.match(
      missingRedeemTimeValidation.stderr,
      /src\/core\/serverAdmin\.js must mention function assertClaimRedeemStillValid/
    );

    await writeFile(join(tempRoot, "src", "core", "serverAdmin.js"), serverAdmin, "utf8");
    const clientServer = await readFile(join(tempRoot, "client", "src", "clientServer.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("await clearClaimRecovery(claimRecovery, paths);", ""),
      "utf8"
    );
    const missingRecoveryClear = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRecoveryClear.code, 0);
    assert.match(
      missingRecoveryClear.stderr,
      /client\/src\/clientServer\.js must clear claim recovery only after successful profile\/jobs\/scheduler import block/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace(
        "      await refreshJobsForProfile(profile);\n      await refreshScheduler();\n      await clearClaimRecovery(claimRecovery, paths);\n      await resetHeartbeatState();\n",
        "      await clearClaimRecovery(claimRecovery, paths);\n      await refreshJobsForProfile(profile);\n      await refreshScheduler();\n"
      ),
      "utf8"
    );
    const earlyRecoveryClear = await runReleaseAudit(tempRoot);
    assert.notEqual(earlyRecoveryClear.code, 0);
    assert.match(
      earlyRecoveryClear.stderr,
      /client\/src\/clientServer\.js must clear claim recovery only after successful profile\/jobs\/scheduler import block/
    );

    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const profileImport = await readFile(join(tempRoot, "client", "src", "profileImport.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "profileImport.js"),
      profileImport.replace("      redeemBody.clientInstallId = String(options.clientInstallId);\n", ""),
      "utf8"
    );
    const missingInstallBinding = await runReleaseAudit(tempRoot);
    assert.notEqual(missingInstallBinding.code, 0);
    assert.match(
      missingInstallBinding.stderr,
      /client\/src\/profileImport\.js must mention redeemBody\.clientInstallId = String\(options\.clientInstallId\);/
    );

    await writeFile(
      join(tempRoot, "client", "src", "profileImport.js"),
      profileImport.replace("function validateClaimRedeemStorage", "function validateStorageForRedeemedClaim"),
      "utf8"
    );
    const missingStorageGuard = await runReleaseAudit(tempRoot);
    assert.notEqual(missingStorageGuard.code, 0);
    assert.match(
      missingStorageGuard.stderr,
      /client\/src\/profileImport\.js must mention function validateClaimRedeemStorage/
    );

    await writeFile(join(tempRoot, "client", "src", "profileImport.js"), profileImport, "utf8");
    const store = await readFile(join(tempRoot, "client", "src", "store.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "store.js"),
      store.replace("claim: { server, codeHash },", "claim: { server, code },"),
      "utf8"
    );
    const rawCodeStash = await runReleaseAudit(tempRoot);
    assert.notEqual(rawCodeStash.code, 0);
    assert.match(
      rawCodeStash.stderr,
      /client\/src\/store\.js must not save the one-time claim code in claim-recovery\.json/
    );

    await writeFile(join(tempRoot, "client", "src", "store.js"), store, "utf8");
    const clientHttp = await readFile(join(tempRoot, "tests", "client-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace(
        "client profile import clears claim recovery after terminal claim redeem errors",
        "client profile import clears terminal claim redeem errors"
      ),
      "utf8"
    );
    const missingTerminalClearTest = await runReleaseAudit(tempRoot);
    assert.notEqual(missingTerminalClearTest.code, 0);
    assert.match(
      missingTerminalClearTest.stderr,
      /tests\/client-http\.test\.js must mention client profile import clears claim recovery after terminal claim redeem errors/
    );

    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace(
        "client profile import keeps claim recovery after retryable claim redeem errors",
        "client profile import keeps retryable claim redeem errors"
      ),
      "utf8"
    );
    const missingRetryableKeepTest = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRetryableKeepTest.code, 0);
    assert.match(
      missingRetryableKeepTest.stderr,
      /tests\/client-http\.test\.js must mention client profile import keeps claim recovery after retryable claim redeem errors/
    );

    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttp, "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "profileImport.js"),
      profileImport.replace("    error.claimRedeemRemoteResponse = true;\n", ""),
      "utf8"
    );
    const missingRemoteRedeemMarker = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRemoteRedeemMarker.code, 0);
    assert.match(
      missingRemoteRedeemMarker.stderr,
      /client\/src\/profileImport\.js must mention[\s\S]*error\.claimRedeemRemoteResponse = true;[\s\S]*function validateClaimRedeemStorage/
    );

    await writeFile(join(tempRoot, "client", "src", "profileImport.js"), profileImport, "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("error?.claimRedeemRemoteResponse", "error?.code"),
      "utf8"
    );
    const missingRemoteRedeemCheck = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRemoteRedeemCheck.code, 0);
    assert.match(
      missingRemoteRedeemCheck.stderr,
      /client\/src\/clientServer\.js must mention error\?\.claimRedeemRemoteResponse/
    );

    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const clientUi = await readFile(join(tempRoot, "client", "public", "app.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "public", "app.js"),
      clientUi.replace("function profileImportErrorGuidance(code)", "function profileImportAdvice(code)"),
      "utf8"
    );
    const missingImportGuidance = await runReleaseAudit(tempRoot);
    assert.notEqual(missingImportGuidance.code, 0);
    assert.match(
      missingImportGuidance.stderr,
      /client\/public\/app\.js must mention function profileImportErrorGuidance\(code\)/
    );

    await writeFile(
      join(tempRoot, "client", "public", "app.js"),
      clientUi.replace(
        "claim_already_used: {\n      retryable: false,",
        "claim_already_used: {\n      retryable: true,"
      ),
      "utf8"
    );
    const terminalGuidanceRetryable = await runReleaseAudit(tempRoot);
    assert.notEqual(terminalGuidanceRetryable.code, 0);
    assert.match(
      terminalGuidanceRetryable.stderr,
      /client\/public\/app\.js profileImportErrorGuidance claim_already_used must include retryable: false/
    );

    await writeFile(
      join(tempRoot, "client", "public", "app.js"),
      clientUi.replace(
        "server_state_write_failed: {\n      retryable: true,",
        "server_state_write_failed: {\n      retryable: false,"
      ),
      "utf8"
    );
    const retryableGuidanceTerminal = await runReleaseAudit(tempRoot);
    assert.notEqual(retryableGuidanceTerminal.code, 0);
    assert.match(
      retryableGuidanceTerminal.stderr,
      /client\/public\/app\.js profileImportErrorGuidance server_state_write_failed must include retryable: true/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when compatibility warning confirmation contract drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-compat-warning-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const serverAdmin = await readFile(join(tempRoot, "src", "core", "serverAdmin.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "serverAdmin.js"),
      serverAdmin.replace('compatibility?.policy?.profileIssue === "warn" && input.confirmCompatibilityWarning !== true', 'false'),
      "utf8"
    );
    const missingServerClaimGuard = await runReleaseAudit(tempRoot);
    assert.notEqual(missingServerClaimGuard.code, 0);
    assert.match(
      missingServerClaimGuard.stderr,
      /src\/core\/serverAdmin\.js must mention compatibility\?\.policy\?\.profileIssue === "warn" && input\.confirmCompatibilityWarning !== true/
    );

    await writeFile(join(tempRoot, "src", "core", "serverAdmin.js"), serverAdmin, "utf8");
    const clientServer = await readFile(join(tempRoot, "client", "src", "clientServer.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace('lastSuccessfulHeartbeat?.ok && lastSuccessfulHeartbeat?.compatibility?.policy?.syncRun === "warn" && body.confirmCompatibilityWarning !== true', 'false'),
      "utf8"
    );
    const missingClientGuard = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientGuard.code, 0);
    assert.match(
      missingClientGuard.stderr,
      /client\/src\/clientServer\.js must mention lastSuccessfulHeartbeat\?\.ok && lastSuccessfulHeartbeat\?\.compatibility\?\.policy\?\.syncRun === "warn" && body\.confirmCompatibilityWarning !== true/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("      lastSuccessfulHeartbeat = lastHeartbeat;\n", ""),
      "utf8"
    );
    const missingSuccessfulHeartbeatCache = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSuccessfulHeartbeatCache.code, 0);
    assert.match(
      missingSuccessfulHeartbeatCache.stderr,
      /client\/src\/clientServer\.js must mention lastSuccessfulHeartbeat = lastHeartbeat;/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("    heartbeat: lastHeartbeat,\n    lastSuccessfulHeartbeat,\n", "    heartbeat: lastHeartbeat,\n"),
      "utf8"
    );
    const missingSuccessfulHeartbeatStatus = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSuccessfulHeartbeatStatus.code, 0);
    assert.match(
      missingSuccessfulHeartbeatStatus.stderr,
      /client\/src\/clientServer\.js must mention heartbeat: lastHeartbeat,\s+lastSuccessfulHeartbeat,/
    );

    await writeFile(
      join(tempRoot, "client", "src", "clientServer.js"),
      clientServer.replace("      await resetHeartbeatState();\n      sendHeartbeat().catch(() => {});\n", "      sendHeartbeat().catch(() => {});\n"),
      "utf8"
    );
    const missingProfileImportHeartbeatReset = await runReleaseAudit(tempRoot);
    assert.notEqual(missingProfileImportHeartbeatReset.code, 0);
    assert.match(
      missingProfileImportHeartbeatReset.stderr,
      /client\/src\/clientServer\.js must mention await resetHeartbeatState\(\);/
    );

    await writeFile(join(tempRoot, "client", "src", "clientServer.js"), clientServer, "utf8");
    const clientHttp = await readFile(join(tempRoot, "tests", "client-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace('  assertHttpErrorResponseContract(await saveAfterFailedHeartbeat.json(), "saveAfterFailedHeartbeat", {\n', ""),
      "utf8"
    );
    const missingFailedHeartbeatGuardTest = await runReleaseAudit(tempRoot);
    assert.notEqual(missingFailedHeartbeatGuardTest.code, 0);
    assert.match(
      missingFailedHeartbeatGuardTest.stderr,
      /tests\/client-http\.test\.js must mention assertHttpErrorResponseContract\(await saveAfterFailedHeartbeat\.json\(\), "saveAfterFailedHeartbeat"/
    );

    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace('  assertHeartbeatContract(failedHeartbeatStatus.lastSuccessfulHeartbeat, "lastSuccessfulHeartbeat");\n', ""),
      "utf8"
    );
    const missingSuccessfulHeartbeatRetentionTest = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSuccessfulHeartbeatRetentionTest.code, 0);
    assert.match(
      missingSuccessfulHeartbeatRetentionTest.stderr,
      /tests\/client-http\.test\.js must mention assertHeartbeatContract\(failedHeartbeatStatus\.lastSuccessfulHeartbeat, "lastSuccessfulHeartbeat"\)/
    );

    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttp.replace('  heartbeatMode = "allow";\n', ""),
      "utf8"
    );
    const missingAllowRecoveryTest = await runReleaseAudit(tempRoot);
    assert.notEqual(missingAllowRecoveryTest.code, 0);
    assert.match(
      missingAllowRecoveryTest.stderr,
      /tests\/client-http\.test\.js must mention heartbeatMode = "allow";/
    );

    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttp, "utf8");
    const clientUi = await readFile(join(tempRoot, "client", "public", "app.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "public", "app.js"),
      clientUi.replace(
        "return currentSuccessfulHeartbeat()?.compatibility || null;",
        "latestStatus?.heartbeat?.compatibility || null"
      ),
      "utf8"
    );
    const missingClientUiSuccessfulHeartbeatSource = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientUiSuccessfulHeartbeatSource.code, 0);
    assert.match(
      missingClientUiSuccessfulHeartbeatSource.stderr,
      /client\/public\/app\.js must mention return currentSuccessfulHeartbeat\(\)\?\.compatibility \|\| null;/
    );

    await writeFile(join(tempRoot, "client", "public", "app.js"), clientUi, "utf8");
    await writeFile(
      join(tempRoot, "client", "public", "app.js"),
      clientUi.replace(/confirmCompatibilityWarning: confirmed\.confirmCompatibilityWarning/g, "confirmCompatibilityWarning: false"),
      "utf8"
    );
    const missingClientUiConfirmation = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientUiConfirmation.code, 0);
    assert.match(
      missingClientUiConfirmation.stderr,
      /client\/public\/app\.js must mention confirmCompatibilityWarning: confirmed\.confirmCompatibilityWarning/
    );

    await writeFile(join(tempRoot, "client", "public", "app.js"), clientUi, "utf8");
    const serverUi = await readFile(join(tempRoot, "public", "app.js"), "utf8");
    await writeFile(
      join(tempRoot, "public", "app.js"),
      serverUi.replace(/confirmCompatibilityWarning: Boolean\(compatibilityConfirmation\)/g, "confirmCompatibilityWarning: false"),
      "utf8"
    );
    const missingServerUiConfirmation = await runReleaseAudit(tempRoot);
    assert.notEqual(missingServerUiConfirmation.code, 0);
    assert.match(
      missingServerUiConfirmation.stderr,
      /public\/app\.js must mention confirmCompatibilityWarning: Boolean\(compatibilityConfirmation\)/
    );

    await writeFile(join(tempRoot, "public", "app.js"), serverUi, "utf8");
    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("heartbeat.compatibility.policy.syncRun: \"warn\"", "heartbeat.compatibility.policy.syncRun: \"allow\""),
      "utf8"
    );
    const missingContractWarning = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractWarning.code, 0);
    assert.match(
      missingContractWarning.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention heartbeat\.compatibility\.policy\.syncRun: "warn"/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when claim create UI guidance drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-claim-create-guidance-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);

    const serverUi = await readFile(join(tempRoot, "public", "app.js"), "utf8");
    await writeFile(
      join(tempRoot, "public", "app.js"),
      serverUi.replace("function claimCreateErrorGuidance(code)", "function claimCreateAdvice(code)"),
      "utf8"
    );
    const missingGuidanceFunction = await runReleaseAudit(tempRoot);
    assert.notEqual(missingGuidanceFunction.code, 0);
    assert.match(
      missingGuidanceFunction.stderr,
      /public\/app\.js must mention function claimCreateErrorGuidance\(code\)/
    );

    await writeFile(
      join(tempRoot, "public", "app.js"),
      serverUi.replace(
        "server_state_write_failed: {\n      retryable: true,",
        "server_state_write_failed: {\n      retryable: false,"
      ),
      "utf8"
    );
    const retryableMarkedTerminal = await runReleaseAudit(tempRoot);
    assert.notEqual(retryableMarkedTerminal.code, 0);
    assert.match(
      retryableMarkedTerminal.stderr,
      /public\/app\.js claimCreateErrorGuidance server_state_write_failed must include retryable: true/
    );

    await writeFile(join(tempRoot, "public", "app.js"), serverUi, "utf8");
    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("服务端控制台 SyncKey 生成失败 UI 建议合同", "服务端控制台 SyncKey 错误说明"),
      "utf8"
    );
    const missingContractGuidance = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractGuidance.code, 0);
    assert.match(
      missingContractGuidance.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention 服务端控制台 SyncKey 生成失败 UI 建议合同/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when claim redeem preview UI guidance drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-claim-redeem-preview-guidance-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);

    const serverUi = await readFile(join(tempRoot, "public", "app.js"), "utf8");
    await writeFile(
      join(tempRoot, "public", "app.js"),
      serverUi.replace("function claimRedeemPreviewErrorGuidance(code)", "function claimRedeemPreviewAdvice(code)"),
      "utf8"
    );
    const missingGuidanceFunction = await runReleaseAudit(tempRoot);
    assert.notEqual(missingGuidanceFunction.code, 0);
    assert.match(
      missingGuidanceFunction.stderr,
      /public\/app\.js must mention function claimRedeemPreviewErrorGuidance\(code\)/
    );

    await writeFile(
      join(tempRoot, "public", "app.js"),
      serverUi.replace(
        "server_state_write_failed: {\n      retryable: true,\n      message: \"服务端没能保存兑换状态，SyncKey 不应视为已消耗。\"",
        "server_state_write_failed: {\n      retryable: false,\n      message: \"服务端没能保存兑换状态，SyncKey 不应视为已消耗。\""
      ),
      "utf8"
    );
    const retryableMarkedTerminal = await runReleaseAudit(tempRoot);
    assert.notEqual(retryableMarkedTerminal.code, 0);
    assert.match(
      retryableMarkedTerminal.stderr,
      /public\/app\.js claimRedeemPreviewErrorGuidance server_state_write_failed must include retryable: true/
    );

    await writeFile(join(tempRoot, "public", "app.js"), serverUi, "utf8");
    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("服务端控制台 SyncKey 测试兑换失败 UI 建议合同", "服务端控制台 SyncKey 测试兑换说明"),
      "utf8"
    );
    const missingContractGuidance = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractGuidance.code, 0);
    assert.match(
      missingContractGuidance.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention 服务端控制台 SyncKey 测试兑换失败 UI 建议合同/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when core stable error codes are missing from the interface contract", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-errorcodes-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace(/\| `server_error` \| 500 \| 服务端通用兜底错误 \|\r?\n/, ""),
      "utf8"
    );

    const missingErrorCode = await runReleaseAudit(tempRoot);
    assert.notEqual(missingErrorCode.code, 0);
    assert.match(
      missingErrorCode.stderr,
      /docs\/INTERFACE_CONTRACT\.md must document stable errorCode server_error with HTTP 500/
    );

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const validContract = await runReleaseAudit(tempRoot);
    assert.equal(validContract.code, 0);
    assert.match(validContract.stdout, /Release audit passed/);

    const errorCodeSchemaPath = join(tempRoot, "docs", "protocol", "schemas", "error-codes.json");
    const errorCodeSchema = await readFile(errorCodeSchemaPath, "utf8");
    await writeFile(
      errorCodeSchemaPath,
      errorCodeSchema.replace('"code": "server_error", "status": 500', '"code": "server_error", "status": 418'),
      "utf8"
    );
    const mismatchedSchemaStatus = await runReleaseAudit(tempRoot);
    assert.notEqual(mismatchedSchemaStatus.code, 0);
    assert.match(
      mismatchedSchemaStatus.stderr,
      /docs\/protocol\/schemas\/error-codes\.json stableHttpCodes must match src\/core\/errors\.js DEFAULT_STATUS_BY_CODE exactly/
    );

    await writeFile(errorCodeSchemaPath, errorCodeSchema, "utf8");
    await writeFile(
      errorCodeSchemaPath,
      errorCodeSchema.replace('    "server_state_write_failed",\n', ""),
      "utf8"
    );
    const mismatchedClaimRedeemCodes = await runReleaseAudit(tempRoot);
    assert.notEqual(mismatchedClaimRedeemCodes.code, 0);
    assert.match(
      mismatchedClaimRedeemCodes.stderr,
      /docs\/protocol\/schemas\/error-codes\.json claimRedeemPassthroughCodes must match src\/core\/errors\.js CLAIM_REDEEM_ERROR_CODES exactly/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when stable error codes are missing from UI messages", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-ui-errorcodes-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const clientApp = await readFile(join(projectRoot, "client", "public", "app.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "public", "app.js"),
      clientApp.replace(/\n\s*server_error: "服务端发生未知错误，请联系管理员查看 sync-server 日志。",/, ""),
      "utf8"
    );

    const missingUiMessage = await runReleaseAudit(tempRoot);
    assert.notEqual(missingUiMessage.code, 0);
    assert.match(
      missingUiMessage.stderr,
      /client\/public\/app\.js formatError must map stable errorCode server_error/
    );

    await writeFile(join(tempRoot, "client", "public", "app.js"), clientApp, "utf8");
    await writeFile(
      join(tempRoot, "client", "public", "app.js"),
      clientApp.replace('errorCode: "client_error"', 'errorCode: "request_failed"'),
      "utf8"
    );
    const forbiddenFrontendRequestFailed = await runReleaseAudit(tempRoot);
    assert.notEqual(forbiddenFrontendRequestFailed.code, 0);
    assert.match(
      forbiddenFrontendRequestFailed.stderr,
      /client\/public\/app\.js must not synthesize undocumented request_failed/
    );

    await writeFile(join(tempRoot, "client", "public", "app.js"), clientApp, "utf8");
    const validUiMessages = await runReleaseAudit(tempRoot);
    assert.equal(validUiMessages.code, 0);
    assert.match(validUiMessages.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when server admin falsy input validation drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-admin-falsy-inputs-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const serverAdmin = await readFile(join(projectRoot, "src", "core", "serverAdmin.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "serverAdmin.js"),
      serverAdmin.replace("return Object.hasOwn(input, field);", "return Boolean(input[field]);"),
      "utf8"
    );

    const missingHasOwnGuard = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHasOwnGuard.code, 0);
    assert.match(
      missingHasOwnGuard.stderr,
      /src\/core\/serverAdmin\.js must mention return Object\.hasOwn\(input, field\);/
    );

    await writeFile(join(tempRoot, "src", "core", "serverAdmin.js"), serverAdmin, "utf8");
    const validAudit = await runReleaseAudit(tempRoot);
    assert.equal(validAudit.code, 0, validAudit.stderr || validAudit.stdout);
    assert.match(validAudit.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when operational recovery docs omit server state errors", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-recovery-docs-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const guide = await readFile(join(projectRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"),
      guide.replace(/`server_state_corrupt`/g, "`server_state_missing_fixture`"),
      "utf8"
    );

    const missingRecoveryDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRecoveryDoc.code, 0);
    assert.match(
      missingRecoveryDoc.stderr,
      /docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md must mention server_state_corrupt/
    );

    await writeFile(
      join(tempRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"),
      guide.replace(/`server_state_locked`/g, "`server_state_missing_fixture`"),
      "utf8"
    );
    const missingLockedRecoveryDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingLockedRecoveryDoc.code, 0);
    assert.match(
      missingLockedRecoveryDoc.stderr,
      /docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md must mention server_state_locked/
    );

    await writeFile(
      join(tempRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"),
      guide.replace("Windows 客户端本地状态恢复", "Windows 客户端状态说明"),
      "utf8"
    );
    const missingClientRecoveryDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientRecoveryDoc.code, 0);
    assert.match(
      missingClientRecoveryDoc.stderr,
      /docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md must mention Windows 客户端本地状态恢复/
    );

    await writeFile(
      join(tempRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"),
      guide.replace("GET /api/diagnostics/export", "GET /api/client/status"),
      "utf8"
    );
    const missingClientDiagnosticRecoveryDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientDiagnosticRecoveryDoc.code, 0);
    assert.match(
      missingClientDiagnosticRecoveryDoc.stderr,
      /docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md must mention GET \/api\/diagnostics\/export/
    );

    await writeFile(join(tempRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), guide, "utf8");
    const validRecoveryDoc = await runReleaseAudit(tempRoot);
    assert.equal(validRecoveryDoc.code, 0);
    assert.match(validRecoveryDoc.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when smoke protocol alignment docs drift", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-smoke-docs-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const guide = await readFile(join(projectRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"),
      guide.replace(/protocols=aligned/g, "protocols-not-documented"),
      "utf8"
    );

    const missingSmokeAlignmentDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSmokeAlignmentDoc.code, 0);
    assert.match(
      missingSmokeAlignmentDoc.stderr,
      /docs\/DEPLOYMENT_AND_MIGRATION_GUIDE\.md must mention protocols=aligned/
    );

    await writeFile(join(tempRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"), guide, "utf8");
    const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    for (const [contractName, replacement] of [
      ["admin write state response contract", "admin write state response shape"],
      ["admin auth check response contract", "admin auth check response shape"],
      ["admin tunnel autofill response contract", "admin tunnel autofill response shape"],
      ["admin tunnel generate response contract", "admin tunnel generate response shape"],
      ["admin sing-box config preview contract", "admin sing-box config preview shape"],
      ["admin sing-box write response contract", "admin sing-box write response shape"],
      ["admin sing-box mark-applied response contract", "admin sing-box mark-applied response shape"],
      ["admin user write response contract", "admin user write response shape"],
      ["admin user delete response contract", "admin user delete response shape"],
      ["`POST /api/admin/users/create` 是低层调试/运维入口", "`POST /api/admin/users/create` 是控制台入口"],
      ["当前服务端控制台的产品化创建设备入口是 `POST /api/claims/create`", "当前服务端控制台的产品化创建设备入口是 `POST /api/admin/users/create`"],
      ["避免出现“已登记但没有可导入 SyncKey”的半成品设备", "允许登记没有可导入 SyncKey 的设备"],
      ["`/api/vless/parse` 必须遵守 vless parse response contract", "`/api/vless/parse` 返回兼容形状"],
      ["`/api/singbox/client-config` 必须遵守 singbox client config response contract", "`/api/singbox/client-config` 返回兼容形状"],
      ["`vlessParse.*`、`singboxClientConfig.*` 或 `jobsPreview.*` 字段路径", "`jobsPreview.*` 字段路径"],
      ["客户端 smoke 还必须覆盖 `/api/logs` 的 client logs contract 和 `/api/diagnostics/export` 的 diagnostic export contract", "客户端 smoke 可选覆盖日志和诊断导出"],
      ["admin storage buckets refresh response contract", "admin storage buckets refresh response shape"],
      ["admin storage bucket create response contract", "admin storage bucket create response shape"],
      ["admin storage bucket toggle response contract", "admin storage bucket toggle response shape"],
      ["admin storage bucket clear response contract", "admin storage bucket clear response shape"],
      ["admin storage bucket delete-empty response contract", "admin storage bucket delete-empty response shape"],
      ["http error response contract", "http error response shape"],
      ["assertHttpErrorResponseContract", "assertHttpErrorPayloadContract"],
      ["claim redeem response contract", "claim redeem response shape"],
      ["server health response contract", "server health response shape"],
      ["client health response contract", "client health response shape"],
      ["client shutdown response contract", "client shutdown response shape"],
      ["client binaries check response contract", "client binaries check response shape"],
      ["client profile import response contract", "client profile import response shape"],
      ["client job save response contract", "client job save response shape"],
      ["client singbox process response contract", "client singbox process response shape"],
      ["client sync history contract", "client sync history shape"],
      ["client sync run response contract", "client sync run response shape"],
      ["vless parse response contract", "vless parse response shape"],
      ["singbox client config response contract", "singbox client config response shape"],
      ["jobs preview response contract", "jobs preview response shape"],
      ["server heartbeat response contract", "server heartbeat response shape"]
    ]) {
      await writeFile(
        join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
        contract.replaceAll(contractName, replacement),
        "utf8"
      );
      const missingClientContractDoc = await runReleaseAudit(tempRoot);
      assert.notEqual(missingClientContractDoc.code, 0);
      assert.match(
        missingClientContractDoc.stderr,
        new RegExp(`docs\\/INTERFACE_CONTRACT\\.md must mention ${contractName}`)
      );
    }

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const serverSmoke = await readFile(join(projectRoot, "scripts", "smoke-server.mjs"), "utf8");
    const clientSmoke = await readFile(join(projectRoot, "scripts", "smoke-client.mjs"), "utf8");
    const runtimeContracts = await readFile(join(projectRoot, "scripts", "lib", "runtimeContracts.mjs"), "utf8");
    const helperContracts = await readFile(join(projectRoot, "tests", "helpers", "contracts.js"), "utf8");
    const clientHttpTest = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
    const contractHttpTest = await readFile(join(projectRoot, "tests", "contract-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replaceAll("safeguards.localState.files", "safeguards.localState.entries"),
      "utf8"
    );
    const missingLocalStateSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingLocalStateSmoke.code, 0);
    assert.match(
      missingLocalStateSmoke.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention safeguards\.localState\.files/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replaceAll('    assertObject(job.schedule, `${jobLabel}.schedule`);\n', ""),
      "utf8"
    );
    const missingHeartbeatScheduleSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHeartbeatScheduleSmoke.code, 0);
    assert.match(
      missingHeartbeatScheduleSmoke.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertObject\(job\.schedule, `\$\{jobLabel\}\.schedule`\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace('  assert(Object.hasOwn(sync, "lastRun"), `${label}.lastRun`);\n', ""),
      "utf8"
    );
    const missingHeartbeatLastRunKeySmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHeartbeatLastRunKeySmoke.code, 0);
    assert.match(
      missingHeartbeatLastRunKeySmoke.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assert\(Object\.hasOwn\(sync, "lastRun"\), `\$\{label\}\.lastRun`\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace('  assertNonEmptyString(preview.schedule.text, `${label}.schedule.text`);\n', ""),
      "utf8"
    );
    const missingPreviewNonEmptySmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingPreviewNonEmptySmoke.code, 0);
    assert.match(
      missingPreviewNonEmptySmoke.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertNonEmptyString\(preview\.schedule\.text, `\$\{label\}\.schedule\.text`\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace('  assertExactKeys(response, ["profile", "rclone", "schedule", "singbox"], label);\n', ""),
      "utf8"
    );
    const missingJobsPreviewKeysSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingJobsPreviewKeysSmoke.code, 0);
    assert.match(
      missingJobsPreviewKeysSmoke.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertExactKeys\(response, \["profile", "rclone", "schedule", "singbox"\], label\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace('  assertExactKeys(response, ["device", "diagnostics", "ok"], label);\n', ""),
      "utf8"
    );
    const missingServerHeartbeatKeysSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingServerHeartbeatKeysSmoke.code, 0);
    assert.match(
      missingServerHeartbeatKeysSmoke.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertExactKeys\(response, \["device", "diagnostics", "ok"\], label\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace('  assertExactKeys(response, ["error", "errorCode", "message", "ok"], label);\n', ""),
      "utf8"
    );
    const missingHttpErrorKeysSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHttpErrorKeysSmoke.code, 0);
    assert.match(
      missingHttpErrorKeysSmoke.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertExactKeys\(response, \["error", "errorCode", "message", "ok"\], label\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace('  assertEqual(response.error, response.errorCode, `${label}.error`);\n', ""),
      "utf8"
    );
    const missingHttpErrorAliasSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHttpErrorAliasSmoke.code, 0);
    assert.match(
      missingHttpErrorAliasSmoke.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertEqual\(response\.error, response\.errorCode, `\$\{label\}\.error`\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace("export function assertClientProfileReadContract", "export function assertClientProfileDetailContract"),
      "utf8"
    );
    const missingClientProfileReadContract = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientProfileReadContract.code, 0);
    assert.match(
      missingClientProfileReadContract.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention export function assertClientProfileReadContract/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace("export function assertClientJobsReadContract", "export function assertClientJobsListContract"),
      "utf8"
    );
    const missingClientJobsReadContract = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientJobsReadContract.code, 0);
    assert.match(
      missingClientJobsReadContract.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention export function assertClientJobsReadContract/
    );

    for (const contractName of [
      "assertAdminAuthCheckResponseContract",
      "assertAdminTunnelAutofillResponseContract",
      "assertAdminTunnelGenerateResponseContract",
      "assertAdminSingboxConfigPreviewContract",
      "assertAdminSingboxWriteResponseContract",
      "assertAdminSingboxMarkAppliedResponseContract",
      "assertAdminUserWriteResponseContract",
      "assertAdminUserDeleteResponseContract",
      "assertAdminUserSummaryContract",
      "assertAdminStorageSaveResponseContract",
      "assertAdminStorageBucketClearResponseContract",
      "assertAdminStorageBucketCreateResponseContract",
      "assertAdminStorageBucketDeleteEmptyResponseContract",
      "assertAdminStorageBucketsRefreshResponseContract",
      "assertAdminStorageBucketToggleResponseContract",
      "assertClaimRedeemResponseContract",
      "assertHttpErrorResponseContract",
      "assertServerHealthResponseContract",
      "assertClientHealthContract",
      "assertClientShutdownResponseContract",
      "assertClientProfileImportResponseContract",
      "assertClientJobSaveResponseContract",
      "assertClientSyncHistoryContract",
      "assertClientSyncRunResponseContract",
      "assertServerHeartbeatResponseContract",
      "assertVlessParseResponseContract",
      "assertSingboxClientConfigResponseContract",
      "assertJobsPreviewResponseContract"
    ]) {
      await writeFile(
        join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
        runtimeContracts.replace(`export function ${contractName}`, `export function Missing${contractName}`),
        "utf8"
      );
      const missingClientRuntimeContract = await runReleaseAudit(tempRoot);
      assert.notEqual(missingClientRuntimeContract.code, 0);
      assert.match(
        missingClientRuntimeContract.stderr,
        new RegExp(`scripts\\/lib\\/runtimeContracts\\.mjs must mention export function ${contractName}`)
      );
    }

    await writeFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), runtimeContracts, "utf8");
    for (const contractName of [
      "assertAdminStorageBucketClearResponseContract",
      "assertAdminStorageBucketCreateResponseContract",
      "assertAdminStorageBucketDeleteEmptyResponseContract",
      "assertAdminStorageBucketsRefreshResponseContract",
      "assertAdminStorageBucketToggleResponseContract",
      "assertAdminStorageSaveResponseContract",
      "assertAdminTunnelAutofillResponseContract",
      "assertAdminTunnelGenerateResponseContract",
      "assertAdminSingboxWriteResponseContract",
      "assertAdminSingboxMarkAppliedResponseContract",
      "assertAdminUserWriteResponseContract",
      "assertAdminUserDeleteResponseContract",
      "assertHttpErrorResponseContract"
    ]) {
      await writeFile(
        join(tempRoot, "tests", "helpers", "contracts.js"),
        helperContracts.replace(`  ${contractName},\n`, ""),
        "utf8"
      );
      const missingHelperExport = await runReleaseAudit(tempRoot);
      assert.notEqual(missingHelperExport.code, 0);
      assert.match(
        missingHelperExport.stderr,
        new RegExp(`tests\\/helpers\\/contracts\\.js must mention ${contractName}`)
      );
    }
    await writeFile(join(tempRoot, "tests", "helpers", "contracts.js"), helperContracts, "utf8");

    for (const [snippet, expectedMessage] of [
      [
        '  assertAdminSingboxWriteResponseContract(directWritten, "directWritten");\n',
        /tests\/contract-http\.test\.js must mention assertAdminSingboxWriteResponseContract\(directWritten, "directWritten"\)/
      ],
      [
        '  assertAdminSingboxMarkAppliedResponseContract(directMarkedApplied, "directMarkedApplied");\n',
        /tests\/contract-http\.test\.js must mention assertAdminSingboxMarkAppliedResponseContract\(directMarkedApplied, "directMarkedApplied"\)/
      ],
      [
        '  assertAdminTunnelAutofillResponseContract(autofill, "autofill");\n',
        /tests\/contract-http\.test\.js must mention assertAdminTunnelAutofillResponseContract\(autofill, "autofill"\)/
      ],
      [
        '  assertAdminTunnelGenerateResponseContract(generated, "generated");\n',
        /tests\/contract-http\.test\.js must mention assertAdminTunnelGenerateResponseContract\(generated, "generated"\)/
      ],
      [
        '  assertAdminSingboxWriteResponseContract(written, "written");\n',
        /tests\/contract-http\.test\.js must mention assertAdminSingboxWriteResponseContract\(written, "written"\)/
      ],
      [
        '  assertAdminSingboxMarkAppliedResponseContract(markedApplied, "markedApplied");\n',
        /tests\/contract-http\.test\.js must mention assertAdminSingboxMarkAppliedResponseContract\(markedApplied, "markedApplied"\)/
      ],
      [
        '  assertAdminStorageSaveResponseContract(storageSave, "storageSave", { rawSecrets: [storageSecret] });\n',
        /tests\/contract-http\.test\.js must mention assertAdminStorageSaveResponseContract\(storageSave, "storageSave"/
      ],
      [
        '  assertAdminUserWriteResponseContract(userCreate, "userCreate", { rawSecrets: [storageSecret] });\n',
        /tests\/contract-http\.test\.js must mention assertAdminUserWriteResponseContract\(userCreate, "userCreate"/
      ],
      [
        '  assertAdminUserWriteResponseContract(disabledUser, "disabledUser");\n',
        /tests\/contract-http\.test\.js must mention assertAdminUserWriteResponseContract\(disabledUser, "disabledUser"\)/
      ],
      [
        '  assertAdminUserWriteResponseContract(disabledAgain, "disabledAgain");\n',
        /tests\/contract-http\.test\.js must mention assertAdminUserWriteResponseContract\(disabledAgain, "disabledAgain"\)/
      ],
      [
        '  assertAdminUserWriteResponseContract(enabledAgain, "enabledAgain");\n',
        /tests\/contract-http\.test\.js must mention assertAdminUserWriteResponseContract\(enabledAgain, "enabledAgain"\)/
      ],
      [
        '  assertAdminUserDeleteResponseContract(deletedUser, "deletedUser");\n',
        /tests\/contract-http\.test\.js must mention assertAdminUserDeleteResponseContract\(deletedUser, "deletedUser"\)/
      ],
      [
        '  assertAdminUserWriteResponseContract(disabledIncompatible, "disabledIncompatible");\n',
        /tests\/contract-http\.test\.js must mention assertAdminUserWriteResponseContract\(disabledIncompatible, "disabledIncompatible"\)/
      ],
      [
        '  assertAdminUserWriteResponseContract(enabledIncompatible, "enabledIncompatible");\n',
        /tests\/contract-http\.test\.js must mention assertAdminUserWriteResponseContract\(enabledIncompatible, "enabledIncompatible"\)/
      ],
      [
        '  assertAdminStorageBucketCreateResponseContract(archiveBucket, "archiveBucket");\n',
        /tests\/contract-http\.test\.js must mention assertAdminStorageBucketCreateResponseContract\(archiveBucket, "archiveBucket"\)/
      ],
      [
        '  assertAdminStorageBucketCreateResponseContract(createdBucket, "nonEmptyBucket.createdBucket");\n',
        /tests\/contract-http\.test\.js must mention assertAdminStorageBucketCreateResponseContract\(createdBucket, "nonEmptyBucket\.createdBucket"\)/
      ],
      [
        '  assertAdminStorageBucketToggleResponseContract(disabledArchiveBucket, "disabledArchiveBucket");\n',
        /tests\/contract-http\.test\.js must mention assertAdminStorageBucketToggleResponseContract\(disabledArchiveBucket, "disabledArchiveBucket"\)/
      ],
      [
        '  assertAdminStorageBucketToggleResponseContract(enabledArchiveBucket, "enabledArchiveBucket");\n',
        /tests\/contract-http\.test\.js must mention assertAdminStorageBucketToggleResponseContract\(enabledArchiveBucket, "enabledArchiveBucket"\)/
      ],
      [
        '  assertAdminStorageBucketsRefreshResponseContract(refreshedBuckets, "refreshedBuckets");\n',
        /tests\/contract-http\.test\.js must mention assertAdminStorageBucketsRefreshResponseContract\(refreshedBuckets, "refreshedBuckets"\)/
      ],
      [
        '  assertAdminStorageBucketClearResponseContract(clearedBucket, "nonEmptyBucket.clearedBucket");\n',
        /tests\/contract-http\.test\.js must mention assertAdminStorageBucketClearResponseContract\(clearedBucket, "nonEmptyBucket\.clearedBucket"\)/
      ],
      [
        '  assertAdminStorageBucketDeleteEmptyResponseContract(deletedEmptyBucket, "nonEmptyBucket.deletedEmptyBucket");\n',
        /tests\/contract-http\.test\.js must mention assertAdminStorageBucketDeleteEmptyResponseContract\(deletedEmptyBucket, "nonEmptyBucket\.deletedEmptyBucket"\)/
      ],
      [
        '  assertClaimCreateResponseContract(created, "created", {\n',
        /tests\/contract-http\.test\.js must mention assertClaimCreateResponseContract\(created, "created"/
      ],
      [
        '  assertClaimRedeemResponseContract(rawRedeemed, "rawRedeemed", { expectedClientName: "contract-pc1" });\n',
        /tests\/contract-http\.test\.js must mention assertClaimRedeemResponseContract\(rawRedeemed, "rawRedeemed"/
      ],
      [
        '  assertServerHeartbeatResponseContract(heartbeat, "heartbeat");\n',
        /tests\/contract-http\.test\.js must mention assertServerHeartbeatResponseContract\(heartbeat, "heartbeat"\)/
      ],
      [
        '  assertHttpErrorResponseContract(await failedGenerate.json(), "failedGenerate", {\n',
        /tests\/contract-http\.test\.js must mention assertHttpErrorResponseContract\(await failedGenerate\.json\(\), "failedGenerate"/
      ],
      [
        '  assertHttpErrorResponseContract(await unknownApi.json(), "serverUnknownApi", {\n',
        /tests\/contract-http\.test\.js must mention assertHttpErrorResponseContract\(await unknownApi\.json\(\), "serverUnknownApi"/
      ],
      [
        '  assertHttpErrorResponseContract(await response.json(), "validationFailedResponse", {\n',
        /tests\/contract-http\.test\.js must mention assertHttpErrorResponseContract\(await response\.json\(\), "validationFailedResponse"/
      ]
    ]) {
      await writeFile(
        join(tempRoot, "tests", "contract-http.test.js"),
        contractHttpTest.replace(snippet, ""),
        "utf8"
      );
      const missingContractHttpCall = await runReleaseAudit(tempRoot);
      assert.notEqual(missingContractHttpCall.code, 0);
      assert.match(missingContractHttpCall.stderr, expectedMessage);
    }
    await writeFile(join(tempRoot, "tests", "contract-http.test.js"), contractHttpTest, "utf8");

    for (const [snippet, expectedMessage] of [
      [
        '  assertHttpErrorResponseContract(payload, "clientMissingRoute", {\n',
        /tests\/client-http\.test\.js must mention assertHttpErrorResponseContract\(payload, "clientMissingRoute"/
      ],
      [
        '  assertHttpErrorResponseContract(await invalidJsonImport.json(), "clientInvalidJsonImport", {\n',
        /tests\/client-http\.test\.js must mention assertHttpErrorResponseContract\(await invalidJsonImport\.json\(\), "clientInvalidJsonImport"/
      ],
      [
        '  assertHttpErrorResponseContract(await missingVaultPreview.json(), "missingVaultPreview", {\n',
        /tests\/client-http\.test\.js must mention assertHttpErrorResponseContract\(await missingVaultPreview\.json\(\), "missingVaultPreview"/
      ],
      [
        '  assertHttpErrorResponseContract(await runDestructiveWithoutConfirmation.json(), "runDestructiveWithoutConfirmation", {\n',
        /tests\/client-http\.test\.js must mention assertHttpErrorResponseContract\(await runDestructiveWithoutConfirmation\.json\(\), "runDestructiveWithoutConfirmation"/
      ]
    ]) {
      await writeFile(
        join(tempRoot, "tests", "client-http.test.js"),
        clientHttpTest.replace(snippet, ""),
        "utf8"
      );
      const missingClientHttpErrorCall = await runReleaseAudit(tempRoot);
      assert.notEqual(missingClientHttpErrorCall.code, 0);
      assert.match(missingClientHttpErrorCall.stderr, expectedMessage);
    }
    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttpTest, "utf8");

    for (const [snippet, expectedMessage] of [
      [
        '  assertServerHealthResponseContract(health);\n',
        /scripts\/smoke-server\.mjs must mention assertServerHealthResponseContract\(health\)/
      ],
      [
        '    assertAdminAuthCheckResponseContract(auth);\n',
        /scripts\/smoke-server\.mjs must mention assertAdminAuthCheckResponseContract\(auth\)/
      ],
      [
        '    assertAdminSingboxConfigPreviewContract(config, state, "singboxConfig");\n',
        /scripts\/smoke-server\.mjs must mention assertAdminSingboxConfigPreviewContract\(config, state, "singboxConfig"\)/
      ]
    ]) {
      await writeFile(
        join(tempRoot, "scripts", "smoke-server.mjs"),
        serverSmoke.replace(snippet, ""),
        "utf8"
      );
      const missingServerSmokeContract = await runReleaseAudit(tempRoot);
      assert.notEqual(missingServerSmokeContract.code, 0);
      assert.match(missingServerSmokeContract.stderr, expectedMessage);
    }
    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace("export function assertClaimCreateResponseContract", "export function assertClaimCreatePayloadContract"),
      "utf8"
    );
    const missingClaimCreateContract = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClaimCreateContract.code, 0);
    assert.match(
      missingClaimCreateContract.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention export function assertClaimCreateResponseContract/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace("  assertClaimCreateConfigWriteState(response, label);\n", ""),
      "utf8"
    );
    const missingClaimCreateConfigWriteState = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClaimCreateConfigWriteState.code, 0);
    assert.match(
      missingClaimCreateConfigWriteState.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must mention assertClaimCreateConfigWriteState\(response, label\);/
    );

    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace(
        "  assertCompatibilityContract(response.compatibility, `${label}.compatibility`);\n",
        "  if (response.compatibility !== undefined) {\n    assertCompatibilityContract(response.compatibility, `${label}.compatibility`);\n  }\n"
      ),
      "utf8"
    );
    const optionalClaimCreateCompatibility = await runReleaseAudit(tempRoot);
    assert.notEqual(optionalClaimCreateCompatibility.code, 0);
    assert.match(
      optionalClaimCreateCompatibility.stderr,
      /scripts\/lib\/runtimeContracts\.mjs must require claim create compatibility instead of treating it as optional/
    );

    for (const contractName of [
      "assertAdminDefaultsSummaryContract",
      "assertAdminSettingsSummaryContract",
      "assertAdminStateSummaryContract",
      "assertAdminStorageSummaryContract",
      "assertAdminTunnelSummaryContract"
    ]) {
      await writeFile(
        join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
        runtimeContracts.replace(`export function ${contractName}`, `export function Missing${contractName}`),
        "utf8"
      );
      const missingAdminSummaryContract = await runReleaseAudit(tempRoot);
      assert.notEqual(missingAdminSummaryContract.code, 0);
      assert.match(
        missingAdminSummaryContract.stderr,
        new RegExp(`scripts\\/lib\\/runtimeContracts\\.mjs must mention export function ${contractName}`)
      );
    }

    await writeFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), runtimeContracts, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      serverSmoke.replace('    assertAdminStateSummaryContract(state, "adminState");\n', ""),
      "utf8"
    );
    const missingAdminStateSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingAdminStateSmoke.code, 0);
    assert.match(
      missingAdminStateSmoke.stderr,
      /scripts\/smoke-server\.mjs must mention assertAdminStateSummaryContract\(state, "adminState"\)/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      serverSmoke.replace(
        'assertClaimCreateResponseContract(created, "claimLifecycle.create"',
        'assertClaimCreatePayloadContract(created, "claimLifecycle.create"'
      ),
      "utf8"
    );
    const missingClaimCreateSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClaimCreateSmoke.code, 0);
    assert.match(
      missingClaimCreateSmoke.stderr,
      /scripts\/smoke-server\.mjs must mention assertClaimCreateResponseContract\(created, "claimLifecycle\.create"/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      serverSmoke.replace('    assertVlessParseResponseContract(parsedVless, "vlessParse");\n', ""),
      "utf8"
    );
    const missingVlessParseSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingVlessParseSmoke.code, 0);
    assert.match(
      missingVlessParseSmoke.stderr,
      /scripts\/smoke-server\.mjs must mention assertVlessParseResponseContract\(parsedVless, "vlessParse"\)/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      serverSmoke.replace('    assertSingboxClientConfigResponseContract(clientConfig, "singboxClientConfig", { localProxyPort: 18082 });\n', ""),
      "utf8"
    );
    const missingSingboxClientConfigSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSingboxClientConfigSmoke.code, 0);
    assert.match(
      missingSingboxClientConfigSmoke.stderr,
      /scripts\/smoke-server\.mjs must mention assertSingboxClientConfigResponseContract\(clientConfig, "singboxClientConfig"/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      serverSmoke.replace('    assertJobsPreviewResponseContract(jobsPreview, "jobsPreview", {\n', ""),
      "utf8"
    );
    const missingJobsPreviewSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingJobsPreviewSmoke.code, 0);
    assert.match(
      missingJobsPreviewSmoke.stderr,
      /scripts\/smoke-server\.mjs must mention assertJobsPreviewResponseContract\(jobsPreview, "jobsPreview"/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      serverSmoke.replace(
        'assertClaimRedeemResponseContract(redeemed, "claimLifecycle.redeemedProfile"',
        'assertServerIssuedProfileContract(redeemed, "claimLifecycle.redeemedProfile"'
      ),
      "utf8"
    );
    const missingClaimRedeemSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClaimRedeemSmoke.code, 0);
    assert.match(
      missingClaimRedeemSmoke.stderr,
      /scripts\/smoke-server\.mjs must mention assertClaimRedeemResponseContract\(redeemed, "claimLifecycle\.redeemedProfile"/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      serverSmoke.replace(
        'assertClaimRedeemResponseContract(replayed, "claimLifecycle.replayedProfile"',
        'assertServerIssuedProfileContract(replayed, "claimLifecycle.replayedProfile"'
      ),
      "utf8"
    );
    const missingClaimReplaySmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClaimReplaySmoke.code, 0);
    assert.match(
      missingClaimReplaySmoke.stderr,
      /scripts\/smoke-server\.mjs must mention assertClaimRedeemResponseContract\(replayed, "claimLifecycle\.replayedProfile"/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-server.mjs"),
      serverSmoke.replace('  assertServerHeartbeatResponseContract(value, "claimLifecycle.heartbeat");\n', ""),
      "utf8"
    );
    const missingServerHeartbeatSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingServerHeartbeatSmoke.code, 0);
    assert.match(
      missingServerHeartbeatSmoke.stderr,
      /scripts\/smoke-server\.mjs must mention assertServerHeartbeatResponseContract\(value, "claimLifecycle\.heartbeat"\)/
    );

    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(
      join(tempRoot, "scripts", "smoke-client.mjs"),
      clientSmoke.replace('  assertClientHealthContract(health);\n', ""),
      "utf8"
    );
    const missingClientHealthSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientHealthSmoke.code, 0);
    assert.match(
      missingClientHealthSmoke.stderr,
      /scripts\/smoke-client\.mjs must mention assertClientHealthContract\(health\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "smoke-client.mjs"),
      clientSmoke.replace('  assertClientProfileReadContract(profileRead, "clientProfile");\n', ""),
      "utf8"
    );
    const missingClientProfileReadSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientProfileReadSmoke.code, 0);
    assert.match(
      missingClientProfileReadSmoke.stderr,
      /scripts\/smoke-client\.mjs must mention assertClientProfileReadContract\(profileRead, "clientProfile"\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "smoke-client.mjs"),
      clientSmoke.replace('  assertClientJobsReadContract(jobsRead, "clientJobs");\n', ""),
      "utf8"
    );
    const missingClientJobsReadSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientJobsReadSmoke.code, 0);
    assert.match(
      missingClientJobsReadSmoke.stderr,
      /scripts\/smoke-client\.mjs must mention assertClientJobsReadContract\(jobsRead, "clientJobs"\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "smoke-client.mjs"),
      clientSmoke.replace('  assertClientSyncHistoryContract(syncHistory, "syncHistory");\n', ""),
      "utf8"
    );
    const missingClientSyncHistorySmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientSyncHistorySmoke.code, 0);
    assert.match(
      missingClientSyncHistorySmoke.stderr,
      /scripts\/smoke-client\.mjs must mention assertClientSyncHistoryContract\(syncHistory, "syncHistory"\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "smoke-client.mjs"),
      clientSmoke.replace('  assertClientLogsContract(logs, "clientLogs");\n', ""),
      "utf8"
    );
    const missingClientLogsSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientLogsSmoke.code, 0);
    assert.match(
      missingClientLogsSmoke.stderr,
      /scripts\/smoke-client\.mjs must mention assertClientLogsContract\(logs, "clientLogs"\)/
    );

    await writeFile(
      join(tempRoot, "scripts", "smoke-client.mjs"),
      clientSmoke.replace('  assertDiagnosticExportContract(diagnosticExport, "diagnosticExport");\n', ""),
      "utf8"
    );
    const missingDiagnosticExportSmoke = await runReleaseAudit(tempRoot);
    assert.notEqual(missingDiagnosticExportSmoke.code, 0);
    assert.match(
      missingDiagnosticExportSmoke.stderr,
      /scripts\/smoke-client\.mjs must mention assertDiagnosticExportContract\(diagnosticExport, "diagnosticExport"\)/
    );

    await writeFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), runtimeContracts, "utf8");
    await writeFile(join(tempRoot, "scripts", "smoke-server.mjs"), serverSmoke, "utf8");
    await writeFile(join(tempRoot, "scripts", "smoke-client.mjs"), clientSmoke, "utf8");
    const validSmokeDocs = await runReleaseAudit(tempRoot);
    assert.equal(validSmokeDocs.code, 0);
    assert.match(validSmokeDocs.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when the server write interface map drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-server-write-map-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const matrix = await readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      matrix.replace(
        "| POST | `/api/admin/storage/save` | 管理 token | 服务端控制台 | 保存 S3/MinIO 配置 |",
        "| POST | `/api/admin/storage/save-renamed` | 管理 token | 服务端控制台 | 保存 S3/MinIO 配置 |"
      ),
      "utf8"
    );
    const missingMatrixRow = await runReleaseAudit(tempRoot);
    assert.notEqual(missingMatrixRow.code, 0);
    assert.match(
      missingMatrixRow.stderr,
      /server write interface map missing API matrix row for POST \/api\/admin\/storage\/save/
    );

    await writeFile(join(tempRoot, "docs", "API_MATRIX.md"), matrix, "utf8");
    const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replaceAll("admin storage save response contract", "admin storage save response shape"),
      "utf8"
    );
    const missingContractPhrase = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractPhrase.code, 0);
    assert.match(
      missingContractPhrase.stderr,
      /server write interface map missing INTERFACE_CONTRACT phrase for POST \/api\/admin\/storage\/save: admin storage save response contract/
    );

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const runtimeContracts = await readFile(join(projectRoot, "scripts", "lib", "runtimeContracts.mjs"), "utf8");
    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace(
        "export function assertAdminStorageSaveResponseContract",
        "export function assertAdminStorageSavePayloadContract"
      ),
      "utf8"
    );
    const missingRuntimeHelper = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRuntimeHelper.code, 0);
    assert.match(
      missingRuntimeHelper.stderr,
      /server write interface map missing runtime contract helper for POST \/api\/admin\/storage\/save: assertAdminStorageSaveResponseContract/
    );

    await writeFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), runtimeContracts, "utf8");
    const helperContracts = await readFile(join(projectRoot, "tests", "helpers", "contracts.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "helpers", "contracts.js"),
      helperContracts.replace("  assertAdminStorageSaveResponseContract,\n", ""),
      "utf8"
    );
    const missingHelperExport = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHelperExport.code, 0);
    assert.match(
      missingHelperExport.stderr,
      /server write interface map missing tests helper export for POST \/api\/admin\/storage\/save: assertAdminStorageSaveResponseContract/
    );

    await writeFile(join(tempRoot, "tests", "helpers", "contracts.js"), helperContracts, "utf8");
    const contractHttpTest = await readFile(join(projectRoot, "tests", "contract-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "contract-http.test.js"),
      contractHttpTest.replace('  assertAdminStorageSaveResponseContract(storageSave, "storageSave", { rawSecrets: [storageSecret] });\n', ""),
      "utf8"
    );
    const missingContractHttpAssertion = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractHttpAssertion.code, 0);
    assert.match(
      missingContractHttpAssertion.stderr,
      /server write interface map missing contract-http assertion for POST \/api\/admin\/storage\/save: assertAdminStorageSaveResponseContract\(storageSave, "storageSave"/
    );

    await writeFile(join(tempRoot, "tests", "contract-http.test.js"), contractHttpTest, "utf8");
    const validMap = await runReleaseAudit(tempRoot);
    assert.equal(validMap.code, 0);
    assert.match(validMap.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when the client local interface map drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-client-local-map-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const matrix = await readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      matrix.replace(
        "| POST | `/api/jobs/save` | 客户端 UI、本地自动化 | 保存同步任务并刷新调度器；当最近一次成功 heartbeat 返回 `compatibility.policy.syncRun: \"warn\"` 时必须带 `confirmCompatibilityWarning: true` |",
        "| POST | `/api/jobs/save-renamed` | 客户端 UI、本地自动化 | 保存同步任务并刷新调度器；当最近一次成功 heartbeat 返回 `compatibility.policy.syncRun: \"warn\"` 时必须带 `confirmCompatibilityWarning: true` |"
      ),
      "utf8"
    );
    const missingMatrixRow = await runReleaseAudit(tempRoot);
    assert.notEqual(missingMatrixRow.code, 0);
    assert.match(
      missingMatrixRow.stderr,
      /client local interface map missing API matrix row for POST \/api\/jobs\/save/
    );

    await writeFile(join(tempRoot, "docs", "API_MATRIX.md"), matrix, "utf8");
    const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replaceAll("client job save response contract", "client job save response shape"),
      "utf8"
    );
    const missingContractPhrase = await runReleaseAudit(tempRoot);
    assert.notEqual(missingContractPhrase.code, 0);
    assert.match(
      missingContractPhrase.stderr,
      /client local interface map missing INTERFACE_CONTRACT phrase for POST \/api\/jobs\/save: client job save response contract/
    );

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const runtimeContracts = await readFile(join(projectRoot, "scripts", "lib", "runtimeContracts.mjs"), "utf8");
    await writeFile(
      join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"),
      runtimeContracts.replace(
        "export function assertClientJobSaveResponseContract",
        "export function assertClientJobSavePayloadContract"
      ),
      "utf8"
    );
    const missingRuntimeHelper = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRuntimeHelper.code, 0);
    assert.match(
      missingRuntimeHelper.stderr,
      /client local interface map missing runtime contract helper for POST \/api\/jobs\/save: assertClientJobSaveResponseContract/
    );

    await writeFile(join(tempRoot, "scripts", "lib", "runtimeContracts.mjs"), runtimeContracts, "utf8");
    const helperContracts = await readFile(join(projectRoot, "tests", "helpers", "contracts.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "helpers", "contracts.js"),
      helperContracts.replace("  assertClientJobSaveResponseContract,\n", ""),
      "utf8"
    );
    const missingHelperExport = await runReleaseAudit(tempRoot);
    assert.notEqual(missingHelperExport.code, 0);
    assert.match(
      missingHelperExport.stderr,
      /client local interface map missing tests helper export for POST \/api\/jobs\/save: assertClientJobSaveResponseContract/
    );

    await writeFile(join(tempRoot, "tests", "helpers", "contracts.js"), helperContracts, "utf8");
    const clientHttpTest = await readFile(join(projectRoot, "tests", "client-http.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "client-http.test.js"),
      clientHttpTest.replace('  assertClientJobSaveResponseContract(savedJobPayload, "savedJob");\n', ""),
      "utf8"
    );
    const missingClientHttpAssertion = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClientHttpAssertion.code, 0);
    assert.match(
      missingClientHttpAssertion.stderr,
      /client local interface map missing client-http assertion for POST \/api\/jobs\/save: assertClientJobSaveResponseContract\(savedJobPayload, "savedJob"\)/
    );

    await writeFile(join(tempRoot, "tests", "client-http.test.js"), clientHttpTest, "utf8");
    const validMap = await runReleaseAudit(tempRoot);
    assert.equal(validMap.code, 0);
    assert.match(validMap.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when runtime diagnostics protocol versions are missing from the interface contract", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-diagnostics-"));
  try {
    await writeReleaseAuditFixture(tempRoot);
    const diagnosticsSource = await readFile(join(projectRoot, "src", "core", "diagnostics.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "diagnostics.js"),
      diagnosticsSource.replace("export const HEARTBEAT_VERSION = 1;", "export const HEARTBEAT_VERSION = 2;"),
      "utf8"
    );

    const missingProtocolVersion = await runReleaseAudit(tempRoot);
    assert.notEqual(missingProtocolVersion.code, 0);
    assert.match(
      missingProtocolVersion.stderr,
      /docs\/INTERFACE_CONTRACT\.md must document diagnostics\.protocols\.heartbeat version 2/
    );

    const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace(/"heartbeat": 1/g, '"heartbeat": 2'),
      "utf8"
    );
    const runtimeDiagnosticsSchemaPath = join(tempRoot, "docs", "protocol", "schemas", "runtime-diagnostics.json");
    const runtimeDiagnosticsSchema = await readFile(runtimeDiagnosticsSchemaPath, "utf8");
    await writeFile(
      runtimeDiagnosticsSchemaPath,
      runtimeDiagnosticsSchema.replace('"heartbeat": 1\n  },', '"heartbeat": 2\n  },'),
      "utf8"
    );
    const protocolBaselinePath = join(tempRoot, "docs", "protocol", "schemas", "protocol-v1-baseline.json");
    const protocolBaseline = await readFile(protocolBaselinePath, "utf8");
    await writeFile(
      protocolBaselinePath,
      protocolBaseline.replace('"heartbeat": 1\n  },', '"heartbeat": 2\n  },'),
      "utf8"
    );
    const validProtocolVersion = await runReleaseAudit(tempRoot);
    assert.equal(validProtocolVersion.code, 0);
    assert.match(validProtocolVersion.stdout, /Release audit passed/);

    const currentDiagnosticsSource = await readFile(join(tempRoot, "src", "core", "diagnostics.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "diagnostics.js"),
      currentDiagnosticsSource.replace(
        "[\"claim\", \"profile\", \"adminState\", \"clientStatus\", \"heartbeat\"]",
        "[\"claim\", \"profile\", \"clientStatus\", \"heartbeat\"]"
      ),
      "utf8"
    );
    const missingAdminStateCompatibilityField = await runReleaseAudit(tempRoot);
    assert.notEqual(missingAdminStateCompatibilityField.code, 0);
    assert.match(
      missingAdminStateCompatibilityField.stderr,
      /src\/core\/diagnostics\.js must mention \["claim", "profile", "adminState", "clientStatus", "heartbeat"\]/
    );

    await writeFile(join(tempRoot, "src", "core", "diagnostics.js"), currentDiagnosticsSource, "utf8");
    const coreTest = await readFile(join(tempRoot, "tests", "core.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "core.test.js"),
      coreTest.replaceAll("runtime diagnostics treat partial protocol diagnostics as missing", "runtime diagnostics compare basic protocol compatibility"),
      "utf8"
    );
    const missingPartialDiagnosticsCoverage = await runReleaseAudit(tempRoot);
    assert.notEqual(missingPartialDiagnosticsCoverage.code, 0);
    assert.match(
      missingPartialDiagnosticsCoverage.stderr,
      /tests\/core\.test\.js must mention runtime diagnostics treat partial protocol diagnostics as missing/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when legacy admin user migration contract drifts", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-legacy-admin-user-"));
  try {
    await writeReleaseAuditFixture(tempRoot);

    const valid = await runReleaseAudit(tempRoot);
    assert.equal(valid.code, 0, valid.stderr || valid.stdout);
    assert.match(valid.stdout, /Release audit passed/);

    const contract = await readFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      contract.replace("读取历史 `sfsc-state.json` 时，服务端必须把 legacy user 迁移为当前设备模型", "读取历史 `sfsc-state.json` 时保持原样"),
      "utf8"
    );
    const missingMigrationDoc = await runReleaseAudit(tempRoot);
    assert.notEqual(missingMigrationDoc.code, 0);
    assert.match(
      missingMigrationDoc.stderr,
      /docs\/INTERFACE_CONTRACT\.md must mention 读取历史 `sfsc-state\.json` 时，服务端必须把 legacy user 迁移为当前设备模型/
    );

    await writeFile(join(tempRoot, "docs", "INTERFACE_CONTRACT.md"), contract, "utf8");
    const serverAdmin = await readFile(join(tempRoot, "src", "core", "serverAdmin.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "core", "serverAdmin.js"),
      serverAdmin.replace("  state.users = normalizeAdminUsers(state.users, state);\n", ""),
      "utf8"
    );
    const missingMigrationImplementation = await runReleaseAudit(tempRoot);
    assert.notEqual(missingMigrationImplementation.code, 0);
    assert.match(
      missingMigrationImplementation.stderr,
      /src\/core\/serverAdmin\.js must mention state\.users = normalizeAdminUsers\(state\.users, state\);/
    );

    await writeFile(join(tempRoot, "src", "core", "serverAdmin.js"), serverAdmin, "utf8");
    const coreTest = await readFile(join(tempRoot, "tests", "core.test.js"), "utf8");
    await writeFile(
      join(tempRoot, "tests", "core.test.js"),
      coreTest.replaceAll("admin state normalization migrates legacy users into device shape", "admin state normalization keeps current users stable"),
      "utf8"
    );
    const missingMigrationCoverage = await runReleaseAudit(tempRoot);
    assert.notEqual(missingMigrationCoverage.code, 0);
    assert.match(
      missingMigrationCoverage.stderr,
      /tests\/core\.test\.js must mention admin state normalization migrates legacy users into device shape/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when implemented API routes are missing from the API matrix", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-apimatrix-"));
  try {
    await writeReleaseAuditFixture(tempRoot);
    const serverSource = await readFile(join(projectRoot, "src", "server.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "server.js"),
      `${serverSource}

export function auditFixtureRoute(req, url) {
  if (req.method === "POST" && url.pathname === "/api/new-contract-route") {
    return true;
  }
}
`,
      "utf8"
    );
    const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      `${contract}\n\n\`\`\`http\nPOST /api/new-contract-route\n\`\`\`\n`,
      "utf8"
    );

    const missingRoute = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRoute.code, 0);
    assert.match(
      missingRoute.stderr,
      /docs\/API_MATRIX\.md must document API route POST \/api\/new-contract-route/
    );

    const matrix = await readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      matrix.replace(
        "| POST | `/api/admin/users/create` | 管理 token | 调试/运维入口 | 低层创建或登记设备；服务端控制台生成设备应使用 `/api/claims/create` |",
        "| POST | `/api/admin/users/create` | 管理 token | 服务端控制台 | 创建或登记设备 |"
      ),
      "utf8"
    );
    const misclassifiedAdminUserCreate = await runReleaseAudit(tempRoot);
    assert.notEqual(misclassifiedAdminUserCreate.code, 0);
    assert.match(
      misclassifiedAdminUserCreate.stderr,
      /docs\/API_MATRIX\.md must mention \| POST \| `\/api\/admin\/users\/create` \| 管理 token \| 调试\/运维入口/
    );

    await writeFile(join(tempRoot, "docs", "API_MATRIX.md"), matrix, "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      matrix.replace(
        "| GET | `/api/profile` | smoke、调试/兼容入口 |",
        "| GET | `/api/profile` | 调试/兼容入口 |"
      ),
      "utf8"
    );
    const missingSmokeConsumer = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSmokeConsumer.code, 0);
    assert.match(
      missingSmokeConsumer.stderr,
      /docs\/API_MATRIX\.md row for smoke API path \/api\/profile must include smoke in 当前消费者/
    );

    await writeFile(join(tempRoot, "docs", "API_MATRIX.md"), matrix, "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      matrix.replace(
        "| GET | `/api/admin/singbox/config` | 管理 token | 服务端控制台、smoke、运维只读入口 | 预览脱敏 sing-box 配置 |",
        "| GET | `/api/admin/singbox/config` | 管理 token | smoke、运维只读入口 | 预览脱敏 sing-box 配置 |"
      ),
      "utf8"
    );
    const missingSingboxConfigConsoleConsumer = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSingboxConfigConsoleConsumer.code, 0);
    assert.match(
      missingSingboxConfigConsoleConsumer.stderr,
      /docs\/API_MATRIX\.md must mention \| GET \| `\/api\/admin\/singbox\/config` \| 管理 token \| 服务端控制台、smoke、运维只读入口/
    );

    await writeFile(join(tempRoot, "docs", "API_MATRIX.md"), matrix, "utf8");
    const serverUiSource = await readFile(join(projectRoot, "public", "app.js"), "utf8");
    await writeFile(
      join(tempRoot, "public", "app.js"),
      serverUiSource.replace('byId("refreshSingboxConfigBtn").addEventListener("click", refreshSingboxConfigPreview);\n', ""),
      "utf8"
    );
    const missingSingboxConfigUi = await runReleaseAudit(tempRoot);
    assert.notEqual(missingSingboxConfigUi.code, 0);
    assert.match(
      missingSingboxConfigUi.stderr,
      /public\/app\.js must mention byId\("refreshSingboxConfigBtn"\)\.addEventListener\("click", refreshSingboxConfigPreview\)/
    );
    await writeFile(join(tempRoot, "public", "app.js"), serverUiSource, "utf8");

    await writeFile(
      join(tempRoot, "public", "app.js"),
      serverUiSource.replace("  await renderLatestSingboxConfigPreview();\n", ""),
      "utf8"
    );
    const missingClaimCreateConfigPreview = await runReleaseAudit(tempRoot);
    assert.notEqual(missingClaimCreateConfigPreview.code, 0);
    assert.match(
      missingClaimCreateConfigPreview.stderr,
      /public\/app\.js must mention await renderLatestSingboxConfigPreview\(\)/
    );
    await writeFile(join(tempRoot, "public", "app.js"), serverUiSource, "utf8");

    await writeFile(join(tempRoot, "docs", "API_MATRIX.md"), matrix, "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      `${matrix}\n| POST | \`/api/new-contract-route\` | 管理 token | 测试 | 测试路由 |\n`,
      "utf8"
    );
    const validRoute = await runReleaseAudit(tempRoot);
    assert.equal(validRoute.code, 0);
    assert.match(validRoute.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when client outbound server APIs are missing from the cross-runtime matrix", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-cross-runtime-"));
  try {
    await writeReleaseAuditFixture(tempRoot);
    const profileImport = await readFile(join(tempRoot, "client", "src", "profileImport.js"), "utf8");
    await writeFile(
      join(tempRoot, "client", "src", "profileImport.js"),
      `${profileImport}
export async function callServer(server) {
  return fetch(\`\${server}/api/client-to-server-new\`, { method: "POST" });
}
`,
      "utf8"
    );

    const missingCrossRuntimeRow = await runReleaseAudit(tempRoot);
    assert.notEqual(missingCrossRuntimeRow.code, 0);
    assert.match(
      missingCrossRuntimeRow.stderr,
      /docs\/API_MATRIX\.md cross-runtime table must document client outbound API path \/api\/client-to-server-new/
    );

    const matrix = await readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      `${matrix}\n| 客户端本地运行时 | POST | \`/api/client-to-server-new\` | 测试 | 测试成功 | 测试失败 |\n`,
      "utf8"
    );
    const validCrossRuntimeRow = await runReleaseAudit(tempRoot);
    assert.equal(validCrossRuntimeRow.code, 0);
    assert.match(validCrossRuntimeRow.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("release audit fails when implemented API routes are missing from the interface contract", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "sfsc-audit-interface-route-"));
  try {
    await writeReleaseAuditFixture(tempRoot);
    const serverSource = await readFile(join(projectRoot, "src", "server.js"), "utf8");
    await writeFile(
      join(tempRoot, "src", "server.js"),
      `${serverSource}

export function auditFixtureRoute(req, url) {
  if (req.method === "POST" && url.pathname === "/api/contract-only-route") {
    return true;
  }
}
`,
      "utf8"
    );
    const matrix = await readFile(join(projectRoot, "docs", "API_MATRIX.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "API_MATRIX.md"),
      `${matrix}\n| POST | \`/api/contract-only-route\` | 管理 token | 测试 | 测试路由 |\n`,
      "utf8"
    );

    const missingRoute = await runReleaseAudit(tempRoot);
    assert.notEqual(missingRoute.code, 0);
    assert.match(
      missingRoute.stderr,
      /docs\/INTERFACE_CONTRACT\.md must document API route POST \/api\/contract-only-route/
    );

    const contract = await readFile(join(projectRoot, "docs", "INTERFACE_CONTRACT.md"), "utf8");
    await writeFile(
      join(tempRoot, "docs", "INTERFACE_CONTRACT.md"),
      `${contract}\n\n\`\`\`http\nPOST /api/contract-only-route\n\`\`\`\n`,
      "utf8"
    );
    const validRoute = await runReleaseAudit(tempRoot);
    assert.equal(validRoute.code, 0);
    assert.match(validRoute.stdout, /Release audit passed/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("server env example covers compose deployment variables", async () => {
  const envExample = await readFile(join(projectRoot, "server", ".env.example"), "utf8");
  const compose = await readFile(join(projectRoot, "server", "docker-compose.yml"), "utf8");
  const composeN1 = await readFile(join(projectRoot, "server", "docker-compose.n1.yml"), "utf8");
  const singboxDockerfile = await readFile(join(projectRoot, "server", "sing-box.Dockerfile"), "utf8");
  const singboxExample = JSON.parse(await readFile(join(projectRoot, "server", "sing-box", "config.example.json"), "utf8"));
  const required = [
    "PUBLIC_SERVER_URL",
    "VLESS_PUBLIC_HOST",
    "VLESS_PUBLIC_PORT",
    "VLESS_PORT",
    "SYNC_SERVER_PORT",
    "SFSC_ADMIN_TOKEN",
    "S3_ENDPOINT",
    "S3_CLIENT_ENDPOINT",
    "S3_BUCKET",
    "MINIO_ROOT_USER",
    "MINIO_ROOT_PASSWORD",
    "MINIO_API_PORT",
    "MINIO_CONSOLE_PORT",
    "SING_BOX_IMAGE_TAG",
    "MINIO_IMAGE_TAG",
    "MINIO_MC_IMAGE_TAG"
  ];

  for (const name of required) {
    assert.match(envExample, new RegExp(`^${name}=`, "m"));
    assert.match(`${compose}\n${composeN1}`, new RegExp(`\\$\\{${name}(?::[-?]|})`));
  }

  assert.doesNotMatch(`${compose}\n${composeN1}`, /:latest\b/);
  assert.match(compose, /sfsc-sing-box:\$\{SING_BOX_IMAGE_TAG:-v1\.13\.14\}/);
  assert.match(composeN1, /sfsc-sing-box:\$\{SING_BOX_IMAGE_TAG:-v1\.13\.14\}/);
  assert.match(singboxDockerfile, /FROM ghcr\.io\/sagernet\/sing-box:\$\{SING_BOX_IMAGE_TAG\}/);
  assert.match(compose, /quay\.io\/minio\/minio:\$\{MINIO_IMAGE_TAG:-RELEASE\.2025-09-07T16-13-09Z\}/);
  assert.match(composeN1, /quay\.io\/minio\/minio:\$\{MINIO_IMAGE_TAG:-RELEASE\.2025-09-07T16-13-09Z\}/);
  assert.match(compose, /quay\.io\/minio\/mc:\$\{MINIO_MC_IMAGE_TAG:-RELEASE\.2025-08-13T08-35-41Z\}/);
  assert.match(composeN1, /quay\.io\/minio\/mc:\$\{MINIO_MC_IMAGE_TAG:-RELEASE\.2025-08-13T08-35-41Z\}/);
  assert.match(envExample, /^VLESS_PORT=45678$/m);
  assert.doesNotMatch(compose, /\$\{VLESS_PORT:-45678\}:45678\/tcp/);
  assert.match(compose, /SFSC_TUNNEL_PATH: \$\{SFSC_TUNNEL_PATH:-\/sfsc-vless\}/);
  assert.match(compose, /expose:\n      - "45678"/);
  assert.equal(singboxExample.inbounds[0].listen_port, 45678);
});

test("buildClientSingboxConfig keeps proxy local and mux disabled", () => {
  const config = buildClientSingboxConfig(uri, { localProxyPort: 18081 });
  assert.equal(config.inbounds[0].listen, "127.0.0.1");
  assert.equal(config.inbounds[0].listen_port, 18081);
  assert.equal(config.outbounds[0].type, "vless");
  assert.equal(config.outbounds[0].server, "pass.971223.xyz");
  assert.equal(config.outbounds[0].multiplex.enabled, false);
  assert.equal(config.outbounds[0].tls.reality.enabled, true);
});

test("buildRclonePreview injects process-scoped proxy env and multi-thread flags", () => {
  const preview = buildRclonePreview({
    direction: "upload",
    localPath: "D:\\Work\\Projects",
    remotePath: "home-minio:home-sync/company-pc1/projects",
    streams: 8,
    transfers: 4,
    dryRun: true,
    destructiveSync: false
  }, { localProxyPort: 18081 });

  assert.equal(preview.executable, "rclone");
  assert.equal(preview.args[0], "copy");
  assert.ok(preview.args.includes("--multi-thread-streams"));
  assert.ok(preview.args.includes("8"));
  assert.equal(preview.args.includes("--s3-upload-concurrency"), true);
  assert.ok(preview.args.includes("--dry-run"));
  assert.equal(preview.env.ALL_PROXY, "socks5://127.0.0.1:18081");
  assert.equal(preview.storage.endpoint, "http://minio:9000");
  assert.equal(preview.safety.usesProcessScopedProxy, true);
  assert.equal(preview.safety.mutatesSystemProxy, false);
  assert.equal(preview.safety.tunRequired, false);
  assert.equal(preview.safety.deleteProtection, true);
});

test("buildRclonePreview calculates a stable transfer plan before copy, sync, and bisync", () => {
  const jobs = [
    { direction: "upload", destructiveSync: false },
    { direction: "upload", destructiveSync: true },
    { direction: "bidirectional", destructiveSync: false }
  ];

  for (const job of jobs) {
    const preview = buildRclonePreview({
      ...job,
      localPath: "D:\\StablePlan",
      remotePath: "home-minio:home-sync/devices/stable-plan"
    });
    assert.ok(preview.args.includes("--check-first"), `${preview.args[0]} must calculate totals before transfer`);
  }
});

test("bandwidth limits normalize to rclone bwlimit syntax", () => {
  assert.equal(normalizeBandwidthLimit(), "off");
  assert.equal(normalizeBandwidthLimit(""), "off");
  assert.equal(normalizeBandwidthLimit("OFF"), "off");
  assert.equal(normalizeBandwidthLimit("500k"), "500k");
  assert.equal(normalizeBandwidthLimit("10m"), "10M");
  assert.equal(normalizeBandwidthLimit({ enabled: true, value: 1, unit: "GB/s" }), "1G");
  assert.equal(normalizeBandwidthLimit("08:00,10m 18:00,off"), "08:00,10M 18:00,off");
  assert.equal(normalizeBandwidthLimit({
    enabled: true,
    mode: "schedule",
    startTime: "08:00",
    endTime: "18:00",
    value: 10,
    unit: "MB/s"
  }), "08:00,10M 18:00,off");
  assert.deepEqual(parseBandwidthLimit("off"), {
    enabled: false,
    mode: "fixed",
    value: "",
    unit: "M",
    startTime: "08:00",
    endTime: "18:00"
  });
  assert.deepEqual(parseBandwidthLimit("10M"), {
    enabled: true,
    mode: "fixed",
    value: 10,
    unit: "M",
    startTime: "08:00",
    endTime: "18:00"
  });
  assert.deepEqual(parseBandwidthLimit("08:00,10M 18:00,off"), {
    enabled: true,
    mode: "schedule",
    value: 10,
    unit: "M",
    startTime: "08:00",
    endTime: "18:00"
  });
  assert.throws(() => normalizeBandwidthLimit("fast"), /Bandwidth limit/);
  assert.throws(() => normalizeBandwidthLimit("08:00,10M 08:00,off"), /differ/);
  assert.throws(() => normalizeBandwidthLimit({ enabled: true, value: 0, unit: "MB/s" }), /positive integer/);
});

test("sync safety policy defaults to 30-day recovery and bounded deletes", () => {
  assert.deepEqual(normalizeSyncSafety(), {
    version: 1,
    recoveryRetentionDays: 30,
    deleteLimit: { maxFiles: 100, maxPercent: 10 },
    bidirectional: { initialized: false, initialMode: "" }
  });
  assert.deepEqual(normalizeSyncSafety({
    recoveryRetentionDays: 14,
    deleteLimit: { maxFiles: 25, maxPercent: 5 },
    bidirectional: { initialized: true, initialMode: "newer" }
  }, "bidirectional"), {
    version: 1,
    recoveryRetentionDays: 14,
    deleteLimit: { maxFiles: 25, maxPercent: 5 },
    bidirectional: { initialized: true, initialMode: "newer" }
  });
  assert.throws(
    () => normalizeSyncSafety({ deleteLimit: { maxPercent: 101 } }),
    (error) => error.code === "validation_failed" && /100 or fewer/.test(error.publicMessage)
  );
  assert.throws(
    () => normalizeSyncSafety({ bidirectional: { initialMode: "unsafe" } }, "bidirectional"),
    (error) => error.code === "validation_failed" && /initial mode/.test(error.publicMessage)
  );
});

test("destructive rclone previews enforce the configured delete cap", () => {
  const preview = buildRclonePreview({
    localPath: "D:\\Safety",
    direction: "upload",
    destructiveSync: true,
    safety: { deleteLimit: { maxFiles: 7 } }
  });
  const maxDeleteIndex = preview.args.indexOf("--max-delete");
  assert.notEqual(maxDeleteIndex, -1);
  assert.equal(preview.args[maxDeleteIndex + 1], "7");
});

test("buildRclonePreview includes normalized bwlimit when enabled", () => {
  const preview = buildRclonePreview({
    direction: "upload",
    localPath: "D:\\Work\\Projects",
    remoteName: "home-minio",
    bucketName: "home-sync",
    clientName: "company-pc1",
    remoteFolder: "projects",
    bandwidthLimit: { enabled: true, value: 10, unit: "MB/s" }
  });

  assert.ok(preview.args.includes("--bwlimit"));
  assert.equal(preview.args[preview.args.indexOf("--bwlimit") + 1], "10M");

  const scheduled = buildRclonePreview({
    direction: "upload",
    localPath: "D:\\Work\\Projects",
    remoteName: "home-minio",
    bucketName: "home-sync",
    clientName: "company-pc1",
    remoteFolder: "projects",
    bandwidthLimit: "08:00,10M 18:00,off"
  });
  assert.equal(scheduled.args[scheduled.args.indexOf("--bwlimit") + 1], "08:00,10M 18:00,off");
});

test("buildRclonePreview includes S3-specific flags and remote config", () => {
  const preview = buildRclonePreview({
    direction: "upload",
    localPath: "D:\\Work\\Projects",
    remoteName: "home-minio",
    bucketName: "home-sync",
    clientName: "company-pc1",
    remoteFolder: "projects",
    storageBackend: "s3",
    streams: 8,
    accessKeyId: "company-pc1",
    secretAccessKey: "secret-for-test"
  });

  assert.ok(preview.args.includes("--s3-upload-concurrency"));
  assert.ok(preview.args.includes("--s3-chunk-size"));
  assert.equal(preview.remotePath, "home-minio:home-sync/devices/company-pc1/projects");
  assert.ok(preview.remoteConfig.displayCommand.includes("provider Minio"));
  assert.equal(preview.remoteConfig.args.includes("secret-for-test"), false);
  assert.equal(preview.remoteConfig.args.includes("secret_access_key"), false);
  assert.equal(preview.remoteConfig.env.RCLONE_CONFIG_HOME_MINIO_SECRET_ACCESS_KEY, "secret-for-test");
  assert.equal(preview.env.RCLONE_CONFIG_HOME_MINIO_SECRET_ACCESS_KEY, "secret-for-test");
  assert.equal(preview.remoteConfig.displayCommand.includes("secret-for-test"), false);
  assert.equal(preview.displayCommand.includes("secret-for-test"), false);
  assert.ok(preview.remoteConfig.displayCommand.includes("se****st"));
});

test("buildRclonePreview reverses source and target for download", () => {
  const preview = buildRclonePreview({
    direction: "download",
    localPath: "E:\\Restore\\Docs",
    remotePath: "home-minio:home-sync/shared/docs",
    streams: 4,
    transfers: 2
  });

  assert.equal(preview.args[1], "home-minio:home-sync/shared/docs");
  assert.equal(preview.args[2], "E:\\Restore\\Docs");
});

test("buildRclonePreview ignores destructive sync for bidirectional jobs", () => {
  const preview = buildRclonePreview({
    direction: "bidirectional",
    destructiveSync: true,
    localPath: "D:\\Work\\Projects",
    remotePath: "home-minio:home-sync/devices/company-pc1/projects"
  });

  assert.equal(preview.args[0], "bisync");
  assert.equal(preview.safety.deleteProtection, true);
});

test("buildServerFolderRemotePath scopes device folders under the client namespace", () => {
  const remotePath = buildServerFolderRemotePath({
    remoteName: "server-folder",
    clientName: "company-pc1",
    serverSpace: "device",
    serverSubdir: "projects"
  });

  assert.equal(remotePath, "server-folder:devices/company-pc1/projects");
});

test("buildStorageRemotePath scopes S3 paths under the bucket and client namespace", () => {
  const remotePath = buildStorageRemotePath({
    remoteName: "home-minio",
    bucketName: "home-sync",
    clientName: "company-pc1",
    serverSpace: "device",
    remoteFolder: "projects"
  });

  assert.equal(remotePath, "home-minio:home-sync/devices/company-pc1/projects");
});

test("buildRclonePreview builds an S3 bucket path when raw remotePath is omitted", () => {
  const preview = buildRclonePreview({
    direction: "upload",
    localPath: "D:\\Work\\Projects",
    remoteName: "home-minio",
    bucketName: "home-sync",
    clientName: "company-pc1",
    serverSpace: "device",
    remoteFolder: "projects",
    streams: 8,
    transfers: 4
  });

  assert.equal(preview.remotePath, "home-minio:home-sync/devices/company-pc1/projects");
  assert.equal(preview.args[1], "D:\\Work\\Projects");
  assert.equal(preview.args[2], "home-minio:home-sync/devices/company-pc1/projects");
});

test("storage paths reject traversal, invalid buckets, and absolute drive paths", () => {
  assert.throws(() => buildStorageRemotePath({
    clientName: "company-pc1",
    remoteFolder: "../secret"
  }), /cannot contain/);

  assert.throws(() => buildStorageRemotePath({
    clientName: "company-pc1",
    remoteFolder: "C:\\secret"
  }), /relative/);

  assert.throws(() => buildStorageRemotePath({
    bucketName: "Bad_Bucket",
    clientName: "company-pc1",
    remoteFolder: "projects"
  }), /Bucket name/);
});

test("remote names cannot inject rclone flags through the positional path", () => {
  // `name:bucket/prefix` is a positional argument. rclone parses any positional
  // starting with `-` as flags, so a server-supplied name like `-P` or `--config`
  // would smuggle CLI options into the client's own rclone invocation.
  for (const remoteName of ["-P", "--config", "-", "-vv", "--dry-run"]) {
    assert.throws(() => buildStorageRemotePath({
      remoteName,
      clientName: "company-pc1",
      remoteFolder: "projects"
    }), /Remote name must start with a letter or number/, `remoteName ${JSON.stringify(remoteName)}`);
  }

  // Legitimate names containing - and _ in non-leading positions still work.
  assert.equal(
    buildStorageRemotePath({ remoteName: "home-minio-v2", clientName: "company-pc1", remoteFolder: "projects" }),
    "home-minio-v2:home-sync/devices/company-pc1/projects"
  );
  assert.equal(
    buildStorageRemotePath({ remoteName: "9lives_remote", clientName: "company-pc1", remoteFolder: "projects" }),
    "9lives_remote:home-sync/devices/company-pc1/projects"
  );
});

test("rclone preview refuses flag-like positional arguments", () => {
  // Defense in depth: if any future path bypasses remote-name/local-path
  // validation, building the command must fail instead of handing rclone flags.
  assert.throws(() => buildRclonePreview({
    name: "job",
    localPath: "--config",
    direction: "upload",
    clientName: "company-pc1",
    remoteFolder: "projects"
  }), /flag-like path argument/);

  // This case is load-bearing rather than defensive: remotePath is a
  // server-supplied field (SERVER_JOBS_PREVIEW_JOB_STRING_FIELDS) and
  // resolveRemotePath returns it verbatim, bypassing sanitizeRemoteName. A
  // malicious or compromised server must not be able to add rclone flags.
  for (const remotePath of ["--config=/tmp/evil.conf", "-P", "--dump-bodies"]) {
    assert.throws(() => buildRclonePreview({
      name: "job",
      localPath: "D:\\Work\\Projects",
      direction: "download",
      clientName: "company-pc1",
      remotePath
    }), /flag-like path argument/, `remotePath ${JSON.stringify(remotePath)}`);
  }

  // A server-supplied remotePath containing spaces is still a single argv
  // element: no shell is used anywhere (spawn without shell:true), so it cannot
  // split into extra arguments and must be passed through unchanged.
  const spaced = buildRclonePreview({
    name: "job",
    localPath: "D:\\Work\\Projects",
    direction: "download",
    clientName: "company-pc1",
    remotePath: "home-minio:bucket/a b --config /tmp/evil.conf"
  });
  assert.equal(spaced.args[1], "home-minio:bucket/a b --config /tmp/evil.conf");
});

test("claim redeem passthrough error codes are centralized in core", () => {
  assert.deepEqual(CLAIM_REDEEM_ERROR_CODES, [
    "claim_not_found",
    "claim_already_used",
    "claim_expired",
    "claim_redeem_rate_limited",
    "server_state_write_failed",
    "validation_failed"
  ]);
  assert.equal(isClaimRedeemErrorCode("claim_not_found"), true);
  assert.equal(isClaimRedeemErrorCode("claim_redeem_rate_limited"), true);
  assert.equal(isClaimRedeemErrorCode("server_state_write_failed"), true);
  assert.equal(isClaimRedeemErrorCode("claim_redeem_failed"), false);
  assert.equal(isClaimRedeemErrorCode("SERVER_STATE_WRITE_FAILED"), false);
  assert.equal(isClaimRedeemErrorCode("unknown_remote_error"), false);
});

test("normalizeHttpError maps product-facing error codes", () => {
  assert.deepEqual(normalizeHttpError(new Error("Import code is required"), "client_error"), {
    status: 400,
    code: "import_code_required",
    message: "Import code is required"
  });

  assert.deepEqual(normalizeHttpError(new Error("Missing bundled rclone: C:\\App\\rclone.exe"), "client_error"), {
    status: 503,
    code: "missing_rclone_binary",
    message: "Missing bundled rclone: C:\\App\\rclone.exe"
  });

  assert.deepEqual(normalizeHttpError({ code: "binary_version_check_failed", message: "Binary version check failed" }, "client_error"), {
    status: 503,
    code: "binary_version_check_failed",
    message: "Binary version check failed"
  });

  assert.deepEqual(normalizeHttpError({ code: "binary_version_check_failed", status: 200, message: "Binary version check failed" }, "client_error"), {
    status: 503,
    code: "binary_version_check_failed",
    message: "Binary version check failed"
  });

  assert.deepEqual(normalizeHttpError({ code: "claim_redeem_failed", status: 418, message: "Remote refused claim redeem" }, "client_error"), {
    status: 418,
    code: "claim_redeem_failed",
    message: "Remote refused claim redeem"
  });

  assert.deepEqual(normalizeHttpError({ code: "made_up_internal_code", status: 418, message: "Internal detail" }, "server_error"), {
    status: 500,
    code: "server_error",
    message: "Internal server error"
  });

  assert.deepEqual(normalizeHttpError(new Error("C:\\private\\runtime\\secret.txt"), "client_error"), {
    status: 400,
    code: "client_error",
    message: "Client request failed"
  });

  assert.deepEqual(normalizeHttpError(new Error("Storage bucket is disabled"), "server_error"), {
    status: 409,
    code: "bucket_disabled",
    message: "Storage bucket is disabled"
  });

  assert.deepEqual(normalizeHttpError(new Error("Client name can only contain letters, numbers, _ and -"), "server_error"), {
    status: 400,
    code: "validation_failed",
    message: "Client name can only contain letters, numbers, _ and -"
  });

  assert.deepEqual(normalizeHttpError(new Error("Bandwidth limit value must be a positive integer"), "client_error"), {
    status: 400,
    code: "validation_failed",
    message: "Bandwidth limit value must be a positive integer"
  });

  assert.deepEqual(normalizeHttpError(new Error("Schedule daily time must use HH:MM 24-hour format"), "client_error"), {
    status: 400,
    code: "validation_failed",
    message: "Schedule daily time must use HH:MM 24-hour format"
  });

  assert.deepEqual(normalizeHttpError(new Error("Invalid URL"), "server_error"), {
    status: 400,
    code: "validation_failed",
    message: "Invalid URL"
  });

  assert.deepEqual(normalizeHttpError(new Error("Profile source server must use http or https"), "client_error"), {
    status: 400,
    code: "validation_failed",
    message: "Profile source server must use http or https"
  });

  // Storage backend failures must not echo the internal MinIO/S3 endpoint, host
  // name or resolver error back to the caller: the public message is a stable
  // sanitized string and the raw detail stays in the server-side error chain.
  const storageEndpointFailure = normalizeHttpError(new Error("http://minio:9000: fetch failed"), "server_error");
  assert.deepEqual(storageEndpointFailure, {
    status: 502,
    code: "storage_request_failed",
    message: "Storage backend request failed"
  });
  assert.equal(storageEndpointFailure.message.includes("minio"), false);
  assert.equal(storageEndpointFailure.message.includes("9000"), false);

  assert.deepEqual(normalizeHttpError(new Error("getaddrinfo ENOTFOUND minio"), "server_error"), {
    status: 502,
    code: "storage_request_failed",
    message: "Storage backend request failed"
  });

  assert.deepEqual(normalizeHttpError(createHttpError(
    "singbox_start_failed",
    500,
    "Failed to start sing-box: access denied"
  ), "client_error"), {
    status: 500,
    code: "singbox_start_failed",
    message: "Failed to start sing-box: access denied"
  });

  assert.deepEqual(normalizeHttpError(createHttpError(
    "rclone_config_failed",
    500,
    "Failed to write rclone remote config: invalid credentials"
  ), "client_error"), {
    status: 500,
    code: "rclone_config_failed",
    message: "Failed to write rclone remote config: invalid credentials"
  });

  // Server-side state/config failures embed absolute paths and raw fs error
  // strings, so the public message is a stable sanitized string. The absolute
  // path stays in the operator's own stderr at startup.
  const corruptState = normalizeHttpError(new Error("Server state file is not valid JSON: /srv/sfsc/data/sfsc-state.json"), "server_error");
  assert.deepEqual(corruptState, {
    status: 500,
    code: "server_state_corrupt",
    message: "Server state file is corrupt"
  });
  assert.equal(corruptState.message.includes("/srv/sfsc"), false);

  assert.deepEqual(normalizeHttpError(new Error("Failed to write server sing-box config: EACCES"), "server_error"), {
    status: 500,
    code: "server_singbox_config_write_failed",
    message: "sing-box config could not be written"
  });

  assert.deepEqual(normalizeHttpError(new Error("Failed to write server state: ENOSPC"), "server_error"), {
    status: 500,
    code: "server_state_write_failed",
    message: "Server state could not be written"
  });

  // A client-local corrupt state file is reported over a loopback-only API and
  // names only the basename, so it stays verbatim to remain diagnosable.
  assert.deepEqual(normalizeHttpError(
    createHttpError("local_state_corrupt", 409, "Local state file is not valid JSON: jobs.json"),
    "client_error"
  ), {
    status: 409,
    code: "local_state_corrupt",
    message: "Local state file is not valid JSON: jobs.json"
  });
});

test("sync run summaries normalize shared client/server fields", () => {
  const normalized = normalizeSyncRun({
    id: " sync-1 ",
    status: "SUCCESS",
    trigger: "scheduler",
    startedAt: "2026-07-03T10:00:00.000Z",
    finishedAt: "2026-07-03T10:05:00.000Z",
    job: {
      name: "contract-sync",
      direction: "bidirectional",
      remotePrefix: "devices\\company-pc1"
    },
    localPath: "D:\\Work",
    exitCode: 0,
    errorCode: "rclone_sync_failed",
    error: "",
    progressPercent: 120,
    transferredSizeText: "1 GiB / 1 GiB",
    currentFile: "projects/video.iso",
    rawSpeed: "8 MiB/s",
    speedMbps: 67.11,
    conflicts: {
      count: 12,
      files: ["projects\\a.txt", "projects/b.txt", "projects/a.txt"],
      truncated: true
    }
  });

  assert.equal(normalized.id, "sync-1");
  assert.equal(normalized.status, "success");
  assert.equal(normalized.trigger, "scheduler");
  assert.equal(normalized.progressPercent, 100);
  assert.equal(normalized.job.remotePrefix, "devices/company-pc1");
  assert.equal(normalized.rawSpeed, "8 MiB/s");
  assert.equal(normalized.speedMbps, 67.11);
  assert.equal(normalized.exitCode, 0);
  assert.equal(normalized.errorCode, "");
  assert.equal(normalized.error, "");
  assert.equal(normalized.conflicts.count, 12);
  assert.deepEqual(normalized.conflicts.files, ["projects/a.txt", "projects/b.txt"]);
  assert.equal(normalized.conflicts.truncated, true);

  const unknown = normalizeSyncRun({
    status: "done",
    startedAt: "not-a-date",
    progressPercent: "bad",
    speedMbps: -1,
    trigger: "daemon",
    errorCode: "not stable"
  });
  assert.equal(unknown.status, "unknown");
  assert.equal(unknown.trigger, "manual");
  assert.equal(unknown.startedAt, null);
  assert.equal(unknown.progressPercent, null);
  assert.equal(unknown.speedMbps, 0);
  assert.equal(unknown.errorCode, "");
  assert.equal(unknown.conflicts.count, 0);

  const failed = normalizeSyncRun({
    status: "error",
    errorCode: "rclone_sync_failed",
    error: "rclone exited with code 7"
  });
  assert.equal(failed.errorCode, "rclone_sync_failed");
  assert.equal(failed.error, "rclone exited with code 7");
});

test("one-way sync summaries discard conflict reports", () => {
  const conflicts = {
    count: 2,
    files: ["projects/a.txt", "projects/b.txt"],
    truncated: true
  };

  for (const direction of ["upload", "download"]) {
    const run = normalizeSyncRun({
      status: "success",
      job: { direction },
      conflicts
    });
    assert.deepEqual(run.conflicts, { count: 0, files: [], truncated: false });

    const sync = normalizeDeviceSync({
      currentJob: { direction },
      conflicts,
      lastRun: {
        status: "success",
        job: { direction },
        conflicts
      }
    });
    assert.deepEqual(sync.conflicts, { count: 0, files: [], truncated: false });
    assert.deepEqual(sync.lastRun.conflicts, { count: 0, files: [], truncated: false });
  }
});

test("scheduler summaries keep only stable error codes", () => {
  const normalized = normalizeDeviceSync({
    scheduler: {
      enabled: true,
      intervalMs: 15000,
      nextRun: "on-startup",
      lastError: "Missing bundled rclone: C:\\App\\rclone.exe",
      jobs: [
        {
          id: "job-1",
          name: "folder-sync",
          schedule: { mode: "interval", intervalMinutes: 30 },
          scheduleText: "Every 30 minutes",
          nextRun: "2026-07-03T10:30:00.000Z",
          lastError: "missing_rclone_binary"
        },
        {
          id: "job-2",
          scheduleText: "Daily at 02:00",
          lastError: "Bad Error Text"
        }
      ]
    }
  });

  assert.equal(normalized.scheduler.lastError, "");
  assert.deepEqual(normalized.scheduler.jobs[0].schedule, { mode: "interval", intervalMinutes: 30 });
  assert.equal(normalized.scheduler.jobs[0].lastError, "missing_rclone_binary");
  assert.deepEqual(normalized.scheduler.jobs[1].schedule, { mode: "manual" });
  assert.equal(normalized.scheduler.jobs[1].lastError, "");
});

test("schedule helpers describe and compute interval runs", () => {
  const now = new Date("2026-07-03T10:00:00.000Z");
  const schedule = normalizeSchedule({ mode: "interval", intervalMinutes: "30" });
  assert.equal(describeSchedule(schedule), "Every 30 minutes");
  assert.equal(computeNextRun(schedule, now).toISOString(), "2026-07-03T10:30:00.000Z");
});

test("schedule normalization validates supported product modes", () => {
  assert.deepEqual(normalizeSchedule(), { mode: "manual" });
  assert.deepEqual(normalizeSchedule({ mode: "interval", intervalMinutes: 15 }), {
    mode: "interval",
    intervalMinutes: 15
  });
  assert.deepEqual(normalizeSchedule({ mode: "daily", time: "09:30" }), {
    mode: "daily",
    time: "09:30"
  });
  assert.deepEqual(normalizeSchedule({ mode: "startup" }), { mode: "startup" });
  assert.throws(() => normalizeSchedule({ mode: "interval", intervalMinutes: 0 }), /Schedule interval/);
  assert.throws(() => normalizeSchedule({ mode: "daily", time: "24:00" }), /Schedule daily time/);
  assert.throws(() => normalizeSchedule({ mode: "cron" }), /Schedule mode/);
});

test("daily schedule rolls to tomorrow when time passed", () => {
  const now = new Date(2026, 6, 3, 10, 0, 0, 0);
  const schedule = { mode: "daily", time: "09:30" };
  const next = computeNextRun(schedule, now);
  assert.equal(next.getFullYear(), 2026);
  assert.equal(next.getMonth(), 6);
  assert.equal(next.getDate(), 4);
  assert.equal(next.getHours(), 9);
  assert.equal(next.getMinutes(), 30);
});

test("startup schedules resolve the next run marker after mode normalization", () => {
  const now = new Date("2026-07-03T10:00:00.000Z");
  // computeNextRun must branch on the normalized mode, not the raw input.
  // Reading schedule.mode directly made every non-canonical spelling fall
  // through to null even though describeSchedule already treated it as startup.
  for (const mode of ["startup", "STARTUP", " startup ", "Startup"]) {
    assert.equal(computeNextRun({ mode }, now), "on-startup", `mode ${JSON.stringify(mode)}`);
    assert.equal(describeSchedule({ mode }), "Run on client startup", `mode ${JSON.stringify(mode)}`);
  }
  assert.equal(computeNextRun(normalizeSchedule({ mode: "STARTUP" }), now), "on-startup");
  assert.equal(computeNextRun({ mode: "manual" }, now), null);
});

test("SFSC import profile encodes server-issued tunnel and storage settings", () => {
  const profile = {
    version: 1,
    profileId: "profile-company-pc1",
    clientName: "company-pc1",
    issuedAt: "2026-07-03T00:00:00.000Z",
    source: {
      type: "profile",
      server: "https://pass.971223.xyz:2025/"
    },
    tunnel: {
      type: "vless",
      uri
    },
    heartbeat: {
      scheme: "sfsc-hmac-sha256-v1",
      secret: "heartbeat-secret"
    },
    storage: {
      type: "s3",
      remoteName: "home-minio",
      endpoint: "http://minio:9000",
      bucket: "home-sync",
      accessKeyId: "company-pc1",
      secretAccessKey: "secret",
      prefix: "devices/company-pc1"
    },
    defaults: {
      localProxyPort: 18081,
      transfers: 4,
      streams: 8,
      chunkSize: "16M"
    }
  };

  const code = encodeImportProfile(profile, { format: "code" });
  assert.match(code, /^SFSC1-/);

  const decoded = decodeImportProfile(code);
  assert.equal(decoded.clientName, "company-pc1");
  assert.deepEqual(decoded.source, {
    type: "profile",
    server: "https://pass.971223.xyz:2025"
  });
  assert.equal(decoded.tunnel.parsed.server, "pass.971223.xyz");
  assert.equal(decoded.heartbeat.scheme, "sfsc-hmac-sha256-v1");
  assert.equal(decoded.heartbeat.secret, "heartbeat-secret");
  assert.equal(decoded.storage.prefix, "devices/company-pc1");

  const job = buildJobFromProfile(decoded, {
    direction: "upload",
    localPath: "D:\\Work\\Projects",
    schedule: { mode: "interval", intervalMinutes: 30 }
  });

  assert.equal(job.remotePrefix, "devices/company-pc1");
  assert.equal(job.bucketName, "home-sync");
  assert.equal(job.localProxyPort, 18081);
});

test("SFSC claim token only carries server address and one-time code", () => {
  const claimCode = encodeClaimToken({
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });
  assert.match(claimCode, /^SFSC1-/);

  const decoded = decodeClaimToken(claimCode);
  assert.deepEqual(decoded, {
    version: 1,
    type: "claim",
    server: "https://pass.971223.xyz:2025",
    code: "C7KD-92PQ"
  });
});

test("SyncKey short code generation is strict while redemption parsing remains legacy-compatible", () => {
  assert.throws(
    () => encodeClaimToken({
      server: "https://pass.971223.xyz:2025",
      code: "I0O1-92PQ"
    }),
    /unambiguous/
  );

  const legacyPayload = {
    version: 1,
    type: "claim",
    server: "https://pass.971223.xyz:2025",
    code: "I0O1-92PQ"
  };
  const legacyToken = `SFSC1-${Buffer.from(JSON.stringify(legacyPayload), "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")}`;
  assert.equal(decodeClaimToken(legacyToken).code, "I0O1-92PQ");

  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://pass.971223.xyz:2025"
  });
  const result = createClaim(state, {
    clientName: "company-pc1"
  });
  assert.match(result.claim.code, CLAIM_CODE_PATTERN);
  assertAdminClaimSummaryContract(summarizeAdminState(state).claims[0]);

  state.claims[0].code = "I0O1-92PQ";
  const redeemed = redeemClaim(state, { code: "I0O1-92PQ" });
  assert.equal(redeemed.clientName, "company-pc1");
});

test("heartbeat auth signs the JSON heartbeat payload", () => {
  const secret = "heartbeat-secret";
  const timestamp = "2026-07-03T10:00:00.000Z";
  const payload = {
    clientName: "company-pc1",
    clientVersion: "0.3.0-rc.1",
    optional: undefined,
    sync: {
      syncState: "syncing",
      progressPercent: 42,
      tags: ["ready", undefined]
    }
  };
  const auth = createHeartbeatAuth(payload, secret, {
    timestamp,
    nonce: "nonce-123456"
  });
  const parsedPayload = JSON.parse(JSON.stringify({
    ...payload,
    auth
  }));

  assert.equal(verifyHeartbeatAuth(parsedPayload, secret, {
    nowMs: new Date(timestamp).getTime()
  }), true);

  assert.throws(() => verifyHeartbeatAuth({
    ...parsedPayload,
    sync: {
      ...parsedPayload.sync,
      progressPercent: 43
    }
  }, secret, {
    nowMs: new Date(timestamp).getTime()
  }), { code: "heartbeat_auth_invalid" });

  assert.throws(() => verifyHeartbeatAuth({
    ...parsedPayload,
    auth: {
      ...auth,
      scheme: "other"
    }
  }, secret, {
    nowMs: new Date(timestamp).getTime()
  }), { code: "heartbeat_auth_invalid" });

  assert.throws(() => verifyHeartbeatAuth(parsedPayload, "wrong-secret", {
    nowMs: new Date(timestamp).getTime()
  }), { code: "heartbeat_auth_invalid" });

  assert.throws(() => verifyHeartbeatAuth(parsedPayload, secret, {
    nowMs: new Date(timestamp).getTime() + 10 * 60 * 1000
  }), { code: "heartbeat_auth_invalid" });

  assert.throws(() => verifyHeartbeatAuth({
    clientName: "company-pc1"
  }, secret, {
    nowMs: new Date(timestamp).getTime()
  }), { code: "heartbeat_auth_required" });
});

test("server creates a claim that redeems into a complete profile once", () => {
  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://pass.971223.xyz:2025",
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679",
    S3_ENDPOINT: "http://minio:9000",
    S3_BUCKET: "home-sync",
    S3_ACCESS_KEY_ID: "syncadmin",
    S3_SECRET_ACCESS_KEY: "secret"
  });

  const result = createClaim(state, {
    clientName: "company-pc1",
    expiresInHours: 24
  });

  const payload = decodeClaimToken(result.token);
  assert.equal(payload.server, "https://pass.971223.xyz:2025");
  assert.equal(payload.code, result.claim.code);
  assert.equal(result.profile.clientName, "company-pc1");
  assert.equal(result.profile.storage.bucket, "home-sync");
  assert.equal(result.profile.storage.prefix, "devices/company-pc1");
  assert.equal(result.profile.heartbeat.scheme, "sfsc-hmac-sha256-v1");
  assert.ok(result.profile.heartbeat.secret);
  assert.match(result.profile.tunnel.uri, /^vless:\/\/.+@pass\.971223\.xyz:45679\?/);

  const redeemed = redeemClaim(state, { code: result.token });
  assert.equal(redeemed.profileId, result.profile.profileId);
  assert.equal(redeemed.heartbeat.secret, result.profile.heartbeat.secret);
  assert.equal(state.claims[0].used, true);
  assert.throws(() => redeemClaim(state, { code: result.claim.code }), /claim_already_used/);
});

test("server claim creation reports client name length separately from character validation", () => {
  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://pass.971223.xyz:2025",
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    S3_SECRET_ACCESS_KEY: "secret"
  });

  assert.throws(
    () => createClaim(state, { clientName: "a".repeat(64) }),
    (error) => error.code === "validation_failed"
      && error.status === 400
      && error.publicMessage === "Client name must be 1-63 characters"
  );
  assert.throws(
    () => createClaim(state, { clientName: "-bad" }),
    (error) => error.code === "validation_failed"
      && error.status === 400
      && error.publicMessage === "Client name can only contain letters, numbers, _ and -"
  );
});

test("server allows short claim replay only for the same redeem binding", () => {
  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://pass.971223.xyz:2025",
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    S3_SECRET_ACCESS_KEY: "secret"
  });
  const result = createClaim(state, {
    clientName: "replay-pc",
    expiresInHours: 24
  });

  const first = redeemClaim(state, {
    code: result.token,
    clientRedeemId: "redeem-attempt-1",
    clientInstallId: "install-device-1"
  });
  assert.equal(first.profileId, result.profile.profileId);
  assert.equal(state.claims[0].used, true);
  assert.equal(state.claims[0].redeemedBy.clientRedeemId, "redeem-attempt-1");
  assert.match(state.claims[0].redeemedBy.clientInstallIdHash, /^[a-f0-9]{64}$/);
  assert.match(state.claims[0].replayUntil, /^\d{4}-\d{2}-\d{2}T/);

  const replay = redeemClaim(state, {
    code: result.claim.code,
    clientRedeemId: "redeem-attempt-1",
    clientInstallId: "install-device-1"
  });
  assert.equal(replay.profileId, result.profile.profileId);
  assert.equal(replay.heartbeat.secret, result.profile.heartbeat.secret);

  assert.throws(() => redeemClaim(state, {
    code: result.claim.code,
    clientRedeemId: "redeem-attempt-2",
    clientInstallId: "install-device-1"
  }), /claim_already_used/);
  assert.throws(() => redeemClaim(state, {
    code: result.claim.code,
    clientRedeemId: "redeem-attempt-1",
    clientInstallId: "install-device-2"
  }), /claim_already_used/);
  assert.throws(() => redeemClaim(state, {
    code: result.claim.code
  }), /claim_already_used/);

  state.claims[0].replayUntil = "2000-01-01T00:00:00.000Z";
  assert.throws(() => redeemClaim(state, {
    code: result.claim.code,
    clientRedeemId: "redeem-attempt-1",
    clientInstallId: "install-device-1"
  }), /claim_already_used/);
});

test("admin state compaction prunes stale claims, deleted users, and replay bindings", () => {
  const nowMs = Date.parse("2026-07-08T12:00:00.000Z");
  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://pass.971223.xyz:2025",
    S3_SECRET_ACCESS_KEY: "secret"
  });

  const used = createClaim(state, { clientName: "used-retained-pc", expiresInHours: 24 });
  redeemClaim(state, {
    tKey: used.token,
    clientRedeemId: "used-redeem",
    clientInstallId: "used-install"
  });
  state.claims[0].replayUntil = "2026-07-01T00:00:00.000Z";

  const expiredUnused = createClaim(state, { clientName: "expired-unused-pc", expiresAt: "2099-01-01T00:00:00.000Z" });
  expiredUnused.claim.expiresAt = "2026-06-01T00:00:00.000Z";

  const recentExpiredUnused = createClaim(state, { clientName: "recent-unused-pc", expiresAt: "2099-01-01T00:00:00.000Z" });
  recentExpiredUnused.claim.expiresAt = "2026-07-07T12:00:00.000Z";

  state.users.push({
    id: "user-old-deleted-unreferenced",
    clientName: "old-deleted-unreferenced",
    uuid: "11111111-1111-4111-8111-111111111111",
    enabled: false,
    deletedAt: "2026-05-01T00:00:00.000Z",
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    heartbeatAuthNonces: [{ nonce: "old", timestamp: "2026-05-01T00:00:00.000Z", seenAt: "2026-05-01T00:00:00.000Z" }],
    storage: {
      accessKeyId: "old-deleted-unreferenced",
      secretAccessKey: "secret",
      bucket: "home-sync",
      prefix: "devices/old-deleted-unreferenced"
    }
  });

  const result = compactAdminState(state, { nowMs });
  assert.equal(result.changed, true);
  assert.equal(result.prunedClaims, 1);
  assert.equal(result.prunedUsers, 1);
  assert.equal(state.claims.some((claim) => claim.code === expiredUnused.claim.code), false);
  assert.equal(state.claims.some((claim) => claim.code === recentExpiredUnused.claim.code), true);
  const retainedUsed = state.claims.find((claim) => claim.code === used.claim.code);
  assert.equal(retainedUsed.used, true);
  assert.equal(retainedUsed.replayUntil, undefined);
  assert.deepEqual(Object.keys(retainedUsed.redeemedBy), ["firstRedeemedAt"]);
  assert.equal(state.users.some((user) => user.id === "user-old-deleted-unreferenced"), false);
  assert.equal(state.users.find((user) => user.clientName === "used-retained-pc")?.deletedAt, undefined);
});

test("stale SyncKeys cannot redeem after issued profile material drifts", () => {
  const tunnelState = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "old.example",
    VLESS_PORT: "45679"
  });
  const tunnelClaim = createClaim(tunnelState, { clientName: "tunnel-drift-pc" });
  updateTunnelConfig(tunnelState, {
    publicHost: "new.example",
    publicPort: 45679,
    listenPort: 45679
  });
  assert.throws(() => redeemClaim(tunnelState, { tKey: tunnelClaim.token }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /profile is stale/);
    return true;
  });
  assert.equal(tunnelClaim.claim.used, false);
  assert.equal(tunnelClaim.claim.redeemedAt, null);

  const storageState = createDefaultAdminState({
    S3_ENDPOINT: "http://minio:9000"
  });
  const storageClaim = createClaim(storageState, { clientName: "storage-drift-pc" });
  updateStorageConfig(storageState, {
    endpoint: "http://new-minio:9000",
    internalEndpoint: "http://new-minio:9000"
  });
  assert.throws(() => redeemClaim(storageState, { tKey: storageClaim.token }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /profile is stale/);
    return true;
  });
  assert.equal(storageClaim.claim.used, false);
  assert.equal(storageClaim.claim.redeemedAt, null);

  const defaultsState = createDefaultAdminState();
  const defaultsClaim = createClaim(defaultsState, { clientName: "defaults-drift-pc" });
  defaultsState.defaults.transfers = 12;
  assert.throws(() => redeemClaim(defaultsState, { tKey: defaultsClaim.token }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /profile is stale/);
    return true;
  });
  assert.equal(defaultsClaim.claim.used, false);
  assert.equal(defaultsClaim.claim.redeemedAt, null);

  const customDefaultsState = createDefaultAdminState();
  const customDefaultsClaim = createClaim(customDefaultsState, {
    clientName: "custom-defaults-pc",
    defaults: {
      transfers: 9
    }
  });
  customDefaultsState.defaults.transfers = 12;
  const redeemed = redeemClaim(customDefaultsState, { tKey: customDefaultsClaim.token });
  assert.equal(redeemed.defaults.transfers, 9);
  assert.equal(customDefaultsClaim.claim.used, true);
});

test("SyncKey profile expiry is validated before issuing and redeeming", async () => {
  const invalidState = createDefaultAdminState();
  assert.throws(() => createClaim(invalidState, {
    clientName: "bad-profile-expiry-pc",
    profileExpiresAt: "not-a-date"
  }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /profileExpiresAt/);
    return true;
  });

  const pastState = createDefaultAdminState();
  assert.throws(() => createClaim(pastState, {
    clientName: "past-profile-expiry-pc",
    profileExpiresAt: "2000-01-01T00:00:00.000Z"
  }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /future/);
    return true;
  });

  const expiringState = createDefaultAdminState();
  const profileExpiresAt = new Date(Date.now() + 100).toISOString();
  const expiringClaim = createClaim(expiringState, {
    clientName: "expiring-profile-pc",
    profileExpiresAt
  });
  assert.equal(expiringClaim.profile.expiresAt, profileExpiresAt);
  const expiresAtMs = Date.parse(profileExpiresAt);
  await new Promise((resolve) => setTimeout(resolve, Math.max(25, expiresAtMs - Date.now() + 25)));
  assert.throws(() => redeemClaim(expiringState, { tKey: expiringClaim.token }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /profile is expired/);
    return true;
  });
  assert.equal(expiringClaim.claim.used, false);
  assert.equal(expiringClaim.claim.redeemedAt, null);

  const replayState = createDefaultAdminState();
  const replayClaim = createClaim(replayState, {
    clientName: "expired-replay-profile-pc",
    profileExpiresAt: new Date(Date.now() + 60_000).toISOString()
  });
  redeemClaim(replayState, {
    tKey: replayClaim.token,
    clientRedeemId: "expiry-replay-attempt",
    clientInstallId: "expiry-replay-install"
  });
  replayClaim.claim.profile.expiresAt = "2000-01-01T00:00:00.000Z";
  assert.throws(() => redeemClaim(replayState, {
    tKey: replayClaim.token,
    clientRedeemId: "expiry-replay-attempt",
    clientInstallId: "expiry-replay-install"
  }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /profile is expired/);
    return true;
  });
});

test("SyncKey claim expiry request fields are explicit and side-effect free on validation errors", () => {
  const explicitState = createDefaultAdminState();
  const futureExpiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const explicitClaim = createClaim(explicitState, {
    clientName: "explicit-claim-expiry-pc",
    expiresAt: futureExpiresAt,
    expiresInHours: 48
  });
  assert.equal(explicitClaim.claim.expiresAt, futureExpiresAt);

  const noExpiryState = createDefaultAdminState();
  const noExpiryClaim = createClaim(noExpiryState, {
    clientName: "no-claim-expiry-pc",
    expiresAt: null
  });
  assert.equal(noExpiryClaim.claim.expiresAt, null);

  for (const [label, input, messagePattern] of [
    ["invalidExpiresAt", { expiresAt: "not-a-date" }, /expiresAt/],
    ["pastExpiresAt", { expiresAt: "2000-01-01T00:00:00.000Z" }, /future/],
    ["emptyExpiresAt", { expiresAt: "" }, /expiresAt/],
    ["zeroExpiresInHours", { expiresInHours: 0 }, /expiresInHours/],
    ["negativeExpiresInHours", { expiresInHours: -1 }, /expiresInHours/],
    ["stringExpiresInHours", { expiresInHours: "abc" }, /expiresInHours/],
    ["objectExpiresInHours", { expiresInHours: {} }, /expiresInHours/],
    ["booleanExpiresInHours", { expiresInHours: true }, /expiresInHours/]
  ]) {
    const state = createDefaultAdminState();
    assert.throws(() => createClaim(state, {
      clientName: `${label}-pc`,
      ...input
    }), (error) => {
      assert.equal(error.code, "validation_failed");
      assert.equal(error.status, 400);
      assert.match(error.publicMessage, messagePattern);
      return true;
    });
    assert.equal(state.users.length, 0, `${label} should not create a user`);
    assert.equal(state.claims.length, 0, `${label} should not create a claim`);
  }
});

test("server admin validation errors carry explicit stable codes", () => {
  const state = createDefaultAdminState({
    S3_BUCKET: "home-sync",
    VLESS_PUBLIC_HOST: "pass.971223.xyz"
  });

  for (const action of [
    () => createClaim(state, { clientName: "bad name" }),
    () => createStorageBucket(state, { bucket: "Bad_Bucket" }),
    () => updateStorageConfig(state, { endpoint: "not-a-url" }),
    () => updateTunnelConfig(state, { publicHost: "https://bad.example.com" }),
    () => updateTunnelConfig(state, { publicPort: 70000 })
  ]) {
    assert.throws(action, (error) => {
      assert.equal(error.code, "validation_failed");
      assert.equal(error.status, 400);
      assert.equal(normalizeHttpError(error, "server_error").code, "validation_failed");
      return true;
    });
  }
});

test("server admin write APIs reject explicit invalid falsy fields without fallback side effects", () => {
  const baseEnv = {
    S3_BUCKET: "home-sync",
    VLESS_PUBLIC_HOST: "pass.971223.xyz"
  };
  const invalidWrites = [
    {
      action: (state) => updateTunnelConfig(state, { publicPort: 0 }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.tunnel, before.tunnel);
        assert.equal(after.updatedAt, before.updatedAt);
      }
    },
    {
      action: (state) => updateTunnelConfig(state, { listenPort: 0 }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.tunnel, before.tunnel);
        assert.equal(after.updatedAt, before.updatedAt);
      }
    },
    {
      action: (state) => updateStorageConfig(state, { endpoint: "" }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.storage, before.storage);
        assert.equal(after.updatedAt, before.updatedAt);
      }
    },
    {
      action: (state) => updateStorageConfig(state, { remoteName: "" }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.storage, before.storage);
        assert.equal(after.updatedAt, before.updatedAt);
      }
    },
    {
      action: (state) => updateStorageConfig(state, { prefixRoot: "" }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.storage, before.storage);
        assert.equal(after.updatedAt, before.updatedAt);
      }
    },
    {
      action: (state) => updateStorageConfig(state, { accessKeyId: "" }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.storage, before.storage);
        assert.equal(after.updatedAt, before.updatedAt);
      }
    },
    {
      action: (state) => createManagedUser(state, { clientName: "" }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.users, before.users);
        assert.deepEqual(after.claims, before.claims);
        assert.equal(after.updatedAt, before.updatedAt);
        assert.equal(after.tunnel.restartRequired, before.tunnel.restartRequired);
      }
    },
    {
      action: (state) => createManagedUser(state, { clientName: "empty-access-pc", accessKeyId: "" }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.users, before.users);
        assert.deepEqual(after.claims, before.claims);
        assert.equal(after.updatedAt, before.updatedAt);
        assert.equal(after.tunnel.restartRequired, before.tunnel.restartRequired);
      }
    },
    {
      action: (state) => createManagedUser(state, { clientName: "empty-secret-pc", secretAccessKey: "" }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.users, before.users);
        assert.deepEqual(after.claims, before.claims);
        assert.equal(after.updatedAt, before.updatedAt);
        assert.equal(after.tunnel.restartRequired, before.tunnel.restartRequired);
      }
    },
    {
      action: (state) => createClaim(state, { clientName: "" }),
      assertUnchanged: (before, after) => {
        assert.deepEqual(after.users, before.users);
        assert.deepEqual(after.claims, before.claims);
        assert.equal(after.updatedAt, before.updatedAt);
        assert.equal(after.tunnel.restartRequired, before.tunnel.restartRequired);
      }
    }
  ];

  for (const { action, assertUnchanged } of invalidWrites) {
    const state = createDefaultAdminState(baseEnv);
    const before = structuredClone(state);
    assert.throws(() => action(state), (error) => {
      assert.equal(error.code, "validation_failed");
      assert.equal(error.status, 400);
      return true;
    });
    assertUnchanged(before, state);
  }
});

test("server accepts SyncKey alias when redeeming a profile", () => {
  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://pass.971223.xyz:2025",
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  const result = createClaim(state, {
    clientName: "company-pc1"
  });

  const redeemed = redeemClaim(state, { tKey: result.token });
  assert.equal(redeemed.clientName, "company-pc1");
  assert.equal(state.claims[0].used, true);
});

test("claim creation requires confirmation for devices with compatibility warnings", () => {
  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://pass.971223.xyz:2025",
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  createClaim(state, { clientName: "company-pc1" });
  state.users[0].clientVersion = "old-client";
  state.users[0].diagnostics = {
    role: "client",
    protocols: {
      claim: 1,
      profile: 1,
      clientStatus: 1,
      heartbeat: 0
    }
  };

  assert.throws(() => createClaim(state, {
    clientName: "company-pc1"
  }), (error) => error.code === "danger_confirmation_required");

  const confirmed = createClaim(state, {
    clientName: "company-pc1",
    confirmCompatibilityWarning: true
  });
  assert.equal(confirmed.compatibility.policy.profileIssue, "warn");
  assert.equal(confirmed.compatibility.action, "diagnostics_missing");
});

test("enabling a device with compatibility warnings requires confirmation", () => {
  const state = createDefaultAdminState();
  createClaim(state, { clientName: "company-pc1" });
  const user = state.users[0];
  user.enabled = false;
  user.clientVersion = "old-client";
  user.diagnostics = {
    role: "client",
    protocols: {
      claim: 1,
      profile: 1,
      clientStatus: 1,
      heartbeat: 0
    }
  };

  assert.throws(() => setManagedUserEnabled(state, {
    userId: user.id,
    enabled: true
  }), (error) => error.code === "danger_confirmation_required");

  const enabled = setManagedUserEnabled(state, {
    userId: user.id,
    enabled: true,
    confirmCompatibilityWarning: true
  });
  assert.equal(enabled.enabled, true);
});

test("server sing-box config is generated from managed users", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  createClaim(state, { clientName: "company-pc2" });

  const config = buildSingboxServerConfig(state);
  assert.equal(config.inbounds[0].type, "vless");
  assert.equal(config.inbounds[0].listen_port, 45679);
  assert.equal(config.inbounds[0].users.length, 1);
  assert.equal(config.inbounds[0].users[0].name, "company-pc2");
  assert.equal(config.inbounds[0].tls, undefined);
});

test("marking sing-box applied requires a pending change and explicit confirmation", () => {
  const state = createDefaultAdminState();
  assert.throws(() => markSingboxApplied(state), (error) => error.code === "danger_confirmation_required");
  assert.throws(() => markSingboxApplied(state, {
    confirmMarkApplied: true
  }), (error) => error.code === "validation_failed");

  updateTunnelConfig(state, {
    publicHost: "pass.971223.xyz",
    publicPort: 45679,
    listenPort: 45679
  });
  assert.equal(state.tunnel.restartRequired, true);
  assert.throws(() => markSingboxApplied(state), (error) => error.code === "danger_confirmation_required");

  const applied = markSingboxApplied(state, {
    confirmMarkApplied: true
  });
  assert.equal(applied.restartRequired, false);
  assert.ok(applied.lastAppliedAt);
});

test("admin summary exposes runtime app version for deployment verification", () => {
  const state = createDefaultAdminState();
  state.appVersion = "0.3.0-rc.1-test";
  const summary = summarizeAdminState(state);
  assert.equal(summary.appVersion, "0.3.0-rc.1-test");
  assert.equal(summary.diagnostics.role, "server");
  assert.equal(summary.diagnostics.version, "0.3.0-rc.1-test");
  assert.equal(summary.diagnostics.protocols.profile, 1);
  assert.equal(summary.diagnostics.protocols.heartbeat, 1);
});

test("admin defaults remain positive integers after environment or state drift", () => {
  const envState = createDefaultAdminState({
    RCLONE_TRANSFERS: "1.5",
    RCLONE_STREAMS: "6",
    RCLONE_CHECKERS: "bad",
    RCLONE_RETRIES: "2.25",
    RCLONE_LOW_LEVEL_RETRIES: "12"
  });
  assert.equal(envState.defaults.transfers, 4);
  assert.equal(envState.defaults.streams, 6);
  assert.equal(envState.defaults.checkers, 8);
  assert.equal(envState.defaults.retries, 3);
  assert.equal(envState.defaults.lowLevelRetries, 12);

  const normalized = normalizeAdminState({
    defaults: {
      localProxyPort: 18082,
      transfers: 1.5,
      streams: "7",
      checkers: {},
      chunkSize: "",
      retries: "3.1",
      lowLevelRetries: "13"
    }
  });
  assert.equal(normalized.defaults.localProxyPort, 18082);
  assert.equal(normalized.defaults.transfers, 4);
  assert.equal(normalized.defaults.streams, 7);
  assert.equal(normalized.defaults.checkers, 8);
  assert.equal(normalized.defaults.chunkSize, "16M");
  assert.equal(normalized.defaults.retries, 3);
  assert.equal(normalized.defaults.lowLevelRetries, 13);
});

test("admin state normalization migrates internal S3 endpoint to configured client endpoint", () => {
  const migrated = normalizeAdminState({
    storage: {
      endpoint: "http://minio:9000",
      internalEndpoint: "http://minio:9000"
    }
  }, {
    S3_ENDPOINT: "http://minio:9000",
    S3_CLIENT_ENDPOINT: "http://n1-minio.sfsc:9000"
  });
  assert.equal(migrated.storage.endpoint, "http://n1-minio.sfsc:9000");
  assert.equal(migrated.storage.internalEndpoint, "http://minio:9000");

  const custom = normalizeAdminState({
    storage: {
      endpoint: "http://storage.example:9000",
      internalEndpoint: "http://minio:9000"
    }
  }, {
    S3_ENDPOINT: "http://minio:9000",
    S3_CLIENT_ENDPOINT: "http://n1-minio.sfsc:9000"
  });
  assert.equal(custom.storage.endpoint, "http://storage.example:9000");
  assert.equal(custom.storage.internalEndpoint, "http://minio:9000");

  const drifted = normalizeAdminState({
    storage: {
      endpoint: "http://n1-minio.sfsc:9000",
      internalEndpoint: "http://n1-minio.sfsc:9000"
    }
  }, {
    S3_ENDPOINT: "http://minio:9000",
    S3_CLIENT_ENDPOINT: "http://n1-minio.sfsc:9000"
  });
  assert.equal(drifted.storage.endpoint, "http://n1-minio.sfsc:9000");
  assert.equal(drifted.storage.internalEndpoint, "http://minio:9000");
});

test("admin state normalization migrates legacy users into device shape", () => {
  const state = normalizeAdminState({
    settings: {
      publicServerUrl: "https://sync.example"
    },
    tunnel: {
      publicHost: "pass.971223.xyz",
      publicPort: 45679
    },
    storage: {
      bucket: "home-sync",
      accessKeyId: "global-access-key",
      secretAccessKey: "global-secret-key",
      prefixRoot: "devices"
    },
    users: [{
      id: "legacy-user-1",
      clientName: "legacy-pc",
      uuid: "11111111-1111-4111-8111-111111111111",
      clientVersion: "legacy-client",
      diagnostics: {
        role: "client",
        protocols: {
          claim: 1,
          profile: 1
        }
      }
    }]
  });

  assert.equal(state.users[0].enabled, true);
  assert.equal(state.users[0].storage.bucket, "home-sync");
  assert.equal(state.users[0].storage.accessKeyId, "global-access-key");
  assert.equal(state.users[0].storage.secretAccessKey, "global-secret-key");
  assert.equal(state.users[0].storage.prefix, "devices/legacy-pc");
  assert.match(state.users[0].heartbeatSecret, /^[A-Za-z0-9_-]{32,}$/);
  assert.deepEqual(state.users[0].heartbeatAuthNonces, []);
  assert.equal(state.users[0].diagnostics, null);

  const summary = summarizeAdminState(state);
  assert.doesNotThrow(() => assertAdminStateSummaryContract(summary, "legacySummary"));
  assert.equal(summary.users[0].storage.bucket, "home-sync");
  assert.notEqual(summary.users[0].storage.secretAccessKey, "global-secret-key");
  assert.match(summary.users[0].storage.secretAccessKey, /\*/);
  assert.equal(summary.devices[0].bucket, "home-sync");
  assert.equal(summary.devices[0].prefix, "devices/legacy-pc");
  assert.equal(summary.devices[0].diagnostics, null);
  assert.equal(summary.devices[0].compatibility.action, "diagnostics_missing");
  assert.equal(summary.devices[0].compatibility.policy.profileIssue, "warn");

  const issued = createClaim(state, {
    userId: "legacy-user-1",
    confirmCompatibilityWarning: true
  });
  assert.equal(issued.claim.userId, "legacy-user-1");
  assertClaimRedeemResponseContract(issued.profile, "legacyProfile");
  assert.equal(issued.profile.clientName, "legacy-pc");
  assert.equal(issued.profile.storage.bucket, "home-sync");
  assert.equal(issued.profile.storage.prefix, "devices/legacy-pc");
  assert.equal(issued.profile.heartbeat.scheme, "sfsc-hmac-sha256-v1");
  assert.equal(issued.profile.heartbeat.secret, state.users[0].heartbeatSecret);
});

test("admin summary treats missing adminState protocol as incomplete diagnostics", () => {
  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://pass.971223.xyz:2025",
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  createClaim(state, { clientName: "company-pc1" });
  const user = state.users[0];
  user.clientVersion = "legacy-client";
  user.lastSeenAt = new Date().toISOString();
  user.diagnostics = {
    app: "singbox-folder-sync",
    role: "client",
    version: "0.3.0-rc.1",
    protocols: {
      claim: 1,
      profile: 1,
      clientStatus: 1,
      heartbeat: 1
    }
  };

  const summary = summarizeAdminState(state);
  assert.equal(summary.devices[0].diagnostics, null);
  assert.equal(summary.devices[0].compatibility.ok, false);
  assert.equal(summary.devices[0].compatibility.action, "diagnostics_missing");
  assert.equal(summary.devices[0].compatibility.policy.profileIssue, "warn");
  assert.equal(summary.devices[0].compatibility.policy.syncRun, "warn");
  assert.deepEqual(
    summary.devices[0].compatibility.issues.map((issue) => [issue.field, issue.type, issue.remote]),
    [
      ["claim", "remote_missing", null],
      ["profile", "remote_missing", null],
      ["adminState", "remote_missing", null],
      ["clientStatus", "remote_missing", null],
      ["heartbeat", "remote_missing", null]
    ]
  );
  assert.throws(() => createClaim(state, {
    userId: user.id
  }), (error) => error.code === "danger_confirmation_required");
});

test("server REALITY config follows the sb script shape", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  createClaim(state, { clientName: "company-pc3" });
  state.tunnel.protocol = "vless-reality-tcp";
  state.tunnel.security = "reality";
  state.tunnel.reality = {
    serverName: "www.microsoft.com",
    fingerprint: "chrome",
    publicKey: REALITY_PUBLIC_KEY,
    privateKey: REALITY_PRIVATE_KEY,
    shortId: REALITY_SHORT_ID
  };

  const config = buildSingboxServerConfig(state);
  assert.equal(config.inbounds[0].tls.server_name, "www.microsoft.com");
  assert.equal(config.inbounds[0].tls.reality.handshake.server, "www.microsoft.com");
  assert.equal(config.inbounds[0].tls.reality.private_key, REALITY_PRIVATE_KEY);
  assert.deepEqual(config.inbounds[0].tls.reality.short_id, [REALITY_SHORT_ID]);

  const updatedProfile = parseVlessUri(buildVlessUri(state.tunnel, state.users[0]));
  assert.equal(updatedProfile.security, "reality");
  assert.equal(updatedProfile.sni, "www.microsoft.com");
  assert.equal(updatedProfile.publicKey, REALITY_PUBLIC_KEY);
  assert.equal(updatedProfile.fingerprint, "chrome");
  assert.equal(updatedProfile.shortId, REALITY_SHORT_ID);

  state.tunnel.reality.publicKey = "SERVER_PUBLIC_KEY";
  assert.throws(() => buildSingboxServerConfig(state), (error) => error.code === "validation_failed");
});

test("admin summary masks REALITY private key without changing generated config", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  createClaim(state, { clientName: "company-pc4" });
  state.tunnel.protocol = "vless-reality-tcp";
  state.tunnel.security = "reality";
  state.tunnel.reality = {
    serverName: "www.microsoft.com",
    fingerprint: "chrome",
    publicKey: REALITY_PUBLIC_KEY,
    privateKey: REALITY_PRIVATE_KEY,
    shortId: REALITY_SHORT_ID
  };

  const summary = summarizeAdminState(state);
  assert.equal(summary.tunnel.reality.publicKey, REALITY_PUBLIC_KEY);
  assert.equal(summary.tunnel.reality.privateKey, "***");
  assert.equal(JSON.stringify(summary).includes(REALITY_PRIVATE_KEY), false);
  // The mask must not carry any plaintext fragment of the real key: leaking the
  // leading/trailing characters is a meaningful disclosure for short secrets.
  assert.equal(summary.tunnel.reality.privateKey.includes(REALITY_PRIVATE_KEY.slice(0, 3)), false);
  assert.equal(summary.tunnel.reality.privateKey.includes(REALITY_PRIVATE_KEY.slice(-3)), false);

  const config = buildSingboxServerConfig(state);
  assert.equal(config.inbounds[0].tls.reality.private_key, REALITY_PRIVATE_KEY);

  updateTunnelConfig(state, {
    protocol: "vless-reality-tcp",
    publicHost: "pass.971223.xyz",
    publicPort: 45679,
    listenPort: 45679,
    reality: {
      serverName: "www.microsoft.com",
      fingerprint: "chrome",
      publicKey: REALITY_PUBLIC_KEY,
      privateKey: summary.tunnel.reality.privateKey,
      shortId: REALITY_SHORT_ID
    }
  });
  assert.equal(state.tunnel.reality.privateKey, REALITY_PRIVATE_KEY);
});

test("admin summary masks storage secrets without changing issued profiles", () => {
  const state = createDefaultAdminState({
    S3_SECRET_ACCESS_KEY: "global-storage-secret"
  });
  const result = createClaim(state, {
    clientName: "company-pc5"
  });

  const summary = summarizeAdminState(state);
  assert.equal(JSON.stringify(summary).includes("global-storage-secret"), false);
  assert.match(summary.storage.secretAccessKey, /\*\*\*/);
  assert.match(summary.users[0].storage.secretAccessKey, /\*\*\*/);
  assert.equal(result.profile.storage.secretAccessKey, "global-storage-secret");
});

test("storage config save preserves existing secret when omitted blank or masked", () => {
  const state = createDefaultAdminState({
    S3_SECRET_ACCESS_KEY: "global-storage-secret"
  });

  updateStorageConfig(state, {
    endpoint: "http://minio.internal:9000",
    secretAccessKey: ""
  });
  assert.equal(state.storage.endpoint, "http://minio.internal:9000");
  assert.equal(state.storage.secretAccessKey, "global-storage-secret");

  const summary = summarizeAdminState(state);
  updateStorageConfig(state, {
    internalEndpoint: "http://minio.service:9000",
    secretAccessKey: summary.storage.secretAccessKey
  });
  assert.equal(state.storage.internalEndpoint, "http://minio:9000");
  assert.equal(state.storage.secretAccessKey, "global-storage-secret");

  updateStorageConfig(state, {
    secretAccessKey: "new-global-storage-secret"
  });
  assert.equal(state.storage.secretAccessKey, "new-global-storage-secret");
});

test("storage config save cannot override the deployment-controlled internal endpoint", () => {
  const state = createDefaultAdminState({
    S3_ENDPOINT: "http://minio:9000",
    S3_CLIENT_ENDPOINT: "http://n1-minio.sfsc:9000"
  });

  updateStorageConfig(state, {
    endpoint: "http://client-route.example:9000",
    internalEndpoint: "http://untrusted-internal.example:9000"
  });

  assert.equal(state.storage.endpoint, "http://client-route.example:9000");
  assert.equal(state.storage.internalEndpoint, "http://minio:9000");
});

test("admin summary claim lifecycle uses an explicit redacted allowlist", () => {
  const state = createDefaultAdminState({
    PUBLIC_SERVER_URL: "https://server.example",
    S3_SECRET_ACCESS_KEY: "global-storage-secret"
  });
  const result = createClaim(state, {
    clientName: "company-pc5"
  });
  Object.assign(state.claims[0], {
    tKey: result.token,
    tKeyUri: result.uri,
    claimCode: result.token,
    token: result.token,
    uri: result.uri,
    secretAccessKey: "global-storage-secret",
    vlessUri: result.profile.tunnel.uri
  });

  const summary = summarizeAdminState(state);
  const claim = summary.claims[0];
  assertAdminClaimSummaryContract(claim);
  assert.deepEqual(Object.keys(claim).sort(), [
    "bucketName",
    "clientName",
    "code",
    "createdAt",
    "expiresAt",
    "id",
    "profileId",
    "redeemedAt",
    "requestedRole",
    "server",
    "syncSpaceId",
    "used",
    "userId"
  ].sort());
  assert.equal(JSON.stringify(summary.claims).includes(result.token), false);
  assert.equal(JSON.stringify(summary.claims).includes(result.uri), false);
  assert.equal(JSON.stringify(summary.claims).includes("global-storage-secret"), false);
  assert.equal(JSON.stringify(summary.claims).includes("vless://"), false);
});

test("admin summary users use an explicit redacted allowlist", () => {
  const state = createDefaultAdminState({
    S3_SECRET_ACCESS_KEY: "global-storage-secret"
  });
  createClaim(state, {
    clientName: "company-pc6"
  });
  Object.assign(state.users[0], {
    heartbeatSecret: "heartbeat-secret",
    heartbeatAuthNonces: ["nonce-1"],
    tKey: "SFSC1-user-secret",
    token: "SFSC1-user-secret",
    claimCode: "ABCD-2345",
    profile: { storage: { secretAccessKey: "profile-secret" } },
    privateKey: "private-key-secret",
    secretAccessKey: "top-level-secret"
  });
  Object.assign(state.users[0].storage, {
    secretAccessKey: "user-storage-secret",
    sessionToken: "storage-session-secret",
    heartbeatSecret: "nested-heartbeat-secret"
  });

  const summary = summarizeAdminState(state);
  const user = summary.users[0];
  assertAdminUserSummaryContract(user);
  assert.deepEqual(Object.keys(user).sort(), [
    "clientName",
    "createdAt",
    "enabled",
    "id",
    "storage",
    "updatedAt",
    "uuid",
    "vlessUriAvailable",
    "vlessUriRevealPath"
  ].sort());
  assert.deepEqual(Object.keys(user.storage).sort(), [
    "accessKeyId",
    "bucket",
    "prefix",
    "secretAccessKey"
  ].sort());
  const userJson = JSON.stringify(user);
  for (const leaked of [
    "heartbeat-secret",
    "nonce-1",
    "SFSC1-user-secret",
    "profile-secret",
    "private-key-secret",
    "top-level-secret",
    "user-storage-secret",
    "storage-session-secret",
    "nested-heartbeat-secret"
  ]) {
    assert.equal(userJson.includes(leaked), false);
  }
});

test("VLESS autofill generates REALITY keys and short id", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });

  autoFillTunnelConfig(state, {
    protocol: "vless-reality-tcp",
    forceRealityKeys: true,
    serverName: "www.microsoft.com"
  });

  assert.equal(state.tunnel.security, "reality");
  assert.equal(state.tunnel.reality.serverName, "www.microsoft.com");
  assert.match(state.tunnel.reality.privateKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(state.tunnel.reality.publicKey, /^[A-Za-z0-9_-]{43}$/);
  assert.match(state.tunnel.reality.shortId, /^[a-f0-9]{16}$/);
});

test("claim creation can select a managed bucket without a separate user step", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679",
    S3_BUCKET: "home-sync"
  });
  createStorageBucket(state, { bucket: "photos" });

  const result = createClaim(state, {
    clientName: "iphone",
    bucketName: "photos"
  });

  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].clientName, "iphone");
  assert.equal(result.profile.storage.bucket, "photos");
  assert.equal(result.profile.storage.prefix, "devices/iphone");
});

test("claim creation updates an existing device bucket when a bucket is explicitly selected", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679",
    S3_BUCKET: "home-sync"
  });
  createStorageBucket(state, { bucket: "photos" });
  const first = createClaim(state, {
    clientName: "iphone",
    bucketName: "home-sync"
  });
  const second = createClaim(state, {
    clientName: "iphone",
    bucketName: "photos"
  });

  assert.equal(state.users.length, 1);
  assert.equal(state.users[0].storage.bucket, "photos");
  assert.equal(first.profile.storage.bucket, "home-sync");
  assert.equal(second.profile.storage.bucket, "photos");
  assert.equal(second.claim.bucketName, "photos");
  assert.equal(summarizeAdminState(state).devices[0].bucket, "photos");
});

test("claim creation by user id also updates the device bucket when selected", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679",
    S3_BUCKET: "home-sync"
  });
  createStorageBucket(state, { bucket: "photos" });
  createClaim(state, {
    clientName: "iphone",
    bucketName: "home-sync"
  });

  const result = createClaim(state, {
    userId: state.users[0].id,
    bucketName: "photos"
  });

  assert.equal(state.users[0].storage.bucket, "photos");
  assert.equal(result.profile.storage.bucket, "photos");
  assert.equal(result.claim.bucketName, "photos");
});

test("disabled storage buckets cannot be selected for new SyncKeys", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679",
    S3_BUCKET: "home-sync"
  });
  createStorageBucket(state, { bucket: "archive" });

  const bucket = setStorageBucketEnabled(state, {
    bucket: "archive",
    enabled: false
  });

  assert.ok(bucket.disabledAt);
  assert.throws(() => createClaim(state, {
    clientName: "ipad",
    bucketName: "archive"
  }), (error) => {
    assert.equal(error.code, "bucket_disabled");
    assert.equal(error.status, 409);
    return true;
  });
});

test("disabling the last active storage bucket is blocked", () => {
  const state = createDefaultAdminState({
    S3_BUCKET: "home-sync"
  });

  assert.throws(() => setStorageBucketEnabled(state, {
    bucket: "home-sync",
    enabled: false
  }), (error) => {
    assert.equal(error.code, "last_active_bucket_disable_blocked");
    assert.equal(error.status, 409);
    assert.equal(normalizeHttpError(error, "server_error").code, "last_active_bucket_disable_blocked");
    return true;
  });
});

test("disabling the default bucket switches to the next active bucket", () => {
  const state = createDefaultAdminState({
    S3_BUCKET: "home-sync"
  });
  createStorageBucket(state, { bucket: "photos" });

  const bucket = setStorageBucketEnabled(state, {
    bucket: "home-sync",
    enabled: false
  });

  assert.ok(bucket.disabledAt);
  assert.equal(state.storage.bucket, "photos");
  const result = createClaim(state, { clientName: "camera" });
  assert.equal(result.profile.storage.bucket, "photos");
});

test("removing an active storage bucket requires another active bucket", () => {
  const state = createDefaultAdminState({
    S3_BUCKET: "home-sync"
  });
  createStorageBucket(state, { bucket: "archive" });
  setStorageBucketEnabled(state, {
    bucket: "archive",
    enabled: false
  });

  assert.throws(() => removeStorageBucket(state, { bucket: "home-sync" }), (error) => {
    assert.equal(error.code, "last_active_bucket_disable_blocked");
    assert.equal(error.status, 409);
    return true;
  });
  assert.equal(state.storage.buckets.some((bucket) => bucket.name === "home-sync"), true);
});

test("removing a storage bucket switches the default bucket", () => {
  const state = createDefaultAdminState({
    S3_BUCKET: "home-sync"
  });
  createStorageBucket(state, { bucket: "photos" });
  state.storage.bucket = "photos";

  const storage = removeStorageBucket(state, { bucket: "photos" });

  assert.equal(storage.bucket, "home-sync");
  assert.equal(storage.buckets.some((bucket) => bucket.name === "photos"), false);
});

test("storage bucket lookup failures use explicit stable codes", () => {
  const state = createDefaultAdminState({
    S3_BUCKET: "home-sync"
  });

  assert.throws(() => removeStorageBucket(state, { bucket: "missing-bucket" }), (error) => {
    assert.equal(error.code, "bucket_not_found");
    assert.equal(error.status, 404);
    return true;
  });

  assert.throws(() => removeStorageBucket(state, { bucket: "home-sync" }), (error) => {
    assert.equal(error.code, "last_bucket_delete_blocked");
    assert.equal(error.status, 409);
    return true;
  });
});

test("removing a bucket migrates devices bound to that bucket", () => {
  const state = createDefaultAdminState({
    S3_BUCKET: "home-sync"
  });
  createStorageBucket(state, { bucket: "photos" });
  createClaim(state, {
    clientName: "camera",
    bucketName: "photos"
  });

  removeStorageBucket(state, { bucket: "photos" });

  assert.equal(state.users[0].storage.bucket, "home-sync");
  assert.equal(summarizeAdminState(state).devices[0].bucket, "home-sync");
  const result = createClaim(state, { clientName: "camera" });
  assert.equal(result.profile.storage.bucket, "home-sync");
});

test("disabled devices cannot receive new SyncKeys or heartbeat", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  const issued = createClaim(state, { clientName: "company-pc1" });
  state.users[0].enabled = false;

  assert.equal(
    normalizeHttpError(new Error("Device is disabled"), "server_error").code,
    "device_disabled"
  );
  for (const action of [
    () => createClaim(state, { clientName: "company-pc1" }),
    () => createClaim(state, { userId: state.users[0].id }),
    () => recordDeviceHeartbeat(state, { clientName: "company-pc1" })
  ]) {
    assert.throws(action, (error) => error.code === "device_disabled" && error.status === 409);
  }
  assert.throws(() => redeemClaim(state, { tKey: issued.token }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /device is disabled/);
    return true;
  });
  assert.equal(issued.claim.used, false);
  assert.equal(issued.claim.redeemedAt, null);
});

test("device enable disable and delete update config and admin summary", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  createClaim(state, { clientName: "company-pc1" });
  const userId = state.users[0].id;

  setManagedUserEnabled(state, { userId, enabled: false });
  assert.equal(state.users[0].enabled, false);
  assert.equal(state.tunnel.restartRequired, true);
  assert.equal(buildSingboxServerConfig(state).inbounds[0].users.length, 0);
  assert.equal(summarizeAdminState(state).devices[0].enabled, false);
  assert.equal(summarizeAdminState(state).tunnel.sampleUri, null);

  setManagedUserEnabled(state, { userId, enabled: true });
  assert.equal(state.users[0].enabled, true);
  assert.equal(buildSingboxServerConfig(state).inbounds[0].users.length, 1);
  const enabledSummary = summarizeAdminState(state);
  assert.equal(enabledSummary.tunnel.sampleUri, null);
  assert.equal(enabledSummary.tunnel.sampleUriAvailable, true);
  assert.match(enabledSummary.tunnel.sampleUriRevealPath, /^\/api\/admin\/devices\/[^/]+\/vless-uri$/);

  deleteManagedUser(state, { userId });
  assert.ok(state.users[0].deletedAt);
  assert.equal(buildSingboxServerConfig(state).inbounds[0].users.length, 0);
  assert.equal(summarizeAdminState(state).devices.length, 0);
  assert.throws(() => recordDeviceHeartbeat(state, {
    clientName: "company-pc1"
  }), /device_not_found/);
});

test("deleted devices are not reused for SyncKeys or heartbeat", () => {
  const state = createDefaultAdminState();
  const staleClaim = createClaim(state, { clientName: "company-pc1" });
  const deletedUserId = state.users[0].id;
  state.users[0].deletedAt = new Date().toISOString();

  const result = createClaim(state, { clientName: "company-pc1" });

  assert.notEqual(result.claim.userId, deletedUserId);
  assert.equal(state.users.length, 2);
  assert.throws(() => createClaim(state, {
    userId: deletedUserId
  }), (error) => {
    assert.equal(error.code, "user_not_found");
    assert.equal(error.status, 404);
    assert.equal(normalizeHttpError(error, "server_error").code, "user_not_found");
    return true;
  });
  assert.doesNotThrow(() => recordDeviceHeartbeat(state, signHeartbeatForState(state, {
    clientName: "company-pc1"
  })));
  assert.throws(() => redeemClaim(state, { tKey: staleClaim.token }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /device is no longer available/);
    return true;
  });
  assert.equal(staleClaim.claim.used, false);
});

test("stale SyncKeys cannot redeem after their storage bucket changes state", () => {
  const disabledState = createDefaultAdminState();
  createStorageBucket(disabledState, { bucket: "archive" });
  const disabledBucketClaim = createClaim(disabledState, {
    clientName: "archive-pc",
    bucketName: "archive"
  });
  setStorageBucketEnabled(disabledState, {
    bucket: "archive",
    enabled: false
  });
  assert.throws(() => redeemClaim(disabledState, { tKey: disabledBucketClaim.token }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /storage bucket is disabled/);
    return true;
  });
  assert.equal(disabledBucketClaim.claim.used, false);
  assert.equal(disabledBucketClaim.claim.redeemedAt, null);

  const removedState = createDefaultAdminState();
  createStorageBucket(removedState, { bucket: "photos" });
  const removedBucketClaim = createClaim(removedState, {
    clientName: "photo-pc",
    bucketName: "photos"
  });
  removeStorageBucket(removedState, { bucket: "photos" });
  assert.throws(() => redeemClaim(removedState, { tKey: removedBucketClaim.token }), (error) => {
    assert.equal(error.code, "validation_failed");
    assert.equal(error.status, 400);
    assert.match(error.publicMessage, /storage bucket is no longer available/);
    return true;
  });
  assert.equal(removedBucketClaim.claim.used, false);
  assert.equal(removedBucketClaim.claim.redeemedAt, null);
});

test("device heartbeat rejects replayed auth nonce", () => {
  const state = createDefaultAdminState();
  createClaim(state, { clientName: "company-pc1" });
  const heartbeat = signHeartbeatForState(state, {
    clientName: "company-pc1",
    clientVersion: "0.3.0-rc.1"
  });

  recordDeviceHeartbeat(state, heartbeat);
  assert.throws(() => recordDeviceHeartbeat(state, heartbeat), (error) => {
    assert.equal(error.code, "heartbeat_auth_invalid");
    assert.equal(error.status, 401);
    return true;
  });
  assert.equal(state.users[0].heartbeatAuthNonces.length, 1);
  assert.equal(summarizeAdminState(state).users[0].heartbeatAuthNonces, undefined);
});

test("device heartbeat nonce window rejects saturation instead of evicting live nonces", () => {
  const state = createDefaultAdminState();
  createClaim(state, { clientName: "company-pc1" });
  const user = state.users[0];

  // Fill the window with distinct in-window nonces, then confirm the first one is
  // still refused as a replay. Evicting to make room would have accepted it.
  const first = signHeartbeatForState(state, { clientName: "company-pc1" });
  recordDeviceHeartbeat(state, first);
  const limit = 512;
  for (let i = user.heartbeatAuthNonces.length; i < limit; i += 1) {
    recordDeviceHeartbeat(state, signHeartbeatForState(state, { clientName: "company-pc1" }));
  }
  // A cap that evicts instead of rejecting never reaches the limit, so this also
  // pins that no still-valid nonce was dropped along the way.
  assert.equal(user.heartbeatAuthNonces.length, limit);

  assert.throws(() => recordDeviceHeartbeat(state, signHeartbeatForState(state, { clientName: "company-pc1" })), (error) => {
    assert.equal(error.code, "heartbeat_auth_invalid");
    assert.equal(error.status, 401);
    assert.match(error.publicMessage, /saturated/);
    return true;
  });
  assert.throws(() => recordDeviceHeartbeat(state, first), (error) => {
    assert.equal(error.code, "heartbeat_auth_invalid");
    assert.match(error.publicMessage, /already used/);
    return true;
  });
  assert.equal(user.heartbeatAuthNonces.length, limit);

  // Once the window ages out, pruning frees the slots again.
  user.heartbeatAuthNonces = user.heartbeatAuthNonces.map((item) => ({
    ...item,
    timestamp: "2026-05-01T00:00:00.000Z",
    seenAt: "2026-05-01T00:00:00.000Z"
  }));
  recordDeviceHeartbeat(state, signHeartbeatForState(state, { clientName: "company-pc1" }));
  assert.equal(user.heartbeatAuthNonces.length, 1);
});

test("device heartbeat appears as an online device in the admin summary", () => {
  const state = createDefaultAdminState({
    VLESS_PUBLIC_HOST: "pass.971223.xyz",
    VLESS_PORT: "45679"
  });
  createClaim(state, { clientName: "company-pc1" });

  recordDeviceHeartbeat(state, signHeartbeatForState(state, {
    clientName: "company-pc1",
    clientVersion: "0.3.0-rc.1",
    diagnostics: buildRuntimeDiagnostics({
      role: "client",
      version: "0.3.0-rc.1",
      buildId: "client-build-1"
    }),
    remoteAddress: "192.168.1.23",
    sync: {
      syncState: "syncing",
      bytesPerSecond: 6250000,
      speedMbps: 50,
      progressPercent: 42.5,
      currentFile: "projects/current.iso",
      conflicts: {
        count: 1,
        files: ["projects/conflict.txt"]
      },
      scheduler: {
        enabled: true,
        intervalMs: 15000,
        nextRun: "2026-07-03T10:30:00.000Z",
        jobs: [{
          id: "job-1",
          name: "folder-sync",
          schedule: { mode: "interval", intervalMinutes: 30 },
          scheduleText: "Every 30 minutes",
          nextRun: "2026-07-03T10:30:00.000Z"
        }]
      },
      currentJob: {
        name: "company-pc1-sync",
        direction: "bidirectional",
        bucketName: "home-sync",
        remotePrefix: "devices/company-pc1"
      },
      lastRun: {
        id: "sync-1",
        status: "success",
        trigger: "scheduler",
        job: {
          name: "company-pc1-sync",
          direction: "bidirectional",
          bucketName: "home-sync",
          remotePrefix: "devices/company-pc1"
        },
        startedAt: "2026-07-03T10:00:00.000Z",
        finishedAt: "2026-07-03T10:05:00.000Z",
        progressPercent: 100,
        transferredSizeText: "1 GiB / 1 GiB",
        rawSpeed: "8 MiB/s",
        speedMbps: 67.11,
        conflicts: {
          count: 1,
          files: ["projects/conflict.txt"]
        }
      }
    }
  }));

  const summary = summarizeAdminState(state);
  assert.equal(summary.devices.length, 1);
  assertServerDeviceSummaryContract(summary.devices[0], "summary.devices[0]");
  assert.equal(summary.devices[0].online, true);
  assert.equal(summary.devices[0].bucket, "home-sync");
  assert.equal(summary.devices[0].clientVersion, "0.3.0-rc.1");
  assert.equal(summary.devices[0].diagnostics.role, "client");
  assert.equal(summary.devices[0].diagnostics.version, "0.3.0-rc.1");
  assert.equal(summary.devices[0].diagnostics.buildId, "client-build-1");
  assert.equal(summary.devices[0].diagnostics.protocols.clientStatus, 1);
  assert.equal(summary.devices[0].compatibility.ok, true);
  assert.equal(summary.devices[0].compatibility.status, "compatible");
  assert.equal(summary.devices[0].compatibility.policy.heartbeat, "allow");
  assert.equal(summary.devices[0].compatibility.policy.profileIssue, "allow");
  assert.equal(summary.devices[0].lastRemoteAddress, "192.168.1.23");
  assert.equal(summary.devices[0].sync.state, "syncing");
  assert.equal(summary.devices[0].sync.speedMbps, 50);
  assert.equal(summary.devices[0].sync.progressPercent, 42.5);
  assert.equal(summary.devices[0].sync.currentFile, "projects/current.iso");
  assert.equal(summary.devices[0].sync.currentJob.name, "company-pc1-sync");
  assert.equal(summary.devices[0].sync.lastRun.status, "success");
  assert.equal(summary.devices[0].sync.lastRun.trigger, "scheduler");
  assert.equal(summary.devices[0].sync.lastRun.progressPercent, 100);
  assert.equal(summary.devices[0].sync.lastRun.rawSpeed, "8 MiB/s");
  assert.equal(summary.devices[0].sync.lastRun.speedMbps, 67.11);
  assert.equal(summary.devices[0].sync.conflicts.count, 1);
  assert.equal(summary.devices[0].sync.lastRun.conflicts.count, 1);
  assert.deepEqual(summary.devices[0].sync.lastRun.conflicts.files, ["projects/conflict.txt"]);
  assert.equal(summary.devices[0].sync.scheduler.nextRun, "2026-07-03T10:30:00.000Z");
  assert.deepEqual(summary.devices[0].sync.scheduler.jobs[0].schedule, { mode: "interval", intervalMinutes: 30 });
  assert.equal(summary.devices[0].sync.scheduler.jobs[0].scheduleText, "Every 30 minutes");
});

test("device heartbeat without diagnostics clears stale compatibility", () => {
  const state = createDefaultAdminState();
  createClaim(state, { clientName: "diagnostics-pc" });

  recordDeviceHeartbeat(state, signHeartbeatForState(state, {
    clientName: "diagnostics-pc",
    clientVersion: "0.3.0-rc.1",
    diagnostics: buildRuntimeDiagnostics({
      role: "client",
      version: "0.3.0-rc.1"
    })
  }));
  assert.equal(summarizeAdminState(state).devices[0].compatibility.ok, true);
  assert.equal(state.users[0].diagnostics.role, "client");

  recordDeviceHeartbeat(state, signHeartbeatForState(state, {
    clientName: "diagnostics-pc",
    clientVersion: "0.1.1"
  }));

  const summary = summarizeAdminState(state);
  assert.equal(state.users[0].diagnostics, null);
  assert.equal(summary.devices[0].diagnostics, null);
  assert.equal(summary.devices[0].clientVersion, "0.1.1");
  assert.equal(summary.devices[0].compatibility.ok, false);
  assert.equal(summary.devices[0].compatibility.action, "diagnostics_missing");
  assert.equal(summary.devices[0].compatibility.policy.profileIssue, "warn");
  assert.equal(summary.devices[0].compatibility.policy.syncRun, "warn");
});

test("device heartbeat treats malformed diagnostics as missing", () => {
  const state = createDefaultAdminState();
  createClaim(state, { clientName: "malformed-diagnostics-pc" });
  const wrongRole = {
    ...buildRuntimeDiagnostics({ role: "client", version: "0.3.0-rc.1" }),
    role: "server"
  };

  recordDeviceHeartbeat(state, signHeartbeatForState(state, {
    clientName: "malformed-diagnostics-pc",
    clientVersion: "0.3.0-rc.1",
    diagnostics: wrongRole
  }));

  const summary = summarizeAdminState(state);
  assert.equal(state.users[0].diagnostics, null);
  assert.equal(summary.devices[0].diagnostics, null);
  assert.equal(summary.devices[0].compatibility.ok, false);
  assert.equal(summary.devices[0].compatibility.action, "diagnostics_missing");
  assert.equal(summary.devices[0].compatibility.policy.syncRun, "warn");
  assert.equal(summary.devices[0].compatibility.remoteRole, "client");
});

test("admin summary normalizes legacy device sync snapshots", () => {
  const state = createDefaultAdminState();
  createClaim(state, { clientName: "legacy-pc" });
  const user = state.users[0];
  user.lastSeenAt = new Date().toISOString();
  user.sync = {
    state: "syncing",
    speedMbps: 12.5,
    progressPercent: 45
  };

  const summary = summarizeAdminState(state);
  assert.equal(summary.devices.length, 1);
  assertServerDeviceSummaryContract(summary.devices[0], "summary.devices[0]");
  assert.equal(summary.devices[0].sync.state, "syncing");
  assert.equal(summary.devices[0].sync.speedMbps, 12.5);
  assert.equal(summary.devices[0].sync.progressPercent, 45);
  assert.equal(summary.devices[0].sync.currentFile, "");
  assert.equal(summary.devices[0].sync.conflicts.count, 0);
  assert.deepEqual(summary.devices[0].sync.conflicts.files, []);
  assert.equal(summary.devices[0].sync.scheduler, null);
});

test("device heartbeat tolerates invalid sync path fields", () => {
  const state = createDefaultAdminState();
  createClaim(state, { clientName: "company-pc1" });

  recordDeviceHeartbeat(state, signHeartbeatForState(state, {
    clientName: "company-pc1",
    sync: {
      syncState: "syncing",
      progressPercent: 150,
      currentJob: {
        name: "dirty-sync",
        direction: "upload",
        remotePrefix: "../bad"
      },
      lastRun: {
        id: "sync-dirty",
        status: "success",
        job: {
          name: "dirty-sync",
          direction: "upload",
          remotePrefix: "C:\\bad"
        }
      }
    }
  }));

  const summary = summarizeAdminState(state);
  assert.equal(summary.devices[0].sync.state, "syncing");
  assert.equal(summary.devices[0].sync.progressPercent, 100);
  assert.equal(summary.devices[0].sync.currentJob.remotePrefix, "");
  assert.equal(summary.devices[0].sync.lastRun.job.remotePrefix, "");
});

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

async function createFakeClientPackage(packageRoot) {
  const appRoot = join(packageRoot, "resources", "app");
  const binRoot = join(packageRoot, "resources", "bin", "win32");
  await mkdir(join(appRoot, "client", "electron"), { recursive: true });
  await mkdir(join(appRoot, "client", "src"), { recursive: true });
  await mkdir(join(appRoot, "client", "public"), { recursive: true });
  await mkdir(join(appRoot, "src", "core"), { recursive: true });
  await mkdir(join(appRoot, "docs"), { recursive: true });
  await mkdir(binRoot, { recursive: true });

  const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  await writeFile(join(packageRoot, "Syncraft.exe"), "exe", "utf8");
  await writeFile(join(appRoot, "package.json"), JSON.stringify({
    name: "syncraft-desktop",
    version: rootPackage.version,
    type: "module",
    main: "client/electron/main.cjs"
  }), "utf8");

  await writeFile(join(appRoot, "client", "electron", "main.cjs"), `
const { BrowserWindow, dialog, ipcMain } = require("electron");
const path = require("node:path");
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload: path.join(__dirname, "preload.cjs")
  }
});
ipcMain.handle("sfsc:pick-folder", async () => dialog.showOpenDialog({
  properties: ["openDirectory", "createDirectory"]
}));
`, "utf8");
  await writeFile(join(appRoot, "client", "electron", "preload.cjs"), `
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("sfscDesktop", {
  pickFolder: () => ipcRenderer.invoke("sfsc:pick-folder")
});
`, "utf8");

  await writeFile(join(appRoot, "client", "src", "clientServer.js"), `
if (req.method === "GET" && url.pathname === "/api/health") {}
http.get(\`\${clientUrl()}api/health\`);
function isSfscClientHealth(body) {
  const payload = JSON.parse(body);
  return payload?.mode === "client-exe-runtime" && payload?.diagnostics?.role === "client";
}
`, "utf8");
  await writeFile(join(appRoot, "client", "src", "launcher.cjs"), `
http.get(\`\${url}api/health\`);
function isSfscClientHealth(body) {
  const payload = JSON.parse(body);
  return payload?.mode === "client-exe-runtime" && payload?.diagnostics?.role === "client";
}
`, "utf8");
  await writeFile(join(appRoot, "client", "src", "Launcher.cs"), `
WebRequest.Create(url + "api/health");
bool IsSfscClientHealth(string body) {
  return HasJsonString(body, "mode", "client-exe-runtime") && HasJsonString(body, "role", "client");
}
`, "utf8");
  await writeFile(join(appRoot, "client", "src", "paths.js"), fakeClientPathsSource(), "utf8");
  await writeFile(join(appRoot, "client", "src", "store.js"), fakeClientStoreSource(), "utf8");

  for (const path of [
    join(appRoot, "client", "src", "diagnosticBundle.js"),
    join(appRoot, "client", "src", "processRunner.js"),
    join(appRoot, "client", "src", "rcloneStats.js"),
    join(appRoot, "client", "src", "profileImport.js"),
    join(appRoot, "client", "public", "index.html"),
    join(appRoot, "client", "public", "app.js"),
    join(appRoot, "client", "public", "styles.css"),
    join(appRoot, "src", "core", "index.js"),
    join(appRoot, "docs", "INTERFACE_CONTRACT.md"),
    join(appRoot, "docs", "API_MATRIX.md"),
    join(appRoot, "docs", "DEPLOYMENT_AND_MIGRATION_GUIDE.md"),
    join(appRoot, "docs", "INTERNAL_TRIAL_CHECKLIST.md"),
    join(appRoot, "docs", "PILOT_RUNBOOK.md"),
    join(appRoot, "docs", "PILOT_ACCEPTANCE_CRITERIA.md"),
    join(appRoot, "docs", "PILOT_SUPPORT_GUIDE.md"),
    join(binRoot, "binaries.lock.json"),
    join(binRoot, "sing-box.exe"),
    join(binRoot, "rclone.exe")
  ]) {
    await writeFile(path, "ok", "utf8");
  }

  await writeFakePackageBinaryLock(binRoot);
  await writeFakeReleaseManifest(packageRoot, rootPackage.version);
}

async function createFakePortableClientPackage(packageRoot) {
  const appRoot = join(packageRoot, "app");
  const docsRoot = join(packageRoot, "resources", "app", "docs");
  const binRoot = join(packageRoot, "resources", "bin", "win32");
  await mkdir(join(appRoot, "client", "src"), { recursive: true });
  await mkdir(join(appRoot, "client", "public"), { recursive: true });
  await mkdir(join(appRoot, "src", "core"), { recursive: true });
  await mkdir(join(packageRoot, "runtime"), { recursive: true });
  await mkdir(docsRoot, { recursive: true });
  await mkdir(binRoot, { recursive: true });

  const rootPackage = JSON.parse(await readFile(join(projectRoot, "package.json"), "utf8"));
  await writeFile(join(packageRoot, "Syncraft.exe"), "exe", "utf8");
  await writeFile(join(packageRoot, "runtime", "node.exe"), "node", "utf8");
  await writeFile(join(appRoot, "package.json"), JSON.stringify({
    version: rootPackage.version,
    type: "module"
  }), "utf8");

  await writeFile(join(appRoot, "client", "src", "clientServer.js"), `
if (req.method === "GET" && url.pathname === "/api/health") {}
http.get(\`\${clientUrl()}api/health\`);
function isSfscClientHealth(body) {
  const payload = JSON.parse(body);
  return payload?.mode === "client-exe-runtime" && payload?.diagnostics?.role === "client";
}
`, "utf8");
  await writeFile(join(appRoot, "client", "src", "launcher.cjs"), `
http.get(\`\${url}api/health\`);
function isSfscClientHealth(body) {
  const payload = JSON.parse(body);
  return payload?.mode === "client-exe-runtime" && payload?.diagnostics?.role === "client";
}
`, "utf8");
  await writeFile(join(appRoot, "client", "src", "Launcher.cs"), `
WebRequest.Create(url + "api/health");
bool IsSfscClientHealth(string body) {
  return HasJsonString(body, "mode", "client-exe-runtime") && HasJsonString(body, "role", "client");
}
`, "utf8");
  await writeFile(join(appRoot, "client", "src", "paths.js"), fakeClientPathsSource(), "utf8");
  await writeFile(join(appRoot, "client", "src", "store.js"), fakeClientStoreSource(), "utf8");

  for (const path of [
    join(appRoot, "client", "src", "diagnosticBundle.js"),
    join(appRoot, "client", "src", "processRunner.js"),
    join(appRoot, "client", "src", "rcloneStats.js"),
    join(appRoot, "client", "src", "profileImport.js"),
    join(appRoot, "client", "public", "index.html"),
    join(appRoot, "client", "public", "app.js"),
    join(appRoot, "client", "public", "styles.css"),
    join(appRoot, "src", "core", "index.js"),
    join(docsRoot, "INTERFACE_CONTRACT.md"),
    join(docsRoot, "API_MATRIX.md"),
    join(docsRoot, "DEPLOYMENT_AND_MIGRATION_GUIDE.md"),
    join(docsRoot, "INTERNAL_TRIAL_CHECKLIST.md"),
    join(docsRoot, "PILOT_RUNBOOK.md"),
    join(docsRoot, "PILOT_ACCEPTANCE_CRITERIA.md"),
    join(docsRoot, "PILOT_SUPPORT_GUIDE.md"),
    join(binRoot, "binaries.lock.json"),
    join(binRoot, "sing-box.exe"),
    join(binRoot, "rclone.exe")
  ]) {
    await writeFile(path, "ok", "utf8");
  }

  await writeFakePackageBinaryLock(binRoot);
  await writeFakeReleaseManifest(packageRoot, rootPackage.version, {}, { packageName: "SyncraftClient" });
}

function fakeClientPathsSource() {
  return `
const configuredDataRoot = process.env.SFSC_CLIENT_DATA_ROOT || process.env.SFSC_DATA_ROOT;
const fallback = process.env.LOCALAPPDATA + "\\\\Syncraft\\\\data";
async function ensureWritableDataRoot() {}
function applyDataRoot() {}
`;
}

function fakeClientStoreSource() {
  return `
async function protectSecretVaultFile() {
  await execFileAsync("icacls.exe", []);
}
async function inspectSecretVaultProtection() {}
const status = { protected: protection.protected };
`;
}

async function writeFakePackageBinaryLock(binRoot) {
  const singBox = await readFile(join(binRoot, "sing-box.exe"));
  const rclone = await readFile(join(binRoot, "rclone.exe"));
  await writeFile(join(binRoot, "binaries.lock.json"), JSON.stringify(binaryLockFixture({
    singBoxSha256: createHash("sha256").update(singBox).digest("hex"),
    rcloneSha256: createHash("sha256").update(rclone).digest("hex")
  }), null, 2), "utf8");
}

async function writeFakeReleaseManifest(packageRoot, version, hashOverrides = {}, overrides = {}) {
  const packageName = overrides.packageName || "SyncraftDesktop";
  const sourceTreeHash = overrides.sourceTreeHash || FAKE_SOURCE_TREE_HASH;
  const buildId = overrides.buildId || `sfsc-${sourceTreeHash.slice(0, 12)}`;
  const manifestFiles = packageName === "SyncraftClient" ? [
    "Syncraft.exe",
    "app/package.json",
    "app/client/src/clientServer.js",
    "app/client/src/paths.js",
    "app/client/src/store.js",
    "app/client/src/diagnosticBundle.js",
    "app/client/src/processRunner.js",
    "app/client/src/rcloneStats.js",
    "app/client/src/profileImport.js",
    "app/client/src/launcher.cjs",
    "app/client/src/Launcher.cs",
    "app/client/public/index.html",
    "app/client/public/app.js",
    "app/client/public/styles.css",
    "app/src/core/index.js",
    "resources/app/docs/INTERFACE_CONTRACT.md",
    "resources/app/docs/API_MATRIX.md",
    "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md",
    "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md",
    "resources/app/docs/PILOT_RUNBOOK.md",
    "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "resources/app/docs/PILOT_SUPPORT_GUIDE.md",
    "resources/bin/win32/binaries.lock.json",
    "resources/bin/win32/sing-box.exe",
    "resources/bin/win32/rclone.exe"
  ] : [
    "Syncraft.exe",
    "resources/app/package.json",
    "resources/app/client/electron/main.cjs",
    "resources/app/client/electron/preload.cjs",
    "resources/app/client/src/clientServer.js",
    "resources/app/client/src/paths.js",
    "resources/app/client/src/store.js",
    "resources/app/client/src/diagnosticBundle.js",
    "resources/app/client/src/processRunner.js",
    "resources/app/client/src/rcloneStats.js",
    "resources/app/client/src/profileImport.js",
    "resources/app/client/src/launcher.cjs",
    "resources/app/client/src/Launcher.cs",
    "resources/app/client/public/index.html",
    "resources/app/client/public/app.js",
    "resources/app/client/public/styles.css",
    "resources/app/src/core/index.js",
    "resources/app/docs/INTERFACE_CONTRACT.md",
    "resources/app/docs/API_MATRIX.md",
    "resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md",
    "resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md",
    "resources/app/docs/PILOT_RUNBOOK.md",
    "resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "resources/app/docs/PILOT_SUPPORT_GUIDE.md",
    "resources/bin/win32/binaries.lock.json",
    "resources/bin/win32/sing-box.exe",
    "resources/bin/win32/rclone.exe"
  ];
  const files = [];
  for (const name of manifestFiles) {
    const data = await readFile(join(packageRoot, ...name.split("/")));
    files.push({
      name,
      size: data.length,
      sha256: hashOverrides[name] || createHash("sha256").update(data).digest("hex")
    });
  }
  await writeFile(join(packageRoot, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    package: packageName,
    version,
    builtAt: overrides.builtAt || "2026-07-04T00:00:00.000Z",
    sourceTreeHash,
    buildId,
    sourceFingerprint: buildFakeSourceFingerprint(sourceTreeHash, buildId),
    files: [...files, ...(overrides.extraFiles || [])]
  }), "utf8");
}

function fakeClientZipContent(packageName, options = {}) {
  const entries = packageName === "SyncraftClient" ? [
    `${packageName}/Syncraft.exe`,
    `${packageName}/release-manifest.json`,
    `${packageName}/app/package.json`,
    `${packageName}/app/client/src/clientServer.js`,
    `${packageName}/app/client/src/paths.js`,
    `${packageName}/app/client/src/store.js`,
    `${packageName}/app/client/src/diagnosticBundle.js`,
    `${packageName}/app/client/src/processRunner.js`,
    `${packageName}/app/client/src/rcloneStats.js`,
    `${packageName}/app/client/src/profileImport.js`,
    `${packageName}/app/client/src/launcher.cjs`,
    `${packageName}/app/client/src/Launcher.cs`,
    `${packageName}/app/client/public/index.html`,
    `${packageName}/app/client/public/app.js`,
    `${packageName}/app/client/public/styles.css`,
    `${packageName}/app/src/core/index.js`,
    `${packageName}/runtime/node.exe`,
    `${packageName}/resources/app/docs/INTERFACE_CONTRACT.md`,
    `${packageName}/resources/app/docs/API_MATRIX.md`,
    `${packageName}/resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md`,
    `${packageName}/resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md`,
    `${packageName}/resources/app/docs/PILOT_RUNBOOK.md`,
    `${packageName}/resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md`,
    `${packageName}/resources/app/docs/PILOT_SUPPORT_GUIDE.md`,
    `${packageName}/resources/bin/win32/binaries.lock.json`,
    `${packageName}/resources/bin/win32/sing-box.exe`,
    `${packageName}/resources/bin/win32/rclone.exe`
  ] : [
    `${packageName}/Syncraft.exe`,
    `${packageName}/release-manifest.json`,
    `${packageName}/resources/app/package.json`,
    `${packageName}/resources/app/client/electron/main.cjs`,
    `${packageName}/resources/app/client/electron/preload.cjs`,
    `${packageName}/resources/app/client/src/clientServer.js`,
    `${packageName}/resources/app/client/src/paths.js`,
    `${packageName}/resources/app/client/src/store.js`,
    `${packageName}/resources/app/client/src/diagnosticBundle.js`,
    `${packageName}/resources/app/client/src/processRunner.js`,
    `${packageName}/resources/app/client/src/rcloneStats.js`,
    `${packageName}/resources/app/client/src/profileImport.js`,
    `${packageName}/resources/app/client/src/launcher.cjs`,
    `${packageName}/resources/app/client/src/Launcher.cs`,
    `${packageName}/resources/app/client/public/index.html`,
    `${packageName}/resources/app/client/public/app.js`,
    `${packageName}/resources/app/client/public/styles.css`,
    `${packageName}/resources/app/src/core/index.js`,
    `${packageName}/resources/app/docs/INTERFACE_CONTRACT.md`,
    `${packageName}/resources/app/docs/API_MATRIX.md`,
    `${packageName}/resources/app/docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md`,
    `${packageName}/resources/app/docs/INTERNAL_TRIAL_CHECKLIST.md`,
    `${packageName}/resources/app/docs/PILOT_RUNBOOK.md`,
    `${packageName}/resources/app/docs/PILOT_ACCEPTANCE_CRITERIA.md`,
    `${packageName}/resources/app/docs/PILOT_SUPPORT_GUIDE.md`,
    `${packageName}/resources/bin/win32/binaries.lock.json`,
    `${packageName}/resources/bin/win32/sing-box.exe`,
    `${packageName}/resources/bin/win32/rclone.exe`
  ];
  const omit = options.omit ? `${packageName}/${options.omit}` : "";
  const finalEntries = entries.filter((entry) => entry !== omit);
  if (options.extra) {
    finalEntries.push(`${packageName}/${options.extra}`);
  }
  return makeZipWithEntries(finalEntries.map((entry) => ({
    name: entry,
    data: fakeZipEntryBody(entry)
  })));
}

function fakeZipEntryBody(entry) {
  if (entry.endsWith("/release-manifest.json")) {
    const packageName = entry.split("/")[0];
    return JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      package: packageName,
      version: "0.3.0-rc.1",
      builtAt: "2026-07-04T00:00:00.000Z",
      sourceTreeHash: FAKE_SOURCE_TREE_HASH,
      buildId: FAKE_BUILD_ID,
      sourceFingerprint: buildFakeSourceFingerprint(FAKE_SOURCE_TREE_HASH, FAKE_BUILD_ID),
      files: []
    });
  }
  if (entry.endsWith("/PILOT_RUNBOOK.md")) {
    return "5-10 人小范围试点 Runbook\n参与者名册字段\n分批 rollout\n每日检查\n试点结束清理\n";
  }
  if (entry.endsWith("/PILOT_ACCEPTANCE_CRITERIA.md")) {
    return "5-10 人小范围试点验收标准\n量化通过指标\n>= 90%\nP0\nP1\n";
  }
  if (entry.endsWith("/PILOT_SUPPORT_GUIDE.md")) {
    return "5-10 人小范围试点支持指南\n支持入口\n首问脚本\n支持包内容\n关闭标准\n";
  }
  return "ok\n";
}

function buildFakeSourceFingerprint(sourceTreeHash, buildId = `sfsc-${sourceTreeHash.slice(0, 12)}`) {
  return {
    algorithm: "sfsc-source-tree-sha256-v1",
    hash: sourceTreeHash,
    buildId,
    fileCount: 1,
    inputs: []
  };
}

async function getFixtureSourceFingerprint(root) {
  return new Promise((resolve, reject) => {
    execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      ". $env:SFSC_FINGERPRINT_HELPER; Get-SourceTreeFingerprint -RepoRoot $env:SFSC_REPO_ROOT | ConvertTo-Json -Depth 20"
    ], {
      cwd: root,
      env: {
        ...process.env,
        SFSC_FINGERPRINT_HELPER: join(root, "scripts", "lib", "build-fingerprint.ps1"),
        SFSC_REPO_ROOT: root
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`failed to compute fixture source fingerprint: ${stderr || stdout || error.message}`));
        return;
      }
      resolve(JSON.parse(String(stdout || "{}")));
    });
  });
}

async function readFixtureSourceTreeHash(root) {
  try {
    const fingerprint = JSON.parse(await readFile(join(root, ".tmp", "source-fingerprint.json"), "utf8"));
    return fingerprint.hash || FAKE_SOURCE_TREE_HASH;
  } catch {
    return FAKE_SOURCE_TREE_HASH;
  }
}

function makeZipWithEntries(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const normalizedEntries = entries.map((entry) => {
    if (typeof entry === "string") {
      return { name: entry, data: Buffer.alloc(0) };
    }
    return {
      name: entry.name,
      data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data || ""), "utf8")
    };
  });
  for (const entry of normalizedEntries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = entry.data;
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(0, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(0, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);

    offset += localHeader.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(normalizedEntries.length, 8);
  endOfCentralDirectory.writeUInt16LE(normalizedEntries.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, endOfCentralDirectory]);
}

async function writeReleaseAuditFixture(tempRoot) {
  const files = [
    "README.md",
    "package.json",
    "client/README.md",
    "docs/INTERFACE_CONTRACT.md",
    "docs/API_MATRIX.md",
    "docs/protocol/README.md",
    "docs/protocol/PROTOCOL_V1_BASELINE.md",
    "docs/protocol/00-http-basics.md",
    "docs/protocol/01-error-codes.md",
    "docs/protocol/02-heartbeat-device-sync.md",
    "docs/protocol/03-diagnostic-bundle.md",
    "docs/protocol/04-claim-lifecycle.md",
    "docs/protocol/05-profile-import.md",
    "docs/protocol/06-runtime-diagnostics.md",
    "docs/protocol/schemas/http-basics.json",
    "docs/protocol/schemas/error-codes.json",
    "docs/protocol/schemas/heartbeat-device-sync.json",
    "docs/protocol/schemas/diagnostic-bundle.json",
    "docs/protocol/schemas/claim-lifecycle.json",
    "docs/protocol/schemas/profile-import.json",
    "docs/protocol/schemas/runtime-diagnostics.json",
    "docs/protocol/schemas/protocol-v1-baseline.json",
    "docs/T_KEY_PROTOCOL.md",
    "docs/SOFTWARE_DESIGN_SPEC.md",
    "docs/client-design.md",
    "docs/server-design.md",
    "docs/PROJECT_HANDOFF.md",
    "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md",
    "docs/INTERNAL_TRIAL_CHECKLIST.md",
    "docs/PILOT_RUNBOOK.md",
    "docs/PILOT_ACCEPTANCE_CRITERIA.md",
    "docs/PILOT_SUPPORT_GUIDE.md",
    "scripts/build-release-bundle.ps1",
    "scripts/deploy-n1.ps1",
    "scripts/apply-n1-singbox.ps1",
    "scripts/post-deploy-n1.ps1",
    "scripts/preflight-release.ps1",
    "scripts/lib/runtimeContracts.mjs",
    "scripts/lib/reportSecrets.mjs",
    "scripts/lib/report-secrets.ps1",
    "scripts/smoke-server.mjs",
    "scripts/smoke-client.mjs",
    "scripts/smoke-client-package.mjs",
    "scripts/smoke-electron-window.mjs",
    "scripts/smoke-electron-e2e.mjs",
    "scripts/release-status.mjs",
    "scripts/record-internal-trial.mjs",
    "scripts/prepare-internal-trial.mjs",
    "scripts/create-trial-t-key.mjs",
    "scripts/internal-trial-assistant.mjs",
    "scripts/client-trial-runner.mjs",
    "scripts/prepare-pilot-wave.mjs",
    "scripts/pilot-summary.mjs",
    "src/core/errors.js",
    "src/core/diagnostics.js",
    "src/core/heartbeatAuth.js",
    "src/core/httpJson.js",
    "src/core/claimProtocol.js",
    "src/core/profileProtocol.js",
    "src/core/protocolSchemas.js",
    "src/core/serverAdmin.js",
    "src/core/syncRun.js",
    "src/core/storage.js",
    "src/server.js",
    "client/src/clientServer.js",
    "client/src/processRunner.js",
    "client/src/store.js",
    "client/src/paths.js",
    "client/src/profileImport.js",
    "client/src/diagnosticBundle.js",
    "client/scripts/build-client.ps1",
    "client/scripts/build-desktop.ps1",
    "public/index.html",
    "public/app.js",
    "client/public/index.html",
    "client/public/app.js",
    "server/.env.example",
    "server/Caddyfile",
    "server/sfscctl",
    "server/sing-box.Dockerfile",
    "server/sing-box-supervisor.sh",
    "server/docker-compose.yml",
    "server/docker-compose.n1.yml",
    "tests/client-http.test.js",
    "tests/contract-http.test.js",
    "tests/helpers/contracts.js",
    "tests/client.test.js",
    "tests/core.test.js"
  ];

  for (const rel of files) {
    await mkdir(join(tempRoot, ...rel.split("/").slice(0, -1)), { recursive: true });
    await writeFile(
      join(tempRoot, ...rel.split("/")),
      await readFile(join(projectRoot, ...rel.split("/")), "utf8"),
      "utf8"
    );
  }
  await mkdir(join(tempRoot, "scripts"), { recursive: true });
  await writeFile(
    join(tempRoot, "scripts", "audit-release.mjs"),
    await readFile(join(projectRoot, "scripts", "audit-release.mjs"), "utf8"),
    "utf8"
  );
  await mkdir(join(tempRoot, "scripts", "lib"), { recursive: true });
  for (const lib of ["composeAudit.mjs", "releaseSignature.mjs"]) {
    await writeFile(
      join(tempRoot, "scripts", "lib", lib),
      await readFile(join(projectRoot, "scripts", "lib", lib), "utf8"),
      "utf8"
    );
  }
  await writeFile(
    join(tempRoot, "scripts", "audit-compose.mjs"),
    await readFile(join(projectRoot, "scripts", "audit-compose.mjs"), "utf8"),
    "utf8"
  );
}

async function writeFakeReleaseBundleZip(tempRoot, bundleName, options = {}) {
  const sourceTreeHash = options.sourceTreeHash || FAKE_SOURCE_TREE_HASH;
  const buildId = options.buildId || `sfsc-${sourceTreeHash.slice(0, 12)}`;
  const packageManifest = (packageName) => JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    package: packageName,
    version: "0.3.0-rc.1",
    builtAt: "2026-07-04T00:00:00.000Z",
    sourceTreeHash,
    buildId,
    sourceFingerprint: buildFakeSourceFingerprint(sourceTreeHash, buildId),
    files: []
  }, null, 2);
  const reportBodies = {
    "reports/release-bundle/preflight.json": JSON.stringify({
      schemaVersion: 1,
      app: "singbox-folder-sync",
      type: "preflight-report",
      ok: true,
      releaseOk: true,
      summary: { passed: 6, failed: 0, skipped: 0 }
    }, null, 2),
    "reports/release-bundle/client-package-smoke-desktop.json": JSON.stringify({
      schemaVersion: 1,
      type: "client-package-smoke-report",
      ok: true,
      package: "SyncraftDesktop"
    }, null, 2),
    "reports/release-bundle/client-package-smoke-portable.json": JSON.stringify({
      schemaVersion: 1,
      type: "client-package-smoke-report",
      ok: true,
      package: "SyncraftClient"
    }, null, 2)
  };
  const bundledReports = Object.entries(reportBodies).map(([path, body]) => ({
    path,
    size: Buffer.byteLength(body),
    sha256: createHash("sha256").update(body).digest("hex")
  }));
  const manifest = JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "release-bundle-manifest",
    version: "0.3.0-rc.1",
    bundleName,
    sourceTreeHash,
    buildId,
    sourceFingerprint: buildFakeSourceFingerprint(sourceTreeHash, buildId),
    clientPackages: {
      desktop: {
        package: "SyncraftDesktop",
        version: "0.3.0-rc.1",
        builtAt: "2026-07-04T00:00:00.000Z",
        sourceTreeHash,
        buildId
      },
      portable: {
        package: "SyncraftClient",
        version: "0.3.0-rc.1",
        builtAt: "2026-07-04T00:00:00.000Z",
        sourceTreeHash,
        buildId
      }
    },
    preflightVerified: true,
    preflightVerification: {
      verified: true,
      mode: "external",
      releaseOk: true,
      summary: { passed: 6, failed: 0, skipped: 0 }
    },
    preflight: {
      mode: "external",
      releaseOk: true,
      summary: { passed: 6, failed: 0, skipped: 0 },
      bundledReports
    },
    artifacts: []
  }, null, 2);
  const fileBodies = {
    "release-bundle-manifest.json": manifest,
    "scripts/lib/runtimeContracts.mjs": "export function assertRuntimeDiagnosticsContract() {}\n",
    "scripts/lib/reportSecrets.mjs": "export function assertReportSafe() {}\nexport function writeJsonReportSync() {}\n",
    "scripts/lib/report-secrets.ps1": "function Assert-ReportTextSafe {}\nfunction Write-SafeJsonReport {}\n",
    "scripts/lib/build-fingerprint.ps1": "function Get-SourceTreeFingerprint { return @{} }\n",
    "scripts/smoke-client.mjs": "console.log('client smoke');\n",
    "scripts/smoke-client-package.mjs": "console.log('client package smoke');\n",
    "scripts/smoke-electron-e2e.mjs": "console.log('electron e2e smoke');\n",
    "scripts/release-status.mjs": [
      "import { assertReportSafe } from './lib/reportSecrets.mjs';",
      "console.log('release-status-summary');",
      "console.log('--fail-on-not-ready');",
      "console.log('currentSource');",
      "console.log('sourceAlignment');",
      "console.log('latest-post-deploy.json');",
      "assertReportSafe({ ok: true }, 'release-status-summary');",
      ""
    ].join("\n"),
    "scripts/record-internal-trial.mjs": "console.log('internal trial record');\n",
    "scripts/prepare-internal-trial.mjs": [
      "console.log('internal-trial-command-sheet');",
      "console.log('This preparation step never asks for, stores, or writes the real SyncKey.');",
      "console.log('SFSC 测试');",
      "console.log('trial:create-t-key');",
      "console.log('--i-understand-real-sync');",
      "console.log('pnpm run trial:record:update');",
      ""
    ].join("\n"),
    "scripts/create-trial-t-key.mjs": [
      "console.log('trial-t-key-report');",
      "console.log('Missing admin token. Set SFSC_ADMIN_TOKEN or ADMIN_TOKEN, or pass --admin-token.');",
      "console.log('ONE-TIME PLAINTEXT SyncKey');",
      "console.log('tKeyPlaintextStored: false');",
      "console.log('Refusing to write trial SyncKey report because it contains sensitive plaintext.');",
      "console.log('SFSC1-[A-Za-z0-9_-]+');",
      "console.log('sfsc:// import URI are never written');",
      ""
    ].join("\n"),
    "scripts/internal-trial-assistant.mjs": "console.log('internal trial assistant');\n",
    "scripts/client-trial-runner.mjs": "console.log('client trial runner');\n",
    "scripts/prepare-pilot-wave.mjs": [
      "console.log('pilot-wave');",
      "console.log('participant-record.json');",
      "console.log('plaintext SyncKey and import URIs are not stored');",
      "console.log('SFSC1-[A-Za-z0-9_-]+');",
      ""
    ].join("\n"),
    "scripts/pilot-summary.mjs": [
      "console.log('pilot-summary');",
      "console.log('ready-for-pilot-signoff');",
      "console.log('install success rate must be >= 90%');",
      "import { assertReportSafe } from './lib/reportSecrets.mjs';",
      "assertReportSafe({ ok: true }, 'pilot-summary');",
      ""
    ].join("\n"),
    "docs/DEPLOYMENT_AND_MIGRATION_GUIDE.md": "deployment guide\n",
    "docs/INTERNAL_TRIAL_CHECKLIST.md": "internal trial checklist\npnpm run pilot:prepare\npnpm run pilot:summary\ndocs/PILOT_RUNBOOK.md\ndocs/PILOT_ACCEPTANCE_CRITERIA.md\ndocs/PILOT_SUPPORT_GUIDE.md\n",
    "docs/PILOT_RUNBOOK.md": "5-10 人小范围试点 Runbook\n准入门禁\n参与者名册字段\n分批 rollout\n每日检查\n升级、回滚和暂停规则\n支持包\n隐私\n试点结束清理\n不得在本文或试点记录中写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key\n",
    "docs/PILOT_ACCEPTANCE_CRITERIA.md": "5-10 人小范围试点验收标准\n量化通过指标\n>= 90%\nP0\nP1\nexpand\npause\nrollback\n不得在验收记录中写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key\n",
    "docs/PILOT_SUPPORT_GUIDE.md": "5-10 人小范围试点支持指南\n支持入口\n首问脚本\n分流处理\n升级、回滚、暂停\n支持包内容\n关闭标准\n不得写入真实 SyncKey、sfsc URI、VLESS URI、token、S3 secret 或 SSH key\n",
    "docs/INTERFACE_CONTRACT.md": "interface contract\n",
    "docs/API_MATRIX.md": "api matrix\n",
    "release-artifacts/windows-client/SyncraftDesktop.zip": "desktop zip\n",
    "release-artifacts/windows-client/SyncraftDesktop.zip.sha256": `${"a".repeat(64)}  SyncraftDesktop.zip\n`,
    "release-artifacts/windows-client/SyncraftDesktop.release-manifest.json": packageManifest("SyncraftDesktop"),
    "release-artifacts/windows-client/SyncraftClient.zip": "portable zip\n",
    "release-artifacts/windows-client/SyncraftClient.zip.sha256": `${"b".repeat(64)}  SyncraftClient.zip\n`,
    "release-artifacts/windows-client/SyncraftClient.release-manifest.json": packageManifest("SyncraftClient"),
    ...reportBodies
  };
  const entries = Object.entries(fileBodies)
    .filter(([name]) => name !== options.omit)
    .map(([name, body]) => ({
      name: `${bundleName}/${name}`,
      data: name === options.corruptReport ? `${body}\ncorrupted after manifest\n` : body
    }));
  const zipContent = makeZipWithEntries(entries);
  const bundleDir = join(tempRoot, "dist", "release-bundles");
  await mkdir(bundleDir, { recursive: true });
  await writeFile(join(bundleDir, `${bundleName}.zip`), zipContent);
  const zipHash = createHash("sha256").update(zipContent).digest("hex");
  await writeFile(join(bundleDir, `${bundleName}.zip.sha256`), `${zipHash}  ${bundleName}.zip\n`, "ascii");
}

async function writeComposeAuditFixture(tempRoot) {
  for (const rel of [
    "server/.env.example",
    "server/docker-compose.yml",
    "server/docker-compose.n1.yml",
    "scripts/audit-compose.mjs",
    "scripts/lib/composeAudit.mjs"
  ]) {
    await mkdir(join(tempRoot, ...rel.split("/").slice(0, -1)), { recursive: true });
    await writeFile(
      join(tempRoot, ...rel.split("/")),
      await readFile(join(projectRoot, ...rel.split("/")), "utf8"),
      "utf8"
    );
  }
}

async function writeReleaseBundleFixture(tempRoot) {
  const textFiles = {
    "README.md": "Productized delivery fixture\n",
    "package.json": JSON.stringify({
      name: "singbox-folder-sync",
      version: "0.3.0-rc.1",
      type: "module"
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "pnpm-workspace.yaml": "packages: []\n",
    "run.ps1": "Write-Host run\n",
    "test.ps1": "Write-Host test\n",
    "docs/INTERFACE_CONTRACT.md": "contract\n",
    "docs/API_MATRIX.md": "matrix\n",
    "docs/INTERNAL_TRIAL_CHECKLIST.md": "checklist\n",
    "docs/PILOT_RUNBOOK.md": "pilot runbook\n",
    "docs/PILOT_ACCEPTANCE_CRITERIA.md": "pilot acceptance criteria\n",
    "docs/PILOT_SUPPORT_GUIDE.md": "pilot support guide\n",
    "src/server.js": "console.log('server');\n",
    "src/core/index.js": "export {};\n",
    "public/index.html": "<main></main>\n",
    "public/app.js": "console.log('app');\n",
    "public/styles.css": "body {}\n",
    "tests/core.test.js": "import test from 'node:test';\n",
    "client/README.md": "client\n",
    "client/src/clientServer.js": "console.log('client');\n",
    "client/src/processRunner.js": "console.log('process runner');\n",
    "client/public/index.html": "<main></main>\n",
    "client/public/app.js": "console.log('client app');\n",
    "client/public/styles.css": "body {}\n",
    "client/scripts/build-client.ps1": "Write-Host build\n",
    "client/electron/main.cjs": "module.exports = {};\n",
    "client/resources/bin/win32/README.md": "download binaries\n",
    "client/data/profile.json": "{\"secret\":\"must not ship\"}\n",
    "server/README.md": "server\n",
    "server/Dockerfile": "FROM node:24\n",
    "server/sing-box.Dockerfile": "ARG SING_BOX_IMAGE_TAG=v1.13.14\nFROM ghcr.io/sagernet/sing-box:${SING_BOX_IMAGE_TAG}\nCOPY server/sing-box-supervisor.sh /usr/local/bin/sfsc-sing-box-supervisor\n",
    "server/sing-box-supervisor.sh": "#!/bin/sh\nexec sing-box run -c /etc/sing-box/config.json\n",
    "server/.env.example": "SFSC_ADMIN_TOKEN=change-this-admin-token\n",
    "server/.env": "SFSC_ADMIN_TOKEN=fixture\n",
    "server/docker-compose.yml": "services: {}\n",
    "server/docker-compose.n1.yml": "services: {}\n",
    "server/sing-box/config.example.json": "{}\n",
    "server/sing-box/config.json": "{\"private_key\":\"must-not-ship\"}\n",
    "server/data/sfsc-state.json": "{}\n",
    "scripts/lib/runtimeContracts.mjs": "export function assertRuntimeDiagnosticsContract() {}\n",
    "scripts/lib/reportSecrets.mjs": "export function assertReportSafe() {}\nexport function writeJsonReportSync() {}\n",
    "scripts/smoke-client.mjs": "console.log('client smoke');\n",
    "scripts/smoke-client-package.mjs": "console.log('client package smoke');\n",
    "scripts/release-status.mjs": "import { assertReportSafe } from './lib/reportSecrets.mjs'; console.log('release-status-summary --fail-on-not-ready currentSource sourceAlignment latest-post-deploy.json'); assertReportSafe({ ok: true }, 'release-status-summary');\n",
    "scripts/record-internal-trial.mjs": "console.log('internal trial record');\n",
    "scripts/prepare-internal-trial.mjs": [
      "console.log('internal-trial-command-sheet');",
      "console.log('This preparation step never asks for, stores, or writes the real SyncKey.');",
      "console.log('SFSC 测试');",
      "console.log('trial:create-t-key');",
      "console.log('--i-understand-real-sync');",
      "console.log('pnpm run trial:record:update');",
      ""
    ].join("\n"),
    "scripts/create-trial-t-key.mjs": [
      "console.log('trial-t-key-report');",
      "console.log('Missing admin token. Set SFSC_ADMIN_TOKEN or ADMIN_TOKEN, or pass --admin-token.');",
      "console.log('ONE-TIME PLAINTEXT SyncKey');",
      "console.log('tKeyPlaintextStored: false');",
      "console.log('Refusing to write trial SyncKey report because it contains sensitive plaintext.');",
      "console.log('SFSC1-[A-Za-z0-9_-]+');",
      "console.log('sfsc:// import URI are never written');",
      ""
    ].join("\n"),
    "scripts/internal-trial-assistant.mjs": "console.log('internal trial assistant');\n",
    "scripts/client-trial-runner.mjs": "console.log('client trial runner');\n",
    "scripts/prepare-pilot-wave.mjs": "console.log('pilot-wave participant-record.json plaintext SyncKey and import URIs are not stored SFSC1-[A-Za-z0-9_-]+');\n",
    "scripts/pilot-summary.mjs": "import { assertReportSafe } from './lib/reportSecrets.mjs'; console.log('pilot-summary ready-for-pilot-signoff install success rate must be >= 90%'); assertReportSafe({ ok: true }, 'pilot-summary');\n",
    ".tmp/scratch.txt": "scratch\n",
    "node_modules/bad.txt": "bad\n"
  };

  for (const [rel, content] of Object.entries(textFiles)) {
    await mkdir(join(tempRoot, ...rel.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(tempRoot, ...rel.split("/")), content, "utf8");
  }
  await mkdir(join(tempRoot, "scripts"), { recursive: true });
  await writeFile(
    join(tempRoot, "scripts", "build-release-bundle.ps1"),
    await readFile(join(projectRoot, "scripts", "build-release-bundle.ps1"), "utf8"),
    "utf8"
  );
  await mkdir(join(tempRoot, "scripts", "lib"), { recursive: true });
  await writeFile(
    join(tempRoot, "scripts", "lib", "report-secrets.ps1"),
    await readFile(join(projectRoot, "scripts", "lib", "report-secrets.ps1"), "utf8"),
    "utf8"
  );
  await writeFile(
    join(tempRoot, "scripts", "lib", "build-fingerprint.ps1"),
    await readFile(join(projectRoot, "scripts", "lib", "build-fingerprint.ps1"), "utf8"),
    "utf8"
  );

  await refreshFakeReleaseBatch(tempRoot);
}

async function refreshFakeReleaseBatch(tempRoot) {
  const sourceFingerprint = await getFixtureSourceFingerprint(tempRoot);
  await mkdir(join(tempRoot, ".tmp"), { recursive: true });
  await writeFile(join(tempRoot, ".tmp", "source-fingerprint.json"), JSON.stringify(sourceFingerprint, null, 2), "utf8");
  await writeFakeReleaseArtifact(tempRoot, "SyncraftDesktop", sourceFingerprint.hash);
  await writeFakeReleaseArtifact(tempRoot, "SyncraftClient", sourceFingerprint.hash);
  return sourceFingerprint;
}

async function writeFakeReleaseArtifact(tempRoot, packageName, sourceTreeHash = FAKE_SOURCE_TREE_HASH) {
  const zip = Buffer.from(`${packageName} zip bytes`, "utf8");
  const zipHash = createHash("sha256").update(zip).digest("hex");
  const buildId = `sfsc-${sourceTreeHash.slice(0, 12)}`;
  const files = packageName === "SyncraftDesktop"
    ? [{
        name: "Syncraft.exe",
        size: Buffer.byteLength("fixture desktop executable"),
        sha256: createHash("sha256").update("fixture desktop executable").digest("hex")
      }]
    : [];
  await mkdir(join(tempRoot, "dist", packageName), { recursive: true });
  await writeFile(join(tempRoot, "dist", `${packageName}.zip`), zip);
  await writeFile(join(tempRoot, "dist", `${packageName}.zip.sha256`), `${zipHash}  ${packageName}.zip\n`, "ascii");
  await writeFile(join(tempRoot, "dist", packageName, "release-manifest.json"), JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    package: packageName,
    version: "0.3.0-rc.1",
    builtAt: "2026-07-04T00:00:00.000Z",
    sourceTreeHash,
    buildId,
    sourceFingerprint: buildFakeSourceFingerprint(sourceTreeHash, buildId),
    files
  }), "utf8");
}

async function writeFakePreflightReports(tempRoot, sourceTreeHash = "") {
  const resolvedSourceTreeHash = sourceTreeHash || await readFixtureSourceTreeHash(tempRoot);
  const buildId = `sfsc-${resolvedSourceTreeHash.slice(0, 12)}`;
  const reportRoot = join(tempRoot, "reports", "release");
  await mkdir(reportRoot, { recursive: true });
  const desktopSmoke = {
    schemaVersion: 1,
    type: "client-package-smoke-report",
    ok: true,
    packageRoot: join(tempRoot, "dist", "SyncraftDesktop"),
    failure: null
  };
  const portableSmoke = {
    schemaVersion: 1,
    type: "client-package-smoke-report",
    ok: true,
    packageRoot: join(tempRoot, "dist", "SyncraftClient"),
    failure: null
  };
  await writeFile(join(reportRoot, "client-package-smoke-desktop.json"), JSON.stringify(desktopSmoke, null, 2), "utf8");
  await writeFile(join(reportRoot, "client-package-smoke-portable.json"), JSON.stringify(portableSmoke, null, 2), "utf8");
  await writeFile(join(reportRoot, "preflight.txt"), "Preflight report:\n  - passed: all release checks\n", "utf8");
  await writeFile(join(reportRoot, "preflight.json"), JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "preflight-report",
    ok: true,
    releaseOk: true,
    context: {
      SourceTreeHash: resolvedSourceTreeHash,
      BuildId: buildId,
      ClientPackageSmokeJsonReportPaths: [
        join(reportRoot, "client-package-smoke-desktop.json"),
        join(reportRoot, "client-package-smoke-portable.json")
      ]
    },
    summary: { passed: 6, failed: 0, skipped: 0 },
    steps: [],
    clientPackageSmokeReports: [
      { exists: true, ok: true, path: join(reportRoot, "client-package-smoke-desktop.json") },
      { exists: true, ok: true, path: join(reportRoot, "client-package-smoke-portable.json") }
    ]
  }, null, 2), "utf8");
}

function buildRuntimeContractDeviceFixture() {
  return {
    id: "device-1",
    clientName: "contract-pc",
    enabled: true,
    online: true,
    status: "online",
    lastSeenAt: "2026-07-04T12:00:00.000Z",
    bucket: "home-sync",
    prefix: "devices/contract-pc",
    clientVersion: "0.3.0-rc.1",
    diagnostics: buildRuntimeDiagnostics({ role: "client", version: "0.3.0-rc.1" }),
    compatibility: {
      ok: true,
      status: "compatible",
      action: "none",
      severity: "ok",
      policy: {
        heartbeat: "allow",
        profileIssue: "allow",
        syncRun: "allow",
        adminActions: "allow",
        reason: "none"
      },
      localRole: "server",
      remoteRole: "client",
      issues: []
    },
    lastRemoteAddress: "127.0.0.1",
    sync: {
      state: "syncing",
      speedMbps: 12.5,
      progressPercent: 42,
      currentFile: "projects/current.iso",
      conflicts: {
        count: 0,
        files: [],
        truncated: false
      },
      currentJob: {
        name: "Folder sync",
        direction: "upload",
        bucketName: "home-sync",
        remotePrefix: "devices/contract-pc"
      },
      lastRun: {
        id: "run-1",
        status: "success",
        trigger: "scheduler",
        startedAt: "2026-07-04T11:00:00.000Z",
        finishedAt: "2026-07-04T11:05:00.000Z",
        job: {
          name: "Folder sync",
          direction: "upload",
          bucketName: "home-sync",
          remotePrefix: "devices/contract-pc"
        },
        localPath: "C:\\Data\\Projects",
        exitCode: 0,
        errorCode: "",
        error: "",
        progressPercent: 100,
        transferredSizeText: "1 GiB",
        currentFile: "projects/video.iso",
        rawSpeed: "8 MiB/s",
        speedMbps: 67.11,
        conflicts: {
          count: 0,
          files: [],
          truncated: false
        }
      },
      scheduler: {
        enabled: true,
        intervalMs: 15000,
        nextRun: "2026-07-04T12:15:00.000Z",
        lastTriggeredAt: "2026-07-04T12:00:00.000Z",
        lastError: "",
        jobs: [
          {
            id: "job-1",
            name: "Folder sync",
            schedule: { mode: "interval", intervalMinutes: 15 },
            scheduleText: "Every 15 minutes",
            nextRun: "2026-07-04T12:15:00.000Z",
            lastTriggeredAt: "2026-07-04T12:00:00.000Z",
            lastError: ""
          }
        ]
      }
    },
    syncState: "syncing",
    speedMbps: 12.5
  };
}

function buildRuntimeContractClientStatusFixture() {
  const lastSync = buildRuntimeContractSyncRunFixture();
  return {
    ok: true,
    mode: "client-exe-runtime",
    appVersion: "0.3.0-rc.1",
    clientVersion: "0.3.0-rc.1",
    diagnostics: buildRuntimeDiagnostics({ role: "client", version: "0.3.0-rc.1" }),
    releaseManifest: buildRuntimeContractReleaseManifestSummaryFixture(),
    paths: {
      root: "C:\\SFSC",
      binRoot: "C:\\SFSC\\bin",
      dataRoot: "C:\\SFSC\\data"
    },
    binaries: {
      singbox: {
        path: "C:\\SFSC\\bin\\sing-box.exe",
        exists: false,
        ok: false,
        errorCode: "missing_singbox_binary",
        message: "Missing bundled sing-box"
      },
      rclone: {
        path: "C:\\SFSC\\bin\\rclone.exe",
        exists: false,
        ok: false,
        errorCode: "missing_rclone_binary",
        message: "Missing bundled rclone"
      }
    },
    profileImported: false,
    profileSummary: null,
    jobs: [],
    scheduler: {
      enabled: false,
      intervalMs: 0,
      updatedAt: "2026-07-04T12:00:00.000Z",
      nextRun: null,
      lastTriggeredAt: null,
      lastError: "",
      jobs: []
    },
    syncHistory: [lastSync],
    lastSync: structuredClone(lastSync),
    processes: {
      singbox: {
        name: "sing-box",
        running: false,
        pid: null,
        startedAt: null,
        lastExit: null
      },
      sync: {
        name: "rclone-sync",
        running: false,
        pid: null,
        startedAt: null,
        lastExit: null,
        metrics: {
          syncState: "idle",
          speedMbps: 0,
          bytesPerSecond: 0,
          progressPercent: null,
          currentFile: ""
        }
      }
    },
    heartbeat: buildRuntimeContractHeartbeatFixture({ ok: false }),
    lastSuccessfulHeartbeat: buildRuntimeContractHeartbeatFixture({ ok: true }),
    safeguards: {
      tun: false,
      systemProxy: false,
      routeMutation: false,
      dnsMutation: false,
      rcloneConfigScope: "C:\\SFSC\\data\\rclone.conf",
      localState: {
        ok: true,
        files: ["profile", "jobs", "secrets", "syncHistory", "claimRecovery", "lastSuccessfulHeartbeat"].map((name) => ({
          name,
          path: `C:\\SFSC\\data\\${name}.json`,
          exists: true,
          ok: true
        }))
      },
      secretVault: {
        backend: "file",
        path: "C:\\SFSC\\data\\secrets.json",
        protected: true,
        protection: {
          protected: true,
          mode: "windows-acl",
          exists: true
        },
        refs: 0,
        missingRefs: [],
        ok: true
      }
    }
  };
}

function buildRuntimeContractSyncRunFixture() {
  return normalizeSyncRun({
    id: "run-1",
    status: "success",
    trigger: "manual",
    startedAt: "2026-07-04T11:00:00.000Z",
    finishedAt: "2026-07-04T11:01:00.000Z",
    job: {
      name: "Folder sync",
      direction: "upload",
      bucketName: "home-sync",
      remotePrefix: "devices/contract-pc"
    },
    localPath: "C:\\Data\\Projects",
    exitCode: 0,
    progressPercent: 100,
    transferredSizeText: "1 GiB",
    currentFile: "projects/current.iso",
    rawSpeed: "8 MiB/s",
    speedMbps: 67.11
  });
}

function buildRuntimeContractHeartbeatFixture(options = {}) {
  if (options.ok === false) {
    return {
      ok: false,
      server: "https://sync.example.com",
      sentAt: "2026-07-04T12:00:00.000Z",
      status: 502,
      errorCode: "heartbeat_failed",
      remoteErrorCode: "server_unavailable"
    };
  }
  return {
    ok: true,
    server: "https://sync.example.com",
    sentAt: "2026-07-04T12:00:00.000Z",
    status: 200,
    serverDiagnostics: buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" }),
    compatibility: {
      ok: true,
      status: "compatible",
      action: "none",
      severity: "ok",
      policy: {
        heartbeat: "allow",
        profileIssue: "allow",
        syncRun: "allow",
        adminActions: "allow",
        reason: "none"
      },
      localRole: "server",
      remoteRole: "client",
      issues: []
    },
    device: buildRuntimeContractDeviceFixture()
  };
}

function buildRuntimeContractDiagnosticExportFixture() {
  return {
    ok: true,
    filename: "sfsc-client-diagnostics-20260704T000000Z.json",
    bundle: buildRuntimeContractDiagnosticBundleFixture()
  };
}

function buildRuntimeContractDiagnosticBundleFixture() {
  return {
    schemaVersion: 1,
    app: "singbox-folder-sync",
    role: "client",
    generatedAt: "2026-07-04T12:00:00.000Z",
    summary: buildRuntimeContractDiagnosticSummaryFixture(),
    status: buildRuntimeContractDiagnosticStatusFixture(),
    environment: buildRuntimeContractDiagnosticEnvironmentFixture(),
    logs: {
      electron: buildRuntimeContractDiagnosticLogMetaFixture("electron"),
      singbox: buildRuntimeContractDiagnosticLogMetaFixture("singbox"),
      rclone: buildRuntimeContractDiagnosticLogMetaFixture("rclone")
    }
  };
}

function buildRuntimeContractDiagnosticSummaryFixture() {
  return {
    appVersion: "0.3.0-rc.1",
    releaseManifestOk: true,
    releaseManifestVersion: "0.3.0-rc.1",
    releaseManifestBuiltAt: "2026-07-04T00:00:00.000Z",
    releaseManifestErrorCode: "",
    releaseManifestSupportDocsOk: true,
    releaseManifestSupportDocsMissing: [],
    releaseManifestRequiredFilesOk: true,
    releaseManifestRequiredFilesMissing: [],
    profileImported: false,
    profileClientName: "",
    serverUrl: "redacted",
    portableRoot: true,
    binariesOk: false,
    missingBinaries: [
      {
        path: "sing-box.exe",
        errorCode: "missing_singbox_binary",
        message: "Missing bundled sing-box"
      }
    ],
    localStateOk: true,
    localStateErrors: [],
    secretVaultOk: true,
    missingSecretRefs: 0,
    heartbeatOk: true,
    heartbeatErrorCode: "",
    heartbeatRemoteErrorCode: "",
    heartbeatDeviceStatus: "online",
    heartbeatDeviceEnabled: true,
    heartbeatDeviceOnline: true,
    heartbeatDeviceBucket: "redacted",
    heartbeatDevicePrefix: "redacted",
    heartbeatDeviceCurrentFile: "redacted",
    heartbeatServerProtocols: buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" }).protocols,
    heartbeatCompatibilityStatus: "compatible",
    heartbeatCompatibilityAction: "none",
    heartbeatCompatibilitySeverity: "ok",
    heartbeatCompatibilitySyncRunPolicy: "allow",
    lastSyncStatus: "success",
    lastSyncErrorCode: "",
    conflictCount: 0,
    logsMissing: [],
    logsTruncated: []
  };
}

function buildRuntimeContractDiagnosticStatusFixture() {
  return {
    diagnostics: buildRuntimeDiagnostics({ role: "client", version: "0.3.0-rc.1" }),
    appVersion: "0.3.0-rc.1",
    profileImported: false,
    profileSummary: {
      clientName: "",
      serverUrl: "",
      storage: "",
      localProxyPort: null
    },
    binaries: {
      singbox: {
        path: "sing-box.exe",
        exists: false,
        ok: false,
        errorCode: "missing_singbox_binary",
        message: "Missing bundled sing-box"
      },
      rclone: {
        path: "rclone.exe",
        exists: false,
        ok: false,
        errorCode: "missing_rclone_binary",
        message: "Missing bundled rclone"
      }
    },
    heartbeat: {
      ok: false,
      server: "redacted",
      sentAt: "2026-07-04T12:00:00.000Z",
      status: 502,
      errorCode: "heartbeat_failed",
      remoteErrorCode: "server_unavailable",
      serverDiagnostics: null,
      compatibility: null,
      device: null
    },
    lastSuccessfulHeartbeat: {
      ok: true,
      server: "redacted",
      sentAt: "2026-07-04T12:00:00.000Z",
      status: 200,
      errorCode: "",
      remoteErrorCode: "",
      serverDiagnostics: buildRuntimeDiagnostics({ role: "server", version: "0.3.0-rc.1" }),
      compatibility: {
        ok: true,
        status: "compatible",
        action: "none",
        severity: "ok",
        policy: {
          heartbeat: "allow",
          profileIssue: "allow",
          syncRun: "allow",
          adminActions: "allow",
          reason: "none"
        },
        localRole: "server",
        remoteRole: "client",
        issues: []
      },
      device: {
        status: "online",
        enabled: true,
        online: true,
        bucket: "redacted",
        prefix: "redacted",
        sync: {
          state: "syncing",
          syncState: "syncing",
          speedMbps: 12.5,
          currentFile: "redacted",
          lastRun: {
            id: "redacted",
            status: "success",
            trigger: "scheduler",
            startedAt: "2026-07-04T11:00:00.000Z",
            finishedAt: "2026-07-04T11:05:00.000Z",
            localPath: "redacted",
            errorCode: "",
            error: "",
            speedMbps: 67.11,
            rawSpeed: "8 MiB/s",
            currentFile: "redacted",
            conflicts: {
              count: 0,
              files: [],
              truncated: false
            }
          },
          scheduler: {
            enabled: true,
            intervalMs: 15000,
            nextRun: "2026-07-04T12:15:00.000Z",
            lastTriggeredAt: "2026-07-04T12:00:00.000Z",
            lastError: "",
            jobs: [
              {
                id: "redacted",
                name: "Folder sync",
                schedule: { mode: "interval", intervalMinutes: 15, timeOfDay: "" },
                scheduleText: "Every 15 minutes",
                nextRun: "2026-07-04T12:15:00.000Z",
                lastTriggeredAt: "2026-07-04T12:00:00.000Z",
                lastError: ""
              }
            ]
          }
        }
      }
    },
    safeguards: {
      localState: {
        ok: true,
        files: ["profile", "jobs", "secrets", "syncHistory", "claimRecovery", "lastSuccessfulHeartbeat"].map((name) => ({
          name,
          exists: true,
          ok: true,
          errorCode: "",
          message: ""
        }))
      },
      secretVault: {
        backend: "file",
        path: "secrets.json",
        protected: true,
        protection: {
          protected: true,
          mode: "windows-acl",
          exists: true
        },
        refs: 0,
        missingRefs: [],
        ok: true
      }
    },
    lastSync: {
      id: "redacted",
      status: "success",
      trigger: "manual",
      startedAt: "2026-07-04T11:00:00.000Z",
      finishedAt: "2026-07-04T11:01:00.000Z",
      localPath: "redacted",
      errorCode: "",
      error: "",
      speedMbps: 67.11,
      rawSpeed: "8 MiB/s",
      currentFile: "redacted",
      conflicts: {
        count: 0,
        files: [],
        truncated: false
      }
    },
    jobs: []
  };
}

function buildRuntimeContractDiagnosticEnvironmentFixture() {
  return {
    node: "v24.0.0",
    platform: "win32",
    arch: "x64",
    pid: 1234,
    uptimeSeconds: 12,
    cwd: "redacted",
    portableRoot: true,
    appRoot: "redacted",
    root: "redacted",
    dataRoot: "redacted",
    releaseManifest: buildRuntimeContractReleaseManifestSummaryFixture(),
    binaries: {
      singbox: buildRuntimeContractFileSummaryFixture("sing-box.exe"),
      rclone: buildRuntimeContractFileSummaryFixture("rclone.exe")
    },
    stateFiles: {
      profile: buildRuntimeContractFileSummaryFixture("profile.json"),
      jobs: buildRuntimeContractFileSummaryFixture("jobs.json"),
      secrets: buildRuntimeContractFileSummaryFixture("secrets.json"),
      syncHistory: buildRuntimeContractFileSummaryFixture("sync-history.json"),
      claimRecovery: buildRuntimeContractFileSummaryFixture("claim-recovery.json"),
      lastSuccessfulHeartbeat: buildRuntimeContractFileSummaryFixture("last-successful-heartbeat.json")
    },
    logFiles: {
      electron: buildRuntimeContractFileSummaryFixture("electron-main.log"),
      singbox: buildRuntimeContractFileSummaryFixture("sing-box.log"),
      rclone: buildRuntimeContractFileSummaryFixture("rclone.log")
    }
  };
}

function buildRuntimeContractDiagnosticLogMetaFixture(name) {
  return {
    path: `${name}.log`,
    exists: true,
    size: 16,
    modifiedAt: "2026-07-04T12:00:00.000Z",
    maxChars: 20000,
    truncated: false,
    text: `${name} log ok`
  };
}

function buildRuntimeContractReleaseManifestSummaryFixture() {
  return {
    path: "release-manifest.json",
    exists: true,
    size: 256,
    modifiedAt: "2026-07-04T00:00:00.000Z",
    ok: true,
    schemaVersion: 1,
    package: "SyncraftClient",
    version: "0.3.0-rc.1",
    builtAt: "2026-07-04T00:00:00.000Z",
    errorCode: "",
    message: "",
    fileCount: 2,
    supportDocuments: {
      ok: true,
      files: [buildRuntimeContractManifestFileFixture("INTERFACE_CONTRACT")]
    },
    requiredFiles: {
      ok: true,
      package: "SyncraftClient",
      files: [buildRuntimeContractManifestFileFixture("clientServer.js")]
    }
  };
}

function buildRuntimeContractManifestFileFixture(name) {
  return {
    name,
    path: name,
    sha256: "a".repeat(64),
    present: true,
    valid: true,
    size: 128
  };
}

function buildRuntimeContractFileSummaryFixture(path) {
  return {
    path,
    exists: true,
    size: 128,
    modifiedAt: "2026-07-04T12:00:00.000Z"
  };
}

function runClientPackageSmoke(packageRoot, options = {}) {
  return new Promise((resolve) => {
    const args = [join(projectRoot, "scripts", "smoke-client-package.mjs")];
    if (options.jsonReportPath) {
      args.push("--json-report", options.jsonReportPath);
    }
    execFile(process.execPath, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        SFSC_CLIENT_PACKAGE_DIR: packageRoot,
        SFSC_CLIENT_PACKAGE_SKIP_LAUNCH: "1"
      }
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runClientTrialRunner(args = []) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(projectRoot, "scripts", "client-trial-runner.mjs"), ...args], {
      cwd: projectRoot,
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runInternalTrialPrepare(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(projectRoot, "scripts", "prepare-internal-trial.mjs"), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...extraEnv
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runPilotPrepare(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(projectRoot, "scripts", "prepare-pilot-wave.mjs"), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...extraEnv
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runPilotSummary(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(projectRoot, "scripts", "pilot-summary.mjs"), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...extraEnv
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runReleaseStatus(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(projectRoot, "scripts", "release-status.mjs"), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...extraEnv
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runTrialTKeyHelper(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(projectRoot, "scripts", "create-trial-t-key.mjs"), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...extraEnv
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runInternalTrialRecord(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(projectRoot, "scripts", "record-internal-trial.mjs"), ...args], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...extraEnv
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

async function writeInternalTrialRecordFixture(tempRoot, recordPath) {
  const releaseZip = join(tempRoot, "release.zip");
  const desktopZip = join(tempRoot, "desktop.zip");
  const portableZip = join(tempRoot, "portable.zip");
  const releaseManifest = join(tempRoot, "release-bundle-manifest.json");
  const desktopManifest = join(tempRoot, "desktop-manifest.json");
  const portableManifest = join(tempRoot, "portable-manifest.json");
  await writeFile(releaseZip, "release", "utf8");
  await writeFile(desktopZip, "desktop", "utf8");
  await writeFile(portableZip, "portable", "utf8");
  await writeFile(releaseManifest, JSON.stringify({ preflightVerified: true, version: "0.3.0-rc.1" }), "utf8");
  await writeFile(desktopManifest, JSON.stringify({ version: "0.3.0-rc.1", files: [] }), "utf8");
  await writeFile(portableManifest, JSON.stringify({ version: "0.3.0-rc.1", files: [] }), "utf8");
  const releaseHash = createHash("sha256").update(await readFile(releaseZip)).digest("hex");
  const desktopHash = createHash("sha256").update(await readFile(desktopZip)).digest("hex");
  const portableHash = createHash("sha256").update(await readFile(portableZip)).digest("hex");
  await writeFile(`${releaseZip}.sha256`, `${releaseHash}  release.zip\n`, "ascii");
  await writeFile(`${desktopZip}.sha256`, `${desktopHash}  desktop.zip\n`, "ascii");
  await writeFile(`${portableZip}.sha256`, `${portableHash}  portable.zip\n`, "ascii");

  const sections = [
    "release-evidence",
    "install-first-launch",
    "t-key-profile",
    "folder-job-save",
    "preview-small-sync",
    "stop-restart-recovery",
    "diagnostics-privacy",
    "portable-compat"
  ].map((id) => ({ id, status: "pending", notes: "", artifacts: [] }));
  await writeFile(recordPath, JSON.stringify({
    schemaVersion: 1,
    app: "singbox-folder-sync",
    type: "internal-trial-record",
    environment: {
      serverBaseUrl: "http://192.168.1.254:5177"
    },
    evidence: {
      releaseBundle: {
        path: releaseZip,
        sha256Path: `${releaseZip}.sha256`,
        manifestPath: releaseManifest,
        sha256: releaseHash
      },
      desktopPackage: {
        path: desktopZip,
        sha256Path: `${desktopZip}.sha256`,
        manifestPath: desktopManifest,
        sha256: desktopHash
      },
      portablePackage: {
        path: portableZip,
        sha256Path: `${portableZip}.sha256`,
        manifestPath: portableManifest,
        sha256: portableHash
      },
      n1: {
        runId: "fixture-n1",
        ok: true,
        releaseBundleVerified: true,
        restartRequired: false,
        targetHostsMatch: true
      }
    },
    sections,
    failures: []
  }, null, 2), "utf8");
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

async function readJsonRequest(req) {
  if (req.method === "GET") return null;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function runReleaseAudit(root) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, "scripts", "audit-release.mjs")], {
      cwd: root
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runComposeAudit(root) {
  return new Promise((resolve) => {
    execFile(process.execPath, [join(root, "scripts", "audit-compose.mjs")], {
      cwd: root
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

async function ensureReportSecretsHelper(root) {
  await mkdir(join(root, "scripts", "lib"), { recursive: true });
  await writeFile(
    join(root, "scripts", "lib", "report-secrets.ps1"),
    await readFile(join(projectRoot, "scripts", "lib", "report-secrets.ps1"), "utf8"),
    "utf8"
  );
  await writeFile(
    join(root, "scripts", "lib", "build-fingerprint.ps1"),
    await readFile(join(projectRoot, "scripts", "lib", "build-fingerprint.ps1"), "utf8"),
    "utf8"
  );
}

async function runPreflight(root, args = [], extraEnv = {}) {
  await ensureReportSecretsHelper(root);
  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "preflight-release.ps1"),
      ...args
    ], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        SFSC_NODE: process.execPath
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

async function runDeploy(root, args = [], extraEnv = {}) {
  await ensureReportSecretsHelper(root);
  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "deploy-n1.ps1"),
      ...args
    ], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        SFSC_NODE: process.execPath
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

async function runApply(root, args = [], extraEnv = {}) {
  await ensureReportSecretsHelper(root);
  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "apply-n1-singbox.ps1"),
      ...args
    ], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        SFSC_NODE: process.execPath
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

async function runPostDeploy(root, args = [], extraEnv = {}) {
  await ensureReportSecretsHelper(root);
  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "post-deploy-n1.ps1"),
      ...args
    ], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        SFSC_NODE: process.execPath
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

async function runReleaseBundle(root, args = [], extraEnv = {}) {
  await ensureReportSecretsHelper(root);
  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(root, "scripts", "build-release-bundle.ps1"),
      ...args
    ], {
      cwd: root,
      env: {
        ...process.env,
        ...extraEnv,
        SFSC_NODE: process.execPath
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function runDownloadBinaries(args = [], extraEnv = {}) {
  return new Promise((resolve) => {
    execFile("powershell", [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      join(projectRoot, "client", "scripts", "download-binaries.ps1"),
      ...args
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...extraEnv
      },
      maxBuffer: 1024 * 1024
    }, (error, stdout, stderr) => {
      resolve({
        code: error?.code || 0,
        stdout: String(stdout || ""),
        stderr: String(stderr || "")
      });
    });
  });
}

function binaryLockFixture({ singBoxSha256, rcloneSha256 }) {
  return {
    schemaVersion: 1,
    platform: "win32-x64",
    tools: {
      "sing-box": {
        repo: "SagerNet/sing-box",
        version: "1.0.0",
        tag: "v1.0.0",
        assetPattern: "windows-amd64.*\\.zip$",
        assetRejectPattern: "legacy",
        exe: "sing-box.exe",
        sha256: singBoxSha256
      },
      rclone: {
        repo: "rclone/rclone",
        version: "1.0.0",
        tag: "v1.0.0",
        assetPattern: "windows-amd64.*\\.zip$",
        exe: "rclone.exe",
        sha256: rcloneSha256
      }
    }
  };
}

async function fileExists(path) {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

function assertErrorCode(action, code) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);
    return true;
  });
}

function buildServerConsoleApiContext(app) {
  const source = extractServerConsoleApiSource(app);
  const context = {
    fetch: async () => {
      throw new Error("fetch was not stubbed");
    }
  };
  runInNewContext([
    "const defaultRequestTimeoutMs = 15000;",
    "let adminToken = \"\";",
    source,
    "this.readJsonOrFallback = readJsonOrFallback;",
    "this.api = api;"
  ].join("\n"), context);
  return context;
}

function extractServerConsoleApiSource(app) {
  const start = app.indexOf("function summarizeResponseText");
  assert.notEqual(start, -1);
  const end = app.indexOf("\nfunction byId", start);
  assert.notEqual(end, -1);
  return app.slice(start, end);
}

function extractImplementedRoutes(source) {
  return [...source.matchAll(/req\.method === "([A-Z]+)" && url\.pathname === "([^"]+)"/g)]
    .map((match) => ({ method: match[1], path: match[2] }))
    .filter((route) => route.path.startsWith("/api/"));
}

function extractApiPaths(source) {
  return [...new Set([...source.matchAll(/["'`]([^"'`]*\/api\/[^"'`${}\s]+)["'`]/g)]
    .map((match) => match[1])
    .map((path) => path.replace(/^.*?(\/api\/)/, "/api/"))
    .map((path) => path.replace(/[),;]+$/, ""))
    .filter((path) => path.startsWith("/api/")))]
    .sort();
}

function routeRowPattern(route) {
  return new RegExp(`\\|\\s*${escapeRegExp(route.method)}\\s*\\|\\s*${escapeRegExp(`\`${route.path}\``)}\\s*\\|`);
}

function pathPattern(path) {
  return new RegExp(escapeRegExp(`\`${path}\``));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
