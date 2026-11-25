'use strict';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  csrfToken: '',
  activeTab: 'sites',
  saving: false,
  username: '',
  iconTargetInput: null,
  iconUploading: false,
  toastTimer: null,
  saveTimer: null,
};

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

function makeId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function clone(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function hostFromUrl(rawUrl) {
  try {
    return new URL(rawUrl).host;
  } catch {
    return rawUrl;
  }
}

function siteInitial(site) {
  return Array.from(site.name || '?')[0] || '?';
}

function isImageIcon(icon) {
  return /^https?:\/\//i.test(icon || '') || /^\/uploads\//.test(icon || '');
}

function fillIcon(container, icon, fallback) {
  container.replaceChildren();
  if (isImageIcon(icon)) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
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

function updateIconPreview(input) {
  if (!input) return;
  const preview = document.getElementById(`${input.id}-preview`);
  if (!preview) return;
  fillIcon(preview, input.value.trim(), '');
}

function renderBrandText(text, font = 'sans') {
  const value = typeof text === 'string' ? text.trim() : 'DEEPNAV';
  for (const element of document.querySelectorAll('.brand-text')) {
    element.classList.remove('brand-font-sans', 'brand-font-mono', 'brand-font-serif');
    element.classList.add(
      ['mono', 'serif'].includes(font) ? `brand-font-${font}` : 'brand-font-sans',
    );
    if (!value) {
      element.hidden = true;
      element.replaceChildren();
      continue;
    }
    element.hidden = false;
    const characters = Array.from(value);
    const tailLength = Math.min(3, characters.length);
    const head = characters.slice(0, characters.length - tailLength).join('');
    const tail = characters.slice(-tailLength).join('');
    element.replaceChildren();
    if (head) element.appendChild(document.createTextNode(head));
    const accent = document.createElement('em');
    accent.textContent = tail;
    element.appendChild(accent);
  }
}

function defaultBrandMark() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M12 2.8 14.7 9l6.5 3-6.5 3L12 21.2 9.3 15l-6.5-3 6.5-3L12 2.8Z');
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
  circle.setAttribute('cx', '12');
  circle.setAttribute('cy', '12');
  circle.setAttribute('r', '2.2');
  svg.append(path, circle);
  return svg;
}

function renderBrandIcon(icon) {
  for (const element of document.querySelectorAll('.brand-mark')) {
    element.replaceChildren();
    if (isImageIcon(icon)) {
      const image = document.createElement('img');
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener(
        'error',
        () => {
          element.replaceChildren(defaultBrandMark());
        },
        { once: true },
      );
      image.src = icon;
      element.appendChild(image);
      continue;
    }
    if (icon) {
      element.textContent = icon;
      continue;
    }
    element.appendChild(defaultBrandMark());
  }
}

function setAdminBackground(url) {
  const wrapper = $('admin-background');
  const image = $('admin-background-image');
  if (!wrapper || !image) return;
  if (!url) {
    wrapper.hidden = true;
    image.removeAttribute('src');
    return;
  }
  wrapper.hidden = false;
  image.onerror = () => {
    wrapper.hidden = true;
  };
  image.src = url;
}

function applyAdminAppearance() {
  if (!state.config) return;
  renderBrandText(state.config.settings.brandText, state.config.settings.brandFont);
  renderBrandIcon(state.config.settings.icon);
  setAdminBackground(state.config.settings.adminBackground);
  const rounded = Math.max(
    0,
    Math.min(100, Math.round(Number(state.config.settings.backgroundTransparency ?? 30) / 10) * 10),
  );
  for (let level = 0; level <= 100; level += 10) {
    document.body.classList.remove(`bg-transparency-${level}`);
  }
  document.body.classList.add(`bg-transparency-${rounded}`);

  const themeLink = document.querySelector('link[data-theme-color]');
  if (themeLink) {
    const key = state.config.settings.themeColor || 'default';
    if (themeLink.dataset.themeKey !== key) {
      themeLink.dataset.themeKey = key;
      themeLink.href = `/theme.css?v=${Date.now()}`;
    }
  }
}

function showToast(message, type = 'success') {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.toggle('is-error', type === 'error');
  toast.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, type === 'error' ? 5000 : 3000);
}

function setSaveState(status) {
  const element = $('save-state');
  clearTimeout(state.saveTimer);
  element.classList.remove('is-saving', 'is-error');

  if (status === 'saving') {
    element.classList.add('is-saving');
    element.textContent = '保存中…';
  } else if (status === 'error') {
    element.classList.add('is-error');
    element.textContent = '保存失败';
  } else {
    element.textContent = '已保存';
  }
}

async function api(path, options = {}) {
  const { method = 'GET', body } = options;
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
  } catch {
    throw new Error('无法连接服务器，请检查网络后重试');
  }

  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) {
    state.csrfToken = '';
    state.config = null;
    showLogin('登录已失效，请重新登录。');
    throw new Error(payload.error || '请先登录');
  }
  if (!response.ok) {
    throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
  }
  return payload;
}

