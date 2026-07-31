// listSessions() and sessionTotals(): the timesheet behind the Sessions sheet.
//
// The Sessions tab has been written since v11 and nothing has ever read a row of
// it back. The owner's question is simple and, today, unanswerable: who signed in
// when, when did they sign out, and how long were they actually on the shared
// profile. These two pure functions are what turns eight hundred raw rows into an
// answer, so every assertion below is written from the point of view of somebody
// reading a timesheet, not from the point of view of the code.
//
// Three things make a session row awkward and all three are exercised here:
//   1. a row can still be open (Status ACTIVE, no Logout Time, no Duration),
//   2. a row can have died rather than ended (Status TIMED OUT, written by the
//      stale-holder auto-release) and that must stay distinguishable from a
//      clean sign-out,
//   3. a row can carry a blank Duration, because closeSession_'s fallback append
//      writes durationMin||"" when it cannot find the ACTIVE row to close.
//
// The column order is read from TABS.Sessions in Code.gs, never copied into this
// file, so re-ordering or renaming a column fails here loudly instead of quietly
// mis-reading a person's hours.
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadApp } from './loadApp.js';

// The live script runs in Asia/Karachi and the Sessions sheet's Login Time is a
// PKT moment. Pinning the process to the same zone is what makes the "no day
// shift" tests below mean something: an ISO picker value parsed as UTC midnight
// against a local-midnight cell drops every row dated exactly on the boundary,
// and at a positive UTC offset that bug is invisible on a US laptop. Vitest gives
// each test file its own process, so this does not leak into the other suites.
process.env.TZ = 'Asia/Karachi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_GS = readFileSync(join(__dirname, '..', 'Code.gs'), 'utf8');

/* ---- the real 10 columns, straight out of Code.gs ---- */
const HEADERS = (function () {
  const m = /Sessions:\s*(\[[\s\S]*?\])\s*,\s*\n/.exec(CODE_GS);
  if (!m) throw new Error('TABS.Sessions could not be found in Code.gs');
  return JSON.parse(m[1]);
})();
const IDX = (function () {
  const o = {};
  HEADERS.forEach((h, i) => { o[h] = i; });
  return o;
})();

// Build a session row by COLUMN NAME. If a column is renamed or removed in
// Code.gs this throws with the offending name instead of silently writing the
// value into the wrong cell.
function row(o) {
  const r = new Array(HEADERS.length).fill('');
  Object.keys(o).forEach((k) => {
    if (IDX[k] === undefined) throw new Error('Code.gs TABS.Sessions has no column named "' + k + '"');
    r[IDX[k]] = o[k];
  });
  return r;
}

let w;
let ROWS;
let SHEET_FORMAT_ROWS;

const ids = (rs) => rs.map((r) => r[IDX['Session ID']]);
const totalFor = (list, person) => list.filter((t) => t.person === person)[0];

