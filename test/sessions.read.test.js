// Server-side (Code.gs) spec for two things the owner asked for: "who logged in
// when, and when did they log out".
//
//   A. listSessions — the FIRST way to read the Sessions tab back. The app has
//      been writing session rows since v11 and has never once read one, so the
//      login/logout history is invisible to everybody. Like listCLEval it hands
//      bulk business data to the browser, so three properties matter more than
//      the happy path: it must never write, it must be POST only, and it must
//      sit behind the same shared LOG_SECRET.
//
//   B. The TIMED OUT bug — today the stale-holder auto-release inside
//      readQueue_(true) drops the seat and appends an AUTO_RELEASE row, but it
//      never calls closeSession_. A crashed tab therefore leaves a Sessions row
//      ACTIVE with a blank Logout Time forever, and the report the owner wants
//      shows that person as still working, days later. The fix must close that
//      session with Status "TIMED OUT", so a session that simply vanished stays
//      distinguishable from a clean sign-out, which still writes "CLOSED".
//
// Every row this file inspects is created by driving the REAL handle_ login and
// logout actions, never by writing cells, so the shapes asserted here are the
// shapes production actually produces.
//
// A failure in this file is not a broken test. It is the proof that Code.gs does
// not yet behave the way the contract says. Never relax an assertion to go green.
//
// Harness note: loadGas() (test/loadGas.js) exports only handle_, and it cannot
// show whether the script lock was taken. The two properties this file needs
// beyond that, "refused over GET" and "does not take the script lock", come from
// loadGasWeb() below: the SAME Code.gs, the SAME in-memory mocks, with
// doGet/doPost also returned and the lock counted. It replaces nothing.
import { describe, it, expect, vi, afterEach } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGas } from './loadGas.js';

// Pin the process timezone to the one Code.gs actually runs in
// (Session.getScriptTimeZone() is Asia/Karachi). The data.since tests compare an
// ISO date string against Login Time values written by the server, and on a
// laptop with a negative UTC offset a same-day row lands on the other side of
// midnight and the bug hides. Vitest gives each file its own process, so this
// does not leak into the other suites.
process.env.TZ = 'Asia/Karachi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_GS = readFileSync(join(__dirname, '..', 'Code.gs'), 'utf8');

const SECRET = 'sessions-read-secret-4417';

// Several suites below drive logins and logouts at chosen wall-clock times, so
// that "logged in on 15 July" and "heartbeat went stale 45 minutes ago" are real
// states of the sheet rather than hand-written cells. The clock is handed back
// after every test so a suite that wants the real one gets it.
afterEach(() => { vi.useRealTimers(); });

/* ============================================================================
   loadGasWeb: loadGas() plus doGet/doPost and a counted script lock.
   ========================================================================= */
function loadGasWeb({ logSecret } = {}) {
  const sheets = {};
  const lockCalls = { wait: 0, release: 0 };
  const state = { lockBusy: false };

  function makeSheet() {
    const rows = [];
    const sheet = {
      _rows: rows,
      appendRow(arr) { rows.push(arr.slice()); },
      getLastRow() { return rows.length; },
      getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
      setFrozenRows() { return sheet; },
      hideSheet() { return sheet; },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        return {
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = rows[r - 1 + i] || [];
              const seg = [];
              for (let j = 0; j < nc; j++) seg.push(row[c - 1 + j] !== undefined ? row[c - 1 + j] : '');
              out.push(seg);
            }
            return out;
          },
          setValues(vals) {
            for (let i = 0; i < vals.length; i++) {
              if (!rows[r - 1 + i]) rows[r - 1 + i] = [];
              for (let j = 0; j < vals[i].length; j++) rows[r - 1 + i][c - 1 + j] = vals[i][j];
            }
            return this;
          },
          setValue(v) {
            if (!rows[r - 1]) rows[r - 1] = [];
            rows[r - 1][c - 1] = v;
            return this;
          },
          setRichTextValue(v) {
            if (!rows[r - 1]) rows[r - 1] = [];
            rows[r - 1][c - 1] = v && v._text !== undefined ? { text: v._text, link: v._link } : v;
            return this;
          },
        };
      },
    };
    return sheet;
  }

  const ss = {
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) { sheets[name] = makeSheet(); return sheets[name]; },
  };

  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet() { return ss; },
      newRichTextValue() {
        const o = { _text: '', _link: '' };
        return { setText(t) { o._text = t; return this; }, setLinkUrl(u) { o._link = u; return this; }, build() { return o; } };
      },
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(n) { return n === 'LOG_SECRET' ? (logSecret === undefined ? null : logSecret) : null; } };
      },
    },
    LockService: {
      getScriptLock() {
        return {
          waitLock() {
            lockCalls.wait++;
            if (state.lockBusy) throw new Error('Could not obtain lock');
          },
          releaseLock() { lockCalls.release++; },
        };
      },
    },
    Utilities: { formatDate(_d, _tz, fmt) { return fmt; } },
    Session: { getScriptTimeZone() { return 'Asia/Karachi'; } },
    ContentService: { createTextOutput(s) { return { setMimeType() { return this; }, _s: s }; }, MimeType: { JSON: 'json' } },
  };

  const names = Object.keys(globals);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, CODE_GS + '\n;return { handle_: handle_, doGet: doGet, doPost: doPost };');
  const api = factory(...names.map((n) => globals[n]));
  const setLockBusy = (v) => { state.lockBusy = v; };
  return { handle_: api.handle_, doGet: api.doGet, doPost: api.doPost, sheets, lockCalls, setLockBusy };
}

// doGet/doPost return the ContentService stub; the JSON payload is on ._s.
const payload = (out) => JSON.parse(out._s);

/* ============================================================================
   Fixtures and helpers
   ========================================================================= */

