# SFSC 0.2.0-beta.2 重发版说明

发布日期：2026-07-13

## 本次修复

- 同步任务统一使用 rclone `--check-first`，客户端新增扫描阶段；扫描期间不再把动态发现量显示为最终总量，进入传输后锁定总字节数、总文件数并保证百分比不倒退。
- 冲突识别仅在双向同步和可靠 bisync 事件上生效；普通 `.sync-conflict-*` 文件名、HTTP 409 和重复日志行不再产生伪冲突，失败原因优先于冲突提示。
- MinIO HTTP 507 `XMinioStorageFull` 归一化为 `storage_full`，客户端显示“服务器存储空间不足”的可执行建议。
- 普通客户端远端目标摘要不再显示 `n1-minio.sfsc` 等内部端点；服务端内部端点始终从 `S3_ENDPOINT` 恢复，避免持久状态漂移。
- N1 MinIO 固定挂载到 SSD `/ssd/sfsc-test/minio`，compose 发布审计会阻止回退到 eMMC 系统盘。

## N1 数据处置

- 已删除本轮 `home-sync/devices/test1` 对象、MinIO 回收站、`test1` 设备和关联 claim/SyncKey 记录。
- 已保留非本轮的 `trial-1758-n1` 数据前缀。
- 清理后根盘可用空间约 `3.7 GiB`；MinIO 活动数据目录已切换到 SSD，`restartRequired=false`。

## 兼容边界

- Protocol v1 的 claim、profile、adminState、clientStatus、heartbeat 版本保持 `1`，本次未引入破坏性协议变更。
- 为兼容旧 SyncKey/profile，N1 的 `S3_CLIENT_ENDPOINT` 路由别名暂时保留，但不再向普通 UI 暴露。改为客户端本地受管存储转发将在后续协议迁移中完成。
- “多台设备选择同一同步 ID 即同步同一内容”的产品重设计仍按已记录方案推进：同步 ID 标识内容，SyncKey/设备凭据负责授权；设备空间、远端目录和 MinIO 路径继续作为内部实现收敛，不属于本次补丁范围。

## 发布闸门

本说明只有在全量测试、发布审计、严格预检、桌面/便携包 smoke、N1 部署 smoke 和当次源指纹对齐全部通过后，才可标记为正式可供试用的 Beta 包。
