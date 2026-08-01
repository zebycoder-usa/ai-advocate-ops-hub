// Write a job through logCLEval, read it back through listCLEval, and check the
// job link survives the trip.
//
// Nothing tested this before. duplicate.detect.test.js has 59 tests, all of which
// hand findDuplicateJob synthetic rows containing real URLs, so they proved the
// matcher works on data the app never actually receives. logCLEval appends the row
// with the real URL and then OVERWRITES column 5 with a rich-text cell whose display
// text is the literal word "URL". Sheets getValues() returns display text, so every
// Job Link arrived back as "URL", jobIdOf() found no id in it, and duplicate
// detection could not match a single row from the day it shipped.
//
// It was invisible twice over: the feature fails silently (no warning is simply no
// warning), and the test mock used to return the whole rich-text object from
// getValues(), which is more generous than Apps Script and hid the loss.
import { describe, it, expect } from 'vitest';
import { loadGas } from './loadGas.js';
import { loadApp } from './loadApp.js';

const SECRET = 'rt-secret';
const LINK = 'https://www.upwork.com/jobs/~021234567890123456';
const LINK2 = 'https://www.upwork.com/jobs/~019876543210987654';

const write = (gas, over = {}) => gas.handle_({
  action: 'logCLEval', secret: SECRET, name: 'Waqas Riaz',
  evaluationId: over.evaluationId || 'ev-1',
  row: { jobTitle: 'RAG engineer', jobLink: LINK, ...(over.row || {}) },
});
const list = (gas) => gas.handle_({ action: 'listCLEval', secret: SECRET, limit: 100 });
const LINK_COL = 4;   // CLEval column 5, zero-indexed

describe('a job link survives write then read', () => {
  it('comes back as the real address, not the word URL', () => {
    const gas = loadGas({ logSecret: SECRET });
    expect(write(gas).ok).toBe(true);
    const rows = list(gas).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0][LINK_COL]).toBe(LINK);
  });

  it('the sheet itself still shows the team their clickable URL cell', () => {
    // The display format is deliberate and must not regress: the fix is in how we
    // READ the cell, not in what the team sees in the sheet.
    const gas = loadGas({ logSecret: SECRET });
    write(gas);
    const cell = gas.sheets.CLEval._rows[1][LINK_COL];
    expect(cell.text).toBe('URL');
    expect(cell.link).toBe(LINK);
  });

  it('keeps each row matched to its own link', () => {
    const gas = loadGas({ logSecret: SECRET });
    write(gas, { evaluationId: 'ev-1' });
    write(gas, { evaluationId: 'ev-2', row: { jobTitle: 'Voice agent', jobLink: LINK2 } });
    const rows = list(gas).rows;
    expect(rows.map((r) => r[LINK_COL])).toEqual([LINK, LINK2]);
  });

  it('writes the no-link sentinel rather than inventing an address', () => {
    // clevalServerRow_ writes `link ? "URL" : "-"`, and the formula-injection guard
    // then prefixes an apostrophe because the cell starts with a dash. So "no link"
    // reads back as "'-", not as an empty string. Anything importing this data later
    // has to treat that sentinel as absent.
    const gas = loadGas({ logSecret: SECRET });
    write(gas, { evaluationId: 'ev-3', row: { jobTitle: 'No link job', jobLink: '' } });
    expect(list(gas).rows[0][LINK_COL]).toBe("'-");
  });

  it('drops a non-Upwork link entirely, by design', () => {
    // isUpworkHttps_ gates both the stored value and the rich-text link, so a link
    // to anywhere else is not merely unlinked, it is discarded. Recorded because it
    // is surprising and it means the sheet is not a complete record of what was
    // pasted.
    const gas = loadGas({ logSecret: SECRET });
    write(gas, { evaluationId: 'ev-4', row: { jobTitle: 'Elsewhere', jobLink: 'https://example.com/not-upwork' } });
    expect(list(gas).rows[0][LINK_COL]).toBe("'-");
  });
});

describe('the end the user actually feels: duplicate detection', () => {
  it('matches a job the team already logged, using rows as listCLEval returns them', () => {
    // The assertion that would have caught this. It joins the two halves that were
    // each tested in isolation and never together.
    const gas = loadGas({ logSecret: SECRET });
    write(gas);
    const rows = list(gas).rows;

    const w = loadApp().window;
    w.setCLEvalRows(rows);
    const hit = w.findDuplicateJob(LINK, rows);
    expect(hit).toBeTruthy();
  });

  it('still reports no duplicate for a job nobody has logged', () => {
    const gas = loadGas({ logSecret: SECRET });
    write(gas);
    const w = loadApp().window;
    const rows = list(gas).rows;
    w.setCLEvalRows(rows);
    expect(w.findDuplicateJob(LINK2, rows)).toBeFalsy();
  });

  it('a link stored as the literal word URL matches nothing, which is the old behaviour', () => {
    // Pins the failure mode itself, so the regression is recognisable if it returns.
    const w = loadApp().window;
    const broken = [['Waqas Riaz', '8/1/2026', '09:00', 'RAG engineer', 'URL']];
    expect(w.findDuplicateJob(LINK, broken)).toBeFalsy();
  });
});