// The live 10 Sessions headers, in the live order. This literal IS the contract:
// the Sessions tab already exists on the owner's spreadsheet and any report,
// filter or formula pointing at a column position breaks if these move.
const LIVE_SESSION_HEADERS = [
  'Session ID', 'User', 'Login Time', 'Logout Time', 'Duration (min)',
  'Duration (h:m)', 'JDs', 'Proposals', 'Copies', 'Status',
];

// Column positions, by name, so the assertions below read like the sheet.
const COL = {
  id: 0, user: 1, loginTime: 2, logoutTime: 3, durationMin: 4,
  durationHm: 5, jds: 6, proposals: 7, copies: 8, status: 9,
};

const list = (gas, data = {}) => gas.handle_({ action: 'listSessions', secret: SECRET, ...data });

// Data rows (header excluded) of a tab that may not exist yet.
function dataRows(gas, tab) {
  const s = gas.sheets[tab];
  return s ? s._rows.slice(1) : [];
}

function sessionRows(gas) { return dataRows(gas, 'Sessions'); }

// The newest row belonging to one user, which is the row openSession_ and
// closeSession_ both reach for.
function rowFor(gas, user) {
  const rows = sessionRows(gas).filter((r) => r[COL.user] === user);
  return rows.length ? rows[rows.length - 1] : null;
}

function seat(gas) {
  const r = (gas.sheets.Queue && gas.sheets.Queue._rows[1]) || [];
  return {
    holder: r[0] || null,
    waiting: r[2] ? String(r[2]).split(' || ').filter(Boolean).map((x) => x.split('|')[0]) : [],
    pendingOffer: r[3] || null,
  };
}

function typesLogged(gas) {
  return dataRows(gas, 'ActivityLog').map((r) => r[2]);
}

// Full byte-level picture of every tab, so a write anywhere shows up as a diff.
function snapshot(gas) {
  return JSON.stringify(Object.keys(gas.sheets).sort().map((n) => [n, gas.sheets[n]._rows]));
}

function tabNames(gas) { return Object.keys(gas.sheets).sort(); }

// Age the holder's heartbeat past STALE_MS (12 min), i.e. the exact state a
// crashed tab leaves behind. Any code path that calls readQueue_(true) from here
// will release the seat.
function staleHeartbeat(gas, minutesAgo = 30) {
  gas.sheets.Queue._rows[1][5] = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

// One complete, clean session driven through the real actions: login, then
// logout five minutes later. Five minutes is deliberately under STALE_MS, so the
// logout is a genuine clean sign-out and not a disguised timeout.
function driveSessionAt(gas, name, isoLocal, opts = {}) {
  const t0 = new Date(isoLocal).getTime();
  vi.useFakeTimers();
  vi.setSystemTime(new Date(t0));
  gas.handle_({ action: 'login', name });
  vi.setSystemTime(new Date(t0 + 5 * 60 * 1000));
  gas.handle_({
    action: 'logout', name,
    jds: opts.jds || 0, proposals: opts.proposals || 0, copies: opts.copies || 0,
  });
}

// Same thing at whatever the real clock says right now.
function driveSession(gas, name, opts = {}) {
  gas.handle_({ action: 'login', name });
  gas.handle_({
    action: 'logout', name,
    jds: opts.jds || 0, proposals: opts.proposals || 0, copies: opts.copies || 0,
  });
}

// n complete sessions by n distinct people, in order. The names are padded so
// sheet order is also alphabetical order, which makes "contiguous run" testable.
function manySessions(gas, n) {
  for (let i = 0; i < n; i++) driveSession(gas, 'U' + String(i).padStart(5, '0'));
  return gas;
}

// Today's calendar day in the script timezone, formatted the way the browser
// would send data.since.
function isoToday() {
  const d = new Date();
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ========================================================================
   1. HEADERS
   ===================================================================== */
describe('listSessions: the 10 column headers it hands the browser', () => {
  it('answers ok:true when the secret is right', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 3);
    expect(list(gas).ok).toBe(true);
  });

  it('returns exactly 10 headers, no more and no fewer', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 3);
    expect(list(gas).headers).toHaveLength(10);
  });

  it('returns the 10 headers in the live sheet order', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 3);
    expect(list(gas).headers).toEqual(LIVE_SESSION_HEADERS);
  });

  it('puts Login Time third and Logout Time fourth, the two columns the owner asked for', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 3);
    const h = list(gas).headers;
    expect(h[COL.loginTime]).toBe('Login Time');
    expect(h[COL.logoutTime]).toBe('Logout Time');
  });

  it('keeps Status last, in column 10', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 3);
    expect(list(gas).headers[COL.status]).toBe('Status');
  });

  it('does not hand back the ActivityLog headers by mistake', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 3);
    expect(list(gas).headers).not.toContain('Timestamp');
    expect(list(gas).headers).not.toContain('Decision');
  });
});

/* ========================================================================
   2. ROWS
   ===================================================================== */
