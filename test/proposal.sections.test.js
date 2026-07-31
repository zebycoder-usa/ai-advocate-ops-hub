// ============================================================================
// proposal.sections.test.js — CONTRACT tests for the NEW 'section' rule inside
// validateProposal() in index.html.
//
// STATUS: the 'section' rule does not exist yet. Every probe that says "this
// draft MUST report 'section'" is RED today, on purpose. This file is the
// specification the rule is implemented against; a failing assertion here is
// proof the budget check is still missing, not a bug in the test. Do not weaken
// an assertion to get green.
//
// HOW TO READ A GREEN LINE TODAY: the backwards-compatibility probes ("this
// draft must NOT report 'section'") pass while the rule is absent, because a
// rule that does not exist cannot raise a false positive. They start earning
// their keep the moment the rule lands, and they are the guarantee that today's
// unlabelled drafts are not suddenly blocked.
//
// THE CONTRACT under test — an addition to the existing global:
//
//   validateProposal(text, opts) -> { ok, violations: [ {rule, detail} ] }
//
//   'section'  a labelled section is outside its word budget.
//
//              Hook       25 to 30 words
//              Proof      35 to 45 words
//              Relevance  25 to 35 words
//              Process    30 to 40 words
//              CTA        15 to 20 words
//
//              Bounds are INCLUSIVE at both ends.
//
//              Sections are found by the labels the model emits: HOOK: PROOF:
//              RELEVANCE: PROCESS: CTA:, case insensitive, optionally wrapped in
//              markdown (**HOOK**, ## Hook, HOOK -).
//
//              The label itself is NOT one of the section's words.
//
//              The violation detail must NAME the section and state its ACTUAL
//              word count, so a bidder can see what to cut or pad.
//
//              Only the sections actually present are judged. A draft with no
//              section labels at all does not fire this rule, and the existing
//              120 to 180 word 'length' rule still governs it.
//
//              'section' and 'length' are independent: a draft whose sections
//              are each in budget can still be outside 120 to 180 overall, and
//              must then report 'length'.
//
// POLICY IS FROZEN: this suite tests mechanics only. It asserts nothing about
// scoring, bans, rates, or bands.
// ============================================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { loadApp } from './loadApp.js';

let app;
let validate;

// ---------------------------------------------------------------------------
// Safe caller. If validateProposal were missing entirely we must not crash every
// it() with a TypeError; the sentinel names the gap instead.
// ---------------------------------------------------------------------------
const MISSING = 'validateProposal-not-implemented';

function V(text, opts) {
  if (typeof validate !== 'function') {
    return {
      ok: false,
      violations: [{ rule: MISSING, detail: 'window.validateProposal(text, opts) is not defined in index.html' }],
    };
  }
  return validate(text, opts);
}

function rules(res) {
  return (res && Array.isArray(res.violations) ? res.violations : []).map((v) => v && v.rule);
}

// Everything the validator said about section budgets, as one lowercased blob.
// The contract does not fix whether one violation names every offending section
// or each section gets its own, so assertions read the blob and stay true either
// way.
function sectionSays(res) {
  return (res && Array.isArray(res.violations) ? res.violations : [])
    .filter((v) => v && v.rule === 'section')
    .map((v) => String(v.detail || ''))
    .join(' | ')
    .toLowerCase();
}

beforeAll(() => {
  app = loadApp();
  validate = app.window.validateProposal;
});

// ---------------------------------------------------------------------------
// Test data builders.
//
// Filler that trips no OTHER rule: no digits, no dashes, no brackets, no badge
// words, no first person singular. Only the word COUNT is under test in the
// synthetic probes, so the prose is deliberately inert.
// ---------------------------------------------------------------------------
const SAFE_WORDS = ['we', 'build', 'reliable', 'software', 'for', 'your', 'team', 'and', 'we', 'ship', 'it', 'early'];
function filler(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(SAFE_WORDS[i % SAFE_WORDS.length]);
  return out.join(' ');
}

