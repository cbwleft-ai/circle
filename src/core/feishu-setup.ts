/**
 * 飞书凭据的引导式配置（首次启动 / 更换凭据时）。
 *
 * 与微信通道的扫码登录思路一致（`src/im/weixin-ilink.ts` 的「环境变量 > 已保存账户 > 扫码登录」），
 * 区别是飞书无需轮询：**输入后立即调用一次接口校验，通过才落盘**，输错当场重输。
 */
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { log } from "./logger.js";
import { feishuAuthPath, saveFeishuAuth, verifyFeishuAuth, type FeishuAuth } from "./feishu-auth.js";

/** 引导式配置所需的飞书配置片段（与 AppConfig["feishu"] 兼容） */
export interface FeishuSetupTarget {
  mode: "ws" | "webhook";
  appId?: string;
  appSecret?: string;
  verificationToken?: string;
  encryptKey?: string;
  baseUrl?: string;
}

const MAX_ATTEMPTS = 3;

/** 丢弃所有输出的流：让 readline 不回显用户输入（用于密钥类输入） */
const mutedOutput = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});

async function promptLine(question: string, opts: { hidden?: boolean } = {}): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: opts.hidden ? mutedOutput : process.stdout,
    terminal: true,
  });
  try {
    if (opts.hidden) process.stdout.write(question);
    const answer = await rl.question(opts.hidden ? "" : question);
    if (opts.hidden) process.stdout.write("\n");
    return answer.trim();
  } finally {
    rl.close();
  }
}

/** 引导用户输入凭据并校验；返回校验通过的凭据，失败（放弃/超次数）返回 undefined */
async function promptAndVerify(target: FeishuSetupTarget): Promise<FeishuAuth | undefined> {
  process.stdout.write(
    [
      "",
      "未找到飞书应用凭据，进入引导式配置。",
      "请在飞书开放平台 →「凭证与基础信息」中获取 App ID 与 App Secret。",
      "",
    ].join("\n"),
  );

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const inputAppId = await promptLine(`App ID${target.appId ? `（回车沿用 ${target.appId}）` : ""}: `);
    const appId = inputAppId || target.appId || "";
    if (!appId) {
      process.stdout.write("App ID 不能为空。\n");
      continue;
    }
    const inputSecret = await promptLine("App Secret（输入不回显，回车沿用已保存值）: ", { hidden: true });
    const appSecret = inputSecret || target.appSecret || "";
    if (!appSecret) {
      process.stdout.write("App Secret 不能为空。\n");
      continue;
    }

    process.stdout.write("正在校验凭据…");
    try {
      await verifyFeishuAuth({ appId, appSecret }, target.baseUrl);
      process.stdout.write(" 通过\n");
    } catch (e) {
      process.stdout.write(` 失败：${(e as Error).message}\n`);
      if (attempt < MAX_ATTEMPTS) process.stdout.write(`请重新输入（剩余 ${MAX_ATTEMPTS - attempt} 次）。\n`);
      continue;
    }

    const auth: FeishuAuth = { appId, appSecret };
    // webhook 模式才需要回调校验 token 与事件加密密钥（ws 长连接不需要）
    if (target.mode === "webhook") {
      const inputToken = await promptLine("Verification Token（可选，回车沿用已保存值）: ");
      auth.verificationToken = inputToken || target.verificationToken || undefined;
      const inputKey = await promptLine("Encrypt Key（可选，输入不回显）: ", { hidden: true });
      auth.encryptKey = inputKey || target.encryptKey || undefined;
    }
    return auth;
  }
  return undefined;
}

/**
 * 确保飞书凭据可用：已配置则直接返回 false，否则引导输入 → 校验 → 写入密钥文件，
 * 并把结果回填到传入的 target（调用方的 config.feishu 随之更新）。
 *
 * @param force 忽略已有凭据，强制重新配置（更换/轮换凭据）
 * @returns 是否新配置了凭据
 */
export async function ensureFeishuCredentials(target: FeishuSetupTarget, opts: { force?: boolean } = {}): Promise<boolean> {
  if (!opts.force && target.appId && target.appSecret) return false;

  if (!process.stdin.isTTY) {
    throw new Error(
      "飞书凭据缺失，且当前不是交互式终端（无法引导式配置）。请二选一：\n" +
        `  1) 写入凭据文件：${feishuAuthPath()}（内容如 {"appId":"cli_xxx","appSecret":"xxx"}，权限 600）\n` +
        "  2) 设置环境变量 CIRCLE_FEISHU_APP_ID / CIRCLE_FEISHU_APP_SECRET（注意：会进入 Worker 子进程环境）",
    );
  }

  const auth = await promptAndVerify(target);
  if (!auth) {
    throw new Error("飞书凭据配置未完成（校验失败或超出重试次数），已退出。");
  }

  const path = saveFeishuAuth(auth);
  target.appId = auth.appId;
  target.appSecret = auth.appSecret;
  target.verificationToken = auth.verificationToken;
  target.encryptKey = auth.encryptKey;
  log.info("feishu", `已保存飞书凭据到 ${path}（权限 600）`);
  return true;
}