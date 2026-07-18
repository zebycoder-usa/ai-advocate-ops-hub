# 05 — CLEval 24→25 + Idempotency (SCOPE ONLY, not implemented)

This is a design/plan document. No `Code.gs`, front-end, Apps Script deployment, or real Ops DB / CLEval data was changed. Line numbers are against the current branch (`feature/quality-9plus`).

## 1. Current state (read-only findings)

### 1a. CLEval header is 24 columns (`Code.gs:23`)
Current `TABS.CLEval` (in order):
`Assignee, Date, Time PKT, Job Title, Job Link, Hiring Rate, Client Ratings, Payment Method Verified?, Total Spend, Proposals, Interviewing, Invites sent, Unanswered Invites, Flag, Applied?, Fixed/Hourly, High Bid, Avg. Bid, Low bid, No. of Connects, Bid, Reason, Job posted, Open jobs` = **24**.

**Diff vs the target 25 (only 3 changes, no reordering of the first 24):**
| # | Target | Current | Change |
|---|---|---|---|
| 16 | `Fixed/ Hourly` | `Fixed/Hourly` | header spacing (add space after `/`) |
| 22 | `Reason/Remarks` | `Reason` | header rename |
| 25 | `Ptoposal Status` (typo preserved) | *(absent)* | **missing column** — the only structurally missing one; default value `Un Opened` |

Everything else (columns 1–15, 17–21, 23–24) matches exactly and stays in place.

### 1b. `logCLEval` handler (`Code.gs:214–230`)
Plain `sheet_("CLEval").appendRow([...])` of **24 values**, no lock, no key. Stale default `d.bid || "$85/hr"` at `Code.gs:227` (R5 — the browser always overrides with `$40+/hr`, but the default is wrong). Server currently sets `Date`, `Time PKT` (tz `Asia/Karachi`) itself; `Assignee` falls back to `name`.

### 1c. Routing — R4 confirmed: `logCLEval` is reachable via GET
`GATE_ACTIONS = {login, logout, heartbeat, gateAccept, gateDecline, forceRelease}` (`Code.gs:200`). `doGet` (`Code.gs:274–278`) rejects **only** `GATE_ACTIONS`. `logCLEval`, `log`, and `claude` are **not** in that set, so `GET ?action=logCLEval&row=…` reaches `handle_` and appends a row (and `claude` spends tokens). Must be folded into this fix.

### 1d. Front-end call path (`index.html`) — and what actually logs today
- `logCLEvalToSheet(scoreJson, clText, jdText)` defined at `index.html:1184`. Introduced by **commit `0286e28`** ("define logCLEvalToSheet on staging"); this fix RECONCILES with that function, it does not rebuild it.
- It is called **only from the CL Score tab**, twice: after scoring (`index.html:1142`) and after rewrite (`index.html:1163`).
- The **Evaluate tab does NOT log**: post-R12, `runEval()` renders `evalDecision()` and calls `logAct('evaluate', …)` (localStorage only) — it never calls `logCLEvalToSheet`. So **no APPLY/SKIP decision is written to CLEval today**; only the CL Score tab writes, and it writes ~7 real fields (assignee, jobTitle, jobLink, connects `'6'`, bid `'$40+/hr'`, reason `"<score>/10 <verdict>"`) with the other ~15 columns as empty strings.
- Because it fires on **both** score and rewrite for the same letter, the current flow already **duplicates** rows per CL evaluation (two appends, no key) — the concrete R2 case.

## 2. Target design (to implement in a later, approved phase)

### 2a. Target 25-column order (spellings preserved EXACTLY, including the typo)
```
1  Assignee
2  Date
3  Time PKT
4  Job Title
5  Job Link
6  Hiring Rate
7  Client Ratings
8  Payment Method Verified?
9  Total Spend
10 Proposals
11 Interviewing
12 Invites sent
13 Unanswered Invites
14 Flag
15 Applied?
16 Fixed/ Hourly
17 High Bid
18 Avg. Bid
19 Low bid
20 No. of Connects
21 Bid
22 Reason/Remarks
23 Job posted
24 Open jobs
25 Ptoposal Status        (typo preserved; default value "Un Opened")
```
Header reconciliation is additive/renaming only: rename #16 and #22, append #25. No existing column moves, so existing rows stay aligned under the first 24 headers.

### 2b. Idempotency (kills R2 duplicates, survives a mid-write crash)
- **`evaluationId`** — a stable key sent by the client so a retry maps to the same logical event. Primary: deterministic = normalized `assignee | jobLink | jobTitle | yyyy-mm-dd(PKT) | decisionType(APPLY|SKIP|CLSCORE)`. Fallback when `jobLink` is blank: a per-decision UUID minted once when the card renders and reused on retry (never re-minted on reload for the same rendered decision). Rationale: a fresh id per click would re-duplicate; a deterministic id makes re-clicks and reloads converge.
- **Hidden ledger tab** `CLEval_Ledger` (kept hidden), keyed by `evaluationId`, columns: `evaluationId, status (PENDING|COMMITTED), rowNumber, updatedAt`.
- **Serialized reserve→append→commit** under `LockService.getScriptLock()` (same lock discipline as the gate actions), so concurrent posts cannot interleave:
  1. `waitLock`.
  2. Look up `evaluationId` in the ledger. If `COMMITTED` → return the stored `rowNumber` (no new row). If `PENDING` with a valid `rowNumber` → the row exists from a crashed prior attempt; treat as committed, mark `COMMITTED`, return that row. If absent → write ledger `PENDING`.
  3. `appendRow` the 25 cells; capture the new `rowNumber`.
  4. Update ledger → `COMMITTED` with `rowNumber`.
  5. `releaseLock`; return `{ok:true, row:rowNumber, deduped:<bool>}`.
