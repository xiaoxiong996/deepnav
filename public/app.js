'use strict';

const state = {
  config: null,
  serverResults: new Map(),
  browserResults: new Map(),
  authenticated: false,
  nodeEls: new Map(),
  nodeById: new Map(),
  siteEls: new Map(),
  groupEls: new Map(),
  query: '',
  runId: 0,
  isPinging: false,
  nextRefreshAt: 0,
  abortController: null,
  browserAbortController: null,
  emptyEl: null,
};

const els = {
  brandMark: document.getElementById('brand-mark'),
  brandText: document.getElementById('brand-text'),
  customBackground: document.getElementById('custom-background'),
  customBackgroundImage: document.getElementById('custom-background-image'),
  customBackgroundMobile: document.getElementById('custom-background-mobile'),
  title: document.getElementById('page-title'),
  subtitle: document.getElementById('page-subtitle'),
  navRoot: document.getElementById('sites'),
  search: document.getElementById('search-input'),
  refresh: document.getElementById('refresh-button'),
  countdown: document.getElementById('countdown-label'),
  statOnline: document.getElementById('stat-online'),
  statServerFastest: document.getElementById('stat-server-fastest'),
  statBrowserFastest: document.getElementById('stat-browser-fastest'),
  statState: document.getElementById('stat-state'),
  autoRefreshNote: document.getElementById('auto-refresh-note'),
};

const brandTemplate = document.getElementById('brand-mark-default');
const defaultBrandIcon = brandTemplate
  ? brandTemplate.content.firstElementChild.cloneNode(true)
  : els.brandMark?.firstElementChild?.cloneNode(true) || null;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function svgIcon(paths, className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  for (const pathData of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathData);
    svg.appendChild(path);
  }
  return svg;
}

function hostFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function isImageIcon(icon) {
  return /^https?:\/\//i.test(icon || '') || /^\/uploads\//.test(icon || '');
}

function siteInitial(site) {
  return Array.from(site.name || '?')[0] || '?';
}

function fillIcon(container, icon, fallback) {
  container.replaceChildren();
  if (isImageIcon(icon)) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener(
      'error',
      () => {
        container.replaceChildren();
        container.textContent = fallback;
      },
      { once: true },
    );
    image.src = icon;
    container.appendChild(image);
    return;
  }
  container.textContent = icon || fallback;
}

function restoreDefaultBrandIcon() {
  els.brandMark.replaceChildren();
  if (defaultBrandIcon) els.brandMark.appendChild(defaultBrandIcon.cloneNode(true));
}

function renderBrandIcon(icon, title) {
  if (!els.brandMark) return;
  if (isImageIcon(icon)) {
    els.brandMark.replaceChildren();
    const image = document.createElement('img');
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', restoreDefaultBrandIcon, { once: true });
    image.src = icon;
    els.brandMark.appendChild(image);
    return;
  }
  if (icon) {
    els.brandMark.replaceChildren();
    els.brandMark.textContent = icon;
    return;
  }
  restoreDefaultBrandIcon();
  els.brandMark.setAttribute('aria-label', title || '导航页图标');
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function setBrandText(text, font = 'sans') {
  if (!els.brandText) return;
  const value = typeof text === 'string' ? text.trim() : 'DEEPNAV';
  els.brandText.classList.remove('brand-font-sans', 'brand-font-mono', 'brand-font-serif');
  els.brandText.classList.add(
    ['mono', 'serif'].includes(font) ? `brand-font-${font}` : 'brand-font-sans',
  );
  if (!value) {
    els.brandText.hidden = true;
    els.brandText.replaceChildren();
    return;
  }
  els.brandText.hidden = false;
  const characters = Array.from(value);
  const tailLength = Math.min(3, characters.length);
  const head = characters.slice(0, characters.length - tailLength).join('');
  const tail = characters.slice(-tailLength).join('');
  els.brandText.replaceChildren();
  if (head) els.brandText.appendChild(document.createTextNode(head));
  const accent = document.createElement('em');
  accent.textContent = tail;
  els.brandText.appendChild(accent);
}

function setBackgroundTransparency(value) {
  const rounded = Math.max(0, Math.min(100, Math.round(Number(value) / 10) * 10));
  for (let level = 0; level <= 100; level += 10) {
    document.body.classList.remove(`bg-transparency-${level}`);
  }
  document.body.classList.add(`bg-transparency-${rounded}`);
}

function setPageBackground(desktopUrl, mobileUrl) {  if (!els.customBackground || !els.customBackgroundImage || !els.customBackgroundMobile) return;
  const wrapper = els.customBackground;
  const desktop = els.customBackgroundImage;
  const mobile = els.customBackgroundMobile;

  desktop.onerror = () => {
    desktop.removeAttribute('src');
    if (!mobileUrl) wrapper.hidden = true;
  };
  mobile.onerror = () => {
    mobile.removeAttribute('src');
    wrapper.classList.remove('has-mobile');
    if (!desktopUrl) wrapper.hidden = true;
  };

  if (!desktopUrl && !mobileUrl) {
    wrapper.hidden = true;
    wrapper.classList.remove('has-mobile');
    desktop.removeAttribute('src');
    mobile.removeAttribute('src');
    return;
  }

  wrapper.hidden = false;
  if (desktopUrl) desktop.src = desktopUrl;
  else desktop.removeAttribute('src');
  if (mobileUrl) {
    wrapper.classList.add('has-mobile');
    mobile.src = mobileUrl;
  } else {
    wrapper.classList.remove('has-mobile');
    mobile.removeAttribute('src');
  }
}

function updateFavicon(icon) {
  const link = document.querySelector('link[rel="icon"]');
  if (!link) return;
  if (isImageIcon(icon)) {
    link.href = icon;
    return;
  }
  if (icon) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f141a"/><text x="32" y="34" text-anchor="middle" dominant-baseline="middle" font-size="40">${escapeXml(icon)}</text></svg>`;
    link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    return;
  }
  link.href = '/favicon.svg';
}

