// ============================================================================
// duplicate.detect.test.js — CONTRACT tests for findDuplicateJob().
//
// WHY THIS EXISTS: twenty people share ONE Upwork profile. If Fiza already sent
// a proposal on a job this morning and Hamza pastes the same job this afternoon,
// the profile bids twice on one post. That burns Connects, looks careless to the
// client, and is invisible today because nobody can see the other 19 people's
// rows. findDuplicateJob() is the warning that stops it.
//
// STATUS: window.findDuplicateJob does not exist yet, so EVERY test in this file
// is red on purpose. This file is the specification, not a bug report. A red line
// here is the proof the guard is still missing. Do not weaken an assertion to get
// green, and do not skip a test to quiet the run.
//
// THE CONTRACT under test — a global on window:
//
//   findDuplicateJob(linkOrId, rows) -> null
//                                    |  { assignee, date, time, applied:boolean }
//
//   rows are CLEval rows: 25 cells, in TABS.CLEval order (read live from Code.gs
//   below, so a column re-order fails loudly instead of silently mis-reading).
//   The match is on the ~NNNNNNNNNNNN Upwork job id INSIDE the URL, never on the
//   whole URL string, so www / query strings / trailing slashes / http still
//   match. The row returned is the MOST RECENT earlier row with that id, by the
//   row's own Date + Time PKT, not by its position in the array.
//   `applied` is true only when that row's "Applied?" cell says Yes, so the UI
//   can shout for a real application and merely murmur for a job that was
//   evaluated and skipped.
//
// POLICY IS FROZEN: this suite tests mechanics only. It asserts nothing about
// scoring, bans, rates or Connect counts.
// ============================================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadApp } from './loadApp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_GS = join(__dirname, '..', 'Code.gs');

// ---------------------------------------------------------------------------
// The 25 column order comes from the REAL backend, not from a copy in this file.
// ---------------------------------------------------------------------------
function clevalHeadersFromCodeGs() {
  const src = readFileSync(CODE_GS, 'utf8');
  const m = src.match(/CLEval:\s*(\[[\s\S]*?\]),/);
  if (!m) throw new Error('could not read TABS.CLEval out of Code.gs');
  return JSON.parse(m[1]);
}
const HEADERS = clevalHeadersFromCodeGs();
const C = {
  assignee: HEADERS.indexOf('Assignee'),
  date: HEADERS.indexOf('Date'),
  time: HEADERS.indexOf('Time PKT'),
  title: HEADERS.indexOf('Job Title'),
  link: HEADERS.indexOf('Job Link'),
  applied: HEADERS.indexOf('Applied?'),
  reason: HEADERS.indexOf('Reason/Remarks'),
  status: HEADERS.indexOf('Ptoposal Status'),
};

// Build one CLEval row in the live 25 column shape.
function row({ assignee = '', date = '', time = '', title = '', link = '', applied = '', reason = '', status = 'Not checked' } = {}) {
  const r = new Array(HEADERS.length).fill('');
  r[C.assignee] = assignee;
  r[C.date] = date;
  r[C.time] = time;
  r[C.title] = title;
  r[C.link] = link;
  r[C.applied] = applied;
  r[C.reason] = reason;
  r[C.status] = status;
  return r;
}

// ---------------------------------------------------------------------------
// Job ids. ID_A and ID_B differ only in the LAST digit (20 shared characters).
// ID_A_PREFIX is a strict 15 character prefix of ID_A, which is what catches a
// lazy indexOf()/startsWith() implementation.
// ---------------------------------------------------------------------------
const ID_A = '021944556677889900112';
const ID_B = '021944556677889900113';
const ID_A_PREFIX = '021944556677889';
const ID_C = '021700011122233344455';

const CANONICAL_A = 'https://www.upwork.com/jobs/~' + ID_A;
const CANONICAL_B = 'https://www.upwork.com/jobs/~' + ID_B;

// ---------------------------------------------------------------------------
// Existence probe + safe caller. If the function is missing we must NOT blow up
// every it() with an identical TypeError; we return a sentinel whose shape names
// the gap, so a failure reads
//     expected { __missing: 'findDuplicateJob-not-implemented' } to be null
// which points at the real defect instead of at jsdom.
// ---------------------------------------------------------------------------
const MISSING = 'findDuplicateJob-not-implemented';
let app;
let dup;

