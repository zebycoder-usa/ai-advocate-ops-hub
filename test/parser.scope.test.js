// Stage 1 — SECTION-SCOPE mutation tests for parseJob().
//
// WHAT THIS SUITE IS FOR
// A pasted Upwork page has five regions, always in this order:
//   1. site chrome                      ... ends at "Account Settings"
//   2. JOB BLOCK    (title, posted, location, Summary, budget, skills)
//                                        ... ends at "Activity on this job"
//   3. ACTIVITY BLOCK (proposals, interviewing, invites, connects, bid range)
//                                        ... ends at "About the client"
//   4. CLIENT BLOCK (verified, rating, country/city, jobs posted, hire rate,
//      open jobs, total spent, hires, avg hourly paid, member since, job link)
//                                        ... ends at "Client's recent history"
//                                            OR "Other open jobs by this Client"
//                                            OR "Footer navigation"
//   5. NOISE        (client history, other open jobs, footer nav)
//
// parseJob() today runs every regex against the WHOLE pasted blob, so region 5
// — dozens of unrelated past jobs and open listings — can and does decide the
// budget, the country ban and the industry ban of the job being scored. That is
// the single largest revenue bug in the tool: it both kills good jobs (a false
// hard ban) and mis-prices real ones.
//
// Each test below mutates a REAL fixture in memory (never on disk) so that the
// ONLY difference between the clean and mutated text is WHERE a word sits.
// A red test here is the proof the defect exists. Stage 2 implements the
// section model; these assertions are what it has to satisfy.
//
// POLICY IS FROZEN. Nothing here changes which industries/companies/countries
// are banned, what a point is worth, or where a band sits. Every "must still
// ban" case is asserted so this suite can never be used to weaken a real ban.
//
// TWO GROUPS HERE ARE BLOCKED ON AN OWNER DECISION, not on code (see the notes
// on each): group 3 (does an idiomatic / negated / nice-to-have mention of a
// banned word still count as that industry?) and group 8 (is Ukraine on the
// Europe list?). Group 8 additionally CONTRADICTS a sibling suite that is green
// today — parser.truth.test.js pins job_voice.txt to isEurope=false,
// region='Other' and the outside-region flag. Both suites cannot be satisfied;
// the owner has to say which one is right before either is changed.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadApp } from './loadApp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

// parseJob() is pure apart from getAllowedRegions() (localStorage, default
// ['US','Europe']). One window is therefore enough for the whole file; tests
// that drive the FORM would need a fresh loadApp() per case, these do not.
let app;
beforeAll(() => { app = loadApp(); });
const parse = (t) => app.parseJob(t);

/* ---------------------------------------------------------------- ban strings
   Copied verbatim from index.html so a typo can never make a test pass. */
const BAN_COUNTRY  = 'Client in India/Bangladesh/Pakistan (hard ban)';
const BAN_FINANCE  = 'Banned industry (finance/crypto/trading)';
const BAN_WEAPONS  = 'Banned industry (weapons/defense)';
const BAN_COMPANY  = 'Banned company';
const FIXED_UNDER_200 = /^Fixed-price under \$200/;
const OUTSIDE_REGION  = /^Outside allowed regions/;

/* ------------------------------------------------------------------ mutators
   Line-precise splices, so a snippet lands in exactly one region. */
function insertAfterLine(text, marker, snippet) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => marker.test(l));
  if (i < 0) throw new Error(`insertAfterLine: marker not found: ${marker}`);
  lines.splice(i + 1, 0, snippet);
  return lines.join('\n');
}
function insertBeforeLine(text, marker, snippet) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => marker.test(l));
  if (i < 0) throw new Error(`insertBeforeLine: marker not found: ${marker}`);
  lines.splice(i, 0, snippet);
  return lines.join('\n');
}

const M_SUMMARY   = /^Summary$/;
const M_ACTIVITY  = /^Activity on this job$/;
const M_CLIENT    = /^About the client$/;
const M_HISTORY   = /^Client's recent history/;
const M_OTHERJOBS = /^Other open jobs by this Client/;

