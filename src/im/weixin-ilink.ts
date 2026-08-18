/**
 * 微信适配器（官方 iLink 通道）
 *
 * 基于腾讯官方开源的 openclaw-weixin bot API（ilinkai.weixin.qq.com）：
 * - 扫码登录获取 bot_token（官方机制，非逆向私有协议）；
 * - 长轮询收消息、HTTP 发消息。
 *
 * 参考：https://github.com/Tencent/openclaw-weixin
 *       https://github.com/huang-x-h/pi-weixinbot（pi 生态封装，本文提取其纯 HTTP 部分）
 *
 * 使用：
 *   CIRCLE_IM_ADAPTER=weixin npm start
 *   无 token 时自动进入扫码登录（终端打印二维码 URL，微信扫码确认后自动连接）；
 *   也可用 CIRCLE_WEIXIN_BOT_TOKEN 直接指定已登录的 bot token 跳过扫码。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createCipheriv, randomBytes, createHash } from "node:crypto";
import { join } from "node:path";
import { log } from "../core/logger.js";
import type { ChatMessage, OutboundFile } from "../core/types.js";
import type { ImAdapter } from "./adapter.js";

// ============================================================================
// 官方 API 常量
// ============================================================================

export const WEIXIN_DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
/** 微信 CDN（无 upload_full_url 时回退拼接上传地址） */
export const WEIXIN_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
/** 文件消息发送大小上限（微信通道限制） */
export const WEIXIN_MAX_FILE_BYTES = 20 * 1024 * 1024;
const API_TIMEOUT_MS = 15000;
const LONG_POLL_TIMEOUT_MS = 35000;
const QR_POLL_INTERVAL_MS = 1000;
const QR_LOGIN_TIMEOUT_MS = 480000;

interface WeixinAccountData {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  userId?: string;
  name?: string;
}

// ============================================================================
// 官方 API 客户端（纯 HTTP，零依赖）
// ============================================================================

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "iLink-App-Id": "",
    "X-WECHAT-UIN": Buffer.from(String(Math.floor(Math.random() * 0xffffffff)), "utf-8").toString("base64"),
    AuthorizationType: "ilink_bot_token",
  };
  if (token?.trim()) headers["Authorization"] = `Bearer ${token.trim()}`;
  return headers;
}

