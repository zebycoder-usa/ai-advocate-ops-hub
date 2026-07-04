// Vercel serverless function: proxies AI requests to the Anthropic API.
const MODEL = "claude-sonnet-4-6";
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });
  }
  try {
    const { system, messages, max_tokens = 1200, model = MODEL } = req.body || {};
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!r.ok) {
      const msg = (data && data.error && data.error.message) || text || ("HTTP " + r.status);
      return res.status(r.status).json({ error: msg, status: r.status, model });
    }
    return res.status(200).json(data);
  } catch (e) {
    return res.status(500).json({ error: String((e && e.stack) || e) });
  }
}
