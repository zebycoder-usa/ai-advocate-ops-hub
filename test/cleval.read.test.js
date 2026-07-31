// Server-side (Code.gs) spec for the NEW read-only action: listCLEval.
//
// listCLEval hands the whole CLEval job-history sheet back to the browser so the
// app can show "every job we ever looked at". It is the first action that READS
// bulk business data, which makes three properties matter more than the happy
// path:
//   1. it must never write (the seat gate lives on the same script; a read that
//      mutates can take the profile away from whoever is mid-bid),
//   2. it must be POST only (a link, a prefetch or a crawler must not reach it),
//   3. it must sit behind the same shared secret logCLEval uses (without it the
//      entire client/job history leaks to anyone who finds the /exec URL).
//
// Every test here asserts the SAFE behaviour. A failure in this file is not a
// broken test, it is the proof that listCLEval does not yet behave the way the
// contract says. Never relax an assertion to go green.
//
// Harness note: loadGas() (test/loadGas.js) is used for everything driven
// through handle_(). It deliberately exports only handle_(), and it cannot show
// whether the script lock was taken. The two properties this file needs beyond
// that, "refused over GET" and "does not take the script lock", are driven
// through loadGasWeb() below: the SAME Code.gs, the SAME in-memory mocks, with
// doGet/doPost also returned and the lock instrumented. It replaces nothing.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGas } from './loadGas.js';

// Pin the process timezone to the one Code.gs actually runs in
// (Session.getScriptTimeZone() is Asia/Karachi, and the Date column is written
// as PKT calendar days by clevalServerRow_). Without this pin the data.since
// tests below pass on a US laptop and fail on the real server, because
// new Date("7/15/2026") and new Date("2026-07-15") land on different sides of
// midnight once the offset is positive. Vitest gives each test file its own
// process, so this does not leak into the other suites.
process.env.TZ = 'Asia/Karachi';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_GS = readFileSync(join(__dirname, '..', 'Code.gs'), 'utf8');

const SECRET = 'cleval-read-secret-9931';

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
   Fixtures
   ========================================================================= */

// The live 25 CLEval headers, in the live order, typo and all. This literal IS
// the contract: if Code.gs ever renames "Ptoposal Status" the sheet's 664 live
// rows and every formula pointing at column 25 break.
const LIVE_HEADERS = [
  'Assignee', 'Date', 'Time PKT', 'Job Title', 'Job Link',
  'Hiring Rate', 'Client Ratings', 'Payment Method Verified?', 'Total Spend', 'Proposals',
  'Interviewing', 'Invites sent', 'Unanswered Invites', 'Flag', 'Applied?',
  'Fixed/ Hourly', 'High Bid', 'Avg. Bid', 'Low bid', 'No. of Connects',
  'Bid', 'Reason/Remarks', 'Job posted', 'Open jobs', 'Ptoposal Status',
];

// Dates on the sheet are written by clevalServerRow_ as Utilities.formatDate(..,"M/d/yyyy").
const dateCell = (y, m, d) => `${m}/${d}/${y}`;

function clevalRow(o = {}) {
  const r = new Array(25).fill('');
  r[0] = o.assignee !== undefined ? o.assignee : 'Waqas Riaz';   // 1  Assignee
  r[1] = o.date !== undefined ? o.date : dateCell(2026, 7, 20);  // 2  Date
  r[2] = o.time !== undefined ? o.time : '14:05';                // 3  Time PKT
  r[3] = o.title !== undefined ? o.title : 'Job';                // 4  Job Title
  r[4] = o.link !== undefined ? o.link : 'URL';                  // 5  Job Link
  r[13] = o.flag !== undefined ? o.flag : 'Green';               // 14 Flag
  r[14] = o.applied !== undefined ? o.applied : 'No';            // 15 Applied?
  r[19] = o.connects !== undefined ? o.connects : 6;             // 20 No. of Connects
  r[20] = o.bid !== undefined ? o.bid : 45;                      // 21 Bid
  r[21] = o.reason !== undefined ? o.reason : '';                // 22 Reason/Remarks
  r[24] = o.status !== undefined ? o.status : 'Not checked';     // 25 Ptoposal Status
  return r;
}

// The CLEval and _Idempotency tabs are created lazily by the first write, so do
// one throwaway logCLEval to materialise them (which also puts the REAL 25
// headers from Code.gs into row 1), then drop the data rows and install ours.
// Row 1 is never touched, so the header assertions below test Code.gs, not this
// fixture.
function seedCLEval(gas, rows) {
  gas.handle_({ action: 'logCLEval', secret: SECRET, evaluationId: 'ev_seed', name: 'Seed User', row: { jobTitle: 'seed' } });
  const s = gas.sheets.CLEval;
  s._rows.length = 1;
  rows.forEach((r) => s._rows.push(r.slice()));
  gas.sheets._Idempotency._rows.length = 1;
  return s;
}

