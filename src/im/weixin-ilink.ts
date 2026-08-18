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
      return JSON.parse(text);
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
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

interface WeixinMessageItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
}

interface WeixinMessage {
  from_user_id?: string;
  message_type?: number;
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
    // 忽略自己发送的消息（BOT 类型）
    if (msg.message_type === 2) return;
    const fromUserId = msg.from_user_id;
    if (!fromUserId) return;

    const text = extractText(msg);
    if (!text) return;

    this.handler?.({ chatId: `wx:${fromUserId}`, text });
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.token) throw new Error("微信未登录");
    const toUserId = chatId.startsWith("wx:") ? chatId.slice(3) : chatId;
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
          item_list: [{ type: 1, text_item: { text: filterMarkdown(text) } }],
        },
        base_info: { channel_version: "1.0.0" },
      },
      this.token,
    );
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

function extractText(msg: WeixinMessage): string {
  const items = msg.item_list ?? [];
  for (const item of items) {
    if (item.type === 1 && item.text_item?.text != null) {
      let text = String(item.text_item.text);
      const ref = (item as { ref_msg?: { message_item?: WeixinMessageItem } }).ref_msg;
      if (ref?.message_item?.type === 1 && ref.message_item.text_item?.text) {
        text = `[引用: ${ref.message_item.text_item.text}]\n${text}`;
      }
      return text;
    }
    if (item.type === 3 && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  // 非文本消息给出占位描述
  const hasImage = items.some((i) => i.type === 2);
  const hasFile = items.some((i) => i.type === 4);
  if (hasImage) return "[收到图片消息]";
  if (hasFile) return "[收到文件消息]";
  return "";
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
