# 二次开发说明

本文面向需要在 Circle 基础上进行二次开发的开发者，介绍代码结构、
扩展点与常见开发任务。

## 1. 代码结构

```
src/
├── index.ts               # 入口：装配 AgentTeam + 选择 IM 适配器
├── config.ts              # 配置加载（环境变量）、长程任务启发式、默认 Worker
├── core/
│   ├── types.ts           # 共享类型（Task / ScheduledTask / WorkerConfig / SafetyVerdict…）
│   ├── logger.ts          # 分级日志 + 内存缓冲（供测试断言）
│   ├── cron.ts            # 5 段 cron 解析：parseCron / nextRun / matches
│   ├── safety.ts          # 安全评估（确定性规则）与拒绝文案
│   ├── task-store.ts      # 任务存储（JSON 持久化 + 状态机 + 清理）
│   ├── schedule-store.ts  # 定时任务存储
│   └── workspace.ts       # Worker 工作空间与任务临时空间管理
├── agents/
│   ├── coordinator.ts     # Coordinator LLM 会话 + 自定义工具 + 系统提示词
│   ├── worker.ts          # Worker LLM 会话（按任务创建）+ 技能加载
│   └── scheduler.ts       # Scheduler 确定性定时触发 + 每日清理
├── team/
│   ├── gateway.ts         # TeamGateway 接口（Coordinator 工具的边界）
│   └── agent-team.ts      # AgentTeam：组合角色、消息路由、安全拦截、结果汇报
└── im/
    ├── adapter.ts         # ImAdapter 接口
    ├── console.ts         # 控制台适配器
    ├── http.ts            # HTTP 适配器
    ├── weixin-ilink.ts    # 微信官方 iLink 通道适配器（推荐）
    ├── wechat.ts          # 微信 wechaty 适配器（旧方案，不推荐）
    └── test.ts            # 测试内存适配器
```

## 2. 核心扩展点

### 2.1 新增 Coordinator 工具

在 `src/agents/coordinator.ts` 的 `buildTools()` 中追加 `defineTool`，
工具内部只能通过 `TeamGateway` 与团队交互：

```typescript
defineTool({
  name: "my_tool",
  label: "我的工具",
  description: "做什么",
  parameters: Type.Object({ input: Type.String() }),
  execute: async (_id, params) => {
    const res = await this.gateway.someMethod(params.input); // 先在 TeamGateway 中声明
    return { content: [{ type: "text", text: res }], details: {} };
  },
}),
```

同时在 `src/team/gateway.ts` 声明方法、在 `AgentTeam` 中实现。
注意：Coordinator 工具**禁止**执行文件/命令操作（安全边界）。

### 2.2 新增/扩展 Worker 能力

- **新增技能**：将 SKILL.md 放入 Worker 工作目录 `.pi/skills/`（自动发现），
  或在 Worker 配置 `skills` 字段指定文件路径（`src/agents/worker.ts` 的 `loadSkills`）；
- **调整工具集**：Worker 配置 `tools` 字段（默认 `read, bash, edit, write, grep, find, ls`）；
- **任务上下文**：每个任务独立 LLM 会话，系统提示词由 `buildSystemPrompt(task, workspaceDir)` 生成；
  会话 `cwd` 指向任务专属工作空间 `tasks/<taskId>/`（`src/core/workspace.ts` 的 `taskWorkspaceDir`）。

### 2.3 新增 IM 通道

实现 `src/im/adapter.ts` 的 `ImAdapter` 接口，并在 `src/index.ts` 的
`createAdapter` 中注册：

```typescript
export interface ImAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(chatId: string, text: string): Promise<void>;   // 下行
  onMessage(cb: (msg: ChatMessage) => void): void;      // 上行
}
```

团队层不感知具体 IM，`AgentTeam` 通过构造时注入的 `outbox` 下发消息。

### 2.4 调整安全规则

编辑 `src/core/safety.ts` 的 `DESTRUCTIVE_PATTERNS` / `SENSITIVE_PATTERNS`
（正则 + 原因文案）。规则变更请同步补充 `test/unit.test.ts` 中的用例。