function manyRows(n, dateFn) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(clevalRow({
      title: `Job ${String(i).padStart(5, '0')}`,
      date: dateFn ? dateFn(i) : dateCell(2026, 7, 20),
    }));
  }
  return out;
}

const list = (gas, data = {}) => gas.handle_({ action: 'listCLEval', secret: SECRET, ...data });

// Data rows (header excluded) of a tab that may not exist yet.
function dataRows(gas, tab) {
  const s = gas.sheets[tab];
  return s ? s._rows.slice(1) : [];
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

function tabNames(gas) {
  return Object.keys(gas.sheets).sort();
}

// Age the holder's heartbeat past STALE_MS (12 min), i.e. the exact state a
// crashed tab leaves behind. Any code path that calls readQueue_(true) from
// here will release the seat and append an AUTO_RELEASE row.
function staleHeartbeat(gas, minutesAgo = 30) {
  gas.sheets.Queue._rows[1][5] = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

/* ========================================================================
   1. HEADERS
   ===================================================================== */
describe('listCLEval: the 25 column headers it hands the browser', () => {
  it('answers ok:true when the secret is right', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(3));
    expect(list(gas).ok).toBe(true);
  });

  it('returns exactly 25 headers, no more and no fewer', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(3));
    expect(list(gas).headers).toHaveLength(25);
  });

  it('returns the 25 headers in the live sheet order', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(3));
    expect(list(gas).headers).toEqual(LIVE_HEADERS);
  });

  it('keeps the live "Ptoposal Status" spelling in column 25, typo and all', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(3));
    expect(list(gas).headers[24]).toBe('Ptoposal Status');
  });

  it('does not silently correct the typo to "Proposal Status"', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(3));
    expect(list(gas).headers).not.toContain('Proposal Status');
  });

  it('puts Assignee first, Job Link fifth and "Applied?" fifteenth', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(3));
    const h = list(gas).headers;
    expect(h[0]).toBe('Assignee');
    expect(h[4]).toBe('Job Link');
    expect(h[14]).toBe('Applied?');
  });
});

/* ========================================================================
   2. ROWS
   ===================================================================== */
describe('listCLEval: the rows it returns', () => {
  it('returns one entry per data row, with the header row excluded', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(7));
    expect(list(gas).rows).toHaveLength(7);
  });

  it('returns every row as all 25 cells, in column order', () => {
    const gas = loadGas({ logSecret: SECRET });
    const row = clevalRow({
      assignee: 'Usman Saeed', date: dateCell(2026, 7, 18), time: '09:31',
      title: 'n8n AI Automation Expert', applied: 'Yes', connects: 12, bid: 60,
      reason: 'Strong RAG fit', status: 'Replied',
    });
    seedCLEval(gas, [row]);
    expect(list(gas).rows[0]).toEqual(row);
  });

  it('returns rows in sheet order: oldest first, newest last', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, [
      clevalRow({ title: 'oldest', date: dateCell(2026, 7, 1) }),
      clevalRow({ title: 'middle', date: dateCell(2026, 7, 10) }),
      clevalRow({ title: 'newest', date: dateCell(2026, 7, 20) }),
    ]);
    expect(list(gas).rows.map((r) => r[3])).toEqual(['oldest', 'middle', 'newest']);
  });

  it('does not reverse the sheet the way getLogs does', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(5));
    const titles = list(gas).rows.map((r) => r[3]);
    expect(titles[0]).toBe('Job 00000');
    expect(titles[titles.length - 1]).toBe('Job 00004');
  });

  it('reports total as the number of rows on the sheet', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(7));
    expect(list(gas).total).toBe(7);
  });

  it('keeps a legacy "Un Opened" row in the results instead of dropping it', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, [
      clevalRow({ title: 'legacy row', status: 'Un Opened' }),
      clevalRow({ title: 'new row', status: 'Not checked' }),
    ]);
    expect(list(gas).rows.map((r) => r[3])).toEqual(['legacy row', 'new row']);
  });

  it('reads a legacy "Un Opened" status as itself or as "Not checked", never blank', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, [clevalRow({ status: 'Un Opened' })]);
    expect(['Un Opened', 'Not checked']).toContain(list(gas).rows[0][24]);
  });
});

/* ========================================================================
   3. EMPTY SHEET
   ===================================================================== */