function formatLatency(value) {
  return Number.isInteger(value) ? String(value) : Number(value).toFixed(1);
}

function redirectHref(nodeId) {
  return `/go/${encodeURIComponent(nodeId)}`;
}

function allNodes(config = state.config) {
  if (!config) return [];
  return config.sites.flatMap((site) => site.nodes);
}

function latencyClass(latencyMs) {
  if (latencyMs <= 120) return 'is-fast';
  if (latencyMs <= 300) return 'is-medium';
  return 'is-slow';
}

function createNodeMetric(source, label, title) {
  const metric = el('span', 'node-metric');
  metric.dataset.source = source;
  metric.title = title;
  metric.appendChild(el('span', 'metric-label', label));
  metric.appendChild(el('span', 'latency is-pending', '测试中'));
  return metric;
}

function buildNode(site, node) {
  const anchor = el('a', 'node is-pending');
  anchor.dataset.nodeId = node.id;
  anchor.setAttribute('aria-disabled', 'true');
  anchor.setAttribute('aria-label', `${site.name} ${node.name}，正在测试延迟`);
  if (state.authenticated) anchor.title = node.url;

  const status = el('span', 'node-status');
  status.appendChild(el('i', 'node-dot'));
  anchor.appendChild(status);

  const body = el('span', 'node-body');
  body.appendChild(el('span', 'node-name', node.name));
  if (state.authenticated) body.appendChild(el('span', 'node-host', hostFromUrl(node.url)));
  anchor.appendChild(body);

  const metrics = el('span', 'node-metrics');
  metrics.append(
    createNodeMetric('server', '服务器', '服务器 ICMP 延迟'),
    createNodeMetric('browser', '浏览器', '浏览器端 HTTP 延迟'),
  );
  anchor.appendChild(metrics);

  anchor.appendChild(svgIcon(['M5 12h13', 'm13 7 5 5-5 5'], 'node-enter'));

  anchor.addEventListener('click', (event) => {
    if (!anchor.getAttribute('href')) event.preventDefault();
  });

  state.nodeEls.set(node.id, anchor);
  return anchor;
}