// Region 5, "Client's recent history".
const intoHistory   = (text, s) => insertAfterLine(text, M_HISTORY, s);
// Region 5, "Other open jobs by this Client".
const intoOtherJobs = (text, s) => insertAfterLine(text, M_OTHERJOBS, s);
// Region 2, inside the Summary prose.
const intoJobBlock  = (text, s) => insertAfterLine(text, M_SUMMARY, s);
// Region 2, the skills tail just before "Activity on this job".
const intoSkills    = (text, s) => insertBeforeLine(text, M_ACTIVITY, s);
// Region 4, right under "About the client".
const intoClient    = (text, s) => insertAfterLine(text, M_CLIENT, s);

/* ------------------------------------------------------------------- bases
   job_browserext.txt is the only fixture that clears the $200 fixed-price
   floor, but its client is genuinely in Pakistan. Swapping ONLY the client
   country/city line gives a page with zero bans — the clean canvas every
   noise-injection test needs. Nothing else about the page is touched. */
const PK_CLIENT_LINES = 'Pakistan\nLahore4:58 PM';
const US_CLIENT_LINES = 'United States\nAustin4:58 PM';
const IN_CLIENT_LINES = 'India\nMumbai4:58 PM';

const cleanUsJob = () => fixture('job_browserext.txt').replace(PK_CLIENT_LINES, US_CLIENT_LINES);
const mumbaiJob  = () => cleanUsJob().replace(US_CLIENT_LINES, IN_CLIENT_LINES);

// job_n8n.txt turned into a REAL hourly job: only the job block's budget lines
// change ($50.00/Fixed-price -> $95.00/Hourly). Its client history still says
// "Fixed-price $20.00" / "Fixed-price $10.27" and its client panel still says
// "$11.70 /hr avg hourly rate paid" — all three are traps, none is this job's
// budget.
const N8N_FIXED_BUDGET  = '$50.00\n\nFixed-price';
const N8N_HOURLY_BUDGET = '$95.00\n\nHourly';
const n8nAsHourly = () => fixture('job_n8n.txt').replace(N8N_FIXED_BUDGET, N8N_HOURLY_BUDGET);

/* ============================================================== 0. guards
   If these go red, every other result in this file is meaningless. */
describe('0 — bases are what the tests assume', () => {
  it('the clean base really has zero bans before any mutation', () => {
    expect(parse(cleanUsJob()).bans).toEqual([]);
  });

  it('the clean base swap actually replaced the client country lines', () => {
    const t = cleanUsJob();
    expect(t).toContain(US_CLIENT_LINES);
    expect(t).not.toContain(PK_CLIENT_LINES);
  });

  it('the hourly mutation actually replaced the job block budget lines', () => {
    const t = n8nAsHourly();
    expect(t).toContain(N8N_HOURLY_BUDGET);
    expect(t).not.toContain(N8N_FIXED_BUDGET);
    // the noise traps must still be present, or test group 4 proves nothing
    expect(t).toContain('Fixed-price $20.00');
    expect(t).toContain('Fixed-price $10.27');
    expect(t).toContain('$11.70 /hr avg hourly rate paid');
  });
});

/* ====================================== 1. noise must never create a hard ban
   Same six words, all placed in region 5 only. The job itself is clean. */
describe('1 — a ban word in the NOISE sections must not ban the job', () => {
  it('"Mumbai" in the client history is a past project, not the client country', () => {
    const P = parse(intoHistory(cleanUsJob(), 'Explainer Video for a Studio in Mumbai'));
    expect(P.bans).not.toContain(BAN_COUNTRY);
    expect(P.isBanCountry).toBe(false);
    expect(P.bans).toEqual([]);
  });

  it('"Bangalore" in the client history is a past project, not the client country', () => {
    const P = parse(intoHistory(cleanUsJob(), 'Data Entry Support for a Bangalore Office'));
    expect(P.bans).not.toContain(BAN_COUNTRY);
    expect(P.isBanCountry).toBe(false);
    expect(P.bans).toEqual([]);
  });

  it('"crypto" in another open job does not make THIS job a crypto job', () => {
    const P = parse(intoOtherJobs(cleanUsJob(), 'Landing Page for a Crypto Exchange BrandFixed-price'));
    expect(P.bans).not.toContain(BAN_FINANCE);
    expect(P.bans).toEqual([]);
  });

  it('"military" in another open job does not make THIS job defense work', () => {
    const P = parse(intoOtherJobs(cleanUsJob(), 'Military Museum Website RefreshFixed-price'));
    expect(P.bans).not.toContain(BAN_WEAPONS);
    expect(P.bans).toEqual([]);
  });

  it('"Stewart" in the client history is a past client name, not this client', () => {
    const P = parse(intoHistory(cleanUsJob(), 'Brand Video for Stewart Retail Group'));
    expect(P.bans).not.toContain(BAN_COMPANY);
    expect(P.bans).toEqual([]);
  });

  it('"Lynx" in another open job is a past product, not this client', () => {
    const P = parse(intoOtherJobs(cleanUsJob(), 'Packaging Design for Lynx DeodorantFixed-price'));
    expect(P.bans).not.toContain(BAN_COMPANY);
    expect(P.bans).toEqual([]);
  });

  it('all six noise words at once still leave the job clean', () => {
    let t = cleanUsJob();
    t = intoHistory(t, 'Explainer Video for a Studio in Mumbai');
    t = intoHistory(t, 'Data Entry Support for a Bangalore Office');
    t = intoHistory(t, 'Brand Video for Stewart Retail Group');
    t = intoOtherJobs(t, 'Landing Page for a Crypto Exchange BrandFixed-price');
    t = intoOtherJobs(t, 'Military Museum Website RefreshFixed-price');
    t = intoOtherJobs(t, 'Packaging Design for Lynx DeodorantFixed-price');
    expect(parse(t).bans).toEqual([]);
  });
});