const ORDER = ['hook', 'proof', 'relevance', 'process', 'cta'];
const LABEL = { hook: 'HOOK', proof: 'PROOF', relevance: 'RELEVANCE', process: 'PROCESS', cta: 'CTA' };
const BUDGET = { hook: [25, 30], proof: [35, 45], relevance: [25, 35], process: [30, 40], cta: [15, 20] };

// Label renderers. 'colon' is the plain form the prompt asks for; the rest are
// the markdown shapes the model actually emits in the wild.
const STYLE = {
  colon: (k) => LABEL[k] + ':',
  lower: (k) => LABEL[k].toLowerCase() + ':',
  title: (k) => LABEL[k][0] + LABEL[k].slice(1).toLowerCase() + ':',
  bold: (k) => '**' + LABEL[k] + '**',
  boldColon: (k) => '**' + LABEL[k] + ':**',
  heading: (k) => '## ' + LABEL[k][0] + LABEL[k].slice(1).toLowerCase(),
  dash: (k) => LABEL[k] + ' -',
};

// Build a labelled draft from explicit section TEXT.
function build(parts, style = 'colon') {
  const render = STYLE[style];
  return ORDER.filter((k) => parts[k] != null)
    .map((k) => render(k) + '\n' + parts[k])
    .join('\n\n');
}

// Build a labelled draft from section WORD COUNTS.
// Defaults sit comfortably inside every budget and total 149 words, so the
// baseline draft trips neither 'section' nor 'length'. Each probe moves exactly
// one section, and every variant below still totals inside 120 to 180, so a
// failure can only be the section rule.
const BASE = { hook: 27, proof: 40, relevance: 30, process: 35, cta: 17 };
function counted(overrides, style = 'colon') {
  const counts = Object.assign({}, BASE, overrides || {});
  const parts = {};
  ORDER.forEach((k) => {
    if (counts[k] == null) return;
    parts[k] = k === 'cta' ? filler(counts[k]) + '?' : filler(counts[k]);
  });
  return build(parts, style);
}

// Only the sections named, nothing else.
function only(counts, style = 'colon') {
  const parts = {};
  Object.keys(counts).forEach((k) => {
    parts[k] = k === 'cta' ? filler(counts[k]) + '?' : filler(counts[k]);
  });
  return build(parts, style);
}

const BARE = { proofBank: '', jobText: '', mode: 'proposal' };

// ---------------------------------------------------------------------------
// Two full, realistic agency proposals. Every figure in them is lifted from the
// real AGENCY_PROOF_BANK constant in index.html (asserted at the bottom of this
// file), so they must survive 'unbacked-number' as well as every other rule.
//
// Section counts, verified by the fixture self-check below:
//   A  hook 27, proof 41, relevance 30, process 37, cta 19   total 154
//   B  hook 27, proof 40, relevance 29, process 39, cta 18   total 153
// Both totals sit inside 120 to 180 whether or not the label words are counted.
// ---------------------------------------------------------------------------
const REAL_A_SECTIONS = {
  hook:
    'Your billing team is writing down revenue every month because manual invoice review cannot keep pace with the volume, ' +
    'and you want that recovered without adding headcount.',
  proof:
    'We built BillClear AI for a national law firm. It recovered 15% of written down revenue, cut manual review 80%, ' +
    'and kept submissions 100% compliant. MarketPulse Live, another build of ours, turns live earnings calls into insight in under 90 seconds.',
  relevance:
    'Your stack is the same shape: documents in, structured review out, with an audit trail your partners can defend. ' +
    'That is the work we do every week for regulated clients.',
  process:
    'First we sample a month of your invoices and agree what a correct write down looks like. Second we build the extraction ' +
    'and review pipeline on that sample. Third we hand it over with tests and documentation.',
  cta: 'Which billing system holds your invoices today, and can we see a redacted sample of a written down claim?',
};

