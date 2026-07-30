// GROUND-TRUTH suite for parseJob(), field by field, over the three REAL pasted
// Upwork pages in test/fixtures/.
//
// This suite is deliberately NOT a characterization suite. Every assertion is
// the value a human read off the actual Upwork page, never the value the current
// parser happens to return. Assertions that are RED today carry a trailing
// comment naming the defect; a red test here is the proof the bug exists, so do
// NOT soften one to get green, and do not .skip or .todo it.
//
// The model the fixes will be built against: a pasted page has ordered regions —
//   1 site chrome (ends at "Account Settings")
//   2 JOB BLOCK    (title, posted, location, summary, budget, skills) ends at "Activity on this job"
//   3 ACTIVITY     (proposals, interviewing, invites, connects, bid range) ends at "About the client"
//   4 CLIENT BLOCK (payment verified, rating, country, spend, hire rate, member since, job link)
//   5 NOISE        (client history, other open jobs, footer) — must never influence a value.
// Routing: budget + industry/company bans read the JOB BLOCK only; country ban,
// payment/rating/spend/hire rate/region read the CLIENT BLOCK only; proposals,
// interviewing, invites, connects and bid range read the ACTIVITY BLOCK only.
//
// Policy is frozen here: which industries ban, what a point is worth and where a
// band sits are owner decisions, not this suite's business.
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadApp } from './loadApp.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name) => readFileSync(join(FIXTURES, name), 'utf8');

/* ==========================================================================
   FIXTURE 1 — job_n8n.txt
   "n8n AI Automation Expert", fixed $50, US client, huge noise tail.
   ========================================================================== */
describe('job_n8n.txt — the $50 n8n automation job posted by a big US client', () => {
  let P;
  beforeAll(() => {
    // Fresh window per fixture so nothing leaks between evaluations.
    const app = loadApp();
    P = app.parseJob(readFixture('job_n8n.txt'));
  });

  it('reads the job title exactly as it appears at the top of the page', () => {
    expect(P.title).toBe('n8n AI Automation Expert');
  });

  it('knows the job was posted 38 minutes ago', () => {
    expect(P.postedAgo).toBe('38 minutes ago');
  });

  it('recognises this as a fixed-price job, not an hourly one', () => {
    expect(P.budgetType).toBe('fixed');
  });

  it('reads the budget as $50, not one of the old job prices further down the page', () => {
    // The noise tail contains "Fixed-price $20.00" and "Fixed-price $10.27"
    // from the client's past contracts, plus 23 other open jobs.
    expect(P.amount).toBe(50);
  });

  it('reads the proposal bucket "20 to 50" and takes 20 as the low end', () => {
    expect(P.proposalsRaw).toBe('20 to 50');
    expect(P.proposalsLow).toBe(20);
  });

  it('counts nobody being interviewed yet', () => {
    expect(P.interviewing).toBe(0);
  });

  it('counts 1 invite sent and 1 of them unanswered', () => {
    expect(P.invitesSent).toBe(1);
    expect(P.unansweredInvites).toBe(1);
  });

  it('knows the proposal costs 11 Connects', () => {
    expect(P.connects).toBe(11);
  });

  it('leaves the bid range blank because the page hides it behind the upgrade message', () => {
    expect(P.bidHigh).toBe('-');
    expect(P.bidAvg).toBe('-');
    expect(P.bidLow).toBe('-');
  });

  it('sees that the client has a verified payment method', () => {
    expect(P.verified).toBe(true);
    expect(P.payVerified).toBe('Yes');
  });

  it('reads the real client rating of 4.99, not the rounded 5.0 badge', () => {
    // RED today: takes the rounded display line "Rating is 5.0 out of 5." and
    // returns 5, while the page's precise figure is 4.99 of 2,149 reviews.
    expect(P.rating).toBe(4.99);
  });

  it('keeps the precise rating string "4.99" for the CLEval row', () => {
    expect(P.ratingPrecise).toBe('4.99');
  });

  it('reads $26K total spent', () => {
    expect(P.spent).toBe(26000);
    expect(P.totalSpendRaw).toBe('$26K');
  });

  it('reads the 100% hire rate', () => {
    expect(P.hireRate).toBe(100);
  });

  it('reads the 87 open jobs from the client block', () => {
    expect(P.openJobs).toBe(87);
  });

  it('places the client in the US and not in Europe or a banned country', () => {
    expect(P.region).toBe('US');
    expect(P.isEurope).toBe(false);
    expect(P.isBanCountry).toBe(false);
  });

  it('sees the job itself is open Worldwide', () => {
    expect(P.worldwide).toBe(true);
  });

  it('does NOT treat the job as US-only just because the client happens to be American', () => {
    // RED today: usOnly is matched against the whole page, so "United States" in
    // the CLIENT block sets it. The JOB block's only location line is "Worldwide".
    expect(P.usOnly).toBe(false);
  });

  it('captures the job link', () => {
    expect(P.jobLink).toBe('https://www.upwork.com/jobs/~022078430146547204560');
  });

  it('bans the job for exactly one reason: the fixed price is under $200', () => {
    expect(P.bans).toEqual(['Fixed-price under $200 ($50)']);
  });

  it('raises no review flags on this job', () => {
    expect(P.flags).toEqual([]);
  });
});

