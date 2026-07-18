// R12 acceptance — the score/verdict the app surfaces (evalDecision, rendered by
// runEval) is the DETERMINISTIC scoreManual() output plus hard-ban override. The
// model is never called to score. runEval must make NO network request.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadApp, scoreWith } from './loadApp.js';

let app;
beforeAll(() => { app = loadApp(); });

const setJob = (text) => { app.window.document.getElementById('job-text').value = text; };
const STRONG_45 = {
  'c-verified': true, 'c-hire': '2', 'c-spend': '2', 'b-type': 'hourly', 'b-amt': '45',
  'j-scope': '2', 'j-props': '1', 'j-long': false, 'm-match': '3', 'm-proof': true, 'c-us': true,
};

describe('R12: evalDecision() == scoreManual() for non-ban jobs', () => {
  it('React/full-stack $45/hr APPLY — surfaced verdict equals scoreManual', () => {
    setJob('Need a React and FastAPI full-stack dashboard. Hourly $45/hr. Payment verified. United States.');
    scoreWith(app, STRONG_45);
    const s = app.scoreManual();
    const d = app.window.evalDecision();
    expect(d.banned).toBe(false);
    expect(d.total).toBe(s.total);       // same /19
    expect(d.decision).toBe(s.decision); // same verdict
    expect(d.decision).toMatch(/^APPLY/);
  });

  it('50+ saturation — surfaced verdict equals scoreManual with sat -2', () => {
    setJob('React app. Hourly $60/hr. United States. 50 to 100 proposals so far.');
    scoreWith(app, { ...STRONG_45, 'j-props': '3' });
    const s = app.scoreManual();
    const d = app.window.evalDecision();
    expect(d.sat).toBe(-2);
    expect(d.total).toBe(s.total);
    expect(d.decision).toBe(s.decision);
  });
});

describe('R12: hard ban overrides the /19 deterministically', () => {
  it('crypto job — surfaced verdict is a hard-ban SKIP (not the model)', () => {
    setJob('Build a crypto trading dashboard. Hourly $80/hr. United States.');
    scoreWith(app, STRONG_45);
    const d = app.window.evalDecision();
    expect(d.banned).toBe(true);
    expect(d.decision).toBe('SKIP — HARD BAN');
    expect(d.bans).toContain('Banned industry (finance/crypto/trading)');
  });
});

describe('R12: runEval() renders the deterministic card and never calls the model', () => {
  it('no /api/claude (model) call during runEval; card shows the in-app score', async () => {
    setJob('React and FastAPI dashboard. Hourly $45/hr. Payment verified. United States.');
    scoreWith(app, STRONG_45);
    const before = app.fetchCalls.length;
    await app.window.runEval();
    const after = app.fetchCalls.slice(before).map(String);
    // The score is deterministic: runEval must NOT call the model proxy.
    expect(after.some((u) => u.includes('/api/claude'))).toBe(false);
    // It does log the decision via the same-origin CLEval proxy (no secret in browser).
    expect(after).toContain('/api/cleval');

    const html = app.window.document.getElementById('eval-out').innerHTML;
    const d = app.window.evalDecision(); // same DOM state runEval rendered from
    expect(html).toContain(String(d.total));
    expect(html).toContain('deterministic');
    expect(html).not.toMatch(/scored live by Claude/i);
  });
});
