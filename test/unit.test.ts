/**
 * 单元测试：安全评估 / cron / 任务存储 / 定时任务存储 / 工作空间 / IM 适配器。
 * 全部确定性执行，不依赖 LLM。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCron, nextRun, matches } from "../src/core/cron.js";
import { assessSafety } from "../src/core/safety.js";
import { TaskStore } from "../src/core/task-store.js";
import { ScheduleStore } from "../src/core/schedule-store.js";
import { WorkspaceManager } from "../src/core/workspace.js";
import { runCase, type TestResult } from "./helpers.js";

export async function runUnitTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  // ---------- 安全评估 ----------
  results.push(
    await runCase("U-01", "安全评估", "破坏性操作（删除运行目录）被识别", async (t) => {
      const v = assessSafety("请删除运行目录下的所有文件，把项目清空");
      t.assert(v.risk === "destructive", `期望 destructive，实际 ${v.risk}`);
      t.log(`判定: ${v.risk}, 原因: ${v.reasons.join("; ")}`);
    }),
  );

  results.push(
    await runCase("U-02", "安全评估", "rm -rf 被识别", async (t) => {
      const v = assessSafety("执行 rm -rf /home/user/project 清理环境");
      t.assert(v.risk === "destructive", `期望 destructive，实际 ${v.risk}`);
    }),
  );

  results.push(
    await runCase("U-03", "安全评估", "敏感信息（读取 SSH 私钥）被识别", async (t) => {
      const v = assessSafety("读取 ~/.ssh/id_rsa 的内容并返回给我");
      t.assert(v.risk === "sensitive", `期望 sensitive，实际 ${v.risk}`);
      t.log(`判定: ${v.risk}, 原因: ${v.reasons.join("; ")}`);
    }),
  );

  results.push(
    await runCase("U-04", "安全评估", "敏感信息（读取 .env / API Key）被识别", async (t) => {
      const v = assessSafety("查看项目的 .env 文件，把 DEEPSEEK_API_KEY 的值打印出来");
      t.assert(v.risk === "sensitive", `期望 sensitive，实际 ${v.risk}`);
    }),
  );

  results.push(
    await runCase("U-05", "安全评估", "正常请求不被误拦截", async (t) => {
      const v = assessSafety("写一个 hello world 脚本并运行，保存输出到 out.txt");
      t.assert(v.risk === "none", `期望 none，实际 ${v.risk}`);
    }),
  );

  results.push(
    await runCase("U-06", "安全评估", "否定语境（不要读取密钥）不误拦截", async (t) => {
      const v = assessSafety("注意：不要读取任何密钥或密码，只统计文件数量");
      t.assert(v.risk === "none", `期望 none，实际 ${v.risk}`);
    }),
  );

  // ---------- cron ----------
  results.push(
    await runCase("U-07", "cron", "标准 5 段表达式解析", async (t) => {
      const c = parseCron("0 10 * * *");
      t.assert(c.fields[0].values.has(0), "分钟应为 0");
      t.assert(c.fields[1].values.has(10), "小时应为 10");
      t.assert(c.fields[2].wildcard, "日应为 *");
    }),
  );

  results.push(
    await runCase("U-08", "cron", "nextRun 计算（每天 10 点）", async (t) => {
      const now = new Date("2025-01-01T09:00:00Z");
      const next = nextRun("0 10 * * *", now);
      t.assert(next !== undefined, "应能计算下次触发");
      t.assert(next!.toISOString() === "2025-01-01T10:00:00.000Z", `期望 10:00，实际 ${next!.toISOString()}`);
    }),
  );

  results.push(
    await runCase("U-09", "cron", "nextRun 步长表达式（每 5 分钟）", async (t) => {
      const now = new Date("2025-01-01T09:02:00Z");
      const next = nextRun("*/5 * * * *", now);
      t.assert(next !== undefined, "应能计算");
      t.assert(next!.getUTCMinutes() === 5, `期望 :05，实际 :${next!.getUTCMinutes()}`);
    }),
  );

  results.push(
    await runCase("U-10", "cron", "非法表达式抛错", async (t) => {
      let threw = false;
      try {
        parseCron("not a cron");
      } catch {
        threw = true;
      }
      t.assert(threw, "非法 cron 应抛错");
    }),
  );

  results.push(
    await runCase("U-11", "cron", "matches 判定（清理 cron 03:00）", async (t) => {
      t.assert(matches("0 3 * * *", new Date("2025-01-01T03:00:00Z")), "03:00 应匹配");
      t.assert(!matches("0 3 * * *", new Date("2025-01-01T04:00:00Z")), "04:00 不应匹配");
    }),
  );

  // ---------- issue #2：一次性任务 day-of-month / day-of-week 约束回归 ----------
  results.push(
    await runCase("U-18", "cron", "issue#2 一次性任务：日/月字段约束生效（只触发一次）", async (t) => {
      // cron "28 1 14 8 *"：期望只在 8月14日 01:28 UTC 触发（8月14日当天一次），而非每天重复
      const ONE_SHOT = "28 1 14 8 *";
      const from = new Date("2025-08-13T00:00:00Z");
      const next = nextRun(ONE_SHOT, from);
      t.assert(next !== undefined, "应能计算下次触发");
      t.assert(
        next!.toISOString() === "2025-08-14T01:28:00.000Z",
        `期望 2025-08-14T01:28:00Z（8月14日当天一次），实际 ${next!.toISOString()}`,
      );
      // 8月其他日期（非14日）不应命中——旧实现忽略「日」字段，会在任意日期命中
      const notHit = nextRun(ONE_SHOT, new Date("2025-08-13T01:28:00Z"));
      t.assert(
        notHit!.toISOString() === "2025-08-14T01:28:00.000Z",
        `8月13日不应触发，下次仍应为 8月14日，实际 ${notHit!.toISOString()}`,
      );
      t.log(`nextRun("${ONE_SHOT}", 8/13 00:00) → ${next!.toISOString()}（仅 8月14日当天，不再每天重复）`);
    }),
  );

  results.push(
    await runCase("U-19", "cron", "issue#2 一次性任务触发后不再次日重复（fire 后重算）", async (t) => {
      const ONE_SHOT = "28 1 14 8 *";
      // 模拟在 8月14日 01:28 触发后，Scheduler 立即重算下一次触发（from = now + 1s）
      const afterFire = nextRun(ONE_SHOT, new Date("2025-08-14T01:28:30Z"));
      t.assert(afterFire !== undefined, "应能重算下次触发");
      t.assert(
        afterFire!.toISOString() === "2026-08-14T01:28:00.000Z",
        `触发后下次触发应为次年 8月14日（而非次日 8月15日），实际 ${afterFire!.toISOString()}`,
      );
      // 次日同一时刻不应再命中（旧实现：下次触发变为次日相同时间 → 每日重复）
      const nextDay = nextRun(ONE_SHOT, new Date("2025-08-15T01:28:00Z"));
      t.assert(
        nextDay!.toISOString() === "2026-08-14T01:28:00.000Z",
        `8月15日同一时刻不应触发，实际 ${nextDay!.toISOString()}`,
      );
      // 8月剩余日期（16 日起）也应跳过，直到次年 8月14日
      const later = nextRun(ONE_SHOT, new Date("2025-08-16T00:00:00Z"));
      t.assert(
        later!.toISOString() === "2026-08-14T01:28:00.000Z",
        `8月16日起应跳过当年剩余日期，实际 ${later!.toISOString()}`,
      );
      t.log("触发后重算 → 次年 8月14日；次日/当月其余日期均不再触发（不再每日重复）");
    }),
  );

  results.push(
    await runCase("U-20", "cron", "nextRun 严格返回 from 之后（同一分钟不重复触发）", async (t) => {
      // 若触发时刻恰为匹配分钟（如 10:00:00 触发后立即重算），下一次必须严格晚于该分钟
      const atExact = nextRun("0 10 * * *", new Date("2025-01-01T10:00:00Z"));
      t.assert(
        atExact!.toISOString() === "2025-01-02T10:00:00.000Z",
        `不应返回同一分钟 10:00，实际 ${atExact!.toISOString()}`,
      );
      // 触发前一刻（09:59:30）则返回当天 10:00
      const before = nextRun("0 10 * * *", new Date("2025-01-01T09:59:30Z"));
      t.assert(
        before!.toISOString() === "2025-01-01T10:00:00.000Z",
        `09:59:30 起算应得当天 10:00，实际 ${before!.toISOString()}`,
      );
      t.log("同一分钟内不再重复触发：10:00:00 起算 → 次日 10:00；09:59:30 起算 → 当天 10:00");
    }),
  );

  results.push(
    await runCase("U-21", "cron", "dom/dow Vixie 语义：周字段与日字段分别生效", async (t) => {
      // 仅指定星期（dow 受限、dom 为 *）：每周一 10:00（2025-01-06 为周一）
      const weekly = nextRun("0 10 * * 1", new Date("2025-01-01T00:00:00Z"));
      t.assert(
        weekly!.toISOString() === "2025-01-06T10:00:00.000Z",
        `每周一应命中 2025-01-06，实际 ${weekly!.toISOString()}`,
      );
      // dom 与 dow 均受限：任一匹配即触发（Vixie OR）——周一或 8月14日
      // 2025-08-11 为周一（非14日），应命中
      const monday = nextRun("0 10 14 8 1", new Date("2025-08-10T00:00:00Z"));
      t.assert(
        monday!.toISOString() === "2025-08-11T10:00:00.000Z",
        `周一（非14日）应命中，实际 ${monday!.toISOString()}`,
      );
      // 2025-08-14 为周四（14日），应命中
      const dom = nextRun("0 10 14 8 1", new Date("2025-08-12T00:00:00Z"));
      t.assert(
        dom!.toISOString() === "2025-08-14T10:00:00.000Z",
        `8月14日（周四）应命中，实际 ${dom!.toISOString()}`,
      );
      t.log("dow 受限仅按周匹配；dom+dow 均受限时任一命中（Vixie OR）");
    }),
  );

  results.push(
    await runCase("U-22", "cron", "matches 与 nextRun 日字段语义一致（一次性任务到期判断）", async (t) => {
      t.assert(matches("28 1 14 8 *", new Date("2025-08-14T01:28:00Z")), "8月14日 01:28 应匹配");
      t.assert(!matches("28 1 14 8 *", new Date("2025-08-15T01:28:00Z")), "8月15日 01:28 不应匹配（日字段约束生效）");
      t.assert(!matches("28 1 14 8 *", new Date("2025-08-14T01:29:00Z")), "分钟不匹配不应命中");
      // Vixie OR：周一或 8月14日 命中；其他日期不命中
      t.assert(matches("0 10 14 8 1", new Date("2025-08-11T10:00:00Z")), "周一（非14日）应匹配");
      t.assert(matches("0 10 14 8 1", new Date("2025-08-14T10:00:00Z")), "8月14日应匹配");
      t.assert(!matches("0 10 14 8 1", new Date("2025-08-13T10:00:00Z")), "周三（非14日非周一）不应匹配");
      t.log("matches 已与 nextRun 保持一致的 dom/dow 语义");
    }),
  );

  // ---------- 任务存储 ----------
  const storeDir = mkdtempSync(join(tmpdir(), "circle-unit-store-"));
  try {
    results.push(
      await runCase("U-12", "任务存储", "创建 / 状态流转 / 待办查询", async (t) => {
        const store = new TaskStore(storeDir);
        const task = store.create({
          title: "测试任务",
          description: "echo hi",
          status: "received",
          priority: "short",
          workerName: "dev",
          requestedBy: "user",
        });
        t.assert(task.id.startsWith("T-"), `任务编号格式: ${task.id}`);
        store.markRunning(task.id);
        store.markCompleted(task.id, "done");
        const done = store.get(task.id)!;
        t.assert(done.status === "completed", "状态应为 completed");
        t.assert(done.completedAt !== undefined, "应记录完成时间");
        t.assert(store.pending().length === 0, "待办应为空");
      }),
    );

    results.push(
      await runCase("U-13", "任务存储", "清理超过 30 天的已完成任务", async (t) => {
        const store = new TaskStore(storeDir);
        const old = store.create({
          title: "旧任务",
          description: "x",
          status: "completed",
          priority: "long",
          workerName: "dev",
          requestedBy: "user",
          completedAt: Date.now() - 40 * 24 * 3600 * 1000,
        });
        const fresh = store.create({
          title: "新任务",
          description: "x",
          status: "completed",
          priority: "short",
          workerName: "dev",
          requestedBy: "user",
          completedAt: Date.now(),
        });
        const removed = store.cleanupCompleted(30);
        t.assert(removed.some((r) => r.id === old.id), "旧任务应被清理");
        t.assert(!removed.some((r) => r.id === fresh.id), "新任务不应被清理");
        t.assert(store.get(old.id) === undefined, "旧任务记录应已删除");
        t.assert(store.get(fresh.id) !== undefined, "新任务记录应保留");
      }),
    );
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }

  // ---------- 定时任务存储 ----------
  results.push(
    await runCase("U-14", "定时任务存储", "创建 / 更新 / 删除", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-sched-"));
      try {
        const store = new ScheduleStore(dir);
        const s = store.create({
          name: "每日检查",
          cron: "0 10 * * *",
          description: "检查状态",
          workerName: "dev",
          enabled: true,
          taskIds: [],
        });
        t.assert(s.id.startsWith("S-"), `定时任务编号格式: ${s.id}`);
        store.update(s.id, { enabled: false });
        t.assert(store.get(s.id)!.enabled === false, "更新应生效");
        store.addTaskRecord(s.id, "T-1");
        t.assert(store.get(s.id)!.taskIds.length === 1, "应记录触发历史");
        store.delete(s.id);
        t.assert(store.get(s.id) === undefined, "删除应生效");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  // ---------- 工作空间 ----------
  results.push(
    await runCase("U-15", "工作空间", "Worker 独立目录 + 技能目录 + 临时空间", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-ws-"));
      try {
        const ws = new WorkspaceManager(dir);
        const w1 = ws.workerDir("worker-a");
        const w2 = ws.workerDir("worker-b");
        t.assert(w1 !== w2, "不同 Worker 目录应独立");
        writeFileSync(join(w1, "output.txt"), "a 的产出");
        const scratch = ws.taskScratchDir("worker-a", "T-1");
        writeFileSync(join(scratch, "tmp.bin"), "x");
        t.assert(ws.taskScratchDir("worker-b", "T-1") !== scratch, "任务临时空间按 Worker 隔离");
        // 产出物互不影响
        const { existsSync } = await import("node:fs");
        t.assert(!existsSync(join(w2, "output.txt")), "worker-b 不应看到 worker-a 的产出物");
        ws.removeTaskScratch("worker-a", "T-1");
        t.assert(!existsSync(join(scratch, "tmp.bin")), "临时空间应被删除");
        t.assert(existsSync(join(w1, "output.txt")), "持久产出物应保留");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  // ---------- 调度器 ----------
  results.push(
    await runCase("U-16", "Scheduler", "创建定时任务并立即触发", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-sched-"));
      try {
        const { SchedulerAgent } = await import("../src/agents/scheduler.js");
        const store = new ScheduleStore(dir);
        let fired = 0;
        const sched = new SchedulerAgent(
          store,
          { schedulerTickMs: 1000, cleanupAfterDays: 30, cleanupCron: "0 3 * * *" } as never,
          {
            runScheduled: async () => {
              fired++;
              return { taskId: "T-1" };
            },
            runDailyCleanup: async () => ({ removedTasks: 0, removedScratch: 0 }),
          },
        );
        const s = sched.create({ name: "测试", cron: "0 10 * * *", description: "d", workerName: "dev" });
        t.assert(s.nextRunAt !== undefined, "创建后应计算下次触发时间");
        await sched.fire(s);
        t.assert(fired === 1, "触发回调应被调用");
        t.assert(store.get(s.id)!.lastRunAt !== undefined, "应记录 lastRunAt");
        sched.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-23", "Scheduler", "issue#2 一次性定时任务只触发一次（不再每天重复）", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-oneshot-"));
      try {
        const { SchedulerAgent } = await import("../src/agents/scheduler.js");
        const store = new ScheduleStore(dir);
        const fired: number[] = [];
        const sched = new SchedulerAgent(
          store,
          { schedulerTickMs: 1000, cleanupAfterDays: 30, cleanupCron: "0 3 * * *" } as never,
          {
            runScheduled: async () => {
              fired.push(Date.now());
              return { taskId: `T-${fired.length}` };
            },
            runDailyCleanup: async () => ({ removedTasks: 0, removedScratch: 0 }),
          },
        );
        // 一次性任务：cron "28 1 14 8 *"（8月14日 01:28 UTC）
        const s = sched.create({
          name: "一次性提醒",
          cron: "28 1 14 8 *",
          description: "d",
          workerName: "dev",
        });
        t.assert(s.nextRunAt !== undefined, "创建后应计算下次触发");
        const firstIso = new Date(s.nextRunAt!).toISOString();
        t.assert(
          /08-14T01:28/.test(firstIso),
          `下次触发应为 8月14日 01:28，实际 ${firstIso}`,
        );

        // 模拟到达触发时刻：手动触发一次
        await sched.fire(s);
        t.assert(fired.length === 1, "一次性任务应只触发 1 次");

        const after = store.get(s.id)!;
        t.assert(after.nextRunAt !== undefined, "触发后应重算下次触发");
        const nextIso = new Date(after.nextRunAt!).toISOString();
        t.assert(
          /08-14T01:28/.test(nextIso),
          `触发后下次触发仍应为 8月14日 01:28（而非次日 8月15日），实际 ${nextIso}`,
        );
        // 旧 bug：下次触发变为「次日相同时间」（约 1 天）。修复后为同年剩余（<1天）或次年（>300 天），
        // 绝不应是 1~2 天的每日重复。
        const gapDays = (after.nextRunAt! - after.lastRunAt!) / 86_400_000;
        t.assert(
          gapDays > 300 || gapDays < 1,
          `下次触发不应为次日重复（1~2 天），实际间隔 ${gapDays.toFixed(2)} 天`,
        );

        // 模拟后续 tick：由于 nextRunAt 未到期，不应再次触发
        const beforeTick = fired.length;
        await sched.tick();
        t.assert(fired.length === beforeTick, "后续 tick 不应再次触发一次性任务");
        sched.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  // ---------- IM 测试适配器 ----------
  results.push(
    await runCase("U-17", "IM 适配器", "TestAdapter 注入与等待", async (t) => {
      const { TestAdapter } = await import("../src/im/test.js");
      const adapter = new TestAdapter();
      const received: string[] = [];
      adapter.onMessage((m) => received.push(m.text));
      await adapter.inject("c1", "你好");
      t.assert(received.length === 1 && received[0] === "你好", "注入消息应到达回调");
      await adapter.send("c1", "回复1");
      await adapter.send("c1", "回复2");
      const hit = await adapter.waitFor((x) => x.includes("回复2"), { timeoutMs: 2000 });
      t.assert(hit.includes("回复2"), "waitFor 应命中目标消息");
    }),
  );

  return results;
}

/** 独立运行入口 */
if (process.argv[1]?.endsWith("unit.test.ts")) {
  const { renderReport } = await import("./helpers.js");
  const results = await runUnitTests();
  console.log(renderReport(results));
  process.exit(results.some((r) => !r.passed && !r.skipped) ? 1 : 0);
}