describe('listCLEval: a CLEval sheet that has only its header row', () => {
  it('still answers ok:true rather than an error', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, []);
    expect(list(gas).ok).toBe(true);
  });

  it('returns an empty rows array, not null and not undefined', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, []);
    expect(list(gas).rows).toEqual([]);
  });

  it('reports total 0', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, []);
    expect(list(gas).total).toBe(0);
  });

  it('still returns the full 25 headers so the table can render its columns', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, []);
    expect(list(gas).headers).toEqual(LIVE_HEADERS);
  });

  it('does not append a row to the empty sheet just by reading it', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, []);
    list(gas);
    expect(dataRows(gas, 'CLEval')).toHaveLength(0);
  });
});

/* ========================================================================
   4. LIMIT
   ===================================================================== */
describe('listCLEval: how many rows come back', () => {
  it('returns at most 500 rows when no limit is asked for', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(600));
    expect(list(gas).rows).toHaveLength(500);
  });

  it('still reports the true total when the default limit truncated the result', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(600));
    expect(list(gas).total).toBe(600);
  });

  it('reports a total larger than the rows returned, so the client can see it was truncated', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(600));
    const res = list(gas);
    expect(res.total).toBeGreaterThan(res.rows.length);
  });

  it('honours a smaller data.limit', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(50));
    expect(list(gas, { limit: 10 }).rows).toHaveLength(10);
  });

  it('reports the full total even when a small data.limit was asked for', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(50));
    expect(list(gas, { limit: 10 }).total).toBe(50);
  });

  it('returns everything when the sheet is smaller than the limit asked for', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(12));
    const res = list(gas, { limit: 400 });
    expect(res.rows).toHaveLength(12);
    expect(res.total).toBe(12);
  });

  it('caps the limit at 2000 even when the caller asks for 5000', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(2500));
    expect(list(gas, { limit: 5000 }).rows).toHaveLength(2000);
  });

  it('still reports the true total when the 2000 cap truncated the result', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(2500));
    expect(list(gas, { limit: 5000 }).total).toBe(2500);
  });

  it('caps an absurd limit at 2000 too, rather than returning the whole sheet', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(2500));
    expect(list(gas, { limit: 999999 }).rows).toHaveLength(2000);
  });

  it('keeps a truncated result in sheet order, each row newer than the one before', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(600));
    const titles = list(gas).rows.map((r) => r[3]);
    const sorted = titles.slice().sort();
    expect(titles).toEqual(sorted);
  });

  it('returns a contiguous run of the sheet when truncated, not a scattered sample', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(600));
    const titles = list(gas).rows.map((r) => r[3]);
    const firstIndex = Number(titles[0].slice(4));
    const expected = [];
    for (let i = 0; i < titles.length; i++) expected.push(`Job ${String(firstIndex + i).padStart(5, '0')}`);
    expect(titles).toEqual(expected);
  });
});

/* ========================================================================
   5. SINCE
   The Date column holds "M/d/yyyy" strings written by clevalServerRow_.
   data.since is an ISO date string. Comparison must be by CALENDAR DAY, not by
   timestamp, or the filter silently shifts by a day depending on the server's
   timezone offset.
   ===================================================================== */
describe('listCLEval: filtering by data.since on the Date column', () => {
  const spread = [
    clevalRow({ title: 'june-01', date: dateCell(2026, 6, 1) }),
    clevalRow({ title: 'june-30', date: dateCell(2026, 6, 30) }),
    clevalRow({ title: 'july-14', date: dateCell(2026, 7, 14) }),
    clevalRow({ title: 'july-15', date: dateCell(2026, 7, 15) }),
    clevalRow({ title: 'july-16', date: dateCell(2026, 7, 16) }),
    clevalRow({ title: 'july-31', date: dateCell(2026, 7, 31) }),
  ];

  it('drops every row dated before the since date', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    const titles = list(gas, { since: '2026-07-15' }).rows.map((r) => r[3]);
    expect(titles).not.toContain('june-01');
    expect(titles).not.toContain('june-30');
    expect(titles).not.toContain('july-14');
  });

  it('keeps every row dated after the since date', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    const titles = list(gas, { since: '2026-07-15' }).rows.map((r) => r[3]);
    expect(titles).toContain('july-16');
    expect(titles).toContain('july-31');
  });

  it('keeps a row dated on the since day itself, so the boundary is inclusive', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    const titles = list(gas, { since: '2026-07-15' }).rows.map((r) => r[3]);
    expect(titles).toContain('july-15');
  });

  it('returns exactly the matching rows, still in sheet order', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    expect(list(gas, { since: '2026-07-15' }).rows.map((r) => r[3]))
      .toEqual(['july-15', 'july-16', 'july-31']);
  });

  it('counts only the matching rows in total, not the whole sheet', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    expect(list(gas, { since: '2026-07-15' }).total).toBe(3);
  });

  it('returns nothing when the since date is after every row on the sheet', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    const res = list(gas, { since: '2027-01-01' });
    expect(res.ok).toBe(true);
    expect(res.rows).toEqual([]);
    expect(res.total).toBe(0);
  });

  it('returns the whole sheet when since is older than every row', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    expect(list(gas, { since: '2020-01-01' }).rows).toHaveLength(6);
  });

  it('returns the whole sheet when since is not given at all', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    expect(list(gas).rows).toHaveLength(6);
  });

  it('applies since and limit together', () => {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, spread);
    const res = list(gas, { since: '2026-07-15', limit: 2 });
    expect(res.rows).toHaveLength(2);
    expect(res.total).toBe(3);
  });
});

