# 架构设计

## 1. 总体架构

Circle 采用「单一入口 + 角色分离」的协作架构。使用者只感知一个 Agent（Coordinator），
系统内部由 Coordinator、Worker、Scheduler 分工协作，通过**确定性代码 + LLM 会话**混合实现：

- **LLM 部分**（需要模型推理的地方）：Coordinator 对话、Worker 任务执行
- **确定性部分**（需要可靠性的地方）：安全评估、任务/定时任务存储、cron 触发、每日清理、IM 路由

```
┌──────────────┐   上行消息     ┌──────────────────────────────┐
│   IM 适配器   │ ────────────► │        AgentTeam             │
│ console/http │               │  ┌────────────────────────┐  │
│ /wechat      │ ◄──────────── │  │  Coordinator (LLM 会话)  │  │
└──────────────┘  下行回复      │  │  自定义工具（TeamGateway）│  │
                               │  └───────────┬────────────┘  │
                               │  dispatch / schedule         │
                               │  ┌───────────▼────────────┐  │
                               │  │ Worker × N (LLM 会话)   │  │
                               │  │  Scheduler (确定性)     │  │
                               │  └───────────┬────────────┘  │
                               │              │               │
                               │  ┌───────────▼────────────┐  │
                               │  │ TaskStore/ScheduleStore │  │
                               │  │ WorkspaceManager/安全   │  │
                               │  └────────────────────────┘  │
                               └──────────────────────────────┘
```

## 2. 角色实现

### 2.1 Coordinator（`src/agents/coordinator.ts`）

- 基于 pi SDK 的 `createAgentSession` 创建**只读会话**：
  - `noTools: "builtin"` —— 不启用任何内置执行工具（read/bash/edit/write 等），
    **从工具层面保证 Coordinator 无法修改/破坏运行环境**；
  - 仅注册 7 个自定义工具，作为与团队交互的唯一通道：

| 工具 | 作用 | 底层 |
| --- | --- | --- |
| `dispatch_task` | 派发执行任务给 Worker | `TeamGateway.dispatch`（含安全复核） |
| `create_schedule` | 创建定时任务 | `Scheduler.create`（cron 校验） |
| `update_schedule` | 修改定时任务 | `Scheduler.update` |
| `delete_schedule` | 删除定时任务 | `Scheduler.delete` |
| `list_tasks` | 查询任务状态 | `TaskStore.summarize` |
| `list_schedules` | 查询定时任务 | `ScheduleStore.summarize` |
| `list_workers` | 查询可用 Worker | Worker 注册表 |

- 系统提示词中固化角色边界与安全规则（拒绝破坏性/敏感请求、长程任务先确认等）；
- **长程任务处理**：`dispatch_task(long=true)` 后工具立即返回
  「任务已收到 + 任务编号」，任务在后台执行；完成时团队注入系统通知，
  Coordinator 整理后主动向用户汇报；
- **每 5 轮对话检查任务状态**：`AgentTeam` 记录对话轮次，每满 5 轮且有
  待办任务时，向 Coordinator 注入状态检查提醒，由其查询并汇报。

### 2.2 Worker（`src/agents/worker.ts`）

- 每个 Worker 一个注册项（名称/职责描述/工作目录/技能），拥有**独立持久工作环境**：
  - 工作目录：`data/workspaces/<workerName>/`，产出物直接输出到此（便于取用）；
  - 技能：工作目录下 `.pi/skills/` 的 SKILL.md 自动发现加载（含内置视觉技能 vision.md），
    也可在配置中指定文件；
  - 临时工作空间：`data/workspaces/<workerName>/.scratch/<taskId>/`（任务级隔离）；
- 每个任务使用**独立 LLM 会话**（上下文干净），但共享该 Worker 的工作环境；
- **多模态**：图片/视觉类任务（命中视觉关键词或带 `【图片】` 标记）自动选用配置的
  视觉模型（`CIRCLE_VISION_MODEL_PROVIDER/ID`），read 工具读图时图片作为附件传给模型；
- 短程任务：执行后直接返回结果；长程任务：团队先下发 ack，执行完成后再反馈；
- 单任务超时保护（默认 30 分钟，可配置）。

### 2.3 Scheduler（`src/agents/scheduler.ts`）

- **确定性实现**（不依赖 LLM）：tick 轮询（默认 30s）+ 轻量 cron 解析器
  （支持 `*`、数字、范围、步长、列表），保证触发可靠；
- 职责：
  1. 接受 Coordinator 转交的定时任务增删改（cron 合法性校验）；
  2. 到期触发：创建 Task → 派发给指定 Worker → 跟进 → 完成后由
     Coordinator 向用户汇报（通知中带 scheduleId）；
  3. **系统定时任务**：每日 cron（默认 `0 3 * * *`）执行全量任务状态检查，
     清理**已完成超过 30 天**的任务记录及其临时工作空间（`.scratch/<taskId>/`），
     持久产出物保留。

