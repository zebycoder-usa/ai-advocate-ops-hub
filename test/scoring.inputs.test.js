// Scoring INPUT defects — Stage 1 (red-first) tests.
//
// These are deliberately NOT characterization tests. Every assertion here states
// what the evaluator MUST do; a failure is the proof that the defect is real and
// is the target for the Stage 2 section-model fix. Do not weaken an assertion to
// make this file green — fix index.html instead.
//
// Scope: the INPUTS the /19 is computed from (the signal form), not the policy.
// The rules themselves (which industries ban, what a point is worth, where a band
// sits) are frozen and are never asserted-against here.
//
// Every window is loaded by test/loadApp.js, which blocks the network before the
// app's inline <script> runs. Nothing in this file reaches Upwork, Apps Script,
// /api/claude or any Google Sheet.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadApp } from './loadApp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

const JOB_N8N = fixture('job_n8n.txt');
const JOB_VOICE = fixture('job_voice.txt');
const JOB_BROWSEREXT = fixture('job_browserext.txt');

/* ---------------------------------------------------------------------------
   Helpers — drive the app the way an operator does: put text in the textarea,
   press Evaluate (runEval), read the decision the app just computed.
   --------------------------------------------------------------------------- */

// Paste a job and press Evaluate. Returns the deterministic verdict the card shows.
function evaluate(app, text) {
  app.window.setVal('job-text', text);
  app.window.runEval();
  return app.window.evalDecision();
}

// Only the scoring-relevant surface, so a failure diff names the defect.
const verdict = (d) => ({
  cli: d.cli, job: d.job, mat: d.mat, sat: d.sat,
  total: d.total, cliMax: d.cliMax, max: d.max, decision: d.decision,
});

// Evaluate a job in a window that has never seen another job.
function evaluateAlone(text) {
  return verdict(evaluate(loadApp(), text));
}

// Run only the parse+prefill half, so the dropdown state can be inspected.
function autofillFrom(text) {
  const app = loadApp();
  const P = app.parseJob(text);
  app.window.autofill(P);
  return { app, P };
}

const optionValues = (app, id) =>
  Array.from(app.doc.getElementById(id).options).map((o) => o.value);

// The selects scoreManual() actually reads.
const SCORED_SELECTS = ['b-type', 'j-props', 'c-spend', 'c-hire', 'j-scope', 'm-match', 'c-tenure'];

/* Two pastes that overlap only partially, which is the ordinary case: the
   saturated one carries an Activity block and no client history, the clean one
   carries client history and no Activity block (the operator copied the job
   panel with Activity collapsed). Neither is malformed. */
const SATURATED_LOW_VALUE = `Account Settings
Bulk data entry automation cleanup
Posted 5 minutes ago
Worldwide
Fixed-price
$800.00
Est. Budget
Activity on this job
Proposals:
50+
Interviewing:
0
About the client
Payment method verified
United States
Houston
Member since Jan 19, 2025
Footer navigation
`;

const CLEAN_HIGH_VALUE = `Account Settings
Senior React and FastAPI engineer for analytics dashboard
Posted 2 minutes ago
Worldwide
$95.00
/hr
About the client
Payment method verified
United States
Austin
100% hire rate
$40K total spent
Member since Jan 19, 2025
Footer navigation
`;

/* ===========================================================================
   1. CROSS-JOB CONTAMINATION
   An evaluation must be a pure function of the job in the textarea. Today it is
   not: autofill() only writes a field when the new post happens to mention it
   (`if(P.amount!=null)`, `if(P.proposalsLow!=null)`, ...) and never writes
   j-scope / m-match / m-proof / j-long / c-tenure at all, so whatever the last
   job left behind is silently scored against the next one.
   =========================================================================== */