beforeAll(() => {
  w = loadApp().window;

  /* Four people, three days, five clean sign-outs, two seats that timed out and
     one person still signed in right now. Login Time / Logout Time arrive as the
     ISO timestamps Apps Script produces when it JSON-encodes a sheet Date. */
  ROWS = [
    row({
      'Session ID': 'FIZA-0729', 'User': 'Fiza',
      'Login Time': '2026-07-29T16:00:00.000Z', 'Logout Time': '2026-07-29T18:30:00.000Z',
      'Duration (min)': 150, 'Duration (h:m)': '2h 30m',
      'JDs': 6, 'Proposals': 3, 'Copies': 4, 'Status': 'CLOSED',
    }),
    row({
      'Session ID': 'USMAN-0729', 'User': 'Usman Saeed',
      'Login Time': '2026-07-29T07:15:00.000Z', 'Logout Time': '2026-07-29T08:15:00.000Z',
      'Duration (min)': 60, 'Duration (h:m)': '1h 0m',
      'JDs': 4, 'Proposals': 2, 'Copies': 2, 'Status': 'CLOSED',
    }),
    row({
      'Session ID': 'SADIA-0730', 'User': 'Sadia',
      'Login Time': '2026-07-30T06:30:00.000Z', 'Logout Time': '2026-07-30T08:00:00.000Z',
      'Duration (min)': 90, 'Duration (h:m)': '1h 30m',
      'JDs': 5, 'Proposals': 2, 'Copies': 3, 'Status': 'CLOSED',
    }),
    row({
      // Tab crashed mid-bid; the stale-holder auto-release closed the seat.
      'Session ID': 'FIZA-0730', 'User': 'Fiza',
      'Login Time': '2026-07-30T07:00:00.000Z', 'Logout Time': '2026-07-30T08:15:00.000Z',
      'Duration (min)': 75, 'Duration (h:m)': '1h 15m',
      'JDs': 3, 'Proposals': 1, 'Copies': 1, 'Status': 'TIMED OUT',
    }),
    row({
      'Session ID': 'FIZA-0731', 'User': 'Fiza',
      'Login Time': '2026-07-31T06:05:00.000Z', 'Logout Time': '2026-07-31T06:25:00.000Z',
      'Duration (min)': 20, 'Duration (h:m)': '0h 20m',
      'JDs': 1, 'Proposals': 0, 'Copies': 0, 'Status': 'CLOSED',
    }),
    row({
      'Session ID': 'SADIA-0731', 'User': 'Sadia',
      'Login Time': '2026-07-31T09:10:00.000Z', 'Logout Time': '2026-07-31T09:40:00.000Z',
      'Duration (min)': 30, 'Duration (h:m)': '0h 30m',
      'JDs': 2, 'Proposals': 1, 'Copies': 1, 'Status': 'TIMED OUT',
    }),
    row({
      // Signed in at 22:00 PKT and signed out after midnight, and the Duration
      // cell is blank: exactly the shape closeSession_'s fallback append writes.
      'Session ID': 'USMAN-0731', 'User': 'Usman Saeed',
      'Login Time': '2026-07-31T17:00:00.000Z', 'Logout Time': '2026-08-01T06:00:00.000Z',
      'Duration (min)': '', 'Duration (h:m)': '',
      'JDs': 2, 'Proposals': 1, 'Copies': 0, 'Status': 'CLOSED',
    }),
    row({
      // Still signed in as this is read: no Logout Time, no Duration yet.
      'Session ID': 'KALEEM-0731', 'User': 'Kaleem',
      'Login Time': '2026-07-31T08:00:00.000Z', 'Logout Time': '',
      'Duration (min)': '', 'Duration (h:m)': '',
      'JDs': 1, 'Proposals': 0, 'Copies': 0, 'Status': 'ACTIVE',
    }),
  ];

  /* The same two sessions as the sheet displays them, M/d/yyyy with a clock
     time, for the rows whose Login Time cell is formatted text rather than a
     date value. Both spellings have to mean the same calendar day. */
  SHEET_FORMAT_ROWS = [
    row({
      'Session ID': 'SHEET-0730', 'User': 'Sadia',
      'Login Time': '7/30/2026 9:04:00', 'Logout Time': '7/30/2026 10:34:00',
      'Duration (min)': 90, 'Duration (h:m)': '1h 30m', 'Status': 'CLOSED',
    }),
    row({
      'Session ID': 'SHEET-0731', 'User': 'Fiza',
      'Login Time': '7/31/2026 8:00:00', 'Logout Time': '7/31/2026 8:45:00',
      'Duration (min)': 45, 'Duration (h:m)': '0h 45m', 'Status': 'CLOSED',
    }),
  ];
});

describe('the Sessions columns this timesheet is built on', () => {
  it('reads the ten column names from Code.gs rather than a copy in this file', () => {
    expect(HEADERS).toHaveLength(10);
  });
  it('still has the four columns a timesheet cannot be read without', () => {
    ['User', 'Login Time', 'Duration (min)', 'Status'].forEach((c) => {
      expect(HEADERS.indexOf(c)).toBeGreaterThan(-1);
    });
  });
});

describe('listSessions: showing everything', () => {
  it('returns every session when no filter is set', () => {
    expect(w.listSessions({}, ROWS)).toHaveLength(8);
  });
  it('returns every session when the filters object is null', () => {
    expect(w.listSessions(null, ROWS)).toHaveLength(8);
  });
  it('returns nothing rather than throwing when there are no sessions at all', () => {
    expect(w.listSessions({ person: 'Fiza' }, [])).toEqual([]);
  });
  it('leaves the rows it was given untouched', () => {
    w.listSessions({ person: 'Fiza', status: 'CLOSED' }, ROWS);
    expect(ROWS).toHaveLength(8);
  });
});

describe('listSessions: by person', () => {
  it('narrows to one teammate and their sessions only', () => {
    expect(ids(w.listSessions({ person: 'Fiza' }, ROWS))).toEqual(['FIZA-0729', 'FIZA-0730', 'FIZA-0731']);
  });
  it('finds the single session of somebody who signed in once', () => {
    expect(ids(w.listSessions({ person: 'Kaleem' }, ROWS))).toEqual(['KALEEM-0731']);
  });
  it('returns nothing for a name nobody on the team has, not everybody', () => {
    expect(w.listSessions({ person: 'Nobody' }, ROWS)).toEqual([]);
  });
});

