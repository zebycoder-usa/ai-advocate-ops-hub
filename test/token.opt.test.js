// The token and speed cuts, and the traps each one carries.
//
// Every optimization here is invisible when it breaks. A trim that empties the
// prompt still returns a proposal, just a worse one. A cache prefix that drifts
// by one byte still works, it just silently costs full price forever. A scorer
// model the proxy does not recognise is silently rewritten to Sonnet, so the
// saving looks shipped and never happens. None of that shows up in the UI, which
// is exactly why it needs tests.
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadApp } from './loadApp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixture = (n) => readFileSync(join(__dirname, 'fixtures', n), 'utf8');
const FIXTURES = ['job_n8n.txt', 'job_voice.txt', 'job_browserext.txt'];

// Every one of the three real fixtures is a HARD BAN: two are fixed-price under
// $200 and one is a Pakistan client. So none of them can reach the model at all,
// and any test that needs the spending path needs a job that is actually biddable.
const CLEAN_JOB = [
  'Senior RAG Engineer for Internal Knowledge Assistant',
  'Hourly: $60.00-$85.00',
  'Expert  Est. time: 3 to 6 months, 30+ hrs/week',
  '',
  'We need an engineer to build a retrieval assistant over roughly 12,000 internal',
  'support documents. Our team currently answers the same questions by hand and it',
  'is eating the week. We want grounded answers with citations back to the source.',
  '',
  'Skills and expertise',
  'Python  LangChain  Pinecone  FastAPI  React',
  '',
  'Activity on this job',
  'Proposals: 5 to 10',
  'Last viewed by client: 2 hours ago',
  'Interviewing: 1',
  'Invites sent: 0',
  'Unanswered invites: 0',
  '',
  'About the client',
  'Payment method verified',
  'Phone number verified',
  'United States',
  'Austin 9:14 am',
  '14 jobs posted',
  '71% hire rate, 3 open jobs',
  '$40K total spent',
  '11 hires, 2 active',
  '',
  "Client's recent history",
  'Data pipeline cleanup  5.00  Mar 2026  $4,200',
  'Internal tooling revamp  5.00  Jan 2026  $9,800',
  'Legacy migration  4.90  Nov 2025  $12,400',
  '',
  'Other open jobs by this client',
  'Frontend engineer for admin console',
  'DevOps contractor for CI pipeline',
  '',
  'Footer navigation',
  'About us  Terms  Privacy  Help',
].join('\n');

let app, w, doc;
beforeEach(() => { app = loadApp(); w = app.window; doc = app.doc; });

describe('the fixtures themselves', () => {
  it('every real fixture is a hard ban, so none of them can reach the model', () => {
    // Recorded because it is surprising and it shapes every test below: the
    // repo has no real fixture for a job that actually earns a proposal.
    FIXTURES.forEach((f) => {
      w.setVal('job-text', fixture(f));
      expect(w.evalDecision().banned).toBe(true);
    });
  });

  it('the inline clean job is genuinely biddable, or the spend tests prove nothing', () => {
    w.setVal('job-text', CLEAN_JOB);
    const d = w.evalDecision();
    expect(d.banned).toBe(false);
    expect(/^APPLY/.test(d.decision)).toBe(true);
  });
});

/* Captures every /api/claude body this window sends. */
function captureClaude() {
  const sent = [];
  w.fetch = async (url, opts) => {
    const u = String(url);
    let body = null;
    try { body = JSON.parse(String((opts && opts.body) || '{}')); } catch { body = null; }
    sent.push({ url: u, body });
    return {
      ok: true, status: 200, text: async () => '',
      json: async () => ({ content: [{ type: 'text', text: 'PROPOSAL\nSome text.' }] }),
    };
  };
  return sent;
}

