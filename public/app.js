const fields = {
  protocol: byId("protocol"),
  remark: byId("remark"),
  publicHost: byId("publicHost"),
  publicPort: byId("publicPort"),
  listenPort: byId("listenPort"),
  claimServer: byId("claimServer"),
  realityServerName: byId("realityServerName"),
  realityFingerprint: byId("realityFingerprint"),
  realityPublicKey: byId("realityPublicKey"),
  realityPrivateKey: byId("realityPrivateKey"),
  realityShortId: byId("realityShortId"),
  remoteName: byId("remoteName"),
  bucket: byId("bucket"),
  endpoint: byId("endpoint"),
  internalEndpoint: byId("internalEndpoint"),
  accessKeyId: byId("accessKeyId"),
  secretAccessKey: byId("secretAccessKey"),
  prefixRoot: byId("prefixRoot"),
  sharedPrefix: byId("sharedPrefix"),
  newBucketName: byId("newBucketName"),
  newSyncId: byId("newSyncId"),
  syncSpaceOwnerSelect: byId("syncSpaceOwnerSelect"),
  syncSpaceSelect: byId("syncSpaceSelect"),
  syncSpaceRole: byId("syncSpaceRole"),
  deviceName: byId("deviceName"),
  bucketSelect: byId("bucketSelect"),
  expiresInHours: byId("expiresInHours"),
  transfers: byId("transfers"),
  streams: byId("streams"),
  checkers: byId("checkers"),
  chunkSize: byId("chunkSize"),
  scheduleMode: byId("scheduleMode"),
  scheduleValue: byId("scheduleValue"),
  deviceStatusFilter: byId("deviceStatusFilter"),
  deviceSyncFilter: byId("deviceSyncFilter"),
  deviceCompatFilter: byId("deviceCompatFilter"),
  deviceSearch: byId("deviceSearch"),
  adminTokenInput: byId("adminTokenInput")
};

let state = null;
let latestClaimTKey = "";
let latestClaimUri = "";
let latestClaimShortCode = "";
const adminTokenStorageKey = "sfsc-admin-token";
let adminToken = localStorage.getItem(adminTokenStorageKey) || "";
let adminAuthEnabled = false;
let pendingConfirmation = null;
const defaultRequestTimeoutMs = 15000;

byId("autoFillVlessBtn").addEventListener("click", autoFillVless);
byId("generateTunnelBtn").addEventListener("click", generateTunnel);
byId("refreshSingboxConfigBtn").addEventListener("click", refreshSingboxConfigPreview);
byId("applySingboxBtn").addEventListener("click", applySingbox);
fields.protocol.addEventListener("change", toggleRealitySettings);
byId("saveStorageBtn").addEventListener("click", saveStorage);
byId("refreshBucketsBtn").addEventListener("click", refreshBuckets);
byId("createBucketBtn").addEventListener("click", createBucket);
byId("bucketList").addEventListener("click", handleBucketAction);
byId("deviceList").addEventListener("click", handleDeviceAction);
fields.deviceStatusFilter.addEventListener("change", renderDevices);
fields.deviceSyncFilter.addEventListener("change", renderDevices);
fields.deviceCompatFilter.addEventListener("change", renderDevices);
fields.deviceSearch.addEventListener("input", renderDevices);
byId("createClaimBtn").addEventListener("click", createClaim);
byId("createSyncSpaceBtn").addEventListener("click", createSyncSpace);
byId("copyClaimBtn").addEventListener("click", copyClaim);
byId("copyClaimUriBtn").addEventListener("click", copyClaimUri);
byId("redeemPreviewBtn").addEventListener("click", redeemPreview);
byId("refreshBtn").addEventListener("click", loadState);
byId("loginForm").addEventListener("submit", loginAdmin);
byId("logoutBtn").addEventListener("click", logoutAdmin);
byId("confirmForm").addEventListener("submit", submitConfirmation);
byId("confirmCancelBtn").addEventListener("click", cancelConfirmation);
document.querySelectorAll("[data-tab-target]").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tabTarget));
});

boot();
setInterval(refreshLiveDevices, 5000);

async function boot() {
  await checkHealth();
  await loadState();
}

async function checkHealth() {
  const healthDot = byId("healthDot");
  const healthText = byId("healthText");
  try {
    const result = await api("/api/health", null, { auth: false });
    adminAuthEnabled = Boolean(result.adminAuth?.enabled);
    const serviceHealth = result.serviceHealth || {};
    healthDot.classList.remove("ok", "good", "warn", "err");
    if (serviceHealth.restartRequired) {
      healthDot.classList.add("warn");
      healthText.textContent = "API 可达 · 待重启";
    } else if (!result.ok) {
      healthDot.classList.add("err");
      healthText.textContent = "API 异常";
    } else {
      healthDot.classList.add("good");
      healthText.textContent = "API 可达";
    }
    byId("diagnosticsStatus").textContent = formatRuntimeDiagnostics(result.diagnostics);
    updateAuthStatus(Boolean(adminToken));
  } catch {
    healthDot.classList.remove("ok", "good", "warn", "err");
    healthDot.classList.add("err");
    healthText.textContent = "offline";
    byId("diagnosticsStatus").textContent = "版本未知";
    updateAuthStatus(false);
  }
}

async function loadState() {
  try {
    state = await api("/api/admin/state");
    hideAuthGate();
    updateAuthStatus(true);
    renderState();
  } catch (error) {
    if (error.code === "admin_auth_required") {
      state = null;
      clearAdminToken();
      showAuthGate();
      updateAuthStatus(false);
      return;
    }
    throw error;
  }
}

async function refreshLiveDevices() {
  if (!state) return;
  try {
    state = await api("/api/admin/state");
    renderApplyNotice();
    renderStatStrip();
    renderDevices();
  } catch (error) {
    if (error.code === "admin_auth_required") {
      state = null;
      clearAdminToken();
      showAuthGate();
      updateAuthStatus(false);
    }
    // Keep the last rendered device list if the admin API is temporarily unreachable.
  }
}

async function autoFillVless() {
  const forceRealityKeys = fields.protocol.value === "vless-reality-tcp";
  const rotatesExistingKeys = forceRealityKeys && Boolean(state?.tunnel?.reality?.publicKey && state?.tunnel?.reality?.privateKey);
  if (rotatesExistingKeys) {
    const confirmed = await requestConfirmation({
      title: "重新生成 REALITY key",
      body: [
        "重新生成 REALITY key 会让已经发出的客户端 VLESS 配置失效。",
        realityRotationImpactSummary()
      ].join("\n"),
      submitText: "重新生成"
    });
    if (!confirmed) return;
  }

  const result = await runAction("正在补全 VLESS 参数...", "VLESS 参数已补全。", () =>
    api("/api/admin/tunnel/autofill", {
      protocol: fields.protocol.value,
      remark: fields.remark.value,
      publicHost: fields.publicHost.value,
      publicPort: Number(fields.publicPort.value || 45678),
      listenPort: Number(fields.listenPort.value || fields.publicPort.value || 45678),
      serverName: fields.realityServerName.value,
      fingerprint: fields.realityFingerprint.value || "chrome",
      forceRealityKeys,
      confirmRotateRealityKeys: rotatesExistingKeys ? true : undefined
    })
  );
  if (!result) return;
  state = result.state;
  renderDebugJson(result.tunnel);
  renderState();
}

async function generateTunnel() {
  const confirmed = await requestConfirmation({
    title: "生成 sing-box 配置",
    body: [
      "此操作会写入服务端 sing-box 配置，并可能要求重启 sing-box 后才生效。",
      tunnelImpactSummary(),
      "确认当前公网地址、端口和 REALITY 参数无误后继续。"
    ].join("\n"),
    submitText: "生成配置"
  });
  if (!confirmed) return;

  const privateKey = readOptionalSecret(fields.realityPrivateKey.value);
  const result = await runAction("正在生成 sing-box 配置...", "sing-box 配置已生成，请点击“重启并应用”。", () =>
    api("/api/admin/tunnel/generate", {
      protocol: fields.protocol.value,
      remark: fields.remark.value,
      publicHost: fields.publicHost.value,
      publicPort: Number(fields.publicPort.value || 45678),
      listenPort: Number(fields.listenPort.value || 45678),
      confirmGenerateTunnel: true,
      reality: {
        serverName: fields.realityServerName.value,
        fingerprint: fields.realityFingerprint.value || "chrome",
        publicKey: fields.realityPublicKey.value,
        privateKey,
        shortId: fields.realityShortId.value
      }
    })
  );
  if (!result) return;
  state = result.state;
  renderState();
  await renderLatestSingboxConfigPreview(result.config);
}

async function refreshSingboxConfigPreview() {
  const result = await runAction("正在读取 sing-box 配置预览...", "sing-box 配置预览已刷新。", () =>
    readSingboxConfigPreview()
  );
  if (!result) return;
  renderSingboxConfigPreview(result);
}

