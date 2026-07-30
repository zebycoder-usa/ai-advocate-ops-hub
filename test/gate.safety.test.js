// Seat-gate safety tests for Code.gs, driven through loadGas().handle_().
//
// Every test here asserts the SAFE behaviour, i.e. what the gate MUST do for the
// shared Upwork profile to stay single-occupancy and for the log to stay honest.
// A failing test in this file is not a broken test: it is the proof that the
// defect it names is live in Code.gs today. Never relax an assertion to go green.
//
// Harness note: loadGas() only exports handle_(). doGet()/doPost() are not
// exported, so where a test needs the GET path it drives handle_() with exactly
// the object doGet() forwards (doGet does `return json_(handle_(p))` for any
// action not listed in POST_ONLY), and pins GET-reachability separately by
// reading the POST_ONLY declaration out of the source.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGas } from './loadGas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_GS = readFileSync(join(__dirname, '..', 'Code.gs'), 'utf8');

/* ---------- helpers ---------- */

// Read the Queue tab back the way readQueue_ parses it, straight from the mock
// sheet, so a test observes persisted state rather than a returned object.
function seat(gas) {
  const r = (gas.sheets.Queue && gas.sheets.Queue._rows[1]) || [];
  return {
    holder: r[0] || null,
    holderSince: r[1] || null,
    waiting: r[2] ? String(r[2]).split(' || ').filter(Boolean).map((x) => x.split('|')[0]) : [],
    pendingOffer: r[3] || null,
    holderHeartbeat: r[5] || null,
  };
}

// Data rows (header excluded) of a tab that may not have been created yet.
function dataRows(gas, tab) {
  const s = gas.sheets[tab];
  return s ? s._rows.slice(1) : [];
}

function typesLogged(gas) {
  return dataRows(gas, 'ActivityLog').map((r) => r[2]);
}

const login = (gas, name) => gas.handle_({ action: 'login', name });
const logout = (gas, name) => gas.handle_({ action: 'logout', name });
const accept = (gas, name) => gas.handle_({ action: 'gateAccept', name });
const decline = (gas, name) => gas.handle_({ action: 'gateDecline', name });

// Age the holder's heartbeat past STALE_MS (12 min) by editing the persisted
// Queue row, which is the same state a crashed tab would leave behind.
function staleHeartbeat(gas, minutesAgo = 30) {
  gas.sheets.Queue._rows[1][5] = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
}

/* ========================================================================
   1. UNAUTHORISED ACCEPT
   ===================================================================== */
describe('gate: an accept from someone who was never offered the seat', () => {
  it('does not make an unqueued stranger the holder', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    expect(seat(gas).holder).toBe('Alice');

    // Bob never logged in, never waited, was never the pendingOffer.
    accept(gas, 'Bob');

    expect(seat(gas).holder).not.toBe('Bob');
  });

  it('leaves the real holder in the seat', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    accept(gas, 'Bob');
    expect(seat(gas).holder).toBe('Alice');
  });

  it('does not report the stranger as holder in the response gate either', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    const res = accept(gas, 'Bob');
    expect(res.gate.holder).toBe('Alice');
  });

  it('does not clear the holder outright, even if it refuses to seat the stranger', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    accept(gas, 'Bob');
    expect(seat(gas).holder).not.toBeNull();
  });
});

/* ========================================================================
   2. ACCEPT WHEN NOT OFFERED
   ===================================================================== */
describe('gate: an accept from a waiter who is not the pendingOffer', () => {
  it('is rejected while another holder is seated', () => {
    const gas = loadGas({});
    login(gas, 'Alice');   // holder
    login(gas, 'Bob');     // waiting #1
    login(gas, 'Carol');   // waiting #2
    expect(seat(gas).pendingOffer).toBeNull(); // nobody has been offered anything

    accept(gas, 'Bob');

    expect(seat(gas).holder).toBe('Alice');
  });

  it('is rejected when the offer belongs to the person ahead in line', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    login(gas, 'Carol');
    logout(gas, 'Alice');                       // seat empties, Bob is offered it
    expect(seat(gas).pendingOffer).toBe('Bob');

    accept(gas, 'Carol');                       // Carol is a waiter, but not the offeree

    expect(seat(gas).holder).not.toBe('Carol');
  });

  it('does not consume the rightful offer when a non-offeree accepts', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    login(gas, 'Carol');
    logout(gas, 'Alice');

    accept(gas, 'Carol');

    expect(seat(gas).pendingOffer).toBe('Bob'); // Bob's turn survives Carol's attempt
  });

  it('does not drop the non-offeree out of the waiting list as a side effect', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    login(gas, 'Carol');
    logout(gas, 'Alice');

    accept(gas, 'Carol');

    expect(seat(gas).waiting).toContain('Carol'); // she keeps her place in line
  });
});

