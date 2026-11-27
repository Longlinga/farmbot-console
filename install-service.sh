#!/usr/bin/env bash
# 疯狂水世界 控制台 · systemd 服务安装脚本（让服务在后台常驻运行）
#
# 用法：
#   sudo ./install-service.sh                  装成系统服务，监听 0.0.0.0:8791，开机自启
#   sudo PORT=8899 ./install-service.sh        换端口
#   sudo HOST=127.0.0.1 ./install-service.sh   只监听本机（配合 Nginx 反代时用）
#   sudo SERVICE_NAME=mybot ./install-service.sh   换服务名
#
# 装完后：
#   systemctl status   farmbot-console    看状态
#   systemctl restart  farmbot-console    重启
#   systemctl stop     farmbot-console    停止
#   journalctl -u farmbot-console -f      看实时日志
#   ./uninstall-service.sh                卸载
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="${SERVICE_NAME:-farmbot-console}"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8791}"

if [ "$(id -u)" -ne 0 ]; then
  echo "[错误] 需要 root 权限来写 systemd 单元文件，请用：" >&2
  echo "         sudo ./install-service.sh" >&2
  exit 1
fi

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "[错误] 找不到 node，请先安装 Node.js 16 或更高版本。" >&2
  exit 1
fi
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 16 ]; then
  echo "[错误] Node.js 版本过低（当前 $("$NODE_BIN" -v)），需要 16 以上。" >&2
  exit 1
fi

if [ ! -f "$APP_DIR/server.js" ]; then
  echo "[错误] 在 $APP_DIR 找不到 server.js，请把脚本放到程序目录里再执行。" >&2
  exit 1
fi

# 检查端口是否已被别的进程占着（常见原因：之前用 start.sh / nohup / systemd-run 跑过没关）
# 这是装服务最常见的失败原因：systemctl restart 起来后抢不到端口，立刻 exit 1，
# 看起来像「脚本装坏了」，其实是旧进程还占着。这里能识别的就自动收掉。
if command -v ss >/dev/null 2>&1; then
  BUSY_PIDS="$(ss -lntpH 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p"$"' | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u || true)"
  if [ -n "$BUSY_PIDS" ]; then
    echo "[提示] 端口 ${PORT} 已被占用，检查是不是上次的残留进程……"
    for pid in $BUSY_PIDS; do
      CMD="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      echo "       pid $pid: ${CMD:-<未知>}"
    done
    # 只在明确是本程序的 node 进程时自动 kill，别碰别人的服务
    KILLABLE=""
    for pid in $BUSY_PIDS; do
      CMD="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
      case "$CMD" in
        *node*server.js*) KILLABLE="$KILLABLE $pid" ;;
      esac
    done
    if [ -n "$KILLABLE" ]; then
      echo "       识别为本控制台的旧进程，先停掉：$KILLABLE"
      # shellcheck disable=SC2086
      kill $KILLABLE 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        if ! ss -lntH 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p"$"' | grep -q .; then break; fi
        sleep 0.3
      done
      # shellcheck disable=SC2086
      ss -lntH 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p"$"' | grep -q . && kill -9 $KILLABLE 2>/dev/null || true
      sleep 0.5
    fi
    if ss -lntH 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p"$"' | grep -q .; then
      echo "[错误] 端口 ${PORT} 仍被占用，且不是本程序的进程：" >&2
      ss -lntp 2>/dev/null | awk -v p=":${PORT}" '$4 ~ p"$"' >&2 || true
      echo "       请先手动停掉它，或者换个端口：sudo PORT=8899 ./install-service.sh" >&2
      exit 1
    fi
    echo "       端口已释放。"
    echo
  fi
fi

# systemd-run 建的临时单元和这里的常驻单元同名，会互相顶掉：
#   systemd-run 报「Unit xxx.service was already loaded or has a fragment file」
# 或者常驻单元装好了但 restart 实际起的是那个临时单元（没有 Restart=always）。
if systemctl show "${SERVICE_NAME}.service" -p Transient --value 2>/dev/null | grep -qx 'yes'; then
  echo "[提示] 检测到同名的 systemd-run 临时单元，先清理……"
  systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
  systemctl reset-failed "${SERVICE_NAME}.service" 2>/dev/null || true
  echo
fi

echo "部署目录：$APP_DIR"
echo "node    ：$NODE_BIN ($("$NODE_BIN" -v))"
echo "监听    ：${HOST}:${PORT}"
echo "服务名  ：${SERVICE_NAME}"
echo

# 如果之前用 systemd-run 起过同名的临时单元，它会和这里的常驻单元抢名字，
# 表现为 systemd-run 报「Unit xxx.service was already loaded or has a fragment file」。
# 这里先把临时单元清掉，保证后续 restart 拿到的是我们刚写的那份。
systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl reset-failed "${SERVICE_NAME}.service" 2>/dev/null || true

cat > "$UNIT" <<UNIT_EOF
[Unit]
Description=疯狂水世界 控制台
Documentation=file://${APP_DIR}/DEPLOY.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/server.js
# 在线更新完成后进程以退出码 75 退出，Restart=always 会自动拉起来
Restart=always
RestartSec=5
Environment=HOST=${HOST}
Environment=PORT=${PORT}
# 首次部署想指定初始账号密码时取消注释（已有 auth.json 时不生效）
#Environment=FARMBOT_USER=admin
#Environment=FARMBOT_PASS=换成你的强密码
# 走 HTTPS 反代并强制 Secure Cookie 时打开
#Environment=FARMBOT_COOKIE_SECURE=1
#Environment=FARMBOT_TRUST_PROXY=1
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT_EOF

echo "已写入 $UNIT"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME"

sleep 2
if systemctl is-active --quiet "$SERVICE_NAME"; then
  echo
  echo "✓ 服务已在后台运行（已设为开机自启）"
  echo
  echo "  访问地址： http://<你的公网IP>:${PORT}"
  echo "  首次账号密码在启动日志里："
  echo "     journalctl -u ${SERVICE_NAME} -n 40 --no-pager | grep -A4 '首次启动'"
  echo
  echo "  常用命令："
  echo "     systemctl status  ${SERVICE_NAME}"
  echo "     systemctl restart ${SERVICE_NAME}"
  echo "     journalctl -u ${SERVICE_NAME} -f"
  echo
  # 说明清楚以后网页点更新会发生什么，省得再被「更新后没起来」吓一次
  echo "  之后的在线更新：进程以退出码 75 退出，Restart=always 会自动拉起新版本。"
  echo "  确认监管生效：journalctl -u ${SERVICE_NAME} -n 50 | grep '更新后由'"
  echo "  （应显示「更新后由 systemd 自动拉起新版本」）"
else
  echo
  echo "[失败] 服务没能启动，看错误原因：" >&2
  systemctl status "$SERVICE_NAME" --no-pager -l | head -30 >&2 || true
  echo >&2
  echo "     journalctl -u ${SERVICE_NAME} -n 60 --no-pager" >&2
  echo >&2
  echo "  最常见的两个原因：" >&2
  echo "    1) 端口 ${PORT} 被别的程序占着 → sudo PORT=8899 ./install-service.sh" >&2
  echo "    2) node 路径不对（用了 nvm，root 访问不到）→ 用系统 node 或改 ExecStart" >&2
  exit 1
fi
