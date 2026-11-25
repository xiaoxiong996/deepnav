import http from 'node:http';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConfigStore,
  ValidationError,
  normalizeAdminPath,
  normalizeConfig,
  toAdminConfig,
  toPublicConfig,
} from './store.js';
import { hashPassword, readCookie, verifyPassword } from './security.js';
import {
  LoginLimiter,
  RateLimiter,
  SESSION_COOKIE,
  SessionManager,
  expiredSessionCookie,
  sessionCookie,
} from './auth.js';
import { ProbeBusyError, ProbeService } from './ping.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(APP_DIR, '..', 'public');
const BODY_LIMIT = 512 * 1024;
const UPLOAD_LIMIT = 5 * 1024 * 1024;
const PING_CACHE_TTL_MS = 8000;
const VERSION = '1.12.0';

const STATIC_ROUTES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/app.js', 'app.js'],
  ['/favicon.svg', 'favicon.svg'],
  ['/admin.css', 'admin.css'],
  ['/admin.js', 'admin.js'],
]);

// Paths the admin console used to live on. They stay reserved so an old
// bookmark gets a clear hint instead of the public navigation page.
const LEGACY_ADMIN_PATHS = new Set(['/admin', '/admin/', '/admin.html']);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

class HttpError extends Error {
  constructor(statusCode, message, headers = {}) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.headers = headers;
  }
}

function externalOrigin(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

// The connect-src allowlist doubles as a map of every node address, so it has to
// be scoped to what the current visitor is actually allowed to see. Otherwise a
// guest could read the hidden node list straight off the response headers.
function buildCsp(config, { authenticated = false, https = false } = {}) {
  const hideAllNodes = Boolean(config.settings.hideNodesForGuests) && !authenticated;
  const connectOrigins = new Set();
  const imageOrigins = new Set();
  let everyVisibleNodeIsHttps = true;

  for (const site of config.sites) {
    if (!authenticated && site.guestHidden) continue;
    const iconOrigin = externalOrigin(site.icon);
    if (iconOrigin) imageOrigins.add(iconOrigin);
    if (hideAllNodes) continue;
    for (const node of site.nodes) {
      if (!authenticated && node.guestHidden) continue;
      const origin = externalOrigin(node.url);
      if (!origin) continue;
      connectOrigins.add(origin);
      if (!origin.startsWith('https://')) everyVisibleNodeIsHttps = false;
    }
  }
  for (const field of ['icon', 'background', 'mobileBackground', 'adminBackground']) {
    const origin = externalOrigin(config.settings[field]);
    if (origin) imageOrigins.add(origin);
  }

  const imgSrc = ["'self'", 'data:', ...imageOrigins].join(' ');
  const connectSrc = ["'self'", ...connectOrigins].join(' ');
  const directives = [
    "default-src 'self'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "form-action 'self'",
    "object-src 'none'",
    `img-src ${imgSrc}`,
    "style-src 'self'",
    "script-src 'self'",
    `connect-src ${connectSrc}`,
  ];
  // Only force the upgrade when every visible node link is already HTTPS,
  // otherwise plain-HTTP bookmarks would stop working.
  if (https && everyVisibleNodeIsHttps) directives.push('upgrade-insecure-requests');
  return directives.join('; ');
}

function isHttpsRequest(request, trustProxy) {
  if (request.socket?.encrypted) return true;
  if (!trustProxy) return false;
  const forwarded = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return forwarded === 'https';
}

function applySecurityHeaders(
  response,
  { config, request, trustProxy, authenticated = false, hstsSubdomains = true },
) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  response.setHeader(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  );
  const https = isHttpsRequest(request, trustProxy);
  response.setHeader('Content-Security-Policy', buildCsp(config, { authenticated, https }));
  if (https) {
    response.setHeader(
      'Strict-Transport-Security',
      hstsSubdomains
        ? 'max-age=31536000; includeSubDomains'
        : 'max-age=31536000',
    );
  }
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function sendText(response, statusCode, message, extraHeaders = {}) {
  const body = Buffer.from(message);
  response.writeHead(statusCode, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

function sendEmpty(response, statusCode, extraHeaders = {}) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  response.end();
}

function requireMethod(request, allowed) {
  if (!allowed.includes(request.method)) {
    throw new HttpError(405, '请求方法不允许', { Allow: allowed.join(', ') });
  }
}

function clientIp(request, trustProxy) {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.trim()) {
      return forwarded.split(',')[0].trim();
    }
    const realIp = request.headers['x-real-ip'];
    if (typeof realIp === 'string' && realIp.trim()) return realIp.trim();
  }
  return request.socket.remoteAddress || 'unknown';
}

