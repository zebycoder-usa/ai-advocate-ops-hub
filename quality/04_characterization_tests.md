# 04 — Characterization Tests (Phase 2)

Local-only work on `feature/quality-9plus`. Goal: capture the **current** deterministic behavior of the in-code scoring so a later refactor (risk **R12** — make `scoreManual()` the authoritative decision instead of the model's free-text /19) can be proven behavior-preserving. These tests document what the code does today; they are not aspirational assertions.

## What was added (no app code changed)
- Dev dependencies: `vitest@^2.1.9`, `jsdom@^25.0.1`. New `test` script: `vitest run`.
- `test/loadApp.js` — harness that loads the **real** `index.html` into jsdom and returns the actual `parseJob` / `scoreManual` functions. No copies, no edits to app logic.
- `test/scoring.characterization.test.js` — 14 tests.

## Safety design (why this cannot touch live systems)
- `index.html` auto-runs `seatBoot()` on load, which calls `fetch(SEAT_BACKEND)` (the live Apps Script `/exec`). The harness replaces `window.fetch` in `beforeParse`, **before** the page script executes, with a stub that records the URL and rejects. No request can reach the network or the live Ops DB.
- A dedicated test asserts that every recorded fetch target was the (blocked) Apps Script URL — nothing else was contacted.
- jsdom is given `url: http://localhost/` only so the app's `localStorage` calls work in-memory. No file, network, Google, Vercel, or `main` access occurs.

## Coverage (14 tests, all passing)
**`parseJob()` — bans & flags:**
- Fixed-price under $200 → hard ban.
- Crypto/trading → banned industry.
- Weapons/defense → banned industry.
- Banned company (CVS Health) → caught.
- Confirmed India client → hard-ban country + `region==='India/Bangladesh'`.
- "Indiana" → NOT India (guard holds); region US.
- Below $40/hr hourly → review **flag**, not a ban (`bans` empty, `belowBudget` true).
- Clean US hourly $75/hr → no bans; `verified` true; region US.

**`scoreManual()` — 19-point math, saturation, decision bands:**
- Strong hourly → cli 7 / job 6 / mat 5 / sat 0 / total 18 → `APPLY WITH BOOST`.
- 50+ proposals → `sat -2`, job 4, total 14 → `APPLY STANDARD`.
- Borderline $35/hr → 1 budget point (not 2), job 5, total 17.
- Fixed-price (cliMax 6) → cli 4 / job 4 / mat 3 / total 11 → `MARGINAL`.
- Weak job → total -1 → `SKIP`.

Every expected value was hand-derived from the code and matched actual output on the first run, confirming the tests mirror current behavior.

## Results
- `npm test` → **14 passed** (1 file).
- `npm run build` → **PASS** (unchanged; app code untouched).

## Baseline behavior notes captured for the R12 refactor
- The deterministic `scoreManual()` already implements bans-as-cap-context, saturation −2 (only for the `50+` bucket), the fixed-price cliMax-6 rule, borderline `$30–39/hr` = 1 point, and all five decision bands. When the authoritative-score refactor lands, these exact numbers must still hold (this suite is the guard).
- The suite deliberately does NOT test `runEval()` (the model path) — that path is non-deterministic today, which is precisely the defect R12 records.
