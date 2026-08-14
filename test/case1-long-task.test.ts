/**
 * 用例 1：用户提交长程任务（+ 短程任务回归）
 *
 * 验证目标：
 * - Coordinator 接收任务并回复「任务已收到」（确认到达）；
 * - Coordinator 将任务派发给 Worker；
 * - Worker 执行（>10s）并反馈结果；
 * - Coordinator 汇总结果后回复用户；
 * - 用户只与 Coordinator 对话（Worker 不直接面向用户）；
 * - 短程任务在同一轮对话中直接返回结果（无递归汇报 bug）。
 */
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTestDir,
  createTestTeam,
  poll,
  runCase,
  type TestResult,
} from "./helpers.js";

const MARKER = "LONG_TASK_DONE_2025";

export async function runCase1(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const llmEnabled = (process.env.CIRCLE_LLM_TESTS ?? "1") === "1";

  results.push(
    await runCase(
      "C1-01",
      "用例1: 长程任务",
      "用户提交长程任务：收到确认 → 派发 → 执行 → 汇报",
      async (t) => {
        const dataDir = mkdtempSync(join(tmpdir(), "circle-case1-"));
        const { team, adapter } = await createTestTeam({
          configOverrides: { dataDir },
          workers: [
            {
              name: "dev",
              description: "开发 Worker：负责脚本/文件类任务",
              cwd: join(dataDir, "workspaces", "dev"),
            },
          ],
        });
        try {
          const t0 = Date.now();
          const sentBefore = adapter.sent.length;

          // 1) 用户提交长程任务
          await adapter.inject(
            "console",
            `请派一个长程任务给 dev Worker：写一个 bash 脚本，先 sleep 12 秒，然后把字符串 ${MARKER} 追加写入 done.txt，最后读取文件内容汇报结果。`,
          );

          // 2) Coordinator 先回复「任务已收到」（长程任务确认：注入后的第一条回复）
          const firstReply = await poll(
            () => adapter.sent.find((s) => s.ts >= sentBefore)?.text ?? undefined,
            { timeoutMs: 120_000, intervalMs: 500, msg: "长程任务确认（第一条回复）" },
          );
          const ackTs = adapter.sent.find((s) => s.ts >= sentBefore)!.ts;
          t.assert(
            firstReply.includes("任务") || firstReply.includes("Worker") || firstReply.includes("收到"),
            "第一条回复应为任务确认",
          );
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] Coordinator 确认: ${firstReply.slice(0, 120)}…`);

          // 3) 任务已记录且为长程
          const task = await poll(
            () => {
              const list = team.taskStore.list();
              return list.find((x) => x.priority === "long" && x.requestedBy === "user");
            },
            { timeoutMs: 30_000, msg: "任务应被创建" },
          );
          t.assert(task.description.includes("sleep"), "任务指令应包含执行内容");
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 任务已创建: ${task.id}（priority=${task.priority}）`);

          // 4) Worker 执行完成后 Coordinator 汇报最终结果（必须是 ack 之后的独立消息）
          const final = await poll(
            () =>
              adapter.sent.find((s) => s.ts > ackTs && s.text.includes(MARKER))?.text ?? undefined,
            { timeoutMs: 420_000, intervalMs: 1000, msg: "最终结果汇报（Worker 完成后的独立消息）" },
          );
          t.assert(final.length > 0, "应收到最终结果汇报");
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 最终汇报已收到: ${final.slice(0, 200)}…`);

          // 5) 断言状态与执行时长
          await poll(() => team.taskStore.get(task.id)?.status === "completed", {
            timeoutMs: 30_000,
            msg: "任务状态应为 completed",
          });
          const done = team.taskStore.get(task.id)!;
          t.assert(done.result !== undefined && done.result.length > 0, "应记录执行结果");
          const elapsed = done.completedAt! - done.startedAt!;
          t.assert(elapsed >= 10_000, `执行时长 ${(elapsed / 1000).toFixed(1)}s 应 >= 10s（长程任务定义）`);

          // 6) 产出物在工作空间中（递归查找包含 MARKER 的文件，容忍文件名/位置差异）
          const workerCwd = team.workers.get("dev")!.config.cwd;
          const wsFile = await poll(
            () => findFileContaining(workerCwd, MARKER, { includeScratch: true }),
            {
              timeoutMs: 90_000,
              msg: `工作空间中应存在包含 ${MARKER} 的产出文件（目录: ${workerCwd}）`,
            },
          );
          const content = readFileSync(wsFile, "utf-8");
          t.assert(content.includes(MARKER), `产出文件内容应包含 ${MARKER}`);
          t.log(`产出物: ${wsFile} → ${content.trim()}`);

          // 7) 用户只与 Coordinator 对话：所有回复都来自 outbox（Coordinator 身份）
          const replies = adapter.sent.filter((s) => s.ts >= sentBefore);
          t.assert(replies.length >= 2, `应有至少 2 条回复（确认 + 结果），实际 ${replies.length} 条`);
          t.assert(
            replies.some((r) => r.ts <= ackTs) && replies.some((r) => r.ts > ackTs && r.text.includes(MARKER)),
            "回复应包含确认与最终结果",
          );
          t.log(`共 ${replies.length} 条回复，全部经由 Coordinator 转发。`);
        } finally {
          await team.stop();
          cleanupTestDir(dataDir);
        }
      },
      { skip: !llmEnabled, timeoutMs: 600_000 },
    ),
  );

  results.push(
    await runCase(
      "C1-02",
      "用例1: 短程任务",
      "用户提交短程任务：直接返回结果（无递归汇报 bug）",
      async (t) => {
        const dataDir = mkdtempSync(join(tmpdir(), "circle-case1-short-"));
        const { team, adapter } = await createTestTeam({
          configOverrides: { dataDir },
          workers: [
            {
              name: "dev",
              description: "开发 Worker",
              cwd: join(dataDir, "workspaces", "dev"),
            },
          ],
        });
        try {
          const t0 = Date.now();
          await adapter.inject(
            "console",
            `请派一个短程任务给 dev Worker：执行 echo SHORT_OK_2025 > short.txt，然后读取 short.txt 内容汇报。`,
          );
          // 短程任务应在同一轮对话中直接返回结果
          const reply = await adapter.waitFor((x) => x.includes("SHORT_OK_2025"), {
            timeoutMs: 180_000,
            since: Date.now() - 1000,
          });
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 短程任务结果: ${reply.slice(0, 200)}…`);
          await poll(
            () =>
              team.taskStore
                .list()
                .find((x) => x.requestedBy === "user" && x.priority === "short" && x.status === "completed") !==
              undefined,
            { timeoutMs: 30_000, msg: "短程任务应完成" },
          );
          t.assert(adapter.sent.length >= 1, "应收到结果回复");
          t.log("短程任务状态已标记 completed。");
        } finally {
          await team.stop();
          cleanupTestDir(dataDir);
        }
      },
      { skip: !llmEnabled, timeoutMs: 300_000 },
    ),
  );

  return results;
}

/** 递归查找包含指定内容的文件（可包含 scratch） */
function findFileContaining(
  root: string,
  needle: string,
  opts: { includeScratch?: boolean } = {},
): string | undefined {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = join(dir, e);
      try {
        if (statSync(p).isDirectory()) {
          if (opts.includeScratch || (e !== ".scratch" && e !== ".pi")) stack.push(p);
        } else if (e.endsWith(".txt") || e.endsWith(".log")) {
          const c = readFileSync(p, "utf-8");
          if (c.includes(needle)) return p;
        }
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

/** 独立运行入口 */
if (process.argv[1]?.endsWith("case1-long-task.test.ts")) {
  const { renderReport } = await import("./helpers.js");
  const results = await runCase1();
  console.log(renderReport(results));
  process.exit(results.some((r) => !r.passed && !r.skipped) ? 1 : 0);
}