describe('listSessions: by day', () => {
  it('from includes the sessions of the day itself', () => {
    expect(ids(w.listSessions({ from: '2026-07-31' }, ROWS)))
      .toEqual(['FIZA-0731', 'SADIA-0731', 'USMAN-0731', 'KALEEM-0731']);
  });
  it('to includes the sessions of the day itself', () => {
    expect(ids(w.listSessions({ to: '2026-07-29' }, ROWS))).toEqual(['FIZA-0729', 'USMAN-0729']);
  });
  it('from and to on the same day give just that day', () => {
    expect(ids(w.listSessions({ from: '2026-07-30', to: '2026-07-30' }, ROWS)))
      .toEqual(['SADIA-0730', 'FIZA-0730']);
  });
  it('from and to together give a closed range across two days', () => {
    expect(w.listSessions({ from: '2026-07-30', to: '2026-07-31' }, ROWS)).toHaveLength(6);
  });
  it('a day nobody signed in on returns nothing', () => {
    expect(w.listSessions({ from: '2026-08-01' }, ROWS)).toEqual([]);
  });
  it('counts a session that ran past midnight on the day it started', () => {
    // USMAN-0731 signs in at 22:00 PKT on the 31st and out the next morning.
    expect(ids(w.listSessions({ from: '2026-07-31', to: '2026-07-31' }, ROWS))).toContain('USMAN-0731');
    expect(ids(w.listSessions({ from: '2026-08-01' }, ROWS))).not.toContain('USMAN-0731');
  });
  it('reads a sheet-formatted M/d/yyyy login time without losing the boundary day', () => {
    expect(ids(w.listSessions({ from: '2026-07-30' }, SHEET_FORMAT_ROWS))).toEqual(['SHEET-0730', 'SHEET-0731']);
  });
  it('reads a sheet-formatted M/d/yyyy login time on the to boundary too', () => {
    expect(ids(w.listSessions({ to: '2026-07-30' }, SHEET_FORMAT_ROWS))).toEqual(['SHEET-0730']);
  });
});

describe('listSessions: by status', () => {
  it('shows who is signed in right now', () => {
    expect(ids(w.listSessions({ status: 'ACTIVE' }, ROWS))).toEqual(['KALEEM-0731']);
  });
  it('shows the sessions that ended with a clean sign-out', () => {
    expect(ids(w.listSessions({ status: 'CLOSED' }, ROWS)))
      .toEqual(['FIZA-0729', 'USMAN-0729', 'SADIA-0730', 'FIZA-0731', 'USMAN-0731']);
  });
  it('shows the sessions that simply vanished, separately from the clean ones', () => {
    expect(ids(w.listSessions({ status: 'TIMED OUT' }, ROWS))).toEqual(['FIZA-0730', 'SADIA-0731']);
  });
  it('never counts a timed-out session as a clean sign-out', () => {
    expect(ids(w.listSessions({ status: 'CLOSED' }, ROWS))).not.toContain('FIZA-0730');
  });
});

describe('listSessions: filters combine', () => {
  it('one person on one day', () => {
    expect(ids(w.listSessions({ person: 'Fiza', from: '2026-07-30', to: '2026-07-30' }, ROWS)))
      .toEqual(['FIZA-0730']);
  });
  it('one person and one status', () => {
    expect(ids(w.listSessions({ person: 'Fiza', status: 'CLOSED' }, ROWS)))
      .toEqual(['FIZA-0729', 'FIZA-0731']);
  });
  it('one day and one status', () => {
    expect(ids(w.listSessions({ from: '2026-07-31', status: 'TIMED OUT' }, ROWS))).toEqual(['SADIA-0731']);
  });
  it('all three at once', () => {
    expect(ids(w.listSessions({ person: 'Sadia', from: '2026-07-30', to: '2026-07-31', status: 'CLOSED' }, ROWS)))
      .toEqual(['SADIA-0730']);
  });
  it('a combination nobody matches returns nothing, not everything', () => {
    expect(w.listSessions({ person: 'Kaleem', status: 'CLOSED' }, ROWS)).toEqual([]);
  });
});

