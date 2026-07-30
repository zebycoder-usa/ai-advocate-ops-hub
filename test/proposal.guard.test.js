// ============================================================================
// proposal.guard.test.js — CONTRACT tests for the proposal validator (Stage 4).
//
// STATUS: window.validateProposal does not exist yet, so every POSITIVE probe
// ("this text must trip rule X") is red today, on purpose. This file is the
// specification Stage 4 implements against; a failing assertion here is the proof
// that the guard is still missing, not a bug in the test. Do not weaken an
// assertion to get green.
//
// HOW TO READ A GREEN LINE TODAY: the NEGATIVE probes ("this text must NOT trip
// rule X") pass while the validator is absent, because a validator that does not
// exist cannot raise a false positive. They are false-positive guards that only
// start earning their keep once Stage 4 lands. The gap itself is proved by the
// three shape tests plus every positive probe below — do not read the green half
// of the run as "half the guard already works".
//
// THE CONTRACT under test — a global on window:
//
//   validateProposal(text, opts) -> { ok: boolean, violations: [ {rule, detail} ] }
//   opts = { proofBank: string, jobText: string, mode: 'proposal' | 'speed' }
//
//   'dash'             any em dash or en dash anywhere in text
//   'placeholder'      any [bracketed placeholder]
//   'badge'            any claim of Top Rated / Top Rated Plus / Job Success Score / JSS / Rising Talent
//   'length'           the PROPOSAL block outside 120 to 180 words (mode 'proposal' only)
//   'unbacked-number'  a claimed figure in the text present in neither opts.proofBank
//                      nor opts.jobText. Years (19xx / 20xx) and ordinary small
//                      counts ("3 steps", "2 weeks") are exempt.
//                      THAT EXEMPTION IS AN UNMADE OWNER DECISION: PROOF_VOICE_RULES
//                      rule 5 in index.html says "Never state a number that is not in
//                      the AGENCY PROOF BANK or the user's own letter", with no
//                      carve-out, yet the app's own question() emits "in the first 2
//                      weeks", which a literal reading would flag. The exemption tests
//                      below are kept as the proposed reading and are reported as
//                      blockedByDecision, not as app defects.
//   'voice'            mixes first person singular (I, me, my) with the mandated agency "we"
//
//   ok is true only when violations is empty.
//
// POLICY IS FROZEN: this suite tests mechanics only. It asserts nothing about
// which industries are banned, what a point is worth, or where a band sits.
// ============================================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { loadApp } from './loadApp.js';

let app;
let validate;

// ---------------------------------------------------------------------------
// Existence probe + safe caller.
//
// If window.validateProposal is missing we must NOT crash every it() with a
// TypeError. Instead we return a sentinel result whose single rule id names the
// gap, so a failure reads:
//     expected [ 'validateProposal-not-implemented' ] to contain 'dash'
// which points straight at the real defect.
// ---------------------------------------------------------------------------
const MISSING = 'validateProposal-not-implemented';

function V(text, opts) {
  if (typeof validate !== 'function') {
    return {
      ok: false,
      violations: [{ rule: MISSING, detail: 'window.validateProposal(text, opts) is not defined in index.html' }],
    };
  }
  return validate(text, opts);
}

// Rule ids from a result, as a plain array — every assertion below reads this.
function rules(res) {
  return (res && Array.isArray(res.violations) ? res.violations : []).map((v) => v && v.rule);
}

beforeAll(() => {
  app = loadApp();
  validate = app.window.validateProposal;
});

// ---------------------------------------------------------------------------
// Test data.
// ---------------------------------------------------------------------------

// One real line lifted from the agency proof bank in index.html. Numbers in a
// proposal are legitimate only if they trace back to text like this.
const PROOF_BANK =
  'Full-stack/SaaS: "AI resume-screening system: 94.7% parse accuracy, 200 resumes in 90 seconds, ' +
  '80% screening-time cut, in production on 500+ applications a month. Full SaaS on FastAPI, React, ' +
  'PostgreSQL, Stripe, Docker, AWS."';

// A proof bank that deliberately does NOT contain 94.7.
const PROOF_BANK_WITHOUT_947 =
  'Automation: "23 production n8n workflows including an IRS-accurate US tax estimator."';

const JOB_TEXT = [
  'Senior Full-Stack Engineer for Internal Resume Screening Dashboard',
  'Hourly: $60/hr',
  'We need a React dashboard over our applicant intake. Our budget for phase one is $5,000.',
  'Client location: United States. Payment method verified.',
].join('\n');

