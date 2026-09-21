/**
 * Scheduler Agent —— 定时任务管理（确定性实现，不依赖 LLM，保证触发可靠）。
 *
 * 职责：
 * 1. 接受 Coordinator 安排的定时任务变更（增删改）；
 * 2. 定时 tick 扫描到期任务，向 Worker 下发执行，并跟进进展；
 * 3. 执行系统定时任务：每天检查一次全量任务状态，清理已完成超过 30 天的任务及其临时工作空间；
 * 4. 任务完成/失败后向 Coordinator 反馈（通过团队回调）。
 */
import { parseCron, nextRun, matches } from "../core/cron.js";
import { log } from "../core/logger.js";
import { isOnceSchedule } from "../core/schedule-store.js";
import { formatLocalDateTime, parseLocalDateTime } from "../core/time.js";
import type { AppConfig } from "../config.js";
import type { ScheduleStore } from "../core/schedule-store.js";
import type { ScheduledTask } from "../core/types.js";

/** 一次性任务错过后的默认补触发宽限期（毫秒），可被 CIRCLE_ONCE_GRACE_MS 覆盖 */
const DEFAULT_ONCE_GRACE_MS = 10 * 60 * 1000;

export interface SchedulerDeps {
  /** 触发定时任务：创建 Task 并派发给 Worker，返回任务 */
  runScheduled(schedule: ScheduledTask): Promise<{ taskId: string; result?: string; error?: string }>;
  /** 每日清理回调 */
  runDailyCleanup(): Promise<{ removedTasks: number; removedWorkspaces: number }>;
}

