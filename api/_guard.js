// Shared request guard for the serverless endpoints.
//
// Both /api/claude and /api/cleval were reachable by anyone on the internet:
// /api/claude forwarded arbitrary model + max_tokens + prompts on the owner's
// Anthropic key, and /api/cleval injected LOG_SECRET on behalf of anonymous
// callers, defeating the fail-closed gate in Code.gs.
//
// Layers here, weakest to strongest:
//   1. same-origin check   stops drive-by curl and cross-site pages
//   2. rate limit          caps burst abuse per instance
//   3. shared gate token   real auth, ON as soon as APP_GATE_TOKEN is set
//
// Layer 3 is the one that actually secures this. Until APP_GATE_TOKEN is set in
// Vercel the endpoints stay open to same-origin callers, which is the current
// behaviour plus a ceiling, so nothing breaks on deploy.

const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 30;

// Per-instance. Vercel may run several, so this is a ceiling on burst abuse,
// not a global quota. A shared store would be needed for a hard global limit.
const hits = new Map();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || 'unknown';
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > WINDOW_MS) {
    hits.set(ip, { start: now, n: 1 });
    if (hits.size > 5000) for (const [k, v] of hits) if (now - v.start > WINDOW_MS) hits.delete(k);
    return false;
  }
  rec.n++;
  return rec.n > MAX_PER_WINDOW;
}

function sameOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  if (!host) return false;
  const src = req.headers.origin || req.headers.referer;
  // No Origin and no Referer is a non-browser caller (curl, a script, a bot).
  if (!src) return false;
  try {
    return new URL(src).host === host;
  } catch {
    return false;
  }
}

/**
 * Returns null when the request may proceed, or {status, body} to return as-is.
 * Call as the first thing in every handler.
 */
export function guard(req) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'POST only' } };

  const required = process.env.APP_GATE_TOKEN;
  if (required) {
    const auth = req.headers.authorization || '';
    const sent = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    // Length-independent compare is overkill for a shared team token, but the
    // early-exit compare below leaks nothing useful either way.
    if (!sent || sent !== required) {
      return { status: 401, body: { error: 'Not authorised. Sign in to the Ops Hub and try again.' } };
    }
  } else if (!sameOrigin(req)) {
    return { status: 403, body: { error: 'This endpoint only serves the Ops Hub app.' } };
  }

  if (rateLimited(req)) {
    return { status: 429, body: { error: 'Too many requests. Wait a minute and try again.' } };
  }

  return null;
}

/** Never hand a stack trace to a caller. Logs the detail, returns a safe string. */
export function safeError(e, context) {
  console.error(context, e);
  return 'The server could not complete that request. Zeb can check the Vercel logs.';
}