// Default opts for the single-rule probes: empty sources, so ONLY numbers that
// are intrinsically exempt (years, ordinary counts) may survive.
const BARE = { proofBank: '', jobText: '', mode: 'proposal' };

// A fully clean, realistic agency proposal. 140 words in the PROPOSAL block.
// It is deliberately built to survive every rule at once:
//   - no em or en dashes (plain hyphens and commas only)
//   - no bracketed placeholders
//   - no platform badge claims
//   - 140 words, inside the 120 to 180 band
//   - every number (94.7, 80, 500) traceable to PROOF_BANK
//   - one consistent "we" voice, no I / me / my
// It also contains "AI", which is the classic false-positive trap for a naive
// /\bI\b/ voice check.
const CLEAN_PROPOSAL = `PROPOSAL
Your team is losing hours to manual resume screening. That is the exact problem we solved for a hiring platform: an AI screening system running at 94.7% parse accuracy, cutting screening time 80% and holding up in production on 500 applications a month. We would bring the same approach to your stack.
Here is how we would start. First, we map your current intake and agree on what a correct parse looks like. Second, we build the extraction and scoring pipeline end to end on a sample of your data, so you can see accuracy on your own records rather than a demo set. Third, we wire it into your applicant tracking system and hand it over with tests and documentation, so your team owns it.
One question: where do your applications land today, and what format are they in?

INTRO MESSAGE
We built an AI screening pipeline that parses at 94.7% accuracy and cut screening time 80%. Happy to walk you through how it maps to your intake.`;

// Filler that trips no other rule: no numbers, no dashes, no brackets, no
// badges, no first person singular. Used only to hit word counts.
const SAFE_WORDS = ['we', 'build', 'reliable', 'software', 'for', 'your', 'team', 'and', 'we', 'ship', 'it', 'early'];
function filler(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(SAFE_WORDS[i % SAFE_WORDS.length]);
  return out.join(' ');
}
function proposalOf(n) {
  return 'PROPOSAL\n' + filler(n);
}

// ===========================================================================
// 0. The gap itself.
// ===========================================================================
describe('validateProposal: exists and returns the contracted shape', () => {
  it('window.validateProposal is a function (RED until Stage 4 lands)', () => {
    expect(typeof validate).toBe('function');
  });

  it('returns an object with a boolean ok and an array of violations', () => {
    // The sentinel in V() has the right shape by construction, so assert the
    // real function is there first; otherwise this test would pass vacuously.
    expect(typeof validate).toBe('function');
    const res = V(CLEAN_PROPOSAL, { proofBank: PROOF_BANK, jobText: JOB_TEXT, mode: 'proposal' });
    expect(typeof res.ok).toBe('boolean');
    expect(Array.isArray(res.violations)).toBe(true);
  });

  it('every violation carries a non-empty rule id and a non-empty detail', () => {
    expect(typeof validate).toBe('function'); // same guard against a vacuous pass
    const res = V('We shipped — a [thing] as a Top Rated team.', BARE);
    expect(res.violations.length).toBeGreaterThan(0);
    res.violations.forEach((v) => {
      expect(typeof v.rule).toBe('string');
      expect(v.rule.length).toBeGreaterThan(0);
      expect(typeof v.detail).toBe('string');
      expect(v.detail.length).toBeGreaterThan(0);
    });
  });
});

// ===========================================================================
// 1. 'dash'
// ===========================================================================
describe("rule 'dash'", () => {
  it('fires on an em dash', () => {
    expect(rules(V('We build the pipeline — then we hand it over.', BARE))).toContain('dash');
  });

  it('fires on an en dash', () => {
    expect(rules(V('We build the pipeline – then we hand it over.', BARE))).toContain('dash');
  });

  it('fires on an em dash buried mid-word with no surrounding spaces', () => {
    expect(rules(V('We ship fast—reliably, every time.', BARE))).toContain('dash');
  });

  it('does NOT fire on a plain hyphen', () => {
    expect(rules(V('We are a full-stack team and we build end-to-end.', BARE))).not.toContain('dash');
  });

  it('does NOT fire on clean prose with no dash characters at all', () => {
    expect(rules(V('We build the pipeline, then we hand it over.', BARE))).not.toContain('dash');
  });
});

