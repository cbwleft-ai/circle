#!/usr/bin/env bash
#
# Circle 服务管理脚本（默认微信 iLink 适配器）
#
# 用法:
#   ./scripts/circle.sh start          # 启动（nohup 后台运行）
#   ./scripts/circle.sh stop           # 停止（SIGTERM 优雅退出）
#   ./scripts/circle.sh restart        # 重启（加载最新代码后常用）
#   ./scripts/circle.sh status         # 查看服务状态
#   ./scripts/circle.sh logs [-f]      # 查看运行日志（-f 跟随）
#   ./scripts/circle.sh log-file       # 打印数据目录日志文件路径
#
# 说明:
#   - 无 systemd 依赖（兼容不支持 systemctl 用户服务的目标环境）：
#     nohup 后台运行 + flock 单实例锁（数据目录 data/circle.lock）；
#   - flock 由内核保证原子性：同时只有一个实例能持有锁并运行，
#     进程退出（含 kill -9）后锁自动释放，不存在 stale 锁残留；
#   - 日志：应用自身写入 data/logs/circle.log（按天轮转，结构化主日志），
#     nohup 的 stdout/stderr 落入 data/logs/startup.log（启动早期错误排查用）。
#
set -euo pipefail

CIRCLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 数据目录（默认 ~/.circle/data）：任务/定时任务/工作空间/微信账户/日志/单实例锁
export CIRCLE_DATA_DIR="${CIRCLE_DATA_DIR:-$HOME/.circle/data}"
# 单实例锁文件：内核 flock 原子保证同一数据目录只有一个 Circle 实例
LOCK_FILE="$CIRCLE_DATA_DIR/circle.lock"
# 主日志（应用写入，按天轮转）
LOG_FILE="$CIRCLE_DATA_DIR/logs/circle.log"
# nohup 输出（启动早期错误 / 未捕获 stderr）
STARTUP_LOG="$CIRCLE_DATA_DIR/logs/startup.log"

# ---- 环境变量（可被外部覆盖）----
export CIRCLE_IM_ADAPTER="${CIRCLE_IM_ADAPTER:-weixin}"
export CIRCLE_AGENT_DIR="${CIRCLE_AGENT_DIR:-$HOME/.pi/agent}"
export CIRCLE_MODEL_PROVIDER="${CIRCLE_MODEL_PROVIDER:-deepseek}"
export CIRCLE_MODEL_ID="${CIRCLE_MODEL_ID:-deepseek-v4-flash}"
export CIRCLE_LOG_LEVEL="${CIRCLE_LOG_LEVEL:-info}"

# 是否已有实例在运行（拿不到锁 = 有实例持有）
# 注意：数据目录不存在时 flock 无法打开锁文件会误判为"被占用"，
# 因此先检查目录存在性——目录不存在视为未运行。
is_running() {
  [[ -d "$CIRCLE_DATA_DIR" ]] || return 1
  ! flock -n "$LOCK_FILE" true 2>/dev/null
}

start() {
  mkdir -p "$CIRCLE_DATA_DIR/logs"
  if is_running; then
    echo "Circle 已在运行（单实例锁 $LOCK_FILE 被占用）。如需重启请用 restart。"
    return 0
  fi
  echo "启动 Circle: IM=$CIRCLE_IM_ADAPTER  DATA=$CIRCLE_DATA_DIR  模型=$CIRCLE_MODEL_PROVIDER/$CIRCLE_MODEL_ID"
  # 后台启动并持有锁：flock 进程存活期间锁有效，进程退出自动释放。
  # flock -n 是唯一仲裁者——即使与另一个 start 并发，内核也保证只有一个实例拿到锁。
  nohup flock -n "$LOCK_FILE" bash -lc "cd '$CIRCLE_DIR' && exec npm start" \
    >> "$STARTUP_LOG" 2>&1 < /dev/null &
  local pid=$!
  sleep 0.3
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "启动失败：单实例锁被占用，或进程启动后立即退出。详情见 $STARTUP_LOG"
    return 1
  fi
  echo "已启动（包装进程 PID $pid）。主日志: $LOG_FILE"
}

stop() {
  if ! is_running; then
    echo "Circle 未在运行。"
    return 0
  fi
  echo "停止 Circle ..."
  # 命中 src/index.ts 的 node 进程链（sh 包装 → tsx → 应用进程），SIGTERM 优雅退出
  pkill -TERM -f "src/index\.ts" 2>/dev/null || true
  # 等待退出（最多 10 秒）
  for _ in $(seq 1 20); do
    is_running || break
    sleep 0.5
  done
  if is_running; then
    echo "进程未在 10 秒内退出，强制结束..."
    pkill -KILL -f "src/index\.ts" 2>/dev/null || true
    sleep 1
  fi
  echo "已停止。"
}

restart() {
  stop
  sleep 1
  start
}

status() {
  if is_running; then
    echo "● Circle 运行中"
    return 0
  fi
  echo "○ Circle 未运行"
  return 1
}

logs() {
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "主日志尚未生成：$LOG_FILE（启动早期输出见 $STARTUP_LOG）"
    return 1
  fi
  if [[ "${1:-}" == "-f" ]]; then
    tail -f "$LOG_FILE"
  else
    tail -n 50 "$LOG_FILE"
  fi
}

log_file() {
  echo "$LOG_FILE"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) restart ;;
  status) status ;;
  logs) logs "${2:-}" ;;
  log-file) log_file ;;
  *)
    echo "用法: $0 {start|stop|restart|status|logs [-f]|log-file}"
    exit 1
    ;;
esac
