// Admin seat-bypass tests for Code.gs, driven through loadGas().handle_().
//
// These pin the new admin rules. They are written BEFORE the implementation, so
// a red run here is the specification, not a broken test. Never relax an
// assertion to go green.
//
// THE RULES BEING PINNED
//   1. ADMINS is exactly ["Usman Saeed","Saqib Shahzad","Waqas Riaz"].
//      Jahanzaib (Zeb) is no longer an admin: no force-release, no bypass.
//   2. An admin logging in can work immediately even while the seat is held, and
//      does NOT evict the current holder. Admins do not bid on the shared Upwork
//      profile, so co-occupancy is safe.
//   3. Admins present are tracked in q.admins, a list held separately from
//      q.holder. An admin never appears in q.holder and never in q.waiting.
//   4. Non-admins are unaffected: joining a held seat still queues exactly as
//      before, and the waiting order is never reshuffled by admin traffic.
//
// DECISION PINNED HERE: AN ADMIN WALKING INTO AN *EMPTY* SEAT DOES NOT TAKE IT.
//   The admin is recorded in q.admins and q.holder stays null.
//   Rationale: the seat exists so that exactly one person can BID from Saqib's
//   profile. Admins do not bid, so an admin occupying an empty seat would fence
//   the profile off from the one group that actually needs it, and every real
//   bidder arriving after them would be queued behind someone who was never
//   going to submit a proposal. Leaving the seat free means the next bidder
//   walks straight in, which is the whole point of the bypass being separate
//   from holdership. Every test below is consistent with this choice.
//
// OBSERVATION NOTE: tests read state two ways.
//   - seat(gas) reads the persisted Queue row for holder / holderSince /
//     heartbeat, the three columns the live sheet already owns.
//   - persistedGate(gas) re-reads the queue through a fresh getLogs call, so
//     admin presence is asserted against what actually survived a round trip to
//     the sheet, without this file pinning which column stores it.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadGas } from './loadGas.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CODE_GS = readFileSync(join(__dirname, '..', 'Code.gs'), 'utf8');
const INDEX_HTML = readFileSync(join(__dirname, '..', 'index.html'), 'utf8');

/* ---------- the cast ---------- */
const USMAN = 'Usman Saeed';
const SAQIB = 'Saqib Shahzad';
const WAQAS = 'Waqas Riaz';
const ADMIN_NAMES = [USMAN, SAQIB, WAQAS];
const ZEB = 'Jahanzaib (Zeb)';

/* ---------- helpers ---------- */

const login = (gas, name) => gas.handle_({ action: 'login', name });
const logout = (gas, name) => gas.handle_({ action: 'logout', name });
const forceRelease = (gas, name) => gas.handle_({ action: 'forceRelease', name });

// The persisted Queue row, parsed the way readQueue_ parses it.
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

// Re-read the queue from the sheet through a read-only action, so admin
// presence is checked after a real persist/parse round trip.
function persistedGate(gas) {
  return gas.handle_({ action: 'getLogs' }).gate || {};
}

// q.admins is "a list of admin names currently in". Accept either bare names or
// {name,...} records; the assertion is on WHO is in the list.
function adminNames(gate) {
  const a = gate && gate.admins;
  if (!Array.isArray(a)) return [];
  return a.map((x) => (x && typeof x === 'object' ? x.name : x)).filter(Boolean);
}

function waitingNames(gate) {
  const w = (gate && gate.waiting) || [];
  return w.map((x) => (x && typeof x === 'object' ? x.name : x)).filter(Boolean);
}

function dataRows(gas, tab) {
  const s = gas.sheets[tab];
  return s ? s._rows.slice(1) : [];
}

const typesLogged = (gas) => dataRows(gas, 'ActivityLog').map((r) => r[2]);

// Stamp the holder's timestamps with distinctive sentinel values so that ANY
// rewrite of those cells is detectable, even one that happens inside the same
// millisecond. The heartbeat sentinel is only 60s old, well inside the 12 min
// stale window, so it cannot trigger the auto-release path by accident.
const SINCE_SENTINEL = '2026-07-01T09:15:04.321Z';
function pinHolderStamps(gas) {
  const hb = new Date(Date.now() - 60 * 1000).toISOString();
  gas.sheets.Queue._rows[1][1] = SINCE_SENTINEL;
  gas.sheets.Queue._rows[1][5] = hb;
  return { holderSince: SINCE_SENTINEL, holderHeartbeat: hb };
}

