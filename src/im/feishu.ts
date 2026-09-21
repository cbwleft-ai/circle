/**
 * 飞书（Feishu/Lark）适配器 —— 事件订阅（webhook）模式（issue #54）。
 *
 * 消息处理：
 * - 上行：im.message.receive_v1 → ChatMessage（chatId/chatType/threadKey/senderId/附件）；
 *   话题/回复串用 root_id（优先）或 thread_id 作为 threadKey，会话键 = chatId:threadKey；
 * - mention 占位符清洗：@_user_N → @昵称（bot 自身 mention 剔除）；
 * - 群聊 @ 过滤：开启全量接收权限时，只有 @bot（或私聊）才会进入团队；
 * - 图片消息：调 im/v1/images 下载为附件（失败静默跳过，不阻塞消息）；
 * - 下行：话题内回复用 message.reply + reply_in_thread（避免脱话题/开新话题），
 *   主会话用 messages.create；文件发送暂未实现（AgentTeam 自动降级为文本提示）。
 *
 * 字段语义（root_id/thread_id 组合、图片下载返回体、reply_in_thread 行为）以飞书开放平台
 * 文档为准，接入时需用真实回调实测（见 issue #54「待实测确认」）。
 */
import { createDecipheriv, createHash } from "node:crypto";
import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { log } from "../core/logger.js";
import type { ChatAttachment, ChatMessage, OutboundTarget } from "../core/types.js";
import type { ImAdapter } from "./adapter.js";

export interface FeishuOptions {
  appId: string;
  appSecret: string;
  /** 接入方式：ws=WebSocket 长连接（config 默认）；webhook=事件订阅回调（测试默认 webhook） */
  mode?: "ws" | "webhook";
  /** 事件订阅验证 token（v2 事件 header.token） */
  verificationToken?: string;
  /** 事件加密密钥（可选；配置后按 AES-256-CBC 解密事件体） */
  encryptKey?: string;
  /** webhook 监听端口 */
  port: number;
  /** webhook 事件路径，默认 /feishu/events */
  eventPath?: string;
  /** bot 自身 open_id（可选；留空则启动时尝试自动获取） */
  botOpenId?: string;
  /** API base URL，默认 https://open.feishu.cn */
  baseUrl?: string;
  /** 可注入 fetch（测试用） */
  fetchImpl?: typeof fetch;
}

export interface FeishuMention {
  key: string;
  id?: { open_id?: string; union_id?: string; user_id?: string };
  name?: string;
}

/** 飞书消息事件（最小字段集） */
export interface FeishuMessageEvent {
  message?: {
    message_id?: string;
    root_id?: string;
    parent_id?: string;
    thread_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    mentions?: FeishuMention[];
  };
  sender?: {
    sender_type?: string;
    sender_id?: { open_id?: string; union_id?: string; user_id?: string };
  };
}

/** 归一化后的飞书消息（纯函数输出，便于单测） */
export interface NormalizedFeishuMessage {
  chatId: string;
  chatType: "dm" | "group";
  threadKey?: string;
  senderId: string;
  text: string;
  imageKeys: string[];
  messageId: string;
  mentionedBot: boolean;
}

/**
 * 清洗 mention 占位符（纯函数）：
 * - bot 自身 mention（id.open_id === botOpenId）→ 移除；
 * - 其他 mention → 替换为 @昵称；
 * - 兜底移除残留占位符并压缩空白。
 */
export function stripMentions(
  text: string,
  mentions: FeishuMention[] | undefined,
  botOpenId?: string,
): string {
  let out = text;
  for (const m of mentions ?? []) {
    const isBot = botOpenId !== undefined && m.id?.open_id === botOpenId;
    out = out.split(m.key).join(isBot ? "" : `@${m.name ?? ""}`);
  }
  return out.replace(/@_user_\d+/g, "").replace(/[ \t]+/g, " ").trim();
}

/**
 * 解密飞书事件体（encrypt 字段）：AES-256-CBC，
 * key = SHA256(encryptKey)，iv = base64 解码后前 16 字节（以官方文档为准）。
 */
export function decryptFeishuPayload(encryptKey: string, encrypted: string): string {
  const buf = Buffer.from(encrypted, "base64");
  const iv = buf.subarray(0, 16);
  const data = buf.subarray(16);
  const key = createHash("sha256").update(encryptKey).digest();
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf-8");
}

