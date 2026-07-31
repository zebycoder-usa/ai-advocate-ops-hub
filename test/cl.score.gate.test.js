// The 9/10 gate from meeting item 2.3, and the two defects that made the
// existing score untrustworthy.
//
// Before this: the scorer was never given the proof bank, so its own rule
// "invented metrics = disqualify" was unenforceable and a convincing fake scored
// full marks on Proof. Nothing clamped the dimensions, so a malformed reply could
// total above 10 and render a green PASS on a failing letter. And the score lived
// in a separate tab that nothing in the proposal flow ever called.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadApp } from './loadApp.js';

let w;
beforeAll(() => { w = loadApp().window; });

describe('the send threshold is one named constant', () => {
  it('CL_SEND_THRESHOLD exists and is 9.0', () => {
    expect(w.CL_SEND_THRESHOLD).toBe(9.0);
  });
});

describe('the scorer can actually verify a metric', () => {
  it('the proof bank is inside the scorer prompt', () => {
    // Without this it can only judge whether a number sounds plausible.
    expect(w.CL_SCORE_SYSTEM).toContain('94.7');
    expect(w.CL_SCORE_SYSTEM).toContain('AGENCY PROOF BANK');
  });

  it('the scorer prompt still states the rubric it is being asked for', () => {
    expect(w.CL_SCORE_SYSTEM).toMatch(/Opening hook/i);
    expect(w.CL_SCORE_SYSTEM).toMatch(/Proof points/i);
  });
});

describe('clampScore: a bad reply cannot produce a false pass', () => {
  const full = { hook: 2, proof: 2, plan: 2, close: 1.5, style: 1.5, len: 1 };

  it('a legitimate perfect score totals 10', () => {
    expect(w.clampScore(full).total).toBe(10);
  });

  it('caps every dimension at its own maximum', () => {
    const r = w.clampScore({ hook: 10, proof: 10, plan: 10, close: 10, style: 10, len: 10 });
    expect(r.hook).toBe(2);
    expect(r.close).toBe(1.5);
    expect(r.len).toBe(1);
    expect(r.total).toBe(10);
  });

  it('a reply scoring every dimension out of 10 cannot exceed 10 overall', () => {
    // This is the false PASS: 57 or 60 points rendering a green bar at 570%.
    expect(w.clampScore({ hook: 9, proof: 9, plan: 9, close: 9, style: 9, len: 9 }).total).toBeLessThanOrEqual(10);
  });

  it('coerces numbers sent as JSON strings instead of throwing', () => {
    const r = w.clampScore({ hook: '2', proof: '1.5', plan: '2', close: '1.5', style: '1.5', len: '1' });
    expect(r.total).toBeCloseTo(9.5, 5);
  });

  it('treats a negative dimension as zero', () => {
    expect(w.clampScore({ ...full, hook: -5 }).hook).toBe(0);
  });

  it('treats a missing dimension as zero rather than NaN', () => {
    const r = w.clampScore({ proof: 2 });
    expect(r.hook).toBe(0);
    expect(Number.isNaN(r.total)).toBe(false);
  });

  it('treats a non-numeric dimension as zero', () => {
    expect(w.clampScore({ ...full, style: 'excellent' }).style).toBe(0);
  });

  it('survives null and undefined without throwing', () => {
    expect(w.clampScore(null).total).toBe(0);
    expect(w.clampScore(undefined).total).toBe(0);
  });

  it('keeps the per-dimension notes so the bidder still gets feedback', () => {
    expect(w.clampScore({ ...full, hook_note: 'opens with a credential' }).hook_note).toBe('opens with a credential');
  });
});

describe('an unparseable reply is not a zero score', () => {
  it('flags the parse failure instead of silently reporting 0.0 out of 10', () => {
    // A real 0.0 and "the model returned prose" look identical otherwise, and
    // the difference was being written to the sheet as a genuine score.
    const r = w.parseScoreJson('I think this proposal is quite good, honestly.');
    expect(r.parseFailed).toBe(true);
  });

  it('parses a clean JSON reply', () => {
    const r = w.parseScoreJson('{"hook":2,"proof":2,"plan":2,"close":1.5,"style":1.5,"len":1}');
    expect(r.parseFailed).toBeFalsy();
    expect(w.clampScore(r).total).toBe(10);
  });

  it('parses JSON wrapped in a markdown code fence', () => {
    const r = w.parseScoreJson('```json\n{"hook":2,"proof":1,"plan":2,"close":1,"style":1,"len":1}\n```');
    expect(r.parseFailed).toBeFalsy();
    expect(w.clampScore(r).total).toBeCloseTo(8, 5);
  });

  it('a truncated reply is a parse failure, not a low score', () => {
    expect(w.parseScoreJson('{"hook":2,"proof":1,"pl').parseFailed).toBe(true);
  });
});

describe('sendVerdict: what the gate decides', () => {
  const clean = { ok: true, violations: [] };
  const dirty = { ok: false, violations: [{ rule: 'dash', detail: 'x' }] };

  it('blocks when the deterministic checks fail, whatever the score', () => {
    expect(w.sendVerdict(dirty, { total: 9.8 }).canSend).toBe(false);
  });

  it('blocks when the score is under the threshold, even with clean mechanics', () => {
    expect(w.sendVerdict(clean, { total: 8.9 }).canSend).toBe(false);
  });

  it('allows at exactly the threshold', () => {
    expect(w.sendVerdict(clean, { total: 9.0 }).canSend).toBe(true);
  });

  it('allows above the threshold', () => {
    expect(w.sendVerdict(clean, { total: 9.6 }).canSend).toBe(true);
  });

  it('when the scorer could not run, it allows but says the draft was not scored', () => {
    // Blocking here would brick the whole tool the moment Anthropic billing
    // lapses, which is exactly what happened this week. The operator is told
    // instead, so they know they are sending unscored work.
    const v = w.sendVerdict(clean, null);
    expect(v.canSend).toBe(true);
    expect(v.scored).toBe(false);
    expect(String(v.reason || '')).toMatch(/not scored|unavailable/i);
  });

  it('still blocks on failed mechanics even when the scorer could not run', () => {
    expect(w.sendVerdict(dirty, null).canSend).toBe(false);
  });

  it('a parse failure counts as not scored rather than as a zero', () => {
    const v = w.sendVerdict(clean, { total: 0, parseFailed: true });
    expect(v.scored).toBe(false);
    expect(v.canSend).toBe(true);
  });
});