describe('1. cross-job contamination: evaluating job A must not change job B', () => {
  it('a clean high-value job scores the same after a saturated job as it does alone', () => {
    const app = loadApp();
    evaluate(app, SATURATED_LOW_VALUE);
    const afterA = verdict(evaluate(app, CLEAN_HIGH_VALUE));
    expect(afterA).toEqual(evaluateAlone(CLEAN_HIGH_VALUE));
  });

  it('a saturated low-value job scores the same after a clean job as it does alone', () => {
    const app = loadApp();
    evaluate(app, CLEAN_HIGH_VALUE);
    const afterB = verdict(evaluate(app, SATURATED_LOW_VALUE));
    expect(afterB).toEqual(evaluateAlone(SATURATED_LOW_VALUE));
  });

  it('the saturation penalty from the previous job does not follow the next job', () => {
    const app = loadApp();
    evaluate(app, SATURATED_LOW_VALUE);          // page says "50+"  -> -2
    const next = evaluate(app, CLEAN_HIGH_VALUE); // page says nothing about proposals
    expect(next.sat).toBe(evaluateAlone(CLEAN_HIGH_VALUE).sat);
  });

  it('operator-adjusted signals do not leak from one job into the next', () => {
    // The operator reviews job A and honestly downgrades it by hand, then pastes
    // job B and presses Evaluate. Job B must be scored on its own merits.
    const app = loadApp();
    app.window.setVal('job-text', SATURATED_LOW_VALUE);
    app.window.setVal('j-scope', '0');
    app.window.setVal('m-match', '0');
    app.window.setVal('m-proof', false);
    app.window.setVal('j-long', true);
    app.window.setVal('c-tenure', 'new');
    app.window.runEval();

    const afterA = verdict(evaluate(app, CLEAN_HIGH_VALUE));
    expect(afterA).toEqual(evaluateAlone(CLEAN_HIGH_VALUE));
  });

  it('the same job re-evaluated twice in one window scores identically', () => {
    const app = loadApp();
    const first = verdict(evaluate(app, JOB_BROWSEREXT));
    const second = verdict(evaluate(app, JOB_BROWSEREXT));
    expect(second).toEqual(first);
  });

  it('evaluating a new job clears the previous job\'s hand-set signal inputs', () => {
    // The mechanism behind the score drift above: these five inputs are read by
    // scoreManual() and written by nobody when a new job is evaluated.
    const app = loadApp();
    app.window.setVal('job-text', SATURATED_LOW_VALUE);
    app.window.setVal('j-scope', '0');
    app.window.setVal('m-match', '0');
    app.window.setVal('c-tenure', 'new');
    app.window.setVal('j-long', true);
    app.window.setVal('m-proof', false);
    app.window.runEval();

    evaluate(app, CLEAN_HIGH_VALUE);

    const fresh = loadApp();
    ['j-scope', 'm-match', 'c-tenure'].forEach((id) => {
      expect(app.doc.getElementById(id).value,
        `${id} still holds the previous job's value`)
        .toBe(fresh.doc.getElementById(id).value);
    });
    ['j-long', 'm-proof'].forEach((id) => {
      expect(app.doc.getElementById(id).checked,
        `${id} still holds the previous job's value`)
        .toBe(fresh.doc.getElementById(id).checked);
    });
  });
});

/* ===========================================================================
   2. PROPOSAL BUCKET MAPPING
   The page's bucket string must land on the matching dropdown option. The
   dropdown has exactly three: '1' Under 20, '2' 20-50 (busy), '3' 50+.
   Today autofill() maps `low>=20 -> '3'`, so an ordinary 20-50 page is scored as
   heavily saturated and eats the -2 penalty it never earned.
   Policy is untouched here: 50+ keeps its -2, 20-50 keeps its 0.
   =========================================================================== */
