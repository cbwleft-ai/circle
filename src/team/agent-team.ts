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
import { assessSafety, REFUSAL_DESTRUCTIVE, REFUSAL_SENSITIVE, WARNING_CONFIG_STRUCTURE } from "../core/safety.js";
import { ScheduleStore } from "../core/schedule-store.js";
import { TaskStore } from "../core/task-store.js";
import { UsageStore } from "../core/usage.js";
import { formatBytes, summarizeText } from "../core/text.js";
import { AttachmentStore, buildMessageWithAttachments } from "../core/upload.js";
import { MessageMerger } from "../core/message-merge.js";
import type {
  ChatMessage,
  DispatchResult,
  OutboundFile,
  ScheduledTask,
  SendArtifactResult,
  Task,
  TaskAttachment,
  WorkerConfig,
} from "../core/types.js";
import { WorkspaceManager } from "../core/workspace.js";
import { inferMimeType } from "../core/text.js";
import type { TeamGateway } from "./gateway.js";

export interface AgentTeamOptions {
  config: AppConfig;
  workers: WorkerConfig[];
  /** 下行消息出口（接入 IM 适配器） */
  outbox: (chatId: string, text: string) => Promise<void>;
  /**
   * 下行文件出口（附件，可选）。
   * 未提供或抛出异常时，sendArtifact 自动降级为文本提示（不阻塞）。
   */
  sendFile?: (chatId: string, file: OutboundFile) => Promise<void>;
  modelRuntime?: ModelRuntime;
}

export class AgentTeam implements TeamGateway {
  readonly config: AppConfig;
  readonly taskStore: TaskStore;
  readonly scheduleStore: ScheduleStore;
  readonly usageStore: UsageStore;
  readonly workspace: WorkspaceManager;
  readonly coordinator: CoordinatorAgent;
  readonly scheduler: SchedulerAgent;
  readonly workers = new Map<string, WorkerAgent>();
  readonly modelRuntime: ModelRuntime;
  readonly attachmentStore: AttachmentStore;

