/**
 * 文本工具：长文本摘要（头尾兼顾）等。
 */

/**
 * 长文本摘要（头尾兼顾）：结果不超过 maxChars 时原样返回；
 * 超过时保留头部 headChars + 尾部 tailChars，中间以省略标记连接。
 * 长任务的关键结论通常在尾部（Worker 提示词要求总结放最后），
 * 因此截断时保尾比保头更重要；完整结果始终已存于 TaskStore 与产出物目录。
 */
export function summarizeText(
  text: string,
  opts: { maxChars?: number; headChars?: number; tailChars?: number } = {},
): string {
  const maxChars = opts.maxChars ?? 4000;
  const headChars = opts.headChars ?? 1500;
  const tailChars = opts.tailChars ?? 1500;
  if (text.length <= maxChars) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const omitted = text.length - headChars - tailChars;
  return `${head}\n\n…(中间省略 ${omitted} 字符，完整结果已存储)…\n\n${tail}`;
}

/** 字节数人类可读格式化：1024 → 1.0 KB */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
