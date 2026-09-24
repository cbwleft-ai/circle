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
export CIRCLE_MODEL_ID=deepseek-flash # 默认 deepseek-flash
```

> 模型注册信息（baseUrl、compat 等）可放在 `CIRCLE_AGENT_DIR/models.json` 中，
> 本项目已针对 DeepSeek V4.1 Flash（`deepseek-flash`）内置了 provider 配置。
> 该模型原生支持图片输入（vision），多模态无需额外注册视觉模型。

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

一次性任务（issue #49）——只触发一次、触发后自动停用：

```
你：明天上午 9 点提醒我提交材料。
Coordinator：定时任务创建成功：S-XXX「提交材料提醒」，触发时间 2026-9-14 09:00，Worker: default。

你：查询定时任务
Coordinator：⏰ S-XXX 提交材料提醒（一次性: 2026-9-14 09:00，Worker: default，待触发，已触发 0 次）…
```

> 周期性任务用 `cron`（5 段表达式），一次性任务用 `at`（本地时间 `YYYY-MM-DD HH:mm`），二者二选一。
> 一次性任务触发一次后自动停用（状态变「已触发」）；若进程宕机错过触发时刻，宽限期内
> （默认 10 分钟，`CIRCLE_ONCE_GRACE_MS` 可调）补触发一次，超期标记“已错过”不再执行。

> 时区：定时任务与系统时间注入均按【进程本地时区】解释（`0 9 * * *` = 本地 09:00）。
> 可用 `TZ=Asia/Shanghai npm start` 或 `CIRCLE_TZ=Asia/Shanghai ./scripts/circle.sh restart` 显式指定；
> 启动日志会打印当前时区，UTC 环境会提示偏差风险。日志时间戳同样为本地时区（带偏移）。

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

## 6. 接入飞书（issue #54）

1. 在飞书开放平台创建**自建应用**，开通机器人能力与事件订阅（`im.message.receive_v1`）；
2. 申请权限：读取/发送消息与下载图片（如 `im:message`、`im:resource`，以开放平台为准）；
   全量接收群消息（`im:message.group_msg`）为敏感权限，首版**仅响应 @bot 的消息**：
   未配置 `CIRCLE_FEISHU_BOT_OPEN_ID` 时由平台默认只推送 @ 消息；开启全量后适配器会按 @ 过滤；
3. 接入方式由 `CIRCLE_FEISHU_MODE` 决定：
   - `ws`（默认，推荐）：WebSocket 长连接，**无需公网入口/反向代理**，也无需 Verification Token 与 Encrypt Key；
     在开放平台「事件与回调」中选择「长连接」即可（目前仅自建应用支持）；
   - `webhook`：事件订阅选择「将事件发送至开发者服务器」，地址填
     `http://<host>:<CIRCLE_FEISHU_PORT><CIRCLE_FEISHU_EVENT_PATH>`，需要公网可达或反向代理；
     如启用了加密，设置 `CIRCLE_FEISHU_ENCRYPT_KEY` 与 `CIRCLE_FEISHU_VERIFICATION_TOKEN`；
4. 配置应用凭据（三选一，优先级：环境变量 > 凭据文件 > 引导式配置）：

   - **引导式配置（推荐）**：凭据缺失时启动会提示输入 App ID / App Secret，
     输入后立即调用飞书接口校验，**校验通过才写入密钥文件**，无需手工编辑任何文件：

     ```bash
     export CIRCLE_IM_ADAPTER=feishu
     npm start
     ```

     更换或轮换凭据：`npm run setup:feishu`

   - **写入密钥文件**（服务器等无交互终端场景）：

     ```bash
     mkdir -p ~/.circle/secrets && chmod 700 ~/.circle/secrets
     cat > ~/.circle/secrets/feishu.json <<'EOF'
     { "appId": "cli_xxx", "appSecret": "xxx" }
     EOF
     chmod 600 ~/.circle/secrets/feishu.json
     ```

   - **环境变量**（仅建议 CI / 临时调试）：环境变量会被 Worker 子进程继承
     （子进程执行 `printenv` 即可读到），不适合长期存放飞书凭据：

     ```bash
     export CIRCLE_IM_ADAPTER=feishu
     export CIRCLE_FEISHU_APP_ID=cli_xxx
     export CIRCLE_FEISHU_APP_SECRET=xxx
     npm start
     ```

   凭据文件默认位于 `~/.circle/secrets/feishu.json`（目录 0700、文件 0600），
   可用 `CIRCLE_SECRETS_DIR` 改到别处；`webhook` 模式的 Verification Token / Encrypt Key
   也会一并保存在该文件中（见 `src/im/feishu-auth.ts`）。