function buildSiteCard(site, group, openInNewTab) {
  const card = el('article', 'site-card');
  card.dataset.siteId = site.id;

  const head = el('div', 'site-head');
  const icon = el('span', 'site-icon');
  icon.setAttribute('aria-hidden', 'true');
  fillIcon(icon, site.icon, siteInitial(site));

  const titleWrap = el('div', 'site-title-wrap');
  titleWrap.appendChild(el('h3', 'site-title', site.name));
  if (site.description) titleWrap.appendChild(el('p', 'site-description', site.description));

  const meta = el('span', 'site-meta');
  meta.appendChild(el('i', 'meta-dot'));
  const metaText = site.nodes.length ? `0/${site.nodes.length}` : '暂无节点';
  meta.appendChild(el('span', 'meta-text', metaText));
  meta.setAttribute(
    'aria-label',
    site.nodes.length ? `可用节点 0，共 ${site.nodes.length}` : '暂无可用节点',
  );

  head.append(icon, titleWrap, meta);
  card.appendChild(head);

  const nodeList = el('div', 'node-list');
  for (const node of site.nodes) nodeList.appendChild(buildNode(site, node));
  if (!site.nodes.length) nodeList.appendChild(el('div', 'node-locked is-inline', '暂无可见节点'));
  card.appendChild(nodeList);

  const searchText = [
    group.name,
    site.name,
    site.description,
    ...site.nodes.flatMap((node) => {
      if (!state.authenticated) return [node.name];
      return [node.name, node.url, hostFromUrl(node.url)];
    }),
  ]
    .join(' ')
    .toLowerCase();

  state.siteEls.set(site.id, { card, site, group, meta, searchText });
  return card;
}

function buildEmptyState() {
  const wrapper = el('div', 'empty-state');
  wrapper.hidden = true;

  const icon = el('span', 'empty-icon');
  icon.appendChild(
    svgIcon([
      'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z',
      'M3.6 9h16.8M3.6 15h16.8',
      'M12 3c2.4 2.5 3.6 5.5 3.6 9s-1.2 6.5-3.6 9c-2.4-2.5-3.6-5.5-3.6-9S9.6 5.5 12 3Z',
    ]),
  );
  const title = el('h2');
  const text = el('p');
  const action = el('button', 'button button-primary');
  action.type = 'button';
  wrapper.append(icon, title, text, action);

  state.emptyEl = { wrapper, title, text, action };
  return wrapper;
}

function setEmptyState({ title, text, actionLabel, onAction }) {
  if (!state.emptyEl) return;
  const { wrapper, title: titleEl, text: textEl, action } = state.emptyEl;
  titleEl.textContent = title;
  textEl.textContent = text;
  action.textContent = actionLabel;
  action.onclick = onAction;
  wrapper.hidden = false;
}

function renderEmptyConfig() {
  const wrapper = el('div', 'empty-state');
  const icon = el('span', 'empty-icon');
  icon.appendChild(
    svgIcon([
      'M4 5.5h16v13H4z',
      'M4 9.5h16',
      'M8 5.5v4',
      'M8 13h4',
    ]),
  );
  wrapper.appendChild(icon);
  wrapper.appendChild(el('h2', '', '暂无可见站点'));
  wrapper.appendChild(
    el('p', '', '站点尚未配置，或已设置为仅登录可见。请通过管理路径登录后台添加站点与节点地址。'),
  );
  els.navRoot.replaceChildren(wrapper);
  els.navRoot.setAttribute('aria-busy', 'false');
}

function renderSites() {
  const config = state.config;
  els.navRoot.replaceChildren();
  els.navRoot.setAttribute('aria-busy', 'false');
  state.serverResults.clear();
  state.browserResults.clear();
  state.nodeEls.clear();
  state.nodeById.clear();
  state.siteEls.clear();
  state.groupEls.clear();

  if (!config.sites.length) {
    renderEmptyConfig();
    updateSummary();
    return;
  }

  for (const node of allNodes(config)) state.nodeById.set(node.id, node);

  for (const group of config.groups) {
    const sites = config.sites.filter((site) => site.groupId === group.id);
    if (!sites.length) continue;

    const section = el('section', 'nav-group');
    section.dataset.groupId = group.id;
    const heading = el('div', 'group-heading');
    heading.appendChild(el('h2', 'group-title', group.name));
    heading.appendChild(el('span', 'group-count', String(sites.length)));
    section.appendChild(heading);

    const grid = el('div', 'site-grid');
    for (const site of sites) {
      grid.appendChild(buildSiteCard(site, group, config.settings.openInNewTab));
    }
    section.appendChild(grid);
    els.navRoot.appendChild(section);
    state.groupEls.set(group.id, section);
  }

  els.navRoot.appendChild(buildEmptyState());
  applySearch();
  updateSummary();
}

