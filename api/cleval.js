// Vercel serverless function: server-side CLEval logging proxy.
// Keeps CLEVAL_BACKEND (the live Apps Script /exec) and LOG_SECRET in env vars so
// the browser NEVER sees the secret (mirrors how api/claude.js holds ANTHROPIC_API_KEY).
// The browser POSTs { action:'logCLEval', evaluationId, name, row, cells } here with
// no secret; this function injects LOG_SECRET and forwards to the Apps Script.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const backend = process.env.CLEVAL_BACKEND;
  const secret = process.env.LOG_SECRET;
  // Not configured yet -> silent skip so the app keeps working (logging simply off).
  if (!backend || !secret) return res.status(200).json({ ok: false, skipped: "CLEval logging not configured" });
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};
    // Never trust a client-sent secret; force the server one and the correct action.
    const payload = { ...body, action: "logCLEval", secret };
    const r = await fetch(backend, {
      method: "POST",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(r.ok ? 200 : r.status).json(data);
  } catch (e) {
    // Logging must never break the app; report but return 200.
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
