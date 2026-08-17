/**
 * Circle —— 单 Agent 多任务协作系统入口。
 *
 * 启动流程：
 * 1. 加载配置；
 * 2. 创建 AgentTeam（Coordinator + Worker × N + Scheduler）；
 * 3. 启动 IM 适配器（console / http / wechat），将上行消息接入团队；
 * 4. 团队下行消息通过适配器回给用户。
 */
import { join } from "node:path";
import { defaultWorkers, loadConfig } from "./config.js";
import { log } from "./core/logger.js";
import { ConsoleAdapter } from "./im/console.js";
import { HttpAdapter } from "./im/http.js";
import { WechatAdapter } from "./im/wechat.js";
import { WeixinIlinkAdapter } from "./im/weixin-ilink.js";
import { AgentTeam } from "./team/agent-team.js";

async function main(): Promise<void> {
  const config = loadConfig();
  log.info("bootstrap", `Circle 启动中（IM: ${config.imAdapter}, 模型: ${config.modelProvider}/${config.modelId}）`);

  // 选择 IM 适配器
  const adapter = createAdapter(config.imAdapter, config);

  const team = await AgentTeam.create({
    config,
    workers: defaultWorkers(config.dataDir),
    outbox: async (chatId, text) => {
      await adapter.send(chatId, text);
    },
    // 文件附件：适配器支持则直发；不支持（console/http 等）时 AgentTeam 自动降级为文本提示
    sendFile: "sendFile" in adapter ? (chatId, file) => adapter.sendFile!(chatId, file) : undefined,
  });
  await team.start();

  adapter.onMessage((msg) => {
    void team.handleUserMessage(msg).catch((e) => {
      log.error("bootstrap", `处理用户消息失败: ${(e as Error).message}`);
    });
  });
  await adapter.start();
  log.info("bootstrap", "Circle 已就绪，等待消息…");
}

function createAdapter(
  kind: "console" | "http" | "wechat" | "weixin",
  config: ReturnType<typeof loadConfig>,
) {
  switch (kind) {
    case "http":
      return new HttpAdapter(config.httpPort);
    case "wechat":
      // 旧方案：wechaty 逆向协议（不推荐，见 docs/usage.md）
      return new WechatAdapter({
        puppet: config.wechat.puppet,
        puppetToken: config.wechat.puppetToken,
        allowContacts: config.wechat.allowContacts,
      });
    case "weixin":
      // 官方 iLink 通道：扫码登录，无需 token puppet
      return new WeixinIlinkAdapter({
        botToken: config.weixin.botToken,
        baseUrl: config.weixin.baseUrl,
        botType: config.weixin.botType,
        stateDir: join(config.dataDir, "weixin"),
      });
    case "console":
    default:
      return new ConsoleAdapter();
  }
}

main().catch((e) => {
  log.error("bootstrap", `启动失败: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});

// 优雅退出
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
