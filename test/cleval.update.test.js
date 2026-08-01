// Backend tests for the NEW "updateCLEvalStatus" action in Code.gs, driven
// through loadGas().handle_().
//
// What this action must do: take an evaluationId, find the CLEval row that
// evaluationId already wrote (via idemFind_), and change column 25, the live
// "Ptoposal Status" header (yes, the typo is the real header). It EDITS IN
// PLACE. It must never append a row, never touch a different row, never write
// a status outside the allowed set, and never run without the shared secret or
// without the script lock.
//
// Every row here is seeded by driving REAL logCLEval calls, so the CLEval rows
// and the hidden _Idempotency ledger are populated exactly the way production
// populates them. Nothing here touches a live Google resource.
//
// Harness note on the lock: loadGas()'s LockService mock is a no-op that
// records nothing, so lock acquisition cannot be observed from behaviour. This
// file therefore pins it the way test/gate.safety.test.js pins GET
// reachability: by reading the declaration straight out of Code.gs.
//
// A failing test in this file is not a broken test. It is the specification.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGas } from './loadGas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_GS = readFileSync(join(__dirname, '..', 'Code.gs'), 'utf8');

const SECRET = 'cleval-update-secret';

/* Column 25 of the 25-column CLEval sheet. Live header: "Ptoposal Status". */
const STATUS_COL = 25;

const ALLOWED = ['Not checked', 'No response', 'Opened', 'Replied', 'Interview', 'Hired', 'Lost'];
/* The value the server has been writing all along, and the value sitting in 664
   live rows. It is NOT an allowed new status, it is the legacy spelling of
   "Not checked" and must keep working when it is read. */
const LEGACY = 'Un Opened';

/* ---------- helpers ---------- */

// loadGas()'s mock Range implements setValues() and setRichTextValue() but not
// the single-cell setValue(), which is a perfectly legal Apps Script call for a
// one-cell edit like this one. This teaches the mock that one method, in this
// file only, so the tests below exercise the update's behaviour instead of the
// mock's API coverage. Nothing else about the harness is changed.
const SHIMMED = new WeakSet();
function shimSetValue(gas) {
  Object.keys(gas.sheets).forEach((tab) => {
    const s = gas.sheets[tab];
    if (SHIMMED.has(s)) return;
    SHIMMED.add(s);
    const origGetRange = s.getRange;
    s.getRange = function (r, c, nr, nc) {
      const range = origGetRange.call(s, r, c, nr, nc);
      if (typeof range.setValue !== 'function') {
        range.setValue = function (v) { range.setValues([[v]]); return range; };
      }
      return range;
    };
  });
}

// Data rows (header excluded) of a tab that may never have been created.
function dataRows(gas, tab) {
  const s = gas.sheets[tab];
  return s ? s._rows.slice(1) : [];
}

function statusAt(gas, rowNumber) {
  const r = (gas.sheets.CLEval && gas.sheets.CLEval._rows[rowNumber - 1]) || [];
  return r[STATUS_COL - 1];
}

// Whole-sheet fingerprint, so "nothing else moved" is a real assertion rather
// than a spot check of one cell.
function snapshot(gas, tab) {
  return JSON.stringify(dataRows(gas, tab));
}

function ledgerFor(gas, evId) {
  return dataRows(gas, '_Idempotency').filter((r) => String(r[0]) === String(evId));
}

// Seed one CLEval row the way the app does it: a real logCLEval write, which
// also populates the _Idempotency ledger entry that idemFind_ reads.
function seed(gas, evId, row, name = 'Usman Saeed') {
  const res = gas.handle_({
    action: 'logCLEval', secret: SECRET, evaluationId: evId, name, row,
  });
  if (!res || res.ok !== true) throw new Error('seeding failed: ' + JSON.stringify(res));
  shimSetValue(gas);
  return res.row; // 1-based sheet row number
}

// Sentinel for "the request carries no secret field at all", which is different
// from carrying an empty one.
const NO_SECRET = Symbol('no secret sent');