async function readSingboxConfigPreview() {
  return api("/api/admin/singbox/config");
}

async function renderLatestSingboxConfigPreview(config) {
  if (config) {
    renderTunnelJson(config);
    return;
  }
  try {
    renderSingboxConfigPreview(await readSingboxConfigPreview());
  } catch (error) {
    setAction(`操作已完成，但配置预览刷新失败：${formatActionError(error)}`, "warn");
  }
}

function renderSingboxConfigPreview(result) {
  renderTunnelJson({
    path: result.path,
    config: result.config
  });
}

async function saveStorage() {
  const payload = {
    remoteName: fields.remoteName.value,
    bucket: fields.bucket.value,
    endpoint: fields.endpoint.value,
    accessKeyId: fields.accessKeyId.value,
    prefixRoot: fields.prefixRoot.value,
    sharedPrefix: fields.sharedPrefix.value
  };
  const secretAccessKey = readOptionalSecret(fields.secretAccessKey.value);
  if (secretAccessKey !== undefined) {
    payload.secretAccessKey = secretAccessKey;
  }
  const result = await runAction("正在保存存储参数...", "存储参数已保存。", () =>
    api("/api/admin/storage/save", payload)
  );
  if (!result) return;
  state = result.state;
  renderDebugJson(result.storage);
  renderState();
}

async function refreshBuckets() {
  setAction("正在刷新仓库列表...");
  let result;
  try {
    result = await api("/api/admin/storage/buckets/refresh", {});
  } catch (error) {
    setAction(formatActionError(error), "bad");
    return;
  }
  if (!result) return;
  state = result.state;
  renderDebugJson({
    ok: result.ok,
    errorCode: result.errorCode || "",
    warning: result.warning || "",
    buckets: result.buckets
  });
  if (result.ok === false) {
    setAction(formatBucketRefreshWarning(result), "bad");
  } else {
    setAction("仓库列表已刷新。", "good");
  }
  renderState();
}

async function createBucket() {
  const result = await runAction("正在创建仓库...", "仓库创建请求已完成。", () =>
    api("/api/admin/storage/buckets/create", {
      bucket: fields.newBucketName.value
    })
  );
  if (!result) return;
  state = result.state;
  if (result.provision?.ok === false) {
    setAction(formatBucketProvisionWarning(result.provision, result.bucket?.name), "warn");
  }
  renderDebugJson({
    bucket: result.bucket,
    provision: result.provision
  });
  renderState();
}

async function handleBucketAction(event) {
  const button = event.target.closest("button[data-bucket-action]");
  if (!button) return;

  const action = button.dataset.bucketAction;
  const bucket = button.dataset.bucket;
  if (!bucket) return;

  let confirmation = null;
  if (action === "clear") {
    confirmation = await requestConfirmation({
      title: "清空同步仓库",
      body: `这会删除 ${bucket} 中的所有对象，但保留 bucket。本操作不可撤销。`,
      requiredText: bucket,
      submitText: "清空数据"
    });
    if (!confirmation) return;
  }
  if (action === "delete-empty") {
    confirmation = await requestConfirmation({
      title: "删除空仓库",
      body: `仅当 ${bucket} 为空时才会删除。删除后需要重新选择默认仓库。`,
      requiredText: bucket,
      submitText: "删除仓库"
    });
    if (!confirmation) return;
  }

  const pathByAction = {
    enable: "/api/admin/storage/buckets/enable",
    disable: "/api/admin/storage/buckets/disable",
    clear: "/api/admin/storage/buckets/clear",
    "delete-empty": "/api/admin/storage/buckets/delete-empty"
  };
  const path = pathByAction[action];
  if (!path) return;

  button.disabled = true;
  try {
    const result = await runAction(bucketActionPendingText(action, bucket), bucketActionSuccessText(action, bucket), () =>
      api(path, {
        bucket,
        confirmBucket: confirmation?.text
      })
    );
    if (!result) return;
    state = result.state;
    renderDebugJson({
      action,
      bucket,
      result: result.result || result.bucket || result.storage
    });
    renderState();
  } catch (error) {
    byId("profileOut").textContent = `${bucket} 操作失败：${formatActionError(error)}`;
  } finally {
    button.disabled = false;
  }
}

async function applySingbox() {
  if (!state?.tunnel?.restartRequired) return;
  const confirmed = await requestConfirmation({
    title: "重启并应用 sing-box",
    body: [
      "服务将校验最新配置并重启 sing-box，现有隧道连接会短暂中断后自动恢复。",
      `最近写入时间：${formatTime(state.tunnel.lastConfigWrittenAt)}。`,
      "配置校验或重启失败时会继续保持待应用状态。"
    ].join("\n"),
    submitText: "重启并应用"
  });
  if (!confirmed) return;

  const result = await runAction("正在校验配置并重启 sing-box...", "sing-box 已重启并应用最新配置。", () =>
    api("/api/admin/singbox/apply", {
      confirmApplySingbox: true
    })
  );
  if (!result) return;
  state = result.state;
  renderState();
}

async function handleDeviceAction(event) {
  const button = event.target.closest("[data-device-action]");
  if (!button) return;
  const action = button.dataset.deviceAction;
  const userId = button.dataset.userId;
  const clientName = button.dataset.clientName || "设备";
  if (!userId) return;
  const device = findDeviceById(userId);

  if (action === "copy-vless-uri") {
    await revealAndCopyDeviceVlessUri(button, device, clientName);
    return;
  }

  let confirmation = null;
  let compatibilityConfirmation = null;
  if (action === "enable" && device?.compatibility?.policy && (
    device.compatibility.policy.profileIssue === "warn" ||
    device.compatibility.policy.syncRun === "warn"
  )) {
    compatibilityConfirmation = await requestConfirmation({
      title: "确认启用不兼容设备",
      body: `${clientName} 当前为 ${formatCompatibility(device.compatibility)}。${compatibilityImpactText(device.compatibility)}`,
      submitText: "继续启用"
    });
    if (!compatibilityConfirmation) return;
  }
  if (action === "delete") {
    confirmation = await requestConfirmation({
      title: "删除设备",
      body: `这会停用并隐藏 ${clientName}，旧客户端将无法继续上报心跳。本操作不会删除 bucket 中的数据。`,
      requiredText: clientName,
      submitText: "删除设备"
    });
    if (!confirmation) return;
  }

  const pathByAction = {
    enable: "/api/admin/users/enable",
    disable: "/api/admin/users/disable",
    delete: "/api/admin/users/delete"
  };
  const path = pathByAction[action];
  if (!path) return;

  button.disabled = true;
  try {
    const result = await runAction(deviceActionPendingText(action, clientName), deviceActionSuccessText(action, clientName), () =>
      api(path, {
        userId,
        confirmText: confirmation?.text,
        confirmCompatibilityWarning: Boolean(compatibilityConfirmation)
      })
    );
    if (!result) return;
    state = result.state;
    renderDebugJson({
      action,
      user: result.user || result.deletedUserId,
      restartRequired: result.state?.tunnel?.restartRequired
    });
    renderState();
    await renderLatestSingboxConfigPreview(result.config);
  } catch (error) {
    renderDebugJson({ action, clientName, error: formatActionError(error) });
  } finally {
    button.disabled = false;
  }
}

async function revealAndCopyDeviceVlessUri(button, device, clientName) {
  const revealPath = device?.vlessUriRevealPath;
  if (!revealPath) {
    setAction(`${clientName} 暂无可复制的 VLESS URI。`, "warn");
    return;
  }
  const confirmed = await requestConfirmation({
    title: "复制完整 VLESS URI",
    body: `${clientName} 的完整 VLESS URI 可直接配置客户端连接参数。仅在需要手动排查或迁移配置时复制。`,
    submitText: "复制 URI"
  });
  if (!confirmed) return;

  button.disabled = true;
  try {
    const result = await api(revealPath);
    const value = result.vlessUri || "";
    if (!value) {
      setAction("服务端未返回可复制的 VLESS URI。", "bad");
      return;
    }
    await navigator.clipboard.writeText(value);
    const textarea = button.closest(".advanced")?.querySelector("textarea");
    if (textarea) {
      textarea.value = maskSensitiveString(value);
    }
    setAction(`${clientName} 的完整 VLESS URI 已复制。`, "good");
  } catch (error) {
    setAction(`复制 VLESS URI 失败：${formatActionError(error)}`, "bad");
  } finally {
    button.disabled = false;
  }
}

