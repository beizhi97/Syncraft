const $ = (id) => document.getElementById(id);
const fields = {
  claimCode: $("claimCode"),
  claimServer: $("claimServer"),
  localPath: $("localPath"),
  direction: $("direction"),
  scheduleMode: $("scheduleMode"),
  scheduleInterval: $("scheduleInterval"),
  scheduleTime: $("scheduleTime"),
  destructiveSync: $("destructiveSync"),
  bisyncInitialMode: $("bisyncInitialMode"),
  bandwidthLimitEnabled: $("bandwidthLimitEnabled"),
  bandwidthLimitMode: $("bandwidthLimitMode"),
  bandwidthLimitValue: $("bandwidthLimitValue"),
  bandwidthLimitUnit: $("bandwidthLimitUnit"),
  bandwidthLimitStart: $("bandwidthLimitStart"),
  bandwidthLimitEnd: $("bandwidthLimitEnd"),
  folderPicker: $("folderPicker")
};

let pendingConfirmation = null;
let latestStatus = null;
// 当前事件及其所描述的状态签名。null = 事件区为空。
let currentAction = null;
let latestSyncHistory = [];
let currentJobDraft = null;
let selectedFirstBisyncOperationId = "";
let statusRequestInFlight = null;
let latestStatusRequestId = 0;
let latestAppliedStatusRequestId = 0;
let lastPreviewJobFingerprint = "";
let activeConnectionRepairOperationId = "";
let activeBusyActionGroups = new Set();
let syncRecoveryPanelsRequestInFlight = null;
const connectionRepairStorageKey = "sfsc.connectionRepair.operation";
const defaultRequestTimeoutMs = 15000;
const profileImportRequestTimeoutMs = 60000;
const syncPreparationRequestTimeoutMs = 120000;
const syncRunRequestTimeoutMs = 120000;
const bidirectionalInitializationRequestTimeoutMs = 240000;
const clientJobDraftFields = [
  "id",
  "name",
  "localPath",
  "direction",
  "storageBackend",
  "relationId",
  "directoryDisplayName",
  "dryRun",
  "destructiveSync",
  "safety",
  "bandwidthLimit",
  "schedule",
  "checkers",
  "s3UploadConcurrency",
  "s3ChunkSize",
  "chunkSize",
  "cutoff",
  "retries",
  "lowLevelRetries",
  "localProxyPort",
  "clientName",
  "remoteName",
  "bucketName",
  "remotePrefix",
  "s3Endpoint"
];

on("settingsBtn", "click", openSettings);
on("emptyEnrollmentBtn", "click", openSettings);
on("settingsScrim", "click", closeSettings);
on("closeSettingsBtn", "click", closeSettings);
on("checkBinsBtn", "click", checkBinaries);
on("saveProfileBtn", "click", saveProfile);
on("importEnrollmentChannelBtn", "click", importEnrollmentChannel);
on("submitEnrollmentRequestBtn", "click", submitEnrollmentRequest);
on("consumeEnrollmentCodeBtn", "click", consumeEnrollmentCode);
on("refreshDirectoryAuthorizationsBtn", "click", refreshDirectoryAuthorizations);
on("repairConnectionBtn", "click", repairSelectedConnection);
on("startTunnelBtn", "click", startTunnel);
on("stopTunnelBtn", "click", stopTunnel);
on("saveJobBtn", "click", saveJob);
on("previewBtn", "click", previewJob);
on("runSyncBtn", "click", runSync);
on("stopSyncBtn", "click", stopSync);
on("refreshHistoryBtn", "click", refreshSyncHistory);
on("refreshRecoveryBtn", "click", refreshRecoveryVersions);
on("historyStatusFilter", "change", () => renderSyncHistory(latestSyncHistory));
on("historySearch", "input", () => renderSyncHistory(latestSyncHistory));
on("refreshLogsBtn", "click", refreshLogs);
on("copyLogsBtn", "click", copyLogs);
on("copySupportSummaryBtn", "click", copySupportSummary);
on("exportDiagnosticsBtn", "click", exportDiagnostics);
on("shutdownBtn", "click", shutdownClient);
on("chooseFolderBtn", "click", chooseLocalFolder);
on("authorizedDirectorySelect", "change", selectAuthorizedDirectory);
on("direction", "change", syncDestructiveAvailability);
on("direction", "change", syncBidirectionalAvailability);
on("direction", "change", refreshSyncRecoveryPanels);
on("scheduleMode", "change", syncScheduleControls);
on("destructiveSync", "change", handleDestructiveToggle);
on("bandwidthLimitEnabled", "change", syncBandwidthAvailability);
on("bandwidthLimitMode", "change", syncBandwidthAvailability);
on("confirmForm", "submit", submitConfirmation);
on("confirmCancelBtn", "click", cancelConfirmation);
fields.folderPicker.addEventListener("change", pickFolder);
document.querySelectorAll(".advanced-toggle").forEach((toggle) => {
  toggle.addEventListener("click", () => {
    const open = toggle.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
    toggle.nextElementSibling?.classList.toggle("open", open);
  });
});

syncDestructiveAvailability();
syncBidirectionalAvailability();
syncScheduleControls();
syncBandwidthAvailability();
loadStatus();
setInterval(() => loadStatus({ background: true }), 1000);

async function loadStatus(options = {}) {
  if (options.background && statusRequestInFlight) {
    return statusRequestInFlight;
  }
  const requestId = latestStatusRequestId + 1;
  latestStatusRequestId = requestId;
  const request = loadStatusOnce(requestId);
  statusRequestInFlight = request;
  try {
    return await request;
  } finally {
    if (statusRequestInFlight === request) {
      statusRequestInFlight = null;
    }
  }
}

async function loadStatusOnce(requestId) {
  try {
    const status = await clientApi.getStatus();
    if (requestId < latestAppliedStatusRequestId) {
      return status;
    }
    latestAppliedStatusRequestId = requestId;
    latestStatus = status;
    renderObservedConfig(status);
    renderLiveState(status);
    latestSyncHistory = status.syncHistory || [];
    renderSyncHistory(latestSyncHistory);

    renderProfileSummary(status.profileSummary, status.heartbeat);
    renderEnrollmentStatus(status.enrollment);
    renderRemoteTargetSummary(status.jobs[status.jobs.length - 1] || currentJobDraft || {}, status.profileSummary);
    // 授权可能在导入新 SyncKey 后变化，所以每次状态刷新都重算方向可选项，
    // 不能只在 writeJob 里做——首次导入时 writeJob 可能已经跑过了。
    applySyncDirectionAuthorization();

    if (status.jobs.length && !$("localPath").dataset.loaded) {
      writeJob(status.jobs[status.jobs.length - 1]);
      $("localPath").dataset.loaded = "1";
      void refreshSyncRecoveryPanels();
    }
    return status;
  } catch {
    if (requestId < latestStatusRequestId) {
      return null;
    }
    // 离线只走这一句。逐个重置元素的老写法已经删掉：成功路径渲染的项比 catch 记得
    // 重置的多得多，差额会安静地留成残影，而且每加一个渲染项就重新漏一次。
    renderLiveState(null);
  }
}

// ── 活状态与事件 ──────────────────────────────────────────────
//
// 「活状态」= 现在怎么样（隧道/同步/心跳/进度/计划）。「配置与身份」= 你配置成什么样
// （版本、路径、协议、发布清单、保管箱、同步历史）。两者的离线语义相反：前者必须归未知，
// 后者必须留着，因为排障时用户要看的正是它们，而一次轮询超时就清空只会造成闪烁。
//
// renderLiveState 是活状态的唯一入口，status 为 null 即未知。成功与离线两条路径都走它，
// 所以离线分支不可能漏掉某一项。上一版是在 catch 里逐个重置 6 处，而成功路径渲染 29 处，
// 剩下 23 处保留上次成功轮询的值：客户端已经连不上了，界面还在断言「隧道运行中」。
function renderLiveState(status) {
  const unknown = status === null;
  const sync = unknown ? null : status.processes?.sync || {};

  if (unknown) {
    setBodyState("state-error");
    setPill("binStatus", "未知", "unknown");
    setPill("profileStatus", "未知", "unknown");
    setPill("tunnelStatus", "未知", "unknown");
    setPill("syncStatus", "未知", "unknown");
    setHealth("singboxHealth", "sing-box", null, "客户端离线");
    setHealth("rcloneHealth", "rclone", null, "客户端离线");
  } else {
    updateBodyState(status);
    const binariesReady = status.binaries.singbox.exists && status.binaries.rclone.exists;
    setPill("binStatus", binariesReady ? "组件正常" : "组件缺失", binariesReady ? "good" : "bad");
    const profileStatus = profileStatusDisplay(status.profileImported, status.heartbeat, status.enrollment);
    setPill("profileStatus", profileStatus.pill, profileStatus.state);
    setPill("tunnelStatus", status.processes.singbox.running ? "隧道运行中" : "隧道已停止", status.processes.singbox.running ? "good" : "");
    const syncPill = syncStatusPill(sync);
    setPill("syncStatus", syncPill.text, syncPill.state);
    setHealth("singboxHealth", "sing-box", status.binaries.singbox.exists);
    setHealth("rcloneHealth", "rclone", status.binaries.rclone.exists);
  }

  renderDeviceRecovery(unknown ? null : status.profileImported, unknown ? null : status.heartbeat);
  renderHeartbeat(unknown ? null : status.heartbeat, unknown ? null : status.profileImported);
  renderSyncProgress(unknown ? null : sync.metrics || {}, unknown ? null : status.lastSync);
  renderScheduler(unknown ? null : status.scheduler);

  expireActionForState(unknown ? null : liveStateSignature(status));
}

// 只有「最后一次成功观测到的配置事实」进这里。离线时不清空是刻意的：
// 排障恰恰要看版本号和路径，而它们描述的不是「现在怎么样」。
function renderObservedConfig(status) {
  const successfulHeartbeat = currentSuccessfulHeartbeat(status);
  $("clientVersion").textContent = status.appVersion || status.clientVersion || "-";
  $("clientProtocols").textContent = formatProtocols(status.diagnostics?.protocols);
  $("serverProtocols").textContent = formatProtocols(successfulHeartbeat?.serverDiagnostics?.protocols);
  $("protocolCompatibility").textContent = formatCompatibility(successfulHeartbeat?.compatibility);
  $("compatibilityPolicy").textContent = formatCompatibilityPolicy(successfulHeartbeat?.compatibility?.policy);
  $("clientBuildId").textContent = status.diagnostics?.buildId || "-";
  $("clientBuildTime").textContent = status.diagnostics?.buildTime ? formatShortTime(status.diagnostics.buildTime) : "-";
  $("releaseManifestStatus").textContent = formatReleaseManifest(status.releaseManifest);
  $("releaseManifestBuiltAt").textContent = status.releaseManifest?.builtAt ? formatShortTime(status.releaseManifest.builtAt) : "-";
  $("singboxPath").textContent = status.binaries.singbox.path;
  $("rclonePath").textContent = status.binaries.rclone.path;
  $("dataRoot").textContent = status.paths.dataRoot;
  $("localStateStatus").textContent = formatLocalState(status.safeguards?.localState);
  $("secretVaultStatus").textContent = formatSecretVault(status.safeguards?.secretVault);
}

// 事件（actionMessage）的存活期不得超过它所描述的状态。签名只取「事件在描述的那几件事」：
// 同步状态及是否在跑、隧道是否在跑、心跳结论、配置是否已导入。签名一变，
// 上一条事件描述的那个世界就已经不在了。
function liveStateSignature(status) {
  const sync = status.processes?.sync || {};
  return [
    currentProcessSyncState(sync),
    sync.running ? "running" : "idle",
    status.processes?.singbox?.running ? "tunnel-up" : "tunnel-down",
    status.heartbeat?.ok ? "hb-ok" : status.heartbeat?.remoteErrorCode || "hb-none",
    status.profileImported ? "imported" : "empty"
  ].join("|");
}

// 兜底存活期：有些事件描述的状态根本不会变（比如「已保存任务」），签名比对永远不触发，
// 那条横幅就会长期驻留——和绿色横幅驻留是同一个缺陷的另一副面孔。
// 错误留久一些：用户需要时间读错误码，而错误本身在状态区也另有体现。
const actionMessageTtlMs = 6000;
const errorActionMessageTtlMs = 20000;

function expireActionForState(signature) {
  if (!currentAction) return;
  // 未知（signature 为 null）时一律清空：我们无从判断那条事件是否还成立，
  // 留着它就是在替一个观测不到的状态背书。
  if (signature === null || signature !== currentAction.signature) {
    setAction("");
    return;
  }
  const ttl = currentAction.state === "bad" ? errorActionMessageTtlMs : actionMessageTtlMs;
  if (Date.now() - currentAction.at >= ttl) {
    setAction("");
  }
}

async function checkBinaries() {
  return withBusyAction("checkBinsBtn", async () => {
    $("binOutput").textContent = "检测中...";
    try {
      const result = await clientApi.checkBinaries();
      setPill("binStatus", result.ok ? "组件检测通过" : "组件检测失败", result.ok ? "good" : "bad");
      setHealth("singboxHealth", "sing-box", Boolean(result.singbox.ok), result.singbox.ok ? "" : formatError({ code: result.singbox.errorCode, message: result.singbox.message }));
      setHealth("rcloneHealth", "rclone", Boolean(result.rclone.ok), result.rclone.ok ? "" : formatError({ code: result.rclone.errorCode, message: result.rclone.message }));
      $("binOutput").textContent = [
        formatBinaryCheckSummary(result),
        formatVersion("sing-box", result.singbox),
        formatVersion("rclone", result.rclone)
      ].join("\n\n");
      await loadStatus();
    } catch (error) {
      $("binOutput").textContent = `检测失败：${error.message}`;
    }
  });
}

function formatBinaryCheckSummary(result = {}) {
  return result.ok ? "组件检测通过" : "组件检测失败";
}

async function importEnrollmentChannel() {
  const code = $("enrollmentChannelCode").value.trim();
  if (!code) return setEnrollmentMessage("请粘贴管理员提供的通道配置码。");
  try {
    const result = await clientApi.importEnrollmentChannel({ code });
    renderEnrollmentStatus(result);
    setEnrollmentMessage("通道签名和服务器密钥已验证。请先与管理员核对上方服务器 ID 和指纹。");
  } catch (error) { setEnrollmentMessage(error.message || "通道配置码导入失败。", true); }
}

async function submitEnrollmentRequest() {
  try {
    const result = await clientApi.submitEnrollmentRequest();
    renderEnrollmentStatus(result);
    setEnrollmentMessage("身份申请已提交。请管理员按本次申请签发身份验证码。");
  } catch (error) { setEnrollmentMessage(error.message || "身份申请失败。", true); }
}

async function consumeEnrollmentCode() {
  const codeField = $("enrollmentCode");
  const code = codeField.value.trim();
  if (!code) return setEnrollmentMessage("请输入管理员为本次申请签发的身份验证码。");
  try {
    const result = await clientApi.consumeEnrollmentCode({ code });
    codeField.value = "";
    renderEnrollmentStatus(result);
    setEnrollmentMessage("身份已验证；等待管理员授予同步目录权限。当前尚未具备同步权限。");
  } catch (error) { setEnrollmentMessage(error.message || "身份验证码验证失败。", true); }
}

async function refreshDirectoryAuthorizations() {
  const button = $("refreshDirectoryAuthorizationsBtn");
  if (button) button.disabled = true;
  try {
    const result = await clientApi.refreshDataAuthorizations();
    if (latestStatus) latestStatus.enrollment = result;
    renderEnrollmentStatus(result);
    const ready = Array.isArray(result.authorizedDirectories) && result.authorizedDirectories.length > 0;
    $("directoryAuthorizationStatus").textContent = ready
      ? `${result.authorizedDirectories.length} 个目录已获管理员授权。选择一个远端目录，再选择本地文件夹。`
      : "身份已验证；当前尚无可用目录授权。管理员授权后再检查一次。";
    setAction(ready ? "已取得签名目录授权。" : "身份已验证，等待管理员授予目录权限。", ready ? "good" : "");
  } catch (error) {
    setEnrollmentMessage(formatError(error) || "目录授权检查失败。", true);
  } finally {
    if (button) button.disabled = false;
  }
}

