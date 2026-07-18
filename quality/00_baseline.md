# 00 — Phase 1 Baseline

**Purpose:** record the exact starting point for the quality-9plus work so any later change is measured against a known-good baseline. Documentation only — no application code was changed in this phase.

## Branch
- **Working branch:** `feature/quality-9plus`
- **Base branch:** `staging`
- **Base commit (short):** `7821888`
- **Base commit (full):** `782188802dab0034135940a61aa2643317c2775c`
- **Note:** at this snapshot `staging`, `main`, `origin/staging`, and `origin/main` all point at the same commit `7821888` (0 ahead / 0 behind). The `staging` git branch therefore provides **no data or environment isolation on its own** — real staging isolation must be a separate Google Sheet + separate Apps Script deployment (tracked in `02_risk_register.md`).

## Toolchain versions (this machine)
- **Node:** v24.18.0
- **npm:** 11.16.0
- **Vite:** 5.4.21 (from build output)

## Baseline build / test results
| Step | Command | Result | Notes |
|---|---|---|---|
| Install | `npm install` | **PASS** (exit 0) | "up to date, audited 64 packages". npm reports 2 vulnerabilities (1 moderate, 1 high) and an `esbuild@0.21.5` install-script warning. Not addressed in this phase (no code changes). |
| Build | `npm run build` (`vite build`) | **PASS** (exit 0) | 2 modules transformed; emitted `dist/index.html` 117.46 kB (gzip 40.33 kB); built in ~1.05s. Vite prints a CJS-Node-API deprecation notice (informational). |
| Test | `npm test` | **none** | No `test` script exists in `package.json` (`scripts`: dev, build, preview). No test runner or test files in the repo yet. |

## What "the app" is (confirmed at baseline)
- **Live app:** root `index.html` — single-file vanilla JS. Its only `<script>` is inline (index.html:309); it does **not** import `src/main.jsx`. This is what Vite builds and Vercel serves.
- **Dead code (not built):** `src/App.jsx` (~408 KB React) and `src/main.jsx` are never referenced by the live entry. Not touched.
- **Backend:** `Code.gs` — Google Apps Script web app (gate/queue, sessions, CLEval logging, Claude fallback). Deployed independently of git.
- **Vercel serverless:** `api/claude.js` — proxies the browser to the Anthropic API using the server-side key.

## Working-tree state
- No modifications to tracked files at branch creation.
- Three **untracked** files present and intentionally **left uncommitted** (they belong to the excluded Academy/learning app, out of scope): `AI_Advocate_Academy_ALLINONE.html`, `UPWORK_GUIDE_CONTENT.md`, `deploy_academy.ps1`.
- This phase commits **only** the four new `quality/*.md` files.

## Secrets
- No secret or API key was printed, read, or committed. Only environment-variable / Script-Property **names** are referenced anywhere in these docs: `ANTHROPIC_API_KEY` (Vercel), `CLAUDE_API_KEY` and `CLAUDE_MODEL` (Apps Script Script Properties).
