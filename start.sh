#!/usr/bin/env bash
# 疯狂水世界 控制台 · Linux 启动脚本
# 用法:
#   ./start.sh                 默认 127.0.0.1:8791（仅本机访问）
#   HOST=0.0.0.0 ./start.sh    监听所有网卡（公网访问用这个）
#   PORT=8899 ./start.sh       换端口
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[错误] 找不到 node，请先安装 Node.js 16 或更高版本。" >&2
  echo "       Ubuntu/Debian: curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs" >&2
  echo "       CentOS/RHEL:   curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs" >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 16 ]; then
  echo "[错误] Node.js 版本过低（当前 $(node -v)），需要 16 以上。" >&2
  exit 1
fi

export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-8791}"

echo "启动中… HOST=$HOST PORT=$PORT"

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