describe('2. proposal bucket mapping: page string -> dropdown option', () => {
  const bucketFor = (text) => autofillFrom(text).app.doc.getElementById('j-props').value;
  const UNDER_20 = '1';
  const BUSY_20_50 = '2';
  const SATURATED_50_PLUS = '3';

  it('"Less than 5" selects Under 20', () => {
    expect(bucketFor('Proposals: Less than 5\nHourly $75/hr')).toBe(UNDER_20);
  });

  it('"5 to 10" selects Under 20', () => {
    expect(bucketFor('Proposals: 5 to 10\nHourly $75/hr')).toBe(UNDER_20);
  });

  it('an exact count of 3 selects Under 20', () => {
    expect(bucketFor('Proposals: 3\nHourly $75/hr')).toBe(UNDER_20);
  });

  it('an exact count of 12 selects Under 20', () => {
    expect(bucketFor('Proposals: 12\nHourly $75/hr')).toBe(UNDER_20);
  });

  it('an exact count of 19 selects Under 20 (19 is under 20)', () => {
    expect(bucketFor('Proposals: 19\nHourly $75/hr')).toBe(UNDER_20);
  });

  it('"20 to 50" selects 20-50, not 50+', () => {
    expect(bucketFor('Proposals: 20 to 50\nHourly $75/hr')).toBe(BUSY_20_50);
  });

  it('an exact count of 20 selects 20-50', () => {
    expect(bucketFor('Proposals: 20\nHourly $75/hr')).toBe(BUSY_20_50);
  });

  it('an exact count of 49 selects 20-50', () => {
    expect(bucketFor('Proposals: 49\nHourly $75/hr')).toBe(BUSY_20_50);
  });

  it('"50+" selects 50+', () => {
    expect(bucketFor('Proposals: 50+\nHourly $75/hr')).toBe(SATURATED_50_PLUS);
  });

  it('job_voice.txt ("Less than 5") selects Under 20', () => {
    expect(bucketFor(JOB_VOICE)).toBe(UNDER_20);
  });

  it('job_browserext.txt ("5 to 10") selects Under 20', () => {
    expect(bucketFor(JOB_BROWSEREXT)).toBe(UNDER_20);
  });

  it('job_n8n.txt ("20 to 50") selects 20-50', () => {
    expect(bucketFor(JOB_N8N)).toBe(BUSY_20_50);
  });
});

describe('2b. the -2 saturation penalty fires on 50+ only', () => {
  const satFor = (text) => {
    const { app } = autofillFrom(text);
    return app.window.scoreManual().sat;
  };

  it('"50+" takes the -2 penalty', () => {
    expect(satFor('Proposals: 50+\nHourly $75/hr')).toBe(-2);
  });

  it('"20 to 50" takes no penalty', () => {
    expect(satFor('Proposals: 20 to 50\nHourly $75/hr')).toBe(0);
  });

  it('"Less than 5" takes no penalty', () => {
    expect(satFor('Proposals: Less than 5\nHourly $75/hr')).toBe(0);
  });

  it('job_n8n.txt, whose page says "20 to 50", is not penalised as saturated', () => {
    // The n8n page is hard-banned on its own merits (fixed-price $50), but the
    // saturation penalty must not be applied to a 20-50 bucket regardless.
    expect(satFor(JOB_N8N)).toBe(0);
  });

  it('a full evaluation of job_n8n.txt reports no saturation penalty', () => {
    expect(evaluateAlone(JOB_N8N).sat).toBe(0);
  });
});

/* ===========================================================================
   3. NO INVALID DROPDOWN VALUE
   Setting a <select> to a value that is not one of its options leaves it with
   selectedIndex -1 and value ''. scoreManual() then reads '' and silently awards
   whatever the else-branch gives. autofill() emits '0' for j-props when the page
   reports fewer than 5 proposals, and j-props has no '0' option.
   =========================================================================== */
describe('3. autofill never writes a value the dropdown does not have', () => {
  const CASES = [
    ['an exact count below 5', 'Proposals: 3\nHourly $75/hr'],
    ['an exact count of 1', 'Proposals: 1\nHourly $75/hr'],
    ['"Less than 5"', 'Proposals: Less than 5\nHourly $75/hr'],
    ['"5 to 10"', 'Proposals: 5 to 10\nHourly $75/hr'],
    ['"20 to 50"', 'Proposals: 20 to 50\nHourly $75/hr'],
    ['"50+"', 'Proposals: 50+\nHourly $75/hr'],
    ['job_n8n.txt', JOB_N8N],
    ['job_voice.txt', JOB_VOICE],
    ['job_browserext.txt', JOB_BROWSEREXT],
  ];

  CASES.forEach(([label, text]) => {
    it(`j-props holds a real option after autofill from ${label}`, () => {
      const { app } = autofillFrom(text);
      const el = app.doc.getElementById('j-props');
      expect(optionValues(app, 'j-props')).toContain(el.value);
      expect(el.selectedIndex).toBeGreaterThanOrEqual(0);
    });
  });

  CASES.forEach(([label, text]) => {
    it(`every scored select holds a real option after autofill from ${label}`, () => {
      const { app } = autofillFrom(text);
      SCORED_SELECTS.forEach((id) => {
        const el = app.doc.getElementById(id);
        expect(optionValues(app, id), `${id} value "${el.value}" is not one of its options`)
          .toContain(el.value);
      });
    });
  });
});

