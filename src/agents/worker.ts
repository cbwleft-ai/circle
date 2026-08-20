/**
 * Worker Agent —— 具体执行任务的角色。
 *
 * 特性：
 * - 每个任务使用**独立会话 + 独立工作空间**：会话 cwd 指向该任务专属目录
 *   data/workspaces/<workerName>/tasks/<taskId>/，任务之间互不可见、互不影响；
 * - Worker 的持久目录仅存放技能/配置，不再作为任务执行目录；
 * - 任务完成后，其工作空间由团队层归档为产出物目录 outputs/<taskId>/（持久保留）；
 * - 短程任务：执行后直接返回结果；
 * - 长程任务：先返回「任务已收到」（由团队层立即 ack），执行完成后再反馈结果。
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ModelRuntime,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import type { AppConfig } from "../config.js";
import { log } from "../core/logger.js";
import { systemTimeBlock } from "../core/time.js";
import { addUsage, emptyUsage, formatUsage, usageFromAgentMessages } from "../core/usage.js";
import type { Task, TaskUsage, WorkerConfig } from "../core/types.js";

const SessionManagerShim = {
  inMemory: () => SessionManager.inMemory(),
  inMemorySettings: () => SettingsManager.inMemory({ compaction: { enabled: false } }),
};

export class WorkerAgent {
  private running = 0;

  constructor(
    readonly config: WorkerConfig,
    private readonly modelRuntime: ModelRuntime,
    private readonly appConfig: AppConfig,
  ) {}

  get name(): string {
    return this.config.name;
  }

  /** 确保工作目录存在（防止 bash 工具回退到 process.cwd()） */
  ensureWorkspace(): void {
    mkdirSync(this.config.cwd, { recursive: true });
    mkdirSync(join(this.config.cwd, ".pi", "skills"), { recursive: true });
  }

  get busy(): boolean {
    return this.running > 0;
  }

  /**
   * 执行单个任务。
   * 注意：本方法返回的 Promise 在任务完成后 resolve；长程任务的「任务已收到」
   * 由团队层在调用本方法后立即下发，无需等待本 Promise。
   * workspaceDir 为任务专属工作空间（会话 cwd），任务之间完全隔离。
   * 返回 Worker 的最终汇报文本与本次任务产生的 LLM 用量/费用。
   */
  async runTask(task: Task, workspaceDir: string): Promise<{ result: string; usage: TaskUsage }> {
    this.running++;
    const started = Date.now();
    try {
      log.info("worker", `[${task.id}] 开始执行（Worker: ${this.name}, 长程: ${task.priority === "long"}）`);
      const { text: result, usage } = await this.execute(task, workspaceDir);
      log.info(
        "worker",
        `[${task.id}] 执行完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，用量 ${formatUsage(usage)}`,
      );
      return { result, usage };
    } finally {
      this.running--;
    }
  }

  private async execute(task: Task, workspaceDir: string): Promise<{ text: string; usage: TaskUsage }> {
    log.info("worker", `[${task.id}] 会话 cwd=${workspaceDir}（Worker 持久目录=${this.config.cwd}）`);
    const loader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      agentDir: this.appConfig.agentDir,
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      systemPromptOverride: () => this.buildSystemPrompt(task, workspaceDir),
      skillsOverride: (base) => ({
        ...base,
        skills: [...base.skills, ...this.loadSkills()],
      }),
    });
    await loader.reload();

    const model = this.modelRuntime.getModel(this.appConfig.modelProvider, this.appConfig.modelId);
    if (!model) {
      throw new Error(`模型 ${this.appConfig.modelProvider}/${this.appConfig.modelId} 未找到`);
    }

    const { session } = await createAgentSession({
      model,
      modelRuntime: this.modelRuntime,
      thinkingLevel: this.appConfig.workerThinkingLevel,
      // 会话 cwd 指向任务专属工作空间：工具（bash/edit/write 等）全部限定在该目录内
      cwd: workspaceDir,
      tools: this.config.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManagerShim.inMemory(),
      settingsManager: SessionManagerShim.inMemorySettings(),
    });

    const chunks: string[] = [];
    const usage = emptyUsage(`${this.appConfig.modelProvider}/${this.appConfig.modelId}`);
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "agent_end") {
        addUsage(usage, usageFromAgentMessages(event.messages));
      } else if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        chunks.push(event.assistantMessageEvent.delta);
      }
    });

    const timeout = setTimeout(() => {
      log.warn("worker", `[${task.id}] 任务超时（${this.appConfig.taskTimeoutMs}ms），中止会话`);
      void session.abort();
    }, this.appConfig.taskTimeoutMs);

    try {
      await session.prompt(
        `${systemTimeBlock()}\n请开始执行任务 ${task.id}「${task.title}」。\n执行指令：\n${task.description}`,
      );
    } catch (e) {
      log.error("worker", `[${task.id}] 执行异常: ${(e as Error).message}`);
      throw new Error((e as Error).message);
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      session.dispose();
    }

    const text = chunks.join("").trim();
    if (!text) {
      throw new Error("Worker 未返回任何结果");
    }
    return { text, usage };
  }

  private buildSystemPrompt(task: Task, workspaceDir: string): string {
    return `你是 Circle 系统中的 Worker「${this.name}」。
${this.config.description}

## 工作环境（任务专属，与其他任务完全隔离）
- 本次会话工作目录：${workspaceDir}
  - 该目录为本任务独有，其他任务看不到也碰不到，不会发生文件冲突；
  - 任务产出物、中间文件均写在这里，无需区分；
  - 任务完成后该目录会被归档为产出物目录（outputs/<taskId>/）持久保留，方便取用。
- 技能：工作目录下的 \`.pi/skills/\` 软链接指向本 Worker 的技能目录
  （${join(this.config.cwd, ".pi", "skills")}），\`.pi/agent-skills/\` 软链接指向用户级技能目录
  （${join(this.appConfig.agentDir, "skills")}）；
  技能文件均可通过上述路径读取，技能中提到的相对路径一律以该技能所在目录为基准
  （即 \`.pi/skills/<技能名>/\` 或 \`.pi/agent-skills/<技能名>/\` 下的相对位置）。

## 路径规则（重要）
1. 所有相对路径一律以工作目录 ${workspaceDir} 为基准解析；
2. 任务指令中出现的其它绝对路径（/home/、/tmp/、项目根目录、其它 Worker 或任务目录等）视为误写，一律忽略，并将相应操作改在本工作目录内执行；
3. 你只能在本工作目录内创建/修改文件。

## 任务
- 任务编号：${task.id}（${task.priority === "long" ? "长程任务" : "短程任务"}）
- 标题：${task.title}

## 时间
- 任务开始时会在指令开头注入当前时刻：（系统时间：YYYY-MM-DD HH:mm，周X）；
- 该时间以服务器本地时区为准（与定时任务 cron 一致）；涉及相对时间/日期计算以此为准。

## 执行要求
1. 仔细理解执行指令，规划步骤后再动手；
2. 使用工具完成任务；涉及文件操作时先查看目录现状，避免误删；
3. 长程任务请耐心等待工具执行完成（如 sleep、下载、批量处理），不要提前结束；
4. 完成后用简洁中文总结：做了什么、产出了哪些文件（路径）、关键结果；
5. **禁止持久副作用（重要）**：你的执行是【一次性】的，任务结束即终止。
   - 禁止创建任何持久定时/驻留机制：crontab、at、systemd timer、nohup 后台进程等
     （如 \`crontab -e\`、\`at now\`、\`systemctl enable\`、\`nohup … &\`）；
   - 禁止修改系统级状态（用户 crontab、系统服务、开机自启等）；
   - 遇到「每 X 分钟 / 每天 / 定时 / 持续运行」等周期性需求：不要自行实现定时器，
     在总结中明确告知 Coordinator 应使用系统的定时任务功能（create_schedule）。`;
  }

  private loadSkills(): Skill[] {
    return (this.config.skills ?? []).map((p) => ({
      name: p.split(/[\\/]/).pop() ?? p,
      description: `技能文件: ${p}`,
      filePath: p,
      baseDir: this.config.cwd,
      sourceInfo: createSyntheticSourceInfo(p, {
        source: "worker-config",
        scope: "project",
        origin: "top-level",
        baseDir: this.config.cwd,
      }),
      disableModelInvocation: false,
    }));
  }
}

