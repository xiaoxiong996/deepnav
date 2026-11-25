#!/bin/sh
# DeepNav 一键部署（非 root，无 Docker）
#
#   curl -fsSL https://raw.githubusercontent.com/xiaoxiong996/deepnav/main/deploy/install-bare.sh | sh
#
# 以普通用户身份运行，安装到 ~/.local/share/deepnav，监听 127.0.0.1:3335。
# 可选环境变量：
#   APP_PORT=3335        监听端口
#   DEEPNAV_DIR=...      安装目录
#   DEEPNAV_VERSION=...  指定版本标签，默认 latest
#   ADMIN_PASSWORD=...   指定管理员密码（默认使用内置默认值）
#
# 卸载：https://raw.githubusercontent.com/xiaoxiong996/deepnav/main/deploy/uninstall-bare.sh
set -eu

REPO="xiaoxiong996/deepnav"
DIR="${DEEPNAV_DIR:-$HOME/.local/share/deepnav}"
PORT="${APP_PORT:-3335}"
VERSION="${DEEPNAV_VERSION:-latest}"
NODE_MIN=20

say() { printf '%s\n' "$*"; }
die() { printf '\n[错误] %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] && die "请用普通用户运行，不要用 root（脚本会配置 systemd --user 服务）。"

# ---------- Node.js ----------
need_node=1
if command -v node >/dev/null 2>&1; then
  current=$(node -p 'process.versions.node.split(".")[0]')
  [ "$current" -ge "$NODE_MIN" ] && need_node=0
fi

if [ "$need_node" -eq 1 ]; then
  say "==> 未找到 Node.js >= $NODE_MIN，尝试安装到 $DIR/runtime"
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) die "不支持的架构：$(uname -m)" ;;
  esac
  mkdir -p "$DIR/runtime"
  url="https://nodejs.org/dist/latest-v22.x"
  file=$(curl -fsSL "$url/SHASUMS256.txt" | grep "linux-$arch.tar.xz" | head -n 1 | awk '{print $2}')
  [ -n "$file" ] || die "无法解析 Node.js 下载地址"
  say "    下载 $file"
  curl -fsSL "$url/$file" -o "$DIR/node.tar.xz" || die "下载 Node.js 失败"
  tar -xJf "$DIR/node.tar.xz" -C "$DIR/runtime" --strip-components=1 || die "解压 Node.js 失败"
  rm -f "$DIR/node.tar.xz"
  NODE_BIN="$DIR/runtime/bin/node"
else
  NODE_BIN=$(command -v node)
fi

say "==> Node.js：$($NODE_BIN --version)"

# ---------- ping ----------
if ! command -v ping >/dev/null 2>&1; then
  say ""
  say "!! 警告：未找到 ping 命令，服务端 ICMP 延迟将全部失败。"
  say "   Debian/Ubuntu: sudo apt install -y iputils-ping"
  say "   CentOS/RHEL:   sudo dnf install -y iputils"
  say "   Alpine:        sudo apk add iputils"
  say ""
fi

# ---------- 代码 ----------
say "==> 安装到 $DIR"
mkdir -p "$DIR/app"
if command -v git >/dev/null 2>&1; then
  if [ -d "$DIR/app/.git" ]; then
    git -C "$DIR/app" fetch --depth 1 origin main >/dev/null 2>&1 || true
    git -C "$DIR/app" reset --hard origin/main >/dev/null 2>&1 || true
  else
    rm -rf "$DIR/app"
    git clone --depth 1 "https://github.com/$REPO.git" "$DIR/app" || die "克隆仓库失败"
  fi
else
  say "    未找到 git，改用 tarball 下载"
  tmp="$DIR/src.tar.gz"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/main" -o "$tmp" || die "下载源码失败"
  rm -rf "$DIR/app.old"
  [ -d "$DIR/app" ] && mv "$DIR/app" "$DIR/app.old"
  mkdir -p "$DIR/app"
  tar -xzf "$tmp" -C "$DIR/app" --strip-components=1 || die "解压源码失败"
  rm -rf "$tmp" "$DIR/app.old"
fi

# ---------- 配置 ----------
DATA_DIR="$DIR/data"
mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

if [ ! -f "$DIR/deepnav.env" ]; then
  cat > "$DIR/deepnav.env" <<EOF
# 留空表示使用默认密码 DeepNav@2026，登录后请在后台修改。
ADMIN_PASSWORD=${ADMIN_PASSWORD:-}
PORT=$PORT
HOST=127.0.0.1
DATA_DIR=$DATA_DIR
TZ=Asia/Shanghai
COOKIE_SECURE=false
TRUST_PROXY=false
NODE_ENV=production
EOF
  chmod 600 "$DIR/deepnav.env"
fi

# ---------- systemd --user ----------
mkdir -p "$HOME/.config/systemd/user"
cat > "$HOME/.config/systemd/user/deepnav.service" <<EOF
[Unit]
Description=DeepNav 自托管导航页
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$DIR/app
EnvironmentFile=$DIR/deepnav.env
ExecStart=$NODE_BIN $DIR/app/server.js
Restart=always
RestartSec=3
# 顶层目录只读，仅数据目录可写
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=$DATA_DIR
# ICMP 需要能创建 raw socket
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW CAP_NET_BIND_SERVICE

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now deepnav.service || die "启动 systemd 服务失败"

if command -v loginctl >/dev/null 2>&1; then
  loginctl enable-linger "$(id -un)" 2>/dev/null || say "!! 无法启用 linger，注销后服务会停止；可手动执行：loginctl enable-linger $(id -un)"
fi

sleep 2

say ""
say "==> 部署完成"
say ""
say "  导航页       http://127.0.0.1:$PORT/"
say "  管理后台     http://127.0.0.1:$PORT/m-deepnav"
say "  默认账号     admin / DeepNav@2026"
say "  安装目录     $DIR/app"
say "  环境变量     $DIR/deepnav.env"
say "  数据目录     $DATA_DIR"
say ""
say "  !! 请立即登录后台修改密码，并在「后台访问路径」中换成自己的路径。"
say ""
say "  查看日志     journalctl --user -u deepnav -f"
say "  重启         systemctl --user restart deepnav"
say "  停止         systemctl --user stop deepnav"
say "  升级         curl -fsSL https://raw.githubusercontent.com/$REPO/main/deploy/install-bare.sh | sh"
say ""
