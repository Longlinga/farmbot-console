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
exec node server.js