function update(gas, data, secret = SECRET) {
  shimSetValue(gas);
  const req = { action: 'updateCLEvalStatus', ...data };
  if (secret !== NO_SECRET) req.secret = secret;
  return gas.handle_(req);
}

// Run an update that may either return {ok:false} or throw, and report both the
// same way, so a test can assert on the sheet without caring which it did.
function attempt(gas, data) {
  try {
    return { threw: false, res: update(gas, data) };
  } catch (e) {
    return { threw: true, error: e };
  }
}

const JOB_A = { jobTitle: 'n8n AI Automation Expert', jobLink: 'https://www.upwork.com/jobs/~022078430146547204560', applied: 'Yes' };
const JOB_B = { jobTitle: 'Build AI Voice Assistant Mobile App MVP', jobLink: 'https://www.upwork.com/jobs/~019988776655443322110', applied: 'No' };
const JOB_C = { jobTitle: 'RAG Chatbot For Internal Docs', jobLink: 'https://www.upwork.com/jobs/~011223344556677889900', applied: 'Yes' };

// Three seeded rows, the ordinary shape of the sheet mid-shift.
function threeRows(gas) {
  return {
    a: seed(gas, 'ev_a', JOB_A, 'Usman Saeed'),
    b: seed(gas, 'ev_b', JOB_B, 'Waqas Riaz'),
    c: seed(gas, 'ev_c', JOB_C, 'Sadia'),
  };
}

// Break the next sheet write, the way a dying Apps Script execution does: the
// range is handed out, the write itself dies. Reads are left alone.
function failNextSheetWrite(gas, tab = 'CLEval') {
  const s = gas.sheets[tab];
  const origGetRange = s.getRange;
  let armed = true;
  s.getRange = function (r, c, nr, nc) {
    const range = origGetRange.call(s, r, c, nr, nc);
    const die = () => {
      armed = false;
      s.getRange = origGetRange; // only the first write dies
      throw new Error('simulated sheet write failure');
    };
    const realSet = range.setValues.bind(range);
    range.setValues = function (v) { return armed ? die() : realSet(v); };
    const realRich = range.setRichTextValue.bind(range);
    range.setRichTextValue = function (v) { return armed ? die() : realRich(v); };
    return range;
  };
}

// Skip the first N sheet writes, then break the next one: used to prove a
// partly-applied update never leaves a row with a new status and no record of
// when it changed.
function failSheetWriteNumber(gas, n, tab = 'CLEval') {
  const s = gas.sheets[tab];
  const origGetRange = s.getRange;
  let seen = 0;
  s.getRange = function (r, c, nr, nc) {
    const range = origGetRange.call(s, r, c, nr, nc);
    const realSet = range.setValues.bind(range);
    range.setValues = function (v) {
      seen += 1;
      if (seen === n) throw new Error('simulated sheet write failure on write #' + n);
      return realSet(v);
    };
    return range;
  };
}

// Every timestamp-looking value anywhere in the mock spreadsheet. Used to prove
// the change time was recorded at update time without dictating WHERE the
// implementation records it.
function allTimestamps(gas) {
  const out = [];
  Object.keys(gas.sheets).forEach((tab) => {
    gas.sheets[tab]._rows.forEach((row) => {
      (row || []).forEach((cell) => {
        if (cell instanceof Date) { out.push(cell.getTime()); return; }
        if (typeof cell === 'string' && /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(cell)) {
          const t = Date.parse(cell);
          if (!Number.isNaN(t)) out.push(t);
        }
      });
    });
  });
  return out;
}

const everything = (gas) => JSON.stringify(gas.sheets);

// Top-level functions of Code.gs, name -> source text, so the update handler can
// be inspected without guessing what it will be called.
function topLevelFunctions() {
  const marks = [];
  const re = /^function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  let m;
  while ((m = re.exec(CODE_GS))) marks.push({ name: m[1], start: m.index });
  return marks.map((mk, i) => ({
    name: mk.name,
    body: CODE_GS.slice(mk.start, i + 1 < marks.length ? marks[i + 1].start : CODE_GS.length),
  }));
}