/* ============================ 2. the same word IN THE RIGHT PLACE must ban
   This group exists so the fix can never be "stop banning". */
describe('2 — the same words in their OWN section must still hard ban', () => {
  it('client block says Mumbai -> country ban fires', () => {
    const P = parse(mumbaiJob());
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain(BAN_COUNTRY);
  });

  it('client block says Bangalore -> country ban fires', () => {
    const P = parse(cleanUsJob().replace(US_CLIENT_LINES, 'India\nBangalore4:58 PM'));
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain(BAN_COUNTRY);
  });

  it('job block Summary is about crypto trading -> industry ban fires', () => {
    const P = parse(intoJobBlock(cleanUsJob(),
      'We are building a crypto trading dashboard for our own exchange desk.'));
    expect(P.bans).toContain(BAN_FINANCE);
  });

  it('job block Summary is real defense work -> weapons ban fires', () => {
    const P = parse(intoJobBlock(cleanUsJob(),
      'This is a military targeting system for a defense contractor.'));
    expect(P.bans).toContain(BAN_WEAPONS);
  });

  it('job block names a banned company -> company ban fires', () => {
    const P = parse(intoJobBlock(cleanUsJob(),
      'You will be embedded with the Stewart brand team for this build.'));
    expect(P.bans).toContain(BAN_COMPANY);
  });

  it('job_browserext.txt (a genuine Pakistan client) keeps its country ban', () => {
    const P = parse(fixture('job_browserext.txt'));
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain(BAN_COUNTRY);
  });

  it('job_n8n.txt keeps its genuine fixed-price-under-200 ban', () => {
    const P = parse(fixture('job_n8n.txt'));
    expect(P.bans.some((b) => FIXED_UNDER_200.test(b))).toBe(true);
  });

  it('job_voice.txt keeps its genuine fixed-price-under-200 ban', () => {
    const P = parse(fixture('job_voice.txt'));
    expect(P.bans).toContain('Fixed-price under $200 ($150)');
  });
});

/* ==================================== 3. negation & compounds in the JOB BLOCK
   These are inside region 2 — the right section — so section routing alone will
   not fix them; they need the ban matcher to understand context. They are the
   second-biggest source of false SKIPs.

   BLOCKED ON AN OWNER DECISION. Each of the four cases below asks for a CARVE-OUT
   from a frozen ban list ("this mention of the banned word does not count"), and
   nobody has ruled on carve-outs. The decision the owner owes is: does a negated
   ("no crypto experience needed"), idiomatic ("military-grade encryption",
   "defense against prompt injection") or nice-to-have-tag mention of a banned
   word still ban the job? The two companion assertions at the end of the group
   are the floor and must never be relaxed whichever way the ruling goes. */
