import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface AppConfig {
  /** 数据目录（任务存储、定时任务存储、工作空间） */
  dataDir: string;
  /** 长程任务判定阈值（秒） */
  longTaskThresholdSec: number;
  /** Coordinator 每 N 轮对话检查一次待办任务状态 */
  statusCheckInterval: number;
  /** Scheduler 调度 tick 间隔（毫秒） */
  schedulerTickMs: number;
  /** 每日清理：已完成超过该天数（默认 30）的任务及临时工作空间 */
  cleanupAfterDays: number;
  /** 每日清理 cron（默认每天 03:00） */
  cleanupCron: string;
  /** 单任务执行超时（毫秒） */
  taskTimeoutMs: number;
  /** pi agentDir（模型/凭据配置目录，默认 ~/.pi/agent） */
  agentDir: string;
  /** 模型 provider */
  modelProvider: string;
  /** 模型 id */
  modelId: string;
  /** 视觉模型 provider（用于图片/视觉任务，默认回退到 modelProvider） */
  visionModelProvider: string;
  /** 视觉模型 id（用于图片/视觉任务，默认回退到 modelId；需支持 input 含 image） */
  visionModelId: string;
  /** Coordinator 思考级别 */
  coordinatorThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** Worker 思考级别 */
  workerThinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  /** IM 适配器: console | http | wechat | weixin */
  imAdapter: "console" | "http" | "wechat" | "weixin";
  /** HTTP 适配器端口 */
  httpPort: number;
  /** 微信机器人配置 */
  wechat: {
    puppet?: string;
    puppetToken?: string;
    /** 接收指令的联系人备注名（留空则接受所有人） */
    allowContacts: string[];
  };
  /** 微信官方 iLink 通道配置 */
  weixin: {
    /** 直接指定 bot token（跳过扫码登录） */
    botToken?: string;
    /** API base URL（默认官方 https://ilinkai.weixin.qq.com） */
    baseUrl?: string;
    /** bot 类型（默认 3） */
    botType?: string;
  };
}

const env = (key: string): string | undefined => process.env[key];
const envInt = (key: string, fallback: number): number => {
  const v = env(key);
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
};
const envBool = (key: string, fallback: boolean): boolean => {
  const v = env(key);
  if (v === undefined) return fallback;
  return v === "1" || v.toLowerCase() === "true";
};

export function loadConfig(): AppConfig {
  const dataDir = env("CIRCLE_DATA_DIR") ?? resolve(__dirname, "../../data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(resolve(dataDir, "workspaces"), { recursive: true });
  mkdirSync(resolve(dataDir, "sessions"), { recursive: true });
  return {
    dataDir,
    longTaskThresholdSec: envInt("CIRCLE_LONG_TASK_SEC", 10),
    statusCheckInterval: envInt("CIRCLE_STATUS_CHECK_INTERVAL", 5),
    schedulerTickMs: envInt("CIRCLE_SCHEDULER_TICK_MS", 30_000),
    cleanupAfterDays: envInt("CIRCLE_CLEANUP_AFTER_DAYS", 30),
    cleanupCron: env("CIRCLE_CLEANUP_CRON") ?? "0 3 * * *",
    taskTimeoutMs: envInt("CIRCLE_TASK_TIMEOUT_MS", 30 * 60 * 1000),
    agentDir: env("CIRCLE_AGENT_DIR") ?? process.env.HOME + "/.pi/agent",
    modelProvider: env("CIRCLE_MODEL_PROVIDER") ?? "deepseek",
    modelId: env("CIRCLE_MODEL_ID") ?? "deepseek-v4-flash",
    visionModelProvider: env("CIRCLE_VISION_MODEL_PROVIDER") ?? env("CIRCLE_MODEL_PROVIDER") ?? "deepseek",
    visionModelId: env("CIRCLE_VISION_MODEL_ID") ?? env("CIRCLE_MODEL_ID") ?? "deepseek-v4-flash",
    coordinatorThinkingLevel:
      (env("CIRCLE_COORDINATOR_THINKING") as AppConfig["coordinatorThinkingLevel"]) ?? "low",
    workerThinkingLevel:
      (env("CIRCLE_WORKER_THINKING") as AppConfig["workerThinkingLevel"]) ?? "high",
    imAdapter: (env("CIRCLE_IM_ADAPTER") as AppConfig["imAdapter"]) ?? "console",
    httpPort: envInt("CIRCLE_HTTP_PORT", 8787),
    wechat: {
      puppet: env("WECHAT_PUPPET"),
      puppetToken: env("WECHAT_PUPPET_TOKEN"),
      allowContacts: (env("WECHAT_ALLOW_CONTACTS") ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    },
    weixin: {
      botToken: env("CIRCLE_WEIXIN_BOT_TOKEN"),
      baseUrl: env("CIRCLE_WEIXIN_BASE_URL"),
      botType: env("CIRCLE_WEIXIN_BOT_TYPE"),
    },
  };
}

/** 长程任务启发式关键词（作为 Coordinator 判定的兜底，保证不会漏判） */
export const LONG_TASK_PATTERNS: RegExp[] = [
  /sleep\s+\d+/i,
  /等待\s*\d+\s*(秒|分钟)/,
  /耗时/,
  /长时间/,
  /长程/,
  /长任务/,
  /\d+\s*(秒|分钟)\s*(以上|之后|后)/,
  /下载/,
  /爬取/,
  /批量/,
  /循环/,
  /编译/,
  /渲染/,
  /训练/,
  /\.\.\./,
];

/**
 * 视觉/图片任务启发式关键词：
 * 命中时 Worker 优先使用配置的视觉模型（若与默认模型不同）。
 */
export const VISION_TASK_PATTERNS: RegExp[] = [
  /图片|图像|看图|读图|截图|视觉|缩略图|photo|image|vision|screenshot/i,
  /描述.*(内容|图片)|识别.*(文字|内容)|ocr/i,
  /【图片】/,
];

/**
 * 判断模型是否支持图片（视觉）输入。
 * pi 的模型定义中 `input` 数组含 "image" 即表示支持视觉输入。
 */
export function supportsVision(model: { input?: readonly string[] } | undefined): boolean {
  return !!model && Array.isArray(model.input) && model.input.includes("image");
}

/**
 * 默认 Worker 配置：
 * 可通过环境变量 CIRCLE_WORKERS 传入 JSON 数组覆盖，例如：
 * [{"name":"dev","description":"负责开发类任务","cwd":"/path/to/dev"}]
 */
export function defaultWorkers(dataDir: string): WorkerConfig[] {
  const raw = process.env.CIRCLE_WORKERS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as WorkerConfig[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch (e) {
      console.warn(`[config] CIRCLE_WORKERS 解析失败，使用默认 Worker: ${(e as Error).message}`);
    }
  }
  return [
    {
      name: "default",
      description: "通用 Worker：负责各类文件/脚本/数据处理任务，产出物输出到其工作目录。",
      cwd: `${dataDir}/workspaces/default`,
    },
  ];
}

import type { WorkerConfig } from "./core/types.js";
