import { createHttpError } from "./errors.js";

// 同步空间的「用途」。方向不是用户选项，而是 f(用途, 角色) 的推导结果。
// 推导只在服务端进行：规则若两端各写一份，就会重新产生本轮修复的那类漂移。
export const SYNC_SPACE_MODES = Object.freeze(["backup", "distribution", "collaboration"]);

// 管理员新建共享空间时的安全默认，对齐需求 §5「单写入端、多读取端」。
export const DEFAULT_SYNC_SPACE_MODE = "distribution";

// 设备私有空间只有一个 owner 成员，不存在第二个写入端，因此不受单写入端默认约束。
// 这些空间承担「换机恢复」，必须保留下载与双向，否则升级会静默删掉既有能力。
export const PRIVATE_SYNC_SPACE_MODE = "collaboration";

const DIRECTIONS_BY_MODE_AND_ROLE = Object.freeze({
  backup: Object.freeze({
    // reader 在备份空间无座位：既不许上传，也不该读取别人的备份。
    owner: Object.freeze(["upload"]),
    writer: Object.freeze(["upload"]),
    reader: Object.freeze([])
  }),
  distribution: Object.freeze({
    owner: Object.freeze(["upload"]),
    writer: Object.freeze(["upload"]),
    reader: Object.freeze(["download"])
  }),
  collaboration: Object.freeze({
    // upload 排在首位：客户端取第一个元素作默认值，而 bidirectional 需要先建立
    // bisync 基准，不能靠数组顺序被静默启用。
    owner: Object.freeze(["upload", "download", "bidirectional"]),
    writer: Object.freeze(["upload", "download", "bidirectional"]),
    reader: Object.freeze(["download"])
  })
});

// 用于读取磁盘上的既有 state：宽松，未知值退回安全默认，与 normalizeSyncSpaceState 的风格一致。
export function normalizeSyncSpaceMode(input) {
  const value = String(input == null ? "" : input).trim().toLowerCase();
  return SYNC_SPACE_MODES.includes(value) ? value : DEFAULT_SYNC_SPACE_MODE;
}

// 用于校验管理员入参：拼错的用途必须报错，不能被静默改成另一种权限模型。
export function requireSyncSpaceMode(input) {
  if (input == null || String(input).trim() === "") {
    return DEFAULT_SYNC_SPACE_MODE;
  }
  const value = String(input).trim().toLowerCase();
  if (!SYNC_SPACE_MODES.includes(value)) {
    throw createHttpError("validation_failed", 400, "mode must be backup, distribution, or collaboration");
  }
  return value;
}

// 未知的用途或角色返回空集合而不是默认放行：降级方向永远是「更少权限」。
export function deriveSyncDirections(mode, role) {
  const byRole = DIRECTIONS_BY_MODE_AND_ROLE[String(mode || "").trim().toLowerCase()];
  if (!byRole) {
    return [];
  }
  const directions = byRole[String(role || "").trim().toLowerCase()];
  return directions ? [...directions] : [];
}

// reader 在 minioPolicy.js 拿到空写动作集合，allowDelete 必须与那里同源，
// 否则协议会声明一个存储层根本不会授予的能力。
export function deriveAuthorization(input = {}) {
  const role = String(input.role || "").trim().toLowerCase();
  const directions = deriveSyncDirections(input.mode, role);
  const allowDelete = input.policy?.allowDelete === true && (role === "owner" || role === "writer");
  return { role, directions, allowDelete };
}
