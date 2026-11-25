# DeepNav

自托管双延迟导航页：服务器 ICMP + 访问者浏览器 HTTP 延迟，带密码后台、逐节点/整站隐藏、图片图库与主题定制。

只依赖 Node.js 内置模块，无 npm 依赖，无构建步骤。

## 一键部署

1. 启动服务（见下方两种方式）。
2. 打开 `http://<host>:3335/m-deepnav`，用 `admin` / `DeepNav@2026` 登录。
3. 立刻改密码，并建议更换后台路径。

首次启动还会在日志里重复这些信息，方便你确认。

### 方式一：Docker（推荐）

```bash
curl -fsSL https://raw.githubusercontent.com/xiaoxiong996/deepnav/main/deploy/install-docker.sh | sh
```

脚本会自动：
1. 检测 Docker / Compose；
2. 安装到 `/opt/deepnav`，生成 `.env`；
3. 拉取多架构镜像 `ghcr.io/xiaoxiong996/deepnav:latest` 并启动；
4. 等到健康检查通过后打印访问地址。

容器只监听 `127.0.0.1:3335`，公网访问请用 Nginx / Caddy / Lucky 反代。

可覆盖的变量：

```bash
APP_PORT=3335 DEEPNAV_DIR=/opt/deepnav ADMIN_PASSWORD='自定义初始密码' \
  curl -fsSL .../install-docker.sh | sh
```

手动方式：

```bash
git clone https://github.com/xiaoxiong996/deepnav.git && cd deepnav
cp .env.example .env
docker compose up -d    # 拉取镜像；加 -f docker-compose.build.yml 可本地构建
```

### 方式二：非 root 直接部署（无 Docker）

以普通用户运行，安装到 `~/.local/share/deepnav`：

```bash
curl -fsSL https://raw.githubusercontent.com/xiaoxiong996/deepnav/main/deploy/install-bare.sh | sh
```

脚本会自动：
1. 检测 Node.js ≥ 20，缺失则下载官方二进制到安装目录（不需要 sudo）；
2. 拉取源码（有 git 用 git，否则用 tarball）；
3. 写入 `~/.local/share/deepnav/deepnav.env`（权限 600）；
4. 注册 `systemd --user` 服务并启动，同时开启 linger 以便注销后继续运行；
5. 打印访问地址。

管理命令：

```bash
systemctl --user status deepnav
journalctl --user -u deepnav -f     # 查看日志（含后台路径）
systemctl --user restart deepnav
```

服务以 `CAP_NET_RAW` 运行，因此非 root 也能发 ICMP；同时开启 `ProtectSystem=strict`、`ProtectHome=read-only`，仅数据目录可写。

手动方式：

```bash
git clone https://github.com/xiaoxiong996/deepnav.git && cd deepnav
npm start    # 等价于 node server.js，默认 0.0.0.0:8090
```

### 部署后必读

全新部署使用**固定默认值**，方便第一次使用：

| 项目 | 默认值 |
|---|---|
| 后台地址 | `http://<host>:3335/m-deepnav` |
| 用户名 | `admin` |
| 密码 | `DeepNav@2026` |

默认值不属于机密，任何知道本项目的人都能试出来，因此：

- **登录后请立刻修改密码**（「系统设置 → 管理员账户」）。
- 建议同时把「后台访问路径」换成只有你知道的路径，保存后旧路径立即失效；也可以点「随机生成」。
- 只要还在用默认密码，后台顶部会一直显示一条警告，修改后自动消失。
- 首页**没有**后台入口按钮，`/admin` 直接返回 404，不会提示真实路径。

忘记后台路径时，在日志里能看到当前地址：

```bash
docker logs deepnav | grep 管理后台      # Docker 部署
journalctl --user -u deepnav | grep 管理后台   # 非 root 部署
```

忘记密码时：

```bash
docker exec deepnav node scripts/reset-password.js          # 随机重置
NEW_ADMIN_PASSWORD='新密码' node scripts/reset-password.js   # 指定新密码
```

