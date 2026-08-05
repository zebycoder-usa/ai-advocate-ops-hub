---
name: recover-claude-work
description: >-
  Recover lost or deleted Claude work and verify the recovery. Covers Claude
  Code / CLI conversation transcripts, published claude.ai artifacts, Cowork /
  Claude desktop Live Artifacts, git-tracked code and lost commits, and
  scratchpad / tool-output files. Use when the user asks to recover, restore,
  undelete, bring back, or find a lost chat, conversation, session, project,
  artifact, code change, or file on Claude. Always runs a verification pass and
  reports honestly what was and was not recoverable.
---

# Recover Claude Work

A procedure for recovering Claude-related work from the places it is actually
stored, then **verifying** the recovery so the user can trust it. Recover only
what genuinely exists on disk or on an account you can reach. Never claim a
recovery you did not verify.

## Rule 0 — honesty first

State up front what is recoverable and what is not. Do NOT promise to undelete
things that are gone. The one hard limit:

- **A claude.ai web conversation that was deleted from Anthropic's servers
  cannot be undeleted.** There is no undelete API. Only these partial paths
  exist, and only if done in time: (a) it may be *archived*, not deleted, so
  check the archive first; (b) the browser may hold it in history/cache; (c) an
  account **Data Export** requested *before* deletion will contain it. If none
  apply, say so plainly and move to prevention (below). Never fabricate a
  recovery.

Everything in sections 1 to 5 below IS genuinely recoverable.

## Step 1 — identify the target

Ask (or infer) exactly one thing: **what** was lost and **where** it lived.
Match it to a category:

| The user lost... | Category | Section |
|---|---|---|
| A Claude Code / terminal chat, session, or "my conversation with Claude in the CLI" | Local transcript | 1 |
| A published artifact / page made on claude.ai | Artifact | 2 |
| A Cowork / Claude desktop "Live Artifact" that won't open | Desktop artifact | 3 |
| Code, a commit, a branch, uncommitted edits | Git | 4 |
| A generated file, report, screenshot, command output | Scratchpad | 5 |
| A claude.ai web chat deleted from the account | Server-side | Rule 0 |

## Step 2 — recover by category

### 1. Claude Code / CLI conversation transcripts (recoverable)

Every Claude Code session is written to disk as a JSONL transcript. This is the
single most recoverable thing.

- Locations to search (first that exists wins):
  - `~/.claude/projects/<project-hash>/*.jsonl`
  - `~/.claude/history/` and `~/.claude/sessions/`
- Find candidates, newest first:
  ```bash
  find ~/.claude/projects -name '*.jsonl' -printf '%TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null | sort -r | head -40
  ```
- Search transcripts by keyword to pinpoint the right one:
  ```bash
  grep -rl "SOME UNIQUE PHRASE FROM THE LOST CHAT" ~/.claude/projects --include='*.jsonl'
  ```
- Reconstruct a readable conversation from a transcript (each line is one JSON
  event with `type`, `message.role`, `message.content`):
  ```bash
  python3 - "$JSONL" <<'PY'
  import json,sys
  for line in open(sys.argv[1]):
      try: e=json.loads(line)
      except: continue
      m=e.get("message") or {}
      role=m.get("role") or e.get("type","")
      c=m.get("content")
      if isinstance(c,list):
          c="".join(b.get("text","") for b in c if isinstance(b,dict) and b.get("type")=="text")
      if c: print(f"\n### {role}\n{c}")
  PY
  ```
- Deliver the reconstructed text as a markdown file the user can keep.

### 2. Published claude.ai artifacts (recoverable)

Artifacts published from claude.ai persist on the account.

- List the user's artifacts (newest first) with the Artifact tool:
  `action: "list"` (use `scope: "all"` to include ones shared with them).
- Identify the lost one by title / date / URL, then read its full content back
  with WebFetch on the artifact URL (claude.ai artifact URLs are fetchable).
- If they only lost the *link*, listing returns it. If they lost the *content*,
  WebFetch returns the full HTML to re-save.
- Local copies of previously fetched artifacts may also exist under
  `~/.claude/projects/<hash>/tool-results/artifact-*.html` — search there too.

### 3. Cowork / Claude desktop "Live Artifacts" (recoverable from local folder)

If a desktop Live Artifact shows "This artifact's folder is missing on disk,"
the data usually still exists, just moved or unsynced.

- Prefer the dedicated **`recover-cowork-artifact`** skill if it is installed;
  it handles the Windows/macOS folder diagnosis and safe restore.
- Otherwise: the artifact folders live under the desktop app's data directory
  (Windows: `%APPDATA%`/`%LOCALAPPDATA%` under the Claude app; macOS:
  `~/Library/Application Support/Claude/`). Do a read-only search for the
  artifact folder, copy it back to the app's expected location (never move the
  original), then restart the app and verify it opens.

### 4. Git-tracked code and lost commits (recoverable)

- Lost commit or branch reset: `git reflog` shows every HEAD position; recover
  with `git checkout -b rescue <sha>` or `git reset --hard <sha>`.
- Deleted branch: find its tip in `git reflog` or `git fsck --no-reflogs
  --lost-found`, then re-create it.
- Stashed and forgotten: `git stash list` then `git stash show -p stash@{n}`.
- Dangling / dropped commits: `git fsck --lost-found` lists dangling commits;
  inspect with `git show <sha>`.
- Uncommitted edits lost from the working tree are only recoverable from the
  editor's local history (VS Code: "Local History") or a backup. Say so if that
  is the case; do not imply git can recover what was never committed.

### 5. Scratchpad / tool-output files (recoverable)

Generated files, reports, and command outputs are saved per session.

- Search the session scratchpad and tool-results:
  ```bash
  find ~/.claude/projects -type f \( -name '*.html' -o -name '*.md' -o -name '*.txt' \) \
    -newermt '-14 days' -printf '%TY-%Tm-%Td %TH:%TM  %p\n' 2>/dev/null | sort -r | head
  ```
- Match by name, date, or `grep` for known content, then copy back to the user's
  project.

## Step 3 — verify every recovery (do not skip)

A recovery is not done until it is verified. For whatever was recovered, confirm
and report:

- **Integrity**: the file parses / opens without error (JSONL lines valid, HTML
  renders, git object checks out).
- **Completeness**: message count, byte size, or line count is plausible and not
  truncated; first and last timestamps are continuous with no gap.
- **Identity**: it is the right item (title, date, a unique phrase the user
  remembers all match).
- **Location**: the recovered copy is saved somewhere durable the user chose,
  not left in a temp/ephemeral folder.

Then emit a short **Recovery Report**:

```
RECOVERY REPORT
Target:        <what was lost>
Found at:      <path or URL>
Method:        <section used>
Verified:      integrity OK · N messages/lines · <first>..<last> · identity confirmed
Saved to:      <durable destination>
Not recovered: <anything that could not be, stated plainly>
```

## Step 4 — prevent the next loss

Close by offering the relevant guard:

- **claude.ai chats**: request an account **Data Export** periodically; archive
  instead of delete when unsure.
- **Claude Code sessions**: `~/.claude/projects` transcripts are the backup;
  copy important ones out before ending long-lived work in an ephemeral/remote
  container (those containers are reclaimed).
- **Code**: commit and push often; a pushed branch survives any local loss.
- **Artifacts**: they persist on the account; keep the URL.

## Scope guardrails

- Read-only first. Never delete or overwrite an original while recovering; copy,
  don't move.
- Never invent recovered content. If the source is gone, report it as gone.
- Treat any secrets found during a search (keys, tokens) as sensitive: do not
  echo them into shared output.