/* ========================================================================
   3. STALE OFFER
   Invariant: the moment anyone becomes holder, pendingOffer must be cleared.
   An offer that outlives the seat becoming occupied can be redeemed later to
   evict the new holder.
   ===================================================================== */
describe('gate: pendingOffer is cleared whenever someone becomes holder', () => {
  it('path A: a plain login into an empty seat clears an outstanding offer', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    logout(gas, 'Alice');                       // seat empty, Bob offered
    expect(seat(gas).pendingOffer).toBe('Bob');

    login(gas, 'Carol');                        // Carol walks into the empty seat
    expect(seat(gas).holder).toBe('Carol');

    expect(seat(gas).pendingOffer).toBeNull();
  });

  it('path A exploit: the stale offer must not be redeemable to evict the new holder', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    logout(gas, 'Alice');
    login(gas, 'Carol');                        // Carol is now the holder

    accept(gas, 'Bob');                         // Bob redeems his stale offer

    expect(seat(gas).holder).toBe('Carol');
  });

  it('path B: a decline promotes the next waiter, and that waiter taking the seat clears the offer', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    login(gas, 'Carol');
    logout(gas, 'Alice');                       // Bob offered
    decline(gas, 'Bob');                        // Bob passes, Carol offered
    expect(seat(gas).pendingOffer).toBe('Carol');

    login(gas, 'Carol');                        // Carol takes the empty seat by logging in
    expect(seat(gas).holder).toBe('Carol');

    expect(seat(gas).pendingOffer).toBeNull();
  });

  it('path B via accept: the promoted waiter accepting clears the offer', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    login(gas, 'Carol');
    logout(gas, 'Alice');
    decline(gas, 'Bob');

    accept(gas, 'Carol');                       // the legitimate offeree accepts

    expect(seat(gas).holder).toBe('Carol');
    expect(seat(gas).pendingOffer).toBeNull();
  });

  it('path B exploit: an offer left over after a decline must not evict whoever took the seat', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    login(gas, 'Carol');
    logout(gas, 'Alice');
    decline(gas, 'Bob');                        // Carol offered
    login(gas, 'Dave');                         // Dave grabs the empty seat first

    accept(gas, 'Carol');                       // Carol redeems the now-stale offer

    expect(seat(gas).holder).toBe('Dave');
  });

  it('path C: a logout promotes the next waiter, and the seat filling clears the offer', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    logout(gas, 'Alice');                       // Bob offered
    login(gas, 'Bob');                          // Bob takes the seat

    expect(seat(gas).holder).toBe('Bob');
    expect(seat(gas).pendingOffer).toBeNull();
  });

  it('path C exploit: a third party filling the seat first is not evicted by the promoted waiter', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');                          // Bob waiting
    logout(gas, 'Alice');                       // Bob offered
    login(gas, 'Zara');                         // Zara, never queued, takes the empty seat

    accept(gas, 'Bob');

    expect(seat(gas).holder).toBe('Zara');
  });

  it('invariant: holder set implies pendingOffer null after a full join/leave cycle', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    login(gas, 'Carol');
    logout(gas, 'Alice');
    decline(gas, 'Bob');
    accept(gas, 'Carol');
    login(gas, 'Dave');

    const s = seat(gas);
    if (s.holder) expect(s.pendingOffer).toBeNull();
    expect(s.holder).toBe('Carol');
  });
});

/* ========================================================================
   4. FORCE RELEASE IS ADMIN ONLY
   NOTE: `name` is self-asserted by the caller. There is no authentication in
   front of Code.gs, so this test pins the CHECK (the ADMINS list is consulted
   and a non-admin name is refused) but NOT real authority: anyone who can post
   to the /exec URL can simply claim to be "Saqib Shahzad". Closing that is an
   auth problem, not a gate problem, and is out of scope for this file.
   ===================================================================== */
describe('gate: forceRelease', () => {
  it('refuses a non-admin caller', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    const res = gas.handle_({ action: 'forceRelease', name: 'Bob' });
    expect(res.ok).toBe(false);
  });

  it('leaves the holder seated when a non-admin tries', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    gas.handle_({ action: 'forceRelease', name: 'Bob' });
    expect(seat(gas).holder).toBe('Alice');
  });

  it('writes no FORCE_RELEASE audit row for a refused attempt', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    gas.handle_({ action: 'forceRelease', name: 'Bob' });
    expect(typesLogged(gas)).not.toContain('FORCE_RELEASE');
  });

  it('refuses an empty / missing caller name', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    const res = gas.handle_({ action: 'forceRelease' });
    expect(res.ok).toBe(false);
    expect(seat(gas).holder).toBe('Alice');
  });

  it('allows a listed admin and empties the seat', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    const res = gas.handle_({ action: 'forceRelease', name: 'Saqib Shahzad' });
    expect(res.ok).toBe(true);
    expect(res.released).toBe('Alice');
    expect(seat(gas).holder).toBeNull();
  });

  it('records the admin force-release in the activity log', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    gas.handle_({ action: 'forceRelease', name: 'Saqib Shahzad' });
    expect(typesLogged(gas)).toContain('FORCE_RELEASE');
  });
});

