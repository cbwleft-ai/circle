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
import { createDecipheriv } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCase, poll, type TestResult } from "./helpers.js";
import { WeixinIlinkAdapter, jsonParseSafe } from "../src/im/weixin-ilink.js";

interface MockServer {
  server: Server;
  baseUrl: string;
  qrStatusCalls: number;
  qrRequests: number;
  updatesQueue: unknown[];
  sentMessages: Array<{ to: string; text: string }>;
  /** 发送消息时使用的 client_id（用于模拟微信回显出站消息） */
  sentClientIds: string[];
  /** 发送的所有消息 item（含文件/图片） */
  sentItems: Array<{ to: string; type: number; item: unknown }>;
  /** getuploadurl 请求体 */
  uploadUrlRequests: Array<Record<string, unknown>>;
  /** CDN 上传收到的密文 */
  cdnUploads: Buffer[];
  close(): Promise<void>;
}

function createMockWeixinServer(): Promise<MockServer> {
  const state: Omit<MockServer, "server" | "baseUrl" | "close"> = {
    qrStatusCalls: 0,
    qrRequests: 0,
    updatesQueue: [],
    sentMessages: [],
    sentClientIds: [],
    sentItems: [],
    uploadUrlRequests: [],
    cdnUploads: [],
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
        state.sentClientIds.push(String(msg.client_id ?? ""));
        state.sentItems.push({ to, type: item?.type ?? 0, item });
        send(200, { ret: 0 });
      });
      return;
    }
    // 获取上传 URL（文件/图片发送）
    if (req.method === "POST" && url.pathname === "/ilink/bot/getuploadurl") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          state.uploadUrlRequests.push(JSON.parse(raw));
        } catch {
          /* ignore */
        }
        const port = (server.address() as { port: number }).port;
        send(200, { upload_full_url: `http://127.0.0.1:${port}/cdn/upload` });
      });
      return;
    }
    // CDN 上传（AES 密文），响应头返回下载参数
    if (req.method === "POST" && url.pathname === "/cdn/upload") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        state.cdnUploads.push(Buffer.concat(chunks));
        res.writeHead(200, { "x-encrypted-param": "mock-download-param" });
        res.end();
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

  results.push(
    await runCase("U-28", "微信官方通道", "文件发送：getuploadurl → CDN 加密上传 → type 4 文件消息", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-file-"));
      try {
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1",
          stateDir,
        });
        await adapter.start();

        const content = Buffer.from("# 报告\n关键结论：全部通过", "utf-8");
        await adapter.sendFile("wx:wxuser-1", {
          fileName: "report.md",
          content,
          size: content.length,
          mimeType: "text/markdown",
          caption: "报告来了",
        });

        // 1) getuploadurl 请求：字段完整（media_type=3 文件，md5/aeskey/size 齐备）
        await poll(() => mock.uploadUrlRequests.length > 0, {
          timeoutMs: 15_000,
          msg: "应发起 getuploadurl",
        });
        const up = mock.uploadUrlRequests[0]!;
        t.assert(up.media_type === 3, `文件 media_type 应为 3，实际 ${up.media_type}`);
        t.assert(up.to_user_id === "wxuser-1", "to_user_id 应为 wxuser-1");
        t.assert(up.rawsize === content.length, "rawsize 应为明文大小");
        t.assert(typeof up.rawfilemd5 === "string" && up.rawfilemd5.length === 32, "应有明文 md5");
        t.assert(typeof up.aeskey === "string" && up.aeskey.length === 32, "应有 16 字节 aeskey(hex)");
        t.assert(typeof up.filekey === "string" && up.filekey.length === 32, "应有 filekey");
        t.assert(up.filesize === Math.ceil((content.length + 1) / 16) * 16, "filesize 应为 AES 填充后大小");

        // 2) CDN 上传：收到 AES-128-ECB 密文，可用发送消息中的 aes_key 解密还原
        await poll(() => mock.cdnUploads.length > 0, { timeoutMs: 15_000, msg: "应上传 CDN" });
        const sentItem = mock.sentItems.find((s) => s.type === 4);
        t.assert(sentItem !== undefined, "应发送 type 4 文件消息");
        const fileItem = (sentItem!.item as { file_item: any }).file_item;
        t.assert(fileItem.file_name === "report.md", "file_name 应为 report.md");
        t.assert(fileItem.len === String(content.length), "len 应为明文大小字符串");
        t.assert(
          fileItem.media.encrypt_query_param === "mock-download-param",
          "encrypt_query_param 应来自 CDN 响应头",
        );
        const aesKeyBase64 = fileItem.media.aes_key as string;
        const aeskey = Buffer.from(Buffer.from(aesKeyBase64, "base64").toString("utf8"), "hex");
        const decipher = createDecipheriv("aes-128-ecb", aeskey, null);
        const plain = Buffer.concat([
          decipher.update(mock.cdnUploads[0]!),
          decipher.final(),
        ]);
        t.assert(plain.equals(content), "CDN 密文解密后应与原文一致（加密链路正确）");

        // 3) 说明文字先以文本消息发出
        const caption = mock.sentMessages.find((m) => m.text.includes("报告来了"));
        t.assert(caption !== undefined, "caption 应以文本消息先发送");
        t.assert(caption!.to === "wxuser-1", "caption 接收方正确");
        await adapter.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-29", "微信官方通道", "图片发送：type 2 图片消息（media_type=1）", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-img-"));
      try {
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1",
          stateDir,
        });
        await adapter.start();

        const img = Buffer.from("\x89PNG\r\n\x1a\n mock-image-bytes");
        await adapter.sendFile("wx:wxuser-1", {
          fileName: "chart.png",
          content: img,
          size: img.length,
          mimeType: "image/png",
        });

        await poll(() => mock.uploadUrlRequests.length > 0, {
          timeoutMs: 15_000,
          msg: "应发起 getuploadurl",
        });
        t.assert(mock.uploadUrlRequests[0]!.media_type === 1, `图片 media_type 应为 1，实际 ${mock.uploadUrlRequests[0]!.media_type}`);
        await poll(() => mock.sentItems.length > 0, { timeoutMs: 15_000, msg: "应发送图片消息" });
        const imgItem = mock.sentItems.find((s) => s.type === 2);
        t.assert(imgItem !== undefined, "应发送 type 2 图片消息");
        const imageItem = (imgItem!.item as { image_item: any }).image_item;
        t.assert(imageItem.media.encrypt_query_param === "mock-download-param", "图片应带下载参数");
        t.assert(imageItem.mid_size === Math.ceil((img.length + 1) / 16) * 16, "mid_size 应为密文大小");
        t.assert(!mock.sentMessages.some((m) => m.text.length > 0), "无 caption 时不应发送文本消息");
        await adapter.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-30", "微信官方通道", "引用消息解析：title 摘要 + 被引用文本/媒体（issue #25）", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-quote-"));
      try {
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1",
          stateDir,
        });
        const received: Array<{ chatId: string; text: string }> = [];
        adapter.onMessage((m) => received.push(m));

        // 单次轮询返回一批消息，覆盖：普通文本 / 引用文本 / 仅 title 摘要 / 引用媒体
        const msgs = [
          // 1) 普通文本（回归）：不应出现引用前缀
          { from_user_id: "wxuser-1", message_type: 1, item_list: [{ type: 1, text_item: { text: "普通消息文本" } }] },
          // 2) 引用文本 + title 摘要：两者都应解析
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [
              {
                type: 1,
                text_item: { text: "回复内容" },
                ref_msg: { title: "文章标题", message_item: { type: 1, text_item: { text: "被引用的文本" } } },
              },
            ],
          },
          // 3) 仅 title 摘要（issue #25 根因场景）：此前会完全丢失
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "看到了吗" }, ref_msg: { title: "仅摘要标题" } }],
          },
          // 4) 引用图片
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "这是什么图" }, ref_msg: { message_item: { type: 2 } } }],
          },
          // 5) 引用文件
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "文件呢" }, ref_msg: { message_item: { type: 4 } } }],
          },
          // 6) 引用语音
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "语音内容" }, ref_msg: { message_item: { type: 3 } } }],
          },
          // 7) 引用视频
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: "视频链接" }, ref_msg: { message_item: { type: 5 } } }],
          },
          // 8) title + 引用媒体组合
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [
              { type: 1, text_item: { text: "标题下的图" }, ref_msg: { title: "带图标题", message_item: { type: 2 } } },
            ],
          },
        ];
        mock.updatesQueue.push({ ret: 0, get_updates_buf: "buf-quote", msgs });

        await adapter.start();
        await poll(() => received.length >= msgs.length, {
          timeoutMs: 15_000,
          msg: "应收到全部引用消息回调",
        });

        const texts = received.map((m) => m.text);
        t.assertEqual(texts[0], "普通消息文本", "普通文本应原样透传（无引用前缀）");
        t.assertEqual(texts[1], "[引用: 文章标题 | 被引用的文本]\n回复内容", "引用文本+title 应完整解析");
        t.assertEqual(texts[2], "[引用: 仅摘要标题]\n看到了吗", "仅 title 摘要不应丢失（issue #25 根因）");
        t.assertEqual(texts[3], "[引用: [引用图片]]\n这是什么图", "引用图片应有类型提示");
        t.assertEqual(texts[4], "[引用: [引用文件]]\n文件呢", "引用文件应有类型提示");
        t.assertEqual(texts[5], "[引用: [引用语音]]\n语音内容", "引用语音应有类型提示");
        t.assertEqual(texts[6], "[引用: [引用视频]]\n视频链接", "引用视频应有类型提示");
        t.assertEqual(texts[7], "[引用: 带图标题 | [引用图片]]\n标题下的图", "title+媒体应组合解析");
        await adapter.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-31", "微信官方通道", "多条 item 合并：引用内容以独立 item 下发时不丢用户指令（issue #25）", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-quote-multi-"));
      try {
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1",
          stateDir,
        });
        const received: Array<{ chatId: string; text: string }> = [];
        adapter.onMessage((m) => received.push(m));

        // 真实引用消息可能以多条 item 下发：被引用内容 + 用户指令
        const msgs = [
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [
              { type: 1, text_item: { text: "被引用的历史消息内容" } },
              { type: 1, text_item: { text: "看下这个产出物" } },
            ],
          },
        ];
        mock.updatesQueue.push({ ret: 0, get_updates_buf: "buf-quote-multi", msgs });

        await adapter.start();
        await poll(() => received.length >= 1, {
          timeoutMs: 15_000,
          msg: "应收到多 item 合并后的消息",
        });

        t.assertEqual(
          received[0].text,
          "被引用的历史消息内容\n看下这个产出物",
          "多条文本 item 应合并，不丢失用户指令",
        );
        await adapter.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-32", "微信官方通道", "真实 iLink 引用载荷：type=0 仅 msg_id，注册表还原 + 兜底占位 + 大整数 id 解析（issue #25）", async (t) => {
      // 大整数安全解析：19 位 message_id 不能被精度丢失
      const parsed = jsonParseSafe('{"message_id":7495099801417603848}') as { message_id: unknown };
      t.assertEqual(parsed.message_id, "7495099801417603848", "超 2^53 的 message_id 应保持精确字符串");

      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-ref-"));
      try {
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1",
          stateDir,
        });
        const received: Array<{ chatId: string; text: string }> = [];
        adapter.onMessage((m) => received.push(m));

        const msgs = [
          // 1) 历史消息（稍后被引用）：顶层 message_id 与 item msg_id 都登记进注册表
          {
            message_id: "7495099801417603848",
            from_user_id: "wxuser-1",
            message_type: 1,
            create_time_ms: 1786971042000,
            item_list: [{ type: 1, msg_id: "v1:hist1", create_time_ms: 1786971042000, text_item: { text: "这是我的产出物报告" } }],
          },
          // 2) 真实引用载荷：ref_msg.message_item.type=0、仅 msg_id（引用上面那条）
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [
              {
                type: 1,
                msg_id: "v1:cur1",
                text_item: { text: "看下这个产出物" },
                ref_msg: { message_item: { type: 0, msg_id: "7495099801417603848", create_time_ms: 1786971042000 } },
              },
            ],
          },
          // 3) 引用未知 id（注册表查不到）→ 兜底占位，Coordinator 至少知道存在引用
          {
            from_user_id: "wxuser-1",
            message_type: 1,
            item_list: [
              {
                type: 1,
                msg_id: "v1:cur2",
                text_item: { text: "这条是什么" },
                ref_msg: { message_item: { type: 0, msg_id: "999888777666555444", create_time_ms: 1786971042000 } },
              },
            ],
          },
        ];
        mock.updatesQueue.push({ ret: 0, get_updates_buf: "buf-ref", msgs });

        await adapter.start();
        await poll(() => received.length >= 3, {
          timeoutMs: 15_000,
          msg: "应收到 3 条消息",
        });

        t.assertEqual(received[1].text, "[引用: 这是我的产出物报告]\n看下这个产出物", "注册表命中：应还原被引用内容");
        t.assert(
          /^\[引用: \[消息 999888777666555444，发送于 \d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\]\n这条是什么$/.test(
            received[2].text,
          ),
          `注册表未命中：应输出 id+时间兜底占位，实际: ${received[2].text}`,
        );
        await adapter.stop();
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  results.push(
    await runCase("U-33", "微信官方通道", "出站消息回显关联：bot 回复被用户引用时可按 client_id 还原内容（issue #25）", async (t) => {
      const mock = await createMockWeixinServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-wx-out-"));
      try {
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1",
          stateDir,
        });
        const received: Array<{ chatId: string; text: string }> = [];
        adapter.onMessage((m) => received.push(m));
        await adapter.start();

        // bot 发送回复 → mock 记录 client_id（sendmessage 响应不带 message_id）
        await adapter.send("wx:wxuser-1", "这是 bot 的回复内容");
        const clientId = mock.sentClientIds[0] ?? "";
        t.assert(clientId.startsWith("circle-"), "应生成 circle- 前缀的 client_id");

        // 微信将 bot 消息回显（message_type=2，带 client_id 与 msg_id）→ 注册表关联发送文本
        // 随后用户引用该 bot 消息 → 应还原出 bot 回复内容
        mock.updatesQueue.push({
          ret: 0,
          get_updates_buf: "buf-out",
          msgs: [
            {
              from_user_id: "aebef8716ba6@im.bot",
              to_user_id: "wxuser-1",
              client_id: clientId,
              message_type: 2,
              create_time_ms: 1786971042000,
              item_list: [{ type: 1, msg_id: "7495099801417603848", text_item: { text: "" } }],
            },
            {
              from_user_id: "wxuser-1",
              message_type: 1,
              item_list: [
                {
                  type: 1,
                  msg_id: "v1:cur3",
                  text_item: { text: "再发一遍" },
                  ref_msg: { message_item: { type: 0, msg_id: "7495099801417603848", create_time_ms: 1786971042000 } },
                },
              ],
            },
          ],
        });

        await poll(() => received.length >= 1, {
          timeoutMs: 15_000,
          msg: "应收到引用 bot 回复的消息",
        });
        t.assertEqual(received[0].text, "[引用: 这是 bot 的回复内容]\n再发一遍", "出站回显关联：应还原 bot 回复内容");
        await adapter.stop();
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
