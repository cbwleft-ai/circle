/**
 * AgentTeam —— 将 Coordinator / Worker / Scheduler 组合为一个对用户呈现
 * 「单个 Agent」的协作团队。
 *
 * 消息流：
 * 用户 → IM → AgentTeam.handleUserMessage
 *       → 安全评估（破坏性/敏感 → 直接拒绝）
 *       → Coordinator（LLM，仅对话）
 *       → dispatch_task / create_schedule 等工具 → Worker / Scheduler
 * 长程任务 / 定时任务完成 → 团队注入系统通知 → Coordinator 汇报 → IM → 用户
 */
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { CoordinatorAgent } from "../agents/coordinator.js";
import { SchedulerAgent } from "../agents/scheduler.js";
import { WorkerAgent } from "../agents/worker.js";
import { LONG_TASK_PATTERNS, type AppConfig } from "../config.js";
import { log } from "../core/logger.js";
import { assessSafety, REFUSAL_DESTRUCTIVE, REFUSAL_SENSITIVE } from "../core/safety.js";
import { ScheduleStore } from "../core/schedule-store.js";
import { TaskStore } from "../core/task-store.js";
import type {
  ChatMessage,
  DispatchResult,
  ScheduledTask,
  Task,
  WorkerConfig,
} from "../core/types.js";
import { WorkspaceManager } from "../core/workspace.js";
import type { TeamGateway } from "./gateway.js";

export interface AgentTeamOptions {
  config: AppConfig;
  workers: WorkerConfig[];
  /** 下行消息出口（接入 IM 适配器） */
  outbox: (chatId: string, text: string) => Promise<void>;
  modelRuntime?: ModelRuntime;
}

export class AgentTeam implements TeamGateway {
  readonly config: AppConfig;
  readonly taskStore: TaskStore;
  readonly scheduleStore: ScheduleStore;
  readonly workspace: WorkspaceManager;
  readonly coordinator: CoordinatorAgent;
  readonly scheduler: SchedulerAgent;
  readonly workers = new Map<string, WorkerAgent>();
  readonly modelRuntime: ModelRuntime;

  private turnCount = 0;
  private currentChatId = "console";
  /** 串行化所有 Coordinator 会话操作 */
  private coordinatorQueue: Promise<unknown> = Promise.resolve();

  /** 异步工厂：创建共享 ModelRuntime（读取 agentDir 的 auth.json / models.json） */
  static async create(opts: AgentTeamOptions): Promise<AgentTeam> {
    const modelRuntime = opts.modelRuntime ?? (await ModelRuntime.create());
    return new AgentTeam({ ...opts, modelRuntime });
  }

  constructor(opts: AgentTeamOptions & { modelRuntime: ModelRuntime }) {
    this.config = opts.config;
    this.modelRuntime = opts.modelRuntime;
    this.taskStore = new TaskStore(this.config.dataDir);
    this.scheduleStore = new ScheduleStore(this.config.dataDir);
    this.workspace = new WorkspaceManager(`${this.config.dataDir}/workspaces`, this.config.agentDir);

    for (const w of opts.workers) {
      const dir = this.workspace.workerDir(w.name);
      const worker = new WorkerAgent({ ...w, cwd: w.cwd ?? dir }, this.modelRuntime, this.config);
      worker.ensureWorkspace();
      this.workers.set(w.name, worker);
    }

    this.coordinator = new CoordinatorAgent(this.modelRuntime, this.config, this);
    this.scheduler = new SchedulerAgent(this.scheduleStore, this.config, {
      runScheduled: (s) => this.runScheduled(s),
      runDailyCleanup: () => this.runDailyCleanup(),
    });
    this.outbox = opts.outbox;
  }

  private outbox: (chatId: string, text: string) => Promise<void>;

  async start(): Promise<void> {
    await this.coordinator.start();
    this.scheduler.start();
    // 启动对账：上次进程中断遗留的任务标记失败，并通知用户（仅通知，不自动重跑）
    await this.reconcileInterrupted();
    log.info(
      "team",
      `AgentTeam 已启动：Coordinator + ${this.workers.size} 个 Worker + Scheduler`,
    );
  }