const flush = async () => {
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 12; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

describe('modelJobText_: trimming the page must never cost the job', () => {
  it('never returns more text than it was given', () => {
    // pageSections_ initialises job, activity and client all to head, so
    // job+activity+client emits a marker-less paste THREE times. This is the
    // assertion that makes that mistake impossible to reintroduce.
    const bare = 'Senior Python engineer needed to build a RAG pipeline over our docs.';
    expect(w.modelJobText_(bare).length).toBeLessThanOrEqual(bare.length);
    FIXTURES.forEach((f) => {
      const t = fixture(f);
      expect(w.modelJobText_(t).length).toBeLessThanOrEqual(t.length);
    });
  });

  const degenerate = [
    ['an empty string', ''],
    ['whitespace only', '   \n\t  '],
    ['null', null],
    ['undefined', undefined],
    ['a bare description with no Upwork chrome', 'Build me an n8n workflow that syncs Stripe to Sheets.'],
    ['a job forwarded by email', 'Hi team,\n\nSaw this one, worth a look?\n\nNeed a LangChain dev for a chatbot.'],
    ['a paste that starts at the client panel', 'About the client\nPayment method verified\nUnited States\nAustin 9:14 am'],
    ['a paste that starts at the activity panel', 'Activity on this job\nProposals: 5 to 10\nLast viewed by client: 2 hours ago'],
    ['Account Settings appearing at the very end', 'Need a computer vision engineer for defect detection on a production line, OpenCV and PyTorch, 6 week engagement.\nAccount Settings'],
  ];

  degenerate.forEach(([label, input]) => {
    it('falls back to the untouched paste for ' + label, () => {
      // Failing open costs the saving. Failing closed sends the model nothing
      // and it writes a proposal for a job it cannot see.
      expect(w.modelJobText_(input)).toBe(String(input == null ? '' : input));
    });
  });

  it('never hands the model an empty prompt for a non-empty paste', () => {
    degenerate.forEach(([, input]) => {
      const raw = String(input == null ? '' : input);
      if (!raw.trim()) return;
      expect(w.modelJobText_(input).trim().length).toBeGreaterThan(0);
    });
  });

  it('actually cuts a real Upwork page, and keeps the facts a proposal needs', () => {
    FIXTURES.forEach((f) => {
      const raw = fixture(f);
      const out = w.modelJobText_(raw);
      expect(out.length).toBeLessThan(raw.length);          // something was cut
      expect(out.length).toBeGreaterThan(400);              // and it is not a stub
      expect(/proposals/i.test(out)).toBe(true);            // saturation signal survives
      expect(/\$|hourly|fixed/i.test(out)).toBe(true);      // budget survives
    });
  });

  it('drops a meaningful share of a real page', () => {
    const raw = fixture('job_n8n.txt');
    expect(w.modelJobText_(raw).length).toBeLessThan(raw.length * 0.75);
  });
});

describe('the trim is for the model payload only', () => {
  it('does not change the deterministic score', () => {
    // The 19-point score and the ban scan read the full paste. If a future edit
    // reassigns jd instead of trimming only the payload, this fails.
    FIXTURES.forEach((f) => {
      const raw = fixture(f);
      w.setVal('job-text', raw);
      const full = w.evalDecision();
      w.setVal('job-text', w.modelJobText_(raw));
      const trimmed = w.evalDecision();
      expect(trimmed.total).toBe(full.total);
      expect(trimmed.banned).toBe(full.banned);
    });
  });
});

describe('prompt caching: one prefix, byte identical, or it is worth nothing', () => {
  it('buildContext() is pure, so the cached prefix is stable', () => {
    expect(w.buildContext()).toBe(w.buildContext());
    expect(w.buildContext()).toBe(w.AGENCY_CONTEXT);
  });

  it('genProposal sends AGENCY_CONTEXT as a cached system block', async () => {
    const sent = captureClaude();
    w.setVal('job-text', CLEAN_JOB);
    await w.genProposal('priority');
    const req = sent.find((s) => s.url === '/api/claude');
    expect(req).toBeDefined();
    expect(Array.isArray(req.body.system)).toBe(true);
    expect(req.body.system[0].text).toBe(w.AGENCY_CONTEXT);
    expect(req.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('aiAnalyzeJob sends the SAME prefix, with its task text in a second block', async () => {
    // It used to concatenate the task onto AGENCY_CONTEXT into one string, which
    // would have keyed its own cache entry and shared nothing with the others.
    const sent = captureClaude();
    doc.body.insertAdjacentHTML('beforeend', '<div id="eval-ai"></div>');
    await w.aiAnalyzeJob(fixture('job_voice.txt'), { total: 15, max: 19, decision: 'APPLY STANDARD', banned: false });
    const req = sent.find((s) => s.url === '/api/claude');
    expect(req.body.system[0].text).toBe(w.AGENCY_CONTEXT);
    expect(req.body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.body.system[1].text).toBe(w.ANALYZE_TASK);
    expect(req.body.system[1].cache_control).toBeUndefined();
  });

  it('the cached prefix clears the 1024-token minimum for Sonnet', () => {
    // Below the model minimum a breakpoint is a silent no-op: no error, no hit.
    expect(w.AGENCY_CONTEXT.length / 3.6).toBeGreaterThan(1024);
  });

  it('the analysis task text is not folded into the cached block', () => {
    expect(w.AGENCY_CONTEXT).not.toContain('FIT / RISKS');
    expect(w.AGENCY_CONTEXT.indexOf('You are analysing ONE Upwork job post')).toBe(-1);
  });
});

describe('the scorer model has to be one the proxy actually accepts', () => {
  it('uses a model id on the api/claude allowlist', () => {
    // api/claude.js allows exactly these two. Anything else is rewritten to
    // Sonnet with no error and nothing here reads the model back, so an alias
    // typo would be a permanent silent Sonnet bill.
    const ALLOWED = new Set(['claude-sonnet-4-6', 'claude-haiku-4-5-20251001']);
    expect(ALLOWED.has(w.CL_SCORE_MODEL)).toBe(true);
  });

  it('is not the bare alias, which the proxy silently downgrades', () => {
    expect(w.CL_SCORE_MODEL).not.toBe('claude-haiku-4-5');
  });

  it('the allowlist in api/claude.js still contains the model we send', () => {
    const proxy = readFileSync(join(__dirname, '..', 'api', 'claude.js'), 'utf8');
    expect(proxy).toContain(w.CL_SCORE_MODEL);
  });

  it('scoreDraft actually sends that model', async () => {
    const sent = [];
    w.fetch = async (url, opts) => {
      sent.push(JSON.parse(String(opts.body)));
      return { ok: true, status: 200, text: async () => '',
        json: async () => ({ content: [{ type: 'text', text: '{"hook":2,"proof":2,"plan":2,"close":1.5,"style":1.5,"len":1}' }] }) };
    };
    await w.scoreDraft('PROPOSAL\nSome words.', 'JOB');
    expect(sent[0].model).toBe(w.CL_SCORE_MODEL);
  });
});

describe('a smaller scorer must not turn into blocked proposals', () => {
  it('retries once when the first reply is unparseable', async () => {
    let n = 0;
    w.fetch = async () => {
      n++;
      const text = n === 1 ? 'Sure! Here is my assessment of the proposal.'
                           : '{"hook":2,"proof":2,"plan":2,"close":1.5,"style":1.5,"len":1}';
      return { ok: true, status: 200, text: async () => '', json: async () => ({ content: [{ type: 'text', text }] }) };
    };
    const sc = await w.scoreDraft('PROPOSAL\nWords.', 'JOB');
    expect(sc).not.toBeNull();
    expect(sc.total).toBe(10);
    expect(n).toBe(2);
  });

  it('gives up after exactly two attempts, and reports unscored rather than zero', async () => {
    let n = 0;
    w.fetch = async () => {
      n++;
      return { ok: true, status: 200, text: async () => '', json: async () => ({ content: [{ type: 'text', text: 'not json' }] }) };
    };
    expect(await w.scoreDraft('PROPOSAL\nWords.', 'JOB')).toBeNull();
    expect(n).toBe(2);
  });

  it('parses JSON wrapped in a markdown fence', () => {
    const r = w.parseScoreJson('```json\n{"hook":2,"proof":2,"plan":2,"close":1.5,"style":1.5,"len":1}\n```');
    expect(r.parseFailed).toBeFalsy();
    expect(r.hook).toBe(2);
  });

  it('parses JSON with a trailing comma, which is the defect small models emit', () => {
    const r = w.parseScoreJson('{"hook":2,"proof":1,"plan":2,"close":1,"style":1,"len":1,}');
    expect(r.parseFailed).toBeFalsy();
    expect(r.proof).toBe(1);
  });

  it('treats a dropped dimension as unscored, not as a low score', () => {
    // Omitting "len" silently cost a full point and told the bidder "Scored 9.0,
    // it must reach 9.0", which is indistinguishable from weak writing.
    expect(w.clampScore({ hook: 2, proof: 2, plan: 2, close: 1.5, style: 1.5 }).parseFailed).toBe(true);
    expect(w.clampScore({ hook: 2, proof: 2, plan: 2, close: 1.5, style: 1.5, len: 1 }).parseFailed).toBe(false);
  });

  it('an unscored draft cannot be sent', () => {
    expect(w.sendVerdict({ ok: true }, null).canSend).toBe(false);
    expect(w.sendVerdict({ ok: true }, w.clampScore({ hook: 2, proof: 2, plan: 2, close: 1.5, style: 1.5 })).canSend).toBe(false);
  });
});

describe('a hard ban must not cost a model call', () => {
  const BANNED_JOB = [
    'Crypto Trading Bot Developer Needed',
    'Hourly: $50.00-$70.00',
    'We need an experienced developer to build an automated crypto trading bot',
    'for our forex and cryptocurrency desk.',
    '',
    'Activity on this job',
    'Proposals: 5 to 10',
    '',
    'About the client',
    'Payment method verified',
    'United States',
  ].join('\n');

  it('evaluateJob renders the ban and asks the model nothing', async () => {
    const sent = captureClaude();
    w.setVal('job-text', BANNED_JOB);
    w.evaluateJob();
    await flush();
    expect(sent.filter((s) => s.url === '/api/claude')).toHaveLength(0);
    expect(doc.getElementById('eval-ai').textContent).toMatch(/hard ban/i);
  });

  it('genProposal already refused to spend on a banned job, and still does', async () => {
    const sent = captureClaude();
    w.setVal('job-text', BANNED_JOB);
    await w.genProposal('priority');
    expect(sent.filter((s) => s.url === '/api/claude')).toHaveLength(0);
  });

  it('a clean job DOES still get its analysis, so the skip is not over-broad', async () => {
    const sent = captureClaude();
    w.setVal('job-text', CLEAN_JOB);
    w.evaluateJob();
    await flush();
    expect(sent.filter((s) => s.url === '/api/claude').length).toBeGreaterThan(0);
  });
});

describe('the send bar is stated where people can see it', () => {
  it('the standing rule card exists on the Evaluate screen', () => {
    const pill = doc.getElementById('send-bar-pill');
    expect(pill).not.toBeNull();
    const card = pill.closest('.card');
    expect(card.textContent).toMatch(/scored out of 10/i);
    expect(card.textContent).toMatch(/locked/i);
  });

  it('the rule card sits in the Evaluate view, not somewhere nobody looks', () => {
    expect(doc.getElementById('send-bar-pill').closest('.view').getAttribute('data-view')).toBe('evaluate');
  });

  it('the 10-point rubric survived the CL tab and is built from CL_RUBRIC', () => {
    w.renderScoring();
    const txt = doc.getElementById('scoring').textContent;
    expect(txt).toContain(w.CL_SEND_THRESHOLD.toFixed(1));
    w.CL_RUBRIC.forEach((r) => expect(txt).toContain(r.label));
  });

  it('no user-facing string in the new rule card uses a dash character', () => {
    const card = doc.getElementById('send-bar-pill').closest('.card');
    expect(card.textContent).not.toMatch(/[—–]/);
  });
});