async function repairSelectedConnection() {
  const button = $("repairConnectionBtn");
  const target = $("connectionRepairStatus");
  const relationId = $("authorizedDirectorySelect")?.value || "";
  if (!button || !target) return;
  const selectedJob = currentJobDraft?.storageBackend === "sftp"
    && currentJobDraft.relationId === relationId
    ? currentJobDraft
    : null;
  let context = readConnectionRepairContext();
  if (!context) {
    if (!relationId) {
      setConnectionRepairMessage("请先选择一个管理员授权目录。", true);
      return;
    }
    context = {
      operationId: crypto.randomUUID(),
      relationId,
      ...(selectedJob?.id ? { jobId: selectedJob.id } : {})
    };
    saveConnectionRepairContext(context);
  }
  activeConnectionRepairOperationId = context.operationId;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  setConnectionRepairMessage("连接检查已启动；正在核对组件、本地目录、身份授权和远端访问…");
  try {
    const response = await clientApi.startConnectionRepair(context);
    const operation = await waitForConnectionRepair(response.operation);
    renderConnectionRepairOperation(operation);
    if (isConnectionRepairTerminalUi(operation.status)) {
      clearConnectionRepairContext(context.operationId);
      activeConnectionRepairOperationId = "";
    }
  } catch (error) {
    setConnectionRepairMessage(`${formatError(error)} 如操作可能已提交，再次点击会使用同一操作编号查询，不会新建探针。`, true);
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

async function waitForConnectionRepair(initialOperation) {
  let operation = initialOperation || {};
  renderConnectionRepairOperation(operation);
  for (let attempt = 0; operation.status === "running" && attempt < 120; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 750));
    const operationId = activeConnectionRepairOperationId || operation.operationId;
    const response = await clientApi.getConnectionRepairOperation(operationId);
    operation = response.operation || operation;
    renderConnectionRepairOperation(operation);
  }
  return operation;
}

function renderConnectionRepairOperation(operation = {}) {
  if (operation.status === "running") {
    const stage = {
      queued: "等待检查",
      components_checked: "检查客户端组件",
      local_probe_write_started: "检查本地目录读写",
      local_probe_cleaned: "清理本地临时探针",
      entry_authorized: "核验设备身份和目录授权",
      root_binding_checked: "核验文件服务和既有根标记",
      probe_write_started: "写入随机临时探针",
      probe_written: "读取随机临时探针",
      probe_verified: "验证探针内容",
      probe_cleanup_started: "清理本次临时探针",
      probe_cleaned: "确认临时探针已清理",
      directory_access_checked: "汇总目录访问检查"
    }[operation.stage] || "检查连接";
    setConnectionRepairMessage(`${stage}中…操作编号：${operation.operationId || "已保存"}`);
    return;
  }
  if (operation.status === "succeeded") {
    const checks = operation.checks || {};
    const marker = checks.fileServiceAndRootMarker === "verified"
      ? "文件服务和既有根标记已核验"
      : "同步根标记尚未建立";
    const local = checks.localDirectory === "passed" ? "本地目录通过" : "本地目录未检查";
    const baseline = checks.syncBaseline === "preserved"
      ? "原同步基准保留"
      : checks.syncBaseline === "not_initialized" ? "原同步基准尚未初始化" : "未关联已保存任务";
    setConnectionRepairMessage(
      `连接检查完成：客户端组件通过；${local}；设备身份与授权有效；${marker}；远端目录列出、写入、读回和临时文件清理通过；${baseline}。`
    );
    return;
  }
  const code = operation.errorCode || "connection_repair_list_failed";
  const extra = code === "connection_repair_probe_conflict"
    ? "探针文件归属或内容不匹配，已保留文件并停止。"
    : code === "connection_repair_cleanup_failed"
      ? "本次探针已核实归属但未能清理，请检查授权目录中的临时探针。"
      : operation.status === "needs_attention" ? "检查已停止，请先核对目录状态后再重试。" : "原任务和同步基准未由本次检查重置。";
  setConnectionRepairMessage(`${formatError({ code })} ${extra}`, true);
}

function setConnectionRepairMessage(message, isError = false) {
  const target = $("connectionRepairStatus");
  if (!target) return;
  target.textContent = message;
  target.dataset.state = isError ? "error" : "ok";
}

function readConnectionRepairContext() {
  try {
    const value = JSON.parse(localStorage.getItem(connectionRepairStorageKey) || "null");
    return value && typeof value.operationId === "string" ? value : null;
  } catch {
    return null;
  }
}

function saveConnectionRepairContext(context) {
  try { localStorage.setItem(connectionRepairStorageKey, JSON.stringify(context)); } catch {}
}

function clearConnectionRepairContext(operationId) {
  try {
    if (readConnectionRepairContext()?.operationId === operationId) localStorage.removeItem(connectionRepairStorageKey);
  } catch {}
}

function isConnectionRepairTerminalUi(status) {
  return ["succeeded", "failed", "needs_attention"].includes(status);
}

function selectAuthorizedDirectory() {
  const select = $("authorizedDirectorySelect");
  const relationId = select?.value || "";
  const directory = latestStatus?.enrollment?.authorizedDirectories?.find((item) => item.relationId === relationId);
  if (!directory) return;
  const previous = currentJobDraft || {};
  currentJobDraft = {
    ...(previous.storageBackend === "sftp" ? previous : {}),
    storageBackend: "sftp",
    relationId,
    directoryDisplayName: directory.displayName,
    direction: "bidirectional"
  };
  fields.direction.value = "bidirectional";
  syncBidirectionalAvailability();
  applySyncDirectionAuthorization();
  syncScheduleControls();
  renderRemoteTargetSummary(currentJobDraft, latestStatus?.profileSummary);
  setAction(`已选择管理员授权目录“${directory.displayName}”。`, "good");
}

function renderEnrollmentStatus(enrollment = {}) {
  const target = $("enrollmentTrustSummary");
  const phase = enrollment.phase || "not-started";
  renderEmptyEnrollmentState(phase);
  renderEnrollmentSteps(phase);
  if (!target) return;
  const directoryPanel = $("directoryAuthorizationPanel");
  if (directoryPanel) directoryPanel.hidden = phase !== "identity-verified-awaiting-directory-authorization";
  const requestButton = $("submitEnrollmentRequestBtn");
  if (requestButton) requestButton.disabled = phase !== "channel-verified";
  const verifyStep = $("enrollmentVerifyStep");
  if (verifyStep) verifyStep.hidden = phase !== "request-pending";
  renderAuthorizedDirectories(enrollment);
  const hasAuthorizedDirectories = Array.isArray(enrollment.authorizedDirectories)
    && enrollment.authorizedDirectories.length > 0;
  if (hasAuthorizedDirectories) {
    renderAuthorizedContent("ready");
    $("authorizedContentValue").textContent = "本机身份已验证。同步内容由管理员签名授权，不能在客户端自行指定。";
  } else if (phase === "identity-verified-awaiting-directory-authorization") {
    renderAuthorizedContent("missing");
    $("authorizedContentValue").textContent = "身份已验证；目录权限由管理员授予。获得授权后可在这里选择同步目录。";
    renderRemoteTargetSummary({}, null);
  }
  const statusLabel = phase === "identity-verified-awaiting-directory-authorization"
    ? hasAuthorizedDirectories ? "目录授权已就绪" : "身份已验证，等待目录授权"
    : phase === "request-pending" ? "身份申请待管理员签发验证码"
      : phase === "channel-verified" ? "通道已验证，等待提交身份申请"
        : phase === "local-state-error" ? "本地接入状态文件异常，已停止接入操作；请按恢复说明修复后再继续" : "尚未接入";
  target.replaceChildren();
  const status = document.createElement("div");
  status.className = "info-item";
  status.innerHTML = '<span class="k">接入状态</span><span class="v"></span>';
  status.querySelector(".v").textContent = statusLabel;
  target.append(status);
  if (enrollment.requestId) {
    const request = document.createElement("div");
    request.className = "info-item";
    request.innerHTML = '<span class="k">申请识别码</span><span class="v"></span>';
    request.querySelector(".v").textContent = enrollment.requestId.slice(-8).toUpperCase();
    target.append(request);
  }
  if (enrollment.serverId || enrollment.serverKeyFingerprint) {
    const details = document.createElement("details");
    details.className = "hint";
    const summary = document.createElement("summary");
    summary.textContent = "连接信息（首次接入时与管理员核对）";
    details.append(summary);
    const info = document.createElement("div");
    info.className = "info-list";
    renderSummaryRows(info, [
      ["服务器 ID", enrollment.serverId || ""],
      ["签名密钥 ID", enrollment.signingKeyId || ""],
      ["服务器密钥 SHA-256", enrollment.serverKeyFingerprint || ""]
    ]);
    details.append(info);
    target.append(details);
  }
}

function renderEnrollmentSteps(phase) {
  const stepByPhase = {
    "not-started": 0,
    "channel-verified": 1,
    "request-pending": 2,
    "identity-verified-awaiting-directory-authorization": 3
  };
  const currentStep = stepByPhase[phase];
  document.querySelectorAll("[data-enrollment-step]").forEach((step, index) => {
    step.classList.toggle("complete", Number.isInteger(currentStep) && index < currentStep);
    step.classList.toggle("current", Number.isInteger(currentStep) && index === currentStep);
    if (Number.isInteger(currentStep) && index === currentStep) {
      step.setAttribute("aria-current", "step");
    } else {
      step.removeAttribute("aria-current");
    }
  });
}

function renderEmptyEnrollmentState(phase) {
  const heading = $("emptyEnrollmentHeading");
  const description = $("emptyEnrollmentDescription");
  const button = $("emptyEnrollmentBtn");
  const copy = {
    "not-started": [
      "开始两码安全接入",
      "粘贴管理员提供的通道配置码，提交身份申请，再输入一次性身份验证码验证设备。",
      "开始两码接入"
    ],
    "channel-verified": [
      "通道已验证",
      "下一步提交身份申请；管理员签发一次性身份验证码后，再回来完成设备验证。",
      "继续身份接入"
    ],
    "request-pending": [
      "身份申请已提交",
      "等待管理员为本次申请签发一次性身份验证码。",
      "查看接入状态"
    ]
  }[phase] || [
    "继续两码安全接入",
    "在设置中查看身份接入状态。",
    "查看接入状态"
  ];
  if (heading) heading.textContent = copy[0];
  if (description) description.textContent = copy[1];
  if (button) button.textContent = copy[2];
}

function renderAuthorizedDirectories(enrollment = {}) {
  const select = $("authorizedDirectorySelect");
  if (!select) return;
  const directories = Array.isArray(enrollment.authorizedDirectories) ? enrollment.authorizedDirectories : [];
  const selectedRelationId = currentJobDraft?.storageBackend === "sftp" ? currentJobDraft.relationId : "";
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = directories.length ? "选择管理员已授权的目录" : "检查目录授权后显示";
  select.append(placeholder);
  for (const item of directories) {
    const option = document.createElement("option");
    option.value = item.relationId;
    option.textContent = item.displayName;
    select.append(option);
  }
  select.disabled = directories.length === 0;
  if (directories.some((item) => item.relationId === selectedRelationId)) select.value = selectedRelationId;
}

function setEnrollmentMessage(message, isError = false) {
  const target = $("enrollmentStatusMessage");
  if (!target) return;
  target.textContent = message;
  target.dataset.state = isError ? "error" : "ok";
}

async function saveProfile() {
  const code = fields.claimCode.value.trim();
  if (!code) {
    setAction("请先在设置里粘贴服务端生成的 SyncKey。", "bad");
    return;
  }
  const shortCode = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code);
  const server = fields.claimServer.value.trim();
  if (shortCode && !server) {
    const message = "短码加入需要填写服务端地址（错误码：import_code_invalid）。";
    $("profileSummary").textContent = message;
    setAction(message, "bad");
    return;
  }

  return withBusyAction("saveProfileBtn", async () => {
    setAction("正在兑换 SyncKey...");
    $("profileSummary").textContent = "正在导入服务端配置...";
    try {
      const result = await clientApi.importProfile({ code, ...(shortCode ? { server } : {}) }, { timeoutMs: profileImportRequestTimeoutMs });
      renderProfileSummaryFromProfile(result.profile);
      fields.claimCode.value = "";
      setAction("服务端配置已导入。", "good");
      await loadStatus();
    } catch (error) {
      const message = formatProfileImportError(error);
      $("profileSummary").textContent = message;
      setAction(message, "bad");
    }
  });
}

async function startTunnel() {
  return withBusyAction("startTunnelBtn", async () => {
    try {
      await clientApi.startTunnel();
      setAction("隧道已启动。", "good");
      await loadStatus();
      await refreshLogs();
    } catch (error) {
      setAction(`隧道启动失败：${formatError(error)}`, "bad");
    }
  });
}

async function stopTunnel() {
  return withBusyAction("stopTunnelBtn", async () => {
    try {
      await clientApi.stopTunnel();
      setAction("隧道已停止。");
      await loadStatus();
    } catch (error) {
      setAction(`停止隧道失败：${formatError(error)}`, "bad");
    }
  });
}

async function saveJob() {
  return withBusyAction("saveJobBtn", async () => {
    let confirmed;
    try {
      confirmed = await readConfirmedJob("save");
    } catch (error) {
      setAction(`保存失败：${formatError(error)}`, "bad");
      return;
    }
    if (!confirmed) return;
    try {
      const saved = await clientApi.saveJob({
        job: confirmed.job,
        confirmCompatibilityWarning: confirmed.confirmCompatibilityWarning,
        confirmDestructiveSync: confirmed.confirmDestructiveSync
      });
      writeJob(saved.job);
      setAction("同步任务已保存。", "good");
      await loadStatus();
      await refreshSyncRecoveryPanels();
    } catch (error) {
      setAction(`保存失败：${formatError(error)}`, "bad");
    }
  }, "job-sync");
}

async function refreshRecoveryVersions() {
  const panel = $("recoveryPanel");
  const target = $("recoveryVersions");
  const jobId = currentJobDraft?.id;
  const contextKey = syncRecoveryPanelContextKey();
  if (!panel || !target) return;
  const available = Boolean(jobId && currentJobDraft?.direction === "bidirectional");
  panel.hidden = !available;
  if (!available) return;
  target.textContent = "正在检查已保存版本…";
  try {
    const result = await clientApi.listRecoveryVersions(jobId);
    if (contextKey !== syncRecoveryPanelContextKey()) return;
    renderRecoveryVersions(jobId, result.versions || []);
    $("recoveryStatus").textContent = "";
  } catch (error) {
    if (contextKey !== syncRecoveryPanelContextKey()) return;
    target.textContent = "暂时无法读取恢复版本。";
    $("recoveryStatus").textContent = formatError(error);
  }
}

