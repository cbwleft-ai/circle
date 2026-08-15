/**
 * 多模态（图片/视觉输入）能力测试
 *
 * 覆盖（issue #3 支持多模态能力：图片/视觉输入）：
 *   M-01 supportsVision：模型视觉能力判定
 *   M-02 AttachmentStore：附件落盘（base64 → 文件）
 *   M-03 buildMessageWithAttachments：附件路径注入消息文本
 *   M-04 HTTP 适配器：/message 携带附件上行
 *   M-05 微信官方通道：图片消息提取为附件（mock 服务器）
 *   M-06 Worker 视觉模型解析 + 内置视觉技能安装
 *   M-07 （LLM）端到端：用户发图 → 附件落盘 → Coordinator 派发 → Worker 执行
 */
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCase, sleep, type TestResult } from "./helpers.js";
import { supportsVision, type AppConfig } from "../src/config.js";
import { AttachmentStore, buildMessageWithAttachments } from "../src/core/upload.js";
import { WorkerAgent } from "../src/agents/worker.js";
import { HttpAdapter } from "../src/im/http.js";
import { WeixinIlinkAdapter } from "../src/im/weixin-ilink.js";
import type { WorkerConfig } from "../src/core/types.js";

const PNG_1PX_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export async function runMultimodalTests(): Promise<TestResult[]> {
  const results: TestResult[] = [];
  const llmEnabled = (process.env.CIRCLE_LLM_TESTS ?? "1") === "1";

  // ---------- M-01 supportsVision ----------
  results.push(
    await runCase("M-01", "多模态: 视觉能力判定", "supportsVision 识别模型 input 含 image", async (t) => {
      t.assert(supportsVision({ input: ["text", "image"] }), "input 含 image 应判定支持视觉");
      t.assert(!supportsVision({ input: ["text"] }), "input 仅 text 应判定不支持视觉");
      t.assert(!supportsVision({ input: [] }), "空 input 应判定不支持视觉");
      t.assert(!supportsVision(undefined), "undefined 应判定不支持视觉");
      t.assert(!supportsVision({}), "无 input 字段应判定不支持视觉");
    }),
  );

  // ---------- M-02 AttachmentStore ----------
  results.push(
    await runCase("M-02", "多模态: 附件落盘", "AttachmentStore 将 base64 图片写入 uploads", async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "circle-mm-upload-"));
      try {
        const store = new AttachmentStore(join(dir, "uploads"));
        const saved = store.save("wx:user-1", [
          {
            kind: "image",
            name: "demo.png",
            mimeType: "image/png",
            data: PNG_1PX_BASE64,
          },
        ]);
        t.assertEqual(saved.length, 1, "应保存 1 个附件");
        const s = saved[0]!;
        t.assert(s.localPath.includes("uploads"), `应落在 uploads 下: ${s.localPath}`);
        t.assert(s.name === "demo.png", `文件名应保留: ${s.name}`);
        t.assert(s.mimeType === "image/png", "mimeType 应保留");
        t.assert(existsSync(s.localPath), "落盘文件应存在");
        const bytes = readFileSync(s.localPath);
        t.assertEqual(
          bytes.toString("base64"),
          PNG_1PX_BASE64,
          "落盘内容应与 base64 一致",
        );
        // 无 data 的附件应被跳过
        t.assertEqual(store.save("wx:user-1", [{ kind: "image", name: "x.png" }]).length, 0, "无数据附件应跳过");
        // localPath 直通
        const pass = store.save("wx:user-1", [{ kind: "image", name: "y.png", localPath: s.localPath }]);
        t.assertEqual(pass.length, 1, "localPath 附件应直通");
        t.assertEqual(pass[0]!.localPath, s.localPath, "localPath 应原样保留");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }),
  );

  // ---------- M-03 buildMessageWithAttachments ----------
  results.push(
    await runCase("M-03", "多模态: 消息富化", "图片附件路径注入消息文本", async (t) => {
      const img = { kind: "image" as const, name: "a.png", localPath: "/data/uploads/1.png" };
      // 纯图片
      const pure = buildMessageWithAttachments("", [img]);
      t.assert(pure.includes("【图片】/data/uploads/1.png"), "纯图片消息应包含图片标记");
      t.assert(pure.includes("描述"), "纯图片消息应包含默认处理指令");
      // 图片 + 文本
      const mixed = buildMessageWithAttachments("请描述这张图", [img]);
      t.assert(mixed.includes("【图片】/data/uploads/1.png"), "混合消息应包含图片标记");
      t.assert(mixed.includes("用户消息：请描述这张图"), "混合消息应保留用户文本");
      // 无附件原样返回
      t.assertEqual(buildMessageWithAttachments("你好", []), "你好", "无附件应原样返回");
    }),
  );

  // ---------- M-04 HTTP 适配器 ----------
  results.push(
    await runCase("M-04", "多模态: HTTP 适配器", "/message 支持 attachments 上行", async (t) => {
      const adapter = new HttpAdapter(0);
      const received: Array<{ chatId: string; text: string; attachments: unknown[] }> = [];
      adapter.onMessage((m) =>
        received.push({ chatId: m.chatId, text: m.text, attachments: m.attachments ?? [] }),
      );
      await adapter.start();
      const port = (adapter as unknown as { server: Server }).server.address() as { port: number };
      const base = `http://127.0.0.1:${port.port}`;
      try {
        // 携带附件
        const res = await fetch(`${base}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: "u1",
            text: "看看这张图",
            attachments: [{ kind: "image", name: "pic.png", mimeType: "image/png", data: PNG_1PX_BASE64 }],
          }),
        });
        t.assertEqual(res.status, 202, "应返回 202");
        await sleep(200);
        t.assertEqual(received.length, 1, "应收到 1 条消息");
        const msg = received[0]!;
        t.assertEqual(msg.chatId, "u1", "chatId 应透传");
        t.assertEqual(msg.text, "看看这张图", "text 应透传");
        t.assertEqual(msg.attachments.length, 1, "attachments 应透传");
        t.assertEqual((msg.attachments[0] as { name: string }).name, "pic.png", "附件名应透传");
        // 只有附件无文本也合法
        const res2 = await fetch(`${base}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: "u2", attachments: [{ kind: "image", data: PNG_1PX_BASE64 }] }),
        });
        t.assertEqual(res2.status, 202, "纯附件消息应返回 202");
        await sleep(200);
        t.assertEqual(received.length, 2, "应收到第 2 条消息");
        t.assertEqual(received[1]!.text, "", "纯附件消息 text 应为空串");
        // 缺 text 且无附件 → 400
        const res3 = await fetch(`${base}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chatId: "u3" }),
        });
        t.assertEqual(res3.status, 400, "无文本无附件应返回 400");
      } finally {
        await adapter.stop();
      }
    }),
  );

  // ---------- M-05 微信官方通道图片提取 ----------
  results.push(
    await runCase("M-05", "多模态: 微信官方通道", "图片消息提取为附件（不再仅返回占位文本）", async (t) => {
      const mock = await createImageMockServer();
      const stateDir = mkdtempSync(join(tmpdir(), "circle-mm-wx-"));
      try {
        // 预置一条图片消息
        mock.updatesQueue.push({
          ret: 0,
          get_updates_buf: "buf-img",
          msgs: [
            {
              from_user_id: "wxuser-img",
              message_type: 1,
              item_list: [
                {
                  type: 2,
                  image_item: { url: `${mock.baseUrl}/img/pic.png`, name: "pic.png" },
                },
              ],
            },
          ],
        });
        const adapter = new WeixinIlinkAdapter({
          baseUrl: mock.baseUrl,
          botToken: "mock-bot-token-1",
          stateDir,
        });
        const received: Array<{ text: string; attachments?: unknown[] }> = [];
        adapter.onMessage((m) => received.push({ text: m.text, attachments: m.attachments }));
        await adapter.start();
        try {
          // 等待图片消息回调
          const deadline = Date.now() + 15_000;
          while (received.length === 0 && Date.now() < deadline) {
            await sleep(300);
          }
          t.assert(received.length === 1, `应收到图片消息，实际 ${received.length}`);
          const msg = received[0]!;
          t.assertEqual(msg.text, "", "成功提取附件后 text 不应是占位文本");
          t.assert(Array.isArray(msg.attachments) && msg.attachments.length === 1, "应提取 1 个图片附件");
          const att = msg.attachments![0] as { kind: string; name: string; mimeType?: string; data?: string };
          t.assertEqual(att.kind, "image", "附件类型应为 image");
          t.assertEqual(att.name, "pic.png", "附件名应为 pic.png");
          t.assertEqual(att.mimeType, "image/png", "mimeType 应为 image/png");
          // 下载内容应与 mock 提供的图片字节一致
          const expected = Buffer.from(PNG_1PX_BASE64, "base64");
          t.assertEqual(Buffer.from(att.data ?? "", "base64").equals(expected), true, "附件数据应与图片一致");
        } finally {
          await adapter.stop();
        }
      } finally {
        await mock.close();
        rmSync(stateDir, { recursive: true, force: true });
      }
    }),
  );

  // ---------- M-06 Worker 视觉模型解析 + 技能安装 ----------
  results.push(
    await runCase("M-06", "多模态: Worker 视觉模型解析", "视觉任务使用视觉模型，普通任务用默认模型", async (t) => {
      const cwd = mkdtempSync(join(tmpdir(), "circle-mm-worker-"));
      try {
        const visionModel = { id: "gpt-4o", input: ["text", "image"] };
        const defaultModel = { id: "deepseek-v4-flash", input: ["text"] };
        const runtime = {
          getModel: (p: string, id: string) =>
            id === "gpt-4o" ? visionModel : id === "deepseek-v4-flash" ? defaultModel : undefined,
        } as never;

        const cfg = {
          name: "dev",
          description: "test",
          cwd,
        } as WorkerConfig;

        const appConfig = {
          modelProvider: "deepseek",
          modelId: "deepseek-v4-flash",
          visionModelProvider: "openai",
          visionModelId: "gpt-4o",
        } as unknown as AppConfig;

        const worker = new WorkerAgent(cfg, runtime, appConfig);

        // 视觉任务 + 视觉模型已配置 → 返回视觉模型
        const visionTask = {
          id: "T-1",
          title: "读图",
          description: "读取图片 /tmp/x.png 并描述内容",
        } as never;
        const m1 = worker.resolveModel(visionTask);
        t.assert(m1 !== undefined, "视觉模型应解析成功");
        t.assertEqual(m1!.id, "gpt-4o", "视觉任务应使用视觉模型");
        t.assert(supportsVision(m1), "视觉模型应支持图片输入");

        // 非视觉任务 → 默认模型
        const textTask = {
          id: "T-2",
          title: "写脚本",
          description: "写一个 hello world 脚本并运行",
        } as never;
        const m2 = worker.resolveModel(textTask);
        t.assert(m2 !== undefined, "默认模型应解析成功");
        t.assertEqual(m2!.id, "deepseek-v4-flash", "普通任务应使用默认模型");

        // 视觉任务 + 未配置视觉模型（与默认相同）→ 默认模型
        const sameCfg = {
          modelProvider: "deepseek",
          modelId: "deepseek-v4-flash",
          visionModelProvider: "deepseek",
          visionModelId: "deepseek-v4-flash",
        } as unknown as AppConfig;
        const worker2 = new WorkerAgent(cfg, runtime, sameCfg);
        const m3 = worker2.resolveModel(visionTask);
        t.assert(m3 !== undefined, "默认模型应解析成功");
        t.assertEqual(m3!.id, "deepseek-v4-flash", "视觉模型与默认相同时应使用默认模型");

        // isVisionTask 判定
        t.assert(WorkerAgent.isVisionTask({ title: "OCR", description: "识别图中文字" }), "OCR 应判为视觉任务");
        t.assert(
          WorkerAgent.isVisionTask({ title: "看图", description: "读取 demo.png 并描述图片内容" }),
          "描述图片应判为视觉任务",
        );
        t.assert(
          !WorkerAgent.isVisionTask({ title: "写脚本", description: "echo hi" }),
          "普通任务不应判为视觉任务",
        );

        // 内置视觉技能安装到工作区
        worker.ensureWorkspace();
        const skillFile = join(cwd, ".pi", "skills", "vision.md");
        t.assert(existsSync(skillFile), "应安装内置视觉技能 vision.md");
        const skillText = readFileSync(skillFile, "utf-8");
        t.assert(skillText.includes("视觉") || skillText.includes("OCR"), "技能内容应包含视觉/OCR 指引");
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }),
  );

  // ---------- M-07 （LLM）端到端：用户发图 ----------
  results.push(
    await runCase(
      "M-07",
      "多模态: 端到端（LLM）",
      "用户发送图片 → 附件落盘 → Coordinator 派发 → Worker 执行",
      async (t) => {
        const { createTestTeam, cleanupTestDir, poll } = await import("./helpers.js");
        const dataDir = mkdtempSync(join(tmpdir(), "circle-mm-e2e-"));
        const { team, adapter } = await createTestTeam({
          configOverrides: { dataDir },
        });
        try {
          const t0 = Date.now();
          const before = adapter.sent.length;
          await adapter.inject(
            "console",
            "请派一个短程任务给 default Worker：读取我发送的图片文件并描述图片内容（若模型不支持视觉则说明无法看图）",
            [
              {
                kind: "image",
                name: "e2e.png",
                mimeType: "image/png",
                data: PNG_1PX_BASE64,
              },
            ],
          );
          // 1) 附件已落盘
          const uploadsRoot = join(dataDir, "uploads");
          const savedFile = await poll(
            () => {
              if (!existsSync(uploadsRoot)) return undefined;
              const files = readdirSync(uploadsRoot, { recursive: true }) as string[];
              return files.find((f) => f.includes("e2e.png")) ?? undefined;
            },
            { timeoutMs: 30_000, msg: "图片附件应落盘到 uploads" },
          );
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 附件已落盘: ${savedFile}`);

          // 2) Coordinator 应派发任务并执行完成（短程任务同一轮返回结果）
          const reply = await adapter.waitFor(
            (x) => x.includes("图片") || x.includes("无法") || x.includes("e2e.png") || x.includes("任务"),
            { timeoutMs: 240_000, since: Date.now() - 1000 },
          );
          t.assert(reply.length > 0, "应收到 Coordinator 的最终回复");
          t.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] 最终回复: ${reply.slice(0, 200)}…`);

          // 3) 任务已创建且完成
          await poll(
            () =>
              team.taskStore
                .list()
                .find((x) => x.requestedBy === "user" && x.status === "completed") !== undefined,
            { timeoutMs: 30_000, msg: "图片任务应已完成" },
          );
          t.log(`共 ${adapter.sent.length - before} 条回复，图片任务链路已打通。`);
        } finally {
          await team.stop();
          cleanupTestDir(dataDir);
        }
      },
      { skip: !llmEnabled, timeoutMs: 360_000 },
    ),
  );

  return results;
}

// ============================================================================
// 微信图片 mock 服务器（复用官方 API mock + 图片资源服务）
// ============================================================================

interface ImageMockServer {
  server: Server;
  baseUrl: string;
  updatesQueue: unknown[];
  close(): Promise<void>;
}

function createImageMockServer(): Promise<ImageMockServer> {
  const state = { updatesQueue: [] as unknown[] };
  const mock = state as ImageMockServer;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    // 图片资源
    if (req.method === "GET" && url.pathname === "/img/pic.png") {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(Buffer.from(PNG_1PX_BASE64, "base64"));
      return;
    }
    if (req.method === "POST" && url.pathname === "/ilink/bot/getupdates") {
      const next = state.updatesQueue.shift();
      send(200, next ?? { ret: 0, msgs: [], get_updates_buf: "buf-idle" });
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

/** 独立运行入口 */
if (process.argv[1]?.endsWith("multimodal.test.ts")) {
  const { renderReport } = await import("./helpers.js");
  const results = await runMultimodalTests();
  console.log(renderReport(results));
  process.exit(results.some((r) => !r.passed && !r.skipped) ? 1 : 0);
}
