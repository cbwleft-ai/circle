/**
 * 控制台适配器：stdin 逐行输入，chatId 固定为 "console"。
 * 适合本地演示、调试与自动化测试。
 */
import { createInterface } from "node:readline";
import type { ChatMessage } from "../core/types.js";
import { log } from "../core/logger.js";
import type { ImAdapter } from "./adapter.js";

export class ConsoleAdapter implements ImAdapter {
  readonly name = "console";
  private rl?: ReturnType<typeof createInterface>;
  private handler?: (msg: ChatMessage) => void;

  onMessage(cb: (msg: ChatMessage) => void): void {
    this.handler = cb;
  }

  async start(): Promise<void> {
    this.rl = createInterface({ input: process.stdin, terminal: false });
    this.rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;
      if (text === "/quit" || text === "/exit") {
        process.exit(0);
      }
      this.handler?.({ chatId: "console", text });
    });
    log.info("im:console", "控制台模式已启动。输入消息与 Coordinator 对话，输入 /quit 退出。");
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }

  async send(chatId: string, text: string): Promise<void> {
    if (chatId !== "console") return;
    console.log("\n🤖 Coordinator: " + text.replace(/\n/g, "\n        "));
  }
}
