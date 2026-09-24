/**
 * 飞书（Feishu/Lark）适配器 —— 事件订阅（webhook）模式（issue #54）。
 *
 * 消息处理：
 * - 上行：im.message.receive_v1 → ChatMessage（chatId/chatType/threadKey/senderId/附件）；
 *   话题/回复串用 root_id（优先）或 thread_id 作为 threadKey，会话键 = chatId:threadKey；
 * - mention 占位符清洗：@_user_N → @昵称（bot 自身 mention 剔除）；
 * - 群聊 @ 过滤：开启全量接收权限时，只有 @bot（或私聊）才会进入团队；
 * - 图片消息：调 im/v1/images 下载为附件（失败静默跳过，不阻塞消息）；
 * - 富文本上行（post）：优先读 content_v2 中的 md 标签（保留原始 Markdown），
 *   回退按 content 段落标签还原文本并提取内嵌图片（issue #64）；
 * - 引用/回复消息（issue #66）：事件只带被引用消息 id（`parent_id`），
 *   emitMessage 经 `GET /im/v1/messages/{message_id}` 取回内容，以
 *   「被引用内容：…\n用户消息：…」前缀注入（与微信 iLink #25 做法一致）；
 *   取不到时给出可读兜底提示，不静默丢失；
 * - 下行：统一以富文本 post + md 标签发送（飞书原生渲染 CommonMark 0.31 + GFM：
 *   标题、加粗、列表、代码块、引用、表格等），超长内容分片，发送失败自动降级纯文本；
 *   话题内回复用 message.reply + reply_in_thread（避免脱话题/开新话题），主会话用 messages.create；
 * - 文件/图片附件（issue #65）：先上传 im/v1/images（image_key）或 im/v1/files（file_key），
 *   再发 image/file 消息，话题场景同样走 reply + reply_in_thread；超限/失败由 AgentTeam 降级为文本提示。
 *
 * 字段语义（root_id/thread_id 组合、图片下载返回体、reply_in_thread 行为、post/md 结构）以
 * 飞书开放平台文档为准，接入时需用真实回调实测（见 issue #54/#64「待实测确认」）。
 */
import { createDecipheriv, createHash } from "node:crypto";
import { EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { log } from "../core/logger.js";
import type { ChatAttachment, ChatMessage, OutboundFile, OutboundTarget } from "../core/types.js";
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
    /** 富文本消息的原始内容（保留 md 标签，推荐优先读取；见飞书「接收消息内容结构」） */
    content_v2?: string;
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
  /** 被引用/被回复的消息 id（issue #66）：飞书事件 `parent_id`，内容需另取 */
  quotedMessageId?: string;
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
  const parsed = parseJsonValue(content);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parseJsonValue(content: string | undefined): unknown {
  if (!content) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
}

/** 富文本 post 的节点（发送与接收结构的最小交集） */
export interface FeishuPostNode {
  tag?: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  language?: string;
  image_key?: string;
}

/** 富文本段落列表（content / content_v2 均为「段落数组」，段落内为节点数组） */
function postParagraphs(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { content?: unknown }).content)) {
    return (parsed as { content: unknown[] }).content;
  }
  return [];
}

/** 单个富文本节点 → 文本（纯函数）；图片 key 就地收集，代码块还原为围栏形式 */
function flattenPostNode(node: FeishuPostNode, imageKeys: string[]): string {
  switch (node.tag) {
    case "text":
      return node.text ?? "";
    case "a":
      return node.href ? `[${node.text ?? ""}](${node.href})` : (node.text ?? "");
    case "at":
      // user_id 形如 @_user_1，交由 stripMentions 依据 mentions 还原昵称/剔除 bot
      return node.user_id ?? node.user_name ?? "";
    case "code_block":
      return `\`\`\`${(node.language ?? "").toLowerCase()}\n${node.text ?? ""}\n\`\`\``;
    case "md":
      return node.text ?? "";
    case "img":
      if (node.image_key) imageKeys.push(node.image_key);
      return "[图片]";
    case "media":
      return "[视频]";
    case "emotion":
      return "";
    case "hr":
      return "---";
    default:
      return node.text ?? "";
  }
}

