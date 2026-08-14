/**
 * 任务存储：JSON 文件持久化 + 内存索引。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import type { Task, TaskStatus } from "./types.js";

export class TaskStore {
  private tasks: Task[] = [];
  private seq = 1;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "tasks.json");
    mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  private load() {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf-8")) as {
          seq: number;
          tasks: Task[];
        };
        this.seq = raw.seq ?? 1;
        this.tasks = raw.tasks ?? [];
      }
    } catch (e) {
      log.warn("task-store", `读取任务存储失败，使用空存储: ${(e as Error).message}`);
    }
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify({ seq: this.seq, tasks: this.tasks }, null, 2));
    } catch (e) {
      log.error("task-store", `持久化失败: ${(e as Error).message}`);
    }
  }

  nextId(): string {
    const now = new Date();
    const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    return `T-${ymd}-${String(this.seq++).padStart(4, "0")}`;
  }

  create(input: Omit<Task, "id" | "createdAt"> & { id?: string }): Task {
    const task: Task = {
      ...input,
      id: input.id ?? this.nextId(),
      createdAt: Date.now(),
      status: input.status ?? "received",
    };
    this.tasks.push(task);
    this.persist();
    return task;
  }

  get(id: string): Task | undefined {
    return this.tasks.find((t) => t.id === id);
  }

  list(filter?: { status?: TaskStatus | TaskStatus[]; worker?: string }): Task[] {
    let out = this.tasks;
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      out = out.filter((t) => statuses.includes(t.status));
    }
    if (filter?.worker) out = out.filter((t) => t.workerName === filter.worker);
    return [...out].sort((a, b) => b.createdAt - a.createdAt);
  }

  update(id: string, patch: Partial<Task>): Task | undefined {
    const task = this.get(id);
    if (!task) return undefined;
    Object.assign(task, patch);
    this.persist();
    return task;
  }

  markRunning(id: string): void {
    this.update(id, { status: "running", startedAt: Date.now() });
  }

  markCompleted(id: string, result: string): void {
    this.update(id, {
      status: "completed",
      result,
      completedAt: Date.now(),
    });
  }

  markFailed(id: string, error: string): void {
    this.update(id, { status: "failed", error, completedAt: Date.now() });
  }

  /** 待办任务（received / dispatched / running） */
  pending(): Task[] {
    return this.list().filter((t) => ["received", "dispatched", "running"].includes(t.status));
  }

  /**
   * 清理已完成超过 retentionDays 天的任务记录。
   * 返回被清理的任务列表（调用方负责清理其临时工作空间）。
   */
  cleanupCompleted(retentionDays: number): Task[] {
    const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000;
    const kept: Task[] = [];
    const removed: Task[] = [];
    for (const t of this.tasks) {
      const doneAt = t.completedAt ?? 0;
      if ((t.status === "completed" || t.status === "failed") && doneAt > 0 && doneAt < cutoff) {
        removed.push(t);
      } else {
        kept.push(t);
      }
    }
    if (removed.length > 0) {
      this.tasks = kept;
      this.persist();
      log.info("task-store", `清理 ${removed.length} 条超过 ${retentionDays} 天的已完成任务记录`);
    }
    return removed;
  }

  remove(id: string): Task | undefined {
    const idx = this.tasks.findIndex((t) => t.id === id);
    if (idx < 0) return undefined;
    const [task] = this.tasks.splice(idx, 1);
    this.persist();
    return task;
  }

  /** 任务摘要（供 Coordinator 汇报） */
  summarize(filter?: { status?: TaskStatus | TaskStatus[] }): string {
    const tasks = this.list(filter);
    if (tasks.length === 0) return "暂无任务。";
    const lines = tasks.map((t) => {
      const done = t.completedAt ? new Date(t.completedAt).toLocaleString("zh-CN") : "-";
      const statusIcon: Record<TaskStatus, string> = {
        received: "🕐",
        dispatched: "📤",
        running: "⏳",
        completed: "✅",
        failed: "❌",
        rejected: "🚫",
      };
      return `${statusIcon[t.status]} ${t.id} [${t.priority}] ${t.title}（Worker: ${t.workerName}, 状态: ${t.status}, 完成: ${done}）`;
    });
    return lines.join("\n");
  }
}
