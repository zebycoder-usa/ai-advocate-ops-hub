// Vercel serverless function: server-side CLEval logging proxy.
//
// Keeps CLEVAL_BACKEND (the live Apps Script /exec) and LOG_SECRET in env vars so
// the browser never sees the secret (mirrors how api/claude.js holds the Anthropic
// key). The browser POSTs { evaluationId, name, row } here with no secret; this
// function injects LOG_SECRET and forwards to the Apps Script.
//
// The secret gate in Code.gs is fail-closed and correct. This proxy satisfies it
// on the caller's behalf, so whatever guards this proxy IS the real gate on the
// live sheet. An empty unauthenticated POST used to append a row. See api/_guard.js.
import { guard, safeError } from './_guard.js';

export default async function handler(req, res) {
  const blocked = guard(req);
  if (blocked) return res.status(blocked.status).json(blocked.body);

  const backend = process.env.CLEVAL_BACKEND;
  const secret = process.env.LOG_SECRET;
  if (!backend || !secret) {
    return res.status(200).json({ ok: false, skipped: 'CLEval logging not configured' });
  }

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    // Idempotency in Code.gs is keyed on evaluationId and is skipped entirely
    // when it is absent, so a request without one can append unbounded rows.
    // Require it here rather than letting a malformed caller duplicate.
    if (!body.evaluationId || typeof body.evaluationId !== 'string') {
      return res.status(400).json({ ok: false, error: 'evaluationId is required.' });
    }

    // A row is the only thing worth writing. An empty body used to produce a
    // row of blank cells.
    if (!body.row || typeof body.row !== 'object' || !Object.keys(body.row).length) {
      return res.status(400).json({ ok: false, error: 'row is required.' });
    }

    // The destination tab is the server's decision, not the browser's. Code.gs
    // honours a client-supplied `sheet` against an allowlist that includes a
    // staging tab, so a caller could silently divert every row off the live tab.
    const { sheet, secret: _ignored, action: _also, ...rest } = body;

    const r = await fetch(backend, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...rest, action: 'logCLEval', secret }),
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { ok: false, error: 'Backend returned a non-JSON response.' }; }

    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    // Logging must never break the app, but the caller still needs to know it
    // failed so the UI can show that this decision was not recorded.
    return res.status(200).json({ ok: false, error: safeError(e, 'api/cleval') });
  }
}