- Result: a retry after a mid-write crash returns the SAME row instead of duplicating; the score→rewrite double-call collapses to one row (or an explicit update of the same row).

### 2c. Injection safety (formula/HYPERLINK abuse)
- **Text cells:** neutralize any leading `=`, `+`, `-`, `@` before writing (prefix with `'` or a zero-width guard) so a pasted job title/reason cannot become a live formula. Applied to every browser-supplied text cell.
- **Job Link:** validate the URL server-side (must be `https://`, host allowlist e.g. `upwork.com`), then set it as a real hyperlink via **rich text** (`SpreadsheetApp` rich-text value + `setLinkUrl` after write). **NEVER** build a `=HYPERLINK("…")` formula string from browser input.
- **Destination fixed server-side:** the target tab is hard-coded (`CLEval`); there is no browser-supplied `sheet`/`tab` selector, so a client cannot redirect the write.

### 2d. Server-owned fields (never trusted from the browser)
Set on the server, ignoring any client value: **Assignee/actor** (from the authenticated seat/`name` the server already tracks), **Date**, **Time PKT** (tz `Asia/Karachi`), and the default **Ptoposal Status = `Un Opened`**. The browser may supply the job/business fields (title, link, bid, connects, flags, applied) but not these four.

### 2e. POST-only (fold in R4)
`logCLEval`, `log`, and `claude` must reject GET. Implementation: add them to the GET-reject set (or invert `doGet` to an explicit read-only allowlist: `getLogs` only). This prevents a stray link/prefetch from writing a CLEval row or spending Claude tokens.

### 2f. Front-end change — log EVERY decision (not just the CL Score tab)
- From the **Evaluate tab**, after `evalDecision()` renders, POST a CLEval row for **every** decision:
  - **APPLY** (any `APPLY …` band): `Applied? = Yes`, colour/marker Green, `No. of Connects` = the real connects for the job, `Bid` = the real bid (e.g. `$40+/hr` or the set rate), `Ptoposal Status` server-defaulted `Un Opened`.
  - **SKIP** (hard ban or `SKIP …`): `Applied? = No`, colour/marker Red, `Bid = '-'`, `No. of Connects = 0` (or blank), `Reason/Remarks` = the ban list / low-score reason.
- Reconcile the **CL Score tab**: keep one call per letter (collapse the score+rewrite double-append via the same `evaluationId`), mapping the CL verdict into `Reason/Remarks`.
- Every call carries `evaluationId` and goes to the fixed `logCLEval` POST endpoint; failures stay swallowed client-side (`.catch`) so logging never breaks the decision flow, but the server response `{row, deduped}` is available for later verification.

## 3. Reconciliation notes (do not rebuild)
- Keep `logCLEvalToSheet` (from `0286e28`) as the base; extend its `row` object with `evaluationId`, `applied`, `fixedHourly`, real `connects`/`bid`, and `reason` → `Reason/Remarks`. Do not introduce a second logging function.
- Correct the stale `$85/hr` default at `Code.gs:227` to `$40+/hr` as part of the same handler edit (touches R5), since the row shape is already being changed here.

## 4. Out of scope for the implementation phase (tracked elsewhere)
- Backfilling/relabeling existing 24-column rows in the live sheet (owner + staging-isolation decision; V1).
- ActivityLog per-event wiring (R8) — separate item.
- Any deploy: schema/header change on the live CLEval tab and the ledger tab creation must run first on an **isolated staging Sheet + Apps Script deployment** (V1), never the live Ops DB, and only reach production under an explicit SHA-named approval (V6).

## 5. Test plan (for the implementation phase, all against staging)
- Header equals the 25 target strings exactly (byte-for-byte, incl. `Fixed/ Hourly`, `Reason/Remarks`, `Ptoposal Status`).
- Same `evaluationId` posted twice → exactly one row; second call returns `deduped:true` and the same row number.
- Simulated mid-write (PENDING left in ledger) → retry returns the existing row, no duplicate.
- A job title / reason beginning with `=`,`+`,`-`,`@` is stored inert (not a formula).
- A non-`https`/non-allowlisted Job Link is rejected or stored as inert text; a valid one becomes a rich-text link, never a `=HYPERLINK`.
- GET `?action=logCLEval|log|claude` → rejected; POST still works.
- Evaluate tab: an APPLY writes Yes/Green/real connects+bid; a SKIP writes No/Red/`-`; both carry server-set Assignee/Date/Time PKT and default `Un Opened`.