function readJson(request) {
  const contentType = String(request.headers['content-type'] || '');
  if (!/^application\/json\b/i.test(contentType)) {
    return Promise.reject(new HttpError(415, '请求体必须是 JSON'));
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, '请求内容过大'));
        return;
      }
      if (size === 0) {
        reject(new HttpError(400, '请求内容不能为空'));
        return;
      }
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new HttpError(400, '请求内容必须是 JSON 对象'));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'JSON 格式不正确'));
      }
    });

    request.on('error', reject);
  });
}

function requireString(value, field, { min = 1, max = 256 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new HttpError(400, `${field}格式不正确`);
  }
  return value;
}

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function hexToRgb(hex) {
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function mixHex(hex, targetHex, targetWeight) {
  const source = hexToRgb(hex);
  const target = hexToRgb(targetHex);
  const mix = (left, right) => Math.round(left * (1 - targetWeight) + right * targetWeight);
  return `#${[mix(source.r, target.r), mix(source.g, target.g), mix(source.b, target.b)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('')}`;
}

function rgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function buildThemeCss(config) {
  const color = config.settings.themeColor;
  if (!color) return '/* default theme */\n';
  const bg = mixHex(color, '#05070a', 0.9);
  const bgSoft = mixHex(color, '#070a0f', 0.86);
  const surface = mixHex(bg, '#ffffff', 0.055);
  const surfaceRaised = mixHex(bg, '#ffffff', 0.09);
  const surfaceSunken = mixHex(bg, '#000000', 0.35);
  const topGradient = mixHex(color, '#0b1017', 0.82);
  const bottomGradient = mixHex(color, '#030507', 0.95);
  return [
    ':root {',
    `  --accent: ${color};`,
    `  --accent-strong: ${mixHex(color, '#000000', 0.15)};`,
    `  --accent-soft: ${rgba(color, 0.12)};`,
    `  --bg: ${bg};`,
    `  --bg-soft: ${bgSoft};`,
    `  --surface: ${surface};`,
    `  --surface-raised: ${surfaceRaised};`,
    `  --surface-sunken: ${surfaceSunken};`,
    `  --border: ${rgba(mixHex(bg, '#ffffff', 0.22), 0.42)};`,
    `  --border-strong: ${rgba(mixHex(bg, '#ffffff', 0.32), 0.55)};`,
    '}',
    'body::before {',
    `  background: radial-gradient(circle at 50% -10%, ${rgba(color, 0.075)}, transparent 38%), radial-gradient(circle at 100% 0%, ${rgba(color, 0.045)}, transparent 30%), linear-gradient(180deg, ${topGradient} 0%, ${bg} 55%, ${bottomGradient} 100%) !important;`,
    '}',
    `.topbar { background: ${rgba(bg, 0.84)} !important; }`,
    `.admin-topbar { background: ${rgba(bg, 0.86)} !important; }`,
    '',
  ].join('\n');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isImageIcon(icon) {
  return /^https?:\/\//i.test(icon || '') || /^\/uploads\//.test(icon || '');
}

const DEFAULT_BRAND_ICON =
  '<svg viewBox="0 0 24 24" fill="none"><path d="M12 2.8 14.7 9l6.5 3-6.5 3L12 21.2 9.3 15l-6.5-3 6.5-3L12 2.8Z" /><circle cx="12" cy="12" r="2.2" /></svg>';

function faviconHref(icon) {
  if (isImageIcon(icon)) return icon;
  if (icon) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f141a"/><text x="32" y="34" text-anchor="middle" dominant-baseline="middle" font-size="40">${escapeHtml(icon)}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }
  return '/favicon.svg';
}

// Mirrors the client-side renderer: trailing characters pick up the accent
// colour. Doing it on the server keeps the first paint from flashing the
// built-in default name before app.js can replace it.
function brandTextMarkup(text) {
  const value = typeof text === 'string' ? text.trim() : '';
  const characters = Array.from(value);
  const tailLength = Math.min(3, characters.length);
  const head = characters.slice(0, characters.length - tailLength).join('');
  const tail = characters.slice(-tailLength).join('');
  return `${escapeHtml(head)}${tail ? `<em>${escapeHtml(tail)}</em>` : ''}`;
}

function brandIconMarkup(icon) {
  if (isImageIcon(icon)) {
    return `<img src="${escapeHtml(icon)}" alt="" referrerpolicy="no-referrer" />`;
  }
  if (icon) return escapeHtml(icon);
  return DEFAULT_BRAND_ICON;
}

function applyTemplate(template, replacements) {
  let html = template;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.replaceAll(`{{${key}}}`, value);
  }
  return html;
}

function commonReplacements(config) {
  const settings = config.settings;
  const title = settings.title || '导航页';
  const brandFont = ['mono', 'serif'].includes(settings.brandFont) ? settings.brandFont : 'sans';
  const transparency = Math.max(
    0,
    Math.min(100, Math.round(Number(settings.backgroundTransparency ?? 30) / 10) * 10),
  );
  return {
    THEME_COLOR: settings.themeColor || '#0b0d10',
    FAVICON_HREF: escapeHtml(faviconHref(settings.icon)),
    BODY_CLASS: `bg-transparency-${transparency}`,
    BRAND_ICON_BODY: brandIconMarkup(settings.icon),
    BRAND_FONT_CLASS: brandFont === 'sans' ? '' : ` brand-font-${brandFont}`,
    BRAND_TEXT_HIDDEN: settings.brandText ? '' : ' hidden',
    BRAND_TEXT_HTML: brandTextMarkup(settings.brandText),
  };
}

function renderIndexHtml(template, config) {
  const settings = config.settings;
  const title = settings.title || '导航页';
  const subtitle = settings.subtitle || '延迟测试完成后，点击显示延迟的节点进入站点。';
  const desktop = settings.background || '';
  const mobile = settings.mobileBackground || '';
  const hasBackground = Boolean(desktop || mobile);
  const common = commonReplacements(config);

  return applyTemplate(template, {
    ...common,
    // Text over a custom photo needs stronger scrims; the default backdrop is
    // dark enough on its own.
    BODY_CLASS: `${common.BODY_CLASS}${hasBackground ? ' has-bg-image' : ''}`,
    TITLE: escapeHtml(title),
    SUBTITLE: escapeHtml(subtitle),
    DESCRIPTION: escapeHtml(`${title} · ${config.sites.length} 个站点`),
    PRELOAD: desktop
      ? `<link rel="preload" as="image" href="${escapeHtml(desktop)}" fetchpriority="high" />`
      : '',
    BACKGROUND_CLASS: mobile ? ' has-mobile' : '',
    BACKGROUND_HIDDEN: hasBackground ? '' : ' hidden',
    BACKGROUND_DESKTOP: desktop ? ` src="${escapeHtml(desktop)}"` : '',
    BACKGROUND_MOBILE: mobile ? ` src="${escapeHtml(mobile)}"` : '',
    FOOTER_META: escapeHtml(`${settings.brandText || title} · 自托管导航页`),
  });
}

function renderAdminHtml(template, config) {
  const settings = config.settings;
  const adminBackground = settings.adminBackground || '';
  return applyTemplate(template, {
    ...commonReplacements(config),
    ADMIN_TITLE: escapeHtml(`管理后台 · ${settings.title || '导航页'}`),
    BACKGROUND_HIDDEN: adminBackground ? '' : ' hidden',
    BACKGROUND_DESKTOP: adminBackground ? ` src="${escapeHtml(adminBackground)}"` : '',
  });
}

function detectImageType(buffer) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return { extension: 'png', mime: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', mime: 'image/jpeg' };
  }
  if (
    buffer.length >= 6 &&
    buffer.subarray(0, 6).toString('ascii') === 'GIF87a'
  ) {
    return { extension: 'gif', mime: 'image/gif' };
  }
  if (
    buffer.length >= 6 &&
    buffer.subarray(0, 6).toString('ascii') === 'GIF89a'
  ) {
    return { extension: 'gif', mime: 'image/gif' };
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', mime: 'image/webp' };
  }
  return null;
}