beforeAll(() => {
  app = loadApp();
  const fn = app.window.findDuplicateJob;
  dup = (link, rows) => {
    if (typeof fn !== 'function') return { __missing: MISSING };
    return fn(link, rows);
  };
});

describe('findDuplicateJob: it exists at all', () => {
  it('the app exposes findDuplicateJob(link, rows) as a function', () => {
    expect(typeof app.window.findDuplicateJob).toBe('function');
  });
});

// ===========================================================================
// 1. Same job, differently written URL — must still be caught.
// ===========================================================================
describe('the same job counts as the same job however the URL was pasted', () => {
  const seen = [row({
    assignee: 'Fiza', date: '7/14/2026', time: '15:20',
    title: 'Senior React Engineer', link: CANONICAL_A, applied: 'Yes',
  })];

  const variants = [
    ['the exact same URL', CANONICAL_A],
    ['the URL without www', 'https://upwork.com/jobs/~' + ID_A],
    ['the URL with a tracking query string', CANONICAL_A + '?ref=abc'],
    ['the URL with a trailing slash', CANONICAL_A + '/'],
    ['the URL with a trailing slash and a query string', CANONICAL_A + '/?ref=abc&utm_source=slack'],
    ['the URL on plain http instead of https', 'http://www.upwork.com/jobs/~' + ID_A],
    ['the URL typed in capitals', 'HTTPS://WWW.UPWORK.COM/JOBS/~' + ID_A],
    ['the long apply URL Upwork gives after clicking the job', 'https://www.upwork.com/freelance-jobs/apply/Senior-React-Engineer_~' + ID_A + '/'],
    ['just the ~id on its own', '~' + ID_A],
    ['just the bare digits of the id', ID_A],
  ];

  variants.forEach(([label, link]) => {
    it('finds the earlier row when the new job is pasted as ' + label, () => {
      const hit = dup(link, seen);
      expect(hit).not.toBeNull();
      expect(hit && hit.assignee).toBe('Fiza');
    });
  });

  it('finds the earlier row even when the stored row itself has the messy URL', () => {
    const messy = [row({
      assignee: 'Hamza', date: '7/14/2026', time: '09:00',
      link: 'http://upwork.com/jobs/~' + ID_A + '/?ref=xyz', applied: 'No',
    })];
    const hit = dup(CANONICAL_A, messy);
    expect(hit).not.toBeNull();
    expect(hit && hit.assignee).toBe('Hamza');
  });
});

// ===========================================================================
// 2. Different jobs must NOT be reported as duplicates.
//    A false duplicate is worse than none: it tells someone not to bid on a job
//    that is free.
// ===========================================================================
describe('a different job is never reported as a duplicate', () => {
  it('a job nobody has touched returns null', () => {
    const rows = [row({ assignee: 'Sadia', date: '7/12/2026', time: '11:00', link: CANONICAL_B, applied: 'Yes' })];
    expect(dup(CANONICAL_A, rows)).toBeNull();
  });

  it('two ids that differ only in the final digit are different jobs', () => {
    const rows = [row({ assignee: 'Sana', date: '7/13/2026', time: '10:00', link: CANONICAL_B, applied: 'Yes' })];
    // ID_A and ID_B share their first 20 characters.
    expect(ID_A.slice(0, 20)).toBe(ID_B.slice(0, 20));
    expect(dup(CANONICAL_A, rows)).toBeNull();
  });

  it('a shorter id that is a prefix of a stored id is not a match', () => {
    // Catches an implementation that does storedLink.indexOf(searchId) !== -1.
    expect(ID_A.startsWith(ID_A_PREFIX)).toBe(true);
    const rows = [row({ assignee: 'Subhan', date: '7/13/2026', time: '10:00', link: CANONICAL_A, applied: 'Yes' })];
    expect(dup('https://www.upwork.com/jobs/~' + ID_A_PREFIX, rows)).toBeNull();
  });

  it('a longer id that merely starts with a stored id is not a match', () => {
    const rows = [row({ assignee: 'Subhan', date: '7/13/2026', time: '10:00', link: 'https://www.upwork.com/jobs/~' + ID_A_PREFIX, applied: 'Yes' })];
    expect(dup(CANONICAL_A, rows)).toBeNull();
  });

  it('an empty rows list returns null', () => {
    expect(dup(CANONICAL_A, [])).toBeNull();
  });
});

