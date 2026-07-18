// Characterization tests — Phase 2. These LOCK IN the current deterministic
// behavior of the real parseJob() and scoreManual() in index.html so a later
// refactor (making scoreManual the authoritative score, per risk R12) can be
// proven behavior-preserving. They document what the code does today, not what
// it ideally should do.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadApp, scoreWith } from './loadApp.js';

let app;
beforeAll(() => { app = loadApp(); });

describe('safety: the harness never touches the network', () => {
  it('stubbed fetch was the only fetch and it never resolved to a live call', () => {
    // seatBoot() on load calls fetch(SEAT_BACKEND). Our stub rejects it.
    // Assert every recorded fetch went to the Apps Script /exec (blocked), nothing else.
    app.fetchCalls.forEach((u) => {
      expect(String(u)).toMatch(/script\.google\.com|^$|undefined/);
    });
  });
});

describe('parseJob(): hard bans and flags (characterization)', () => {
  it('fixed-price under $200 is a hard ban', () => {
    const P = app.parseJob('Fixed-price project. Budget: $150. Build a small landing page.');
    expect(P.budgetType).toBe('fixed');
    expect(P.amount).toBe(150);
    expect(P.bans).toContain('Fixed-price under $200 ($150)');
  });

  it('crypto / trading is a banned industry', () => {
    const P = app.parseJob('We need a trading bot for our crypto hedge fund.');
    expect(P.bans).toContain('Banned industry (finance/crypto/trading)');
  });

  it('weapons / defense is a banned industry', () => {
    const P = app.parseJob('Build software for a military defense contractor.');
    expect(P.bans).toContain('Banned industry (weapons/defense)');
  });

  it('banned company is caught', () => {
    const P = app.parseJob('Automation project for the CVS Health analytics team.');
    expect(P.bans).toContain('Banned company');
  });

  it('confirmed India client is a hard-ban country', () => {
    const P = app.parseJob('Client located in Mumbai, India. Hourly $60/hr.');
    expect(P.isBanCountry).toBe(true);
    expect(P.region).toBe('India/Bangladesh');
    expect(P.bans).toContain('Client in India/Bangladesh/Pakistan (hard ban)');
  });

  it('"Indiana" is NOT treated as India (guard)', () => {
    const P = app.parseJob('Client in Indiana, USA. Hourly $60/hr. Payment verified.');
    expect(P.isBanCountry).toBe(false);
    expect(P.region).toBe('US');
  });

  it('below $40/hr hourly is a review FLAG, not a ban', () => {
    const P = app.parseJob('Hourly rate $30/hr for a long project.');
    expect(P.budgetType).toBe('hourly');
    expect(P.amount).toBe(30);
    expect(P.belowBudget).toBe(true);
    expect(P.flags).toContain('Below $40/hr rate floor — review before bidding');
    expect(P.bans).toEqual([]);
  });

  it('clean US hourly job has no bans', () => {
    const P = app.parseJob('Hourly $75/hr. Payment verified. United States based client.');
    expect(P.budgetType).toBe('hourly');
    expect(P.amount).toBe(75);
    expect(P.verified).toBe(true);
    expect(P.region).toBe('US');
    expect(P.bans).toEqual([]);
  });
});

describe('scoreManual(): 19-point math, saturation, decision bands (characterization)', () => {
  const STRONG = {
    'c-verified': true, 'c-hire': '2', 'c-spend': '2',
    'b-type': 'hourly', 'b-amt': '75', 'j-scope': '2', 'j-props': '1',
    'j-long': false, 'm-match': '3', 'm-proof': true, 'c-us': true,
  };

  it('strong hourly job -> APPLY WITH BOOST', () => {
    const r = scoreWith(app, STRONG);
    expect(r).toMatchObject({ cli: 7, job: 6, mat: 5, sat: 0, total: 18,
      decision: 'APPLY WITH BOOST' });
  });

  it('50+ proposals applies the -2 saturation penalty', () => {
    const r = scoreWith(app, { ...STRONG, 'j-props': '3' });
    expect(r.sat).toBe(-2);
    expect(r.job).toBe(4);      // scope2 + meets2 + props(50+)=0
    expect(r.total).toBe(14);   // 7 + 4 + 5 - 2
    expect(r.decision).toBe('APPLY STANDARD');
  });

  it('borderline $35/hr earns 1 budget point (not 2)', () => {
    const r = scoreWith(app, { ...STRONG, 'b-amt': '35' });
    expect(r.job).toBe(5);      // scope2 + border1 + props2
    expect(r.total).toBe(17);
    expect(r.decision).toBe('APPLY WITH BOOST');
  });

  it('fixed-price drops the hourly point (cliMax 6) -> MARGINAL band', () => {
    const r = scoreWith(app, {
      'c-verified': true, 'c-hire': '1', 'c-spend': '1b',
      'b-type': 'fixed', 'b-amt': '500', 'j-scope': '1', 'j-props': '2',
      'j-long': false, 'm-match': '2', 'm-proof': false, 'c-us': true,
    });
    expect(r).toMatchObject({ cli: 4, job: 4, mat: 3, sat: 0, total: 11,
      decision: 'MARGINAL — recover 1-2 pts if legitimate, else skip' });
  });

  it('weak job below 10 -> SKIP', () => {
    const r = scoreWith(app, {
      'c-verified': false, 'c-hire': '0', 'c-spend': '0',
      'b-type': 'hourly', 'b-amt': '20', 'j-scope': '0', 'j-props': '3',
      'j-long': false, 'm-match': '0', 'm-proof': false, 'c-us': false,
    });
    expect(r.sat).toBe(-2);
    expect(r.total).toBe(-1);
    expect(r.decision).toBe('SKIP — score too low');
  });
});