// The common setup: a non-admin bidder is working, with nobody else around.
function seatedHolder(name = 'Alice') {
  const gas = loadGas({});
  login(gas, name);
  const stamps = pinHolderStamps(gas);
  return { gas, stamps };
}

/* ========================================================================
   1. THE ADMIN ROSTER ITSELF
   ===================================================================== */
describe('who counts as an admin', () => {
  it('lists Usman Saeed, Saqib Shahzad and Waqas Riaz as the admins', () => {
    const decl = CODE_GS.match(/var\s+ADMINS\s*=\s*\[[^\]]*\]/);
    expect(decl).not.toBeNull();
    ADMIN_NAMES.forEach((n) => expect(decl[0]).toContain(n));
  });

  it('no longer lists Zeb (Jahanzaib) as an admin', () => {
    const decl = CODE_GS.match(/var\s+ADMINS\s*=\s*\[[^\]]*\]/);
    expect(decl).not.toBeNull();
    expect(decl[0]).not.toMatch(/Jahanzaib|Zeb/i);
  });

  it('holds exactly three admins, nobody extra', () => {
    const decl = CODE_GS.match(/var\s+ADMINS\s*=\s*\[([^\]]*)\]/);
    expect(decl).not.toBeNull();
    const names = decl[1].split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    expect(names.sort()).toEqual([...ADMIN_NAMES].sort());
  });

  it('the app screen agrees with the backend about who is an admin', () => {
    const decl = INDEX_HTML.match(/var\s+SEAT_ADMINS\s*=\s*\[[^\]]*\]/);
    expect(decl).not.toBeNull();
    ADMIN_NAMES.forEach((n) => expect(decl[0]).toContain(n));
    expect(decl[0]).not.toMatch(/Jahanzaib|Zeb/i);
  });
});

/* ========================================================================
   2. AN ADMIN ARRIVING WHILE SOMEONE IS BIDDING
   The heart of the change: the admin gets in, the bidder is untouched.
   ===================================================================== */
describe('an admin arrives while a team member is holding the seat', () => {
  ADMIN_NAMES.forEach((admin) => {
    describe(admin, () => {
      it('is let in straight away instead of being put in the queue', () => {
        const { gas } = seatedHolder();
        const res = login(gas, admin);
        expect(res.ok).toBe(true);
        // Whatever word the backend uses for "you are in", it must not be a
        // queue position. The exact token is deliberately not pinned.
        expect(String(res.gateStatus || '')).not.toMatch(/^WAITING/);
        expect(String(res.gateStatus || '')).not.toBe('ALREADY_WAITING');
      });

      it('is recorded as an admin who is currently in', () => {
        const { gas } = seatedHolder();
        login(gas, admin);
        expect(adminNames(persistedGate(gas))).toContain(admin);
      });

      it('does not take the seat from the person holding it', () => {
        const { gas } = seatedHolder();
        login(gas, admin);
        expect(seat(gas).holder).toBe('Alice');
      });

      it('does not reset when the holder started their turn', () => {
        const { gas, stamps } = seatedHolder();
        login(gas, admin);
        expect(seat(gas).holderSince).toBe(stamps.holderSince);
      });

      it("does not touch the holder's heartbeat", () => {
        const { gas, stamps } = seatedHolder();
        login(gas, admin);
        expect(seat(gas).holderHeartbeat).toBe(stamps.holderHeartbeat);
      });

      it('is never written into the holder cell', () => {
        const { gas } = seatedHolder();
        login(gas, admin);
        expect(seat(gas).holder).not.toBe(admin);
      });

      it('is never added to the waiting list', () => {
        const { gas } = seatedHolder();
        login(gas, admin);
        expect(seat(gas).waiting).not.toContain(admin);
        expect(waitingNames(persistedGate(gas))).not.toContain(admin);
      });

      it('does not create a pending offer for anyone', () => {
        const { gas } = seatedHolder();
        login(gas, admin);
        expect(seat(gas).pendingOffer).toBeNull();
      });
    });
  });

  it('exposes the admins who are in as a list, separate from the holder', () => {
    const { gas } = seatedHolder();
    login(gas, USMAN);
    const g = persistedGate(gas);
    expect(Array.isArray(g.admins)).toBe(true);
    expect(g.holder).toBe('Alice');
  });

  it('an admin arriving twice is only counted once', () => {
    const { gas } = seatedHolder();
    login(gas, SAQIB);
    login(gas, SAQIB);
    expect(adminNames(persistedGate(gas)).filter((n) => n === SAQIB)).toHaveLength(1);
  });

  it('an admin arriving does not kick the holder out of an open session', () => {
    const { gas } = seatedHolder();
    login(gas, WAQAS);
    expect(typesLogged(gas)).not.toContain('AUTO_RELEASE');
    expect(typesLogged(gas)).not.toContain('FORCE_RELEASE');
  });
});

