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
import { log, setLogFile } from "./core/logger.js";
import { timezoneInfo } from "./core/time.js";
import { ConsoleAdapter } from "./im/console.js";
import { FeishuAdapter } from "./im/feishu.js";
import { HttpAdapter } from "./im/http.js";
import { WechatAdapter } from "./im/wechat.js";
import { WeixinIlinkAdapter } from "./im/weixin-ilink.js";
import { AgentTeam } from "./team/agent-team.js";

async function main(): Promise<void> {
  const config = loadConfig();
  // 日志同时落盘到数据目录（data/logs/circle.log，按天轮转），与 stdout 双写
  setLogFile(join(config.dataDir, "logs", "circle.log"));
  // 时区校验：系统时间注入与 cron 均按进程本地时区解释。UTC 环境（如默认配置的容器）
  // 会让用户按北京时间描述的「每天 10 点」实际在北京时间 18:00 触发，因此在启动日志中
  // 明确打印当前时区并给出提示，避免静默偏差。
  const tz = timezoneInfo();
  log.info("bootstrap", `进程时区: ${tz.label}（系统时间注入与 cron 均按此时区解释）`);
  if (tz.offsetMinutes === 0) {
    log.warn(
      "bootstrap",
      "检测到进程时区为 UTC（偏移 0）：若按北京时间描述定时任务（如「每天 10 点」），实际会在北京时间 18:00 触发。" +
        "请在启动前设置 TZ（如 TZ=Asia/Shanghai），或使用 ./scripts/circle.sh（支持 CIRCLE_TZ）。",
    );
  }
  log.info("bootstrap", `Circle 启动中（IM: ${config.imAdapter}, 模型: ${config.modelProvider}/${config.modelId}）`);

  // 选择 IM 适配器
  const adapter = createAdapter(config.imAdapter, config);

  const team = await AgentTeam.create({
    config,
    workers: defaultWorkers(config.dataDir),
    outbox: async (chatId, text, target) => {
      await adapter.send(chatId, text, target);
    },
    // 文件附件：适配器支持则直发；不支持（console/http 等）时 AgentTeam 自动降级为文本提示
    sendFile:
      "sendFile" in adapter
        ? (chatId, file, target) => adapter.sendFile!(chatId, file, target)
        : undefined,
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

function createAdapter(kind: ReturnType<typeof loadConfig>["imAdapter"], config: ReturnType<typeof loadConfig>) {
  switch (kind) {
    case "http":
      return new HttpAdapter(config.httpPort);
    case "feishu": {
      const { appId, appSecret, verificationToken, encryptKey, port, eventPath, botOpenId, baseUrl } = config.feishu;
      if (!appId || !appSecret) {
        throw new Error(
          "飞书适配器需要 CIRCLE_FEISHU_APP_ID / CIRCLE_FEISHU_APP_SECRET（应用凭据，见 docs/usage.md）",
        );
      }
      return new FeishuAdapter({ appId, appSecret, verificationToken, encryptKey, port, eventPath, botOpenId, baseUrl });
    }
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
