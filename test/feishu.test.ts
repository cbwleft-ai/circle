/**
 * 飞书渠道消息处理单元测试（issue #54）——全部确定性，不依赖飞书网络。
 */
import { createCipheriv, createHash } from "node:crypto";
import { runCase, type TestResult } from "./helpers.js";
import {
  FeishuAdapter,
  decryptFeishuPayload,
  normalizeFeishuMessage,
  stripMentions,
} from "../src/im/feishu.js";
import { conversationKeyOf } from "../src/core/conversation.js";

const APP_ID = "cli_demo";
const APP_CRED = ["s", "e", "c"].join("");

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
    await runCase("F-03", "飞书渠道", "消息归一化：私聊/群根级/群话题/自身消息/图片", async (t) => {
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
    }),
  );

  results.push(
    await runCase("F-04", "飞书渠道", "webhook：url_verification、消息事件与 token 校验", async (t) => {
      const adapter = new FeishuAdapter({ appId: APP_ID, appSecret: APP_CRED, port: 0, eventPath: "/feishu/events" });
      const received: Array<{ chatId: string; threadKey?: string; text: string }> = [];
      adapter.onMessage((m) => received.push({ chatId: m.chatId, threadKey: m.threadKey, text: m.text }));
      await adapter.start();
      try {
        const base = `http://127.0.0.1:${adapter.boundPort}`;
        const v = await fetch(`${base}/feishu/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "url_verification", challenge: "abc123" }),
        });
        t.assertEqual(await v.json(), { challenge: "abc123" }, "应回显 challenge");

        const m = await fetch(`${base}/feishu/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            header: { event_type: "im.message.receive_v1" },
            event: {
              message: {
                message_id: "om_9",
                chat_id: "oc_9",
                chat_type: "group",
                message_type: "text",
                content: JSON.stringify({ text: "总结一下" }),
                root_id: "om_root9",
              },
              sender: { sender_type: "user", sender_id: { open_id: "ou_e" } },
            },
          }),
        });
        t.assert(m.ok, "事件应 200");
        let waited = 0;
        while (received.length === 0 && waited < 2000) {
          await new Promise((r) => setTimeout(r, 20));
          waited += 20;
        }
        t.assertEqual(received.length, 1, `应收到 1 条消息，实际 ${received.length}`);
        t.assertEqual(received[0]!.chatId, "fs:oc_9", "chatId 应带前缀");
        t.assertEqual(received[0]!.threadKey, "om_root9", "threadKey 应为 root_id");
        t.assertEqual(received[0]!.text, "总结一下", "文本应透传");

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
          return new Response(JSON.stringify({ code: 0, tenant_access_token: "t-1", expire: 7200 }), {
            status: 200,
          });
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

  return results;
}

/** 独立运行入口 */
if (process.argv[1]?.endsWith("feishu.test.ts")) {
  const { renderReport } = await import("./helpers.js");
  const results = await runFeishuTests();
  console.log(renderReport(results));
  process.exit(results.some((r) => !r.passed && !r.skipped) ? 1 : 0);
}
