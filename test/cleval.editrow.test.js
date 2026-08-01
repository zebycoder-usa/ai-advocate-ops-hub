// Editing any column on a job row.
//
// The addressing is the whole problem. updateCLEvalStatus finds its row through
// the _Idempotency ledger, which only has entries for rows the APP wrote. The 681
// rows the team typed by hand have no ledger entry, so every one of them answers
// "unknown evaluationId". An edit feature that only works on rows nobody needs to
// edit is not a feature, so this addresses by row number too.
//
// Row numbers drift when someone inserts or deletes a line in the sheet, and a
// drifted write silently overwrites a different person's job. So the client sends
// the title it believes is on that row and the write is refused on mismatch.
// Refusing an edit is recoverable; writing to the wrong job is not.
import { describe, it, expect, beforeEach } from 'vitest';
import { loadGas } from './loadGas.js';

const SECRET = 'edit-secret';
const TITLE = 'Senior AI Engineer RAG';

// A row exactly like the hand-typed ones: present in the sheet, absent from the ledger.
const HAND_TYPED = ['Sadia', '8/1/2026', '09:00', TITLE, 'URL', '89%', '5', 'Yes', '$1K',
  '5-10', '0', '0', '0', 'Green', 'Yes', 'Hourly', '', '', '', '12', '', 'old reason',
  '1 hour ago', '2', 'Un Opened'];

let gas, rowNum;
beforeEach(() => {
  gas = loadGas({ logSecret: SECRET });
  // Force the CLEval sheet into existence with its headers, then append by hand.
  gas.handle_({ action: 'logCLEval', secret: SECRET, name: 'seed', evaluationId: 'seed', row: { jobTitle: 'seed' } });
  gas.sheets.CLEval._rows.push(HAND_TYPED.slice());
  rowNum = gas.sheets.CLEval._rows.length;
});

const edit = (over = {}) => gas.handle_({
  action: 'updateCLEvalRow', secret: SECRET, name: 'Waqas Riaz',
  rowNumber: rowNum, expectTitle: TITLE, ...over,
});
const cell = (i) => gas.sheets.CLEval._rows[rowNum - 1][i];

describe('a hand-typed row can be edited at all', () => {
  it('updates by row number even with no idempotency entry', () => {
    // The assertion that matters for the 681 existing rows.
    const r = edit({ row: { totalSpend: '$2.5K' } });
    expect(r.ok).toBe(true);
    expect(cell(8)).toBe('$2.5K');
  });

  it('updates several columns at once and reports which', () => {
    const r = edit({ row: { totalSpend: '$2.5K', connects: '16', reason: 'Client replied' } });
    expect(r.changed).toBe(3);
    expect(r.fields.sort()).toEqual(['connects', 'reason', 'totalSpend']);
  });

  it('leaves the columns it was not given alone', () => {
    edit({ row: { totalSpend: '$2.5K' } });
    expect(cell(3)).toBe(TITLE);        // Job Title
    expect(cell(13)).toBe('Green');     // Flag
    expect(cell(21)).toBe('old reason');
  });

  it('reports nothing changed when the value is identical', () => {
    expect(edit({ row: { totalSpend: '$1K' } }).changed).toBe(0);
  });
});

describe('refusing to write to the wrong job', () => {
  it('refuses when the title on that row does not match', () => {
    const r = edit({ expectTitle: 'A Totally Different Job', row: { totalSpend: '$999' } });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/row moved/i);
  });

  it('changes nothing when it refuses', () => {
    edit({ expectTitle: 'A Totally Different Job', row: { totalSpend: '$999' } });
    expect(cell(8)).toBe('$1K');
  });

  it('refuses a row number past the end of the sheet', () => {
    expect(edit({ rowNumber: 9999, row: { totalSpend: '$1' } }).ok).toBe(false);
  });

  it('refuses the header row', () => {
    expect(edit({ rowNumber: 1, row: { totalSpend: '$1' } }).ok).toBe(false);
  });
});

describe('what a client is not allowed to do', () => {
  it('rejects a request with no secret', () => {
    expect(gas.handle_({ action: 'updateCLEvalRow', rowNumber: rowNum, row: { totalSpend: '$1' } }))
      .toEqual({ ok: false, error: 'unauthorized' });
  });

  it('ignores a status outside the agreed vocabulary', () => {
    // The filters and every outcome metric match on exact strings, so a freehand
    // status makes the row invisible to its own team.
    edit({ row: { proposalStatus: 'Banana' } });
    expect(cell(24)).toBe('Un Opened');
  });

  it('accepts a status that is in the vocabulary', () => {
    edit({ row: { proposalStatus: 'Interview' } });
    expect(cell(24)).toBe('Interview');
  });

  it('ignores a field name that is not a column', () => {
    const r = edit({ row: { notAColumn: 'x', totalSpend: '$3K' } });
    expect(r.fields).toEqual(['totalSpend']);
  });

  it('neutralises a value that would run as a formula', () => {
    edit({ row: { reason: '=IMPORTRANGE("evil","A1")' } });
    expect(String(cell(21)).startsWith("'")).toBe(true);
  });

  it('requires a row object', () => {
    expect(gas.handle_({ action: 'updateCLEvalRow', secret: SECRET, rowNumber: rowNum }).ok).toBe(false);
  });
});

describe('the job link keeps the format the team reads', () => {
  it('stores an Upwork link as the clickable URL cell, not a raw address', () => {
    edit({ row: { jobLink: 'https://www.upwork.com/jobs/~0299' } });
    const c = cell(4);
    expect(c.text).toBe('URL');
    expect(c.link).toBe('https://www.upwork.com/jobs/~0299');
  });

  it('writes a non-Upwork value as plain text', () => {
    edit({ row: { jobLink: 'see email' } });
    expect(cell(4)).toBe('see email');
  });
});

describe('every edit is on the record', () => {
  it('logs each changed field with its before and after and who did it', () => {
    edit({ row: { totalSpend: '$2.5K', connects: '16' } });
    const log = gas.sheets._RowLog._rows.slice(1);
    expect(log).toHaveLength(2);
    const spend = log.find((r) => r[2] === 'totalSpend');
    expect(spend[3]).toBe('$1K');          // from
    expect(spend[4]).toBe('$2.5K');        // to
    expect(spend[6]).toBe('Waqas Riaz');   // by
  });

  it('writes no log entry when nothing actually changed', () => {
    edit({ row: { totalSpend: '$1K' } });
    expect(gas.sheets._RowLog ? gas.sheets._RowLog._rows.length - 1 : 0).toBe(0);
  });
});

describe('the field list is one contract across two files', () => {
  it('has a field name for every CLEval column', async () => {
    // CLEVAL_FIELDS in Code.gs, TABS.CLEval in Code.gs and CLEVAL_COLUMNS in
    // index.html must stay aligned in ORDER, or an edit writes to the wrong column.
    const { readFileSync } = await import('node:fs');
    const code = readFileSync(new URL('../Code.gs', import.meta.url), 'utf8');
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

    const fields = JSON.parse(code.match(/var CLEVAL_FIELDS\s*=\s*(\[[\s\S]*?\]);/)[1]);
    const tabs = code.match(/CLEval:\s*\[([\s\S]*?)\],\n/)[1].split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
    const cols = [...html.match(/var CLEVAL_COLUMNS=\[([\s\S]*?)\];/)[1]
      .matchAll(/\[\s*'([^']+)'\s*,\s*'([^']+)'\s*\]/g)].map((m) => m[2]);

    expect(fields).toHaveLength(tabs.length);
    expect(fields).toEqual(cols);
  });
});
