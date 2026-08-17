/**
 * IM 适配器接口。
 * Circle 通过适配器对接不同 IM（微信、HTTP、控制台），
 * 团队内部只依赖本接口，便于扩展新的 IM 通道。
 */
import type { ChatMessage, OutboundFile } from "../core/types.js";

export interface ImAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** 向指定会话发送消息 */
  send(chatId: string, text: string): Promise<void>;
  /**
   * 向指定会话发送文件消息（附件）。
   * 可选：不支持文件发送的通道（控制台/HTTP 等）可不实现，
   * 上层（AgentTeam）会自动降级为文本 + 产出物路径提示，不阻塞主流程。
   */
  sendFile?(chatId: string, file: OutboundFile): Promise<void>;
  /** 注册上行消息回调（IM → 团队） */
  onMessage(cb: (msg: ChatMessage) => void): void;
}
