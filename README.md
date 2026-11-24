# Paseo 会话指标

桌面和手机都在左侧边栏底部随当前 Codex 会话显示 16 项指标。累计缓存输入已包含在累计输入中。Trellis 显示规划、进行、完成和取消四种任务计数。点「详情」可查看 Codex 会话 ID、指标来源、采样时间和覆盖状态。左栏条目可在 Paseo 的「设置 → 侧边栏」中管理。

侧栏可见且当前会话运行时，插件每 15 秒自动刷新。轮次结束后至少等 5 秒补读一次，再保留读数并暂停轮询。切回会话时会读取一次，详情仍可手动刷新。

## 本地验证

使用 Node.js 24 和 Paseo 0.17.2 或更高版本运行验证。

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## 从 Git 安装

将目标 GitHub Release 对应的完整提交写入 Pennix Lifecycle 的 Paseo 插件声明。在测试 daemon 上先运行 `pennix paseo-plugins plan`，核对提交与目标主机后按工具提示运行 `apply`。插件 ID 为 `paseo-session-insights`，受管 `settings` 为 `{}`。

在测试 daemon 的启动环境里设置 `PASEO_SESSION_INSIGHTS_FIXTURE=1` 可显示明确标记的合成快照。启用真实来源前移除该项。

## 配置数据来源

由 Pennix Lifecycle 管理的 Paseo daemon 会使用 `workflow.config` 指定的 Codex 数据根，并从当前会话所属工作区读取 Trellis 和 Teamwork 状态。独立安装或需要覆盖默认值时，使用以下变量。

| 变量 | 用途 |
| --- | --- |
| `PASEO_SESSION_INSIGHTS_CODEX_HOME` | 目标 Codex 数据根的绝对路径。按线程 ID 读取 `state_5.sqlite` 中的会话路径，再投影 `sessions` 目录内对应记录中的结构化用量和压缩元数据。 |
| `PASEO_SESSION_INSIGHTS_WORKFLOW` | 设为 `1` 启用本地 Trellis 读取，设为 `0` 关闭。 |
| `PASEO_SESSION_INSIGHTS_LIFECYCLE_CONFIG` | Lifecycle 使用非默认 `workflow.config` 时，设为该配置的绝对路径。 |

CCHP 读取需要包含本插件接入的 Pennix Lifecycle 版本。使用 `pennix config edit` 在 Paseo 配置中启用会话指标 CCHP 取数，填写控制面 HTTPS 地址及该 Codex 推理密钥的 ID。运行 `pennix secrets edit`，在 `[cchp]` 下写入组织范围内具有 `usage:read` 的 `usage_token`。默认秘密文件为 `~/.config/pennix/secrets.toml`。运行 `pennix secrets check` 核对字段完整性。插件服务端通过 Lifecycle 私有管道读取配置和令牌，同一 daemon 的客户端共享指标结果。

Codex 本地适配以 `threads` 索引和活动 JSONL 会话为基线。超出读取上限的会话会标记覆盖范围。CCHP 已结算费用以账本额度 `CRED` 显示，按请求去重，优先取校正后的净金额。长会话的费用扫描跨刷新续页，结果可复用 60 秒。详情显示查询条数和金额覆盖情况。
