/**
 * 轻量 cron 解析器：支持 5 段 cron（分 时 日 月 周），
 * 支持 *、数字、范围、步长、逗号列表。
 * 用于 Scheduler 的定时触发与每日清理。
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
 * 日字段（day-of-month / day-of-week）匹配，遵循 Vixie cron 语义：
 * - dom 与 dow 均为「未受限」（全覆盖，如 *）：每天均匹配；
 * - 仅其一未受限：以受限字段为准（未受限字段不参与约束）；
 * - 两者均受限：任一匹配即触发（与 Vixie cron 一致）。
 *
 * 修复 issue #2：旧实现 `domOk || dowOk` 在 dow 为 * 时恒为 true，
 * 导致「日」约束被忽略——一次性任务（如 `28 1 14 8 *`）被当作每天重复触发。
 */
function dayMatches(domField: CronField, dowField: CronField, d: number, dow: number): boolean {
  // 「未受限」= 覆盖该字段全部合法取值（dom 0..31 共 32 个、dow 0..7 共 8 个）
  const domUnrestricted = domField.values.size === 32;
  const dowUnrestricted = dowField.values.size === 8;
  const domOk = domField.values.has(d);
  const dowOk = dowField.values.has(dow);

  if (domUnrestricted && dowUnrestricted) return true;
  if (domUnrestricted) return dowOk;
  if (dowUnrestricted) return domOk;
  return domOk || dowOk;
}

/**
 * 计算 cron 在 from（严格之后）的下一次触发时间。
 * 返回时刻严格晚于 from：若起始分钟恰好命中（如触发后立即重算），
 * 会跳过该分钟，避免同一分钟内被重复触发（issue #2 重复触发的一部分）。
 */
export function nextRun(cron: ParsedCron | string, from: Date = new Date()): Date | undefined {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const [minField, hourField, domField, monField, dowField] = parsed.fields;
  const SCAN_LIMIT = 366 * 24 * 60; // 最多向前扫描 1 年

  const candidate = new Date(from);
  candidate.setUTCSeconds(0, 0);
  if (candidate.getTime() <= from.getTime()) {
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }

  for (let step = 0; step < SCAN_LIMIT; step++) {
    const m = candidate.getUTCMonth() + 1;
    const d = candidate.getUTCDate();
    const dow = candidate.getUTCDay(); // 0=周日

    const monOk = monField.values.has(m);

    if (monOk && dayMatches(domField, dowField, d, dow)) {
      if (hourField.values.has(candidate.getUTCHours())) {
        if (minField.values.has(candidate.getUTCMinutes())) {
          return new Date(candidate);
        }
      }
    }
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  return undefined;
}

/** 判断某个时刻是否匹配 cron（用于清理任务的到期判断）；日字段采用与 nextRun 一致的 Vixie 语义 */
export function matches(cron: ParsedCron | string, at: Date = new Date()): boolean {
  const parsed = typeof cron === "string" ? parseCron(cron) : cron;
  const [minField, hourField, domField, monField, dowField] = parsed.fields;
  return (
    minField.values.has(at.getUTCMinutes()) &&
    hourField.values.has(at.getUTCHours()) &&
    monField.values.has(at.getUTCMonth() + 1) &&
    dayMatches(domField, dowField, at.getUTCDate(), at.getUTCDay())
  );
}
