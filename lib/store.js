import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword } from './security.js';

export const LIMITS = Object.freeze({
  groups: 40,
  sites: 300,
  nodesPerSite: 12,
  title: 60,
  subtitle: 160,
  description: 200,
  groupName: 30,
  siteName: 60,
  nodeName: 40,
  iconText: 8,
  iconUrl: 2048,
  brandText: 24,
  url: 2048,
});

export class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

const ADMIN_PATH_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

// Fixed defaults so a fresh install has a documented address and login. They
// are not secret: the point is that the console is not advertised on the home
// page and sits off the well-known /admin. Operators are prompted to change
// both after the first login.
export const DEFAULT_ADMIN_PATH = '/m-deepnav';
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = 'DeepNav@2026';

// Used when an operator asks for a new random path from the admin console.
export function generateAdminPath() {
  const bytes = crypto.randomBytes(20);
  let slug = '';
  for (const byte of bytes) slug += ADMIN_PATH_ALPHABET[byte % ADMIN_PATH_ALPHABET.length];
  return `/m-${slug}`;
}

export function normalizeAdminPath(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  if (!/^\/[a-z0-9][a-z0-9-]{5,47}$/.test(raw)) {
    throw new ValidationError(
      '后台路径须以 / 开头，由 6-48 位小写字母、数字或短横线组成，例如 /m-deepnav',
    );
  }
  const reserved = ['/api', '/go', '/uploads', '/index.html', '/styles.css', '/app.js', '/favicon.svg'];
  if (reserved.some((prefix) => raw === prefix || raw.startsWith(`${prefix}/`))) {
    throw new ValidationError('后台路径不能与既有保留路径冲突');
  }
  return raw;
}

export function createDefaultConfig() {
  return {
    version: 1,
    settings: {
      title: '导航页',
      subtitle: '自动延迟测试，选择一个顺畅的入口',
      icon: '',
      brandText: 'DEEPNAV',
      brandFont: 'sans',
      background: '',
      mobileBackground: '',
      adminBackground: '',
      backgroundTransparency: 30,
      themeColor: '',
      autoRefreshSeconds: 60,
      pingTimeoutMs: 5000,
      openInNewTab: true,
      showOffline: true,
      hideNodesForGuests: false,
      passwordHash: null,
      passwordSalt: null,
      passwordUpdatedAt: null,
      adminUsername: DEFAULT_ADMIN_USERNAME,
      adminPath: DEFAULT_ADMIN_PATH,
      // Cleared once the operator sets a password of their own.
      defaultCredentials: true,
    },
    groups: [
      {
        id: crypto.randomUUID(),
        name: '常用站点',
      },
    ],
    sites: [],
  };
}

function asObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${label}格式不正确`);
  }
  return value;
}

function text(value, max, label, { required = false } = {}) {
  const result = typeof value === 'string' ? value.trim() : '';
  if (required && !result) throw new ValidationError(`${label}不能为空`);
  if (result.length > max) throw new ValidationError(`${label}不能超过 ${max} 个字符`);
  return result;
}

function integer(value, min, max, label, fallback) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new ValidationError(`${label}必须是 ${min} 到 ${max} 之间的整数`);
  }
  return number;
}

function boolean(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function validId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(value);
}

export function normalizeTargetUrl(input) {
  let raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new ValidationError('地址不能为空');
  if (raw.length > LIMITS.url) throw new ValidationError(`地址不能超过 ${LIMITS.url} 个字符`);
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) raw = `https://${raw}`;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError('地址格式不正确，请填写完整网址');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ValidationError('只支持 http:// 或 https:// 地址');
  }
  if (!parsed.hostname) throw new ValidationError('地址中缺少域名');
  if (parsed.username || parsed.password) {
    throw new ValidationError('地址中不能包含用户名或密码');
  }

  return parsed.toString();
}

function normalizeIcon(input, label) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  if (raw.length > LIMITS.iconUrl) throw new ValidationError(`${label}不能超过 ${LIMITS.iconUrl} 个字符`);

  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ValidationError(`${label}链接格式不正确`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new ValidationError(`${label}只支持 http:// 或 https:// 链接`);
    }
    if (parsed.username || parsed.password) {
      throw new ValidationError(`${label}链接中不能包含用户名或密码`);
    }
    return parsed.toString();
  }

  if (raw.startsWith('/uploads/')) {
    if (!/^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/.test(raw)) {
      throw new ValidationError(`${label}上传路径不正确`);
    }
    return raw;
  }

  if (Array.from(raw).length > LIMITS.iconText) {
    throw new ValidationError(`${label}请填写一个 emoji 或图片链接`);
  }
  return raw;
}

