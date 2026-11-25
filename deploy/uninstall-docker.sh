#!/bin/sh
# DeepNav 一键卸载（Docker / Podman）
#
#   curl -fsSL https://raw.githubusercontent.com/xiaoxiong996/deepnav/main/deploy/uninstall-docker.sh | sh
#
# 默认只删除容器和镜像，保留数据卷，方便以后重装。
# 可选环境变量：
#   DEEPNAV_DIR=/opt/deepnav   安装目录
#   PURGE=1                同时删除数据卷和安装目录（不可恢复）
#   KEEP_IMAGE=1           保留镜像
#   YES=1                  跳过确认提示（用于自动化）
set -eu

DIR="${DEEPNAV_DIR:-/opt/deepnav}"
PURGE="${PURGE:-0}"
KEEP_IMAGE="${KEEP_IMAGE:-0}"
YES="${YES:-0}"

say() { printf '%s\n' "$*"; }
die() { printf '\n[错误] %s\n' "$*" >&2; exit 1; }
ask() {
  [ "$YES" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer || answer=""
  case "$answer" in
    [yY] | [yY][eE][sS]) return 0 ;;
    *) return 1 ;;
  esac
}

# ---------- 运行环境 ----------
if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  die "未找到 docker 或 podman，无法卸载容器。"
fi

if [ "$ENGINE" = docker ]; then
  COMPOSE="docker compose"
  docker info >/dev/null 2>&1 || die "无法连接 Docker 守护进程。"
else
  COMPOSE="podman-compose"
fi

say "==> DeepNav 卸载"
say ""
if [ "$PURGE" = "1" ]; then
  say "  模式：完全清除（容器 + 镜像 + 数据卷 + 安装目录）"
  say "  !! 站点配置、上传的图片和管理员密码都会永久丢失。"
else
  say "  模式：仅移除容器（保留数据卷，以后可重新安装）"
  say "  如需连数据一起删除，请用 PURGE=1 重新运行。"
fi
say ""

if ! ask "确认继续？"; then
  say "已取消。"
  exit 0
fi

# ---------- 停止并删除容器 ----------
if [ -f "$DIR/docker-compose.yml" ]; then
  say "==> 停止容器"
  (cd "$DIR" && $COMPOSE down --remove-orphans) || say "(compose down 失败，继续清理残留容器)"
fi

# Only touch a container that this project created. Matching on the bare name
# would delete an unrelated container that happens to be called "deepnav".
if $ENGINE inspect deepnav >/dev/null 2>&1; then
  project=$($ENGINE inspect deepnav --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)
  if [ "$project" = "deepnav" ]; then
    say "==> 删除残留容器 deepnav"
    $ENGINE rm -f deepnav >/dev/null 2>&1 || true
  else
    say "!! 存在名为 deepnav 的容器，但不是本项目的（project=${project:-无}），已跳过。"
    say "   如确认要删除，请手动执行：$ENGINE rm -f deepnav"
  fi
fi

# ---------- 数据卷 ----------
# compose prefixes volumes with the project name, so match that exact prefix
# instead of any volume that merely contains "deepnav".
VOLUMES=$($ENGINE volume ls --format '{{.Name}}' 2>/dev/null | grep -E '^deepnav(_|$)' || true)
if [ "$PURGE" = "1" ]; then
  if [ -n "$VOLUMES" ]; then
    say "==> 删除数据卷"
    for volume in $VOLUMES; do
      $ENGINE volume rm "$volume" >/dev/null 2>&1 && say "    - $volume" || say "    - $volume（删除失败，可能仍被占用）"
    done
  fi
else
  if [ -n "$VOLUMES" ]; then
    say ""
    say "==> 保留了数据卷："
    for volume in $VOLUMES; do say "    - $volume"; done
    say "    重新执行安装脚本即可继续使用原有配置。"
  fi
fi

# ---------- 镜像 ----------
if [ "$KEEP_IMAGE" != "1" ]; then
  IMAGES=$($ENGINE images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep -E 'deepnav' || true)
  if [ -n "$IMAGES" ]; then
    say "==> 删除镜像"
    for image in $IMAGES; do
      # Skip the multi-arch manifest list entry: rmi on it fails after the
      # per-arch images are already gone.
      case "$image" in
        *'<none>'*) continue ;;
      esac
      $ENGINE rmi "$image" >/dev/null 2>&1 && say "    - $image" || say "    - $image（仍被使用或已被移除）"
    done
  fi
fi

# ---------- 安装目录 ----------
if [ "$PURGE" = "1" ] && [ -d "$DIR" ]; then
  say "==> 删除安装目录 $DIR"
  if ! rm -rf "$DIR" 2>/dev/null; then
    say "!! 删除失败，请手动执行：sudo rm -rf $DIR"
  fi
fi

say ""
say "==> 卸载完成"
if [ "$PURGE" != "1" ]; then
  say "    数据卷与 $DIR/.env 仍在，重装后配置不变。"
fi