// ===========================================================================
// 2. 'placeholder'
// ===========================================================================
describe("rule 'placeholder'", () => {
  it('fires on a bracketed name placeholder', () => {
    expect(rules(V('Hello [Client Name], we can help with this.', BARE))).toContain('placeholder');
  });

  it('fires on a bracketed instruction placeholder', () => {
    expect(rules(V('We delivered [insert metric here] for a similar team.', BARE))).toContain('placeholder');
  });

  it('does NOT fire on clean prose with no brackets', () => {
    expect(rules(V('We can help with this, and we would start on your intake.', BARE))).not.toContain('placeholder');
  });
});

// ===========================================================================
// 3. 'badge'
// ===========================================================================
describe("rule 'badge'", () => {
  it('fires on "Top Rated"', () => {
    expect(rules(V('We are a Top Rated team on this platform.', BARE))).toContain('badge');
  });

  it('fires on "Top Rated Plus"', () => {
    expect(rules(V('We are Top Rated Plus with a long track record.', BARE))).toContain('badge');
  });

  it('fires on "Job Success Score"', () => {
    expect(rules(V('Our Job Success Score speaks for the work we do.', BARE))).toContain('badge');
  });

  it('fires on the "JSS" abbreviation', () => {
    expect(rules(V('Our JSS reflects how we deliver.', BARE))).toContain('badge');
  });

  it('fires on "Rising Talent"', () => {
    expect(rules(V('We hold Rising Talent status on the platform.', BARE))).toContain('badge');
  });

  it('is case insensitive', () => {
    expect(rules(V('we are top rated and we deliver.', BARE))).toContain('badge');
  });

  it('does NOT fire on ordinary prose that merely uses the word "top" or "success"', () => {
    const res = V('We put your top priority first, and we measure success on your own data.', BARE);
    expect(rules(res)).not.toContain('badge');
  });
});

// ===========================================================================
// 4. 'length' — measured on the PROPOSAL block, mode 'proposal'
// ===========================================================================
describe("rule 'length'", () => {
  it('fires when the PROPOSAL block is under 120 words', () => {
    expect(rules(V(proposalOf(40), BARE))).toContain('length');
  });

  it('fires when the PROPOSAL block is over 180 words', () => {
    expect(rules(V(proposalOf(220), BARE))).toContain('length');
  });

  it('does NOT fire at 120 words (lower bound is inclusive)', () => {
    expect(rules(V(proposalOf(120), BARE))).not.toContain('length');
  });

  it('does NOT fire at 180 words (upper bound is inclusive)', () => {
    expect(rules(V(proposalOf(180), BARE))).not.toContain('length');
  });

  it('does NOT fire at 140 words, mid band', () => {
    expect(rules(V(proposalOf(140), BARE))).not.toContain('length');
  });

  it('counts the PROPOSAL block ONLY, ignoring the INTRO MESSAGE block', () => {
    // 140-word PROPOSAL + a long INTRO MESSAGE. The combined text is well over
    // 180 words, so a validator that counts the whole string fails here.
    const text = 'PROPOSAL\n' + filler(140) + '\n\nINTRO MESSAGE\n' + filler(120);
    expect(rules(V(text, BARE))).not.toContain('length');
  });

  it('counts the PROPOSAL block ONLY, ignoring site chrome before the label', () => {
    const text = 'Here is your draft, review before sending.\n\nPROPOSAL\n' + filler(140);
    expect(rules(V(text, BARE))).not.toContain('length');
  });

  it('treats an unlabelled text as the proposal block itself', () => {
    expect(rules(V(filler(40), BARE))).toContain('length');
  });

  it("does NOT fire in mode 'speed' — a speed bid is deliberately short", () => {
    const speed = { proofBank: '', jobText: '', mode: 'speed' };
    expect(rules(V(proposalOf(40), speed))).not.toContain('length');
  });

  it("does NOT fire in mode 'speed' even for a very short bid", () => {
    const speed = { proofBank: '', jobText: '', mode: 'speed' };
    expect(rules(V('PROPOSAL\nwe can start on your intake today and we ship early.', speed))).not.toContain('length');
  });
});

