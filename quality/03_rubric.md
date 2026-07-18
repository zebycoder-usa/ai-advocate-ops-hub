# 03 — Quality Rubric (target: every dimension ≥ 8.5, overall ≥ 9.0)

The final production-readiness score is the **average of the 10 dimensions below**, on a 0–10 scale. Two hard rules:

1. **Per-dimension floor:** every dimension must score **≥ 8.5**. Any dimension below 8.5 caps the release regardless of the average.
2. **Overall floor:** the average must be **≥ 9.0**.

Scoring is evidence-based. A plan is not proof — a dimension only earns its score when the claim is demonstrated (test run, diff, screenshot, log row, or reproduced audit). Scores are assigned by an **independent audit** at the end, not self-assigned.

## Veto gates (any single failure = release blocked, score capped at 5.0 overall)
A veto gate is a pass/fail precondition. If any of these is not proven, the app cannot be scored ≥ 9.0 no matter how strong the dimensions are.

- **V1 — Staging isolation:** all pre-release testing ran against a **separate** Google Sheet and a **separate** Apps Script deployment, never the live Ops DB or live CLEval. A test tab inside the live DB does NOT satisfy this.
- **V2 — Auth / identity integrity:** the identity and admin model behaves as the owner intends for the shared-profile design; no unintended cross-identity write or gate takeover beyond the accepted internal-trust model; write actions cannot be triggered by a stray GET.
- **V3 — Data integrity / idempotency:** CLEval (and any log write) is atomic and non-duplicating — a retry or the normal score→rewrite sequence does not create duplicate rows; column count/order matches the agreed schema exactly.
- **V4 — Honesty-gate traceability:** for a generated proposal, every numeric metric is traceable to `AGENCY_PROOF_BANK` or the user's own text; no fabricated or unverifiable number can reach client-facing output.
- **V5 — Rollback completeness:** every change ships with an exact, tested rollback (git revert target SHA + Apps Script previous version + any Sheet schema back-out) that returns the system to baseline `7821888` behavior.
- **V6 — Production-unchanged proof:** evidence that `main`, the live Vercel app, the live Apps Script deployment, and real CLEval data were untouched until an explicit final approval naming an exact commit SHA.
- **V7 — Independent audit reproduces the score:** a second, independent pass re-runs the checks and arrives at the same dimension scores from the same evidence.

## The 10 scored dimensions
| # | Dimension | What ≥ 8.5 looks like | Primary evidence |
|---|---|---|---|
| D1 | **Correctness of scoring/ban logic** | `parseJob` + `scoreManual` and the AI scorer agree on bans, saturation penalty, new-client fairness, and decision bands across a fixed set of characterization cases. | characterization tests (added before any refactor) passing pre- and post-change |
| D2 | **CL scorer + rewrite reliability** | CL rubric totals correctly; the 9.0 SEND threshold comes from one constant; rewrite loop converges without fabricating metrics. | tests + sample runs; threshold-constant diff |
| D3 | **Data-integrity / idempotent logging** | CLEval writes are atomic, keyed, non-duplicating; 25-column schema reconciled; header/writer/client payload aligned. | duplicate-retry test on the staging Sheet showing one row |
| D4 | **Identity & gate behavior** | Single-login gate, queue, heartbeat, auto-release, and admin force-release behave correctly within the accepted internal-trust model; GET cannot write. | gate transition tests; GET-reject proof |
| D5 | **Honesty-gate enforcement & traceability** | No fabricated/unverifiable numeric metric can reach client output; each metric traces to the proof bank or user text. | adversarial proposal cases; trace notes |
| D6 | **Staging isolation & environment separation** | Separate Sheet + separate Apps Script deployment; config points test traffic away from live. | deployment IDs + config diff proving separation |
| D7 | **Test coverage & characterization** | Meaningful automated coverage of scoring, CL, and logging paths; characterization tests captured baseline behavior before refactor. | test suite + coverage summary |
| D8 | **Code quality & maintainability** | Magic literals (threshold, rates) centralized; stale `$85` remnants removed; minimal, focused diffs; no dead-code churn. | diffs; grep showing remnants gone |
| D9 | **Rollback & operational safety** | Documented, tested rollback for front end, Apps Script, and Sheet schema; no destructive migration. | rollback runbook + a dry-run |
| D10 | **Documentation & auditability** | `quality/` docs let an independent reviewer reproduce the state, the risks, and the score without tribal knowledge. | this folder + audit reproduction |

## Scoring procedure (end of project)
1. Confirm all seven veto gates pass. If any fails, stop — the release is blocked.
2. Score each of D1–D10 from its evidence; none may be below 8.5.
3. Compute the average; it must be ≥ 9.0.
4. An independent audit re-derives the scores from the same artifacts (V7). The release is approved only if the audit reproduces ≥ 9.0 with every dimension ≥ 8.5, and only then does an explicit approval naming the exact commit SHA authorize production.
