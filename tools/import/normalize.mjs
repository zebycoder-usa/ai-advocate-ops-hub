// Turns the exported CLEval CSV into clean job documents.
//
// Pure functions only: no filesystem, no network, no Firestore. That keeps every
// decision below testable, because the decisions are the risky part of an import,
// not the writing.
//
// What the 1 Aug 2026 export actually contained, and why each rule exists, is
// recorded next to the rule. This file is the record of what we chose to do with
// 681 rows of real history.

/** RFC4180-ish. Handles quoted fields, "" escapes, commas and newlines inside
 *  quotes. The Reason/Remarks column contains all three, so a split(',') import
 *  would have silently shredded the file. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''));
}

/* The sheet's header labels differ from the app's field names in two places, and
   the sheet has trailing spaces in three. Matching on a normalised key rather
   than an exact string means a stray space never silently drops a column. */
const KEY = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const FIELD_BY_HEADER = {
  assignee: 'assignee',
  date: 'date',
  timepkt: 'timePkt',
  jobtitle: 'jobTitle',
  joblink: 'jobLink',
  joblinkrecovered: 'jobLink',        // the recovery script's column wins if present
  hiringrate: 'hiringRate',
  clientratings: 'clientRatings',
  paymentmethodverified: 'payVerified',
  totalspend: 'totalSpend',
  proposals: 'proposals',
  interviewing: 'interviewing',
  invitessent: 'invitesSent',
  unansweredinvites: 'unansweredInvites',
  flag: 'flag',
  applied: 'applied',
  fixedhourly: 'fixedHourly',
  highbid: 'highBid',
  avgbid: 'avgBid',
  lowbid: 'lowBid',
  noofconnectsused: 'connects',       // sheet says "No. of Connects Used"
  noofconnects: 'connects',           // app says "No. of Connects"
  pricerate: 'bid',                   // sheet says "Price/ Rate"
  bid: 'bid',                         // app says "Bid"
  reasonremarks: 'reason',
  jobposted: 'jobPosted',
  openjobs: 'openJobs',
  ptoposalstatus: 'proposalStatus',   // the team's typo, preserved deliberately
  proposalstatus: 'proposalStatus',
};

/* Values that mean "nothing here". The sheet writes "-" for an absent job link,
   and the formula-injection guard prefixes an apostrophe to a leading dash, so
   "'-" is the same thing. "URL" is the display text of a rich-text cell whose
   address CSV could not carry: it is not an address and must never be stored as
   one. */
const EMPTYISH = new Set(['', '-', "'-", 'n/a', 'na', 'none', 'null', 'undefined']);
export const isEmptyish = (v) => EMPTYISH.has(String(v == null ? '' : v).trim().toLowerCase());

export const cleanCell = (v) => {
  const s = String(v == null ? '' : v).trim();
  // Undo the formula-injection guard so values read naturally again.
  return s.startsWith("'") ? s.slice(1) : s;
};

/** A job link only counts if it is really a link. "URL" is the flattened display
 *  text of a hyperlink CSV could not export, so it is dropped rather than stored
 *  as a fake address that would poison duplicate detection forever. */
export function cleanJobLink(v) {
  const s = cleanCell(v);
  if (isEmptyish(s)) return '';
  if (/^url$/i.test(s)) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  return s;
}

/** The Upwork job id inside a link. Matching on the id rather than the URL string
 *  means www, query strings, trailing slashes and casing all still match. */
export function jobIdOf(link) {
  const m = String(link || '').match(/~([0-9a-z]{10,})/i);
  return m ? m[1].toLowerCase() : '';
}

/** "7/7/2026" or "12/31/2026" -> "2026-07-07". Returns '' rather than guessing
 *  when the shape is unfamiliar, because a wrong date is worse than no date. */
export function toISODate(v) {
  const s = cleanCell(v);
  if (!s) return '';
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const [, mo, d, y] = m;
    return `${y}-${String(+mo).padStart(2, '0')}-${String(+d).padStart(2, '0')}`;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return '';
}

const YES = (v) => /^y(es)?$/i.test(cleanCell(v));

/* "Un Opened" is the legacy default the sheet writes on every new row. It means
   "nobody has recorded an outcome", which is NOT the same as "the client did not
   open it" even though it reads that way. Keeping the raw value and adding an
   explicit flag means we can measure real outcome coverage instead of inferring
   it from a string that lies. */
export const LEGACY_STATUS = 'Un Opened';
export const hasOutcome = (status) => {
  const s = cleanCell(status);
  return !!s && s.toLowerCase() !== LEGACY_STATUS.toLowerCase();
};

/* The sheet uses first names; the app roster uses display names. Mapping here
   keeps the imported data joinable to the roster instead of stranding it. */
const PEOPLE = {
  jahanzaib: 'Jahanzaib (Zeb)',
  zeb: 'Jahanzaib (Zeb)',
  fiza: 'Fiza',
  sadia: 'Sadia',
  subhan: 'Subhan',
  hamza: 'Hamza',
  kaleem: 'Kaleem',
  sana: 'Sana',
  ayesha: 'Ayesha',
  usmansaeed: 'Usman Saeed',
  usman: 'Usman Saeed',
  waqasriaz: 'Waqas Riaz',
  waqas: 'Waqas Riaz',
  saqibshahzad: 'Saqib Shahzad',
  saqib: 'Saqib Shahzad',
};
export const normalizePerson = (v) => {
  const s = cleanCell(v);
  return PEOPLE[KEY(s)] || s;
};

