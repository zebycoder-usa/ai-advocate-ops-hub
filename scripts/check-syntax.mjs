#!/usr/bin/env node
/**
 * Parses the inline <script> in index.html.
 *
 * `vite build` never sees this code: the app is a classic inline script tag, not
 * a module, so Vite only transforms the two files under src/. A syntax error in
 * the application therefore builds green and deploys as a blank page. This is
 * the check that closes that gap. Run it before vite build.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const files = [join(here, '..', 'index.html')];

let failed = 0;

for (const file of files) {
  const html = readFileSync(file, 'utf8');

  // Inline scripts only. A src= script is a separate file with its own checks,
  // and document.write'd loader tags carry no parseable body here.
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)];

  if (!blocks.length) {
    console.error(`FAIL ${file}: no inline <script> found. The app should have one.`);
    failed++;
    continue;
  }

  let checked = 0;
  for (const [, code] of blocks) {
    if (!code.trim()) continue;

    // Line number of this block, so an error points at index.html not at an offset.
    const offset = html.slice(0, html.indexOf(code)).split('\n').length;

    try {
      new vm.Script(code, { filename: file });
      checked++;
    } catch (err) {
      const m = /at .*?:(\d+)/.exec(err.stack || '');
      const line = m ? Number(m[1]) + offset - 1 : '?';
      console.error(`FAIL ${file}:${line}  ${err.message}`);
      failed++;
    }
  }

  if (!failed) {
    const lines = blocks.reduce((n, [, c]) => n + c.split('\n').length, 0);
    console.log(`ok  ${file}  (${checked} inline script${checked === 1 ? '' : 's'}, ${lines} lines parsed)`);
  }
}

if (failed) {
  console.error(`\n${failed} syntax error(s). Not building.`);
  process.exit(1);
}