function showLogin(message = '') {
  const dialog = $('site-dialog');
  if (dialog.open) dialog.close();
  const picker = $('icon-picker');
  if (picker.open) picker.close();
  $('app-loading').hidden = true;
  $('dashboard').hidden = true;
  $('login-view').hidden = false;
  $('login-error').hidden = !message;
  $('login-error').textContent = message;
  $('login-password').value = '';
  if (state.username) $('login-username').value = state.username;
  window.setTimeout(() => {
    if ($('login-username').value.trim()) $('login-password').focus();
    else $('login-username').focus();
  }, 30);
}

function showDashboard() {
  $('app-loading').hidden = true;
  $('login-view').hidden = true;
  $('dashboard').hidden = false;
  setSaveState('saved');
}

function updateDataSummary() {
  if (!state.config) return;
  const nodeCount = state.config.sites.reduce((total, site) => total + site.nodes.length, 0);
  $('data-summary').textContent = `${state.config.groups.length} 分组 · ${state.config.sites.length} 站点 · ${nodeCount} 节点`;
}

function rowButton(action, label, paths, { danger = false, disabled = false } = {}) {
  const button = el('button', `row-button${danger ? ' is-danger' : ''}`);
  button.type = 'button';
  button.dataset.action = action;
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.appendChild(svgIcon(paths));
  return button;
}

const icons = {
  up: ['M12 19V5', 'm6 11 6-6 6 6'],
  down: ['M12 5v14', 'm18 13-6 6-6-6'],
  edit: ['M4 20h4L19 9l-4-4L4 16v4Z', 'm13.5 6.5 4 4'],
  remove: ['M4 7h16', 'M9 7V4h6v3', 'm6 7 1 13h10l1-13', 'M10 11v5', 'M14 11v5'],
};

function createEmptyState({ title, text, actionLabel, onAction }) {
  const wrapper = el('div', 'empty-admin');
  const icon = el('span', 'empty-admin-icon');
  icon.appendChild(
    svgIcon([
      'M4 5.5h16v13H4z',
      'M4 9.5h16',
      'M8 5.5v4',
      'M8 13h4',
    ]),
  );
  wrapper.append(icon, el('h2', '', title), el('p', '', text));
  if (actionLabel) {
    const action = el('button', 'btn btn-primary', actionLabel);
    action.type = 'button';
    action.addEventListener('click', onAction);
    wrapper.appendChild(action);
  }
  return wrapper;
}

/* ---------- Sites ---------- */

function renderSites() {
  const list = $('site-list');
  list.replaceChildren();

  if (!state.config.sites.length) {
    list.appendChild(
      createEmptyState({
        title: '还没有站点',
        text: '添加第一个站点，并为它配置一个或多个节点地址。保存后导航页会自动进行延迟测试。',
        actionLabel: '添加站点',
        onAction: () => openSiteDialog(),
      }),
    );
    return;
  }

  for (const group of state.config.groups) {
    const sites = state.config.sites.filter((site) => site.groupId === group.id);
    if (!sites.length) continue;

    const section = el('section', 'admin-group');
    const heading = el('div', 'admin-group-head');
    heading.append(
      el('h2', 'admin-group-title', group.name),
      el('span', 'admin-group-count', `${sites.length} 个站点`),
    );
    section.appendChild(heading);

    const rows = el('div', 'site-row-list');
    sites.forEach((site, index) => {
      const row = el('article', 'site-row');
      row.dataset.siteId = site.id;

      const icon = el('span', 'site-row-icon');
      fillIcon(icon, site.icon, siteInitial(site));
      row.appendChild(icon);

      const main = el('div', 'site-row-main');
      const titleLine = el('div', 'site-row-titleline');
      titleLine.append(
        el('h3', 'site-row-name', site.name),
        el('span', 'site-badge', `${site.nodes.length} 个地址`),
      );
      if (site.guestHidden) {
        const badge = el('span', 'site-badge is-guest-hidden', '仅登录可见');
        badge.title = '未登录访客看不到该站点及其节点';
        titleLine.appendChild(badge);
      }
      main.appendChild(titleLine);
      if (site.description) main.appendChild(el('p', 'site-row-desc', site.description));

      const chips = el('div', 'site-node-chips');
      for (const node of site.nodes) {
        const chip = el('span', `node-chip${node.guestHidden ? ' is-guest-hidden' : ''}`);
        chip.title = node.guestHidden
          ? `${node.url}\n仅登录可见`
          : node.url;
        chip.append(
          el('span', 'node-chip-name', node.name),
          el('span', 'node-chip-host', hostFromUrl(node.url)),
        );
        if (node.guestHidden) chip.appendChild(el('span', 'node-chip-lock', '锁'));
        chips.appendChild(chip);
      }
      main.appendChild(chips);

      const actions = el('div', 'site-row-actions');
      actions.append(
        rowButton('up', '上移站点', icons.up, { disabled: index === 0 }),
        rowButton('down', '下移站点', icons.down, { disabled: index === sites.length - 1 }),
        rowButton('edit', '编辑站点', icons.edit),
        rowButton('delete', '删除站点', icons.remove, { danger: true }),
      );

      row.append(main, actions);
      rows.appendChild(row);
    });

    section.appendChild(rows);
    list.appendChild(section);
  }
}

