#!/usr/bin/env bash
# 疯狂水世界 控制台 · Linux 启动脚本
#
# 用法:
#   ./start.sh                 前台运行，默认 127.0.0.1:8791（仅本机访问）
#   HOST=0.0.0.0 ./start.sh    前台运行，监听所有网卡（公网访问用这个）
#   PORT=8899 ./start.sh       换端口
#
#   后台运行（推荐用 systemd，见 install-service.sh）：
#   HOST=0.0.0.0 ./start.sh -d        后台运行，日志写到 logs/console.out
#   HOST=0.0.0.0 ./start.sh --daemon  同上
#   ./start.sh stop                   停止后台进程
#   ./start.sh restart                重启后台进程
#   ./start.sh status                 看后台进程状态
set -euo pipefail

cd "$(dirname "$0")"

PID_FILE=".console.pid"
OUT_LOG="logs/console.out"

# ---- 进程识别 ----
# 后台模式起的是一个 bash 包装层（它再跑 node），所以有两层进程，要都找出来。
# 注意：不能只信 pid 文件——pid 可能被系统复用，误杀无关进程。
all_ps() { ps -eo pid=,args= 2>/dev/null; }

# 某个 pid 的命令行里是否含指定关键字（用于校验 pid 文件没失效）
pid_args() { all_ps | awk -v p="$1" '$1==p {$1=""; sub(/^ /,""); print; exit}'; }

node_pid() {
  # 匹配 node server.js / node.exe "..." server.js 等各种形态
  all_ps | awk '/server\.js/ && $0 !~ /awk|grep/ && $0 !~ /start\.sh/ {print $1; exit}'
}

wrapper_pid() {
  local pid=""
  if [ -f "$PID_FILE" ]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    # 必须确认这个 pid 现在确实是我们的包装层，否则视为失效
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      case "$(pid_args "$pid")" in
        *start.sh*) echo "$pid"; return 0 ;;
      esac
    fi
  fi
  pid="$(all_ps | awk '/start\.sh run/ && $0 !~ /awk|grep/ {print $1; exit}')"
  if [ -n "$pid" ]; then echo "$pid"; return 0; fi
  return 1
}

find_pid() {
  local w n
  w="$(wrapper_pid || true)"
  n="$(node_pid || true)"
  if [ -n "$w" ]; then echo "$w"; return 0; fi
  if [ -n "$n" ]; then echo "$n"; return 0; fi
  return 1
}

do_stop() {
  local w="" n="" targets="" p

  w="$(wrapper_pid || true)"
  n="$(node_pid || true)"

  if [ -z "$w" ] && [ -z "$n" ]; then
    echo "没有在运行的后台进程。"
    rm -f "$PID_FILE"
    return 0
  fi

  # 要杀的目标：包装层 + node + 它们的直接子进程。
  # 只杀包装层会留下孤儿 node 继续占端口，所以必须显式列出 node。
  for p in $w $n; do
    [ -z "$p" ] && continue
    targets="$targets $p"
    targets="$targets $(all_ps | awk -v parent="$p" '$2==parent {print $1}')"
  done
  targets="$(echo $targets | tr ' ' '\n' | grep -E '^[0-9]+$' | sort -u | tr '\n' ' ')"

  echo "停止进程：$targets"

  # 1) 先按进程组整发（Linux 上 setsid 的会话里 pgid = 包装层 pid，最干净）
  if [ -n "$w" ] && [ "$(uname -s 2>/dev/null)" = "Linux" ]; then
    kill -TERM -- "-$w" 2>/dev/null || true
  fi
  # 2) 再逐个逐个发，双保险
  for p in $targets; do kill -TERM "$p" 2>/dev/null || true; done

  local i alive=""
  for i in $(seq 1 30); do
    alive=""
    for p in $targets; do kill -0 "$p" 2>/dev/null && alive="$alive $p"; done
    [ -z "$alive" ] && break
    sleep 0.2
  done

  # 3) 还不走就 -9
  if [ -n "$alive" ]; then
    echo "进程 $alive 没响应 TERM，强制结束。"
    for p in $alive; do kill -9 "$p" 2>/dev/null || true; done
    sleep 0.5
  fi

  # 4) 兜底：再查一遍端口对应的 node
  local left
  left="$(node_pid || true)"
  [ -n "$left" ] && { echo "清理残留 node：$left"; kill -9 "$left" 2>/dev/null || true; }

  rm -f "$PID_FILE"
  if find_pid >/dev/null 2>&1; then
    echo "[警告] 还有残留进程，请手动检查： ps -eo pid,args | grep server.js" >&2
    return 1
  fi
  echo "✓ 已停止"
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    echo "[错误] 找不到 node，请先安装 Node.js 16 或更高版本。" >&2
    echo "       Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs" >&2
    echo "       CentOS/RHEL:   curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs" >&2
    exit 1
  fi
  local major
  major="$(node -p 'process.versions.node.split(".")[0]')"
  if [ "$major" -lt 16 ]; then
    echo "[错误] Node.js 版本过低（当前 $(node -v)），需要 16 以上。" >&2
    exit 1
  fi
}

