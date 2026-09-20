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

/**
 * 格式化本地时间为 "YYYY-MM-DD HH:mm"（一次性任务 runAt 的存储格式，issue #49）。
 */
export function formatLocalDateTime(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 解析本地时间 "YYYY-MM-DD HH:mm" → Date（严格校验，非法抛错）。
 * 与 cron 一致按【进程本地时区】解释；不依赖 Date 引擎对非 ISO 字符串的隐式解析。
 */
export function parseLocalDateTime(text: string): Date {
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!m) {
    throw new Error(`一次性触发时间格式必须为 "YYYY-MM-DD HH:mm"（本地时间），收到 "${text}"`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const date = new Date(year, month - 1, day, hour, minute, 0, 0);
  // 回读校验：拦截 2026-02-30、25:00 之类的非法日期时间
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day ||
    date.getHours() !== hour ||
    date.getMinutes() !== minute
  ) {
    throw new Error(`时间 "${text}" 不是合法的日期时间`);
  }
  return date;
}
