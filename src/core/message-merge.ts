/**
 * 连续消息合并（debounce + merge）
 *
 * 用户在 IM 中常连续发送多条消息表达一个完整意图
 * （例如「一张照片 + 一句描述」），若每条消息各自触发一轮 Coordinator
 * 回复，会得到多条割裂的回复。
 *
 * MessageMerger 按会话缓冲消息：
 * - **合并窗口只由携带附件（图片/文件）的消息启动**（照片 + 描述场景），
 *   纯文本消息无待合并批次时立即处理、零延迟；
 * - 同一会话窗口内的后续消息会重置窗口定时器（debounce），窗口内消息归为一批；
 * - 窗口到期后把批次合并为一条 ChatMessage，调用一次处理回调
 *   （Coordinator 一轮 → 一条回复）；
 * - 合并窗口为 0 时退化为立即逐条处理（合并关闭）。
 *
 * 放在 core 层而非 IM 适配器，保证 console / http / weixin 各通道行为一致，
 * 且逻辑可独立单元测试。
 */
import type { ChatMessage } from "./types.js";

/**
 * 合并多条连续消息为一条（纯函数，便于测试）：
 * - 文本：非空文本按到达顺序以换行拼接（trim 后）；
 * - 附件：全部按顺序合并（图片消息的文本常为空，会被跳过）；
 * - chatId：取第一条消息的会话。
 */
export function mergeMessages(messages: ChatMessage[]): ChatMessage {
  const first = messages[0];
  if (!first) throw new Error("mergeMessages: 消息列表为空");
  if (messages.length === 1) return first;
  const text = messages
    .map((m) => (m.text ?? "").trim())
    .filter(Boolean)
    .join("\n");
  const attachments = messages.flatMap((m) => m.attachments ?? []);
  return {
    chatId: first.chatId,
    text,
    attachments: attachments.length > 0 ? attachments : undefined,
  };
}

interface PendingBatch {
  chatId: string;
  messages: ChatMessage[];
  /** 等待本批处理完成的调用方（push 返回的 Promise） */
  settles: Array<{ resolve: () => void; reject: (e: unknown) => void }>;
  timer?: NodeJS.Timeout;
}

/**
 * 按会话的消息合并器：合并窗口内到达的消息归为一批，
 * 窗口到期后调用 `process(mergedMessage)` 处理一次。
 *
 * 合并策略（避免给纯文本对话引入延迟）：
 * - **只有携带附件（图片/文件）的消息才启动合并窗口**（照片 + 描述场景）；
 * - 纯文本消息若无待合并批次 → 立即处理、零延迟；
 * - 若该会话已有待合并批次（附件先到）→ 纯文本/附件消息并入该批并重置窗口；
 *
 * `push` 返回的 Promise 在该消息所在批次处理完成后 resolve
 * （合并关闭时即该条消息处理完成后 resolve），调用方仍可 await。
 */
export class MessageMerger {
  private readonly batches = new Map<string, PendingBatch>();

  constructor(
    /** 合并窗口（毫秒）；<=0 表示关闭合并，逐条立即处理 */
    private readonly windowMs: number,
    /** 一批消息合并后的处理回调（每批只调用一次） */
    private readonly process: (msg: ChatMessage) => Promise<void>,
  ) {}

  /** 进入一条消息，返回该消息所在批次处理完成的 Promise */
  push(msg: ChatMessage): Promise<void> {
    if (this.windowMs <= 0) {
      // 合并关闭：立即逐条处理
      return this.process(msg);
    }
    const chatId = msg.chatId;
    const hasAttachments = (msg.attachments ?? []).length > 0;
    const hasPendingBatch = this.batches.has(chatId);
    // 合并窗口只由附件消息启动；纯文本消息无待合并批次时立即处理（零延迟）
    if (!hasAttachments && !hasPendingBatch) {
      return this.process(msg);
    }
    let batch = this.batches.get(chatId);
    if (!batch) {
      batch = { chatId, messages: [], settles: [] };
      this.batches.set(chatId, batch);
    }
    batch.messages.push(msg);
    const settled = new Promise<void>((resolve, reject) => {
      batch!.settles.push({ resolve, reject });
    });
    // 新消息到达 → 重置窗口（debounce），窗口到期后统一处理
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      void this.flush(chatId);
    }, this.windowMs);
    return settled;
  }

  /** 立即处理指定会话的待合并批次（幂等：无批次时直接返回） */
  async flush(chatId: string): Promise<void> {
    const batch = this.batches.get(chatId);
    if (!batch) return;
    this.batches.delete(chatId);
    if (batch.timer) clearTimeout(batch.timer);
    const merged = mergeMessages(batch.messages);
    try {
      await this.process(merged);
      for (const s of batch.settles) s.resolve();
    } catch (e) {
      for (const s of batch.settles) s.reject(e);
    }
  }

  /** 立即处理所有待合并批次（测试 / 优雅退出时避免丢消息） */
  async flushAll(): Promise<void> {
    const ids = [...this.batches.keys()];
    await Promise.all(ids.map((id) => this.flush(id)));
  }

  /** 丢弃所有待合并批次并清除定时器（停止时调用） */
  dispose(): void {
    for (const b of this.batches.values()) {
      if (b.timer) clearTimeout(b.timer);
    }
    this.batches.clear();
  }

  /** 当前待合并的会话数（测试 / 观测用） */
  get pendingCount(): number {
    return this.batches.size;
  }
}