describe('3 — negations and compounds in the job block must not ban', () => {
  it('"no crypto experience needed" is not a crypto job', () => {
    // JUDGEMENT CALL: unambiguous. The client is explicitly ruling crypto OUT.
    // A bidder reading this page would never call it a finance job.
    const P = parse(intoJobBlock(cleanUsJob(),
      'No crypto experience needed - this is a plain B2B SaaS dashboard.'));
    expect(P.bans).not.toContain(BAN_FINANCE);
    expect(P.bans).toEqual([]);
  });

  it('"military-grade encryption" is a security idiom, not defense work', () => {
    // JUDGEMENT CALL: arguable but one-sided. "Military-grade" is boilerplate
    // marketing language for AES-256; it appears on fintech-free SaaS pages
    // constantly. Treating it as weapons work costs real bids and buys nothing.
    const P = parse(intoJobBlock(cleanUsJob(),
      'All user data is protected with military-grade encryption at rest and in transit.'));
    expect(P.bans).not.toContain(BAN_WEAPONS);
    expect(P.bans).toEqual([]);
  });

  it('"defense against prompt injection" is an AI-security requirement', () => {
    // JUDGEMENT CALL: arguable but one-sided. "Defense against X" is the normal
    // English for hardening. This exact phrase shows up in most agent/LLM job
    // posts we WANT to bid on, so the current match is a self-inflicted wound.
    const P = parse(intoJobBlock(cleanUsJob(),
      'Implement defense against prompt injection and jailbreak attempts in the agent layer.'));
    expect(P.bans).not.toContain(BAN_WEAPONS);
    expect(P.bans).toEqual([]);
  });

  it('"Blockchain" as a NICE-TO-HAVE skill tag does not make it a blockchain job', () => {
    // JUDGEMENT CALL: the most arguable of the four, and deliberately narrow.
    // A nice-to-have tag is a bonus, not the work. If "Blockchain" were in
    // MANDATORY skills or in the Summary, the ban should stand — see the
    // companion assertion below, which this suite must never relax.
    const P = parse(intoSkills(cleanUsJob(), 'Nice-to-have skills\nBlockchain'));
    expect(P.bans).not.toContain(BAN_FINANCE);
    expect(P.bans).toEqual([]);
  });

  it('"Blockchain" as a MANDATORY skill still bans (the companion rule)', () => {
    const P = parse(intoSkills(cleanUsJob(), 'Mandatory skills\nBlockchain\nSolidity'));
    expect(P.bans).toContain(BAN_FINANCE);
  });

  it('a plain crypto Summary still bans even next to the word "no"', () => {
    // Guard against an over-broad negation fix that keys off the word "no".
    const P = parse(intoJobBlock(cleanUsJob(),
      'We have no frontend yet. Build the crypto trading engine and wallet.'));
    expect(P.bans).toContain(BAN_FINANCE);
  });
});

/* ================================================ 4. budget from the JOB BLOCK
   Region 5 lists every past and open job of the client, each labelled with its
   own price. None of them is this job's budget. */
describe('4 — budget type and amount come from the job block only', () => {
  it('job_n8n.txt: amount is the job block $50, not a client-history price', () => {
    const P = parse(fixture('job_n8n.txt'));
    expect(P.budgetType).toBe('fixed');
    expect(P.amount).toBe(50);
    expect(P.amount).not.toBe(20);
    expect(P.amount).not.toBe(10.27);
  });

  it('an hourly job stays hourly even when the noise is full of "Fixed-price"', () => {
    const P = parse(n8nAsHourly());
    expect(P.budgetType).toBe('hourly');
  });

  it('an hourly job takes the job block rate, not the noise "Fixed-price $20.00"', () => {
    const P = parse(n8nAsHourly());
    expect(P.amount).toBe(95);
    expect(P.amount).not.toBe(20);
    expect(P.amount).not.toBe(10.27);
  });

  it('an hourly job never fires the fixed-price-under-$200 ban', () => {
    // The whole ban is inapplicable to hourly work. Today the noise flips
    // budgetType to "fixed" and a $20 history price walks straight into it,
    // producing SKIP - HARD BAN on a $95/hr job.
    const P = parse(n8nAsHourly());
    expect(P.bans.some((b) => FIXED_UNDER_200.test(b))).toBe(false);
  });

  it('a $95/hr job is above the $40 rate floor, so no below-rate flag', () => {
    const P = parse(n8nAsHourly());
    expect(P.belowBudget).toBe(false);
    expect(P.flags).not.toContain('Below $40/hr rate floor — review before bidding');
  });

  it('injecting a cheap fixed-price line into the NOISE cannot move the amount', () => {
    const P = parse(intoOtherJobs(cleanUsJob(), 'Quick Logo TouchupFixed-price $15.00'));
    expect(P.amount).toBe(300);
    expect(P.bans.some((b) => FIXED_UNDER_200.test(b))).toBe(false);
  });
});

