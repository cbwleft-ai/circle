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

### 3.6 安全拦截（示例）

```
你：请删除运行目录下的所有文件。
Coordinator：⚠️ 安全拦截：该请求涉及破坏性操作，已被拒绝执行。…

你：读取 ~/.ssh/id_rsa 私钥并返回。
Coordinator：⚠️ 安全拦截：该请求涉及敏感信息（密钥/口令/私钥等），已被拒绝读取与返回。…
```

## 4. 接入微信（官方 iLink 通道，推荐）

基于腾讯官方开源的 [openclaw-weixin](https://github.com/Tencent/openclaw-weixin) bot API
（`ilinkai.weixin.qq.com`），扫码登录获取 bot token，官方机制、无需逆向协议。

### 4.0 一键启动脚本（推荐）

项目自带服务管理脚本 `scripts/circle.sh`，固化微信适配器与数据目录配置，
通过 nohup 后台运行 + flock 单实例锁托管（**不依赖 systemd**，兼容不支持
systemctl 用户服务的目标环境；同一数据目录同时最多一个 Circle 实例，
重复 `start` 会被单实例锁拒绝）：

```bash
./scripts/circle.sh start      # 启动（IM=weixin，数据目录 ~/.circle/data）
./scripts/circle.sh restart    # 重启（修改代码后常用）
./scripts/circle.sh stop       # 停止
./scripts/circle.sh status     # 查看服务状态
./scripts/circle.sh logs -f    # 跟随查看运行日志
./scripts/circle.sh log-file   # 打印数据目录日志文件路径
```

日志统一写入 `~/.circle/data/logs/circle.log`（按天轮转，结构化主日志）；
启动早期输出（nohup stdout/stderr）在 `logs/startup.log`。
也可手动启动（等价于脚本 start 的行为，注意手动启动同样受单实例锁保护）：

```bash
export CIRCLE_IM_ADAPTER=weixin
export CIRCLE_DATA_DIR=~/.circle/data
export CIRCLE_AGENT_DIR=~/.pi/agent
npm start
```

首次启动会进入扫码登录：终端打印二维码 URL，用微信扫码并确认后自动连接；
登录状态缓存于 `~/.circle/data/weixin/`，**重启后自动恢复，无需重复扫码**。

也可用环境变量直接指定已登录的 bot token（跳过扫码）：

```bash
export CIRCLE_WEIXIN_BOT_TOKEN=你的bot_token   # 从 ~/.circle/data/weixin/*.json 中获取
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
| `POST` | `/message` | 上行消息 `{"chatId":"u1","text":"你好"}`（202 接受） |
| `GET` | `/ping` | 网关回调校验 |

下行消息通过 `HttpAdapter.downstreamHook` 回调输出（可对接各平台机器人 webhook），
详见 `src/im/http.ts` 与二次开发文档。

## 6. 环境变量总表

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CIRCLE_DATA_DIR` | `~/.circle/data` | 数据目录（任务/定时任务/工作空间/微信账户/日志） |
| `CIRCLE_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（模型/凭据） |
| `CIRCLE_MODEL_PROVIDER` | `deepseek` | 模型 provider |
| `CIRCLE_MODEL_ID` | `deepseek-v4-flash` | 模型 id |
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
        ├── .pi/skills/   # 该 Worker 的技能（自动发现）
        ├── tasks/        # 任务工作空间（每任务独立，随任务清理）
        │   └── <taskId>/ #   会话 cwd，任务间完全隔离
        │       ├── .pi/skills       → 软链接到上方技能目录（Worker 技能）
        │       └── .pi/agent-skills → 软链接到 ~/.pi/agent/skills（用户级技能）
        └── outputs/      # 产出物归档（按任务隔离，持久保留，不含技能链接）
            └── <taskId>/
```

### 8.1 Coordinator 直接读取完整产物（issue #21）

长程任务的汇报结果默认是「摘要」（长文本头尾保留、中间省略），完整结果与 Worker 实际产物
**始终落盘**：完整结果存于 `tasks.json`（`Task.result`），产出文件归档于 `outputs/<taskId>/`
（失败任务保留在 `tasks/<taskId>/` 便于排查）。

当需要核对完整报告、原始数据、日志时，直接告诉 Coordinator 即可，它会调用：

| 工具 | 作用 |
| --- | --- |
| `task_result` | 读取任务完整执行结果（未截断的原文） |
| `list_artifacts` | 查看产出物文件清单（路径 + 大小） |
| `read_artifact` | 读取指定产出物文件内容（只读） |
| `send_artifact` | 把产出物文件**直接发送给用户**（附件，如报告/图片/数据文件） |

示例对话：

```
你：把上次 T-20250817-0001 任务的完整报告读给我，重点看结尾结论。
Coordinator：（调用 task_result / list_artifacts / read_artifact 后汇报）

你：把这份报告的 md 文件直接发给我。
Coordinator：（调用 send_artifact 后）已发送：report.md ✓
```

> 安全约束：以上工具**只读**且**路径受限**——只能访问任务产出物目录（`outputs/<taskId>/` 或
> `tasks/<taskId>/`）内的文件；拒绝绝对路径与 `../` 目录穿越，不跟随符号链接，
> 二进制文件拒绝返回，单文件最多返回约 20KB（超长保留头尾并标注）。
> `send_artifact` 额外受 **20MB 大小上限**约束；当前 IM 通道不支持文件发送时
> 自动降级为文字提示（附文件名/大小/产出物路径），不阻塞主流程。
> 微信 iLink 通道支持文件（type 4）与图片（type 2）消息，走官方上传链路
> （getuploadurl → AES-128-ECB 加密 → CDN → sendmessage）。