function setNodePending(node) {
  const nodeEl = state.nodeEls.get(node.id);
  if (!nodeEl) return;
  nodeEl.hidden = false;
  nodeEl.classList.remove(
    'is-online',
    'is-offline',
    'latency-fast',
    'latency-medium',
    'latency-slow',
  );
  nodeEl.classList.add('is-pending');
  nodeEl.removeAttribute('href');
  nodeEl.removeAttribute('target');
  nodeEl.removeAttribute('rel');
  nodeEl.setAttribute('aria-disabled', 'true');
  nodeEl.setAttribute('aria-label', `${node.name}，正在测试延迟`);
  if (state.authenticated) nodeEl.title = node.url;
  else nodeEl.removeAttribute('title');

  for (const metric of nodeEl.querySelectorAll('.node-metric')) {
    const label = metric.dataset.source === 'server' ? '服务器 ICMP' : '浏览器 HTTP';
    const latency = metric.querySelector('.latency');
    latency.className = 'latency is-pending';
    latency.textContent = '测试中';
    latency.title = `${label} 正在测试`;
  }
}

function shortFailure(result) {
  const error = result?.error || '';
  if (/超时|timeout/i.test(error)) return '超时';
  if (/HTTPS|混合/i.test(error)) return '阻止';
  if (/权限/i.test(error)) return '权限';
  return '失败';
}

function updateMetric(nodeEl, source, result, label) {
  const metric = nodeEl.querySelector(`.node-metric[data-source="${source}"]`);
  if (!metric) return;
  const latency = metric.querySelector('.latency');
  latency.className = 'latency';

  if (!result) {
    latency.classList.add('is-pending');
    latency.textContent = '测试中';
    latency.title = `${label} 正在测试`;
    return;
  }
  if (result.ok) {
    const level = latencyClass(result.latencyMs);
    latency.classList.add(level);
    latency.textContent = `${formatLatency(result.latencyMs)} ms`;
    latency.title = `${label} · ${formatLatency(result.latencyMs)} ms`;
    return;
  }
  latency.classList.add('is-offline');
  latency.textContent = shortFailure(result);
  latency.title = `${label}：${result.error || '不可用'}`;
}

function updateNodeState(node) {
  const nodeEl = state.nodeEls.get(node.id);
  if (!nodeEl) return;

  const server = state.serverResults.get(node.id);
  const browser = state.browserResults.get(node.id);
  const done = Boolean(server && browser);
  const available = Boolean(server?.ok || browser?.ok);
  const preferred = browser?.ok ? browser : server?.ok ? server : null;

  nodeEl.classList.remove(
    'is-pending',
    'is-online',
    'is-offline',
    'latency-fast',
    'latency-medium',
    'latency-slow',
  );
  if (!done) nodeEl.classList.add('is-pending');
  else nodeEl.classList.add(available ? 'is-online' : 'is-offline');

  if (preferred) {
    nodeEl.classList.add(`latency-${latencyClass(preferred.latencyMs).slice(3)}`);
  }

  updateMetric(nodeEl, 'server', server, '服务器 ICMP');
  updateMetric(nodeEl, 'browser', browser, '浏览器 HTTP');

  if (done && available) {
    nodeEl.href = redirectHref(node.id);
    if (state.config.settings.openInNewTab) {
      nodeEl.target = '_blank';
      nodeEl.rel = 'noopener noreferrer';
    }
    nodeEl.setAttribute('aria-disabled', 'false');
    nodeEl.hidden = false;
    const serverText = server.ok
      ? `服务器 ICMP ${formatLatency(server.latencyMs)} 毫秒`
      : `服务器 ICMP ${server.error || '失败'}`;
    const browserText = browser.ok
      ? `浏览器 HTTP ${formatLatency(browser.latencyMs)} 毫秒`
      : `浏览器 HTTP ${browser.error || '失败'}`;
    nodeEl.setAttribute(
      'aria-label',
      `${node.name}，${serverText}，${browserText}，点击${state.config.settings.openInNewTab ? '在新标签页' : ''}进入`,
    );
    if (state.authenticated) nodeEl.title = node.url;
    else nodeEl.removeAttribute('title');
    return;
  }

  nodeEl.removeAttribute('href');
  nodeEl.removeAttribute('target');
  nodeEl.removeAttribute('rel');
  nodeEl.setAttribute('aria-disabled', 'true');

  if (!done) {
    nodeEl.setAttribute('aria-label', `${node.name}，正在测试延迟`);
    if (state.authenticated) nodeEl.title = node.url;
    else nodeEl.removeAttribute('title');
    nodeEl.hidden = false;
    return;
  }

  const details = [
    `服务器 ICMP：${server.ok ? '正常' : server.error || '失败'}`,
    `浏览器 HTTP：${browser.ok ? '正常' : browser.error || '失败'}`,
  ].join('，');
  nodeEl.setAttribute('aria-label', `${node.name}，不可用，${details}`);
  if (state.authenticated) nodeEl.title = `${node.url}\n${details}`;
  else nodeEl.title = details;
  nodeEl.hidden = !state.config.settings.showOffline;
}