/* ========================================================================
   3. ZEB IS AN ORDINARY MEMBER NOW
   ===================================================================== */
describe('Zeb is treated like any other team member', () => {
  it('is put in the queue when he logs in while the seat is held', () => {
    const { gas } = seatedHolder();
    const res = login(gas, ZEB);
    expect(res.gateStatus).toBe('WAITING#1');
  });

  it('does not take the seat from the holder', () => {
    const { gas } = seatedHolder();
    login(gas, ZEB);
    expect(seat(gas).holder).toBe('Alice');
  });

  it('appears in the waiting list, not in the admin list', () => {
    const { gas } = seatedHolder();
    login(gas, ZEB);
    expect(seat(gas).waiting).toContain(ZEB);
    expect(adminNames(persistedGate(gas))).not.toContain(ZEB);
  });

  it('cannot force-release the seat any more', () => {
    const { gas } = seatedHolder();
    const res = forceRelease(gas, ZEB);
    expect(res.ok).toBe(false);
  });

  it('leaves the holder seated when he tries to force-release', () => {
    const { gas } = seatedHolder();
    forceRelease(gas, ZEB);
    expect(seat(gas).holder).toBe('Alice');
  });

  it('writes no force-release record when he tries', () => {
    const { gas } = seatedHolder();
    forceRelease(gas, ZEB);
    expect(typesLogged(gas)).not.toContain('FORCE_RELEASE');
  });

  it('is not told he is an admin by the refusal message', () => {
    const { gas } = seatedHolder();
    const res = forceRelease(gas, ZEB);
    expect(String(res.error || '')).not.toMatch(/zeb|jahanzaib/i);
  });
});

/* ========================================================================
   4. NON-ADMINS QUEUE EXACTLY AS BEFORE
   ===================================================================== */
describe('an ordinary team member joining a busy seat', () => {
  it('is told they are first in line', () => {
    const { gas } = seatedHolder();
    expect(login(gas, 'Bob').gateStatus).toBe('WAITING#1');
  });

  it('is told they are second in line when someone is already waiting', () => {
    const { gas } = seatedHolder();
    login(gas, 'Bob');
    expect(login(gas, 'Carol').gateStatus).toBe('WAITING#2');
  });

  it('is told they are already waiting if they log in again', () => {
    const { gas } = seatedHolder();
    login(gas, 'Bob');
    expect(login(gas, 'Bob').gateStatus).toBe('ALREADY_WAITING');
  });

  it('still gets the same queue position when admins are also in', () => {
    const { gas } = seatedHolder();
    login(gas, USMAN);
    login(gas, SAQIB);
    expect(login(gas, 'Bob').gateStatus).toBe('WAITING#1');
  });

  it('is never listed as an admin', () => {
    const { gas } = seatedHolder();
    login(gas, 'Bob');
    expect(adminNames(persistedGate(gas))).not.toContain('Bob');
  });

  it('takes the seat normally when it is free', () => {
    const gas = loadGas({});
    expect(login(gas, 'Bob').gateStatus).toBe('HOLDER');
    expect(seat(gas).holder).toBe('Bob');
  });
});

/* ========================================================================
   5. TWO ADMINS AT ONCE
   ===================================================================== */
describe('two admins in at the same time', () => {
  it('records both of them as in', () => {
    const { gas } = seatedHolder();
    login(gas, USMAN);
    login(gas, WAQAS);
    const names = adminNames(persistedGate(gas));
    expect(names).toContain(USMAN);
    expect(names).toContain(WAQAS);
  });

  it('does not let the second admin displace the first', () => {
    const { gas } = seatedHolder();
    login(gas, USMAN);
    login(gas, WAQAS);
    expect(adminNames(persistedGate(gas))).toContain(USMAN);
  });

  it('leaves the bidder in the seat with all three admins in', () => {
    const { gas, stamps } = seatedHolder();
    ADMIN_NAMES.forEach((a) => login(gas, a));
    expect(seat(gas).holder).toBe('Alice');
    expect(seat(gas).holderSince).toBe(stamps.holderSince);
    expect(seat(gas).holderHeartbeat).toBe(stamps.holderHeartbeat);
  });

  it('records all three admins when all three are in', () => {
    const { gas } = seatedHolder();
    ADMIN_NAMES.forEach((a) => login(gas, a));
    expect(adminNames(persistedGate(gas)).sort()).toEqual([...ADMIN_NAMES].sort());
  });

  it('one admin leaving does not remove the other', () => {
    const { gas } = seatedHolder();
    login(gas, USMAN);
    login(gas, WAQAS);
    logout(gas, USMAN);
    const names = adminNames(persistedGate(gas));
    expect(names).toContain(WAQAS);
    expect(names).not.toContain(USMAN);
  });
});

