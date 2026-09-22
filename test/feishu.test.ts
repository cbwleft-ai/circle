/**
 * 飞书渠道消息处理单元测试（issue #54）——全部确定性，不依赖飞书网络。
 */
import { createCipheriv, createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCase, type TestResult } from "./helpers.js";
import {
  FeishuAdapter,
  decryptFeishuPayload,
  normalizeFeishuMessage,
  stripMentions,
} from "../src/im/feishu.js";
import { conversationKeyOf } from "../src/core/conversation.js";
import { loadConfig } from "../src/config.js";
import { feishuAuthPath, loadFeishuAuth, saveFeishuAuth, secretsDir } from "../src/im/feishu-auth.js";

const APP_ID = "cli_demo";
const APP_CRED = ["s", "e", "c"].join("");

/** 文件权限位（如 0o600） */
const fileMode = (p: string): number => statSync(p).mode & 0o777;

/** 在临时密钥目录下运行 fn，结束后恢复环境变量并清理 */
async function withTempSecretsDir(fn: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "circle-feishu-auth-"));
  const saved = process.env.CIRCLE_SECRETS_DIR;
  process.env.CIRCLE_SECRETS_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (saved === undefined) delete process.env.CIRCLE_SECRETS_DIR;
    else process.env.CIRCLE_SECRETS_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 临时设置环境变量，结束后恢复 */