async function createClaim() {
  const targetDevice = findDeviceByName(fields.deviceName.value);
  if (targetDevice?.enabled === false) {
    const message = `${targetDevice.clientName} 已停用。请先在设备列表中重新启用，再生成 SyncKey。`;
    setAction(message, "bad");
    renderDebugJson({
      action: "claims/create",
      clientName: targetDevice.clientName,
      errorCode: "device_disabled",
      message
    });
    return;
  }
  let compatibilityConfirmation = null;
  if (targetDevice?.compatibility?.policy?.profileIssue === "warn") {
    compatibilityConfirmation = await requestConfirmation({
      title: "确认向不兼容设备下发 SyncKey",
      body: `${targetDevice.clientName} 当前为 ${formatCompatibility(targetDevice.compatibility)}。${compatibilityImpactText(targetDevice.compatibility)}`,
      submitText: "继续生成 SyncKey"
    });
    if (!compatibilityConfirmation) return;
  }

  const syncSpaceId = fields.syncSpaceSelect.value || "";
  const result = await runAction(
    "正在生成 SyncKey...",
    "SyncKey 已生成，请复制到客户端导入。",
    () => api("/api/claims/create", {
      clientName: fields.deviceName.value,
      ...(syncSpaceId ? {
        syncSpaceId,
        requestedRole: fields.syncSpaceRole.value
      } : {
        bucketName: fields.bucketSelect.value
      }),
      server: fields.claimServer.value,
      expiresInHours: Number(fields.expiresInHours.value || 24),
      confirmCompatibilityWarning: Boolean(compatibilityConfirmation),
      defaults: readDefaults()
    }),
    { errorFormatter: formatClaimCreateError }
  );
  if (!result) return;
  state = result.state;
  latestClaimTKey = result.tKey || result.claimCode || "";
  latestClaimUri = result.tKeyUri || result.uri || "";
  latestClaimShortCode = result.code || result.claim?.code || "";
  byId("claimOut").value = latestClaimTKey;
  renderClaimResult(result);
  renderDebugJson({
    code: result.code,
    tKey: result.tKey,
    tKeyUri: result.tKeyUri,
    compatibility: result.compatibility,
    profile: result.profile
  });
  renderState();
  await renderLatestSingboxConfigPreview();
}

async function createSyncSpace() {
  const syncId = fields.newSyncId.value.trim();
  const ownerUserId = fields.syncSpaceOwnerSelect.value;
  if (!syncId || !ownerUserId) {
    setAction("请填写同步 ID 并选择 Owner 设备。", "warn");
    return;
  }
  const result = await runAction("正在创建同步空间...", "同步空间已创建。", () =>
    api("/api/admin/sync-spaces/create", { syncId, ownerUserId })
  );
  if (!result) return;
  state = result.state;
  fields.newSyncId.value = "";
  renderState();
  fields.syncSpaceSelect.value = result.syncSpace.id;
  fields.syncSpaceRole.value = "writer";
  renderDebugJson({ syncSpace: result.syncSpace });
}

async function redeemPreview() {
  const code = byId("claimOut").value.trim();
  if (!code) return;
  const confirmed = await requestConfirmation({
    title: "测试兑换会消耗 SyncKey",
    body: "SyncKey 是一次性的。测试兑换成功后，这个 SyncKey 将不能再导入客户端。仅在你确认要验证并作废它时继续。",
    requiredText: "消耗 SyncKey",
    submitText: "确认兑换"
  });
  if (!confirmed) return;

  const profile = await runAction(
    "正在测试兑换 SyncKey...",
    "SyncKey 已兑换，此 SyncKey 已作废。",
    () => api("/api/claims/redeem", { code }),
    { errorFormatter: formatClaimRedeemPreviewError }
  );
  if (!profile) return;
  renderDebugJson(profile);
  await loadState();
}

async function copyClaim() {
  const value = latestClaimTKey || byId("claimOut").value;
  if (!value) {
    setAction("请先生成 SyncKey。");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    setAction("完整 SyncKey 已复制。", "good");
  } catch {
    setAction("复制失败，当前浏览器不允许访问剪贴板。", "bad");
  }
}

async function copyClaimUri() {
  const value = latestClaimUri;
  if (!value) {
    setAction("请先生成 SyncKey。");
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    setAction("导入 URI 已复制。", "good");
  } catch {
    setAction("复制失败，当前浏览器不允许访问剪贴板。", "bad");
  }
}

async function loginAdmin(event) {
  event.preventDefault();
  const token = fields.adminTokenInput.value.trim();
  if (!token) {
    setAuthMessage("请输入管理 Token");
    return;
  }

  adminToken = token;
  localStorage.setItem(adminTokenStorageKey, adminToken);
  try {
    await api("/api/admin/auth/check", null, { auth: true });
  } catch (error) {
    clearAdminToken();
    updateAuthStatus(false);
    setAuthMessage(error.code === "admin_auth_required" ? "管理 Token 不正确" : error.message);
    return;
  }

  fields.adminTokenInput.value = "";
  hideAuthGate();
  updateAuthStatus(true);
  try {
    await loadState();
  } catch (error) {
    setAction(`控制台状态加载失败：${formatActionError(error)}`, "bad");
  }
}

function logoutAdmin() {
  clearAdminToken();
  state = null;
  updateAuthStatus(false);
  if (adminAuthEnabled) {
    showAuthGate();
  } else {
    loadState().catch(() => {});
  }
}

function showAuthGate() {
  if (!adminAuthEnabled) return;
  const gate = byId("authGate");
  gate.hidden = false;
  gate.classList.add("open");
  setAuthMessage("");
  setTimeout(() => fields.adminTokenInput.focus(), 0);
}

function hideAuthGate() {
  const gate = byId("authGate");
  gate.classList.remove("open");
  gate.hidden = true;
  setAuthMessage("");
}

function setAuthMessage(message) {
  const target = byId("authMessage");
  target.hidden = !message;
  target.textContent = message || "";
}

function setAction(message, state = "") {
  const target = byId("actionMessage");
  if (!target) return;
  target.hidden = !message;
  target.textContent = message || "";
  target.className = state ? `notice ${state}` : "notice";
}

function formatBucketProvisionWarning(provision = {}, bucketName = "") {
  const bucket = bucketName || "该同步仓库";
  const error = {
    code: provision.errorCode || "storage_request_failed",
    message: provision.warning || ""
  };
  return `${bucket} 已登记，但远端 MinIO/S3 创建未确认。${formatActionError(error)}`;
}

function formatBucketRefreshWarning(result = {}) {
  return formatActionError({
    code: result.errorCode || "storage_request_failed",
    message: result.warning || ""
  });
}

async function runAction(pendingText, successText, action, options = {}) {
  setAction(pendingText);
  try {
    const result = await action();
    setAction(successText, "good");
    return result;
  } catch (error) {
    const formatter = options.errorFormatter || formatActionError;
    setAction(formatter(error), "bad");
    return null;
  }
}

function bucketActionPendingText(action, bucket) {
  const text = {
    enable: `正在启用 ${bucket}...`,
    disable: `正在停用 ${bucket}...`,
    clear: `正在清空 ${bucket}...`,
    "delete-empty": `正在删除空仓库 ${bucket}...`
  };
  return text[action] || `正在操作 ${bucket}...`;
}

function bucketActionSuccessText(action, bucket) {
  const text = {
    enable: `${bucket} 已启用。`,
    disable: `${bucket} 已停用。`,
    clear: `${bucket} 已清空。`,
    "delete-empty": `${bucket} 已删除。`
  };
  return text[action] || `${bucket} 操作已完成。`;
}

function deviceActionPendingText(action, clientName) {
  const text = {
    enable: `正在启用 ${clientName}...`,
    disable: `正在停用 ${clientName}...`,
    delete: `正在删除 ${clientName}...`
  };
  return text[action] || `正在操作 ${clientName}...`;
}

function deviceActionSuccessText(action, clientName) {
  const text = {
    enable: `${clientName} 已启用，配置已写入；请点击“重启并应用”。`,
    disable: `${clientName} 已停用，配置已写入；请点击“重启并应用”。`,
    delete: `${clientName} 已删除，配置已写入；请点击“重启并应用”。`
  };
  return text[action] || `${clientName} 操作已完成。`;
}