const REAL_B_SECTIONS = {
  hook:
    'You are losing hours every week to manual resume screening, and the backlog grows faster than your recruiters can work ' +
    'through it, so good candidates go cold.',
  proof:
    'We built an AI resume screening system that parses at 94.7% accuracy, handles 200 resumes in 90 seconds, and cut screening ' +
    'time 80%. It has been in production on 500 applications a month, running on FastAPI, React, PostgreSQL and AWS.',
  relevance:
    'Your intake is the same problem in a different shape: messy files in, structured candidate records out, with scoring your ' +
    'recruiters can trust and explain to a hiring manager.',
  process:
    'First we map your current intake and agree what a correct parse looks like. Second we build the extraction and scoring ' +
    'pipeline on a sample of your own records. Third we wire it into your tracking system with tests.',
  cta: 'Where do your applications land today, and what formats do your recruiters see most often in that queue?',
};

// The drafts as the model would hand them over: the PROPOSAL label the app
// already looks for, then the five labelled sections.
const REAL_A = 'PROPOSAL\n' + build(REAL_A_SECTIONS, 'colon');
const REAL_B = 'PROPOSAL\n' + build(REAL_B_SECTIONS, 'bold');

const JOB_A = [
  'Senior AI Engineer for Legal Billing Review Automation',
  'Hourly: $75/hr',
  'Our billing team writes down revenue every month on invoices nobody has time to review.',
  'Client location: United States. Payment method verified.',
].join('\n');

const JOB_B = [
  'Full-Stack Engineer for Applicant Screening Dashboard',
  'Hourly: $65/hr',
  'We need resume intake parsed and scored so recruiters stop reading every file by hand.',
  'Client location: United Kingdom. Payment method verified.',
].join('\n');

// ===========================================================================
// 0. Fixture self-check.
//
// Not part of the contract: this proves the two realistic proposals really are
// inside every budget, so that if they later report 'section' the app is wrong,
// not the fixture.
// ===========================================================================
describe('fixture self-check: the two realistic proposals really are in budget', () => {
  const wc = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

  ORDER.forEach((k) => {
    it('proposal A: the ' + k + ' section sits inside its own word budget', () => {
      const n = wc(REAL_A_SECTIONS[k]);
      expect(n).toBeGreaterThanOrEqual(BUDGET[k][0]);
      expect(n).toBeLessThanOrEqual(BUDGET[k][1]);
    });

    it('proposal B: the ' + k + ' section sits inside its own word budget', () => {
      const n = wc(REAL_B_SECTIONS[k]);
      expect(n).toBeGreaterThanOrEqual(BUDGET[k][0]);
      expect(n).toBeLessThanOrEqual(BUDGET[k][1]);
    });
  });

  it('both proposals total between 120 and 180 words, labels counted or not', () => {
    [REAL_A_SECTIONS, REAL_B_SECTIONS].forEach((p) => {
      const total = ORDER.reduce((sum, k) => sum + wc(p[k]), 0);
      expect(total).toBeGreaterThanOrEqual(120);
      expect(total + ORDER.length).toBeLessThanOrEqual(180);
    });
  });
});

// ===========================================================================
// 1. A fully in-budget labelled proposal is clean.
// ===========================================================================
describe("a labelled proposal with every section in budget reports no 'section' problem", () => {
  it('the baseline labelled draft reports no section problem', () => {
    expect(rules(V(counted({}), BARE))).not.toContain('section');
  });

  it('the baseline labelled draft is not tripped up by any other rule either', () => {
    expect(rules(V(counted({}), BARE))).toEqual([]);
  });

  it('the tightest legal draft, every section at its minimum, reports nothing', () => {
    const tight = counted({ hook: 25, proof: 35, relevance: 25, process: 30, cta: 15 });
    expect(rules(V(tight, BARE))).toEqual([]);
  });

  it('the loosest legal draft, every section at its maximum, reports nothing', () => {
    const loose = counted({ hook: 30, proof: 45, relevance: 35, process: 40, cta: 20 });
    expect(rules(V(loose, BARE))).toEqual([]);
  });
});

