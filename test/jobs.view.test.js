// listJobs(): the filtering behind the All Jobs tab.
//
// Everyone sees everyone's rows, so these filters are how twenty people's work
// stays readable. Verified in a real browser once; pinned here so it stays true.
import { describe, it, expect, beforeAll } from 'vitest';
import { loadApp } from './loadApp.js';

let w, IDX;

function row(o) {
  const r = new Array(25).fill('');
  Object.keys(o).forEach((k) => { r[IDX[k]] = o[k]; });
  return r;
}
let ROWS;

beforeAll(() => {
  w = loadApp().window;
  IDX = w.CLEVAL_IDX;
  ROWS = [
    row({ assignee: 'Fiza',        date: '7/29/2026', timePkt: '11:04', jobTitle: 'n8n AI Automation Expert',  applied: 'No',  reason: 'Fixed-price under $200', proposalStatus: 'Un Opened', jobLink: 'https://www.upwork.com/jobs/~021000000000000000111' }),
    row({ assignee: 'Jahanzaib',   date: '7/30/2026', timePkt: '09:12', jobTitle: 'RAG Chatbot over Notion',   applied: 'Yes', reason: '16/19 APPLY',            proposalStatus: 'Interview', jobLink: 'https://www.upwork.com/jobs/~021000000000000000222' }),
    row({ assignee: 'Sadia',       date: '7/30/2026', timePkt: '10:03', jobTitle: 'Computer Vision defects',   applied: 'Yes', reason: '17/19 APPLY',            proposalStatus: 'Hired',     jobLink: 'https://www.upwork.com/jobs/~021000000000000000333' }),
    row({ assignee: 'Sadia',       date: '7/31/2026', timePkt: '12:15', jobTitle: 'QA Cypress for fintech',    applied: 'No',  reason: 'Banned industry',        proposalStatus: '',          jobLink: 'https://www.upwork.com/jobs/~021000000000000000444' }),
    row({ assignee: 'Usman Saeed', date: '7/31/2026', timePkt: '08:47', jobTitle: 'LangGraph agents',          applied: 'Yes', reason: '18/19 APPLY',            proposalStatus: 'Replied',   jobLink: 'https://www.upwork.com/jobs/~021000000000000000555' }),
  ];
});

const ids = (rs) => rs.map((r) => r[IDX.assignee] + '|' + r[IDX.date]);

describe('listJobs: no filter', () => {
  it('returns every row when nothing is set', () => {
    expect(w.listJobs({}, ROWS)).toHaveLength(5);
  });
  it('survives an empty row set without throwing', () => {
    expect(w.listJobs({ person: 'Fiza' }, [])).toEqual([]);
  });
});

describe('listJobs: by person', () => {
  it('narrows to one teammate', () => {
    expect(ids(w.listJobs({ person: 'Sadia' }, ROWS))).toEqual(['Sadia|7/30/2026', 'Sadia|7/31/2026']);
  });
  it('an unknown name matches nothing rather than everything', () => {
    expect(w.listJobs({ person: 'Nobody' }, ROWS)).toEqual([]);
  });
});

describe('listJobs: by date', () => {
  it('from is inclusive of the day itself', () => {
    expect(w.listJobs({ from: '2026-07-31' }, ROWS)).toHaveLength(2);
  });
  it('to is inclusive of the day itself', () => {
    expect(w.listJobs({ to: '2026-07-29' }, ROWS)).toHaveLength(1);
  });
  it('from and to together give a closed range', () => {
    expect(w.listJobs({ from: '2026-07-30', to: '2026-07-30' }, ROWS)).toHaveLength(2);
  });
  it('reads the sheet\'s M/d/yyyy dates against an ISO picker value without a timezone shift', () => {
    // The same class of bug that dropped every boundary row in listCLEval.
    expect(w.listJobs({ from: '2026-07-30', to: '2026-07-31' }, ROWS)).toHaveLength(4);
  });
});

describe('listJobs: by applied and status', () => {
  it('applied yes returns only sent proposals', () => {
    expect(w.listJobs({ applied: 'yes' }, ROWS)).toHaveLength(3);
  });
  it('applied no returns only the ones we passed on', () => {
    expect(w.listJobs({ applied: 'no' }, ROWS)).toHaveLength(2);
  });
  it('filters on a recorded status', () => {
    expect(ids(w.listJobs({ status: 'Hired' }, ROWS))).toEqual(['Sadia|7/30/2026']);
  });
  it('treats the legacy "Un Opened" and a blank cell alike as Not checked', () => {
    // 664 live rows hold "Un Opened"; a blank means the same thing.
    expect(w.listJobs({ status: 'Not checked' }, ROWS)).toHaveLength(2);
  });
});

describe('listJobs: search', () => {
  it('matches the job title', () => {
    expect(ids(w.listJobs({ q: 'langgraph' }, ROWS))).toEqual(['Usman Saeed|7/31/2026']);
  });
  it('matches the reason column too', () => {
    expect(w.listJobs({ q: 'banned' }, ROWS)).toHaveLength(1);
  });
  it('is case insensitive', () => {
    expect(w.listJobs({ q: 'RAG' }, ROWS)).toHaveLength(1);
  });
});

describe('listJobs: filters combine', () => {
  it('person and applied together', () => {
    expect(w.listJobs({ person: 'Sadia', applied: 'yes' }, ROWS)).toHaveLength(1);
  });
  it('date range and applied together', () => {
    expect(w.listJobs({ from: '2026-07-31', applied: 'yes' }, ROWS)).toHaveLength(1);
  });
  it('a combination that matches nothing returns empty, not everything', () => {
    expect(w.listJobs({ person: 'Fiza', status: 'Hired' }, ROWS)).toEqual([]);
  });
});
