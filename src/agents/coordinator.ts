/**
 * Coordinator Agent —— 与使用者对话的唯一入口。
 *
 * 职责：
 * 1. 响应使用者对话（双向沟通），不负责具体执行；
 * 2. 通过自定义工具向 Worker / Scheduler 下达命令；
 * 3. 接收 Worker / Scheduler 反馈并向使用者汇报；
 * 4. 长程任务：先回复「任务已收到」并记录待办，之后每 5 轮对话检查一次任务状态。
 *
 * 安全边界：
 * - 不启用任何内置执行工具（read/bash/edit/write 等均不可用），物理上无法修改环境；
 * - 所有派发/调度工具在执行前都会再次经过确定性安全评估；
 * - 破坏性与敏感信息请求在团队入口处即被拦截。
 */
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
  type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AppConfig } from "../config.js";
import { log } from "../core/logger.js";
import type { TeamGateway } from "../team/gateway.js";

export class CoordinatorAgent {
  session?: AgentSession;
  private readonly gateway: TeamGateway;

  constructor(
    private readonly modelRuntime: ModelRuntime,
    private readonly config: AppConfig,
    gateway: TeamGateway,
  ) {
    this.gateway = gateway;
  }

  async start(): Promise<void> {
    const loader = new DefaultResourceLoader({
      cwd: process.cwd(),
      agentDir: this.config.agentDir,
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      systemPromptOverride: () => this.buildSystemPrompt(),
    });
    await loader.reload();

    const model = this.modelRuntime.getModel(this.config.modelProvider, this.config.modelId);
    if (!model) {
      throw new Error(
        `模型 ${this.config.modelProvider}/${this.config.modelId} 未找到，请检查 models.json 或环境配置`,
      );
    }

    const { session } = await createAgentSession({
      model,
      modelRuntime: this.modelRuntime,
      thinkingLevel: this.config.coordinatorThinkingLevel,
      // 关键安全设计：不启用任何内置执行工具，仅保留自定义工具
      noTools: "builtin",
      customTools: this.buildTools(),
      resourceLoader: loader,
      sessionManager: SessionManagerShim.inMemory(),
      settingsManager: SessionManagerShim.inMemorySettings(),
    });
    this.session = session;
    log.info("coordinator", `Coordinator 就绪（模型 ${model.id}）`);
  }

  /** 系统提示词：角色定义 + 安全边界 + 协作规则 */
  private buildSystemPrompt(): string {
    const workers = this.gateway
      .listWorkers()
      .map((w) => `- ${w.name}: ${w.description}`)
      .join("\n");
    return `你是 Circle 系统中的 Coordinator，是使用者唯一对话的 Agent。
你只负责沟通与协调，绝不亲自执行具体任务；执行一律派发给 Worker 或 Scheduler。

## 你的职责
1. 响应用户对话，理解需求；
2. 需要执行的任务 → 调用 dispatch_task 派发给合适的 Worker；
   - 预计运行超过 10 秒（长程任务，如 sleep/等待/下载/爬取/批量/编译/渲染）→ 设置 long=true，并立即回复「任务已收到」，告知用户任务编号，说明完成后会主动汇报；
   - 短程任务 → 直接派发并把结果汇报给用户；
3. 定时任务（周期性任务）→ 调用 create_schedule / update_schedule / delete_schedule 管理，把自然语言时间换算成 5 段 cron（如"每天上午 10 点"→"0 10 * * *"）；
4. 用户询问任务/定时任务状态 → 调用 list_tasks / list_schedules / list_workers 查询并汇报；
5. 收到系统通知（Worker 完成长程任务、定时任务触发结果）→ 整理后向用户汇报最终结果。

## 可用 Worker
${workers || "- （暂无 Worker）"}

## 派发任务时的路径规则（重要）
1. 派发任务时**不要编造或写入任何具体文件路径**（尤其不要写项目根目录、绝对路径、~ 等）；
2. Worker 会在自己的独立工作目录中执行，相对路径由 Worker 在其工作目录内自行解析；
3. 任务指令只描述「做什么」与「产出什么」，不指定「在哪做」。

## 安全边界（必须严格遵守）
1. 拒绝破坏性操作：删除目录/文件、rm -rf、格式化、清空数据库、关机重启、强推覆盖等 → 直接拒绝，说明原因，绝不派发；
2. 拒绝敏感信息：读取/返回 API Key、密码、私钥、.env、SSH 凭据等真实值 → 直接拒绝，绝不派发；
3. 配置结构/格式/字段调研类任务（如"查询 token 字段的格式""梳理配置项说明"）属于合法任务，应正常派发；但只允许处理结构、格式、字段名与示例，禁止读取或返回任何真实私密值；
4. 你不具备任何文件/命令执行能力，请勿假装执行。

## 沟通风格
- 简洁、结构化，使用中文；
- 长程任务先确认收到，再跟进；
- 结果汇报包含任务编号、产出物位置、关键结果。`;
  }

