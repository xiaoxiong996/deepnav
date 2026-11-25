import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApplication } from './lib/app.js';
import { DEFAULT_ADMIN_PASSWORD } from './lib/store.js';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const port = numberFromEnv('PORT', 8090);
const host = process.env.HOST || '0.0.0.0';
const dataDir = process.env.DATA_DIR || path.join(APP_DIR, 'data');
const initialPassword = process.env.ADMIN_PASSWORD || '';
const cookieSecure = process.env.COOKIE_SECURE === 'true';
const trustProxy = process.env.TRUST_PROXY === 'true';
const hstsSubdomains = process.env.HSTS_INCLUDE_SUBDOMAINS !== 'false';

let application;
try {
  application = await createApplication({
    dataDir,
    initialPassword,
    cookieSecure,
    trustProxy,
    hstsSubdomains,
  });
} catch (error) {
  console.error(`[DeepNav] 启动失败：${error.message}`);
  process.exit(1);
}

application.server.listen(port, host, () => {
  const shownHost = host === '0.0.0.0' ? 'localhost' : host;
  const adminPath = application.store.get().settings.adminPath;
  console.log(`[DeepNav] 导航页已启动：http://${shownHost}:${port}`);
  console.log(`[DeepNav] 管理后台：http://${shownHost}:${port}${adminPath}`);
  console.log(`[DeepNav] 数据目录：${dataDir}`);

  if (application.firstRun) {
    const settings = application.store.get().settings;
    console.warn('');
    console.warn('  ┌──────────────────────────────────────────────────────────────┐');
    console.warn('  │  首次启动，使用的是默认管理员账户，请登录后立即修改：        │');
    console.warn('  └──────────────────────────────────────────────────────────────┘');
    console.warn(`     后台地址：http://${shownHost}:${port}${settings.adminPath}`);
    console.warn(`     用户名　：${settings.adminUsername}`);
    console.warn(`     密码　　：${DEFAULT_ADMIN_PASSWORD}`);
    console.warn('');
    console.warn('  登录后请在「管理员账户」中修改密码，并在「后台访问路径」中换成自己的路径。');
    console.warn('  也可以设置环境变量 ADMIN_PASSWORD 指定初始密码。');
    console.warn('');
  }
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[DeepNav] 收到 ${signal}，正在停止服务…`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  try {
    await application.close();
    process.exit(0);
  } catch (error) {
    console.error('[DeepNav] 停止服务失败', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