function collectGroupNames(config) {
  const inputs = $('group-list').querySelectorAll('.group-name-input');
  for (const input of inputs) {
    const group = config.groups.find((entry) => entry.id === input.dataset.groupId);
    if (!group) continue;
    const value = input.value.trim();
    if (!value) throw new Error('分组名称不能为空');
    group.name = value;
  }
}

async function saveConfig(nextConfig, message) {
  if (state.saving) {
    showToast('正在保存，请稍候…', 'error');
    return false;
  }

  state.saving = true;
  setSaveState('saving');
  try {
    const saved = await api('/api/admin/config', {
      method: 'PUT',
      body: {
        settings: nextConfig.settings,
        groups: nextConfig.groups,
        sites: nextConfig.sites,
      },
    });
    state.config = saved;
    setSaveState('saved');
    renderAll();
    if (message) showToast(message);
    return true;
  } catch (error) {
    setSaveState('error');
    showToast(error.message, 'error');
    return false;
  } finally {
    state.saving = false;
  }
}

async function moveSite(siteId, direction) {
  const next = clone(state.config);
  const site = next.sites.find((entry) => entry.id === siteId);
  if (!site) return;
  const groupSites = next.sites.filter((entry) => entry.groupId === site.groupId);
  const index = groupSites.indexOf(site);
  const target = groupSites[index + direction];
  if (!target) return;

  const first = next.sites.indexOf(site);
  const second = next.sites.indexOf(target);
  [next.sites[first], next.sites[second]] = [next.sites[second], next.sites[first]];
  await saveConfig(next);
}

async function deleteSite(siteId) {
  const site = state.config.sites.find((entry) => entry.id === siteId);
  if (!site) return;
  if (!window.confirm(`确定删除站点「${site.name}」及其 ${site.nodes.length} 个节点吗？`)) return;
  const next = clone(state.config);
  next.sites = next.sites.filter((entry) => entry.id !== siteId);
  await saveConfig(next, '站点已删除');
}

$('site-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('[data-site-id]');
  if (!row) return;
  const siteId = row.dataset.siteId;

  if (button.dataset.action === 'edit') openSiteDialog(siteId);
  if (button.dataset.action === 'delete') deleteSite(siteId);
  if (button.dataset.action === 'up') moveSite(siteId, -1);
  if (button.dataset.action === 'down') moveSite(siteId, 1);
});

/* ---------- Groups ---------- */

function renderGroups() {
  const list = $('group-list');
  list.replaceChildren();

  state.config.groups.forEach((group, index) => {
    const row = el('div', 'group-row');
    row.dataset.groupId = group.id;
    const siteCount = state.config.sites.filter((site) => site.groupId === group.id).length;

    row.appendChild(el('span', 'group-index', String(index + 1).padStart(2, '0')));

    const input = el('input', 'group-name-input');
    input.type = 'text';
    input.maxLength = 30;
    input.value = group.name;
    input.dataset.groupId = group.id;
    input.setAttribute('aria-label', `分组 ${index + 1} 名称`);
    row.appendChild(input);

    row.appendChild(el('span', 'group-site-count', `${siteCount} 个站点`));

    const actions = el('div', 'group-row-actions');
    actions.append(
      rowButton('up', '上移分组', icons.up, { disabled: index === 0 }),
      rowButton('down', '下移分组', icons.down, { disabled: index === state.config.groups.length - 1 }),
      rowButton('delete', '删除分组', icons.remove, {
        danger: true,
        disabled: state.config.groups.length <= 1,
      }),
    );
    row.appendChild(actions);
    list.appendChild(row);
  });
}