describe('listSessions: the rows it returns', () => {
  it('returns one entry per session, with the header row excluded', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 7);
    expect(list(gas).rows).toHaveLength(7);
  });

  it('returns every row as all 10 cells, in column order', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSession(gas, 'Usman Saeed', { jds: 4, proposals: 2, copies: 1 });
    const row = list(gas).rows[0];
    expect(row).toHaveLength(10);
    expect(row[COL.user]).toBe('Usman Saeed');
    expect(row[COL.jds]).toBe(4);
    expect(row[COL.proposals]).toBe(2);
    expect(row[COL.copies]).toBe(1);
  });

  it('returns the very row the sheet holds, cell for cell', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSession(gas, 'Sadia', { jds: 3, proposals: 1, copies: 5 });
    expect(list(gas).rows[0]).toEqual(sessionRows(gas)[0]);
  });

  it('returns rows in sheet order: oldest login first, newest last', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Alice', '2026-07-01T09:00:00');
    driveSessionAt(gas, 'Bob', '2026-07-10T09:00:00');
    driveSessionAt(gas, 'Cara', '2026-07-20T09:00:00');
    expect(list(gas).rows.map((r) => r[COL.user])).toEqual(['Alice', 'Bob', 'Cara']);
  });

  it('does not reverse the sheet the way getLogs does', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 5);
    const users = list(gas).rows.map((r) => r[COL.user]);
    expect(users[0]).toBe('U00000');
    expect(users[users.length - 1]).toBe('U00004');
  });

  it('reports total as the number of sessions on the sheet', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 7);
    expect(list(gas).total).toBe(7);
  });

  it('shows a still-open session as ACTIVE with a blank Logout Time', () => {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ action: 'login', name: 'Fiza' });
    const row = list(gas).rows[0];
    expect(row[COL.status]).toBe('ACTIVE');
    expect(row[COL.logoutTime]).toBe('');
  });

  it('shows a finished session as CLOSED with a Logout Time filled in', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Fiza', '2026-07-20T09:00:00');
    const row = list(gas).rows[0];
    expect(row[COL.status]).toBe('CLOSED');
    expect(row[COL.logoutTime]).toBeTruthy();
  });

  it('does not open a second row when the same person refreshes the page', () => {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ action: 'login', name: 'Hamza' });
    gas.handle_({ action: 'login', name: 'Hamza' });
    gas.handle_({ action: 'login', name: 'Hamza' });
    expect(list(gas).rows).toHaveLength(1);
  });

  it('returns one row per real session when the same person works twice in a day', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Hamza', '2026-07-20T09:00:00');
    driveSessionAt(gas, 'Hamza', '2026-07-20T15:00:00');
    const rows = list(gas).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r[COL.user] === 'Hamza')).toBe(true);
  });

  it('includes an admin, who bypasses the queue but still gets a session row', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSession(gas, 'Waqas Riaz');
    driveSession(gas, 'Sana');
    expect(list(gas).rows.map((r) => r[COL.user])).toEqual(['Waqas Riaz', 'Sana']);
  });

  it('carries the session id, so a row can be pointed at unambiguously', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSession(gas, 'Subhan');
    expect(String(list(gas).rows[0][COL.id])).toMatch(/^SUBHAN-/);
  });

  it('carries the human duration column alongside the minutes', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Ayesha', '2026-07-20T09:00:00');
    const row = list(gas).rows[0];
    expect(row[COL.durationMin]).toBe(5);
    expect(row[COL.durationHm]).toBe('0h 5m');
  });
});

/* ========================================================================
   3. NOTHING LOGGED YET
   ===================================================================== */
describe('listSessions: a Sessions sheet with nothing on it', () => {
  it('still answers ok:true rather than an error', () => {
    const gas = loadGas({ logSecret: SECRET });
    expect(list(gas).ok).toBe(true);
  });

  it('returns an empty rows array, not null and not undefined', () => {
    const gas = loadGas({ logSecret: SECRET });
    expect(list(gas).rows).toEqual([]);
  });

  it('reports total 0', () => {
    const gas = loadGas({ logSecret: SECRET });
    expect(list(gas).total).toBe(0);
  });

  it('still returns the full 10 headers so the table can render its columns', () => {
    const gas = loadGas({ logSecret: SECRET });
    expect(list(gas).headers).toEqual(LIVE_SESSION_HEADERS);
  });

  it('does not invent a session row just by being read', () => {
    const gas = loadGas({ logSecret: SECRET });
    list(gas);
    list(gas);
    expect(sessionRows(gas)).toHaveLength(0);
    expect(list(gas).rows).toEqual([]);
  });
});

/* ========================================================================
   4. LIMIT
   ===================================================================== */
describe('listSessions: how many rows come back', () => {
  it('returns at most 500 rows when no limit is asked for', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 600);
    expect(list(gas).rows).toHaveLength(500);
  });

  it('still reports the true total when the default limit truncated the result', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 600);
    expect(list(gas).total).toBe(600);
  });

  it('reports a total larger than the rows returned, so the client can see it was truncated', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 600);
    const res = list(gas);
    expect(res.total).toBeGreaterThan(res.rows.length);
  });

  it('honours a smaller data.limit', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 50);
    expect(list(gas, { limit: 10 }).rows).toHaveLength(10);
  });

  it('reports the full total even when a small data.limit was asked for', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 50);
    expect(list(gas, { limit: 10 }).total).toBe(50);
  });

  it('returns everything when the sheet is smaller than the limit asked for', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 12);
    const res = list(gas, { limit: 400 });
    expect(res.rows).toHaveLength(12);
    expect(res.total).toBe(12);
  });

  it('caps the limit at 2000 even when the caller asks for 5000', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 2100);
    expect(list(gas, { limit: 5000 }).rows).toHaveLength(2000);
  });

  it('still reports the true total when the 2000 cap truncated the result', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 2100);
    expect(list(gas, { limit: 5000 }).total).toBe(2100);
  });

  it('caps an absurd limit at 2000 too, rather than returning the whole sheet', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 2100);
    expect(list(gas, { limit: 999999 }).rows).toHaveLength(2000);
  });

  it('keeps a truncated result in sheet order', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 600);
    const users = list(gas).rows.map((r) => r[COL.user]);
    expect(users).toEqual(users.slice().sort());
  });

  it('returns a contiguous run of the sheet when truncated, not a scattered sample', () => {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 600);
    const users = list(gas).rows.map((r) => r[COL.user]);
    const first = Number(users[0].slice(1));
    const expected = [];
    for (let i = 0; i < users.length; i++) expected.push('U' + String(first + i).padStart(5, '0'));
    expect(users).toEqual(expected);
  });
});

