/** HTTP app (plain node:http). createApp(deps) returns a request handler; index.js wires the real deps. */
import { issueInstallToken, verifyToken, INSTALL_ID_RE } from './tokens.js';
import { RateLimiter } from './ratelimit.js';
import { systemFor, TASKS, MODES, JSON_TASKS, MAX_TOKENS } from './prompts.js';
import { chatComplete, UpstreamError } from './openai.js';
import { verifyStripeSignature, applyStripeEvent } from './stripe.js';
import { imageSizeFromDataUrl } from './image-size.js';

export const VERSION = '1.1.0';
const IMAGE_RE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/;
const MAX_MESSAGES = 30;
const MAX_TEXT = 24000;
const MAX_TOTAL_TEXT = 80000;
const MAX_IMAGES = 4;
const MAX_IMAGE_CHARS = 7 * 1024 * 1024;

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
export function nextUtcMidnight(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round6 = (n) => Math.round(n * 1e6) / 1e6;
const EMPTY_BOX = Object.freeze({ x: 0, y: 0, w: 0, h: 0, confidence: 0 });

/** Parse + clamp a locate-task model response into {x,y,w,h,confidence} in [0,1]. Exported for tests. */
export function normalizeLocateBox(text) {
  let obj = text;
  if (typeof text === 'string') {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return { ...EMPTY_BOX };
    try { obj = JSON.parse(text.slice(start, end + 1)); } catch { return { ...EMPTY_BOX }; }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ...EMPTY_BOX };
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const x0 = num(obj.x), y0 = num(obj.y), w0 = num(obj.w), h0 = num(obj.h);
  if (x0 === null || y0 === null || w0 === null || h0 === null) return { ...EMPTY_BOX };
  const confidence = round6(clamp01(num(obj.confidence) ?? 0));
  let x = clamp01(x0), y = clamp01(y0), w = clamp01(w0), h = clamp01(h0);
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  if (w <= 0 || h <= 0) return { ...EMPTY_BOX };
  return { x: round6(x), y: round6(y), w: round6(w), h: round6(h), confidence };
}

/** Validate + normalize a /complete body. Throws HttpError(400). Exported for tests. */
export function validateCompleteBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'Invalid request body.');
  const task = b.task || 'solve';
  if (!TASKS.includes(task)) throw new HttpError(400, 'Unknown task.');
  const mode = b.mode && MODES.includes(b.mode) ? b.mode : 'answer';
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > MAX_MESSAGES) throw new HttpError(400, 'Invalid messages.');
  let total = 0;
  let images = 0;
  const messages = b.messages.map((m) => {
    if (!m || typeof m !== 'object') throw new HttpError(400, 'Invalid message.');
    const role = m.role === 'assistant' ? 'assistant' : m.role === 'user' ? 'user' : null;
    if (!role) throw new HttpError(400, 'Invalid message role.');
    const text = m.text == null ? '' : m.text;
    if (typeof text !== 'string' || text.length > MAX_TEXT) throw new HttpError(400, 'Message text is too long.');
    total += text.length;
    let image = null;
    if (m.image) {
      if (role !== 'user' || typeof m.image !== 'string' || m.image.length > MAX_IMAGE_CHARS || !IMAGE_RE.test(m.image)) throw new HttpError(400, 'Invalid image.');
      if (++images > MAX_IMAGES) throw new HttpError(400, 'Too many images.');
      image = m.image;
    }
    if (!text && !image) throw new HttpError(400, 'Empty message.');
    return { role, text, image };
  });
  if (total > MAX_TOTAL_TEXT) throw new HttpError(400, 'Request is too long.');
  if (messages[messages.length - 1].role !== 'user') throw new HttpError(400, 'Last message must be from the user.');
  const hasContext = /Relevant excerpts from the student's Notebook/.test(messages[messages.length - 1].text);
  return { task, mode, messages, hasContext };
}

