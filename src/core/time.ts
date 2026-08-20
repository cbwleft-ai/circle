/**
 * 系统时间注入：每轮对话/任务开始时，给 Agent 一个当前时刻锚点。
 *
 * 时区语义（与 cron.ts 一致，issue #1）：按【进程本地时区】取时间，
 * 保证 Coordinator 把自然语言换算为 cron、Agent 判断相对时间时，
 * 使用的时钟与 Scheduler 实际触发的时钟一致。
 *
 * 注入格式约定（静态说明写入各 Agent 的 system prompt，此处只生成值）：
 * （系统时间：YYYY-MM-DD HH:mm，周X）
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 生成当前系统时间块，如：`（系统时间：2025-07-18 14:32，周五）` */
export function systemTimeBlock(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `（系统时间：${date} ${time}，${WEEKDAYS[now.getDay()]!}）`;
}
