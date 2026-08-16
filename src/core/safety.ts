/**
 * 安全评估模块（Coordinator 的第一道防线）
 *
 * 设计原则：
 * 1. 破坏性操作（删除、格式化、关停等）→ 直接拒绝，不进入执行链路；
 * 2. 敏感信息（密钥、口令、私钥等）→ 拒绝读取/返回；
 * 3. 判定是确定性的（正则规则），不依赖 LLM 判断，保证不可绕过；
 * 4. 即使 Coordinator（LLM）误判并尝试派发，dispatch 入口会再次调用本模块复核。
 */
import type { SafetyVerdict } from "./types.js";

/** 破坏性操作规则 */
const DESTRUCTIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /rm\s+-rf/i, reason: "rm -rf 强制递归删除" },
  { re: /rm\s+-fr/i, reason: "rm -fr 强制递归删除" },
  { re: /\brm\s+-f\b/i, reason: "强制删除文件" },
  { re: /rmdir\s+\//, reason: "删除根目录" },
  { re: /drop\s+(table|database|schema)/i, reason: "删除数据库/表结构" },
  { re: /truncate\s+(table|database)/i, reason: "清空数据库表" },
  { re: /format\s+[a-z]:/i, reason: "格式化磁盘" },
  { re: /\b(shutdown|reboot|poweroff|init\s+0)\b/i, reason: "关机/重启系统" },
  { re: /kill\s+-9\s+(1|0)\b/, reason: "杀死系统关键进程" },
  { re: /git\s+push\s+--force/i, reason: "强制推送覆盖远端" },
  { re: /git\s+reset\s+--hard/i, reason: "丢弃所有未提交改动" },
  { re: /删除.*(运行目录|运行环境|整个项目|项目根|所有文件|全部文件)/i, reason: "删除运行目录/项目文件" },
  { re: /清空.*(目录|文件夹|项目)/i, reason: "清空目录" },
  { re: /删除.*(目录|文件夹|工作区)/i, reason: "删除目录" },
  { re: /卸载.*(系统|运行时|node|python)/i, reason: "卸载运行环境" },
  { re: /(破坏|摧毁|瘫痪|搞坏).*(环境|系统|服务)/i, reason: "破坏运行环境" },
  { re: /rm\s+.*(\/\*|\.\*|~\*)/, reason: "使用通配符危险删除" },
  // 持久定时 / 后台驻留机制：Worker 越权创建系统级定时器/后台进程，
  // 绕过 Scheduler 治理（nextRunAt/去重/清理均失效），且为孤儿副作用（系统删除后仍残留）
  { re: /\bcrontab\b/i, reason: "crontab 定时任务表（系统级定时器）" },
  // cron/crontab 后【紧邻】脚本/文件/条目类完整词才算自建定时条目
  // （"cron 表达式/定时任务"为合法功能语义；避免单字词表误伤如"表达式"的"表"字）
  { re: /(?:cron|crontab)\s*(?:脚本|文件|条目)/i, reason: "自建 cron/crontab 定时条目" },
  { re: /定时脚本/i, reason: "自建定时脚本" },
  { re: /systemctl\s+(?:enable|start|daemon-reload)/i, reason: "systemd 服务/定时器管理" },
  { re: /systemd\s+timer/i, reason: "systemd timer 定时器" },
  { re: /\bat\s+now\b/i, reason: "at 一次性定时任务" },
  { re: /\bnohup\b/i, reason: "nohup 后台驻留运行" },
];

/** 敏感信息规则（读取/返回） */
const SENSITIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /api[_-]?key/i, reason: "API 密钥" },
  { re: /\bsecret\b/i, reason: "secret 密钥" },
  { re: /pass(word|wd)?/i, reason: "口令/密码" },
  { re: /private\s+key/i, reason: "私钥" },
  { re: /id_rsa|id_ed25519|id_ecdsa/i, reason: "SSH 私钥文件" },
  { re: /\.ssh[\\/]/i, reason: "SSH 配置目录" },
  { re: /\.env\b/i, reason: "环境变量文件（常含密钥）" },
  { re: /credentials?/i, reason: "凭据" },
  { re: /access[_-]?token/i, reason: "访问令牌" },
  { re: /(密钥|密码|口令|私钥|令牌|token)/i, reason: "敏感凭证" },
  { re: /auth\.json|models-store\.json/i, reason: "凭据存储文件" },
  { re: /(银行卡|身份证|手机号|手机号码|社保卡)/i, reason: "个人敏感信息" },
  { re: /webhook.*(secret|token|url)/i, reason: "Webhook 密钥" },
];

/** 读取/返回类动作动词（带否定语境检测："不要读取"不判为敏感意图） */
const READ_VERBS =
  /(?<!不要)(?<!别)(?<!禁止)(?<!请勿)(?<!无需)(?<!不需要)(?<!避免)(?<!拒绝)(?<!不能)(?<!不可)(读取|读|查看|显示|展示|输出|返回|给我|导出|打印|打开|获取|查询|cat\s|less\s|more\s|head\s|tail\s)/i;

/**
 * 对请求文本做安全评估。
 * 优先级：破坏性 > 敏感信息 > 安全。
 */
export function assessSafety(text: string): SafetyVerdict {
  const reasons: string[] = [];
  for (const { re, reason } of DESTRUCTIVE_PATTERNS) {
    if (re.test(text)) reasons.push(`破坏性操作: ${reason}`);
  }
  if (reasons.length > 0) {
    return { risk: "destructive", reasons: reasons.slice(0, 3) };
  }
  for (const { re, reason } of SENSITIVE_PATTERNS) {
    if (re.test(text)) {
      // 仅当上下文是「读取/返回」类意图时才判为敏感；
      // 例如用户说「不要读取密钥」不应被拦截。
      if (READ_VERBS.test(text)) {
        reasons.push(`敏感信息: ${reason}`);
      }
    }
  }
  if (reasons.length > 0) {
    return { risk: "sensitive", reasons: reasons.slice(0, 3) };
  }
  return { risk: "none", reasons: [] };
}

export const REFUSAL_DESTRUCTIVE =
  "⚠️ 安全拦截：该请求涉及破坏性操作，已被拒绝执行。\n" +
  "Coordinator 不会执行任何删除、格式化、关停等破坏性操作，也不会将其派发给 Worker 或 Scheduler。\n" +
  "如确需此类操作，请由人工在受控环境中手动完成。";

export const REFUSAL_SENSITIVE =
  "⚠️ 安全拦截：该请求涉及敏感信息（密钥/口令/私钥等），已被拒绝读取与返回。\n" +
  "Coordinator 不会访问或返回敏感信息，也不会将其派发给 Worker 或 Scheduler。\n" +
  "请使用系统提供的受管密钥服务（如环境变量、密钥管理平台）完成凭证注入。";