function formatError(error) {
  const copy = {
    admin_auth_required: "管理 Token 不正确或已失效，请重新登录。",
    binary_version_check_failed: "客户端组件存在但版本检测失败，请重新解压或重新安装。",
    bucket_disabled: "该同步仓库已停用，请选择其他仓库。",
    bucket_not_empty: "仓库内仍有数据，请先清空后再删除。",
    bucket_not_found: "找不到这个同步仓库，请刷新仓库列表。",
    claim_already_used: "这个 SyncKey 已经使用过，请重新生成。",
    claim_expired: "这个 SyncKey 已过期，请重新生成。",
    claim_not_found: "这个 SyncKey 不存在，请确认是否复制完整。",
    claim_redeem_rate_limited: "SyncKey 兑换失败次数过多，请稍后再试或重新生成。",
    claim_redeem_failed: "客户端兑换 SyncKey 失败，请检查服务地址和网络。",
    client_error: "客户端发生未知错误，请查看客户端诊断包。",
    client_port_in_use: "客户端本地端口被占用，请关闭重复实例后重试。",
    danger_confirmation_required: "请按提示完成二次确认后再继续。",
    device_disabled: "该设备已被停用，请在服务端重新启用后再继续。",
    device_not_found: "当前客户端未在服务端登记，请重新生成并导入 SyncKey。",
    heartbeat_auth_invalid: "客户端心跳签名无效，请重新导入 SyncKey。",
    heartbeat_auth_required: "客户端心跳缺少签名，请重新导入 SyncKey。",
    heartbeat_failed: "无法接收客户端心跳，设备在线状态可能延迟。",
    import_code_required: "请先填写服务端生成的 SyncKey。",
    import_code_invalid: "SyncKey 格式不正确，请重新复制。",
    invalid_json: "请求内容不是合法 JSON，请刷新页面后重试。",
    invalid_path: "请求的资源路径非法，请刷新页面后重试。",
    invalid_vless_uri: "VLESS 链接格式不正确，请检查参数。",
    last_active_bucket_disable_blocked: "至少需要保留一个启用的同步仓库。",
    last_bucket_delete_blocked: "至少需要保留一个同步仓库。",
    local_state_corrupt: "客户端本地状态文件损坏，请先导出诊断包，备份并修复或隔离损坏 JSON 后再按需重新导入 SyncKey。",
    local_write_forbidden: "客户端本地写入请求被拒绝，请从客户端窗口内操作。",
    missing_rclone_binary: "客户端缺少 rclone 组件，请重新解压或重新安装。",
    missing_singbox_binary: "客户端缺少 sing-box 组件，请重新解压或重新安装。",
    network_error: "无法连接服务，请检查服务是否正在运行。",
    not_found: "请求的接口或资源不存在，请确认双端版本是否匹配。",
    profile_heartbeat_required: "服务端签发 profile 缺少心跳密钥，请重新生成 SyncKey。",
    profile_not_imported: "客户端尚未导入 SyncKey，请先完成导入。",
    profile_storage_required: "服务端签发 profile 缺少存储凭据，请重新生成 SyncKey。",
    profile_tunnel_required: "profile 缺少隧道 URI，请重新生成 SyncKey。",
    request_body_too_large: "请求内容过大，请减少输入内容后重试。",
    rclone_config_failed: "客户端同步配置写入失败，请检查存储配置和权限。",
    rclone_sync_failed: "同步失败，请查看客户端 rclone 日志。",
    secret_vault_missing: "客户端密钥库缺少同步密钥，请重新导入 SyncKey。",
    server_error: "服务端发生未知错误，请查看 sync-server 日志。",
    server_singbox_config_write_failed: "服务端 sing-box 配置写入失败，请检查配置路径和权限。",
    server_state_corrupt: "服务端状态文件损坏，请先备份并修复 sfsc-state.json。",
    server_state_locked: "服务端数据目录已有运行中的写入者，请检查是否重复启动 sync-server。",
    server_state_write_failed: "服务端状态文件写入失败，请检查数据目录权限和磁盘空间。",
    singbox_restart_failed: "sing-box 重启失败，请检查配置和服务端日志。",
    singbox_restart_timeout: "等待 sing-box 重启超时，请稍后重试或检查服务状态。",
    singbox_restart_unavailable: "sing-box 重启服务未配置，请检查服务端部署。",
    singbox_start_failed: "客户端隧道启动失败，请查看客户端诊断日志。",
    storage_request_failed: "存储服务请求失败，请检查 MinIO、地址和密钥。",
    sync_already_running: "客户端已有其他同步任务正在运行，请等待完成后再启动这个任务。",
    request_timeout: "请求服务超时，请稍后重试。",
    unsupported_media_type: "请求内容类型不受支持，请刷新页面后重试。",
    unsupported_profile_version: "当前客户端不支持这个配置版本，请升级客户端。",
    user_not_found: "找不到这个设备，请刷新页面后重试。",
    validation_failed: "输入内容不符合要求，请检查后重试。"
  };
  return copy[error?.code] || error?.message || "操作失败";
}

function formatActionError(error) {
  const reason = formatError(error);
  const suggestion = recoverySuggestion(error);
  return suggestion ? `${reason} 建议：${suggestion}` : reason;
}

function formatClaimCreateError(error) {
  const item = claimCreateErrorGuidance(error?.code);
  if (!item) {
    return `SyncKey 未生成：${formatActionError(error)}`;
  }
  return `SyncKey 未生成：${item.message} ${item.action}`;
}

function claimCreateErrorGuidance(code) {
  const guidance = {
    server_state_write_failed: {
      retryable: true,
      message: "服务端没能保存 SyncKey 和设备状态。",
      action: "可重试：请检查 sfsc-state.json 数据目录权限和磁盘空间，修复后重新生成 SyncKey。"
    },
    network_error: {
      retryable: true,
      message: "控制台无法连接 sync-server。",
      action: "可重试：请确认 sync-server 容器、反代和端口可访问，然后重新生成 SyncKey。"
    },
    request_timeout: {
      retryable: true,
      message: "生成 SyncKey 请求超时。",
      action: "可重试：请检查 N1 负载和 sync-server 日志，确认没有长时间写入后重新生成 SyncKey。"
    },
    danger_confirmation_required: {
      retryable: false,
      message: "该设备存在协议兼容性风险，服务端拒绝直接生成 SyncKey。",
      action: "请按弹窗确认兼容性风险后再生成 SyncKey。"
    },
    device_disabled: {
      retryable: false,
      message: "目标设备已停用。",
      action: "请先在设备列表中重新启用并应用 sing-box 配置，再重新生成 SyncKey。"
    },
    bucket_disabled: {
      retryable: false,
      message: "选择的同步仓库已停用。",
      action: "请启用该仓库，或选择其他启用的同步仓库后重新生成 SyncKey。"
    },
    bucket_not_found: {
      retryable: false,
      message: "服务端找不到选择的同步仓库。",
      action: "请刷新仓库列表并选择仍存在的仓库后重新生成 SyncKey。"
    },
    user_not_found: {
      retryable: false,
      message: "服务端找不到目标设备。",
      action: "请刷新设备列表；如果设备已删除，请输入设备名重新登记并生成 SyncKey。"
    },
    validation_failed: {
      retryable: false,
      message: "SyncKey 表单内容不符合要求。",
      action: "请检查设备名、SyncKey 服务地址、有效期、同步参数和仓库选择后重新生成。"
    },
    storage_request_failed: {
      retryable: true,
      message: "存储服务请求失败，SyncKey 生成流程没有完成。",
      action: "可重试：请检查 MinIO/S3 endpoint、密钥和 bucket 权限后重新生成 SyncKey。"
    },
    server_error: {
      retryable: true,
      message: "服务端生成 SyncKey 时发生未知错误。",
      action: "可重试：请查看 sync-server 日志，修复后重新生成 SyncKey。"
    }
  };
  return guidance[code] || null;
}

function formatClaimRedeemPreviewError(error) {
  const item = claimRedeemPreviewErrorGuidance(error?.code);
  if (!item) {
    return `SyncKey 测试兑换失败：${formatActionError(error)}`;
  }
  return `SyncKey 测试兑换失败：${item.message} ${item.action}`;
}

function claimRedeemPreviewErrorGuidance(code) {
  const guidance = {
    claim_not_found: {
      retryable: false,
      message: "服务端找不到这个 SyncKey。",
      action: "不可重试当前 SyncKey：请重新复制完整 SyncKey；如果仍失败，请在服务端重新生成 SyncKey。"
    },
    claim_already_used: {
      retryable: false,
      message: "这个 SyncKey 已经被兑换。",
      action: "不可重试当前 SyncKey：请刷新管理状态查看 claim 是否已 used/redeemedAt；需要导入客户端时重新生成 SyncKey。"
    },
    claim_expired: {
      retryable: false,
      message: "这个 SyncKey 已过期。",
      action: "不可重试当前 SyncKey：请在服务端重新生成 SyncKey。"
    },
    validation_failed: {
      retryable: false,
      message: "测试兑换请求内容不符合要求。",
      action: "不可重试当前内容：请重新复制完整 SyncKey，不要粘贴短码或截断内容。"
    },
    import_code_invalid: {
      retryable: false,
      message: "SyncKey 格式不正确。",
      action: "不可重试当前内容：请重新复制完整 SyncKey，不要粘贴短码或截断内容。"
    },
    claim_redeem_rate_limited: {
      retryable: true,
      message: "测试兑换失败次数过多，服务端已临时限速。",
      action: "可重试：请等待限速窗口，检查是否误粘贴或自动化重复提交；无法确认时重新生成 SyncKey。"
    },
    server_state_write_failed: {
      retryable: true,
      message: "服务端没能保存兑换状态，SyncKey 不应视为已消耗。",
      action: "可重试：兑换状态未成功持久化；请检查 sfsc-state.json 数据目录权限和磁盘空间，修复后用同一个 SyncKey 再试。"
    },
    network_error: {
      retryable: false,
      message: "控制台无法确认测试兑换结果。",
      action: "结果未知：请先刷新管理状态查看 claim 是否已 used/redeemedAt，不要把这个 SyncKey 交给客户端；无法确认时重新生成 SyncKey。"
    },
    request_timeout: {
      retryable: false,
      message: "测试兑换请求超时，结果可能已经在服务端完成。",
      action: "结果未知：请先刷新管理状态查看 claim 是否已 used/redeemedAt，不要把这个 SyncKey 交给客户端；无法确认时重新生成 SyncKey。"
    },
    server_error: {
      retryable: false,
      message: "服务端测试兑换时发生未知错误。",
      action: "结果未知：请先刷新管理状态查看 claim 是否已 used/redeemedAt，不要把这个 SyncKey 交给客户端；无法确认时重新生成 SyncKey。"
    },
    claim_redeem_failed: {
      retryable: false,
      message: "测试兑换没有得到可靠结果。",
      action: "结果未知：请先刷新管理状态查看 claim 是否已 used/redeemedAt，不要把这个 SyncKey 交给客户端；无法确认时重新生成 SyncKey。"
    }
  };
  return guidance[code] || null;
}

