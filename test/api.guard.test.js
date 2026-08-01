// Covers api/_guard.js and the two serverless handlers.
//
// Before this, api/ had no tests at all. /api/claude forwarded any model and any
// max_tokens on the live Anthropic key to any caller, and /api/cleval injected
// LOG_SECRET for anonymous callers, which appended a row to the live sheet from
// an empty POST. Nothing here touches the network: global fetch is stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { guard } from '../api/_guard.js';

const HOST = 'ai-advocate-ops-hub.vercel.app';

// `headers` MERGES onto the app-origin default. `bareHeaders` REPLACES it, which
// is how you build a caller that sends no Origin and no Referer, i.e. curl.
function req(over = {}) {
  const { headers, bareHeaders, ...rest } = over;
  return {
    method: 'POST',
    headers: bareHeaders || { host: HOST, origin: `https://${HOST}`, ...(headers || {}) },
    socket: { remoteAddress: `10.0.0.${Math.floor(Math.random() * 250) + 1}` },
    body: {},
    ...rest,
  };
}

function res() {
  const out = { code: 200, payload: null };
  out.status = (c) => { out.code = c; return out; };
  out.json = (p) => { out.payload = p; return out; };
  return out;
}

const ENV = { ...process.env };
beforeEach(() => {
  delete process.env.APP_GATE_TOKEN;
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.CLEVAL_BACKEND = 'https://script.google.com/macros/s/TEST/exec';
  process.env.LOG_SECRET = 'test-log-secret';
});
afterEach(() => { process.env = { ...ENV }; vi.unstubAllGlobals(); });

describe('guard: method and origin', () => {
  it('rejects anything that is not a POST', () => {
    expect(guard(req({ method: 'GET' })).status).toBe(405);
  });

  it('rejects a caller with no Origin and no Referer, which is how curl arrives', () => {
    const r = guard(req({ bareHeaders: { host: HOST } }));
    expect(r.status).toBe(403);
  });

  it('rejects a request whose Origin is a different site', () => {
    const r = guard(req({ headers: { host: HOST, origin: 'https://attacker.example' } }));
    expect(r.status).toBe(403);
  });

  it('allows the app calling itself', () => {
    expect(guard(req())).toBeNull();
  });

  it('accepts Referer when Origin is absent, as some browsers send only Referer', () => {
    const r = guard(req({ headers: { host: HOST, referer: `https://${HOST}/index.html` } }));
    expect(r).toBeNull();
  });
});

describe('guard: shared gate token', () => {
  it('demands the token once APP_GATE_TOKEN is set, even from the app origin', () => {
    process.env.APP_GATE_TOKEN = 's3cret';
    expect(guard(req()).status).toBe(401);
  });

  it('rejects a wrong token', () => {
    process.env.APP_GATE_TOKEN = 's3cret';
    const r = guard(req({ headers: { host: HOST, origin: `https://${HOST}`, authorization: 'Bearer nope' } }));
    expect(r.status).toBe(401);
  });

  it('accepts the right token from any origin, so the token is the real gate', () => {
    process.env.APP_GATE_TOKEN = 's3cret';
    const r = guard(req({ headers: { host: HOST, authorization: 'Bearer s3cret' } }));
    expect(r).toBeNull();
  });
});

