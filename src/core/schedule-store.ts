/**
 * 定时任务存储：JSON 文件持久化。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import type { ScheduledTask } from "./types.js";

export class ScheduleStore {
  private schedules: ScheduledTask[] = [];
  private seq = 1;
  private readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, "schedules.json");
    mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  private load() {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf-8")) as {
          seq: number;
          schedules: ScheduledTask[];
        };
        this.seq = raw.seq ?? 1;
        this.schedules = raw.schedules ?? [];
      }
    } catch (e) {
      log.warn("schedule-store", `读取定时任务存储失败，使用空存储: ${(e as Error).message}`);
    }
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify({ seq: this.seq, schedules: this.schedules }, null, 2));
    } catch (e) {
      log.error("schedule-store", `持久化失败: ${(e as Error).message}`);
    }
  }

  nextId(): string {
    return `S-${Date.now().toString(36).toUpperCase()}-${String(this.seq++).padStart(3, "0")}`;
  }

  create(input: Omit<ScheduledTask, "id" | "createdAt"> & { id?: string }): ScheduledTask {
    const s: ScheduledTask = {
      id: input.id ?? this.nextId(),
      name: input.name,
      cron: input.cron,
      description: input.description,
      workerName: input.workerName,
      enabled: input.enabled ?? true,
      createdAt: Date.now(),
      taskIds: input.taskIds ?? [],
    };
    this.schedules.push(s);
    this.persist();
    return s;
  }

  get(id: string): ScheduledTask | undefined {
    return this.schedules.find((s) => s.id === id);
  }

  list(enabledOnly = false): ScheduledTask[] {
    return this.schedules.filter((s) => (enabledOnly ? s.enabled : true));
  }

  update(id: string, patch: Partial<ScheduledTask>): ScheduledTask | undefined {
    const s = this.get(id);
    if (!s) return undefined;
    Object.assign(s, patch);
    this.persist();
    return s;
  }

  delete(id: string): ScheduledTask | undefined {
    const idx = this.schedules.findIndex((s) => s.id === id);
    if (idx < 0) return undefined;
    const [s] = this.schedules.splice(idx, 1);
    this.persist();
    return s;
  }

  addTaskRecord(id: string, taskId: string): void {
    const s = this.get(id);
    if (!s) return;
    s.taskIds.push(taskId);
    this.persist();
  }

  summarize(): string {
    const list = this.list();
    if (list.length === 0) return "暂无定时任务。";
    return list
      .map((s) => {
        const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString("zh-CN") : "未计算";
        return `${s.enabled ? "🔁" : "⏸️"} ${s.id} ${s.name}（cron: "${s.cron}", Worker: ${s.workerName}, 下次触发: ${next}, 已触发 ${s.taskIds.length} 次）`;
      })
      .join("\n");
  }
}
