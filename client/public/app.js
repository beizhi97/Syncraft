const $ = (id) => document.getElementById(id);
const fields = {
  claimCode: $("claimCode"),
  localPath: $("localPath"),
  direction: $("direction"),
  remoteFolder: $("remoteFolder"),
  serverSpace: $("serverSpace"),
  scheduleMode: $("scheduleMode"),
  scheduleInterval: $("scheduleInterval"),
  scheduleTime: $("scheduleTime"),
  transfers: $("transfers"),
  streams: $("streams"),
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
let latestSyncHistory = [];
let currentJobDraft = null;
let statusRequestInFlight = null;
let latestStatusRequestId = 0;
let latestAppliedStatusRequestId = 0;
let lastPreviewJobFingerprint = "";
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
  "remoteFolder",
  "serverSpace",
  "transfers",
  "streams",
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
on("emptyImportBtn", "click", openSettings);
on("settingsScrim", "click", closeSettings);
on("closeSettingsBtn", "click", closeSettings);
on("checkBinsBtn", "click", checkBinaries);
on("saveProfileBtn", "click", saveProfile);
on("startTunnelBtn", "click", startTunnel);
on("stopTunnelBtn", "click", stopTunnel);
on("saveJobBtn", "click", saveJob);
on("previewBtn", "click", previewJob);
on("runSyncBtn", "click", runSync);
on("stopSyncBtn", "click", stopSync);
on("refreshHistoryBtn", "click", refreshSyncHistory);
on("historyStatusFilter", "change", () => renderSyncHistory(latestSyncHistory));
on("historySearch", "input", () => renderSyncHistory(latestSyncHistory));
on("refreshLogsBtn", "click", refreshLogs);
on("copyLogsBtn", "click", copyLogs);
on("copySupportSummaryBtn", "click", copySupportSummary);
on("exportDiagnosticsBtn", "click", exportDiagnostics);
on("shutdownBtn", "click", shutdownClient);
on("chooseFolderBtn", "click", chooseLocalFolder);
on("direction", "change", syncDestructiveAvailability);
on("direction", "change", syncBidirectionalAvailability);
on("remoteFolder", "input", updateRemoteTargetDraft);
on("serverSpace", "change", updateRemoteTargetDraft);
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
    updateBodyState(status);
    $("clientVersion").textContent = status.appVersion || status.clientVersion || "-";
    const successfulHeartbeat = currentSuccessfulHeartbeat(status);
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

    const binariesReady = status.binaries.singbox.exists && status.binaries.rclone.exists;
    setPill("binStatus", binariesReady ? "组件正常" : "组件缺失", binariesReady ? "good" : "bad");
    const profileStatus = profileStatusDisplay(status.profileImported, status.heartbeat);
    setPill("profileStatus", profileStatus.pill, profileStatus.state);
    renderDeviceRecovery(status.profileImported, status.heartbeat);
    setPill("tunnelStatus", status.processes.singbox.running ? "隧道运行中" : "隧道已停止", status.processes.singbox.running ? "good" : "");
    const syncPill = syncStatusPill(status.processes.sync || {});
    setPill("syncStatus", syncPill.text, syncPill.state);
    renderHeartbeat(status.heartbeat, status.profileImported);
    setHealth("singboxHealth", "sing-box", status.binaries.singbox.exists);
    setHealth("rcloneHealth", "rclone", status.binaries.rclone.exists);
    renderSyncProgress(status.processes.sync.metrics || {}, status.lastSync);
    renderScheduler(status.scheduler);
    latestSyncHistory = status.syncHistory || [];
    renderSyncHistory(latestSyncHistory);

    renderProfileSummary(status.profileSummary, status.heartbeat);
    renderRemoteTargetSummary(status.jobs[status.jobs.length - 1] || currentJobDraft, status.profileSummary);

    if (status.jobs.length && !$("localPath").dataset.loaded) {
      writeJob(status.jobs[status.jobs.length - 1]);
      $("localPath").dataset.loaded = "1";
    }
    return status;
  } catch {
    if (requestId < latestStatusRequestId) {
      return null;
    }
    setBodyState("state-error");
    setPill("binStatus", "客户端离线", "bad");
    setPill("heartbeatStatus", "客户端离线", "bad");
    setHealth("singboxHealth", "sing-box", false);
    setHealth("rcloneHealth", "rclone", false);
    setHealth("heartbeatHealth", "服务端心跳", false, "客户端离线");
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

async function saveProfile() {
  const code = fields.claimCode.value.trim();
  if (!code) {
    setAction("请先在设置里粘贴服务端生成的 SyncKey。", "bad");
    return;
  }

  return withBusyAction("saveProfileBtn", async () => {
    setAction("正在兑换 SyncKey...");
    $("profileSummary").textContent = "正在导入服务端配置...";
    try {
      const result = await clientApi.importProfile({ code }, { timeoutMs: profileImportRequestTimeoutMs });
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
      await clientApi.saveJob({
        job: confirmed.job,
        confirmCompatibilityWarning: confirmed.confirmCompatibilityWarning,
        confirmDestructiveSync: confirmed.confirmDestructiveSync
      });
      setAction("同步任务已保存。", "good");
      await loadStatus();
    } catch (error) {
      setAction(`保存失败：${formatError(error)}`, "bad");
    }
  });
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
      const previewConfirmed = await requestConfirmation({
        title: "确认远端目标",
        body: [
          "当前任务尚未按最新填写内容生成预览。",
          `本地：${confirmed.job.localPath || "未选择"}`,
          `方向：${formatDirection(confirmed.job.direction)}`,
          `远端目录：${confirmed.job.remoteFolder || "SyncKey 设备目录"}`,
          "建议先生成 rclone 命令预览，确认最终远端路径。"
        ].join("\n"),
        submitText: "仍然开始同步"
      });
      if (!previewConfirmed) {
        setAction("已取消同步。请先生成预览并确认远端目录。", "bad");
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
          const initialized = await requestConfirmation({
            title: "初始化双向同步",
            body: `首次双向同步将以“${formatBisyncInitialMode(confirmed.job.safety?.bidirectional?.initialMode)}”建立基准。系统会先做只读检查，再执行 rclone bisync 初始化。`,
            requiredText: "初始化双向",
            submitText: "初始化"
          });
          if (!initialized) return;
          await clientApi.initializeBidirectionalSync({
            job: confirmed.job,
            safetyPlanId: safetyPlan.id,
            confirmCompatibilityWarning: confirmed.confirmCompatibilityWarning,
            confirmBidirectionalInitialization: true
          });
          safetyPlan = await clientApi.createSyncSafetyPlan({ job: confirmed.job });
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
  });
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
  const remoteFolder = readRemoteFolderField();
  return {
    ...base,
    direction: fields.direction.value,
    localPath: fields.localPath.value,
    remoteFolder,
    serverSpace: fields.serverSpace.value,
    transfers: readPositiveIntegerField(fields.transfers, "并行文件", 32),
    streams: readPositiveIntegerField(fields.streams, "单文件线程", 32),
    destructiveSync: fields.direction.value !== "bidirectional" && fields.destructiveSync.checked,
    safety: fields.direction.value === "bidirectional"
      ? { bidirectional: { initialMode: fields.bisyncInitialMode.value || "newer" } }
      : undefined,
    bandwidthLimit: readBandwidthLimit(),
    schedule: readSchedule()
  };
}