function normalizeBackground(input, label) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  if (raw.length > LIMITS.iconUrl) throw new ValidationError(`${label}不能超过 ${LIMITS.iconUrl} 个字符`);

  if (/^https?:\/\//i.test(raw)) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      throw new ValidationError(`${label}链接格式不正确`);
    }
    if (parsed.username || parsed.password) {
      throw new ValidationError(`${label}链接中不能包含用户名或密码`);
    }
    return parsed.toString();
  }

  if (/^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/.test(raw)) {
    return raw;
  }

  throw new ValidationError(`${label}请填写图片链接或使用本地上传`);
}

function normalizeThemeColor(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) return '';
  if (!/^#[0-9a-fA-F]{6}$/.test(raw)) {
    throw new ValidationError('主题颜色必须是 #RRGGBB 格式');
  }
  return raw.toLowerCase();
}

function normalizeSettings(input, fallback, security) {
  const raw = input && typeof input === 'object' ? input : {};
  const base = fallback || createDefaultConfig().settings;
  const source = security || base;

  return {
    title: text(raw.title === undefined ? base.title : raw.title, LIMITS.title, '导航标题', {
      required: true,
    }),
    subtitle: text(raw.subtitle === undefined ? base.subtitle : raw.subtitle, LIMITS.subtitle, '副标题'),
    icon: normalizeIcon(raw.icon === undefined ? base.icon : raw.icon, '导航页图标'),
    brandText: text(
      raw.brandText === undefined ? base.brandText : raw.brandText,
      LIMITS.brandText,
      '顶部品牌文字',
    ),
    brandFont: (() => {
      const value = raw.brandFont === undefined ? base.brandFont || 'sans' : raw.brandFont;
      if (!['sans', 'mono', 'serif'].includes(value)) {
        throw new ValidationError('顶部品牌字体不在允许范围内');
      }
      return value;
    })(),
    background: normalizeBackground(
      raw.background === undefined ? base.background : raw.background,
      '前台背景图片',
    ),
    mobileBackground: normalizeBackground(
      raw.mobileBackground === undefined ? base.mobileBackground : raw.mobileBackground,
      '手机竖屏背景图片',
    ),
    adminBackground: normalizeBackground(
      raw.adminBackground === undefined ? base.adminBackground : raw.adminBackground,
      '后台背景图片',
    ),
    backgroundTransparency: Math.round(
      integer(
        raw.backgroundTransparency,
        0,
        100,
        '背景遮罩透明度',
        base.backgroundTransparency ?? 30,
      ) / 10,
    ) * 10,
    themeColor: normalizeThemeColor(
      raw.themeColor === undefined ? base.themeColor : raw.themeColor,
    ),
    autoRefreshSeconds: integer(
      raw.autoRefreshSeconds,
      15,
      3600,
      '自动延迟测试间隔',
      base.autoRefreshSeconds ?? 60,
    ),
    pingTimeoutMs: integer(raw.pingTimeoutMs, 1000, 15000, '延迟测试超时', base.pingTimeoutMs ?? 5000),
    openInNewTab: boolean(raw.openInNewTab, base.openInNewTab ?? true),
    showOffline: boolean(raw.showOffline, base.showOffline ?? true),
    hideNodesForGuests: boolean(
      raw.hideNodesForGuests,
      base.hideNodesForGuests ?? false,
    ),
    passwordHash: source.passwordHash || null,
    passwordSalt: source.passwordSalt || null,
    passwordUpdatedAt: source.passwordUpdatedAt || null,
    adminUsername: source.adminUsername || DEFAULT_ADMIN_USERNAME,
    adminPath:
      normalizeAdminPath(raw.adminPath === undefined ? base.adminPath : raw.adminPath) ||
      DEFAULT_ADMIN_PATH,
    // Security-relevant: only the server may clear this flag, never a client
    // payload that happens to omit it.
    defaultCredentials: source.defaultCredentials !== false,
  };
}

function normalizeGroups(input, fallback) {
  let raw = input;
  if (!Array.isArray(raw)) raw = fallback?.groups;
  if (!Array.isArray(raw) || raw.length === 0) {
    raw = createDefaultConfig().groups;
  }
  if (raw.length > LIMITS.groups) {
    throw new ValidationError(`分组数量不能超过 ${LIMITS.groups} 个`);
  }

  const used = new Set();
  return raw.map((entry, index) => {
    const group = asObject(entry, `第 ${index + 1} 个分组`);
    let id = validId(group.id) && !used.has(group.id) ? group.id : crypto.randomUUID();
    while (used.has(id)) id = crypto.randomUUID();
    used.add(id);
    return {
      id,
      name: text(group.name, LIMITS.groupName, '分组名称', { required: true }),
    };
  });
}