/* ==========================================================================
   FIXTURE 2 — job_voice.txt
   "Build AI Voice Assistant Mobile App MVP", fixed $150, unverified Ukraine client.
   ========================================================================== */
describe('job_voice.txt — the $150 voice assistant MVP from an unverified Ukrainian client', () => {
  let P;
  beforeAll(() => {
    const app = loadApp();
    P = app.parseJob(readFixture('job_voice.txt'));
  });

  it('reads the job title exactly as it appears at the top of the page', () => {
    expect(P.title).toBe('Build AI Voice Assistant Mobile App MVP');
  });

  it('knows the job was posted 6 minutes ago', () => {
    expect(P.postedAgo).toBe('6 minutes ago');
  });

  it('recognises this as a fixed-price job', () => {
    expect(P.budgetType).toBe('fixed');
  });

  it('reads the budget as $150, not the $290 old contract in the history section', () => {
    expect(P.amount).toBe(150);
  });

  it('reads the proposal bucket "Less than 5" verbatim', () => {
    expect(P.proposalsRaw).toBe('Less than 5');
  });

  it('treats "Less than 5" proposals as a low end of 0, the same way "20 to 50" means 20', () => {
    // RED today: stores the bucket's UPPER bound (5) in a field that everywhere
    // else holds the LOW bound, so the least-contested job on the board looks
    // like it already has 5 proposals. Latent rather than visible: both 0 and 5
    // land in the same job-points band today, so no score moves.
    expect(P.proposalsLow).toBe(0);
  });

  it('counts nobody being interviewed and no invites sent or unanswered', () => {
    expect(P.interviewing).toBe(0);
    expect(P.invitesSent).toBe(0);
    expect(P.unansweredInvites).toBe(0);
  });

  it('knows the proposal costs 14 Connects', () => {
    expect(P.connects).toBe(14);
  });

  it('leaves the bid range blank because this page never shows one', () => {
    expect(P.bidHigh).toBe('-');
    expect(P.bidAvg).toBe('-');
    expect(P.bidLow).toBe('-');
  });

  it('sees that the client payment method is NOT verified', () => {
    expect(P.verified).toBe(false);
    expect(P.payVerified).toBe('No');
  });

  it('reads the client rating of 5.00 from 2 reviews', () => {
    expect(P.rating).toBe(5);
    expect(P.ratingPrecise).toBe('5.00');
  });

  it('reads $575 total spent', () => {
    expect(P.spent).toBe(575);
    expect(P.totalSpendRaw).toBe('$575');
  });

  it('reads the 100% hire rate', () => {
    expect(P.hireRate).toBe(100);
  });

  it('reads the single open job from the client block', () => {
    expect(P.openJobs).toBe(1);
  });

  it('does not count Ukraine as Europe, because it is not on the app Europe list', () => {
    expect(P.isEurope).toBe(false);
  });

  it('does not treat Ukraine as a banned country', () => {
    expect(P.isBanCountry).toBe(false);
  });

  it('files the client region as Other', () => {
    expect(P.region).toBe('Other');
  });

  it('sees the job is open Worldwide and is not US-only', () => {
    expect(P.worldwide).toBe(true);
    expect(P.usOnly).toBe(false);
  });

  it('captures the job link', () => {
    expect(P.jobLink).toBe('https://www.upwork.com/jobs/~022078438161943164750');
  });

  it('bans the job for exactly one reason: the fixed price is under $200', () => {
    // The history section mentions a "Flutter DeFi Calculator App"; a client's
    // past crypto work is not this job's industry and must not add a ban.
    expect(P.bans).toEqual(['Fixed-price under $200 ($150)']);
  });

  it('flags the client region for review rather than skipping the job outright', () => {
    expect(P.flags).toEqual(['Outside allowed regions (Other) — review, not auto-skip']);
  });
});