describe('sessionTotals: hours per person', () => {
  it('gives one line per person, not one per session', () => {
    expect(w.sessionTotals(ROWS).map((t) => t.person))
      .toEqual(['Fiza', 'Sadia', 'Usman Saeed', 'Kaleem']);
  });
  it('counts how many times each person signed in', () => {
    const t = w.sessionTotals(ROWS);
    expect(totalFor(t, 'Fiza').sessions).toBe(3);
    expect(totalFor(t, 'Usman Saeed').sessions).toBe(2);
    expect(totalFor(t, 'Kaleem').sessions).toBe(1);
  });
  it('adds up the minutes each person was on the profile', () => {
    const t = w.sessionTotals(ROWS);
    expect(totalFor(t, 'Fiza').minutes).toBe(245);
    expect(totalFor(t, 'Sadia').minutes).toBe(120);
  });
  it('says the same total in hours and minutes', () => {
    const t = w.sessionTotals(ROWS);
    expect(totalFor(t, 'Fiza').hm).toBe('4h 5m');
    expect(totalFor(t, 'Sadia').hm).toBe('2h 0m');
    expect(totalFor(t, 'Usman Saeed').hm).toBe('1h 0m');
  });
  it('puts the busiest person first', () => {
    const mins = w.sessionTotals(ROWS).map((t) => t.minutes);
    expect(mins).toEqual([245, 120, 60, 0]);
  });
  it('returns nothing when there are no sessions to total', () => {
    expect(w.sessionTotals([])).toEqual([]);
  });
});

describe('sessionTotals: who is still signed in', () => {
  it('counts the sessions still open for each person', () => {
    expect(totalFor(w.sessionTotals(ROWS), 'Kaleem').open).toBe(1);
  });
  it('shows nobody open for a person who signed out of everything', () => {
    expect(totalFor(w.sessionTotals(ROWS), 'Fiza').open).toBe(0);
  });
  it('does not count a timed-out session as still open', () => {
    // Sadia's 31 July seat timed out; it ended, it is not still running.
    expect(totalFor(w.sessionTotals(ROWS), 'Sadia').open).toBe(0);
  });
  it('shows zero minutes, not NaN, for somebody whose only session is still open', () => {
    const k = totalFor(w.sessionTotals(ROWS), 'Kaleem');
    expect(Number.isNaN(k.minutes)).toBe(false);
    expect(k.minutes).toBe(0);
    expect(k.hm).toBe('0h 0m');
  });
});

describe('sessionTotals: rows with no usable duration', () => {
  it('treats a blank Duration cell as zero instead of poisoning the total', () => {
    // USMAN-0731 closed with an empty Duration; his one timed session was 60 min.
    const u = totalFor(w.sessionTotals(ROWS), 'Usman Saeed');
    expect(Number.isNaN(u.minutes)).toBe(false);
    expect(u.minutes).toBe(60);
    expect(u.hm).toBe('1h 0m');
  });
  it('still counts a blank-duration row as a session that happened', () => {
    expect(totalFor(w.sessionTotals(ROWS), 'Usman Saeed').sessions).toBe(2);
  });
  it('treats a non-numeric Duration as zero rather than NaN', () => {
    const junk = [
      row({ 'Session ID': 'J-1', 'User': 'Hamza', 'Login Time': '2026-07-30T07:00:00.000Z', 'Duration (min)': 'n/a', 'Status': 'CLOSED' }),
      row({ 'Session ID': 'J-2', 'User': 'Hamza', 'Login Time': '2026-07-30T09:00:00.000Z', 'Duration (min)': 40, 'Status': 'CLOSED' }),
    ];
    const h = w.sessionTotals(junk)[0];
    expect(Number.isNaN(h.minutes)).toBe(false);
    expect(h.minutes).toBe(40);
    expect(h.sessions).toBe(2);
  });
  it('reads a duration the sheet stored as text, so the hours still add up', () => {
    const text = [
      row({ 'Session ID': 'T-1', 'User': 'Subhan', 'Login Time': '2026-07-30T07:00:00.000Z', 'Duration (min)': '25', 'Status': 'CLOSED' }),
    ];
    expect(w.sessionTotals(text)[0].minutes).toBe(25);
  });
});

describe('SESSION_ROWS: what the app holds after loading the sheet', () => {
  afterEach(() => { w.setSessionRows([]); });

  it('starts empty, before anything has been loaded', () => {
    expect(w.SESSION_ROWS).toEqual([]);
  });
  it('holds the rows it was given', () => {
    expect(w.setSessionRows(ROWS)).toHaveLength(8);
    expect(w.SESSION_ROWS).toHaveLength(8);
  });
  it('lists the loaded rows when no rows are passed in', () => {
    w.setSessionRows(ROWS);
    expect(ids(w.listSessions({ person: 'Kaleem' }))).toEqual(['KALEEM-0731']);
  });
  it('totals only the sessions left on screen after a filter', () => {
    w.setSessionRows(ROWS);
    const shown = w.sessionTotals(w.listSessions({ person: 'Fiza' }));
    expect(shown.map((t) => t.person)).toEqual(['Fiza']);
    expect(shown[0].sessions).toBe(3);
    expect(shown[0].minutes).toBe(245);
  });
  it('forgets everything when handed an empty load', () => {
    w.setSessionRows(ROWS);
    w.setSessionRows([]);
    expect(w.SESSION_ROWS).toEqual([]);
  });
});