/** True for a row that is a repeated header rather than data. The export contains
 *  seven of these, presumably from per-person sections in the sheet. Importing
 *  them would create seven jobs titled "Job Title". */
export function isHeaderRow(rec) {
  return KEY(rec.jobTitle) === 'jobtitle' || KEY(rec.assignee) === 'assignee';
}

/** A stable id, so re-running the import updates rather than duplicates.
 *  Prefers the Upwork job id. Falls back to person + date + title, which is what
 *  distinguishes two rows with no link. */
export function docIdFor(rec) {
  const id = jobIdOf(rec.jobLink);
  if (id) return 'job_' + id;
  const basis = [rec.assignee, rec.date, rec.jobTitle].map((x) => cleanCell(x).toLowerCase()).join('|');
  let h = 5381;
  for (let i = 0; i < basis.length; i++) h = ((h * 33) ^ basis.charCodeAt(i)) >>> 0;
  return 'row_' + h.toString(36);
}

/** header row -> field name per column index. */
export function mapHeader(header) {
  return header.map((h) => FIELD_BY_HEADER[KEY(h)] || null);
}

/** One CSV row -> one job document, or null if the row is not data. */
export function toDoc(fields, row) {
  const rec = {};
  fields.forEach((f, i) => {
    if (!f) return;
    // A later column with the same field wins, which is how the recovered link
    // column overrides the flattened "URL" one.
    const v = row[i];
    if (f === 'jobLink') { const l = cleanJobLink(v); if (l || rec.jobLink === undefined) rec.jobLink = l; return; }
    rec[f] = cleanCell(v);
  });
  if (isHeaderRow(rec)) return null;
  if (!cleanCell(rec.jobTitle) && !rec.jobLink) return null;   // nothing identifying

  const link = rec.jobLink || '';
  const status = cleanCell(rec.proposalStatus) || LEGACY_STATUS;
  return {
    id: docIdFor(rec),
    assignee: normalizePerson(rec.assignee),
    date: toISODate(rec.date),
    timePkt: cleanCell(rec.timePkt),
    jobTitle: cleanCell(rec.jobTitle),
    jobLink: link,
    jobId: jobIdOf(link),
    hiringRate: cleanCell(rec.hiringRate),
    clientRatings: cleanCell(rec.clientRatings),
    payVerified: cleanCell(rec.payVerified),
    totalSpend: cleanCell(rec.totalSpend),
    proposals: cleanCell(rec.proposals),
    interviewing: cleanCell(rec.interviewing),
    invitesSent: cleanCell(rec.invitesSent),
    unansweredInvites: cleanCell(rec.unansweredInvites),
    flag: cleanCell(rec.flag),
    applied: YES(rec.applied),
    fixedHourly: cleanCell(rec.fixedHourly),
    highBid: cleanCell(rec.highBid),
    avgBid: cleanCell(rec.avgBid),
    lowBid: cleanCell(rec.lowBid),
    connects: isEmptyish(rec.connects) ? '' : cleanCell(rec.connects),
    bid: isEmptyish(rec.bid) ? '' : cleanCell(rec.bid),
    reason: cleanCell(rec.reason),
    jobPosted: cleanCell(rec.jobPosted),
    openJobs: cleanCell(rec.openJobs),
    proposalStatus: status,
    hasOutcome: hasOutcome(status),
    source: 'sheet-import',
  };
}

/** Whole file -> { docs, skipped, stats }. Never throws on a bad row: it reports. */
export function normalize(csvText) {
  const rows = parseCSV(csvText);
  if (!rows.length) return { docs: [], skipped: [], stats: { rows: 0 } };
  const fields = mapHeader(rows[0].map((h) => String(h).trim()));
  const unmapped = rows[0].filter((h, i) => !fields[i]).map((h) => String(h).trim());

  const docs = [], skipped = [], byId = new Map();
  rows.slice(1).forEach((row, i) => {
    const doc = toDoc(fields, row);
    if (!doc) { skipped.push({ line: i + 2, reason: 'header or empty row' }); return; }
    if (byId.has(doc.id)) {
      // Same job logged twice. Keep the first and record it: this is exactly the
      // double-bid duplicate detection exists to prevent.
      skipped.push({ line: i + 2, reason: 'duplicate of ' + doc.id, title: doc.jobTitle });
      return;
    }
    byId.set(doc.id, true);
    docs.push(doc);
  });

  return {
    docs,
    skipped,
    stats: {
      rows: rows.length - 1,
      imported: docs.length,
      skipped: skipped.length,
      unmappedColumns: unmapped,
      withLink: docs.filter((d) => d.jobLink).length,
      applied: docs.filter((d) => d.applied).length,
      withOutcome: docs.filter((d) => d.hasOutcome).length,
      people: [...new Set(docs.map((d) => d.assignee))].sort(),
    },
  };
}
