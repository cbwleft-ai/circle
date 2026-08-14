/**
 * 用例 2：用户创建定时任务
 *
 * 验证目标：
 * - Coordinator 解析需求并转交 Scheduler 创建定时任务；
 * - 到达触发时间后 Scheduler 向 Worker 下发执行；
 * - Worker 完成后结果返回 Scheduler，再由 Scheduler 反馈给 Coordinator；
 * - Coordinator 向用户同步最终结果；
 * - 定时任务支持删除。
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupTestDir,
  createTestTeam,
  poll,
  runCase,
  type TestResult,
} from "./helpers.js";

const MARKER = "SCHEDULE_OK_2025";

export async function runCase2(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const llmEnabled = (process.env.CIRCLE_LLM_TESTS ?? "1") === "1";

  results.push(
    await runCase(
      "C2-01",
      "用例2: 定时任务",
      "创建定时任务 → 触发执行 → 结果回流 → 删除",
      async (t) => {
        const dataDir = mkdtempSync(join(tmpdir(), "circle-case2-"));
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

          // 1) 用户要求创建定时任务（每天上午 10 点）
          await adapter.inject(
            "console",
            `创建一个定时任务，名称叫「每日状态检查」，每天上午 10 点执行：在 dev Worker 上运行命令 echo ${MARKER} >> schedule_check.txt。cron 表达式为 0 10 * * *。`,
          );

          // 2) Coordinator 转交 Scheduler 创建成功
          const schedule = await poll(
            () => team.scheduleStore.list().find((s) => s.name.includes("每日状态检查")),
            { timeoutMs: 90_000, msg: "定时任务应被创建" },
          );
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 定时任务已创建: ${schedule.id}「${schedule.name}」cron="${schedule.cron}"`);
          t.assert(schedule.cron.split(/\s+/).length === 5, `cron 应为 5 段，实际 "${schedule.cron}"`);
          t.assert(schedule.workerName === "dev", `Worker 应为 dev，实际 ${schedule.workerName}`);

          // 3) 模拟到达触发时间：由 Scheduler 触发（测试环境不等待真实 10:00）
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 手动触发定时任务（模拟到达触发时间）…`);
          await team.triggerScheduleNow(schedule.id);

          // 4) Scheduler 向 Worker 下发执行，结果经 Coordinator 回流给用户
          const final = await adapter.waitFor((x) => x.includes(MARKER), {
            timeoutMs: 420_000,
          });
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 定时任务结果已回流: ${final.slice(0, 120)}…`);

          // 5) 断言：任务记录关联 scheduleId，且状态 completed
          const task = await poll(
            () => team.taskStore.list().find((x) => x.scheduleId === schedule.id),
            { timeoutMs: 30_000, msg: "应存在关联定时任务的任务记录" },
          );
          await poll(() => team.taskStore.get(task.id)?.status === "completed", {
            timeoutMs: 60_000,
            msg: "任务状态应为 completed",
          });
          t.assert(team.taskStore.get(task.id)!.status === "completed", "定时任务触发的任务应完成");
          t.assert(
            (team.scheduleStore.get(schedule.id)?.taskIds ?? []).includes(task.id),
            "Scheduler 应记录触发历史",
          );
          t.log(`任务 ${task.id} 已完成，Scheduler 已记录触发。`);

          // 6) 删除定时任务（用户 → Coordinator → Scheduler）
          await adapter.inject("console", `请删除定时任务 ${schedule.id}`);
          await poll(() => team.scheduleStore.get(schedule.id) === undefined, {
            timeoutMs: 90_000,
            msg: "定时任务应被删除",
          });
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 定时任务 ${schedule.id} 已删除。`);
        } finally {
          await team.stop();
          cleanupTestDir(dataDir);
        }
      },
      { skip: !llmEnabled, timeoutMs: 600_000 },
    ),
  );

  return results;
}

/** 独立运行入口 */
if (process.argv[1]?.endsWith("case2-scheduled-task.test.ts")) {
  const { renderReport } = await import("./helpers.js");
  const results = await runCase2();
  console.log(renderReport(results));
  process.exit(results.some((r) => !r.passed && !r.skipped) ? 1 : 0);
}