// ===========================================================================
// 3. Rows with no usable link must be skipped, not treated as wildcards.
//    buildCLEvalRow() writes the literal word "URL" into the Job Link cell (the
//    real address is attached server side as a rich text link), and rows with no
//    link at all default to "-". Neither carries an id.
// ===========================================================================
describe('rows with no job link are skipped, not matched', () => {
  it('a row with an empty Job Link cell does not match', () => {
    const rows = [row({ assignee: 'Kaleem', date: '7/14/2026', time: '12:00', link: '', applied: 'Yes' })];
    expect(dup(CANONICAL_A, rows)).toBeNull();
  });

  it('a row whose Job Link is the default dash does not match', () => {
    const rows = [row({ assignee: 'Kaleem', date: '7/14/2026', time: '12:00', link: '-', applied: 'Yes' })];
    expect(dup(CANONICAL_A, rows)).toBeNull();
  });

  it('a row whose Job Link is the literal word URL does not match', () => {
    const rows = [row({ assignee: 'Kaleem', date: '7/14/2026', time: '12:00', link: 'URL', applied: 'Yes' })];
    expect(dup(CANONICAL_A, rows)).toBeNull();
  });

  it('a linkless row sitting next to a real match does not hide the real match', () => {
    const rows = [
      row({ assignee: 'Kaleem', date: '7/15/2026', time: '12:00', link: '-', applied: 'Yes' }),
      row({ assignee: 'Fiza', date: '7/14/2026', time: '15:20', link: CANONICAL_A, applied: 'Yes' }),
    ];
    const hit = dup(CANONICAL_A, rows);
    expect(hit).not.toBeNull();
    expect(hit && hit.assignee).toBe('Fiza');
  });
});

// ===========================================================================
// 4. When several people touched the same job, name the MOST RECENT one.
//    Telling Hamza that "Usman looked at this on 2 July" when Fiza actually
//    applied yesterday is the same as telling him nothing.
// ===========================================================================
describe('when several rows share the job, the most recent one is returned', () => {
  it('picks the latest date, not the first row in the sheet', () => {
    // Deliberately out of order: newest is in the MIDDLE, so first-wins and
    // last-wins implementations both fail here.
    const rows = [
      row({ assignee: 'Usman Saeed', date: '7/10/2026', time: '09:00', link: CANONICAL_A, applied: 'No' }),
      row({ assignee: 'Fiza', date: '7/20/2026', time: '15:30', link: CANONICAL_A, applied: 'Yes' }),
      row({ assignee: 'Sadia', date: '7/14/2026', time: '11:00', link: CANONICAL_A, applied: 'No' }),
    ];
    const hit = dup(CANONICAL_A, rows);
    expect(hit && hit.assignee).toBe('Fiza');
    expect(hit && hit.date).toBe('7/20/2026');
  });

  it('compares dates as dates, so 10 July is newer than 9 July', () => {
    // A string sort puts '7/9/2026' after '7/10/2026' and gets this backwards.
    const rows = [
      row({ assignee: 'Sana', date: '7/9/2026', time: '08:00', link: CANONICAL_A, applied: 'No' }),
      row({ assignee: 'Ayesha', date: '7/10/2026', time: '08:00', link: CANONICAL_A, applied: 'No' }),
    ];
    expect(dup(CANONICAL_A, rows).assignee).toBe('Ayesha');
  });

  it('on the same day, the later clock time wins', () => {
    // A string sort puts '9:05' after '14:20' and gets this backwards too.
    const rows = [
      row({ assignee: 'Sana', date: '7/14/2026', time: '14:20', link: CANONICAL_A, applied: 'No' }),
      row({ assignee: 'Ayesha', date: '7/14/2026', time: '9:05', link: CANONICAL_A, applied: 'No' }),
    ];
    expect(dup(CANONICAL_A, rows).assignee).toBe('Sana');
  });

  it('rows for other jobs in between do not disturb the pick', () => {
    const rows = [
      row({ assignee: 'Usman Saeed', date: '7/10/2026', time: '09:00', link: CANONICAL_A, applied: 'No' }),
      row({ assignee: 'Noise One', date: '7/28/2026', time: '23:59', link: CANONICAL_B, applied: 'Yes' }),
      row({ assignee: 'Fiza', date: '7/20/2026', time: '15:30', link: CANONICAL_A, applied: 'Yes' }),
      row({ assignee: 'Noise Two', date: '7/29/2026', time: '23:59', link: 'https://www.upwork.com/jobs/~' + ID_C, applied: 'Yes' }),
    ];
    expect(dup(CANONICAL_A, rows).assignee).toBe('Fiza');
  });

  it('a real application outranks nothing: the newest row wins even if it only skipped the job', () => {
    // The newest row is the truth about the job's current state. An older Yes
    // must not be promoted over a newer No, or the warning starts lying.
    const rows = [
      row({ assignee: 'Fiza', date: '7/10/2026', time: '09:00', link: CANONICAL_A, applied: 'Yes' }),
      row({ assignee: 'Hamza', date: '7/22/2026', time: '09:00', link: CANONICAL_A, applied: 'No' }),
    ];
    const hit = dup(CANONICAL_A, rows);
    expect(hit && hit.assignee).toBe('Hamza');
    expect(hit && hit.applied).toBe(false);
  });
});

