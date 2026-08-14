/** 极简分级日志（同时写入内存缓冲，供测试断言与报告使用） */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = (process.env.CIRCLE_LOG_LEVEL as LogLevel) ?? "info";

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

/** 内存环形缓冲 */
class RingBuffer {
  private items: string[] = [];
  constructor(private capacity = 5000) {}
  push(line: string) {
    this.items.push(line);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  all(): string[] {
    return [...this.items];
  }
  clear() {
    this.items = [];
  }
}

export const logBuffer = new RingBuffer();

function ts(): string {
  return new Date().toISOString();
}

function emit(level: LogLevel, tag: string, msg: string) {
  const line = `[${ts()}] [${level.toUpperCase()}] [${tag}] ${msg}`;
  logBuffer.push(line);
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  debug: (tag: string, msg: string) => emit("debug", tag, msg),
  info: (tag: string, msg: string) => emit("info", tag, msg),
  warn: (tag: string, msg: string) => emit("warn", tag, msg),
  error: (tag: string, msg: string) => emit("error", tag, msg),
};