### 2.5 调整调度/清理策略

- tick 间隔：`CIRCLE_SCHEDULER_TICK_MS`；
- 清理周期与保留天数：`CIRCLE_CLEANUP_CRON` / `CIRCLE_CLEANUP_AFTER_DAYS`；
- 触发逻辑：`src/agents/scheduler.ts` 的 `tick()` / `fire()`；
- 清理逻辑：`AgentTeam.runDailyCleanup()`（任务记录 + 任务工作空间，产出物目录保留）。

### 2.6 更换/新增模型

模型通过 pi 的 provider 机制注册（`CIRCLE_AGENT_DIR/models.json` 或扩展注册）。
本项目默认 DeepSeek V4 Flash（OpenAI 兼容），更换模型只需调整环境变量
`CIRCLE_MODEL_PROVIDER` / `CIRCLE_MODEL_ID`（该模型需支持函数调用）。

## 3. 关键设计约定

| 约定 | 原因 |
| --- | --- |
| Coordinator 会话 `noTools: "builtin"` | 从工具层保证 Coordinator 无法执行破坏性操作 |
| 安全评估为确定性代码 | 不依赖 LLM，保证不可绕过 |
| 派发入口二次安全复核 | 兜底 LLM 误判 |
| Scheduler 为确定性实现 | 定时触发必须可靠，不引入 LLM 延迟/不确定性 |
| 每个任务独立 Worker 会话 | 上下文干净、可并发、互不影响 |
| 短程任务不触发独立结果通知 | 避免 Coordinator 会话递归（工具返回值已含结果） |
| 长程任务先 ack 后异步执行 | 用户无需等待，完成后主动汇报 |

## 4. 常见二次开发任务

### 4.1 想给任务增加更多状态

1. `src/core/types.ts` 扩展 `TaskStatus`；
2. `src/core/task-store.ts` 增加对应状态流转方法；
3. Coordinator 系统提示词/工具描述补充说明。

### 4.2 想支持多会话（多个用户互不干扰）

当前为单会话设计（所有对话共享 Coordinator 上下文）。
如需多会话：为每个 chatId 建立独立 `CoordinatorAgent` 实例并放入映射，
`AgentTeam.handleUserMessage` 按 `msg.chatId` 路由（参考 `worker.ts` 的按任务建会话模式）。

### 4.3 想持久化会话历史

`CoordinatorAgent.start()` / `WorkerAgent.execute()` 使用
`SessionManager.inMemory()`。改为 `SessionManager.create(cwd)` 即可落盘会话，
也可用 `SessionManager.continueRecent(cwd)` 恢复最近会话。

### 4.4 想接入其他 LLM 提供商

在 pi 中注册 provider（详见 pi 文档 custom-provider.md），例如 OpenAI 兼容：

```typescript
// 作为扩展注册
pi.registerProvider("my-llm", {
  baseUrl: "https://api.example.com/v1",
  apiKey: "$MY_API_KEY",
  api: "openai-completions",
  models: [{ id: "my-model", name: "My Model", reasoning: false, input: ["text"],
             cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
             contextWindow: 128000, maxTokens: 8192 }],
});
```

然后设置 `CIRCLE_MODEL_PROVIDER=my-llm` / `CIRCLE_MODEL_ID=my-model`。

## 5. 测试开发

- 单元测试：`test/unit.test.ts`（确定性，无 API key 也可运行）；
- 端到端用例：`test/case1-long-task.test.ts`（长程/短程任务）、
  `test/case2-scheduled-task.test.ts`（定时任务）、
  `test/case3-safety-intercept.test.ts`（安全拦截）；
- 测试基础设施：`test/helpers.ts`（runCase / createTestTeam / poll / renderReport）；
- 新增用例后运行 `npm test` 自动刷新 `test/TEST_REPORT.md`；
- 无 API key 环境：`CIRCLE_LLM_TESTS=0 npm test` 仅跑确定性用例。

## 6. 构建与发布

```bash
npm run build        # tsc 编译到 dist/
node dist/src/index.js   # 以编译产物运行
npm test             # 运行测试（建议发布前全量通过）
```