/* ========================================================================
   5. SINCE
   Login Time holds real Date values written by openSession_. data.since arrives
   from the browser as an ISO date string. Comparison must be by CALENDAR DAY via
   dayNum_, never by timestamp: on the live server at UTC+5 an ISO midnight sits
   five hours BEFORE the same day's rows, which is exactly the bug that silently
   dropped every boundary row out of listCLEval.
   ===================================================================== */
describe('listSessions: filtering by data.since on the Login Time column', () => {
  function spread(gas) {
    driveSessionAt(gas, 'Alice', '2026-06-01T09:00:00');
    driveSessionAt(gas, 'Bob', '2026-06-30T09:00:00');
    driveSessionAt(gas, 'Cara', '2026-07-14T09:00:00');
    driveSessionAt(gas, 'Dan', '2026-07-15T09:00:00');
    driveSessionAt(gas, 'Eve', '2026-07-16T09:00:00');
    driveSessionAt(gas, 'Finn', '2026-07-31T09:00:00');
    return gas;
  }

  it('drops every session that logged in before the since day', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    const users = list(gas, { since: '2026-07-15' }).rows.map((r) => r[COL.user]);
    expect(users).not.toContain('Alice');
    expect(users).not.toContain('Bob');
    expect(users).not.toContain('Cara');
  });

  it('keeps every session that logged in after the since day', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    const users = list(gas, { since: '2026-07-15' }).rows.map((r) => r[COL.user]);
    expect(users).toContain('Eve');
    expect(users).toContain('Finn');
  });

  it('keeps a session that logged in ON the since day itself, so the boundary is inclusive', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    const users = list(gas, { since: '2026-07-15' }).rows.map((r) => r[COL.user]);
    expect(users).toContain('Dan');
  });

  it('keeps an early-morning login on the since day, not just a mid-afternoon one', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Kaleem', '2026-07-15T00:20:00');
    expect(list(gas, { since: '2026-07-15' }).rows.map((r) => r[COL.user])).toEqual(['Kaleem']);
  });

  it('keeps a late-evening login on the since day too', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Kaleem', '2026-07-15T23:40:00');
    expect(list(gas, { since: '2026-07-15' }).rows.map((r) => r[COL.user])).toEqual(['Kaleem']);
  });

  it('keeps a session logged in today when since is today, the exact boundary bug', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSession(gas, 'Zeb');
    expect(list(gas, { since: isoToday() }).rows.map((r) => r[COL.user])).toEqual(['Zeb']);
  });

  it('keeps a still-ACTIVE session logged in today when since is today', () => {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ action: 'login', name: 'Zeb' });
    const res = list(gas, { since: isoToday() });
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0][COL.status]).toBe('ACTIVE');
  });

  it('returns exactly the matching sessions, still in sheet order', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    expect(list(gas, { since: '2026-07-15' }).rows.map((r) => r[COL.user]))
      .toEqual(['Dan', 'Eve', 'Finn']);
  });

  it('counts only the matching sessions in total, not the whole sheet', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    expect(list(gas, { since: '2026-07-15' }).total).toBe(3);
  });

  it('filters on Login Time, not on Logout Time', () => {
    // Logs in on 14 July, signs out after midnight on 15 July. The owner asked
    // "who logged in when", so a since of 15 July must NOT pull this one back.
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-14T23:55:00'));
    gas.handle_({ action: 'login', name: 'Nightowl' });
    vi.setSystemTime(new Date('2026-07-15T00:05:00'));   // still under the 12 min stale window
    gas.handle_({ action: 'logout', name: 'Nightowl' });

    expect(rowFor(gas, 'Nightowl')[COL.status]).toBe('CLOSED');
    expect(list(gas, { since: '2026-07-15' }).rows).toEqual([]);
    expect(list(gas, { since: '2026-07-14' }).rows.map((r) => r[COL.user])).toEqual(['Nightowl']);
  });

  it('returns nothing when the since day is after every session', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    const res = list(gas, { since: '2027-01-01' });
    expect(res.ok).toBe(true);
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('returns the whole sheet when since is older than every session', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    expect(list(gas, { since: '2020-01-01' }).rows).toHaveLength(6);
  });

  it('returns the whole sheet when since is not given at all', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    expect(list(gas).rows).toHaveLength(6);
  });

  it('applies since and limit together', () => {
    const gas = spread(loadGas({ logSecret: SECRET }));
    const res = list(gas, { since: '2026-07-15', limit: 2 });
    expect(res.rows).toHaveLength(2);
    expect(res.total).toBe(3);
  });
});

/* ========================================================================
   6. IT MUST NOT WRITE
   The seat gate and the session log share one script. readQueue_(true) releases
   a stale holder, appends an AUTO_RELEASE row and, once the bug below is fixed,
   also closes that person's session. A bulk read that reaches that path takes
   the Upwork profile away from whoever is mid-bid AND falsifies the very report
   it was asked to produce. listSessions must touch nothing.
   ===================================================================== */