function renderRecoveryVersions(jobId, versions) {
  const target = $("recoveryVersions");
  target.replaceChildren();
  if (!versions.length) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "尚无已完成的同步版本。每轮双向同步完成后会出现可恢复文件。";
    target.append(empty);
    return;
  }
  for (const version of versions.slice().reverse()) {
    const group = document.createElement("section");
    group.className = "recovery-version";
    const heading = document.createElement("strong");
    heading.textContent = `${new Date(version.createdAt).toLocaleString()} · ${version.status === "completed" ? "已完成" : "未完成，可查看已保存内容"}`;
    group.append(heading);
    for (const file of version.files || []) {
      const row = document.createElement("div");
      row.className = "recovery-file";
      const description = document.createElement("span");
      description.textContent = `${file.side === "path1" ? "本地" : "远端"} · ${file.path}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "btn-sm";
      button.textContent = "还原为新文件…";
      button.addEventListener("click", () => restoreRecoveryFile(jobId, version, file));
      row.append(description, button);
      group.append(row);
    }
    if (!(version.files || []).length) {
      const none = document.createElement("p");
      none.className = "hint";
      none.textContent = "本轮没有产生需要恢复的旧版本。";
      group.append(none);
    }
    target.append(group);
  }
}

async function refreshFirstBisyncConflictOperations() {
  const panel = $("firstBisyncRecoveryPanel");
  const target = $("firstBisyncOperations");
  const job = currentJobDraft || {};
  const contextKey = syncRecoveryPanelContextKey(job);
  const available = Boolean(job.id && job.direction === "bidirectional" && job.storageBackend === "sftp" && job.relationId);
  if (!available) {
    panel.hidden = true;
    target.replaceChildren();
    selectedFirstBisyncOperationId = "";
    return;
  }
  target.textContent = "正在检查首次冲突保存记录…";
  try {
    const operations = await clientApi.listFirstBisyncConflictOperations({ job });
    if (contextKey !== syncRecoveryPanelContextKey()) return;
    renderFirstBisyncConflictOperations(job, operations || []);
    $("firstBisyncRecoveryStatus").textContent = "";
  } catch (error) {
    if (contextKey !== syncRecoveryPanelContextKey()) return;
    panel.hidden = false;
    target.textContent = "无法读取首次冲突保存记录。";
    $("firstBisyncRecoveryStatus").textContent = formatError(error);
  }
}

function syncRecoveryPanelContextKey(job = currentJobDraft) {
  return JSON.stringify({
    id: job?.id || "",
    relationId: job?.relationId || "",
    rootId: job?.syncRelation?.rootId || "",
    localPath: job?.localPath || "",
    direction: job?.direction || ""
  });
}

function refreshSyncRecoveryPanels() {
  const contextKey = syncRecoveryPanelContextKey();
  if (syncRecoveryPanelsRequestInFlight) {
    if (syncRecoveryPanelsRequestInFlight.contextKey === contextKey) {
      return syncRecoveryPanelsRequestInFlight.promise;
    }
    return syncRecoveryPanelsRequestInFlight.promise.catch(() => {}).then(() => refreshSyncRecoveryPanels());
  }
  const request = (async () => {
    await refreshRecoveryVersions();
    await refreshFirstBisyncConflictOperations();
  })();
  const trackedRequest = request.finally(() => {
    if (syncRecoveryPanelsRequestInFlight?.promise === trackedRequest) {
      syncRecoveryPanelsRequestInFlight = null;
    }
  });
  syncRecoveryPanelsRequestInFlight = { contextKey, promise: trackedRequest };
  return trackedRequest;
}

function renderFirstBisyncConflictOperations(job, operations) {
  const panel = $("firstBisyncRecoveryPanel");
  const target = $("firstBisyncOperations");
  target.replaceChildren();
  const ordered = operations.slice().sort((left, right) => Date.parse(right.createdAt || "") - Date.parse(left.createdAt || ""));
  if (!ordered.length) {
    panel.hidden = true;
    selectedFirstBisyncOperationId = "";
    return;
  }
  panel.hidden = false;
  for (const operation of ordered) {
    const row = document.createElement("div");
    row.className = "first-bisync-operation";
    const summary = document.createElement("div");
    const state = operation.status === "saved" ? "双方版本已保存" : "冲突保存未完成";
    const fileCount = Array.isArray(operation.conflicts) ? operation.conflicts.length : 0;
    const timestamp = operation.savedAt || operation.createdAt;
    summary.textContent = `${state} · ${fileCount} 个冲突文件${timestamp ? ` · ${new Date(timestamp).toLocaleString()}` : ""}`;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn-sm";
    button.textContent = operation.status === "saved" ? "继续首次初始化" : "恢复冲突保存";
    button.disabled = !operation.operationId;
    button.addEventListener("click", () => resumeFirstBisyncConflictOperation(job, operation));
    row.append(summary, button);
    target.append(row);
  }
}

async function resumeFirstBisyncConflictOperation(job, operation) {
  const target = $("firstBisyncRecoveryStatus");
  const operations = $("firstBisyncOperations");
  const buttons = operations.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  target.textContent = operation.status === "saved" ? "正在核对已保存的冲突操作…" : "正在从本机受保护记录恢复冲突保存…";
  try {
    const saved = await clientApi.resumeFirstBisyncConflictSave({ job, operationId: operation.operationId });
    selectedFirstBisyncOperationId = saved.operationId;
    target.textContent = "冲突双方版本已保存。点击“开始同步”确认后继续首次双向初始化。";
    await refreshFirstBisyncConflictOperations();
  } catch (error) {
    target.textContent = formatError(error);
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function restoreRecoveryFile(jobId, version, file) {
  const destinationPath = `${file.path}.recovered-${version.runId.slice(0, 8)}`;
  try {
    const preview = await clientApi.previewRecoveryRestore(jobId, {
      runId: version.runId, side: file.side, path: file.path, destinationPath
    });
    const confirmed = await requestConfirmation({
      title: "还原为新文件",
      body: [`来源：${file.side === "path1" ? "本地" : "远端"} / ${file.path}`,
        `目标：${preview.destinationPath}`, `SHA-256：${preview.sourceSha256}`,
        `预览有效期至：${formatRecoveryExpiry(preview.expiresAt)}`,
        "目标文件已存在时系统会拒绝还原，不会覆盖。"].join("\n"),
      submitText: "还原文件"
    });
    if (!confirmed) {
      await clientApi.cancelRecoveryRestore(jobId, preview.previewId).catch(() => {});
      $("recoveryStatus").textContent = "已取消还原；本地文件未更改。";
      return;
    }
    const result = await clientApi.restoreRecoveryVersion(jobId, preview.previewId);
    $("recoveryStatus").textContent = `已还原到 ${result.destinationPath}（SHA-256 ${result.sourceSha256}）。`;
    await refreshRecoveryVersions();
  } catch (error) {
    $("recoveryStatus").textContent = formatError(error);
  }
}

function formatRecoveryExpiry(value) {
  const timestamp = Date.parse(value || "");
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "时间未提供";
}

async function previewJob() {
  return withBusyAction("previewBtn", async () => {
    $("previewOutput").textContent = "生成中...";
    try {
      const job = readJob();
      const result = await clientApi.previewSync({ job });
      lastPreviewJobFingerprint = jobPreviewFingerprint(job);
      $("previewOutput").textContent = [
        "# Schedule: " + result.schedule.text,
        "# Next run: " + (result.schedule.nextRun || "manual"),
        "# Remote path: " + result.rclone.remotePath,
        "",
        "# rclone remote config",
        result.rclone.remoteConfig.displayCommand,
        "",
        "# rclone sync command",
        result.rclone.displayCommand
      ].join("\n");
    } catch (error) {
      $("previewOutput").textContent = `生成失败：${formatError(error)}`;
    }
  });
}

async function runSync() {
  return withBusyAction("runSyncBtn", async () => {
    let confirmed;
    try {
      confirmed = await readConfirmedJob("run");
    } catch (error) {
      setAction(`同步启动失败：${formatError(error)}`, "bad");
      return;
    }
    if (!confirmed) return;
    if (lastPreviewJobFingerprint !== jobPreviewFingerprint(confirmed.job)) {
      const sftpDirectory = confirmed.job.storageBackend === "sftp" && confirmed.job.relationId
        ? latestStatus?.enrollment?.authorizedDirectories?.find(directory => directory.relationId === confirmed.job.relationId)
        : null;
      const isAuthorizedDirectoryJob = Boolean(confirmed.job.storageBackend === "sftp" && confirmed.job.relationId);
      const previewConfirmed = await requestConfirmation({
        title: "确认同步范围",
        body: isAuthorizedDirectoryJob
          ? [
              `服务器文件夹：${confirmed.job.directoryDisplayName || sftpDirectory?.displayName || "管理员授权目录"}`,
              `本地路径：${confirmed.job.localPath || "未选择"}`,
              `同步方向：${formatDirection(confirmed.job.direction)}`
            ].join("\n")
          : [
              "当前任务尚未按最新填写内容生成预览。",
              `本地：${confirmed.job.localPath || "未选择"}`,
              `方向：${formatDirection(confirmed.job.direction)}`,
              `同步空间：${formatSyncSpaceName(latestStatus?.profileSummary?.syncSpace)}`,
              "建议先生成 rclone 命令预览，确认最终同步范围。"
            ].join("\n"),
        submitText: isAuthorizedDirectoryJob ? "确认并继续" : "仍然开始同步"
      });
      if (!previewConfirmed) {
        setAction(isAuthorizedDirectoryJob ? "已取消同步。" : "已取消同步。请先生成预览并确认同步范围。", "bad");
        return;
      }
    }
    try {
      let safetyPlanId = "";
      if (confirmed.job.direction === "bidirectional" || confirmed.job.destructiveSync) {
        let safetyPlan = await clientApi.createSyncSafetyPlan({ job: confirmed.job });
        if (!safetyPlan.deletions.allowed) {
          setAction(`同步已阻止：预估删除 ${safetyPlan.deletions.files} 个文件，超出当前保护上限。`, "bad");
          return;
        }
        if (safetyPlan.bidirectional.initializationRequired) {
          let savedConflicts;
          if (selectedFirstBisyncOperationId) {
            savedConflicts = await clientApi.resumeFirstBisyncConflictSave({
              job: confirmed.job,
              operationId: selectedFirstBisyncOperationId
            });
          } else {
            const conflictPreview = await clientApi.previewFirstBisyncConflicts({ job: confirmed.job });
            const conflictItems = conflictPreview.conflicts || [];
            const conflictList = conflictItems.length
              ? conflictItems.slice(0, 30).map(item => `• ${item.path}\n  本机 ${item.localSize} 字节 · SHA-256 ${item.localHash.slice(0, 16)}…\n  远端 ${item.remoteSize} 字节 · SHA-256 ${item.remoteHash.slice(0, 16)}…`).join("\n")
                + (conflictItems.length > 30 ? `\n…还有 ${conflictItems.length - 30} 项` : "")
              : "未发现同名不同内容的文件。初始化前会再次扫描；若文件有变化，系统会停止并要求重新检查。";
            const saveConflicts = await requestConfirmation({
              title: "先保留首次冲突的双方版本",
              body: [
                conflictItems.length
                  ? "系统将把下列文件的本机版和远端版分别复制到本机同步目录中的可见冲突副本。副本名带本次操作编号和来源；不会覆盖已有文件。"
                  : "预览未发现同名不同内容的文件。系统仍会保存本次检查结果，并在初始化前重新核对文件状态。",
                conflictItems.length ? "初始化后，这些副本会随正常同步传到两端。" : "",
                "",
                conflictList
              ].join("\n"),
              requiredText: "保存双方版本",
              submitText: "保存并继续"
            });
            if (!saveConflicts) return;
            savedConflicts = await clientApi.saveFirstBisyncConflicts({ job: confirmed.job, previewId: conflictPreview.previewId });
          }
          selectedFirstBisyncOperationId = savedConflicts.operationId;
          const initialized = await requestConfirmation({
            title: "初始化双向同步",
            body: `首次双向同步将以“${formatBisyncInitialMode(confirmed.job.safety?.bidirectional?.initialMode)}”建立基准。首次冲突操作 ${savedConflicts.operationId} 已保存或恢复；初始化前会重新核对当前冲突集合和内容哈希，若文件变化会停止。`,
            requiredText: "初始化双向",
            submitText: "初始化"
          });
          if (!initialized) {
            setAction("双向基准尚未初始化；首次冲突副本仍保留，可从设置中的待继续操作恢复。", "warn");
            void refreshFirstBisyncConflictOperations();
            return;
          }
          await clientApi.initializeBidirectionalSync({
            job: confirmed.job,
            safetyPlanId: safetyPlan.id,
            confirmCompatibilityWarning: confirmed.confirmCompatibilityWarning,
            confirmBidirectionalInitialization: true,
            conflictOperationId: savedConflicts.operationId
          });
          selectedFirstBisyncOperationId = "";
          safetyPlan = await clientApi.createSyncSafetyPlan({ job: confirmed.job });
          await refreshFirstBisyncConflictOperations();
          setAction("首次冲突检查已完成，双向同步基准已初始化。", "good");
        }
        safetyPlanId = safetyPlan.id;
      }
      await clientApi.runSync({
        job: confirmed.job,
        confirmCompatibilityWarning: confirmed.confirmCompatibilityWarning,
        confirmDestructiveSync: confirmed.confirmDestructiveSync,
        safetyPlanId
      });
      setAction("同步已开始。", "good");
      await loadStatus();
      await refreshLogs();
    } catch (error) {
      setAction(formatSyncStartError(error), "bad");
      if (error.code === "request_timeout") {
        await Promise.allSettled([loadStatus(), refreshLogs()]);
      }
    }
  }, "job-sync");
}

function formatSyncStartError(error = {}) {
  if (error.code === "request_timeout") {
    return "同步启动等待超时：客户端仍可能在后台准备任务，请稍后刷新同步状态。";
  }
  return `同步启动失败：${formatError(error)}`;
}

async function stopSync() {
  return withBusyAction("stopSyncBtn", async () => {
    try {
      const result = await clientApi.stopSync();
      if (result?.running || result?.stopTimedOut) {
        setAction("停止请求已发送，同步仍在停止中。", "warn");
      } else {
        setAction("同步已停止。");
      }
      await loadStatus();
      await refreshLogs();
    } catch (error) {
      setAction(`停止失败：${formatError(error)}`, "bad");
    }
  });
}

async function refreshLogs() {
  return withBusyAction("refreshLogsBtn", async () => {
    try {
      const logs = await clientApi.getLogs();
      $("logOutput").textContent = [
        "## sing-box",
        logs.singbox || "(empty)",
        "",
        "## rclone",
        logs.rclone || "(empty)"
      ].join("\n");
    } catch (error) {
      $("logOutput").textContent = `读取日志失败：${formatError(error)}`;
    }
  });
}

async function exportDiagnostics() {
  return withBusyAction("exportDiagnosticsBtn", async () => {
    try {
      const result = await clientApi.exportDiagnostics();
      const filename = result.filename || `sfsc-client-diagnostics-${Date.now()}.json`;
      downloadJson(filename, result.bundle || result);
      setAction("脱敏诊断包已导出。", "good");
    } catch (error) {
      setAction(`导出诊断包失败：${formatError(error)}`, "bad");
    }
  });
}

function downloadJson(filename, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function refreshSyncHistory() {
  return withBusyAction("refreshHistoryBtn", async () => {
    const target = $("syncHistoryList");
    if (target) {
      target.textContent = "刷新中...";
    }
    try {
      const result = await clientApi.getSyncHistory();
      latestSyncHistory = result.history || [];
      renderSyncHistory(latestSyncHistory);
      setAction("同步历史已刷新。", "good");
    } catch (error) {
      if (target) {
        target.textContent = `读取历史失败：${formatError(error)}`;
      }
      setAction(`读取历史失败：${formatError(error)}`, "bad");
    }
  });
}

async function copyLogs() {
  const text = $("logOutput").textContent || "";
  try {
    await navigator.clipboard.writeText(text);
    setAction("日志已复制。", "good");
  } catch {
    setAction("复制日志失败，当前系统不允许访问剪贴板。", "bad");
  }
}

async function copySupportSummary() {
  const text = buildSupportSummary(latestStatus, latestSyncHistory);
  try {
    await navigator.clipboard.writeText(text);
    setAction("支持摘要已复制，可直接发给支持人员。", "good");
  } catch {
    setAction("复制支持摘要失败，当前系统不允许访问剪贴板。", "bad");
  }
  return text;
}

function buildSupportSummary(status = latestStatus, syncHistory = latestSyncHistory) {
  const releaseManifest = status?.releaseManifest || {};
  const heartbeat = status?.heartbeat || {};
  const lastSync = status?.lastSync || (Array.isArray(syncHistory) ? syncHistory[0] : null) || {};
  const syncMetrics = status?.processes?.sync?.metrics || {};
  const lines = [
    "SFSC support summary",
    `appVersion=${supportValue(status?.appVersion || status?.clientVersion)}`,
    `buildId=${supportValue(status?.diagnostics?.buildId)}`,
    `buildTime=${supportValue(status?.diagnostics?.buildTime)}`,
    `releaseManifest=${releaseManifest.ok ? "ok" : supportValue(releaseManifest.errorCode, "unknown")}`,
    `releaseManifestVersion=${supportValue(releaseManifest.version)}`,
    `releaseManifestBuiltAt=${supportValue(releaseManifest.builtAt)}`,
    `localState=${status?.safeguards?.localState?.ok ? "ok" : supportValue(status?.safeguards?.localState?.errorCode, "unknown")}`,
    `secretVault=${status?.safeguards?.secretVault?.ok ? "ok" : supportValue(status?.safeguards?.secretVault?.errorCode, "unknown")}`,
    `binaries=${supportBinaryStatus(status?.binaries)}`,
    `profileImported=${Boolean(status?.profileSummary || status?.profile)}`,
    `heartbeat=${heartbeat.ok ? "ok" : supportErrorStatus(heartbeat.errorCode || heartbeat.remoteErrorCode)}`,
    `syncState=${supportValue(syncMetrics.syncState || status?.sync?.state)}`,
    `lastSync=${supportValue(lastSync.status)}`,
    `lastSyncErrorCode=${supportValue(lastSync.errorCode)}`,
    "diagnosticExport=settings -> export diagnostics"
  ];
  return lines.join("\n");
}

function supportValue(value, fallback = "n/a") {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : fallback;
  }
  return String(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[=]/g, ":")
    .slice(0, 120);
}

function supportErrorStatus(errorCode) {
  return errorCode ? `error:${supportValue(errorCode)}` : "unknown";
}

function supportBinaryStatus(binaries = {}) {
  const singboxOk = Boolean(binaries?.singbox?.exists);
  const rcloneOk = Boolean(binaries?.rclone?.exists);
  if (singboxOk && rcloneOk) return "ok";
  const missing = [];
  if (!singboxOk) missing.push("sing-box");
  if (!rcloneOk) missing.push("rclone");
  return `missing:${missing.join(",")}`;
}

async function shutdownClient() {
  return withBusyAction("shutdownBtn", async () => {
    try {
      await clientApi.shutdown();
      setPill("syncStatus", "客户端已退出", "");
      setAction("客户端已退出。", "good");
    } catch (error) {
      setAction(`退出客户端失败：${formatError(error)}`, "bad");
    }
  });
}

async function chooseLocalFolder() {
  if (window.sfscDesktop?.pickFolder) {
    try {
      const result = await window.sfscDesktop.pickFolder();
      if (!result?.canceled && result?.path) {
        fields.localPath.value = result.path;
        setAction("已选择本地文件夹。", "good");
      }
      return;
    } catch (error) {
      setAction(`选择文件夹失败：${formatError(error)}`, "bad");
    }
  }
  fields.localPath.focus();
  setAction("当前模式无法读取真实文件夹路径，请粘贴完整本地路径。", "bad");
}

function readJob() {
  const base = currentJobDraft && typeof currentJobDraft === "object" ? currentJobDraft : {};
  const selectedRelationId = $("authorizedDirectorySelect")?.value || (base.storageBackend === "sftp" ? base.relationId : "");
  return {
    ...base,
    ...(selectedRelationId ? { storageBackend: "sftp", relationId: selectedRelationId } : {}),
    direction: readDirectionField(),
    localPath: fields.localPath.value,
    destructiveSync: fields.direction.value !== "bidirectional" && fields.destructiveSync.checked,
    safety: fields.direction.value === "bidirectional"
      ? { bidirectional: { initialMode: fields.bisyncInitialMode.value || "newer" } }
      : undefined,
    bandwidthLimit: readBandwidthLimit(),
    schedule: readSchedule()
  };
}

// 方向是服务端授权的一部分，不是本地偏好。这里再挡一次，避免用户改 DOM 后
// 把一个 MinIO 一定会拒的方向送进执行链路，只留下一条难懂的 AccessDenied。
function readDirectionField() {
  const value = fields.direction.value;
  const allowed = allowedSyncDirections();
  if (allowed && !allowed.includes(value)) {
    const error = new Error("这台设备在当前同步空间没有该方向的授权，请向管理员索取新的 SyncKey。");
    error.code = "sync_direction_not_authorized";
    throw error;
  }
  return value;
}

// null 表示「未知授权」：legacy/离线 profile 或还没导入，此时不施加额外限制。
function allowedSyncDirections() {
  if (currentJobDraft?.storageBackend === "sftp" || $("authorizedDirectorySelect")?.value) return ["bidirectional"];
  const directions = latestStatus?.profileSummary?.authorization?.directions;
  return Array.isArray(directions) && directions.length > 0 ? directions : null;
}

function jobPreviewFingerprint(job = {}) {
  return JSON.stringify({
    direction: job.direction || "",
    localPath: job.localPath || "",
    destructiveSync: Boolean(job.destructiveSync),
    bandwidthLimit: job.bandwidthLimit || "off",
    schedule: job.schedule || {}
  });
}

async function readConfirmedJob(action) {
  const job = readJob();
  let confirmCompatibilityWarning = false;
  let confirmDestructiveSync = false;
  const compatibility = currentSyncCompatibility();
  if (["save", "run"].includes(action) && compatibility?.policy?.syncRun === "warn") {
    const confirmedCompatibility = await requestConfirmation({
      title: "确认协议兼容性风险",
      body: `${formatCompatibility(compatibility)}。${formatSyncCompatibilityWarning(compatibility)}`,
      submitText: action === "save" ? "继续保存" : "继续同步"
    });
    if (!confirmedCompatibility) {
      return null;
    }
    confirmCompatibilityWarning = true;
  }
  if (action === "save" && job.schedule?.mode !== "manual" && hasAutomaticScheduleChanged(job)) {
    const authorized = await requestConfirmation({
      title: "授权自动同步",
      body: [
        `计划：${describeLocalSchedule(job.schedule)}`,
        "每次运行前会重新检查两端目录、同步基准和删除保护上限。",
        "检查失败或超出保护上限时，本轮会停止并显示失败状态。",
        "任务运行期间的新触发会合并，不会并行启动。"
      ].join("\n"),
      submitText: "确认并保存计划"
    });
    if (!authorized) return null;
  }
  if (!job.destructiveSync) {
    return { job, confirmCompatibilityWarning, confirmDestructiveSync };
  }

  const confirmed = await requestConfirmation({
    title: action === "save" ? "保存镜像同步任务" : "启动镜像同步",
    body: destructiveSyncConfirmationBody(job),
    requiredText: "镜像同步",
    submitText: action === "save" ? "保存任务" : "开始同步"
  });
  confirmDestructiveSync = Boolean(confirmed);
  return confirmed ? { job, confirmCompatibilityWarning, confirmDestructiveSync } : null;
}

function hasAutomaticScheduleChanged(job) {
  const saved = currentJobDraft?.schedule || { mode: "manual" };
  return scheduleFingerprint(job.schedule) !== scheduleFingerprint(saved);
}

function scheduleFingerprint(schedule = {}) {
  const mode = schedule?.mode || "manual";
  if (mode === "interval") return `interval:${Number(schedule.intervalMinutes)}`;
  if (mode === "daily") return `daily:${schedule.time || "02:00"}`;
  return mode;
}

function currentSyncCompatibility() {
  return currentSuccessfulHeartbeat()?.compatibility || null;
}

function currentSuccessfulHeartbeat(status = latestStatus) {
  return status?.heartbeat?.ok
    ? status.heartbeat
    : status?.lastSuccessfulHeartbeat?.ok
      ? status.lastSuccessfulHeartbeat
      : null;
}

function readSchedule() {
  if (fields.scheduleMode.value === "interval") {
    const intervalMinutes = Number(fields.scheduleInterval.value);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
      throw new Error("请填写 1 到 1440 之间的计划间隔分钟。");
    }
    return { mode: "interval", intervalMinutes };
  }
  if (fields.scheduleMode.value === "daily") {
    const time = fields.scheduleTime.value || "02:00";
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      throw new Error("请填写有效的每天执行时间。");
    }
    return { mode: "daily", time };
  }
  if (fields.scheduleMode.value === "startup") {
    return { mode: "startup" };
  }
  return { mode: "manual" };
}

function writeJob(job) {
  currentJobDraft = toClientJobDraft(job);
  const directorySelect = $("authorizedDirectorySelect");
  if (directorySelect && currentJobDraft.storageBackend === "sftp" && currentJobDraft.relationId) {
    directorySelect.value = currentJobDraft.relationId;
  }
  fields.direction.value = currentJobDraft.direction || fields.direction.value;
  fields.localPath.value = currentJobDraft.localPath || fields.localPath.value;
  fields.destructiveSync.checked = Boolean(currentJobDraft.destructiveSync);
  fields.bisyncInitialMode.value = currentJobDraft.safety?.bidirectional?.initialMode || "newer";
  writeBandwidthLimit(currentJobDraft.bandwidthLimit || "off");
  writeSchedule(currentJobDraft.schedule || { mode: "manual" });
  renderRemoteTargetSummary(currentJobDraft, latestStatus?.profileSummary);
  applySyncDirectionAuthorization();
  syncDestructiveAvailability();
  syncBidirectionalAvailability();
  syncScheduleControls();
  syncBandwidthAvailability();
}

// 只展示服务端授权的方向；只有一个方向时不给选择器，因为那不是一个选择。
function applySyncDirectionAuthorization() {
  const allowed = allowedSyncDirections();
  const hint = $("directionFixedHint");
  for (const option of fields.direction.options) {
    option.hidden = Boolean(allowed) && !allowed.includes(option.value);
    option.disabled = option.hidden;
  }
  if (!allowed) {
    fields.direction.disabled = false;
    if (hint) {
      hint.hidden = true;
      hint.textContent = "";
    }
    return;
  }
  if (!allowed.includes(fields.direction.value)) {
    fields.direction.value = allowed[0];
  }
  const single = allowed.length === 1;
  fields.direction.disabled = single;
  if (hint) {
    hint.hidden = !single;
    hint.textContent = single
      ? `该同步空间只授权${formatDirection(allowed[0])}，方向由服务端决定。`
      : "";
  }
}

function toClientJobDraft(job = {}) {
  if (!job || typeof job !== "object") {
    return {};
  }
  const draft = {};
  for (const field of clientJobDraftFields) {
    if (Object.hasOwn(job, field) && job[field] !== undefined) {
      draft[field] = job[field];
    }
  }
  return draft;
}

async function handleDestructiveToggle() {
  if (!fields.destructiveSync.checked) {
    syncDestructiveAvailability();
    return;
  }
  const confirmed = await requestConfirmation({
    title: "开启镜像同步",
    body: "开启后上传/下载会使用 rclone sync，目标端多余文件会被删除。",
    requiredText: "删除目标端多余文件",
    submitText: "开启"
  });
  if (!confirmed) {
    fields.destructiveSync.checked = false;
  }
  syncDestructiveAvailability();
}

function syncDestructiveAvailability() {
  const isBidirectional = fields.direction.value === "bidirectional";
  fields.destructiveSync.disabled = isBidirectional;
  if (isBidirectional) {
    fields.destructiveSync.checked = false;
    $("destructiveSyncHint").textContent = "双向同步使用 rclone bisync，不使用镜像删除开关。";
    return;
  }
  $("destructiveSyncHint").textContent = fields.destructiveSync.checked
    ? "镜像同步已开启，启动或保存前会再次确认。"
    : "上传/下载默认使用 copy，不会删除目标端多余文件。";
}

function syncBidirectionalAvailability() {
  $("bisyncInitialModeRow").hidden = fields.direction.value !== "bidirectional";
}

function formatBisyncInitialMode(value) {
  return { local: "以本地为准", remote: "以远端为准", newer: "保留较新文件" }[value] || "保留较新文件";
}

function writeSchedule(schedule = {}) {
  if (schedule.mode === "interval") {
    fields.scheduleMode.value = "interval";
    fields.scheduleInterval.value = validInteger(schedule.intervalMinutes, 30, 1, 1440);
    return;
  }
  if (schedule.mode === "daily") {
    fields.scheduleMode.value = "daily";
    fields.scheduleTime.value = /^([01]\d|2[0-3]):([0-5]\d)$/.test(schedule.time || "") ? schedule.time : "02:00";
    return;
  }
  if (schedule.mode === "startup") {
    fields.scheduleMode.value = "startup";
    return;
  }
  fields.scheduleMode.value = "manual";
}

function syncScheduleControls() {
  const mode = fields.scheduleMode.value;
  const intervalMode = mode === "interval";
  const dailyMode = mode === "daily";
  setVisibility("scheduleIntervalRow", intervalMode);
  setVisibility("scheduleTimeRow", dailyMode);
  fields.scheduleInterval.hidden = !intervalMode;
  fields.scheduleInterval.disabled = !intervalMode;
  fields.scheduleTime.hidden = !dailyMode;
  fields.scheduleTime.disabled = !dailyMode;
}

function describeLocalSchedule(schedule = {}) {
  if (schedule.mode === "interval") return `每 ${schedule.intervalMinutes} 分钟`;
  if (schedule.mode === "daily") return `每天 ${schedule.time || "02:00"}`;
  if (schedule.mode === "startup") return "客户端启动时";
  return "手动";
}

function readBandwidthLimit() {
  if (!fields.bandwidthLimitEnabled.checked) {
    return "off";
  }

  const value = Number(fields.bandwidthLimitValue.value);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("请填写 1 以上的整数带宽限制。");
  }

  const fixed = `${value}${fields.bandwidthLimitUnit.value}`;
  if (fields.bandwidthLimitMode.value !== "schedule") {
    return fixed;
  }

  const startTime = fields.bandwidthLimitStart.value;
  const endTime = fields.bandwidthLimitEnd.value;
  if (!isValidTime(startTime) || !isValidTime(endTime)) {
    throw new Error("请填写有效的带宽限制开始和结束时间。");
  }
  if (startTime === endTime) {
    throw new Error("带宽限制开始和结束时间不能相同。");
  }
  return `${startTime},${fixed} ${endTime},off`;
}

function writeBandwidthLimit(value) {
  const text = String(value || "").trim();
  const schedule = text.match(/^(\d{2}:\d{2}),([1-9]\d*)\s*([kKmMgG])\s+(\d{2}:\d{2}),off$/i);
  if (schedule && isValidTime(schedule[1]) && isValidTime(schedule[4]) && schedule[1] !== schedule[4]) {
    fields.bandwidthLimitEnabled.checked = true;
    fields.bandwidthLimitMode.value = "schedule";
    fields.bandwidthLimitValue.value = schedule[2];
    fields.bandwidthLimitUnit.value = schedule[3] === "k" || schedule[3] === "K" ? "k" : schedule[3].toUpperCase();
    fields.bandwidthLimitStart.value = schedule[1];
    fields.bandwidthLimitEnd.value = schedule[4];
    syncBandwidthAvailability();
    return;
  }

  const match = text.match(/^([1-9]\d*)\s*([kKmMgG])$/);
  if (!match) {
    fields.bandwidthLimitEnabled.checked = false;
    fields.bandwidthLimitMode.value = "fixed";
    fields.bandwidthLimitValue.value = "";
    fields.bandwidthLimitUnit.value = "M";
    fields.bandwidthLimitStart.value = "08:00";
    fields.bandwidthLimitEnd.value = "18:00";
    syncBandwidthAvailability();
    return;
  }

  fields.bandwidthLimitEnabled.checked = true;
  fields.bandwidthLimitMode.value = "fixed";
  fields.bandwidthLimitValue.value = match[1];
  fields.bandwidthLimitUnit.value = match[2] === "k" || match[2] === "K" ? "k" : match[2].toUpperCase();
  fields.bandwidthLimitStart.value = "08:00";
  fields.bandwidthLimitEnd.value = "18:00";
  syncBandwidthAvailability();
}

function syncBandwidthAvailability() {
  const enabled = fields.bandwidthLimitEnabled.checked;
  const scheduled = enabled && fields.bandwidthLimitMode.value === "schedule";
  setVisibility("bandwidthScheduleRow", scheduled);
  fields.bandwidthLimitMode.disabled = !enabled;
  fields.bandwidthLimitValue.disabled = !enabled;
  fields.bandwidthLimitUnit.disabled = !enabled;
  fields.bandwidthLimitStart.disabled = !scheduled;
  fields.bandwidthLimitEnd.disabled = !scheduled;
  if (enabled && !fields.bandwidthLimitValue.value) {
    fields.bandwidthLimitValue.value = "10";
  }
  if (enabled && !fields.bandwidthLimitStart.value) {
    fields.bandwidthLimitStart.value = "08:00";
  }
  if (enabled && !fields.bandwidthLimitEnd.value) {
    fields.bandwidthLimitEnd.value = "18:00";
  }
}

function isValidTime(value) {
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ""));
}

// metrics 为 null 表示「此刻无从观测」（客户端离线）。必须显式分支：默认参数 `= {}`
// 只拦 undefined 不拦 null，直接往下走会在 metrics.speedMbps 抛 TypeError；
// 而把 null 当成 {} 更糟——那会渲染出「0.00 Mbps / 0%」，把未知说成「静止且无进度」。
function renderSyncProgress(metrics, lastSync = null) {
  if (metrics === null) {
    $("speedValue").textContent = "-";
    $("progressFill").style.width = "0%";
    $("progressValue").textContent = "未知";
    $("transferredValue").textContent = "-";
    $("lastSyncValue").textContent = "-";
    $("currentFileValue").textContent = "-";
    return;
  }
  metrics = metrics || {};
  const speed = Number(metrics.speedMbps || 0);
  const scanning = metrics.syncState === "syncing" && metrics.phase === "scanning";
  const alreadyCurrent = metrics.phase === "completed"
    && !metrics.transferredSizeText
    && !metrics.transferredText;
  const percent = scanning ? null : alreadyCurrent ? 100 : clampPercent(metrics.progressPercent);
  const currentFile = metrics.currentFile || "-";
  const currentFileSuffix = metrics.currentFileProgressPercent != null
    ? ` (${formatPercent(metrics.currentFileProgressPercent)}${metrics.currentFileSizeText ? ` / ${metrics.currentFileSizeText}` : ""})`
    : "";

  $("speedValue").textContent = `${speed.toFixed(2)} Mbps`;
  $("progressFill").style.width = percent == null ? "0%" : `${percent}%`;
  $("progressValue").textContent = alreadyCurrent
    ? "内容已是最新"
    : scanning
    ? "正在扫描并计算总量"
    : percent == null ? statusText(metrics.syncState) : `${formatPercent(percent)}${metrics.eta ? ` · ETA ${metrics.eta}` : ""}`;
  $("transferredValue").textContent = alreadyCurrent
    ? "0 B / 0 B"
    : scanning ? "-" : metrics.transferredSizeText || metrics.transferredText || "-";
  $("lastSyncValue").textContent = formatLastSync(lastSync || metrics.lastRun);
  $("currentFileValue").textContent = `${currentFile}${currentFile === "-" ? "" : currentFileSuffix}`;
}

function renderScheduler(scheduler) {
  const target = $("schedulerValue");
  if (!target) return;
  // null 与 {} 在这里绝不能同义：{} 渲染成「未启用」，那是一句关于配置的断言，
  // 而离线时我们并不知道计划是否启用。
  if (scheduler === null) {
    target.textContent = "未知";
    return;
  }
  scheduler = scheduler || {};
  if (!scheduler.enabled) {
    target.textContent = "未启用";
    return;
  }
  if (scheduler.lastError) {
    target.textContent = `调度异常：${formatError({ code: scheduler.lastError })}`;
    return;
  }
  if (!scheduler.jobs?.length) {
    target.textContent = "手动";
    return;
  }
  target.textContent = scheduler.nextRun
    ? `下次 ${formatScheduleTime(scheduler.nextRun)}`
    : "等待下一次计划";
}

function formatScheduleTime(value) {
  if (value === "on-startup") {
    return "启动后";
  }
  return formatShortTime(value);
}

function renderSyncHistory(history = []) {
  const target = $("syncHistoryList");
  if (!target) return;

  const allRuns = Array.isArray(history) ? history.slice(0, 20) : [];
  renderHistorySummary(allRuns);
  const runs = filterSyncHistory(allRuns);
  target.textContent = "";
  if (!runs.length) {
    const empty = document.createElement("div");
    empty.className = "history-empty";
    empty.textContent = allRuns.length ? "没有匹配的同步历史" : "暂无同步历史";
    target.append(empty);
    return;
  }

  for (const run of runs) {
    const item = document.createElement("article");
    const statusClass = syncRunPresentationClass(run);
    item.className = `history-item ${statusClass}`;
    item.setAttribute("role", "listitem");

    const head = document.createElement("div");
    head.className = "history-title-row";

    const title = document.createElement("div");
    title.className = "history-title";

    const badge = document.createElement("span");
    badge.className = `history-status ${statusClass}`;
    badge.textContent = syncRunBadgeText(run);

    const name = document.createElement("strong");
    name.textContent = formatSyncRunTitle(run);

    title.append(badge, name);

    const time = document.createElement("time");
    time.className = "history-time";
    const timeValue = run.finishedAt || run.startedAt || "";
    if (timeValue) {
      time.dateTime = timeValue;
    }
    time.textContent = formatShortTime(timeValue) || "-";

    head.append(title, time);

    const meta = document.createElement("div");
    meta.className = "history-meta";
    for (const text of syncRunMeta(run)) {
      const span = document.createElement("span");
      span.textContent = text;
      meta.append(span);
    }

    const details = document.createElement("div");
    details.className = "history-detail";
    details.textContent = syncRunDetail(run);

    item.append(head, meta, details);
    target.append(item);
  }
}

function renderHistorySummary(history = []) {
  const target = $("historySummary");
  if (!target) return;
  const summary = summarizeSyncHistory(history);
  if (!summary.total) {
    target.textContent = "暂无同步历史";
    return;
  }
  const parts = [
    `共 ${summary.total} 次`,
    `成功 ${summary.success} 次`,
    `失败 ${summary.error} 次`,
    `冲突 ${summary.conflict} 次`,
    summary.peakSpeed ? `峰值 ${summary.peakSpeed}` : "",
    summary.lastRunAt ? `最近 ${formatShortTime(summary.lastRunAt)}` : ""
  ].filter(Boolean);
  target.textContent = parts.join(" · ");
}

function summarizeSyncHistory(history = []) {
  const summary = {
    total: 0,
    success: 0,
    error: 0,
    conflict: 0,
    running: 0,
    stopped: 0,
    peakSpeed: "",
    peakSpeedMbps: 0,
    lastRunAt: ""
  };
  for (const run of Array.isArray(history) ? history : []) {
    summary.total += 1;
    if (run.status === "success") summary.success += 1;
    if (run.status === "error") summary.error += 1;
    if (run.status === "running") summary.running += 1;
    if (run.status === "stopped") summary.stopped += 1;
    if (hasDisplayableConflicts(run)) summary.conflict += 1;
    const speed = syncRunSpeedMbps(run);
    if (speed > summary.peakSpeedMbps) {
      summary.peakSpeedMbps = speed;
      summary.peakSpeed = run.rawSpeed || `${speed.toFixed(2)} Mb/s`;
    }
    const time = run.finishedAt || run.startedAt || "";
    if (time && (!summary.lastRunAt || new Date(time).getTime() > new Date(summary.lastRunAt).getTime())) {
      summary.lastRunAt = time;
    }
  }
  return summary;
}

function syncRunSpeedMbps(run = {}) {
  if (Number.isFinite(Number(run.speedMbps)) && Number(run.speedMbps) > 0) {
    return Number(run.speedMbps);
  }
  return parseSpeedMbps(run.rawSpeed);
}

function parseSpeedMbps(value = "") {
  const raw = String(value).trim();
  const match = raw.match(/^([\d.]+)\s*([KMGT]?)(?:i?B|b)\/s$/i);
  if (!match) return 0;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return 0;
  const unit = match[2].toUpperCase();
  const bytesMultiplier = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }[unit] || 1;
  const isBytes = /(?:i?B)\/s$/.test(raw);
  const bitsPerSecond = isBytes ? number * bytesMultiplier * 8 : number * bytesMultiplier;
  return bitsPerSecond / 1000 / 1000;
}

function filterSyncHistory(history = []) {
  const status = $("historyStatusFilter")?.value || "all";
  const query = ($("historySearch")?.value || "").trim().toLowerCase();
  return history.filter((run) => {
    const statusKey = syncRunStatusClass(run.status);
    const conflict = hasDisplayableConflicts(run);
    if (status === "conflict") {
      return conflict && (!query || syncRunSearchText(run).includes(query));
    }
    if (status !== "all" && statusKey !== status) {
      return false;
    }
    if (!query) {
      return true;
    }
    return syncRunSearchText(run).includes(query);
  });
}

function syncRunSearchText(run = {}) {
  const job = run.job || {};
  const conflicts = Array.isArray(run.conflicts?.files) ? run.conflicts.files : [];
  return [
    run.id,
    run.status,
    run.errorCode,
    run.error,
    run.currentFile,
    run.localPath,
    run.remotePath,
    run.rawSpeed,
    run.transferredSizeText,
    job.name,
    job.direction,
    job.localPath,
    job.remotePrefix,
    ...conflicts
  ].filter(Boolean).join(" ").toLowerCase();
}

function pickFolder() {
  const first = fields.folderPicker.files && fields.folderPicker.files[0];
  if (!first) return;
  if (first.path) {
    fields.localPath.value = first.path;
    setAction("已选择本地文件夹。", "good");
  }
}

function renderProfileSummary(summary, heartbeat = null) {
  const target = $("profileSummary");
  if (!summary) {
    target.textContent = "未导入旧版 SyncKey 配置；两码身份与目录授权可独立使用。";
    renderAuthorizedContent("missing");
    return;
  }
  renderSummaryRows(target, [
    ["连接", "已导入 SyncKey"],
    ["同步内容", "已按授权范围配置"],
    ["心跳", profileHeartbeatSummary(heartbeat)],
    ["协议", "等待兼容性检查"]
  ]);
  renderAuthorizedContent(authorizationState(heartbeat));
}

function renderProfileSummaryFromProfile(profile) {
  renderSummaryRows($("profileSummary"), [
    ["连接", "已导入 SyncKey"],
    ["同步内容", "已按授权范围配置"],
    ["隧道", "已配置"],
    ["协议", "正在检查"]
  ]);
  renderAuthorizedContent("ready");
  renderRemoteTargetSummary();
}

function renderRemoteTargetSummary(job = {}, profileSummary = null) {
  const target = $("remoteTargetSummary");
  if (!target) return;
  if (job.storageBackend === "sftp" || (currentJobDraft?.storageBackend === "sftp" && $("authorizedDirectorySelect")?.value)) {
    const directoryName = job.directoryDisplayName || currentJobDraft?.directoryDisplayName
      || latestStatus?.enrollment?.authorizedDirectories?.find((item) => item.relationId === job.relationId)?.displayName
      || "管理员授权目录";
    renderSummaryRows(target, [
      ["远端目录", directoryName],
      ["授权方向", "双向同步"],
      ["连接方式", "设备专用安全通道"],
      ["执行方式", "手动运行并使用双向基准"]
    ]);
    $("syncSpaceLabel").textContent = "服务器文件夹";
    $("syncSpaceSummary").textContent = directoryName;
    return;
  }
  $("syncSpaceLabel").textContent = "同步空间";
  const summary = profileSummary || latestStatus?.profileSummary;
  if (summary) {
    renderSummaryRows(target, [
      ["同步空间", formatSyncSpaceName(summary.syncSpace)],
      ["用途", formatSyncSpaceMode(summary.syncSpace?.mode)],
      ["本设备角色", formatSyncSpaceRole(summary.authorization?.role)],
      ["授权方向", formatAuthorizedDirections(summary.authorization?.directions)],
      ["执行方式", "预览后再开始"]
    ]);
    renderSyncSpaceLabel(summary);
    return;
  }
  renderSummaryRows(target, [
    ["状态", "选择管理员授权的目录后显示"]
  ]);
  renderSyncSpaceLabel(null);
}

function renderSyncSpaceLabel(summary) {
  const label = $("syncSpaceSummary");
  if (!label) return;
  if (!summary) {
    label.textContent = "选择管理员授权的目录。";
    return;
  }
  const syncId = summary.syncSpace?.syncId;
  label.textContent = syncId
    ? `${syncId}（${formatSyncSpaceMode(summary.syncSpace?.mode)}）`
    : formatSyncSpaceName(summary.syncSpace);
}

// 同步空间在界面上只有一个名字：服务端签发的 syncId。
// 这里是唯一的兜底文案来源——曾经三处各写一句（「未绑定（离线配置）」
// 「未绑定同步空间（离线配置）」「SyncKey 授权目录」），同一状态三种说法，
// 正是「同步空间」这个概念在客户端说不清的原因。
function formatSyncSpaceName(syncSpace) {
  return syncSpace?.syncId || "未绑定同步空间（离线配置）";
}

function formatSyncSpaceMode(mode) {
  return { backup: "备份", distribution: "分发", collaboration: "协作" }[mode] || "未知";
}

function formatSyncSpaceRole(role) {
  return { owner: "所有者", writer: "写入者", reader: "只读" }[role] || "未知";
}

function formatAuthorizedDirections(directions) {
  if (!Array.isArray(directions) || directions.length === 0) {
    return "未知（离线配置）";
  }
  return directions.map(formatDirection).join("、");
}

function profileHeartbeatSummary(heartbeat = null) {
  if (!heartbeat) return "等待上报";
  if (heartbeat.ok) return "正常";
  if (["device_disabled", "device_not_found"].includes(heartbeat.remoteErrorCode)) return "不可用";
  return "上报失败";
}

function authorizationState(heartbeat = null) {
  if (heartbeat?.remoteErrorCode === "device_disabled") return "disabled";
  if (heartbeat?.remoteErrorCode === "device_not_found") return "unregistered";
  return "ready";
}

function renderAuthorizedContent(authorization = "missing") {
  const state = $("authorizedContentState");
  const value = $("authorizedContentValue");
  if (!state || !value) return;
  const display = {
    ready: ["badge ok", "授权已就绪", "此设备只能同步管理员签名授权的内容。"],
    disabled: ["badge err", "设备已停用", "服务端已停用此设备。重新启用后才能继续同步。"],
    unregistered: ["badge err", "设备未登记", "服务端找不到此设备。请联系管理员检查设备接入状态。"],
    missing: ["badge neutral", "等待管理员目录授权", "同步内容由管理员签名授权。客户端不能自行指定目录。"]
  }[authorization] || ["badge neutral", "等待管理员目录授权", "同步内容由管理员签名授权。客户端不能自行指定目录。"];
  state.className = display[0];
  state.textContent = display[1];
  value.textContent = display[2];
}

function destructiveSyncConfirmationBody(job = {}) {
  return [
    "镜像同步会删除目标端多余文件。",
    `本地：${job.localPath || "未选择"}`,
    `方向：${formatDirection(job.direction)}`,
    "同步内容：当前 SyncKey 已授权内容"
  ].join("\n");
}

function formatDirection(value) {
  const labels = {
    upload: "上传",
    download: "下载",
    bidirectional: "双向同步"
  };
  return labels[value] || "未选择";
}

function renderSummaryRows(target, rows) {
  target.innerHTML = "";
  for (const [label, value] of rows) {
    const row = document.createElement("div");
    row.className = "summary-row";
    row.append(document.createElement("span"), document.createElement("code"));
    row.children[0].textContent = label;
    row.children[1].textContent = value;
    target.append(row);
  }
}

function setPill(id, text, state) {
  const el = $(id);
  el.textContent = text;
  el.className = state ? `pill ${state}` : "pill";
}

function syncStatusPill(sync = {}) {
  const state = currentProcessSyncState(sync);
  if (state === "stopping") {
    return { text: "正在停止", state: "warn" };
  }
  if (sync.running || state === "syncing") {
    return { text: "同步中", state: "good" };
  }
  if (state === "error") {
    return { text: "同步失败", state: "bad" };
  }
  return { text: "空闲", state: "" };
}

// ok 三态：true=正常，false=异常，null=未知。用 null 而不是再加一个布尔参数，
// 因为「未知」不是「异常」的一种程度——客户端连不上时我们对 sing-box 是否在跑
// 毫无观测，画成红叉会让用户去修一个可能并不存在的故障。
function setHealth(id, name, ok, detail = "") {
  const el = $(id);
  const wide = el.classList.contains("wide");
  const unknown = ok === null;
  const glyph = unknown ? "?" : ok ? "✓" : "×";
  const tone = unknown ? "unknown" : ok ? "good" : "bad";
  el.textContent = `${glyph} ${name}${detail ? ` · ${detail}` : ""}`;
  el.className = `health-card ${tone}${wide ? " wide" : ""}`;
}

// heartbeat 为 null 表示客户端本身不可达，这与「心跳失败」不同：心跳失败是我们
// 成功问到了客户端、客户端说它连不上服务端；null 是我们连客户端都没问到，
// 对服务端可达性没有任何观测。
function renderHeartbeat(heartbeat, profileImported) {
  if (profileImported === null) {
    setPill("heartbeatStatus", "未知", "unknown");
    setHealth("heartbeatHealth", "服务端心跳", null, "客户端离线");
    return;
  }
  if (!profileImported) {
    setPill("heartbeatStatus", "心跳不适用", "");
    const health = $("heartbeatHealth");
    health.textContent = "— 服务端心跳 · 两码接入不使用旧心跳";
    health.className = "health-card neutral";
    return;
  }
  if (heartbeat === null) {
    setPill("heartbeatStatus", "未知", "unknown");
    setHealth("heartbeatHealth", "服务端心跳", null, "客户端离线");
    return;
  }
  const status = heartbeatDisplay(heartbeat, profileImported);
  setPill("heartbeatStatus", status.pill, status.state);
  setHealth("heartbeatHealth", "服务端心跳", status.ok, status.detail);
}

function renderDeviceRecovery(profileImported, heartbeat) {
  const target = $("deviceRecoveryNotice");
  if (!target) return;
  // 离线时收起提示而不是留着：这条提示会指导用户去重新导入 SyncKey，
  // 而基于陈旧心跳给出的操作建议可能把用户推向一次没必要的重新导入。
  if (heartbeat === null) {
    target.hidden = true;
    target.textContent = "";
    return;
  }
  const message = deviceRecoveryMessage(profileImported, heartbeat);
  target.hidden = !message;
  target.textContent = message || "";
}

function deviceRecoveryMessage(profileImported, heartbeat) {
  if (!profileImported) {
    return "";
  }
  if (heartbeat?.remoteErrorCode === "device_disabled") {
    return "当前设备已被服务端停用。请在服务端控制台重新启用此设备，再等待心跳恢复。";
  }
  if (heartbeat?.remoteErrorCode === "device_not_found") {
    return "服务端找不到当前设备。请联系管理员检查设备接入状态。";
  }
  return "";
}

function profileStatusDisplay(profileImported, heartbeat, enrollment = {}) {
  if (!profileImported) {
    const phase = enrollment?.phase || "not-started";
    if (phase === "channel-verified") {
      return { pill: "通道已验证", state: "good" };
    }
    if (phase === "request-pending") {
      return { pill: "等待管理员验证码", state: "warn" };
    }
    if (phase === "identity-verified-awaiting-directory-authorization") {
      return Array.isArray(enrollment.authorizedDirectories) && enrollment.authorizedDirectories.length
        ? { pill: "目录授权已就绪", state: "good" }
        : { pill: "等待目录授权", state: "warn" };
    }
    if (phase === "local-state-error") {
      return { pill: "接入状态异常", state: "bad" };
    }
    return {
      pill: "等待两码接入",
      state: ""
    };
  }
  if (heartbeat?.remoteErrorCode === "device_disabled") {
    return {
      pill: "设备已停用",
      state: "bad"
    };
  }
  if (heartbeat?.remoteErrorCode === "device_not_found") {
    return {
      pill: "设备未登记",
      state: "bad"
    };
  }
  return {
    pill: "配置已导入",
    state: "good"
  };
}

function heartbeatDisplay(heartbeat, profileImported) {
  if (!profileImported) {
    return {
      ok: false,
      pill: "心跳未配置",
      state: "",
      detail: "未导入配置"
    };
  }
  if (!heartbeat) {
    return {
      ok: false,
      pill: "心跳待上报",
      state: "",
      detail: "等待上报"
    };
  }
  const time = formatShortTime(heartbeat.sentAt);
  if (heartbeat.ok) {
    const deviceDetail = formatHeartbeatDevice(heartbeat.device);
    return {
      ok: true,
      pill: "心跳正常",
      state: "good",
      detail: [time || "已上报", deviceDetail].filter(Boolean).join(" · ")
    };
  }
  const message = heartbeat.errorCode
    ? formatError({ code: heartbeat.errorCode, message: heartbeat.message || heartbeat.error })
    : heartbeat.message || heartbeat.error || "上报失败";
  const remoteMessage = heartbeat.remoteErrorCode
    ? formatError({ code: heartbeat.remoteErrorCode, message: heartbeat.remoteErrorCode })
    : "";
  const details = [message];
  if (remoteMessage && remoteMessage !== message) {
    details.push(`服务端：${remoteMessage}`);
  }
  if (time) {
    details.push(time);
  }
  return {
    ok: false,
    pill: "心跳失败",
    state: "bad",
    detail: details.join(" · ")
  };
}

function formatHeartbeatDevice(device) {
  if (!device) {
    return "";
  }
  const parts = [];
  if (device.status) {
    parts.push(device.status);
  }
  if (device.bucket || device.prefix) {
    parts.push("已授权同步内容");
  }
  const currentFile = device.sync?.currentFile || device.sync?.lastRun?.currentFile || "";
  if (currentFile) {
    parts.push(`当前文件：${currentFile}`);
  }
  return parts.join(" · ");
}

// 写入事件时记下它所描述的状态签名和时间，让 expireActionForState 能判断
// 「它描述的那件事还成立吗」。空文本即清空，不记签名——否则清空动作自己会变成一条事件。
function setAction(text, state) {
  const el = $("actionMessage");
  el.textContent = text;
  el.className = state ? `notice ${state}` : "notice";
  currentAction = text
    ? { signature: latestStatus ? liveStateSignature(latestStatus) : null, state: state || "", at: Date.now() }
    : null;
}

async function withBusyAction(buttonId, action, groupName = "") {
  const groupButtons = groupName === "job-sync" ? ["saveJobBtn", "runSyncBtn"] : [];
  const elements = [...new Set([buttonId, ...groupButtons])].map($).filter(Boolean);
  if ((groupName && activeBusyActionGroups.has(groupName))
    || elements.some((element) => element.dataset.busy === "1")) {
    return null;
  }
  if (groupName) activeBusyActionGroups.add(groupName);
  const priorStates = elements.map((element) => ({
    element,
    disabled: element.disabled,
    ariaBusy: element.getAttribute?.("aria-busy") ?? null,
    hadBusy: Object.prototype.hasOwnProperty.call(element.dataset, "busy"),
    busy: element.dataset.busy
  }));
  for (const { element } of priorStates) {
    element.dataset.busy = "1";
    element.disabled = true;
    element.setAttribute("aria-busy", "true");
  }
  try {
    return await action();
  } finally {
    for (const state of priorStates) {
      state.element.disabled = state.disabled;
      if (state.ariaBusy === null) state.element.removeAttribute("aria-busy");
      else state.element.setAttribute("aria-busy", state.ariaBusy);
      if (state.hadBusy) state.element.dataset.busy = state.busy;
      else delete state.element.dataset.busy;
    }
    if (groupName) activeBusyActionGroups.delete(groupName);
  }
}

function setVisibility(id, visible) {
  const el = $(id);
  if (!el) return;
  el.hidden = !visible;
  el.classList.toggle("open", Boolean(visible));
}

function setBodyState(nextState) {
  document.body.classList.remove("state-empty", "state-normal", "state-running", "state-stopping", "state-error");
  document.body.classList.add(nextState);
}

function updateBodyState(status = {}) {
  const sync = status.processes?.sync || {};
  const syncState = currentProcessSyncState(sync);
  const enrollmentPhase = status.enrollment?.phase || "not-started";
  if (enrollmentPhase === "local-state-error") {
    setBodyState("state-error");
    return;
  }
  if (!status.profileImported && enrollmentPhase !== "identity-verified-awaiting-directory-authorization") {
    setBodyState("state-empty");
    return;
  }
  if (sync.stopping || sync.stopRequested || syncState === "stopping") {
    setBodyState("state-stopping");
    return;
  }
  if (sync.running || syncState === "running" || syncState === "syncing") {
    setBodyState("state-running");
    return;
  }
  if (syncState === "error" || status.lastSync?.status === "error") {
    setBodyState("state-error");
    return;
  }
  setBodyState("state-normal");
}

function currentProcessSyncState(sync = {}) {
  return String(sync.metrics?.syncState || sync.syncState || sync.state || "").toLowerCase();
}

function requestConfirmation(options = {}) {
  if (pendingConfirmation) {
    pendingConfirmation.resolve(null);
  }
  const gate = $("confirmGate");
  const textLabel = $("confirmTextLabel");
  const textInput = $("confirmTextInput");
  const submitBtn = $("confirmSubmitBtn");

  $("confirmTitle").textContent = options.title || "确认操作";
  $("confirmBody").textContent = options.body || "";
  textLabel.hidden = !options.requiredText;
  textLabel.textContent = options.requiredText ? `请输入 ${options.requiredText} 以确认：` : "";
  textInput.hidden = !options.requiredText;
  textInput.value = "";
  textInput.placeholder = options.requiredText ? `输入 ${options.requiredText}` : "";
  submitBtn.textContent = options.submitText || "确认";
  setConfirmMessage("");

  gate.hidden = false;
  gate.classList.add("open");
  pendingConfirmation = {
    requiredText: options.requiredText || "",
    resolve: null
  };

  setTimeout(() => {
    if (options.requiredText) {
      textInput.focus();
    } else {
      submitBtn.focus();
    }
  }, 0);

  return new Promise((resolve) => {
    pendingConfirmation.resolve = resolve;
  });
}

function submitConfirmation(event) {
  event.preventDefault();
  if (!pendingConfirmation) return;

  const requiredText = pendingConfirmation.requiredText;
  const actualText = $("confirmTextInput").value.trim();
  if (requiredText && actualText !== requiredText) {
    setConfirmMessage(`请输入 ${requiredText} 以确认。`);
    return;
  }

  const resolve = pendingConfirmation.resolve;
  closeConfirmation();
  resolve({ confirmed: true, text: actualText || requiredText });
}

function cancelConfirmation() {
  if (!pendingConfirmation) return;
  const resolve = pendingConfirmation.resolve;
  closeConfirmation();
  resolve(null);
}

function closeConfirmation() {
  pendingConfirmation = null;
  const gate = $("confirmGate");
  gate.classList.remove("open");
  gate.hidden = true;
  setConfirmMessage("");
}

function setConfirmMessage(message) {
  const target = $("confirmMessage");
  target.hidden = !message;
  target.textContent = message || "";
}

function formatError(error) {
  const copy = {
    directory_root_input_invalid: "目录路径无效，请重新选择同步目录。",
    directory_root_io_failed: "无法检查同步目录，请检查磁盘和目录权限。",
    directory_root_link_denied: "同步目录包含不受支持的链接，已停止访问。",
    directory_root_marker_collision: "目录保护标记位置已有其他内容，已停止操作。",
    directory_root_marker_mismatch: "目录保护标记与登记目录不匹配，请核对目录。",
    directory_root_marker_missing: "目录保护标记缺失，已停止同步以免误判为删除。",
    directory_root_missing: "同步目录不可用，请连接原磁盘或挂载后重试。",
    directory_root_mount_changed: "同步目录挂载已变化，请核对原目录后再继续。",
    directory_root_mount_unavailable: "同步目录所在磁盘或挂载当前不可用。",
    directory_root_not_ready: "同步目录尚未就绪，请检查磁盘与读写权限。",
    directory_root_overlap: "本地目录与同步目录重叠，无法建立安全关系。",
    directory_root_permission_denied: "当前用户没有同步目录所需的读写权限。",
    directory_root_record_invalid: "已登记的目录保护信息无效，需要管理员检查。",
    directory_root_registration_incomplete: "目录登记尚未完成，当前未开放同步。",
    directory_root_registration_review_required: "目录状态需要人工核对，当前未执行同步。",
    directory_root_replaced: "同步目录已被替换，请核对原目录后重新连接。",
    directory_root_space_insufficient: "同步目录可用空间不足。",
    directory_root_space_unavailable: "无法确认同步目录剩余空间，已停止操作。",
    connection_repair_busy: "同步或另一项连接修复正在进行，请完成后再检查。",
    first_sync_conflict_review_required: "首次冲突保护需要人工复核；未执行初始化。请检查本地同步目录、远端权限和未完成操作后重试。",
    first_sync_conflict_set_changed: "预览后文件发生变化。未执行初始化，请重新预览并保存当前冲突双方版本。",
    first_sync_conflict_save_required: "初始化前必须先预览并保存双方版本。",
    first_sync_conflict_command_failed: "首次冲突保护操作失败；未执行初始化。请检查服务端状态后重新预览。",
    first_sync_conflict_preview_expired: "首次冲突预览已过期；未执行初始化。请重新扫描并复核冲突。",
    first_sync_conflict_preview_required: "初始化前必须先完成首次冲突预览。",
    first_sync_conflict_source_changed: "冲突来源文件已变化；未执行初始化。请重新扫描并复核双方版本。",
    first_sync_conflict_stage_invalid: "首次冲突保护暂存区无效；未执行初始化，请联系管理员检查服务端状态。",
    first_sync_conflict_target_exists: "恢复目标已存在；未覆盖现有文件，也未执行初始化。",
    first_sync_conflict_target_invalid: "冲突恢复目标路径无效；未执行初始化，请重新选择目录。",
    first_sync_conflict_trusted_relation_required: "首次冲突扫描缺少可信目录授权关系；未执行初始化，请检查任务授权和目录选择。",
    first_sync_conflict_scan_failed: "首次冲突扫描失败；未执行初始化。请检查通道连接与目录权限后重试。",
    first_sync_conflict_staging_invalid: "首次冲突保护暂存内容无效；未执行初始化，请联系管理员检查服务端状态。",
    connection_repair_invalid: "连接修复操作与所选授权目录或本地任务不匹配。",
    connection_repair_list_failed: "无法读取授权目录，请检查网络、通道和目录权限。",
    connection_repair_write_failed: "无法创建目录探针；未初始化同步基准，也未执行同步。",
    connection_repair_probe_conflict: "探针路径已有无法确认归属的文件；已停止并保留该文件。",
    connection_repair_cleanup_failed: "本次临时探针未能清理，请管理员检查授权目录。",
    connection_repair_read_failed: "目录探针无法读回，请检查文件服务和目录权限。",
    enrollment_channel_stale: "通道配置已过期或不再匹配，请从 N1 管理页重新导出配置码。",
    enrollment_reconfigure_busy: "正在应用新的通道配置，请稍后查看操作状态。",
    enrollment_reconfigure_conflict: "重新配置请求编号已用于不同内容，请重新开始操作。",
    enrollment_reconfigure_invalid: "新的通道配置无效，请重新检查管理员提供的内容。",
    enrollment_reconfigure_needs_repair: "通道配置应用需要管理员修复；当前未签发新配置码。",
    enrollment_reconfigure_not_found: "找不到这次通道配置操作记录。",
    enrollment_reconfigure_state_invalid: "通道配置操作记录无效，需要管理员检查。",
    enrollment_reconfigure_write_failed: "新的通道配置未能安全保存。",
    sync_recovery_preflight_failed: "同步前无法完成恢复区检查，当前未执行同步。",
    sync_recovery_restore_hash_mismatch: "恢复文件校验不一致，未写入目标文件。",
    sync_recovery_restore_preview_required: "需要先预览当前还原操作。",
    sync_recovery_restore_staging_invalid: "受保护的还原暂存区无效，未写入目标文件。",
    sync_recovery_restore_target_exists: "还原目标已经存在，未覆盖现有文件。",
    sync_recovery_restore_target_invalid: "还原目标必须位于本地同步文件夹内。",
    sync_recovery_restore_preview_expired: "还原预览已过期，请重新预览。",
    sync_recovery_review_required: "恢复区或双向同步基准需要人工核对；本次未执行同步。",
    sync_recovery_trusted_relation_required: "当前任务没有可验证的目录授权关系，不能使用恢复功能。",
    sync_recovery_version_not_found: "找不到这份已保存版本，或它尚未完成。",
    sync_recovery_review_required: "恢复区或同步基准需要人工核对，当前未执行同步。",
    sync_recovery_trusted_relation_required: "当前任务没有可验证的目录授权关系，不能使用恢复功能。",
    sync_recovery_version_not_found: "找不到这份已保存版本，或它尚未完成。",
    sftp_access_marker_missing: "已有同步基准对应的根标记缺失；已停止修复，不会重建标记或初始化基准。",
    sftp_access_marker_conflict: "本机或远端访问标记与当前授权根目录冲突；拒绝覆盖，请核对原同步目录。",
    sftp_access_marker_invalid: "SFTP 访问标记输入无效，或缺少已验证的根目录标识。",
    sftp_access_marker_write_failed: "无法确认 SFTP 访问标记写入结果；请核对本机或远端目录后重试。",
    sync_relation_migration_required: "现有同步关系需要人工核对；本次未更改任务或同步基准。",
    admin_auth_required: "管理 Token 不正确或已失效，请联系管理员。",
    binary_version_check_failed: "组件存在但无法运行版本检测，请重新解压或重新安装。",
    bucket_disabled: "服务端同步仓库已停用，请联系管理员选择其他仓库。",
    bucket_not_empty: "服务端仓库仍有数据，请联系管理员处理后重试。",
    bucket_not_found: "服务端找不到同步仓库，请联系管理员刷新仓库配置。",
    claim_redeem_failed: "兑换 SyncKey 失败，请检查服务地址和网络后重试。",
    client_error: "客户端发生未知错误，请查看诊断日志。",
    client_port_in_use: "客户端本地端口被占用，请关闭重复实例后重试。",
    danger_confirmation_required: "该操作需要二次确认，请按页面提示完成确认。",
    invalid_json: "请求内容不是合法 JSON，请刷新页面后重试。",
    invalid_path: "请求的资源路径非法，请刷新页面后重试。",
    import_code_required: "请先粘贴服务端生成的 SyncKey。",
    import_code_invalid: "SyncKey 格式不正确，请重新复制。",
    unsupported_profile_version: "当前客户端不支持这个配置版本，请升级客户端。",
    claim_not_found: "这个 SyncKey 不存在，请确认是否复制完整。",
    claim_already_used: "这个 SyncKey 已经使用过，请在服务端重新生成。",
    claim_expired: "这个 SyncKey 已过期，请在服务端重新生成。",
    claim_redeem_rate_limited: "SyncKey 兑换失败次数过多，请稍后再试或联系管理员重新生成。",
    device_disabled: "当前客户端已在服务端停用，请联系管理员重新启用。",
    device_not_found: "当前客户端未在服务端登记，请重新生成并导入 SyncKey。",
    enrollment_auth_invalid: "身份验证码签名无效，请重新发起申请并联系管理员。",
    enrollment_auth_capacity: "身份验证请求过多，请稍后重试。",
    enrollment_auth_expired: "服务器与电脑的系统时间可能存在较大差异。请先检查本机 Windows 日期、时间和时区，并尝试立即同步；若本机时间正确，再请管理员检查服务器时间。无需重新配对、重新导入通道码或重新签发身份验证码。",
    enrollment_auth_replayed: "该身份验证请求已使用，请重新发起申请。",
    enrollment_binding_mismatch: "身份申请与授权目录不匹配，请联系管理员重新签发。",
    enrollment_catalog_not_ready: "身份接入目录尚未就绪，请联系管理员检查服务端设置。",
    enrollment_channel_invalid: "请先导入管理员提供的通道配置码。",
    enrollment_channel_mismatch: "通道配置与身份申请不匹配，请重新导入管理员提供的通道配置码。",
    enrollment_channel_not_ready: "服务端身份接入通道尚未就绪，请检查连接地址、端口和通道设置后重试。",
    enrollment_channel_expired: "通道配置已过期，请重新复制管理员提供的通道配置码。",
    enrollment_code_expired: "身份验证码已过期，请管理员重新签发。",
    enrollment_code_invalid: "身份验证码无效或不属于当前申请，请核对申请后联系管理员。",
    enrollment_code_used: "身份验证码已使用，请重新发起身份申请。",
    enrollment_device_revoked: "该客户端身份已撤销，请联系管理员。",
    enrollment_endpoint_invalid: "接入地址无效，请重新导入管理员提供的通道配置码。",
    enrollment_identity_conflict: "客户端身份与服务端已登记身份冲突，请联系管理员处理。",
    enrollment_identity_missing: "本地设备身份文件缺失或损坏，请先修复本地状态。",
    enrollment_proxy_unavailable: "首次接入隧道不可用，请检查 sing-box 组件和网络。",
    enrollment_public_key_mismatch: "身份公钥与服务端登记不一致，请联系管理员核对。",
    enrollment_relation_conflict: "同步关系与当前授权冲突，请联系管理员核对目录绑定。",
    enrollment_relation_denied: "尚未获得同步目录权限，请等待管理员授权。",
    enrollment_relation_revoked: "该同步关系已撤销，请联系管理员。",
    enrollment_revocation_identity_conflict: "撤销期间关系身份发生变化，请管理员检查 operation 状态。",
    enrollment_revocation_incomplete: "撤销尚未完成；请查询并继续同一 operation。",
    enrollment_revocation_invalid: "撤销请求无效，请检查目标和 operation ID。",
    enrollment_revocation_operation_conflict: "该 operation ID 已用于其他撤销目标。",
    enrollment_revocation_operation_not_found: "找不到该撤销 operation。",
    enrollment_revocation_not_ready: "关系服务尚未就绪，撤销尚未开始。",
    enrollment_revocation_overlay_not_applied: "撤销后的数据配置尚未确认应用。",
    enrollment_revocation_recovery_pending: "撤销恢复尚未完成，暂时不能申请数据授权。",
    enrollment_request_exists: "该身份申请已存在，请查看当前申请状态。",
    enrollment_request_invalid: "身份申请内容无效，请重新提交。",
    enrollment_request_mismatch: "身份验证码不属于当前设备或申请，请核对后重试。",
    enrollment_request_not_found: "服务端找不到该身份申请，请重新提交申请。",
    enrollment_response_invalid: "身份接入响应无效，请检查服务端版本或联系管理员。",
    enrollment_signer_invalid: "服务端身份签名组件不可用，请联系管理员。",
    enrollment_state_invalid: "服务端身份状态无效，请联系管理员检查服务端数据。",
    enrollment_state_conflict: "身份状态已变化，请刷新后重试。",
    enrollment_transport_failed: "首次接入隧道连接失败，请检查网络和服务端状态。",
    enrollment_trust_failed: "服务器密钥或身份回执签名校验失败，请与管理员核对指纹。",
    enrollment_trust_verifier_required: "缺少独立的服务器密钥 pin，无法验证接入通道。",
    data_authorization_invalid: "服务端目录授权内容无效，无法安全连接。",
    data_authorization_mismatch: "服务端目录授权与当前设备身份不匹配。",
    data_authorization_trust_failed: "服务端目录授权签名或有效期验证失败。",
    enrollment_data_authorization_denied: "当前设备尚未获得该目录授权，请联系管理员。",
    enrollment_data_channel_not_ready: "服务端安全数据通道尚未应用，请联系管理员。",
    enrollment_data_relation_start_failed: "服务器未能启动受保护的目录服务，请管理员检查服务能力和权限后重试。",
    enrollment_data_relation_not_ready: "服务端目录传输服务尚未就绪，请联系管理员。",
    heartbeat_auth_invalid: "心跳签名无效，请重新导入 SyncKey。",
    heartbeat_auth_required: "心跳缺少签名，请重新导入 SyncKey。",
    heartbeat_rate_limited: "心跳失败次数过多，服务端已临时限速，稍后会自动重试。",
    profile_heartbeat_required: "服务端下发配置缺少心跳密钥，请重新生成 SyncKey。",
    profile_not_imported: "请先导入服务端生成的 SyncKey。",
    profile_storage_required: "服务端下发配置缺少存储凭据，请重新生成 SyncKey。",
    profile_tunnel_required: "服务端下发配置不完整，请重新生成 SyncKey。",
    invalid_vless_uri: "隧道配置格式不正确，请检查服务端 VLESS 参数。",
    missing_singbox_binary: "客户端缺少 sing-box 组件，请重新解压或重新安装。",
    missing_rclone_binary: "客户端缺少 rclone 组件，请重新解压或重新安装。",
    singbox_start_failed: "隧道启动失败，请查看诊断日志。",
    rclone_config_failed: "同步配置写入失败，请检查存储配置和权限。",
    local_host_forbidden: "请求的 Host 不是本机回环地址，已拒绝；请从客户端窗口内操作。",
    local_state_corrupt: "本地状态文件损坏，请先导出诊断包，备份并修复或隔离损坏 JSON 后再按需重新导入 SyncKey。",
    local_read_forbidden: "本地读取请求被拒绝，请从客户端窗口内操作。",
    local_write_forbidden: "本地写入请求被拒绝，请从客户端窗口内操作。",
    last_active_bucket_disable_blocked: "服务端至少需要保留一个启用的同步仓库。",
    last_bucket_delete_blocked: "服务端至少需要保留一个同步仓库。",
    secret_vault_missing: "本地密钥库缺少同步密钥，请重新导入 SyncKey。",
    secret_vault_unprotected: "无法为本地密钥库设置仅限当前用户的访问权限，已拒绝保存密钥，请检查数据目录所在磁盘（需要 NTFS）后重试。",
    not_found: "请求的接口或资源不存在，请确认客户端版本是否匹配。",
    rclone_sync_failed: "同步失败，请查看日志中的 rclone 错误。",
    storage_full: "服务器存储空间不足，请联系管理员清理空间或迁移存储后重试。",
    server_error: "服务端发生未知错误，请联系管理员查看 sync-server 日志。",
    server_singbox_config_write_failed: "服务端 sing-box 配置写入失败，请联系管理员检查路径和权限。",
    server_state_corrupt: "服务端状态文件损坏，请联系管理员备份并修复 sfsc-state.json。",
    server_state_locked: "服务端数据目录已有运行中的写入者，请联系管理员检查是否重复启动 sync-server。",
    server_state_write_failed: "服务端状态文件写入失败，请联系管理员检查数据目录权限和磁盘空间。",
    singbox_restart_failed: "服务端隧道重启失败，请联系管理员检查配置和服务日志。",
    singbox_restart_timeout: "服务端隧道重启超时，请稍后重试或联系管理员。",
    singbox_restart_unavailable: "服务端未配置隧道重启服务，请联系管理员检查部署。",
    storage_request_failed: "存储服务请求失败，请联系管理员检查 MinIO、地址和密钥。",
    sync_already_running: "已有其他同步任务正在运行，请等待完成后再启动这个任务。",
    sync_relation_migration_required: "双向同步关系需要迁移或重新确认，请先完成关系评审后再保存、预览或运行。",
    sync_direction_not_authorized: "这台设备在当前同步空间没有该方向的授权，请向管理员索取新的 SyncKey。",
    sync_id_unavailable: "这个同步空间名称已被占用，请联系管理员。",
    sync_space_access_denied: "这台设备没有该同步空间的授权，请向管理员索取新的 SyncKey。",
    sync_space_membership_exists: "这台设备已经是该同步空间的成员。",
    sync_space_role_not_allowed: "该同步空间的用途不接受这台设备的角色，请联系管理员调整。",
    validation_failed: "输入内容不符合要求，请检查后重试。",
    request_body_too_large: "请求内容过大，请减少输入内容后重试。",
    unsupported_media_type: "请求内容类型不受支持，请刷新页面后重试。",
    heartbeat_failed: "无法向服务端上报在线状态，同步可继续。",
    network_error: "无法连接客户端服务，请确认客户端正在运行。",
    request_timeout: "客户端操作等待超时，请刷新状态后确认结果。",
    release_manifest_missing: "未找到发布包 manifest，请确认是否从正式客户端包启动。",
    release_manifest_invalid: "发布包 manifest 无法解析，请重新下载或解压客户端包。",
    user_not_found: "服务端找不到这个设备，请联系管理员重新生成 SyncKey。"
  };
  return copy[error?.code] || error?.message || "操作失败";
}

function formatProfileImportError(error) {
  const item = profileImportErrorGuidance(error?.code);
  const code = error?.code ? `（错误码：${error.code}）` : "";
  if (!item) {
    return `导入失败：${formatError(error)}${code}`;
  }
  return `导入失败：${item.message} ${item.action}${code}`;
}

function profileImportErrorGuidance(code) {
  const guidance = {
    claim_not_found: {
      retryable: false,
      message: "这个 SyncKey 不存在或已被服务端清理。",
      action: "不可重试当前 SyncKey：请确认是否复制完整；确认无误后请在服务端重新生成。"
    },
    claim_already_used: {
      retryable: false,
      message: "这个 SyncKey 已经被使用。",
      action: "不可重试当前 SyncKey：请在服务端重新生成后导入。"
    },
    claim_expired: {
      retryable: false,
      message: "这个 SyncKey 已过期。",
      action: "不可重试当前 SyncKey：请在服务端重新生成后导入。"
    },
    validation_failed: {
      retryable: false,
      message: "服务端拒绝了这次 SyncKey 兑换请求。",
      action: "不可重试当前内容：请重新复制完整 SyncKey；仍失败时请让管理员重新生成。"
    },
    claim_redeem_rate_limited: {
      retryable: true,
      message: "SyncKey 兑换失败次数过多，服务端已临时限速。",
      action: "可重试：请等待限速窗口，确认没有反复粘贴错误 SyncKey；必要时联系管理员重新生成。"
    },
    server_state_write_failed: {
      retryable: true,
      message: "服务端暂时无法保存兑换状态。",
      action: "可重试：请让管理员检查服务端数据目录权限和磁盘空间，修复后用同一个 SyncKey 再试。"
    },
    claim_redeem_failed: {
      retryable: true,
      message: "客户端没有完成 SyncKey 兑换。",
      action: "可重试：请检查网络、服务端地址和服务端进程后，用同一个 SyncKey 再试。"
    },
    profile_heartbeat_required: {
      retryable: false,
      message: "服务端下发配置缺少心跳密钥。",
      action: "不可重试当前 SyncKey：请检查服务端配置后重新生成 SyncKey；若反复出现，请升级或修复服务端签发逻辑。"
    },
    profile_storage_required: {
      retryable: false,
      message: "服务端下发配置缺少存储凭据。",
      action: "不可重试当前 SyncKey：请检查服务端配置后重新生成 SyncKey，确认存储桶和设备配置完整。"
    },
    profile_tunnel_required: {
      retryable: false,
      message: "服务端下发配置缺少隧道信息。",
      action: "不可重试当前 SyncKey：请在服务端检查隧道配置后重新生成 SyncKey。"
    },
    import_code_invalid: {
      retryable: false,
      message: "SyncKey 格式不正确。",
      action: "请重新复制完整 SyncKey；使用短码时，请同时填写服务端地址。"
    },
    import_code_required: {
      retryable: false,
      message: "还没有填写 SyncKey。",
      action: "请粘贴服务端生成的完整 SyncKey。"
    },
    unsupported_profile_version: {
      retryable: false,
      message: "当前客户端不支持这个 SyncKey 或 profile 版本。",
      action: "请升级客户端后重新导入。"
    },
    request_timeout: {
      retryable: true,
      message: "客户端页面等待导入结果超时。",
      action: "可重试：请确认本地客户端仍在运行，稍后用同一个 SyncKey 再试。"
    },
    network_error: {
      retryable: true,
      message: "页面无法连接本地客户端服务。",
      action: "可重试：请确认客户端没有退出，再用同一个 SyncKey 导入。"
    },
    local_state_corrupt: {
      retryable: false,
      message: "本地状态文件损坏，客户端已停止写入以保护数据。",
      action: "请先导出诊断包，备份并修复或隔离损坏 JSON 后再重新导入 SyncKey。"
    }
  };
  return guidance[code] || null;
}

function formatReleaseManifest(manifest) {
  if (!manifest) {
    return "-";
  }
  const supportDocs = formatReleaseManifestSupportDocuments(manifest.supportDocuments);
  const requiredFiles = formatReleaseManifestRequiredFiles(manifest.requiredFiles);
  if (manifest.ok) {
    const fileCount = Number(manifest.fileCount || 0);
    return `正常 · ${manifest.version || "-"} · ${fileCount} 个文件${supportDocs ? ` · ${supportDocs}` : ""}${requiredFiles ? ` · ${requiredFiles}` : ""}`;
  }
  const details = [supportDocs, requiredFiles].filter(Boolean).join("；");
  if (details) {
    return details;
  }
  if (supportDocs) {
    return supportDocs;
  }
  return formatError({ code: manifest.errorCode, message: manifest.message });
}

function formatReleaseManifestSupportDocuments(supportDocuments) {
  if (!supportDocuments) {
    return "";
  }
  const files = Array.isArray(supportDocuments.files) ? supportDocuments.files : [];
  if (supportDocuments.ok) {
    return "合同文档已登记";
  }
  const brokenFiles = files.filter((file) => file && (file.present === false || file.valid === false));
  const missing = brokenFiles
    .map((file) => file.name || file.path || "未知文档")
    .slice(0, 3);
  const suffix = brokenFiles.length > missing.length ? " 等" : "";
  return `合同文档缺失或无效：${missing.join("、") || "未知"}${suffix}`;
}

function formatReleaseManifestRequiredFiles(requiredFiles) {
  if (!requiredFiles) {
    return "";
  }
  const files = Array.isArray(requiredFiles.files) ? requiredFiles.files : [];
  if (requiredFiles.ok) {
    return "关键文件已登记";
  }
  const broken = files
    .filter((file) => file && (file.present === false || file.valid === false))
    .map((file) => file.name || file.path || "未知文件")
    .slice(0, 3);
  const totalBroken = files.filter((file) => file && (file.present === false || file.valid === false)).length;
  const suffix = totalBroken > broken.length ? " 等" : "";
  return `关键文件未登记：${broken.join("、") || "未知"}${suffix}`;
}

function formatSecretVault(vault) {
  if (!vault) {
    return "-";
  }
  if (vault.ok) {
    return `${vault.backend || "vault"} 正常 · ${vault.refs || 0} 项`;
  }
  return `缺少 ${vault.missingRefs?.length || 0} 项密钥，请重新导入 SyncKey`;
}

function formatLocalState(localState) {
  if (!localState) {
    return "-";
  }
  if (localState.ok) {
    const count = Array.isArray(localState.files) ? localState.files.length : 0;
    return `正常 · ${count} 个文件`;
  }
  const broken = (localState.files || [])
    .filter((file) => file && file.ok === false)
    .map((file) => file.name || file.path || "unknown")
    .slice(0, 3);
  const suffix = (localState.files || []).filter((file) => file && file.ok === false).length > broken.length ? " 等" : "";
  return `损坏：${broken.join("、") || "未知"}${suffix}`;
}

function validInteger(input, fallback, min, max) {
  const value = Number(input);
  if (!Number.isInteger(value)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, value));
}

function clampPercent(value) {
  if (value == null || value === "") {
    return null;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.max(0, Math.min(100, number));
}

function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return "-";
  }
  return `${number.toFixed(number % 1 === 0 ? 0 : 1)}%`;
}

function statusText(state) {
  if (state === "syncing") return "同步中";
  if (state === "error") return "同步失败";
  if (state === "stopping") return "正在停止";
  return "等待开始";
}

function formatLastSync(run) {
  if (!run) return "-";
  const status = {
    running: "运行中",
    success: "成功",
    error: "失败",
    stopped: "已停止"
  }[run.status] || run.status || "-";
  const time = run.finishedAt || run.startedAt;
  const conflicts = hasDisplayableConflicts(run) ? `有冲突 ${run.conflicts.count} 项` : "";
  const failed = run.status === "error" || Boolean(run.errorCode || run.error);
  return [failed ? status : conflicts || status, time ? formatShortTime(time) : ""].filter(Boolean).join(" · ");
}

function formatProtocols(protocols = {}) {
  const pairs = [
    ["SyncKey", protocols.claim],
    ["profile", protocols.profile],
    ["admin", protocols.adminState],
    ["status", protocols.clientStatus],
    ["heartbeat", protocols.heartbeat]
  ];
  const text = pairs
    .filter(([, version]) => Number.isFinite(Number(version)) && Number(version) > 0)
    .map(([name, version]) => `${name} v${Number(version)}`)
    .join(" · ");
  return text || "-";
}

function formatCompatibility(compatibility) {
  if (!compatibility) {
    return "-";
  }
  if (compatibility.ok) {
    return "协议兼容";
  }
  const first = compatibility.issues?.[0];
  const field = first?.field ? `：${first.field}` : "";
  const actions = {
    upgrade_remote: `客户端过旧${field}`,
    upgrade_local: `服务端过旧${field}`,
    diagnostics_missing: `诊断信息缺失${field}`,
    manual_check: `协议版本混杂${field}`
  };
  return actions[compatibility.action] || `协议不兼容${field}`;
}

function formatCompatibilityPolicy(policy = {}) {
  if (!policy.heartbeat) {
    return "-";
  }
  const names = {
    allow: "允许",
    warn: "警告",
    block: "阻止"
  };
  return [
    `心跳${names[policy.heartbeat] || policy.heartbeat}`,
    `配置${names[policy.profileIssue] || policy.profileIssue || "-"}`,
    `同步${names[policy.syncRun] || policy.syncRun || "-"}`
  ].join(" · ");
}

function formatSyncCompatibilityWarning(compatibility = {}) {
  const first = compatibility.issues?.[0];
  const detail = first
    ? `${first.field} 服务端 v${first.local || "-"}，客户端 v${first.remote || "-"}`
    : "协议版本不一致";
  const actions = {
    upgrade_remote: `客户端协议过旧：${detail}。建议升级客户端后再同步。`,
    upgrade_local: `服务端协议过旧：${detail}。建议升级服务端后再同步。`,
    diagnostics_missing: `诊断信息不完整：${detail}。请确认客户端和服务端版本后再同步。`,
    manual_check: `客户端和服务端协议版本混杂：${detail}。请确认两端来自同一发布批次后再同步。`
  };
  return actions[compatibility.action] || `协议不兼容：${detail}。请确认后再同步。`;
}

function syncRunStatusText(status) {
  return {
    running: "运行中",
    success: "成功",
    error: "失败",
    stopped: "已停止"
  }[status] || "未知";
}

function syncRunStatusClass(status) {
  return ["running", "success", "error", "stopped"].includes(status) ? status : "unknown";
}

function hasDisplayableConflicts(run = {}) {
  const direction = run.job?.direction || run.direction || "";
  return direction === "bidirectional" && run.conflicts?.count > 0;
}

function syncRunPresentationClass(run = {}) {
  if (run.status === "error" || run.errorCode || run.error) {
    return "error";
  }
  return hasDisplayableConflicts(run) ? "conflict" : syncRunStatusClass(run.status);
}

function syncRunBadgeText(run = {}) {
  if (run.status === "error" || run.errorCode || run.error) {
    return "失败";
  }
  return hasDisplayableConflicts(run) ? "有冲突" : syncRunStatusText(run.status);
}

function formatSyncRunTitle(run = {}) {
  const job = run.job || {};
  const name = job.name || "folder-sync";
  const direction = formatDirection(job.direction || run.direction);
  return `${name} · ${direction}`;
}

function syncRunMeta(run = {}) {
  const parts = [];
  parts.push(formatSyncRunTrigger(run.trigger));
  if (run.transferredSizeText) {
    parts.push(run.transferredSizeText);
  }
  if (run.progressPercent != null) {
    parts.push(formatPercent(run.progressPercent));
  }
  if (run.rawSpeed) {
    parts.push(run.rawSpeed);
  }
  const duration = formatDuration(run.startedAt, run.finishedAt);
  if (duration) {
    parts.push(duration);
  }
  if (Number.isInteger(run.exitCode)) {
    parts.push(`退出码 ${run.exitCode}`);
  }
  if (hasDisplayableConflicts(run)) {
    parts.push(`冲突 ${run.conflicts.count} 项`);
  }
  return parts.length ? parts : ["暂无传输统计"];
}

function formatSyncRunTrigger(trigger) {
  return trigger === "scheduler" ? "计划触发" : "手动触发";
}

function syncRunDetail(run = {}) {
  if (run.errorCode) {
    const message = formatError({ code: run.errorCode, message: run.error });
    return run.error ? `错误：${message}（${run.error}）` : `错误：${message}`;
  }
  if (run.error) {
    return `错误：${run.error}`;
  }
  if (hasDisplayableConflicts(run)) {
    return `${formatConflictSummary(run.conflicts)}。${conflictResolutionHint()}`;
  }
  if (run.currentFile) {
    return `最近文件：${run.currentFile}`;
  }
  if (run.localPath) {
    return `本地：${run.localPath}`;
  }
  return "未记录文件详情";
}

function formatConflictSummary(conflicts = {}) {
  const files = Array.isArray(conflicts.files) ? conflicts.files.slice(0, 3) : [];
  const suffix = conflicts.truncated ? " 等" : "";
  const fileText = files.length ? `：${files.join("、")}${suffix}` : "";
  return `检测到 ${Number(conflicts.count || files.length)} 项同步冲突${fileText}`;
}

function conflictResolutionHint() {
  return "请暂停继续双向同步，先手动比对示例文件，确认保留版本后再重新运行同步";
}

function formatDuration(startedAt, finishedAt) {
  const start = new Date(startedAt).getTime();
  const end = new Date(finishedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "";
  }

  const seconds = Math.max(1, Math.round((end - start) / 1000));
  if (seconds < 60) {
    return `${seconds} 秒`;
  }
  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;
  if (minutes < 60) {
    return restSeconds ? `${minutes} 分 ${restSeconds} 秒` : `${minutes} 分`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
}

function formatShortTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString();
}

function formatVersion(name, binary) {
  if (!binary.exists) {
    const reason = binary.errorCode ? formatError({ code: binary.errorCode, message: binary.message }) : "未找到";
    return `${name}: ${reason}\n${binary.path}`;
  }
  const firstLine = binary.version?.stdout?.split("\n").find(Boolean) || "version unavailable";
  return `${name}: ${binary.version?.ok ? "正常" : "异常"}\n${firstLine}\n${binary.path}`;
}

function openSettings() {
  setVisibility("settingsScrim", true);
  setVisibility("settingsPanel", true);
}

function closeSettings() {
  setVisibility("settingsScrim", false);
  setVisibility("settingsPanel", false);
}

function on(id, event, handler) {
  const el = $(id);
  if (el) el.addEventListener(event, handler);
}

function summarizeResponseText(text) {
  return String(text || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function responseStatusLabel(response) {
  const status = Number(response.status || 0);
  const statusText = String(response.statusText || "").trim();
  return statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
}

function buildNonJsonApiResponse(response, text) {
  const summary = summarizeResponseText(text);
  return {
    ok: false,
    status: Number(response.status || 0),
    errorCode: "client_error",
    code: "client_error",
    error: "client_error",
    message: summary
      ? `${responseStatusLabel(response)}: ${summary}`
      : `${responseStatusLabel(response)}: non-JSON response`,
    nonJson: true
  };
}

async function readJsonOrFallback(response) {
  let text = "";
  try {
    text = await response.text();
  } catch {
    return buildNonJsonApiResponse(response, "");
  }

  try {
    return JSON.parse(text);
  } catch {
    return buildNonJsonApiResponse(response, text);
  }
}

const clientApi = Object.freeze({
  getStatus: () => requestJson({ method: "GET", path: "/api/client/status" }),
  startConnectionRepair: (body) => requestJson({ method: "POST", path: "/api/enrollment/connection/repair", body }),
  getConnectionRepairOperation: (operationId) => requestJson({
    method: "GET",
    path: "/api/enrollment/connection/repair/" + encodeURIComponent(operationId)
  }),
  importEnrollmentChannel: (body) => requestJson({ method: "POST", path: "/api/enrollment/channel/import", body }),
  submitEnrollmentRequest: () => requestJson({ method: "POST", path: "/api/enrollment/request", body: {} }),
  consumeEnrollmentCode: (body) => requestJson({ method: "POST", path: "/api/enrollment/consume", body }),
  refreshDataAuthorizations: () => requestJson({ method: "POST", path: "/api/enrollment/data-authorizations/refresh", body: {} }),
  checkBinaries: () => requestJson({ method: "POST", path: "/api/binaries/check", body: {}, allowOkFalse: true }),
  importProfile: (body, options = {}) => requestJson({ method: "POST", path: "/api/profile/import", body, ...options }),
  startTunnel: () => requestJson({ method: "POST", path: "/api/singbox/start", body: {} }),
  stopTunnel: () => requestJson({ method: "POST", path: "/api/singbox/stop", body: {} }),
  saveJob: (body) => requestJson({ method: "POST", path: "/api/jobs/save", body }),
  previewSync: (body) => requestJson({ method: "POST", path: "/api/sync/preview", body }),
  createSyncSafetyPlan: (body) => requestJson({ method: "POST", path: "/api/sync/safety-plan", body, timeoutMs: syncPreparationRequestTimeoutMs }).then((result) => result.plan),
  initializeBidirectionalSync: (body) => requestJson({ method: "POST", path: "/api/sync/bisync/initialize", body, timeoutMs: bidirectionalInitializationRequestTimeoutMs }).then((result) => result.initialization),
  previewFirstBisyncConflicts: (body) => requestJson({ method: "POST", path: "/api/sync/bisync/conflicts/preview", body, timeoutMs: syncPreparationRequestTimeoutMs }).then((result) => result.preview),
  saveFirstBisyncConflicts: (body) => requestJson({ method: "POST", path: "/api/sync/bisync/conflicts/save", body, timeoutMs: syncPreparationRequestTimeoutMs }).then((result) => result.saved),
  listFirstBisyncConflictOperations: (body) => requestJson({ method: "POST", path: "/api/sync/bisync/conflicts/operations", body, timeoutMs: syncPreparationRequestTimeoutMs }).then((result) => result.operations),
  resumeFirstBisyncConflictSave: (body) => requestJson({ method: "POST", path: "/api/sync/bisync/conflicts/resume", body, timeoutMs: syncPreparationRequestTimeoutMs }).then((result) => result.saved),
  runSync: (body) => requestJson({ method: "POST", path: "/api/sync/run", body, timeoutMs: syncRunRequestTimeoutMs }),
  stopSync: () => requestJson({ method: "POST", path: "/api/sync/stop", body: {} }),
  getLogs: () => requestJson({ method: "GET", path: "/api/logs" }),
  exportDiagnostics: () => requestJson({ method: "GET", path: "/api/diagnostics/export" }),
  getSyncHistory: () => requestJson({ method: "GET", path: "/api/sync/history" }),
  listRecoveryVersions: (jobId) => requestJson({ method: "GET", path: `/api/jobs/${encodeURIComponent(jobId)}/recovery`, timeoutMs: syncPreparationRequestTimeoutMs }),
  previewRecoveryRestore: (jobId, body) => requestJson({ method: "POST", path: `/api/jobs/${encodeURIComponent(jobId)}/recovery/restore-preview`, body }).then(result => result.preview),
  restoreRecoveryVersion: (jobId, previewId) => requestJson({ method: "POST", path: `/api/jobs/${encodeURIComponent(jobId)}/recovery/restore`, body: { previewId } }),
  cancelRecoveryRestore: (jobId, previewId) => requestJson({ method: "POST", path: `/api/jobs/${encodeURIComponent(jobId)}/recovery/restore-cancel`, body: { previewId } }),
  shutdown: () => requestJson({ method: "POST", path: "/api/client/shutdown", body: {} })
});

async function requestJson({ method, path, body, timeoutMs = defaultRequestTimeoutMs, allowOkFalse = false }) {
  let response;
  const controller = typeof AbortController === "function" && timeoutMs > 0
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    response = await fetch(path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller?.signal
    });
  } catch (cause) {
    const timedOut = cause?.name === "AbortError";
    const error = new Error(timedOut ? "Request timed out" : cause.message || "Network error");
    error.code = timedOut ? "request_timeout" : "network_error";
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  const result = await readJsonOrFallback(response);
  if (!response.ok || result?.nonJson === true || (result?.ok === false && !allowOkFalse)) {
    const error = new Error(result.message || result.errorCode || result.error || "Request failed");
    error.code = result.errorCode || result.error || result.code || "";
    error.status = response.status || result.status;
    throw error;
  }
  return result;
}
