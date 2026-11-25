#!/bin/sh
# DeepNav 一键卸载（非 root，无 Docker）
#
#   curl -fsSL https://raw.githubusercontent.com/xiaoxiong996/deepnav/main/deploy/uninstall-bare.sh | sh
#
# 默认停止并移除服务，保留数据目录，方便以后重装。
# 可选环境变量：
#   DEEPNAV_DIR=...   安装目录（默认 ~/.local/share/deepnav）
#   PURGE=1           同时删除数据目录和安装目录（不可恢复）
#   YES=1             跳过确认提示（用于自动化）
set -eu

DIR="${DEEPNAV_DIR:-$HOME/.local/share/deepnav}"
PURGE="${PURGE:-0}"
YES="${YES:-0}"
UNIT="$HOME/.config/systemd/user/deepnav.service"

say() { printf '%s\n' "$*"; }
ask() {
  [ "$YES" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer || answer=""
  case "$answer" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

say "==> DeepNav 卸载"
say ""
if [ "$PURGE" = "1" ]; then
  say "  模式：完全清除（服务 + 安装目录 + 数据目录）"
  say "  !! 站点配置、上传的图片和管理员密码都会永久丢失。"
else
  say "  模式：仅移除服务（保留 $DIR 下的数据，以后可重装）"
  say "  如需连数据一起删除，请用 PURGE=1 重新运行。"
fi
say ""

if ! ask "确认继续？"; then
  say "已取消。"
  exit 0
fi

# ---------- systemd 服务 ----------
if command -v systemctl >/dev/null 2>&1; then
  say "==> 停止并禁用服务"
  systemctl --user stop deepnav.service 2>/dev/null || true
  systemctl --user disable deepnav.service 2>/dev/null || true
fi

if [ -f "$UNIT" ]; then
  # Guard against removing a unit that some other service installed under the
  # same name: the ExecStart path must point inside our install directory.
  if grep -qF "$DIR/app/server.js" "$UNIT" 2>/dev/null; then
    say "==> 删除 unit 文件"
    rm -f "$UNIT"
    command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload 2>/dev/null || true
  else
    say "!! $UNIT 不属于 $DIR，已跳过删除。"
    say "   如确认要移除，请手动执行：rm -f $UNIT && systemctl --user daemon-reload"
  fi
fi

# ---------- 目录 ----------
if [ "$PURGE" = "1" ]; then
  if [ -d "$DIR" ]; then
    say "==> 删除安装目录 $DIR"
    if ! rm -rf "$DIR" 2>/dev/null; then
      say "!! 删除失败（可能有进程占用或权限不足）。请手动执行：sudo rm -rf $DIR"
    fi
  fi
else
  say ""
  say "==> 保留了数据目录 $DIR"
  say "    其中 deepnav.env 含管理员密码，config.json 是站点配置。"
fi

say ""
say "==> 卸载完成"
if [ "$PURGE" != "1" ]; then
  say "    重新执行安装脚本即可继续使用原有配置。"
else
  OWNER=$(id -un 2>/dev/null || whoami 2>/dev/null || echo '你的用户名')
  say "    如需同时关闭 linger： loginctl disable-linger $OWNER"
fi
