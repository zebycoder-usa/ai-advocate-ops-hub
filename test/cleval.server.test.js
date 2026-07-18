// Server-side (Code.gs) test: the logCLEval LOG_SECRET gate.
// Correct secret -> row written. Wrong/empty secret -> rejected, nothing written.
import { describe, it, expect } from 'vitest';
import { loadGas } from './loadGas.js';

const SECRET = 'staging-test-7714';
const ROW = { jobTitle: 'Full Stack Engineer', jobLink: 'https://www.upwork.com/jobs/~abc', flag: 'Green', applied: 'Yes' };
const req = (secret) => ({ action: 'logCLEval', secret, evaluationId: 'ev_test', name: 'Usman Saeed', row: ROW });

describe('Code.gs logCLEval LOG_SECRET gate', () => {
  it('correct secret -> row written to CLEval', () => {
    const gas = loadGas({ logSecret: SECRET });
    const res = gas.handle_(req(SECRET));
    expect(res.ok).toBe(true);
    // CLEval sheet exists: header row + 1 data row
    expect(gas.sheets.CLEval).toBeTruthy();
    expect(gas.sheets.CLEval._rows).toHaveLength(2);
    expect(gas.sheets.CLEval._rows[1][3]).toBe('Full Stack Engineer'); // Job Title cell
    expect(gas.sheets.CLEval._rows[1][24]).toBe('Un Opened');          // Ptoposal Status (server default)
  });

  it('wrong secret -> unauthorized, nothing written', () => {
    const gas = loadGas({ logSecret: SECRET });
    const res = gas.handle_(req('wrong-secret'));
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(gas.sheets.CLEval).toBeUndefined(); // no sheet created, no append
  });

  it('missing secret -> unauthorized, nothing written', () => {
    const gas = loadGas({ logSecret: SECRET });
    const res = gas.handle_({ action: 'logCLEval', evaluationId: 'ev_test', row: ROW });
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(gas.sheets.CLEval).toBeUndefined();
  });

  it('fail-closed: server has no LOG_SECRET -> even a sent secret is rejected', () => {
    const gas = loadGas({}); // LOG_SECRET unset
    const res = gas.handle_(req(SECRET));
    expect(res).toEqual({ ok: false, error: 'unauthorized' });
    expect(gas.sheets.CLEval).toBeUndefined();
  });

  it('Job Link cell renders as clickable "URL" linked to the ~id job URL', () => {
    const gas = loadGas({ logSecret: SECRET });
    const url = 'https://www.upwork.com/jobs/~022078430146547204560';
    const res = gas.handle_({ action: 'logCLEval', secret: SECRET, evaluationId: 'ev_link',
      name: 'Usman Saeed', row: { jobTitle: 'n8n AI Automation Expert', jobLink: url } });
    expect(res.ok).toBe(true);
    const cell = gas.sheets.CLEval._rows[1][4]; // Job Link column (rich text)
    expect(cell.text).toBe('URL');   // shows "URL", not the raw URL
    expect(cell.link).toBe(url);     // linked to the job URL
  });

  it('idempotency still holds under the gate: same evaluationId twice -> one row', () => {
    const gas = loadGas({ logSecret: SECRET });
    const a = gas.handle_(req(SECRET));
    const b = gas.handle_(req(SECRET));
    expect(a.ok).toBe(true);
    expect(b).toMatchObject({ ok: true, deduped: true });
    expect(gas.sheets.CLEval._rows).toHaveLength(2); // header + exactly one data row
  });
});