// The dedicated handler(s) for the update, i.e. not the router and not the
// doGet/doPost wrappers.
function updateHandlerSource() {
  return topLevelFunctions()
    .filter((f) => ['handle_', 'doGet', 'doPost'].indexOf(f.name) === -1)
    .filter((f) => /updateCLEvalStatus|unknown evaluationId/.test(f.body))
    .map((f) => f.body)
    .join('\n');
}

afterEach(() => { vi.useRealTimers(); });

/* ========================================================================
   1. THE HAPPY PATH: a known evaluationId edits its own row
   ===================================================================== */
describe('updateCLEvalStatus: updating a row that exists', () => {
  it('sets column 25, the "Ptoposal Status" cell, to the new status', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Opened' });

    expect(statusAt(gas, rowNo)).toBe('Opened');
  });

  it('reports success', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    expect(update(gas, { evaluationId: 'ev_a', status: 'Opened' }).ok).toBe(true);
  });

  it('tells the caller which sheet row it changed', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    expect(update(gas, { evaluationId: 'ev_a', status: 'Opened' }).row).toBe(rowNo);
  });

  it('echoes back the status it stored', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    expect(update(gas, { evaluationId: 'ev_a', status: 'Replied' }).status).toBe('Replied');
  });

  it('changes nothing else in the row it edits, only the status cell', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);
    const before = gas.sheets.CLEval._rows[rowNo - 1].slice(0, STATUS_COL - 1);

    update(gas, { evaluationId: 'ev_a', status: 'Interview' });

    const after = gas.sheets.CLEval._rows[rowNo - 1].slice(0, STATUS_COL - 1);
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('keeps the job title and the clickable job link intact', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Hired' });

    const row = gas.sheets.CLEval._rows[rowNo - 1];
    expect(row[3]).toBe(JOB_A.jobTitle);
    expect(row[4]).toMatchObject({ text: 'URL', link: JOB_A.jobLink });
  });

  it('does not widen the sheet past its 25 live columns', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Lost' });

    expect(gas.sheets.CLEval._rows[rowNo - 1].length).toBe(25);
    expect(gas.sheets.CLEval._rows[0].length).toBe(25);
  });

  ALLOWED.forEach((status) => {
    it(`accepts the allowed status "${status}"`, () => {
      const gas = loadGas({ logSecret: SECRET });
      const rowNo = seed(gas, 'ev_a', JOB_A);

      const res = update(gas, { evaluationId: 'ev_a', status });

      expect(res.ok).toBe(true);
      expect(statusAt(gas, rowNo)).toBe(status);
    });
  });
});

/* ========================================================================
   2. AN UPDATE IS AN EDIT, NEVER AN APPEND
   The whole point of this action is that it edits the row in place. A row that
   grows a second copy of itself every time someone marks it "Replied" is worse
   than no feature at all.
   ===================================================================== */
describe('updateCLEvalStatus: it edits in place and never appends', () => {
  it('leaves the sheet with exactly the rows that were logged', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);

    update(gas, { evaluationId: 'ev_b', status: 'Opened' });

    expect(dataRows(gas, 'CLEval')).toHaveLength(3);
  });

  it('still has three rows after every one of them is updated', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);

    update(gas, { evaluationId: 'ev_a', status: 'Opened' });
    update(gas, { evaluationId: 'ev_b', status: 'Replied' });
    update(gas, { evaluationId: 'ev_c', status: 'Lost' });

    expect(dataRows(gas, 'CLEval')).toHaveLength(3);
  });

  it('does not append even when the same row is updated many times', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    ['Opened', 'Replied', 'Interview', 'Hired'].forEach((s) => update(gas, { evaluationId: 'ev_a', status: s }));

    expect(dataRows(gas, 'CLEval')).toHaveLength(1);
  });

  it('does not add a second ledger entry for an evaluationId it updates', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Opened' });
    update(gas, { evaluationId: 'ev_a', status: 'Hired' });

    expect(ledgerFor(gas, 'ev_a')).toHaveLength(1);
  });
});