/* ============================================== 5. the client avg-rate trap
   "$11.70 /hr avg hourly rate paid" lives in the CLIENT block. It is a history
   statistic about the buyer, never the budget of the job being scored.

   TEST BUG, FIXED HERE. This group used to run on n8nAsHourly(). On that base
   the region-5 bait "Fixed-price $20.00" matches first, so amount came back 20
   — meaning the group only ever re-proved group 4, and its own point-of-the-
   group assertions (not.toBe(11.7), not.toBe(8)) could not have failed however
   parseJob behaved. The base below removes the fixed-price bait from REGION 5
   ONLY, by renaming the "Fixed-price" labels on the client's past contracts.
   Everything else — the job block's "$95.00 / Hourly" and the client block's
   "$11.70 /hr avg hourly rate paid" — is untouched, so the client's average is
   now the only money-shaped decoy outside the job block. On this base today's
   parser really does return 11.70 as the job's rate, mark belowBudget true and
   raise a false "Below $40/hr" flag on a $95/hr job. */
const MARK_HISTORY = "Client's recent history";
const n8nAvgRateTrap = () => {
  const t = n8nAsHourly();
  const i = t.indexOf(MARK_HISTORY);
  if (i < 0) throw new Error('fixture no longer has a client-history section');
  return t.slice(0, i) + t.slice(i).replace(/Fixed-price/g, 'Contract');
};

describe('5 — the client "avg hourly rate paid" is not the job rate', () => {
  it('the isolating base leaves the client average as the only decoy', () => {
    const t = n8nAvgRateTrap();
    const i = t.indexOf(MARK_HISTORY);
    expect(t.slice(0, i)).toContain(N8N_HOURLY_BUDGET);      // job block still $95/Hourly
    expect(t.slice(i)).not.toContain('Fixed-price');         // region-5 bait removed
    expect(t).toContain('$11.70 /hr avg hourly rate paid');  // the trap under test
  });

  it('a $95/hr job whose client averages $11.70/hr parses as 95', () => {
    const P = parse(n8nAvgRateTrap());
    expect(P.amount).toBe(95);
    expect(P.amount).not.toBe(11.7);
  });

  it('the client avg rate cannot drag a good job under the $40 floor', () => {
    const P = parse(n8nAvgRateTrap());
    expect(P.belowBudget).toBe(false);
    expect(P.flags).not.toContain('Below $40/hr rate floor — review before bidding');
  });

  it('a low client avg rate injected into the CLIENT block is still ignored', () => {
    const P = parse(intoClient(n8nAvgRateTrap(), '$8.00 /hr avg hourly rate paid'));
    expect(P.amount).toBe(95);
    expect(P.amount).not.toBe(8);
  });
});

/* ================================================= 6. the "Indiana" kill switch
   isBanCountry is ANDed with !/\bindiana\b/ over the WHOLE page, so any
   occurrence of the US state anywhere — including region 5 — silently disables
   the entire country hard ban. */
describe('6 — "Indiana" anywhere must not disable the country ban', () => {
  it('a Mumbai client still bans when "Indiana" appears in the noise', () => {
    const t = intoOtherJobs(mumbaiJob(), 'Storefront Redesign for an Indiana Bakery ChainFixed-price');
    const P = parse(t);
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain(BAN_COUNTRY);
  });

  it('a Mumbai client still bans when "Indiana" appears in the client history', () => {
    const t = intoHistory(mumbaiJob(), 'Menu Photography for an Indiana Diner');
    const P = parse(t);
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain(BAN_COUNTRY);
  });

  it('a Mumbai client still bans when "Indiana" appears in the job block', () => {
    const t = intoJobBlock(mumbaiJob(), 'Our pilot users are franchise owners in Indiana.');
    const P = parse(t);
    expect(P.isBanCountry).toBe(true);
    expect(P.bans).toContain(BAN_COUNTRY);
  });

  it('a genuine Indiana client is still NOT banned (the guard\'s real purpose)', () => {
    const t = cleanUsJob().replace(US_CLIENT_LINES, 'United States\nIndianapolis, Indiana4:58 PM');
    const P = parse(t);
    expect(P.isBanCountry).toBe(false);
    expect(P.bans).toEqual([]);
  });
});

