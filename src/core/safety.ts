/**
 * 安全评估模块（Coordinator 的第一道防线）
 *
 * 设计原则：
 * 1. 破坏性操作（删除、格式化、关停等）→ 直接拒绝，不进入执行链路；
 * 2. 敏感信息（密钥、口令、私钥等）→ 拒绝读取/返回真实值；
 * 3. 判定是确定性的（正则规则），不依赖 LLM 判断，保证不可绕过；
 * 4. 即使 Coordinator（LLM）误判并尝试派发，dispatch 入口会再次调用本模块复核；
 * 5. 区分「读取/返回真实私密值」与「配置结构/格式/字段调研」（issue #4）：
 *    - 明确要求取值（值/内容/明文/打印/导出等）→ 拦截（sensitive）；
 *    - 仅调研配置结构/格式/字段/模板/文档（如"查询 token 字段的格式"）→ 放行但提示（warning），
 *      禁止读取任何真实私密值；
 *    - 仅为字面提及敏感词 + 读取动词 → 拦截（sensitive），保持原有兜底。
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

/**
 * 敏感信息规则（读取/返回）。
 * 说明：英文规则均带词边界（\b），避免把 "compass"/"passport"/"jsonwebtoken" 等
 * 普通单词中的 "pass"/"token" 子串误判为敏感信息（issue #4 误判来源之一）。
 */
const SENSITIVE_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bapi[_-]?keys?\b/i, reason: "API 密钥" },
  { re: /\bsecret\b/i, reason: "secret 密钥" },
  { re: /\bpass(word|wd)?\b/i, reason: "口令/密码" },
  { re: /\bprivate\s+key\b/i, reason: "私钥" },
  { re: /id_rsa|id_ed25519|id_ecdsa/i, reason: "SSH 私钥文件" },
  { re: /\.ssh[\\/]/i, reason: "SSH 配置目录" },
  { re: /\.env\b/i, reason: "环境变量文件（常含密钥）" },
  { re: /\bcredentials?\b/i, reason: "凭据" },
  { re: /\btokens?\b/i, reason: "访问令牌" },
  { re: /(密钥|密码|口令|私钥|令牌)/i, reason: "敏感凭证" },
  { re: /auth\.json|models-store\.json/i, reason: "凭据存储文件" },
  { re: /(银行卡|身份证|手机号|手机号码|社保卡)/i, reason: "个人敏感信息" },
  { re: /webhook.*(secret|token|url)/i, reason: "Webhook 密钥" },
];

/** 否定语境（"不要读取"等）前瞻前缀：避免否定句被误判为取值意图/读取动词 */
const NEGATION_LB =
  "(?<!不要)(?<!别)(?<!禁止)(?<!请勿)(?<!无需)(?<!不需要)(?<!避免)(?<!拒绝)(?<!不能)(?<!不可)";

/**
 * 取值意图（明确要求读取/返回真实私密值，而非结构/格式调研）。
 * 命中即按 sensitive 拦截，即使同时存在配置结构上下文。
 */
const VALUE_ACCESS_PATTERNS: RegExp[] = [
  /(具体值|实际值|当前值|真实值|明文|原文|全部值|具体内容)/,
  // 动词 + 值/内容（"取值范围/值类型/值格式/默认值/示例值"等结构语义通过前后断言排除）
  new RegExp(
    `${NEGATION_LB}(读取|查看|获取|查询|输出|返回|打印|导出|显示|cat\\s|less\\s|more\\s|head\\s|tail\\s).{0,16}((?<!默认)(?<!示例)(?<!样例)(?<!缺省)(?<!可选)(?<!可能)值(?!范围|类型|格式|列表|枚举|集合|示例|样例)|内容|原文|明文)`,
    "i",
  ),
  new RegExp(
    `${NEGATION_LB}((?<!默认)(?<!示例)(?<!样例)(?<!缺省)(?<!可选)(?<!可能)值(?!范围|类型|格式|列表|枚举|集合|示例|样例)|内容|原文|明文).{0,16}(读取|查看|获取|查询|输出|返回|打印|导出|显示|给我)`,
    "i",
  ),
  new RegExp(`${NEGATION_LB}(把|将).{0,24}(打印|输出|返回|导出)`, "i"),
  /(dump|dumps?|print|export|read|cat|show|display|grep).{0,16}(value|content|plaintext|secret|password|token|credential)/i,
  /(value|content|plaintext|secret|password|token|credential)s?.{0,16}(dump|print|export|read|show|display)/i,
];

/**
 * 剔除"不写真实值 / 不要读取任何值 / 不含明文"等否定取值短语，
 * 避免把否定句误判为取值意图（issue #4 误判来源之一：配置模板类任务常写"不写真实值"）。
 */
function stripNegatedValueAccess(text: string): string {
  return text.replace(
    /(不|非|别|不要|无需|不需要|禁止|请勿|避免|拒绝|不能|不可|勿|未)[^，。；,;、\n]{0,16}(真实值|实际值|当前值|具体值|明文|原文|全部值|值|内容)/g,
    " ",
  );
}