  /** 自定义工具：Coordinator 与团队交互的唯一通道 */
  private buildTools() {
    const g = this.gateway;
    return [
      defineTool({
        name: "dispatch_task",
        label: "派发任务",
        description:
          "将具体执行任务派发给指定 Worker。长程任务（预计 >10 秒）请设置 long=true。执行结果由系统在完成后异步通知。",
        promptSnippet: "派发执行任务给 Worker",
        parameters: Type.Object({
          worker: Type.String({ description: "Worker 名称" }),
          title: Type.String({ description: "任务标题（一句话）" }),
          description: Type.String({ description: "给 Worker 的详细执行指令" }),
          long: Type.Optional(Type.Boolean({ description: "是否为长程任务（预计超过 10 秒）" })),
        }),
        execute: async (_id, params) => {
          const res = await g.dispatch(
            params.worker,
            params.title,
            params.description,
            params.long ?? false,
          );
          return {
            content: [{ type: "text", text: res.message }],
            details: {},
          };
        },
      }),
      defineTool({
        name: "create_schedule",
        label: "创建定时任务",
        description: "创建周期性定时任务。cron 为 5 段表达式（分 时 日 月 周）。",
        parameters: Type.Object({
          name: Type.String({ description: "定时任务名称" }),
          cron: Type.String({ description: "5 段 cron 表达式，如 0 10 * * *" }),
          description: Type.String({ description: "触发时派发给 Worker 的执行指令" }),
          worker: Type.String({ description: "执行该任务的 Worker 名称" }),
        }),
        execute: async (_id, params) => {
          try {
            const s = g.createSchedule(params.name, params.cron, params.description, params.worker);
            return {
              content: [
                {
                  type: "text",
                  text: `定时任务创建成功：${s.id}「${s.name}」，cron "${s.cron}"，Worker: ${s.workerName}。`,
                },
              ],
              details: {},
            };
          } catch (e) {
            return {
              content: [{ type: "text", text: `创建失败：${(e as Error).message}` }],
              details: {},
            };
          }
        },
      }),
      defineTool({
        name: "update_schedule",
        label: "修改定时任务",
        description: "修改定时任务的名称/cron/描述/Worker/启停。",
        parameters: Type.Object({
          id: Type.String({ description: "定时任务 id" }),
          name: Type.Optional(Type.String()),
          cron: Type.Optional(Type.String()),
          description: Type.Optional(Type.String()),
          worker: Type.Optional(Type.String()),
          enabled: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id, params) => {
          try {
            const s = g.updateSchedule(params.id, params);
            if (!s) return { content: [{ type: "text", text: `未找到定时任务 ${params.id}` }], details: {} };
            return {
              content: [{ type: "text", text: `定时任务 ${s.id} 已更新。` }],
              details: {},
            };
          } catch (e) {
            return {
              content: [{ type: "text", text: `更新失败：${(e as Error).message}` }],
              details: {},
            };
          }
        },
      }),
      defineTool({
        name: "delete_schedule",
        label: "删除定时任务",
        description: "删除一个定时任务。",
        parameters: Type.Object({
          id: Type.String({ description: "定时任务 id" }),
        }),
        execute: async (_id, params) => {
          const ok = g.deleteSchedule(params.id);
          return {
            content: [
              {
                type: "text",
                text: ok ? `定时任务 ${params.id} 已删除。` : `未找到定时任务 ${params.id}。`,
              },
            ],
            details: {},
          };
        },
      }),
      defineTool({
        name: "list_tasks",
        label: "查询任务列表",
        description: "查询任务列表及状态，可按状态过滤（received/dispatched/running/completed/failed）。",
        parameters: Type.Object({
          status: Type.Optional(
            Type.String({ description: "可选状态过滤：received/dispatched/running/completed/failed" }),
          ),
        }),
        execute: async (_id, params) => {
          const text = g.listTasks(params.status as never);
          return { content: [{ type: "text", text }], details: {} };
        },
      }),
      defineTool({
        name: "list_schedules",
        label: "查询定时任务",
        description: "查询全部定时任务。",
        parameters: Type.Object({}),
        execute: async () => {
          const text = g.listSchedules();
          return { content: [{ type: "text", text }], details: {} };
        },
      }),
      defineTool({
        name: "list_workers",
        label: "查询 Worker",
        description: "查询可用 Worker 及其职责。",
        parameters: Type.Object({}),
        execute: async () => {
          const text = g
            .listWorkers()
            .map((w) => `- ${w.name}: ${w.description}`)
            .join("\n");
          return { content: [{ type: "text", text: text || "暂无 Worker" }], details: {} };
        },
      }),
    ];
  }

  /** 让 Coordinator 处理一轮输入，返回其完整文本回复 */
  async respond(input: string): Promise<string> {
    const session = this.requireSession();
    const chunks: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        chunks.push(event.assistantMessageEvent.delta);
      }
    });
    try {
      await session.prompt(input);
    } catch (e) {
      const err = (e as Error).message;
      log.warn("coordinator", `本轮回复异常: ${err}`);
      unsubscribe();
      return `（Coordinator 处理异常：${err}）`;
    }
    unsubscribe();
    return chunks.join("").trim();
  }

  private requireSession(): AgentSession {
    if (!this.session) throw new Error("Coordinator 尚未启动");
    return this.session;
  }

  async dispose(): Promise<void> {
    this.session?.dispose();
  }
}

const SessionManagerShim = {
  inMemory: () => SessionManager.inMemory(),
  inMemorySettings: () => SettingsManager.inMemory({ compaction: { enabled: false } }),
};