// ===========================================================================
// 2. Each section, individually UNDER budget, is reported by name and count.
// ===========================================================================
describe('a section that is too SHORT is reported by name, with its real word count', () => {
  const SHORT = { hook: 20, proof: 25, relevance: 15, process: 20, cta: 8 };

  ORDER.forEach((k) => {
    it('a ' + k + ' section of ' + SHORT[k] + ' words, under its ' + BUDGET[k][0] + ' word floor, is reported', () => {
      const res = V(counted({ [k]: SHORT[k] }), BARE);
      expect(rules(res)).toContain('section');
    });

    it('the report for a short ' + k + ' section names the section, so the bidder knows where to write more', () => {
      const said = sectionSays(V(counted({ [k]: SHORT[k] }), BARE));
      expect(said).toContain(k);
    });

    it('the report for a short ' + k + ' section states its actual count of ' + SHORT[k] + ' words', () => {
      const said = sectionSays(V(counted({ [k]: SHORT[k] }), BARE));
      expect(said).toMatch(new RegExp('\\b' + SHORT[k] + '\\b'));
    });

    it('a short ' + k + ' section does not drag the other four sections into the report', () => {
      const said = sectionSays(V(counted({ [k]: SHORT[k] }), BARE));
      ORDER.filter((o) => o !== k).forEach((other) => {
        expect(said).not.toContain(other);
      });
    });
  });

  it('a short section alone does not fire the overall length rule, which is still satisfied', () => {
    // 20 + 40 + 30 + 35 + 17 = 142 words, comfortably inside 120 to 180. Only
    // the hook budget is broken here.
    const res = V(counted({ hook: 20 }), BARE);
    expect(rules(res)).toContain('section');
    expect(rules(res)).not.toContain('length');
  });
});

// ===========================================================================
// 3. Each section, individually OVER budget, is reported by name and count.
// ===========================================================================
describe('a section that is too LONG is reported by name, with its real word count', () => {
  const LONG = { hook: 40, proof: 60, relevance: 50, process: 55, cta: 30 };

  ORDER.forEach((k) => {
    it('a ' + k + ' section of ' + LONG[k] + ' words, over its ' + BUDGET[k][1] + ' word ceiling, is reported', () => {
      const res = V(counted({ [k]: LONG[k] }), BARE);
      expect(rules(res)).toContain('section');
    });

    it('the report for a long ' + k + ' section names the section, so the bidder knows where to cut', () => {
      const said = sectionSays(V(counted({ [k]: LONG[k] }), BARE));
      expect(said).toContain(k);
    });

    it('the report for a long ' + k + ' section states its actual count of ' + LONG[k] + ' words', () => {
      const said = sectionSays(V(counted({ [k]: LONG[k] }), BARE));
      expect(said).toMatch(new RegExp('\\b' + LONG[k] + '\\b'));
    });
  });

  it('two sections out of budget at once are both reported', () => {
    const said = sectionSays(V(counted({ hook: 40, cta: 30 }), BARE));
    expect(said).toContain('hook');
    expect(said).toContain('cta');
  });

  it('a long section alone does not fire the overall length rule, which is still satisfied', () => {
    // 27 + 60 + 30 + 35 + 17 = 169 words, still inside 120 to 180.
    const res = V(counted({ proof: 60 }), BARE);
    expect(rules(res)).toContain('section');
    expect(rules(res)).not.toContain('length');
  });
});

