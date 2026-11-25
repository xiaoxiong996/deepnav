import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return {
    passwordHash: Buffer.from(derived).toString('hex'),
    passwordSalt: salt,
  };
}

export async function verifyPassword(password, salt, expectedHash) {
  if (typeof password !== 'string' || !salt || !expectedHash) return false;

  try {
    const expected = Buffer.from(expectedHash, 'hex');
    if (expected.length !== KEY_LENGTH) return false;
    const derived = Buffer.from(await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS));
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function randomPassword() {
  return crypto.randomBytes(12).toString('base64url');
}

export function readCookie(cookieHeader, name) {
  if (!cookieHeader) return '';
  for (const part of cookieHeader.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}
