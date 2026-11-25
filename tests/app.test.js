import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createApplication } from '../lib/app.js';
import { buildPingArguments, parsePingLatency } from '../lib/ping.js';
import { normalizeConfig } from '../lib/store.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

test('parses Linux and Windows ping latency output', () => {
  assert.equal(
    parsePingLatency('64 bytes from 1.1.1.1: seq=0 ttl=42 time=12.34 ms'),
    12.3,
  );
  assert.equal(
    parsePingLatency('来自 127.0.0.1 的回复: 字节=32 时间=8ms TTL=128'),
    8,
  );
  assert.equal(parsePingLatency('64 bytes from 127.0.0.1: time<1ms'), 1);
  assert.equal(parsePingLatency('Request timeout for icmp_seq 0'), null);
  assert.deepEqual(buildPingArguments('example.com', 2000, 'linux'), [
    '-n',
    '-c',
    '1',
    '-W',
    '2',
    '-w',
    '2',
    'example.com',
  ]);
  assert.deepEqual(buildPingArguments('example.com', 2000, 'win32'), [
    '-n',
    '1',
    '-w',
    '2000',
    'example.com',
  ]);
});

test('node IDs are unique across the whole navigation page', () => {
  const config = normalizeConfig({
    settings: { title: '测试' },
    groups: [{ id: 'group-id-1', name: '分组' }],
    sites: [
      {
        id: 'site-id-1',
        groupId: 'group-id-1',
        name: '站点一',
        nodes: [{ id: 'node-shared-1', name: 'A', url: 'https://example.com' }],
      },
      {
        id: 'site-id-2',
        groupId: 'group-id-1',
        name: '站点二',
        nodes: [{ id: 'node-shared-1', name: 'B', url: 'https://example.org' }],
      },
    ],
  });

  const ids = config.sites.flatMap((site) => site.nodes.map((node) => node.id));
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(config.sites[0].nodes[0].id, 'node-shared-1');
});

