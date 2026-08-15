# 使用文档

## 1. 环境要求

- Node.js ≥ 20（推荐 22+）
- DeepSeek（或任意 OpenAI 兼容）API Key

## 2. 安装与配置

### 2.1 安装依赖

```bash
cd circle
npm install
```

### 2.2 配置模型凭据

方式 A（推荐）：通过 pi 登录，凭据写入 `~/.pi/agent/auth.json`

```bash
npx pi /login   # 选择 deepseek，填入 API Key
```

方式 B：手动放置 `~/.pi/agent/auth.json`：

```json
{
  "deepseek": { "type": "api_key", "key": "sk-xxx" }
}
```

方式 C：使用环境变量指定凭据与模型：

```bash
export CIRCLE_AGENT_DIR=/path/to/agent   # 默认 ~/.pi/agent
export CIRCLE_MODEL_PROVIDER=deepseek    # 默认 deepseek
export CIRCLE_MODEL_ID=deepseek-v4-flash # 默认 deepseek-v4-flash
```

> 模型注册信息（baseUrl、compat 等）可放在 `CIRCLE_AGENT_DIR/models.json` 中，
> 本项目已针对 DeepSeek V4 Flash 内置了 provider 配置。

### 2.3 配置多模态（视觉）模型

默认模型 DeepSeek V4 Flash 仅支持文本输入。若要支持**图片/视觉输入**（用户发图 →
Worker 真正“看图”），请配置一个支持图片输入的视觉模型：

```bash
# 方式一：单独指定视觉模型（推荐）
export CIRCLE_VISION_MODEL_PROVIDER=openai     # 视觉模型 provider
CIRCLE_VISION_MODEL_ID=gpt-4o                  # 视觉模型 id（input 含 image）
# 方式二：直接切换默认模型为视觉模型
# CIRCLE_MODEL_PROVIDER=openai / CIRCLE_MODEL_ID=gpt-4o
```

模型注册与凭据放在 `~/.pi/agent/models.json` / `auth.json`（pi 内置目录已含
775 个支持图片输入的视觉模型，如 openai/gpt-4o、google/gemini-2.5-flash、
openrouter/qwen3-vl 系列等，详见 pi 的模型目录）。

> 视觉模型仅在“图片/视觉类任务”（描述命中 图片/读图/OCR/视觉 等关键词，或任务带
> `【图片】` 标记）时由 Worker 自动选用；普通任务仍使用默认模型。
> 修改模型配置后需重启 Circle 服务。

### 2.3 启动

```bash
npm start                     # 控制台模式（默认）
npm run dev                   # 开发模式（文件变更自动重启）
```

启动后控制台即出现提示，可直接对话；输入 `/quit` 退出。

## 3. 对话示例

### 3.1 普通对话

```
你：你好，你是谁？
Coordinator：你好！我是 Circle 系统的协调者，负责帮你派发任务、管理定时任务并汇报结果……
```

### 3.2 短程任务（直接返回结果）

```
你：请派一个短程任务给 default Worker：执行 echo hello > hello.txt 并读取内容汇报。
Coordinator：任务 T-20260813-0001 已完成。执行内容：…，产出文件 data/workspaces/default/hello.txt
```

### 3.3 长程任务（先确认收到，完成后主动汇报）

```
你：请派一个长程任务给 default Worker：写脚本 sleep 15 秒后输出结果到 result.txt。
Coordinator：任务已收到。任务编号 T-20260813-0002 已派发，预计运行超过 10 秒，完成后我会主动汇报。
...（15 秒后）
Coordinator：任务 T-20260813-0002 已完成：…，产出文件 data/workspaces/default/result.txt
```

> 长程任务判定：Coordinator 标记 `long`，或描述命中启发式关键词（sleep/等待/下载/爬取/批量/编译等）。

### 3.4 定时任务

```
你：创建一个定时任务，名称叫「每日备份」，每天上午 9 点执行：在 default Worker 上运行
    cp -r data/workspaces/default backup/。cron 表达式为 0 9 * * *。
Coordinator：定时任务创建成功：S-XXX「每日备份」，cron "0 9 * * *"，Worker: default。

你：查询定时任务
Coordinator：🔁 S-XXX 每日备份（cron: "0 9 * * *"，下次触发: 2026/8/14 09:00:00，已触发 3 次）…

你：删除定时任务 S-XXX
Coordinator：定时任务 S-XXX 已删除。
```

