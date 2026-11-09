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
  newSyncSpaceMode: byId("newSyncSpaceMode"),
  syncSpaceRole: byId("syncSpaceRole"),
  deviceName: byId("deviceName"),
  bucketSelect: byId("bucketSelect"),
  newDeviceName: byId("newDeviceName"),
  newDeviceBucket: byId("newDeviceBucket"),
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
// null 表示「就绪度未取到」，不是「一切正常」。渲染侧必须按未验证处理。
let setupReadiness = null;
let latestClaimTKey = "";
let latestClaimUri = "";
let latestClaimShortCode = "";
const adminTokenStorageKey = "sfsc-admin-token";
const enrollmentReconfigureStorageKey = "sfsc-enrollment-reconfigure-operation";
const enrollmentRevocationStorageKey = "sfsc-enrollment-revocation-operation";
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
byId("createDeviceBtn").addEventListener("click", createDevice);
byId("refreshEnrollmentDirectoriesBtn").addEventListener("click", loadEnrollmentDirectories);
byId("refreshEnrollmentDirectoriesBtn").addEventListener("click", loadEnrollmentRequests);
byId("openEnrollmentDirectoryBtn").addEventListener("click", openEnrollmentDirectory);
byId("createEnrollmentChannelCodeBtn").addEventListener("click", createEnrollmentChannelCode);
byId("reconfigureEnrollmentChannelBtn").addEventListener("click", reconfigureEnrollmentChannel);
byId("copyClaimBtn").addEventListener("click", copyClaim);
byId("copyShortClaimBtn").addEventListener("click", copyShortClaim);
byId("copyClaimUriBtn").addEventListener("click", copyClaimUri);
byId("redeemPreviewBtn").addEventListener("click", redeemPreview);
byId("refreshBtn").addEventListener("click", loadState);
byId("refreshOverviewBtn").addEventListener("click", loadState);
byId("refreshSetupBtn").addEventListener("click", loadState);
byId("setupStepList").addEventListener("click", (event) => {
  const target = event.target instanceof Element ? event.target.closest("[data-tab-target]") : null;
  if (!target || !event.currentTarget.contains(target)) return;
  switchTab(target.dataset.tabTarget);
});
byId("loginForm").addEventListener("submit", loginAdmin);
byId("logoutBtn").addEventListener("click", logoutAdmin);
byId("confirmForm").addEventListener("submit", submitConfirmation);
byId("confirmCancelBtn").addEventListener("click", cancelConfirmation);
document.querySelectorAll("[data-tab-target]").forEach((tab) => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tabTarget));
  if (tab.closest(".settings-tabs")) {
    tab.setAttribute("role", "tab");
    tab.addEventListener("keydown", (event) => {
      const tabs = [...tab.closest(".settings-tabs").querySelectorAll("[data-tab-target]")];
      const current = tabs.indexOf(tab);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (current + 1) % tabs.length : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length : -1;
      if (next < 0) return;
      event.preventDefault(); tabs[next].focus(); switchTab(tabs[next].dataset.tabTarget);
    });
  }
});
document.querySelector(".config-preview .toggle")?.addEventListener("click", toggleConfigPreview);

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
      healthText.textContent = "管理 API 可达 · 待重启";
    } else if (!result.ok) {
      healthDot.classList.add("err");
      healthText.textContent = "API 异常";
    } else {
      healthDot.classList.add("good");
      healthText.textContent = "管理 API 可达";
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
    // 就绪度先取再渲染：概览的隧道/存储灯现在读它，缺了会退回「未验证」而不是谎报就绪。
    await loadSetupReadiness();
    renderState();
    await loadEnrollmentDirectories();
    await loadEnrollmentRequests();
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

// 就绪度带实时探针（MinIO 健康端点 1.5s 超时、sing-box 端口与 PID），
// 所以它独立于 /api/admin/state 取，失败时置 null——渲染侧把 null 当「未验证」，
// 绝不当「已就绪」。这是整个 C 的前提：未知不等于良好。
async function loadSetupReadiness() {
  try {
    setupReadiness = await api("/api/admin/setup");
  } catch (error) {
    if (error.code === "admin_auth_required") throw error;
    setupReadiness = null;
  }
}

async function refreshLiveDevices() {
  if (!state) return;
  try {
    state = await api("/api/admin/state");
    renderApplyNotice();
    renderStatStrip();
    renderOverview();
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
  clearClaimResult();
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

async function createDevice() {
  const clientName = fields.newDeviceName.value.trim();
  if (!clientName) {
    setAction("请填写设备名。", "warn");
    return;
  }
  const existing = findDeviceByName(clientName);
  if (existing) {
    // createManagedUser is idempotent on clientName: it would return the existing
    // device and report success. Say so instead of implying a new device appeared.
    setAction(`${clientName} 已存在，未创建新设备。请换一个设备名。`, "warn");
    return;
  }
  const bucketName = fields.newDeviceBucket.value;
  const result = await runAction(
    "正在创建设备...",
    `设备 ${clientName} 已创建。下一步：生成 SyncKey 后才能在客户端导入。`,
    () => api("/api/admin/users/create", {
      clientName,
      ...(bucketName ? { bucketName } : {})
    })
  );
  if (!result) return;
  state = result.state;
  fields.newDeviceName.value = "";
  // The contract's original objection to a console create button was that it
  // strands "registered but no importable SyncKey" half-built devices. Carry the
  // new device into the SyncKey flow so creation continues instead of dangling.
  fields.deviceName.value = clientName;
  renderDebugJson({ user: result.user });
  renderState();
}

async function createSyncSpace() {
  const syncId = fields.newSyncId.value.trim();
  const ownerUserId = fields.syncSpaceOwnerSelect.value;
  if (!syncId || !ownerUserId) {
    setAction("请填写同步 ID 并选择 Owner 设备。", "warn");
    return;
  }
  const result = await runAction("正在创建同步空间...", "同步空间已创建。", () =>
    api("/api/admin/sync-spaces/create", { syncId, ownerUserId, mode: fields.newSyncSpaceMode.value })
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
    await copyText(value);
    setAction("完整 SyncKey 已复制。", "good");
  } catch {
    setAction("复制失败，当前浏览器不允许访问剪贴板。", "bad");
  }
}

async function copyShortClaim() {
  const value = latestClaimShortCode;
  if (!value) {
    setAction("请先生成 SyncKey。");
    return;
  }
  try {
    await copyText(value);
    setAction("短码已复制；加入时还需填写服务端地址。", "good");
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
    await copyText(value);
    setAction("导入 URI 已复制。", "good");
  } catch {
    setAction("复制失败，当前浏览器不允许访问剪贴板。", "bad");
  }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Intranet HTTP pages are not secure contexts, so use the selected-text
      // fallback below when the Clipboard API is absent or denied.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = String(value || "");
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  if (!copied) {
    throw new Error("Clipboard copy was rejected");
  }
}

function clearClaimResult() {
  latestClaimTKey = "";
  latestClaimUri = "";
  latestClaimShortCode = "";
  byId("claimOut").value = "";
  byId("claimShortCode").textContent = "-";
  byId("claimServerResult").textContent = "-";
  byId("claimResult").hidden = true;
  byId("profileOut").textContent = "等待新的 SyncKey 生成结果...";
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

async function loadEnrollmentDirectories() {
  const list = byId("enrollmentDirectoryList");
  if (!list) return;
  if (adminAuthEnabled && !adminToken) {
    list.textContent = "登录管理控制台后查看已开放目录。";
    return;
  }
  try {
    const result = await api("/api/admin/enrollment/v1/directories");
    const directories = Array.isArray(result.directories) ? result.directories : [];
    list.replaceChildren();
    if (directories.length === 0) {
      list.innerHTML = '<div class="empty">尚未开放目录</div>';
      await loadEnrollmentRelations();
      await loadEnrollmentRequests();
      return;
    }
    for (const directory of directories) {
      const row = document.createElement("div");
      row.className = "summary-row";
      const name = document.createElement("span");
      name.textContent = directory.path?.split(/[\\/]/).filter(Boolean).at(-1) || "目录";
      const path = document.createElement("span");
      path.className = "mono";
      path.textContent = `${directory.path} · ${directory.status === "active" ? "已开放" : "登记待恢复"}`;
      row.append(name, path);
      list.append(row);
    }
    await loadEnrollmentRelations();
    await loadEnrollmentRequests();
  } catch (error) {
    list.textContent = `目录读取失败：${formatActionError(error)}`;
  }
}

async function loadEnrollmentRelations() {
  const list = byId("enrollmentRelationList");
  if (!list) return;
  if (adminAuthEnabled && !adminToken) {
    list.textContent = "登录管理控制台后查看设备的目录授权。";
    return;
  }
  try {
    const { relations = [] } = await api("/api/admin/enrollment/v1/relations");
    list.replaceChildren();
    const groups = new Map();
    for (const relation of relations) {
      if (!groups.has(relation.deviceId)) groups.set(relation.deviceId, []);
      groups.get(relation.deviceId).push(relation);
    }
    if (!groups.size) {
      list.innerHTML = '<div class="empty">暂无已配对设备</div>';
      await loadEnrollmentRevocationStatus();
      return;
    }
    for (const [deviceId, deviceRelations] of groups) {
      const card = document.createElement("article");
      card.className = "item enrollment-relation-card";
      const heading = document.createElement("div");
      heading.className = "device-row";
      const label = document.createElement("strong");
      label.textContent = `已配对设备 · ${deviceId}`;
      const revokeDevice = document.createElement("button");
      revokeDevice.type = "button";
      revokeDevice.className = "danger btn-compact";
      revokeDevice.textContent = "撤销设备授权";
      revokeDevice.disabled = deviceRelations.every(item => item.status === "revoked");
      revokeDevice.addEventListener("click", () => confirmEnrollmentRevocation(
        { kind: "device", deviceId },
        `确定撤销此设备的 ${deviceRelations.length} 个目录授权？该设备授权无法自动恢复。`
      ));
      heading.append(label, revokeDevice);
      card.append(heading);
      for (const relation of deviceRelations) {
        const row = document.createElement("div");
        row.className = "summary-row enrollment-relation-row";
        const description = document.createElement("span");
        description.textContent = `${relation.directory || relation.rootId} · ${relation.status === "active" ? "授权中" : "已撤销"}`;
        const revokeRelation = document.createElement("button");
        revokeRelation.type = "button";
        revokeRelation.className = "btn-secondary btn-compact";
        revokeRelation.textContent = "撤销此目录授权";
        revokeRelation.disabled = relation.status !== "active";
        revokeRelation.addEventListener("click", () => confirmEnrollmentRevocation(
          { kind: "relation", relationId: relation.relationId },
          `只撤销设备 ${deviceId} 对目录 ${relation.directory || relation.rootId} 的授权？其他目录授权保持不变。`
        ));
        row.append(description, revokeRelation);
        card.append(row);
      }
      list.append(card);
    }
    await loadEnrollmentRevocationStatus();
  } catch (error) {
    list.textContent = `授权列表读取失败：${formatActionError(error)}`;
  }
}

async function confirmEnrollmentRevocation(target, body) {
  const confirmed = await requestConfirmation({
    title: target.kind === "device" ? "撤销设备授权" : "撤销目录授权",
    body,
    submitText: "撤销"
  });
  if (!confirmed) return;
  const operationId = `revop_${crypto.randomUUID().replaceAll("-", "")}`;
  sessionStorage.setItem(enrollmentRevocationStorageKey, JSON.stringify({ operationId, target }));
  await submitEnrollmentRevocation(operationId, target);
}

async function submitEnrollmentRevocation(operationId, target) {
  const message = byId("enrollmentRelationMessage");
  message.textContent = "正在撤销授权并停止相关传输...";
  try {
    try {
      await api("/api/admin/enrollment/v1/revocations", { operationId, target });
    } catch (error) {
      if (error.status !== 503) throw error;
    }
    await loadEnrollmentRevocationStatus();
    await loadEnrollmentRelations();
  } catch (error) {
    message.textContent = `暂时无法读取撤销状态：${formatActionError(error)}；状态已保存，可刷新后继续。`;
  }
}

async function loadEnrollmentRevocationStatus() {
  const raw = sessionStorage.getItem(enrollmentRevocationStorageKey);
  if (!raw) return;
  let saved;
  try { saved = JSON.parse(raw); }
  catch { sessionStorage.removeItem(enrollmentRevocationStorageKey); return; }
  if (!saved?.operationId || !saved?.target) return;
  const message = byId("enrollmentRelationMessage");
  const status = await api(`/api/admin/enrollment/v1/operations/${encodeURIComponent(saved.operationId)}`);
  const targetLabel = saved.target.kind === "device" ? "设备授权" : "目录授权";
  message.replaceChildren();
  const text = document.createElement("span");
  text.textContent = status.status === "complete"
    ? "授权已撤销，相关传输已停止"
    : "授权已停用，正在停止传输；可点击继续";
  message.append(text);
  if (status.status !== "complete") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "btn-secondary btn-compact";
    retry.textContent = "继续";
    retry.addEventListener("click", () => submitEnrollmentRevocation(saved.operationId, saved.target));
    message.append(retry);
  }
}

async function loadEnrollmentRequests() {
  const list = byId("enrollmentRequestList");
  if (!list) return;
  if (adminAuthEnabled && !adminToken) {
    list.textContent = "登录管理控制台后查看设备配对申请。";
    return;
  }
  try {
    // A fresh server has no enrollment catalog until its first directory is
    // registered. Read the directory list first so this normal state does
    // not become a scary 503 or an invented empty request result. Errors from
    // catalog reads still reach the catch below and remain visible.
    const { directories = [] } = await api("/api/admin/enrollment/v1/directories");
    const activeDirectories = directories.filter(item => item.status === "active");
    if (!activeDirectories.length) {
      list.textContent = directories.length
        ? "目录验证完成后，设备配对申请会显示在这里。"
        : "开放并验证服务器目录后，设备配对申请会显示在这里。";
      return;
    }
    const { requests = [] } = await api("/api/admin/enrollment/v1/requests");
    list.replaceChildren();
    if (!requests.length) {
      list.innerHTML = '<div class="empty">没有待审批申请</div>';
      return;
    }
    for (const request of requests) {
      const row = document.createElement("div");
      row.className = "summary-row";
      const label = document.createElement("span");
      label.textContent = `设备申请 · ${formatTime(request.createdAt)}`;
      const controls = document.createElement("div");
      controls.className = "actions";
      const select = document.createElement("select");
      select.multiple = true;
      select.size = Math.min(Math.max(activeDirectories.length, 2), 5);
      select.setAttribute("aria-label", "选择一个或多个授权目录");
      select.title = "可按住 Ctrl 或 Shift 选择多个目录";
      for (const directory of activeDirectories) {
        const option = document.createElement("option");
        option.value = directory.rootId;
        option.textContent = directory.path?.split(/[\\/]/).filter(Boolean).at(-1) || "目录";
        select.append(option);
      }
      select.selectedIndex = -1;
      const issue = document.createElement("button");
      issue.type = "button";
      issue.className = "btn-primary btn-compact";
      issue.textContent = "签发验证码";
      issue.disabled = activeDirectories.length === 0;
      issue.addEventListener("click", () => {
        const selected = [...select.selectedOptions].filter(option => option.value);
        if (!selected.length) {
          byId("enrollmentIssuedCode").textContent = "请先选择至少一个要授权的服务器目录。";
          return;
        }
        issueEnrollmentCode(
          request.requestId,
          selected.map(option => option.value),
          selected.map(option => option.textContent.trim())
        );
      });
      controls.append(select, issue);
      row.append(label, controls);
      list.append(row);
    }
  } catch (error) {
    list.textContent = `申请读取失败：${formatActionError(error)}`;
  }
}

async function issueEnrollmentCode(requestId, rootIds, directoryNames = []) {
  const output = byId("enrollmentIssuedCode");
  output.textContent = "正在签发...";
  try {
    const roots = Array.isArray(rootIds) ? rootIds : [rootIds];
    const requestBody = roots.length === 1 ? { rootId: roots[0] } : { rootIds: roots };
    const result = await api(`/api/admin/enrollment/v1/requests/${encodeURIComponent(requestId)}/issue`, requestBody);
    if (!result.deviceEnrollmentCode
      || (roots.length === 1 && !result.binding)
      || (roots.length > 1 && (!Array.isArray(result.bindings) || result.bindings.length !== roots.length))) {
      throw new Error("服务端返回的目录授权结果与所选目录数量不一致。");
    }
    const names = directoryNames.length ? directoryNames.join("、") : `${roots.length} 个目录`;
    output.textContent = `已授权目录：${names}\n一次性身份验证码（请安全交付给对应设备）：${result.deviceEnrollmentCode}`;
    await loadEnrollmentRequests();
  } catch (error) {
    output.textContent = `验证码未签发：${formatActionError(error)}`;
  }
}

async function createEnrollmentChannelCode() {
  const output = byId("enrollmentChannelCode");
  output.textContent = "正在检查已应用的 sing-box 配置...";
  try {
    const result = await api("/api/admin/enrollment/v1/channel-code", {});
    output.textContent = `接入通道码（请安全交付给设备）：${result.wrappedCode}`;
  } catch (error) {
    output.textContent = `通道码未生成：${formatActionError(error)}`;
  }
}

async function reconfigureEnrollmentChannel() {
  const button = byId("reconfigureEnrollmentChannelBtn");
  const output = byId("enrollmentReconfigureStatus");
  button.disabled = true;
  try {
    if (readinessStep("directory")?.ready !== true) {
      output.textContent = "请先开放并验证一个服务器目录，再准备连接和通道码。";
      return;
    }
    const repair = readinessStep("repair");
    const tunnel = state?.tunnel || {};
    const firstUse = !tunnel.lastAppliedAt;
    // On a genuinely unconfigured install, bootstrap a REALITY profile using
    // only the external endpoint the administrator supplied. Keep the
    // established reconfigure/apply path for already-applied connections.
    if (firstUse) {
      const publicHost = byId("firstUsePublicHost").value.trim();
      const publicPort = Number(byId("firstUsePublicPort").value);
      if (!publicHost || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535) {
        output.textContent = "首次连接需要填写外部访问地址和 1–65535 之间的端口。";
        return;
      }
      output.textContent = "正在准备并应用连接设置...";
      await api("/api/admin/tunnel/autofill", {
        protocol: "vless-reality-tcp",
        publicHost,
        publicPort,
        listenPort: Number(tunnel.listenPort || publicPort),
        remark: "sfsc-home",
        forceRealityKeys: false
      });
      const applied = await api("/api/admin/singbox/apply", { confirmApplySingbox: true }, { timeoutMs: 0 });
      if (applied?.state?.tunnel?.restartRequired) {
        throw new Error("服务端没有确认连接设置已生效，通道码未签发。");
      }
      state = applied.state;
      await loadSetupReadiness();
      renderState();
    }
    let operation;
    try {
      operation = JSON.parse(localStorage.getItem(enrollmentReconfigureStorageKey) || "null");
    } catch {
      localStorage.removeItem(enrollmentReconfigureStorageKey);
      operation = null;
    }
    const requestedHost = (firstUse ? byId("firstUsePublicHost").value : fields.publicHost.value).trim();
    const requestedPort = Number(firstUse ? byId("firstUsePublicPort").value : fields.publicPort.value);
    if (operation && typeof operation.operationId === "string"
      && (operation.publicHost !== requestedHost || operation.publicPort !== requestedPort)) {
      let previous;
      try {
        previous = await api(`/api/admin/enrollment/v1/reconfigure/${encodeURIComponent(operation.operationId)}`);
      } catch (error) {
      output.textContent = `上一次连接设置的状态尚未确认，请先刷新或点击继续；新的地址尚未应用：${formatActionError(error)}`;
        return;
      }
      if (!(["complete", "rolled-back"].includes(previous.stage))) {
        output.textContent = "上一次连接设置仍在处理中，请先使用原地址继续；新的地址尚未应用。";
        return;
      }
      localStorage.removeItem(enrollmentReconfigureStorageKey);
      operation = null;
    }
    if (!operation || typeof operation.operationId !== "string") {
      const random = crypto.getRandomValues(new Uint8Array(16));
      const operationId = `op_${Array.from(random, value => value.toString(16).padStart(2, "0")).join("")}`;
      operation = {
        operationId,
        ...(requestedHost ? { publicHost: requestedHost } : {}),
        ...(Number.isInteger(requestedPort) && requestedPort >= 1 && requestedPort <= 65535 ? { publicPort: requestedPort } : {})
      };
      localStorage.setItem(enrollmentReconfigureStorageKey, JSON.stringify(operation));
    }
    output.textContent = "正在应用连接设置并生成通道码...";
    const result = await api("/api/admin/enrollment/v1/reconfigure", operation, { timeoutMs: 0 });
    if (result.stage === "complete" && result.wrappedCode) {
      output.textContent = `连接设置已应用，通道码已生成（请安全交付给设备；外部连接仍需设备实际验证）：${result.wrappedCode}`;
      localStorage.removeItem(enrollmentReconfigureStorageKey);
      return;
    }
    if (result.stage === "rolled-back") {
      output.textContent = "连接设置失败，已恢复原配置；未生成通道码。可检查原因后重试。";
      localStorage.removeItem(enrollmentReconfigureStorageKey);
      return;
    }
    if (result.stage === "repair-needed") {
      output.textContent = "连接设置未完成，服务端需要管理员检查和修复；未生成通道码。";
      return;
    }
    output.textContent = "连接设置正在恢复中；未生成通道码。点击继续可查询进度。";
  } catch (error) {
    output.textContent = `连接设置状态尚未确认；状态已保存，可刷新后继续：${formatActionError(error)}`;
  } finally {
    button.disabled = false;
    loadState().catch(() => {});
  }
}

async function openEnrollmentDirectory() {
  const path = byId("enrollmentDirectoryPath").value.trim();
  const message = byId("enrollmentDirectoryMessage");
  if (!path) {
    message.textContent = "请输入服务器上已存在的目录路径。";
    return;
  }
  const button = byId("openEnrollmentDirectoryBtn");
  button.disabled = true;
  message.textContent = "正在校验并登记目录...";
  try {
    const result = await api("/api/admin/enrollment/v1/directories", { path });
    message.textContent = `目录已开放：${result.directory.path}`;
    byId("enrollmentDirectoryPath").value = "";
    await loadState();
  } catch (error) {
    message.textContent = `目录未开放：${formatActionError(error)}`;
  } finally {
    button.disabled = false;
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
    connection_repair_busy: "同步或另一项连接修复正在进行，请稍后重试。",
    connection_repair_cleanup_failed: "修复探测未确认清理完成，不能视为修复成功。",
    connection_repair_invalid: "连接修复请求无效，请刷新页面后重试。",
    connection_repair_list_failed: "无法检查连接修复目标，请检查服务端状态。",
    connection_repair_probe_conflict: "无法确认探测路径属于本次修复，未修改文件。",
    connection_repair_read_failed: "无法读取连接修复目标，请检查服务端状态。",
    connection_repair_write_failed: "无法更新连接修复目标，请检查服务端状态。",
    danger_confirmation_required: "请按提示完成二次确认后再继续。",
    data_authorization_invalid: "签名目录授权无效，请重新检查服务器通道和授权状态。",
    data_authorization_mismatch: "签名目录授权与当前设备或关系不匹配，请管理员核对目录授权。",
    data_authorization_trust_failed: "目录授权签名未通过已 pin 的服务器密钥验证，请核对服务器信任信息。",
    device_disabled: "该设备已被停用，请在服务端重新启用后再继续。",
    device_not_found: "当前客户端未在服务端登记，请重新生成并导入 SyncKey。",
    enrollment_auth_invalid: "身份验证码签名无效，请重新发起申请并联系管理员。",
    enrollment_auth_capacity: "身份验证请求过多，请稍后重试。",
    enrollment_auth_expired: "服务器与电脑的系统时间可能存在较大差异。请先检查本机 Windows 日期、时间和时区，并尝试立即同步；若本机时间正确，再请管理员检查服务器时间。无需重新配对、重新导入通道码或重新签发身份验证码。",
    enrollment_auth_replayed: "该身份验证请求已使用，请重新发起申请。",
    enrollment_binding_mismatch: "身份申请与授权目录不匹配，请联系管理员重新签发。",
    enrollment_catalog_not_ready: "身份接入目录尚未就绪，请检查服务端设置。",
    enrollment_channel_invalid: "客户端尚未导入有效的通道配置码。",
    enrollment_channel_mismatch: "通道配置与身份申请不匹配，请重新导入管理员提供的通道配置码。",
    enrollment_channel_stale: "设备请求的接入通道已更新，请重新导入管理员提供的新通道码。",
    enrollment_channel_not_ready: "服务端身份接入通道尚未就绪，请检查连接地址、端口和通道设置后重试。",
    enrollment_channel_expired: "通道配置已过期，请重新复制管理员提供的通道配置码。",
    enrollment_code_expired: "身份验证码已过期，请管理员重新签发。",
    enrollment_code_invalid: "身份验证码无效或不属于当前申请，请核对申请后联系管理员。",
    enrollment_code_used: "身份验证码已使用，请重新发起身份申请。",
    enrollment_device_revoked: "该客户端身份已撤销，请联系管理员。",
    enrollment_data_authorization_denied: "设备没有该同步关系的数据访问授权，请联系管理员检查目录绑定。",
    enrollment_data_channel_not_ready: "服务端数据通道尚未完成配置或应用，请管理员检查隧道状态。",
    enrollment_data_relation_not_ready: "服务端受保护目录关系尚未运行，请管理员检查服务状态。",
    enrollment_data_relation_start_failed: "无法启动服务端受保护目录关系，请管理员检查防护能力和运行日志。",
    enrollment_endpoint_invalid: "身份接入地址无效，请重新导入管理员提供的通道配置码。",
    enrollment_identity_conflict: "客户端身份与服务端已登记身份冲突，请联系管理员处理。",
    enrollment_identity_missing: "本地设备身份文件缺失或损坏，请先修复本地状态。",
    enrollment_proxy_unavailable: "首次接入隧道不可用，请检查客户端 sing-box 组件和网络。",
    enrollment_public_key_mismatch: "身份公钥与服务端登记不一致，请联系管理员核对。",
    enrollment_relation_conflict: "同步关系与当前授权冲突，请联系管理员核对目录绑定。",
    enrollment_relation_denied: "该客户端没有同步关系授权，请联系管理员授予目录权限。",
    enrollment_relation_revoked: "该同步关系已撤销，请联系管理员。",
    enrollment_revocation_identity_conflict: "撤销期间设备授权发生变化，请管理员检查服务端状态。",
    enrollment_revocation_incomplete: "授权撤销尚未完成，请刷新状态后继续。",
    enrollment_revocation_invalid: "撤销请求无效，请检查所选设备或目录。",
    enrollment_revocation_operation_conflict: "该撤销请求与之前保存的目标不一致，请刷新后重试。",
    enrollment_revocation_operation_not_found: "找不到已保存的撤销状态，请刷新后重试。",
    enrollment_revocation_not_ready: "关系服务尚未就绪，撤销尚未开始。",
    enrollment_revocation_overlay_not_applied: "撤销后的数据配置尚未确认应用。",
    enrollment_revocation_recovery_pending: "撤销恢复尚未完成，暂时不能申请数据授权。",
    sftp_access_marker_conflict: "本机或远端访问标记与当前授权根目录冲突；拒绝覆盖，请核对原同步目录。",
    sftp_access_marker_invalid: "SFTP 访问标记输入无效，或缺少已验证的根目录标识。",
    sftp_access_marker_missing: "已初始化关系的本机或远端访问标记缺失；拒绝重建或继续。",
    sftp_access_marker_write_failed: "无法确认 SFTP 访问标记写入结果；请核对本机或远端目录后重试。",
    enrollment_request_exists: "该身份申请已存在，请查看当前申请状态。",
    enrollment_request_invalid: "身份申请内容无效，请重新发起申请。",
    enrollment_request_mismatch: "身份验证码不属于当前设备或申请，请核对后重试。",
    enrollment_request_not_found: "服务端找不到该身份申请，请重新发起申请。",
    enrollment_reconfigure_busy: "另一个隧道或数据通道操作正在进行，请稍后重试。",
    enrollment_reconfigure_conflict: "该连接设置请求与之前保存的信息不一致，请重新开始操作。",
    enrollment_reconfigure_invalid: "重配置请求无效，请检查公网地址和端口。",
    enrollment_reconfigure_needs_repair: "重配置需要管理员修复；服务端未签发通道码。",
    enrollment_reconfigure_not_found: "找不到已保存的连接设置，请重新检查后重试。",
    enrollment_reconfigure_state_invalid: "重配置记录无效，请管理员检查服务端状态。",
    enrollment_reconfigure_write_failed: "重配置记录无法保存，请管理员检查数据目录。",
    enrollment_response_invalid: "身份接入响应无效，请检查服务端版本和日志。",
    enrollment_signer_invalid: "服务端身份签名组件不可用，请检查服务端配置。",
    enrollment_state_invalid: "服务端身份状态损坏，请先备份并修复服务端状态。",
    enrollment_state_conflict: "身份状态已变化，请刷新后重试。",
    enrollment_transport_failed: "首次接入隧道连接失败，请检查客户端网络和服务端状态。",
    enrollment_trust_failed: "服务端密钥或身份回执签名校验失败，请与管理员核对服务器指纹。",
    enrollment_trust_verifier_required: "缺少独立的服务端密钥 pin，无法验证身份通道。",
    heartbeat_auth_invalid: "客户端心跳签名无效，请重新导入 SyncKey。",
    heartbeat_auth_required: "客户端心跳缺少签名，请重新导入 SyncKey。",
    heartbeat_rate_limited: "该来源心跳失败次数过多，服务端已临时限速，请稍后再试。",
    heartbeat_failed: "无法接收客户端心跳，设备在线状态可能延迟。",
    import_code_required: "请先填写服务端生成的 SyncKey。",
    import_code_invalid: "SyncKey 格式不正确，请重新复制。",
    invalid_json: "请求内容不是合法 JSON，请刷新页面后重试。",
    invalid_path: "请求的资源路径非法，请刷新页面后重试。",
    sync_recovery_preflight_failed: "同步前无法完成恢复区检查，当前未执行同步。",
    sync_recovery_restore_hash_mismatch: "恢复文件校验不一致，未写入目标文件。",
    sync_recovery_restore_preview_expired: "还原预览已过期，请重新预览。",
    sync_recovery_restore_preview_required: "需要先预览当前还原操作。",
    sync_recovery_restore_staging_invalid: "受保护的还原暂存区无效，未写入目标文件。",
    sync_recovery_restore_target_exists: "还原目标已经存在，未覆盖现有文件。",
    sync_recovery_restore_target_invalid: "还原目标必须位于本地同步文件夹内。",
    first_sync_conflict_command_failed: "首次冲突保护操作失败；未执行初始化。请检查服务端状态后重新预览。",
    first_sync_conflict_preview_expired: "首次冲突预览已过期；未执行初始化。请重新扫描并复核冲突。",
    first_sync_conflict_preview_required: "初始化前必须先完成首次冲突预览。",
    first_sync_conflict_review_required: "首次冲突保护需要人工复核；未执行初始化。请检查目录和未完成操作后重试。",
    first_sync_conflict_save_required: "初始化前必须先预览并保存双方版本。",
    first_sync_conflict_set_changed: "预览后文件发生变化。未执行初始化，请重新预览并保存当前冲突双方版本。",
    first_sync_conflict_source_changed: "冲突来源文件已变化；未执行初始化。请重新扫描并复核双方版本。",
    first_sync_conflict_stage_invalid: "首次冲突保护暂存区无效；未执行初始化，请联系管理员检查服务端状态。",
    first_sync_conflict_target_exists: "恢复目标已存在；未覆盖现有文件，也未执行初始化。",
    first_sync_conflict_target_invalid: "冲突恢复目标路径无效；未执行初始化，请重新选择目录。",
    first_sync_conflict_trusted_relation_required: "首次冲突扫描缺少可信目录授权关系；未执行初始化，请检查任务授权和目录选择。",
    first_sync_conflict_scan_failed: "首次冲突扫描失败；未执行初始化。请检查通道连接与目录权限后重试。",
    first_sync_conflict_staging_invalid: "首次冲突保护暂存内容无效；未执行初始化，请联系管理员检查服务端状态。",
    sync_recovery_review_required: "恢复区或双向同步基准需要人工核对；本次未执行同步。",
    sync_recovery_trusted_relation_required: "当前任务没有可验证的目录授权关系，不能使用恢复功能。",
    sync_recovery_version_not_found: "找不到这份已保存版本，或它尚未完成。",
    directory_root_input_invalid: "目录路径无效，请输入服务器上已存在的目录。",
    directory_root_io_failed: "服务器无法完成目录检查，请检查服务端日志和文件系统状态。",
    directory_root_link_denied: "不允许通过符号链接登记目录，请选择真实目录路径。",
    directory_root_missing: "服务器上找不到所选目录，请核对路径。",
    directory_root_marker_collision: "所选目录已有 Syncraft 或未知标记，未覆盖；请人工核查。",
    directory_root_marker_mismatch: "目录标记内容与登记记录不符，未覆盖；请人工核查。",
    directory_root_marker_missing: "目录标记已丢失，请人工核查后重试。",
    directory_root_registration_review_required: "目录登记状态需要人工核查，未覆盖现有文件。",
    directory_root_mount_changed: "目录所在文件系统已变化，请重新检查路径后重试。",
    directory_root_overlap: "所选目录与已开放目录相互包含，请选择完全独立的目录。",
    directory_root_mount_unavailable: "无法验证目录所在文件系统，请检查服务器运行环境。",
    directory_root_not_ready: "目录尚未完成登记，请重试或检查服务端状态。",
    directory_root_permission_denied: "服务端没有读取或写入所选目录的权限。",
    directory_root_record_invalid: "目录登记记录无效，请备份后人工核查。",
    directory_root_registration_incomplete: "目录登记未完成，可刷新状态后重试。",
    directory_root_replaced: "所选路径已指向另一个目录，请人工核查。",
    directory_root_space_insufficient: "所选目录可用空间不足。",
    directory_root_space_unavailable: "无法读取所选目录的可用空间。",
    invalid_vless_uri: "VLESS 链接格式不正确，请检查参数。",
    last_active_bucket_disable_blocked: "至少需要保留一个启用的同步仓库。",
    last_bucket_delete_blocked: "至少需要保留一个同步仓库。",
    local_host_forbidden: "客户端拒绝了非回环 Host 的请求，请从客户端窗口内操作。",
    local_state_corrupt: "客户端本地状态文件损坏，请先导出诊断包，备份并修复或隔离损坏 JSON 后再按需重新导入 SyncKey。",
    local_read_forbidden: "客户端本地读取请求被拒绝，请从客户端窗口内操作。",
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
    secret_vault_unprotected: "客户端无法为本地密钥库设置访问权限，已拒绝保存密钥，请检查客户端所在磁盘和系统账户。",
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
    sync_id_unavailable: "这个同步空间名称已被占用，请换一个。",
    sync_space_access_denied: "这台设备没有该同步空间的授权，请先把它加入空间。",
    sync_space_membership_exists: "这台设备已经是该同步空间的成员。",
    sync_space_role_not_allowed: "备份用途的同步空间不接受只读成员，请改用分发用途，或把角色设为可写。",
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

// 取一步的就绪信息。拿不到就绪度时返回 null，调用方据此显示「未验证」。
function readinessStep(id) {
  const steps = Array.isArray(setupReadiness?.steps) ? setupReadiness.steps : [];
  return steps.find((step) => step.id === id) || null;
}

function renderSetupReadiness() {
  const navItem = byId("setupNavItem");
  const panel = byId("tab-setup");
  const complete = setupReadiness?.complete === true;
  // 全部就绪后收起入口：向导长期驻留会在日常运维界面留下一个永远绿的装饰。
  // 取不到就绪度时保持显示——那种情况更需要管理员看到检测失败。
  if (navItem) navItem.hidden = complete;
  if (panel && complete && panel.classList.contains("active")) {
    switchTab("tab-overview");
  }

  const steps = Array.isArray(setupReadiness?.steps) ? setupReadiness.steps : [];
  const progress = byId("setupProgress");
  if (progress) {
    if (!setupReadiness) {
      progress.textContent = "拿不到就绪检测结果，请确认服务端在运行后重新检测。";
    } else {
      const readyCount = steps.filter((step) => step.ready).length;
      progress.textContent = complete
        ? `目录、连接设置和设备配对均已就绪。`
        : `已完成 ${readyCount} / ${steps.length} 步，当前应处理：${steps.find((step) => step.id === setupReadiness.currentStepId)?.title || "未知"}。`;
    }
  }

  const list = byId("setupStepList");
  if (!list) return;
  if (!steps.length) {
    list.innerHTML = `<div class="notice warning"><strong>就绪状态未验证</strong><span>没有拿到检测结果，界面不会据此判断是否配置完成。</span></div>`;
    return;
  }
  list.innerHTML = steps.map((step, index) => {
    const tone = step.ready ? "good" : step.blocked ? "" : "warn";
    const stateText = step.ready ? "已就绪" : step.blocked ? "待前置步骤" : "待处理";
    return `
      <div class="notice ${step.ready ? "success" : step.blocked ? "" : "warning"}">
        <strong>${index + 1}. ${escapeHtml(step.title)} <span class="pill ${tone}">${escapeHtml(stateText)}</span></strong>
        <span>${escapeHtml(step.ready ? step.hint : step.blockedReason || step.hint)}</span>
        ${step.ready ? "" : `<span><button class="btn-secondary btn-compact" type="button" data-tab-target="${escapeHtml(setupStepTab(step.id))}">前往</button></span>`}
      </div>`;
  }).join("");
}

// 普通目录、修复与配对工作流都从首页进入；隧道细节留在高级设置。
function setupStepTab(id) {
  return { directory: "tab-overview", repair: "tab-overview", pairing: "tab-overview" }[id] || "tab-overview";
}

function renderState() {
  if (!state) return;
  renderSetupReadiness();
  renderStatStrip();
  renderOverview();
  renderVless();
  renderApplyNotice();
  renderStorage();
  renderSyncSpaces();
  renderDevices();
  renderComponentVersions();
  toggleRealitySettings();
}

function switchTab(tabId) {
  if (!tabId) return;
  const targetPanel = byId(tabId);
  const navGroup = targetPanel?.dataset.navGroup || "";
  document.querySelectorAll("[data-tab-target]").forEach((tab) => {
    const groupedActive = navGroup && tab.dataset.navGroup === navGroup;
    tab.classList.toggle("active", tab.dataset.tabTarget === tabId || groupedActive);
    if (tab.closest(".settings-tabs")) tab.setAttribute("aria-selected", String(tab.dataset.tabTarget === tabId));
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === tabId);
  });
  byId("pageTitle").textContent = targetPanel?.dataset.pageTitle || "Syncraft 管理";
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderComponentVersions() {
  const target = byId("applianceVersion");
  if (!target) return;
  target.textContent = state?.diagnostics?.version || state?.appVersion || "—";
}

function toggleConfigPreview() {
  const preview = document.querySelector(".config-preview");
  if (!preview) return;
  preview.classList.toggle("collapsed");
  const expanded = !preview.classList.contains("collapsed");
  const toggle = preview.querySelector(".toggle");
  toggle.textContent = expanded ? "×" : "▾";
  toggle.setAttribute("aria-label", expanded ? "收起配置预览" : "展开配置预览");
}

function renderStatStrip() {
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const enabledDevices = devices.filter((device) => device.enabled !== false);
  const onlineDevices = enabledDevices.filter((device) => device.online);
  const syncingDevices = enabledDevices.filter((device) => {
    const syncState = currentDeviceSyncState(device);
    return syncState === "syncing" || syncState === "running";
  });
  const directory = readinessStep("directory");
  const pairing = readinessStep("pairing");
  const directoryCount = Number(directory?.evidence?.activeRootCount) || 0;
  const authorizedRelationCount = Number(pairing?.evidence?.authorizedRelationCount) || 0;
  setStatValue("statDirectoryValue", directory ? String(directoryCount) : "未验证", directoryCount ? "ok" : "warn");
  setStatText("statDirectorySub", directory?.ready ? "目录标记与访问检查通过" : directory?.blockedReason || "目录检查结果未取得");
  setStatValue("statOnlineDevicesValue", `${onlineDevices.length} / ${enabledDevices.length}`, onlineDevices.length ? "ok" : "warn");
  setStatText("statOnlineDevicesSub", enabledDevices.length
    ? `${Math.max(enabledDevices.length - onlineDevices.length, 0)} 台离线`
    : "暂无启用设备");
  setStatValue("statSyncingValue", String(syncingDevices.length), syncingDevices.length ? "ok" : "");
  setStatText("statSyncingSub", syncingDevices.length
    ? syncingDevices.map((device) => device.clientName || device.name || device.id || "未知设备").slice(0, 2).join("、")
    : "暂无同步任务");
  setStatValue("statAuthorizedRelationValue", pairing ? String(authorizedRelationCount) : "未验证", authorizedRelationCount ? "ok" : "warn");
  setStatText("statAuthorizedRelationSub", pairing?.ready ? "已签名授权并绑定已验证目录" : pairing?.blockedReason || "授权检查结果未取得");
}

function renderOverview() {
  // 这里刻意不再从 state.tunnel / state.storage 读任何东西：概览的配置类灯与
  // 待处理项全部改由就绪度提供。把那两个变量留在作用域里，等于给「顺手用
  // tunnel.protocol 判断一下」留好了入口，而那正是本轮要消除的缺陷。
  const devices = Array.isArray(state?.devices) ? state.devices : [];
  const enabledDevices = devices.filter((device) => device.enabled !== false);
  const issues = [];

  // 首次配置未完成时，它是唯一值得说的事：底下那些「离线/失败」条目在
  // 配置本身没完成时全是噪音。旧实现没有「你还没配置完」这个概念，
  // 于是零配置部署的概览显示「无待处理项」。
  if (setupReadiness && setupReadiness.complete === false) {
    const current = setupReadiness.steps.find((step) => step.id === setupReadiness.currentStepId);
    issues.push({
      level: "warning",
      title: "首次配置尚未完成",
      detail: current ? `下一步：${current.title}。${current.blockedReason || current.hint}` : "打开首次配置面板查看剩余步骤。"
    });
  }
  if (!setupReadiness) {
    issues.push({ level: "warning", title: "就绪状态未验证", detail: "拿不到就绪检测结果，界面不会据此判断配置是否完成。" });
  }
  const offlineCount = enabledDevices.filter((device) => !device.online).length;
  if (offlineCount) {
    issues.push({ level: "warning", title: `${offlineCount} 台设备离线`, detail: "查看设备页的最近心跳和客户端状态。" });
  }
  const incompatibleCount = enabledDevices.filter((device) => device.compatibility?.ok === false).length;
  if (incompatibleCount) {
    issues.push({ level: "danger", title: `${incompatibleCount} 台设备协议不兼容`, detail: "同步前需要升级对应客户端或确认兼容策略。" });
  }
  const failedCount = enabledDevices.filter((device) => device.sync?.lastRun?.status === "error").length;
  if (failedCount) {
    issues.push({ level: "danger", title: `${failedCount} 台设备最近同步失败`, detail: "打开设备详情查看稳定错误码和恢复建议。" });
  }

  const count = byId("overviewAttentionCount");
  count.textContent = issues.length ? `${issues.length} 项` : "无需处理";
  count.className = `badge ${issues.some((issue) => issue.level === "danger") ? "bad" : issues.length ? "warning" : "good"}`;
  byId("overviewAttentionList").innerHTML = issues.length
    ? issues.slice(0, 4).map((issue) => `<div class="notice ${issue.level}"><strong>${escapeHtml(issue.title)}</strong><span>${escapeHtml(issue.detail)}</span></div>`).join("")
    : `<div class="notice success"><strong>无待处理项</strong></div>`;

  const directoryStep = readinessStep("directory");
  const repairStep = readinessStep("repair");
  const pairingStep = readinessStep("pairing");
  setOverviewStatus("overviewServiceState", Boolean(setupReadiness), setupReadiness ? "API 与管理状态可达" : "就绪检测未返回");
  setOverviewStatus("overviewTunnelState", directoryStep?.ready === true, directoryStep ? (directoryStep.ready ? `${directoryStep.evidence.activeRootCount} 个目录已实测` : directoryStep.blockedReason) : "未验证");
  setOverviewStatus("overviewStorageState", repairStep?.ready === true, repairStep ? (repairStep.ready ? "已应用" : repairStep.blockedReason) : "未验证");
  setOverviewStatus("overviewProtocolState", pairingStep?.ready === true, pairingStep ? (pairingStep.ready ? `${pairingStep.evidence.authorizedRelationCount} 个有效关系` : pairingStep.blockedReason) : "未验证");

  const recent = [...devices].sort((left, right) => String(right.lastSeenAt || "").localeCompare(String(left.lastSeenAt || ""))).slice(0, 5);
  byId("overviewDeviceList").innerHTML = recent.length ? `
    <div class="overview-device-row header"><span>设备</span><span>在线</span><span>同步</span><span>最近心跳</span></div>
    ${recent.map((device) => `
      <div class="overview-device-row">
        <span class="overview-device-name">${escapeHtml(device.clientName || device.id || "未知设备")}</span>
        <span class="pill ${device.enabled === false ? "warn" : device.online ? "good" : ""}">${device.enabled === false ? "停用" : device.online ? "在线" : "离线"}</span>
        <span class="overview-device-meta">${escapeHtml(formatSyncState(currentDeviceSyncState(device)))}</span>
        <span class="overview-device-meta">${escapeHtml(formatTime(device.lastSeenAt))}</span>
      </div>`).join("")}` : `<div class="empty">暂无设备；先开放目录，再批准设备配对申请。</div>`;
}

function setOverviewStatus(id, ok, text) {
  const target = byId(id);
  target.textContent = text;
  target.className = `status ${ok ? "good" : "warn"}`;
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
  const firstUseInputs = byId("firstUseConnectionInputs");
  if (firstUseInputs) firstUseInputs.hidden = Boolean(tunnel.lastAppliedAt);
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
  if (tunnel.lastAppliedAt) {
    if (!byId("firstUsePublicHost").value) byId("firstUsePublicHost").value = tunnel.publicHost || "";
    if (!byId("firstUsePublicPort").value) byId("firstUsePublicPort").value = tunnel.publicPort || "";
  }

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

  const currentNewDeviceBucket = fields.newDeviceBucket.value || storage.bucket;
  fields.newDeviceBucket.innerHTML = activeBuckets.length
    ? activeBuckets.map((bucket) =>
      `<option value="${escapeHtml(bucket.name)}">${escapeHtml(bucket.name)}</option>`
    ).join("")
    : `<option value="">先创建仓库</option>`;
  fields.newDeviceBucket.value = activeBuckets.some((bucket) => bucket.name === currentNewDeviceBucket)
    ? currentNewDeviceBucket
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
  // 私有空间也是一个有真实 syncId 的同步空间，不是「没有空间」这个替代项。
  // 空值的含义是「这台设备用它自己的私有空间」，措辞必须仍然落在「同步空间」这个词上。
  fields.syncSpaceSelect.innerHTML = `<option value="">这台设备的私有同步空间</option>${spaces.map((space) =>
    `<option value="${escapeHtml(space.id)}">${escapeHtml(space.syncId)} · ${escapeHtml(formatSyncSpaceMode(space.mode))} · ${escapeHtml(space.memberCount)} 个成员</option>`
  ).join("")}`;
  fields.syncSpaceSelect.value = spaces.some((space) => space.id === selectedSpace) ? selectedSpace : "";
}

// 与客户端 app.js 的同名函数保持同一张对照表：同一个空间在两个界面必须用同一个词
// 描述自己的用途，否则管理员看到的「分发」和用户看到的说法会对不上。
function formatSyncSpaceMode(mode) {
  return { backup: "备份", distribution: "分发", collaboration: "协作" }[mode] || "未知";
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
  byId("claimServerResult").textContent = claim.server || fields.claimServer.value || "-";
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
  return `服务端版本 ${version}`;
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