async function saveGroups() {
  const next = clone(state.config);
  try {
    collectGroupNames(next);
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  await saveConfig(next, '分组已保存');
}

async function moveGroup(groupId, direction) {
  const next = clone(state.config);
  try {
    collectGroupNames(next);
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  const index = next.groups.findIndex((group) => group.id === groupId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= next.groups.length) return;
  [next.groups[index], next.groups[target]] = [next.groups[target], next.groups[index]];
  await saveConfig(next);
}

async function deleteGroup(groupId) {
  if (state.config.groups.length <= 1) {
    showToast('至少需要保留一个分组', 'error');
    return;
  }
  const group = state.config.groups.find((entry) => entry.id === groupId);
  if (!group) return;
  const next = clone(state.config);
  try {
    collectGroupNames(next);
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }

  const remaining = next.groups.filter((entry) => entry.id !== groupId);
  const target = remaining[0];
  const affected = next.sites.filter((site) => site.groupId === groupId).length;
  const prompt = affected
    ? `删除分组「${group.name}」？其中 ${affected} 个站点将移动到「${target.name}」。`
    : `确定删除分组「${group.name}」吗？`;
  if (!window.confirm(prompt)) return;

  for (const site of next.sites) {
    if (site.groupId === groupId) site.groupId = target.id;
  }
  next.groups = remaining;
  await saveConfig(next, '分组已删除');
}

$('group-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('[data-group-id]');
  if (!row) return;
  const groupId = row.dataset.groupId;

  if (button.dataset.action === 'delete') deleteGroup(groupId);
  if (button.dataset.action === 'up') moveGroup(groupId, -1);
  if (button.dataset.action === 'down') moveGroup(groupId, 1);
});

$('save-groups-button').addEventListener('click', saveGroups);

$('add-group-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('new-group-name');
  const name = input.value.trim();
  if (!name) {
    showToast('请输入分组名称', 'error');
    input.focus();
    return;
  }

  const next = clone(state.config);
  try {
    collectGroupNames(next);
  } catch (error) {
    showToast(error.message, 'error');
    return;
  }
  next.groups.push({ id: makeId(), name });
  const saved = await saveConfig(next, '分组已添加');
  if (saved) {
    input.value = '';
    input.focus();
  }
});

/* ---------- Settings ---------- */

function renderSettings() {
  const settings = state.config.settings;
  $('setting-title').value = settings.title;
  $('setting-brand-text').value = settings.brandText || '';
  $('setting-brand-font').value = settings.brandFont || 'sans';
  $('setting-icon').value = settings.icon || '';
  $('setting-subtitle').value = settings.subtitle || '';
  $('setting-background').value = settings.background || '';
  $('setting-mobile-background').value = settings.mobileBackground || '';
  $('setting-admin-background').value = settings.adminBackground || '';
  $('setting-transparency').value = String(settings.backgroundTransparency ?? 30);
  $('transparency-value').textContent = `${settings.backgroundTransparency ?? 30}%`;
  $('setting-theme-color').value = settings.themeColor || '';
  if (/^#[0-9a-fA-F]{6}$/.test(settings.themeColor || '')) {
    $('setting-theme-picker').value = settings.themeColor;
  }
  $('setting-refresh').value = String(settings.autoRefreshSeconds);
  $('setting-timeout').value = String(settings.pingTimeoutMs);
  $('setting-new-tab').checked = Boolean(settings.openInNewTab);
  $('setting-show-offline').checked = Boolean(settings.showOffline);
  $('setting-hide-nodes').checked = Boolean(settings.hideNodesForGuests);
  if ($('setting-admin-path')) {
    $('setting-admin-path').value = settings.adminPath || '';
  }
  updateIconPreview($('setting-icon'));
  updateIconPreview($('setting-background'));
  updateIconPreview($('setting-mobile-background'));
  updateIconPreview($('setting-admin-background'));
}

$('settings-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;

  const next = clone(state.config);
  next.settings.title = $('setting-title').value.trim();
  next.settings.brandText = $('setting-brand-text').value.trim();
  next.settings.brandFont = $('setting-brand-font').value;
  next.settings.icon = $('setting-icon').value.trim();
  next.settings.subtitle = $('setting-subtitle').value.trim();
  next.settings.background = $('setting-background').value.trim();
  next.settings.mobileBackground = $('setting-mobile-background').value.trim();
  next.settings.adminBackground = $('setting-admin-background').value.trim();
  next.settings.backgroundTransparency = Number($('setting-transparency').value);
  next.settings.themeColor = $('setting-theme-color').value.trim();
  next.settings.autoRefreshSeconds = Number($('setting-refresh').value);
  next.settings.pingTimeoutMs = Number($('setting-timeout').value);
  next.settings.openInNewTab = $('setting-new-tab').checked;
  next.settings.showOffline = $('setting-show-offline').checked;
  next.settings.hideNodesForGuests = $('setting-hide-nodes').checked;

  if (!next.settings.title) {
    showToast('导航标题不能为空', 'error');
    $('setting-title').focus();
    return;
  }

  await saveConfig(next, '设置已保存');
});

function setPasswordMessage(message, type = '') {
  const element = $('password-message');
  element.textContent = message;
  element.className = `form-message${type ? ` is-${type}` : ''}`;
  element.hidden = !message;
}

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.currentTarget.reportValidity()) return;

  const currentPassword = $('current-password').value;
  const newPassword = $('new-password').value;
  const confirmPassword = $('confirm-password').value;
  const newUsername = $('new-username').value.trim();
  setPasswordMessage('');

  if (!newUsername && !newPassword) {
    setPasswordMessage('请填写新用户名或新密码中的至少一项。', 'error');
    return;
  }
  if (!currentPassword) {
    setPasswordMessage('请输入当前密码。', 'error');
    return;
  }
  if (newPassword !== confirmPassword) {
    setPasswordMessage('两次输入的新密码不一致。', 'error');
    return;
  }
  if (newPassword && newPassword.length < 8) {
    setPasswordMessage('新密码至少需要 8 个字符。', 'error');
    return;
  }

  const button = $('save-password-button');
  button.disabled = true;
  button.textContent = '保存中…';
  try {
    const result = await api('/api/admin/password', {
      method: 'POST',
      body: { currentPassword, newPassword, newUsername },
    });
    state.csrfToken = result.csrfToken;
    state.username = newUsername || state.username;
    $('current-password').value = '';
    $('new-username').value = '';
    $('new-password').value = '';
    $('confirm-password').value = '';
    setPasswordMessage('账户信息已更新，其他会话已退出。', 'success');
    showToast(newUsername ? '用户名已更新' : '密码已更新');
  } catch (error) {
    setPasswordMessage(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = '更新密码';
  }
});