function updateSiteMeta(site) {
  const record = state.siteEls.get(site.id);
  if (!record) return;
  if (!site.nodes.length) {
    const metaText = record.meta.querySelector('.meta-text');
    if (metaText) metaText.textContent = '暂无节点';
    record.meta.classList.remove('is-online');
    record.meta.setAttribute('aria-label', '暂无可用节点');
    record.card.classList.remove('is-all-offline');
    return;
  }

  let online = 0;
  let allDone = true;
  for (const node of site.nodes) {
    const server = state.serverResults.get(node.id);
    const browser = state.browserResults.get(node.id);
    if (!server || !browser) allDone = false;
    if (server?.ok || browser?.ok) online += 1;
  }
  record.meta.querySelector('.meta-text').textContent = `${online}/${site.nodes.length}`;
  record.meta.classList.toggle('is-online', online > 0);
  record.meta.setAttribute('aria-label', `可用节点 ${online}，共 ${site.nodes.length}`);
  record.card.classList.toggle(
    'is-all-offline',
    allDone && site.nodes.length > 0 && online === 0,
  );
}

function updateSummary() {
  if (!state.config) return;
  const nodes = allNodes();
  const serverDone = nodes
    .map((node) => state.serverResults.get(node.id))
    .filter((result) => result?.ok);
  const browserDone = nodes
    .map((node) => state.browserResults.get(node.id))
    .filter((result) => result?.ok);
  const available = nodes.filter((node) => {
    return state.serverResults.get(node.id)?.ok || state.browserResults.get(node.id)?.ok;
  }).length;
  const serverFastest = serverDone.length
    ? Math.min(...serverDone.map((result) => result.latencyMs))
    : null;
  const browserFastest = browserDone.length
    ? Math.min(...browserDone.map((result) => result.latencyMs))
    : null;
  const allDone = nodes.every(
    (node) => state.serverResults.has(node.id) && state.browserResults.has(node.id),
  );

  els.statOnline.textContent = `${available} / ${nodes.length}`;
  els.statServerFastest.textContent =
    serverFastest === null ? '--' : `${formatLatency(serverFastest)} ms`;
  els.statBrowserFastest.textContent =
    browserFastest === null ? '--' : `${formatLatency(browserFastest)} ms`;

  if (!nodes.length) {
    els.statOnline.textContent = '0 / 0';
    els.statState.textContent = '暂无节点';
  } else if (state.isPinging) {
    els.statState.textContent = '测试中';
  } else {
    els.statState.textContent = allDone ? '已完成' : '待测试';
  }
  els.statState.classList.toggle('is-active', state.isPinging);

  for (const site of state.config.sites) updateSiteMeta(site);
  refreshVisibility();
}

function siteMatches(record, query) {
  return !query || record.searchText.includes(query);
}