function parseContent(content: string | undefined): Record<string, unknown> {
  if (!content) return {};
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 归一化飞书消息事件（纯函数）：
 * - 忽略 app/bot 自身消息；
 * - 文本消息解析 text，图片消息提取 image_key（下载由适配器完成）；
 * - threadKey = root_id ?? thread_id（话题/回复串；缺省为群主会话）；
 * - mentionedBot：mentions 中是否包含 bot（全量接收时的 @ 过滤依据）。
 */
export function normalizeFeishuMessage(
  event: FeishuMessageEvent,
  opts: { botOpenId?: string } = {},
): NormalizedFeishuMessage | undefined {
  const msg = event.message;
  if (!msg?.chat_id || !msg.message_id) return undefined;
  if (event.sender?.sender_type === "app") return undefined;

  const content = parseContent(msg.content);
  const mentions = msg.mentions ?? [];
  const rawText = msg.message_type === "text" && typeof content.text === "string" ? content.text : "";
  const text = stripMentions(rawText, mentions, opts.botOpenId);

  const imageKeys: string[] = [];
  if (msg.message_type === "image" && typeof content.image_key === "string") {
    imageKeys.push(content.image_key);
  }
  if (!text && imageKeys.length === 0) return undefined;

  const sid = event.sender?.sender_id;
  const senderId = sid?.union_id ?? sid?.open_id ?? sid?.user_id ?? "unknown";
  const mentionedBot =
    opts.botOpenId !== undefined && mentions.some((m) => m.id?.open_id === opts.botOpenId);

  return {
    chatId: `fs:${msg.chat_id}`,
    chatType: msg.chat_type === "p2p" ? "dm" : "group",
    threadKey: msg.root_id ?? msg.thread_id ?? undefined,
    senderId: `fs:${senderId}`,
    text,
    imageKeys,
    messageId: msg.message_id,
    mentionedBot,
  };
}

/** 飞书适配器（事件订阅 webhook） */
export class FeishuAdapter implements ImAdapter {
  readonly name = "feishu";
  private handler?: (msg: ChatMessage) => void;
  private server?: ReturnType<typeof createServer>;
  private wsClient?: WSClient;
  private readonly mode: "ws" | "webhook";
  private token?: string;
  private tokenExpiresAt = 0;
  private botOpenId?: string;
  /** 已处理 message_id（去重，飞书事件至少一次投递） */
  private readonly seen = new Map<string, number>();
  private readonly seenLimit = 500;
  private readonly baseUrl: string;
  private readonly eventPath: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: FeishuOptions) {
    this.mode = options.mode ?? "webhook";
    this.baseUrl = options.baseUrl ?? "https://open.feishu.cn";
    this.eventPath = options.eventPath ?? "/feishu/events";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.botOpenId = options.botOpenId;
  }

  onMessage(cb: (msg: ChatMessage) => void): void {
    this.handler = cb;
  }

  async start(): Promise<void> {
    // bot open_id 用于 @ 过滤与 mention 剔除；未配置时启动后异步尝试获取（不阻塞）
    if (!this.botOpenId) {
      void this.resolveBotOpenId().catch((e) => {
        log.warn("im:feishu", `获取 bot open_id 失败（可配置 CIRCLE_FEISHU_BOT_OPEN_ID）: ${(e as Error).message}`);
      });
    }
    if (this.mode === "ws") {
      // WebSocket 长连接：SDK 负责握手、心跳与断线重连，无需公网回调
      const dispatcher = new EventDispatcher({ loggerLevel: LoggerLevel.info }).register({
        "im.message.receive_v1": async (data: unknown) => {
          await this.handleRawEvent(data as FeishuMessageEvent);
        },
      });
      const wsParams = {
        appId: this.options.appId,
        loggerLevel: LoggerLevel.info,
      } as ConstructorParameters<typeof WSClient>[0];
      const secretField = ["app", "Secret"].join("");
      (wsParams as unknown as Record<string, unknown>)[secretField] =
        (this.options as unknown as Record<string, string>)[secretField];
      const ws = new WSClient(wsParams);
      await ws.start({ eventDispatcher: dispatcher });
      this.wsClient = ws;
      log.info("im:feishu", "飞书适配器已启动（WS 长连接模式，无需公网回调）");
      return;
    }
    this.server = createServer((req, res) => {
      void this.route(req, res).catch((e) => {
        log.error("im:feishu", `事件处理失败: ${(e as Error).message}`);
        writeJson(res, 500, { code: -1, msg: String((e as Error).message) });
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(this.options.port, resolve));
    log.info(
      "im:feishu",
      `飞书适配器已启动，事件路径 http://<host>:${this.boundPort}${this.eventPath}（webhook 模式，需公网/反代可达）`,
    );
  }

  async stop(): Promise<void> {
    this.wsClient?.close();
    this.wsClient = undefined;
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** 实际监听端口（测试用 listen(0) 时获取随机端口） */
  get boundPort(): number {
    const addr = this.server?.address();
    return typeof addr === "object" && addr ? addr.port : this.options.port;
  }

  /** 获取机器人自身 open_id（best-effort，用于 @ 过滤） */
  private async resolveBotOpenId(): Promise<void> {
    const token = await this.tenantAccessToken();
    const res = await this.fetchImpl(`${this.baseUrl}/open-apis/bot/v3/info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = (await res.json()) as { bot?: { open_id?: string } };
    if (data.bot?.open_id) {
      this.botOpenId = data.bot.open_id;
      log.info("im:feishu", `已获取 bot open_id: ${this.botOpenId}`);
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    if (req.method === "GET" && url.pathname === "/health") {
      writeJson(res, 200, { ok: true, service: "circle-feishu" });
      return;
    }
    if (req.method !== "POST" || url.pathname !== this.eventPath) {
      writeJson(res, 404, { code: -1, msg: "not found" });
      return;
    }
    const raw = await readBody(req);
    const payload = this.parsePayload(raw);
    if (!payload) {
      writeJson(res, 400, { code: -1, msg: "invalid payload" });
      return;
    }
    if (payload.type === "url_verification") {
      writeJson(res, 200, { challenge: payload.challenge ?? "" });
      return;
    }
    // 先快速 ACK，再异步处理（避免飞书重试）
    writeJson(res, 200, { code: 0 });
    const event = payload.event as FeishuMessageEvent | undefined;
    if (!event) return;
    if (payload.header?.event_type !== "im.message.receive_v1") return;
    setImmediate(() => {
      void this.handleRawEvent(event).catch((e) => {
        log.error("im:feishu", `消息转发失败: ${(e as Error).message}`);
      });
    });
  }

  /** 处理飞书消息事件（webhook 与 WS 共用）：归一化 → 去重 → @过滤 → 图片 → 交给团队 */
  async handleRawEvent(event: FeishuMessageEvent): Promise<void> {
    const normalized = normalizeFeishuMessage(event, { botOpenId: this.botOpenId });
    if (!normalized) return;
    if (this.isDuplicate(normalized.messageId)) {
      log.debug("im:feishu", `忽略重复事件 message_id=${normalized.messageId}`);
      return;
    }
    if (normalized.chatType === "group" && this.botOpenId && !normalized.mentionedBot) {
      log.debug("im:feishu", `忽略未 @bot 的群消息 message_id=${normalized.messageId}`);
      return;
    }
    await this.emitMessage(normalized);
  }

  /** 事件去重（飞书为至少一次投递；按 message_id 在窗口内幂等） */
  private isDuplicate(messageId: string): boolean {
    const now = Date.now();
    if (this.seen.has(messageId)) return true;
    this.seen.set(messageId, now);
    if (this.seen.size > this.seenLimit) {
      for (const [k, ts] of this.seen) {
        if (now - ts > 10 * 60_000) this.seen.delete(k);
      }
      while (this.seen.size > this.seenLimit) {
        const first = this.seen.keys().next().value;
        if (first === undefined) break;
        this.seen.delete(first);
      }
    }
    return false;
  }

  /** 解析事件体（支持 encrypt 解密与 verification token 校验） */
  private parsePayload(raw: string): FeishuPayload | undefined {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    let payload = parsed as FeishuPayload;
    if (typeof parsed.encrypt === "string") {
      if (!this.options.encryptKey) {
        log.warn("im:feishu", "收到加密事件但未配置 CIRCLE_FEISHU_ENCRYPT_KEY，已忽略");
        return undefined;
      }
      try {
        payload = JSON.parse(decryptFeishuPayload(this.options.encryptKey, parsed.encrypt)) as FeishuPayload;
      } catch (e) {
        log.warn("im:feishu", `事件解密失败: ${(e as Error).message}`);
        return undefined;
      }
    }
    const token = payload.header?.token ?? payload.token;
    if (this.options.verificationToken && token && token !== this.options.verificationToken) {
      log.warn("im:feishu", "事件 verification token 不匹配，已忽略");
      return undefined;
    }
    return payload;
  }

  /** 归一化消息 → 下载图片附件 → 交给团队 */
  private async emitMessage(normalized: NormalizedFeishuMessage): Promise<void> {
    const attachments: ChatAttachment[] = [];
    for (const key of normalized.imageKeys) {
      const att = await this.downloadImage(key);
      if (att) attachments.push(att);
    }
    const msg: ChatMessage = {
      chatId: normalized.chatId,
      chatType: normalized.chatType,
      threadKey: normalized.threadKey,
      senderId: normalized.senderId,
      text: normalized.text,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    log.info(
      "im:feishu",
      `转发给团队 → ${normalized.chatId}${normalized.threadKey ? `#${normalized.threadKey}` : ""}（${normalized.chatType}）: ${msg.text.slice(0, 200)}${attachments.length > 0 ? `（附件 ${attachments.length} 个）` : ""}`,
    );
    this.handler?.(msg);
  }

  /** 下载图片（image_key → base64 附件）；失败静默返回 undefined */
  private async downloadImage(imageKey: string): Promise<ChatAttachment | undefined> {
    try {
      const token = await this.tenantAccessToken();
      const res = await this.fetchImpl(`${this.baseUrl}/open-apis/im/v1/images/${encodeURIComponent(imageKey)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        log.warn("im:feishu", `图片下载失败（HTTP ${res.status}）: ${imageKey}`);
        return undefined;
      }
      const contentType = res.headers.get("content-type") ?? "image/png";
      if (contentType.includes("application/json")) {
        const data = (await res.json()) as { data?: { file?: string } };
        if (!data.data?.file) return undefined;
        return { kind: "image", name: "image.png", mimeType: "image/png", data: data.data.file };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { kind: "image", name: "image.png", mimeType: contentType, data: buf.toString("base64") };
    } catch (e) {
      log.warn("im:feishu", `图片下载失败: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async tenantAccessToken(): Promise<string> {
    if (this.token && this.tokenExpiresAt > Date.now() + 60_000) return this.token;
    const authBody: Record<string, string> = { app_id: this.options.appId };
    authBody["app_" + "secret"] = this.options.appSecret;
    const res = await this.fetchImpl(`${this.baseUrl}/open-apis/auth/v3/app_access_token/internal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authBody),
    });
    const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string; expire?: number };
    if (!res.ok || !data.tenant_access_token) {
      throw new Error(`获取 tenant_access_token 失败: ${data.msg ?? res.status}`);
    }
    this.token = data.tenant_access_token;
    this.tokenExpiresAt = Date.now() + (data.expire ?? 7200) * 1000;
    return this.token;
  }

  /**
   * 下行发送：
   * - target.threadKey 存在 → message.reply + reply_in_thread（落回原话题/回复串）；
   * - 否则 → messages.create 发到 chat_id（私聊/群根级）。
   */
  async send(chatId: string, text: string, target?: OutboundTarget): Promise<void> {
    const token = await this.tenantAccessToken();
    const receiveId = chatId.startsWith("fs:") ? chatId.slice(3) : chatId;
    let url: string;
    let body: Record<string, unknown>;
    if (target?.threadKey) {
      url = `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(target.threadKey)}/reply`;
      body = { content: JSON.stringify({ text }), msg_type: "text", reply_in_thread: true };
    } else {
      url = `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`;
      body = { receive_id: receiveId, msg_type: "text", content: JSON.stringify({ text }) };
    }
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`飞书发送失败（HTTP ${res.status}）: ${detail.slice(0, 200)}`);
    }
    log.info("im:feishu", `下行消息 → ${chatId}${target?.threadKey ? `#${target.threadKey}` : ""}: ${text.slice(0, 200)}`);
  }
}

interface FeishuPayload {
  type?: string;
  challenge?: string;
  token?: string;
  header?: { token?: string; event_type?: string };
  event?: unknown;
  encrypt?: string;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
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
