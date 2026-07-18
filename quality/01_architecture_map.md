# 01 — Architecture Map (Ops Hub)

Concise map of where each behavior lives. All line numbers are against the baseline commit `7821888`. Files: `index.html` (live front end), `Code.gs` (Apps Script backend), `api/claude.js` (Vercel proxy).

## High-level data flow
```
Browser (index.html)
  ├─ AI scoring / proposal / CL scorer / CL rewrite ──> POST /api/claude ──> api/claude.js ──> api.anthropic.com
  └─ gate/queue, sessions, CLEval logging ───────────> POST SEAT_BACKEND (/exec) ──> Code.gs ──> Google Sheet (Ops DB)
```
- `api/claude.js` holds the Anthropic key server-side (`process.env.ANTHROPIC_API_KEY`, api/claude.js:5) and forwards `{system, messages, max_tokens, model}` to Anthropic. Default model `claude-sonnet-4-6` (api/claude.js:2).
- `Code.gs` holds `CLAUDE_API_KEY` / `CLAUDE_MODEL` in Script Properties; its `claude()` action is a fallback the live UI does not use (see note at index.html:1110).

## Job scoring
- **Parser:** `parseJob(text)` — index.html:483. Regex-extracts budget type/amount, region, spend, hire rate, star rating, proposal count; builds `P.bans` / `P.flags`.
- **Authoritative deterministic score (R12, commit `7d8f395`):** `scoreManual()` — index.html:544. 19-point model: Client /7 (fixed-price /6, the hourly "$25/hr avg paid" point is N/A) + Job /7 + Match /5 + saturation penalty, with new-client fairness scaling (R13). Returns `{total, cli, job, mat, sat, decision, cliMax, achievableMax, isNew, integrity}`.
- **`runEval()` — index.html (post-R12):** no longer scores. It calls `parseJob()` + `autofill()`, then renders `evalDecision()` = hard-ban override + `scoreManual()` /19, deterministically, with **zero model calls**. `evalDecision()`/`renderDecisionCard()` surface the verdict. The model is used ONLY by `genProposal()` (proposal prose) and the CL scorer/rewrite — never to produce or override the score.
- **Model system context:** `AGENCY_CONTEXT` built by `buildContext()` — index.html:947–948 (the full-service rules, bans, decision bands, new-client fairness, honesty gate live in this prompt string).

## Hard bans / saturation / new-client rules
- **Hard bans (code-enforced):** `parseJob` — index.html:511–519. Fixed-price `< $200` (511); finance/crypto/trading industries (513); weapons/defense (516); banned companies umbrage/stewart/cvs health/lynx (517); confirmed India/Bangladesh/Pakistan (`isBanCountry` 504, pushed 518); on-site 2+ days/week (519). Government/public-sector explicitly allowed (comment 514–515).
- **Saturation (penalty, never a ban):** `SAT_PENALTY = -2` only for the `50+` proposals bucket — index.html:552; applied to total at index.html:555.
- **New-client fairness / below-rate:** `< $40/hr` hourly is a **flag**, not a ban. Region outside allowed set is a flag, not an auto-skip. New-client fairness + integrity check are now **code-enforced** in `scoreManual()` (R13, commit `b86bbe1`): for `tenure==='new'`, unknowable history (spend, hire, $25/hr-avg) is N/A and the decision bands scale to the achievable max; the prompt copy in `AGENCY_CONTEXT` is now a mirror of the deterministic rule, not the source of truth.
- **Pakistan hard ban (R14, commit `3a02808`):** `parseJob()` `isBanCountry` regex now includes `pakistan`/`pakistani` + major cities (index.html:510).
- **Mirror copy (non-authoritative):** the same rules are echoed as UI/chat text at index.html:810–825, 988–996 — display only.

## Cover-letter (CL) scorer + rewrite loop
- **Rubric constant:** `CL_RUBRIC` — index.html:1013 (hook 2.0 / proof 2.0 / plan 2.0 / close 1.5 / style 1.5 / len 1.0 = 10.0).
- **Scorer system prompt:** `CL_SCORE_SYSTEM` — index.html:1060 (returns per-dimension JSON).
- **Rewrite system prompt:** `CL_REWRITE_SYSTEM` — index.html:1062 (injects `AGENCY_PROOF_BANK` + `PROOF_VOICE_RULES`; internal up-to-2-revision loop toward 9.0).
- **Transport:** both go through `callBackend()` — index.html:1113, which POSTs to `/api/claude` (index.html:1114), NOT to the GAS `claude()` action.
- **SEND threshold:** hardcoded `9.0` literal at index.html:1037, 1050, 1051, 1130, and UI copy at 302 / 285; also embedded in the prompt strings at 1060, 1062, 1094, 1095.
- **Proof source:** `AGENCY_PROOF_BANK` — index.html:932; `PROOF_VOICE_RULES` — index.html:939 (single matching entry only; badges are not proof; never state a number not in the bank or the user's letter).

## Front-end → backend calls
- **Anthropic proxy endpoint:** `/api/claude` — used by `runEval` (index.html:588), proposal generation (index.html:678), CL scorer (index.html:1002), and `callBackend` (index.html:1114).
- **Ops-DB / gate endpoint:** `SEAT_BACKEND` — index.html:1170 = the Apps Script `/exec` URL (matches CLAUDE.md). Called via `seatApi(action, payload)` — index.html:1175, which sends `Content-Type: text/plain` JSON.
- **Gate actions used by the client:** `login`, `logout`, `heartbeat`, `getLogs`, `gateAccept`, `gateDecline`, `forceRelease` (index.html:1252–1344). Admin list `SEAT_ADMINS` at index.html:1171 must match `ADMINS` in Code.gs:27.
- **Activity logging gap:** client `logAct()` — index.html:713 — writes only to `localStorage` (`mem.activity`). The client never POSTs `action:'log'`, so the server-side ActivityLog sheet is populated only by server events (`AUTO_RELEASE`, `FORCE_RELEASE`).

## The exact `logCLEval` code path
1. **Trigger (client):** after CL scoring — `logCLEvalToSheet(json, cl, jd)` at index.html:1083; and after CL rewrite — index.html:1104. Definition: index.html:1125.
2. **Payload:** builds a `row` object (index.html:1132–1141) with assignee, jobTitle, jobLink, `connects:'6'`, `bid:'$40+/hr'`, `reason: total.toFixed(1)+'/10 '+verdict`; the ~15 client-facing metric columns are sent as empty strings.
3. **Transport:** `fetch(SEAT_BACKEND, {method:'POST', Content-Type:'text/plain', body: JSON.stringify({action:'logCLEval', name, row})})` — index.html:1131. Failures are swallowed (`.catch(function(){})`) so logging never breaks the score flow.
4. **Server handler:** `handle_()` branch `action==="logCLEval"` — Code.gs:214. Does `sheet_("CLEval").appendRow([...])` — Code.gs:218, writing exactly **24** values in the order of the `CLEval` header (`TABS.CLEval`, Code.gs:23).
5. **No lock / no idempotency:** `logCLEval` is **not** in `GATE_ACTIONS` (Code.gs:200), so it runs outside the script lock and appends unconditionally — no unique key, no de-duplication (see `02_risk_register.md`).
