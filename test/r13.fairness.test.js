// R13 acceptance — new-client fairness via achievable-max band scaling.
// Fairness fires ONLY for tenure==='new'. For a new client the unknowable
// history signals (spend, hire, $25/hr-avg) are N/A: removed from earned AND
// from the achievable max, and the decision bands are scaled proportionally
// ((16/14/12/10)/19 * achievableMax) so N/A never counts against them. Non-new
// clients keep today's absolute /19 bands byte-identical.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadApp, scoreWith } from './loadApp.js';

let app;
beforeAll(() => { app = loadApp(); });

// A strong AI hourly job with NO client history ($0 spend, 0 hires, no rating).
const STRONG_JOB_NO_HISTORY = {
  'c-verified': true, 'c-hire': '0', 'c-spend': '0', 'b-type': 'hourly', 'b-amt': '60',
  'j-scope': '2', 'j-props': '1', 'j-long': false, 'm-match': '3', 'm-proof': true, 'c-us': true,
};

describe('R13: brand-new client is scored fairly (not auto-SKIP)', () => {
  it('(a) new client, strong AI hourly job -> APPLY, not SKIP', () => {
    const r = scoreWith(app, { ...STRONG_JOB_NO_HISTORY, 'c-tenure': 'new' });
    // client dim: verified only (spend/hire/$25-avg all N/A) => cli 2, cliMax 2
    expect(r.cli).toBe(2);
    expect(r.cliMax).toBe(2);
    expect(r.achievableMax).toBe(14);   // 2 + job7max + match5max ... here 2+7+5
    expect(r.total).toBe(13);           // 2 + job6 + mat5
    expect(r.decision).toMatch(/^APPLY/); // not SKIP
    expect(r.decision).not.toMatch(/SKIP/);
  });

  it('(b) established client, SAME inputs -> today\'s absolute /19 bands, unchanged', () => {
    const r = scoreWith(app, { ...STRONG_JOB_NO_HISTORY, 'c-tenure': 'established' });
    // non-new: verified2 + hire0 + spend0 + hourly1 = 3; total 3+6+5 = 14
    expect(r.cli).toBe(3);
    expect(r.achievableMax).toBe(19);
    expect(r.total).toBe(14);
    expect(r.decision).toBe('APPLY STANDARD'); // absolute band at 14
  });

  it('(c) fairness genuinely helps: new client band >= established band, never lower', () => {
    const neu = scoreWith(app, { ...STRONG_JOB_NO_HISTORY, 'c-tenure': 'new' });
    const est = scoreWith(app, { ...STRONG_JOB_NO_HISTORY, 'c-tenure': 'established' });
    // new reaches BOOST (13 >= (16/19)*14 = 11.79 with mat>=4); established only STANDARD.
    expect(neu.decision).toBe('APPLY WITH BOOST');
    expect(est.decision).toBe('APPLY STANDARD');
    const rank = { 'SKIP — score too low': 0 };
    const order = (d) => /BOOST/.test(d) ? 4 : /^APPLY STANDARD/.test(d) ? 3
      : /RECOVERY/.test(d) ? 2 : /MARGINAL/.test(d) ? 1 : 0;
    expect(order(neu.decision)).toBeGreaterThanOrEqual(order(est.decision));
  });
});

describe('R13: guardrails — non-new scoring is unchanged', () => {
  it('established, all signals known -> achievableMax 19 and identical to absolute bands', () => {
    const r = scoreWith(app, {
      'c-tenure': 'established', 'c-verified': true, 'c-hire': '2', 'c-spend': '2',
      'b-type': 'hourly', 'b-amt': '75', 'j-scope': '2', 'j-props': '1', 'j-long': false,
      'm-match': '3', 'm-proof': true, 'c-us': true,
    });
    expect(r.achievableMax).toBe(19);
    expect(r).toMatchObject({ cli: 7, job: 6, mat: 5, sat: 0, total: 18, decision: 'APPLY WITH BOOST' });
  });

  it('fixed-price non-new -> cliMax 6, absolute bands unchanged (MARGINAL at 11)', () => {
    const r = scoreWith(app, {
      'c-tenure': 'unknown', 'c-verified': true, 'c-hire': '1', 'c-spend': '1b',
      'b-type': 'fixed', 'b-amt': '500', 'j-scope': '1', 'j-props': '2', 'j-long': false,
      'm-match': '2', 'm-proof': false, 'c-us': true,
    });
    expect(r.cliMax).toBe(6);
    expect(r).toMatchObject({ cli: 4, job: 4, mat: 3, sat: 0, total: 11,
      decision: 'MARGINAL — recover 1-2 pts if legitimate, else skip' });
  });

  it('integrity flag: a NEW account showing large spend/hires is flagged and not awarded', () => {
    const r = scoreWith(app, {
      'c-tenure': 'new', 'c-verified': true, 'c-hire': '2', 'c-spend': '2',
      'b-type': 'hourly', 'b-amt': '60', 'j-scope': '2', 'j-props': '1', 'j-long': false,
      'm-match': '3', 'm-proof': true, 'c-us': true,
    });
    expect(r.integrity).toBe(true); // inconsistent: new but large history
    expect(r.cli).toBe(2);          // large spend/hire NOT awarded at face value
  });
});