function recoverySuggestion(error = {}) {
  const suggestions = {
    admin_auth_required: "重新登录管理控制台，确认使用的是 N1 .env 中的 SFSC_ADMIN_TOKEN。",
    bucket_disabled: "先在同步仓库中启用该 bucket，或生成 SyncKey 时选择其他可用仓库。",
    bucket_not_empty: "确认 bucket 内数据已备份；确实要删除时先使用“清空数据”，再删除空仓库。",
    bucket_not_found: "点击“刷新仓库”，确认 MinIO 中 bucket 仍存在后再重试。",
    danger_confirmation_required: "按弹窗要求输入确认文本或勾选兼容性确认后重试。",
    device_disabled: "在设备列表中重新启用该设备，并重新生成/应用 sing-box 配置。",
    device_not_found: "刷新设备列表；如果设备已删除，请重新生成 SyncKey 并在客户端导入。",
    last_active_bucket_disable_blocked: "先启用另一个 bucket 并设为可用，再停用当前 bucket。",
    last_bucket_delete_blocked: "至少保留一个同步仓库；先创建新 bucket 后再删除当前 bucket。",
    network_error: "确认 sync-server 容器正在运行，反代或端口可以访问。",
    request_timeout: "等待当前操作完成后刷新页面；如果持续超时，请检查 N1 负载和 sync-server 日志。",
    storage_request_failed: "检查 MinIO 容器、endpoint、access key/secret，以及 bucket 权限。",
    validation_failed: "检查输入格式、端口范围、bucket 名称、URL 和计划参数。",
    user_not_found: "刷新设备列表；如果设备已迁移或删除，请重新生成 SyncKey。"
  };
  return suggestions[error?.code] || "";
}

function renderDebugJson(value) {
  byId("profileOut").textContent = JSON.stringify(maskSensitiveForDisplay(value), null, 2);
}

function renderTunnelJson(value) {
  byId("tunnelOut").textContent = JSON.stringify(maskSensitiveForDisplay(value), null, 2);
}

function maskSensitiveForDisplay(value) {
  if (Array.isArray(value)) {
    return value.map(maskSensitiveForDisplay);
  }
  if (typeof value === "string") {
    return maskSensitiveString(value);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const next = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = isSensitiveDisplayKey(key) ? maskDisplaySecret(item) : maskSensitiveForDisplay(item);
  }
  return next;
}

function isSensitiveDisplayKey(key) {
  return /^(secret|secretAccessKey|secret_access_key|heartbeatSecret|heartbeatAuthNonces|privateKey|private_key|tKey|tKeyUri|claimCode|token)$/i.test(key);
}

function maskSensitiveString(value) {
  const text = String(value || "");
  return text
    .replace(/\bSFSC1-[A-Za-z0-9_-]+/g, "SFSC1-****")
    .replace(/\bsfsc:\/\/import\/v1#[A-Za-z0-9_-]+/gi, "sfsc://import/v1#****")
    .replace(/\bvless:\/\/[^\s"',<>]+/gi, "vless://****");
}

function maskDisplaySecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.includes("***")) return text;
  return text.length <= 6 ? "****" : `${text.slice(0, 3)}***${text.slice(-3)}`;
}

function clearAdminToken() {
  adminToken = "";
  localStorage.removeItem(adminTokenStorageKey);
}

function updateAuthStatus(authenticated) {
  const status = byId("authStatus");
  const logoutBtn = byId("logoutBtn");
  if (!adminAuthEnabled) {
    status.textContent = "认证未启用";
    status.className = "pill warn";
    logoutBtn.hidden = true;
    return;
  }
  status.textContent = authenticated ? "已登录" : "未登录";
  status.className = authenticated ? "pill good" : "pill warn";
  logoutBtn.hidden = !authenticated;
}

function requestConfirmation(options = {}) {
  if (pendingConfirmation) {
    pendingConfirmation.resolve(null);
  }
  const gate = byId("confirmGate");
  const form = byId("confirmForm");
  const textLabel = byId("confirmTextLabel");
  const textInput = byId("confirmTextInput");
  const submitBtn = byId("confirmSubmitBtn");

  byId("confirmTitle").textContent = options.title || "确认操作";
  byId("confirmBody").textContent = options.body || "";
  submitBtn.textContent = options.submitText || "确认";
  textLabel.hidden = !options.requiredText;
  textInput.value = "";
  textInput.placeholder = options.requiredText ? `输入 ${options.requiredText}` : "";
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
    form.dataset.active = "true";
  });
}

function submitConfirmation(event) {
  event.preventDefault();
  if (!pendingConfirmation) return;

  const requiredText = pendingConfirmation.requiredText;
  const actualText = byId("confirmTextInput").value.trim();
  if (requiredText && actualText !== requiredText) {
    setConfirmMessage(`请输入 ${requiredText} 以确认。`);
    return;
  }

  const resolve = pendingConfirmation.resolve;
  closeConfirmation();
  resolve({
    text: actualText || requiredText,
    confirmed: true
  });
}

function cancelConfirmation() {
  if (!pendingConfirmation) return;
  const resolve = pendingConfirmation.resolve;
  closeConfirmation();
  resolve(null);
}

function closeConfirmation() {
  pendingConfirmation = null;
  const gate = byId("confirmGate");
  gate.classList.remove("open");
  gate.hidden = true;
  byId("confirmForm").dataset.active = "";
  setConfirmMessage("");
}

function setConfirmMessage(message) {
  const target = byId("confirmMessage");
  target.hidden = !message;
  target.textContent = message || "";
}

function renderState() {
  if (!state) return;
  renderStatStrip();
  renderVless();
  renderApplyNotice();
  renderStorage();
  renderSyncSpaces();
  renderDevices();
  toggleRealitySettings();
}

