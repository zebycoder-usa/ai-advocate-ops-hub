// Sign-in times are a shared record, so everyone must read the same number.
//
// fmtWhen used toLocaleDateString(), which formats in the VIEWER's timezone and
// prints no zone label. Saqib works from Texas and the bidding team works from
// Karachi, ten hours apart, so the two of them opened the same sign-in row and
// saw different times, sometimes different calendar days, with nothing on screen
// to say which was which. On a log whose entire purpose is settling who held the
// profile when, that makes the log unable to settle anything.
//
// None of the 45 tests in sessions.view.test.js caught this, because they all
// asserted on row counts, filters and ordering, never on a rendered timestamp.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadApp } from './loadApp.js';

let w, doc;
beforeEach(() => { const a = loadApp(); w = a.window; doc = a.doc; });

// 04:00 UTC is 09:00 in Karachi (UTC+5) and 23:00 the PREVIOUS DAY in Texas.
// That gap is the whole bug, so it is the fixture.
const UTC_0400 = '2026-08-01T04:00:00.000Z';

describe('one canonical time, whoever is looking', () => {
  it('renders an instant in PKT, not in the viewer timezone', () => {
    expect(w.fmtWhen(UTC_0400)).toBe('01 Aug 09:00');
  });

  it('does not slip to the previous day the way local time did', () => {
    // The old output in Texas was "7/31/2026 11:00 PM": wrong day, no label.
    expect(w.fmtWhen(UTC_0400)).not.toMatch(/31/);
    expect(w.fmtWhen(UTC_0400)).toContain('01 Aug');
  });

  it('is independent of the machine running it', () => {
    // The assertion is timezone-proof by construction: fmtWhen names
    // Asia/Karachi explicitly, so this value cannot vary with the host clock.
    // If someone reverts to toLocaleDateString, this fails everywhere except
    // a machine that happens to be set to Karachi.
    const out = w.fmtWhen(UTC_0400);
    expect(out).toBe('01 Aug 09:00');
    expect(out).not.toMatch(/AM|PM/);   // 24h, so 09:00 cannot be read as 9pm
  });

  it('handles an instant that lands on a different PKT day', () => {
    // 20:00 UTC on 31 Jul is 01:00 on 1 Aug in Karachi.
    expect(w.fmtWhen('2026-07-31T20:00:00.000Z')).toBe('01 Aug 01:00');
  });

  it('keeps midnight readable rather than printing 24:00', () => {
    expect(w.fmtWhen('2026-07-31T19:00:00.000Z')).toBe('01 Aug 00:00');
  });

  it('shows a dash for a session that has not ended', () => {
    expect(w.fmtWhen('')).toBe('-');
    expect(w.fmtWhen(null)).toBe('-');
    expect(w.fmtWhen(undefined)).toBe('-');
  });

  it('passes through a value it cannot parse instead of showing Invalid Date', () => {
    expect(w.fmtWhen('not a date')).toBe('not a date');
  });
});

describe('the column says which timezone it is', () => {
  const ROWS = [
    ['F-1', 'Fiza', UTC_0400, '2026-08-01T06:30:00.000Z', 150, '2h 30m', 12, 5, 4, 'CLOSED'],
    ['S-1', 'Sadia', '2026-08-01T06:00:00.000Z', '', '', '', 7, 3, 3, 'ACTIVE'],
  ];

  it('labels both time columns PKT, so no one has to guess', () => {
    w.setSessionRows(ROWS);
    w.renderSessions();
    const head = doc.getElementById('sessions-out').querySelector('thead').textContent;
    expect(head).toContain('Signed in (PKT)');
    expect(head).toContain('Signed out (PKT)');
  });

  it('renders the PKT time into the table body', () => {
    w.setSessionRows(ROWS);
    w.renderSessions();
    expect(doc.getElementById('sessions-out').textContent).toContain('01 Aug 09:00');
  });
});

describe('the questions the owner actually asked', () => {
  const ROWS = [
    ['F-1', 'Fiza', UTC_0400, '2026-08-01T06:30:00.000Z', 150, '2h 30m', 12, 5, 4, 'CLOSED'],
    ['S-1', 'Sadia', '2026-08-01T06:00:00.000Z', '', '', '', 7, 3, 3, 'ACTIVE'],
    ['H-1', 'Hamza', '2026-07-31T03:00:00.000Z', '', '', '', 2, 0, 0, 'TIMED OUT'],
  ];

  it('who is on the profile right now', () => {
    expect(w.listSessions({ status: 'ACTIVE' }, ROWS).map((r) => r[1])).toEqual(['Sadia']);
  });

  it('who signed in and out, with both times present', () => {
    w.setSessionRows(ROWS);
    w.renderSessions();
    const txt = doc.getElementById('sessions-out').textContent;
    expect(txt).toContain('Fiza');
    expect(txt).toContain('01 Aug 09:00');   // signed in
    expect(txt).toContain('01 Aug 11:30');   // signed out
  });

  it('how long each person held the profile', () => {
    const totals = w.sessionTotals(ROWS);
    const fiza = totals.find((t) => t.person === 'Fiza');
    expect(fiza.hm).toBe('2h 30m');
    expect(totals.find((t) => t.person === 'Sadia').open).toBe(1);
  });

  it('a dropped session is marked TIMED OUT rather than looking like a normal exit', () => {
    w.setSessionRows(ROWS);
    w.renderSessions();
    expect(doc.getElementById('sessions-out').textContent).toContain('TIMED OUT');
  });
});