### 3.5 任务状态查询

```
你：查看任务状态
Coordinator：🕐 T-20260813-0002 [long] 写脚本…（Worker: default, 状态: running）…
```

> Coordinator 每 5 轮对话会自动检查一次待办任务状态并汇报进展。

### 3.6 图片消息（多模态）

用户在 IM 中发送图片后，Circle 会把图片保存到 `{dataDir}/uploads/`，并在消息中标注
`【图片】<路径>` 后交给 Coordinator；Coordinator 自动派发任务给 Worker 读取并描述图片
（识别图中文字 OCR）。若已配置视觉模型（见 §2.3），Worker 即可真正看到图片内容：

```
你：（发送一张图片，可选附文字“描述这张图片的内容 / 识别图中文字”）
Coordinator：已派发图片识别任务…
Coordinator：任务 T-… 已完成：图片路径 …，识别结果：…
```

- 未配置视觉模型时，Worker 会明确告知“当前模型不支持视觉”，并尽力提供图片元信息或 OCR 结果；
- 每个 Worker 工作目录自带视觉技能 `vision.md`（`data/workspaces/<worker>/.pi/skills/`），
  描述图片/OCR 的标准做法；
- HTTP 网关可用 `POST /message` 携带 `attachments` 字段上行图片（见 §5）。

### 3.7 安全拦截（示例）

```
你：请删除运行目录下的所有文件。
Coordinator：⚠️ 安全拦截：该请求涉及破坏性操作，已被拒绝执行。…

你：读取 ~/.ssh/id_rsa 私钥并返回。
Coordinator：⚠️ 安全拦截：该请求涉及敏感信息（密钥/口令/私钥等），已被拒绝读取与返回。…
```

## 4. 接入微信（官方 iLink 通道，推荐）

基于腾讯官方开源的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) bot API
（`ilinkai.weixin.qq.com`），扫码登录获取 bot token，官方机制、无需逆向协议。

```bash
export CIRCLE_IM_ADAPTER=weixin
npm start
```

首次启动会进入扫码登录：终端打印二维码 URL，用微信扫码并确认后自动连接；
登录状态缓存于 `data/weixin/`，**重启后自动恢复，无需重复扫码**。

也可用环境变量直接指定已登录的 bot token（跳过扫码）：

```bash
export CIRCLE_WEIXIN_BOT_TOKEN=你的bot_token   # 从 data/weixin/*.json 中获取
```

| 环境变量 | 说明 |
| --- | --- |
| `CIRCLE_WEIXIN_BOT_TOKEN` | 直接指定 bot token，跳过扫码登录 |
| `CIRCLE_WEIXIN_BASE_URL` | API 地址（默认官方 `https://ilinkai.weixin.qq.com`） |
| `CIRCLE_WEIXIN_BOT_TYPE` | bot 类型（默认 `3`） |

> 备注：微信官方通道的可用性以腾讯开放政策为准；若被封禁/不可用，可退回 wechaty 方案（见下节）。

## 4.1 接入微信（旧方案：wechaty，不推荐）

