// CLEval row-builder — proves buildCLEvalRow() emits EXACTLY the 25 columns in
// order for a known APPLY, matching the real fixture, and that the client column
// order matches the 25 target headers (parity with TABS.CLEval in Code.gs).
import { describe, it, expect, beforeAll } from 'vitest';
import { loadApp } from './loadApp.js';

let app;
beforeAll(() => { app = loadApp(); });

const TARGET_HEADERS = [
  'Assignee', 'Date', 'Time PKT', 'Job Title', 'Job Link', 'Hiring Rate',
  'Client Ratings', 'Payment Method Verified?', 'Total Spend', 'Proposals',
  'Interviewing', 'Invites sent', 'Unanswered Invites', 'Flag', 'Applied?',
  'Fixed/ Hourly', 'High Bid', 'Avg. Bid', 'Low bid', 'No. of Connects', 'Bid',
  'Reason/Remarks', 'Job posted', 'Open jobs', 'Ptoposal Status',
];

// Real fixture: 25 cells, positions 1:1 with the header list.
const FIXTURE_INPUT = {
  assignee: 'Usman Saeed', date: '7/15/2026', timePkt: '13:37',
  jobTitle: 'Full Stack Engineer — TypeScript / AWS / AI Agents', jobLink: 'URL',
  hiringRate: '100', clientRatings: '5', payVerified: 'Yes',
  totalSpend: '17k', proposals: '50+', interviewing: '0', invitesSent: '0', unansweredInvites: '0',
  flag: 'Green', applied: 'Yes', fixedHourly: 'Hourly',
  highBid: '150', avgBid: '48.19', lowBid: '10', connects: '27', bid: '70',
  reason: 'Applied', jobPosted: 'Yesterday', openJobs: '1', proposalStatus: 'Un Opened',
};
const FIXTURE_ROW = [
  'Usman Saeed', '7/15/2026', '13:37',
  'Full Stack Engineer — TypeScript / AWS / AI Agents', 'URL', '100', '5', 'Yes',
  '17k', '50+', '0', '0', '0', 'Green', 'Yes', 'Hourly',
  '150', '48.19', '10', '27', '70', 'Applied', 'Yesterday', '1', 'Un Opened',
];

describe('CLEval buildCLEvalRow()', () => {
  it('client column order matches the 25 target headers exactly', () => {
    const headers = app.window.CLEVAL_COLUMNS.map((c) => c[0]);
    expect(headers).toEqual(TARGET_HEADERS);
    expect(headers).toHaveLength(25);
  });

  it('emits EXACTLY the 25-cell fixture row, in order, for a known APPLY', () => {
    const row = app.window.buildCLEvalRow(FIXTURE_INPUT);
    expect(row).toHaveLength(25);
    expect(row).toEqual(FIXTURE_ROW);
  });

  it('defaults "Ptoposal Status" to "Un Opened" when omitted; blanks unknown cells', () => {
    const row = app.window.buildCLEvalRow({ jobTitle: 'X' });
    expect(row).toHaveLength(25);
    expect(row[3]).toBe('X');          // Job Title
    expect(row[24]).toBe('Un Opened'); // Ptoposal Status default
    expect(row[8]).toBe('');           // Total Spend blank
  });
});

describe('CLEval clevalRowFrom() decision mapping', () => {
  it('APPLY -> Flag Green, Applied Yes, real connects + bid', () => {
    const row = app.window.clevalRowFrom(
      { banned: false, decision: 'APPLY WITH BOOST' },
      { jobTitle: 'Job', jobLink: 'https://www.upwork.com/jobs/~abc', fixedHourly: 'Hourly', connects: '6', bid: '$45/hr' },
    );
    expect(row.flag).toBe('Green');
    expect(row.applied).toBe('Yes');
    expect(row.connects).toBe('6');
    expect(row.bid).toBe('$45/hr');
    // server-owned fields left blank for the server to fill:
    expect(row.assignee).toBe(''); expect(row.date).toBe(''); expect(row.timePkt).toBe('');
    expect(row.proposalStatus).toBe('Un Opened');
  });

  it('SKIP -> Flag Red, Applied No, connects blank, Bid "-"', () => {
    const row = app.window.clevalRowFrom(
      { banned: true, decision: 'SKIP — HARD BAN', bans: ['Banned industry (finance/crypto/trading)'] },
      { jobTitle: 'Job' },
    );
    expect(row.flag).toBe('Red');
    expect(row.applied).toBe('No');
    expect(row.connects).toBe('');
    expect(row.bid).toBe('-');
    expect(row.reason).toContain('Banned industry');
  });
});

describe('CLEval postCLEval() is staging-safe (never writes to the live backend)', () => {
  const R = { jobTitle: 'X', proposalStatus: 'Un Opened' };

  it('unset endpoint -> no network write at all', () => {
    app.window.CLEVAL_BACKEND = '';
    const before = app.fetchCalls.length;
    app.window.postCLEval(R, 'ev_test');
    expect(app.fetchCalls.length).toBe(before); // no-op
  });

  it('REFUSES to write when CLEVAL_BACKEND equals the live SEAT_BACKEND', () => {
    app.window.CLEVAL_BACKEND = app.window.SEAT_BACKEND; // misconfiguration
    const before = app.fetchCalls.length;
    app.window.postCLEval(R, 'ev_test');
    expect(app.fetchCalls.length).toBe(before); // hard-refused, no write to live
  });

  it('writes only to a DISTINCT staging endpoint', () => {
    const STAGING = 'https://script.google.com/macros/s/STAGING_CLONE/exec';
    app.window.CLEVAL_BACKEND = STAGING;
    const before = app.fetchCalls.length;
    app.window.postCLEval(R, 'ev_test');
    expect(app.fetchCalls.length).toBe(before + 1);
    expect(String(app.fetchCalls[app.fetchCalls.length - 1])).toBe(STAGING);
    app.window.CLEVAL_BACKEND = ''; // restore no-op default for other tests
  });
});
