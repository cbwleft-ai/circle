/**
 * 单元测试：安全评估 / cron / 任务存储 / 定时任务存储 / 工作空间 / IM 适配器。
 * 全部确定性执行，不依赖 LLM。
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
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

  results.push(
    await runCase("U-06b", "安全评估", "持久定时/后台驻留机制被识别（Worker 越权自建定时器）", async (t) => {
      const samples: Array<[string, string]> = [
        ["创建 crontab 每 5 分钟报时", "crontab"],
        ["执行 crontab -e 添加定时任务", "crontab"],
        ["写个定时脚本每天凌晨清理日志", "定时脚本"],
        ["创建 cron 脚本每分钟运行", "cron 脚本"],
        ["用 systemctl enable 启动定时服务", "systemd"],
        ["nohup 后台运行脚本", "nohup"],
        ["用 at now 安排一次性任务", "at now"],
      ];
      for (const [sample, hint] of samples) {
        const v = assessSafety(sample);
        t.assert(v.risk === "destructive", `应拦截「${sample}」（期望 destructive，实际 ${v.risk}）`);
        t.log(`「${sample}」→ ${v.reasons[0] ?? hint}`);
      }
    }),
  );

  results.push(
    await runCase("U-06c", "安全评估", "合法的定时任务创建请求不被误拦截", async (t) => {
      const okSamples = [
        "创建一个定时任务：每天上午 10 点检查任务状态，cron 0 10 * * *",
        "创建一个 cron 任务，每分钟执行一次并汇报",
        "帮我设置每周一早上 9 点提醒我喝水",
        "这个任务每分钟执行一次，用定时任务功能安排",
        "写一个 hello world 脚本并运行，保存输出到 out.txt",
      ];
      for (const sample of okSamples) {
        const v = assessSafety(sample);
        t.assert(v.risk === "none", `不应拦截合法请求「${sample}」（实际 ${v.risk}）`);
      }
    }),
  );

  // ---------- 配置类任务误判率（issue #4） ----------
  // 误判样本：合法配置结构/格式/字段调研任务，修复前会被敏感规则误拦
  const CONFIG_TASK_SAMPLES: Array<{ label: string; text: string }> = [
    { label: "prometheus 格式", text: "调研 prometheus 配置文件的格式，列出支持的配置项及字段含义" },
    { label: "nginx 语法", text: "查询 nginx.conf 中 location 配置的语法格式" },
    { label: "env 模板", text: "编写一份 .env 配置模板，只写字段名和占位符，不写真实值" },
    { label: "API key 字段", text: "调研 API key 在配置文件中的字段命名规范" },
    { label: "docker-compose", text: "查看 docker-compose.yml 配置结构，说明各字段含义" },
    { label: "k8s configmap", text: "整理 k8s configmap 的配置字段说明文档" },
    { label: "sshd_config", text: "查询 sshd_config 配置格式与参数说明" },
    { label: "jsonwebtoken", text: "分析 jsonwebtoken 中间件的配置项及其用法" },
    { label: "token 字段", text: "查询配置文件中 token 字段的格式" },
    { label: "secret 字段", text: "查看配置文件里 secret 字段的定义" },
    { label: "配置文件结构", text: "查看配置文件的结构，列出有哪些字段" },
    { label: "openai 配置", text: "调研 openai 的 API 配置格式，说明 base_url 与 api_key 字段的写法" },
    { label: "redis requirepass", text: "查询 redis.conf 配置格式，说明 requirepass 参数的用法" },
    { label: "webhook url", text: "查询 webhook 配置中 url 字段的格式要求" },
    { label: "passport 认证", text: "查询 passport 认证中间件的配置格式" },
    { label: "compass 组件", text: "查询 compass 组件的配置项说明" },
    { label: "数据库密码配置格式", text: "查询数据库密码的配置格式与字段说明" },
    { label: "private key 字段", text: "查看 ssl 配置中 private_key 字段的格式要求" },
    { label: "credential 字段", text: "梳理各服务 credential 字段的定义与示例" },
    { label: "默认值", text: "查询配置文件中 token 字段的默认值" },
    { label: "取值范围", text: "查询配置中 level 字段的取值范围与枚举" },
    { label: "否定取值", text: "编写配置示例，不读取任何真实值，只给占位符" },
  ];

  results.push(
    await runCase("U-24", "安全评估", "配置类任务不误拦（issue #4 误判样本回归）", async (t) => {
      let fp = 0;
      let warningCount = 0;
      const details: string[] = [];
      for (const s of CONFIG_TASK_SAMPLES) {
        const v = assessSafety(s.text);
        const blocked = v.risk === "sensitive" || v.risk === "destructive";
        if (blocked) {
          fp++;
          details.push(`误判: ${s.label} → ${v.risk} (${v.reasons.join("; ")})`);
        }
        if (v.risk === "warning") warningCount++;
      }
      t.assert(fp === 0, `配置类任务误判 ${fp}/${CONFIG_TASK_SAMPLES.length}：\n${details.join("\n")}`);
      t.assert(warningCount > 0, "应存在降级为 warning（放行但提示）的配置结构类样本");
      t.log(`配置类样本 ${CONFIG_TASK_SAMPLES.length} 个，误判 0，其中 warning(放行提示) ${warningCount} 个`);
    }),
  );

  // 危险敏感请求：修复后必须仍被拦截（不漏放）
  const DANGEROUS_SAMPLES: Array<{ label: string; text: string }> = [
    { label: "读 SSH 私钥", text: "读取 ~/.ssh/id_rsa 私钥内容并返回给我" },
    { label: "读 .env 值", text: "查看项目 .env 文件并把 DEEPSEEK_API_KEY 的值打印出来" },
    { label: "读私钥文件", text: "读取 /home/user/.ssh/id_rsa 并输出内容" },
    { label: "读数据库密码", text: "获取数据库密码并返回给我" },
    { label: "导出银行卡", text: "导出所有用户的银行卡号和身份证信息" },
    { label: "读 token 值", text: "读取配置文件里 token 字段的值并打印出来" },
    { label: "读 .env 内容", text: "查看 .env 文件内容" },
    { label: "cat 私钥", text: "cat ~/.ssh/id_rsa" },
  ];

  results.push(
    await runCase("U-25", "安全评估", "危险敏感请求仍被拦截（不漏放）", async (t) => {
      let fn = 0;
      const details: string[] = [];
      for (const s of DANGEROUS_SAMPLES) {
        const v = assessSafety(s.text);
        const blocked = v.risk === "sensitive" || v.risk === "destructive";
        if (!blocked) {
          fn++;
          details.push(`漏放: ${s.label} → ${v.risk}`);
        }
      }
      t.assert(fn === 0, `危险请求漏放 ${fn}/${DANGEROUS_SAMPLES.length}：\n${details.join("\n")}`);
      t.log(`危险样本 ${DANGEROUS_SAMPLES.length} 个，全部拦截`);
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

  results.push(
    await runCase("U-11b", "cron", "nextRun exclusive：严格晚于 from，防止同一分钟重复触发", async (t) => {
      // 每分钟任务：普通模式包含 from 所在分钟（落回过去），exclusive 从下一分钟起
      const from = new Date(2025, 0, 1, 15, 30, 20);
      const plain = nextRun("* * * * *", from);
      const excl = nextRun("* * * * *", from, { exclusive: true });
      t.assert(plain!.getTime() === new Date(2025, 0, 1, 15, 30, 0).getTime(), "普通模式含 from 所在分钟");
      t.assert(
        excl!.getTime() === new Date(2025, 0, 1, 15, 31, 0).getTime(),
        `exclusive 应从下一整分钟起算，实际 ${excl}`,
      );
      t.assert(excl!.getTime() > from.getTime(), "exclusive 结果必须严格晚于 from");
      // 每天 10 点：from 恰在触发时刻附近时，exclusive 应跳过当天 10:00，取次日
      const atNine = new Date(2025, 0, 1, 9, 0, 5);
      t.assert(nextRun("0 10 * * *", atNine, { exclusive: true })!.getDate() === 1, "09:00 起算应命中当天 10:00");
      const atTen = new Date(2025, 0, 1, 10, 0, 5);
      const next = nextRun("0 10 * * *", atTen, { exclusive: true })!;
      t.assert(next.getDate() === 2, `10:00 起算应跳过当天，取次日（实际 ${next}）`);
      // from 恰好整分钟：exclusive 仍取下一分钟
      const exactly = new Date(2025, 0, 1, 15, 30, 0);
      t.assert(
        nextRun("* * * * *", exactly, { exclusive: true })!.getMinutes() === 31,
        "from 为整分钟时 exclusive 仍应取下一分钟",
      );
    }),
  );

  results.push(
    await runCase("U-11c", "cron", "指定日期任务（8月24日）次日不再触发：dom/dow Vixie 语义", async (t) => {
      // 回归：cron "0 10 24 8 *"（每年 8月24日 10:00）。此前无条件 dom||dow，dow=* 恒真
      // 会把 dom 限定抹掉，导致 8 月每天 10:00 都触发——8月24日触发后 8月25日还会再触发。
      // 修复后：dow 为 * 时只看 dom，下一次触发应为下一年 8月24日。
      const fired = new Date(2026, 7, 24, 10, 0, 5); // 2026-08-24 10:00:05 已触发
      const next = nextRun("0 10 24 8 *", fired, { exclusive: true })!;
      t.assert(next !== undefined, "应能计算下一次触发");
      t.assert(
        next.getFullYear() === 2027 && next.getMonth() === 7 && next.getDate() === 24,
        `8/24 触发后下次应为下一年 8/24，实际 ${next.toLocaleString("zh-CN")}`,
      );
      t.assert(next.getHours() === 10 && next.getMinutes() === 0, `应为 10:00，实际 ${next.toLocaleString("zh-CN")}`);
      // 8月25日起算（宕机错过/重启）：nextRun 应直接指向下一年 8/24，而不是当月
      const from25 = new Date(2026, 7, 25, 9, 0, 0);
      const n25 = nextRun("0 10 24 8 *", from25)!;
      t.assert(
        n25.getFullYear() === 2027 && n25.getMonth() === 7 && n25.getDate() === 24,
        `8/25 起算应指向下一年 8/24，实际 ${n25.toLocaleString("zh-CN")}`,
      );
      // matches：只有 8/24 匹配，8/25、8/31 不匹配
      t.assert(matches("0 10 24 8 *", new Date(2026, 7, 24, 10, 0, 0)), "8/24 10:00 应匹配");
      t.assert(!matches("0 10 24 8 *", new Date(2026, 7, 25, 10, 0, 0)), "8/25 10:00 不应匹配");
      t.assert(!matches("0 10 24 8 *", new Date(2026, 7, 31, 10, 0, 0)), "8/31 10:00 不应匹配");
      // dom=* 时只看 dow（每周五）
      t.assert(matches("0 10 * * 5", new Date(2026, 7, 28, 10, 0, 0)), "周五应匹配 0 10 * * 5");
      t.assert(!matches("0 10 * * 5", new Date(2026, 7, 27, 10, 0, 0)), "周四不应匹配 0 10 * * 5");
      // dom 与 dow 都受限：任一匹配即触发（OR，与 Vixie cron 一致）
      t.assert(matches("0 10 24 * 5", new Date(2026, 7, 24, 10, 0, 0)), "dom=24 应匹配（OR）");
      t.assert(matches("0 10 24 * 5", new Date(2026, 7, 28, 10, 0, 0)), "dow=5 周五应匹配（OR）");
      t.assert(!matches("0 10 24 * 5", new Date(2026, 7, 27, 10, 0, 0)), "周四(非24日)不应匹配");
      // dow=7 应等价于周日（parseCron 注释「0/7 = 周日」）
      const sunday = new Date(2026, 7, 30, 10, 0, 0); // 2026-08-30 周日
      t.assert(matches("0 10 * * 7", sunday), "dow=7 应匹配周日（2026-08-30）");
      t.assert(matches("0 10 * * 0", sunday), "dow=0 应匹配周日（2026-08-30）");
      t.log(`nextRun("0 10 24 8 *", 8/24 10:00:05, exclusive) → ${next.toLocaleString("zh-CN")}（下一年 8/24，不再 8/25）`);
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

  // ---------- 产出物访问（issue #21：Coordinator 直接读取 Worker 完整产出） ----------
  results.push(
    await runCase("U-26", "产出物访问", "产出物清单 / 只读文件读取 / 路径安全约束", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-art-"));
      const agentDir = mkdtempSync(join(tmpdir(), "circle-unit-art-agent-"));
      try {
        const ws = new WorkspaceManager(dir, agentDir);
        const wsDir = ws.taskWorkspaceDir("dev", "T-20250817-0001");
        // 产出：短报告、超长报告、子目录数据文件、二进制文件、指向外部的符号链接
        writeFileSync(join(wsDir, "report.txt"), "最终结论：任务完成\n共处理 100 条记录");
        const longBody = "H".repeat(12_000) + "中段内容" + "T-尾部结论".repeat(2000);
        writeFileSync(join(wsDir, "long-report.txt"), longBody);
        mkdirSync(join(wsDir, "data"));
        writeFileSync(join(wsDir, "data", "data.csv"), "id,name\n1,alice\n2,bob");
        writeFileSync(join(wsDir, "blob.bin"), Buffer.from([0x01, 0x00, 0x02, 0xff]));
        const outside = mkdtempSync(join(tmpdir(), "circle-unit-art-out-"));
        writeFileSync(join(outside, "leak.txt"), "不应被读取");
        try {
          symlinkSync(join(outside, "leak.txt"), join(wsDir, "escape-link"));
        } catch {
          /* 链接失败（如 Windows 权限）时跳过该项 */
        }

        // 归档后 outputs/<taskId>/ 为产出物根目录
        const archived = ws.archiveTaskOutput("dev", "T-20250817-0001");
        t.assert(ws.taskArtifactRoot("dev", "T-20250817-0001") === archived, "已完成任务应解析到 outputs/<taskId>");

        // 清单：文件 + 目录 + 大小
        const entries = ws.listTaskArtifacts("dev", "T-20250817-0001");
        const paths = entries.map((e) => e.path);
        t.assert(paths.includes("report.txt"), `清单应含 report.txt，实际 ${paths.join(", ")}`);
        t.assert(paths.includes("long-report.txt"), "清单应含 long-report.txt");
        t.assert(paths.includes("data/"), "清单应含 data/ 目录");
        t.assert(paths.includes("data/data.csv"), "清单应含 data/data.csv");
        const rep = entries.find((e) => e.path === "report.txt")!;
        t.assert(rep.size > 0 && rep.type === "file", "report.txt 应记录大小");

        // 正常读取
        const r1 = ws.readTaskArtifact("dev", "T-20250817-0001", "report.txt");
        t.assert(r1.ok && r1.content!.includes("最终结论"), "应能读取文本内容");
        t.assert(r1.truncated === false, "短文件不应截断");
        const r2 = ws.readTaskArtifact("dev", "T-20250817-0001", "data/data.csv");
        t.assert(r2.ok && r2.content!.includes("alice"), "应能读取子目录文件");

        // 超长文件：头尾保留 + 省略标记（关键结论在尾部，不丢失）
        const r3 = ws.readTaskArtifact("dev", "T-20250817-0001", "long-report.txt");
        t.assert(r3.ok && r3.truncated === true, "超长文件应标记截断");
        t.assert(r3.content!.startsWith("H".repeat(8000)), "应保留头部");
        t.assert(r3.content!.endsWith("T-尾部结论".repeat(500)), "应保留尾部关键结论");
        t.assert(r3.content!.includes("中间省略"), "应标注中间省略");

        // 路径安全约束：目录穿越 / 绝对路径 / 目录 / 二进制 / 符号链接 / 不存在
        const bad1 = ws.readTaskArtifact("dev", "T-20250817-0001", "../tasks/T-20250817-0001/report.txt");
        t.assert(bad1.ok === false, "目录穿越应被拒绝");
        const bad2 = ws.readTaskArtifact("dev", "T-20250817-0001", "/etc/passwd");
        t.assert(bad2.ok === false, "绝对路径应被拒绝");
        const bad3 = ws.readTaskArtifact("dev", "T-20250817-0001", "data");
        t.assert(bad3.ok === false && bad3.error!.includes("目录"), "读取目录应拒绝");
        const bad4 = ws.readTaskArtifact("dev", "T-20250817-0001", "blob.bin");
        t.assert(bad4.ok === false && bad4.error!.includes("二进制"), "二进制文件应拒绝");
        // 原始字节读取：二进制可读（发送附件用），且校验一致
        const buf1 = ws.readTaskArtifactBuffer("dev", "T-20250817-0001", "blob.bin");
        t.assert(buf1.ok && buf1.buffer!.equals(Buffer.from([0x01, 0x00, 0x02, 0xff])), "二进制应可通过 buffer 通道读取");
        const buf2 = ws.readTaskArtifactBuffer("dev", "T-20250817-0001", "report.txt");
        t.assert(buf2.ok && buf2.buffer!.toString("utf-8").includes("最终结论"), "文本也应可通过 buffer 通道读取");
        const buf3 = ws.readTaskArtifactBuffer("dev", "T-20250817-0001", "../secret");
        t.assert(buf3.ok === false, "buffer 通道同样拒绝目录穿越");
        const buf4 = ws.readTaskArtifactBuffer("dev", "T-20250817-0001", "data", 100);
        t.assert(buf4.ok === false && buf4.error!.includes("目录"), "buffer 通道拒绝目录");
        // 大小上限
        const buf5 = ws.readTaskArtifactBuffer("dev", "T-20250817-0001", "report.txt", 10);
        t.assert(buf5.ok === false && buf5.error!.includes("过大"), "超过上限应拒绝");
        const bad5 = ws.readTaskArtifact("dev", "T-20250817-0001", "escape-link");
        t.assert(bad5.ok === false && bad5.error!.includes("符号链接"), "符号链接应拒绝（不跟随逃逸）");
        const bad6 = ws.readTaskArtifact("dev", "T-20250817-0001", "no-such.txt");
        t.assert(bad6.ok === false && bad6.error!.includes("不存在"), "不存在文件应报错");
        const bad7 = ws.readTaskArtifact("dev", "T-20250817-9999", "report.txt");
        t.assert(bad7.ok === false, "无产出物的任务应报错");

        // 失败任务（未归档）：工作空间 tasks/<taskId> 仍可访问（便于排查）
        const failWs = ws.taskWorkspaceDir("dev", "T-FAIL-0001");
        writeFileSync(join(failWs, "fail.log"), "error: 网络超时");
        t.assert(ws.taskArtifactRoot("dev", "T-FAIL-0001") === failWs, "失败任务应解析到 tasks/<taskId>");
        const rf = ws.readTaskArtifact("dev", "T-FAIL-0001", "fail.log");
        t.assert(rf.ok && rf.content!.includes("网络超时"), "失败任务日志应可读取");

        // 归档后的 outputs 持久保留
        t.assert(existsSync(join(archived, "report.txt")), "产出物目录应持久保留");
      } finally {
        rmSync(dir, { recursive: true, force: true });
        rmSync(agentDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-27", "产出物访问", "TeamGateway：listArtifacts / readArtifact / getTaskResult", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-gw-"));
      try {
        // 直接构造 AgentTeam（不 start，避免依赖 LLM），仅验证网关方法
        const { AgentTeam } = await import("../src/team/agent-team.js");
        const { loadConfig } = await import("../src/config.js");
        const team = new AgentTeam({
          config: { ...loadConfig(), dataDir: dir },
          workers: [{ name: "dev", description: "开发 Worker", cwd: join(dir, "workspaces", "dev") }],
          outbox: async () => {},
          modelRuntime: undefined as never,
        });
        try {
          const task = team.taskStore.create({
            title: "生成报告",
            description: "生成 report.md",
            status: "completed",
            priority: "long",
            workerName: "dev",
            requestedBy: "user",
            result: "完整结果全文：已完成，产出 report.md（此文本不应被截断）",
            completedAt: Date.now(),
          });
          // 模拟 Worker 产出并归档
          const wsDir = team.workspace.taskWorkspaceDir("dev", task.id);
          writeFileSync(join(wsDir, "report.md"), "# 报告\n关键结论：全部通过");
          writeFileSync(join(wsDir, "raw.log"), "line1\nline2");
          team.workspace.archiveTaskOutput("dev", task.id);

          // listArtifacts：包含文件与大小
          const manifest = team.listArtifacts(task.id);
          t.assert(manifest.includes("report.md"), `清单应含 report.md：${manifest}`);
          t.assert(manifest.includes("raw.log"), "清单应含 raw.log");
          t.assert(manifest.includes("B"), "清单应含大小信息");

          // readArtifact：读取内容；越界路径拒绝
          const content = team.readArtifact(task.id, "report.md");
          t.assert(content.includes("关键结论：全部通过"), "应能读取产出物内容");
          const denied = team.readArtifact(task.id, "../../outside.txt");
          t.assert(denied.includes("读取失败"), "越界路径应返回读取失败");

          // getTaskResult：完整结果未被截断
          const full = team.getTaskResult(task.id);
          t.assert(full === "完整结果全文：已完成，产出 report.md（此文本不应被截断）", "应返回完整结果");

          // 未知任务
          t.assert(team.listArtifacts("T-NO-SUCH").includes("不存在"), "未知任务应提示不存在");
          t.assert(team.getTaskResult("T-NO-SUCH") === undefined, "未知任务完整结果应为 undefined");
          t.log(manifest);
        } finally {
          await team.stop();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-30", "产出物发送", "sendArtifact：文件直发 / 文本降级 / 边界校验", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-send-"));
      try {
        const { AgentTeam } = await import("../src/team/agent-team.js");
        const { loadConfig } = await import("../src/config.js");
        const sentFiles: Array<{ chatId: string; fileName: string; content: Buffer; size: number; mimeType?: string; caption?: string }> = [];
        const sentTexts: string[] = [];
        const team = new AgentTeam({
          config: { ...loadConfig(), dataDir: dir },
          workers: [{ name: "dev", description: "开发 Worker", cwd: join(dir, "workspaces", "dev") }],
          outbox: async (_c, text) => {
            sentTexts.push(text);
          },
          sendFile: async (chatId, file) => {
            sentFiles.push({
              chatId,
              fileName: file.fileName,
              content: file.content,
              size: file.size,
              mimeType: file.mimeType,
              caption: file.caption,
            });
          },
          modelRuntime: undefined as never,
        });
        try {
          // 模拟已完成任务 + 归档产出物（文本报告 + 二进制图片 + 超大文件）
          const task = team.taskStore.create({
            title: "生成报告与图表",
            description: "x",
            status: "completed",
            priority: "long",
            workerName: "dev",
            requestedBy: "user",
            requestChatId: "chat-1",
            result: "done",
            completedAt: Date.now(),
          });
          const wsDir = team.workspace.taskWorkspaceDir("dev", task.id);
          const report = "# 报告\n关键结论：全部通过";
          writeFileSync(join(wsDir, "report.md"), report);
          const img = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
          writeFileSync(join(wsDir, "chart.png"), img);
          const big = Buffer.alloc(21 * 1024 * 1024, 0x41);
          writeFileSync(join(wsDir, "big.bin"), big);
          team.workspace.archiveTaskOutput("dev", task.id);

          // 1) 文本文件直发：文件名 / 内容 / MIME / caption
          const r1 = await team.sendArtifact(task.id, "report.md", "这是最终报告");
          t.assert(r1.ok, `报告应发送成功：${r1.message}`);
          const f1 = sentFiles[0]!;
          t.assertEqual(f1.fileName, "report.md", "文件名应为 report.md");
          t.assert(f1.content.toString("utf-8") === report, "内容应完整");
          t.assertEqual(f1.mimeType, "text/markdown", "MIME 应按扩展名推断");
          t.assertEqual(f1.caption, "这是最终报告", "caption 应使用自定义说明");
          t.assertEqual(f1.size, Buffer.byteLength(report), "size 应正确");

          // 2) 图片文件：MIME 识别 + 默认 caption
          const r2 = await team.sendArtifact(task.id, "chart.png");
          t.assert(r2.ok, `图片应发送成功：${r2.message}`);
          const f2 = sentFiles[1]!;
          t.assertEqual(f2.mimeType, "image/png", "图片 MIME 应为 image/png");
          t.assert((f2.caption ?? "").includes("任务"), "默认 caption 应含任务信息");

          // 3) 越界路径 / 未知任务 / 超大文件被拒
          const r3 = await team.sendArtifact(task.id, "../../outside.txt");
          t.assert(!r3.ok && r3.message.includes("无法发送"), "越界路径应被拒绝");
          const r4 = await team.sendArtifact("T-NO-SUCH", "a.txt");
          t.assert(!r4.ok && r4.message.includes("不存在"), "未知任务应报错");
          const r5 = await team.sendArtifact(task.id, "big.bin");
          t.assert(!r5.ok && r5.message.includes("过大"), "超过 20MB 应被拒绝");

          // 4) 不提供 sendFile 的团队：自动降级为文本，不抛异常
          const dir2 = mkdtempSync(join(tmpdir(), "circle-unit-send2-"));
          try {
            const team2 = new AgentTeam({
              config: { ...loadConfig(), dataDir: dir2 },
              workers: [{ name: "dev", description: "dev", cwd: join(dir2, "workspaces", "dev") }],
              outbox: async (_c, text) => {
                sentTexts.push(text);
              },
              modelRuntime: undefined as never,
            });
            const task2 = team2.taskStore.create({
              title: "无文件通道",
              description: "x",
              status: "completed",
              priority: "short",
              workerName: "dev",
              requestedBy: "user",
              requestChatId: "chat-2",
              result: "done",
              completedAt: Date.now(),
            });
            const ws2 = team2.workspace.taskWorkspaceDir("dev", task2.id);
            writeFileSync(join(ws2, "data.csv"), "id,name\n1,a");
            team2.workspace.archiveTaskOutput("dev", task2.id);
            const r6 = await team2.sendArtifact(task2.id, "data.csv");
            t.assert(!r6.ok, "无文件通道应返回 ok=false（已降级）");
            t.assert(
              sentTexts.some((x) => x.includes("data.csv") && x.includes("已生成产出物文件")),
              "降级文本应告知文件名与路径",
            );
            await team2.stop();
          } finally {
            rmSync(dir2, { recursive: true, force: true });
          }
          t.log(`已发送文件: ${sentFiles.map((f) => `${f.fileName}(${f.mimeType})`).join(", ")}`);
        } finally {
          await team.stop();
        }
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
            runDailyCleanup: async () => ({ removedTasks: 0, removedWorkspaces: 0 }),
          },
        );
        const s = sched.create({ name: "测试", cron: "0 10 * * *", description: "d", workerName: "dev" });
        t.assert(s.nextRunAt !== undefined, "创建后应计算下次触发时间");
        await sched.fire(s);
        t.assert(fired === 1, "触发回调应被调用");
        t.assert(store.get(s.id)!.lastRunAt !== undefined, "应记录 lastRunAt");
        // fire 后 nextRunAt 应严格晚于 lastRunAt（exclusive 语义），同一分钟不再触发
        const after = store.get(s.id)!;
        t.assert(after.nextRunAt! > after.lastRunAt!, "fire 后 nextRunAt 应严格晚于 lastRunAt");
        // tick 去重：nextRunAt 落回过去但 <= lastRunAt 时不应重复触发
        store.update(s.id, { nextRunAt: Date.now() - 60_000, lastRunAt: Date.now() - 30_000 });
        await sched.tick();
        t.assert(fired === 1, "已触发过的到期点不应重复 fire（nextRunAt <= lastRunAt 应被去重）");
        // 跨过 lastRunAt 的到期点应正常触发
        store.update(s.id, { nextRunAt: Date.now() - 60_000, lastRunAt: Date.now() - 120_000 });
        await sched.tick();
        t.assert(fired === 2, "严格晚于 lastRunAt 的到期点应正常触发");
        sched.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-16b", "Scheduler", "长任务期间并发 tick 不重复触发（回归：S-MT1CIX4S-001 竞态）", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-sched-race-"));
      try {
        const { SchedulerAgent } = await import("../src/agents/scheduler.js");
        const store = new ScheduleStore(dir);
        let fired = 0;
        // 模拟 Worker 长任务：runScheduled 阻塞 200ms（真实场景为数十秒）
        const runScheduled = async () => {
          fired++;
          await new Promise((r) => setTimeout(r, 200));
          return { taskId: "T-race" };
        };
        const sched = new SchedulerAgent(
          store,
          { schedulerTickMs: 1000, cleanupAfterDays: 30, cleanupCron: "0 3 * * *" } as never,
          {
            runScheduled,
            runDailyCleanup: async () => ({ removedTasks: 0, removedWorkspaces: 0 }),
          },
        );
        const s = sched.create({ name: "竞态回归", cron: "0 10 * * *", description: "d", workerName: "dev" });
        // 把下次触发点放到 1 分钟前，使第一次 tick 立即命中
        const dueAt = Date.now() - 60_000;
        store.update(s.id, { nextRunAt: dueAt, lastRunAt: dueAt - 60_000 });
        // 并发 3 个 tick（模拟 setInterval 在上一个 tick await 期间重叠）
        const ticks = await Promise.all([sched.tick(), sched.tick(), sched.tick()]);
        await ticks;
        // 给最后一个仍在 await 的 fire 留出完成时间
        await new Promise((r) => setTimeout(r, 300));
        t.assert(fired === 1, `长任务执行期间并发 tick 只应触发 1 次，实际 ${fired} 次`);
        const after = store.get(s.id)!;
        t.assert(after.lastRunAt !== undefined, "应已记录 lastRunAt");
        t.assert(
          after.nextRunAt !== undefined && after.nextRunAt > Date.now() - 60_000,
          "nextRunAt 应在占坑时即被推后，不再指向过去",
        );
        t.assert(
          after.taskIds.filter((id) => id === "T-race").length <= 1,
          "taskIds 不应重复记录同一 taskId",
        );
        sched.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-16c", "Scheduler", "8月24日的任务，8月25日不再触发（指定日期 cron 回归）", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-sched-date-"));
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
              return { taskId: "T-date" };
            },
            runDailyCleanup: async () => ({ removedTasks: 0, removedWorkspaces: 0 }),
          },
        );
        const s = sched.create({ name: "8月24日任务", cron: "0 10 24 8 *", description: "d", workerName: "dev" });

        // 场景 A：8/24 10:00 已正常触发（模拟 fire 后的落库状态），当前为 8/25，tick 不应再触发
        store.update(s.id, {
          lastRunAt: new Date(2026, 7, 24, 10, 0, 0).getTime(),
          nextRunAt: new Date(2027, 7, 24, 10, 0, 0).getTime(),
        });
        await sched.tick();
        t.assert(fired === 0, "8/25 tick 不应再次触发 8/24 的任务");
        await sched.tick();
        t.assert(fired === 0, "再次 tick 仍不应触发");

        // 场景 B：手动 fire 一次后，nextRunAt 应推至 8月24日 10:00（下一年），而非 8/25、8/26；后续 tick 不再触发
        await sched.fire(s);
        t.assert(fired === 1, "fire 应触发 1 次");
        const after = store.get(s.id)!;
        const next = new Date(after.nextRunAt!);
        t.assert(
          next.getMonth() === 7 && next.getDate() === 24 && next.getHours() === 10 && next.getMinutes() === 0,
          `fire 后 nextRunAt 应为 8月24日 10:00（下一年），实际 ${next.toLocaleString("zh-CN")}`,
        );
        t.assert(after.nextRunAt! > Date.now(), "nextRunAt 应在未来");
        await sched.tick();
        t.assert(fired === 1, "fire 后 tick 不应重复触发（nextRunAt 已推后）");
        sched.stop();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-34", "模型配置", "Coordinator/Worker 可独立配置模型（回退全局）", async (t) => {
      const { loadConfig } = await import("../src/config.js");
      const old: Record<string, string | undefined> = {};
      for (const k of [
        "CIRCLE_COORDINATOR_MODEL_PROVIDER",
        "CIRCLE_COORDINATOR_MODEL_ID",
        "CIRCLE_WORKER_MODEL_PROVIDER",
        "CIRCLE_WORKER_MODEL_ID",
        "CIRCLE_MODEL_PROVIDER",
        "CIRCLE_MODEL_ID",
      ]) {
        old[k] = process.env[k];
        delete process.env[k];
      }
      try {
        // 未配置 → 全部回退到全局默认
        const d = loadConfig();
        t.assert(d.coordinatorModelProvider === "deepseek" && d.coordinatorModelId === "deepseek-v4-flash", "默认应回退 deepseek-v4-flash");
        t.assert(d.workerModelProvider === "deepseek" && d.workerModelId === "deepseek-v4-flash", "Worker 默认应同全局");
        // 仅配置全局 → 跟随全局
        process.env.CIRCLE_MODEL_PROVIDER = "deepseek";
        process.env.CIRCLE_MODEL_ID = "deepseek-v4-pro";
        const g = loadConfig();
        t.assert(g.coordinatorModelId === "deepseek-v4-pro" && g.workerModelId === "deepseek-v4-pro", "应跟随全局模型");
        // Coordinator 与 Worker 分别覆盖
        process.env.CIRCLE_COORDINATOR_MODEL_ID = "deepseek-v4-flash";
        process.env.CIRCLE_WORKER_MODEL_ID = "deepseek-v4-flash-vision-exp";
        const s = loadConfig();
        t.assert(s.coordinatorModelId === "deepseek-v4-flash", `Coordinator 应独立配置，实际 ${s.coordinatorModelId}`);
        t.assert(s.workerModelId === "deepseek-v4-flash-vision-exp", `Worker 应独立配置，实际 ${s.workerModelId}`);
        t.assert(s.coordinatorModelId !== s.workerModelId, "Coordinator 与 Worker 模型应可不同");
        t.log(`Coordinator=${s.coordinatorModelProvider}/${s.coordinatorModelId}，Worker=${s.workerModelProvider}/${s.workerModelId}`);
      } finally {
        for (const [k, v] of Object.entries(old)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    }),
  );

  // ---------- 多模态：附件落盘与派发透传 ----------
  results.push(
    await runCase("U-31", "多模态", "附件落盘与消息富化（AttachmentStore + buildMessageWithAttachments）", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-upload-"));
      try {
        const { AttachmentStore, buildMessageWithAttachments } = await import("../src/core/upload.js");
        const store = new AttachmentStore(dir);
        // 本地路径附件（引用已有文件）
        const local = join(dir, "already.png");
        writeFileSync(local, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        const saved1 = store.save("c1", [{ kind: "image", name: "already.png", mimeType: "image/png", localPath: local }]);
        t.assert(saved1.length === 1 && saved1[0]!.localPath === local, "本地路径附件应直接引用");
        // base64 附件（落盘到 uploads/c2/）
        const saved2 = store.save("c2", [{ kind: "image", name: "shot.png", mimeType: "image/png", data: Buffer.from("fakeimg").toString("base64") }]);
        t.assert(saved2.length === 1, "base64 附件应落盘");
        t.assert(
          saved2[0]!.localPath.startsWith(join(dir, "c2")) && saved2[0]!.localPath.endsWith("shot.png"),
          `应落盘到 <root>/c2/*-shot.png: ${saved2[0]!.localPath}`,
        );
        t.assert(existsSync(saved2[0]!.localPath), "落盘文件应存在");
        t.assert(readFileSync(saved2[0]!.localPath).toString() === "fakeimg", "落盘内容应为原始字节");
        // 无数据无路径的附件跳过
        t.assert(store.save("c3", [{ kind: "image" }]).length === 0, "空附件应跳过");
        // 路径穿越文件名被净化：分隔符替换后为单个文件名，落盘仍在会话目录内
        const saved3 = store.save("c4", [{ kind: "image", name: "../../evil.png", data: Buffer.from("x").toString("base64") }]);
        t.assert(
          saved3.length === 1 && saved3[0]!.localPath.startsWith(join(dir, "c4")),
          `净化后应仍在会话目录内: ${saved3[0]?.localPath}`,
        );
        t.assert(!saved3[0]!.localPath.split(sep).includes(".."), "路径段中不应出现 ..");
        // 消息富化：带图标记 + 空文本兜底文案
        t.assert(
          buildMessageWithAttachments("看下这张图", saved2).includes("【图片】") &&
            buildMessageWithAttachments("看下这张图", saved2).includes("看下这张图"),
          "富化文本应含【图片】标记与原文",
        );
        t.assert(
          buildMessageWithAttachments("", saved2).includes("请派发任务给 Worker"),
          "空文本时应引导派发给 Worker",
        );
        t.assert(buildMessageWithAttachments("无附件", []) === "无附件", "无附件应原样返回");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-33", "多模态", "派发附加图片 buildDispatchWithAttachments", async (t) => {
      const { buildDispatchWithAttachments } = await import("../src/team/agent-team.js");
      const pending = [{ path: "/tmp/u/a.png", mimeType: "image/png" }];
      const r = buildDispatchWithAttachments("描述图片", pending);
      t.assert(r.attachments === pending, "应透传附件");
      t.assert(r.description.includes("1 张图片") && r.description.startsWith("描述图片"), "描述应追加图片说明");
      const empty = buildDispatchWithAttachments("普通任务", undefined);
      t.assert(empty.attachments === undefined && empty.description === "普通任务", "无附件应原样返回");
    }),
  );

  results.push(
    await runCase("U-32", "多模态", "Worker 图片输入 loadTaskImages（读取/损坏跳过/默认 MIME）", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-unit-images-"));
      try {
        const { loadTaskImages } = await import("../src/agents/worker.js");
        const png = join(dir, "a.png");
        const jpg = join(dir, "b.jpg");
        writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        writeFileSync(jpg, Buffer.from("jpgbytes"));
        // 正常 + 损坏（不存在）文件
        const images = loadTaskImages([
          { path: png, mimeType: "image/png" },
          { path: jpg },
          { path: join(dir, "missing.png") },
        ]);
        t.assert(images.length === 2, `应读取 2 张图片（损坏跳过），实际 ${images.length}`);
        t.assert(images[0]!.type === "image" && images[0]!.mimeType === "image/png", "应保留 mimeType");
        t.assert(images[0]!.data === Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64"), "base64 内容应一致");
        t.assert(images[1]!.mimeType === "image/jpeg", "未指定 mimeType 应默认 image/jpeg");
        // 无附件
        t.assert(loadTaskImages(undefined).length === 0, "无附件应返回空");
        // 注入 fs 便于测试
        const fakeFs = { readFileSync: () => Buffer.from("zzz") };
        const viaFs = loadTaskImages([{ path: png }], fakeFs);
        t.assert(viaFs.length === 1 && viaFs[0]!.data === "enp6", "应使用注入的 fs 读取");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-35", "多模态", "Coordinator 提示词含多模态派发规则（图片标记→派发 Worker）", async (t) => {
      const { CoordinatorAgent } = await import("../src/agents/coordinator.js");
      const { loadConfig } = await import("../src/config.js");
      const c = new CoordinatorAgent(undefined as never, loadConfig(), {
        listWorkers: () => [],
      } as never);
      const prompt = (c as unknown as { buildSystemPrompt(): string }).buildSystemPrompt();
      t.assert(prompt.includes("【图片】"), "提示词应解释【图片】标记含义");
      t.assert(prompt.includes("dispatch_task"), "提示词应要求派发任务给 Worker");
      t.assert(
        prompt.includes("禁止") && prompt.includes("无法查看图片"),
        "提示词应禁止「我无法查看图片」话术（直接派发）",
      );
      t.assert(prompt.includes("无需") && prompt.includes("路径"), "提示词应说明无需在任务描述中写路径");
    }),
  );

  results.push(
    await runCase("U-36", "多模态", "微信图片附件提取：url / full_url / media 字符串 / media 加密对象（AES 解密）", async (t) => {
      const { createServer } = await import("node:http");
      const { createCipheriv } = await import("node:crypto");
      const { extractAttachments, toImageDownloadRef } = await import("../src/im/weixin-ilink.js");

      const png = Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.from("fake-png-body"),
      ]);
      // 加密一份 PNG（模拟微信 CDN 的 AES-128-ECB 密文下载）
      const aesKey = Buffer.from("0123456789abcdef"); // 16 字节
      const cipher = createCipheriv("aes-128-ecb", aesKey, null);
      const encrypted = Buffer.concat([cipher.update(png), cipher.final()]);

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === "/plain.png") {
          res.writeHead(200, { "Content-Type": "image/png" });
          res.end(png);
        } else if (
          (url.pathname === "/download" || url.pathname === "/c2c/download") &&
          url.searchParams.has("encrypted_query_param")
        ) {
          res.writeHead(200, { "Content-Type": "application/octet-stream" });
          res.end(encrypted);
        } else {
          res.writeHead(404);
          res.end("not found");
        }
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const port = (server.address() as { port: number }).port;
      const base = `http://127.0.0.1:${port}`;
      try {
        // 1) url 直链 → 明文提取
        const r1 = await extractAttachments(
          { item_list: [{ type: 2, image_item: { url: `${base}/plain.png`, name: "a.png" } }] },
          base,
        );
        t.assert(r1.length === 1, `url 直链应提取成功，实际 ${r1.length}`);
        t.assert(r1[0]!.data === png.toString("base64"), "url 直链内容应一致");

        // 2) media 加密对象（真实报文形态）：full_url + encrypt_query_param + aes_key(base64)
        const aesKeyB64 = aesKey.toString("base64");
        const r2 = await extractAttachments(
          {
            item_list: [
              {
                type: 2,
                image_item: {
                  media: {
                    encrypt_query_param: "p-123",
                    aes_key: aesKeyB64,
                    full_url: `${base}/download?encrypted_query_param=p-123`,
                  },
                },
              },
            ],
          },
          base,
        );
        t.assert(r2.length === 1, `media 加密对象（full_url + aes_key）应解密提取成功，实际 ${r2.length}`);
        t.assert(r2[0]!.data === png.toString("base64"), "解密后内容应为原始 PNG");
        t.assert(r2[0]!.mimeType === "image/png", "应推断出 image/png");

        // 3) media 加密对象但 aes_key 缺失，改用顶层 aeskey（hex）解密（真实报文形态）
        const aesKeyHex = aesKey.toString("hex");
        const r3 = await extractAttachments(
          {
            item_list: [
              {
                type: 2,
                image_item: {
                  aeskey: aesKeyHex,
                  media: {
                    encrypt_query_param: "p-456",
                    full_url: `${base}/c2c/download?encrypted_query_param=p-456`,
                  },
                },
              },
            ],
          },
          base,
        );
        t.assert(r3.length === 1, `顶层 aeskey(hex) 应能解密提取，实际 ${r3.length}`);
        t.assert(r3[0]!.data === png.toString("base64"), "hex 密钥解密后内容应为原始 PNG");

        // 4) media 字符串（CDN key）→ CDN 不可达时跳过而非抛错
        const r4 = await extractAttachments(
          { item_list: [{ type: 2, image_item: { media: "some/key.png" } }] },
          base,
        );
        t.assert(r4.length === 0, "CDN 不可达时应跳过附件（不抛错）");

        // 5) 非图片响应（HTML 错误页）不应被当作图片
        const r5 = await extractAttachments(
          { item_list: [{ type: 2, image_item: { url: `${base}/nope.html` } }] },
          base,
        );
        t.assert(r5.length === 0, "非图片响应应跳过");

        // 6) toImageDownloadRef 规整：full_url / url / media 字符串 / media 对象 / 空
        t.assert(toImageDownloadRef({ url: "http://x/a.png" })?.url === "http://x/a.png", "url 应直接使用");
        t.assert(toImageDownloadRef({ media: "k.png" })?.media === "k.png", "media 字符串应识别");
        const ref = toImageDownloadRef({
          aeskey: aesKeyHex,
          media: { encrypt_query_param: "p", aes_key: aesKeyB64, full_url: "http://x/f" },
        });
        t.assert(ref?.fullUrl === "http://x/f" && ref?.queryParam === "p", "media 对象应规整（含 full_url）");
        t.assert(ref?.aesKey === aesKeyB64 && ref?.aesKeyHex === aesKeyHex, "应同时保留两个密钥形式");
        t.assert(toImageDownloadRef({}) === undefined, "空 image_item 应返回 undefined");

        t.log(`url 直链 ✅ / full_url+aes_key 解密 ✅ / aeskey(hex) 解密 ✅ / media 字符串不可达跳过 ✅ / 非图片跳过 ✅`);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
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
