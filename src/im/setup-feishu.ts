/**
 * 飞书凭据配置入口：`npm run setup:feishu`
 *
 * 用于首次配置、更换 App Secret 或轮换凭据（会覆盖已有配置）。
 * 与首次启动时的引导式配置（src/index.ts）共用同一套流程。
 */
import { loadConfig } from "../config.js";
import { ensureFeishuCredentials } from "./feishu-setup.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await ensureFeishuCredentials(config.feishu, { force: true });
  console.log("飞书凭据已更新，重启 Circle 后生效。");
}

main().catch((e) => {
  console.error(`配置失败: ${(e as Error).message}`);
  process.exit(1);
});