/**
 * 解析富文本段落结构（content 或 content_v2 的段落数组）为文本（纯函数）。
 * content_v2 优先，因其 md 标签保留原始 Markdown；content 中 md 会被拆成其他标签。
 */
export function extractPostContent(parsed: unknown): { text: string; imageKeys: string[] } {
  const imageKeys: string[] = [];
  const paragraphs: string[] = [];
  for (const paragraph of postParagraphs(parsed)) {
    if (!Array.isArray(paragraph)) continue;
    const line = paragraph.map((n) => flattenPostNode((n ?? {}) as FeishuPostNode, imageKeys)).join("");
    if (line) paragraphs.push(line);
  }
  return { text: paragraphs.join("\n"), imageKeys };
}

/** 飞书富文本请求体上限 30KB（官方文档）；预留 JSON 转义与结构开销 */
const POST_CONTENT_LIMIT_BYTES = 30_000;
/** 单片目标字节数：接口上限基础上预留 JSON 转义与结构开销 */
const POST_CHUNK_BYTES = Math.floor(POST_CONTENT_LIMIT_BYTES * 0.93); // ≈27.9KB

/** 飞书图片消息大小上限（约 10MB，以开放平台文档为准） */
export const FEISHU_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
/** 飞书文件消息大小上限（约 30MB，以开放平台文档为准） */
export const FEISHU_FILE_MAX_BYTES = 30 * 1024 * 1024;

/** 扩展名 → 飞书 file_type（仅支持官方枚举，其余一律按 stream 发送） */
const FEISHU_FILE_TYPE_BY_EXT: Record<string, string> = {
  opus: "opus",
  mp4: "mp4",
  pdf: "pdf",
  doc: "doc",
  docx: "doc",
  xls: "xls",
  xlsx: "xls",
  ppt: "ppt",
  pptx: "ppt",
};

/** 推断飞书文件上传所需 file_type（纯函数） */
export function inferFeishuFileType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return FEISHU_FILE_TYPE_BY_EXT[ext] ?? "stream";
}

/**
 * 将 Markdown 包装为富文本 post 的 content 对象（纯函数）。
 * 飞书文档推荐用 `md` 标签发送 Markdown（CommonMark 0.31 + GFM）。
 * 注意：md 标签独占一个段落，不能与其他标签同行，因此整体包在单个 md 节点内。
 */
export function buildPostContent(markdown: string): Record<string, unknown> {
  return { zh_cn: { content: [[{ tag: "md", text: markdown }]] } };
}

/** 富文本 post 序列化后的字节数（用于分片阈值判断） */
function postContentBytes(markdown: string): number {
  return Buffer.byteLength(JSON.stringify(buildPostContent(markdown)), "utf-8");
}

