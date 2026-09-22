/**
 * 飞书应用凭据的持久化与校验。
 *
 * 凭据默认存于 `~/.circle/secrets/feishu.json`（0600），**不写入仓库、也不进进程环境变量**：
 * 环境变量会被 Worker 子进程继承（`printenv` 即可读到），而密钥文件只有主动读取才暴露。
 *
 * 解析优先级（见 src/config.ts）：环境变量 > 密钥文件 > 引导式配置（src/core/feishu-setup.ts）。
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface FeishuAuth {
  appId: string;
  appSecret: string;
  verificationToken?: string;
  encryptKey?: string;
}

/** 密钥目录：默认 `~/.circle/secrets`，与 data 目录平级但在 Worker 工作区之外 */
export function secretsDir(): string {
  return process.env.CIRCLE_SECRETS_DIR ?? resolve(homedir(), ".circle", "secrets");
}

/** 飞书凭据文件路径 */
export function feishuAuthPath(): string {
  return join(secretsDir(), "feishu.json");
}

/** 读取飞书凭据；文件不存在、损坏或字段不全时返回 undefined（不抛错） */
export function loadFeishuAuth(): FeishuAuth | undefined {
  const path = feishuAuthPath();
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return undefined; // 未配置（首次启动走引导式配置）
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FeishuAuth>;
    if (!parsed.appId || !parsed.appSecret) {
      console.warn(`[config] 飞书凭据文件缺少 appId/appSecret: ${path}`);
      return undefined;
    }
    return {
      appId: parsed.appId,
      appSecret: parsed.appSecret,
      verificationToken: parsed.verificationToken,
      encryptKey: parsed.encryptKey,
    };
  } catch (e) {
    console.warn(`[config] 飞书凭据文件解析失败: ${(e as Error).message}（${path}）`);
    return undefined;
  }
}

/**
 * 写入飞书凭据（目录 0700、文件 0600）。
 *
 * 注意：writeFileSync 的 mode 仅在**新建**文件时生效，覆盖已有文件不会改变权限，
 * 因此写入后显式 chmod 一次，保证历史遗留的宽权限文件被收紧。
 */
export function saveFeishuAuth(auth: FeishuAuth): string {
  const dir = secretsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = feishuAuthPath();
  const payload: FeishuAuth = { appId: auth.appId, appSecret: auth.appSecret };
  if (auth.verificationToken) payload.verificationToken = auth.verificationToken;
  if (auth.encryptKey) payload.encryptKey = auth.encryptKey;
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/**
 * 调用飞书接口校验应用凭据（换取 tenant_access_token）。
 * 校验失败抛出带飞书错误信息的异常，便于引导式配置当场提示重输。
 */
export async function verifyFeishuAuth(
  auth: { appId: string; appSecret: string },
  baseUrl = "https://open.feishu.cn",
): Promise<void> {
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: auth.appId, app_secret: auth.appSecret }),
  });
  const data = (await res.json().catch(() => ({}))) as {
    code?: number;
    msg?: string;
    tenant_access_token?: string;
  };
  if (!res.ok || !data.tenant_access_token) {
    throw new Error(`换取 tenant_access_token 失败：${data.msg ?? `HTTP ${res.status}`}`);
  }
}