export function createApp({ config, store, fetchImpl = globalThis.fetch, log = () => {}, now = () => new Date() }) {
  const perInstall = new RateLimiter({ limit: config.rateLimitPerMinute, windowMs: 60_000 });
  const perIp = new RateLimiter({ limit: config.rateLimitPerMinute * 2, windowMs: 60_000 });
  const locatePerInstall = new RateLimiter({ limit: config.locateRateLimitPerMinute, windowMs: 60_000 });
  const locatePerIp = new RateLimiter({ limit: config.locateRateLimitPerMinute * 2, windowMs: 60_000 });
  const registerLimiter = new RateLimiter({ limit: config.registerPerHour, windowMs: 3_600_000 });
  const brand = process.env.BRAND_NAME || 'Margin';

  const limitFor = (plan) => (plan === 'pro' ? config.proDailyLimit : config.freeDailyLimit);
  function upgradeUrlFor(iid) {
    if (!config.checkoutUrl) return '';
    try {
      const u = new URL(config.checkoutUrl);
      u.searchParams.set('client_reference_id', iid); // Stripe Payment Links pass this to checkout.session.completed
      return u.toString();
    } catch { return config.checkoutUrl; }
  }
  async function usageFor(iid, plan) {
    const used = await store.getUsed(iid, utcDay(now()));
    const limit = limitFor(plan);
    return { used, limit: limit || null, plan, resetsAt: nextUtcMidnight(now()) };
  }

  /* ---------- plumbing ---------- */
  function clientIp(req) {
    if (config.trustProxy) {
      const xf = req.headers['x-forwarded-for'];
      if (xf) return String(xf).split(',')[0].trim();
    }
    return req.socket?.remoteAddress || 'unknown';
  }
  function originAllowed(origin) {
    if (!origin) return config.allowNoOrigin;
    const m = /^chrome-extension:\/\/([a-p]{32})$/.exec(origin);
    if (!m) return false;
    return !config.allowedExtensionIds.length || config.allowedExtensionIds.includes(m[1]);
  }
  function send(res, status, data, headers = {}) {
    if (res.headersSent) return;
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
    res.end(body);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length'] || 0);
      if (declared > config.maxBodyBytes) { reject(new HttpError(413, 'Request is too large.')); req.resume(); return; }
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > config.maxBodyBytes) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => reject(new HttpError(400, 'Could not read request.')));
    });
  }
  async function readJson(req) {
    const ct = String(req.headers['content-type'] || '');
    if (!/^application\/json\b/i.test(ct)) throw new HttpError(415, 'Content-Type must be application/json.');
    const raw = await readBody(req);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }
  function auth(req) {
    const h = String(req.headers.authorization || '');
    const m = /^Bearer\s+(.+)$/i.exec(h);
    const p = m && verifyToken(m[1].trim(), config.tokenSecret);
    if (!p) throw new HttpError(401, 'Your session expired. Reopen the panel to reconnect.', { code: 'auth' });
    return p.iid;
  }

  /* ---------- routes ---------- */
  async function health() {
    return { status: 200, data: { ok: true, version: VERSION, model: config.model, aiConfigured: !!config.openaiApiKey, store: config.store } };
  }

  async function register(req) {
    const ipOk = registerLimiter.take(clientIp(req));
    if (!ipOk.ok) throw new HttpError(429, 'Too many new sessions from this network. Try again later.', { code: 'rate_limited', retryAfter: ipOk.retryAfter });
    const body = await readJson(req);
    const iid = body.installId;
    if (typeof iid !== 'string' || !INSTALL_ID_RE.test(iid)) throw new HttpError(400, 'Invalid installId.');
    const inst = await store.upsertInstall(iid);
    return { status: 200, data: { token: issueInstallToken(iid, config.tokenSecret), plan: inst.plan, usage: await usageFor(iid, inst.plan), upgradeUrl: upgradeUrlFor(iid) } };
  }

  async function me(req) {
    const iid = auth(req);
    const inst = await store.upsertInstall(iid);
    return { status: 200, data: { user: null, installId: iid, plan: inst.plan, usage: await usageFor(iid, inst.plan), upgradeUrl: upgradeUrlFor(iid), manageBillingUrl: inst.plan === 'pro' ? config.manageBillingUrl : '' } };
  }

  async function complete(req) {
    const iid = auth(req);
    const body = await readJson(req);
    const locateRequest = body && body.task === 'locate';
    const rl = locateRequest ? locatePerInstall.take(iid) : perInstall.take(iid);
    const rlIp = locateRequest ? locatePerIp.take(clientIp(req)) : perIp.take(clientIp(req));
    if (!rl.ok || !rlIp.ok) throw new HttpError(429, 'You’re going a little fast — wait a few seconds and try again.', { code: 'rate_limited', retryAfter: Math.max(rl.retryAfter, rlIp.retryAfter) });
    const { task, mode, messages, hasContext } = validateCompleteBody(body);
    const inst = await store.upsertInstall(iid);
    const plan = inst.plan === 'pro' ? 'pro' : 'free';
    const day = utcDay(now());
    if (task === 'ping') return { status: 200, data: { text: 'ok', usage: await usageFor(iid, plan) } };
    if (task === 'locate') {
      if (messages.length !== 1 || messages[0].role !== 'user' || !messages[0].image) throw new HttpError(400, 'Locate requires exactly one image.');
      const dim = imageSizeFromDataUrl(messages[0].image);
      if (!dim) throw new HttpError(400, 'Invalid image.');
      if (Math.max(dim.width, dim.height) > 1024) throw new HttpError(400, 'Image is too large. Longest side must be 1024 pixels or less.');
    }

    const counted = task !== 'locate' && config.countedTasks.has(task);
    const limit = limitFor(plan);
    if (counted) {
      const r = await store.reserve(iid, day, limit);
      if (!r.ok) {
        throw new HttpError(429, plan === 'pro' ? 'Daily fair-use limit reached. Try again tomorrow.' : `You’ve used all ${limit} free solves for today. Upgrade for unlimited solves, or come back after midnight UTC.`, {
          code: 'quota', upgradeUrl: upgradeUrlFor(iid), usage: { used: r.used, limit: limit || null, plan, resetsAt: nextUtcMidnight(now()) },
        });
      }
    }
    const escalate = config.escalationModel && (task === 'verify' || mode === 'explain') && (config.escalateFor === 'all' || (config.escalateFor === 'pro' && plan === 'pro'));
    const model = escalate ? config.escalationModel : config.model;
    const completeMessages = task === 'locate' ? [{ role: 'user', text: '', image: messages[0].image }] : messages;
    try {
      const out = await chatComplete({
        config, fetchImpl, model,
        system: systemFor({ task, mode, brand, hasContext }),
        messages: completeMessages,
        json: JSON_TASKS.has(task),
        maxTokens: MAX_TOKENS[task],
        imageDetail: task === 'locate' ? 'low' : undefined,
      });
      const text = task === 'locate' ? JSON.stringify(normalizeLocateBox(out.text)) : out.text;
      log({ evt: 'complete', task, mode, model: out.model, plan, tokens: out.tokens?.total_tokens, images: completeMessages.filter((m) => m.image).length });
      return { status: 200, data: { text, model: out.model, usage: await usageFor(iid, plan) } };
    } catch (e) {
      if (counted) await store.release(iid, day); // failed answers never cost the student a solve
      throw e;
    }
  }

  async function adminPlan(req) {
    if (!config.adminToken) throw new HttpError(404, 'Not found.');
    const h = String(req.headers.authorization || '');
    if (h !== `Bearer ${config.adminToken}`) throw new HttpError(401, 'Unauthorized.');
    const { installId, plan } = await readJson(req);
    if (typeof installId !== 'string' || !INSTALL_ID_RE.test(installId) || !['free', 'pro'].includes(plan)) throw new HttpError(400, 'installId and plan (free|pro) required.');
    const inst = await store.setPlan(installId, plan);
    return { status: 200, data: { ok: true, installId, plan: inst.plan } };
  }

  async function stripeWebhook(req) {
    if (!config.stripeWebhookSecret) throw new HttpError(404, 'Not found.');
    const raw = await readBody(req);
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], config.stripeWebhookSecret, { now: now().getTime() })) throw new HttpError(400, 'Invalid signature.');
    let event;
    try { event = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.'); }
    const result = await applyStripeEvent(event, store);
    log({ evt: 'stripe', type: event.type, result });
    return { status: 200, data: { received: true } };
  }

  const routes = {
    'GET /v1/health': health,
    'POST /v1/register': register,
    'GET /v1/me': me,
    'POST /v1/complete': complete,
    'POST /v1/admin/plan': adminPlan,
    'POST /v1/stripe/webhook': stripeWebhook,
  };
  const SERVER_TO_SERVER = new Set(['/v1/stripe/webhook', '/v1/admin/plan']);

  return async function handler(req, res) {
    const started = Date.now();
    const url = new URL(req.url, 'http://local');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    const origin = req.headers.origin;
    const cors = {};
    try {
      if (!SERVER_TO_SERVER.has(pathname)) {
        if (!originAllowed(origin)) throw new HttpError(403, 'Origin not allowed.');
        if (origin) Object.assign(cors, { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
      }
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Client', 'Access-Control-Max-Age': '600' });
        res.end();
        return;
      }
      const route = routes[`${req.method} ${pathname}`];
      if (!route) throw new HttpError(pathname === '/' && req.method === 'GET' ? 200 : 404, pathname === '/' ? 'Margin API — see /v1/health' : 'Not found.');
      const { status, data } = await route(req);
      send(res, status, data, cors);
    } catch (e) {
      const status = e instanceof HttpError || e instanceof UpstreamError ? e.status : 500;
      if (status >= 500 && !(e instanceof UpstreamError)) log({ evt: 'error', path: pathname, message: e?.message });
      if (e instanceof UpstreamError) log({ evt: 'upstream_error', status: e.upstreamStatus || e.status });
      const extra = e instanceof HttpError ? e.extra : {};
      const headers = { ...cors, ...(extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {}) };
      const message = status === 500 ? 'Something went wrong on our side.' : e.message;
      send(res, status, status === 200 ? { ok: true, message } : { error: message, ...extra }, headers);
    } finally {
      if (pathname !== '/v1/health') log({ evt: 'req', method: req.method, path: pathname, status: res.statusCode, ms: Date.now() - started });
    }
  };
}