function normalizeNodes(input, siteName, usedNodeIds) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError(`站点「${siteName}」至少需要一个地址`);
  }
  if (input.length > LIMITS.nodesPerSite) {
    throw new ValidationError(`每个站点最多 ${LIMITS.nodesPerSite} 个地址`);
  }

  return input.map((entry, index) => {
    const node = asObject(entry, `站点「${siteName}」的第 ${index + 1} 个地址`);
    const url = normalizeTargetUrl(node.url);
    let id = validId(node.id) && !usedNodeIds.has(node.id) ? node.id : crypto.randomUUID();
    while (usedNodeIds.has(id)) id = crypto.randomUUID();
    usedNodeIds.add(id);

    let fallbackName;
    try {
      fallbackName = new URL(url).hostname;
    } catch {
      fallbackName = `节点 ${index + 1}`;
    }

    return {
      id,
      name: text(node.name, LIMITS.nodeName, '节点名称') || fallbackName,
      url,
      guestHidden: boolean(node.guestHidden, false),
    };
  });
}

function normalizeSites(input, groups) {
  const raw = Array.isArray(input) ? input : [];
  if (raw.length > LIMITS.sites) {
    throw new ValidationError(`站点数量不能超过 ${LIMITS.sites} 个`);
  }

  const currentGroupIds = new Set(groups.map((group) => group.id));
  const defaultGroupId = groups[0].id;
  const used = new Set();
  const usedNodeIds = new Set();

  return raw.map((entry, index) => {
    const site = asObject(entry, `第 ${index + 1} 个站点`);
    const name = text(site.name, LIMITS.siteName, '站点名称', { required: true });
    let id = validId(site.id) && !used.has(site.id) ? site.id : crypto.randomUUID();
    while (used.has(id)) id = crypto.randomUUID();
    used.add(id);

    const groupId =
      validId(site.groupId) && currentGroupIds.has(site.groupId) ? site.groupId : defaultGroupId;
    const icon = normalizeIcon(site.icon, '站点图标');

    return {
      id,
      groupId,
      name,
      description: text(site.description, LIMITS.description, '站点描述'),
      icon,
      guestHidden: boolean(site.guestHidden, false),
      nodes: normalizeNodes(site.nodes, name, usedNodeIds),
    };
  });
}

export function normalizeConfig(input, { fallback, security } = {}) {
  const base = fallback || createDefaultConfig();
  const raw = asObject(input, '配置');
  const groups = normalizeGroups(raw.groups, base);
  const sites = normalizeSites(raw.sites, groups);

  return {
    version: 1,
    settings: normalizeSettings(raw.settings, base.settings, security),
    groups,
    sites,
  };
}

export function toPublicConfig(config, { authenticated = false } = {}) {
  const hideAll = config.settings.hideNodesForGuests && !authenticated;
  const visibleSites = authenticated
    ? config.sites
    : config.sites.filter((site) => !site.guestHidden);
  const hiddenSiteCount = config.sites.length - visibleSites.length;

  const sites = visibleSites.map((site) => {
    if (hideAll) return { ...site, nodes: [] };
    if (authenticated) return site;
    // Guests get no hint that hidden nodes exist: not the count, not the
    // per-site tally, nothing that could confirm a guess.
    return { ...site, nodes: site.nodes.filter((node) => !node.guestHidden) };
  });

  const settings = {
    title: config.settings.title,
    subtitle: config.settings.subtitle,
    icon: config.settings.icon || '',
    brandText: config.settings.brandText || '',
    brandFont: config.settings.brandFont || 'sans',
    background: config.settings.background || '',
    mobileBackground: config.settings.mobileBackground || '',
    backgroundTransparency: config.settings.backgroundTransparency ?? 30,
    themeColor: config.settings.themeColor || '',
    autoRefreshSeconds: config.settings.autoRefreshSeconds,
    pingTimeoutMs: config.settings.pingTimeoutMs,
    openInNewTab: config.settings.openInNewTab,
    showOffline: config.settings.showOffline,
    authenticated: Boolean(authenticated),
  };
  if (authenticated) {
    settings.hideNodesForGuests = Boolean(config.settings.hideNodesForGuests);
  }

  return {
    settings,
    // Drop groups that only contain hidden sites, but keep groups when no
    // site has been configured yet (fresh install) or nothing is hidden.
    groups:
      hiddenSiteCount === 0 || config.sites.length === 0
        ? config.groups
        : config.groups.filter((group) => sites.some((site) => site.groupId === group.id)),
    sites,
  };
}

