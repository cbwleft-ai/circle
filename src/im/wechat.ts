/**
 * 微信适配器：基于 wechaty（可选依赖）。
 *
 * 使用方式（见 docs/usage.md）：
 *   1. npm install wechaty wechaty-puppet-wechat4u（或其它 puppet）
 *   2. 设置 WECHAT_PUPPET / WECHAT_PUPPET_TOKEN
 *   3. 运行 npm start（CIRCLE_IM_ADAPTER=wechat）
 *
 * 未安装 wechaty 时，start() 会给出明确指引而不会崩溃。
 */
import { log } from "../core/logger.js";
import type { ChatMessage } from "../core/types.js";
import type { ImAdapter } from "./adapter.js";

export interface WechatAdapterOptions {
  puppet?: string;
  puppetToken?: string;
  allowContacts?: string[];
}

export class WechatAdapter implements ImAdapter {
  readonly name = "wechat";
  private handler?: (msg: ChatMessage) => void;
  private bot: any;
  private started = false;

  constructor(private readonly options: WechatAdapterOptions = {}) {}

  onMessage(cb: (msg: ChatMessage) => void): void {
    this.handler = cb;
  }

  async start(): Promise<void> {
    if (this.started) return;
    let wechaty: any;
    try {
      wechaty = await import("wechaty");
    } catch {
      log.error(
        "im:wechat",
        "未安装 wechaty。请执行 npm install wechaty wechaty-puppet-wechat4u，并设置 WECHAT_PUPPET / WECHAT_PUPPET_TOKEN（详见 docs/usage.md）。",
      );
      throw new Error("wechaty not installed");
    }
    const { WechatyBuilder, ScanStatus, log: wechatyLog } = wechaty;
    wechatyLog.level("warn");

    const options: Record<string, unknown> = {};
    if (this.options.puppet) options.puppet = this.options.puppet;
    if (this.options.puppetToken) options.puppetToken = this.options.puppetToken;

    this.bot = WechatyBuilder.build(options);

    this.bot.on("scan", (qrcode: string, status: number) => {
      if (status === ScanStatus.Waiting || status === ScanStatus.Timeout) {
        log.info("im:wechat", `请扫码登录: https://wechaty.js.org/qrcode/${encodeURIComponent(qrcode)}`);
      }
    });
    this.bot.on("login", (user: { name: () => string }) => {
      log.info("im:wechat", `微信登录成功: ${user.name()}`);
    });
    this.bot.on("logout", (user: { name: () => string }) => {
      log.warn("im:wechat", `微信登出: ${user.name()}`);
    });

    this.bot.on("message", async (message: any) => {
      try {
        if (message.self()) return;
        const room = message.room();
        const contact = message.talker();
        const chatId = room ? `room:${room.id}` : `contact:${contact.id}`;

        // 联系人白名单过滤
        if (!room && this.options.allowContacts && this.options.allowContacts.length > 0) {
          const remark = contact.name();
          if (!this.options.allowContacts.includes(remark)) {
            log.debug("im:wechat", `忽略非白名单联系人消息: ${remark}`);
            return;
          }
        }

        const type = message.type();
        if (type === this.bot.Message.Type.Text) {
          const text = message.text();
          this.handler?.({ chatId, text });
          return;
        }
        // 多模态：图片消息 → 附件（base64），不再只返回占位
        if (type === this.bot.Message.Type.Image) {
          const fileBox = await message.toFileBox();
          const buf = await fileBox.toBuffer();
          this.handler?.({
            chatId,
            text: "",
            attachments: [
              {
                kind: "image",
                name: fileBox.name ?? "image",
                mimeType: fileBox.mimeType ?? "image/jpeg",
                data: buf.toString("base64"),
              },
            ],
          });
          return;
        }
      } catch (e) {
        log.error("im:wechat", `消息处理异常: ${(e as Error).message}`);
      }
    });

    await this.bot.start();
    this.started = true;
    log.info("im:wechat", "微信适配器已启动");
  }

  async stop(): Promise<void> {
    if (this.bot) await this.bot.stop();
    this.started = false;
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.bot) return;
    try {
      if (chatId.startsWith("room:")) {
        const room = await this.bot.Room.find({ id: chatId.slice(5) });
        if (room) await room.say(text);
      } else {
        const contact = await this.bot.Contact.find({ id: chatId.slice(8) });
        if (contact) await contact.say(text);
      }
    } catch (e) {
      log.error("im:wechat", `发送失败: ${(e as Error).message}`);
    }
  }
}
