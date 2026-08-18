/** 极简分级日志（同时写入内存缓冲，供测试断言与报告使用；可选落盘到数据目录） */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = (process.env.CIRCLE_LOG_LEVEL as LogLevel) ?? "info";

export function setLogLevel(level: LogLevel) {
  minLevel = level;
}

// ============ 文件输出（data/logs/circle.log，按天轮转） ============

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

let logFile: string | undefined;
/** 当前写入的日志文件对应的日期（UTC），跨天时轮转归档 */
let logFileDay = "";

/**
 * 启用文件日志：写入 file（如 data/logs/circle.log）。
 * 跨天时把旧文件归档为 circle-YYYY-MM-DD.log，再新建当日文件，
 * 保证 tail -f 的固定文件名始终指向最新日志。
 */
export function setLogFile(file: string): void {
  logFile = file;
  mkdirSync(dirname(file), { recursive: true });
  logFileDay = new Date().toISOString().slice(0, 10);
  try {
    appendFileSync(file, `\n===== Circle 启动 ${new Date().toISOString()} =====\n`);
  } catch {
    // 文件写入失败不阻塞主流程（仅控制台/内存日志继续）
  }
}

function writeFileLine(line: string): void {
  if (!logFile) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    if (day !== logFileDay) {
      // 跨天：归档昨天的文件，今天的写新文件
      try {
        if (existsSync(logFile) && statSync(logFile).size > 0) {
          renameSync(logFile, `${logFile}.${logFileDay}`);
        }
      } catch {
        // 归档失败忽略，继续写当前文件
      }
      logFileDay = day;
    }
    appendFileSync(logFile, line + "\n");
  } catch {
    // 写入失败不阻塞主流程
  }
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
  // 强制单行：消息中的换行转义为字面 \n，避免日志被多行消息打断
  const singleLine = msg.replace(/\r?\n/g, "\\n");
  const line = `[${ts()}] [${level.toUpperCase()}] [${tag}] ${singleLine}`;
  logBuffer.push(line);
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  writeFileLine(line);
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