export class SchedulerAgent {
  private timer?: ReturnType<typeof setInterval>;
  /** 上次实际执行每日清理的时间戳（0 = 本次进程尚未执行过）；用于同一触发分钟内的防重 */
  private lastCleanupAt = 0;
  /** 正在执行中的定时任务 id（in-flight 锁）：tick 与 fire 并发时防止同一任务重复触发 */
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly store: ScheduleStore,
    private readonly config: AppConfig,
    private readonly deps: SchedulerDeps,
  ) {}

  start(): void {
    // 启动时初始化各定时任务的 nextRunAt
    for (const s of this.store.list()) {
      if (!s.enabled) continue;
      if (isOnceSchedule(s)) {
        // 一次性任务：runAt 是语义源，启动时始终重算 nextRunAt（人工改过 runAt 也能生效）
        try {
          const at = parseLocalDateTime(s.runAt ?? "");
          this.store.update(s.id, { nextRunAt: at.getTime() });
        } catch (e) {
          this.store.update(s.id, { enabled: false, nextRunAt: undefined });
          log.error("scheduler", `一次性任务 ${s.id}「${s.name}」的触发时间无效，已停用: ${(e as Error).message}`);
        }
      } else if (!s.nextRunAt && s.cron) {
        const next = nextRun(s.cron);
        if (next) this.store.update(s.id, { nextRunAt: next.getTime() });
      }
    }
    this.timer = setInterval(() => void this.tick(), this.config.schedulerTickMs);
    this.timer.unref?.();
    log.info(
      "scheduler",
      `Scheduler 已启动（tick=${this.config.schedulerTickMs}ms，清理规则: cron "${this.config.cleanupCron}"，保留 ${this.config.cleanupAfterDays} 天）`,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 每 tick 检查：到期定时任务 + 每日清理 */
  async tick(): Promise<void> {
    const now = new Date();
    for (const s of this.store.list(true)) {
      // in-flight 锁：已有一次触发在执行中（Worker 可能跑很久），本轮直接跳过，不再重复下发
      if (this.inFlight.has(s.id)) continue;
      const nextAt = s.nextRunAt;
      // 到期（nextRunAt <= now）且未被本次触发过（> lastRunAt）：双重防重
      if (nextAt === undefined || nextAt > now.getTime() || nextAt <= (s.lastRunAt ?? 0)) continue;
      // 一次性任务错过补触发策略（issue #49）：宽限期内补触发，超期标记「已错过」不再执行，
      // 避免宕机数小时后陈旧提醒才突然打扰。
      if (isOnceSchedule(s) && now.getTime() - nextAt > this.onceGraceMs()) {
        this.store.update(s.id, { enabled: false, nextRunAt: undefined, missedAt: now.getTime() });
        log.warn(
          "scheduler",
          `一次性任务 ${s.id}「${s.name}」已错过触发（计划 ${s.runAt ?? nextAt}），超过宽限期 ${this.onceGraceMs()}ms，不再执行`,
        );
        continue;
      }
      await this.fire(s);
    }
    await this.maybeRunCleanup(now);
  }

  /** 立即触发某个定时任务（供测试与手动触发） */
  async fire(schedule: ScheduledTask): Promise<void> {
    if (this.inFlight.has(schedule.id)) {
      log.warn("scheduler", `定时任务 ${schedule.id} 已在执行中，跳过重复触发`);
      return;
    }
    this.inFlight.add(schedule.id);
    log.info("scheduler", `触发定时任务 ${schedule.id}「${schedule.name}」`);
    try {
      // 先占坑再执行：在派发 Worker 之前立刻写回 lastRunAt/nextRunAt。
      // 此前记账在 await runScheduled（Worker 可能执行数分钟）之后，
      // 导致并发的 tick 一直读到旧状态（nextRunAt 仍 <= now、lastRunAt 为空）而反复触发。
      if (isOnceSchedule(schedule)) {
        // 一次性任务（issue #49）：派发前立即停用并清空 nextRunAt，并发 tick / 进程重启都不会二次触发。
        this.store.update(schedule.id, { lastRunAt: Date.now(), nextRunAt: undefined, enabled: false });
      } else {
        // exclusive：从下一整分钟起算，nextRunAt 严格晚于本次触发，防止同一分钟重复触发。
        const next = schedule.cron ? nextRun(schedule.cron, new Date(), { exclusive: true }) : undefined;
        this.store.update(schedule.id, { lastRunAt: Date.now(), nextRunAt: next?.getTime() });
      }
      const res = await this.deps.runScheduled(schedule);
      // 任务记录已由 runScheduled 内部的 addTaskRecord 写入（同一 store 实例），
      // 这里不再基于旧数组展开 taskIds——既避免并发覆盖，也避免重复记录同一 taskId。
      if (res.error) {
        log.error("scheduler", `定时任务 ${schedule.id} 执行失败: ${res.error}`);
      }
    } finally {
      this.inFlight.delete(schedule.id);
    }
  }

  /** 创建定时任务：cron（周期性）与 at（一次性，本地时间 "YYYY-MM-DD HH:mm"）二选一 */
  create(input: {
    name: string;
    cron?: string;
    at?: string;
    description: string;
    workerName: string;
    /** 创建者所在会话（触发结果回流；缺省回落到默认会话） */
    ownerChatId?: string;
  }): ScheduledTask {
    const timing = this.resolveTiming(input);
    const s = this.store.create({
      name: input.name,
      description: input.description,
      workerName: input.workerName,
      ownerChatId: input.ownerChatId,
      enabled: true,
      taskIds: [],
      ...timing,
    });
    const when = timing.kind === "once" ? `一次性触发时间 ${timing.runAt}` : `cron "${timing.cron}"`;
    log.info("scheduler", `已创建定时任务 ${s.id}「${s.name}」${when}`);
    return s;
  }

  /** 修改定时任务：cron 与 runAt（一次性）互斥；提供 runAt 时默认重新启用（re-arm） */
  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined {
    const current = this.store.get(id);
    if (!current) return undefined;
    const nextPatch: Partial<ScheduledTask> = { ...patch };
    const hasCron = patch.cron !== undefined;
    const hasAt = patch.runAt !== undefined;
    if (hasCron && hasAt) throw new Error("cron（周期性）与 at（一次性）只能二选一");
    if (hasCron || hasAt) {
      const timing = this.resolveTiming(hasCron ? { cron: patch.cron } : { at: patch.runAt });
      Object.assign(nextPatch, timing, { missedAt: undefined });
      // 一次性任务重新武装：未显式指定 enabled 时默认重新启用
      if (timing.kind === "once" && patch.enabled === undefined) nextPatch.enabled = true;
    }
    let updated = this.store.update(id, nextPatch);
    if (updated && updated.enabled) {
      // 保持派生字段 nextRunAt 与语义源一致：cron 重算表达式，once 从 runAt 派生
      try {
        updated = this.store.update(id, { nextRunAt: this.deriveNextRunAt(updated) });
      } catch (e) {
        log.error("scheduler", `定时任务 ${id} 的下次触发时间计算失败: ${(e as Error).message}`);
      }
    }
    return updated;
  }

  delete(id: string): ScheduledTask | undefined {
    const s = this.store.delete(id);
    if (s) log.info("scheduler", `已删除定时任务 ${id}「${s.name}」`);
    return s;
  }

  private onceGraceMs(): number {
    return this.config.onceGraceMs ?? DEFAULT_ONCE_GRACE_MS;
  }

  /**
   * 校验并归一化触发时间（issue #49）：cron（周期性）与 at（一次性）必须二选一。
   * once 的 runAt 统一存本地时间 "YYYY-MM-DD HH:mm"，nextRunAt 为派生时间戳。
   */
  private resolveTiming(input: { cron?: string; at?: string }): Pick<
    ScheduledTask,
    "kind" | "cron" | "runAt" | "nextRunAt"
  > {
    const hasCron = input.cron !== undefined;
    const hasAt = input.at !== undefined;
    if (hasCron && hasAt) {
      throw new Error("cron（周期性）与 at（一次性）只能二选一");
    }
    if (!hasCron && !hasAt) {
      throw new Error("必须提供 cron（周期性任务）或 at（一次性任务）之一");
    }
    if (hasCron) {
      const expr = input.cron!.trim();
      if (!expr) throw new Error("cron 不能为空");
      const next = nextRun(expr); // 内含 parseCron 校验；闰日等超扫描范围时 next 为 undefined
      return { kind: "cron", cron: expr, runAt: undefined, nextRunAt: next?.getTime() };
    }
    const atText = input.at!.trim();
    const at = parseLocalDateTime(atText);
    if (at.getTime() <= Date.now()) {
      throw new Error(`一次性触发时间必须晚于当前时间（收到 ${atText}）；如需立即执行请直接派发任务`);
    }
    return { kind: "once", cron: undefined, runAt: formatLocalDateTime(at), nextRunAt: at.getTime() };
  }

  /** 由语义源（cron / runAt）派生 nextRunAt；once 不校验未来，供启动/更新后重算使用 */
  private deriveNextRunAt(s: Pick<ScheduledTask, "kind" | "cron" | "runAt">): number | undefined {
    if (isOnceSchedule(s)) {
      if (!s.runAt) return undefined;
      return parseLocalDateTime(s.runAt).getTime();
    }
    if (!s.cron) return undefined;
    return nextRun(s.cron)?.getTime();
  }

  /** 每日清理：cron 到点后清理已完成超过 N 天的任务及其临时工作空间 */
  private async maybeRunCleanup(now: Date): Promise<void> {
    const cron = this.config.cleanupCron;
    try {
      const parsed = parseCron(cron);
      // 每分钟粒度：命中触发时刻且距上次实际执行超过 60s（同一分钟内多次 tick 只执行一次）。
      // 必须基于「上次实际执行时间」而非「上次检查时间」：否则进程恰在清理时刻前 60s 内
      // 启动时，首个命中的 tick 会被防重条件跳过，导致当天清理整体漏执行。
      if (matches(parsed, now) && now.getTime() - this.lastCleanupAt > 60_000) {
        this.lastCleanupAt = now.getTime();
        const res = await this.deps.runDailyCleanup();
        log.info(
          "scheduler",
          `每日清理完成：删除任务记录 ${res.removedTasks} 条，清理任务工作空间 ${res.removedWorkspaces} 个`,
        );
      }
    } catch (e) {
      log.error("scheduler", `清理 cron 配置无效: ${(e as Error).message}`);
    }
  }
}
