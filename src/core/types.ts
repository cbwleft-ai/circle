/**
 * Circle 核心共享类型定义
 */

/** 任务生命周期状态 */
export type TaskStatus =
  | "received" // 已收到（长程任务 ack 后）
  | "dispatched" // 已派发
  | "running" // 执行中
  | "completed" // 已完成
  | "failed" // 失败
  | "rejected"; // 被安全评估拦截

/** 任务类型：短程（<=10s 预期） / 长程（>10s 预期） */
export type TaskPriority = "short" | "long";

/** LLM 调用用量与费用（token 与美元计价，来自 pi AgentSession 的 usage 上报） */
export interface TaskUsage {
  /** 模型标识，如 deepseek/deepseek-v4-flash */
  model: string;
  /** LLM 调用次数 */
  calls: number;
  /** 输入 token */
  input: number;
  /** 输出 token */
  output: number;
  /** 缓存命中读取 token */
  cacheRead: number;
  /** 缓存写入 token */
  cacheWrite: number;
  /** 推理 token（属于 output 的子集，提供方不支持时为 0） */
  reasoning: number;
  /** token 总量（input+output+cacheRead+cacheWrite） */
  totalTokens: number;
  /** 总费用（美元） */
  cost: number;
}

export interface Task {
  /** 任务编号，如 T-20250813-0001 */
  id: string;
  /** 任务标题（一句话） */
  title: string;
  /** 给 Worker 的执行指令 */
  description: string;
  /** 状态 */
  status: TaskStatus;
  /** 长程 / 短程 */
  priority: TaskPriority;
  /** 负责执行的 Worker 名称 */
  workerName: string;
  /** 任务来源 */
  requestedBy: "user" | "scheduler";
  /** 若由定时任务触发，记录 schedule id */
  scheduleId?: string;
  /** 发起对话的 chatId（用于异步结果汇报） */
  requestChatId?: string;
  /** 用户附带的图片/文件（落盘路径），Worker 执行时作为图片输入传给模型（issue #3） */
  attachments?: TaskAttachment[];
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** 最终结果摘要 */
  result?: string;
  /** 错误信息 */
  error?: string;
  /** Worker 执行该任务产生的 LLM 用量与费用（无记录时为 undefined） */
  usage?: TaskUsage;
}

/** 定时任务 */
export interface ScheduledTask {
  id: string;
  /** 名称（用户可读） */
  name: string;
  /** 5 段 cron 表达式 */
  cron: string;
  /** 触发的执行指令（派发给 Worker） */
  description: string;
  /** 执行该任务的 Worker 名称 */
  workerName: string;
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number;
  nextRunAt?: number;
  /** 历史触发的任务 id */
  taskIds: string[];
}

/** Worker 配置（使用者可为 Worker 设置初始工作环境） */
export interface WorkerConfig {
  /** Worker 名称（唯一） */
  name: string;
  /** 角色描述，供 Coordinator 理解该 Worker 的职责 */
  description: string;
  /** 工作目录（工作环境根目录，产出物输出于此） */
  cwd: string;
  /** 启用的内置工具 */
  tools?: string[];
  /** 技能（SKILL.md 文件路径列表，可选） */
  skills?: string[];
  /** 该 Worker 专用的模型 provider（可选，覆盖全局 worker 模型配置） */
  modelProvider?: string;
  /** 该 Worker 专用的模型 id（可选，覆盖全局 worker 模型配置） */
  modelId?: string;
}

/** 对话消息（IM 层与团队层之间的统一结构） */
export interface ChatMessage {
  chatId: string;
  text: string;
  /** 附带附件（图片/文件），base64 内容或本地路径，由 IM 适配器提供（issue #3） */
  attachments?: ChatAttachment[];
}

/**
 * 上行附件（IM 适配器 → 团队层）。
 * - `data`: base64 内容（适配器已下载/转码）；
 * - `localPath`: 已落盘的本地文件（二选一，优先 localPath）。
 */
export interface ChatAttachment {
  kind: "image" | "file";
  /** 文件名（含扩展名，可选） */
  name?: string;
  mimeType?: string;
  /** base64 内容 */
  data?: string;
  /** 已落盘文件的本地路径 */
  localPath?: string;
}

/** 任务附带的图片/文件（团队层落盘后写入任务，Worker 执行时读取） */
export interface TaskAttachment {
  /** 落盘后的绝对路径 */
  path: string;
  mimeType?: string;
}

/** 下行文件消息载荷（附件） */
export interface OutboundFile {
  /** 文件名（含扩展名） */
  fileName: string;
  /** 文件内容（原始字节） */
  content: Buffer;
  /** MIME 类型（按扩展名推断，可选） */
  mimeType?: string;
  /** 文件字节数 */
  size: number;
  /** 随附文字说明（可选） */
  caption?: string;
  /** 来源产出物绝对路径（供不支持文件发送的通道降级提示） */
  sourcePath?: string;
}

/** 产出物发送结果 */
export interface SendArtifactResult {
  ok: boolean;
  message: string;
}

/** 安全评估结论 */
export interface SafetyVerdict {
  /**
   * none: 安全;
   * warning: 提及敏感字段但为「配置结构/格式/字段」调研上下文，放行但提示（禁止读取真实值）;
   * sensitive: 涉及敏感信息（读取/返回真实私密值）;
   * destructive: 破坏性操作。
   */
  risk: "none" | "warning" | "sensitive" | "destructive";
  /** 判定原因（供用户查看） */
  reasons: string[];
}

/** 派发结果 */
export type DispatchResult =
  | {
      ok: true;
      task: Task;
      /** true 表示长程任务已 ack，结果稍后异步送达 */
      async: boolean;
      message: string;
    }
  | {
      ok: false;
      reasons: string[];
      message: string;
    };
