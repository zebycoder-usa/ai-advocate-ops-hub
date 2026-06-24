// Vercel serverless function: proxies AI Tutor requests to the Anthropic API.
// Uses the ANTHROPIC_API_KEY env var if present. When no key is configured,
// Anthropic returns a non-OK status and the client falls back to built-in answers.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { system, messages, max_tokens = 1000, model = "claude-sonnet-4-6" } = req.body || {};
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY || "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model, max_tokens, system, messages }),
    });
    const data = await r.json();
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: String(e) });
  }
}
