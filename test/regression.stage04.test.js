// Regressions introduced BY the Stage 0-4 fixes and caught by an adversarial
// review after they had already shipped to production.
//
// Every case here was reproduced against the shipped code before being fixed.
// They exist because the first round of fixes was verified against three clean
// fixtures and a green suite, which is exactly the failure this project was
// audited for in the first place.
import { describe, it, expect } from 'vitest';
import { loadApp } from './loadApp.js';

const app = loadApp();
const parse = (t) => app.parseJob(t);

// A complete, realistic Upwork page. `desc` is dropped into the description so a
// test can prove that description prose cannot move a section boundary.
function page({ desc = 'We need a senior React engineer to build an internal dashboard.', budget = '$95.00\n/hr\nHourly' } = {}) {
  return [
    'Skip to content', 'Upwork home', 'Find work', '', 'Account Settings',
    'Senior React Engineer for Internal Dashboard',
    'Posted 12 minutes ago',
    'Worldwide',
    '',
    'Summary',
    desc,
    '',
    budget,
    'Intermediate',
    'Skills and Expertise',
    'Mandatory skills', 'React', 'Node.js',
    'Activity on this job',
    'Proposals:', '5 to 10',
    'Interviewing:', '1',
    'Invites sent:', '2',
    'Unanswered invites:', '0',
    'Send a proposal for: 12 Connects',
    'About the client',
    'Payment method verified',
    'Rating is 5.0 out of 5.', '4.92 of 214 reviews',
    'United States', 'Seattle9:14 AM',
    '18 jobs posted', '64% hire rate, 3 open jobs',
    '$26K total spent', '12 hires, 1 active',
    'Member since Mar 3, 2024',
    'Job link', 'https://www.upwork.com/jobs/~021111111111111111111',
    "Client's recent history (12)",
    'Explainer Video for a Studio in Mumbai', 'Fixed-price $20.00',
    'Other open jobs by this Client (3)',
    'Crypto Trading Bot MaintenanceFixed-price',
    'Footer navigation', 'About Us', 'Terms of Service',
  ].join('\n');
}

const CRYPTO = 'We are building a cryptocurrency exchange and need blockchain settlement work.';
const BAN_FINANCE = 'Banned industry (finance/crypto/trading)';

describe('parser: description prose must not move a section boundary', () => {
  it('a crypto job still hard bans when the description contains "About the client:"', () => {
    // Shipped behaviour: the phrase truncated the JOB block, so the crypto words
    // landed in the client region where the ban scan never looks. APPLY, not SKIP.
    const P = parse(page({ desc: 'About the client: a Series B fintech in NYC.\n' + CRYPTO }));
    expect(P.bans).toContain(BAN_FINANCE);
  });

  it('a crypto job still hard bans when "About the Client" is its own heading in the post', () => {
    const P = parse(page({ desc: 'About the Client\nA Series B fintech.\n' + CRYPTO }));
    expect(P.bans).toContain(BAN_FINANCE);
  });

  it('the budget survives an "About the client" mention in the description', () => {
    const P = parse(page({ desc: 'About the client: a design studio.\nWe need a dashboard.' }));
    expect(P.budgetType).toBe('hourly');
    expect(P.amount).toBe(95);
  });

  it('a description mentioning "the client\'s recent history" does not void the parse', () => {
    // Shipped behaviour: all four regions collapsed onto the same short prefix.
    const P = parse(page({ desc: "Deliver a report on the client's recent history of orders." }));
    expect(P.budgetType).toBe('hourly');
    expect(P.amount).toBe(95);
    expect(P.proposalsLow).toBe(5);
    expect(P.verified).toBe(true);
    expect(P.spent).toBe(26000);
    expect(P.region).toBe('US');
  });

  it('a crypto job still bans even when the description mentions recent history', () => {
    const P = parse(page({ desc: "A report on the client's recent history.\n" + CRYPTO }));
    expect(P.bans).toContain(BAN_FINANCE);
  });

  it('"Nice to have skills:" written as prose does not delete the rest of the description', () => {
    // Shipped behaviour: the strip ran to the end of the job block, taking the
    // sentence that said what the product actually was.
    const P = parse(page({ desc: 'Nice to have skills: Docker, Kubernetes.\n' + CRYPTO }));
    expect(P.bans).toContain(BAN_FINANCE);
  });

  it('the real nice-to-have CHIP list is still excluded from the ban scan', () => {
    const P = parse(page({ desc: 'Build a dashboard.\n\nNice-to-have skills\nBlockchain\nD3.js\n\nPreferred qualifications' }));
    expect(P.bans).toEqual([]);
  });

  it('noise sections still cannot ban: Mumbai and a crypto job in the tail stay harmless', () => {
    const P = parse(page());
    expect(P.isBanCountry).toBe(false);
    expect(P.bans).toEqual([]);
    expect(P.region).toBe('US');
  });
});