/* ========================================================================
   3. IT MUST HIT THE RIGHT ROW
   ===================================================================== */
describe('updateCLEvalStatus: picking the correct row out of several', () => {
  it('updates the middle row when asked for the middle row', () => {
    const gas = loadGas({ logSecret: SECRET });
    const r = threeRows(gas);

    update(gas, { evaluationId: 'ev_b', status: 'Interview' });

    expect(statusAt(gas, r.b)).toBe('Interview');
  });

  it('leaves the row above it untouched', () => {
    const gas = loadGas({ logSecret: SECRET });
    const r = threeRows(gas);
    const before = JSON.stringify(gas.sheets.CLEval._rows[r.a - 1]);

    update(gas, { evaluationId: 'ev_b', status: 'Interview' });

    expect(JSON.stringify(gas.sheets.CLEval._rows[r.a - 1])).toBe(before);
  });

  it('leaves the row below it untouched', () => {
    const gas = loadGas({ logSecret: SECRET });
    const r = threeRows(gas);
    const before = JSON.stringify(gas.sheets.CLEval._rows[r.c - 1]);

    update(gas, { evaluationId: 'ev_b', status: 'Interview' });

    expect(JSON.stringify(gas.sheets.CLEval._rows[r.c - 1])).toBe(before);
  });

  it('leaves both neighbours still showing the legacy default status', () => {
    const gas = loadGas({ logSecret: SECRET });
    const r = threeRows(gas);

    update(gas, { evaluationId: 'ev_b', status: 'Hired' });

    expect(statusAt(gas, r.a)).toBe(LEGACY);
    expect(statusAt(gas, r.c)).toBe(LEGACY);
  });

  it('returns the row number of the row it actually edited', () => {
    const gas = loadGas({ logSecret: SECRET });
    const r = threeRows(gas);

    const res = update(gas, { evaluationId: 'ev_c', status: 'Lost' });

    expect(res.row).toBe(r.c);
    expect(statusAt(gas, r.c)).toBe('Lost');
  });

  it('matches on the evaluationId, not on the job link, when two rows share a link', () => {
    const gas = loadGas({ logSecret: SECRET });
    const first = seed(gas, 'ev_dup_1', JOB_A, 'Usman Saeed');
    const second = seed(gas, 'ev_dup_2', JOB_A, 'Sadia');

    update(gas, { evaluationId: 'ev_dup_2', status: 'Replied' });

    expect(statusAt(gas, second)).toBe('Replied');
    expect(statusAt(gas, first)).toBe(LEGACY);
  });

  it('updates the first row correctly even after later rows exist', () => {
    const gas = loadGas({ logSecret: SECRET });
    const r = threeRows(gas);

    update(gas, { evaluationId: 'ev_a', status: 'No response' });

    expect(statusAt(gas, r.a)).toBe('No response');
    expect(statusAt(gas, r.b)).toBe(LEGACY);
    expect(statusAt(gas, r.c)).toBe(LEGACY);
  });
});

/* ========================================================================
   4. AN UNKNOWN evaluationId
   ===================================================================== */
