/** Anonymous per-install tokens: base64url(JSON payload) + "." + base64url(HMAC-SHA256). */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const INSTALL_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function signToken(payload, secret) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token, secret) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const expect = createHmac('sha256', secret).update(body).digest();
  let got;
  try { got = Buffer.from(sig, 'base64url'); } catch { return null; }
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p || p.v !== 1 || !INSTALL_ID_RE.test(p.iid || '')) return null;
    return p;
  } catch { return null; }
}

export function issueInstallToken(installId, secret) {
  return signToken({ v: 1, iid: installId, iat: Math.floor(Date.now() / 1000), n: randomBytes(4).toString('hex') }, secret);
}
