// Covers apiFetch(), the browser half of the shared gate token.
//
// api/_guard.js rejects every request once APP_GATE_TOKEN is set in Vercel. The
// client sent no Authorization header at all, so setting that variable would
// have 401'd all three AI features and CLEval logging for the whole team at
// once. These tests pin the client side so that trap cannot come back.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadApp } from './loadApp.js';

const TOKEN = 'team-key-abc123';

function harness() {
  const app = loadApp();
  const w = app.window;
  const seen = [];
  w.fetch = async (url, opts) => {
    seen.push({ url: String(url), headers: (opts && opts.headers) || {} });
    return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
  };
  return { app, w, seen };
}

function auth(rec) {
  return rec.headers.Authorization || rec.headers.authorization;
}

describe('apiFetch: attaching the shared gate token', () => {
  let h;
  beforeEach(() => { h = harness(); });

  it('exists, because the server rejects untokened calls once the variable is set', () => {
    expect(typeof h.w.apiFetch).toBe('function');
  });

  it('sends no Authorization header when no token is stored', async () => {
    await h.w.apiFetch('/api/claude', { method: 'POST' });
    expect(auth(h.seen[0])).toBeUndefined();
  });

  it('attaches the stored token as a bearer to our own endpoints', async () => {
    h.w.setGateToken(TOKEN);
    await h.w.apiFetch('/api/claude', { method: 'POST' });
    expect(auth(h.seen[0])).toBe('Bearer ' + TOKEN);
  });

  it('attaches it to /api/cleval too, not just the model endpoint', async () => {
    h.w.setGateToken(TOKEN);
    await h.w.apiFetch('/api/cleval', { method: 'POST' });
    expect(auth(h.seen[0])).toBe('Bearer ' + TOKEN);
  });

  it('does NOT leak the token to a third-party URL', async () => {
    // postCLEval's local-dev path posts straight to an Apps Script URL. Our team
    // key has no business being sent there.
    h.w.setGateToken(TOKEN);
    await h.w.apiFetch('https://script.google.com/macros/s/XYZ/exec', { method: 'POST' });
    expect(auth(h.seen[0])).toBeUndefined();
  });

  it('preserves the caller\'s own headers rather than replacing them', async () => {
    h.w.setGateToken(TOKEN);
    await h.w.apiFetch('/api/claude', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    expect(h.seen[0].headers['Content-Type']).toBe('application/json');
    expect(auth(h.seen[0])).toBe('Bearer ' + TOKEN);
  });

  it('does not mutate the options object the caller passed in', async () => {
    h.w.setGateToken(TOKEN);
    const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
    await h.w.apiFetch('/api/claude', opts);
    expect(opts.headers.Authorization).toBeUndefined();
  });
});

describe('apiFetch: recovering from a 401', () => {
  it('asks for the key once and retries, so a rotated token is not a dead app', async () => {
    const app = loadApp();
    const w = app.window;
    const seen = [];
    let first = true;
    w.fetch = async (url, opts) => {
      seen.push({ url: String(url), headers: (opts && opts.headers) || {} });
      if (first) { first = false; return { ok: false, status: 401, json: async () => ({}), text: async () => '' }; }
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    };
    w.prompt = () => TOKEN;

    const res = await w.apiFetch('/api/claude', { method: 'POST' });

    expect(seen).toHaveLength(2);
    expect(auth(seen[1])).toBe('Bearer ' + TOKEN);
    expect(res.status).toBe(200);
    expect(w.gateToken()).toBe(TOKEN);   // remembered, so it asks once per browser
  });

  it('gives up quietly when the operator dismisses the prompt', async () => {
    const app = loadApp();
    const w = app.window;
    const seen = [];
    w.fetch = async (url, opts) => {
      seen.push(String(url));
      return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
    };
    w.prompt = () => null;

    const res = await w.apiFetch('/api/claude', { method: 'POST' });

    expect(seen).toHaveLength(1);   // no retry loop
    expect(res.status).toBe(401);   // the caller still sees the failure and can report it
  });

  it('does not prompt for a 401 from somewhere that is not ours', async () => {
    const app = loadApp();
    const w = app.window;
    let asked = 0;
    w.fetch = async () => ({ ok: false, status: 401, json: async () => ({}), text: async () => '' });
    w.prompt = () => { asked++; return TOKEN; };

    await w.apiFetch('https://script.google.com/macros/s/XYZ/exec', { method: 'POST' });

    expect(asked).toBe(0);
  });
});
