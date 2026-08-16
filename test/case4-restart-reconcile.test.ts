/**
 * 用例 4：进程重启后的启动对账与中断通知
 *
 * 验证目标：
 * - 预置一个 status=running 的遗留任务（模拟进程重启前的执行现场）；
 * - AgentTeam 启动时将其标记为 failed（原因：进程重启，任务中断），不再被误报为"执行中"；
 * - 按发起会话向用户发送中断通知（仅通知，不自动重跑）。
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTestDir,
  createTestTeam,
  poll,
  runCase,
  type TestResult,
} from "./helpers.js";

export async function runCase4(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const llmEnabled = (process.env.CIRCLE_LLM_TESTS ?? "1") === "1";

  results.push(
    await runCase(
      "C4-01",
      "用例4: 重启对账",
      "启动时标记中断任务为失败并通知用户（仅通知，不自动恢复）",
      async (t) => {
        const dataDir = mkdtempSync(join(tmpdir(), "circle-case4-"));
        try {
          // 预置遗留任务：模拟上次进程在 running 状态下被杀死
          const legacyTask = {
            id: "T-LEGACY-0001",
            title: "重启前未完成的长程任务",
            description: "sleep 60 秒后写结果",
            status: "running",
            priority: "long",
            workerName: "dev",
            requestedBy: "user",
            requestChatId: "console",
            createdAt: Date.now() - 3600_000,
            startedAt: Date.now() - 1800_000,
          };
          writeFileSync(
            join(dataDir, "tasks.json"),
            JSON.stringify({ seq: 2, tasks: [legacyTask] }, null, 2),
          );

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
            // 1) 启动对账：遗留任务应被标记为 failed
            await poll(
              () => team.taskStore.get("T-LEGACY-0001")?.status === "failed",
              { timeoutMs: 30_000, msg: "遗留任务应被标记为 failed" },
            );
            const task = team.taskStore.get("T-LEGACY-0001")!;
            t.assert(task.error?.includes("重启"), `失败原因应含「重启」: ${task.error}`);
            t.assert(team.taskStore.pending().length === 0, "对账后不应再有待办任务");

            // 2) 用户应收到中断通知（内容含任务编号/标题）
            const notice = await poll(
              () => adapter.sent.find((s) => s.text.includes("T-LEGACY-0001"))?.text ?? undefined,
              { timeoutMs: 120_000, intervalMs: 500, msg: "应收到重启中断通知" },
            );
            t.assert(notice.includes("重启"), "通知应说明系统已重启");
            t.assert(notice.includes("T-LEGACY-0001"), "通知应包含任务编号");
            t.log(`中断通知: ${notice.slice(0, 200)}…`);
          } finally {
            await team.stop();
          }
        } finally {
          cleanupTestDir(dataDir);
        }
      },
      { skip: !llmEnabled, timeoutMs: 300_000 },
    ),
  );

  return results;
}

/** 独立运行入口 */
if (process.argv[1]?.endsWith("case4-restart-reconcile.test.ts")) {
  const { renderReport } = await import("./helpers.js");
  const results = await runCase4();
  console.log(renderReport(results));
  process.exit(results.some((r) => !r.passed && !r.skipped) ? 1 : 0);
}