  /**
   * 启动对账：把进程重启遗留的 received/running 任务标记为 failed，
   * 并按发起会话（requestChatId）分组通知用户中断清单。
   * 只通知、不自动恢复——重跑由用户决定后重新派发。
   */
  private async reconcileInterrupted(): Promise<void> {
    const interrupted = this.taskStore.reconcileInterrupted("进程重启，任务中断");
    if (interrupted.length === 0) return;

    // 按 requestChatId 分组，避免打扰无关会话
    const byChat = new Map<string, Task[]>();
    for (const t of interrupted) {
      const chatId = t.requestChatId ?? this.currentChatId;
      const list = byChat.get(chatId) ?? [];
      list.push(t);
      byChat.set(chatId, list);
    }

    for (const [chatId, tasks] of byChat) {
      const summary = tasks
        .map((t) => `- ${t.id}「${t.title}」（Worker: ${t.workerName}）`)
        .join("\n");
      const notification = `（系统通知）系统已重启。上次进程中断时有 ${tasks.length} 个任务未完成，已标记为失败：\n${summary}\n\n请告知用户：这些任务如需重新执行，用户可以提出，我会重新派发。`;
      try {
        const reply = await this.enqueueCoordinator(() =>
          this.coordinator.respond(notification),
        );
        if (reply) await this.outbox(chatId, reply);
      } catch (e) {
        log.error("team", `重启中断通知汇报失败: ${(e as Error).message}`);
        await this.outbox(
          chatId,
          `（系统自动通知）系统已重启，以下 ${tasks.length} 个任务因进程中断未完成：\n${summary}\n\n如需重新执行，请告诉我。`,
        );
      }
    }
  }

  async stop(): Promise<void> {
    this.scheduler.stop();
    await this.coordinator.dispose();
    log.info("team", "AgentTeam 已停止");
  }

  // ============ IM 入口 ============

  /** 用户消息入口（由 IM 适配器回调） */
  async handleUserMessage(msg: ChatMessage): Promise<void> {
    this.currentChatId = msg.chatId;
    this.turnCount++;

    // 1) 安全评估（确定性拦截，不经过 LLM，保证不可绕过）
    const verdict = assessSafety(msg.text);
    if (verdict.risk === "destructive") {
      log.warn("safety", `拦截破坏性请求: ${msg.text.slice(0, 100)}`);
      await this.outbox(msg.chatId, REFUSAL_DESTRUCTIVE);
      return;
    }
    if (verdict.risk === "sensitive") {
      log.warn("safety", `拦截敏感请求: ${msg.text.slice(0, 100)}`);
      await this.outbox(msg.chatId, REFUSAL_SENSITIVE);
      return;
    }

    // 2) Coordinator 处理
    const reply = await this.enqueueCoordinator(() => this.coordinator.respond(msg.text));
    if (reply) await this.outbox(msg.chatId, reply);

    // 3) 每 N 轮对话检查一次待办任务状态（长程任务跟进）
    if (this.turnCount % this.config.statusCheckInterval === 0) {
      const pending = this.taskStore.pending();
      if (pending.length > 0) {
        const summary = this.taskStore.summarize({
          status: ["received", "dispatched", "running"],
        });
        const statusReply = await this.enqueueCoordinator(() =>
          this.coordinator.respond(
            `（系统提醒：已到第 ${this.turnCount} 轮对话，请检查以下待办任务状态并向用户汇报最新进展）\n${summary}`,
          ),
        );
        if (statusReply) await this.outbox(msg.chatId, statusReply);
      }
    }
  }

  /** 串行执行 Coordinator 会话操作 */
  private enqueueCoordinator<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.coordinatorQueue.then(() => fn());
    this.coordinatorQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  // ============ TeamGateway 实现（Coordinator 工具回调） ============

  listWorkers(): WorkerConfig[] {
    return [...this.workers.values()].map((w) => w.config);
  }

