// Characterization-test harness (Phase 2, local only).
//
// Loads the LIVE app file index.html into a jsdom window so the REAL parseJob()
// and scoreManual() run — no copies, no edits to the app.
//
// SAFETY: window.fetch is replaced with a rejecting stub BEFORE the page script
// executes, so the app's on-load seatBoot() -> seatApi('getLogs') cannot reach
// the live Apps Script backend or any network. Every test asserts fetch was
// never allowed to hit the network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML_PATH = join(__dirname, '..', 'index.html');

export function loadApp() {
  const html = readFileSync(HTML_PATH, 'utf8');
  const calls = [];
  const log = [];
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'http://localhost/', // gives jsdom a working localStorage
    beforeParse(window) {
      // Block ALL network before the inline <script> runs.
      window.fetch = (...args) => {
        calls.push(args[0]);
        log.push({ url: args[0], body: args[1] && args[1].body });
        return Promise.reject(new Error('network disabled in characterization tests'));
      };
      // Silence the app's benign console noise during load.
      window.console.error = () => {};
    },
  });
  const { window } = dom;
  return {
    window,
    doc: window.document,
    // functions the app defines on the global (window) scope:
    parseJob: window.parseJob,
    scoreManual: window.scoreManual,
    // test helpers to drive the manual signal form:
    setVal: (id, v) => window.setVal(id, v),
    fetchCalls: calls,
    fetchLog: log,
  };
}

// Set the manual scoring inputs, then run the real scoreManual().
export function scoreWith(app, inputs) {
  Object.entries(inputs).forEach(([id, v]) => app.setVal(id, v));
  return app.scoreManual();
}
