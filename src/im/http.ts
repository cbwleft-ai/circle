/**
 * HTTP 适配器：提供 REST 接口供任意 IM 网关（企业微信、钉钉、飞书等）回调对接。
 *
 * - POST /message  body: { chatId, text }  上行消息
 * - GET  /health                           健康检查
 * - GET  /ping                             存活检查（用于网关校验）
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ChatAttachment, ChatMessage } from "../core/types.js";
import { log } from "../core/logger.js";
import type { ImAdapter } from "./adapter.js";

export class HttpAdapter implements ImAdapter {
  readonly name = "http";
  private handler?: (msg: ChatMessage) => void;
  private server?: ReturnType<typeof createServer>;

  constructor(private readonly port: number) {}

  onMessage(cb: (msg: ChatMessage) => void): void {
    this.handler = cb;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((e) => {
        log.error("im:http", `请求处理失败: ${(e as Error).message}`);
        writeJson(res, 500, { ok: false, error: String((e as Error).message) });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, resolve));
    log.info("im:http", `HTTP 适配器已启动，监听端口 ${this.port}`);
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ping")) {
      writeJson(res, 200, { ok: true, service: "circle-agent-team", ts: Date.now() });
      return;
    }
    if (req.method === "POST" && url.pathname === "/message") {
      const body = await readBody(req);
      const { chatId, text, attachments } = JSON.parse(body) as {
        chatId?: string;
        text?: string;
        attachments?: ChatAttachment[];
      };
      if (!chatId || (!text && !(attachments && attachments.length > 0))) {
        writeJson(res, 400, { ok: false, error: "需要 chatId 与 text/attachments 字段" });
        return;
      }
      // 异步处理，立即返回 202
      const cb = this.handler;
      if (cb) {
        setImmediate(() => cb({ chatId, text: text ?? "", attachments }));
      }
      writeJson(res, 202, { ok: true, received: true });
      return;
    }
    writeJson(res, 404, { ok: false, error: "not found" });
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  async send(chatId: string, text: string): Promise<void> {
    // HTTP 通道的"下行"由接入方通过自身网关推送；
    // 这里把消息写入日志，并可选回调 http 下行 hook。
    log.info("im:http", `下行消息 → ${chatId}: ${text.slice(0, 200)}`);
    this.downstreamHook?.(chatId, text);
  }

  /** 接入方可注入下行回调（例如转发给企业微信/钉钉机器人 webhook） */
  downstreamHook?: (chatId: string, text: string) => void;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      // 10MB 上限：容纳 base64 图片附件（多模态，issue #3）
      if (data.length > 10_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, code: number, obj: unknown) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}
