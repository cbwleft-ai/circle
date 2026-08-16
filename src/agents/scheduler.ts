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
import type { AppConfig } from "../config.js";
import type { ScheduleStore } from "../core/schedule-store.js";
import type { ScheduledTask } from "../core/types.js";

export interface SchedulerDeps {
  /** 触发定时任务：创建 Task 并派发给 Worker，返回任务 */
  runScheduled(schedule: ScheduledTask): Promise<{ taskId: string; result?: string; error?: string }>;
  /** 每日清理回调 */
  runDailyCleanup(): Promise<{ removedTasks: number; removedWorkspaces: number }>;
}

export class SchedulerAgent {
  private timer?: ReturnType<typeof setInterval>;
  private lastCleanupCheck: Date = new Date();

  constructor(
    private readonly store: ScheduleStore,
    private readonly config: AppConfig,
    private readonly deps: SchedulerDeps,
  ) {}

  start(): void {
    // 启动时初始化各定时任务的 nextRunAt
    for (const s of this.store.list()) {
      if (s.enabled && !s.nextRunAt) {
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
      const nextAt = s.nextRunAt;
      // 到期（nextRunAt <= now）且未被本次触发过（> lastRunAt）：双重防重
      if (nextAt !== undefined && nextAt <= now.getTime() && nextAt > (s.lastRunAt ?? 0)) {
        await this.fire(s);
      }
    }
    await this.maybeRunCleanup(now);
  }

  /** 立即触发某个定时任务（供测试与手动触发） */
  async fire(schedule: ScheduledTask): Promise<void> {
    log.info("scheduler", `触发定时任务 ${schedule.id}「${schedule.name}」`);
    const res = await this.deps.runScheduled(schedule);
    // exclusive：从下一整分钟起算，nextRunAt 严格晚于本次触发，防止同一分钟重复触发
    const next = nextRun(schedule.cron, new Date(), { exclusive: true });
    this.store.update(schedule.id, {
      lastRunAt: Date.now(),
      nextRunAt: next?.getTime(),
      taskIds: res.taskId ? [...schedule.taskIds, res.taskId] : schedule.taskIds,
    });
    if (res.error) {
      log.error("scheduler", `定时任务 ${schedule.id} 执行失败: ${res.error}`);
    }
  }

  /** 创建定时任务（校验 cron 合法性） */
  create(input: {
    name: string;
    cron: string;
    description: string;
    workerName: string;
  }): ScheduledTask {
    parseCron(input.cron); // 校验
    const s = this.store.create({
      name: input.name,
      cron: input.cron,
      description: input.description,
      workerName: input.workerName,
      enabled: true,
      taskIds: [],
    });
    const next = nextRun(s.cron);
    if (next) this.store.update(s.id, { nextRunAt: next.getTime() });
    log.info("scheduler", `已创建定时任务 ${s.id}「${s.name}」cron="${s.cron}"`);
    return s;
  }

  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined {
    if (patch.cron !== undefined) parseCron(patch.cron); // 校验
    const s = this.store.update(id, patch);
    if (s && s.enabled) {
      const next = nextRun(s.cron);
      this.store.update(s.id, { nextRunAt: next?.getTime() });
    }
    return s;
  }

  delete(id: string): ScheduledTask | undefined {
    const s = this.store.delete(id);
    if (s) log.info("scheduler", `已删除定时任务 ${id}「${s.name}」`);
    return s;
  }

  /** 每日清理：cron 到点后清理已完成超过 N 天的任务及其临时工作空间 */
  private async maybeRunCleanup(now: Date): Promise<void> {
    const cron = this.config.cleanupCron;
    try {
      const parsed = parseCron(cron);
      // 每分钟粒度：检查上一个 tick 到现在是否跨过触发时刻
      if (matches(parsed, now) && now.getTime() - this.lastCleanupCheck.getTime() > 60_000) {
        this.lastCleanupCheck = now;
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
