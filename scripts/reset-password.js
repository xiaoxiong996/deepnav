import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigStore } from '../lib/store.js';
import { hashPassword } from '../lib/security.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.resolve(APP_DIR, '..', 'data');
const password = process.env.NEW_ADMIN_PASSWORD || process.argv[2] || '';

if (password.length < 8 || password.length > 128) {
  console.error('用法：NEW_ADMIN_PASSWORD="至少8位的新密码" node scripts/reset-password.js');
  process.exit(1);
}

const store = new ConfigStore(dataDir);
try {
  await store.init();
  const credentials = await hashPassword(password);
  const next = structuredClone(store.get());
  Object.assign(next.settings, credentials, {
    passwordUpdatedAt: new Date().toISOString(),
  });
  await store.replace(next);
  console.log('[DeepNav] 管理员密码已更新。请重启容器使运行中的服务加载新密码。');
} catch (error) {
  console.error(`[DeepNav] 重置密码失败：${error.message}`);
  process.exit(1);
}
