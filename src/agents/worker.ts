/**
 * Worker Agent —— 具体执行任务的角色。
 *
 * 特性：
 * - 每个 Worker 拥有独立持久工作环境（cwd），技能与产出物均存放于此，Worker 之间互不影响；
 * - 每个任务使用独立会话（独立上下文），但共享该 Worker 的工作环境；
 * - 短程任务：执行后直接返回结果；
 * - 长程任务：先返回「任务已收到」（由团队层立即 ack），执行完成后再反馈结果；
 * - 任务若产出文件，直接输出到工作环境，便于取用。
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
import { supportsVision, VISION_TASK_PATTERNS, type AppConfig } from "../config.js";
import { log } from "../core/logger.js";
import type { Task, WorkerConfig } from "../core/types.js";

/** 内置视觉技能文件（安装到每个 Worker 工作目录 .pi/skills/ 下） */
const VISION_SKILL_SRC = fileURLToPath(new URL("../skills/vision.md", import.meta.url));

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
    const skillsDir = join(this.config.cwd, ".pi", "skills");
    mkdirSync(skillsDir, { recursive: true });
    // 安装内置视觉技能（若不存在），使 Worker 具备图片/OCR 能力指引
    try {
      const target = join(skillsDir, "vision.md");
      if (!existsSync(target) && existsSync(VISION_SKILL_SRC)) {
        copyFileSync(VISION_SKILL_SRC, target);
      }
    } catch (e) {
      log.warn("worker", `安装视觉技能失败: ${(e as Error).message}`);
    }
  }

  get busy(): boolean {
    return this.running > 0;
  }

  /**
   * 执行单个任务。
   * 注意：本方法返回的 Promise 在任务完成后 resolve；长程任务的「任务已收到」
   * 由团队层在调用本方法后立即下发，无需等待本 Promise。
   */
  async runTask(task: Task, scratchDir: string): Promise<string> {
    this.running++;
    const started = Date.now();
    try {
      log.info("worker", `[${task.id}] 开始执行（Worker: ${this.name}, 长程: ${task.priority === "long"}）`);
      const result = await this.execute(task, scratchDir);
      log.info(
        "worker",
        `[${task.id}] 执行完成，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s`,
      );
      return result;
    } finally {
      this.running--;
    }
  }

  private async execute(task: Task, scratchDir: string): Promise<string> {
    log.info("worker", `[${task.id}] 会话 cwd=${this.config.cwd}（进程 cwd=${process.cwd()}）`);
    const loader = new DefaultResourceLoader({
      cwd: this.config.cwd,
      agentDir: this.appConfig.agentDir,
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      systemPromptOverride: () => this.buildSystemPrompt(task, scratchDir),
      skillsOverride: (base) => ({
        ...base,
        skills: [...base.skills, ...this.loadSkills()],
      }),
    });
    await loader.reload();

    const model = this.resolveModel(task);
    if (!model) {
      throw new Error(`模型 ${this.appConfig.modelProvider}/${this.appConfig.modelId} 未找到`);
    }

    const { session } = await createAgentSession({
      model,
      modelRuntime: this.modelRuntime,
      thinkingLevel: this.appConfig.workerThinkingLevel,
      cwd: this.config.cwd,
      tools: this.config.tools ?? ["read", "bash", "edit", "write", "grep", "find", "ls"],
      resourceLoader: loader,
      sessionManager: SessionManagerShim.inMemory(),
      settingsManager: SessionManagerShim.inMemorySettings(),
    });

    const chunks: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        chunks.push(event.assistantMessageEvent.delta);
      }
    });

    const timeout = setTimeout(() => {
      log.warn("worker", `[${task.id}] 任务超时（${this.appConfig.taskTimeoutMs}ms），中止会话`);
      void session.abort();
    }, this.appConfig.taskTimeoutMs);

    try {
      await session.prompt(
        `请开始执行任务 ${task.id}「${task.title}」。\n执行指令：\n${task.description}`,
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
    return text;
  }

  /**
   * 解析本次任务使用的模型：
   * - 若任务为图片/视觉类（命中 VISION_TASK_PATTERNS）且配置了不同的视觉模型，则使用视觉模型；
   * - 否则回退到默认模型。
   */
  resolveModel(task: Task) {
    const visionTask = WorkerAgent.isVisionTask(task);
    const visionConfigured =
      this.appConfig.visionModelProvider !== this.appConfig.modelProvider ||
      this.appConfig.visionModelId !== this.appConfig.modelId;
    if (visionTask && visionConfigured) {
      const vm = this.modelRuntime.getModel(
        this.appConfig.visionModelProvider,
        this.appConfig.visionModelId,
      );
      if (vm) {
        log.info(
          "worker",
          `[${task.id}] 视觉任务，使用视觉模型 ${this.appConfig.visionModelProvider}/${this.appConfig.visionModelId}（支持图片=${supportsVision(vm)}）`,
        );
        return vm;
      }
      log.warn(
        "worker",
        `[${task.id}] 视觉模型 ${this.appConfig.visionModelProvider}/${this.appConfig.visionModelId} 未找到，回退默认模型`,
      );
    }
    return this.modelRuntime.getModel(this.appConfig.modelProvider, this.appConfig.modelId);
  }

  /**
   * 判断任务是否为图片/视觉类（供测试直接断言）。
   */
  static isVisionTask(task: Pick<Task, "title" | "description">): boolean {
    return VISION_TASK_PATTERNS.some((re) => re.test(`${task.title}\n${task.description}`));
  }

  private buildSystemPrompt(task: Task, scratchDir: string): string {
    return `你是 Circle 系统中的 Worker「${this.name}」。
${this.config.description}

## 工作环境
- 工作目录：${this.config.cwd}
  - 任务产出物请直接输出到此目录（便于使用者取用）；
  - 该目录下可能已有其它任务的产出物，注意不要覆盖无关文件。
- 临时工作空间：${scratchDir}
  - 执行过程中的临时/中间文件放在这里；
  - 不要在此目录之外创建临时目录。

## 路径规则（重要）
1. 所有相对路径一律以工作目录 ${this.config.cwd} 为基准解析；
2. 任务指令中出现的其它绝对路径（/home/、/tmp/、项目根目录等）视为误写，一律忽略，并将相应操作改在本工作目录内执行；
3. 你只能在工作目录与临时工作空间内创建/修改文件。

## 任务
- 任务编号：${task.id}（${task.priority === "long" ? "长程任务" : "短程任务"}）
- 标题：${task.title}

## 图片 / 视觉任务（多模态）
- 任务指令中带 \`【图片】<路径>\` 标记的文件，表示用户发来的图片，请用 read 工具读取并描述内容 / 识别文字（OCR），详见你的视觉技能（vision.md）；
- 若你的模型支持图片输入，read 图片时图片会作为附件直接传给你，请基于图片内容回答；
- 若模型不支持视觉，按技能说明改用 OCR 或明确告知用户无法看图，不要编造图片内容。

## 执行要求
1. 仔细理解执行指令，规划步骤后再动手；
2. 使用工具完成任务；涉及文件操作时先查看目录现状，避免误删；
3. 长程任务请耐心等待工具执行完成（如 sleep、下载、批量处理），不要提前结束；
4. 完成后用简洁中文总结：做了什么、产出了哪些文件（路径）、关键结果。`;
  }

  private loadSkills(): Skill[] {
    const skills: Skill[] = [];
    const add = (p: string) => {
      const name = p.split(/[\\/]/).pop()?.replace(/\.md$/i, "") ?? p;
      skills.push({
        name,
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
      });
    };
    // 1) 配置中显式指定的技能
    for (const p of this.config.skills ?? []) add(p);
    // 2) 工作目录 .pi/skills/ 下自动发现（含内置视觉技能）
    try {
      const skillsDir = join(this.config.cwd, ".pi", "skills");
      if (existsSync(skillsDir)) {
        for (const f of readdirSync(skillsDir).filter((x) => x.endsWith(".md"))) {
          const p = join(skillsDir, f);
          if (!(this.config.skills ?? []).includes(p)) add(p);
        }
      }
    } catch {
      /* ignore */
    }
    return skills;
  }
}