## 3. 消息流

### 3.1 短程任务

```
用户 ─► IM ─► AgentTeam.handleUserMessage
      ├─ 安全评估（通过）
      ├─ Coordinator.respond（LLM 调用 dispatch_task）
      │    └─ TeamGateway.dispatch
      │         ├─ 安全复核 → TaskStore 入库 → Worker 执行（同步等待）
      │         └─ 工具返回值（含结果）
      └─ Coordinator 整理结果 → IM → 用户
```

### 3.2 长程任务

```
用户 ─► Coordinator ─► dispatch_task(long=true)
      ├─ 工具立即返回「任务已收到 + 编号」→ Coordinator 回复用户（ack）
      └─ 后台：Worker 执行 → TaskStore 标记 completed
           └─ reportCompletion：注入系统通知 → Coordinator 整理 → 回复用户
```

### 3.3 定时任务

```
用户 ─► Coordinator ─► create_schedule ─► Scheduler（cron 校验 + 计算 nextRunAt）
到达触发时间：Scheduler.fire ─► 创建 Task ─► Worker 执行 ─► 完成
      └─ reportCompletion（带 scheduleId）→ Coordinator → 用户
```

### 3.4 安全拦截

```
用户请求（破坏性/敏感）
      ├─ 入口安全评估命中 → 直接返回拒绝文案，不经过 LLM、不派发
      └─（若 LLM 误判仍尝试派发）→ dispatch 入口二次安全复核 → 拒绝
```

### 3.5 图片消息（多模态）

```
用户发图 ─► IM 适配器提取附件（ChatMessage.attachments）
      ─► AgentTeam：落盘到 {dataDir}/uploads/，并以「【图片】<路径>」富化消息文本
      ─► Coordinator：识别图片标记 → 派发视觉任务给 Worker
      ─► Worker：read 工具读图（视觉模型下图片作为附件传给模型）→ 描述/OCR
      ─► Coordinator 整理结果 → 用户
```

- 纯图片（无文字）消息不再返回 `[收到图片消息]` 占位文本，而是真正进入视觉链路；
- 未配置视觉模型时，Worker 明确告知“不支持看图”，并尽力提供元信息/OCR 结果。

## 4. 关键模块

| 模块 | 文件 | 说明 |
| --- | --- | --- |
| 配置 | `src/config.ts` | 环境变量驱动（见 usage.md） |
| 安全评估 | `src/core/safety.ts` | 破坏性/敏感信息正则规则 + 否定语境处理；确定性、不可绕过 |
| cron | `src/core/cron.ts` | 5 段 cron 解析、nextRun、matches |
| 任务存储 | `src/core/task-store.ts` | JSON 持久化、状态机、30 天清理 |
| 定时任务存储 | `src/core/schedule-store.ts` | JSON 持久化、触发历史 |
| 工作空间 | `src/core/workspace.ts` | Worker 目录/任务临时空间/过期清理 |
| 附件落盘 | `src/core/upload.ts` | `AttachmentStore`（附件 → uploads）+ 消息富化 |
| 视觉技能 | `src/skills/vision.md` | 内置图片/OCR 技能，安装到各 Worker `.pi/skills/` |
| IM 适配器 | `src/im/*` | 统一接口，console/http/weixin(官方)/wechat(wechaty) 四实现 |
| 团队 | `src/team/agent-team.ts` | 组合三角色、消息路由、附件落盘、轮次状态检查、结果汇报 |

## 5. 数据模型

```
Task: id / title / description / status(received→dispatched→running→completed|failed|rejected)
      / priority(short|long) / workerName / requestedBy(user|scheduler) / scheduleId?
      / requestChatId / createdAt / startedAt / completedAt / result / error

ScheduledTask: id / name / cron(5段) / description / workerName / enabled
               / createdAt / lastRunAt / nextRunAt / taskIds[]

ChatMessage: chatId / text / attachments?: ChatAttachment[]
ChatAttachment: kind(image|file) / name? / mimeType? / data?(base64) / localPath?
```

## 6. 安全边界（实现层面）

1. **Coordinator 无执行工具**：`noTools: "builtin"`，物理上无法执行命令或改文件；
2. **双重安全评估**：`handleUserMessage` 入口（确定性）+ `dispatch` 派发入口（复核）；
3. **Worker 隔离**：每个 Worker 独立 cwd，任务级 scratch 隔离；产出物互不可见；
4. **敏感信息不落地**：拦截发生在派发之前，Worker 永远不会收到敏感类指令；
5. **超时与清理**：任务超时中止会话；30 天自动清理防止存储与临时文件膨胀。