/* ===========================================================================
   4. THE MANUAL HARD-BAN CHECKBOX
   j-ban exists so a human can ban a job the text scanner cannot see (a client
   who names the country only in chat, a company alias, an on-site condition
   buried in a screenshot). It is currently read by nothing: scoreManual() never
   looks at it and evalDecision() bans only on parseJob()'s own findings.
   =========================================================================== */
describe('4. the manual hard-ban checkbox', () => {
  const CLEAN_JOB = 'Hourly $95/hr. Payment verified. United States based client. Build a React dashboard.';

  it('ticking j-ban turns the decision into a hard-ban SKIP', () => {
    const app = loadApp();
    app.window.setVal('job-text', CLEAN_JOB);
    app.window.setVal('j-ban', true);
    const d = app.window.evalDecision();
    expect(d.banned).toBe(true);
    expect(d.decision).toBe('SKIP — HARD BAN');
  });

  it('ticking j-ban records a ban reason on the verdict', () => {
    const app = loadApp();
    app.window.setVal('job-text', CLEAN_JOB);
    app.window.setVal('j-ban', true);
    expect(app.window.evalDecision().bans.length).toBeGreaterThan(0);
  });

  it('leaving j-ban unticked on the same clean job leaves it unbanned (control)', () => {
    const app = loadApp();
    app.window.setVal('job-text', CLEAN_JOB);
    app.window.setVal('j-ban', false);
    expect(app.window.evalDecision().banned).toBe(false);
  });

  it('genProposal refuses to write a proposal for a manually banned job', async () => {
    const app = loadApp();
    app.window.setVal('job-text', CLEAN_JOB);
    app.window.setVal('j-ban', true);
    await app.window.genProposal('priority');
    expect(app.doc.getElementById('prop-out').innerHTML).toMatch(/hard ban/i);
  });

  it('a manually banned job burns no model call', async () => {
    // A banned job is worth 0 connects and 0 tokens; the refusal must happen
    // before the request, not after it fails.
    const app = loadApp();
    app.window.setVal('job-text', CLEAN_JOB);
    app.window.setVal('j-ban', true);
    await app.window.genProposal('priority');
    expect(app.fetchCalls.filter((u) => String(u).includes('/api/claude'))).toEqual([]);
  });
});

/* ===========================================================================
   5. THE FROZEN CARD
   syncManualState() puts .manual-dim (opacity .5; pointer-events:none) on
   #signal-card and #j-props as soon as job-text is non-empty, on the premise
   that "the AI scores it". The AI does not score it: scoreManual() reads those
   very inputs. Pasting a job therefore locks the operator out of the controls
   the score is computed from.
   =========================================================================== */
describe('5. the signal inputs stay operable after a job is pasted', () => {
  // Paste the way the operator does, so the textarea's oninput handler runs.
  function paste(app, text) {
    const ta = app.doc.getElementById('job-text');
    ta.value = text;
    ta.dispatchEvent(new app.window.Event('input', { bubbles: true }));
    return app;
  }

  it('.manual-dim really does disable the controls (guard: the checks below are not vacuous)', () => {
    // If this ever goes red the class was renamed or defanged and the two tests
    // after it stop meaning anything.
    const app = loadApp();
    const css = app.doc.documentElement.innerHTML;
    expect(css).toMatch(/\.manual-dim\s*\{[^}]*pointer-events\s*:\s*none/);
  });

  it('#signal-card is not disabled once a job is pasted', () => {
    const app = paste(loadApp(), CLEAN_HIGH_VALUE);
    const card = app.doc.getElementById('signal-card');
    expect(card.classList.contains('manual-dim')).toBe(false);
    expect(app.window.getComputedStyle(card).pointerEvents).not.toBe('none');
  });

  it('#j-props is not disabled once a job is pasted', () => {
    const app = paste(loadApp(), CLEAN_HIGH_VALUE);
    const sel = app.doc.getElementById('j-props');
    expect(sel.classList.contains('manual-dim')).toBe(false);
    expect(app.window.getComputedStyle(sel).pointerEvents).not.toBe('none');
  });

  it('the scored inputs are still reachable and still change the score after a paste', () => {
    const app = paste(loadApp(), CLEAN_HIGH_VALUE);
    const before = app.window.scoreManual().total;
    app.window.setVal('j-scope', '0');
    expect(app.window.scoreManual().total).not.toBe(before);
  });

  it('an empty textarea leaves the card operable (control)', () => {
    const app = paste(loadApp(), '');
    expect(app.doc.getElementById('signal-card').classList.contains('manual-dim')).toBe(false);
  });
});