// ===========================================================================
// 4. Bounds are INCLUSIVE at both ends.
// ===========================================================================
describe('the word budgets are inclusive at both ends', () => {
  ORDER.forEach((k) => {
    it('a ' + k + ' section of exactly ' + BUDGET[k][0] + ' words, the floor, is accepted', () => {
      expect(rules(V(counted({ [k]: BUDGET[k][0] }), BARE))).not.toContain('section');
    });

    it('a ' + k + ' section of exactly ' + BUDGET[k][1] + ' words, the ceiling, is accepted', () => {
      expect(rules(V(counted({ [k]: BUDGET[k][1] }), BARE))).not.toContain('section');
    });

    it('a ' + k + ' section one word under the floor is rejected', () => {
      expect(rules(V(counted({ [k]: BUDGET[k][0] - 1 }), BARE))).toContain('section');
    });

    it('a ' + k + ' section one word over the ceiling is rejected', () => {
      expect(rules(V(counted({ [k]: BUDGET[k][1] + 1 }), BARE))).toContain('section');
    });
  });
});

// ===========================================================================
// 5. The label is not one of the words.
// ===========================================================================
describe('the section labels are not counted as words', () => {
  it('a hook of exactly 30 words passes, so the word "HOOK:" was not counted as a 31st', () => {
    expect(rules(V(counted({ hook: 30 }), BARE))).not.toContain('section');
  });

  it('a CTA of exactly 20 words passes, so the word "CTA:" was not counted as a 21st', () => {
    expect(rules(V(counted({ cta: 20 }), BARE))).not.toContain('section');
  });

  it('a hook of exactly 25 words passes, so a markdown label was not counted as one of the 25', () => {
    // If "**HOOK**" were swallowed into the section AND counted, this is 26 and
    // passes anyway; if the label were counted but the content miscounted low,
    // this is 24 and fails. Pinning the floor with a markdown label catches the
    // second mistake.
    expect(rules(V(counted({ hook: 25 }, 'bold'), BARE))).not.toContain('section');
  });

  it('a proof of exactly 45 words with a markdown label passes, the label is not a 46th word', () => {
    expect(rules(V(counted({ proof: 45 }, 'boldColon'), BARE))).not.toContain('section');
  });
});

// ===========================================================================
// 6. BACKWARDS COMPATIBILITY — unlabelled drafts are untouched.
//
// This is the promise to the twenty people already using the app: nothing they
// send today starts getting blocked because a rule they never opted into
// appeared. Only 'length' governs an unlabelled draft, exactly as it does now.
// ===========================================================================
describe('an unlabelled draft is not judged on section budgets at all', () => {
  it('a 140 word unlabelled draft reports nothing', () => {
    expect(rules(V(filler(140), BARE))).toEqual([]);
  });

  it('a 140 word unlabelled draft does not report a section problem', () => {
    expect(rules(V(filler(140), BARE))).not.toContain('section');
  });

  it('a 40 word unlabelled draft still reports the old length problem', () => {
    expect(rules(V(filler(40), BARE))).toContain('length');
  });

  it('a 40 word unlabelled draft reports length but NOT section', () => {
    expect(rules(V(filler(40), BARE))).not.toContain('section');
  });

  it('a 220 word unlabelled draft still reports the old length problem, and no section problem', () => {
    const r = rules(V(filler(220), BARE));
    expect(r).toContain('length');
    expect(r).not.toContain('section');
  });

  it('an unlabelled draft under the PROPOSAL heading is still not judged on sections', () => {
    expect(rules(V('PROPOSAL\n' + filler(140), BARE))).not.toContain('section');
  });

  it('prose that merely uses the words hook, proof and process is not treated as labelled', () => {
    // The trap: the rule must key on a LABEL LINE, not on the word appearing in
    // a sentence. This draft is 130 words of ordinary prose.
    const prose =
      'We open with the hook your brief already gives us, we bring one proof point from work we shipped, ' +
      'and we set out a process you can follow. ' + filler(105);
    const r = rules(V(prose, BARE));
    expect(r).not.toContain('section');
  });
});