function switchTab(tabId) {
  if (!tabId) return;
  document.querySelectorAll("[data-tab-target]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tabTarget === tabId);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
}

function renderStatStrip() {
  const tunnel = state.tunnel || {};
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const enabledDevices = devices.filter((device) => device.enabled !== false);
  const onlineDevices = enabledDevices.filter((device) => device.online);
  const syncingDevices = enabledDevices.filter((device) => {
    const syncState = currentDeviceSyncState(device);
    return syncState === "syncing" || syncState === "running";
  });
  const buckets = Array.isArray(state.storage?.buckets) ? state.storage.buckets : [];
  const totalBytes = buckets.reduce((sum, bucket) => sum + (Number(bucket.sizeBytes) || 0), 0);

  setStatValue("statTunnelValue", tunnel.restartRequired ? "待重启" : tunnel.protocol ? "已配置" : "未配置", tunnel.restartRequired ? "warn" : "ok");
  setStatText("statTunnelSub", tunnel.protocol
    ? `${tunnel.protocol}${tunnel.publicPort ? ` · :${tunnel.publicPort}` : ""}`
    : "尚未生成隧道配置");
  setStatValue("statOnlineDevicesValue", `${onlineDevices.length} / ${enabledDevices.length}`, onlineDevices.length ? "ok" : "warn");
  setStatText("statOnlineDevicesSub", enabledDevices.length
    ? `${Math.max(enabledDevices.length - onlineDevices.length, 0)} 台离线`
    : "暂无启用设备");
  setStatValue("statSyncingValue", String(syncingDevices.length), syncingDevices.length ? "ok" : "");
  setStatText("statSyncingSub", syncingDevices.length
    ? syncingDevices.map((device) => device.clientName || device.name || device.id || "未知设备").slice(0, 2).join("、")
    : "暂无同步任务");
  setStatValue("statStorageUsageValue", totalBytes > 0 ? formatStorageBytes(totalBytes) : `${buckets.length} 个仓库`, buckets.length ? "ok" : "warn");
  setStatText("statStorageUsageSub", buckets.length
    ? `${buckets.filter((bucket) => !bucket.disabledAt).length} 个启用仓库`
    : "暂无仓库状态");
}

function setStatValue(id, text, stateClass = "") {
  const target = byId(id);
  target.textContent = text;
  target.classList.remove("ok", "warn");
  if (stateClass) {
    target.classList.add(stateClass);
  }
}

function setStatText(id, text) {
  byId(id).textContent = text;
}

function renderApplyNotice() {
  const tunnel = state.tunnel || {};
  const notice = byId("applyNotice");
  const button = byId("applySingboxBtn");
  if (tunnel.restartRequired) {
    notice.hidden = false;
    notice.className = "apply-notice bad";
    notice.textContent = tunnel.lastConfigWrittenAt
      ? `sing-box 配置已写入但尚未生效。最近写入：${formatTime(tunnel.lastConfigWrittenAt)}。请点击“重启并应用”。`
      : "sing-box 配置已写入但尚未生效。请点击“重启并应用”。";
    button.textContent = "重启并应用";
    button.disabled = false;
    return;
  }
  notice.hidden = false;
  notice.className = "apply-notice good";
  notice.textContent = tunnel.lastAppliedAt
    ? `当前配置已标记为生效，最近应用时间：${formatTime(tunnel.lastAppliedAt)}。`
    : "当前没有待应用的 sing-box 配置变更。生成配置、启停设备或删除设备后这里会提示重新应用。";
  button.textContent = "无需应用";
  button.disabled = true;
}

function renderVless() {
  const tunnel = state.tunnel;
  fields.protocol.value = tunnel.protocol;
  fields.remark.value = tunnel.remark || "sfsc-home";
  fields.publicHost.value = tunnel.publicHost;
  fields.publicPort.value = tunnel.publicPort;
  fields.listenPort.value = tunnel.listenPort;
  fields.claimServer.value = state.settings.publicServerUrl;
  fields.realityServerName.value = tunnel.reality?.serverName || "www.microsoft.com";
  fields.realityFingerprint.value = tunnel.reality?.fingerprint || "chrome";
  fields.realityPublicKey.value = tunnel.reality?.publicKey || "";
  fields.realityPrivateKey.value = "";
  fields.realityPrivateKey.placeholder = tunnel.reality?.privateKey ? "已保存，留空保持不变" : "";
  fields.realityShortId.value = tunnel.reality?.shortId || "";

  byId("tunnelOut").textContent = [
    `协议: ${tunnel.protocol}`,
    `公网: ${tunnel.publicHost}:${tunnel.publicPort}`,
    `监听: ${tunnel.listenHost}:${tunnel.listenPort}`,
    `REALITY SNI: ${tunnel.reality?.serverName || "-"}`,
    `REALITY key: ${tunnel.reality?.publicKey ? "已配置" : "未配置"}`,
    `设备数: ${state.devices.length}`,
    `需要重启 sing-box: ${tunnel.restartRequired ? "是" : "否"}`,
    `最近写入时间: ${formatTime(tunnel.lastConfigWrittenAt)}`,
    `最近应用时间: ${formatTime(tunnel.lastAppliedAt)}`,
    "",
    tunnel.sampleUriAvailable ? "示例 VLESS URI 已隐藏；如需完整 URI，请在设备详情中按需复制。" : "生成设备 SyncKey 后，可在设备详情中按需复制完整 VLESS URI。"
  ].join("\n");
}

function renderStorage() {
  const storage = state.storage;
  fields.remoteName.value = storage.remoteName;
  fields.bucket.value = storage.bucket;
  fields.endpoint.value = storage.endpoint;
  fields.internalEndpoint.value = storage.internalEndpoint;
  fields.accessKeyId.value = storage.accessKeyId;
  fields.secretAccessKey.value = "";
  fields.prefixRoot.value = storage.prefixRoot;
  fields.sharedPrefix.value = storage.sharedPrefix;
  fields.newBucketName.value = storage.bucket || "home-sync";

  const activeBuckets = storage.buckets.filter((bucket) => !bucket.disabledAt);
  const current = fields.bucketSelect.value || storage.bucket;
  fields.bucketSelect.innerHTML = activeBuckets.map((bucket) =>
    `<option value="${escapeHtml(bucket.name)}">${escapeHtml(bucket.name)}</option>`
  ).join("");
  fields.bucketSelect.value = activeBuckets.some((bucket) => bucket.name === current)
    ? current
    : activeBuckets[0]?.name || "";

  byId("bucketList").innerHTML = storage.buckets.length ? storage.buckets.map((bucket) =>
    renderBucketItem(bucket, storage.buckets, activeBuckets)
  ).join("") : `<div class="empty">暂无仓库</div>`;
}

function renderSyncSpaces() {
  const devices = (state?.devices || []).filter((device) => device.enabled !== false);
  const spaces = Array.isArray(state?.syncSpaces) ? state.syncSpaces : [];
  const selectedOwner = fields.syncSpaceOwnerSelect.value;
  const selectedSpace = fields.syncSpaceSelect.value;
  fields.syncSpaceOwnerSelect.innerHTML = devices.length
    ? devices.map((device) => `<option value="${escapeHtml(device.id)}">${escapeHtml(device.clientName)}</option>`).join("")
    : `<option value="">先创建设备</option>`;
  fields.syncSpaceOwnerSelect.value = devices.some((device) => device.id === selectedOwner) ? selectedOwner : devices[0]?.id || "";
  fields.syncSpaceSelect.innerHTML = `<option value="">设备私有空间</option>${spaces.map((space) =>
    `<option value="${escapeHtml(space.id)}">${escapeHtml(space.syncId)} · ${escapeHtml(space.memberCount)} 个成员</option>`
  ).join("")}`;
  fields.syncSpaceSelect.value = spaces.some((space) => space.id === selectedSpace) ? selectedSpace : "";
}

function renderBucketItem(bucket, buckets = [], activeBuckets = []) {
  const bucketName = escapeHtml(bucket.name);
  const toggleAction = bucket.disabledAt ? "enable" : "disable";
  return `
    <article class="item bucket-item ${bucket.disabledAt ? "disabled" : ""}">
      <div>
        <div class="bucket-title">
          <strong>${bucketName}</strong>
          <span class="pill ${bucket.disabledAt ? "warn" : "good"}">${bucket.disabledAt ? "停用" : "可用"}</span>
        </div>
        <span>${escapeHtml(bucket.source || "configured")} · ${escapeHtml(bucket.endpoint)}</span>
        <code>${escapeHtml(bucket.remoteName)}:${bucketName}/</code>
      </div>
      <div class="bucket-actions">
        ${renderBucketActionButton(bucket, toggleAction, bucket.disabledAt ? "启用" : "停用", buckets, activeBuckets)}
        ${renderBucketActionButton(bucket, "clear", "清空数据", buckets, activeBuckets, "danger")}
        ${renderBucketActionButton(bucket, "delete-empty", "删除空仓库", buckets, activeBuckets, "danger")}
      </div>
    </article>
  `;
}

function renderBucketActionButton(bucket, action, label, buckets = [], activeBuckets = [], className = "") {
  const disabledReason = bucketActionDisabledReason(bucket, action, buckets, activeBuckets);
  return `<button${className ? ` class="${className}"` : ""} data-bucket-action="${action}" data-bucket="${escapeHtml(bucket.name)}"${disabledReason ? " disabled" : ""} title="${escapeHtml(disabledReason || label)}">${label}</button>`;
}

function bucketActionDisabledReason(bucket, action, buckets = [], activeBuckets = []) {
  if (action === "disable" && activeBuckets.length <= 1) {
    return "至少需要保留一个启用的同步仓库。";
  }
  if (["clear", "delete-empty"].includes(action) && bucket.disabledAt) {
    return "该同步仓库已停用，请先启用后再操作。";
  }
  if (action === "delete-empty" && buckets.length <= 1) {
    return "至少需要保留一个同步仓库。";
  }
  return "";
}

function renderDevices() {
  const devices = state.devices || [];
  const filteredDevices = filterDevices(devices);
  renderDeviceFilterSummary(devices, filteredDevices);
  byId("deviceList").innerHTML = filteredDevices.length ? filteredDevices.map((device) => `
    <article class="item device-card ${deviceCardClass(device)}">
      <div class="device-row">
        <div>
          <strong>${escapeHtml(device.clientName)}</strong>
          <span>${escapeHtml(device.bucket)} · ${escapeHtml(device.prefix)}</span>
        </div>
        <div class="device-actions">
          <span class="pill ${device.enabled === false ? "warn" : device.online ? "good" : ""}">${device.enabled === false ? "停用" : device.online ? "在线" : "离线"}</span>
          <button data-device-action="${device.enabled === false ? "enable" : "disable"}" data-user-id="${escapeHtml(device.id)}" data-client-name="${escapeHtml(device.clientName)}">${device.enabled === false ? "启用" : "停用"}</button>
          <button class="danger" data-device-action="delete" data-user-id="${escapeHtml(device.id)}" data-client-name="${escapeHtml(device.clientName)}">删除</button>
        </div>
      </div>
      <div class="device-impact ${deviceImpactClass(device)}">${escapeHtml(formatDeviceImpact(device))}</div>
      <div class="meta-grid">
        <span>最近心跳: ${escapeHtml(formatTime(device.lastSeenAt))}</span>
        <span>客户端: ${escapeHtml(device.clientVersion || "-")}</span>
        <span>客户端协议: ${escapeHtml(formatProtocolVersions(device.diagnostics?.protocols))}</span>
        <span>兼容状态: ${escapeHtml(formatCompatibility(device.compatibility))}</span>
        <span>兼容策略: ${escapeHtml(formatCompatibilityPolicy(device.compatibility?.policy))}</span>
        <span>客户端构建: ${escapeHtml(formatBuildInfo(device.diagnostics))}</span>
        <span>来源地址: ${escapeHtml(device.lastRemoteAddress || "-")}</span>
        <span>同步状态: ${escapeHtml(formatSyncState(device.sync?.state || device.syncState))}</span>
        <span>当前速度: ${escapeHtml(formatSpeed(device.sync?.speedMbps ?? device.speedMbps))}</span>
        <span>进度: ${escapeHtml(formatProgress(device.sync?.progressPercent))}</span>
        <span>任务: ${escapeHtml(formatJob(device.sync?.currentJob))}</span>
        <span>当前文件: ${escapeHtml(formatCurrentFile(device.sync))}</span>
        <span>计划: ${escapeHtml(formatScheduler(device.sync?.scheduler))}</span>
        <span>最近结果: ${escapeHtml(formatSyncRun(device.sync?.lastRun))}</span>
      </div>
      <details class="advanced">
        <summary>设备详情</summary>
        <textarea readonly spellcheck="false" data-vless-output="${escapeHtml(device.id)}">${escapeHtml(device.vlessUriAvailable ? "完整 VLESS URI 已隐藏。点击“复制 VLESS URI”时才会按需读取。" : "暂无可复制的 VLESS URI。")}</textarea>
        <button data-device-action="copy-vless-uri" data-user-id="${escapeHtml(device.id)}" data-client-name="${escapeHtml(device.clientName)}"${device.vlessUriAvailable ? "" : " disabled"}>复制 VLESS URI</button>
      </details>
    </article>
  `).join("") : `<div class="empty">${devices.length ? "没有匹配的设备" : "暂无设备，先生成一个设备 SyncKey。"}</div>`;
}

function filterDevices(devices = []) {
  const status = fields.deviceStatusFilter.value || "all";
  const sync = fields.deviceSyncFilter.value || "all";
  const compat = fields.deviceCompatFilter.value || "all";
  const query = fields.deviceSearch.value.trim().toLowerCase();
  return devices.filter((device) => {
    if (!deviceMatchesStatus(device, status)) return false;
    if (!deviceMatchesSync(device, sync)) return false;
    if (!deviceMatchesCompatibility(device, compat)) return false;
    if (query && !deviceSearchText(device).includes(query)) return false;
    return true;
  });
}

function renderDeviceFilterSummary(devices = [], filteredDevices = []) {
  const enabledDevices = devices.filter((device) => device.enabled !== false);
  const onlineCount = enabledDevices.filter((device) => device.online).length;
  const issueCount = enabledDevices.filter((device) =>
    device.compatibility?.ok === false ||
    device.sync?.lastRun?.status === "error" ||
    getDeviceConflictSummary(device).count > 0
  ).length;
  byId("deviceFilterSummary").textContent = [
    `当前显示 ${filteredDevices.length}/${devices.length} 个设备`,
    `启用 ${enabledDevices.length} 个`,
    `在线 ${onlineCount} 个`,
    `需关注 ${issueCount} 个`
  ].join(" · ");
}

function deviceMatchesStatus(device, status) {
  if (status === "all") return true;
  if (status === "disabled") return device.enabled === false;
  if (status === "online") return device.enabled !== false && device.online === true;
  if (status === "offline") return device.enabled !== false && device.online !== true;
  return true;
}

function deviceMatchesSync(device, sync) {
  if (sync === "all") return true;
  const syncState = currentDeviceSyncState(device);
  const lastRunStatus = String(device.sync?.lastRun?.status || "").toLowerCase();
  const lastRun = device.sync?.lastRun || {};
  if (sync === "conflict") return getDeviceConflictSummary(device).count > 0;
  if (sync === "syncing" || sync === "running") return syncState === "syncing" || lastRunStatus === "running";
  if (sync === "idle") return syncState === "idle";
  if (sync === "error") return syncState === "error" || lastRunStatus === "error";
  return syncState === sync;
}

function deviceMatchesCompatibility(device, compat) {
  if (compat === "all") return true;
  if (compat === "compatible") return device.compatibility?.status === "compatible";
  if (compat === "mismatch") return device.compatibility?.status === "mismatch";
  return true;
}

function currentDeviceSyncState(device = {}) {
  return String(device.sync?.state || device.syncState || device.sync?.lastRun?.status || "").toLowerCase();
}

function deviceSearchText(device = {}) {
  const sync = device.sync || {};
  const lastRun = sync.lastRun || {};
  const job = sync.currentJob || lastRun.job || {};
  const conflicts = getDeviceConflictSummary(device);
  const conflictFiles = Array.isArray(conflicts.files) ? conflicts.files : [];
  return [
    device.clientName,
    device.bucket,
    device.prefix,
    device.clientVersion,
    device.lastRemoteAddress,
    formatCompatibility(device.compatibility),
    formatCompatibilityPolicy(device.compatibility?.policy),
    sync.state,
    lastRun.status,
    lastRun.errorCode,
    lastRun.error,
    sync.currentFile,
    lastRun.currentFile,
    job.name,
    job.direction,
    job.remotePrefix,
    ...conflictFiles
  ].filter(Boolean).join(" ").toLowerCase();
}

function renderClaimResult(result = {}) {
  const claim = result.claim || {};
  byId("claimResult").hidden = false;
  byId("claimShortCode").textContent = result.code || claim.code || latestClaimShortCode || "-";
  byId("claimDevice").textContent = claim.clientName || result.profile?.clientName || fields.deviceName.value || "-";
  byId("claimBucket").textContent = claim.bucketName || result.profile?.storage?.bucket || fields.bucketSelect.value || "-";
  byId("claimExpiry").textContent = formatExpiry(claim.expiresAt);
}

function findDeviceByName(input) {
  const name = String(input || "").trim();
  return (state?.devices || []).find((device) => device.clientName === name) || null;
}

function findDeviceById(input) {
  const id = String(input || "").trim();
  return (state?.devices || []).find((device) => device.id === id) || null;
}

function toggleRealitySettings() {
  byId("realitySettings").hidden = fields.protocol.value !== "vless-reality-tcp";
}

function readDefaults() {
  return {
    transfers: Number(fields.transfers.value || 4),
    streams: Number(fields.streams.value || 8),
    checkers: Number(fields.checkers.value || 8),
    chunkSize: fields.chunkSize.value || "16M",
    schedule: readDefaultSchedule()
  };
}

function readDefaultSchedule() {
  const mode = fields.scheduleMode.value;
  if (mode === "interval") {
    const intervalMinutes = Number(fields.scheduleValue.value || 30);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) {
      const error = new Error("计划间隔必须是 1 到 1440 分钟。");
      error.code = "validation_failed";
      throw error;
    }
    return { mode, intervalMinutes };
  }
  if (mode === "daily") {
    const time = String(fields.scheduleValue.value || "02:00").trim();
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
      const error = new Error("每天固定时间必须使用 HH:MM。");
      error.code = "validation_failed";
      throw error;
    }
    return { mode, time };
  }
  return { mode: "manual" };
}