describe('updateCLEvalStatus: an evaluationId nobody has ever logged', () => {
  it('refuses with a clear "unknown evaluationId" error', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);

    expect(update(gas, { evaluationId: 'ev_never_written', status: 'Opened' }))
      .toEqual({ ok: false, error: 'unknown evaluationId' });
  });

  it('changes no status on any existing row', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);
    const before = snapshot(gas, 'CLEval');

    update(gas, { evaluationId: 'ev_never_written', status: 'Opened' });

    expect(snapshot(gas, 'CLEval')).toBe(before);
  });

  it('appends no CLEval row for the id it could not find', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);

    update(gas, { evaluationId: 'ev_never_written', status: 'Opened' });

    expect(dataRows(gas, 'CLEval')).toHaveLength(3);
  });

  it('leaves no ledger entry behind for the unknown id', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);

    update(gas, { evaluationId: 'ev_never_written', status: 'Opened' });

    expect(ledgerFor(gas, 'ev_never_written')).toHaveLength(0);
  });

  it('refuses when no CLEval sheet exists at all yet, and creates no rows', () => {
    const gas = loadGas({ logSecret: SECRET });

    const res = update(gas, { evaluationId: 'ev_never_written', status: 'Opened' });

    expect(res.ok).toBe(false);
    expect(dataRows(gas, 'CLEval')).toHaveLength(0);
  });

  it('refuses a missing evaluationId', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);
    const before = snapshot(gas, 'CLEval');

    const res = update(gas, { status: 'Opened' });

    expect(res.ok).toBe(false);
    expect(snapshot(gas, 'CLEval')).toBe(before);
  });

  it('refuses an empty evaluationId instead of guessing a row', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);
    const before = snapshot(gas, 'CLEval');

    const res = update(gas, { evaluationId: '', status: 'Opened' });

    expect(res.ok).toBe(false);
    expect(snapshot(gas, 'CLEval')).toBe(before);
  });
});

/* ========================================================================
   5. UPDATING TWICE
   ===================================================================== */
describe('updateCLEvalStatus: updating the same row more than once', () => {
  it('keeps the last status that was set', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Opened' });
    update(gas, { evaluationId: 'ev_a', status: 'Hired' });

    expect(statusAt(gas, rowNo)).toBe('Hired');
  });

  it('reports success on the second update too', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Opened' });

    expect(update(gas, { evaluationId: 'ev_a', status: 'Hired' }).ok).toBe(true);
  });

  it('keeps pointing at the same row on the second update', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    const first = update(gas, { evaluationId: 'ev_a', status: 'Opened' });
    const second = update(gas, { evaluationId: 'ev_a', status: 'Lost' });

    expect(first.row).toBe(rowNo);
    expect(second.row).toBe(rowNo);
  });

  it('setting the same status twice is harmless', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Replied' });
    const again = update(gas, { evaluationId: 'ev_a', status: 'Replied' });

    expect(again.ok).toBe(true);
    expect(statusAt(gas, rowNo)).toBe('Replied');
    expect(dataRows(gas, 'CLEval')).toHaveLength(1);
  });

  it('a status can be walked all the way down the funnel', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    ['Opened', 'Replied', 'Interview', 'Hired'].forEach((s) => update(gas, { evaluationId: 'ev_a', status: s }));

    expect(statusAt(gas, rowNo)).toBe('Hired');
  });

  it('a mistake can be corrected back to "Not checked"', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Hired' });
    update(gas, { evaluationId: 'ev_a', status: 'Not checked' });

    expect(statusAt(gas, rowNo)).toBe('Not checked');
  });
});

/* ========================================================================
   6. THE CHANGE TIME
   Fake timers are used so the seed happens an hour before the update: any
   timestamp the sheet holds from the update must therefore be the update's own,
   not the one the row was logged with.
   ===================================================================== */
describe('updateCLEvalStatus: recording when the status changed', () => {
  const T0 = new Date('2026-07-31T06:00:00.000Z').getTime();
  const T1 = T0 + 60 * 60 * 1000; // one hour later

  it('records a change time taken at the moment of the update', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);
    expect(Math.max(...allTimestamps(gas))).toBeLessThan(T1);

    vi.setSystemTime(T1);
    update(gas, { evaluationId: 'ev_a', status: 'Opened' });

    expect(Math.max(...allTimestamps(gas))).toBeGreaterThanOrEqual(T1);
  });

  it('moves the change time forward again on a later update', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    vi.setSystemTime(T1);
    update(gas, { evaluationId: 'ev_a', status: 'Opened' });
    const T2 = T1 + 60 * 60 * 1000;
    vi.setSystemTime(T2);
    update(gas, { evaluationId: 'ev_a', status: 'Hired' });

    expect(Math.max(...allTimestamps(gas))).toBeGreaterThanOrEqual(T2);
  });

  it('records no change time for an update it refused', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    vi.setSystemTime(T1);
    update(gas, { evaluationId: 'ev_not_a_real_id', status: 'Opened' });

    expect(Math.max(...allTimestamps(gas))).toBeLessThan(T1);
  });

  it('still records the change time when the caller supplies its own "at"', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    vi.setSystemTime(T1);
    const res = update(gas, { evaluationId: 'ev_a', status: 'Opened', at: new Date(T1).toISOString() });

    expect(res.ok).toBe(true);
    expect(statusAt(gas, rowNo)).toBe('Opened');
    expect(Math.max(...allTimestamps(gas))).toBeGreaterThanOrEqual(T1);
  });
});

