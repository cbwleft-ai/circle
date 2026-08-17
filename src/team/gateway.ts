/**
 * TeamGateway —— Coordinator 自定义工具与 AgentTeam 之间的接口。
 * Coordinator 只能通过该接口与团队交互，不接触任何执行细节。
 */
import type { DispatchResult, ScheduledTask, WorkerConfig } from "../core/types.js";

export interface TeamGateway {
  /** 可用 Worker 列表 */
  listWorkers(): WorkerConfig[];

  /**
   * 派发任务给 Worker。
   * 内部会再次执行安全评估；高风险请求在此被拒绝，不会进入执行链路。
   */
  dispatch(worker: string, title: string, description: string, long: boolean): Promise<DispatchResult>;

  createSchedule(name: string, cron: string, description: string, worker: string): ScheduledTask;
  updateSchedule(id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined;
  deleteSchedule(id: string): ScheduledTask | undefined;

  /** 任务列表摘要 */
  listTasks(status?: string): string;
  /** 定时任务摘要 */
  listSchedules(): string;

  /** 列出任务产出物清单（相对路径 + 大小），用于 Coordinator 直接核对 Worker 实际产物 */
  listArtifacts(taskId: string): string;
  /** 读取任务产出物目录内单个文件内容（只读、受限），用于 Coordinator 直接核对完整报告/数据 */
  readArtifact(taskId: string, relPath: string): string;
  /** 读取任务完整执行结果（未截断的原始结果），无结果时返回 undefined */
  getTaskResult(taskId: string): string | undefined;
}
