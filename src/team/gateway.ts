/**
 * TeamGateway —— Coordinator 自定义工具与 AgentTeam 之间的接口。
 * Coordinator 只能通过该接口与团队交互，不接触任何执行细节。
 */
import type { DispatchResult, ScheduledTask, SendArtifactResult, WorkerConfig } from "../core/types.js";

export interface TeamGateway {
  /** 可用 Worker 列表 */
  listWorkers(): WorkerConfig[];

  /**
   * 派发任务给 Worker（chatId 由框架注入，代表任务归属会话）。
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
  /** 修改定时任务（仅限所属会话或管理员） */
  updateSchedule(chatId: string, id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined;
  /** 删除定时任务（仅限所属会话或管理员） */
  deleteSchedule(chatId: string, id: string): ScheduledTask | undefined;

  /** 任务列表摘要（默认仅当前会话，管理员可看全部） */
  listTasks(chatId: string, status?: string): string;
  /** 定时任务摘要（默认仅当前会话，管理员可看全部） */
  listSchedules(chatId: string): string;

  /** 列出任务产出物清单（仅限任务所属会话或管理员） */
  listArtifacts(chatId: string, taskId: string): string;
  /** 读取任务产出物目录内单个文件内容（仅限任务所属会话或管理员） */
  readArtifact(chatId: string, taskId: string, relPath: string): string;
  /** 读取任务完整执行结果（仅限任务所属会话或管理员），无结果时返回 undefined */
  getTaskResult(chatId: string, taskId: string): string | undefined;

  /**
   * 把指定任务的产出物文件通过 IM 发送给用户（附件形式，issue #24）。
   * 仅限任务产出物目录内文件（只读 + 路径受限 + 大小上限）；
   * 通道不支持文件时自动降级为文本提示，不阻塞。
   */
  sendArtifact(chatId: string, taskId: string, relPath: string, caption?: string): Promise<SendArtifactResult>;
}
