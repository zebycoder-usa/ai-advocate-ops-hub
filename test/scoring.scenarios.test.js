// Phase 3 — named-scenario characterization tests for the DETERMINISTIC pure
// scoring path only (parseJob bans/flags + scoreManual /19). These pin the
// exact outcomes the code produces TODAY so the R12 refactor (make scoreManual
// authoritative) can be proven behavior-preserving.
//
// runEval() (the model free-text /19) is intentionally NOT tested: it is
// non-deterministic and is the known must-fix (R12).
//
// Where current behavior looks WRONG it is still pinned here and recorded in
// quality/02_risk_register.md (R13, R14) — we fix in the refactor phase with
// this net in place.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadApp, scoreWith } from './loadApp.js';

let app;
beforeAll(() => { app = loadApp(); });

// A strong, clean baseline set of manual inputs; individual tests override.
const BASE = {
  'c-verified': true, 'c-hire': '2', 'c-spend': '2',
  'b-type': 'hourly', 'b-amt': '45', 'j-scope': '2', 'j-props': '1',
  'j-long': false, 'm-match': '3', 'm-proof': true, 'c-us': true,
};
const isApply = (d) => /^APPLY/.test(d);

describe('Phase 3 scenarios — APPLY bands (capability match, $45/hr)', () => {
  it('React/full-stack job at $45/hr hourly -> APPLY band', () => {
    // Strong match (React/FastAPI is our stack) at exactly the $40 floor + $5.
    const r = scoreWith(app, { ...BASE, 'm-match': '3', 'b-amt': '45' });
    expect(r).toMatchObject({ cli: 7, job: 6, mat: 5, sat: 0, total: 18 });
    expect(r.decision).toBe('APPLY WITH BOOST');
    expect(isApply(r.decision)).toBe(true);
  });

  it('QA job at $45/hr -> APPLY band (full-service capability match)', () => {
    // QA is inside the full-service stack, represented by a strong match input.
    // NOTE: scoreManual has no domain->capability inference; Match is a manual/
    // model-set signal (see risk register). Here a busy 20-50 proposal bucket
    // and 20-50% hire rate still clear the APPLY line.
    const r = scoreWith(app, { ...BASE, 'c-hire': '1', 'j-props': '2', 'm-match': '3' });
    expect(r).toMatchObject({ cli: 6, job: 5, mat: 5, sat: 0, total: 16 });
    expect(r.decision).toBe('APPLY WITH BOOST');
    expect(isApply(r.decision)).toBe(true);
  });
});

describe('Phase 3 scenarios — hard BANS (parseJob)', () => {
  it('crypto job -> hard BAN', () => {
    const P = app.parseJob('Build a crypto trading dashboard. Hourly $80/hr.');
    expect(P.bans).toContain('Banned industry (finance/crypto/trading)');
  });

  it('forex job -> hard BAN', () => {
    const P = app.parseJob('We run a forex brokerage and need a data pipeline. $90/hr.');
    expect(P.bans).toContain('Banned industry (finance/crypto/trading)');
  });

  it('confirmed India client -> hard BAN', () => {
    const P = app.parseJob('Client based in Bengaluru, India. Hourly $70/hr.');
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain('Client in India/Bangladesh/Pakistan (hard ban)');
  });

  it('confirmed Bangladesh client -> hard BAN', () => {
    const P = app.parseJob('Client in Dhaka, Bangladesh. Hourly $70/hr.');
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain('Client in India/Bangladesh/Pakistan (hard ban)');
  });

  it('confirmed Pakistan client -> hard BAN (R14 fixed)', () => {
    const P = app.parseJob('Client located in Islamabad, Pakistan. Hourly $70/hr.');
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain('Client in India/Bangladesh/Pakistan (hard ban)');
  });

  it('Karachi client -> hard BAN', () => {
    const P = app.parseJob('Remote team based in Karachi. Hourly $70/hr.');
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain('Client in India/Bangladesh/Pakistan (hard ban)');
  });

  it('Lahore client -> hard BAN', () => {
    const P = app.parseJob('Startup in Lahore looking for React devs. $80/hr.');
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain('Client in India/Bangladesh/Pakistan (hard ban)');
  });

  it('an allowed location is NOT falsely banned by the new tokens', () => {
    const P = app.parseJob('Client in Amsterdam, Netherlands. Hourly $75/hr.');
    expect(P.isBanCountry).toBe(false);
    expect(P.bans).toEqual([]);
  });

  it('\\b guards: "Islamic" does not match islamabad; "Pakistani" does ban', () => {
    // 'islamabad' must not match the substring 'Islam' -> not a ban country.
    const a = app.parseJob('We build tools for an Islamic art museum in Paris.');
    expect(a.isBanCountry).toBe(false);
    // 'pakistani' (demonym) is an added token -> ban.
    const b = app.parseJob('Client is a Pakistani-owned startup. Hourly $80/hr.');
    expect(b.isBanCountry).toBe(true);
  });

  it('fixed-price under $200 -> hard BAN', () => {
    const P = app.parseJob('Fixed-price. Budget $180. Quick script.');
    expect(P.budgetType).toBe('fixed');
    expect(P.amount).toBe(180);
    expect(P.bans).toContain('Fixed-price under $200 ($180)');
  });
});

describe('Phase 3 scenarios — penalties & flags (never a ban)', () => {
  it('proposals bucket 50+ -> SAT_PENALTY -2 applied', () => {
    const r = scoreWith(app, { ...BASE, 'j-props': '3' });
    expect(r.sat).toBe(-2);
    expect(r.total).toBe(BASE_TOTAL_MINUS_SAT); // computed below
  });

  it('new-client / below $40/hr -> FLAG, not a ban', () => {
    const P = app.parseJob('New client, first job. Hourly $30/hr.');
    expect(P.belowBudget).toBe(true);
    expect(P.flags).toContain('Below $40/hr rate floor — review before bidding');
    expect(P.bans).toEqual([]); // below-rate and newness never ban
  });

  it('fairness is tenure-gated: an UNKNOWN-tenure client is not treated as new (R13)', () => {
    // BASE sets no c-tenure -> default 'unknown'. R13 fairness fires ONLY for
    // tenure==='new', so 'unknown'/'established' keep today's absolute scoring:
    // $0 spend still scores 0 here (no fairness credit for a non-new client).
    const r = scoreWith(app, { ...BASE, 'c-spend': '0' });
    expect(r.cli).toBe(5); // verified2 + hire2 + spend0 + hourly1 = 5 (unchanged)
  });

  it('region outside allowed set -> FLAG, not skip', () => {
    const P = app.parseJob('Client in Sao Paulo, Brazil. Hourly $75/hr.');
    expect(P.region).toBe('Other');
    expect(P.flags).toContain('Outside allowed regions (Other) — review, not auto-skip');
    expect(P.bans).toEqual([]); // outside-region is a flag, never an auto-skip ban
  });
});

// BASE total = cli7 + job6 + mat5 = 18; with 50+ bucket job loses its 2 props
// points (18-2) and takes the -2 penalty => 14.
const BASE_TOTAL_MINUS_SAT = 14;