export function toAdminConfig(config) {
  return {
    version: config.version,
    settings: {
      title: config.settings.title,
      subtitle: config.settings.subtitle,
      icon: config.settings.icon || '',
      brandText: config.settings.brandText || '',
      brandFont: config.settings.brandFont || 'sans',
      background: config.settings.background || '',
      mobileBackground: config.settings.mobileBackground || '',
      adminBackground: config.settings.adminBackground || '',
      backgroundTransparency: config.settings.backgroundTransparency ?? 30,
      themeColor: config.settings.themeColor || '',
      autoRefreshSeconds: config.settings.autoRefreshSeconds,
      pingTimeoutMs: config.settings.pingTimeoutMs,
      openInNewTab: config.settings.openInNewTab,
      showOffline: config.settings.showOffline,
      hideNodesForGuests: Boolean(config.settings.hideNodesForGuests),
      adminUsername: config.settings.adminUsername || DEFAULT_ADMIN_USERNAME,
      adminPath: config.settings.adminPath,
      defaultCredentials: config.settings.defaultCredentials !== false,
      passwordUpdatedAt: config.settings.passwordUpdatedAt,
      hasPassword: Boolean(config.settings.passwordHash),
    },
    groups: config.groups,
    sites: config.sites,
  };
}

async function writeAtomic(file, content) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, content, { mode: 0o600 });
  try {
    await fs.rename(temporary, file);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
    await fs.rm(file, { force: true });
    await fs.rename(temporary, file);
  }
}

export class ConfigStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.file = path.join(dataDir, 'config.json');
    this.data = null;
    this.writeChain = Promise.resolve();
    this.generatedPassword = null;
    this.firstRun = false;
  }

  async init({ initialPassword } = {}) {
    await fs.mkdir(this.dataDir, { recursive: true });

    let parsed = null;
    try {
      const source = await fs.readFile(this.file, 'utf8');
      parsed = JSON.parse(source);
    } catch (error) {
      if (error.code !== 'ENOENT') {
        const backup = `${this.file}.invalid-${Date.now()}`;
        await fs.rename(this.file, backup).catch(() => {});
        throw new Error(
          `无法读取 ${this.file}（${error.message}）。原文件已备份到 ${backup}，请修复或删除后重启。`,
        );
      }
    }

    if (parsed) {
      this.data = normalizeConfig(parsed, { security: parsed?.settings });
    } else {
      this.data = createDefaultConfig();
    }

    // Configs written before the admin path existed get one now, and it must be
    // persisted immediately: otherwise every restart would mint a new path.
    const needsAdminPath = parsed && !parsed.settings?.adminPath;
    // An install that already had a password hash predates the shipped default,
    // so its operator has clearly picked their own credentials.
    const legacyCredentials = parsed && parsed.settings?.defaultCredentials === undefined;
    if (legacyCredentials) this.data.settings.defaultCredentials = false;

    if (!this.data.settings.passwordHash) {
      const password = initialPassword || DEFAULT_ADMIN_PASSWORD;
      if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        throw new Error('ADMIN_PASSWORD 必须为 8 到 128 个字符');
      }
      if (
        initialPassword &&
        ['please-change-this-password', 'change-me', 'changeme', 'admin123', 'password'].includes(
          password.toLowerCase(),
        )
      ) {
        throw new Error('ADMIN_PASSWORD 仍是示例弱密码，请先修改 .env 中的密码');
      }
      const credentials = await hashPassword(password);
      Object.assign(this.data.settings, credentials, {
        passwordUpdatedAt: new Date().toISOString(),
        // Only mark the shipped default as "still default"; an operator-supplied
        // password counts as already chosen.
        defaultCredentials: initialPassword ? false : true,
      });
      this.generatedPassword = initialPassword ? null : password;
      this.firstRun = !initialPassword;
      await this.save();
    } else if (needsAdminPath || legacyCredentials) {
      await this.save();
    }

    return this;
  }

  get() {
    if (!this.data) throw new Error('数据存储尚未初始化');
    return this.data;
  }

  async replace(nextConfig) {
    this.data = nextConfig;
    await this.save();
    return this.data;
  }

  async save() {
    const content = `${JSON.stringify(this.data, null, 2)}\n`;
    const write = this.writeChain
      .catch(() => {})
      .then(() => writeAtomic(this.file, content));
    this.writeChain = write;
    await write;
  }

  async close() {
    await this.writeChain.catch(() => {});
  }
}