  private turnCount = 0;
  private currentChatId = "console";
  /** 串行化所有 Coordinator 会话操作 */
  private coordinatorQueue: Promise<unknown> = Promise.resolve();
  /**
   * 各会话最近一次携带图片附件的落盘路径（issue #3）：
   * 用户发图后，本轮及后续轮次的派发会确定性附加这些图片（替换式更新，不自动清除，
   * 支持「请描述刚才那张图」这类不带图的追问）。
   */
  private readonly pendingAttachments = new Map<string, TaskAttachment[]>();
  /**
   * 连续消息合并器：同一会话合并窗口内的多条消息（如照片 + 描述）归为一批，
   * Coordinator 只回一轮，避免每条消息各回一条造成割裂。
   */
  private readonly messageMerger: MessageMerger;

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
    this.usageStore = new UsageStore(this.config.dataDir);
    this.workspace = new WorkspaceManager(`${this.config.dataDir}/workspaces`, this.config.agentDir);
    this.attachmentStore = new AttachmentStore(`${this.config.dataDir}/uploads`);

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
    this.sendFile = opts.sendFile;
    this.messageMerger = new MessageMerger(this.config.messageMergeMs, (merged) =>
      this.processMerged(merged),
    );
  }

  private outbox: (chatId: string, text: string) => Promise<void>;
  private sendFile?: (chatId: string, file: OutboundFile) => Promise<void>;

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
    // 丢弃尚未到合并窗口的待处理消息（正常退出场景），避免悬挂定时器
    const pending = this.messageMerger.pendingCount;
    this.messageMerger.dispose();
    if (pending > 0) log.warn("team", `停止时丢弃 ${pending} 个待合并消息批次`);
    this.scheduler.stop();
    await this.coordinator.dispose();
    log.info("team", "AgentTeam 已停止");
  }

  // ============ IM 入口 ============

  /**
   * 用户消息入口（由 IM 适配器回调）。
   * 经 MessageMerger 合并：同会话窗口内多条连续消息（照片 + 描述等）合并为一批，
   * Coordinator 只回复一次；窗口为 0（CIRCLE_MESSAGE_MERGE_MS=0）时退化为逐条处理。
   */
  async handleUserMessage(msg: ChatMessage): Promise<void> {
    this.currentChatId = msg.chatId;
    await this.messageMerger.push(msg);
  }

  /**
   * 处理一批（合并后）用户消息：附件落盘 → 安全评估 → Coordinator → 状态检查。
   * 由 MessageMerger 在合并窗口到期后调用（合并关闭时逐条调用）。
   */
  private async processMerged(msg: ChatMessage): Promise<void> {
    this.turnCount++;

    // 0) 多模态：保存图片/文件附件并把本地路径注入消息文本（issue #3）
    let coordinatorText = msg.text;
    if ((msg.attachments ?? []).length > 0) {
      const saved = this.attachmentStore.save(msg.chatId, msg.attachments!);
      if (saved.length > 0) {
        this.pendingAttachments.set(
          msg.chatId,
          saved.map((s) => ({ path: s.localPath, mimeType: s.mimeType })),
        );
        coordinatorText = buildMessageWithAttachments(msg.text, saved);
        log.info("team", `已保存 ${saved.length} 个附件（chat=${msg.chatId}）`);
      }
    }

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
    if (verdict.risk === "warning") {
      // 配置结构/格式/字段调研：放行（不拦截），但提示仅限结构、禁止读取真实值
      log.warn("safety", `配置结构类请求放行（warning）: ${msg.text.slice(0, 100)} → ${verdict.reasons[0]}`);
      await this.outbox(msg.chatId, WARNING_CONFIG_STRUCTURE);
    }

    // 2) Coordinator 处理（文本已富化：附件路径以【图片】标记注入）
    const reply = await this.enqueueCoordinator(() => this.coordinator.respond(coordinatorText));
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
    if (verdict.risk === "warning") {
      // 配置结构/格式/字段调研：派发入口放行，记录提示
      log.warn("safety", `派发放行（配置结构类 warning）: ${title} → ${verdict.reasons[0]}`);
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
    // 多模态：把该会话最近一次图片附件确定性附加到任务（不依赖 LLM 转述路径，issue #3）
    const pending = this.pendingAttachments.get(this.currentChatId) ?? [];
    const { description: finalDescription, attachments } = buildDispatchWithAttachments(description, pending);
    const task = this.taskStore.create({
      title,
      description: finalDescription,
      status: "received",
      priority: long ? "long" : "short",
      workerName,
      requestedBy: "user",
      requestChatId: this.currentChatId,
      attachments,
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
      const { result, usage } = await worker.runTask(task, workspace);
      this.taskStore.markCompleted(task.id, result, usage);
      this.usageStore.recordTask(task.id, usage);
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
    const notification = `（系统通知）Worker「${task.workerName}」报告：任务 ${task.id}「${task.title}」已${statusWord}。\n执行结果（摘要）：\n${summarizeText(result)}\n\n如用户需要核对完整结果或 Worker 实际产出，可直接调用以下工具读取（无需让 Worker 转述）：\n- task_result：读取完整执行结果（未截断）\n- list_artifacts：查看产出物文件清单（路径 + 大小）\n- read_artifact：读取指定产出物文件内容\n\n请整理后向用户汇报最终结果。`;
    try {
      const reply = await this.enqueueCoordinator(() => this.coordinator.respond(notification));
      if (reply) await this.outbox(chatId, reply);
    } catch (e) {
      log.error("team", `任务结果汇报失败: ${(e as Error).message}`);
      await this.outbox(
        chatId,
        `任务 ${task.id} 已${statusWord}（系统自动汇报）：\n${summarizeText(result, { maxChars: 500 })}\n\n完整结果与产出物文件位于 ${this.workspace.taskArtifactRoot(task.workerName, task.id) ?? "产出物目录"}，可随时要求我读取核对。`,
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

  // ============ 产出物访问（issue #21：Coordinator 直接读取 Worker 完整产出） ============

  listArtifacts(taskId: string): string {
    const task = this.taskStore.get(taskId);
    if (!task) return `任务 ${taskId} 不存在。`;
    const entries = this.workspace.listTaskArtifacts(task.workerName, taskId);
    if (entries.length === 0) {
      return `任务 ${taskId}「${task.title}」暂无产出物文件。`;
    }
    const files = entries.filter((e) => e.type === "file");
    const dirs = entries.filter((e) => e.type === "dir");
    const lines: string[] = [
      `任务 ${taskId}「${task.title}」产出物清单（${files.length} 个文件${dirs.length > 0 ? `，${dirs.length} 个目录` : ""}）：`,
    ];
    for (const e of entries) {
      lines.push(e.type === "dir" ? `  📁 ${e.path}` : `  📄 ${e.path}（${formatBytes(e.size)}）`);
    }
    return lines.join("\n");
  }

  readArtifact(taskId: string, relPath: string): string {
    const task = this.taskStore.get(taskId);
    if (!task) return `任务 ${taskId} 不存在。`;
    const res = this.workspace.readTaskArtifact(task.workerName, taskId, relPath);
    if (!res.ok) return `读取失败：${res.error}`;
    const truncatedNote = res.truncated
      ? `（内容超长，已保留头尾；完整文件位于产出物目录 ${this.workspace.taskArtifactRoot(task.workerName, task.id) ?? "产出物目录"}）`
      : "";
    return `文件 ${relPath}（${formatBytes(res.size ?? 0)}${truncatedNote}）：\n\n${res.content}`;
  }

  getTaskResult(taskId: string): string | undefined {
    return this.taskStore.get(taskId)?.result;
  }

  async sendArtifact(taskId: string, relPath: string, caption?: string): Promise<SendArtifactResult> {
    const task = this.taskStore.get(taskId);
    if (!task) {
      return { ok: false, message: `任务 ${taskId} 不存在，无法发送产出物。` };
    }
    const read = this.workspace.readTaskArtifactBuffer(task.workerName, taskId, relPath);
    if (!read.ok || !read.buffer) {
      return { ok: false, message: `无法发送产出物：${read.error}` };
    }
    const fileName = relPath.split("/").pop() ?? relPath;
    const file: OutboundFile = {
      fileName,
      content: read.buffer,
      size: read.size ?? read.buffer.length,
      mimeType: inferMimeType(fileName),
      caption: caption ?? `任务 ${taskId}「${task.title}」的产出物：${fileName}`,
      sourcePath: this.workspace.taskArtifactRoot(task.workerName, taskId),
    };
    const chatId = task.requestChatId ?? this.currentChatId;
    if (this.sendFile) {
      try {
        await this.sendFile(chatId, file);
        log.info("team", `任务 ${taskId} 产出物已发送 → ${chatId}: ${fileName}（${file.size} B）`);
        return {
          ok: true,
          message: `产出物 ${fileName} 已作为文件发送给用户（${file.size} 字节）。`,
        };
      } catch (e) {
        const err = (e as Error).message;
        log.warn("team", `任务 ${taskId} 产出物文件发送失败，降级为文本: ${err}`);
        // 文件通道失败 → 降级为文本提示，不阻塞主流程
      }
    }
    // 通道不支持文件或发送失败 → 文本降级
    const fallback = `已生成产出物文件 ${fileName}（${file.size} 字节）${file.sourcePath ? `，完整文件位于 ${file.sourcePath}` : ""}。当前通道无法直接发送文件，如需内容可用 read_artifact 读取。`;
    try {
      await this.outbox(chatId, fallback);
    } catch (e) {
      return { ok: false, message: `产出物发送失败：${(e as Error).message}` };
    }
    return { ok: false, message: `产出物 ${fileName} 已生成但当前通道不支持文件发送，已通过文字告知用户（${file.size} 字节）。` };
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
 * 派发时把会话待处理的图片附件确定性附加到任务（纯函数，便于测试）。
 * 有附件时在描述尾部追加说明，并返回 attachments 供任务持久化。
 */
export function buildDispatchWithAttachments(
  description: string,
  pending: TaskAttachment[] | undefined,
): { description: string; attachments: TaskAttachment[] | undefined } {
  if (!pending || pending.length === 0) return { description, attachments: undefined };
  return {
    description: `${description}\n\n（用户附带了 ${pending.length} 张图片，已作为图片输入提供，请查看并处理）`,
    attachments: pending,
  };
}

/**
 * 长文本摘要（头尾兼顾）——自 core/text 转发，保持既有引用兼容。
 * 完整实现见 src/core/text.ts。
 */
export { summarizeText } from "../core/text.js";