/* ========================================================================
   6. AN ADMIN WALKING INTO AN EMPTY SEAT
   Pinned decision: the admin does NOT become the holder. See the file header
   for the reasoning. The seat stays open for the next person who will actually
   bid from it.
   ===================================================================== */
describe('an admin logs in when nobody is holding the seat', () => {
  it('leaves the seat empty rather than claiming it', () => {
    const gas = loadGas({});
    login(gas, SAQIB);
    expect(seat(gas).holder).toBeNull();
  });

  it('records the admin as in even though they hold nothing', () => {
    const gas = loadGas({});
    login(gas, SAQIB);
    expect(adminNames(persistedGate(gas))).toContain(SAQIB);
  });

  it('does not report the admin as the holder in the reply', () => {
    const gas = loadGas({});
    const res = login(gas, SAQIB);
    expect(res.gate.holder).not.toBe(SAQIB);
  });

  it('does not put the admin in the waiting list either', () => {
    const gas = loadGas({});
    login(gas, SAQIB);
    expect(seat(gas).waiting).toHaveLength(0);
  });

  it('lets the next bidder walk straight into the seat', () => {
    const gas = loadGas({});
    login(gas, SAQIB);
    const res = login(gas, 'Bob');
    expect(res.gateStatus).toBe('HOLDER');
    expect(seat(gas).holder).toBe('Bob');
  });

  it('does not queue the bidder behind the admin', () => {
    const gas = loadGas({});
    ADMIN_NAMES.forEach((a) => login(gas, a));
    expect(login(gas, 'Bob').gateStatus).toBe('HOLDER');
  });
});

/* ========================================================================
   7. AN ADMIN LEAVING
   ===================================================================== */
describe('an admin logs out', () => {
  it('is no longer listed as in', () => {
    const { gas } = seatedHolder();
    login(gas, USMAN);
    logout(gas, USMAN);
    expect(adminNames(persistedGate(gas))).not.toContain(USMAN);
  });

  it('leaves the holder exactly where they were', () => {
    const { gas, stamps } = seatedHolder();
    login(gas, WAQAS);
    logout(gas, WAQAS);
    const s = seat(gas);
    expect(s.holder).toBe('Alice');
    expect(s.holderSince).toBe(stamps.holderSince);
    expect(s.holderHeartbeat).toBe(stamps.holderHeartbeat);
  });

  it('does not hand the seat to anyone', () => {
    const { gas } = seatedHolder();
    login(gas, 'Bob');
    login(gas, SAQIB);
    const res = logout(gas, SAQIB);
    expect(res.promoted).toBeNull();
    expect(seat(gas).pendingOffer).toBeNull();
  });

  it('leaves the waiting list untouched', () => {
    const { gas } = seatedHolder();
    login(gas, 'Bob');
    login(gas, 'Carol');
    login(gas, SAQIB);
    logout(gas, SAQIB);
    expect(seat(gas).waiting).toEqual(['Bob', 'Carol']);
  });

  it('an admin who was never in can log out without breaking anything', () => {
    const { gas, stamps } = seatedHolder();
    login(gas, 'Bob');
    logout(gas, USMAN);
    const s = seat(gas);
    expect(s.holder).toBe('Alice');
    expect(s.holderSince).toBe(stamps.holderSince);
    expect(s.waiting).toEqual(['Bob']);
  });

  it('can come back in after leaving', () => {
    const { gas } = seatedHolder();
    login(gas, USMAN);
    logout(gas, USMAN);
    login(gas, USMAN);
    expect(adminNames(persistedGate(gas))).toContain(USMAN);
    expect(seat(gas).holder).toBe('Alice');
  });
});

/* ========================================================================
   8. FORCE RELEASE
   NOTE: `name` is self-asserted by the caller; there is no authentication in
   front of Code.gs. This pins the CHECK (the admin list is consulted), not real
   authority.
   ===================================================================== */
