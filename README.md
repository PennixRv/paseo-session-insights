# Paseo 会话指标

本地私测候选，为 Codex 会话提供五枚桌面胶囊和一个手机详情入口。两端使用同一份十四项指标。字体跟随 Paseo，旧状态栏图标由随包提供的 SVG 轮廓绘制。

## 本地验证

使用 Node.js 24 和 Paseo 0.17.3 运行验证。

```bash
npm ci
npm run typecheck
npm test
npm pack --dry-run
```

## 隔离 daemon 预览

在获准的测试 daemon 上，启动环境变量 `PASEO_SESSION_INSIGHTS_FIXTURE=1` 可令插件显示明确标记的合成快照。使用本地目录安装，`TEST_DAEMON_HOME` 指向已选测试目录。

```bash
paseo plugin install "$PWD" --home "$TEST_DAEMON_HOME"
paseo plugin ls paseo-session-insights --home "$TEST_DAEMON_HOME"
paseo plugin disable paseo-session-insights --home "$TEST_DAEMON_HOME"
```

测试真实数据时移除 `PASEO_SESSION_INSIGHTS_FIXTURE`，按实际测试范围配置 daemon 服务环境。每项来源在配置前显示未接入。

| 变量 | 用途 |
| --- | --- |
| `PASEO_SESSION_INSIGHTS_CODEX_HOME` | 目标 Codex 数据根的绝对路径。按线程 ID 读取 `state_5.sqlite` 中的会话路径，再投影 `sessions` 目录内对应记录中的结构化用量和压缩元数据。 |
| `PASEO_SESSION_INSIGHTS_WORKFLOW` | 设为 `1` 后使用该 daemon 的 `trellis` CLI 获取工作区任务和当前会话成员状态。 |
| `PASEO_SESSION_INSIGHTS_CCHP_URL`、`PASEO_SESSION_INSIGHTS_CCHP_TOKEN`、`PASEO_SESSION_INSIGHTS_CCHP_KEY_ID` | 分别填写 HTTPS 控制面地址、具有 `usage:read` 的最小权限凭据及请求使用的密钥 ID。当前适配只启用 TTFT 和 TPS。 |

Codex 本地适配以 `threads` 索引和活动 JSONL 会话为基线。超出读取上限的会话会标记覆盖范围。CCHP 用量接口的 credit units 需要与目标部署的账单口径核对，当前以缺失状态展示会话费用。详见[图标来源](licenses/NOTICE.md)。