/** 读取/返回类动作动词（带否定语境检测："不要读取"不判为敏感意图） */
const READ_VERBS =
  /(?<!不要)(?<!别)(?<!禁止)(?<!请勿)(?<!无需)(?<!不需要)(?<!避免)(?<!拒绝)(?<!不能)(?<!不可)(读取|读|查看|显示|展示|输出|返回|给我|导出|打印|打开|获取|查询|cat\s|less\s|more\s|head\s|tail\s)/i;

/**
 * 配置结构/格式/字段调研上下文标记。
 * 命中表示任务意图是"看配置长什么样"（格式/结构/字段名/模板/文档/示例），
 * 而非"拿真实值"。此时敏感词提及降级为 warning（放行但提示），不直接拦截。
 */
const CONFIG_STRUCTURE_PATTERNS: RegExp[] = [
  // 配置 + 结构类词
  /配置\s*(格式|结构|模板|示例|样例|规范|文档|说明|手册|字段|参数|项|方式|方法|写法|语法|取值|枚举)/,
  // 结构类词（任意位置）
  /(格式|结构|模板|示例|样例|规范|文档|说明|手册|字段|参数|语法|写法|用法|定义|占位符|取值范围|取值|枚举|默认值|示例值|样例值|缺省值|可选值|如何配置|怎么配置|配置方式|配置方法)/,
  // 英文结构类词
  /\b(schema|format|template|example|sample|spec|specification|documentation|placeholder|field|fields|structure|syntax|enum|enumeration|layout|how to configure)\b/i,
];

/**
 * 配置类任务放行白名单（issue #4 建议 c）。
 * 命中这些已知配置文件名/配置系统的上下文，且无取值意图时，视为配置调研放行。
 * 可通过环境变量 CIRCLE_SAFETY_WHITELIST 追加关键词（逗号分隔，按字面包含匹配）。
 */
export const CONFIG_TASK_WHITELIST: RegExp[] = [
  /(nginx\.conf|redis\.conf|sshd_config|docker-compose|dockerfile|configmap|prometheus|grafana|kubernetes|k8s|gitlab-ci|jenkins|traefik|envoy|haproxy|kong|systemd)/i,
];

let envWhitelist: RegExp[] | undefined;
function loadEnvWhitelist(): RegExp[] {
  if (envWhitelist) return envWhitelist;
  const raw = process.env.CIRCLE_SAFETY_WHITELIST ?? "";
  envWhitelist = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((k) => new RegExp(escapeRegExp(k), "i"));
  return envWhitelist;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 是否明确要求读取/返回真实值（先剔除否定取值短语） */
function hasValueExtractionIntent(text: string): boolean {
  const normalized = stripNegatedValueAccess(text);
  return VALUE_ACCESS_PATTERNS.some((re) => re.test(normalized));
}

/** 是否属于配置结构/格式/字段调研上下文（含白名单） */
function hasConfigStructureIntent(text: string): boolean {
  if (CONFIG_STRUCTURE_PATTERNS.some((re) => re.test(text))) return true;
  if (CONFIG_TASK_WHITELIST.some((re) => re.test(text))) return true;
  return loadEnvWhitelist().some((re) => re.test(text));
}

/**
 * 对请求文本做安全评估。
 * 优先级：破坏性 > 敏感信息（取值意图/读取动词） > 配置结构放行（warning） > 安全。
 */
export function assessSafety(text: string): SafetyVerdict {
  const destructiveReasons: string[] = [];
  for (const { re, reason } of DESTRUCTIVE_PATTERNS) {
    if (re.test(text)) destructiveReasons.push(`破坏性操作: ${reason}`);
  }
  if (destructiveReasons.length > 0) {
    return { risk: "destructive", reasons: destructiveReasons.slice(0, 3) };
  }

  const sensitiveReasons: string[] = [];
  const configCautionReasons: string[] = [];
  const valueExtraction = hasValueExtractionIntent(text);
  const configStructure = hasConfigStructureIntent(text);

  for (const { re, reason } of SENSITIVE_PATTERNS) {
    if (!re.test(text)) continue;
    if (valueExtraction) {
      // 明确要求取值 → 拦截
      sensitiveReasons.push(`敏感信息: ${reason}`);
    } else if (configStructure) {
      // 配置结构/格式/字段调研 → 放行但提示（降级，不拦截）
      configCautionReasons.push(reason);
    } else if (READ_VERBS.test(text)) {
      // 字面敏感词 + 读取动词（无结构上下文）→ 拦截
      sensitiveReasons.push(`敏感信息: ${reason}`);
    }
  }

  if (sensitiveReasons.length > 0) {
    return { risk: "sensitive", reasons: sensitiveReasons.slice(0, 3) };
  }
  if (configCautionReasons.length > 0) {
    return {
      risk: "warning",
      reasons: configCautionReasons
        .slice(0, 3)
        .map((r) => `配置结构类上下文已放行（仅限结构/格式/字段，禁止读取真实值）: ${r}`),
    };
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

export const WARNING_CONFIG_STRUCTURE =
  "⚠️ 安全提示：该请求提及敏感字段（token/secret/密码/私钥等），但上下文为配置结构/格式/字段调研，已放行。\n" +
  "仅允许处理配置结构、格式、字段名与示例，禁止读取或返回任何真实私密值。";
