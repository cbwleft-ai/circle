/**
 * 工作空间管理
 *
 * - 每个 Worker 拥有独立持久工作环境：data/workspaces/<workerName>/
 *   技能（.pi/skills/）、产出物均存放于此，Worker 之间互不影响。
 * - 每个任务拥有临时工作空间：data/workspaces/<workerName>/.scratch/<taskId>/
 *   用于存放任务执行过程中的临时产物；任务完成超过 30 天后随记录一起清理。
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";

export class WorkspaceManager {
  constructor(private readonly root: string) {
    mkdirSync(root, { recursive: true });
  }

  /** Worker 持久工作空间 */
  workerDir(workerName: string): string {
    const dir = join(this.root, workerName);
    mkdirSync(dir, { recursive: true });
    // 确保技能目录存在
    mkdirSync(join(dir, ".pi", "skills"), { recursive: true });
    return dir;
  }

  /** 任务临时工作空间 */
  taskScratchDir(workerName: string, taskId: string): string {
    const dir = join(this.root, workerName, ".scratch", taskId);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** 删除任务临时工作空间 */
  removeTaskScratch(workerName: string, taskId: string): void {
    rmSync(join(this.root, workerName, ".scratch", taskId), { recursive: true, force: true });
  }

  /** 删除 Worker 的全部临时工作空间（清理用） */
  removeAllScratch(workerName: string): void {
    const dir = join(this.root, workerName, ".scratch");
    rmSync(dir, { recursive: true, force: true });
  }

  /**
   * 清理超过 retentionMs 未修改的 scratch 目录。
   * 返回清理数量。
   */
  cleanupStaleScratch(retentionMs: number): number {
    let removed = 0;
    let workers: string[] = [];
    try {
      workers = readdirSync(this.root).filter((n) => !n.startsWith("."));
    } catch {
      return 0;
    }
    for (const worker of workers) {
      const scratchRoot = join(this.root, worker, ".scratch");
      if (!existsSync(scratchRoot)) continue;
      for (const taskId of readdirSync(scratchRoot)) {
        const dir = join(scratchRoot, taskId);
        try {
          const mtime = statSync(dir).mtimeMs;
          if (Date.now() - mtime > retentionMs) {
            rmSync(dir, { recursive: true, force: true });
            removed++;
            log.info("workspace", `清理过期临时工作空间: ${dir}`);
          }
        } catch {
          /* 并发删除时忽略 */
        }
      }
    }
    return removed;
  }
}