function exportableSettings(settings) {
  return {
    title: settings.title,
    subtitle: settings.subtitle,
    icon: settings.icon || '',
    brandText: settings.brandText || '',
    brandFont: settings.brandFont || 'sans',
    background: settings.background || '',
    mobileBackground: settings.mobileBackground || '',
    adminBackground: settings.adminBackground || '',
    backgroundTransparency: settings.backgroundTransparency ?? 30,
    themeColor: settings.themeColor || '',
    autoRefreshSeconds: settings.autoRefreshSeconds,
    pingTimeoutMs: settings.pingTimeoutMs,
    openInNewTab: settings.openInNewTab,
    showOffline: settings.showOffline,
    hideNodesForGuests: Boolean(settings.hideNodesForGuests),
  };
}

$('export-button').addEventListener('click', () => {
  const data = {
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: exportableSettings(state.config.settings),
    groups: state.config.groups,
    sites: state.config.sites,
  };
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `deepnav-config-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  showToast('配置已导出');
});

$('import-button').addEventListener('click', () => $('import-file').click());

$('import-file').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 1024 * 1024) {
    showToast('配置文件不能超过 1 MB', 'error');
    return;
  }

  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    showToast('配置文件不是有效的 JSON', 'error');
    return;
  }
  if (!data || typeof data !== 'object') {
    showToast('配置文件格式不正确', 'error');
    return;
  }
  if (!window.confirm('导入配置将覆盖当前站点、分组和外观设置，确定继续吗？')) return;

  const next = clone(state.config);
  if (data.settings && typeof data.settings === 'object') {
    Object.assign(next.settings, exportableSettings({ ...next.settings, ...data.settings }));
  }
  if (Array.isArray(data.groups)) next.groups = data.groups;
  if (Array.isArray(data.sites)) next.sites = data.sites;

  await saveConfig(next, '配置已导入');
});

/* ---------- Site editor ---------- */

function populateGroupSelect(selectedId) {
  const select = $('site-group');
  select.replaceChildren();
  for (const group of state.config.groups) {
    const option = document.createElement('option');
    option.value = group.id;
    option.textContent = group.name;
    select.appendChild(option);
  }
  if (selectedId && state.config.groups.some((group) => group.id === selectedId)) {
    select.value = selectedId;
  }
}

function createNodeEditorRow(node = {}) {
  const row = el('div', 'node-editor-row');
  row.dataset.nodeId = node.id || makeId();

  const fields = el('div', 'node-editor-fields');

  const nameLabel = el('label', 'node-field');
  nameLabel.appendChild(el('span', '', '节点名称'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.dataset.field = 'name';
  nameInput.placeholder = '例如：主站、备用线路';
  nameInput.value = node.name || '';
  nameLabel.appendChild(nameInput);

  const urlLabel = el('label', 'node-field');
  urlLabel.appendChild(el('span', '', '节点地址'));
  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.maxLength = 2048;
  urlInput.dataset.field = 'url';
  urlInput.placeholder = 'https://example.com';
  urlInput.value = node.url || '';
  urlLabel.appendChild(urlInput);

  fields.append(nameLabel, urlLabel);

  const hiddenLabel = el('label', 'node-hidden-toggle');
  const hiddenInput = document.createElement('input');
  hiddenInput.type = 'checkbox';
  hiddenInput.dataset.field = 'guestHidden';
  hiddenInput.checked = Boolean(node.guestHidden);
  hiddenLabel.append(hiddenInput, el('span', '', '仅登录可见'));
  hiddenLabel.title = '勾选后，未登录访客看不到该节点，也不能对它测速或跳转';

  const actions = el('div', 'node-editor-actions');
  actions.append(
    rowButton('up', '上移节点', icons.up),
    rowButton('down', '下移节点', icons.down),
    rowButton('remove', '删除节点', icons.remove, { danger: true }),
  );

  row.append(fields, hiddenLabel, actions);
  return row;
}

function updateNodeEditorButtons() {
  const list = $('node-editor-list');
  const rows = [...list.querySelectorAll('.node-editor-row')];
  rows.forEach((row, index) => {
    const up = row.querySelector('[data-action="up"]');
    const down = row.querySelector('[data-action="down"]');
    const remove = row.querySelector('[data-action="remove"]');
    if (up) up.disabled = index === 0;
    if (down) down.disabled = index === rows.length - 1;
    if (remove) remove.disabled = rows.length <= 1;
  });
  $('add-node-button').disabled = rows.length >= 12;
}

function openSiteDialog(siteId = null) {
  if (!state.config.groups.length) {
    showToast('请先添加一个分组', 'error');
    return;
  }

  const site = siteId ? state.config.sites.find((entry) => entry.id === siteId) : null;
  $('site-form').reset();
  $('site-form-error').hidden = true;
  $('site-id').value = site?.id || '';
  $('site-dialog-title').textContent = site ? '编辑站点' : '添加站点';
  $('site-name').value = site?.name || '';
  $('site-icon').value = site?.icon || '';
  $('site-description').value = site?.description || '';
  $('site-guest-hidden').checked = Boolean(site?.guestHidden);
  updateIconPreview($('site-icon'));
  populateGroupSelect(site?.groupId);

  const list = $('node-editor-list');
  list.replaceChildren();
  const nodes = site?.nodes?.length ? site.nodes : [{}];
  for (const node of nodes) list.appendChild(createNodeEditorRow(node));
  updateNodeEditorButtons();

  $('site-dialog').showModal();
  window.setTimeout(() => $('site-name').focus(), 30);
}

$('add-site-button').addEventListener('click', () => openSiteDialog());

$('add-node-button').addEventListener('click', () => {
  const list = $('node-editor-list');
  if (list.children.length >= 12) {
    showToast('每个站点最多 12 个节点', 'error');
    return;
  }
  const row = createNodeEditorRow();
  list.appendChild(row);
  updateNodeEditorButtons();
  row.querySelector('[data-field="url"]').focus();
});

$('node-editor-list').addEventListener('click', (event) => {
  const button = event.target.closest('button[data-action]');
  if (!button) return;
  const row = button.closest('.node-editor-row');
  if (!row) return;
  const action = button.dataset.action;

  if (action === 'up' && row.previousElementSibling) {
    row.parentNode.insertBefore(row, row.previousElementSibling);
  }
  if (action === 'down' && row.nextElementSibling) {
    row.parentNode.insertBefore(row.nextElementSibling, row);
  }
  if (action === 'remove') {
    if (row.parentNode.children.length <= 1) {
      showToast('至少需要一个节点地址', 'error');
      return;
    }
    row.remove();
  }
  updateNodeEditorButtons();
});

function closeSiteDialog() {
  $('site-dialog').close();
  $('site-id').value = '';
  $('site-form-error').hidden = true;
}

$('site-dialog-close').addEventListener('click', closeSiteDialog);
$('site-cancel').addEventListener('click', closeSiteDialog);
$('site-dialog').addEventListener('close', () => {
  $('site-form-error').hidden = true;
});

$('site-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorElement = $('site-form-error');
  errorElement.hidden = true;

  const name = $('site-name').value.trim();
  if (!name) {
    errorElement.textContent = '请输入站点名称。';
    errorElement.hidden = false;
    $('site-name').focus();
    return;
  }

  const groupId = $('site-group').value;
  if (!groupId) {
    errorElement.textContent = '请选择所属分组。';
    errorElement.hidden = false;
    return;
  }

  const rows = [...$('node-editor-list').querySelectorAll('.node-editor-row')];
  if (!rows.length) {
    errorElement.textContent = '至少需要一个节点地址。';
    errorElement.hidden = false;
    return;
  }

  const nodes = [];
  for (const row of rows) {
    const urlInput = row.querySelector('[data-field="url"]');
    const nameInput = row.querySelector('[data-field="name"]');
    const url = urlInput.value.trim();
    if (!url) {
      errorElement.textContent = '每个节点都需要填写地址。';
      errorElement.hidden = false;
      urlInput.focus();
      return;
    }
    nodes.push({
      id: row.dataset.nodeId || makeId(),
      name: nameInput.value.trim(),
      url,
      guestHidden: Boolean(row.querySelector('[data-field="guestHidden"]')?.checked),
    });
  }

  const id = $('site-id').value || makeId();
  const site = {
    id,
    groupId,
    name,
    description: $('site-description').value.trim(),
    icon: $('site-icon').value.trim(),
    guestHidden: $('site-guest-hidden').checked,
    nodes,
  };

  const next = clone(state.config);
  const index = next.sites.findIndex((entry) => entry.id === id);
  if (index >= 0) next.sites[index] = site;
  else next.sites.push(site);

  const button = $('site-save');
  button.disabled = true;
  button.textContent = '保存中…';
  const saved = await saveConfig(next, index >= 0 ? '站点已更新' : '站点已添加');
  button.disabled = false;
  button.textContent = '保存站点';

  if (saved) {
    closeSiteDialog();
  } else {
    errorElement.textContent = '保存失败，请查看提示后重试。';
    errorElement.hidden = false;
  }
});

/* ---------- Icon picker and uploads ---------- */

function setIconPickerMessage(message, type = 'error') {
  const element = $('icon-picker-message');
  element.textContent = message;
  element.className = `form-message${type ? ` is-${type}` : ''}`;
  element.hidden = !message;
}

async function loadIconLibrary() {
  const list = $('icon-upload-list');
  list.replaceChildren(el('div', 'icon-empty', '正在读取上传列表…'));

  let payload;
  try {
    payload = await api('/api/admin/uploads');
  } catch (error) {
    list.replaceChildren(el('div', 'icon-empty', error.message));
    return;
  }

  const items = Array.isArray(payload.items) ? payload.items : [];
  if (!items.length) {
    list.replaceChildren(
      el('div', 'icon-empty', '还没有上传图片，点击右上角「上传图片」添加。'),
    );
    return;
  }

  const selectedValue = state.iconTargetInput?.value.trim() || '';
  list.replaceChildren();

  for (const item of items) {
    const wrapper = el('div', 'icon-item');
    const button = el('button', 'icon-choice');
    button.type = 'button';
    button.classList.toggle('is-selected', item.url === selectedValue);
    button.title = `${item.url}\n${new Date(item.modifiedAt).toLocaleString('zh-CN')}`;

    const imageWrap = el('span', 'icon-choice-image');
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.src = item.url;
    image.addEventListener('error', () => imageWrap.replaceChildren(el('span', '', '!')), {
      once: true,
    });
    imageWrap.appendChild(image);

    const date = new Date(item.modifiedAt);
    const meta = `${date.toLocaleDateString('zh-CN')} · ${Math.max(
      1,
      Math.round(item.size / 1024),
    )} KB`;
    button.append(imageWrap, el('span', 'icon-choice-meta', meta));
    button.addEventListener('click', () => selectIcon(item.url));

    const remove = el('button', 'icon-delete', '×');
    remove.type = 'button';
    remove.title = '删除图片';
    remove.setAttribute('aria-label', '删除图片');
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      deleteUpload(item);
    });

    wrapper.append(button, remove);
    list.appendChild(wrapper);
  }
}

async function deleteUpload(item) {
  if (!window.confirm('确定从上传列表删除这张图片吗？')) return;
  try {
    await api(`/api/admin/uploads/${encodeURIComponent(item.url.split('/').pop())}`, {
      method: 'DELETE',
    });
    const inputs = document.querySelectorAll(
      '#setting-icon, #site-icon, #setting-background, #setting-mobile-background, #setting-admin-background',
    );
    for (const input of inputs) {
      if (input.value.trim() === item.url) {
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }
    await loadIconLibrary();
    showToast('图片已删除');
  } catch (error) {
    setIconPickerMessage(error.message);
    showToast(error.message, 'error');
  }
}

function selectIcon(url) {
  if (!state.iconTargetInput) return;
  state.iconTargetInput.value = url;
  state.iconTargetInput.dispatchEvent(new Event('input', { bubbles: true }));
  $('icon-picker').close();
  showToast('图片已选用，保存后生效');
}

function openIconPicker(input) {
  if (!input) return;
  state.iconTargetInput = input;
  setIconPickerMessage('');
  if (!$('icon-picker').open) $('icon-picker').showModal();
  loadIconLibrary();
}

async function uploadIconFile(file) {
  if (!file || !state.iconTargetInput || state.iconUploading) return;
  const allowedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  if (!allowedTypes.includes(file.type)) {
    setIconPickerMessage('只支持 PNG、JPEG、WebP、GIF 图片。');
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    setIconPickerMessage('图片不能超过 5 MB。');
    return;
  }

  state.iconUploading = true;
  setIconPickerMessage('');
  const button = $('icon-upload-button');
  button.disabled = true;
  button.textContent = '上传中…';

  try {
    const response = await fetch('/api/admin/uploads', {
      method: 'POST',
      headers: {
        'Content-Type': file.type,
        'X-CSRF-Token': state.csrfToken,
      },
      body: file,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401) {
      state.csrfToken = '';
      state.config = null;
      showLogin('登录已失效，请重新登录。');
      return;
    }
    if (!response.ok) throw new Error(payload.error || `上传失败（HTTP ${response.status}）`);

    if (!state.iconTargetInput) {
      showToast('图片已上传，可重新打开列表选择');
      return;
    }
    state.iconTargetInput.value = payload.url;
    state.iconTargetInput.dispatchEvent(new Event('input', { bubbles: true }));
    $('icon-picker').close();
    showToast('图片已上传并选用，保存后生效');
  } catch (error) {
    setIconPickerMessage(error.message);
  } finally {
    state.iconUploading = false;
    button.disabled = false;
    button.textContent = '上传图片';
    $('icon-upload-file').value = '';
  }
}

for (const button of document.querySelectorAll('.icon-picker-button')) {
  button.addEventListener('click', () => {
    openIconPicker($(button.dataset.iconInput));
  });
}

for (const id of [
  'setting-icon',
  'site-icon',
  'setting-background',
  'setting-mobile-background',
  'setting-admin-background',
]) {
  $(id).addEventListener('input', () => updateIconPreview($(id)));
}

$('setting-transparency').addEventListener('input', () => {
  $('transparency-value').textContent = `${$('setting-transparency').value}%`;
});

$('setting-theme-color').addEventListener('input', () => {
  const value = $('setting-theme-color').value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) $('setting-theme-picker').value = value;
});

$('setting-theme-picker').addEventListener('input', () => {
  $('setting-theme-color').value = $('setting-theme-picker').value;
});

$('icon-upload-button').addEventListener('click', () => $('icon-upload-file').click());
$('icon-upload-file').addEventListener('change', (event) => {
  uploadIconFile(event.target.files?.[0]);
});
$('icon-picker-close').addEventListener('click', () => $('icon-picker').close());
$('icon-picker-done').addEventListener('click', () => $('icon-picker').close());
$('icon-picker').addEventListener('close', () => {
  state.iconTargetInput = null;
  setIconPickerMessage('');
  $('icon-upload-file').value = '';
});

/* ---------- Tabs, boot, auth ---------- */

function switchTab(tab) {
  state.activeTab = tab;
  const tabs = [...document.querySelectorAll('.sidebar-tab')];
  for (const button of tabs) {
    const active = button.dataset.tab === tab;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.hidden = panel.id !== `panel-${tab}`;
  }

  if (tab === 'sites') renderSites();
  if (tab === 'groups') renderGroups();
  if (tab === 'settings') renderSettings();
}

for (const button of document.querySelectorAll('.sidebar-tab')) {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
}

$('logout-button').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST' });
    state.csrfToken = '';
    state.config = null;
    showLogin();
    showToast('已退出登录');
  } catch (error) {
    if (state.csrfToken) showToast(error.message, 'error');
  }
});

// Lets the operator rotate the admin path without editing files on the server.
const pathForm = $('admin-path-form');
if (pathForm) {
  $('admin-path-random')?.addEventListener('click', () => {
    const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    let slug = '';
    for (const byte of bytes) slug += alphabet[byte % alphabet.length];
    $('setting-admin-path').value = `/m-${slug}`;
  });
  pathForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = $('setting-admin-path');
    const value = input.value.trim();
    if (!value) {
      showToast('请填写新的后台路径', 'error');
      return;
    }
    try {
      const result = await api('/api/admin/path', {
        method: 'POST',
        body: { adminPath: value },
      });
      state.config = result.config;
      input.value = result.config.settings.adminPath;
      showToast(`后台路径已改为 ${result.config.settings.adminPath}，正在跳转…`);
      // The old URL stops existing the moment the config is saved.
      setTimeout(() => {
        window.location.href = result.config.settings.adminPath;
      }, 900);
    } catch (error) {
      showToast(error.message, 'error');
    }
  });
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = $('login-username').value.trim();
  const password = $('login-password').value;
  const errorElement = $('login-error');
  const button = $('login-button');
  errorElement.hidden = true;

  if (!username) {
    errorElement.textContent = '请输入管理员用户名。';
    errorElement.hidden = false;
    $('login-username').focus();
    return;
  }
  if (!password) {
    errorElement.textContent = '请输入管理员密码。';
    errorElement.hidden = false;
    $('login-password').focus();
    return;
  }

  button.disabled = true;
  button.textContent = '登录中…';
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `登录失败（HTTP ${response.status}）`);

    state.csrfToken = payload.csrfToken;
    state.username = payload.username || username;
    const config = await api('/api/admin/config');
    state.config = config;
    $('login-password').value = '';
    renderAll();
    showDashboard();
    showToast('登录成功');
  } catch (error) {
    errorElement.textContent = error.message;
    errorElement.hidden = false;
    $('login-password').select();
  } finally {
    button.disabled = false;
    button.textContent = '登录';
  }
});

function renderAll() {
  if (!state.config) return;
  renderSites();
  renderGroups();
  renderSettings();
  renderDefaultCredentialsWarning();
  updateDataSummary();
  applyAdminAppearance();
  setSaveState('saved');
}

// The default password is published with the project, so anyone who reaches
// this page can log in until it is changed.
function renderDefaultCredentialsWarning() {
  const banner = $('default-credentials-warning');
  if (!banner) return;
  banner.hidden = !state.config?.settings?.defaultCredentials;
}

async function boot() {
  try {
    const response = await fetch('/api/admin/session', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const session = await response.json().catch(() => ({}));
    if (!response.ok || !session.authenticated) {
      showLogin();
      return;
    }

    state.csrfToken = session.csrfToken;
    state.username = session.username || '';
    const config = await api('/api/admin/config');
    state.config = config;
    renderAll();
    switchTab('sites');
    showDashboard();
  } catch (error) {
    showLogin(error.message === '请先登录' ? '' : '无法加载后台，请检查服务状态。');
  }
}

boot();