function readRemoteFolderField() {
  const value = fields.remoteFolder.value.trim();
  if (!value) {
    if (fields.serverSpace.value === "shared") {
      const error = new Error("共享空间必须填写远端子目录，避免不同设备写入同一根目录。");
      error.code = "shared_remote_folder_required";
      throw error;
    }
    return "";
  }
  if (/^[A-Za-z]:/.test(value) || value.startsWith("/") || value.startsWith("\\") || value.split(/[\\/]+/).includes("..")) {
    const error = new Error("远端目录只能填写相对目录，不能使用盘符、绝对路径或 ..。");
    error.code = "invalid_remote_folder";
    throw error;
  }
  return value;
}

function jobPreviewFingerprint(job = {}) {
  return JSON.stringify({
    direction: job.direction || "",
    localPath: job.localPath || "",
    remoteFolder: job.remoteFolder || "",
    serverSpace: job.serverSpace || "",
    transfers: job.transfers || 0,
    streams: job.streams || 0,
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
  fields.direction.value = currentJobDraft.direction || fields.direction.value;
  fields.localPath.value = currentJobDraft.localPath || fields.localPath.value;
  fields.remoteFolder.value = currentJobDraft.remoteFolder || "";
  fields.serverSpace.value = currentJobDraft.serverSpace || "device";
  fields.transfers.value = currentJobDraft.transfers || fields.transfers.value;
  fields.streams.value = currentJobDraft.streams || fields.streams.value;
  fields.destructiveSync.checked = Boolean(currentJobDraft.destructiveSync);
  fields.bisyncInitialMode.value = currentJobDraft.safety?.bidirectional?.initialMode || "newer";
  writeBandwidthLimit(currentJobDraft.bandwidthLimit || "off");
  writeSchedule(currentJobDraft.schedule || { mode: "manual" });
  renderRemoteTargetSummary(currentJobDraft, latestStatus?.profileSummary);
  syncDestructiveAvailability();
  syncBidirectionalAvailability();
  syncScheduleControls();
  syncBandwidthAvailability();
}

function updateRemoteTargetDraft() {
  const base = currentJobDraft && typeof currentJobDraft === "object" ? currentJobDraft : {};
  currentJobDraft = {
    ...base,
    remoteFolder: fields.remoteFolder.value.trim(),
    serverSpace: fields.serverSpace.value
  };
  renderRemoteTargetSummary(currentJobDraft, latestStatus?.profileSummary);
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

function renderSyncProgress(metrics = {}, lastSync = null) {
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

function renderScheduler(scheduler = {}) {
  const target = $("schedulerValue");
  if (!target) return;
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
    target.textContent = "等待导入服务端配置...";
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
  if (profileSummary || latestStatus?.profileSummary) {
    renderSummaryRows(target, [
      ["授权范围", "整个已授权同步内容"],
      ["同步 ID", "本地安全摘要提供后显示"],
      ["执行方式", "预览后再开始"]
    ]);
    return;
  }
  renderSummaryRows(target, [
    ["状态", "导入 SyncKey 后显示授权内容"]
  ]);
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
    ready: ["badge ok", "授权已就绪", "此设备只能同步管理员通过 SyncKey 授权的内容。"],
    disabled: ["badge err", "设备已停用", "服务端已停用此设备。重新启用后才能继续同步。"],
    unregistered: ["badge err", "设备未登记", "服务端找不到此设备。请重新生成并导入 SyncKey。"],
    missing: ["badge neutral", "等待 SyncKey 授权", "导入 SyncKey 后显示。客户端不提供手工输入、搜索或加入同步 ID 的入口。"]
  }[authorization] || ["badge neutral", "等待 SyncKey 授权", "导入 SyncKey 后显示。"];
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

// Kept as a compatibility seam for the confirmation flow; never reveal storage routing.
function formatRemoteTarget(job = {}) {
  return "当前 SyncKey 已授权内容";
}

function formatServerSpace(value) {
  return value === "shared" ? "共享空间" : "设备空间";
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

function setHealth(id, name, ok, detail = "") {
  const el = $(id);
  const wide = el.classList.contains("wide");
  el.textContent = `${ok ? "✓" : "×"} ${name}${detail ? ` · ${detail}` : ""}`;
  el.className = `health-card ${ok ? "good" : "bad"}${wide ? " wide" : ""}`;
}

function renderHeartbeat(heartbeat, profileImported) {
  const status = heartbeatDisplay(heartbeat, profileImported);
  setPill("heartbeatStatus", status.pill, status.state);
  setHealth("heartbeatHealth", "服务端心跳", status.ok, status.detail);
}

function renderDeviceRecovery(profileImported, heartbeat) {
  const target = $("deviceRecoveryNotice");
  if (!target) return;
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
    return "服务端找不到当前设备。请在服务端重新生成 SyncKey，并在设置中重新导入。";
  }
  return "";
}

function profileStatusDisplay(profileImported, heartbeat) {
  if (!profileImported) {
    return {
      pill: "未导入配置",
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

function setAction(text, state) {
  const el = $("actionMessage");
  el.textContent = text;
  el.className = state ? `notice ${state}` : "notice";
}

async function withBusyAction(buttonId, action) {
  const button = $(buttonId);
  if (button?.dataset.busy === "1") {
    return null;
  }
  if (button) {
    button.dataset.busy = "1";
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
  }
  try {
    return await action();
  } finally {
    if (button) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      delete button.dataset.busy;
    }
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
  if (!status.profileImported) {
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
    shared_remote_folder_required: "共享空间必须填写远端子目录，避免不同设备写入同一根目录。",
    invalid_remote_folder: "远端目录只能填写相对目录，不能使用盘符、绝对路径或 ..。",
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
  if (!item) {
    return `导入失败：${formatError(error)}`;
  }
  return `导入失败：${item.message} ${item.action}`;
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
      action: "不可重试当前内容：请从服务端重新复制完整 SyncKey，不要粘贴短码。"
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

function readPositiveIntegerField(input, label, max) {
  const value = Number(input.value);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${label}必须是 1 到 ${max} 之间的整数。`);
  }
  return value;
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
  checkBinaries: () => requestJson({ method: "POST", path: "/api/binaries/check", body: {}, allowOkFalse: true }),
  importProfile: (body, options = {}) => requestJson({ method: "POST", path: "/api/profile/import", body, ...options }),
  startTunnel: () => requestJson({ method: "POST", path: "/api/singbox/start", body: {} }),
  stopTunnel: () => requestJson({ method: "POST", path: "/api/singbox/stop", body: {} }),
  saveJob: (body) => requestJson({ method: "POST", path: "/api/jobs/save", body }),
  previewSync: (body) => requestJson({ method: "POST", path: "/api/sync/preview", body }),
  createSyncSafetyPlan: (body) => requestJson({ method: "POST", path: "/api/sync/safety-plan", body, timeoutMs: syncPreparationRequestTimeoutMs }).then((result) => result.plan),
  initializeBidirectionalSync: (body) => requestJson({ method: "POST", path: "/api/sync/bisync/initialize", body, timeoutMs: bidirectionalInitializationRequestTimeoutMs }).then((result) => result.initialization),
  runSync: (body) => requestJson({ method: "POST", path: "/api/sync/run", body, timeoutMs: syncRunRequestTimeoutMs }),
  stopSync: () => requestJson({ method: "POST", path: "/api/sync/stop", body: {} }),
  getLogs: () => requestJson({ method: "GET", path: "/api/logs" }),
  exportDiagnostics: () => requestJson({ method: "GET", path: "/api/diagnostics/export" }),
  getSyncHistory: () => requestJson({ method: "GET", path: "/api/sync/history" }),
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
