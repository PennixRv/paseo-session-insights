# Paseo 会话指标

桌面和手机都在左侧边栏底部随当前 Codex 会话显示 16 项指标。累计缓存输入已包含在累计输入中。Trellis 显示规划、进行、完成和取消四种任务计数。工作区名右侧的列表图标打开会话详情，可查看 Codex 会话 ID、指标来源、采样时间和覆盖状态。详情中「本会话」右侧的圆形箭头手动刷新。左栏条目可在 Paseo 的「设置 → 侧边栏」中管理。

启用 Sub2API 后，桌面在会话指标上方显示「ChatGPT Status」。手机默认显示会话指标，通过最右侧的双向箭头切换。账号区展示七天用量窗口、重置时间、重置卡、订阅到期，以及今日和近七个自然日的 Token 消耗、账号计费、请求数和输入缓存命中率。

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

Sub2API 依赖 Pennix Lifecycle `0.3.45` 或更新版本。使用 `pennix config edit` 开启会话指标 Sub2API 取数，填写控制面 HTTPS 源地址和目标 OpenAI OAuth 账号 ID。在 `pennix secrets edit` 中将原生受限管理员 Key 写入 `[sub2api]` 的 `account_read_key`。将 `openai.quota.read`、`accounts.stats.read`、`accounts.read` 和 `accounts.identity.read` 限定在目标 OpenAI OAuth 账号的分组内。Sub2API `0.2.23` 的账号详情入口会先检查 `accounts.read`，再按 `accounts.identity.read` 返回订阅到期。今日和近七天统计按 Sub2API 的 `Asia/Shanghai` 自然日计算，账号计费用 `USD` 显示。

Codex 本地适配以 `threads` 索引和活动 JSONL 会话为基线。压缩历史分批读取，读取进度保存在 daemon 内存中。长日志在首次打开或 daemon 重启后可能需要多次刷新才能核对完整。Teamwork 按当前 Codex 会话的精确 owner 查询各项目及全局频道，Trellis 任务计数仍以当前工作区为准。

CCHP 已结算费用以账本额度 `CRED` 显示，按请求去重，优先取校正后的净金额。长会话的费用扫描跨刷新续页，结果可复用 60 秒。网关暂时不可用时，下一次读取可从已核对的分页进度继续。权限拒绝或会话归属冲突会清除关联的费用读数。
