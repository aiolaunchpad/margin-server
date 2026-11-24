/** All configuration comes from environment variables (see README / .env.example). */
import { randomBytes } from 'node:crypto';

const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  let tokenSecret = env.TOKEN_SECRET || '';
  let ephemeralSecret = false;
  if (!tokenSecret) {
    if (production) throw new Error('TOKEN_SECRET is required in production (use a long random string).');
    tokenSecret = randomBytes(32).toString('hex');
    ephemeralSecret = true;
  }
  return {
    production,
    port: int(env.PORT, 8787),
    host: env.HOST || '0.0.0.0',
    openaiApiKey: env.OPENAI_API_KEY || '',
    openaiBaseUrl: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    model: env.MODEL || 'gpt-4o-mini',
    escalationModel: env.ESCALATION_MODEL || '',
    /** Who gets the escalation model for Double-Check / Explain: 'pro' (default) | 'all' | 'none' */
    escalateFor: env.ESCALATE_FOR || 'pro',
    /** OpenAI vision detail: 'high' (accurate, ~$0.002/snapshot on gpt-4o-mini) | 'low' (cheaper, blurrier) | 'auto' */
    imageDetail: ['high', 'low', 'auto'].includes(env.IMAGE_DETAIL) ? env.IMAGE_DETAIL : 'high',
    tokenSecret,
    ephemeralSecret,
    freeDailyLimit: int(env.FREE_DAILY_LIMIT, 5),
    proDailyLimit: int(env.PRO_DAILY_LIMIT, 0), // 0 = unlimited (soft cap available for abuse control)
    countedTasks: new Set(list(env.COUNTED_TASKS || 'solve,followup,verify,quiz,flashcards')),
    checkoutUrl: env.CHECKOUT_URL || '',
    manageBillingUrl: env.MANAGE_BILLING_URL || '',
    allowedExtensionIds: list(env.ALLOWED_EXTENSION_IDS),
    allowNoOrigin: env.ALLOW_NO_ORIGIN !== 'false',
    adminToken: env.ADMIN_TOKEN || '',
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    dataDir: env.DATA_DIR || './data',
    store: env.STORE || 'sqlite', // 'sqlite' | 'memory'
    maxBodyBytes: int(env.MAX_BODY_BYTES, 8 * 1024 * 1024),
    rateLimitPerMinute: int(env.RATE_LIMIT_PER_MINUTE, 30), // per install + per IP on /complete
    registerPerHour: int(env.REGISTER_PER_HOUR, 20), // per IP
    upstreamTimeoutMs: int(env.UPSTREAM_TIMEOUT_MS, 60000),
    trustProxy: env.TRUST_PROXY !== 'false', // read X-Forwarded-For behind Render/Railway/Fly
  };
}
