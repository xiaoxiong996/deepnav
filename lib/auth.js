import { randomToken } from './security.js';

export const SESSION_COOKIE = 'deepnav_session';

export class SessionManager {
  constructor({ ttlMs = 12 * 60 * 60 * 1000, maxSessions = 200 } = {}) {
    this.ttlMs = ttlMs;
    this.maxSessions = maxSessions;
    this.sessions = new Map();
  }

  prune(now = Date.now()) {
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }

  create() {
    const now = Date.now();
    this.prune(now);

    if (this.sessions.size >= this.maxSessions) {
      const oldest = [...this.sessions.entries()].sort(
        (left, right) => left[1].createdAt - right[1].createdAt,
      )[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }

    const token = randomToken(32);
    const session = {
      token,
      csrfToken: randomToken(24),
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.sessions.set(token, session);
    return session;
  }

  get(token) {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session;
  }

  destroy(token) {
    if (token) this.sessions.delete(token);
  }

  clear() {
    this.sessions.clear();
  }
}

export function sessionCookie(token, { secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${12 * 60 * 60}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function expiredSessionCookie({ secure = false } = {}) {
  const parts = [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export class LoginLimiter {
  constructor({ maxAttempts = 5, windowMs = 10 * 60 * 1000 } = {}) {
    this.maxAttempts = maxAttempts;
    this.windowMs = windowMs;
    this.attempts = new Map();
  }

  key(ip) {
    return ip || 'unknown';
  }

  status(ip, now = Date.now()) {
    const record = this.attempts.get(this.key(ip));
    if (!record || record.resetAt <= now) return { blocked: false, remaining: this.maxAttempts };
    const remaining = Math.max(0, this.maxAttempts - record.count);
    return { blocked: remaining === 0, remaining, retryAfter: Math.ceil((record.resetAt - now) / 1000) };
  }

  fail(ip, now = Date.now()) {
    const key = this.key(ip);
    const record = this.attempts.get(key);
    if (!record || record.resetAt <= now) {
      this.attempts.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      record.count += 1;
    }
    this.cleanup(now);
  }

  reset(ip) {
    this.attempts.delete(this.key(ip));
  }

  cleanup(now = Date.now()) {
    if (this.attempts.size < 500) return;
    for (const [key, record] of this.attempts) {
      if (record.resetAt <= now) this.attempts.delete(key);
    }
  }
}

export class RateLimiter {
  constructor({ limit = 300, windowMs = 60 * 1000 } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  consume(ip, now = Date.now()) {
    const key = ip || 'unknown';
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;

    if (this.entries.size > 1000) {
      for (const [entryKey, value] of this.entries) {
        if (value.resetAt <= now) this.entries.delete(entryKey);
      }
    }

    return {
      allowed: entry.count <= this.limit,
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    };
  }
}