// ===========================================================================
// 7. A partially labelled draft reports only on the sections present.
// ===========================================================================
describe('a partially labelled draft is judged only on the sections it actually has', () => {
  it('a draft with only HOOK and CTA, both in budget, reports no section problem', () => {
    expect(rules(V(only({ hook: 27, cta: 17 }), BARE))).not.toContain('section');
  });

  it('a draft with only HOOK and CTA does not complain about the missing proof section', () => {
    const said = sectionSays(V(only({ hook: 27, cta: 17 }), BARE));
    expect(said).not.toContain('proof');
  });

  it('a draft with only HOOK and CTA does not complain about the missing relevance or process sections', () => {
    const said = sectionSays(V(only({ hook: 27, cta: 17 }), BARE));
    expect(said).not.toContain('relevance');
    expect(said).not.toContain('process');
  });

  it('an over-long CTA in a HOOK plus CTA draft is still reported', () => {
    const res = V(only({ hook: 27, cta: 30 }), BARE);
    expect(rules(res)).toContain('section');
    expect(sectionSays(res)).toContain('cta');
  });

  it('an over-long CTA in a HOOK plus CTA draft does not drag the hook into the report', () => {
    expect(sectionSays(V(only({ hook: 27, cta: 30 }), BARE))).not.toContain('hook');
  });

  it('a draft with only PROOF, out of budget, is reported on proof alone', () => {
    const said = sectionSays(V(only({ proof: 60 }), BARE));
    expect(said).toContain('proof');
    expect(said).not.toContain('hook');
    expect(said).not.toContain('cta');
  });
});

// ===========================================================================
// 8. Markdown wrapped and differently cased labels are recognised.
// ===========================================================================
describe('the labels are recognised however the model dresses them up', () => {
  const STYLES = [
    ['plain HOOK: labels', 'colon'],
    ['lower case hook: labels', 'lower'],
    ['title case Hook: labels', 'title'],
    ['bold **HOOK** labels', 'bold'],
    ['bold **HOOK:** labels', 'boldColon'],
    ['markdown ## Hook headings', 'heading'],
    ['HOOK - dashed labels', 'dash'],
  ];

  STYLES.forEach(([name, style]) => {
    it('with ' + name + ', an in-budget draft reports no section problem', () => {
      expect(rules(V(counted({}, style), BARE))).not.toContain('section');
    });

    it('with ' + name + ', an over-long proof section is still caught', () => {
      const res = V(counted({ proof: 60 }, style), BARE);
      expect(rules(res)).toContain('section');
      expect(sectionSays(res)).toContain('proof');
    });

    it('with ' + name + ', a too-short hook is still caught and named', () => {
      const res = V(counted({ hook: 20 }, style), BARE);
      expect(rules(res)).toContain('section');
      expect(sectionSays(res)).toContain('hook');
    });
  });

  it('a "HOOK -" label does not itself count as a dash violation', () => {
    // The dash rule is about em and en dashes. A plain hyphen in a label is not
    // one, and must not block the bid.
    expect(rules(V(counted({}, 'dash'), BARE))).not.toContain('dash');
  });
});

