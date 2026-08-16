/**
 * 测试入口：运行全部用例并生成测试报告（test/TEST_REPORT.md）。
 *
 * 用法：
 *   npm test                     # 运行全部用例并生成报告
 *   CIRCLE_LLM_TESTS=0 npm test  # 仅运行确定性用例（无需 API key）
 *   npm run test:unit|case1|case2|case3
 *   npm run report               # 仅重新生成报告文件（不执行）
 */
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { runUnitTests } from "./unit.test.js";
import { runCase1 } from "./case1-long-task.test.js";
import { runCase2 } from "./case2-scheduled-task.test.js";
import { runCase3 } from "./case3-safety-intercept.test.js";
import { runCase4 } from "./case4-restart-reconcile.test.js";
import { runWeixinIlinkTests } from "./weixin-ilink.test.js";
import { renderReport, type TestResult } from "./helpers.js";

const REPORT_PATH = join(import.meta.dirname, "TEST_REPORT.md");

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--report-only")) {
    if (existsSync(REPORT_PATH)) {
      console.log(readFileSync(REPORT_PATH, "utf-8"));
      return;
    }
    console.error("报告文件不存在，请先运行 npm test");
    process.exit(1);
  }

  const llmEnabled = (process.env.CIRCLE_LLM_TESTS ?? "1") === "1";
  console.log(`\n========== Circle 测试套件 ==========`);
  console.log(`LLM 端到端用例: ${llmEnabled ? "启用（需要 DeepSeek API key）" : "跳过（CIRCLE_LLM_TESTS=0）"}\n`);

  const all: TestResult[] = [];
  all.push(...(await runUnitTests()));
  all.push(...(await runWeixinIlinkTests()));
  all.push(...(await runCase1()));
  all.push(...(await runCase2()));
  all.push(...(await runCase3()));
  all.push(...(await runCase4()));

  const passed = all.filter((r) => r.passed).length;
  const failed = all.filter((r) => !r.passed && !r.skipped).length;
  const skipped = all.filter((r) => r.skipped).length;

  const extra = [
    "## 环境信息",
    "",
    `- 模型：${process.env.CIRCLE_MODEL_PROVIDER ?? "deepseek"} / ${process.env.CIRCLE_MODEL_ID ?? "deepseek-v4-flash"}`,
    `- LLM 端到端用例：${llmEnabled ? "启用" : "跳过"}`,
    `- Node：${process.version}`,
    "",
    "## 结论",
    "",
    failed === 0
      ? "全部用例通过。三个验收用例（长程任务 / 定时任务 / 安全拦截）均满足预期结果。"
      : `存在 ${failed} 个失败用例，请参考下方失败详情排查。`,
  ];

  const report = renderReport(all, extra);
  writeFileSync(REPORT_PATH, report, "utf-8");
  console.log(`\n${report}`);
  console.log(`\n报告已写入: ${REPORT_PATH}`);
  process.exit(failed > 0 ? 1 : 0);
}

await main();