// ===========================================================================
// 5. 'unbacked-number'
// ===========================================================================
describe("rule 'unbacked-number'", () => {
  it('fires on an invented percentage with empty proof sources', () => {
    expect(rules(V('We cut costs by 47% for a similar client.', BARE))).toContain('unbacked-number');
  });

  it('names the offending number in the violation detail', () => {
    const res = V('We cut costs by 47% for a similar client.', BARE);
    const hit = res.violations.find((v) => v.rule === 'unbacked-number');
    expect(hit).toBeDefined();
    expect(hit.detail).toContain('47');
  });

  it('does NOT fire on 94.7% when that figure IS in the supplied proofBank', () => {
    const res = V('We run at 94.7% parse accuracy on production traffic.', {
      proofBank: PROOF_BANK, jobText: '', mode: 'proposal',
    });
    expect(rules(res)).not.toContain('unbacked-number');
  });

  it('DOES fire on 94.7% when that figure is NOT in the supplied proofBank', () => {
    const res = V('We run at 94.7% parse accuracy on production traffic.', {
      proofBank: PROOF_BANK_WITHOUT_947, jobText: '', mode: 'proposal',
    });
    expect(rules(res)).toContain('unbacked-number');
  });

  it("allows a number that appears in the JOB post — the client's own $5,000 budget quoted back", () => {
    const res = V('You mentioned a $5,000 budget for phase one, and we can scope to it.', {
      proofBank: '', jobText: JOB_TEXT, mode: 'proposal',
    });
    expect(rules(res)).not.toContain('unbacked-number');
  });

  it('allows the job post hourly rate quoted back', () => {
    const res = V('At the $60/hr you posted, we would start with the intake mapping.', {
      proofBank: '', jobText: JOB_TEXT, mode: 'proposal',
    });
    expect(rules(res)).not.toContain('unbacked-number');
  });

  it('does NOT report a year like 2026 as an unbacked number', () => {
    expect(rules(V('We have run this stack in production since 2026.', BARE))).not.toContain('unbacked-number');
  });

  it('does NOT report an ordinary small count like "3 steps" as an unbacked number', () => {
    expect(rules(V('Here is how we would start, in 3 steps.', BARE))).not.toContain('unbacked-number');
  });

  it('does NOT report an ordinary small count like "2 weeks" as an unbacked number', () => {
    expect(rules(V('We would show you a working slice in 2 weeks.', BARE))).not.toContain('unbacked-number');
  });

  it('still catches an invented metric sitting next to exempt numbers', () => {
    // 3 and 2026 are exempt; 91% is not. The rule must not be fooled into
    // passing the whole sentence because some numbers were fine.
    const res = V('In 3 steps, since 2026, we have held 91% accuracy.', BARE);
    expect(rules(res)).toContain('unbacked-number');
    const hit = res.violations.find((v) => v.rule === 'unbacked-number');
    expect(hit.detail).toContain('91');
  });

  it('does NOT fire on prose with no numbers at all', () => {
    expect(rules(V('We would map your intake, then build the scoring pipeline.', BARE))).not.toContain('unbacked-number');
  });
});

// ===========================================================================
// 6. 'voice'
// ===========================================================================
describe("rule 'voice'", () => {
  it('fires when "I" is mixed with the agency "we"', () => {
    expect(rules(V('We build the pipeline. I will handle the deployment.', BARE))).toContain('voice');
  });

  it('fires when "my" is mixed with the agency "we"', () => {
    expect(rules(V('We would scope it first, then my team runs the build.', BARE))).toContain('voice');
  });

  it('fires when "me" is mixed with the agency "we"', () => {
    expect(rules(V('We can start Monday, so send the files to me.', BARE))).toContain('voice');
  });

  it('does NOT fire on a consistent "we" voice', () => {
    expect(rules(V('We would map your intake, then we build the scoring pipeline.', BARE))).not.toContain('voice');
  });

  it('does NOT fire on the capital I inside "AI" or "API"', () => {
    // The classic false positive: /I/ without a word boundary flags AI and API.
    expect(rules(V('We build AI and API integrations, and we test them.', BARE))).not.toContain('voice');
  });

  it('does NOT fire on a sentence-initial "It"', () => {
    expect(rules(V('We ship the working slice early. It runs on your own data.', BARE))).not.toContain('voice');
  });
});