/* ================================================== 7. total-spent shapes
   P.spent drives the client score; P.totalSpendRaw is the CLEval column. The
   column regex demands the literal "<money> total spent" shape, so the two very
   common variants below produce an empty cell. */
describe('7 — total spent parses beyond the exact "$26K total spent" shape', () => {
  it('the baseline "$26K total spent" shape parses (regression guard)', () => {
    const P = parse(fixture('job_n8n.txt'));
    expect(P.spent).toBe(26000);
    expect(P.totalSpendRaw).toBe('$26K');
  });

  it('"$10K+ total spent" parses to 10000', () => {
    const P = parse(cleanUsJob().replace('$70 total spent', '$10K+ total spent'));
    expect(P.spent).toBe(10000);
  });

  it('"$10K+ total spent" fills the CLEval spend column', () => {
    const P = parse(cleanUsJob().replace('$70 total spent', '$10K+ total spent'));
    expect(P.totalSpendRaw).not.toBe('');
    expect(P.totalSpendRaw).toContain('$10K');
  });

  it('"$0 spent" parses to 0', () => {
    const P = parse(cleanUsJob().replace('$70 total spent', '$0 spent'));
    expect(P.spent).toBe(0);
  });

  it('"$0 spent" fills the CLEval spend column', () => {
    const P = parse(cleanUsJob().replace('$70 total spent', '$0 spent'));
    expect(P.totalSpendRaw).toBe('$0');
  });

  it('a spend figure in the NOISE cannot overwrite the client block figure', () => {
    const t = intoOtherJobs(cleanUsJob(), 'Ghostwriting Retainer - $90K total spent to dateFixed-price');
    expect(parse(t).spent).toBe(70);
  });
});

/* ======================================================== 8. Ukraine is Europe
   NOTE: this depends on the Europe list being completed. The list in index.html
   enumerates western/central European countries and capitals and stops there;
   Ukraine (and the "UKR" country code Upwork prints) is absent, so a Kherson
   client falls through to region "Other" and gets flagged. Ukraine is a normal,
   allowed European market for us — the flag is a false positive, not policy.
   This does NOT propose adding any region to the allowed set; Europe is already
   allowed, the list is just incomplete.

   BLOCKED ON AN OWNER DECISION, and on a direct conflict with a GREEN sibling
   suite. parser.truth.test.js asserts the opposite for this very fixture:
     "does not count Ukraine as Europe, because it is not on the app Europe list"
        -> expect(P.isEurope).toBe(false)
     "files the client region as Other"          -> expect(P.region).toBe('Other')
     "flags the client region for review ..."    -> expect(P.flags).toEqual([...])
   Those three pass today; the three below cannot pass at the same time. Do not
   change index.html for either suite until the owner rules on the one question:
   is Ukraine (and the "UKR" code Upwork prints) on our Europe list or not? The
   loser's assertions get updated, and only then. */
describe('8 — a Ukrainian client is inside the allowed regions', () => {
  it('job_voice.txt is not flagged as outside the allowed regions', () => {
    const P = parse(fixture('job_voice.txt'));
    expect(P.flags.some((f) => OUTSIDE_REGION.test(f))).toBe(false);
  });

  it('job_voice.txt resolves to the Europe region', () => {
    const P = parse(fixture('job_voice.txt'));
    expect(P.region).toBe('Europe');
  });

  it('a spelled-out "Ukraine" client is also Europe', () => {
    const t = cleanUsJob().replace(US_CLIENT_LINES, 'Ukraine\nKyiv4:58 PM');
    const P = parse(t);
    expect(P.region).toBe('Europe');
    expect(P.flags.some((f) => OUTSIDE_REGION.test(f))).toBe(false);
  });

  it('a genuinely outside region is still flagged (policy unchanged)', () => {
    const t = cleanUsJob().replace(US_CLIENT_LINES, 'Brazil\nSao Paulo4:58 PM');
    const P = parse(t);
    expect(P.region).toBe('Other');
    expect(P.flags.some((f) => OUTSIDE_REGION.test(f))).toBe(true);
    expect(P.bans).toEqual([]); // outside-region is a flag, never a ban
  });
});
