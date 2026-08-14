/**
 * 测试基础设施：轻量断言框架 + 团队测试环境 + 报告结构。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultWorkers, loadConfig, type AppConfig } from "../src/config.js";
import { TestAdapter } from "../src/im/test.js";
import { AgentTeam } from "../src/team/agent-team.js";
import type { WorkerConfig } from "../src/core/types.js";

export interface TestResult {
  id: string;
  category: string;
  name: string;
  passed: boolean;
  detail: string;
  durationMs: number;
  skipped?: boolean;
}

export type TestCaseFn = (t: TestCaseContext) => Promise<void>;

export interface TestCaseContext {
  assert(cond: unknown, msg: string): void;
  assertEqual<T>(actual: T, expected: T, msg?: string): void;
  log(msg: string): void;
}

export class AssertionError extends Error {}

/** 运行一个测试用例，捕获失败并返回结果 */
export async function runCase(
  id: string,
  category: string,
  name: string,
  fn: TestCaseFn,
  opts: { skip?: boolean; timeoutMs?: number } = {},
): Promise<TestResult> {
  const start = Date.now();
  const logs: string[] = [];
  const t: TestCaseContext = {
    assert(cond, msg) {
      if (!cond) throw new AssertionError(msg);
    },
    assertEqual(actual, expected, msg) {
      const a = JSON.stringify(actual);
      const e = JSON.stringify(expected);
      if (a !== e) throw new AssertionError(`${msg ?? "值不相等"}：期望 ${e}，实际 ${a}`);
    },
    log(msg) {
      logs.push(msg);
    },
  };
  if (opts.skip) {
    return { id, category, name, passed: false, detail: "已跳过（SKIP）", durationMs: 0, skipped: true };
  }
  try {
    await withTimeout(fn(t), opts.timeoutMs ?? 300_000, `${name} 超时（${opts.timeoutMs}ms）`);
    return {
      id,
      category,
      name,
      passed: true,
      detail: logs.length > 0 ? logs.join("\n") : "通过",
      durationMs: Date.now() - start,
    };
  } catch (e) {
    return {
      id,
      category,
      name,
      passed: false,
      detail: `${(e as Error).message}\n${logs.join("\n")}`,
      durationMs: Date.now() - start,
    };
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export async function poll<T>(
  fn: () => T | undefined | Promise<T | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; msg?: string } = {},
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await fn();
    if (last !== undefined && last !== null && last !== false) return last as T;
    await sleep(intervalMs);
  }
  throw new Error(`轮询超时(${timeoutMs}ms)${opts.msg ? `: ${opts.msg}` : ""}${last !== undefined ? `（最后值: ${JSON.stringify(last)}）` : ""}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 创建独立的测试团队环境 */
export async function createTestTeam(opts: {
  workers?: WorkerConfig[];
  configOverrides?: Partial<AppConfig>;
  llmEnabled?: boolean;
} = {}): Promise<{ team: AgentTeam; adapter: TestAdapter; config: AppConfig; dataDir: string }> {
  // 测试默认使用低思考级别加速
  process.env.CIRCLE_COORDINATOR_THINKING = process.env.CIRCLE_COORDINATOR_THINKING ?? "low";
  process.env.CIRCLE_WORKER_THINKING = process.env.CIRCLE_WORKER_THINKING ?? "low";

  const dataDir = mkdtempSync(join(tmpdir(), "circle-test-"));
  const config: AppConfig = {
    ...loadConfig(),
    dataDir,
    schedulerTickMs: 1000,
    statusCheckInterval: 5,
    ...opts.configOverrides,
  };
  const adapter = new TestAdapter();
  const workers =
    opts.workers ??
    defaultWorkers(dataDir).map((w) => ({ ...w, cwd: join(dataDir, "workspaces", w.name) }));
  const team = await AgentTeam.create({
    config,
    workers,
    outbox: async (chatId, text) => {
      await adapter.send(chatId, text);
    },
  });
  await team.start();
  adapter.onMessage((msg) => {
    void team.handleUserMessage(msg).catch((e) => {
      console.error(`[test] 处理消息失败: ${(e as Error).message}`);
    });
  });
  return { team, adapter, config, dataDir };
}

/** 清理测试数据目录 */
export function cleanupTestDir(dataDir: string): void {
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** 生成 Markdown 测试报告 */
export function renderReport(results: TestResult[], extra: string[] = []): string {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  const totalMs = results.reduce((s, r) => s + r.durationMs, 0);

  const lines: string[] = [];
  lines.push("# Circle 测试报告");
  lines.push("");
  lines.push(`- 生成时间：${new Date().toLocaleString("zh-CN")}`);
  lines.push(`- 用例总数：${total}，通过：${passed}，失败：${failed}，跳过：${skipped}`);
  lines.push(`- 总耗时：${(totalMs / 1000).toFixed(1)}s`);
  lines.push("");
  if (extra.length > 0) {
    lines.push(...extra);
    lines.push("");
  }
  lines.push("## 用例明细");
  lines.push("");
  lines.push("| ID | 分类 | 用例 | 结果 | 耗时 |");
  lines.push("| --- | --- | --- | --- | --- |");
  for (const r of results) {
    const icon = r.skipped ? "⏭️ 跳过" : r.passed ? "✅ 通过" : "❌ 失败";
    lines.push(`| ${r.id} | ${r.category} | ${r.name} | ${icon} | ${(r.durationMs / 1000).toFixed(1)}s |`);
  }
  lines.push("");
  lines.push("## 失败/跳过详情");
  lines.push("");
  for (const r of results) {
    if (r.passed && !r.skipped) continue;
    lines.push(`### ${r.id} ${r.name}`);
    lines.push("");
    lines.push("```");
    lines.push(r.detail.slice(0, 2000));
    lines.push("```");
    lines.push("");
  }
  lines.push("## 运行详情（含真实对话记录）");
  lines.push("");
  for (const r of results) {
    if (r.skipped) continue;
    lines.push(`### ${r.id} ${r.name}`);
    lines.push("");
    lines.push("```");
    lines.push(r.detail.slice(0, 2500));
    lines.push("```");
    lines.push("");
  }
  return lines.join("\n");
}
