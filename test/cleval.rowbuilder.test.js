// CLEval row-builder — proves buildCLEvalRow() emits EXACTLY the 25 columns in
// order for a known APPLY, matching the real fixture, and that the client column
// order matches the 25 target headers (parity with TABS.CLEval in Code.gs).
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadApp } from './loadApp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dirname, 'fixtures', name), 'utf8');

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
    expect(row.connects).toBe('0');   // count default (no connects in ctx)
    expect(row.bid).toBe('-');
    expect(row.reason).toContain('Banned industry');
  });
});

describe('CLEval full Upwork-page parse -> exact row (3 REAL fixtures, Usman format)', () => {
  const rowObjFor = (file) => {
    app.doc.getElementById('job-text').value = fixture(file);
    app.doc.getElementById('cl-job-link').value = '';
    const d = app.window.evalDecision();
    const ctx = app.window.evalCtx();
    return app.window.clevalRowFrom(d, ctx);
  };
  const cols3to24 = (cells) => cells.slice(3, 25);

  it('job_n8n.txt ~022078430146547204560', () => {
    const row = rowObjFor('job_n8n.txt');
    // the row OBJECT carries the real URL (server attaches it to the "URL" text)
    expect(row.jobLink).toBe('https://www.upwork.com/jobs/~022078430146547204560');
    expect(cols3to24(app.window.buildCLEvalRow(row))).toEqual([
      'n8n AI Automation Expert', 'URL', '50', '4.99', 'Yes', '26k', '20 to 50',
      '0', '1', '1', 'Red', 'No', 'Fixed', '-', '-', '-', '11', '-',
      'Fixed-price under $200 ($50)', '38 minutes ago', '87', 'Un Opened',
    ]);
  });

  it('job_voice.txt ~022078438161943164750', () => {
    const row = rowObjFor('job_voice.txt');
    expect(row.jobLink).toBe('https://www.upwork.com/jobs/~022078438161943164750');
    expect(cols3to24(app.window.buildCLEvalRow(row))).toEqual([
      'Build AI Voice Assistant Mobile App MVP', 'URL', '150', '5', 'No', '575', 'Less than 5',
      '0', '0', '0', 'Red', 'No', 'Fixed', '-', '-', '-', '14', '-',
      'Fixed-price under $200 ($150)', '6 minutes ago', '1', 'Un Opened',
    ]);
  });

  it('job_browserext.txt ~022078427482786284164', () => {
    const row = rowObjFor('job_browserext.txt');
    expect(row.jobLink).toBe('https://www.upwork.com/jobs/~022078427482786284164');
    expect(cols3to24(app.window.buildCLEvalRow(row))).toEqual([
      'Senior Full-Stack AI Engineer Needed to Build AI-Powered Browser Extension', 'URL',
      '300', '5', 'Yes', '70', '5 to 10', '3', '11', '6', 'Red', 'No', 'Fixed',
      '-', '-', '-', '13', '-', 'Client in India/Bangladesh/Pakistan (hard ban)',
      '48 minutes ago', '2', 'Un Opened',
    ]);
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
