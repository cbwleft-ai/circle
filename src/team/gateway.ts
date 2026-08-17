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

  /** 列出任务产出物目录中的文件（只读） */
  listTaskOutputs(taskId: string): string;
  /** 读取任务产出物目录中的指定文件（只读） */
  readTaskOutput(taskId: string, path: string): string;
}