async function postJson(baseUrl: string, endpoint: string, body: unknown, token?: string, timeoutMs = API_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${endpoint}`, {
      method: "POST",
      headers: buildHeaders(token),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`微信 API ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    try {
      return jsonParseSafe(text);
    } catch {
      return { raw: text };
    }
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

async function getJson(baseUrl: string, endpoint: string, timeoutMs = API_TIMEOUT_MS): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/${endpoint}`, {
      method: "GET",
      headers: buildHeaders(),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`微信 API ${endpoint} HTTP ${res.status}: ${text.slice(0, 200)}`);
    return jsonParseSafe(text);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * 大整数安全 JSON 解析（issue #25 引用还原的配套修复）：
 * 微信 message_id 为 19 位大整数，JSON.parse 直接解析会丢失精度
 * （7495099801417603848 → 7495099801417604000），导致注册表 key 与引用 msg_id 对不上。
 * 解析前先把超 2^53 的整数字面量改写成字符串，保证 id 精确匹配。
 */
export function jsonParseSafe(text: string): unknown {
  const fixed = text.replace(/(?<=[:,\[])\s*(-?\d{16,})(?=\s*[,}\]])/g, (m) => {
    const digits = m.trim();
    if (Math.abs(Number(digits)) <= Number.MAX_SAFE_INTEGER) return m;
    return m.replace(digits, `"${digits}"`);
  });
  return JSON.parse(fixed);
}

interface WeixinMessageItem {
  type?: number;
  create_time_ms?: number;
  is_completed?: boolean;
  /** 消息 ID（顶层消息也有 message_id，item 级为 msg_id，引用时凭此还原内容） */
  msg_id?: string;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  /** 引用消息（quoted message）载荷，字段与腾讯官方 openclaw-weixin 对齐 */
  ref_msg?: RefMessage;
}

/**
 * 引用消息载荷：
 * - title: 被引用消息的摘要/标题（引用卡片、链接或仅摘要时提供）；
 * - message_item: 被引用消息的内容项（文本/媒体）。
 */
interface RefMessage {
  title?: string;
  message_item?: WeixinMessageItem;
}

interface WeixinMessage {
  from_user_id?: string;
  to_user_id?: string;
  message_type?: number;
  create_time_ms?: number;
  message_id?: number;
  client_id?: string;
  item_list?: WeixinMessageItem[];
  context_token?: string;
  [k: string]: unknown;
}

// ============================================================================
// 适配器
// ============================================================================

export interface WeixinIlinkOptions {
  /** 直接指定 bot token（跳过扫码登录） */
  botToken?: string;
  /** API base URL（默认官方） */
  baseUrl?: string;
  /** CDN base URL（默认官方 CDN，服务端返回 upload_full_url 时优先使用） */
  cdnBaseUrl?: string;
  /** bot 类型（默认 3） */
  botType?: string;
  /** 登录状态存储目录（默认 {dataDir}/weixin） */
  stateDir?: string;
}

export class WeixinIlinkAdapter implements ImAdapter {
  readonly name = "weixin";
  private handler?: (msg: ChatMessage) => void;
  private token?: string;
  private apiBaseUrl: string;
  private accountId?: string;
  private polling = false;
  private abort?: AbortController;
  private getUpdatesBuf = "";

  /**
   * 本地消息注册表：msg_id/message_id → 文本，用于还原引用消息内容（issue #25）。
   * 真实 iLink 报文里引用（ref_msg.message_item）只回传被引用消息的 msg_id（type=0），
   * 不附带内容；需要凭 id 在本地历史中查回文本。
   */
  private msgRegistry = new Map<string, { text: string; ts: number }>();
  private registryLoaded = false;
  /**
   * 出站消息登记：client_id → 发送文本。
   * 微信可能把 bot 自己发的消息回显到 getupdates（带 client_id），
   * 此时可把发送文本关联到回显消息的 msg_id，供后续被引用时还原。
   */
  private pendingOutbound = new Map<string, string>();

  constructor(private readonly options: WeixinIlinkOptions = {}) {
    this.apiBaseUrl = options.baseUrl ?? WEIXIN_DEFAULT_BASE_URL;
  }

  /** 登录状态（供测试/状态检查） */
  get connected(): boolean {
    return this.polling && !!this.token;
  }

  onMessage(cb: (msg: ChatMessage) => void): void {
    this.handler = cb;
  }

  // ============ 生命周期 ============

  async start(): Promise<void> {
    // 1) 解析 token：环境变量 > 已保存账户 > 扫码登录
    if (this.options.botToken) {
      this.token = this.options.botToken;
      this.accountId = "env";
      log.info("im:weixin", "使用环境变量提供的 bot token");
    } else {
      const saved = this.loadSavedAccount();
      if (saved?.token) {
        this.token = saved.token;
        this.accountId = saved.accountId;
        this.apiBaseUrl = saved.baseUrl ?? this.apiBaseUrl;
        log.info("im:weixin", `从缓存恢复账户 ${saved.accountId}`);
      } else {
        const login = await this.qrLogin();
        if (!login.connected || !login.botToken) {
          throw new Error(`微信登录失败：${login.message}`);
        }
        this.token = login.botToken;
        this.accountId = login.accountId;
        if (login.baseUrl) this.apiBaseUrl = login.baseUrl;
      }
    }
    this.startPolling();
    log.info("im:weixin", `微信适配器已连接（账户 ${this.accountId}，API ${this.apiBaseUrl}）`);
  }

  async stop(): Promise<void> {
    this.polling = false;
    this.abort?.abort();
  }

  // ============ 扫码登录 ============

  private async qrLogin(): Promise<{
    connected: boolean;
    botToken?: string;
    accountId?: string;
    baseUrl?: string;
    message: string;
  }> {
    log.info("im:weixin", "未找到已保存的微信登录状态，开始扫码登录…");
    const qr = await getJson(this.apiBaseUrl, `ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(this.options.botType ?? "3")}`, 30000);
    const qrcode: string = qr.qrcode;
    const qrcodeUrl: string = qr.qrcode_img_content;
    if (!qrcode) throw new Error(`获取微信二维码失败：${JSON.stringify(qr).slice(0, 200)}`);
    log.info("im:weixin", `请用微信扫描二维码完成登录：${qrcodeUrl}`);
    this.onQRCode?.(qrcodeUrl);

    const deadline = Date.now() + QR_LOGIN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const status = await getJson(this.apiBaseUrl, `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, 35000);
      switch (status.status) {
        case "scaned":
          log.info("im:weixin", "已扫码，请在微信中确认登录…");
          break;
        case "scaned_but_redirect":
          if (status.redirect_host) {
            this.apiBaseUrl = `https://${status.redirect_host}`;
            log.info("im:weixin", `登录通道重定向至 ${status.redirect_host}`);
          }
          break;
        case "expired":
          throw new Error("二维码已过期，请重启后重新登录");
        case "confirmed":
          if (!status.ilink_bot_id) throw new Error("登录失败：服务器未返回机器人 ID");
          this.saveAccount(status.ilink_bot_id, {
            token: status.bot_token,
            baseUrl: status.baseurl,
            userId: status.ilink_user_id,
          });
          log.info("im:weixin", "扫码登录成功，机器人 ID: " + status.ilink_bot_id);
          return {
            connected: true,
            botToken: status.bot_token,
            accountId: status.ilink_bot_id,
            baseUrl: status.baseurl,
            message: "connected",
          };
        case "wait":
        default:
          break;
      }
      await sleep(QR_POLL_INTERVAL_MS);
    }
    return { connected: false, message: "登录超时，请重试" };
  }

  /** 登录二维码回调（测试/UI 可注入） */
  onQRCode?: (url: string) => void;

  // ============ 账户存储 ============

  private stateDir(): string {
    const dir = this.options.stateDir ?? join(process.cwd(), "data", "weixin");
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private accountPath(accountId: string): string {
    return join(this.stateDir(), `${accountId}.json`);
  }

  private loadSavedAccount(): { accountId: string; token: string; baseUrl?: string } | undefined {
    try {
      const index = join(this.stateDir(), "accounts.json");
      if (!existsSync(index)) return undefined;
      const ids = JSON.parse(readFileSync(index, "utf-8")) as string[];
      for (const id of ids) {
        const p = this.accountPath(id);
        if (!existsSync(p)) continue;
        const data = JSON.parse(readFileSync(p, "utf-8")) as WeixinAccountData;
        if (data.token) return { accountId: id, token: data.token, baseUrl: data.baseUrl };
      }
    } catch (e) {
      log.warn("im:weixin", `读取账户缓存失败: ${(e as Error).message}`);
    }
    return undefined;
  }

  private saveAccount(accountId: string, data: Partial<WeixinAccountData>): void {
    const dir = this.stateDir();
    mkdirSync(dir, { recursive: true });
    const existing = existsSync(this.accountPath(accountId))
      ? (JSON.parse(readFileSync(this.accountPath(accountId), "utf-8")) as WeixinAccountData)
      : {};
    writeFileSync(
      this.accountPath(accountId),
      JSON.stringify({ ...existing, ...data, savedAt: new Date().toISOString() }, null, 2),
      "utf-8",
    );
    const index = join(dir, "accounts.json");
    let ids: string[] = [];
    if (existsSync(index)) ids = JSON.parse(readFileSync(index, "utf-8")) as string[];
    if (!ids.includes(accountId)) {
      ids.push(accountId);
      writeFileSync(index, JSON.stringify(ids, null, 2), "utf-8");
    }
  }

  // ============ 消息收发 ============

  private startPolling(): void {
    this.polling = true;
    this.abort = new AbortController();
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.polling) {
      try {
        const resp = await postJson(
          this.apiBaseUrl,
          "ilink/bot/getupdates",
          { get_updates_buf: this.getUpdatesBuf, base_info: { channel_version: "1.0.0" } },
          this.token,
          LONG_POLL_TIMEOUT_MS,
        );
        if (typeof resp.ret === "number" && resp.ret !== 0) {
          log.warn("im:weixin", `getupdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg}`);
          if (resp.errcode === -14) {
            log.error("im:weixin", "微信 Session 已过期，请删除 data/weixin 后重新扫码登录");
            this.polling = false;
            return;
          }
        }
        if (resp.get_updates_buf) this.getUpdatesBuf = resp.get_updates_buf;
        if (resp.msgs?.length) {
          for (const msg of resp.msgs as WeixinMessage[]) {
            this.handleIncoming(msg);
          }
        }
      } catch (err) {
        if ((err as Error).name === "AbortError" || (err as Error).message.includes("abort")) {
          // 长轮询超时是正常现象，继续
        } else {
          log.warn("im:weixin", `getupdates 异常: ${(err as Error).message}`);
        }
      }
    }
  }

  private handleIncoming(msg: WeixinMessage): void {
    // 先把所有消息（含 bot 自身 type=2）登记进注册表，供后续引用还原（issue #25）
    this.recordMessage(msg);

    // 忽略自己发送的消息（BOT 类型）
    if (msg.message_type === 2) return;
    const fromUserId = msg.from_user_id;
    if (!fromUserId) return;

    // 调试：打印收到的原始报文结构（长字段截断、媒体密钥脱敏），
    // 用于核对真实 iLink 载荷（issue #25 引用消息结构排查）
    log.info("im:weixin", `收到消息 from=${fromUserId} message_type=${msg.message_type} items=${(msg.item_list ?? []).length}\n${redactPayload(msg)}`);

    const text = extractText(msg, (msgId) => this.msgRegistry.get(msgId)?.text);
    if (!text) {
      log.warn("im:weixin", `消息无可提取文本，已丢弃 from=${fromUserId} items=${(msg.item_list ?? []).length}`);
      return;
    }

    log.info("im:weixin", `转发给团队 → ${fromUserId}: ${text.slice(0, 300)}`);
    this.handler?.({ chatId: `wx:${fromUserId}`, text });
  }

  // ============ 消息注册表（引用还原，issue #25） ============

  private registryPath(): string {
    return join(this.stateDir(), "msg-registry.json");
  }

  private loadRegistry(): void {
    if (this.registryLoaded) return;
    this.registryLoaded = true;
    try {
      const raw = readFileSync(this.registryPath(), "utf-8");
      const data = JSON.parse(raw) as Array<{ id: string; text: string; ts: number }>;
      for (const e of data) this.msgRegistry.set(e.id, { text: e.text, ts: e.ts });
    } catch {
      /* 无历史注册表时忽略 */
    }
  }

  private saveRegistry(): void {
    try {
      const arr = [...this.msgRegistry.entries()]
        .slice(-2000)
        .map(([id, v]) => ({ id, text: v.text, ts: v.ts }));
      writeFileSync(this.registryPath(), JSON.stringify(arr), "utf-8");
    } catch (e) {
      log.warn("im:weixin", `消息注册表保存失败: ${(e as Error).message}`);
    }
  }

  /** 登记消息文本：顶层 message_id 与 item 级 msg_id 都记录（引用可能引用任一 id） */
  private recordMessage(msg: WeixinMessage): void {
    this.loadRegistry();
    const msgTs = msg.create_time_ms ?? Date.now();
    // 出站消息回显：client_id 命中 pendingOutbound → 用发送时的文本登记
    let outboundText: string | undefined;
    if (msg.client_id && this.pendingOutbound.has(msg.client_id)) {
      outboundText = this.pendingOutbound.get(msg.client_id);
      this.pendingOutbound.delete(msg.client_id);
    }
    if (msg.message_id) {
      const text = outboundText ?? rawTextOf(msg);
      if (text) this.msgRegistry.set(String(msg.message_id), { text, ts: msgTs });
    }
    for (const item of msg.item_list ?? []) {
      if (!item.msg_id) continue;
      const text = outboundText ?? item.text_item?.text ?? item.voice_item?.text ?? "";
      if (text) this.msgRegistry.set(item.msg_id, { text, ts: item.create_time_ms ?? msgTs });
    }
    // 每次记录后落盘：注册表持久化，重启不丢（容量上限在 saveRegistry 内裁剪）
    this.saveRegistry();
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.token) throw new Error("微信未登录");
    const toUserId = chatId.startsWith("wx:") ? chatId.slice(3) : chatId;
    const clientId = `circle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    // 登记出站文本，待微信回显（带 client_id）时关联到 msg_id（issue #25）
    this.pendingOutbound.set(clientId, text);
    if (this.pendingOutbound.size > 500) {
      // 防泄漏：只保留最近 500 条待关联出站消息
      const oldest = [...this.pendingOutbound.keys()].slice(0, this.pendingOutbound.size - 500);
      for (const k of oldest) this.pendingOutbound.delete(k);
    }
    const resp = await postJson(
      this.apiBaseUrl,
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: clientId,
          message_type: 2,
          message_state: 2,
          item_list: [{ type: 1, text_item: { text: filterMarkdown(text) } }],
        },
        base_info: { channel_version: "1.0.0" },
      },
      this.token,
    );
    log.info("im:weixin", `已发送消息 → ${toUserId}: ${text.slice(0, 120)}`);
    // 平台若回传消息 id，直接登记（供该消息被引用时还原内容）
    const sentId = resp?.message_id ?? resp?.msg?.message_id ?? resp?.msg_id;
    if (sentId != null) {
      this.loadRegistry();
      this.msgRegistry.set(String(sentId), { text, ts: Date.now() });
      this.pendingOutbound.delete(clientId);
    }
  }

  /**
   * 发送文件/图片消息（issue #24）。
   * 流程（openclaw-weixin 同款官方协议）：
   *   1. ilink/bot/getuploadurl 获取预签名上传地址 + 上传参数；
   *   2. 文件内容 AES-128-ECB 加密后 POST 到 CDN（响应头 x-encrypted-param 为下载参数）；
   *   3. ilink/bot/sendmessage 发送 type 4（文件）/ type 2（图片）消息。
   */
  async sendFile(chatId: string, file: OutboundFile): Promise<void> {
    if (!this.token) throw new Error("微信未登录");
    if (file.size > WEIXIN_MAX_FILE_BYTES) {
      throw new Error(`文件过大（${file.size} 字节），微信通道上限 ${WEIXIN_MAX_FILE_BYTES} 字节`);
    }
    const toUserId = chatId.startsWith("wx:") ? chatId.slice(3) : chatId;
    const isImage = (file.mimeType ?? "").startsWith("image/");

    // 1) 上传准备：filekey / aeskey / md5 / 密文大小
    const rawsize = file.size;
    const rawfilemd5 = createHash("md5").update(file.content).digest("hex");
    const aeskey = randomBytes(16);
    const aeskeyHex = aeskey.toString("hex");
    const filesize = aesEcbPaddedSize(rawsize);
    const filekey = randomBytes(16).toString("hex");
    const mediaType = isImage ? 1 : 3; // UploadMediaType: IMAGE=1, FILE=3

    // 2) 获取上传 URL
    const uploadUrlResp = await postJson(
      this.apiBaseUrl,
      "ilink/bot/getuploadurl",
      {
        filekey,
        media_type: mediaType,
        to_user_id: toUserId,
        rawsize,
        rawfilemd5,
        filesize,
        no_need_thumb: true,
        aeskey: aeskeyHex,
        base_info: { channel_version: "1.0.0" },
      },
      this.token,
    );
    const uploadFullUrl = uploadUrlResp?.upload_full_url?.trim();
    const uploadParam = uploadUrlResp?.upload_param;
    if (!uploadFullUrl && !uploadParam) {
      throw new Error("微信 getuploadurl 未返回上传地址（upload_full_url/upload_param 均为空）");
    }
    const cdnBase = this.options.cdnBaseUrl ?? WEIXIN_CDN_BASE_URL;
    const cdnUrl = uploadFullUrl
      ? uploadFullUrl
      : `${cdnBase.replace(/\/$/, "")}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;

    // 3) AES-128-ECB 加密后上传 CDN
    const cipher = createCipheriv("aes-128-ecb", aeskey, null);
    const ciphertext = Buffer.concat([cipher.update(file.content), cipher.final()]);
    const uploadRes = await fetch(cdnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(ciphertext),
    });
    if (!uploadRes.ok) {
      const errMsg = uploadRes.headers.get("x-error-message") ?? `HTTP ${uploadRes.status}`;
      throw new Error(`CDN 上传失败: ${errMsg}`);
    }
    const downloadParam = uploadRes.headers.get("x-encrypted-param");
    if (!downloadParam) {
      throw new Error("CDN 上传响应缺少 x-encrypted-param 头");
    }

    // 4) 先发说明文字（独立文本消息），再发文件/图片消息
    if (file.caption) {
      await this.send(chatId, file.caption);
    }
    const media = {
      encrypt_query_param: downloadParam,
      aes_key: Buffer.from(aeskeyHex).toString("base64"),
      encrypt_type: 1,
    };
    const item = isImage
      ? { type: 2, image_item: { media, mid_size: filesize } }
      : { type: 4, file_item: { media, file_name: file.fileName, len: String(rawsize) } };
    await postJson(
      this.apiBaseUrl,
      "ilink/bot/sendmessage",
      {
        msg: {
          from_user_id: "",
          to_user_id: toUserId,
          client_id: `circle-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          message_type: 2,
          message_state: 2,
          item_list: [item],
        },
        base_info: { channel_version: "1.0.0" },
      },
      this.token,
    );
    log.info("im:weixin", `已发送文件消息 → ${toUserId}: ${file.fileName}（${rawsize} B, ${isImage ? "图片" : "文件"}）`);
  }
}

// ============================================================================
// 消息文本提取 / markdown 清洗
// ============================================================================

function extractText(msg: WeixinMessage, lookupRef?: (msgId: string) => string | undefined): string {
  const items = msg.item_list ?? [];
  const parts: string[] = [];
  let hasImage = false;
  let hasFile = false;
  for (const item of items) {
    if (item.type === 2) hasImage = true;
    if (item.type === 4) hasFile = true;
    if (item.type === 1 && item.text_item?.text != null) {
      let text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (ref) {
        // 拼装引用上下文：摘要(title) + 被引用文本(message_item.text)
        // （issue #25）
        const quoteParts: string[] = [];
        if (ref.title?.trim()) quoteParts.push(ref.title.trim());
        const refMsg = ref.message_item;
        if (refMsg) {
          if (refMsg.type === 1 && refMsg.text_item?.text) {
            // 被引用内容直接带文本（部分平台/场景）
            quoteParts.push(refMsg.text_item.text);
          } else if (refMsg.type && mediaTypeHint(refMsg.type)) {
            // 引用的是媒体消息：给出类型提示
            quoteParts.push(mediaTypeHint(refMsg.type)!);
          } else if (refMsg.msg_id) {
            // 真实 iLink 场景：平台只回传被引用消息的 msg_id（type=0），不带内容
            // 1) 优先从本地注册表还原内容
            const cached = lookupRef?.(refMsg.msg_id);
            if (cached) {
              quoteParts.push(cached);
            } else {
              // 2) 兜底：至少让 Coordinator 知道存在引用及其时间，可结合任务记录关联
              quoteParts.push(`[消息 ${refMsg.msg_id}，发送于 ${formatMsgTime(refMsg.create_time_ms)}（内容不可见）]`);
            }
          }
        }
        if (quoteParts.length) {
          // 用直白自然语言而非 [引用: ...] 标记：部分 LLM 会把方括号标记误认为"不可见引用"而忽略内容
          text = `被引用内容：${quoteParts.join(" | ")}\n用户消息：${text}`;
        }
      }
      parts.push(text);
    } else if (item.type === 3 && item.voice_item?.text) {
      // 语音转文字：语音消息自带 text 字段时直接使用文字内容
      parts.push(item.voice_item.text);
    }
  }
  // 合并所有文本/语音项（真实引用消息可能以多条 item 下发，
  // 此前只取第一条会丢掉引用内容或用户指令，issue #25）
  if (parts.length) return parts.join("\n");
  // 非文本消息给出占位描述
  if (hasImage) return "[收到图片消息]";
  if (hasFile) return "[收到文件消息]";
  return "";
}

/** 消息文本原始提取（不含引用前缀），供注册表登记 */
function rawTextOf(msg: WeixinMessage): string {
  for (const item of msg.item_list ?? []) {
    if (item.type === 1 && item.text_item?.text != null) return String(item.text_item.text);
    if (item.type === 3 && item.voice_item?.text) return item.voice_item.text;
  }
  return "";
}

/** 确定性时间格式：YYYY-MM-DD HH:mm（本地时区） */
function formatMsgTime(ts?: number): string {
  if (!ts) return "未知时间";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 入站报文脱敏打印：长字符串截断、媒体密钥打码，便于排查真实载荷结构。
 */
function redactPayload(msg: WeixinMessage): string {
  const walk = (v: unknown, depth: number): unknown => {
    if (depth > 8) return "[...]";
    if (typeof v === "string") {
      if (v.length > 200) return `${v.slice(0, 200)}…(${v.length} 字符)`;
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        o[k] = k === "aes_key" ? "[redacted]" : walk(val, depth + 1);
      }
      return o;
    }
    return v;
  };
  return JSON.stringify(walk(msg, 0));
}

/** 被引用媒体消息的类型提示（MessageItemType: 2 图片 / 3 语音 / 4 文件 / 5 视频） */
function mediaTypeHint(type?: number): string | undefined {
  switch (type) {
    case 2:
      return "[引用图片]";
    case 3:
      return "[引用语音]";
    case 4:
      return "[引用文件]";
    case 5:
      return "[引用视频]";
    default:
      return undefined;
  }
}

function filterMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/```[\s\S]*?```/g, (m) => m.replace(/```\w*\n?/g, "").trim())
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/^#+\s*/gm, "")
    .replace(/^[-*]\s+/gm, "• ")
    .replace(/^\d+\.\s+/gm, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** AES-128-ECB 加密后大小（PKCS7 对齐到 16 字节边界） */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}