test('DeepNav end-to-end API flow', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepnav-test-'));
  const fakeProbe = async (url) => {
    const host = new URL(url).hostname;
    if (host === 'online.example') {
      return { ok: true, latencyMs: 12.3, protocol: 'icmp', error: null, code: null };
    }
    return {
      ok: false,
      latencyMs: null,
      protocol: 'icmp',
      error: 'ICMP 超时',
      code: 'ETIMEDOUT',
    };
  };

  const app = await createApplication({
    dataDir,
    initialPassword: 'test-password-123',
    logger: { error() {} },
    probe: fakeProbe,
  });
  const port = await listen(app.server);
  const base = `http://127.0.0.1:${port}`;
  // The admin console is served from a random path that differs on every fresh
  // install; read it back from the store instead of hard-coding /admin.
  const adminPath = app.store.get().settings.adminPath;
  let cookie = '';
  let csrf = '';
  let uploadedIconUrl = '';

  async function request(pathname, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (options.csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`${base}${pathname}`, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const setCookie =
      typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()[0]
        : response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return { response, json: await readJson(response) };
  }

  t.after(async () => {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await t.test('serves health, navigation page and security headers', async () => {
    const health = await request('/api/health');
    assert.equal(health.response.status, 200);
    assert.equal(health.json.ok, true);

    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /DEEPNAV/);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /img-src 'self' data:/);
    assert.match(csp, /connect-src 'self'/);
    assert.doesNotMatch(csp, /https: http:/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(page.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(page.headers.get('x-permitted-cross-domain-policies'), 'none');
    assert.equal(page.headers.get('strict-transport-security'), null);

    const admin = await fetch(`${base}${adminPath}`);
    assert.equal(admin.status, 200);
    assert.match(await admin.text(), /登录管理后台/);
    assert.match(adminPath, /^\/m-deepnav$/, 'fresh installs use the documented admin path');
    assert.equal(admin.headers.get('x-robots-tag'), 'noindex, nofollow');

    // The well-known path is gone and does not redirect to the real one.
    for (const legacy of ['/admin', '/admin/', '/admin.html']) {
      const response = await fetch(`${base}${legacy}`);
      assert.equal(response.status, 404, `${legacy} must not exist`);
    }

    const blocked = await fetch(`${base}/%2e%2e/server.js`);
    assert.equal(blocked.status, 404);
  });

  await t.test('keeps the admin path out of the public payload', async () => {    const nav = await request('/api/nav');
    assert.equal(nav.response.status, 200);
    const raw = JSON.stringify(nav.json);
    assert.equal(nav.json.settings.adminPath, undefined);
    assert.doesNotMatch(raw, /adminPath|adminPath/i);

    const page = await (await fetch(`${base}/`)).text();
    assert.doesNotMatch(page, new RegExp(adminPath), 'home page must not link the console');
    assert.doesNotMatch(page, /管理后台/);
  });

  await t.test('returns only public settings', async () => {
    const { response, json } = await request('/api/nav');
    assert.equal(response.status, 200);
    assert.equal(json.sites.length, 0);
    assert.ok(json.groups.length >= 1);
    assert.equal(json.settings.passwordHash, undefined);
    assert.equal(json.settings.passwordSalt, undefined);
  });

  await t.test('rejects unauthenticated and incorrectly authenticated admin actions', async () => {
    const config = await request('/api/admin/config');
    assert.equal(config.response.status, 401);

    const wrong = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'admin', password: 'wrong-password' },
    });
    assert.equal(wrong.response.status, 401);
    assert.equal(wrong.json.error, '用户名或密码错误');

    const wrongUser = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'root', password: 'test-password-123' },
    });
    assert.equal(wrongUser.response.status, 401);
    assert.equal(wrongUser.json.error, '用户名或密码错误');

    const login = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'admin', password: 'test-password-123' },
    });
    assert.equal(login.response.status, 200);
    assert.ok(login.json.csrfToken);
    csrf = login.json.csrfToken;
  });

  await t.test('uploads and lists local icon images', async () => {
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2ZQAAAABJRU5ErkJggg==',
      'base64',
    );
    const uploadPath = '/api/admin/uploads';

    const withoutCsrf = await fetch(`${base}${uploadPath}`, {
      method: 'POST',
      headers: { Cookie: cookie, 'Content-Type': 'image/png' },
      body: png,
    });
    assert.equal(withoutCsrf.status, 403);

    const invalid = await fetch(`${base}${uploadPath}`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'image/png',
        'X-CSRF-Token': csrf,
      },
      body: Buffer.from('this is not an image'),
    });
    assert.equal(invalid.status, 415);

    const upload = await fetch(`${base}${uploadPath}`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'image/png',
        'X-CSRF-Token': csrf,
      },
      body: png,
    });
    const uploaded = await readJson(upload);
    assert.equal(upload.status, 201);
    assert.match(uploaded.url, /^\/uploads\/[a-f0-9]{32}\.png$/);
    uploadedIconUrl = uploaded.url;

    const image = await fetch(`${base}${uploaded.url}`);
    assert.equal(image.status, 200);
    assert.equal(image.headers.get('content-type'), 'image/png');
    assert.match(image.headers.get('cache-control'), /immutable/);

    const library = await request('/api/admin/uploads');
    assert.equal(library.response.status, 200);
    assert.ok(library.json.items.some((item) => item.url === uploadedIconUrl));

    const disposableUpload = await fetch(`${base}${uploadPath}`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'image/png',
        'X-CSRF-Token': csrf,
      },
      body: png,
    });
    const disposable = await readJson(disposableUpload);
    assert.equal(disposableUpload.status, 201);
    assert.notEqual(disposable.url, uploadedIconUrl);

    const withoutDeleteCsrf = await fetch(`${base}${disposable.url.replace('/uploads/', '/api/admin/uploads/')}`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    assert.equal(withoutDeleteCsrf.status, 403);

    const deleted = await fetch(
      `${base}${disposable.url.replace('/uploads/', '/api/admin/uploads/')}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
      },
    );
    assert.equal(deleted.status, 200);
    const deletedImage = await fetch(`${base}${disposable.url}`);
    assert.equal(deletedImage.status, 404);
  });

  await t.test('requires CSRF and validates malicious URLs', async () => {
    const noCsrf = await request('/api/admin/config', {
      method: 'PUT',
      body: { groups: [{ name: '测试' }], sites: [] },
    });
    assert.equal(noCsrf.response.status, 403);

    const badUrl = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: {
        settings: { title: '测试导航' },
        groups: [{ id: 'group-1111', name: '测试分组' }],
        sites: [
          {
            id: 'site-1111',
            groupId: 'group-1111',
            name: '恶意站点',
            nodes: [{ id: 'node-1111', name: '节点', url: 'ftp://example.com' }],
          },
        ],
      },
    });
    assert.equal(badUrl.response.status, 400);
    assert.match(badUrl.json.error, /http/);

    const badIcon = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: {
        settings: { title: '测试导航', icon: 'not-an-icon' },
        groups: [{ id: 'group-1111', name: '测试分组' }],
        sites: [],
      },
    });
    assert.equal(badIcon.response.status, 400);
    assert.match(badIcon.json.error, /图标/);

    const badBrand = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: {
        settings: {
          title: '测试导航',
          brandFont: 'comic',
          background: '😀',
        },
        groups: [{ id: 'group-1111', name: '测试分组' }],
        sites: [],
      },
    });
    assert.equal(badBrand.response.status, 400);

    const badTheme = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: {
        settings: { title: '测试导航', themeColor: 'blue' },
        groups: [{ id: 'group-1111', name: '测试分组' }],
        sites: [],
      },
    });
    assert.equal(badTheme.response.status, 400);
    assert.match(badTheme.json.error, /RRGGBB/);
  });

  await t.test('saves sites with multiple node addresses', async () => {
    const payload = {
      settings: {
        title: '测试导航',
        subtitle: '多节点延迟测试',
        icon: '🧭',
        brandText: 'TESTNAV',
        brandFont: 'mono',
        background: uploadedIconUrl,
        mobileBackground: uploadedIconUrl,
        adminBackground: uploadedIconUrl,
        backgroundTransparency: 60,
        themeColor: '#3b82f6',
        autoRefreshSeconds: 30,
        pingTimeoutMs: 2000,
        openInNewTab: false,
        showOffline: true,
      },
      groups: [
        { id: 'group-1111', name: '开发工具' },
        { id: 'group-2222', name: '其他' },
      ],
      sites: [
        {
          id: 'site-1111',
          groupId: 'group-1111',
          name: '本地服务',
          description: '用于自动化测试',
          icon: uploadedIconUrl,
          nodes: [
            {
              id: 'node-1111',
              name: '主线路',
              url: 'https://online.example/health',
            },
            {
              id: 'node-2222',
              name: '备用线路',
              url: 'online.example/backup',
            },
            {
              id: 'node-3333',
              name: '离线线路',
              url: 'http://offline.example/',
            },
            {
              id: 'node-4444',
              name: '仅登录节点',
              url: 'https://private.example/',
              guestHidden: true,
            },
          ],
        },
      ],
    };

    const saved = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: payload,
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.json.settings.title, '测试导航');
    assert.equal(saved.json.settings.icon, '🧭');
    assert.equal(saved.json.settings.brandText, 'TESTNAV');
    assert.equal(saved.json.settings.brandFont, 'mono');
    assert.equal(saved.json.settings.background, uploadedIconUrl);
    assert.equal(saved.json.settings.mobileBackground, uploadedIconUrl);
    assert.equal(saved.json.settings.adminBackground, uploadedIconUrl);
    assert.equal(saved.json.settings.backgroundTransparency, 60);
    assert.equal(saved.json.settings.themeColor, '#3b82f6');
    assert.equal(saved.json.settings.hideNodesForGuests, false);
    assert.equal(saved.json.sites[0].icon, uploadedIconUrl);
    assert.equal(saved.json.sites[0].nodes.length, 4);
    assert.equal(saved.json.sites[0].nodes[1].url, 'https://online.example/backup');
    assert.equal(saved.json.sites[0].nodes[3].guestHidden, true);
    assert.equal(saved.json.sites[0].nodes[0].guestHidden, false);
    assert.equal(saved.json.settings.passwordHash, undefined);

    const nav = await request('/api/nav');
    assert.equal(nav.json.settings.title, '测试导航');
    assert.equal(nav.json.settings.icon, '🧭');
    assert.equal(nav.json.settings.brandText, 'TESTNAV');
    assert.equal(nav.json.settings.brandFont, 'mono');
    assert.equal(nav.json.settings.background, uploadedIconUrl);
    assert.equal(nav.json.settings.mobileBackground, uploadedIconUrl);
    assert.equal(nav.json.settings.adminBackground, undefined);
    assert.equal(nav.json.settings.backgroundTransparency, 60);
    assert.equal(nav.json.settings.themeColor, '#3b82f6');
    assert.equal(nav.json.settings.adminUsername, undefined);
    assert.equal(nav.json.sites[0].name, '本地服务');
    assert.equal(nav.json.sites[0].nodes.length, 4, 'admin sees every node');

    const themeCss = await fetch(`${base}/theme.css`);
    const css = await themeCss.text();
    assert.equal(themeCss.status, 200);
    assert.match(css, /--accent: #3b82f6/);
    assert.match(css, /--bg: #/);

    // The page must arrive already branded, otherwise the browser paints the
    // built-in default name before app.js can replace it.
    const brandedPage = await fetch(`${base}/`);
    const brandedHtml = await brandedPage.text();
    assert.match(brandedHtml, /<title>测试导航<\/title>/);
    assert.match(brandedHtml, /TEST<em>NAV<\/em>/);
    assert.doesNotMatch(brandedHtml, /DEEPNAV/);
    assert.doesNotMatch(brandedHtml, /\{\{[A-Z_]+\}\}/);
    assert.match(brandedHtml, /bg-transparency-60/);
    assert.match(brandedHtml, /<meta name="theme-color" content="#3b82f6"/);

    const adminPageHtml = await (await fetch(`${base}${adminPath}`)).text();
    assert.match(adminPageHtml, /<title>管理后台 · 测试导航<\/title>/);
    assert.doesNotMatch(adminPageHtml, /\{\{[A-Z_]+\}\}/);

    const guestPage = await fetch(`${base}/`);
    const guestCsp = guestPage.headers.get('content-security-policy');
    assert.match(
      guestCsp,
      /connect-src 'self' https:\/\/online\.example http:\/\/offline\.example$/,
      'guest CSP lists exactly the visible node origins',
    );
    assert.doesNotMatch(
      guestCsp,
      /private\.example/,
      'guest CSP must not leak guest-hidden node origins',
    );
    assert.match(guestCsp, /frame-src 'none'/);
    assert.doesNotMatch(guestCsp, /upgrade-insecure-requests/);

    const adminPage = await fetch(`${base}/`, { headers: { Cookie: cookie } });
    const adminCsp = adminPage.headers.get('content-security-policy');
    assert.match(adminCsp, /https:\/\/private\.example/, 'admin CSP covers every node');

    const uploadedImage = await fetch(`${base}${uploadedIconUrl}`);
    assert.match(uploadedImage.headers.get('content-security-policy'), /sandbox/);

    const redirect = await fetch(`${base}/go/node-1111`, { redirect: 'manual' });
    assert.equal(redirect.status, 302);
    assert.equal(redirect.headers.get('location'), 'https://online.example/health');
    const missingRedirect = await fetch(`${base}/go/missing-node`, { redirect: 'manual' });
    assert.equal(missingRedirect.status, 404);

    const usedDelete = await fetch(
      `${base}${uploadedIconUrl.replace('/uploads/', '/api/admin/uploads/')}`,
      {
        method: 'DELETE',
        headers: { Cookie: cookie, 'X-CSRF-Token': csrf },
      },
    );
    assert.equal(usedDelete.status, 409);
    assert.match((await readJson(usedDelete)).error, /正在使用/);
  });

  await t.test('measures configured nodes without accepting arbitrary URLs', async () => {
    const unknown = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'does-not-exist' },
    });
    assert.equal(unknown.response.status, 404);

    const online = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-1111' },
    });
    assert.equal(online.response.status, 200);
    assert.equal(online.json.ok, true);
    assert.equal(online.json.protocol, 'icmp');
    assert.equal(online.json.latencyMs, 12.3);
    assert.equal(online.json.httpStatus, undefined);

    const cached = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-1111' },
    });
    assert.equal(cached.response.status, 200);
    assert.equal(cached.json.ok, true);

    const offline = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-3333' },
    });
    assert.equal(offline.response.status, 200);
    assert.equal(offline.json.ok, false);
    assert.ok(offline.json.error);
    assert.equal(offline.json.latencyMs, null);
  });

  await t.test('hides nodes from guests when enabled', async () => {
    const config = await request('/api/admin/config');
    const enabled = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: {
        settings: { ...config.json.settings, hideNodesForGuests: true },
        groups: config.json.groups,
        sites: config.json.sites,
      },
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.json.settings.hideNodesForGuests, true);

    const guestCookie = cookie;
    cookie = '';
    const guestNav = await request('/api/nav');
    assert.equal(guestNav.json.settings.authenticated, false);
    assert.equal(guestNav.json.settings.nodesHidden, undefined);
    assert.equal(guestNav.json.settings.hideNodesForGuests, undefined);
    assert.equal(guestNav.json.settings.hiddenSiteCount, undefined);
    assert.equal(guestNav.json.sites.length, 1);
    assert.equal(guestNav.json.sites[0].nodes.length, 0);
    assert.equal(guestNav.json.sites[0].name, '本地服务');
    assert.equal(guestNav.json.sites[0].hiddenCount, undefined);

    const lockedPage = await fetch(`${base}/`);
    const lockedCsp = lockedPage.headers.get('content-security-policy');
    assert.match(lockedCsp, /connect-src 'self'$/);

    const guestPing = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-1111' },
    });
    assert.equal(guestPing.response.status, 403);

    const guestRedirect = await fetch(`${base}/go/node-1111`, { redirect: 'manual' });
    assert.equal(guestRedirect.status, 403);

    cookie = guestCookie;
    const adminNav = await request('/api/nav');
    assert.equal(adminNav.json.settings.hideNodesForGuests, true);
    assert.equal(adminNav.json.settings.authenticated, true);
    assert.equal(adminNav.json.sites[0].nodes.length, 4);

    const adminPing = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-1111' },
    });
    assert.equal(adminPing.response.status, 200);

    const disabled = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: {
        settings: { ...config.json.settings, hideNodesForGuests: false },
        groups: config.json.groups,
        sites: config.json.sites,
      },
    });
    assert.equal(disabled.response.status, 200);
  });

  await t.test('hides individual guest-hidden nodes from guests only', async () => {
    const adminCookie = cookie;
    cookie = '';
    const guestNav = await request('/api/nav');
    assert.equal(guestNav.json.settings.nodesHidden, undefined);
    assert.equal(guestNav.json.sites[0].hiddenCount, undefined);
    assert.equal(guestNav.json.sites[0].nodes.length, 3);
    assert.ok(guestNav.json.sites[0].nodes.every((node) => !node.guestHidden));

    const hiddenPing = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-4444' },
    });
    assert.equal(hiddenPing.response.status, 403);
    assert.match(hiddenPing.json.error, /仅登录可见/);

    const hiddenRedirect = await fetch(`${base}/go/node-4444`, { redirect: 'manual' });
    assert.equal(hiddenRedirect.status, 403);

    const visiblePing = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-1111' },
    });
    assert.equal(visiblePing.response.status, 200);

    cookie = adminCookie;
    const adminPing = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-4444' },
    });
    assert.equal(adminPing.response.status, 200);
  });

  await t.test('hides a whole site from guests', async () => {
    const config = await request('/api/admin/config');
    const site = config.json.sites[0];
    const enabled = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: {
        settings: config.json.settings,
        groups: config.json.groups,
        sites: [{ ...site, guestHidden: true }],
      },
    });
    assert.equal(enabled.response.status, 200);
    assert.equal(enabled.json.sites[0].guestHidden, true);

    const adminCookie = cookie;
    cookie = '';
    const guestNav = await request('/api/nav');
    assert.equal(guestNav.json.settings.hiddenSiteCount, undefined);
    assert.equal(guestNav.json.sites.length, 0);
    assert.equal(guestNav.json.groups.length, 0);

    const hiddenSitePage = await fetch(`${base}/`);
    const hiddenSiteCsp = hiddenSitePage.headers.get('content-security-policy');
    assert.match(hiddenSiteCsp, /connect-src 'self'$/);

    const guestPing = await request('/api/ping', {
      method: 'POST',
      body: { nodeId: 'node-1111' },
    });
    assert.equal(guestPing.response.status, 403);
    assert.match(guestPing.json.error, /站点已设为仅登录可见/);

    const guestGo = await fetch(`${base}/go/node-1111`, { redirect: 'manual' });
    assert.equal(guestGo.status, 403);

    cookie = adminCookie;
    const adminNav = await request('/api/nav');
    assert.equal(adminNav.json.settings.hiddenSiteCount, undefined);
    assert.equal(adminNav.json.sites.length, 1);
    assert.equal(adminNav.json.sites[0].nodes.length, 4);

    const restored = await request('/api/admin/config', {
      method: 'PUT',
      csrf: true,
      body: {
        settings: config.json.settings,
        groups: config.json.groups,
        sites: config.json.sites,
      },
    });
    assert.equal(restored.response.status, 200);
    assert.equal(restored.json.sites[0].guestHidden, false);
  });

  await t.test('changes the admin password and rotates the session', async () => {
    const oldCookie = cookie;
    const oldCsrf = csrf;

    const badCurrent = await request('/api/admin/password', {
      method: 'POST',
      csrf: true,
      body: { currentPassword: 'not-the-password', newPassword: 'new-password-456' },
    });
    assert.equal(badCurrent.response.status, 400);

    const changed = await request('/api/admin/password', {
      method: 'POST',
      csrf: true,
      body: { currentPassword: 'test-password-123', newPassword: 'new-password-456' },
    });
    assert.equal(changed.response.status, 200);
    assert.ok(changed.json.csrfToken);
    csrf = changed.json.csrfToken;

    const oldSession = await fetch(`${base}/api/admin/config`, {
      headers: { Cookie: oldCookie, 'X-CSRF-Token': oldCsrf },
    });
    assert.equal(oldSession.status, 401);

    const newSession = await request('/api/admin/config');
    assert.equal(newSession.response.status, 200);

    const logout = await request('/api/admin/logout', { method: 'POST', csrf: true });
    assert.equal(logout.response.status, 200);
    cookie = '';

    const oldLogin = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'admin', password: 'test-password-123' },
    });
    assert.equal(oldLogin.response.status, 401);

    const newLogin = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'admin', password: 'new-password-456' },
    });
    assert.equal(newLogin.response.status, 200);
    assert.ok(newLogin.json.csrfToken);
    assert.equal(newLogin.json.username, 'admin');
    csrf = newLogin.json.csrfToken;

    const renamed = await request('/api/admin/password', {
      method: 'POST',
      csrf: true,
      body: {
        currentPassword: 'new-password-456',
        newPassword: 'final-password-789',
        newUsername: 'operator_01',
      },
    });
    assert.equal(renamed.response.status, 200);
    csrf = renamed.json.csrfToken;

    const session = await request('/api/admin/session');
    assert.equal(session.json.username, 'operator_01');

    const oldNameLogin = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'admin', password: 'final-password-789' },
    });
    assert.equal(oldNameLogin.response.status, 401);

    const newNameLogin = await request('/api/admin/login', {
      method: 'POST',
      body: { username: 'operator_01', password: 'final-password-789' },
    });
    assert.equal(newNameLogin.response.status, 200);
    assert.equal(newNameLogin.json.username, 'operator_01');
    csrf = newNameLogin.json.csrfToken;

    // Rotating the admin path retires the previous URL immediately.
    const rotated = await request('/api/admin/path', {
      method: 'POST',
      csrf: true,
      body: { adminPath: '/m-rotated0123456789ab' },
    });
    assert.equal(rotated.response.status, 200);
    assert.equal(rotated.json.config.settings.adminPath, '/m-rotated0123456789ab');

    assert.equal((await fetch(`${base}${adminPath}`)).status, 404, 'old path is retired');
    assert.equal((await fetch(`${base}/m-rotated0123456789ab`)).status, 200);

    for (const badPath of ['admin', '/admin', '/api/x', '/m-a', 'm-a1b2c3']) {
      const rejected = await request('/api/admin/path', {
        method: 'POST',
        csrf: true,
        body: { adminPath: badPath },
      });
      assert.equal(rejected.response.status, 400, `${badPath} must be rejected`);
    }

    const withoutCsrf = await request('/api/admin/path', {
      method: 'POST',
      body: { adminPath: '/m-nocsrf0123456789a' },
    });
    assert.equal(withoutCsrf.response.status, 403);
  });
});

async function startSecureApp(options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepnav-tls-'));
  const app = await createApplication({
    dataDir,
    initialPassword: 'test-password-123',
    trustProxy: true,
    logger: { error() {} },
    probe: async () => ({
      ok: true,
      latencyMs: 1,
      protocol: 'icmp',
      httpStatus: null,
      error: null,
      code: null,
      checkedAt: new Date().toISOString(),
    }),
    ...options,
  });
  const port = await listen(app.server);
  return { app, dataDir, base: `http://127.0.0.1:${port}` };
}

test('advertises HSTS with includeSubDomains over HTTPS', async () => {
  const { app, dataDir, base } = await startSecureApp();
  try {
    const page = await fetch(`${base}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(
      page.headers.get('strict-transport-security'),
      'max-age=31536000; includeSubDomains',
    );
    assert.match(page.headers.get('content-security-policy'), /upgrade-insecure-requests/);
  } finally {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('fresh install ships documented default credentials', async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepnav-default-'));
  const app = await createApplication({
    // No initialPassword: the built-in default is used.
    dataDir,
    logger: { error() {}, info() {} },
    probe: async () => ({ ok: true, latencyMs: 1, protocol: 'icmp' }),
  });
  const port = await listen(app.server);
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal(app.firstRun, true);
    const settings = app.store.get().settings;
    assert.equal(settings.adminPath, '/m-deepnav');
    assert.equal(settings.adminUsername, 'admin');
    assert.equal(settings.defaultCredentials, true);

    // The console is reachable at the documented path…
    assert.equal((await fetch(`${base}/m-deepnav`)).status, 200);
    // …and the documented password logs in.
    const login = await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'DeepNav@2026' }),
    });
    assert.equal(login.status, 200);

    const cookie = (
      typeof login.headers.getSetCookie === 'function'
        ? login.headers.getSetCookie()[0]
        : login.headers.get('set-cookie')
    ).split(';')[0];
    const { csrfToken } = await login.json();
    const config = await (
      await fetch(`${base}/api/admin/config`, {
        headers: { Cookie: cookie, 'X-CSRF-Token': csrfToken },
      })
    ).json();
    assert.equal(config.settings.defaultCredentials, true, 'console must warn about defaults');

    // Changing the password clears the warning flag.
    const changed = await fetch(`${base}/api/admin/password`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookie,
        'X-CSRF-Token': csrfToken,
      },
      body: JSON.stringify({
        currentPassword: 'DeepNav@2026',
        newPassword: 'my-own-password-1',
      }),
    });
    assert.equal(changed.status, 200);
    const { csrfToken: newCsrf } = await changed.json();
    const newCookie = (
      typeof changed.headers.getSetCookie === 'function'
        ? changed.headers.getSetCookie()[0]
        : changed.headers.get('set-cookie')
    ).split(';')[0];
    const after = await (
      await fetch(`${base}/api/admin/config`, {
        headers: { Cookie: newCookie, 'X-CSRF-Token': newCsrf },
      })
    ).json();
    assert.equal(after.settings.defaultCredentials, false);
  } finally {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test('allows disabling HSTS includeSubDomains', async () => {
  const { app, dataDir, base } = await startSecureApp({ hstsSubdomains: false });
  try {
    const page = await fetch(`${base}/`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(page.headers.get('strict-transport-security'), 'max-age=31536000');
  } finally {
    await app.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