describe('listSessions: reading the history must not change anything', () => {
  function primed() {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ action: 'login', name: 'Alice' });   // Alice holds the seat
    gas.handle_({ action: 'login', name: 'Bob' });     // Bob waits behind her
    manySessions(gas, 4);                              // some finished sessions
    staleHeartbeat(gas);                               // Alice's tab looks crashed
    return gas;
  }

  it('leaves the stale holder seated instead of auto-releasing them', () => {
    const gas = primed();
    list(gas);
    expect(seat(gas).holder).toBe('Alice');
  });

  it('does not hand the seat to the waiter behind the stale holder', () => {
    const gas = primed();
    list(gas);
    expect(seat(gas).pendingOffer).toBeNull();
  });

  it('leaves the waiting list exactly as it was', () => {
    const gas = primed();
    const before = seat(gas).waiting;
    list(gas);
    expect(seat(gas).waiting).toEqual(before);
  });

  it('closes nobody: the stale holder stays ACTIVE with a blank Logout Time', () => {
    const gas = primed();
    list(gas);
    const row = rowFor(gas, 'Alice');
    expect(row[COL.status]).toBe('ACTIVE');
    expect(row[COL.logoutTime]).toBe('');
  });

  it('marks nobody TIMED OUT just by reading', () => {
    const gas = primed();
    list(gas);
    expect(sessionRows(gas).map((r) => r[COL.status])).not.toContain('TIMED OUT');
  });

  it('appends no AUTO_RELEASE row to the activity log', () => {
    const gas = primed();
    list(gas);
    expect(typesLogged(gas)).not.toContain('AUTO_RELEASE');
  });

  it('appends no ActivityLog row of any kind', () => {
    const gas = primed();
    const before = dataRows(gas, 'ActivityLog').length;
    list(gas);
    expect(dataRows(gas, 'ActivityLog')).toHaveLength(before);
  });

  it('appends no row to Sessions itself', () => {
    const gas = primed();
    const before = sessionRows(gas).length;
    list(gas);
    expect(sessionRows(gas)).toHaveLength(before);
  });

  it('opens no session row for a reader who is not logged in', () => {
    const gas = primed();
    list(gas, { name: 'Snooper' });
    expect(sessionRows(gas).map((r) => r[COL.user])).not.toContain('Snooper');
  });

  it('creates no new sheet tab', () => {
    const gas = primed();
    const before = tabNames(gas);
    list(gas);
    expect(tabNames(gas)).toEqual(before);
  });

  it('changes not one cell on any sheet: full before and after snapshot is identical', () => {
    const gas = primed();
    const before = snapshot(gas);
    list(gas);
    expect(snapshot(gas)).toBe(before);
  });

  it('changes nothing when a since filter and a limit are supplied either', () => {
    const gas = primed();
    const before = snapshot(gas);
    list(gas, { since: '2020-01-01', limit: 3 });
    expect(snapshot(gas)).toBe(before);
  });

  it('leaves every sheet byte-identical after ten calls', () => {
    const gas = primed();
    const before = snapshot(gas);
    for (let i = 0; i < 10; i++) list(gas);
    expect(snapshot(gas)).toBe(before);
  });

  it('returns the same rows on the tenth call as on the first', () => {
    const gas = primed();
    const first = JSON.stringify(list(gas).rows);
    for (let i = 0; i < 9; i++) list(gas);
    expect(JSON.stringify(list(gas).rows)).toBe(first);
  });

  it('reports the same total on the tenth call as on the first', () => {
    const gas = primed();
    const first = list(gas).total;
    for (let i = 0; i < 9; i++) list(gas);
    expect(list(gas).total).toBe(first);
  });
});

/* ========================================================================
   7. IT MUST NOT TAKE THE SCRIPT LOCK
   A bulk read that grabs the gate lock stalls every login, logout and heartbeat
   in a 20 person team for as long as the read runs.
   ===================================================================== */
describe('listSessions: the script lock', () => {
  it('does not take the script lock at all', () => {
    const gas = loadGasWeb({ logSecret: SECRET });
    manySessions(gas, 5);
    gas.lockCalls.wait = 0;
    gas.lockCalls.release = 0;

    gas.handle_({ action: 'listSessions', secret: SECRET });

    expect(gas.lockCalls.wait).toBe(0);
  });

  it('does not release a lock it never took', () => {
    const gas = loadGasWeb({ logSecret: SECRET });
    manySessions(gas, 5);
    gas.lockCalls.wait = 0;
    gas.lockCalls.release = 0;

    gas.handle_({ action: 'listSessions', secret: SECRET });

    expect(gas.lockCalls.release).toBe(0);
  });

  it('still returns the history while someone else is holding the gate lock', () => {
    const gas = loadGasWeb({ logSecret: SECRET });
    manySessions(gas, 5);
    // Seed first, then jam the lock: from here every waitLock() throws, which is
    // what a mid-login teammate looks like to a second request.
    gas.setLockBusy(true);

    const res = gas.handle_({ action: 'listSessions', secret: SECRET });

    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(5);
  });

  it('a jammed gate lock never turns the session read into a "busy, try again" error', () => {
    const gas = loadGasWeb({ logSecret: SECRET });
    manySessions(gas, 5);
    gas.setLockBusy(true);

    const res = gas.handle_({ action: 'listSessions', secret: SECRET });

    expect(res.error).toBeUndefined();
  });
});

/* ========================================================================
   8. IT MUST BE POST ONLY
   ===================================================================== */
describe('listSessions over GET', () => {
  function primedWeb() {
    const gas = loadGasWeb({ logSecret: SECRET });
    manySessions(gas, 4);
    return gas;
  }

  it('is refused when reached with a GET', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listSessions' } }));
    expect(res.ok).toBe(false);
  });

  it('says the action requires POST', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listSessions' } }));
    expect(res.error).toBe('This action requires POST.');
  });

  it('leaks no rows over GET', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listSessions' } }));
    expect(res.rows).toBeUndefined();
  });

  it('leaks no headers over GET', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listSessions' } }));
    expect(res.headers).toBeUndefined();
  });

  it('is refused over GET even when the correct secret is put in the query string', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listSessions', secret: SECRET } }));
    expect(res.ok).toBe(false);
    expect(res.rows).toBeUndefined();
    expect(res.total).toBeUndefined();
  });

  it('is listed in POST_ONLY in Code.gs, so no future action name slips past the router', () => {
    const postOnly = CODE_GS.match(/var POST_ONLY\s*=\s*\{[\s\S]*?\}/)[0];
    expect(postOnly).toMatch(/listSessions/);
  });

  it('changes nothing on any sheet when refused over GET', () => {
    const gas = primedWeb();
    const before = snapshot(gas);
    gas.doGet({ parameter: { action: 'listSessions', secret: SECRET } });
    expect(snapshot(gas)).toBe(before);
  });

  it('is served normally over POST', () => {
    const gas = primedWeb();
    const res = payload(gas.doPost({ postData: { contents: JSON.stringify({ action: 'listSessions', secret: SECRET }) } }));
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(4);
  });
});

