/**
 * LLM 用量与费用统计。
 *
 * 背景：Worker 的 AgentSession 为内存态（in-memory），执行完即丢弃，
 * 历史任务无法查询 token 用量与费用（issue #29）。
 * 本模块在 Worker 会话执行过程中监听 agent_end 事件，把每条 assistant 消息
 * 自带的 usage（token 明细 + 美元费用）汇总，持久化到 data/costs.json，
 * 并写回 tasks.json 的任务记录（Task.usage），使历史任务可查询费用。
 *
 * 仅统计任务执行（Worker）用量；Coordinator 为对话调度，不归属具体任务，不记录。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger.js";
import type { TaskUsage } from "./types.js";

/** costs.json 的磁盘结构 */
interface CostsFile {
  updatedAt: number;
  /** 按任务 id 索引的 Worker 用量 */
  tasks: Record<string, TaskUsage>;
}

/** 会话消息中可提取的原始 usage（来自 pi 的 AssistantMessage / ToolResultMessage） */
interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost?: { total?: number };
}

/** agent_end 事件消息的最小结构（避免依赖 pi 内部消息类型） */
interface UsageMessageLike {
  role: string;
  provider?: string;
  model?: string;
  responseModel?: string;
  usage?: RawUsage;
}

/** 创建一个零值用量 */
export function emptyUsage(model: string): TaskUsage {
  return {
    model,
    calls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    totalTokens: 0,
    cost: 0,
  };
}

/** 把 u 累加到 target（就地修改 target） */
export function addUsage(target: TaskUsage, u: TaskUsage): void {
  target.calls += u.calls;
  target.input += u.input;
  target.output += u.output;
  target.cacheRead += u.cacheRead;
  target.cacheWrite += u.cacheWrite;
  target.reasoning += u.reasoning;
  target.totalTokens += u.totalTokens;
  target.cost += u.cost;
}

/**
 * 从 agent_end 事件的 messages 中汇总全部 LLM 用量。
 * - assistant 消息：主模型调用，含 usage；
 * - toolResult 消息：工具/摘要类调用（如 compaction），若带 usage 一并计入；
 * - 模型名取 responseModel ?? model，去重后按首个出现记录。
 */
export function usageFromAgentMessages(messages: readonly UsageMessageLike[]): TaskUsage {
  const acc = emptyUsage("unknown");
  let model = "";
  for (const m of messages) {
    if (!m.usage) continue;
    if (m.role === "assistant") {
      acc.calls++;
      acc.input += m.usage.input;
      acc.output += m.usage.output;
      acc.cacheRead += m.usage.cacheRead;
      acc.cacheWrite += m.usage.cacheWrite;
      acc.reasoning += m.usage.reasoning ?? 0;
      acc.totalTokens += m.usage.totalTokens;
      acc.cost += m.usage.cost?.total ?? 0;
      if (!model) {
        model = [m.provider, m.responseModel ?? m.model].filter(Boolean).join("/");
      }
    } else if (m.role === "toolResult") {
      acc.calls++;
      acc.input += m.usage.input;
      acc.output += m.usage.output;
      acc.cacheRead += m.usage.cacheRead;
      acc.cacheWrite += m.usage.cacheWrite;
      acc.totalTokens += m.usage.totalTokens;
      acc.cost += m.usage.cost?.total ?? 0;
    }
  }
  if (model) acc.model = model;
  return acc;
}

/** 美元费用格式化：小额保留更多小数位，便于观察 */
export function formatCost(cost: number): string {
  if (cost <= 0) return "$0";
  if (cost < 0.01) return `$${cost.toFixed(6)}`;
  if (cost < 1) return `$${cost.toFixed(4)}`;
  return `$${cost.toFixed(2)}`;
}

/** 用量一行摘要 */
export function formatUsage(u: TaskUsage): string {
  const cost = formatCost(u.cost);
  const tokens = u.totalTokens.toLocaleString("en-US");
  return `${cost}（${tokens} tokens，${u.calls} 次调用，模型 ${u.model}）`;
}

/** 用量与费用持久化存储（data/costs.json） */
export class UsageStore {
  private readonly file: string;
  private data: CostsFile = { updatedAt: 0, tasks: {} };

  constructor(dataDir: string) {
    this.file = join(dataDir, "costs.json");
    mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  private load(): void {
    try {
      if (existsSync(this.file)) {
        const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Partial<CostsFile>;
        this.data = {
          updatedAt: raw.updatedAt ?? 0,
          tasks: raw.tasks ?? {},
        };
      }
    } catch (e) {
      log.warn("usage", `读取费用记录失败，使用空记录: ${(e as Error).message}`);
    }
  }

  private persist(): void {
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (e) {
      log.error("usage", `费用记录持久化失败: ${(e as Error).message}`);
    }
  }

  /** 记录某任务的 Worker 用量（覆盖式，任务只执行一次） */
  recordTask(taskId: string, usage: TaskUsage): void {
    this.data.tasks[taskId] = usage;
    this.data.updatedAt = Date.now();
    this.persist();
    log.info("usage", `任务 ${taskId} 用量: ${formatUsage(usage)}`);
  }

  getTaskUsage(taskId: string): TaskUsage | undefined {
    return this.data.tasks[taskId];
  }
}