describe('force-releasing the seat', () => {
  ADMIN_NAMES.forEach((admin) => {
    it(`${admin} can force-release a stuck holder`, () => {
      const { gas } = seatedHolder();
      const res = forceRelease(gas, admin);
      expect(res.ok).toBe(true);
      expect(res.released).toBe('Alice');
      expect(seat(gas).holder).toBeNull();
    });

    it(`${admin}'s force-release is written to the activity log`, () => {
      const { gas } = seatedHolder();
      forceRelease(gas, admin);
      expect(typesLogged(gas)).toContain('FORCE_RELEASE');
    });
  });

  it('refuses an ordinary team member', () => {
    const { gas } = seatedHolder();
    expect(forceRelease(gas, 'Bob').ok).toBe(false);
    expect(seat(gas).holder).toBe('Alice');
  });

  it('refuses a caller with no name at all', () => {
    const { gas } = seatedHolder();
    expect(gas.handle_({ action: 'forceRelease' }).ok).toBe(false);
    expect(seat(gas).holder).toBe('Alice');
  });

  it('hands the freed seat to the first person waiting', () => {
    const { gas } = seatedHolder();
    login(gas, 'Bob');
    login(gas, 'Carol');
    forceRelease(gas, SAQIB);
    expect(seat(gas).pendingOffer).toBe('Bob');
  });

  it('does not offer the freed seat to an admin who is in', () => {
    const { gas } = seatedHolder();
    login(gas, 'Bob');
    login(gas, USMAN);
    forceRelease(gas, USMAN);
    expect(seat(gas).pendingOffer).toBe('Bob');
  });

  it('leaves the admin still in after they free the seat', () => {
    const { gas } = seatedHolder();
    login(gas, WAQAS);
    forceRelease(gas, WAQAS);
    expect(adminNames(persistedGate(gas))).toContain(WAQAS);
  });
});

/* ========================================================================
   9. THE WAITING LINE IS NEVER RESHUFFLED BY ADMIN TRAFFIC
   ===================================================================== */
describe('the order of the waiting line', () => {
  // Alice holds; Bob, Carol and Dave are queued in that order.
  function busyQueue() {
    const { gas, stamps } = seatedHolder();
    login(gas, 'Bob');
    login(gas, 'Carol');
    login(gas, 'Dave');
    return { gas, stamps };
  }

  it('survives an admin joining', () => {
    const { gas } = busyQueue();
    login(gas, USMAN);
    expect(seat(gas).waiting).toEqual(['Bob', 'Carol', 'Dave']);
  });

  it('survives all three admins joining', () => {
    const { gas } = busyQueue();
    ADMIN_NAMES.forEach((a) => login(gas, a));
    expect(seat(gas).waiting).toEqual(['Bob', 'Carol', 'Dave']);
  });

  it('survives admins joining and leaving again', () => {
    const { gas } = busyQueue();
    login(gas, USMAN);
    login(gas, SAQIB);
    logout(gas, USMAN);
    login(gas, WAQAS);
    logout(gas, SAQIB);
    expect(seat(gas).waiting).toEqual(['Bob', 'Carol', 'Dave']);
  });

  it('still offers the seat to Bob first when the holder leaves', () => {
    const { gas } = busyQueue();
    ADMIN_NAMES.forEach((a) => login(gas, a));
    logout(gas, 'Alice');
    expect(seat(gas).pendingOffer).toBe('Bob');
  });

  it('lets Bob take the seat after the holder leaves, with admins still in', () => {
    const { gas } = busyQueue();
    login(gas, SAQIB);
    logout(gas, 'Alice');
    gas.handle_({ action: 'gateAccept', name: 'Bob' });
    expect(seat(gas).holder).toBe('Bob');
    expect(adminNames(persistedGate(gas))).toContain(SAQIB);
  });

  it('keeps Carol and Dave in order after Bob is promoted', () => {
    const { gas } = busyQueue();
    login(gas, WAQAS);
    logout(gas, 'Alice');
    gas.handle_({ action: 'gateAccept', name: 'Bob' });
    expect(seat(gas).waiting).toEqual(['Carol', 'Dave']);
  });

  it('does not let an admin jump the line into the emptied seat', () => {
    const { gas } = busyQueue();
    login(gas, USMAN);
    logout(gas, 'Alice');
    expect(seat(gas).holder).toBeNull();
    expect(seat(gas).pendingOffer).toBe('Bob');
  });
});