/* ========================================================================
   6. IT MUST NOT WRITE
   The seat gate and the job history share one script. readQueue_(true) releases
   a stale holder and appends an AUTO_RELEASE row. A read that reaches that path
   takes the Upwork profile away from whoever is mid-bid, and does it outside
   the lock. listCLEval must touch nothing.
   ===================================================================== */
describe('listCLEval: reading the history must not change anything', () => {
  function primed() {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ action: 'login', name: 'Alice' });
    gas.handle_({ action: 'login', name: 'Bob' });     // Bob waits behind Alice
    seedCLEval(gas, manyRows(4));
    staleHeartbeat(gas);                                // Alice's tab looks crashed
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

  it('appends no row to CLEval itself', () => {
    const gas = primed();
    list(gas);
    expect(dataRows(gas, 'CLEval')).toHaveLength(4);
  });

  it('writes no idempotency ledger entry', () => {
    const gas = primed();
    list(gas);
    expect(dataRows(gas, '_Idempotency')).toHaveLength(0);
  });

  it('opens no session row', () => {
    const gas = primed();
    const before = dataRows(gas, 'Sessions').length;
    list(gas);
    expect(dataRows(gas, 'Sessions')).toHaveLength(before);
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
    list(gas, { since: '2026-01-01', limit: 3 });
    expect(snapshot(gas)).toBe(before);
  });
});

/* ========================================================================
   7. CALLING IT REPEATEDLY CHANGES NOTHING
   ===================================================================== */
describe('listCLEval: calling it over and over', () => {
  function primed() {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ action: 'login', name: 'Alice' });
    seedCLEval(gas, manyRows(6));
    staleHeartbeat(gas);
    return gas;
  }

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

  it('leaves every sheet byte-identical after ten calls', () => {
    const gas = primed();
    const before = snapshot(gas);
    for (let i = 0; i < 10; i++) list(gas);
    expect(snapshot(gas)).toBe(before);
  });

  it('still has the same holder seated after ten calls', () => {
    const gas = primed();
    for (let i = 0; i < 10; i++) list(gas);
    expect(seat(gas).holder).toBe('Alice');
  });

  it('piles up no log rows across ten calls', () => {
    const gas = primed();
    const before = dataRows(gas, 'ActivityLog').length;
    for (let i = 0; i < 10; i++) list(gas);
    expect(dataRows(gas, 'ActivityLog')).toHaveLength(before);
  });
});

/* ========================================================================
   8. IT MUST NOT TAKE THE SCRIPT LOCK
   A bulk read that grabs the gate lock stalls every login, logout and heartbeat
   in a 20 person team for as long as the read runs.
   ===================================================================== */
describe('listCLEval: the script lock', () => {
  it('does not take the script lock at all', () => {
    const gas = loadGasWeb({ logSecret: SECRET });
    seedCLEval(gas, manyRows(5));
    gas.lockCalls.wait = 0;
    gas.lockCalls.release = 0;

    gas.handle_({ action: 'listCLEval', secret: SECRET });

    expect(gas.lockCalls.wait).toBe(0);
  });

  it('does not release a lock it never took', () => {
    const gas = loadGasWeb({ logSecret: SECRET });
    seedCLEval(gas, manyRows(5));
    gas.lockCalls.wait = 0;
    gas.lockCalls.release = 0;

    gas.handle_({ action: 'listCLEval', secret: SECRET });

    expect(gas.lockCalls.release).toBe(0);
  });

  it('still returns the history while someone else is holding the gate lock', () => {
    const gas = loadGasWeb({ logSecret: SECRET });
    seedCLEval(gas, manyRows(5));
    // Seed first, then jam the lock: from here every waitLock() throws, which is
    // what a mid-login teammate looks like to a second request.
    gas.setLockBusy(true);

    const res = gas.handle_({ action: 'listCLEval', secret: SECRET });

    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(5);
  });

  it('a jammed gate lock never turns the history read into a "busy, try again" error', () => {
    const gas = loadGasWeb({ logSecret: SECRET });
    seedCLEval(gas, manyRows(5));
    gas.setLockBusy(true);

    const res = gas.handle_({ action: 'listCLEval', secret: SECRET });

    expect(res.error).toBeUndefined();
  });
});

