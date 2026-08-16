/**
 * 工作空间管理
 *
 * - 每个 Worker 拥有独立持久目录：data/workspaces/<workerName>/
 *   技能（.pi/skills/）存放于此；不再作为任务执行目录。
 * - 每个任务拥有**专属会话工作空间**：data/workspaces/<workerName>/tasks/<taskId>/
 *   Worker 会话的 cwd 指向该目录，任务之间完全隔离（互不可见、互不影响）。
 * - 任务完成后，其工作空间被**归档**为产出物目录：
 *   data/workspaces/<workerName>/outputs/<taskId>/（持久保留，便于取用）。
 * - 任务工作空间在任务记录被清理（默认 30 天）时删除；产出物目录不自动清理。
 */
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";

export class WorkspaceManager {
  private readonly agentDir: string;

  constructor(
    private readonly root: string,
    /** pi 全局配置目录（~/.pi/agent），用于链接用户级技能 */
    agentDir?: string,
  ) {
    this.agentDir = agentDir ?? join(homedir(), ".pi", "agent");
    mkdirSync(root, { recursive: true });
  }

  /** Worker 持久目录（技能、配置；不再作为任务执行目录） */
  workerDir(workerName: string): string {
    const dir = join(this.root, workerName);
    mkdirSync(dir, { recursive: true });
    // 确保技能目录存在
    mkdirSync(join(dir, ".pi", "skills"), { recursive: true });
    return dir;
  }

  /**
   * 任务专属会话工作空间（会话 cwd 指向此处，任务间完全隔离）。
   * 创建时建立两个技能软链接，使技能在任务工作空间内即可访问：
   * - .pi/skills       → Worker 技能目录（项目级）
   * - .pi/agent-skills → 用户级技能目录（~/.pi/agent/skills）
   * 链接失败（如 Windows 权限）不影响任务执行。
   */
  taskWorkspaceDir(workerName: string, taskId: string): string {
    const dir = join(this.root, workerName, "tasks", taskId);
    mkdirSync(dir, { recursive: true });
    this.linkWorkerSkills(workerName, dir);
    this.linkAgentSkills(dir);
    return dir;
  }

  /** 在任务工作空间内创建 .pi/skills → <workerDir>/.pi/skills 软链接 */
  private linkWorkerSkills(workerName: string, taskWorkspace: string): void {
    const target = join(this.root, workerName, ".pi", "skills");
    const link = join(taskWorkspace, ".pi", "skills");
    if (!existsSync(target)) return;
    if (existsSync(link)) return;
    try {
      mkdirSync(join(taskWorkspace, ".pi"), { recursive: true });
      symlinkSync(target, link, "dir");
      log.info("workspace", `任务工作空间技能软链接: ${link} → ${target}`);
    } catch (e) {
      log.warn("workspace", `技能软链接创建失败（不影响任务执行）: ${(e as Error).message}`);
    }
  }

  /** 在任务工作空间内创建 .pi/agent-skills → <agentDir>/skills 软链接 */
  private linkAgentSkills(taskWorkspace: string): void {
    const target = join(this.agentDir, "skills");
    const link = join(taskWorkspace, ".pi", "agent-skills");
    if (!existsSync(target)) return;
    if (existsSync(link)) return;
    try {
      mkdirSync(join(taskWorkspace, ".pi"), { recursive: true });
      symlinkSync(target, link, "dir");
      log.info("workspace", `用户级技能软链接: ${link} → ${target}`);
    } catch (e) {
      log.warn("workspace", `用户级技能软链接创建失败（不影响任务执行）: ${(e as Error).message}`);
    }
  }

  /** Worker 产出物归档目录 */
  outputsDir(workerName: string): string {
    return join(this.root, workerName, "outputs");
  }

  /**
   * 任务完成后归档产出物：把任务工作空间 tasks/<taskId> 重命名为 outputs/<taskId>。
   * 返回归档后的目录路径。重命名失败时回退为复制 + 删除源目录。
   */
  archiveTaskOutput(workerName: string, taskId: string): string {
    const src = join(this.root, workerName, "tasks", taskId);
    const dstDir = this.outputsDir(workerName);
    mkdirSync(dstDir, { recursive: true });
    const dst = join(dstDir, taskId);
    if (!existsSync(src)) {
      mkdirSync(dst, { recursive: true });
      return dst;
    }
    try {
      renameSync(src, dst);
      log.info("workspace", `归档任务产出物: ${src} → ${dst}`);
    } catch {
      // 跨设备等极端情况：复制后删除源目录
      copyDir(src, dst);
      rmSync(src, { recursive: true, force: true });
      log.info("workspace", `归档任务产出物（复制）: ${src} → ${dst}`);
    }
    // 产出物目录只保留任务真实产出，移除技能软链接（指向 Worker 技能目录）
    rmSync(join(dst, ".pi"), { recursive: true, force: true });
    return dst;
  }

  /** 删除任务工作空间（随任务记录清理时调用） */
  removeTaskWorkspace(workerName: string, taskId: string): void {
    rmSync(join(this.root, workerName, "tasks", taskId), { recursive: true, force: true });
  }

  /**
   * 清理超过 retentionMs 未修改的任务工作空间（tasks/ 下）。
   * 返回清理数量。产出物目录（outputs/）不在此列，持久保留。
   */
  cleanupStaleTaskWorkspaces(retentionMs: number): number {
    let removed = 0;
    let workers: string[] = [];
    try {
      workers = readdirSync(this.root).filter((n) => !n.startsWith("."));
    } catch {
      return 0;
    }
    for (const worker of workers) {
      const tasksRoot = join(this.root, worker, "tasks");
      if (!existsSync(tasksRoot)) continue;
      for (const taskId of readdirSync(tasksRoot)) {
        const dir = join(tasksRoot, taskId);
        try {
          const mtime = statSync(dir).mtimeMs;
          if (Date.now() - mtime > retentionMs) {
            rmSync(dir, { recursive: true, force: true });
            removed++;
            log.info("workspace", `清理过期任务工作空间: ${dir}`);
          }
        } catch {
          /* 并发删除时忽略 */
        }
      }
    }
    return removed;
  }
}

/** 递归复制目录（归档回退用）；符号链接保持为链接，不跟随复制 */
function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    const s = join(src, entry);
    const d = join(dst, entry);
    if (lstatSync(s).isSymbolicLink()) {
      try {
        symlinkSync(readlinkSync(s), d);
      } catch {
        /* 链接失败时跳过 */
      }
    } else if (statSync(s).isDirectory()) {
      copyDir(s, d);
    } else {
      copyFileSync(s, d);
    }
  }
}
