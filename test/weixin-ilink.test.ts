/**
 * 微信官方 iLink 通道适配器测试
 *
 * 使用本地 mock 服务器模拟腾讯官方 API（ilink/bot/get_bot_qrcode、
 * get_qrcode_status、getupdates、sendmessage），在无需真实微信账号的
 * 情况下完整验证适配器行为：
 *   U-20 扫码登录流程（二维码 → 轮询 → confirmed → 保存账户）
 *   U-21 消息接收（长轮询 getupdates → onMessage 回调）
 *   U-22 消息发送（sendmessage + markdown 清洗）
 *   U-23 缓存恢复（重启不重复扫码）
 */
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCase, poll, type TestResult } from "./helpers.js";
import { WeixinIlinkAdapter } from "../src/im/weixin-ilink.js";

interface MockServer {
  server: Server;
  baseUrl: string;
  qrStatusCalls: number;
  qrRequests: number;
  updatesQueue: unknown[];
  sentMessages: Array<{ to: string; text: string }>;
  close(): Promise<void>;
}

function createMockWeixinServer(): Promise<MockServer> {
  const state: Omit<MockServer, "server" | "baseUrl" | "close"> = {
    qrStatusCalls: 0,
    qrRequests: 0,
    updatesQueue: [],
    sentMessages: [],
  };
  // mock 与 state 是同一对象（引用共享），避免浅拷贝导致计数不更新
  const mock = state as MockServer;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };

    // 登录：获取二维码
    if (req.method === "GET" && url.pathname === "/ilink/bot/get_bot_qrcode") {
      state.qrRequests++;
      send(200, { qrcode: "qr-mock-1", qrcode_img_content: "https://mock/qr/1" });
      return;
    }
    // 登录：查询二维码状态（wait → scaned → confirmed）
    if (req.method === "GET" && url.pathname === "/ilink/bot/get_qrcode_status") {
      state.qrStatusCalls++;
      if (state.qrStatusCalls === 1) {
        send(200, { status: "wait" });
      } else if (state.qrStatusCalls === 2) {
        send(200, { status: "scaned" });
      } else {
        send(200, {
          status: "confirmed",
          bot_token: "mock-bot-token-1",
          ilink_bot_id: "mock-bot-1",
          baseurl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
          ilink_user_id: "mock-user-1",
        });
      }
      return;
    }
    // 收消息（长轮询，mock 立即返回）
    if (req.method === "POST" && url.pathname === "/ilink/bot/getupdates") {
      const next = state.updatesQueue.shift();
      send(200, next ?? { ret: 0, msgs: [], get_updates_buf: "buf-idle" });
      return;
    }
    // 发消息
    if (req.method === "POST" && url.pathname === "/ilink/bot/sendmessage") {
      let body: any = {};
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          body = JSON.parse(raw);
        } catch {
          /* ignore */
        }
        const msg = body.msg ?? {};
        const to = msg.to_user_id ?? "";
        const item = (msg.item_list ?? [])[0];
        state.sentMessages.push({ to, text: item?.text_item?.text ?? "" });
        send(200, { ret: 0 });
      });
      return;
    }
    send(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      mock.server = server;
      mock.baseUrl = `http://127.0.0.1:${port}`;
      mock.close = () => new Promise<void>((r) => server.close(() => r()));
      resolve(mock);
    });
  });
}

