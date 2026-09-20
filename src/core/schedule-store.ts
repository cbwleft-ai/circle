/**
 * 定时任务存储：JSON 文件持久化。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import type { ScheduledTask } from "./types.js";

/** 是否为一次性任务（kind 缺省视为 cron，兼容旧数据） */
export function isOnceSchedule(s: Pick<ScheduledTask, "kind">): boolean {
  return s.kind === "once";
}

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
        // 旧数据（issue #49 前）无 kind 字段，归一化为 cron，保持既有行为不变
        this.schedules = (raw.schedules ?? []).map((s) => ({ ...s, kind: s.kind ?? "cron" }));
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
      kind: input.kind ?? "cron",
      cron: input.cron,
      runAt: input.runAt,
      description: input.description,
      workerName: input.workerName,
      ownerChatId: input.ownerChatId,
      createdBy: input.createdBy,
      enabled: input.enabled ?? true,
      createdAt: Date.now(),
      lastRunAt: input.lastRunAt,
      nextRunAt: input.nextRunAt,
      missedAt: input.missedAt,
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

  summarize(filter?: { ownerChatId?: string; legacyOwnerChatId?: string }): string {
    const list = filter?.ownerChatId
      ? this.list().filter((s) => (s.ownerChatId ?? filter.legacyOwnerChatId) === filter.ownerChatId)
      : this.list();
    if (list.length === 0) return "暂无定时任务。";
    return list
      .map((s) => {
        if (isOnceSchedule(s)) {
          const state = s.missedAt ? "已错过（不再执行）" : s.enabled ? "待触发" : "已触发";
          const icon = s.missedAt ? "⚠️" : s.enabled ? "⏰" : "✅";
          return `${icon} ${s.id} ${s.name}（一次性: ${s.runAt ?? "未设置"}，Worker: ${s.workerName}，${state}，已触发 ${s.taskIds.length} 次）`;
        }
        const next = s.nextRunAt ? new Date(s.nextRunAt).toLocaleString("zh-CN") : "未计算";
        return `${s.enabled ? "🔁" : "⏸️"} ${s.id} ${s.name}（cron: "${s.cron ?? ""}", Worker: ${s.workerName}, 下次触发: ${next}, 已触发 ${s.taskIds.length} 次）`;
      })
      .join("\n");
  }
}
