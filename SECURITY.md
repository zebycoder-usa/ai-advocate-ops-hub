# Security

## API key handling

The Anthropic API key used by this project is stored **server-side only**. It is
never committed to the repository and never sent to the browser.

The key lives in two server-side stores:

- **Vercel** (used by the live app via the serverless proxy). Read at runtime
  from `process.env.ANTHROPIC_API_KEY` in `api/claude.js`. The browser calls the
  project's own `/api/claude` endpoint; it has no knowledge of the key. Set it in
  Vercel under Project -> Settings -> Environment Variables.
- **Google Apps Script** (fallback backend in `Code.gs`). Read at runtime from
  `PropertiesService.getScriptProperties().getProperty("CLAUDE_API_KEY")`. Set it
  in Apps Script under Project Settings -> Script Properties.

The client (`index.html`) never holds the key. It reaches Anthropic only through
the server-side proxy, so the secret stays on the server.

### Rules

- Do not paste a real key into any tracked file. The only key-shaped string in the
  repo is a documentation placeholder (`sk-ant-api03-...`) in the `Code.gs` setup
  comment.
- Do not use a `VITE_`-prefixed key for the Anthropic secret. A `VITE_` variable is
  bundled into client-side code and would expose the key in the browser.
- `.env` and `.env.*` are ignored by git and must never be committed.

### Verification (2026-07-24)

A review of the repository confirmed:

- No real API key is hardcoded in any file.
- No real API key appears anywhere in git history.
- No `.env` or other secret files are tracked by git.
- `.gitignore` covers `.env` and `.env.*`.

This review covers the repository only. It does not inspect the values stored in
the Vercel dashboard or Apps Script Script Properties.

### If a key is ever exposed

Rotate it. Generate a new key in the Anthropic console, then update it in both
Vercel Environment Variables and Apps Script Script Properties. Rotation is also a
reasonable periodic peace-of-mind step even when no exposure is known.

## Reporting a concern

Raise any security concern privately with the repository owner rather than opening
a public issue.
