/**
 * 单元测试：安全评估 / cron / 任务存储 / 定时任务存储 / 工作空间 / IM 适配器。
 * 全部确定性执行，不依赖 LLM。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCron, nextRun, matches } from "../src/core/cron.js";
import { assessSafety } from "../src/core/safety.js";
import { TaskStore } from "../src/core/task-store.js";
import { ScheduleStore } from "../src/core/schedule-store.js";
import { WorkspaceManager } from "../src/core/workspace.js";
import { summarizeText } from "../src/team/agent-team.js";
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
    await runCase("U-08", "cron", "nextRun 计算（每天本地 10 点）", async (t) => {
      const now = new Date(2025, 0, 1, 8, 0, 0); // 本地 2025-01-01 08:00
      const next = nextRun("0 10 * * *", now);
      t.assert(next !== undefined, "应能计算下次触发");
      t.assert(
        next!.getHours() === 10 && next!.getMinutes() === 0,
        `期望本地 10:00，实际本地 ${next!.getHours()}:${String(next!.getMinutes()).padStart(2, "0")}`,
      );
      t.assert(next!.getDate() === 1, "应为当天触发");
      // 修复前按 UTC 解析会得到 10:00Z = 本地 18:00，晚 8 小时
      t.assert(next!.getTime() !== new Date("2025-01-01T10:00:00Z").getTime(), "不应按 UTC 解析触发（晚 8 小时）");
    }),
  );

  results.push(
    await runCase("U-09", "cron", "nextRun 步长表达式（每 5 分钟）", async (t) => {
      const now = new Date(2025, 0, 1, 9, 2, 0); // 本地 09:02
      const next = nextRun("*/5 * * * *", now);
      t.assert(next !== undefined, "应能计算");
      t.assert(next!.getMinutes() === 5, `期望本地 :05，实际本地 :${next!.getMinutes()}`);
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
    await runCase("U-11", "cron", "matches 判定（清理 cron 本地 03:00）", async (t) => {
      t.assert(matches("0 3 * * *", new Date(2025, 0, 1, 3, 0, 0)), "本地 03:00 应匹配");
      t.assert(!matches("0 3 * * *", new Date(2025, 0, 1, 4, 0, 0)), "本地 04:00 不应匹配");
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

    results.push(
      await runCase("U-13b", "任务存储", "启动对账：进程重启遗留的进行中任务标记为失败", async (t) => {
        const store = new TaskStore(storeDir);
        const running = store.create({
          title: "重启前执行中",
          description: "x",
          status: "running",
          priority: "long",
          workerName: "dev",
          requestedBy: "user",
        });
        const received = store.create({
          title: "重启前未开始",
          description: "x",
          status: "received",
          priority: "long",
          workerName: "dev",
          requestedBy: "user",
        });
        const done = store.create({
          title: "重启前已完成",
          description: "x",
          status: "completed",
          priority: "short",
          workerName: "dev",
          requestedBy: "user",
          completedAt: Date.now(),
        });
        const interrupted = store.reconcileInterrupted("进程重启，任务中断");
        t.assert(interrupted.length === 2, `应标记 2 个任务，实际 ${interrupted.length}`);
        t.assert(store.get(running.id)!.status === "failed", "running 任务应标记为 failed");
        t.assert(store.get(received.id)!.status === "failed", "received 任务应标记为 failed");
        t.assert(store.get(running.id)!.error?.includes("重启"), "应记录中断原因");
        t.assert(store.get(done.id)!.status === "completed", "已完成任务不受影响");
        t.assert(store.pending().length === 0, "对账后不应再有待办任务");
        // 幂等：再次对账无副作用
        t.assert(store.reconcileInterrupted("再次重启").length === 0, "再次对账不应重复标记");
      }),
    );
  } finally {
    rmSync(storeDir, { recursive: true, force: true });
  }

  // ---------- issue #1：cron 时区偏差回归（本地时区 vs UTC） ----------
  results.push(
    await runCase("U-18", "cron", "issue#1 回归：本地 09:00 触发，不再晚 8 小时（nextRun）", async (t) => {
      // 复现场景：本地 2025-01-01 00:00 起，cron "0 9 * * *" 应于当天本地 09:00 触发
      const from = new Date(2025, 0, 1, 0, 0, 0);
      const next = nextRun("0 9 * * *", from);
      t.assert(next !== undefined, "应能计算下次触发");
      const localMin = next!.getHours() * 60 + next!.getMinutes();
      t.assert(localMin === 9 * 60, `应为本地 09:00，实际本地 ${next!.getHours()}:${String(next!.getMinutes()).padStart(2, "0")}`);
      t.assert(next!.getDate() === 1, "应为当天本地 09:00 触发");
      // 旧实现按 UTC 解析：09:00Z = 本地 17:00（晚 8 小时）
      const buggyUtc = new Date("2025-01-01T09:00:00Z");
      t.assert(next!.getTime() !== buggyUtc.getTime(), `不应触发于 09:00Z（=本地 17:00，晚 8 小时），实际 ${next!.toISOString()}`);
      t.log(`nextRun("0 9 * * *", 本地 00:00) → ${next!.toLocaleString("zh-CN")}（本地 09:00，不再晚 8 小时）`);
    }),
  );

  results.push(
    await runCase("U-19", "cron", "issue#1 回归：matches 按本地时区判定", async (t) => {
      // 本地 09:00 应匹配 "0 9 * * *"
      t.assert(matches("0 9 * * *", new Date(2025, 0, 1, 9, 0, 0)), "本地 09:00 应匹配 0 9 * * *");
      // 本地 17:00 不应匹配（旧逻辑按 UTC 会把本地 17:00 当作 09:00Z 误匹配）
      t.assert(!matches("0 9 * * *", new Date(2025, 0, 1, 17, 0, 0)), "本地 17:00 不应匹配 0 9 * * *");
      // 每日清理 cron 也按本地时间判定
      t.assert(matches("0 3 * * *", new Date(2025, 0, 1, 3, 0, 0)), "本地 03:00 应匹配清理 cron");
      t.assert(!matches("0 3 * * *", new Date(2025, 0, 1, 11, 0, 0)), "本地 11:00 不应匹配清理 cron");
      t.log("matches 已按本地时区判定，旧 UTC 误匹配已消除");
    }),
  );

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

  // ---------- 汇报摘要 ----------
  results.push(
    await runCase("U-14c", "汇报摘要", "长文本头尾兼顾，短文本原样返回", async (t) => {
      // 短文本：原样返回
      const short = "短结果：已完成，产出 data.csv";
      t.assert(summarizeText(short) === short, "短文本应原样返回");
      // 长文本：头尾保留 + 省略标记
      const head = "H".repeat(2000);
      const mid = "M".repeat(5000);
      const tail = "T-结论".repeat(1000); // 4000 字符（关键结论应在尾部）
      const long = head + mid + tail; // 11000 字符
      const s = summarizeText(long);
      t.assert(s.length < long.length, "长文本应被压缩");
      t.assert(s.startsWith("H".repeat(1500)), "应保留头部（过程开头）");
      t.assert(s.endsWith("T-结论".repeat(375)), "应保留尾部（关键结论）");
      t.assert(s.includes("中间省略 8000 字符"), "省略字符数应正确");
      t.assert(s.includes("完整结果已存储"), "应说明完整结果已存储");
      // 自定义阈值（失败兜底路径）
      const s2 = summarizeText(long, { maxChars: 500, headChars: 200, tailChars: 200 });
      t.assert(s2.includes("中间省略 10600 字符"), "自定义阈值下省略数应正确");
    }),
  );

  // ---------- 工作空间 ----------
  results.push(
    await runCase("U-15", "工作空间", "Worker 独立目录 + 任务级会话工作空间隔离 + 产出物归档", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-ws-"));
      const agentDir = mkdtempSync(join(tmpdir(), "circle-unit-agent-"));
      try {
        const ws = new WorkspaceManager(dir, agentDir);
        const w1 = ws.workerDir("worker-a");
        const w2 = ws.workerDir("worker-b");
        t.assert(w1 !== w2, "不同 Worker 目录应独立");
        writeFileSync(join(w1, "output.txt"), "a 的产出");
        // 用户级技能目录（~/.pi/agent/skills 的替身）
        const agentSkills = join(agentDir, "skills");
        mkdirSync(agentSkills, { recursive: true });
        writeFileSync(join(agentSkills, "user-skill.md"), "user skill probe");
        // 任务工作空间：按 Worker 与按任务双重隔离
        const wsA1 = ws.taskWorkspaceDir("worker-a", "T-1");
        const wsA2 = ws.taskWorkspaceDir("worker-a", "T-2");
        const wsB1 = ws.taskWorkspaceDir("worker-b", "T-1");
        writeFileSync(join(wsA1, "out.txt"), "T-1 的产出");
        t.assert(wsA1 !== wsA2, "同一 Worker 的不同任务工作空间应隔离");
        t.assert(wsA1 !== wsB1, "不同 Worker 的同名任务工作空间应隔离");
        t.assert(!existsSync(join(wsA2, "out.txt")), "任务 T-2 不应看到任务 T-1 的产出");
        t.assert(!existsSync(join(w2, "output.txt")), "worker-b 不应看到 worker-a 的产出物");
        // 技能软链接：任务工作空间内 .pi/skills 指向 Worker 技能目录
        const skillsLink = join(wsA1, ".pi", "skills");
        t.assert(lstatSync(skillsLink).isSymbolicLink(), "任务工作空间内应有技能软链接");
        const skillsReal = join(w1, ".pi", "skills");
        t.assert(readlinkSync(skillsLink) === skillsReal, "技能软链接应指向 Worker 技能目录");
        // 用户级技能软链接：.pi/agent-skills 指向 agentDir/skills
        const agentSkillsLink = join(wsA1, ".pi", "agent-skills");
        t.assert(lstatSync(agentSkillsLink).isSymbolicLink(), "任务工作空间内应有用户级技能软链接");
        t.assert(readlinkSync(agentSkillsLink) === agentSkills, "用户级技能软链接应指向 agentDir/skills");
        // 技能文件通过软链接可见（写入技能目录后任务工作空间内应能看到）
        writeFileSync(join(skillsReal, "probe-skill.md"), "probe");
        t.assert(existsSync(join(skillsLink, "probe-skill.md")), "技能文件应通过软链接可见");
        t.assert(existsSync(join(agentSkillsLink, "user-skill.md")), "用户级技能文件应通过软链接可见");
        // 完成后归档产出物：tasks/<id> → outputs/<id>
        const archived = ws.archiveTaskOutput("worker-a", "T-1");
        t.assert(archived.endsWith(join("outputs", "T-1")), "产出物应归档到 outputs/<taskId>");
        t.assert(existsSync(join(archived, "out.txt")), "归档后产出文件应存在");
        t.assert(!existsSync(wsA1), "归档后原任务工作空间应被移除");
        t.assert(!existsSync(join(archived, ".pi")), "产出物目录不应包含技能软链接");
        // 删除任务工作空间
        ws.removeTaskWorkspace("worker-a", "T-2");
        t.assert(!existsSync(wsA2), "任务工作空间应被删除");
        t.assert(existsSync(join(archived, "out.txt")), "产出物目录（持久）应保留");
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
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
            runDailyCleanup: async () => ({ removedTasks: 0, removedWorkspaces: 0 }),
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