// ===========================================================================
// 9. 'section' and 'length' are independent.
// ===========================================================================
describe('the overall 120 to 180 word rule still applies to a labelled draft', () => {
  it('a labelled draft whose sections are all in budget but which totals only 44 words reports length', () => {
    // HOOK 27 plus CTA 17. Both inside their budgets, the draft as a whole is
    // far too short to send.
    const res = V(only({ hook: 27, cta: 17 }), BARE);
    expect(rules(res)).toContain('length');
  });

  it('that same too-short labelled draft reports length WITHOUT inventing a section problem', () => {
    expect(rules(V(only({ hook: 27, cta: 17 }), BARE))).not.toContain('section');
  });

  it('a labelled draft with every section at its maximum plus a long preamble reports length', () => {
    // Sections total 170, each in budget. A 40 word preamble ahead of the first
    // label pushes the sendable draft past 180.
    const draft = filler(40) + '\n\n' + counted({ hook: 30, proof: 45, relevance: 35, process: 40, cta: 20 });
    expect(rules(V(draft, BARE))).toContain('length');
  });

  it('that over-long labelled draft does NOT report a section problem, because every section is in budget', () => {
    const draft = filler(40) + '\n\n' + counted({ hook: 30, proof: 45, relevance: 35, process: 40, cta: 20 });
    expect(rules(V(draft, BARE))).not.toContain('section');
  });

  it('a draft can report both length and section at once', () => {
    // Sections total 40 plus an 80 word hook: the hook is over budget AND the
    // whole thing is short.
    const res = V(only({ hook: 80, cta: 17 }), BARE);
    expect(rules(res)).toContain('section');
    expect(rules(res)).toContain('length');
  });

  it("a labelled draft in mode 'speed' is not judged on the overall length", () => {
    const speed = { proofBank: '', jobText: '', mode: 'speed' };
    expect(rules(V(only({ hook: 27, cta: 17 }), speed))).not.toContain('length');
  });
});

// ===========================================================================
// 10. The existing rules still fire inside labelled sections.
//
// Adding section budgets must not create a blind spot: a dash, a placeholder or
// a badge claim written INSIDE a labelled section is exactly as unsendable as
// one written in a plain draft.
// ===========================================================================
describe('the old rules still fire on a labelled draft', () => {
  // Each injection is short enough that every section stays inside its budget,
  // so the only thing these drafts can report is the injected fault.
  const DIRTY = build({
    hook: 'Hello [Client Name], ' + filler(25),
    proof: filler(20) + ' — ' + filler(19),
    relevance: 'We are a Top Rated team, ' + filler(24),
    process: filler(35),
    cta: filler(17) + '?',
  });

  it('an em dash inside the proof section is still caught', () => {
    expect(rules(V(DIRTY, BARE))).toContain('dash');
  });

  it('a bracket placeholder inside the hook section is still caught', () => {
    expect(rules(V(DIRTY, BARE))).toContain('placeholder');
  });

  it('a badge claim inside the relevance section is still caught', () => {
    expect(rules(V(DIRTY, BARE))).toContain('badge');
  });

  it('all three faults are reported together, not one at a time', () => {
    const r = rules(V(DIRTY, BARE));
    expect(r).toContain('dash');
    expect(r).toContain('placeholder');
    expect(r).toContain('badge');
  });

  it('the dirty draft is not ok', () => {
    expect(V(DIRTY, BARE).ok).toBe(false);
  });

  it('an invented number inside a labelled proof section is still caught', () => {
    const draft = counted({});
    const withNumber = draft.replace('PROOF:\n', 'PROOF:\nWe cut costs 47% for a similar team. ');
    expect(rules(V(withNumber, BARE))).toContain('unbacked-number');
  });

  it('mixing "I" with "we" inside a labelled section is still caught', () => {
    const draft = counted({});
    const withI = draft.replace('PROCESS:\n', 'PROCESS:\nI will run the build. ');
    expect(rules(V(withI, BARE))).toContain('voice');
  });
});

