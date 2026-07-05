# CLAUDE.md - AI Advocate Ops Hub

This repo builds the live app at ai-advocate-ops-hub.vercel.app (Vite + React, build with `npm run build`, output `dist`, deploys from GitHub `main`). Follow these rules in every session in this repo. These rules override ad-hoc prompts.

## Non-negotiable
- IMPORTANT: Edit ONLY the files the task names. NEVER change scoring/ban logic, the /api proxy, vercel.json, or other tabs unless explicitly told.
- IMPORTANT: This app's theme is GREEN. Read the file's own :root CSS variables and reuse them (var(--green), var(--gold), var(--card), etc.). NEVER hardcode colors or paste a different palette.
- YOU MUST verify facts before stating them. NEVER invent a metric, tool, employer, title, credential, or result. Use only facts true of Saqib and present on the live Upwork profile.
- After any edit, run `npm run build`. If it fails, report the error. NEVER push a broken build.
- NEVER deploy to `main` without the owner's exact phrase: APPROVED - DEPLOY.

## Proposal and cover-letter output (whenever generating them)
- Always output a full PROPOSAL and a full COVER LETTER, both complete and ready to paste.
- NEVER use em dashes or en dashes. Use commas and periods.
- NEVER leave placeholders or bracketed blanks. If a number is unknown, write a true qualitative sentence instead.
- Natural, humanized, spoken English. No "Dear Hiring Manager", no "I am the perfect fit".
- Shape: open with the client's exact problem in their words; one or two true proof points; a 2 to 3 step plan; end with one specific question. Proposal 120 to 180 words; cover letter 2 to 4 sentences.

## Current operating numbers (v9, July 2026) - use exactly
- Hard bans (skip before scoring, 0 Connects): banking, trading, forex, crypto, weapons, defense; clients confirmed in India, Bangladesh, or Pakistan (unknown region is NOT a ban); Umbrage, Stewart, CVS Health, Lynx; fixed-price under $200; survey/test jobs. Government and public-sector AI, data, automation, and voice work is ALLOWED.
- Proposal count: under 20 no penalty; 20 to 50 subtract 1 (busy); 50+ AUTO-SKIP. Upwork never shows a bucket above "50+".
- Scoring (19-point): Client /7 (fixed-price /6, the "$25/hr avg paid" point is N/A) + Job /7 + Match /5. Decision: 16-19 with Match 4+ = APPLY WITH BOOST; 14-15 = APPLY STANDARD; below 14 or any hard ban = SKIP. There is no REVIEW band.
- Fees: freelancer service fee is variable 0-15% per contract. The flat 10% and the tiered 20/10/5 are RETIRED. Client fee 3-10%. Connects $0.15 each; standard proposal about 6 Connects.
- Rate: Saqib $55/hr; agency $45-55/hr.

## Working style
- One change at a time; confirm before the next step. State facts as facts and assumptions as assumptions.
- Keep the diff minimal. Do not reformat or touch unrelated code.