// ===========================================================================
// 5. The returned fields are the ones the warning sentence is built from:
//    "already applied by Fiza on 14 July at 3:20pm".
// ===========================================================================
describe('the returned row identifies who, when, and whether they actually applied', () => {
  const rows = [row({
    assignee: 'Fiza', date: '7/14/2026', time: '15:20',
    title: 'Senior React Engineer for Internal Dashboard',
    link: CANONICAL_A, applied: 'Yes',
  })];

  it('returns the assignee from the matched row, verbatim', () => {
    expect(dup(CANONICAL_A, rows).assignee).toBe('Fiza');
  });

  it('returns the date from the matched row, verbatim, not reformatted', () => {
    expect(dup(CANONICAL_A, rows).date).toBe('7/14/2026');
  });

  it('returns the PKT time from the matched row, verbatim, not reformatted', () => {
    expect(dup(CANONICAL_A, rows).time).toBe('15:20');
  });

  it('returns exactly the four fields the warning needs', () => {
    expect(Object.keys(dup(CANONICAL_A, rows)).sort()).toEqual(['applied', 'assignee', 'date', 'time']);
  });
});

describe('applied tells a real application apart from a job that was only looked at', () => {
  const at = (applied) => [row({ assignee: 'Fiza', date: '7/14/2026', time: '15:20', link: CANONICAL_A, applied })];

  it('Applied? = Yes means a proposal really went out', () => {
    expect(dup(CANONICAL_A, at('Yes')).applied).toBe(true);
  });

  it('Applied? = No means the job was evaluated and skipped, so applied is false', () => {
    expect(dup(CANONICAL_A, at('No')).applied).toBe(false);
  });

  it('an empty Applied? cell is not an application', () => {
    expect(dup(CANONICAL_A, at('')).applied).toBe(false);
  });

  it('the default dash in Applied? is not an application', () => {
    expect(dup(CANONICAL_A, at('-')).applied).toBe(false);
  });

  it('a hand-typed lowercase yes still counts as an application', () => {
    // 664 live rows were typed by hand; casing is not a promise.
    expect(dup(CANONICAL_A, at('yes')).applied).toBe(true);
  });

  it('applied is a real boolean, not the string from the cell', () => {
    expect(typeof dup(CANONICAL_A, at('Yes')).applied).toBe('boolean');
  });

  it('a skipped earlier row is still reported, it just is not an application', () => {
    const hit = dup(CANONICAL_A, at('No'));
    expect(hit).not.toBeNull();
    expect(hit.assignee).toBe('Fiza');
  });
});