/* ===========================================================================
   6. DISPLAYED DENOMINATOR
   A fixed-price job cannot earn the "$25/hr average paid" client point, so its
   real ceiling is 18, not 19 — scoreManual() already computes achievableMax=18
   for it. The card still prints "/ 19" for every non-new client, so a perfect
   fixed-price job reads as 18/19 and looks like it lost a point it was never
   able to win.

   BLOCKED ON AN OWNER DECISION: whether fixed-price should be rescaled to /18
   or the missing point should be redistributed is a policy call nobody has made
   yet, so the strong assertion (denominator === achievable max) is NOT written
   here. Only the invariant that holds under either outcome is asserted.
   =========================================================================== */
describe('6. displayed denominator', () => {
  // Everything a fixed-price job can possibly earn.
  function perfectFixedPrice() {
    const app = loadApp();
    ['c-verified', 'c-us', 'm-proof', 'j-long'].forEach((id) => app.window.setVal(id, true));
    app.window.setVal('c-tenure', 'unknown');
    app.window.setVal('c-hire', '2');
    app.window.setVal('c-spend', '2');
    app.window.setVal('b-type', 'fixed');
    app.window.setVal('b-amt', '5000');
    app.window.setVal('j-scope', '2');
    app.window.setVal('j-props', '1');
    app.window.setVal('m-match', '3');
    return app;
  }

  // Read the two numbers the operator actually sees on the decision card.
  function displayed(app, d) {
    const html = app.window.renderDecisionCard(d);
    const m = html.match(/scorebig[^>]*>\s*(-?\d+)\s*<span[^>]*>\s*\/\s*(\d+)/);
    expect(m, 'could not read the score line off the decision card').toBeTruthy();
    return { total: parseInt(m[1], 10), max: parseInt(m[2], 10) };
  }

  it('a perfect fixed-price job displays a total no greater than the displayed max', () => {
    const app = perfectFixedPrice();
    const shown = displayed(app, app.window.evalDecision());
    expect(shown.total).toBeLessThanOrEqual(shown.max);
  });

  it('the displayed total never exceeds the displayed max on any fixture', () => {
    [JOB_N8N, JOB_VOICE, JOB_BROWSEREXT].forEach((text) => {
      const app = loadApp();
      const d = evaluate(app, text);
      const shown = displayed(app, d);
      expect(shown.total).toBeLessThanOrEqual(shown.max);
    });
  });

  it('the verdict total never exceeds the verdict max on any fixture', () => {
    [JOB_N8N, JOB_VOICE, JOB_BROWSEREXT].forEach((text) => {
      const d = evaluateAlone(text);
      expect(d.total).toBeLessThanOrEqual(d.max);
    });
  });

  it('a perfect fixed-price job scores its own achievable maximum', () => {
    // Not a denominator claim — just that "perfect" really is perfect, so the
    // gap the card shows is a display gap and not an unearned point.
    const app = perfectFixedPrice();
    const s = app.window.scoreManual();
    expect(s.total).toBe(s.achievableMax);
  });
});

/* ===========================================================================
   SAFETY: this file never reaches the network.
   =========================================================================== */
describe('safety', () => {
  it('the only fetch the app attempts on load is the blocked seat call', () => {
    const app = loadApp();
    app.fetchCalls.forEach((u) => {
      expect(String(u)).toMatch(/script\.google\.com/);
    });
  });
});