/* ==========================================================================
   FIXTURE 3 — job_browserext.txt
   "Senior Full-Stack AI Engineer ... Browser Extension", fixed $300, Pakistan client.
   The only fixture that clears the $200 floor; its country ban is correct.
   ========================================================================== */
describe('job_browserext.txt — the $300 browser extension job from a Lahore client', () => {
  let P;
  beforeAll(() => {
    const app = loadApp();
    P = app.parseJob(readFixture('job_browserext.txt'));
  });

  it('reads the job title exactly as it appears at the top of the page', () => {
    expect(P.title).toBe(
      'Senior Full-Stack AI Engineer Needed to Build AI-Powered Browser Extension'
    );
  });

  it('knows the job was posted 48 minutes ago', () => {
    expect(P.postedAgo).toBe('48 minutes ago');
  });

  it('recognises this as a fixed-price job', () => {
    expect(P.budgetType).toBe('fixed');
  });

  it('reads the budget as $300, the only fixture that clears the $200 floor', () => {
    expect(P.amount).toBe(300);
  });

  it('reads the proposal bucket "5 to 10" and takes 5 as the low end', () => {
    expect(P.proposalsRaw).toBe('5 to 10');
    expect(P.proposalsLow).toBe(5);
  });

  it('counts 3 freelancers already being interviewed', () => {
    expect(P.interviewing).toBe(3);
  });

  it('counts 11 invites sent and 6 of them unanswered', () => {
    expect(P.invitesSent).toBe(11);
    expect(P.unansweredInvites).toBe(6);
  });

  it('knows the proposal costs 13 Connects', () => {
    expect(P.connects).toBe(13);
  });

  it('leaves the bid range blank because the page hides it behind the upgrade message', () => {
    expect(P.bidHigh).toBe('-');
    expect(P.bidAvg).toBe('-');
    expect(P.bidLow).toBe('-');
  });

  it('sees that the client has a verified payment method', () => {
    expect(P.verified).toBe(true);
    expect(P.payVerified).toBe('Yes');
  });

  it('reads the client rating of 5.00 from a single review', () => {
    expect(P.rating).toBe(5);
    expect(P.ratingPrecise).toBe('5.00');
  });

  it('reads $70 total spent', () => {
    expect(P.spent).toBe(70);
    expect(P.totalSpendRaw).toBe('$70');
  });

  it('reads the 34% hire rate', () => {
    expect(P.hireRate).toBe(34);
  });

  it('reads the 2 open jobs from the client block', () => {
    expect(P.openJobs).toBe(2);
  });

  it('identifies the client as being in a banned country', () => {
    expect(P.isBanCountry).toBe(true);
    expect(P.isEurope).toBe(false);
  });

  it('files the client under the banned-country region bucket', () => {
    // 'India/Bangladesh' is the frozen label for the whole hard-ban bucket,
    // which includes Pakistan. Renaming it is a policy decision, not a fix.
    expect(P.region).toBe('India/Bangladesh');
  });

  it('sees the job is open Worldwide and is not US-only', () => {
    expect(P.worldwide).toBe(true);
    expect(P.usOnly).toBe(false);
  });

  it('captures the job link', () => {
    expect(P.jobLink).toBe('https://www.upwork.com/jobs/~022078427482786284164');
  });

  it('bans the job only for the client country, never for the budget', () => {
    // $300 clears the $200 floor, so the budget ban must not appear here.
    expect(P.bans).toEqual(['Client in India/Bangladesh/Pakistan (hard ban)']);
  });

  it('raises no review flags on this job', () => {
    expect(P.flags).toEqual([]);
  });
});