/* ========================================================================
   9. IT MUST BE POST ONLY
   ===================================================================== */
describe('listCLEval over GET', () => {
  function primedWeb() {
    const gas = loadGasWeb({ logSecret: SECRET });
    seedCLEval(gas, manyRows(4));
    return gas;
  }

  it('is refused when reached with a GET', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listCLEval' } }));
    expect(res.ok).toBe(false);
  });

  it('says the action requires POST', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listCLEval' } }));
    expect(res.error).toBe('This action requires POST.');
  });

  it('leaks no rows over GET', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listCLEval' } }));
    expect(res.rows).toBeUndefined();
  });

  it('leaks no headers over GET', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listCLEval' } }));
    expect(res.headers).toBeUndefined();
  });

  it('is refused over GET even when the correct secret is put in the query string', () => {
    const gas = primedWeb();
    const res = payload(gas.doGet({ parameter: { action: 'listCLEval', secret: SECRET } }));
    expect(res.ok).toBe(false);
    expect(res.rows).toBeUndefined();
  });

  it('is listed in POST_ONLY in Code.gs, so no future action name slips past the router', () => {
    const postOnly = CODE_GS.match(/var POST_ONLY\s*=\s*\{[\s\S]*?\}/)[0];
    expect(postOnly).toMatch(/listCLEval/);
  });

  it('changes nothing on any sheet when refused over GET', () => {
    const gas = primedWeb();
    const before = snapshot(gas);
    gas.doGet({ parameter: { action: 'listCLEval', secret: SECRET } });
    expect(snapshot(gas)).toBe(before);
  });

  it('is served normally over POST', () => {
    const gas = primedWeb();
    const res = payload(gas.doPost({ postData: { contents: JSON.stringify({ action: 'listCLEval', secret: SECRET }) } }));
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(4);
  });
});

/* ========================================================================
   10. IT MUST REQUIRE THE SHARED SECRET
   This is the one that stops the whole job history, every client, every bid and
   every reason, leaking to anyone who finds the /exec URL.
   ===================================================================== */
describe('listCLEval: the shared-secret gate', () => {
  // A server that DOES have the secret configured, and a sheet with real rows on
  // it, so a refusal is genuinely a refusal and not an empty sheet.
  function primed() {
    const gas = loadGas({ logSecret: SECRET });
    seedCLEval(gas, manyRows(4));
    return gas;
  }

  it('rejects a request that carries no secret', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval' });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('returns no rows when the secret is missing', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval' });
    expect(res.rows).toBeUndefined();
  });

  it('returns no headers when the secret is missing', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval' });
    expect(res.headers).toBeUndefined();
  });

  it('does not even leak the row count when the secret is missing', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval' });
    expect(res.total).toBeUndefined();
  });

  it('rejects a wrong secret', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval', secret: 'not-the-secret' });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('rejects an empty-string secret', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval', secret: '' });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('does not accept a secret that is merely a prefix of the real one', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval', secret: SECRET.slice(0, -1) });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('does not fall back to a no-op success that hides the refusal', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval', secret: 'not-the-secret' });
    expect(res.ok).not.toBe(true);
    expect(res.note).toBeUndefined();
  });

  it('fails closed when the server has no LOG_SECRET configured, even if a secret is sent', () => {
    const gas = loadGas({}); // LOG_SECRET unset
    const res = gas.handle_({ action: 'listCLEval', secret: SECRET });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('writes nothing when it refuses an unauthorized read', () => {
    const gas = primed();
    const before = snapshot(gas);
    gas.handle_({ action: 'listCLEval', secret: 'not-the-secret' });
    expect(snapshot(gas)).toBe(before);
  });

  it('accepts the exact secret and returns the history', () => {
    const gas = primed();
    const res = gas.handle_({ action: 'listCLEval', secret: SECRET });
    expect(res.ok).toBe(true);
    expect(res.rows).toHaveLength(4);
  });
});
