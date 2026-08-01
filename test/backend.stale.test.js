// "No rows" and "the backend cannot answer" must not look the same.
//
// An Apps Script deployment older than the app does not fail. It answers
// {ok:true, note:'no-op'} with no rows key at all. Both loaders read that as
// `data.rows||[]`, so a whole undeployed feature rendered as "No sessions match
// these filters" and sent people hunting through their filters. This is the
// exact response the live backend returned on 1 Aug 2026.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadApp } from './loadApp.js';

let app, w, doc;
beforeEach(() => { app = loadApp(); w = app.window; doc = app.doc; });

const NO_OP = { ok: true, note: 'no-op' };          // stale deployment
const EMPTY = { ok: true, rows: [] };               // deployed, genuinely no data

function stubBackend(payload) {
  w.fetch = async () => ({
    ok: true, status: 200,
    text: async () => JSON.stringify(payload),
    json: async () => payload,
  });
}

describe('telling a stale backend apart from an empty one', () => {
  it('recognises a no-op reply as stale', () => {
    expect(w.backendStale_(NO_OP)).toBe(true);
  });

  it('does NOT call an empty result stale', () => {
    // The distinction the whole fix rests on. rows:[] means the backend answered
    // and there is genuinely nothing there.
    expect(w.backendStale_(EMPTY)).toBe(false);
  });

  it('treats a missing body as stale rather than as empty', () => {
    expect(w.backendStale_(null)).toBe(true);
    expect(w.backendStale_(undefined)).toBe(true);
  });

  it('accepts a populated result', () => {
    expect(w.backendStale_({ ok: true, rows: [['a', 'b']] })).toBe(false);
  });

  it('the stale message names the cause and the fix, not the filters', () => {
    const h = w.backendStaleHtml_('Sign-in history');
    expect(h).toMatch(/older than this app/i);
    expect(h).toMatch(/Code\.gs/);
    expect(h).toMatch(/Manage deployments/i);
    expect(h).toMatch(/filters are fine/i);
  });

  it('the stale message uses no dash characters', () => {
    expect(w.backendStaleHtml_('The job list')).not.toMatch(/[—–]/);
  });
});

describe('Sign-ins against a stale backend', () => {
  it('says the backend is stale instead of "no sessions match"', async () => {
    stubBackend(NO_OP);
    await w.loadSessions(true);
    const txt = doc.getElementById('sessions-out').textContent;
    expect(txt).toMatch(/older than this app/i);
    expect(txt).not.toMatch(/no sessions match/i);
  });

  it('clears the totals block too, so no stale summary sits above the warning', async () => {
    stubBackend(NO_OP);
    await w.loadSessions(true);
    expect(doc.getElementById('sessions-totals').innerHTML).toBe('');
  });

  it('does not mark sessions as loaded, so a later real load still runs', async () => {
    // Caching a no-op would keep showing the warning after Code.gs is deployed.
    stubBackend(NO_OP);
    await w.loadSessions(true);
    stubBackend({ ok: true, rows: [] });
    await w.loadSessions();
    expect(doc.getElementById('sessions-out').textContent).not.toMatch(/older than this app/i);
  });

  it('still says "no sessions match" when the backend really is deployed and empty', async () => {
    stubBackend(EMPTY);
    await w.loadSessions(true);
    expect(doc.getElementById('sessions-out').textContent).toMatch(/no sessions match/i);
  });
});

describe('All Jobs against a stale backend', () => {
  it('says the backend is stale instead of rendering an empty table', async () => {
    stubBackend(NO_OP);
    await w.loadJobs(true);
    expect(doc.getElementById('jobs-out').textContent).toMatch(/older than this app/i);
  });

  it('does not mark jobs as loaded', async () => {
    stubBackend(NO_OP);
    await w.loadJobs(true);
    stubBackend({ ok: true, rows: [] });
    await w.loadJobs();
    expect(doc.getElementById('jobs-out').textContent).not.toMatch(/older than this app/i);
  });

  it('a real empty Ops DB still renders the normal empty state', async () => {
    stubBackend(EMPTY);
    await w.loadJobs(true);
    expect(doc.getElementById('jobs-out').textContent).not.toMatch(/older than this app/i);
  });
});

describe('a genuine error is still an error', () => {
  it('does not mistake ok:false for a stale backend', async () => {
    stubBackend({ ok: false, error: 'Bad secret' });
    await w.loadSessions(true);
    const txt = doc.getElementById('sessions-out').textContent;
    expect(txt).toMatch(/Bad secret/);
    expect(txt).not.toMatch(/older than this app/i);
  });
});
