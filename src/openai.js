/** OpenAI Chat Completions call (plain fetch, no SDK). The key never leaves this module. */
export class UpstreamError extends Error {
  constructor(message, status = 502, upstreamStatus = 0) { super(message); this.status = status; this.upstreamStatus = upstreamStatus; }
}

const supportsTemperature = (model) => !/^(o\d|gpt-5)/i.test(model);

export function toOpenAIMessages(system, messages, detail = 'high') {
  const out = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.image) out.push({ role: m.role, content: [{ type: 'text', text: m.text || '' }, { type: 'image_url', image_url: { url: m.image, detail } }] });
    else out.push({ role: m.role, content: m.text || '' });
  }
  return out;
}

export async function chatComplete({ config, fetchImpl, model, system, messages, json, maxTokens, imageDetail }) {
  if (!config.openaiApiKey) throw new UpstreamError('The AI service is not configured yet.', 503);
  const detail = imageDetail || config.imageDetail || 'high';
  const body = { model, messages: toOpenAIMessages(system, messages, detail), max_completion_tokens: maxTokens };
  if (supportsTemperature(model)) body.temperature = 0.2;
  if (json) body.response_format = { type: 'json_object' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.upstreamTimeoutMs);
  let res;
  try {
    res = await fetchImpl(`${config.openaiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.openaiApiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new UpstreamError(e?.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI service.', e?.name === 'AbortError' ? 504 : 502);
  } finally { clearTimeout(timer); }
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) {
    // Never forward upstream error text verbatim (may echo request details); map to friendly errors.
    const msg = res.status === 429 ? 'The AI service is busy right now. Try again in a moment.' : res.status === 400 ? 'The AI could not read that question. Try a clearer selection or snapshot.' : 'The AI service had a problem. Try again.';
    throw new UpstreamError(msg, res.status === 400 ? 422 : 502, res.status);
  }
  const c = data?.choices?.[0]?.message?.content;
  const text = Array.isArray(c) ? c.map((x) => x.text || '').join('') : c || '';
  if (!text) throw new UpstreamError('The AI returned an empty answer. Try again.', 502, res.status);
  return { text, model: data?.model || model, tokens: data?.usage || null };
}