/* ========================================================================
   5. GET MUST NOT MUTATE
   getLogs is not in POST_ONLY, so it is reachable over GET (a link, a prefetch,
   a crawler). handle_('getLogs') calls readQueue_(), and readQueue_ performs the
   stale-holder auto-release: it rewrites the Queue row and appends an
   AUTO_RELEASE row, outside the script lock. A read must not do either.
   ===================================================================== */
describe('gate: a GET-reachable read must not mutate state', () => {
  it('getLogs is reachable over GET (POST_ONLY does not cover it)', () => {
    const postOnly = CODE_GS.match(/var POST_ONLY\s*=\s*\{[\s\S]*?\}/)[0];
    expect(postOnly).not.toMatch(/getLogs/);
  });

  it('getLogs on a stale-heartbeat queue does not release the seat', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    staleHeartbeat(gas);

    // exactly what doGet forwards for ?action=getLogs
    gas.handle_({ action: 'getLogs' });

    expect(seat(gas).holder).toBe('Alice');
  });

  it('getLogs on a stale-heartbeat queue appends no ActivityLog row', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    staleHeartbeat(gas);
    const before = dataRows(gas, 'ActivityLog').length;

    gas.handle_({ action: 'getLogs' });

    expect(dataRows(gas, 'ActivityLog')).toHaveLength(before);
  });

  it('getLogs on a stale-heartbeat queue writes no AUTO_RELEASE row', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    staleHeartbeat(gas);

    gas.handle_({ action: 'getLogs' });

    expect(typesLogged(gas)).not.toContain('AUTO_RELEASE');
  });

  it('getLogs does not hand the seat to the first waiter', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    login(gas, 'Bob');
    staleHeartbeat(gas);

    gas.handle_({ action: 'getLogs' });

    expect(seat(gas).pendingOffer).toBeNull();
  });

  it('repeated getLogs calls do not pile up release rows', () => {
    const gas = loadGas({});
    login(gas, 'Alice');
    staleHeartbeat(gas);

    gas.handle_({ action: 'getLogs' });
    gas.handle_({ action: 'getLogs' });
    gas.handle_({ action: 'getLogs' });

    expect(dataRows(gas, 'ActivityLog')).toHaveLength(0);
  });
});

/* ========================================================================
   6. IDEMPOTENT CLEval RETRY
   handleLogCLEval_ reserves the evaluationId as PENDING with no row number,
   then appends, then commits. A crash between the append and the commit leaves
   the ledger saying PENDING/"" while the row is already on the sheet, so the
   retry cannot tell the write landed and appends a duplicate.

   The crash is produced for real: the CLEval append is made to throw straight
   after the row lands, so the ledger keeps exactly what the app itself reserved.
   These tests therefore say nothing about HOW the reservation is stored, only
   that a retry after a crash must land on the existing row instead of a
   second one.
   ===================================================================== */