export async function runWeixinIlinkTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];

  results.push(
    await runCase("U-20", "微信官方通道", "扫码登录：二维码 → 轮询 → confirmed → 保存账户", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-login-"));
      try {
        const qrUrls: string[] = [];
        const adapter = new WeixinIlinkAdapter({ baseUrl: mock.baseUrl, stateDir });
        adapter.onQRCode = (url) => qrUrls.push(url);
        await adapter.start();

        // 二维码已生成
        t.assert(qrUrls.length === 1, `应回调一次二维码 URL，实际 ${qrUrls.length}`);
        t.assert(qrUrls[0]!.includes("mock/qr/1"), `二维码 URL 应为 mock，实际 ${qrUrls[0]}`);
        // 登录状态轮询走通（wait → scaned → confirmed）
        t.assert(mock.qrStatusCalls >= 3, `二维码状态应至少轮询 3 次，实际 ${mock.qrStatusCalls}`);
        // 已连接
        t.assert(adapter.connected, "适配器应处于已连接状态");
        // 账户已保存（缓存恢复用）
        const acctFile = join(stateDir, "mock-bot-1.json");
        t.assert(existsSync(acctFile), "账户文件应已保存");
        const saved = JSON.parse(readFileSync(acctFile, "utf-8")) as { token?: string };
        t.assert(saved.token === "mock-bot-token-1", "账户文件应包含 token");
        await adapter.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-21", "微信官方通道", "消息接收：getupdates → onMessage 回调", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-recv-"));
      try {
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1", // 跳过扫码
          stateDir,
        });
        const received: Array<{ chatId: string; text: string }> = [];
        adapter.onMessage((m) => received.push(m));

        // 预置：第一条轮询返回一条用户文本消息
        mock.updatesQueue.push({
          ret: 0,
          get_updates_buf: "buf-after-msg",
          msgs: [
            {
              from_user_id: "wxuser-1",
              message_type: 1,
              item_list: [{ type: 1, text_item: { text: "你好，请执行一个任务" } }],
              context_token: "ctx-1",
            },
          ],
        });

        await adapter.start();
        await poll(() => received.length > 0, {
          timeoutMs: 15_000,
          msg: "应收到用户消息回调",
        });
        t.assertEqual(received[0]!.chatId, "wx:wxuser-1", "chatId 应为 wx:<from_user_id>");
        t.assertEqual(received[0]!.text, "你好，请执行一个任务", "文本应正确提取");
        await adapter.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-22", "微信官方通道", "消息发送：sendmessage + markdown 清洗", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-send-"));
      try {
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1",
          stateDir,
        });
        await adapter.start();

        // 发给 wxuser-1，内容含 markdown
        await adapter.send("wx:wxuser-1", "**任务已完成**：`done.txt` [查看](http://x)");

        await poll(() => mock.sentMessages.length > 0, {
          timeoutMs: 15_000,
          msg: "mock 服务器应收到 sendmessage",
        });
        const sent = mock.sentMessages[0]!;
        t.assertEqual(sent.to, "wxuser-1", "to_user_id 应为 wxuser-1");
        t.assert(!sent.text.includes("**"), "粗体标记应被清洗");
        t.assert(!sent.text.includes("`"), "行内代码标记应被清洗");
        t.assert(sent.text.includes("任务已完成"), "正文应保留");
        t.assert(sent.text.includes("done.txt"), "代码内容应保留");
        t.assert(sent.text.includes("查看") && !sent.text.includes("http"), "链接应转为纯文本");
        await adapter.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-23", "微信官方通道", "缓存恢复：重启后不重复扫码", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-restore-"));
      try {
        // 第一次：扫码登录
        const a1 = new WeixinIlinkAdapter({ baseUrl: mock.baseUrl, stateDir });
        await a1.start();
        t.assert(a1.connected, "第一次应登录成功");
        const qrCountAfterFirst = mock.qrRequests;
        await a1.stop();

        // 第二次：应直接复用缓存，不再请求二维码
        const a2 = new WeixinIlinkAdapter({ baseUrl: mock.baseUrl, stateDir });
        await a2.start();
        t.assert(a2.connected, "第二次应直接连接成功");
        t.assertEqual(mock.qrRequests, qrCountAfterFirst, "不应再次请求二维码");
        await a2.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  return results;
}

/** 独立运行入口 */
if (process.argv[1]?.endsWith("weixin-ilink.test.ts")) {
  const { renderReport } = await import("./helpers.js");
  const results = await runWeixinIlinkTests();
  console.log(renderReport(results));
  process.exit(results.some((r) => !r.passed && !r.skipped) ? 1 : 0);
}