### 会话与话题

- 私聊/群聊统一映射为 `fs:<chat_id>`；话题/回复串的会话键为 `fs:<chat_id>:<root_id>`，
  各话题上下文互相隔离（见 #53）：
  - `root_id`（优先）或 `thread_id` 作为 threadKey；同一话题共享一个 Coordinator 会话；
  - 话题内的回复经 `message.reply + reply_in_thread` 落回原话题；长任务完成后的汇报同样回原话题；
  - 群聊内连续消息与图片按 `(会话, 发送者)` 分片，不跨人合并/错配；
- 话题首次唤醒目前只带当前消息，**不注入话题历史与群历史**（后续增强见 #54「待实测确认」）；
- 文件/图片附件发送（issue #65）：产出物先上传 `im/v1/images`（得 `image_key`）或
  `im/v1/files`（得 `file_key`），再发 `image`/`file` 消息；话题场景同样走 `reply + reply_in_thread`；
  图片上限约 10MB（超出按文件发送）、文件上限约 30MB，超限或上传失败时自动降级为文本 + 路径提示。

### 富文本（Markdown）

- **下行**：适配器将回复统一以富文本 `post` + `md` 标签发送，由飞书客户端原生渲染
  CommonMark 0.31 + GFM——标题、加粗、斜体、列表（含嵌套/任务列表）、代码块与行内代码、
  引用、表格、分割线、超链接等；无需本地转换 Markdown。
- **超长内容**：单条富文本体积上限 30KB，超限时按行自动分片，
  若切在代码围栏内会自动补全闭合围栏并在下片重开，保证每片语法完整。
- **降级**：富文本发送失败（如内容不合法）时自动降级为纯文本重试并记录日志，不丢失信息。
- **上行**：用户发送的富文本 `post` 消息优先读取 `content_v2` 中的 `md` 标签还原原始 Markdown，
  否则回退解析 `content` 的段落标签（文本/链接/@/代码块/图片等）；
  飞书当前不支持 Setext 标题、缩进代码块、raw HTML 与邮箱自动链接（见开放平台文档）。

## 7. 环境变量总表

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CIRCLE_DATA_DIR` | `~/.circle/data` | 数据目录（任务/定时任务/工作空间/微信账户/日志） |
| `CIRCLE_SECRETS_DIR` | `~/.circle/secrets` | 密钥目录（飞书凭据 `feishu.json`，目录 0700 / 文件 0600） |
| `CIRCLE_AGENT_DIR` | `~/.pi/agent` | pi 配置目录（模型/凭据） |
| `CIRCLE_MODEL_PROVIDER` | `deepseek` | 模型 provider |
| `CIRCLE_MODEL_ID` | `deepseek-flash` | 模型 id |
| `CIRCLE_COORDINATOR_THINKING` | `low` | Coordinator 思考级别 |
| `CIRCLE_WORKER_THINKING` | `high` | Worker 思考级别 |
| `CIRCLE_LONG_TASK_SEC` | `10` | 长程任务判定阈值（秒） |
| `CIRCLE_STATUS_CHECK_INTERVAL` | `5` | Coordinator 每 N 轮检查待办任务 |
| `CIRCLE_MESSAGE_MERGE_MS` | `1500` | 附件消息合并窗口（毫秒）：收到图片/文件后，窗口内的后续消息合并为一批，Coordinator 只回复一次；纯文本消息零延迟；`0` = 关闭合并 |
| `CIRCLE_SCHEDULER_TICK_MS` | `30000` | Scheduler tick 间隔（毫秒） |
| `CIRCLE_ONCE_GRACE_MS` | `600000` | 一次性任务错过触发后的补触发宽限期（毫秒）：宽限期内补触发一次，超期标记“已错过”不再执行 |
| `CIRCLE_CLEANUP_AFTER_DAYS` | `30` | 已完成任务保留天数 |
| `CIRCLE_CLEANUP_CRON` | `0 3 * * *` | 每日清理时间 |
| `CIRCLE_TASK_TIMEOUT_MS` | `1800000` | 单任务执行超时（毫秒） |
| `CIRCLE_DEFAULT_CHAT_ID` | `console` | 无归属的旧任务/定时任务回流使用的默认会话 |
| `CIRCLE_IM_ADAPTER` | `console` | `console` / `http` / `weixin`（官方）/ `feishu`（飞书）/ `wechat`（wechaty 旧方案） |
| `CIRCLE_HTTP_PORT` | `8787` | HTTP 适配器端口 |
| `CIRCLE_WEIXIN_BOT_TOKEN` | - | 微信官方通道：直接指定 bot token（跳过扫码） |
| `CIRCLE_WEIXIN_BASE_URL` | 官方地址 | 微信官方通道 API 地址 |
| `CIRCLE_WEIXIN_BOT_TYPE` | `3` | 微信官方通道 bot 类型 |
| `CIRCLE_FEISHU_APP_ID` / `CIRCLE_FEISHU_APP_SECRET` | - | 飞书自建应用凭据；仅作临时覆盖，推荐 `npm run setup:feishu` 写入密钥文件 |
| `CIRCLE_FEISHU_VERIFICATION_TOKEN` | - | 飞书事件订阅 Verification Token |
| `CIRCLE_FEISHU_ENCRYPT_KEY` | - | 飞书事件 Encrypt Key（配置后按 AES-256-CBC 解密事件体） |
| `CIRCLE_FEISHU_PORT` | `8788` | 飞书 webhook 监听端口 |
| `CIRCLE_FEISHU_EVENT_PATH` | `/feishu/events` | 飞书 webhook 事件路径 |
| `CIRCLE_FEISHU_BOT_OPEN_ID` | - | bot 自身 open_id（用于 @ 过滤与剔除；留空启动时自动获取） |
| `CIRCLE_FEISHU_BASE_URL` | `https://open.feishu.cn` | 飞书 API 地址（私有化/测试可覆盖） |
| `CIRCLE_FEISHU_MODE` | `ws` | 接入方式：`ws`=WebSocket 长连接（免公网入口）；`webhook`=事件订阅回调 |
| `CIRCLE_WORKERS` | - | Worker 配置 JSON 数组（见下） |
| `WECHAT_PUPPET` / `WECHAT_PUPPET_TOKEN` / `WECHAT_ALLOW_CONTACTS` | - | 微信适配器配置 |
| `CIRCLE_LOG_LEVEL` | `info` | 日志级别 debug/info/warn/error |
| `CIRCLE_TZ` | 系统时区 | 仅 `scripts/circle.sh` 使用：导出为 `TZ`（影响系统时间注入与 cron 解释）。UTC 容器部署建议设为 `Asia/Shanghai` |