describe('CLEval: retry after a crash between the pending write and the commit', () => {
  const SECRET = 'gate-safety-secret';
  const REQ = {
    action: 'logCLEval',
    secret: SECRET,
    evaluationId: 'ev_crash_1',
    name: 'Usman Saeed',
    row: { jobTitle: 'n8n AI Automation Expert', jobLink: 'https://www.upwork.com/jobs/~022078430146547204560' },
  };

  // The CLEval and _Idempotency tabs are created lazily by the first write, so
  // do one throwaway write to materialise them and then empty both back to their
  // header row. This leaves real sheet objects to wrap, on a clean ledger.
  function primeSheets(gas) {
    gas.handle_({ ...REQ, evaluationId: 'ev_prime' });
    gas.sheets.CLEval._rows.length = 1;
    gas.sheets._Idempotency._rows.length = 1;
  }

  // Kill the next write the way a dying Apps Script execution does: the CLEval
  // row lands on the sheet, then the execution stops before the ledger is
  // committed. Whatever the reserve step recorded is left exactly as the app
  // wrote it, so this makes no assumption about the ledger's internal format.
  // (An earlier version of this helper hand-wrote the ledger back to
  // PENDING/"" — that hardcoded today's reservation shape and could not be
  // satisfied by any implementation that reserves the row number up front.)
  function crashAfterNextAppend(gas) {
    const s = gas.sheets.CLEval;
    const orig = s.appendRow;
    s.appendRow = function (r) {
      orig.call(s, r);
      s.appendRow = orig;               // only the first append dies
      throw new Error('simulated crash after append, before commit');
    };
  }

  // Post-condition: exactly one CLEval row is on the sheet and the ledger holds
  // whatever the app reserved for it.
  function firstWriteCrashes(gas) {
    primeSheets(gas);
    crashAfterNextAppend(gas);
    expect(() => gas.handle_(REQ)).toThrow();
    expect(dataRows(gas, 'CLEval')).toHaveLength(1); // the row really did land
  }

  it('writes exactly one CLEval row when the same evaluationId is retried', () => {
    const gas = loadGas({ logSecret: SECRET });
    firstWriteCrashes(gas);

    gas.handle_(REQ);

    expect(dataRows(gas, 'CLEval')).toHaveLength(1);
  });

  it('reports the retry as deduped rather than as a fresh write', () => {
    const gas = loadGas({ logSecret: SECRET });
    firstWriteCrashes(gas);

    const retry = gas.handle_(REQ);

    expect(retry).toMatchObject({ ok: true, deduped: true });
  });

  it('points the retry at the row that already exists', () => {
    const gas = loadGas({ logSecret: SECRET });
    firstWriteCrashes(gas);
    const landedRow = gas.sheets.CLEval._rows.length; // 1-based row of the crashed append

    const retry = gas.handle_(REQ);

    expect(retry.row).toBe(landedRow);
  });

  it('does not duplicate across three retries of the same crashed write', () => {
    const gas = loadGas({ logSecret: SECRET });
    firstWriteCrashes(gas);

    gas.handle_(REQ);
    gas.handle_(REQ);
    gas.handle_(REQ);

    expect(dataRows(gas, 'CLEval')).toHaveLength(1);
  });

  it('still writes two rows for two genuinely different evaluationIds', () => {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_(REQ);
    gas.handle_({ ...REQ, evaluationId: 'ev_crash_2' });

    expect(dataRows(gas, 'CLEval')).toHaveLength(2);
  });
});

/* ========================================================================
   7. LOGGING AUTH
   NOTE: this pins the server-side shared-secret check only. The Vercel proxy in
   front of Code.gs currently attaches the correct LOG_SECRET on behalf of any
   anonymous caller, so in production this gate is effectively open. Fixing the
   proxy is a Stage 0 change and lives outside this file.
   ===================================================================== */
describe('CLEval: shared-secret logging gate', () => {
  const SECRET = 'gate-safety-secret';
  const base = { action: 'logCLEval', evaluationId: 'ev_auth', name: 'Usman Saeed', row: { jobTitle: 'Build AI Voice Assistant Mobile App MVP' } };

  it('rejects a request with no secret', () => {
    const gas = loadGas({ logSecret: SECRET });
    expect(gas.handle_({ ...base })).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('writes nothing when the secret is missing', () => {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ ...base });
    expect(dataRows(gas, 'CLEval')).toHaveLength(0);
  });

  it('rejects a wrong secret', () => {
    const gas = loadGas({ logSecret: SECRET });
    expect(gas.handle_({ ...base, secret: 'not-the-secret' })).toEqual({ ok: false, error: 'unauthorized' });
  });

  it('writes nothing when the secret is wrong', () => {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ ...base, secret: 'not-the-secret' });
    expect(dataRows(gas, 'CLEval')).toHaveLength(0);
  });

  it('leaves no idempotency reservation behind for a rejected request', () => {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ ...base, secret: 'not-the-secret' });
    expect(dataRows(gas, '_Idempotency')).toHaveLength(0);
  });

  it('fails closed when the server has no LOG_SECRET configured', () => {
    const gas = loadGas({}); // LOG_SECRET unset
    expect(gas.handle_({ ...base, secret: SECRET })).toEqual({ ok: false, error: 'unauthorized' });
    expect(dataRows(gas, 'CLEval')).toHaveLength(0);
  });

  it('rejects an empty-string secret even if the server secret is empty-ish', () => {
    const gas = loadGas({ logSecret: SECRET });
    gas.handle_({ ...base, secret: '' });
    expect(dataRows(gas, 'CLEval')).toHaveLength(0);
  });

  it('accepts the exact secret and writes one row', () => {
    const gas = loadGas({ logSecret: SECRET });
    const res = gas.handle_({ ...base, secret: SECRET });
    expect(res.ok).toBe(true);
    expect(dataRows(gas, 'CLEval')).toHaveLength(1);
  });
});
