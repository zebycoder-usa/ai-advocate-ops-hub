// Loads the real Code.gs into Node with in-memory mocks of the Apps Script
// globals it touches (SpreadsheetApp, PropertiesService, LockService, Utilities,
// Session, ContentService), so handle_() can be driven and the resulting sheet
// rows inspected. Nothing here touches any live Google resource.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(__dirname, '..', 'Code.gs'), 'utf8');

export function loadGas({ logSecret } = {}) {
  const sheets = {};

  function makeSheet() {
    const rows = []; // array of arrays (row 1 = header)
    const sheet = {
      _rows: rows,
      appendRow(arr) { rows.push(arr.slice()); },
      getLastRow() { return rows.length; },
      getLastColumn() { return rows.reduce((m, r) => Math.max(m, r.length), 0); },
      setFrozenRows() { return sheet; },
      hideSheet() { return sheet; },
      getRange(r, c, nr, nc) {
        nr = nr || 1; nc = nc || 1;
        return {
          getValues() {
            const out = [];
            for (let i = 0; i < nr; i++) {
              const row = rows[r - 1 + i] || [];
              const seg = [];
              for (let j = 0; j < nc; j++) seg.push(row[c - 1 + j] !== undefined ? row[c - 1 + j] : '');
              out.push(seg);
            }
            return out;
          },
          setValues(vals) {
            for (let i = 0; i < vals.length; i++) {
              if (!rows[r - 1 + i]) rows[r - 1 + i] = [];
              for (let j = 0; j < vals[i].length; j++) rows[r - 1 + i][c - 1 + j] = vals[i][j];
            }
            return this;
          },
          setRichTextValue(v) {
            if (!rows[r - 1]) rows[r - 1] = [];
            rows[r - 1][c - 1] = v && v._text !== undefined ? v._text : v;
            return this;
          },
        };
      },
    };
    return sheet;
  }

  const ss = {
    getSheetByName(name) { return sheets[name] || null; },
    insertSheet(name) { sheets[name] = makeSheet(); return sheets[name]; },
  };

  const globals = {
    SpreadsheetApp: {
      getActiveSpreadsheet() { return ss; },
      newRichTextValue() {
        const o = { _text: '', _link: '' };
        return { setText(t) { o._text = t; return this; }, setLinkUrl(u) { o._link = u; return this; }, build() { return o; } };
      },
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty(n) { return n === 'LOG_SECRET' ? (logSecret === undefined ? null : logSecret) : null; } };
      },
    },
    LockService: { getScriptLock() { return { waitLock() {}, releaseLock() {} }; } },
    Utilities: { formatDate(_d, _tz, fmt) { return fmt; } },
    Session: { getScriptTimeZone() { return 'Asia/Karachi'; } },
    ContentService: { createTextOutput(s) { return { setMimeType() { return this; }, _s: s }; }, MimeType: { JSON: 'json' } },
  };

  const names = Object.keys(globals);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, SRC + '\n;return { handle_: handle_ };');
  const api = factory(...names.map((n) => globals[n]));
  return { handle_: api.handle_, sheets };
}
