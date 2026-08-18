#!/usr/bin/env bash
#
# Circle 服务管理脚本（默认微信 iLink 适配器）
#
# 用法:
#   ./scripts/circle.sh start          # 启动（systemd 用户服务 circle-agent）
#   ./scripts/circle.sh stop           # 停止
#   ./scripts/circle.sh restart        # 重启（加载最新代码后常用）
#   ./scripts/circle.sh status         # 查看服务状态
#   ./scripts/circle.sh logs [-f]      # 查看运行日志（-f 跟随）
#   ./scripts/circle.sh log-file       # 打印数据目录日志文件路径
#
# 说明:
#   - 通过 systemd 用户服务托管，脱离终端会话，重启机器/终端不影响运行；
#   - 所有关键环境变量在此固化，微信适配器无需手动拼参数；
#   - 日志统一写入数据目录 logs/circle.log（按天轮转），stdout 进 systemd journal。
#
set -euo pipefail

CIRCLE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT="circle-agent"

# ---- 环境变量（可被外部覆盖）----
# IM 适配器：weixin（官方 iLink 通道，微信扫码登录/缓存恢复）
export CIRCLE_IM_ADAPTER="${CIRCLE_IM_ADAPTER:-weixin}"
# 数据目录：默认 ~/.circle/data（任务/定时任务/工作空间/微信账户/日志）
export CIRCLE_DATA_DIR="${CIRCLE_DATA_DIR:-$HOME/.circle/data}"
# pi agent 配置目录（模型/凭据）
export CIRCLE_AGENT_DIR="${CIRCLE_AGENT_DIR:-$HOME/.pi/agent}"
export CIRCLE_MODEL_PROVIDER="${CIRCLE_MODEL_PROVIDER:-deepseek}"
export CIRCLE_MODEL_ID="${CIRCLE_MODEL_ID:-deepseek-v4-flash}"
export CIRCLE_LOG_LEVEL="${CIRCLE_LOG_LEVEL:-info}"

start() {
  if systemctl --user is-active "$UNIT" >/dev/null 2>&1; then
    echo "Circle 已在运行（systemd 用户服务 $UNIT）。如需重启请用 restart。"
    return 0
  fi
  echo "启动 Circle: IM=$CIRCLE_IM_ADAPTER  DATA=$CIRCLE_DATA_DIR  模型=$CIRCLE_MODEL_PROVIDER/$CIRCLE_MODEL_ID"
  systemd-run --user --unit="$UNIT" --working-directory="$CIRCLE_DIR" \
    --setenv=CIRCLE_IM_ADAPTER="$CIRCLE_IM_ADAPTER" \
    --setenv=CIRCLE_DATA_DIR="$CIRCLE_DATA_DIR" \
    --setenv=CIRCLE_AGENT_DIR="$CIRCLE_AGENT_DIR" \
    --setenv=CIRCLE_MODEL_PROVIDER="$CIRCLE_MODEL_PROVIDER" \
    --setenv=CIRCLE_MODEL_ID="$CIRCLE_MODEL_ID" \
    --setenv=CIRCLE_LOG_LEVEL="$CIRCLE_LOG_LEVEL" \
    --setenv=PATH="$PATH" --setenv=HOME="$HOME" \
    bash -lc "cd '$CIRCLE_DIR' && npm start"
  echo "已启动。日志统一写入: $CIRCLE_DATA_DIR/logs/circle.log（stdout 进 systemd journal）"
}

stop() {
  if ! systemctl --user is-active "$UNIT" >/dev/null 2>&1; then
    echo "Circle 未在运行。"
    return 0
  fi
  echo "停止 Circle ..."
  systemctl --user stop "$UNIT"
  echo "已停止。"
}

restart() {
  stop
  sleep 1
  start
}

status() {
  if systemctl --user is-active "$UNIT" >/dev/null 2>&1; then
    echo "● Circle 运行中（systemd 用户服务 $UNIT）"
    systemctl --user status "$UNIT" --no-pager | head -8
  else
    echo "○ Circle 未运行"
  fi
}

logs() {
  local target="$CIRCLE_DATA_DIR/logs/circle.log"
  if [[ ! -f "$target" ]]; then
    echo "数据目录日志尚未生成：$target"
    return 1
  fi
  if [[ "${1:-}" == "-f" ]]; then
    tail -f "$target"
  else
    tail -n 50 "$target"
  fi
}

log_file() {
  echo "$CIRCLE_DATA_DIR/logs/circle.log"
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
