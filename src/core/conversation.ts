/**
 * 会话键（conversationKey）——会话隔离的唯一标识（issue #53/#54）。
 *
 * - 主会话（私聊 / 群根级）：key = chatId；
 * - 话题/线程（飞书话题群、普通群回复串）：key = chatId:threadKey。
 *
 * 会话池、附件归属均以此为键；平台适配器负责把 root_id/thread_id 归一化为 threadKey。
 */
export function conversationKeyOf(chatId: string, threadKey?: string): string {
  return threadKey ? `${chatId}:${threadKey}` : chatId;
}