/* ========================================================================
   7. A STATUS OUTSIDE THE ALLOWED SET
   Allowed: Not checked, No response, Opened, Replied, Interview, Hired, Lost.
   Anything else is a typo, a stale build, or an injection attempt, and none of
   those may reach the sheet the whole team reads.
   ===================================================================== */
describe('updateCLEvalStatus: a status that is not one of the seven allowed values', () => {
  const REJECTED = [
    ['a status nobody defined', 'Ghosted'],
    ['a near miss of a real status', 'Interviewing'],
    ['an empty status', ''],
    ['a number instead of a status', 42],
    ['a spreadsheet formula smuggled in as a status', '=HYPERLINK("http://evil.example","Hired")'],
    ['a whole sentence pasted into the status', 'Client said they would get back to us next week'],
  ];

  REJECTED.forEach(([label, bad]) => {
    it(`refuses ${label}`, () => {
      const gas = loadGas({ logSecret: SECRET });
      seed(gas, 'ev_a', JOB_A);

      const res = update(gas, { evaluationId: 'ev_a', status: bad });

      expect(res.ok).toBe(false);
    });

    it(`writes nothing to the row when given ${label}`, () => {
      const gas = loadGas({ logSecret: SECRET });
      const rowNo = seed(gas, 'ev_a', JOB_A);
      const before = snapshot(gas, 'CLEval');

      update(gas, { evaluationId: 'ev_a', status: bad });

      expect(statusAt(gas, rowNo)).toBe(LEGACY);
      expect(snapshot(gas, 'CLEval')).toBe(before);
    });
  });

  it('refuses an update with no status at all', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    const res = update(gas, { evaluationId: 'ev_a' });

    expect(res.ok).toBe(false);
    expect(statusAt(gas, rowNo)).toBe(LEGACY);
  });

  it('says what went wrong, naming the status', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    const res = update(gas, { evaluationId: 'ev_a', status: 'Ghosted' });

    expect(typeof res.error).toBe('string');
    expect(res.error).toMatch(/status/i);
  });

  it('does not report a bad status as "unknown evaluationId"', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    const res = update(gas, { evaluationId: 'ev_a', status: 'Ghosted' });

    expect(res.error).not.toMatch(/unknown evaluationId/);
  });

  it('a rejected status does not undo the status that was already there', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);
    update(gas, { evaluationId: 'ev_a', status: 'Interview' });

    update(gas, { evaluationId: 'ev_a', status: 'Ghosted' });

    expect(statusAt(gas, rowNo)).toBe('Interview');
  });

  it('a rejected status appends no row', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Ghosted' });

    expect(dataRows(gas, 'CLEval')).toHaveLength(1);
  });
});

/* ========================================================================
   8. THE LEGACY "Un Opened" VALUE
   664 live rows hold it, and the server has been writing it as the default all
   along. It is the old spelling of "Not checked". Reading it must not blow up,
   and a legacy row must be updatable like any other.
   ===================================================================== */