function refreshVisibility() {
  if (!state.config) return;
  const query = state.query.trim().toLowerCase();
  let visibleCards = 0;

  for (const record of state.siteEls.values()) {
    const matches = siteMatches(record, query);
    const allDone = record.site.nodes.every(
      (node) => state.serverResults.has(node.id) && state.browserResults.has(node.id),
    );
    const online = record.site.nodes.some(
      (node) => state.serverResults.get(node.id)?.ok || state.browserResults.get(node.id)?.ok,
    );
    const hideAllOffline =
      !state.config.settings.showOffline &&
      allDone &&
      record.site.nodes.length > 0 &&
      !online;
    record.card.hidden = !matches || hideAllOffline;
    if (!record.card.hidden) visibleCards += 1;
  }

  for (const [groupId, section] of state.groupEls) {
    const groupSites = state.config.sites.filter((site) => site.groupId === groupId);
    const visible = groupSites.some((site) => {
      const record = state.siteEls.get(site.id);
      return record && !record.card.hidden;
    });
    section.hidden = !visible;
  }

  if (!state.emptyEl) return;

  if (visibleCards > 0) {
    state.emptyEl.wrapper.hidden = true;
    return;
  }

  if (query) {
    setEmptyState({
      title: '没有匹配的站点',
      text: '换一个关键词，或清除搜索条件查看全部站点。',
      actionLabel: '清除搜索',
      onAction: () => {
        els.search.value = '';
        state.query = '';
        refreshVisibility();
        els.search.focus();
      },
    });
    return;
  }

  const allOffline =
    state.config.sites.length > 0 &&
    allNodes().every((node) => {
      const server = state.serverResults.get(node.id);
      const browser = state.browserResults.get(node.id);
      return server && browser && !server.ok && !browser.ok;
    });

  if (allOffline) {
    setEmptyState({
      title: '当前没有可用节点',
      text: '所有节点均未通过延迟测试，请检查网络或稍后重新测试。',
      actionLabel: '重新测试',
      onAction: () => runPings(),
    });
  } else {
    state.emptyEl.wrapper.hidden = true;
  }
}

function applySearch() {
  state.query = els.search.value;
  refreshVisibility();
}