MODE="${1:-run}"

case "$MODE" in
  stop)
    do_stop
    exit 0
    ;;
  status)
    if pid="$(find_pid)"; then
      echo "运行中，PID $pid"
      n="$(node_pid || true)"; [ -n "$n" ] && echo "  node 进程：$n"
      # 端口从日志首行读，比当前 shell 的环境变量准（后台进程是上一轮起的）
      if [ -f "$OUT_LOG" ]; then
        listen="$(grep -o 'http://[0-9.]*:[0-9]*' "$OUT_LOG" 2>/dev/null | tail -1)"
        [ -n "$listen" ] && echo "  监听： $listen"
        echo "  日志： $OUT_LOG"
      fi
    else
      echo "未运行。"
      exit 1
    fi
    exit 0
    ;;
  restart)
    do_stop
    MODE="-d"
    ;;
  -d|--daemon|daemon)
    MODE="-d"
    ;;
  run|"")
    MODE="run"
    ;;
  *)
    echo "[错误] 未知参数：$MODE" >&2
    echo "       可用：-d / --daemon / stop / restart / status" >&2
    exit 1
    ;;
esac

require_node

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8791}"

# 后台模式：日志写文件，进程脱离终端
if [ "$MODE" = "-d" ]; then
  if pid="$(find_pid)"; then
    echo "已经在后台运行了（PID $pid）。要重启请用： ./start.sh restart"
    exit 0
  fi
  mkdir -p logs
  : > "$OUT_LOG"
  echo "后台启动中… HOST=$HOST PORT=$PORT"
  # 注意：这里再起一份「前台模式」的自己，而不是直接跑 node。
  # 这样在线更新（退出码 75）后那层 while 循环还能把新版本拉起来。
  # setsid 让进程脱离当前终端会话，关掉 ssh 也不受影响。
  if command -v setsid >/dev/null 2>&1; then
    setsid nohup bash "$0" run >> "$OUT_LOG" 2>&1 < /dev/null &
  else
    nohup bash "$0" run >> "$OUT_LOG" 2>&1 < /dev/null &
  fi
  echo $! > "$PID_FILE"
  sleep 2
  if pid="$(find_pid)"; then
    echo "✓ 已在后台运行，PID $pid"
    echo "  访问： http://<你的公网IP>:${PORT}"
    echo "  日志： tail -f $OUT_LOG"
    echo "  停止： ./start.sh stop"
  else
    echo "[失败] 没起来，看日志：" >&2
    tail -n 30 "$OUT_LOG" >&2 || true
    rm -f "$PID_FILE"
    exit 1
  fi
  exit 0
fi

# 前台模式
echo "启动中… HOST=$HOST PORT=$PORT"
echo "（想后台运行：加 -d，例如 HOST=0.0.0.0 ./start.sh -d）"
echo

# 退出码 75 = 在线更新完成，需要重启加载新代码。
# 用循环代替 exec，这样直接 ./start.sh 跑的时候更新完也能自动拉起，
# 不依赖 systemd 的 Restart=always。
while true; do
  set +e
  node server.js
  CODE=$?
  set -e
  if [ "$CODE" -eq 75 ]; then
    echo "检测到在线更新完成（退出码 75），2 秒后重启…"
    sleep 2
    continue
  fi
  if [ "$CODE" -eq 0 ]; then
    echo "服务正常退出。"
    exit 0
  fi
  echo "[警告] 服务异常退出（退出码 $CODE），5 秒后重启。按 Ctrl+C 可停止。" >&2
  sleep 5
done
