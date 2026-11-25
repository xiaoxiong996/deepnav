import { execFile } from 'node:child_process';

export class ProbeBusyError extends Error {
  constructor(message = '延迟测试队列繁忙，请稍后重试') {
    super(message);
    this.name = 'ProbeBusyError';
    this.statusCode = 503;
  }
}

export function parsePingLatency(output) {
  const match = String(output || '').match(
    /(?:time|时间)\s*[=<]\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i,
  );
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  return Math.max(0.1, Math.round(value * 10) / 10);
}

export function targetHostFromUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('只支持 http:// 或 https:// 目标');
  }
  let host = parsed.hostname;
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) throw new Error('目标地址缺少域名');
  if (host.startsWith('-')) throw new Error('目标域名格式不正确');
  return host;
}

export function buildPingArguments(host, timeoutMs, platform = process.platform) {
  const timeout = Math.max(1000, Number(timeoutMs) || 5000);
  if (platform === 'win32') {
    const args = ['-n', '1', '-w', String(timeout)];
    if (host.includes(':')) args.push('-6');
    args.push(host);
    return args;
  }

  const seconds = String(Math.max(1, Math.ceil(timeout / 1000)));
  return ['-n', '-c', '1', '-W', seconds, '-w', seconds, host];
}

function runPing(host, timeoutMs, platform) {
  const args = buildPingArguments(host, timeoutMs, platform);
  return new Promise((resolve) => {
    execFile(
      'ping',
      args,
      {
        windowsHide: true,
        timeout: Math.max(2500, Number(timeoutMs) + 2000),
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

function failureFromPing(error, stdout, stderr) {
  const text = `${stdout}\n${stderr}`;
  const lower = text.toLowerCase();

  if (error?.code === 'ENOENT') {
    return { error: '服务器缺少 ping 命令', code: 'ENOENT' };
  }
  if (
    /unknown host|name or service not known|temporary failure in name resolution|could not find host|bad address|no address associated/i.test(
      text,
    ) ||
    /无法解析|找不到主机|名称或服务未知/.test(text)
  ) {
    return { error: '域名解析失败', code: 'ENOTFOUND' };
  }
  if (/operation not permitted|permission denied|权限不足|不允许的操作/i.test(text)) {
    return { error: 'ICMP 权限不足', code: 'EPERM' };
  }
  if (
    /network is unreachable|no route to host|destination host unreachable|无法访问目标主机|网络不可达/i.test(
      text,
    )
  ) {
    return { error: '目标不可达', code: 'EHOSTUNREACH' };
  }
  if (
    error?.killed ||
    /request timed out|timed out|timeout|100% packet loss|请求超时|超时/i.test(text)
  ) {
    return { error: 'ICMP 超时', code: 'ETIMEDOUT' };
  }
  if (error?.code) return { error: 'ICMP 探测失败', code: error.code };

  return { error: '无法连接', code: 'UNKNOWN' };
}

export async function probeUrl(url, timeoutMs = 5000) {
  let host;
  try {
    host = targetHostFromUrl(url);
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      protocol: 'icmp',
      error: error.message,
      code: 'EINVAL',
    };
  }

  const { error, stdout, stderr } = await runPing(host, timeoutMs, process.platform);
  if (!error) {
    const latency = parsePingLatency(stdout);
    if (latency !== null) {
      return {
        ok: true,
        latencyMs: latency,
        protocol: 'icmp',
        error: null,
        code: null,
      };
    }
  }

  const failure = failureFromPing(error, stdout, stderr);
  return {
    ok: false,
    latencyMs: null,
    protocol: 'icmp',
    error: failure.error,
    code: failure.code,
  };
}

export class ProbeService {
  constructor({ concurrency = 16, maxQueue = 400, runner = probeUrl } = {}) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.runner = runner;
    this.active = 0;
    this.waiters = [];
  }

  acquire() {
    if (this.active < this.concurrency) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.waiters.length >= this.maxQueue) {
      return Promise.reject(new ProbeBusyError());
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active = Math.max(0, this.active - 1);
  }

  async probe(url, timeoutMs) {
    await this.acquire();
    try {
      return await this.runner(url, timeoutMs);
    } finally {
      this.release();
    }
  }
}
