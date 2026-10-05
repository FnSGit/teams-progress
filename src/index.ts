/**
 * Teammate 进度播报（teams-progress）
 *
 * 问题：lead 派发 teammate 后，运行期间主会话完全静默——只有完成/失败
 * （team:complete → triggerTurn）才唤醒；teammate 静默卡死要等 pi-teams
 * 的 5 分钟超时清扫器兜底。用户感知：状态丢失，不知道在跑还是停了。
 *
 * 方案：监听 pi-teams 发到共享事件总线的生命周期事件，维护活跃 teammate
 * 状态表；「状态变化即报 + 心跳兜底」把进度快照注入主会话
 * （triggerTurn 唤醒协调循环，MIN_GAP 最小间隔合并突发防刷屏）：
 *   team:started           → 登记 + 延迟 FIRST_DELAY 首报（证明真的跑起来了）
 *   team:teammate-progress → ctx tokens / 当前工具 / 最新摘要 / 活动时间
 *   team:teammate-idle     → 空闲标记（不即报：idle 即已交付最终消息，
 *     完成通知由 pi-teams team-notify 发送，即报会抢在 complete 前重复播报）
 *   team:complete          → 注销（完成通知由 pi-teams 自带，不重复播报）
 * 心跳每 INTERVAL 兜底一次，磁盘终态/超长无活动清扫也在心跳里做。team 归属
 * 用 agentId 反查 ~/.pi/teams/<team>/config.json。不从磁盘收养新成员——
 * 多会话并行时其他 lead 的 teammate 不得进入本进程的播报。
 *
 * UI：footer 扩展状态区一行动态状态（setStatus，同 git-status 区域）：
 *   ⠹worker 12m 45k │ ·scout idle 3m
 * 运行中用盲文 spinner 逐帧动画，无进度超 STALE_MS 换 ⚠，全空闲时停动画。
 *
 * 环境变量：
 *   PI_TEAMS_PROGRESS_INTERVAL_MS    心跳间隔，默认 300000（5 分钟）
 *   PI_TEAMS_PROGRESS_FIRST_DELAY_MS spawn 后首报延迟，默认 5_000
 *   PI_TEAMS_PROGRESS_MIN_GAP_MS     两次播报最小间隔（合并突发），默认 20_000
 *   PI_TEAMS_PROGRESS_STALE_MS       无进度事件标记「疑似卡住」的阈值，默认 90000
 *   PI_TEAMS_PROGRESS_UI_MS          footer 状态行动画间隔，默认 900
 *   PI_TEAMS_PROGRESS=0              禁用本扩展
 *
 * 诊断：异常路径（ctx 失效 / hasUI=false / setStatus 抛错）追加写入
 *   ~/.pi/agent/teams-progress-debug.log（低频，常开；PI_TEAMS_PROGRESS_DEBUG=0 关闭）。
 *   footer 状态行消失而日志无异常记录 ⇒ 问题在 pi 侧渲染链路，不在本扩展。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const THINKING_LEVELS = new Set([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

interface TrackedTeammate {
  id: string;
  name: string;
  agentType: string;
  startedAt: number;
  lastProgressAt: number;
  lastSummary?: string;
  currentTool?: string;
  tokens?: number;
  activity: "running" | "idle";
  /** 展示用模型名（直连格式去掉 provider 前缀） */
  model?: string;
  /** 展示用思考等级（"off" 不显示） */
  thinking?: string;
  /** 模型标签已由 config.json 定稿（含判定为直连格式不可信而置空）：锁定后不再重算 */
  modelLocked?: boolean;
}

