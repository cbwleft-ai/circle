/**
 * 长文本摘要（头尾兼顾）：结果不超过 maxChars 时原样返回；
 * 超过时保留头部 headChars + 尾部 tailChars，中间以省略标记连接。
 * 长任务的关键结论通常在尾部（Worker 提示词要求总结放最后），
 * 因此截断时保尾比保头更重要。
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
