import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

const sha = (s) => createHash('sha256').update(String(s)).digest();
const b64 = (b) => Buffer.from(b).toString('base64url');

export function checkPassword(input, expected) {
  return timingSafeEqual(sha(input ?? ''), sha(expected));
}

/** Stateless HMAC-signed session token: base64url(payload).base64url(hmac). */
export function signToken(secret, ttlSec, nowMs = Date.now()) {
  const payload = b64(JSON.stringify({ exp: nowMs + ttlSec * 1000 }));
  return `${payload}.${b64(createHmac('sha256', secret).update(payload).digest())}`;
}

export function verifyToken(token, secret, nowMs = Date.now()) {
  if (typeof token !== 'string') return false;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return false;
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(sig, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString()).exp > nowMs;
  } catch {
    return false;
  }
}

export function requireAuth(secret) {
  return (req, res, next) => {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!verifyToken(token, secret)) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    next();
  };
}
