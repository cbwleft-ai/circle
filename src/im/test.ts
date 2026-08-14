/**
 * 测试适配器：内存实现，供自动化测试注入消息并捕获回复。
 */
import type { ChatMessage } from "../core/types.js";
import type { ImAdapter } from "./adapter.js";

export class TestAdapter implements ImAdapter {
  readonly name = "test";
  sent: Array<{ chatId: string; text: string; ts: number }> = [];
  private handler?: (msg: ChatMessage) => void;

  onMessage(cb: (msg: ChatMessage) => void): void {
    this.handler = cb;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  /** 测试注入上行消息 */
  async inject(chatId: string, text: string): Promise<void> {
    this.handler?.({ chatId, text });
  }

  async send(chatId: string, text: string): Promise<void> {
    this.sent.push({ chatId, text, ts: Date.now() });
  }

  /** 所有已发送文本（拼接） */
  allText(): string {
    return this.sent.map((s) => s.text).join("\n---\n");
  }

  /** 等待某条回复出现（轮询） */
  async waitFor(
    predicate: (text: string) => boolean,
    opts: { timeoutMs?: number; since?: number } = {},
  ): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const since = opts.since ?? 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const hit = this.sent.find((s) => s.ts >= since && predicate(s.text));
      if (hit) return hit.text;
      await sleep(300);
    }
    throw new Error(`等待回复超时(${timeoutMs}ms): 已收到消息:\n${this.allText()}`);
  }

  countAfter(since: number): number {
    return this.sent.filter((s) => s.ts >= since).length;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