function readBinary(request, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (tooLarge) {
        reject(new HttpError(413, `图片不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`));
        return;
      }
      if (size === 0) {
        reject(new HttpError(400, '上传内容为空'));
        return;
      }
      resolve(Buffer.concat(chunks));
    });

    request.on('error', reject);
  });
}

export async function createApplication({
  dataDir,
  initialPassword,
  cookieSecure = false,
  trustProxy = false,
  hstsSubdomains = true,
  logger = console,
  probe,
} = {}) {
  if (!dataDir) throw new Error('必须提供 dataDir');

  const store = await new ConfigStore(dataDir).init({ initialPassword });
  const uploadDir = path.join(dataDir, 'uploads');
  await fs.mkdir(uploadDir, { recursive: true });
  const sessions = new SessionManager();
  const loginLimiter = new LoginLimiter();
  const pingLimiter = new RateLimiter({ limit: 300, windowMs: 60 * 1000 });
  const probes = new ProbeService({ concurrency: 16, maxQueue: 400, runner: probe });
  const pingCache = new Map();
  const pingInflight = new Map();

  function findNode(nodeId) {
    const config = store.get();
    for (const site of config.sites) {
      for (const node of site.nodes) {
        if (node.id === nodeId) return { site, node };
      }
    }
    return null;
  }

  async function listUploads() {
    const entries = await fs.readdir(uploadDir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter(
        (entry) =>
          entry.isFile() && /^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/.test(entry.name),
      )
      .slice(0, 500);

    const items = await Promise.all(
      files.map(async (entry) => {
        const stats = await fs.stat(path.join(uploadDir, entry.name));
        return {
          url: `/uploads/${entry.name}`,
          size: stats.size,
          modifiedAt: stats.mtime.toISOString(),
        };
      }),
    );

    return items.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
  }

  function cachePing(key, result, checkedAt) {
    pingCache.set(key, { result, checkedAt });
    if (pingCache.size > 500) {
      const oldestAllowed = Date.now() - PING_CACHE_TTL_MS * 2;
      for (const [cacheKey, entry] of pingCache) {
        if (entry.checkedAt < oldestAllowed) pingCache.delete(cacheKey);
      }
    }
  }

  async function measureNode(node, timeoutMs) {
    const key = `${node.url}|${timeoutMs}`;
    const now = Date.now();
    const cached = pingCache.get(key);

    if (cached && now - cached.checkedAt < PING_CACHE_TTL_MS) {
      return {
        ...cached.result,
        nodeId: node.id,
        checkedAt: new Date(cached.checkedAt).toISOString(),
        cached: true,
      };
    }

    let pending = pingInflight.get(key);
    if (!pending) {
      pending = probes
        .probe(node.url, timeoutMs)
        .then((result) => {
          const checkedAt = Date.now();
          cachePing(key, result, checkedAt);
          return { result, checkedAt };
        })
        .finally(() => pingInflight.delete(key));
      pingInflight.set(key, pending);
    }

    const measured = await pending;
    return {
      ...measured.result,
      nodeId: node.id,
      checkedAt: new Date(measured.checkedAt).toISOString(),
      cached: false,
    };
  }

  function getSession(request) {
    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    return { token, session: sessions.get(token) };
  }

  function requireAdmin(request) {
    const { token, session } = getSession(request);
    if (!session) throw new HttpError(401, '请先登录后台');
    return { token, session };
  }

  function requireCsrf(request, session) {
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || token !== session.csrfToken) {
      throw new HttpError(403, 'CSRF 校验失败，请刷新页面后重试');
    }
  }

  async function handleApi(request, response, pathname) {
    const ip = clientIp(request, trustProxy);

    if (pathname === '/api/health' && request.method === 'GET') {
      sendJson(response, 200, {
        ok: true,
        version: VERSION,
        uptimeSeconds: Math.round(process.uptime()),
      });
      return;
    }

    if (pathname === '/api/nav' && request.method === 'GET') {
      const config = store.get();
      const authenticated = Boolean(getSession(request).session);
      sendJson(response, 200, toPublicConfig(config, { authenticated }));
      return;
    }

    if (pathname === '/api/ping') {
      requireMethod(request, ['POST']);
      const config = store.get();
      const guest = !getSession(request).session;
      if (config.settings.hideNodesForGuests && guest) {
        throw new HttpError(403, '节点已设为隐藏，请先登录后台查看');
      }
      const rate = pingLimiter.consume(ip);
      if (!rate.allowed) {
        throw new HttpError(429, '延迟测试请求过于频繁，请稍后再试', {
          'Retry-After': String(rate.retryAfter),
        });
      }

      const body = await readJson(request);
      const nodeId = requireString(body.nodeId, '节点 ID', { max: 64 });
      const found = findNode(nodeId);
      if (!found) throw new HttpError(404, '节点不存在，请刷新页面');
      if (guest && found.site.guestHidden) {
        throw new HttpError(403, '该站点已设为仅登录可见');
      }
      if (guest && found.node.guestHidden) {
        throw new HttpError(403, '该节点已设为仅登录可见');
      }

      try {
        const result = await measureNode(found.node, config.settings.pingTimeoutMs);
        sendJson(response, 200, result);
      } catch (error) {
        if (error instanceof ProbeBusyError) throw error;
        logger.error?.('延迟测试失败', error);
        throw new HttpError(502, '延迟测试服务暂时不可用');
      }
      return;
    }

    if (pathname === '/api/admin/session' && request.method === 'GET') {
      const { session } = getSession(request);
      if (!session) {
        sendJson(response, 200, { authenticated: false });
        return;
      }
      sendJson(response, 200, {
        authenticated: true,
        csrfToken: session.csrfToken,
        username: store.get().settings.adminUsername || 'admin',
      });
      return;
    }

    if (pathname === '/api/admin/login') {
      requireMethod(request, ['POST']);
      const status = loginLimiter.status(ip);
      if (status.blocked) {
        throw new HttpError(429, '登录尝试过多，请稍后再试', {
          'Retry-After': String(status.retryAfter || 60),
        });
      }

      const body = await readJson(request);
      const username = typeof body.username === 'string' ? body.username.trim() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (username.length > 64 || password.length > 128) {
        throw new HttpError(400, '用户名或密码格式不正确');
      }
      if (!username) {
        throw new HttpError(400, '请输入管理员用户名');
      }

      const settings = store.get().settings;
      const expectedUsername = settings.adminUsername || 'admin';
      const usernameOk = constantTimeEqual(username, expectedUsername);
      const passwordOk = await verifyPassword(
        password,
        settings.passwordSalt,
        settings.passwordHash,
      );

      if (!usernameOk || !passwordOk) {
        loginLimiter.fail(ip);
        const next = loginLimiter.status(ip);
        if (next.blocked) {
          throw new HttpError(429, '登录尝试过多，登录已暂时锁定', {
            'Retry-After': String(next.retryAfter || 60),
          });
        }
        throw new HttpError(401, '用户名或密码错误');
      }

      loginLimiter.reset(ip);
      const session = sessions.create();
      sendJson(
        response,
        200,
        {
          ok: true,
          csrfToken: session.csrfToken,
          username: settings.adminUsername || 'admin',
        },
        { 'Set-Cookie': sessionCookie(session.token, { secure: cookieSecure }) },
      );
      return;
    }

    if (pathname === '/api/admin/logout') {
      requireMethod(request, ['POST']);
      const { token, session } = requireAdmin(request);
      requireCsrf(request, session);
      sessions.destroy(token);
      sendJson(
        response,
        200,
        { ok: true },
        { 'Set-Cookie': expiredSessionCookie({ secure: cookieSecure }) },
      );
      return;
    }

    if (pathname === '/api/admin/uploads') {
      requireMethod(request, ['GET', 'POST']);
      const { session } = requireAdmin(request);

      if (request.method === 'GET') {
        const items = await listUploads();
        sendJson(response, 200, { items });
        return;
      }

      requireCsrf(request, session);
      const existing = await listUploads();
      if (existing.length >= 500) {
        throw new HttpError(400, '上传图片数量已达上限，请先清理旧图片');
      }

      const buffer = await readBinary(request, UPLOAD_LIMIT);
      const imageType = detectImageType(buffer);
      if (!imageType) {
        throw new HttpError(415, '只支持 PNG、JPEG、WebP 或 GIF 图片');
      }

      const fileName = `${crypto.randomBytes(16).toString('hex')}.${imageType.extension}`;
      await fs.writeFile(path.join(uploadDir, fileName), buffer, {
        mode: 0o644,
        flag: 'wx',
      });
      sendJson(response, 201, {
        url: `/uploads/${fileName}`,
        size: buffer.length,
        mime: imageType.mime,
      });
      return;
    }

    if (pathname.startsWith('/api/admin/uploads/')) {
      requireMethod(request, ['DELETE']);
      const { session } = requireAdmin(request);
      requireCsrf(request, session);

      const fileName = pathname.slice('/api/admin/uploads/'.length);
      if (!/^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/.test(fileName)) {
        throw new HttpError(404, '图片不存在');
      }

      const config = store.get();
      const url = `/uploads/${fileName}`;
      const usages = [];
      const settingsFields = [
        ['icon', '导航页图标'],
        ['background', '电脑横屏背景'],
        ['mobileBackground', '手机竖屏背景'],
        ['adminBackground', '后台背景'],
      ];
      for (const [field, label] of settingsFields) {
        if (config.settings[field] === url) usages.push(label);
      }
      for (const site of config.sites) {
        if (site.icon === url) usages.push(`站点「${site.name}」图标`);
      }
      if (usages.length) {
        throw new HttpError(409, `该图片正在使用中：${usages.join('、')}，请先更换后再删除`);
      }

      try {
        await fs.unlink(path.join(uploadDir, fileName));
      } catch (error) {
        if (error.code === 'ENOENT') throw new HttpError(404, '图片不存在');
        throw error;
      }
      sendJson(response, 200, { ok: true, url });
      return;
    }

    if (pathname === '/api/admin/config') {
      requireMethod(request, ['GET', 'PUT']);
      requireAdmin(request);

      if (request.method === 'GET') {
        sendJson(response, 200, toAdminConfig(store.get()));
        return;
      }

      const { session } = requireAdmin(request);
      requireCsrf(request, session);
      const body = await readJson(request);
      const current = store.get();
      let next;
      try {
        next = normalizeConfig(body, { fallback: current, security: current.settings });
      } catch (error) {
        if (error instanceof ValidationError) throw error;
        throw error;
      }
      await store.replace(next);
      sendJson(response, 200, toAdminConfig(next));
      return;
    }

    if (pathname === '/api/admin/path') {
      requireMethod(request, ['POST']);
      const { session } = requireAdmin(request);
      requireCsrf(request, session);

      const body = await readJson(request);
      let nextPath;
      try {
        nextPath = normalizeAdminPath(body.adminPath);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      if (!nextPath) throw new HttpError(400, '请填写新的后台路径');

      const current = store.get();
      if (nextPath === current.settings.adminPath) {
        throw new HttpError(400, '新路径与当前路径相同');
      }
      const taken = STATIC_ROUTES.has(nextPath) || LEGACY_ADMIN_PATHS.has(nextPath);
      if (taken || nextPath === '/api' || nextPath === '/go' || nextPath === '/uploads') {
        throw new HttpError(400, '该路径已被占用，请换一个');
      }

      const next = structuredClone(current);
      next.settings.adminPath = nextPath;
      await store.replace(next);
      logger.info?.(`[DeepNav] 后台路径已更新为 ${nextPath}`);
      sendJson(response, 200, { config: toAdminConfig(next) });
      return;
    }

    if (pathname === '/api/admin/password') {
      requireMethod(request, ['POST']);
      const { session } = requireAdmin(request);
      requireCsrf(request, session);

      const body = await readJson(request);
      const currentPassword =
        typeof body.currentPassword === 'string' ? body.currentPassword : '';
      const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
      const newUsername =
        typeof body.newUsername === 'string' ? body.newUsername.trim() : '';
      const current = store.get();
      const wantUsernameChange = newUsername && newUsername !== current.settings.adminUsername;

      if (!newPassword && !wantUsernameChange) {
        throw new HttpError(400, '请填写新密码或新用户名');
      }
      if (newPassword && (newPassword.length < 8 || newPassword.length > 128)) {
        throw new HttpError(400, '新密码长度必须为 8 到 128 个字符');
      }
      if (newPassword && currentPassword === newPassword) {
        throw new HttpError(400, '新密码不能与当前密码相同');
      }
      if (wantUsernameChange) {
        if (!/^[A-Za-z0-9_.@-]{2,32}$/.test(newUsername)) {
          throw new HttpError(400, '用户名需为 2–32 位字母、数字或 _ . @ - 字符');
        }
      }

      const valid = await verifyPassword(
        currentPassword,
        current.settings.passwordSalt,
        current.settings.passwordHash,
      );
      if (!valid) throw new HttpError(400, '当前密码不正确');

      const next = structuredClone(current);
      if (wantUsernameChange) next.settings.adminUsername = newUsername;
      if (newPassword) {
        const credentials = await hashPassword(newPassword);
        Object.assign(next.settings, credentials, {
          passwordUpdatedAt: new Date().toISOString(),
          // Once the operator picks their own password the shipped default is
          // no longer in play.
          defaultCredentials: false,
        });
      }
      await store.replace(next);

      sessions.clear();
      const freshSession = sessions.create();
      sendJson(
        response,
        200,
        { ok: true, csrfToken: freshSession.csrfToken },
        { 'Set-Cookie': sessionCookie(freshSession.token, { secure: cookieSecure }) },
      );
      return;
    }

    throw new HttpError(404, '接口不存在');
  }

  async function serveStatic(request, response, pathname) {
    const fileName = STATIC_ROUTES.get(pathname);
    if (!fileName) throw new HttpError(404, '页面不存在');
    await serveFile(request, response, fileName);
  }

  async function serveFile(request, response, fileName) {
    const filePath = path.join(PUBLIC_DIR, fileName);
    let content;
    try {
      content = await fs.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, '页面不存在');
      throw error;
    }

    if (fileName === 'index.html') {
      content = Buffer.from(renderIndexHtml(content.toString('utf8'), store.get()));
    } else if (fileName === 'admin.html') {
      content = Buffer.from(renderAdminHtml(content.toString('utf8'), store.get()));
    }
    const contentType = MIME_TYPES[path.extname(fileName)] || 'application/octet-stream';
    const headers = {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    };
    // The CSP now depends on who is asking, so any shared cache in front of the
    // site must key HTML documents by session cookie as well.
    if (/^text\/html\b/.test(contentType)) {
      headers.Vary = 'Cookie, X-Forwarded-Proto';
      // The admin console must never be indexed, even though its URL is random.
      if (fileName === 'admin.html') headers['X-Robots-Tag'] = 'noindex, nofollow';
    }
    response.writeHead(200, headers);
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(content);
  }

  async function handler(request, response) {
    applySecurityHeaders(response, {
      config: store.get(),
      request,
      trustProxy,
      authenticated: Boolean(getSession(request).session),
      hstsSubdomains,
    });

    try {
      const parsedUrl = new URL(request.url || '/', 'http://localhost');
      let pathname;
      try {
        pathname = decodeURIComponent(parsedUrl.pathname);
      } catch {
        throw new HttpError(400, '请求路径不正确');
      }

      if (pathname.startsWith('/api/')) {
        await handleApi(request, response, pathname);
        return;
      }

      if (pathname === '/theme.css') {
        if (request.method !== 'GET') {
          throw new HttpError(405, '请求方法不允许', { Allow: 'GET' });
        }
        const css = Buffer.from(buildThemeCss(store.get()));
        response.writeHead(200, {
          'Content-Type': 'text/css; charset=utf-8',
          'Content-Length': css.length,
          'Cache-Control': 'no-store',
        });
        response.end(css);
        return;
      }

      if (pathname.startsWith('/uploads/')) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          throw new HttpError(405, '请求方法不允许', { Allow: 'GET, HEAD' });
        }
        const fileName = pathname.slice('/uploads/'.length);
        if (!/^[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/.test(fileName)) {
          throw new HttpError(404, '图片不存在');
        }
        const filePath = path.join(uploadDir, fileName);
        let content;
        try {
          content = await fs.readFile(filePath);
        } catch (error) {
          if (error.code === 'ENOENT') throw new HttpError(404, '图片不存在');
          throw error;
        }
        const extension = path.extname(fileName).slice(1);
        response.writeHead(200, {
          'Content-Type': MIME_TYPES[`.${extension}`] || 'application/octet-stream',
          'Content-Length': content.length,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Content-Disposition': 'inline',
          'Content-Security-Policy': "default-src 'none'; sandbox",
          'X-Robots-Tag': 'noindex, nofollow',
        });
        if (request.method === 'HEAD') response.end();
        else response.end(content);
        return;
      }

      if (pathname.startsWith('/go/')) {
        if (request.method !== 'GET') {
          throw new HttpError(405, '请求方法不允许', { Allow: 'GET' });
        }
        const config = store.get();
        const guest = !getSession(request).session;
        if (config.settings.hideNodesForGuests && guest) {
          throw new HttpError(403, '节点已设为隐藏，请先登录后台查看');
        }
        const nodeId = pathname.slice('/go/'.length);
        const found = nodeId.length <= 64 ? findNode(nodeId) : null;
        if (!found) throw new HttpError(404, '节点不存在');
        if (guest && found.site.guestHidden) {
          throw new HttpError(403, '该站点已设为仅登录可见');
        }
        if (guest && found.node.guestHidden) {
          throw new HttpError(403, '该节点已设为仅登录可见');
        }
        response.writeHead(302, {
          Location: found.node.url,
          'Cache-Control': 'no-store',
          'X-Robots-Tag': 'noindex, nofollow',
        });
        response.end();
        return;
      }

      // The admin console answers on the configured secret path only.
      const adminPath = store.get().settings.adminPath;
      if (pathname === adminPath || pathname === `${adminPath}/`) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          throw new HttpError(405, '请求方法不允许', { Allow: 'GET, HEAD' });
        }
        await serveFile(request, response, 'admin.html');
        return;
      }

      if (LEGACY_ADMIN_PATHS.has(pathname)) {
        // No redirect: that would confirm the console exists somewhere else.
        throw new HttpError(404, '页面不存在');
      }

      if (request.method !== 'GET' && request.method !== 'HEAD') {
        throw new HttpError(405, '请求方法不允许', { Allow: 'GET, HEAD' });
      }
      await serveStatic(request, response, pathname);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      if (error instanceof HttpError || error instanceof ValidationError) {
        sendJson(response, error.statusCode || 400, { error: error.message }, error.headers || {});
        return;
      }
      if (error instanceof ProbeBusyError) {
        sendJson(response, 503, { error: error.message });
        return;
      }
      logger.error?.('请求处理失败', error);
      sendJson(response, 500, { error: '服务器内部错误' });
    }
  }

  const server = http.createServer(handler);
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 5_000;

  async function close() {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections?.();
      setTimeout(() => server.closeAllConnections?.(), 2000).unref?.();
    });
    await store.close();
  }

  return {
    server,
    store,
    sessions,
    close,
    generatedPassword: store.generatedPassword,
    firstRun: store.firstRun,
  };
}