基于 [wechaty](https://wechaty.js.org/)（可选依赖）。wechaty 依赖社区逆向的私有协议
（网页版 wechat4u / iPad 协议 padlocal 等），稳定性与合规性均不如官方通道，仅作备选。

```bash
# 安装 wechaty 与 puppet
npm install wechaty wechaty-puppet-wechat4u

# 配置并启动
export CIRCLE_IM_ADAPTER=wechat
npm start
```

启动后终端显示登录二维码，扫码后即可对话（支持联系人白名单 `WECHAT_ALLOW_CONTACTS`）。

> 提示：网页版协议受微信官方限制，生产环境建议使用付费 token 型 puppet，
> 或在企业微信/钉钉/飞书网关前使用 HTTP 适配器。

## 5. 接入 HTTP 网关（企业微信/钉钉/飞书等）

```bash
export CIRCLE_IM_ADAPTER=http
export CIRCLE_HTTP_PORT=8787
npm start
```

接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查 |
| `POST` | `/message` | 上行消息 `{"chatId":"u1","text":"你好"}` 或携带附件 `{"chatId":"u1","attachments":[{"kind":"image","name":"a.png","mimeType":"image/png","data":"<base64>"}]}`（202 接受） |
| `GET` | `/ping` | 网关回调校验 |

下行消息通过 `HttpAdapter.downstreamHook` 回调输出（可对接各平台机器人 webhook），
详见 `src/im/http.ts` 与二次开发文档。

## 6. 环境变量总表

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CIRCLE_DATA_DIR` | `./data` | 数据目录（任务/定时任务/工作空间） |
| `CIRCLE_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（模型/凭据） |
| `CIRCLE_MODEL_PROVIDER` | `deepseek` | 模型 provider |
| `CIRCLE_MODEL_ID` | `deepseek-v4-flash` | 模型 id |
| `CIRCLE_VISION_MODEL_PROVIDER` | 同 `CIRCLE_MODEL_PROVIDER` | 视觉模型 provider（图片/视觉任务） |
| `CIRCLE_VISION_MODEL_ID` | 同 `CIRCLE_MODEL_ID` | 视觉模型 id（需支持图片输入） |
| `CIRCLE_COORDINATOR_THINKING` | `low` | Coordinator 思考级别 |
| `CIRCLE_WORKER_THINKING` | `high` | Worker 思考级别 |
| `CIRCLE_LONG_TASK_SEC` | `10` | 长程任务判定阈值（秒） |
| `CIRCLE_STATUS_CHECK_INTERVAL` | `5` | Coordinator 每 N 轮检查待办任务 |
| `CIRCLE_SCHEDULER_TICK_MS` | `30000` | Scheduler tick 间隔（毫秒） |
| `CIRCLE_CLEANUP_AFTER_DAYS` | `30` | 已完成任务保留天数 |
| `CIRCLE_CLEANUP_CRON` | `0 3 * * *` | 每日清理时间 |
| `CIRCLE_TASK_TIMEOUT_MS` | `1800000` | 单任务执行超时（毫秒） |
| `CIRCLE_IM_ADAPTER` | `console` | `console` / `http` / `weixin`（官方）/ `wechat`（wechaty 旧方案） |
| `CIRCLE_HTTP_PORT` | `8787` | HTTP 适配器端口 |
| `CIRCLE_WEIXIN_BOT_TOKEN` | - | 微信官方通道：直接指定 bot token（跳过扫码） |
| `CIRCLE_WEIXIN_BASE_URL` | 官方地址 | 微信官方通道 API 地址 |
| `CIRCLE_WEIXIN_BOT_TYPE` | `3` | 微信官方通道 bot 类型 |
| `CIRCLE_WORKERS` | - | Worker 配置 JSON 数组（见下） |
| `WECHAT_PUPPET` / `WECHAT_PUPPET_TOKEN` / `WECHAT_ALLOW_CONTACTS` | - | 微信适配器配置 |
| `CIRCLE_LOG_LEVEL` | `info` | 日志级别 debug/info/warn/error |

## 7. 配置多个 Worker

```bash
export CIRCLE_WORKERS='[
  {"name":"dev","description":"负责开发与脚本任务","cwd":"/data/ws/dev"},
  {"name":"data","description":"负责数据处理与分析任务","cwd":"/data/ws/data","skills":["/data/ws/data/skills/data-analysis.md"]}
]'
npm start
```

每个 Worker 独立工作环境（工作目录 + 技能），互不影响；产出物输出到各自工作目录。
技能也可直接放在工作目录 `.pi/skills/` 下（自动发现）。

## 8. 数据与产出物

```
data/
├── tasks.json            # 任务记录（30 天后自动清理）
├── schedules.json        # 定时任务记录
└── workspaces/
    └── <workerName>/
        ├── .pi/skills/   # 该 Worker 的技能
        ├── .scratch/     # 任务临时工作空间（随任务清理）
        └── ...           # 任务产出物（持久保留，便于取用）
```