interface TeamMemberInfo {
  team: string;
  status: string;
  /** config.json member.model，回退 team.defaultModel */
  model?: string;
  agentType?: string;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const INTERVAL_MS = readPositiveIntEnv(
  "PI_TEAMS_PROGRESS_INTERVAL_MS",
  300_000,
);
const FIRST_DELAY_MS = readPositiveIntEnv(
  "PI_TEAMS_PROGRESS_FIRST_DELAY_MS",
  5_000,
);
const MIN_GAP_MS = readPositiveIntEnv("PI_TEAMS_PROGRESS_MIN_GAP_MS", 20_000);
const STALE_MS = readPositiveIntEnv("PI_TEAMS_PROGRESS_STALE_MS", 90_000);
const MAX_TRACK_MS = readPositiveIntEnv(
  "PI_TEAMS_PROGRESS_MAX_TRACK_MS",
  1_800_000,
);
const UI_ANIMATION_INTERVAL_MS = readPositiveIntEnv(
  "PI_TEAMS_PROGRESS_UI_MS",
  900,
);
const UI_STATUS_KEY = "teams-progress";
const UI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠧", "⠏"];
const TEAMS_ROOT =
  process.env.PI_TEAMS_PROGRESS_TEAMS_ROOT ??
  path.join(os.homedir(), ".pi", "teams");
const SUMMARY_MAX_CHARS = 60;

// ---- 诊断日志：只记异常路径与登记事件，低频常开 ----
const DEBUG_ENABLED = process.env.PI_TEAMS_PROGRESS_DEBUG !== "0";
const DEBUG_LOG_PATH =
  process.env.PI_TEAMS_PROGRESS_DEBUG_LOG ??
  path.join(os.homedir(), ".pi", "agent", "teams-progress-debug.log");
const DEBUG_LOG_MAX_BYTES = 256 * 1024;

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function debugLog(event: string, detail: Record<string, unknown> = {}): void {
  if (!DEBUG_ENABLED) return;
  try {
    // 简单尺寸上限：超限直接截断重写（诊断日志允许丢历史）
    try {
      if (fs.statSync(DEBUG_LOG_PATH).size > DEBUG_LOG_MAX_BYTES) {
        fs.writeFileSync(DEBUG_LOG_PATH, "");
      }
    } catch {}
    const entry = { t: new Date().toISOString(), pid: process.pid, event, ...detail };
    fs.appendFileSync(DEBUG_LOG_PATH, `${JSON.stringify(entry)}\n`);
  } catch {}
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}m`;
  if (m > 0) return `${m}m${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

function fmtTokens(n?: number): string {
  if (n === undefined || !Number.isFinite(n)) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function oneLine(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

/** 模型串去 provider 前缀展示："anthropic/claude-x" → "claude-x"，tier 名原样 */
function shortModelName(model: string): string {
  const slashIdx = model.lastIndexOf("/");
  return slashIdx !== -1 ? model.substring(slashIdx + 1) : model;
}

/** 直连格式判定：含 provider 前缀（如 anthropic/claude-x）不在 harness 注册表，
 * worker 会静默回退会话默认模型，展示层不可信。tier 名（Sonnet/Haiku/Opus/Fable）不含 "/"。 */
function isDirectFormat(model?: string): boolean {
  return !!model && model.includes("/");
}

/** 拆 "model:thinking" 后缀（同 pi-teams applyThinkingSuffix 口径，off 视为无） */
function splitModelThinking(
  model?: string,
): { model?: string; thinking?: string } {
  if (!model) return {};
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx !== -1) {
    const suffix = model.substring(colonIdx + 1);
    if (THINKING_LEVELS.has(suffix) && suffix !== "off") {
      return { model: model.substring(0, colonIdx), thinking: suffix };
    }
  }
  return { model };
}

/** 读 agent 定义 frontmatter 的 model/thinking；项目级优先，用户级兜底 */
function readAgentFrontmatter(
  cwd: string,
  agentType: string,
): { model?: string; thinking?: string } {
  const dirs = [
    path.join(cwd, ".pi", "agents"),
    path.join(os.homedir(), ".pi", "agent", "agents"),
  ];
  for (const dir of dirs) {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(dir, `${agentType}.md`), "utf-8");
    } catch {
      continue; // 该级无此定义，试下一级
    }
    // 只在 frontmatter 块内匹配，避免正文误伤
    const fm = /^---\n([\s\S]*?)\n---/.exec(raw)?.[1] ?? "";
    const pick = (key: string): string | undefined => {
      const value = new RegExp(`^${key}:\\s*(\\S+)`, "m").exec(fm)?.[1];
      return value && value !== "false" ? value : undefined;
    };
    const thinking = pick("thinking");
    return {
      model: pick("model"),
      thinking: thinking && thinking !== "off" ? thinking : undefined,
    };
  }
  return {};
}

/** agentId → {team, status}。只读，解析失败的目录跳过。 */
function scanTeamMembers(): Map<string, TeamMemberInfo> {
  const map = new Map<string, TeamMemberInfo>();
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(TEAMS_ROOT);
  } catch {
    return map;
  }
  for (const entry of entries) {
    let raw: string;
    try {
      raw = fs.readFileSync(
        path.join(TEAMS_ROOT, entry, "config.json"),
        "utf-8",
      );
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const config = asRecord(parsed);
    const teamName = asString(config.name) ?? entry;
    const fallbackModel = asString(config.defaultModel);
    const members = Array.isArray(config.members) ? config.members : [];
    for (const member of members) {
      const rec = asRecord(member);
      const agentId = asString(rec.agentId);
      const status = asString(rec.status);
      if (!agentId || !status) continue;
      map.set(agentId, {
        team: teamName,
        status,
        model: asString(rec.model) ?? fallbackModel,
        agentType: asString(rec.agentType),
      });
    }
  }
  return map;
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_TEAMS_PROGRESS === "0") return;