// ===========================================================================
// 6. Rubbish in must not throw. This runs on every paste; an exception here
//    kills the evaluation the operator is waiting on.
// ===========================================================================
describe('bad input returns null instead of throwing', () => {
  const rows = [row({ assignee: 'Fiza', date: '7/14/2026', time: '15:20', link: CANONICAL_A, applied: 'Yes' })];

  it('a null link returns null', () => {
    expect(() => dup(null, rows)).not.toThrow();
    expect(dup(null, rows)).toBeNull();
  });

  it('an undefined link returns null', () => {
    expect(dup(undefined, rows)).toBeNull();
  });

  it('an empty string link returns null', () => {
    expect(dup('', rows)).toBeNull();
  });

  it('a link that is not a URL at all returns null', () => {
    expect(dup('not a url', rows)).toBeNull();
  });

  it('an Upwork URL carrying no job id returns null', () => {
    expect(dup('https://www.upwork.com/jobs/', rows)).toBeNull();
  });

  it('a tilde followed by too few digits is not an id', () => {
    expect(dup('https://www.upwork.com/jobs/~12345', rows)).toBeNull();
  });

  it('a missing rows argument returns null instead of throwing', () => {
    expect(() => dup(CANONICAL_A, undefined)).not.toThrow();
    expect(dup(CANONICAL_A, undefined)).toBeNull();
  });

  it('a null rows argument returns null instead of throwing', () => {
    expect(dup(CANONICAL_A, null)).toBeNull();
  });

  it('a short or ragged row in the data does not throw', () => {
    const ragged = [[], ['Fiza'], null, undefined, row({ assignee: 'Fiza', date: '7/14/2026', time: '15:20', link: CANONICAL_A, applied: 'Yes' })];
    expect(() => dup(CANONICAL_A, ragged)).not.toThrow();
    expect(dup(CANONICAL_A, ragged).assignee).toBe('Fiza');
  });

  it('a matched row with a missing date or time still returns without throwing', () => {
    const rows2 = [row({ assignee: 'Fiza', date: '', time: '', link: CANONICAL_A, applied: 'Yes' })];
    expect(() => dup(CANONICAL_A, rows2)).not.toThrow();
    expect(dup(CANONICAL_A, rows2).assignee).toBe('Fiza');
  });
});

// ===========================================================================
// 7. Column order is read from Code.gs, so this file cannot drift from the
//    sheet the app actually writes.
// ===========================================================================
describe('the fixtures in this file match the live CLEval sheet shape', () => {
  it('reads 25 columns straight out of TABS.CLEval in Code.gs', () => {
    expect(HEADERS).toHaveLength(25);
  });

  it('every column this suite depends on exists in the live header list', () => {
    Object.entries(C).forEach(([field, idx]) => {
      expect(idx, 'column for ' + field + ' missing from TABS.CLEval').toBeGreaterThan(-1);
    });
  });

  it('the live typo "Ptoposal Status" is still column 25 and is left alone', () => {
    expect(HEADERS[24]).toBe('Ptoposal Status');
  });
});

// ===========================================================================
// 8. END TO END — the warning has to reach the operator's screen.
//
// RED FOR A SECOND REASON: this test needs BOTH findDuplicateJob() and the
// evaluate-path UI that renders its result. Neither exists yet. When
// findDuplicateJob lands but the card still says nothing, this is the test that
// stays red, and that is correct: a duplicate check nobody can see prevents
// nothing.
//
// The seeding step below is deliberately tolerant about HOW the loaded CLEval
// rows get into the app (a setter if one exists, otherwise a global), because
// that plumbing is the implementer's choice. The assertion is not tolerant.
// ===========================================================================
function seedLoadedCLEvalRows(w, rows) {
  if (typeof w.setCLEvalRows === 'function') { w.setCLEvalRows(rows); return 'setCLEvalRows()'; }
  if (typeof w.loadCLEvalRows === 'function') { w.loadCLEvalRows(rows); return 'loadCLEvalRows()'; }
  w.CLEVAL_ROWS = rows;
  w.clevalRows = rows;
  w.__CLEVAL_ROWS__ = rows;
  return 'window.CLEVAL_ROWS';
}