/** 超长单行兜底硬切（按字节逼近上限；无法保证语义边界） */
function hardSplit(text: string, maxBytes: number): string[] {
  const out: string[] = [];
  let buf = "";
  for (const ch of text) {
    if (buf && postContentBytes(buf + ch) > maxBytes) {
      out.push(buf);
      buf = "";
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 按飞书富文本体积上限切分 Markdown（纯函数）：
 * - 优先在行边界切分；若切在代码围栏内，则补闭合围栏并在下片重开，保证每片语法完整；
 * - 极端超长单行（压缩后的代码/JSON）最终按字节硬切兜底。
 */
export function splitMarkdown(text: string, maxBytes = POST_CHUNK_BYTES): string[] {
  if (postContentBytes(text) <= maxBytes) return [text];
  const chunks: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  let fenceLang = "";
  const flush = () => {
    if (cur.length > 0) {
      chunks.push(cur.join("\n"));
      cur = [];
    }
  };
  for (const line of text.split("\n")) {
    if (cur.length > 0 && postContentBytes([...cur, line].join("\n")) > maxBytes) {
      if (inFence) cur.push("```");
      flush();
      if (inFence) cur.push("```" + fenceLang);
    }
    if (/^\s*```/.test(line)) {
      if (!inFence) fenceLang = line.trim().replace(/^```+/, "").trim();
      inFence = !inFence;
    }
    cur.push(line);
  }
  flush();
  return chunks.flatMap((c) => (postContentBytes(c) <= maxBytes ? [c] : hardSplit(c, maxBytes)));
}

/** 被引用消息类型 → 可读类型提示（issue #66） */
function quotedTypeHint(msgType: string): string {
  switch (msgType) {
    case "image":
      return "[图片]";
    case "file":
      return "[文件]";
    case "audio":
      return "[语音]";
    case "media":
      return "[视频]";
    case "sticker":
      return "[表情]";
    case "interactive":
      return "[卡片]";
    default:
      return `[${msgType}]`;
  }
}

/**
 * 从被引用消息（`GET /im/v1/messages/{id}` 返回的 item）提取可读文本（纯函数，issue #66）。
 * - text：解析 content.text；post：还原富文本为 Markdown；
 * - 图片/文件等非文本：返回类型提示；内容为空时返回 undefined，交由调用方兜底。
 */
export function extractQuotedText(msgType: string, content: string | undefined): string | undefined {
  if (msgType === "text") {
    const parsed = parseContent(content);
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    return text || undefined;
  }
  if (msgType === "post") {
    const text = extractPostContent(parseJsonValue(content)).text.trim();
    return text || undefined;
  }
  return quotedTypeHint(msgType);
}

/**
 * 归一化飞书消息事件（纯函数）：
 * - 忽略 app/bot 自身消息；
 * - 文本消息解析 text，图片消息提取 image_key（下载由适配器完成）；
 * - 富文本 post：优先 content_v2（md 标签保留原始 Markdown），回退 content 段落还原；
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

  const mentions = msg.mentions ?? [];
  const imageKeys: string[] = [];
  let rawText = "";

  if (msg.message_type === "text") {
    const content = parseContent(msg.content);
    if (typeof content.text === "string") rawText = content.text;
  } else if (msg.message_type === "image") {
    const content = parseContent(msg.content);
    if (typeof content.image_key === "string") imageKeys.push(content.image_key);
  } else if (msg.message_type === "post") {
    // content_v2 的 md 标签保留原始 Markdown；若为空则回退到 content 的段落标签
    const v2 = extractPostContent(parseJsonValue(msg.content_v2));
    const rich = v2.text ? v2 : extractPostContent(parseJsonValue(msg.content));
    rawText = rich.text;
    imageKeys.push(...rich.imageKeys);
  }

  const text = stripMentions(rawText, mentions, opts.botOpenId);
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
    // parent_id = 被回复/被引用消息 id（飞书「回复」与「引用」同一套语义）；
    // upper_message_id 是合并转发树的直接父节点，不是引用，勿用。
    quotedMessageId: msg.parent_id || undefined,
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

  /** 归一化消息 → 下载图片附件 → 还原引用内容 → 交给团队 */
  private async emitMessage(normalized: NormalizedFeishuMessage): Promise<void> {
    const attachments: ChatAttachment[] = [];
    for (const key of normalized.imageKeys) {
      const att = await this.downloadImage(key);
      if (att) attachments.push(att);
    }
    let text = normalized.text;
    // 引用/回复消息（issue #66）：取回被引用内容并以自然语言前缀注入上下文；
    // 取不到时给出可读兜底，不静默丢失。
    if (normalized.quotedMessageId && normalized.quotedMessageId !== normalized.messageId) {
      const quoted = await this.fetchQuotedText(normalized.quotedMessageId);
      const quoteLine = `被引用内容：${quoted ?? `[消息 ${normalized.quotedMessageId}（内容不可见）`}`;
      text = text ? `${quoteLine}\n用户消息：${text}` : quoteLine;
    }
    const msg: ChatMessage = {
      chatId: normalized.chatId,
      chatType: normalized.chatType,
      threadKey: normalized.threadKey,
      senderId: normalized.senderId,
      text,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
    log.info(
      "im:feishu",
      `转发给团队 → ${normalized.chatId}${normalized.threadKey ? `#${normalized.threadKey}` : ""}（${normalized.chatType}）: ${msg.text.slice(0, 200)}${attachments.length > 0 ? `（附件 ${attachments.length} 个）` : ""}`,
    );
    this.handler?.(msg);
  }

  /**
   * 取回被引用消息内容（issue #66）：`GET /open-apis/im/v1/messages/{message_id}`。
   * 内容需机器人位于消息所在会话且有读取权限；取不到返回 undefined，由调用方兜底。
   */
  private async fetchQuotedText(messageId: string): Promise<string | undefined> {
    try {
      const token = await this.tenantAccessToken();
      const res = await this.fetchImpl(`${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(messageId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        log.warn("im:feishu", `被引用消息取回失败（HTTP ${res.status}）: ${messageId}`);
        return undefined;
      }
      const data = (await res.json()) as {
        data?: { items?: Array<{ msg_type?: string; body?: { content?: string } }> };
      };
      const item = data.data?.items?.[0];
      return item?.msg_type ? extractQuotedText(item.msg_type, item.body?.content) : undefined;
    } catch (e) {
      log.warn("im:feishu", `被引用消息取回失败: ${(e as Error).message}`);
      return undefined;
    }
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
   * 下行发送：将 Markdown 以富文本 post + md 标签发送（飞书原生渲染 CommonMark + GFM）。
   * - target.threadKey 存在 → message.reply + reply_in_thread（落回原话题/回复串）；
   * - 否则 → messages.create 发到 chat_id（私聊/群根级）；
   * - 超过单条体积上限时自动分片；富文本发送失败则降级为纯文本重试（issue #64）。
   */
  async send(chatId: string, text: string, target?: OutboundTarget): Promise<void> {
    const token = await this.tenantAccessToken();
    const receiveId = chatId.startsWith("fs:") ? chatId.slice(3) : chatId;
    const chunks = splitMarkdown(text);
    for (const chunk of chunks) {
      await this.deliver(token, receiveId, chunk, target);
    }
    log.info(
      "im:feishu",
      `下行消息 → ${chatId}${target?.threadKey ? `#${target.threadKey}` : ""}${chunks.length > 1 ? `（${chunks.length} 片）` : ""}: ${text.slice(0, 200)}`,
    );
  }

  /** 发送单片富文本；失败时降级纯文本重试，仍失败则抛错 */
  private async deliver(
    token: string,
    receiveId: string,
    markdown: string,
    target: OutboundTarget | undefined,
  ): Promise<void> {
    const post = this.messageRequest(receiveId, target, "post", JSON.stringify(buildPostContent(markdown)));
    const res = await this.post(token, post);
    if (res.ok) return;
    const detail = await res.text().catch(() => "");
    log.warn("im:feishu", `富文本发送失败（HTTP ${res.status}），降级纯文本重试: ${detail.slice(0, 200)}`);
    const fallback = this.messageRequest(receiveId, target, "text", JSON.stringify({ text: markdown }));
    const res2 = await this.post(token, fallback);
    if (!res2.ok) {
      const detail2 = await res2.text().catch(() => "");
      throw new Error(`飞书发送失败（HTTP ${res2.status}）: ${detail2.slice(0, 200)}`);
    }
  }

  /**
   * 下行发送文件/图片附件（issue #65）：
   * - 图片（mimeType 为 image/* 且 ≤10MB）→ 上传 im/v1/images 得 image_key，发 image 消息；
   * - 其它（含超 10MB 的图片）→ 上传 im/v1/files 得 file_key，发 file 消息；
   * - 话题/回复串沿用 messageRequest（reply + reply_in_thread）；
   * - caption 作为独立文本先发；上传/发送失败抛错，由 AgentTeam 降级为文本提示。
   */
  async sendFile(chatId: string, file: OutboundFile, target?: OutboundTarget): Promise<void> {
    if (file.size > FEISHU_FILE_MAX_BYTES) {
      throw new Error(`文件过大（${file.size} 字节），飞书通道上限 ${FEISHU_FILE_MAX_BYTES} 字节`);
    }
    const token = await this.tenantAccessToken();
    const receiveId = chatId.startsWith("fs:") ? chatId.slice(3) : chatId;
    const isImage = (file.mimeType ?? "").startsWith("image/") && file.size <= FEISHU_IMAGE_MAX_BYTES;

    let msgType: string;
    let content: string;
    if (isImage) {
      const imageKey = await this.uploadImage(token, file);
      msgType = "image";
      content = JSON.stringify({ image_key: imageKey });
    } else {
      const fileKey = await this.uploadFile(token, file);
      msgType = "file";
      content = JSON.stringify({ file_key: fileKey });
    }

    // 先发随附说明（独立文本消息），再发附件消息，与微信通道行为对齐
    if (file.caption) {
      await this.send(chatId, file.caption, target);
    }

    const res = await this.post(token, this.messageRequest(receiveId, target, msgType, content));
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`飞书${isImage ? "图片" : "文件"}发送失败（HTTP ${res.status}）: ${detail.slice(0, 200)}`);
    }
    log.info(
      "im:feishu",
      `已发送${isImage ? "图片" : "文件"}消息 → ${chatId}${target?.threadKey ? `#${target.threadKey}` : ""}: ${file.fileName}（${file.size} B）`,
    );
  }

  /** 上传图片，返回 image_key（im/v1/images，multipart/form-data） */
  private async uploadImage(token: string, file: OutboundFile): Promise<string> {
    const form = new FormData();
    form.append("image_type", "message");
    form.append("image", new Blob([file.content], { type: file.mimeType ?? "application/octet-stream" }), file.fileName);
    const res = await this.fetchImpl(`${this.baseUrl}/open-apis/im/v1/images`, {
      method: "POST",
      // 不手动设置 Content-Type，交由 fetch 自动生成 multipart boundary
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { msg?: string; data?: { image_key?: string } };
    if (!res.ok || !data.data?.image_key) {
      throw new Error(`飞书图片上传失败（HTTP ${res.status}）: ${data.msg ?? "未返回 image_key"}`);
    }
    return data.data.image_key;
  }

  /** 上传文件，返回 file_key（im/v1/files，multipart/form-data） */
  private async uploadFile(token: string, file: OutboundFile): Promise<string> {
    const form = new FormData();
    form.append("file_type", inferFeishuFileType(file.fileName));
    form.append("file_name", file.fileName);
    form.append("file", new Blob([file.content]), file.fileName);
    const res = await this.fetchImpl(`${this.baseUrl}/open-apis/im/v1/files`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    const data = (await res.json().catch(() => ({}))) as { msg?: string; data?: { file_key?: string } };
    if (!res.ok || !data.data?.file_key) {
      throw new Error(`飞书文件上传失败（HTTP ${res.status}）: ${data.msg ?? "未返回 file_key"}`);
    }
    return data.data.file_key;
  }

  /** 组装发送/回复请求：话题回复走 reply API，根级走 create */
  private messageRequest(
    receiveId: string,
    target: OutboundTarget | undefined,
    msgType: string,
    content: string,
  ): { url: string; body: Record<string, unknown> } {
    if (target?.threadKey) {
      return {
        url: `${this.baseUrl}/open-apis/im/v1/messages/${encodeURIComponent(target.threadKey)}/reply`,
        body: { content, msg_type: msgType, reply_in_thread: true },
      };
    }
    return {
      url: `${this.baseUrl}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      body: { receive_id: receiveId, msg_type: msgType, content },
    };
  }

  private post(token: string, req: { url: string; body: Record<string, unknown> }): Promise<Response> {
    return this.fetchImpl(req.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(req.body),
    });
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
