/**
 * TeamGateway —— Coordinator 自定义工具与 AgentTeam 之间的接口。
 * Coordinator 只能通过该接口与团队交互，不接触任何执行细节。
 */
import type { DispatchResult, ScheduledTask, SendArtifactResult, WorkerConfig } from "../core/types.js";

export interface TeamGateway {
  /** 可用 Worker 列表 */
  listWorkers(): WorkerConfig[];

  /**
   * 派发任务给 Worker（chatId 由框架注入，标记任务归属会话）。
   * 内部会再次执行安全评估；高风险请求在此被拒绝，不会进入执行链路。
   */
  dispatch(chatId: string, worker: string, title: string, description: string, long: boolean): Promise<DispatchResult>;

  createSchedule(
    chatId: string,
    name: string,
    timing: { cron?: string; at?: string },
    description: string,
    worker: string,
  ): ScheduledTask;
  /** 修改定时任务（仅限所属会话） */
  updateSchedule(chatId: string, id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined;
  /** 删除定时任务（仅限所属会话） */
  deleteSchedule(chatId: string, id: string): ScheduledTask | undefined;

  /** 任务列表摘要（仅当前会话） */
  listTasks(chatId: string, status?: string): string;
  /** 定时任务摘要（仅当前会话） */
  listSchedules(chatId: string): string;

  /** 列出任务产出物清单（相对路径 + 大小），用于 Coordinator 直接核对 Worker 实际产物 */
  listArtifacts(chatId: string, taskId: string): string;
  /** 读取任务产出物目录内单个文件内容（只读、受限），用于 Coordinator 直接核对完整报告/数据 */
  readArtifact(chatId: string, taskId: string, relPath: string): string;
  /** 读取任务完整执行结果（未截断的原始结果），无结果时返回 undefined */
  getTaskResult(chatId: string, taskId: string): string | undefined;

  /**
   * 把指定任务的产出物文件通过 IM 发送给用户（附件形式，issue #24）。
   * 仅限任务产出物目录内文件（只读 + 路径受限 + 大小上限）；
   * 通道不支持文件时自动降级为文本提示，不阻塞。
   */
  sendArtifact(chatId: string, taskId: string, relPath: string, caption?: string): Promise<SendArtifactResult>;
}