describe('updateCLEvalStatus: rows still holding the legacy "Un Opened" value', () => {
  it('a freshly logged row starts on the legacy value, which is why this matters', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    expect(statusAt(gas, rowNo)).toBe(LEGACY);
  });

  it('updating a legacy row does not crash', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    expect(() => update(gas, { evaluationId: 'ev_a', status: 'Opened' })).not.toThrow();
  });

  it('updating a legacy row works normally', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    const res = update(gas, { evaluationId: 'ev_a', status: 'Replied' });

    expect(res.ok).toBe(true);
    expect(statusAt(gas, rowNo)).toBe('Replied');
  });

  it('a legacy row can be moved to "Not checked", the value it already meant', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    const res = update(gas, { evaluationId: 'ev_a', status: 'Not checked' });

    expect(res.ok).toBe(true);
    expect(statusAt(gas, rowNo)).toBe('Not checked');
  });

  it('the legacy spelling is gone from the cell once the row is updated', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Not checked' });

    expect(statusAt(gas, rowNo)).not.toBe(LEGACY);
  });

  it('a legacy row hand-written into an older sheet updates the same way', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);
    gas.sheets.CLEval._rows[rowNo - 1][STATUS_COL - 1] = LEGACY; // exactly what the 664 rows hold

    const res = update(gas, { evaluationId: 'ev_a', status: 'Hired' });

    expect(res.ok).toBe(true);
    expect(statusAt(gas, rowNo)).toBe('Hired');
  });

  it('updating one legacy row leaves the other legacy rows alone', () => {
    const gas = loadGas({ logSecret: SECRET });
    const r = threeRows(gas);

    update(gas, { evaluationId: 'ev_b', status: 'Opened' });

    expect(statusAt(gas, r.a)).toBe(LEGACY);
    expect(statusAt(gas, r.c)).toBe(LEGACY);
  });

  it('the legacy value counts as not checked, so moving a legacy row to "Not checked" is not refused as a no-op', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    const res = update(gas, { evaluationId: 'ev_a', status: 'Not checked' });

    expect(res).toMatchObject({ ok: true, status: 'Not checked' });
  });
});

/* ========================================================================
   9. AUTHORISATION AND METHOD
   ===================================================================== */
