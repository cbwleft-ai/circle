/**
 * 轻量 cron 解析器：支持 5 段 cron（分 时 日 月 周），
 * 支持 *、数字、范围、步长、逗号列表。
 * 用于 Scheduler 的定时触发与每日清理。
 *
 * 时区语义（issue #1）：cron 各字段（分/时/日/月/周）按【进程本地时区】解释。
 * 用户按本地时间填写的 cron（如 `0 9 * * *` = 本地 09:00）将被正确解析，
 * 不再按 UTC 解析导致触发时刻偏移（UTC+8 环境下晚 8 小时）。
 */

export type CronField = { values: Set<number>; wildcard: boolean };

const FIELD_NAMES = ["minute", "hour", "day-of-month", "month", "day-of-week"] as const;

export function parseField(expr: string, field: number, max: number): CronField {
  const name = FIELD_NAMES[field];
  const values = new Set<number>();
  let wildcard = false;

  const tokens = expr.split(",");
  if (tokens.some((t) => t.trim() === "")) {
    throw new Error(`cron 表达式字段 ${name} 存在空 token`);
  }
  for (const raw of tokens) {
    const token = raw.trim();
    if (token === "*") {
      wildcard = true;
      for (let i = 0; i <= max; i++) values.add(i);
      continue;
    }
    const stepMatch = token.match(/^(\*|\d+)(?:-(\d+))?\/(\d+)$/);
    if (stepMatch) {
      const [, startRaw, endRaw, stepRaw] = stepMatch;
      const step = parseInt(stepRaw, 10);
      if (step <= 0) throw new Error(`cron 字段 ${name} 步长必须 > 0`);
      const start = startRaw === "*" ? 0 : parseInt(startRaw, 10);
      const end = endRaw !== undefined ? parseInt(endRaw, 10) : max;
      if (startRaw === "*") wildcard = true;
      for (let v = start; v <= end; v += step) values.add(v);
      continue;
    }
    const rangeMatch = token.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const [, a, b] = rangeMatch;
      const lo = Math.min(parseInt(a, 10), parseInt(b, 10));
      const hi = Math.max(parseInt(a, 10), parseInt(b, 10));
      for (let v = lo; v <= hi; v++) values.add(v);
      continue;
    }
    const num = parseInt(token, 10);
    if (Number.isNaN(num)) throw new Error(`cron 字段 ${name} 无法解析 token "${token}"`);
    values.add(num);
  }

  for (const v of values) {
    if (v < 0 || v > max) throw new Error(`cron 字段 ${name} 取值 ${v} 超出范围 0-${max}`);
  }
  if (values.size === 0) throw new Error(`cron 字段 ${name} 为空`);
  return { values, wildcard };
}

export interface ParsedCron {
  fields: [CronField, CronField, CronField, CronField, CronField];
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron 表达式必须为 5 段（分 时 日 月 周），收到 ${parts.length} 段: "${expr}"`);
  }
  return {
    fields: [
      parseField(parts[0]!, 0, 59),
      parseField(parts[1]!, 1, 23),
      parseField(parts[2]!, 2, 31),
      parseField(parts[3]!, 3, 12),
      parseField(parts[4]!, 4, 7), // 0/7 = 周日
    ],
  };
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * 计算 cron 在 from（含）之后的下一次触发时间。
 * 注意：dom 与 dow 的关系采用「两者任一匹配即触发」（与 Vixie cron 一致）。
 */
export function nextRun(cron: ParsedCron | string, from: Date = new Date()): Date | undefined {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const [minField, hourField, domField, monField, dowField] = parsed.fields;
  const SCAN_LIMIT = 366 * 24 * 60; // 最多向前扫描 1 年

  const candidate = new Date(from);
  candidate.setSeconds(0, 0);

  // 全部使用本地时间字段（getFullYear/getMonth/getDate/getDay/getHours/getMinutes），
  // 使 cron 的「分 时 日 月 周」按进程本地时区匹配，修复 UTC+8 晚 8 小时触发问题。
  for (let step = 0; step < SCAN_LIMIT; step++) {
    const m = candidate.getMonth() + 1;
    const d = candidate.getDate();
    const dow = candidate.getDay(); // 0=周日

    const monOk = monField.values.has(m);
    const domOk = domField.values.has(d);
    const dowOk = dowField.values.has(dow);

    if (monOk && (domOk || dowOk)) {
      if (hourField.values.has(candidate.getHours())) {
        if (minField.values.has(candidate.getMinutes())) {
          return new Date(candidate);
        }
      }
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return undefined;
}

/** 判断某个时刻是否匹配 cron（用于清理任务的到期判断） */
export function matches(cron: ParsedCron | string, at: Date = new Date()): boolean {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const [minField, hourField, domField, monField, dowField] = parsed.fields;
  // 与 nextRun 一致：按进程本地时区匹配（修复 UTC 解析导致的 8 小时偏差）。
  return (
    minField.values.has(at.getMinutes()) &&
    hourField.values.has(at.getHours()) &&
    domField.values.has(at.getDate()) &&
    monField.values.has(at.getMonth() + 1) &&
    dowField.values.has(at.getDay())
  );
}