## 8. 配置多个 Worker

```bash
export CIRCLE_WORKERS='[
  {"name":"dev","description":"负责开发与脚本任务","cwd":"/data/ws/dev"},
  {"name":"data","description":"负责数据处理与分析任务","cwd":"/data/ws/data","skills":["/data/ws/data/skills/data-analysis.md"]}
]'
npm start
```

每个 Worker 独立工作环境（工作目录 + 技能），互不影响；产出物输出到各自工作目录。
技能也可直接放在工作目录 `.pi/skills/` 下（自动发现）。

## 9. 数据与产出物

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
> （getuploadurl → AES-128-ECB 加密 → CDN → sendmessage）；
> 飞书通道支持图片（`image` 消息，约 10MB）与文件（`file` 消息，约 30MB），
> 走 `im/v1/images` / `im/v1/files` 上传后发消息（见 #65）。

## 10. 连续消息合并（照片 + 描述 → 一条回复）

用户在微信中常**先发一张照片、再补一句描述**（如「看下这张截图里的报错」）。若每条消息
各自触发一轮 Coordinator 回复，会产生多条割裂的回复。

Circle 在团队入口（`AgentTeam.handleUserMessage`，对所有 IM 通道统一生效）内置
**附件触发的合并窗口（debounce）**：

- **只有携带附件（图片/文件）的消息才启动合并窗口**（`CIRCLE_MESSAGE_MERGE_MS`，
  默认 `1500`ms）；窗口内到达的后续消息（描述文本、更多图片）归为同一批；
- 窗口到期后把多条消息**合并为一条**（文本按到达顺序换行拼接、附件全部保留），
  Coordinator 只处理一轮、只回复一条；
- **纯文本消息零延迟**：无待合并批次时立即逐条处理，不等待窗口——日常文字对话
  回复不受任何影响；只有发图后的第一轮可能等待至多一个窗口；
- 不同会话互不干扰；窗口内新消息到达会重置定时器（真正的突发消息不会拆开）；
- 合并发生在**安全评估之前**，合并后的完整文本统一过安全拦截，不存在绕过风险；
- 关闭合并：`export CIRCLE_MESSAGE_MERGE_MS=0`（所有消息立即逐条处理）。

> 注意：附件消息的回复会等待至多一个窗口（等可能跟随的描述）；若描述先发、照片后发，
> 描述会先被立即回复，照片再独立处理（建议照片在前）。窗口大小可调小以降低等待。
> 实现见 `src/core/message-merge.ts`（纯函数 `mergeMessages` + `MessageMerger`，可独立测试）。