  const tracked = new Map<string, TrackedTeammate>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let pendingAt: number | null = null;
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;
  let lastReportAt = 0;

  // ---- 模型/思考等级解析（登记时解析，缺了在 sweep 补齐）----
  // ---- footer 动态状态行（setStatus，同 git-status 区域）----
  let uiCtx: ExtensionContext | null = null;
  let uiTimer: ReturnType<typeof setInterval> | null = null;
  let uiFrame = 0;

  // 模型标签只信 config.json 的 member.model（回退 team.defaultModel）——pi-teams 的
  // effectiveModel（params.model ?? team.defaultModel），决定 worker 实际模型的唯一来源：
  //   · 空值 → effectiveModel 空 → worker 继承会话默认（省略 model 场景）→ 不可知，置空「?」
  //   · 直连格式（含 "/"）→ 不在 harness 注册表 → worker 静默回退会话默认 → 不可信，置空
  //   · tier 名 → 有效，展示
  // agent 定义的 model 字段不参与 effectiveModel（team-executor 不读），兜底只会给错误值，故不用；
  // thinking 由 pi-teams applyThinkingSuffix 从 agent 定义取，裸 model（无 :thinking 后缀）时用它兜底。
  const fillModelInfo = (t: TrackedTeammate, diskModel?: string) => {
    // 竞态窗（team:started 早于 registerTeammate 写入）无值：不锁定，等 sweep 补齐
    if (!diskModel) return;
    if (t.modelLocked) return;
    const split = splitModelThinking(diskModel);
    if (isDirectFormat(split.model)) {
      t.modelLocked = true; // 直连格式不可信：保持空「?」，不再重算
      return;
    }
    const agent = readAgentFrontmatter(
      uiCtx?.cwd ?? process.cwd(),
      t.agentType,
    );
    if (split.model) t.model = shortModelName(split.model);
    // 裸 model 时思考等级取 agent 定义，同 pi-teams applyThinkingSuffix 口径
    t.thinking = split.thinking ?? agent.thinking;
    t.modelLocked = true;
  };

  const modelLabel = (t: TrackedTeammate): string =>
    t.model ? (t.thinking ? `${t.model}:${t.thinking}` : t.model) : "?";

  const stopUiAnimation = () => {
    if (uiTimer === null) return;
    clearInterval(uiTimer);
    uiTimer = null;
  };

  const renderUi = () => {
    if (!uiCtx) {
      // session_start 未到达（加载时序异常）：tracked 非空时 footer 必然缺失，记录之
      if (tracked.size > 0) debugLog("render_skipped", { reason: "no_ui_ctx", tracked: tracked.size });
      return;
    }
    let hasUI: boolean;
    try {
      hasUI = uiCtx.hasUI;
    } catch (err) {
      // ctx 失效（session 替换/reload 后旧 ctx getter 抛 assertActive 错误）：
      // 置空等下一个生命周期事件重新捕获，动画一并停掉
      debugLog("ctx_stale", { error: errMessage(err), tracked: tracked.size });
      uiCtx = null;
      stopUiAnimation();
      return;
    }
    if (!hasUI) {
      if (tracked.size > 0) debugLog("render_skipped", { reason: "no_ui", tracked: tracked.size });
      return;
    }
    const now = Date.now();
    let anyRunning = false;
    const parts: string[] = [];
    for (const t of tracked.values()) {
      const stale = now - t.lastProgressAt > STALE_MS;
      const text =
        t.activity === "running"
          ? `${stale ? "⚠" : (UI_SPINNER_FRAMES[uiFrame % UI_SPINNER_FRAMES.length] ?? "⠋")}${t.name} ${modelLabel(t)} ${fmtDuration(now - t.startedAt)} ${fmtTokens(t.tokens)}`
          : `·${t.name} ${modelLabel(t)} idle ${fmtDuration(now - t.lastProgressAt)}`;
      anyRunning = anyRunning || t.activity === "running";
      try {
        parts.push(uiCtx.ui.theme.fg(stale ? "warning" : t.activity === "running" ? "accent" : "dim", text));
      } catch (err) {
        // 主题调用失败不阻断整行：退化为纯文本
        debugLog("theme_fg_failed", { error: errMessage(err) });
        parts.push(text);
      }
    }
    let separator = " │ ";
    try {
      separator = uiCtx.ui.theme.fg("dim", " │ ");
    } catch (err) {
      debugLog("theme_fg_failed", { error: errMessage(err) });
    }
    try {
      uiCtx.ui.setStatus(UI_STATUS_KEY, parts.join(separator));
    } catch (err) {
      debugLog("set_status_failed", { error: errMessage(err), tracked: tracked.size });
    }
    syncUiAnimation(anyRunning);
  };

