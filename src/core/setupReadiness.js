// First-use readiness is derived from verified directory, supervisor, and
// consumed-device authorization evidence. Optional S3 compatibility settings
// are intentionally not a prerequisite for the ordinary directory flow.

export const SETUP_STEP_IDS = Object.freeze(["directory", "repair", "pairing"]);

const STEP_TITLES = Object.freeze({
  directory: "开放服务器目录",
  repair: "准备外部连接",
  pairing: "完成设备配对与授权"
});

const STEP_HINTS = Object.freeze({
  directory: "选择已有服务器目录。Syncraft 会先检查目录状态，再开放给设备使用。",
  repair: "首次使用时填写外部访问地址并继续；已有连接异常时可重新检查和修复。",
  pairing: "批准设备申请。设备导入接入码后，即可使用已开放的目录。"
});

export function summarizeSetupReadiness(state, health, enrollment = {}) {
  const checks = readChecks(health);
  const directories = readDirectoryEvidence(enrollment);
  const repairEvidence = collectRepairEvidence(state, checks, enrollment);
  const pairingEvidence = collectPairingEvidence(enrollment, directories.verifiedRootIds);
  const verdicts = {
    directory: judgeDirectory(directories),
    repair: judgeRepair(repairEvidence, directories.activeRootCount > 0),
    pairing: judgePairing(pairingEvidence)
  };

  let blockedBy = null;
  const steps = SETUP_STEP_IDS.map(id => {
    const verdict = verdicts[id];
    const step = {
      id,
      title: STEP_TITLES[id],
      hint: STEP_HINTS[id],
      ready: verdict.ready,
      blocked: blockedBy !== null,
      blockedBy,
      blockedReason: verdict.ready ? "" : verdict.reason,
      evidence: id === "directory" ? directories : id === "repair" ? repairEvidence : pairingEvidence
    };
    if (!verdict.ready && blockedBy === null) blockedBy = id;
    return step;
  });
  const firstUnready = steps.find(step => !step.ready) || null;
  return {
    complete: steps.every(step => step.ready),
    currentStepId: firstUnready?.id || null,
    steps
  };
}

function readChecks(health) {
  const checks = health && typeof health === "object" ? health.checks : null;
  const source = checks && typeof checks === "object" ? checks : {};
  return {
    singbox: source.singbox && typeof source.singbox === "object" ? source.singbox : {},
    probeAvailable: Boolean(checks && typeof checks === "object")
  };
}

function readDirectoryEvidence(enrollment) {
  const ids = Array.isArray(enrollment?.verifiedRootIds)
    ? [...new Set(enrollment.verifiedRootIds.filter(id => typeof id === "string" && /^root_[A-Za-z0-9_-]{16,128}$/.test(id)))]
    : [];
  return {
    directoryEvidenceAvailable: enrollment?.directoryEvidenceAvailable === true,
    activeRootCount: Number.isSafeInteger(enrollment?.activeRootCount) && enrollment.activeRootCount >= 0
      ? enrollment.activeRootCount : 0,
    verifiedRootIds: ids,
    unverifiedRootCount: Number.isSafeInteger(enrollment?.unverifiedRootCount) && enrollment.unverifiedRootCount >= 0
      ? enrollment.unverifiedRootCount : 0
  };
}

function collectRepairEvidence(state, checks, enrollment) {
  const tunnel = state?.tunnel || {};
  const pid = Number(checks.singbox.pid);
  return {
    configWrittenAt: tunnel.lastConfigWrittenAt || null,
    appliedAt: tunnel.lastAppliedAt || null,
    restartRequired: tunnel.restartRequired === true,
    probeAvailable: checks.probeAvailable,
    processAlive: checks.singbox.processAlive === true,
    portReady: checks.singbox.portReady === true,
    pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    configDigestAvailable: enrollment?.configDigestAvailable === true,
    bootstrapApplyReceipt: enrollment?.bootstrapApplyReceipt === true,
    dataOverlayApplyReceipt: enrollment?.dataOverlayApplyReceipt === true
  };
}

function collectPairingEvidence(enrollment, verifiedRootIds) {
  const available = enrollment?.authorizationEvidenceAvailable === true;
  const authorizedRelationRootIds = Array.isArray(enrollment?.authorizedRelationRootIds)
    ? enrollment.authorizedRelationRootIds.filter(id => verifiedRootIds.includes(id))
    : [];
  return {
    authorizationEvidenceAvailable: available,
    authorizedRelationCount: available ? authorizedRelationRootIds.length : 0
  };
}

function judgeDirectory(evidence) {
  if (!evidence.directoryEvidenceAvailable) {
    return { ready: false, reason: "无法确认服务器目录状态，请检查服务后刷新。" };
  }
  if (evidence.activeRootCount < 1) {
    return { ready: false, reason: evidence.unverifiedRootCount
      ? "已登记目录当前不可用，请检查目录并重试。"
      : "还没有可用的服务器目录，请先开放一个已存在的目录。" };
  }
  return { ready: true, reason: "" };
}

function judgeRepair(evidence, hasDirectory) {
  if (!hasDirectory) return { ready: false, reason: "先开放并验证一个服务器目录。" };
  if (!evidence.configWrittenAt || !evidence.appliedAt || evidence.restartRequired) {
    return { ready: false, reason: "连接设置尚未应用，请在目录页填写外部访问地址并继续。" };
  }
  if (!evidence.probeAvailable || !evidence.processAlive || !evidence.portReady) {
    return { ready: false, reason: "连接服务当前不可用，请检查连接设置或使用修复操作。" };
  }
  if (!evidence.configDigestAvailable || !evidence.bootstrapApplyReceipt || !evidence.dataOverlayApplyReceipt) {
    return { ready: false, reason: "连接设置尚未确认完成，点击修复操作重新应用。" };
  }
  return { ready: true, reason: "" };
}

function judgePairing(evidence) {
  if (!evidence.authorizationEvidenceAvailable) {
    return { ready: false, reason: "暂时无法确认设备配对状态，请刷新后重试。" };
  }
  if (evidence.authorizedRelationCount < 1) {
    return { ready: false, reason: "还没有设备完成目录配对，请处理设备申请并让设备导入接入码。" };
  }
  return { ready: true, reason: "" };
}