describe('guard: rate limit', () => {
  it('cuts a caller off after a burst from one address', () => {
    const ip = '203.0.113.9';
    const mk = () => req({ socket: { remoteAddress: ip }, headers: { host: HOST, origin: `https://${HOST}`, 'x-forwarded-for': ip } });
    let limited = 0;
    for (let i = 0; i < 60; i++) if (guard(mk())?.status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
  });
});

describe('/api/claude', () => {
  async function call(body, bareHeaders) {
    const mod = await import('../api/claude.js?t=' + Math.random());
    const q = req(bareHeaders ? { body, bareHeaders } : { body });
    const s = res();
    await mod.default(q, s);
    return s;
  }

  it('refuses an anonymous caller before spending a single token', async () => {
    const seen = [];
    vi.stubGlobal('fetch', (...a) => { seen.push(a); return Promise.resolve(new Response('{}')); });
    const s = await call({ messages: [{ role: 'user', content: 'hi' }] }, { host: HOST });
    expect(s.code).toBe(403);
    expect(seen).toHaveLength(0); // never reached Anthropic
  });

  it('rejects a request with no messages instead of forwarding it', async () => {
    const seen = [];
    vi.stubGlobal('fetch', (...a) => { seen.push(a); return Promise.resolve(new Response('{}')); });
    const s = await call({});
    expect(s.code).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('forces an unlisted model back to the app default', async () => {
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":1}')); });
    await call({ model: 'claude-opus-5', messages: [{ role: 'user', content: 'hi' }] });
    expect(sent.model).toBe('claude-sonnet-4-6');
  });

  it('caps max_tokens no matter what the caller asks for', async () => {
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":1}')); });
    await call({ max_tokens: 200000, messages: [{ role: 'user', content: 'hi' }] });
    expect(sent.max_tokens).toBeLessThanOrEqual(3000);
  });

  it('still passes through the app\'s own legitimate request unchanged', async () => {
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":1}')); });
    await call({ model: 'claude-sonnet-4-6', max_tokens: 2200, system: 'brief', messages: [{ role: 'user', content: 'job' }] });
    expect(sent.model).toBe('claude-sonnet-4-6');
    expect(sent.max_tokens).toBe(2200);
    expect(sent.system).toBe('brief');
  });

  it('never returns a stack trace to the caller', async () => {
    vi.stubGlobal('fetch', () => { throw new Error('boom at /var/task/api/claude.js:42'); });
    const s = await call({ messages: [{ role: 'user', content: 'hi' }] });
    expect(s.code).toBe(500);
    expect(s.payload.error).not.toMatch(/\.js:\d+/);   // no file:line
    expect(s.payload.error).not.toMatch(/\/var\/task/);  // no server path
    expect(s.payload.error).not.toMatch(/boom/);        // not the raw throw
  });
});

describe('/api/cleval', () => {
  async function call(body, bareHeaders) {
    const mod = await import('../api/cleval.js?t=' + Math.random());
    const q = req(bareHeaders ? { body, bareHeaders } : { body });
    const s = res();
    await mod.default(q, s);
    return s;
  }

  it('does not write a row for an anonymous caller', async () => {
    const seen = [];
    vi.stubGlobal('fetch', (...a) => { seen.push(a); return Promise.resolve(new Response('{"ok":true}')); });
    const s = await call({ evaluationId: 'e1', row: { jobTitle: 'x' } }, { host: HOST });
    expect(s.code).toBe(403);
    expect(seen).toHaveLength(0);
  });

  it('refuses an empty body, which used to append a row of blank cells', async () => {
    const seen = [];
    vi.stubGlobal('fetch', (...a) => { seen.push(a); return Promise.resolve(new Response('{"ok":true}')); });
    const s = await call({});
    expect(s.code).toBe(400);
    expect(seen).toHaveLength(0);
  });

  it('requires an evaluationId, because without one the backend cannot dedupe', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"ok":true}')));
    const s = await call({ row: { jobTitle: 'x' } });
    expect(s.code).toBe(400);
    expect(String(s.payload.error)).toMatch(/evaluationId/i);
  });

  it('strips a client-chosen destination tab so rows cannot be diverted', async () => {
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":true}')); });
    await call({ evaluationId: 'e1', row: { jobTitle: 'x' }, sheet: 'CLEval_StagingTest' });
    expect(sent.sheet).toBeUndefined();
  });

  it('overrides any client-supplied secret with the server one', async () => {
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":true}')); });
    await call({ evaluationId: 'e1', row: { jobTitle: 'x' }, secret: 'guessed' });
    expect(sent.secret).toBe('test-log-secret');
  });

  it('forwards a listCLEval read instead of rewriting it as a write', async () => {
    // The proxy used to force action:'logCLEval' on every request, so the read
    // endpoints were unreachable through it and the All Jobs tab could never
    // load. It answered "evaluationId is required" to a list request.
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":true,"rows":[]}')); });
    const s = await call({ action: 'listCLEval', limit: 10 });
    expect(sent.action).toBe('listCLEval');
    expect(s.code).toBe(200);
  });

  it('does not demand evaluationId or row on a read', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"ok":true,"rows":[]}')));
    const s = await call({ action: 'listCLEval' });
    expect(s.code).toBe(200);
  });

  it('forwards a listSessions read', async () => {
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":true,"rows":[]}')); });
    await call({ action: 'listSessions' });
    expect(sent.action).toBe('listSessions');
  });

  it('forwards a status update, and still requires the id it needs', async () => {
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":true}')); });
    await call({ action: 'updateCLEvalStatus', evaluationId: 'ev_1', status: 'Hired' });
    expect(sent.action).toBe('updateCLEvalStatus');
    const bad = await call({ action: 'updateCLEvalStatus', status: 'Hired' });
    expect(bad.code).toBe(400);
  });

  it('refuses an action that is not on the allowlist by falling back to the write path', async () => {
    // A caller must not be able to invoke arbitrary backend actions through here.
    vi.stubGlobal('fetch', () => Promise.resolve(new Response('{"ok":true}')));
    const s = await call({ action: 'forceRelease', name: 'Saqib Shahzad' });
    expect(s.code).toBe(400);   // treated as a write, which needs an evaluationId
  });

  it('forwards a well formed row from the app', async () => {
    let sent;
    vi.stubGlobal('fetch', (_u, o) => { sent = JSON.parse(o.body); return Promise.resolve(new Response('{"ok":true,"row":7}')); });
    const s = await call({ evaluationId: 'e-42', name: 'Waqas Riaz', row: { jobTitle: 'n8n AI Automation Expert' } });
    expect(sent.action).toBe('logCLEval');
    expect(sent.evaluationId).toBe('e-42');
    expect(s.payload).toEqual({ ok: true, row: 7 });
  });
});