function upworkPage(link) {
  return [
    'Skip to content', 'Upwork home', 'Find work', '', 'Account Settings',
    'Senior React Engineer for Internal Dashboard',
    'Posted 12 minutes ago',
    'Worldwide',
    '',
    'Summary',
    'We need a senior React engineer to build an internal dashboard.',
    '',
    '$95.00\n/hr\nHourly',
    'Intermediate',
    'Skills and Expertise', 'React', 'Node.js',
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
    'Job link', link,
    'Footer navigation', 'About Us', 'Terms of Service',
  ].join('\n');
}

describe('END TO END: pasting a job somebody already applied to warns the operator', () => {
  let e2e;
  let html;

  beforeAll(() => {
    e2e = loadApp();
    seedLoadedCLEvalRows(e2e.window, [
      row({
        assignee: 'Fiza', date: '7/14/2026', time: '15:20',
        title: 'Senior React Engineer for Internal Dashboard',
        link: CANONICAL_A, applied: 'Yes', reason: 'Applied',
      }),
      row({
        assignee: 'Usman Saeed', date: '7/02/2026', time: '10:00',
        title: 'Some other job', link: CANONICAL_B, applied: 'No', reason: 'SKIP',
      }),
    ]);
    // Same job, pasted with a query string and no www — the exact way a second
    // person's copy of the link differs from the first person's.
    e2e.doc.getElementById('job-text').value = upworkPage('https://upwork.com/jobs/~' + ID_A + '?ref=slack');
    e2e.window.runEval();
    html = e2e.doc.getElementById('eval-out').innerHTML;
  });

  it('the evaluation card still renders (the duplicate check must not break scoring)', () => {
    expect(html).toMatch(/deterministic/i);
  });

  it('the parser pulled the job id out of the pasted page', () => {
    expect(e2e.window.parseJob(upworkPage('https://upwork.com/jobs/~' + ID_A + '?ref=slack')).jobLink).toContain(ID_A);
  });

  it('the rendered output warns that this job is already taken', () => {
    expect(html).toMatch(/already applied|already evaluated|duplicate/i);
  });

  it('the warning names the person who got there first', () => {
    expect(html).toContain('Fiza');
  });

  it('the warning carries the date it happened', () => {
    expect(html).toContain('7/14/2026');
  });

  // GREEN TODAY FOR THE WRONG REASON: a warning that does not exist cannot fire
  // falsely. This is a false-positive guard that only starts earning its keep
  // once the warning ships. Do not read its green as "half of this already works".
  it('a job nobody has touched produces no warning', () => {
    const clean = loadApp();
    seedLoadedCLEvalRows(clean.window, [
      row({ assignee: 'Fiza', date: '7/14/2026', time: '15:20', link: CANONICAL_A, applied: 'Yes' }),
    ]);
    clean.doc.getElementById('job-text').value = upworkPage('https://www.upwork.com/jobs/~' + ID_C);
    clean.window.runEval();
    const cleanHtml = clean.doc.getElementById('eval-out').innerHTML;
    expect(cleanHtml).toMatch(/deterministic/i);            // the card did render
    expect(cleanHtml).not.toMatch(/already applied|duplicate/i);
    expect(cleanHtml).not.toContain('Fiza');
  });
});

// ===========================================================================
// 9. Safety: this suite touches no network and writes to no sheet.
// ===========================================================================
describe('safety: duplicate detection is a pure local read', () => {
  it('the only fetch the harness ever saw is the blocked seat-boot call', () => {
    expect(app.fetchCalls.length).toBeGreaterThan(0); // otherwise this is vacuous
    app.fetchCalls.forEach((u) => {
      expect(String(u)).toMatch(/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/);
    });
  });

  it('running the duplicate check many times issues no fetch of any kind', () => {
    const rows = [row({ assignee: 'Fiza', date: '7/14/2026', time: '15:20', link: CANONICAL_A, applied: 'Yes' })];
    const before = app.fetchCalls.length;
    dup(CANONICAL_A, rows);
    dup(CANONICAL_B, rows);
    dup(null, rows);
    dup('~' + ID_A, rows);
    expect(app.fetchCalls.length).toBe(before);
  });

  it('the check does not mutate the rows it was handed', () => {
    const rows = [row({ assignee: 'Fiza', date: '7/14/2026', time: '15:20', link: CANONICAL_A, applied: 'Yes' })];
    const snapshot = JSON.stringify(rows);
    dup(CANONICAL_A, rows);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});
