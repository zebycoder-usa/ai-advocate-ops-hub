# CLAUDE.md - AI Advocate Ops Hub
**Version: v11 | Last updated: July 2026 | Owner: Saqib Shahzad (AI ADVOCATE HOLDING LLC)**

This repo builds the live app at ai-advocate-ops-hub.vercel.app (Vite + React, build with `npm run build`, output `dist`, deploys from GitHub `main`). Follow these rules in every session in this repo. These rules override ad-hoc prompts.

---

## Project architecture — read this first

### Two separate apps in this repo
| File | Stack | Status | Deployed |
|---|---|---|---|
| `index.html` | Vanilla JS, single file, v11 | **THE LIVE APP** | Yes, via Vite passthrough |
| `src/App.jsx` | React, 5,600+ lines, 21 tabs | Dead code — never wired to build | No |

**NEVER touch `src/App.jsx` unless explicitly told. It is not deployed.**

### Backend: Google Apps Script (GAS)
- File: `Code.gs` in this repo
- Deployed as Web App at: `https://script.google.com/macros/s/AKfycbwsAdkj8XwW-x8DykVJ4mXzNp4qzFbJFx2kSm4uAor2Wi6AMm6BhuRW0P19xdIVoZFWWw/exec`
- GAS handles: gate/queue, sessions, activity logging, Claude API proxy
- To update backend: paste `Code.gs` into Apps Script editor → Save → Deploy → "New version" (URL never changes)
- Script Properties required: `CLAUDE_API_KEY` = Anthropic key, `CLAUDE_MODEL` = claude-sonnet-4-6

### Google Sheets (auto-populated by GAS)
| Sheet | Purpose | Key columns |
|---|---|---|
| ActivityLog | Every event (login, eval, proposal, copy, logout) | Timestamp, User, Type, Decision, Score, Detail |
| Sessions | Per-session records | Login time, logout time, duration, JDs, proposals, copies |
| Queue | Live gate state | Holder, HolderSince, Waiting, PendingOffer, UpdatedAt, HolderHeartbeat |

### Gate/Queue system (v11)
- Single occupancy: one person holds Saqib's profile at a time; others queue
- Heartbeat: holder pings every 2 min; 12 min silence = auto-release
- Admin force-release: Saqib Shahzad and Zeb (Jahanzaib) only
- `beforeunload` sends logout beacon on tab close (best-effort)

### Vercel deployment
- `vercel.json` routes all non-asset requests to `index.html`
- `api/claude.js` is a Vercel serverless function (used by React app only, not by `index.html`)
- **NEVER modify `vercel.json` or `api/claude.js` unless explicitly told**

---

## Team roster (v11, July 2026)
| Name | Role | Notes |
|---|---|---|
| Saqib Shahzad | Owner, senior AI/ML consultant | Agency rate floor **$40/hr and above, set per job** (v9.3). Upwork **Rising Talent**, 100% Job Success (NOT Top Rated). ADMIN |
| Zeb (Jahanzaib) | Co-admin, ops lead | ADMIN — can force-release gate |
| Waqas Riaz | Team member | Full access |
| Usman Saeed | Team member | Full access |
| Sadia | Team member | Full access |
| Subhan | Team member | Full access |
| Hamza | Team member | Full access |
| Fiza | Team member | Full access |
| Sana | Team member | Full access |
| Ayesha | Team member | Full access |
| Kaleem | New, learner, part-time | 2-4 hrs/day. Give extra step-by-step guidance |

---