// ===========================================================================
// 7. ok semantics + the fully clean proposal
// ===========================================================================
describe('ok is true only when violations is empty', () => {
  const OPTS = { proofBank: PROOF_BANK, jobText: JOB_TEXT, mode: 'proposal' };

  it('a fully clean, realistic 140-word agency proposal returns ok true', () => {
    const res = V(CLEAN_PROPOSAL, OPTS);
    expect(rules(res)).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('the clean proposal trips none of the six rules individually', () => {
    const r = rules(V(CLEAN_PROPOSAL, OPTS));
    ['dash', 'placeholder', 'badge', 'length', 'unbacked-number', 'voice'].forEach((rule) => {
      expect(r).not.toContain(rule);
    });
  });

  it('one violation is enough to make ok false', () => {
    const res = V(CLEAN_PROPOSAL.replace('That is the exact problem', 'That — is the exact problem'), OPTS);
    expect(rules(res)).toContain('dash');
    expect(res.ok).toBe(false);
  });

  it('ok is false whenever violations is non-empty, for a text that breaks everything', () => {
    const res = V('Hi [Client], I am Top Rated and we lift revenue 63% — fast.', BARE);
    expect(res.violations.length).toBeGreaterThan(0);
    expect(res.ok).toBe(false);
  });

  it('reports every broken rule at once, not just the first', () => {
    const res = V('Hi [Client], I am Top Rated and we lift revenue 63% — fast.', BARE);
    const r = rules(res);
    expect(r).toContain('dash');
    expect(r).toContain('placeholder');
    expect(r).toContain('badge');
    expect(r).toContain('unbacked-number');
    expect(r).toContain('voice');
    expect(r).toContain('length'); // far under 120 words
  });

  it('reports each broken rule only once', () => {
    // Two em dashes and two placeholders are still one 'dash' and one 'placeholder'.
    const res = V('We ship — fast — for [Client] and [Team].', BARE);
    const r = rules(res);
    expect(r.filter((x) => x === 'dash')).toHaveLength(1);
    expect(r.filter((x) => x === 'placeholder')).toHaveLength(1);
  });

  it('the real AGENCY_PROOF_BANK in index.html backs the 94.7% figure', () => {
    // Ties the contract to the app's own data instead of a test-local copy.
    const bank = app.window.AGENCY_PROOF_BANK;
    expect(typeof bank).toBe('string');
    expect(bank).toContain('94.7');
    const res = V('We run at 94.7% parse accuracy in production.', {
      proofBank: bank, jobText: '', mode: 'proposal',
    });
    expect(rules(res)).not.toContain('unbacked-number');
  });
});

// ===========================================================================
// 8. The suite touches no network.
// ===========================================================================
describe('safety: validation is pure and never touches the network', () => {
  it('the only fetch the harness ever saw is the blocked seat-boot call', () => {
    // The `|^$|undefined` alternatives this assertion used to carry made it
    // nearly unfailable — an https://evil.example/undefined call would have
    // satisfied it. Pin the one call the harness legitimately sees: seatBoot()
    // hitting the Apps Script exec endpoint, which loadApp() rejects offline.
    expect(app.fetchCalls.length).toBeGreaterThan(0); // otherwise this is vacuous
    app.fetchCalls.forEach((u) => {
      expect(String(u)).toMatch(/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/);
    });
  });

  it('running the validator many times issues no fetch of any kind', () => {
    const before = app.fetchCalls.length;
    V(CLEAN_PROPOSAL, { proofBank: PROOF_BANK, jobText: JOB_TEXT, mode: 'proposal' });
    V('We ship — fast for [Client].', BARE);
    V(proposalOf(220), BARE);
    V('We are Top Rated and I deliver 99% uptime.', BARE);
    expect(app.fetchCalls.length).toBe(before);
  });
});

// ===========================================================================
// 9. INTEGRATION — the copy control must not hand over dirty text.
//
// ############################################################################
// # RED UNTIL STAGE 4 LANDS. Nothing in index.html wires validateProposal into
// # genProposal today: the card renders an always-enabled "Copy proposal"
// # button and copyText() writes whatever is in [data-copy] straight to the
// # clipboard. These tests state the DOM the app must reach once the guard is
// # wired in. They are the integration half of the contract above.
// #
// # The DOM contract this suite pins:
// #   - the rendered card still exposes the draft at #prop-out [data-copy]
// #   - when the draft has open violations the card exposes #prop-out
// #     [data-violations], naming the failing rule ids
// #   - the copy control is disabled while violations are open
// #   - copyText() itself refuses to write, so the guard survives a
// #     programmatic call and does not depend on the disabled attribute alone
// #   - a clean draft copies normally, with no violations region
// ############################################################################
// ===========================================================================
describe('integration: genProposal -> copy control (RED until Stage 4)', () => {
  let harness;   // the loadApp() handle for THIS test's window
  let w;
  let writes;
  let stubCalls; // every URL genProposal asked the in-process stub for

  // A draft with three unmistakable, open violations: an em dash, a bracketed
  // placeholder, and a badge claim.
  const DIRTY_DRAFT = CLEAN_PROPOSAL
    .replace('That is the exact problem', 'That — is the exact problem')
    .replace('Your team is losing hours', 'Hi [Client Name], your team is losing hours')
    .replace('We would bring the same approach', 'As a Top Rated team we would bring the same approach');

  // Renders a draft through the REAL genProposal() with a local stub standing in
  // for the /api/claude response. No network: the stub resolves in-process.
  async function render(draftText, mode = 'priority') {
    w.setVal('job-text', JOB_TEXT);
    w.fetch = async (url) => {
      stubCalls.push(String(url));
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: [{ type: 'text', text: draftText }] }),
        text: async () => '',
      };
    };
    await w.genProposal(mode);
    return w.document.getElementById('prop-out');
  }

  function copyButton(out) {
    return Array.from(out.querySelectorAll('button')).find((b) => /copy/i.test(b.textContent));
  }

  beforeEach(() => {
    // Fresh window per test so one render cannot leak into the next. Keep the
    // handle: its fetchCalls array is the ONLY witness of a real network call
    // from this window, and the network test below has to read that one.
    harness = loadApp();
    w = harness.window;
    writes = [];
    stubCalls = [];
    // jsdom has no clipboard; give the app one we can inspect.
    Object.defineProperty(w.navigator, 'clipboard', {
      value: { writeText: (t) => { writes.push(String(t)); return Promise.resolve(); } },
      configurable: true,
    });
    // jsdom does not implement innerText, which copyText() reads. Map it to
    // textContent so the handed-over text is observable.
    if (!('innerText' in w.HTMLElement.prototype)) {
      Object.defineProperty(w.HTMLElement.prototype, 'innerText', {
        get() { return this.textContent; },
        configurable: true,
      });
    }
  });

  it('renders the draft into #prop-out [data-copy] (passes today)', async () => {
    const out = await render(CLEAN_PROPOSAL);
    expect(out.querySelector('[data-copy]')).not.toBeNull();
  });

  it('renders without touching the network (passes today)', async () => {
    // This used to build a SECOND, unused window and compare that window's
    // counter before and after — a render on `w` could never move it, so the
    // assertion could not fail. Read the counter of the window actually being
    // rendered into, and pin what the in-process stub was asked for.
    const before = harness.fetchCalls.length;
    await render(CLEAN_PROPOSAL);
    expect(harness.fetchCalls.length).toBe(before); // no reach-around to real fetch
    expect(stubCalls.length).toBeGreaterThan(0);    // the stub really was the path taken
    stubCalls.forEach((u) => expect(u).toBe('/api/claude')); // same-origin proxy only
  });

  it('surfaces the open violations in the card as [data-violations]', async () => {
    const out = await render(DIRTY_DRAFT);
    expect(out.querySelector('[data-violations]')).not.toBeNull();
  });

  it('names the failing rule ids in the violations region', async () => {
    const out = await render(DIRTY_DRAFT);
    const region = out.querySelector('[data-violations]');
    const txt = region ? region.textContent : '';
    expect(txt).toContain('dash');
    expect(txt).toContain('placeholder');
    expect(txt).toContain('badge');
  });

  it('disables the copy control while violations are open', async () => {
    const out = await render(DIRTY_DRAFT);
    const btn = copyButton(out);
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(true);
  });

  it('copyText() refuses to hand over a draft with open violations', async () => {
    // The load-bearing assertion: even called directly, the copy path must not
    // put violating text on the clipboard. A disabled attribute alone is not a
    // guard, it is a hint.
    const out = await render(DIRTY_DRAFT);
    const btn = copyButton(out);
    w.copyText(btn);
    expect(writes).toEqual([]);
  });

  it('a clean draft leaves the copy control enabled', async () => {
    const out = await render(CLEAN_PROPOSAL);
    const btn = copyButton(out);
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(false);
  });

  it('a clean draft shows no violations region', async () => {
    const out = await render(CLEAN_PROPOSAL);
    expect(out.querySelector('[data-violations]')).toBeNull();
  });

  it('copyText() does hand over a clean draft', async () => {
    const out = await render(CLEAN_PROPOSAL);
    w.copyText(copyButton(out));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('parse accuracy');
  });

  it('a speed bid under 120 words is not blocked by the length rule', async () => {
    // mode 'speed' renders through the same card; the length rule must not
    // disable the copy control for a deliberately short bid.
    const short = 'PROPOSAL\nWe can start on your intake today, and we ship the first slice early.';
    const out = await render(short, 'speed');
    const btn = copyButton(out);
    expect(btn).toBeDefined();
    expect(btn.disabled).toBe(false);
  });
});