// ===========================================================================
// 11. Two full, realistic, sendable agency proposals.
//
// These are the acceptance cases: real prose, real proof bank figures, correct
// voice, every section in budget. If the guard blocks either of these it is
// blocking good work.
// ===========================================================================
describe('two complete labelled agency proposals pass every rule', () => {
  it('the real AGENCY_PROOF_BANK is available and carries the figures these proposals cite', () => {
    const bank = app.window.AGENCY_PROOF_BANK;
    expect(typeof bank).toBe('string');
    ['15%', '80%', '90 seconds', '94.7', '200 resumes', '500'].forEach((fig) => {
      expect(bank).toContain(fig);
    });
  });

  it('proposal A, the legal billing draft, reports no section problem', () => {
    const opts = { proofBank: app.window.AGENCY_PROOF_BANK, jobText: JOB_A, mode: 'proposal' };
    expect(rules(V(REAL_A, opts))).not.toContain('section');
  });

  it('proposal A passes every rule and is ok', () => {
    const opts = { proofBank: app.window.AGENCY_PROOF_BANK, jobText: JOB_A, mode: 'proposal' };
    const res = V(REAL_A, opts);
    expect(rules(res)).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('proposal B, the resume screening draft with markdown labels, reports no section problem', () => {
    const opts = { proofBank: app.window.AGENCY_PROOF_BANK, jobText: JOB_B, mode: 'proposal' };
    expect(rules(V(REAL_B, opts))).not.toContain('section');
  });

  it('proposal B passes every rule and is ok', () => {
    const opts = { proofBank: app.window.AGENCY_PROOF_BANK, jobText: JOB_B, mode: 'proposal' };
    const res = V(REAL_B, opts);
    expect(rules(res)).toEqual([]);
    expect(res.ok).toBe(true);
  });

  it('padding proposal A\'s hook past 30 words is the one thing that breaks it', () => {
    const opts = { proofBank: app.window.AGENCY_PROOF_BANK, jobText: JOB_A, mode: 'proposal' };
    const padded = Object.assign({}, REAL_A_SECTIONS, {
      hook: REAL_A_SECTIONS.hook + ' We can start on this within the week and we work in your time zone.',
    });
    const res = V('PROPOSAL\n' + build(padded, 'colon'), opts);
    expect(rules(res)).toContain('section');
    expect(sectionSays(res)).toContain('hook');
  });

  it("trimming proposal B's CTA below 15 words is the one thing that breaks it", () => {
    const opts = { proofBank: app.window.AGENCY_PROOF_BANK, jobText: JOB_B, mode: 'proposal' };
    const trimmed = Object.assign({}, REAL_B_SECTIONS, { cta: 'Where do your applications land today?' });
    const res = V('PROPOSAL\n' + build(trimmed, 'bold'), opts);
    expect(rules(res)).toContain('section');
    expect(sectionSays(res)).toContain('cta');
  });
});

// ===========================================================================
// 12. ok semantics and safety.
// ===========================================================================
describe('ok semantics and safety', () => {
  it('a section budget breach on its own is enough to make ok false', () => {
    const res = V(counted({ hook: 20 }), BARE);
    expect(rules(res)).toContain('section');
    expect(res.ok).toBe(false);
  });

  it('every section violation carries a non-empty rule id and a non-empty detail', () => {
    const res = V(counted({ hook: 20, cta: 30 }), BARE);
    const hits = res.violations.filter((v) => v.rule === 'section');
    expect(hits.length).toBeGreaterThan(0);
    hits.forEach((v) => {
      expect(typeof v.detail).toBe('string');
      expect(v.detail.length).toBeGreaterThan(0);
    });
  });

  it('the rule id is exactly "section", not a variant spelling', () => {
    const ids = rules(V(counted({ hook: 20 }), BARE));
    expect(ids).toContain('section');
  });

  it('checking section budgets issues no fetch of any kind', () => {
    const before = app.fetchCalls.length;
    V(counted({}), BARE);
    V(counted({ hook: 20, proof: 60 }), BARE);
    V(REAL_A, { proofBank: app.window.AGENCY_PROOF_BANK, jobText: JOB_A, mode: 'proposal' });
    V(filler(140), BARE);
    expect(app.fetchCalls.length).toBe(before);
  });

  it('the only fetch the harness ever saw is the blocked seat-boot call', () => {
    expect(app.fetchCalls.length).toBeGreaterThan(0); // otherwise this is vacuous
    app.fetchCalls.forEach((u) => {
      expect(String(u)).toMatch(/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/);
    });
  });
});