## Platform coordination rules
When working across VS Code Claude, Claude Code web, or Claude.ai:
- **VS Code Claude** = most capable for this repo. Has your GitHub credentials, full filesystem at `C:\Users\Hi\OneDrive\Desktop\ai-advocate-ops-hub\`, can push directly. Use for all git operations.
- **Claude Code web (remote session)** = can read/write files, run builds, but cannot push to GitHub (403 from environment proxy). Use for coding, analysis, and generating file content.
- **Claude.ai chat** = no file/git access. Use for Q&A, proposal review, and planning only.
- **Handoff rule**: when Claude Code web finishes edits, it commits locally and provides file content. VS Code Claude picks up, pastes files, commits, and pushes.
- **Single source of truth**: `C:\Users\Hi\OneDrive\Desktop\ai-advocate-ops-hub\` on your machine. Never create a second clone.

---

## Non-negotiable
- IMPORTANT: Edit ONLY the files the task names. NEVER change scoring/ban logic, the /api proxy, vercel.json, or other tabs unless explicitly told.
- IMPORTANT: This app's theme is GREEN. Read the file's own :root CSS variables and reuse them (var(--green), var(--gold), var(--card), etc.). NEVER hardcode colors or paste a different palette.
- YOU MUST verify facts before stating them. NEVER invent a metric, tool, employer, title, credential, or result. Use only facts true of Saqib and present on the live Upwork profile.
- After any edit, run `npm run build`. If it fails, report the error. NEVER push a broken build.
- NEVER deploy to `main` without the owner's exact phrase: APPROVED - DEPLOY.

## Proposal and cover-letter output (whenever generating them)
- Proof points come ONLY from the **AGENCY_PROOF_BANK** constant in `index.html` (real results published on the agency's live Upwork profile) or from facts in the user's own letter. Pick the ONE bank entry matching the job's domain, never list all. NEVER invent a number not in the bank or the user's text. Platform badges (Job Success Score, Rising Talent, star ratings) are NOT proof.
- One consistent voice: "we" (the agency team) throughout — never mix "Saqib" and "we". NEVER mention the agency's Upwork job count, tenure, account age, or newness; lead with portfolio results and team expertise only.
- Always output a full PROPOSAL and a full COVER LETTER, both complete and ready to paste.
- NEVER use em dashes or en dashes. Use commas and periods.
- NEVER leave placeholders or bracketed blanks. If a number is unknown, write a true qualitative sentence instead.
- Natural, humanized, spoken English. No "Dear Hiring Manager", no "I am the perfect fit".
- Shape: open with the client's exact problem in their words; one or two true proof points; a 2 to 3 step plan; end with one specific question. Proposal 120 to 180 words; cover letter 2 to 4 sentences.

## Current operating numbers (v9.3, July 2026) - use exactly
- Hard bans (skip before scoring, 0 Connects): banking, trading, forex, crypto, weapons, defense; clients confirmed in India, Bangladesh, or Pakistan (unknown region is NOT a ban); Umbrage, Stewart, CVS Health, Lynx; fixed-price under $200; survey/test jobs. Government and public-sector AI, data, automation, and voice work is ALLOWED.
- Proposal count (v9.3): a score penalty, never a ban. Under 20 = 0; 20 to 50 = 0; 50+ = subtract 2. Let the /19 decide. Upwork never shows a bucket above "50+".
- Scoring (19-point, v9.3 recovery-review): Client /7 (fixed-price /6, the "$25/hr avg paid" point is N/A) + Job /7 + Match /5. Match never fails just because the domain differs from AI/ML — we are full-service. Decision: 16-19 with Match 4+ = APPLY WITH BOOST; 14-15 = APPLY STANDARD; 12 to under 14 = recovery review (honestly re-score, justify to 14 if legitimate); 10 to under 12 = marginal (recover 1-2 points only if legitimate, else skip); under 10 or any hard ban = SKIP. Recovery = honest re-scoring, never inflation.
- New-client fairness (v9.3): a client new to Upwork is never a red flag by itself. Do not deduct for $0 spent, 0 hires, or no reviews on a new account — score those as N/A (neutral) and award what the client does qualify for (payment verified, allowed region). Integrity check: a very new account with large spend/many hires/many 5-star reviews = flag "verify client authenticity: inconsistent history" and do not award those points at face value.
- Fees: freelancer service fee is variable 0-15% per contract. The flat 10% and the tiered 20/10/5 are RETIRED. Client fee 3-10%. Connects $0.15 each; standard proposal about 6 Connects.
- Rate (updated 17 July 2026, v9.3, agency full-service): **rate floor is $40/hr and above, set per job**. The old $85 personal bid floor is **RETIRED — do not revert it**. The agency is full-service (front-end, back-end, full-stack, AI/ML, LLM/RAG/agentic AI, computer vision, NLP, data science, MLOps, QA, UX/UI, CI/CD, DevOps, mobile) and applies to the maximum number of jobs across all these skills.
- Budget point (v9.3, matches the app): hourly **$40+/hr** earns the point; **$30-39/hr** borderline, 1 point, review; **below $30/hr** flag "below rate floor — review before bidding", review critically, but do NOT ban — still score it and always state the final score. Fixed-price $200+ earns the point.
- Badge: **Rising Talent, 100% Job Success. NOT Top Rated.** Never claim Top Rated or Top Rated Plus in any proposal or profile copy.

## Working style
- One change at a time; confirm before the next step. State facts as facts and assumptions as assumptions.
- Keep the diff minimal. Do not reformat or touch unrelated code.

---

## Git and deployment workflow
- Dev branch: `claude/upwork-app-full-build-jazm8a` — all new work goes here
- Never push to `main` directly. Never deploy to `main` without owner's exact phrase: **APPROVED - DEPLOY**
- After editing: run `npm run build`. If it fails, fix before committing. Never push a broken build.
- Push order: Claude Code web generates files → VS Code Claude commits and pushes → PR created → owner approves → merge to main → Vercel auto-deploys
- GAS backend update is independent of git — paste `Code.gs` into Apps Script editor and redeploy

## What Claude must ALWAYS do
- Read `:root` CSS variables from `index.html` before touching any styles. Never hardcode colors.
- Run `npm run build` after every edit. Report errors immediately.
- Check `BACKEND_URL` in `index.html` before changing anything — it must always point to the GAS `/exec` URL above.
- When generating proposals: follow Saqib's 5-point formula exactly (hook, proof, plan, question, CTA). 120-180 words. No em dashes. No placeholders without instruction to replace.
- Log all events with the correct user name. Never fabricate scores, metrics, or credentials.

## What Claude must NEVER do
- Touch `src/App.jsx`, `api/claude.js`, `vercel.json` unless explicitly told
- Change scoring logic, ban lists, or Connect rules without explicit instruction
- Push to `main` without "APPROVED - DEPLOY" from Saqib
- Invent facts about Saqib (credentials, numbers, employers, tools not in the job post)
- Create a second clone of the repo (OneDrive copy is the single source of truth)
- Use em dashes or en dashes in any proposal or cover letter output
- Leave bracket placeholders in final output unless told to (Claude API output may use them — Saqib replaces before sending)