describe('updateCLEvalStatus: shared secret and POST', () => {
  it('is declared POST only, so a link or a prefetch cannot change a status', () => {
    const postOnly = CODE_GS.match(/var POST_ONLY\s*=\s*\{[\s\S]*?\}/)[0];
    expect(postOnly).toMatch(/updateCLEvalStatus/);
  });

  it('rejects a request with no secret', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    expect(update(gas, { evaluationId: 'ev_a', status: 'Opened' }, NO_SECRET))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('changes nothing when the secret is missing', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Opened' }, NO_SECRET);

    expect(statusAt(gas, rowNo)).toBe(LEGACY);
  });

  it('rejects a wrong secret', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    expect(update(gas, { evaluationId: 'ev_a', status: 'Opened' }, 'not-the-secret'))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('changes nothing when the secret is wrong', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    update(gas, { evaluationId: 'ev_a', status: 'Opened' }, 'not-the-secret');

    expect(statusAt(gas, rowNo)).toBe(LEGACY);
  });

  it('rejects an empty-string secret', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    const res = update(gas, { evaluationId: 'ev_a', status: 'Opened' }, '');

    expect(res.ok).toBe(false);
    expect(statusAt(gas, rowNo)).toBe(LEGACY);
  });

  it('fails closed when the server has no LOG_SECRET configured', () => {
    const gas = loadGas({}); // LOG_SECRET unset
    expect(update(gas, { evaluationId: 'ev_a', status: 'Opened' }))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('checks the secret before it looks the evaluationId up', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);

    const res = update(gas, { evaluationId: 'ev_never_written', status: 'Opened' }, 'not-the-secret');

    expect(res).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('an unauthorised attempt leaves the whole spreadsheet byte for byte identical', () => {
    const gas = loadGas({ logSecret: SECRET });
    threeRows(gas);
    const before = everything(gas);

    update(gas, { evaluationId: 'ev_a', status: 'Hired' }, 'not-the-secret');

    expect(everything(gas)).toBe(before);
  });
});

/* ========================================================================
   10. THE SCRIPT LOCK
   Two people marking two different jobs at the same second must not read and
   rewrite the same range on top of each other. The mock LockService records
   nothing, so this is pinned against the Code.gs source, the same way
   gate.safety.test.js pins GET reachability.
   ===================================================================== */
describe('updateCLEvalStatus: it runs under the script lock', () => {
  it('lives in its own handler rather than inline in the router', () => {
    expect(updateHandlerSource()).not.toBe('');
  });

  it('takes the script lock', () => {
    expect(updateHandlerSource()).toMatch(/LockService\.getScriptLock\(\)/);
  });

  it('waits for the lock instead of writing without it', () => {
    expect(updateHandlerSource()).toMatch(/waitLock\(/);
  });

  it('releases the lock', () => {
    expect(updateHandlerSource()).toMatch(/releaseLock\(/);
  });

  it('releases the lock in a finally, so a failed update cannot wedge the sheet', () => {
    const src = updateHandlerSource();
    expect(src).toMatch(/finally/);
    expect(src.indexOf('finally')).toBeLessThan(src.lastIndexOf('releaseLock'));
  });
});

/* ========================================================================
   11. A FAILURE PART WAY THROUGH
   ===================================================================== */
describe('updateCLEvalStatus: when the sheet write itself fails', () => {
  it('leaves the row exactly as it was', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);
    const before = JSON.stringify(gas.sheets.CLEval._rows[rowNo - 1]);
    failNextSheetWrite(gas);

    attempt(gas, { evaluationId: 'ev_a', status: 'Hired' });

    expect(JSON.stringify(gas.sheets.CLEval._rows[rowNo - 1])).toBe(before);
  });

  it('does not report success for a write that never landed', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);
    failNextSheetWrite(gas);

    const out = attempt(gas, { evaluationId: 'ev_a', status: 'Hired' });

    expect(out.threw || out.res.ok === false).toBe(true);
  });

  it('appends no row as a consolation prize when the edit fails', () => {
    const gas = loadGas({ logSecret: SECRET });
    seed(gas, 'ev_a', JOB_A);
    failNextSheetWrite(gas);

    attempt(gas, { evaluationId: 'ev_a', status: 'Hired' });

    expect(dataRows(gas, 'CLEval')).toHaveLength(1);
  });

  it('leaves the neighbouring rows untouched when a write fails', () => {
    const gas = loadGas({ logSecret: SECRET });
    const r = threeRows(gas);
    failNextSheetWrite(gas);

    attempt(gas, { evaluationId: 'ev_b', status: 'Hired' });

    expect(statusAt(gas, r.a)).toBe(LEGACY);
    expect(statusAt(gas, r.c)).toBe(LEGACY);
  });

  it('a retry after the failure clears has the intended effect, on the same one row', () => {
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);
    failNextSheetWrite(gas);
    attempt(gas, { evaluationId: 'ev_a', status: 'Hired' });

    const res = update(gas, { evaluationId: 'ev_a', status: 'Hired' });

    expect(res.ok).toBe(true);
    expect(statusAt(gas, rowNo)).toBe('Hired');
    expect(dataRows(gas, 'CLEval')).toHaveLength(1);
  });

  it('never leaves a row carrying a new status with no record of when it changed', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const T0 = new Date('2026-07-31T06:00:00.000Z').getTime();
    const T1 = T0 + 60 * 60 * 1000;
    vi.setSystemTime(T0);
    const gas = loadGas({ logSecret: SECRET });
    const rowNo = seed(gas, 'ev_a', JOB_A);

    vi.setSystemTime(T1);
    failSheetWriteNumber(gas, 2); // the status lands, the second write dies
    attempt(gas, { evaluationId: 'ev_a', status: 'Hired' });

    if (statusAt(gas, rowNo) === 'Hired') {
      expect(Math.max(...allTimestamps(gas))).toBeGreaterThanOrEqual(T1);
    } else {
      expect(statusAt(gas, rowNo)).toBe(LEGACY);
    }
  });
});