async function pingPool(nodes, runId, signal) {
  let cursor = 0;
  const workerCount = Math.min(6, nodes.length);

  async function worker() {
    while (cursor < nodes.length) {
      const node = nodes[cursor];
      cursor += 1;
      if (runId !== state.runId) return;

      let result;
      try {
        const response = await fetch('/api/ping', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ nodeId: node.id }),
          cache: 'no-store',
          signal,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
        result = payload;
      } catch (error) {
        if (error.name === 'AbortError') return;
        result = {
          nodeId: node.id,
          ok: false,
          latencyMs: null,
          error: error.message || '延迟测试请求失败',
        };
      }

      if (runId !== state.runId) return;
      state.serverResults.set(node.id, result);
      updateNodeState(node);
      updateSummary();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function browserProbe(node, signal, timeoutMs) {
  let url;
  try {
    url = new URL(node.url);
  } catch {
    return {
      nodeId: node.id,
      ok: false,
      latencyMs: null,
      protocol: 'browser-http',
      error: '节点地址格式错误',
    };
  }

  if (window.location.protocol === 'https:' && url.protocol === 'http:') {
    return {
      nodeId: node.id,
      ok: false,
      latencyMs: null,
      protocol: 'browser-http',
      error: 'HTTPS 页面无法请求 HTTP 节点（混合内容限制）',
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const started = performance.now();

  try {
    await fetch(node.url, {
      mode: 'no-cors',
      cache: 'no-store',
      redirect: 'follow',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
    });
    return {
      nodeId: node.id,
      ok: true,
      latencyMs: Math.max(0.1, Math.round((performance.now() - started) * 10) / 10),
      protocol: 'browser-http',
      error: null,
    };
  } catch {
    if (signal.aborted) return null;
    return {
      nodeId: node.id,
      ok: false,
      latencyMs: null,
      protocol: 'browser-http',
      error: timedOut ? '浏览器请求超时' : '浏览器无法访问节点（网络、证书或跨域策略限制）',
    };
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', abort);
  }
}

async function browserPool(nodes, runId, signal) {
  let cursor = 0;
  const workerCount = Math.min(6, nodes.length);
  const timeoutMs = state.config.settings.pingTimeoutMs;

  async function worker() {
    while (cursor < nodes.length) {
      const node = nodes[cursor];
      cursor += 1;
      if (runId !== state.runId) return;

      const result = await browserProbe(node, signal, timeoutMs);
      if (!result || runId !== state.runId) return;
      state.browserResults.set(node.id, result);
      updateNodeState(node);
      updateSummary();
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

async function runPings() {
  if (!state.config || state.isPinging) return;
  const nodes = allNodes();
  if (!nodes.length) {
    updateSummary();
    return;
  }

  state.runId += 1;
  const runId = state.runId;
  state.isPinging = true;
  state.nextRefreshAt = 0;
  state.abortController?.abort();
  state.abortController = new AbortController();
  state.browserAbortController?.abort();
  state.browserAbortController = new AbortController();

  for (const node of nodes) {
    state.serverResults.delete(node.id);
    state.browserResults.delete(node.id);
    setNodePending(node);
  }

  els.refresh.disabled = true;
  els.refresh.classList.add('is-loading');
  els.countdown.textContent = '正在测试…';
  updateSummary();

  try {
    await Promise.all([
      pingPool(nodes, runId, state.abortController.signal),
      browserPool(nodes, runId, state.browserAbortController.signal),
    ]);
  } finally {
    if (runId === state.runId) {
      state.isPinging = false;
      els.refresh.disabled = false;
      els.refresh.classList.remove('is-loading');
      state.nextRefreshAt =
        Date.now() + Math.max(15, state.config.settings.autoRefreshSeconds) * 1000;
      updateSummary();
      tick();
    }
  }
}

function tick() {
  if (!state.config) return;
  const nodes = allNodes();

  if (!nodes.length) {
    els.countdown.textContent = '暂无节点';
    return;
  }
  if (state.isPinging) {
    els.countdown.textContent = '正在测试…';
    return;
  }
  if (document.hidden) {
    els.countdown.textContent = '后台暂停';
    return;
  }
  if (!state.nextRefreshAt) {
    els.countdown.textContent = '准备测试';
    return;
  }

  const remaining = Math.max(0, Math.ceil((state.nextRefreshAt - Date.now()) / 1000));
  els.countdown.textContent = `${remaining}s 后重测`;

  if (remaining <= 0) {
    runPings();
  }
}

function renderError(message) {
  const wrapper = el('div', 'empty-state');
  const icon = el('span', 'empty-icon');
  icon.appendChild(svgIcon(['M12 8v5', 'M12 16.5v.2', 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z']));
  wrapper.appendChild(icon);
  wrapper.appendChild(el('h2', '', '导航数据加载失败'));
  wrapper.appendChild(el('p', '', message || '请检查服务状态后重试。'));
  const button = el('button', 'button button-primary', '重新加载');
  button.type = 'button';
  button.addEventListener('click', () => load());
  wrapper.appendChild(button);

  els.navRoot.replaceChildren(wrapper);
  els.navRoot.setAttribute('aria-busy', 'false');
  els.countdown.textContent = '加载失败';
  els.statState.textContent = '加载失败';
}

async function load() {
  els.navRoot.setAttribute('aria-busy', 'true');
  els.countdown.textContent = '读取配置…';
  try {
    const [response, sessionResponse] = await Promise.all([
      fetch('/api/nav', { cache: 'no-store' }),
      fetch('/api/admin/session', { cache: 'no-store' }).catch(() => null),
    ]);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    const session = sessionResponse
      ? await sessionResponse.json().catch(() => ({}))
      : {};

    state.config = payload;
    state.authenticated = Boolean(sessionResponse?.ok && session.authenticated);
    els.search.placeholder = state.authenticated
      ? '搜索站点、节点或域名…'
      : '搜索站点或节点…';
    state.runId += 1;
    state.isPinging = false;
    state.nextRefreshAt = 0;
    state.abortController?.abort();
    state.browserAbortController?.abort();

    document.title = payload.settings.title;
    els.title.textContent = payload.settings.title;
    els.subtitle.textContent = payload.settings.subtitle || '选择一个已完成延迟测试的节点进入站点。';
    setBrandText(payload.settings.brandText, payload.settings.brandFont);
    setPageBackground(payload.settings.background, payload.settings.mobileBackground);
    setBackgroundTransparency(payload.settings.backgroundTransparency);
    renderBrandIcon(payload.settings.icon, payload.settings.title);
    updateFavicon(payload.settings.icon);
    if (els.autoRefreshNote) {
      els.autoRefreshNote.textContent = `每 ${payload.settings.autoRefreshSeconds}s 自动重测`;
    }

    renderSites();
    tick();
    await runPings();
  } catch (error) {
    renderError(error.message);
  }
}

els.refresh.addEventListener('click', () => {
  runPings();
});

els.search.addEventListener('input', applySearch);
els.search.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && els.search.value) {
    els.search.value = '';
    applySearch();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  const tagName = target && target.tagName ? target.tagName.toLowerCase() : '';
  if (['input', 'textarea', 'select'].includes(tagName) || target?.isContentEditable) return;
  event.preventDefault();
  els.search.focus();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.config && !state.isPinging) {
    if (state.nextRefreshAt && Date.now() >= state.nextRefreshAt) {
      runPings();
    } else {
      tick();
    }
  }
});

window.setInterval(tick, 1000);
load();