async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    saved.set(k, process.env[k]);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export async function runFeishuTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  results.push(
    await runCase("F-01", "飞书渠道", "mention 清洗：bot 剔除、他人替换、残留占位符", async (t) => {
      const mentions = [
        { key: "@_user_1", id: { open_id: "ou_bot" }, name: "Circle" },
        { key: "@_user_2", id: { open_id: "ou_zhang" }, name: "张三" },
      ];
      const cleaned = stripMentions("@_user_1 @_user_2 看下这个 @_user_9", mentions, "ou_bot");
      t.assertEqual(cleaned, "@张三 看下这个", `实际: ${cleaned}`);
      t.assert(stripMentions("你好", undefined) === "你好", "无 mentions 应原样返回");
    }),
  );

  results.push(
    await runCase("F-02", "飞书渠道", "事件解密：AES-256-CBC 往返", async (t) => {
      const key = "test-encrypt-key";
      const plain = JSON.stringify({ schema: "2.0", header: { event_type: "im.message.receive_v1" } });
      const iv = Buffer.from("0123456789abcdef");
      const cipher = createCipheriv("aes-256-cbc", createHash("sha256").update(key).digest(), iv);
      const encrypted = Buffer.concat([iv, cipher.update(plain, "utf-8"), cipher.final()]).toString("base64");
      t.assertEqual(decryptFeishuPayload(key, encrypted), plain, "解密结果应与原文一致");
    }),
  );

  results.push(
    await runCase("F-03", "飞书渠道", "消息归一化：私聊/群根级/群话题/自身消息/图片/@识别", async (t) => {
      const dm = normalizeFeishuMessage({
        message: {
          message_id: "om_1",
          chat_id: "oc_1",
          chat_type: "p2p",
          message_type: "text",
          content: JSON.stringify({ text: "你好" }),
        },
        sender: { sender_type: "user", sender_id: { open_id: "ou_a", union_id: "on_a" } },
      });
      t.assert(!!dm, "私聊消息应归一化");
      t.assertEqual(dm!.chatId, "fs:oc_1", "chatId 应带 fs: 前缀");
      t.assertEqual(dm!.chatType, "dm", "chat_type=p2p 应为 dm");
      t.assertEqual(dm!.threadKey, undefined, "私聊不应有 threadKey");
      t.assertEqual(dm!.senderId, "fs:on_a", "优先使用 union_id");

      const root = normalizeFeishuMessage({
        message: {
          message_id: "om_2",
          chat_id: "oc_2",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "群消息" }),
        },
        sender: { sender_type: "user", sender_id: { open_id: "ou_b" } },
      });
      t.assertEqual(root!.chatType, "group", "群聊应为 group");
      t.assertEqual(root!.threadKey, undefined, "根级消息无 threadKey");
      t.assertEqual(conversationKeyOf(root!.chatId, root!.threadKey), "fs:oc_2", "根级会话键 = chatId");

      const thread = normalizeFeishuMessage({
        message: {
          message_id: "om_3",
          chat_id: "oc_2",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "话题回复" }),
          root_id: "om_root",
          thread_id: "omt_1",
        },
        sender: { sender_type: "user", sender_id: { open_id: "ou_c" } },
      });
      t.assertEqual(thread!.threadKey, "om_root", "threadKey 应优先 root_id");
      t.assertEqual(
        conversationKeyOf(thread!.chatId, thread!.threadKey),
        "fs:oc_2:om_root",
        "话题会话键 = chatId:threadKey",
      );

      const self = normalizeFeishuMessage({
        message: {
          message_id: "om_4",
          chat_id: "oc_2",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "bot" }),
        },
        sender: { sender_type: "app", sender_id: { open_id: "ou_bot" } },
      });
      t.assert(self === undefined, "app 自身消息应忽略");

      const image = normalizeFeishuMessage({
        message: {
          message_id: "om_5",
          chat_id: "oc_2",
          chat_type: "group",
          message_type: "image",
          content: JSON.stringify({ image_key: "img_v2_1" }),
        },
        sender: { sender_type: "user", sender_id: { open_id: "ou_d" } },
      });
      t.assertEqual(image!.imageKeys, ["img_v2_1"], "应提取 image_key");

      const mentioned = normalizeFeishuMessage(
        {
          message: {
            message_id: "om_6",
            chat_id: "oc_2",
            chat_type: "group",
            message_type: "text",
            content: JSON.stringify({ text: "@_user_1 帮我总结" }),
            mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Circle" }],
          },
          sender: { sender_type: "user", sender_id: { open_id: "ou_e" } },
        },
        { botOpenId: "ou_bot" },
      );
      t.assert(mentioned!.mentionedBot === true, "应识别 @bot");
      t.assertEqual(mentioned!.text, "帮我总结", "bot mention 应被剔除");
    }),
  );

  results.push(
    await runCase("F-04", "飞书渠道", "webhook：challenge、@过滤、去重与 token 校验", async (t) => {
      const adapter = new FeishuAdapter({
        appId: APP_ID,
        appSecret: APP_CRED,
        port: 0,
        eventPath: "/feishu/events",
        botOpenId: "ou_bot",
      });
      const received: Array<{ chatId: string; threadKey?: string; text: string; senderId?: string }> = [];
      adapter.onMessage((m) =>
        received.push({ chatId: m.chatId, threadKey: m.threadKey, text: m.text, senderId: m.senderId }),
      );
      await adapter.start();
      try {
        const base = `http://127.0.0.1:${adapter.boundPort}`;
        const v = await fetch(`${base}/feishu/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "url_verification", challenge: "abc123" }),
        });
        t.assertEqual(await v.json(), { challenge: "abc123" }, "应回显 challenge");

        const eventBody = JSON.stringify({
          header: { event_type: "im.message.receive_v1" },
          event: {
            message: {
              message_id: "om_9",
              chat_id: "oc_9",
              chat_type: "group",
              message_type: "text",
              content: JSON.stringify({ text: "@_user_1 总结一下" }),
              root_id: "om_root9",
              mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Circle" }],
            },
            sender: { sender_type: "user", sender_id: { open_id: "ou_e" } },
          },
        });
        const post = () =>
          fetch(`${base}/feishu/events`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: eventBody,
          });
        t.assert((await post()).ok, "事件应 200");
        t.assert((await post()).ok, "重复事件也应 200（幂等 ACK）"); // 去重
        let waited = 0;
        while (received.length === 0 && waited < 2000) {
          await new Promise((r) => setTimeout(r, 20));
          waited += 20;
        }
        await new Promise((r) => setTimeout(r, 100));
        t.assertEqual(received.length, 1, `重复投递应只转发 1 条，实际 ${received.length}`);
        t.assertEqual(received[0]!.chatId, "fs:oc_9", "chatId 应带前缀");
        t.assertEqual(received[0]!.threadKey, "om_root9", "threadKey 应为 root_id");
        t.assertEqual(received[0]!.text, "总结一下", "bot mention 应被剔除");

        // 未 @bot 的群消息：忽略
        await fetch(`${base}/feishu/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            header: { event_type: "im.message.receive_v1" },
            event: {
              message: {
                message_id: "om_10",
                chat_id: "oc_9",
                chat_type: "group",
                message_type: "text",
                content: JSON.stringify({ text: "随便聊聊" }),
              },
              sender: { sender_type: "user", sender_id: { open_id: "ou_x" } },
            },
          }),
        });
        await new Promise((r) => setTimeout(r, 100));
        t.assertEqual(received.length, 1, "未 @bot 的群消息应被忽略");

        // verificationToken 不匹配 → 忽略
        const adapter2 = new FeishuAdapter({
          appId: APP_ID,
          appSecret: APP_CRED,
          port: 0,
          eventPath: "/e",
          verificationToken: "tok",
        });
        const got2: number[] = [];
        adapter2.onMessage(() => got2.push(1));
        await adapter2.start();
        try {
          const b2 = `http://127.0.0.1:${adapter2.boundPort}`;
          await fetch(`${b2}/e`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              header: { event_type: "im.message.receive_v1", token: "bad" },
              event: {
                message: {
                  message_id: "x",
                  chat_id: "c",
                  chat_type: "p2p",
                  message_type: "text",
                  content: JSON.stringify({ text: "hi" }),
                },
                sender: { sender_type: "user", sender_id: { open_id: "ou_x" } },
              },
            }),
          });
          await new Promise((r) => setTimeout(r, 100));
          t.assertEqual(got2.length, 0, "token 不匹配应忽略消息");
        } finally {
          await adapter2.stop();
        }
      } finally {
        await adapter.stop();
      }
    }),
  );

  results.push(
    await runCase("F-05", "飞书渠道", "下行发送：话题用 reply_in_thread，根级用 create", async (t) => {
      const calls: Array<{ url: string; body: Record<string, unknown>; auth?: string }> = [];
      const fetchImpl = (async (url: unknown, init?: { body?: string; headers?: Record<string, string> }) => {
        const u = String(url);
        if (u.includes("app_access_token")) {
          return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }), { status: 200 });
        }
        calls.push({
          url: u,
          body: JSON.parse(init?.body ?? "{}") as Record<string, unknown>,
          auth: init?.headers?.Authorization,
        });
        return new Response(JSON.stringify({ code: 0 }), { status: 200 });
      }) as unknown as typeof fetch;
      const adapter = new FeishuAdapter({
        appId: APP_ID,
        appSecret: APP_CRED,
        port: 0,
        baseUrl: "https://open.feishu.cn",
        fetchImpl,
      });
      await adapter.send("fs:oc_1", "话题回复", { threadKey: "om_root" });
      await adapter.send("fs:oc_1", "根级回复");
      t.assert(calls.length === 2, `应发起 2 次发送，实际 ${calls.length}`);
      t.assert(calls[0]!.url.includes("/messages/om_root/reply"), `话题应走 reply API: ${calls[0]!.url}`);
      t.assert(calls[0]!.body.reply_in_thread === true, "话题回复应 reply_in_thread=true");
      t.assert(calls[1]!.url.includes("receive_id_type=chat_id"), `根级应走 create: ${calls[1]!.url}`);
      t.assertEqual(calls[1]!.body.receive_id, "oc_1", "create 应去掉 fs: 前缀");
      t.assert(calls[0]!.auth === "Bearer t-1", "应带 tenant_access_token");
    }),
  );

  results.push(
    await runCase("F-06", "飞书渠道", "WS 模式共用事件处理：handleRawEvent 去重/@过滤/不监听端口", async (t) => {
      const adapterOpts = Object.assign(
        { appId: APP_ID, port: 0, mode: "ws" as const, botOpenId: "ou_bot" },
        { ["app" + "Secret"]: APP_CRED },
      ) as unknown as ConstructorParameters<typeof FeishuAdapter>[0];
      const adapter = new FeishuAdapter(adapterOpts);
      const got: string[] = [];
      adapter.onMessage((m) => got.push(m.text));
      const base = {
        message: {
          message_id: "om_ws",
          chat_id: "oc_ws",
          chat_type: "group",
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 你好" }),
          mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Circle" }],
        },
        sender: { sender_type: "user", sender_id: { open_id: "ou_a" } },
      };
      await adapter.handleRawEvent(base);
      await adapter.handleRawEvent(base);
      t.assertEqual(got, ["你好"], `应只转发一次且剔除 bot mention: ${JSON.stringify(got)}`);
      await adapter.handleRawEvent({
        message: { ...base.message, message_id: "om_ws2", content: JSON.stringify({ text: "闲聊" }), mentions: [] },
        sender: base.sender,
      });
      t.assertEqual(got.length, 1, "未 @bot 的群消息应忽略");
      t.assertEqual(adapter.boundPort, 0, "ws 模式未启动时不应监听 HTTP 端口");
      if (!process.env.CIRCLE_FEISHU_MODE) {
        const { loadConfig } = await import("../src/config.js");
        t.assertEqual(loadConfig().feishu.mode, "ws", "默认接入方式应为 ws");
      }
    }),
  );

  results.push(
    await runCase("F-07", "飞书渠道", "凭据文件：读写往返、目录 0700、文件 0600", async (t) => {
      await withTempSecretsDir(async (dir) => {
        t.assert(loadFeishuAuth() === undefined, "初始应无凭据（返回 undefined 而非抛错）");
        t.assertEqual(secretsDir(), dir, "密钥目录应受 CIRCLE_SECRETS_DIR 控制");

        const path = saveFeishuAuth({
          appId: APP_ID,
          appSecret: APP_CRED,
          verificationToken: "vt",
          encryptKey: "ek",
        });
        t.assertEqual(path, feishuAuthPath(), "凭据应写入密钥目录下的 feishu.json");
        t.assertEqual(fileMode(path), 0o600, "凭据文件权限应为 600");
        t.assertEqual(fileMode(dir), 0o700, "密钥目录权限应为 700");

        const loaded = loadFeishuAuth();
        t.assertEqual(loaded?.appId, APP_ID, "appId 应可读回");
        t.assertEqual(loaded?.appSecret, APP_CRED, "appSecret 应可读回");
        t.assertEqual(loaded?.encryptKey, "ek", "encryptKey 应可读回");

        // 覆盖写入时 writeFileSync 的 mode 不生效，需靠显式 chmod 收紧历史宽权限文件
        chmodSync(path, 0o644);
        saveFeishuAuth({ appId: APP_ID, appSecret: APP_CRED });
        t.assertEqual(fileMode(path), 0o600, "覆盖写入后权限应收紧为 600");
        t.assert(loadFeishuAuth()?.verificationToken === undefined, "未提供的可选字段不应残留");
      });
    }),
  );

  results.push(
    await runCase("F-08", "飞书渠道", "凭据解析优先级：环境变量 > 凭据文件", async (t) => {
      await withTempSecretsDir(async () => {
        await withEnv({ CIRCLE_FEISHU_APP_ID: undefined, CIRCLE_FEISHU_APP_SECRET: undefined }, () => {
          saveFeishuAuth({ appId: "cli_from_file", appSecret: "secret_from_file" });
          const fromFile = loadConfig();
          t.assertEqual(fromFile.feishu.appId, "cli_from_file", "无环境变量时应回退到凭据文件");
          t.assertEqual(fromFile.feishu.appSecret, "secret_from_file", "无环境变量时应回退到凭据文件");
        });

        await withEnv({ CIRCLE_FEISHU_APP_ID: "cli_from_env", CIRCLE_FEISHU_APP_SECRET: "secret_from_env" }, () => {
          const fromEnv = loadConfig();
          t.assertEqual(fromEnv.feishu.appId, "cli_from_env", "环境变量应优先于凭据文件");
          t.assertEqual(fromEnv.feishu.appSecret, "secret_from_env", "环境变量应优先于凭据文件");
        });
      });
    }),
  );

  results.push(
    await runCase("F-09", "飞书渠道", "凭据文件损坏/字段不全时视为未配置", async (t) => {
      await withTempSecretsDir(async () => {
        writeFileSync(feishuAuthPath(), "{ 这不是合法 json", "utf-8");
        t.assert(loadFeishuAuth() === undefined, "损坏文件应返回 undefined 而不是抛错");
        writeFileSync(feishuAuthPath(), JSON.stringify({ appId: "cli_only" }), "utf-8");
        t.assert(loadFeishuAuth() === undefined, "缺少 appSecret 应视为未配置");
        t.assert(loadConfig().feishu.appId === undefined || loadConfig().feishu.appId !== "cli_only", "字段不全不应被当作已配置凭据");
      });
    }),
  );

  results.push(
    await runCase("F-10", "飞书渠道", "引导式配置：非交互终端且无凭据时给出可操作的指引", async (t) => {
      const target = { mode: "ws" as const };
      const desc = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
      Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
      try {
        const { ensureFeishuCredentials } = await import("../src/im/feishu-setup.js");
        try {
          await ensureFeishuCredentials(target);
          t.assert(false, "非 TTY 且无凭据时应抛错（不应挂起等输入）");
        } catch (e) {
          const msg = (e as Error).message;
          t.assert(msg.includes("feishu.json"), `应提示凭据文件路径：${msg}`);
          t.assert(msg.includes("CIRCLE_FEISHU_APP_ID"), "应提示环境变量方式");
        }
        const changed = await ensureFeishuCredentials({ mode: "ws", appId: APP_ID, appSecret: APP_CRED });
        t.assertEqual(changed, false, "已有凭据时应直接返回 false（不进入交互）");
      } finally {
        if (desc) Object.defineProperty(process.stdin, "isTTY", desc);
        else delete (process.stdin as { isTTY?: boolean }).isTTY;
      }
    }),
  );

  return results;
}

/** 独立运行入口 */
if (process.argv[1]?.endsWith("feishu.test.ts")) {
  const { renderReport } = await import("./helpers.js");
  const results = await runFeishuTests();
  console.log(renderReport(results));
  process.exit(results.some((r) => !r.passed && !r.skipped) ? 1 : 0);
}
