# teams-progress

> **Teammate 进度播报扩展** — lead 派发 teammate 后，主会话不再静默。监听 pi-teams 生命周期事件，维护活跃 teammate 状态表，把进度快照注入主会话（状态变化即报 + 心跳兜底），并在 footer 渲染一行动态状态（盲文 spinner 动画）。

## 解决什么问题

pi 的协调模式（coordinator mode）派发 teammate 后，运行期间主会话**完全静默**——只有完成/失败（`team:complete` → `triggerTurn`）才唤醒；teammate 静默卡死要等 pi-teams 的 5 分钟超时清扫器兜底。用户感知：状态丢失，不知道在跑还是停了。

本扩展补上这块缺失的反馈环。

## 工作机制

监听 pi-teams 发到共享事件总线的生命周期事件，维护活跃 teammate 状态表；「状态变化即报 + 心跳兜底」把进度快照注入主会话（`triggerTurn` 唤醒协调循环，`MIN_GAP` 最小间隔合并突发防刷屏）：

| 事件 | 处理 |
| --- | --- |
| `team:started` | 登记 + 延迟 `FIRST_DELAY` 首报（证明真的跑起来了） |
| `team:teammate-progress` | 更新 ctx tokens / 当前工具 / 最新摘要 / 活动时间 |
| `team:teammate-idle` | 空闲标记（不即报：idle 即已交付最终消息，完成通知由 pi-teams `team-notify` 发送，即报会抢在 complete 前重复播报） |
| `team:complete` | 注销（完成通知由 pi-teams 自带，不重复播报） |

心跳每 `INTERVAL` 兜底一次，磁盘终态自愈（漏收 complete 事件时自动注销）与超长无活动清扫也在心跳里做。team 归属用 `agentId` 反查 `~/.pi/teams/<team>/config.json`。**不从磁盘收养新成员**——多会话并行时其他 lead 的 teammate 不得进入本进程的播报。

### Footer 动态状态行

footer 扩展状态区一行动态状态（`setStatus`，与 `git-status` 同区域，各自独占一行）：

```
⠹worker 12m 45k │ ·scout idle 3m
```

运行中用盲文 spinner 逐帧动画，无进度超 `STALE_MS` 换 `⚠`，全空闲时停动画。

> **注意**：pi 内置 footer 会把每个扩展状态渲染在独立一行。本扩展的进度行与 `git-status` 的路径+分支行互不挤压——这正是本扩展独立成包后移除 `~/.pi/agent/extensions/teams-progress.ts` 单文件的原因（否则两路加载重复，监听器/定时器/状态行翻倍）。

## 模型与思考等级展示

teammate 的展示用模型名与思考等级，解析口径与 pi-teams 的 `applyThinkingSuffix` 一致：

- 优先级：`config.json` 的 `member.model`（spawn 实参）> agent 定义 frontmatter 的 `model` 字段
- 直连格式去 provider 前缀：`anthropic/claude-x` → `claude-x`，tier 名（`Sonnet`/`Haiku`/`Opus`/`Fable`）原样
- 拆 `model:thinking` 后缀；`off` 视为无，不显示

## 环境变量

| 变量 | 说明 | 默认 |
| --- | --- | --- |
| `PI_TEAMS_PROGRESS_INTERVAL_MS` | 心跳间隔 | `300000`（5 分钟） |
| `PI_TEAMS_PROGRESS_FIRST_DELAY_MS` | spawn 后首报延迟 | `5000` |
| `PI_TEAMS_PROGRESS_MIN_GAP_MS` | 两次播报最小间隔（合并突发） | `20000` |
| `PI_TEAMS_PROGRESS_STALE_MS` | 无进度事件标记「疑似卡住」的阈值 | `90000` |
| `PI_TEAMS_PROGRESS_MAX_TRACK_MS` | 超长无活动兜底注销阈值 | `1800000` |
| `PI_TEAMS_PROGRESS_UI_MS` | footer 状态行动画间隔 | `900` |
| `PI_TEAMS_PROGRESS_TEAMS_ROOT` | teams 配置根目录 | `~/.pi/teams` |
| `PI_TEAMS_PROGRESS=0` | 禁用本扩展 | — |

## 安装

### pi（原生扩展）

包内 `package.json` 通过 `pi.extensions` 字段自动声明扩展入口，安装后启用即生效。

**本地路径安装**（开发期，与 `git-safety-guard` 同款）——在 `~/.pi/agent/settings.json` 的 `packages` 数组加入：

```jsonc
{
  "packages": [
    // ...
    "../../IDE/ai-agent/ai-agent-plugin/teams-progress"
  ]
}
```

> 路径相对 `~/.pi/agent/`。如改放别处，相应调整。

安装后**务必**从 `~/.pi/agent/extensions/` 移除 `teams-progress.ts` 单文件，否则目录扫描与 package 声明两路加载重复。

### 从 GitHub 安装

```bash
pi install git:github.com/FnSGit/teams-progress@v0.1.0
```

或从 [Releases](https://github.com/FnSGit/teams-progress/releases) 下载 tarball：

```bash
pi install https://github.com/FnSGit/teams-progress/releases/download/v0.1.0/teams-progress-0.1.0.tgz
```

## 依赖

- peerDependency：`@earendil-works/pi-coding-agent`（由宿主 pi 提供）
- 运行时依赖 pi-teams（提供生命周期事件总线）

## License

MIT
