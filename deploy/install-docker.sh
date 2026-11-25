#!/bin/sh
# DeepNav 一键部署（Docker / Podman）
#
#   curl -fsSL https://raw.githubusercontent.com/xiaoxiong996/deepnav/main/deploy/install-docker.sh | sh
#
# 可选环境变量：
#   APP_PORT=3335          宿主机回环端口
#   DEEPNAV_DIR=/opt/deepnav   安装目录
#   DEEPNAV_IMAGE=ghcr.io/...  覆盖镜像
#   ADMIN_PASSWORD=...     指定管理员密码（默认自动生成）
set -eu

REPO="xiaoxiong996/deepnav"
IMAGE="${DEEPNAV_IMAGE:-ghcr.io/xiaoxiong996/deepnav:latest}"
DIR="${DEEPNAV_DIR:-/opt/deepnav}"
PORT="${APP_PORT:-3335}"

say() { printf '%s\n' "$*"; }
die() { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

# ---------- 运行环境 ----------
if command -v docker >/dev/null 2>&1; then
  ENGINE=docker
elif command -v podman >/dev/null 2>&1; then
  ENGINE=podman
else
  die "未找到 docker 或 podman。请先安装：
  Debian/Ubuntu: curl -fsSL https://get.docker.com | sh
  CentOS/RHEL:   dnf install -y docker && systemctl enable --now docker"
fi

if [ "$ENGINE" = docker ]; then
  docker info >/dev/null 2>&1 || die "无法连接 Docker 守护进程。请确认服务已启动，且当前用户有权限（可加入 docker 组或使用 sudo）。"
  COMPOSE="docker compose"
  $COMPOSE version >/dev/null 2>&1 || die "缺少 Docker Compose 插件。请安装 docker-compose-plugin。"
else
  COMPOSE="podman-compose"
  command -v $COMPOSE >/dev/null 2>&1 || die "使用 Podman 时需要 podman-compose。"
fi

# ---------- 安装目录 ----------
say "==> 安装目录 $DIR"
if [ -f "$DIR/.env" ]; then
  say "==> 检测到已有安装，保留现有 .env 与数据卷（升级模式）"
else
  mkdir -p "$DIR"
  cat > "$DIR/.env" <<EOF
# 首次生成的配置。修改后需重启：$COMPOSE up -d
# 留空表示使用默认密码 DeepNav@2026，登录后请在后台修改。
ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
APP_PORT=$PORT
TZ=Asia/Shanghai
# 站点走 HTTPS 时改为 true（Cookie 仅经 HTTPS 传输）
COOKIE_SECURE=false
# 反向代理（Nginx/Caddy/Lucky）转发时改为 true，用于取真实客户端 IP
TRUST_PROXY=false
HSTS_INCLUDE_SUBDOMAINS=true
EOF
  chmod 600 "$DIR/.env"
fi

cd "$DIR"

if [ "$ENGINE" = podman ]; then
  sed -i 's/^\(\s*\)image:.*/\1image: '"$IMAGE"'/' /dev/null 2>/dev/null || true
fi

cat > "$DIR/docker-compose.yml" <<EOF
name: deepnav

services:
  deepnav:
    image: $IMAGE
    container_name: deepnav
    restart: unless-stopped
    init: true
    ports:
      - "127.0.0.1:\${APP_PORT:-$PORT}:8090"
    environment:
      PORT: "8090"
      DATA_DIR: /data
      ADMIN_PASSWORD: "\${ADMIN_PASSWORD:-}"
      TZ: "\${TZ:-Asia/Shanghai}"
      COOKIE_SECURE: "\${COOKIE_SECURE:-false}"
      TRUST_PROXY: "\${TRUST_PROXY:-false}"
      HSTS_INCLUDE_SUBDOMAINS: "\${HSTS_INCLUDE_SUBDOMAINS:-true}"
    sysctls:
      net.ipv4.ping_group_range: "0 2147483647"
    volumes:
      - deepnav-data:/data
    security_opt:
      - no-new-privileges:true
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  deepnav-data:
EOF

say "==> 拉取镜像 $IMAGE"
$COMPOSE pull || say "(拉取失败，尝试本地已存在的镜像)"

say "==> 启动容器"
$COMPOSE up -d

say "==> 等待健康检查"
i=0
while [ $i -lt 30 ]; do
  if $ENGINE inspect --format '{{.State.Health.Status}}' deepnav 2>/dev/null | grep -q healthy; then
    break
  fi
  i=$((i + 1))
  sleep 1
done

say ""
say "==> 部署完成"
say ""
say "  导航页       http://127.0.0.1:$PORT/"
say "  管理后台     http://127.0.0.1:$PORT/m-deepnav"
say "  默认账号     admin / DeepNav@2026"
say "  配置文件     $DIR/.env"
say "  数据卷       deepnav-data"
say ""
say "  !! 请立即登录后台修改密码，并在「后台访问路径」中换成自己的路径。"
say ""
say "如果需要公网访问，请用 Nginx / Caddy / Lucky 反代到 127.0.0.1:$PORT，"
say "并把 .env 中的 COOKIE_SECURE 改为 true、TRUST_PROXY 改为 true 后重启。"