  const syncUiAnimation = (animate: boolean) => {
    if (!animate) {
      stopUiAnimation();
      return;
    }
    if (uiTimer !== null) return;
    uiTimer = setInterval(() => {
      try {
        uiFrame = (uiFrame + 1) % UI_SPINNER_FRAMES.length;
        renderUi();
      } catch {}
    }, UI_ANIMATION_INTERVAL_MS);
    uiTimer.unref?.();
  };

  const stopTimer = () => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    pendingAt = null;
  };

  // 磁盘终态自愈：漏收 complete 事件时自动注销；超长无活动兜底注销
  const sweep = () => {
    const now = Date.now();
    const disk = scanTeamMembers();
    for (const [id, t] of tracked) {
      const info = disk.get(id);
      if (
        (info && info.status !== "running") ||
        now - t.lastProgressAt > MAX_TRACK_MS
      ) {
        tracked.delete(id);
        continue;
      }
      fillModelInfo(t, info?.model); // 心跳补齐（spawn 后 config.json 可能延迟写入）
    }
    if (tracked.size === 0) stopTimer();
  };

  // git-status 同款防御：每个生命周期事件都重新捕获 ctx。
  // 一次性捕获的 ctx 在会话替换/reload 后 getter 会抛错（assertActive），而事件订阅
  // 在共享总线上仍然存活——逐事件刷新是 footer 唯一的自愈途径。
  const refreshCtx = (ctx: ExtensionContext): void => {
    try {
      uiCtx = ctx;
      renderUi();
    } catch (err) {
      debugLog("refresh_ctx_failed", { error: errMessage(err) });
    }
  };

  const buildReport = (now: number): string => {
    const disk = scanTeamMembers();

    const byTeam = new Map<string, TrackedTeammate[]>();
    const ungrouped: TrackedTeammate[] = [];
    const stale: string[] = [];
    for (const t of tracked.values()) {
      const team = disk.get(t.id)?.team;
      if (team) {
        const list = byTeam.get(team);
        if (list) list.push(t);
        else byTeam.set(team, [t]);
      } else {
        ungrouped.push(t);
      }
      if (now - t.lastProgressAt > STALE_MS) {
        stale.push(
          `${t.name}：${fmtDuration(now - t.lastProgressAt)} 无进度事件（可能是长工具调用或卡住）`,
        );
      }
    }

    const lines: string[] = [`[Team 进度播报] 活跃 ${tracked.size} 个（自动）`];
    const renderMember = (t: TrackedTeammate) => {
      const base =
        t.activity === "running"
          ? `• ${t.name}[${modelLabel(t)}] 运行 ${fmtDuration(now - t.startedAt)} | ctx ${fmtTokens(t.tokens)} | ${t.currentTool ?? "—"} | 活动 ${fmtDuration(now - t.lastProgressAt)}前`
          : `• ${t.name}[${modelLabel(t)}] 空闲 ${fmtDuration(now - t.lastProgressAt)}（累计 ${fmtDuration(now - t.startedAt)}）| ctx ${fmtTokens(t.tokens)}`;
      const summary = t.lastSummary
        ? ` | ${oneLine(t.lastSummary, SUMMARY_MAX_CHARS)}`
        : "";
      lines.push(`${base}${summary}`);
    };
    for (const [team, members] of [...byTeam.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      lines.push(`${team}:`);
      for (const t of members) renderMember(t);
    }
    if (ungrouped.length > 0) {
      lines.push("（未关联 team）:");
      for (const t of ungrouped) renderMember(t);
    }
    for (const s of stale) lines.push(`⚠ ${s}`);
    lines.push(
      "（自动播报，非用户输入：若无可行动变化，用一句话向用户汇报即可；若 teammate 空闲或被标记疑似卡住，按协调职责跟进：send_message 追问 / 重派 / 更新任务板。）",
    );

    return lines.join("\n");
  };

  const sendReport = () => {
    pendingAt = null;
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    if (tracked.size === 0) return;
    lastReportAt = Date.now();
    try {
      void pi.sendMessage(
        {
          customType: "team-progress",
          content: buildReport(Date.now()),
          display: true,
        },
        { triggerTurn: true, deliverAs: "followUp" },
      );
    } catch {
      // 播报失败静默（如 compaction 期间），等下个触发
    }
  };

  // 请求一次播报：不早于本次延迟，也不早于上次播报 + MIN_GAP（合并突发）
  const requestReport = (delayMs: number) => {
    if (tracked.size === 0) return;
    const proposed = Math.max(Date.now() + delayMs, lastReportAt + MIN_GAP_MS);
    if (pendingAt !== null && proposed >= pendingAt) return;
    pendingAt = proposed;
    if (pendingTimer !== null) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(
      () => sendReport(),
      Math.max(0, pendingAt - Date.now()),
    );
    pendingTimer.unref?.();
  };

  // 心跳兜底：清扫 + 请求播报
  const ensureTimer = () => {
    if (timer !== null || tracked.size === 0) return;
    timer = setInterval(() => {
      try {
        sweep();
        requestReport(0);
      } catch {
        // 失败不影响下个周期
      }
    }, INTERVAL_MS);
    timer.unref?.();
  };

  pi.events.on("team:started", (data) => {
    const rec = asRecord(data);
    const id = asString(rec.id);
    if (!id || tracked.has(id)) return;
    const now = Date.now();
    const t: TrackedTeammate = {
      id,
      name: asString(rec.name) ?? id,
      agentType: asString(rec.agent) ?? "unknown",
      startedAt: now,
      lastProgressAt: now,
      activity: "running",
    };
    fillModelInfo(t, scanTeamMembers().get(t.id)?.model);
    tracked.set(id, t);
    ensureTimer();
    requestReport(FIRST_DELAY_MS);
    debugLog("team_started", { id, name: t.name, agent: t.agentType });
    renderUi();
  });

  pi.events.on("team:teammate-progress", (data) => {
    const rec = asRecord(data);
    const id = asString(rec.agentId);
    const t = id ? tracked.get(id) : undefined;
    if (!t) return;
    t.lastProgressAt = Date.now();
    t.activity = "running";
    const tokens = asNumber(rec.tokens);
    if (tokens !== undefined) t.tokens = tokens;
    const tool = asString(rec.currentTool);
    if (tool) t.currentTool = tool;
    const summary = asString(rec.summary);
    if (summary) t.lastSummary = summary;
    renderUi();
  });

  pi.events.on("team:teammate-idle", (data) => {
    const rec = asRecord(data);
    const id = asString(rec.agentId);
    const t = id ? tracked.get(id) : undefined;
    if (!t) return;
    t.lastProgressAt = Date.now();
    t.activity = "idle";
    const summary = asString(rec.summary);
    if (summary) t.lastSummary = summary;
    // 不 requestReport：idle = 已交付最终消息，team:complete 随后即到
    // （abort + SIGTERM + promise resolve），即报会抢在完成通知前重复播报。
    renderUi();
  });

  pi.events.on("team:complete", (data) => {
    const rec = asRecord(data);
    const id = asString(rec.id);
    if (id) tracked.delete(id);
    if (tracked.size === 0) stopTimer();
    renderUi();
  });

  const reset = () => {
    // 隐藏的 session_start/reset 会清空 tracked 并抹掉 footer——team 运行中发生即为异常，记录之
    if (tracked.size > 0) debugLog("reset_nonempty", { cleared: tracked.size });
    tracked.clear();
    stopTimer();
    renderUi();
  };
  pi.on("session_start", (_event, ctx) => {
    uiCtx = ctx;
    reset();
  });
  // 生命周期事件逐个刷新 ctx（同 git-status），保证任何时刻 renderUi 拿到的都是活 ctx
  pi.on("tool_call", (_event, ctx) => refreshCtx(ctx));
  pi.on("tool_result", (_event, ctx) => refreshCtx(ctx));
  pi.on("turn_start", (_event, ctx) => refreshCtx(ctx));
  pi.on("agent_end", (_event, ctx) => refreshCtx(ctx));
  pi.on("session_shutdown", () => {
    uiCtx = null;
    reset();
  });
}