function readOptionalSecret(value) {
  const text = String(value || "").trim();
  return !text || text.includes("***") ? undefined : text;
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
    errorCode: "server_error",
    code: "server_error",
    error: "server_error",
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

async function api(path, body, options = {}) {
  let response;
  const timeoutMs = options.timeoutMs ?? defaultRequestTimeoutMs;
  const controller = typeof AbortController === "function" && timeoutMs > 0
    ? new AbortController()
    : null;
  const timeoutId = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    response = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: buildHeaders(body, options),
      body: body ? JSON.stringify(body) : undefined,
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

  const json = await readJsonOrFallback(response);
  if (!response.ok || json?.nonJson === true) {
    const error = new Error(json.message || json.errorCode || json.error || "Request failed");
    error.code = json.errorCode || json.error || json.code || "";
    error.status = response.status || json.status;
    throw error;
  }
  return json;
}

function buildHeaders(body, options = {}) {
  const headers = body ? { "content-type": "application/json" } : {};
  if (adminToken && options.auth !== false) {
    headers.authorization = `Bearer ${adminToken}`;
  }
  return headers;
}

function byId(id) {
  return document.getElementById(id);
}

function formatTime(value) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

function formatExpiry(value) {
  if (!value) return "不过期";
  return formatTime(value);
}

function formatSpeed(value) {
  const speed = Number(value || 0);
  if (!Number.isFinite(speed) || speed <= 0) {
    return "-";
  }
  return `${speed.toFixed(speed >= 10 ? 1 : 2)} Mbps`;
}

function formatStorageBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "-";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let current = bytes;
  let unitIndex = 0;
  while (current >= 1024 && unitIndex < units.length - 1) {
    current /= 1024;
    unitIndex += 1;
  }
  return `${current.toFixed(current >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatProgress(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  const progress = Number(value);
  return Number.isFinite(progress) ? `${progress.toFixed(progress >= 10 ? 1 : 2)}%` : "-";
}

function formatSyncState(value) {
  const state = String(value || "idle");
  const names = {
    syncing: "同步中",
    idle: "空闲",
    error: "异常",
    stopping: "停止中",
    offline: "离线"
  };
  return names[state] || state;
}

function formatJob(job) {
  if (!job) {
    return "-";
  }
  return [job.name, job.direction].filter(Boolean).join(" · ") || "-";
}

function formatCurrentFile(sync = {}) {
  return sync.currentFile || sync.lastRun?.currentFile || "-";
}

function formatSyncRun(run) {
  if (!run) {
    return "-";
  }
  const status = {
    running: "运行中",
    success: "成功",
    error: "失败",
    stopped: "已停止",
    unknown: "未知"
  }[run.status] || run.status || "-";
  const time = run.finishedAt || run.startedAt;
  const error = run.errorCode ? formatError({ code: run.errorCode, message: run.error }) : "";
  const conflicts = isBidirectionalSyncDirection(run.job?.direction) && run.conflicts?.count > 0
    ? `冲突 ${run.conflicts.count} 项`
    : "";
  return [status, formatSyncTrigger(run.trigger), time ? formatTime(time) : "", error, conflicts].filter(Boolean).join(" · ");
}

function formatSyncTrigger(trigger) {
  return trigger === "scheduler" ? "计划触发" : "手动触发";
}

function formatScheduler(scheduler) {
  if (!scheduler || scheduler.enabled === false) {
    return "-";
  }
  if (scheduler.lastError) {
    return `异常：${formatError({ code: scheduler.lastError })}`;
  }
  if (scheduler.nextRun === "on-startup") {
    return "启动后";
  }
  if (scheduler.nextRun) {
    return `下次 ${formatTime(scheduler.nextRun)}`;
  }
  if (scheduler.jobs?.length) {
    return "等待下一次计划";
  }
  return "手动";
}

function formatConflictSummary(conflicts = {}) {
  const files = Array.isArray(conflicts.files) ? conflicts.files.slice(0, 3) : [];
  const suffix = conflicts.truncated ? " 等" : "";
  const fileText = files.length ? `${files.join("、")}${suffix}` : "未记录文件名";
  return `${Number(conflicts.count || files.length)} 项（${fileText}）`;
}

function formatRuntimeDiagnostics(diagnostics = {}) {
  const version = diagnostics.version || "-";
  return `服务端 ${version} · ${formatProtocolVersions(diagnostics.protocols)}`;
}

function formatProtocolVersions(protocols = {}) {
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

function formatBuildInfo(diagnostics = {}) {
  const normalized = diagnostics && typeof diagnostics === "object" ? diagnostics : {};
  const buildId = normalized.buildId || "";
  const buildTime = normalized.buildTime ? formatTime(normalized.buildTime) : "";
  return [buildId, buildTime].filter(Boolean).join(" · ") || "-";
}

function formatCompatibility(compatibility) {
  if (!compatibility) {
    return "未知";
  }
  if (compatibility.ok) {
    return "协议兼容";
  }
  return compatibilityActionText(compatibility);
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

function deviceImpactClass(device) {
  if (device.enabled === false) {
    return "warn";
  }
  if (device.compatibility && device.compatibility.ok === false) {
    return "bad";
  }
  if (getDeviceConflictSummary(device).count > 0) {
    return "warn";
  }
  if (device.sync?.lastRun?.status === "error") {
    return "bad";
  }
  return device.online ? "good" : "";
}

function deviceCardClass(device) {
  const impact = deviceImpactClass(device);
  if (impact === "bad") return "bad";
  if (impact === "warn") return "warn";
  return "";
}

function getDeviceConflictSummary(device = {}) {
  const sync = device.sync || {};
  const lastRun = sync.lastRun;
  const lastRunConflicts = lastRun?.conflicts;
  if (isBidirectionalSyncDirection(lastRun?.job?.direction) && Number(lastRunConflicts?.count || 0) > 0) {
    return lastRunConflicts;
  }
  const currentDirection = sync.currentJob?.direction || lastRun?.job?.direction;
  if (isBidirectionalSyncDirection(currentDirection)) {
    return sync.conflicts || { count: 0, files: [], truncated: false };
  }
  return { count: 0, files: [], truncated: false };
}

function isBidirectionalSyncDirection(direction) {
  return String(direction || "").trim().toLowerCase() === "bidirectional";
}

function formatDeviceImpact(device) {
  if (device.enabled === false) {
    return "设备已停用：旧客户端心跳和新 SyncKey 生成都会被拒绝，重新启用后需重新应用 sing-box 配置。";
  }
  if (device.compatibility && device.compatibility.ok === false) {
    return compatibilityImpactText(device.compatibility);
  }
  const lastRun = device.sync?.lastRun;
  const conflicts = getDeviceConflictSummary(device);
  if (conflicts.count > 0) {
    return `最近同步检测到冲突：${formatConflictSummary(conflicts)}。请让用户暂停继续双向同步，在客户端历史详情中比对示例文件并确认保留版本后再重新运行。`;
  }
  if (lastRun?.status === "error") {
    const reason = lastRun.errorCode
      ? formatError({ code: lastRun.errorCode, message: lastRun.error })
      : lastRun.error || "请查看客户端日志。";
    return `最近同步失败：${reason}`;
  }
  if (device.online) {
    return "设备在线：心跳正常，最近同步状态可在下方查看。";
  }
  return "设备离线：若长时间未恢复，请检查客户端是否运行、网络是否可达，或重新导入 SyncKey。";
}

function getEnabledDevices() {
  return (state?.devices || []).filter((device) => device.enabled !== false);
}

function formatAffectedDeviceNames(devices = []) {
  const names = devices
    .map((device) => device.clientName || device.userId)
    .filter(Boolean)
    .slice(0, 5);
  if (names.length === 0) {
    return "暂无已启用设备受影响。";
  }
  const suffix = devices.length > names.length ? ` 等 ${devices.length} 个设备` : "";
  return `受影响设备：${names.join("、")}${suffix}。`;
}

function tunnelImpactSummary() {
  const devices = state?.devices || [];
  const enabledDevices = getEnabledDevices();
  const onlineCount = enabledDevices.filter((device) => device.online).length;
  const incompatibleCount = enabledDevices.filter((device) => device.compatibility && device.compatibility.ok === false).length;
  const lines = [
    `当前设备：共 ${devices.length} 个，启用 ${enabledDevices.length} 个，在线 ${onlineCount} 个。`,
    formatAffectedDeviceNames(enabledDevices),
    "写入配置后需重启 sing-box，并在控制台点击“已重启”标记生效。"
  ];
  if (incompatibleCount > 0) {
    lines.push(`其中 ${incompatibleCount} 个启用设备存在协议兼容性警告，生成新配置后请优先重新下发 SyncKey。`);
  }
  return lines.join("\n");
}

function realityRotationImpactSummary() {
  return [
    tunnelImpactSummary(),
    "REALITY key 变更后，旧 SyncKey/profile 中的 VLESS 参数会失效，需要重新生成 SyncKey 并重新导入客户端。"
  ].join("\n");
}

function compatibilityActionText(compatibility = {}) {
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

function compatibilityImpactText(compatibility = {}) {
  const first = compatibility.issues?.[0];
  const detail = first
    ? `${first.field} 服务端 v${first.local || "-"}，客户端 v${first.remote || "-"}`
    : "协议版本不一致";
  const actions = {
    upgrade_remote: `客户端协议过旧：${detail}。心跳继续允许，配置下发和同步操作需先升级客户端。`,
    upgrade_local: `服务端协议过旧：${detail}。心跳继续允许，配置下发和同步操作需先升级服务端。`,
    diagnostics_missing: `客户端诊断信息不完整：${detail}。心跳继续允许，配置下发和同步操作需确认客户端版本。`,
    manual_check: `客户端和服务端协议版本混杂：${detail}。心跳继续允许，配置下发和同步操作需确认两端发布批次。`
  };
  return actions[compatibility.action] || `客户端协议不兼容：${detail}。请升级不匹配的一端。`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
