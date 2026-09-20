/**
 * 系统时间注入：每轮对话/任务开始时，给 Agent 一个当前时刻锚点。
 *
 * 时区语义（与 cron.ts 一致，issue #1）：按【进程本地时区】取时间，
 * 保证 Coordinator 把自然语言换算为 cron、Agent 判断相对时间时，
 * 使用的时钟与 Scheduler 实际触发的时钟一致。
 * 日志时间戳/轮转（logger.ts）与启动时区提示（index.ts）也复用本模块的本地时间工具，
 * 避免同一系统内混用 UTC 与本地时间。
 *
 * 注入格式约定（静态说明写入各 Agent 的 system prompt，此处只生成值）：
 * （系统时间：YYYY-MM-DD HH:mm，周X）
 */

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

/** 本地日期 YYYY-MM-DD（如日志按天轮转的归档日期） */
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** 本地时间戳：ISO 8601 带时区偏移，如 2026-09-20T15:01:44.123+08:00（用于日志，可读且无时区歧义） */
export function localTimestamp(now: Date = new Date()): string {
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
  return `${localDay(now)}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export interface TimezoneInfo {
  /** IANA 时区名，如 Asia/Shanghai；无法解析时为 "unknown" */
  name: string;
  /** 相对 UTC 的偏移分钟数（东八区 = 480） */
  offsetMinutes: number;
  /** 展示文案，如 `Asia/Shanghai (UTC+8)` */
  label: string;
}

/** 当前进程时区信息（与 systemTimeBlock / cron 使用的是同一个进程本地时钟） */
export function timezoneInfo(now: Date = new Date()): TimezoneInfo {
  const name = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  const offsetMinutes = -now.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offset =
    abs % 60 === 0 ? `${sign}${Math.floor(abs / 60)}` : `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return { name, offsetMinutes, label: `${name} (UTC${offset})` };
}

/** 生成当前系统时间块，如：`（系统时间：2025-07-18 14:32，周五）` */
export function systemTimeBlock(now: Date = new Date()): string {
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  return `（系统时间：${localDay(now)} ${time}，${WEEKDAYS[now.getDay()]!}）`;
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
