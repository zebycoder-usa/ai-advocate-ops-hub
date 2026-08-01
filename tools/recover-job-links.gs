/**
 * RECOVER THE JOB LINKS BEFORE EXPORTING AGAIN.
 *
 * Why this exists
 * ---------------
 * logCLEval wrote each job link as a rich-text cell whose DISPLAY TEXT is the
 * word "URL" and whose hyperlink carries the real address. That looks right in
 * the sheet and is unrecoverable everywhere else:
 *
 *   - getValues() returns "URL", which is why listCLEval fed "URL" to the
 *     duplicate checker and it never matched a single job.
 *   - CSV export writes "URL", because export flattens rich text to display
 *     text. Measured on the 1 Aug 2026 export: 568 of 681 rows, 83%.
 *
 * The addresses are NOT lost. They are still attached to those cells as link
 * targets, reachable only through getRichTextValues(). This script copies them
 * into a plain-text column so they survive an export.
 *
 * How to run it
 * -------------
 * 1. Open the Ops Hub spreadsheet, Extensions, Apps Script.
 * 2. Paste this file in as a NEW script file. Do not replace Code.gs.
 * 3. Choose recoverJobLinks from the function dropdown and press Run.
 *    Grant the permission prompt the first time.
 * 4. Read the summary it logs, then re-export the CLEval tab as CSV.
 *
 * It adds one column, "Job Link (recovered)", at the far right and fills it. It
 * does not touch the 25 columns the team already uses, does not reorder rows and
 * does not delete anything. Running it twice is safe: it overwrites its own
 * column and nothing else.
 */

function recoverJobLinks() {
  var SHEET_NAME = 'CLEval';          // change if the tab is named differently
  var LINK_HEADER = 'Job Link';
  var OUT_HEADER = 'Job Link (recovered)';

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SHEET_NAME);
  if (!sh) {
    var names = ss.getSheets().map(function (s) { return s.getName(); });
    throw new Error('No tab named "' + SHEET_NAME + '". Tabs here: ' + names.join(', '));
  }

  var lastRow = sh.getLastRow();
  var lastCol = sh.getLastColumn();
  if (lastRow < 2) { Logger.log('Nothing to do: no data rows.'); return; }

  var header = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  var linkCol = header.indexOf(LINK_HEADER) + 1;
  if (!linkCol) throw new Error('No "' + LINK_HEADER + '" column found in row 1.');

  // Reuse our own column if this has been run before, otherwise append one.
  var outCol = header.indexOf(OUT_HEADER) + 1;
  if (!outCol) { outCol = lastCol + 1; sh.getRange(1, outCol).setValue(OUT_HEADER); }

  var n = lastRow - 1;
  var rich = sh.getRange(2, linkCol, n, 1).getRichTextValues();
  var text = sh.getRange(2, linkCol, n, 1).getDisplayValues();

  var out = [];
  var recovered = 0, alreadyPlain = 0, nothing = 0;

  for (var i = 0; i < n; i++) {
    var cell = rich[i][0];
    var shown = String(text[i][0] || '').trim();

    // The link target is the authoritative value when one exists.
    var url = cell ? cell.getLinkUrl() : null;

    // A cell can also carry its link on a run rather than the whole value.
    if (!url && cell && cell.getRuns) {
      var runs = cell.getRuns();
      for (var r = 0; r < runs.length && !url; r++) url = runs[r].getLinkUrl();
    }

    if (url) { out.push([url]); recovered++; }
    else if (/^https?:\/\//i.test(shown)) { out.push([shown]); alreadyPlain++; }  // typed in by hand
    else { out.push(['']); nothing++; }
  }

  sh.getRange(2, outCol, n, 1).setValues(out);

  var msg = [
    'Job link recovery complete.',
    '  rows examined            : ' + n,
    '  recovered from hyperlink : ' + recovered,
    '  already plain text       : ' + alreadyPlain,
    '  no link found            : ' + nothing,
    '',
    'Column "' + OUT_HEADER + '" is now column ' + outCol + '.',
    'Re-export this tab as CSV and the addresses will come with it.'
  ].join('\n');
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { /* no UI when run headless */ }
}