  async dispatch(
    workerName: string,
    title: string,
    description: string,
    longFlag: boolean,
  ): Promise<DispatchResult> {
    // 第二道安全评估：即使 Coordinator LLM 误判，这里也会拦截
    const verdict = assessSafety(description);
    if (verdict.risk === "destructive") {
      log.warn("safety", `派发拦截（破坏性）: ${title}`);
      return { ok: false, reasons: verdict.reasons, message: REFUSAL_DESTRUCTIVE };
    }
    if (verdict.risk === "sensitive") {
      log.warn("safety", `派发拦截（敏感）: ${title}`);
      return { ok: false, reasons: verdict.reasons, message: REFUSAL_SENSITIVE };
    }

    const worker = this.workers.get(workerName);
    if (!worker) {
      const available = [...this.workers.keys()].join(", ");
      return {
        ok: false,
        reasons: [],
        message: `Worker「${workerName}」不存在。可用 Worker: ${available || "无"}`,
      };
    }

    // 长程判定：Coordinator 标记 或 启发式兜底
    const long = longFlag || LONG_TASK_PATTERNS.some((re) => re.test(description));
    const task = this.taskStore.create({
      title,
      description,
      status: "received",
      priority: long ? "long" : "short",
      workerName,
      requestedBy: "user",
      requestChatId: this.currentChatId,
    });
    log.info("team", `创建任务 ${task.id}「${title}」→ ${workerName}（${task.priority}）`);

    const workspace = this.workspace.taskWorkspaceDir(workerName, task.id);

    if (long) {
      // 长程任务：立即 ack，异步执行
      void this.executeTask(task, worker, workspace, true);
      return {
        ok: true,
        task,
        async: true,
        message: `任务已收到。任务编号 ${task.id}「${title}」已派发给 Worker「${workerName}」，预计运行超过 ${this.config.longTaskThresholdSec} 秒，完成后我会主动向你汇报。`,
      };
    }

    // 短程任务：同步执行（结果直接在工具返回值中带出，由 Coordinator 在当轮汇报，不再触发独立通知）
    try {
      const result = await this.executeTask(task, worker, workspace, false);
      return {
        ok: true,
        task,
        async: false,
        message: `任务 ${task.id}「${title}」已完成。\n\n${result}`,
      };
    } catch (e) {
      const err = (e as Error).message;
      this.taskStore.markFailed(task.id, err);
      return {
        ok: true,
        task,
        async: false,
        message: `任务 ${task.id}「${title}」执行失败：${err}`,
      };
    }
  }

  /**
   * 执行任务（更新状态 + 完成后归档产出物 + 通知 Coordinator 汇报）。
   * notify=true 适用于长程/定时任务（在非 Coordinator 回合中异步执行）；
   * notify=false 适用于短程任务（结果随工具返回值返回，避免递归触发 Coordinator 回合）。
   */
  private async executeTask(
    task: Task,
    worker: WorkerAgent,
    workspace: string,
    notify: boolean,
  ): Promise<string> {
    this.taskStore.markRunning(task.id);
    try {
      const result = await worker.runTask(task, workspace);
      this.taskStore.markCompleted(task.id, result);
      log.info("team", `任务 ${task.id} 已完成`);
      // 归档任务工作空间为产出物目录（tasks/<taskId> → outputs/<taskId>），持久保留
      let report = result;
      try {
        const outDir = this.workspace.archiveTaskOutput(task.workerName, task.id);
        report = `${result}\n\n产出物目录：${outDir}`;
      } catch (e) {
        log.warn("team", `任务 ${task.id} 产出物归档失败: ${(e as Error).message}`);
      }
      if (notify) await this.reportCompletion(task, report, false);
      return report;
    } catch (e) {
      const err = (e as Error).message;
      this.taskStore.markFailed(task.id, err);
      log.error("team", `任务 ${task.id} 失败: ${err}`);
      // 失败任务的工作空间保留在 tasks/<taskId> 便于排查，由 30 天清理兜底
      if (notify) await this.reportCompletion(task, err, true);
      throw e;
    }
  }

