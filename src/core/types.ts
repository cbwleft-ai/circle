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
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  /** 最终结果摘要 */
  result?: string;
  /** 错误信息 */
  error?: string;
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
}

/** 对话消息（IM 层与团队层之间的统一结构） */
export interface ChatMessage {
  chatId: string;
  text: string;
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