走 HTTPS 时把 `COOKIE_SECURE` 和 `TRUST_PROXY` 改为 `true` 再重启。

## 后台功能

- 站点、分组、多节点地址增删改排序。
- 每个节点可勾选「仅登录可见」；站点可勾选「整站仅登录可见」；系统设置可全局隐藏全部节点。
- 导航页名称、顶部品牌文字与字体、导航页图标、站点图标。
- 电脑横屏背景、手机竖屏背景、后台背景，背景遮罩透明度。
- 自定义主题色（同时影响强调色和深色背景），留空为默认黑色。
- 上传 PNG / JPEG / WebP / GIF（≤5 MB）作为图标或背景，可删除未被引用的图片。
- 配置导出 / 导入；管理员用户名与密码修改；后台访问路径修改。

## 安全设计

- Scrypt 密码哈希、HttpOnly + SameSite=Strict 会话 Cookie、CSRF Token。
- 登录失败按 IP 限流（5 次 / 10 分钟），登录错误不区分用户名或密码。
- 管理员用户名使用常量时间比较。
- CSP 按「当前访客可见范围」动态生成：`connect-src` 只包含本次请求有权看到的节点来源，访客拿不到被隐藏节点的任何地址；`img-src` 仅允许自身、data: 与已配置图片来源。
- 访客的 `/api/nav` 不返回 `hiddenSiteCount`、`hiddenCount`、`nodesHidden`、`hideNodesForGuests`，不透露是否存在隐藏站点或节点。
- HSTS `max-age=31536000; includeSubDomains`（HTTPS 请求时；`HSTS_INCLUDE_SUBDOMAINS=false` 可关闭）；补 `frame-src 'none'`，并在全部可见节点均为 HTTPS 时加 `upgrade-insecure-requests`（避免破坏 HTTP 书签）。
- HTML 响应带 `Vary: Cookie, X-Forwarded-Proto`，防止反向代理把登录态的 CSP 缓存给访客。
- 首屏由服务端按当前配置渲染：标题、品牌文字与字体、图标、favicon、主题色、背景与遮罩透明度都直接写进 HTML，刷新时不会先闪一下内置默认名称。
- `X-Frame-Options: DENY`、`frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、COOP/CORP 同源、Referrer-Policy no-referrer。
- 上传只接受真实图片文件头，拒绝 SVG；上传图片响应带 `CSP: default-src 'none'; sandbox`。
- 节点跳转使用内部 `/go/<id>` 并校验配置；未登录隐藏时服务端同时拒绝测速与跳转。
- Docker 以非 root `node` 用户运行，`no-new-privileges`，仅发布到回环地址。

## 反向代理

应用只监听回环地址，公网访问请交给反向代理。Nginx 示例：

```nginx
location / {
    proxy_pass http://127.0.0.1:3335;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

配置好后把 `.env` 里的 `COOKIE_SECURE=true`、`TRUST_PROXY=true` 打开并重启，否则会话 Cookie 不会加 `Secure`、限流也会把所有人当成同一个 IP。

建议同时：
1. 在代理层开启 HTTPS，并把 HTTP 跳转到 HTTPS。
2. 如果前面还有 CDN，确认源站只接受 CDN 回源，避免绕过。
3. 定期 `docker compose pull && docker compose up -d` 更新镜像。

## 测试

```bash
node tests/app.test.js
```

无第三方依赖。覆盖登录、CSRF、上传、逐节点隐藏、整站隐藏、访客 CSP 不泄露隐藏节点、后台路径与轮换、HSTS、ICMP 探测等。

## 目录结构

```
server.js              启动入口、环境变量
lib/app.js             HTTP 路由、CSP、服务端首屏渲染
lib/store.js           配置校验与持久化
lib/security.js        密码哈希、会话、Cookie
lib/ping.js            ICMP 探测与并发队列
public/                前端页面与静态资源
scripts/reset-password.js
deploy/                一键部署脚本
tests/app.test.js
```

## 版本

`1.12.0`（后台改为固定默认路径且首页无入口；首屏服务端渲染，修复刷新时的名称/图标闪烁）。