/* ========================================================================
   9. IT MUST REQUIRE THE SHARED SECRET
   Without it, every name, every login time and every hour worked leaks to
   anyone who finds the /exec URL.
   ===================================================================== */
describe('listSessions: the shared-secret gate', () => {
  function primed() {
    const gas = loadGas({ logSecret: SECRET });
    manySessions(gas, 4);
    return gas;
  }

  it('rejects a request that carries no secret', () => {
    const gas = primed();
    expect(gas.handle_({ action: 'listSessions' })).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('returns no rows when the secret is missing', () => {
    const gas = primed();
    expect(gas.handle_({ action: 'listSessions' }).rows).toBeUndefined();
  });

  it('returns no headers when the secret is missing', () => {
    const gas = primed();
    expect(gas.handle_({ action: 'listSessions' }).headers).toBeUndefined();
  });

  it('does not even leak the session count when the secret is missing', () => {
    const gas = primed();
    expect(gas.handle_({ action: 'listSessions' }).total).toBeUndefined();
  });

  it('rejects a wrong secret', () => {
    const gas = primed();
    expect(gas.handle_({ action: 'listSessions', secret: 'not-the-secret' }))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('rejects an empty-string secret', () => {
    const gas = primed();
    expect(gas.handle_({ action: 'listSessions', secret: '' }))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('does not accept a secret that is merely a prefix of the real one', () => {
    const gas = primed();
    expect(gas.handle_({ action: 'listSessions', secret: SECRET.slice(0, -1) }))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('does not let an admin name stand in for the secret', () => {
    const gas = primed();
    expect(gas.handle_({ action: 'listSessions', name: 'Saqib Shahzad' }))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('does not fall back to a no-op success that hides the refusal', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listSessions', secret: 'not-the-secret' });
    expect(res.ok).not.toBe(true);
    expect(res.note).toBeUndefined();
  });

  it('fails closed when the server has no LOG_SECRET configured, even if a secret is sent', () => {
    const gas = loadGas({});   // LOG_SECRET unset
    expect(gas.handle_({ action: 'listSessions', secret: SECRET }))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('writes nothing when it refuses an unauthorized read', () => {
    const gas = primed();
    const before = snapshot(gas);
    gas.handle_({ action: 'listSessions', secret: 'not-the-secret' });
    expect(snapshot(gas)).toBe(before);
  });

  it('accepts the exact secret and returns the history', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listSessions', secret: SECRET });
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(4);
  });
});

/* ========================================================================
   10. THE TIMED OUT BUG
   A crashed tab leaves the heartbeat behind. The next real gate action calls
   readQueue_(true), which drops the seat and logs AUTO_RELEASE. Today it stops
   there, so the Sessions row stays ACTIVE with an empty Logout Time forever and
   the owner's report shows that person still working days later.
   ===================================================================== */
describe('the stale-holder auto-release must close that holder\'s session', () => {
  const T0 = new Date('2026-07-20T09:00:00').getTime();
  const MIN = 60 * 1000;

  // Alice holds the seat and her tab dies. Bob is waiting behind her. 45 minutes
  // later Bob's client sends a heartbeat, which is the next real gate action and
  // therefore the moment readQueue_(true) notices Alice is gone.
  function crashedHolder({ withWaiter = true, trigger = true } = {}) {
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    gas.handle_({ action: 'login', name: 'Alice' });
    if (withWaiter) {
      vi.setSystemTime(new Date(T0 + 1 * MIN));
      gas.handle_({ action: 'login', name: 'Bob' });
    }
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    if (trigger) gas.handle_({ action: 'heartbeat', name: withWaiter ? 'Bob' : 'Alice2' });
    return gas;
  }

  it('leaves the session ACTIVE while the holder is still alive (nothing fires early)', () => {
    const gas = crashedHolder({ trigger: false });
    expect(rowFor(gas, 'Alice')[COL.status]).toBe('ACTIVE');
  });

  it('sets the released holder\'s status to TIMED OUT, not ACTIVE', () => {
    const gas = crashedHolder();
    expect(rowFor(gas, 'Alice')[COL.status]).toBe('TIMED OUT');
  });

  it('does not leave the released holder\'s status as ACTIVE', () => {
    const gas = crashedHolder();
    expect(rowFor(gas, 'Alice')[COL.status]).not.toBe('ACTIVE');
  });

  it('does not mislabel a vanished session as a clean CLOSED sign-out', () => {
    const gas = crashedHolder();
    expect(rowFor(gas, 'Alice')[COL.status]).not.toBe('CLOSED');
  });

  it('fills in a Logout Time instead of leaving the cell blank forever', () => {
    const gas = crashedHolder();
    expect(rowFor(gas, 'Alice')[COL.logoutTime]).not.toBe('');
    expect(rowFor(gas, 'Alice')[COL.logoutTime]).toBeTruthy();
  });

  it('stamps the Logout Time at the moment the timeout was noticed, after the login', () => {
    const gas = crashedHolder();
    const row = rowFor(gas, 'Alice');
    expect(new Date(row[COL.logoutTime]).getTime())
      .toBeGreaterThan(new Date(row[COL.loginTime]).getTime());
  });

  it('fills in a duration in minutes that is a positive number', () => {
    const gas = crashedHolder();
    const d = rowFor(gas, 'Alice')[COL.durationMin];
    expect(typeof d).toBe('number');
    expect(d).toBeGreaterThan(0);
  });

  it('computes that duration from the real login time, not from zero', () => {
    const gas = crashedHolder();
    expect(rowFor(gas, 'Alice')[COL.durationMin]).toBe(45);
  });

  it('fills the human duration column too, so the report is readable', () => {
    const gas = crashedHolder();
    expect(rowFor(gas, 'Alice')[COL.durationHm]).toBe('0h 45m');
  });

  it('keeps the same session id: it closes the existing row, it does not start a new one', () => {
    const gas = crashedHolder({ trigger: false });
    const idBefore = rowFor(gas, 'Alice')[COL.id];
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    expect(rowFor(gas, 'Alice')[COL.id]).toBe(idBefore);
  });

  it('appends no extra Sessions row at all: still one row per person', () => {
    const gas = crashedHolder();
    expect(sessionRows(gas)).toHaveLength(2);
  });

  it('never appends the "(auto)" fallback row closeSession_ writes when it finds nothing', () => {
    const gas = crashedHolder();
    expect(sessionRows(gas).map((r) => r[COL.id])).not.toContain('(auto)');
  });

  it('still appends exactly one AUTO_RELEASE row to the activity log', () => {
    const gas = crashedHolder();
    expect(typesLogged(gas).filter((t) => t === 'AUTO_RELEASE')).toHaveLength(1);
  });
});

describe('TIMED OUT and CLOSED must stay distinguishable', () => {
  const T0 = new Date('2026-07-20T09:00:00').getTime();
  const MIN = 60 * 1000;

  it('a clean logout still writes CLOSED', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Alice', '2026-07-20T09:00:00');
    expect(rowFor(gas, 'Alice')[COL.status]).toBe('CLOSED');
  });

  it('a clean logout is never relabelled TIMED OUT', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Alice', '2026-07-20T09:00:00');
    expect(rowFor(gas, 'Alice')[COL.status]).not.toBe('TIMED OUT');
  });

  it('a clean logout still records the counts the client sent', () => {
    const gas = loadGas({ logSecret: SECRET });
    driveSessionAt(gas, 'Alice', '2026-07-20T09:00:00', { jds: 6, proposals: 3, copies: 2 });
    const row = rowFor(gas, 'Alice');
    expect([row[COL.jds], row[COL.proposals], row[COL.copies]]).toEqual([6, 3, 2]);
  });

  it('a clean sign-out and a crashed tab end up with different statuses on the same sheet', () => {
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    driveSessionAt(gas, 'Cara', '2026-07-19T09:00:00');            // clean
    vi.setSystemTime(new Date(T0));
    gas.handle_({ action: 'login', name: 'Alice' });               // crashes
    vi.setSystemTime(new Date(T0 + 1 * MIN));
    gas.handle_({ action: 'login', name: 'Bob' });
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });

    expect(rowFor(gas, 'Cara')[COL.status]).toBe('CLOSED');
    expect(rowFor(gas, 'Alice')[COL.status]).toBe('TIMED OUT');
  });

  it('the three statuses the report needs all appear, and nothing else does', () => {
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    driveSessionAt(gas, 'Cara', '2026-07-19T09:00:00');            // CLOSED
    vi.setSystemTime(new Date(T0));
    gas.handle_({ action: 'login', name: 'Alice' });               // TIMED OUT
    vi.setSystemTime(new Date(T0 + 1 * MIN));
    gas.handle_({ action: 'login', name: 'Bob' });                 // stays ACTIVE
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });

    const statuses = sessionRows(gas).map((r) => r[COL.status]).sort();
    expect(statuses).toEqual(['ACTIVE', 'CLOSED', 'TIMED OUT']);
  });

  it('a timed-out person who comes back gets a fresh ACTIVE row, not the old one reopened', () => {
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    gas.handle_({ action: 'login', name: 'Alice' });
    vi.setSystemTime(new Date(T0 + 1 * MIN));
    gas.handle_({ action: 'login', name: 'Bob' });
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    vi.setSystemTime(new Date(T0 + 60 * MIN));
    gas.handle_({ action: 'login', name: 'Alice' });

    const alice = sessionRows(gas).filter((r) => r[COL.user] === 'Alice');
    expect(alice).toHaveLength(2);
    expect(alice[0][COL.status]).toBe('TIMED OUT');
    expect(alice[1][COL.status]).toBe('ACTIVE');
  });

  it('surfaces TIMED OUT through listSessions, which is where the owner will read it', () => {
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    gas.handle_({ action: 'login', name: 'Alice' });
    vi.setSystemTime(new Date(T0 + 1 * MIN));
    gas.handle_({ action: 'login', name: 'Bob' });
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });

    const rows = list(gas).rows;
    const alice = rows.find((r) => r[COL.user] === 'Alice');
    expect(alice[COL.status]).toBe('TIMED OUT');
    expect(alice[COL.logoutTime]).toBeTruthy();
  });
});

describe('the auto-release must touch only the stale holder', () => {
  const T0 = new Date('2026-07-20T09:00:00').getTime();
  const MIN = 60 * 1000;

  // Alice holds and crashes. Bob waits. Kaleem is an ordinary teammate who is
  // logged in and working, and Waqas Riaz is an admin who bypasses the queue.
  // Neither of them may be closed by Alice's timeout.
  function crowded() {
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    gas.handle_({ action: 'login', name: 'Alice' });
    vi.setSystemTime(new Date(T0 + 1 * MIN));
    gas.handle_({ action: 'login', name: 'Bob' });
    gas.handle_({ action: 'login', name: 'Kaleem' });
    gas.handle_({ action: 'login', name: 'Waqas Riaz' });
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    return gas;
  }

  it('leaves the waiter\'s own session ACTIVE', () => {
    const gas = crowded();
    expect(rowFor(gas, 'Bob')[COL.status]).toBe('ACTIVE');
  });

  it('leaves an unrelated teammate\'s session ACTIVE with a blank Logout Time', () => {
    const gas = crowded();
    expect(rowFor(gas, 'Kaleem')[COL.status]).toBe('ACTIVE');
    expect(rowFor(gas, 'Kaleem')[COL.logoutTime]).toBe('');
  });

  it('leaves a present admin\'s session ACTIVE', () => {
    const gas = crowded();
    expect(rowFor(gas, 'Waqas Riaz')[COL.status]).toBe('ACTIVE');
  });

  it('closes exactly one session, not the whole sheet', () => {
    const gas = crowded();
    const timedOut = sessionRows(gas).filter((r) => r[COL.status] === 'TIMED OUT');
    expect(timedOut).toHaveLength(1);
    expect(timedOut[0][COL.user]).toBe('Alice');
  });

  it('does not blank out anybody else\'s duration columns', () => {
    const gas = crowded();
    ['Bob', 'Kaleem', 'Waqas Riaz'].forEach((who) => {
      expect(rowFor(gas, who)[COL.durationMin]).toBe('');
      expect(rowFor(gas, who)[COL.durationHm]).toBe('');
    });
  });

  it('adds no session rows: still one per person who logged in', () => {
    const gas = crowded();
    expect(sessionRows(gas)).toHaveLength(4);
  });
});

describe('the auto-release must fire once and only once', () => {
  const T0 = new Date('2026-07-20T09:00:00').getTime();
  const MIN = 60 * 1000;

  function released() {
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    gas.handle_({ action: 'login', name: 'Alice' });
    vi.setSystemTime(new Date(T0 + 1 * MIN));
    gas.handle_({ action: 'login', name: 'Bob' });
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    return gas;
  }

  it('a second gate action does not close the session a second time', () => {
    const gas = released();
    const before = JSON.stringify(rowFor(gas, 'Alice'));
    vi.setSystemTime(new Date(T0 + 50 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    expect(JSON.stringify(rowFor(gas, 'Alice'))).toBe(before);
  });

  it('a second gate action does not open a new session row', () => {
    const gas = released();
    const before = sessionRows(gas).length;
    vi.setSystemTime(new Date(T0 + 50 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    gas.handle_({ action: 'gateDecline', name: 'Bob' });
    expect(sessionRows(gas)).toHaveLength(before);
  });

  it('several more gate actions append no second AUTO_RELEASE row', () => {
    const gas = released();
    vi.setSystemTime(new Date(T0 + 50 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    expect(typesLogged(gas).filter((t) => t === 'AUTO_RELEASE')).toHaveLength(1);
  });

  it('leaves the whole Sessions tab untouched across several more gate actions', () => {
    const gas = released();
    const before = JSON.stringify(sessionRows(gas));
    vi.setSystemTime(new Date(T0 + 50 * MIN));
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    gas.handle_({ action: 'heartbeat', name: 'Bob' });
    expect(JSON.stringify(sessionRows(gas))).toBe(before);
  });
});

describe('the gate itself must keep behaving the way it does today', () => {
  const T0 = new Date('2026-07-20T09:00:00').getTime();
  const MIN = 60 * 1000;

  function released({ withWaiter = true } = {}) {
    const gas = loadGas({ logSecret: SECRET });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(T0));
    gas.handle_({ action: 'login', name: 'Alice' });
    if (withWaiter) {
      vi.setSystemTime(new Date(T0 + 1 * MIN));
      gas.handle_({ action: 'login', name: 'Bob' });
      gas.handle_({ action: 'login', name: 'Cara' });
    }
    vi.setSystemTime(new Date(T0 + 45 * MIN));
    gas.handle_({ action: 'heartbeat', name: withWaiter ? 'Bob' : 'Nobody' });
    return gas;
  }

  it('drops the stale holder out of the seat', () => {
    const gas = released();
    expect(seat(gas).holder).toBeNull();
  });

  it('offers the seat to the first person waiting', () => {
    const gas = released();
    expect(seat(gas).pendingOffer).toBe('Bob');
  });

  it('leaves the waiting list in place, in order, exactly as it is today', () => {
    const gas = released();
    expect(seat(gas).waiting).toEqual(['Bob', 'Cara']);
  });

  it('leaves no pending offer when nobody was waiting', () => {
    const gas = released({ withWaiter: false });
    expect(seat(gas).holder).toBeNull();
    expect(seat(gas).pendingOffer).toBeNull();
  });

  it('lets the promoted person accept and take the seat', () => {
    const gas = released();
    vi.setSystemTime(new Date(T0 + 46 * MIN));
    gas.handle_({ action: 'gateAccept', name: 'Bob' });
    expect(seat(gas).holder).toBe('Bob');
  });

  it('does not give Bob a second session row when he accepts the seat', () => {
    const gas = released();
    vi.setSystemTime(new Date(T0 + 46 * MIN));
    gas.handle_({ action: 'gateAccept', name: 'Bob' });
    expect(sessionRows(gas).filter((r) => r[COL.user] === 'Bob')).toHaveLength(1);
  });

  it('does not resurrect the timed-out holder when Bob takes the seat', () => {
    const gas = released();
    vi.setSystemTime(new Date(T0 + 46 * MIN));
    gas.handle_({ action: 'gateAccept', name: 'Bob' });
    expect(rowFor(gas, 'Alice')[COL.status]).toBe('TIMED OUT');
  });

  it('still logs the AUTO_RELEASE against the person who vanished', () => {
    const gas = released();
    const row = dataRows(gas, 'ActivityLog').find((r) => r[2] === 'AUTO_RELEASE');
    expect(row[1]).toBe('Alice');
  });
});
