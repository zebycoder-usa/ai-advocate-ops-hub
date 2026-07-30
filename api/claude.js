// Vercel serverless function: proxies AI requests to the Anthropic API.
//
// This endpoint spends real money on the owner's Anthropic key. It used to
// accept any model, any max_tokens, and any prompt from any caller on the
// internet, with a POST check as its only guard. See api/_guard.js.
import { guard, safeError } from './_guard.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';

// Only the models this app actually uses. An unlisted model means a caller
// picking their own, which is not the Ops Hub.
const ALLOWED_MODELS = new Set(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);

// The app's largest legitimate request is genProposal at 2200.
const MAX_TOKENS_CEILING = 3000;

// Guards against a caller pasting a book in to burn tokens. The longest real
// input is a full Upwork page plus the agency brief, well under this.
const MAX_INPUT_CHARS = 60000;

export default async function handler(req, res) {
  const blocked = guard(req);
  if (blocked) return res.status(blocked.status).json(blocked.body);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const { system, messages } = body;

    if (!Array.isArray(messages) || !messages.length) {
      return res.status(400).json({ error: 'messages is required.' });
    }

    const model = ALLOWED_MODELS.has(body.model) ? body.model : DEFAULT_MODEL;

    const requested = Number(body.max_tokens);
    const max_tokens = Number.isFinite(requested)
      ? Math.min(Math.max(1, Math.trunc(requested)), MAX_TOKENS_CEILING)
      : 1200;

    if (JSON.stringify({ system, messages }).length > MAX_INPUT_CHARS) {
      return res.status(413).json({ error: 'That job post is too long to analyse. Trim it and retry.' });
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    if (!r.ok) {
      // Anthropic's own message is useful to the operator (rate limit, credit
      // balance, overload) and carries no secret, so it is worth surfacing.
      const msg = (data && data.error && data.error.message) || ('Upstream error (HTTP ' + r.status + ').');
      console.error('anthropic error', r.status, msg);
      return res.status(r.status).json({ error: msg, status: r.status, model });
    }

    return res.status(200).json(data || { error: 'Upstream returned a non-JSON response.' });
  } catch (e) {
    return res.status(500).json({ error: safeError(e, 'api/claude') });
  }
}