describe('scoring inputs: baseline and operator intent', () => {
  it('the budget-type baseline is a value the dropdown actually has', () => {
    const a = loadApp();
    const opts = Array.from(a.doc.getElementById('b-type').options).map((o) => o.value);
    a.window.resetSignals();
    expect(opts).toContain(a.doc.getElementById('b-type').value);
  });

  it('an hourly job under the floor is judged against $40, not the $200 fixed floor', () => {
    // Shipped behaviour: the baseline blanked b-type, so bt==='hourly' failed.
    const a = loadApp();
    a.window.setVal('job-text', page({ budget: '$35.00\n/hr\nHourly' }));
    a.window.runEval();
    expect(a.doc.getElementById('b-type').value).toBe('hourly');
    expect(a.window.parseJob(a.window.val('job-text')).belowBudget).toBe(true);
  });

  it("an operator's hard-ban tick survives pressing Evaluate again on the same job", () => {
    // Shipped behaviour: autofill wrote j-ban false, wiping the tick, and pressing
    // Evaluate is the only way to make the tick take effect.
    const a = loadApp();
    a.window.setVal('job-text', page());
    a.window.runEval();
    a.window.setVal('j-ban', true);
    a.window.runEval();
    expect(a.window.chk('j-ban')).toBe(true);
    expect(a.window.evalDecision().banned).toBe(true);
  });

  it('a genuinely new job still clears the previous job\'s tick', () => {
    const a = loadApp();
    a.window.setVal('job-text', page());
    a.window.runEval();
    a.window.setVal('j-ban', true);
    a.window.setVal('job-text', page({ desc: 'A completely different job about data pipelines.' }));
    a.window.runEval();
    expect(a.window.chk('j-ban')).toBe(false);
  });
});

describe('shortlist agrees with the decision card', () => {
  it('a Worldwide job with no US marker is not silently recorded as 0', () => {
    // Shipped behaviour: shortlist ran its own rule engine, and usOnly changed
    // meaning under it, so almost every job recorded 0.
    const a = loadApp();
    a.window.setVal('job-text', page());
    a.window.runEval();
    const card = a.window.evalDecision();
    a.window.shortlist();
    const row = a.window.mem.pipeline[a.window.mem.pipeline.length - 1];
    expect(card.banned).toBe(false);
    expect(row.score).toBe(card.total);
    expect(row.score).toBeGreaterThan(0);
  });
});

describe('proposal guard: must not block work a human would send', () => {
  const BANK = app.window.AGENCY_PROOF_BANK;
  const V = (t, o) => app.window.validateProposal(t, Object.assign({ proofBank: BANK, jobText: '', mode: 'proposal' }, o || {}));
  const body = (n) => Array.from({ length: n }, (_, i) => ['we', 'build', 'reliable', 'software', 'for', 'your', 'team', 'and', 'we', 'ship', 'it', 'early'][i % 12]).join(' ');
  const ruleIds = (r) => r.violations.map((v) => v.rule);

  it('accepts a markdown-labelled draft, which is what the model actually writes', () => {
    const t = '**PROPOSAL**\n' + body(140) + '\n\n**INTRO MESSAGE**\n' + body(120);
    expect(ruleIds(V(t))).not.toContain('length');
  });

  it('accepts a heading-labelled draft', () => {
    const t = '## Proposal\n' + body(140) + '\n\n## Intro Message\n' + body(120);
    expect(ruleIds(V(t))).not.toContain('length');
  });

  it('accepts "COVER LETTER" as the second block, which CLAUDE.md also calls it', () => {
    const t = 'PROPOSAL\n' + body(140) + '\n\nCOVER LETTER\nWe can start on your intake this week.';
    expect(ruleIds(V(t))).not.toContain('length');
  });

  it('ignores a dash in the model preamble, which never reaches the client', () => {
    const t = 'Here is your draft — review before sending.\n\nPROPOSAL\n' + body(140);
    expect(ruleIds(V(t))).not.toContain('dash');
  });

  it('allows mirroring the client\'s own words back in quotes, which the voice rules require', () => {
    const t = 'PROPOSAL\nYou wrote "I need this dashboard working before our board meeting". We can do that. ' + body(130);
    expect(ruleIds(V(t))).not.toContain('voice');
  });

  it('still fires on voice when the agency itself says I, outside any quote', () => {
    const t = 'PROPOSAL\nWe would map your intake. I will handle the deployment personally. ' + body(130);
    expect(ruleIds(V(t))).toContain('voice');
  });

  it('does not report version strings and standards as invented metrics', () => {
    const t = 'PROPOSAL\nWe build on Python 3.11, Node 20, React 18, Manifest V3, OAuth 2.0 and ISO 27001. ' + body(125);
    expect(ruleIds(V(t))).not.toContain('unbacked-number');
  });

  it('does not report ordinary durations and team sizes as invented metrics', () => {
    const t = 'PROPOSAL\nWe would ship a working slice in 3 weeks with 2 engineers, running 24/7. ' + body(125);
    expect(ruleIds(V(t))).not.toContain('unbacked-number');
  });

  it('does not treat a markdown link as an unfilled placeholder', () => {
    const t = 'PROPOSAL\nOur write-up is at [our case study](https://example.com/case). ' + body(130);
    expect(ruleIds(V(t))).not.toContain('placeholder');
  });

  it('still catches a genuinely invented metric', () => {
    const t = 'PROPOSAL\nWe lifted revenue by 63% for a similar client. ' + body(130);
    expect(ruleIds(V(t))).toContain('unbacked-number');
  });

  it('still catches a real bracketed placeholder', () => {
    const t = 'PROPOSAL\nHello [Client Name], we can help. ' + body(130);
    expect(ruleIds(V(t))).toContain('placeholder');
  });
});
