#!/usr/bin/env bash
# 疯狂水世界 控制台 · 卸载 systemd 服务（停止后台常驻）
#
# 用法：
#   sudo ./uninstall-service.sh
#   sudo SERVICE_NAME=mybot ./uninstall-service.sh
set -euo pipefail

SERVICE_NAME="${SERVICE_NAME:-farmbot-console}"
UNIT="/etc/systemd/system/${SERVICE_NAME}.service"

if [ "$(id -u)" -ne 0 ]; then
  echo "[错误] 需要 root 权限，请用：sudo ./uninstall-service.sh" >&2
  exit 1
fi

if [ ! -f "$UNIT" ]; then
  echo "[提示] 没找到 $UNIT，服务可能本来就没装。"
  exit 0
fi

systemctl stop "$SERVICE_NAME" 2>/dev/null || true
systemctl disable "$SERVICE_NAME" 2>/dev/null || true
rm -f "$UNIT"
systemctl daemon-reload

echo "✓ 已停止并移除服务 ${SERVICE_NAME}（程序目录和你的数据都还在）"