  /** 任务完成/失败 → 注入系统通知 → Coordinator 汇总 → 发送给发起用户 */
  private async reportCompletion(task: Task, result: string, failed: boolean): Promise<void> {
    const chatId = task.requestChatId ?? this.currentChatId;
    const statusWord = failed ? "失败" : "完成";
    const notification = `（系统通知）Worker「${task.workerName}」报告：任务 ${task.id}「${task.title}」已${statusWord}。\n执行结果：\n${summarizeText(result)}\n\n请整理后向用户汇报最终结果。`;
    try {
      const reply = await this.enqueueCoordinator(() => this.coordinator.respond(notification));
      if (reply) await this.outbox(chatId, reply);
    } catch (e) {
      log.error("team", `任务结果汇报失败: ${(e as Error).message}`);
      await this.outbox(
        chatId,
        `任务 ${task.id} 已${statusWord}（系统自动汇报）：\n${summarizeText(result, { maxChars: 500 })}`,
      );
    }
  }

  // ============ Scheduler 协作 ============

  createSchedule(name: string, cron: string, description: string, worker: string): ScheduledTask {
    if (!this.workers.has(worker)) {
      throw new Error(`Worker「${worker}」不存在`);
    }
    return this.scheduler.create({ name, cron, description, workerName: worker });
  }

  updateSchedule(id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined {
    return this.scheduler.update(id, patch);
  }

  deleteSchedule(id: string): ScheduledTask | undefined {
    return this.scheduler.delete(id);
  }

  listTasks(status?: string): string {
    const valid = ["received", "dispatched", "running", "completed", "failed", "rejected"];
    if (status && valid.includes(status)) {
      return this.taskStore.summarize({ status: status as Task["status"] });
    }
    return this.taskStore.summarize();
  }

  listSchedules(): string {
    return this.scheduleStore.summarize();
  }

  /** Scheduler 触发：创建任务并派发 Worker，等待结果 */
  private async runScheduled(
    schedule: ScheduledTask,
  ): Promise<{ taskId: string; result?: string; error?: string }> {
    const worker = this.workers.get(schedule.workerName);
    if (!worker) {
      return { taskId: "", error: `Worker「${schedule.workerName}」不存在` };
    }
    const task = this.taskStore.create({
      title: `[定时] ${schedule.name}`,
      description: schedule.description,
      status: "received",
      priority: "long",
      workerName: schedule.workerName,
      requestedBy: "scheduler",
      scheduleId: schedule.id,
      requestChatId: this.currentChatId,
    });
    this.scheduleStore.addTaskRecord(schedule.id, task.id);
    const workspace = this.workspace.taskWorkspaceDir(schedule.workerName, task.id);
    try {
      const result = await this.executeTask(task, worker, workspace, true);
      return { taskId: task.id, result };
    } catch (e) {
      return { taskId: task.id, error: (e as Error).message };
    }
  }

  /** 每日清理：删除已完成超过 N 天的任务记录及其任务工作空间 */
  private async runDailyCleanup(): Promise<{ removedTasks: number; removedWorkspaces: number }> {
    const removedTasks = this.taskStore.cleanupCompleted(this.config.cleanupAfterDays);
    for (const t of removedTasks) {
      this.workspace.removeTaskWorkspace(t.workerName, t.id);
    }
    const removedWorkspaces = this.workspace.cleanupStaleTaskWorkspaces(
      this.config.cleanupAfterDays * 24 * 3600 * 1000,
    );
    return { removedTasks: removedTasks.length, removedWorkspaces };
  }

  /** 供测试/运维手动触发定时任务 */
  async triggerScheduleNow(id: string): Promise<void> {
    const s = this.scheduleStore.get(id);
    if (!s) throw new Error(`定时任务 ${id} 不存在`);
    await this.scheduler.fire(s);
  }
}

/**
 * 长文本摘要（头尾兼顾）：结果不超过 maxChars 时原样返回；
 * 超过时保留头部 headChars + 尾部 tailChars，中间以省略标记连接。
 * 长任务的关键结论通常在尾部（Worker 提示词要求总结放最后），
 * 因此截断时保尾比保头更重要；完整结果始终已存于 TaskStore 与产出物目录。
 */
export function summarizeText(
  text: string,
  opts: { maxChars?: number; headChars?: number; tailChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 4000;
  const headChars = opts.headChars ?? 1500;
  const tailChars = opts.tailChars ?? 1500;
  if (text.length <= maxChars) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - headChars - tailChars;
  return `${head}\n\n…(中间省略 ${omitted} 字符，完整结果已存储)…\n\n${tail}`;
}

