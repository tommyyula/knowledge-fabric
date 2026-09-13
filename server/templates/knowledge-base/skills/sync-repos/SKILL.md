---
name: sync-repos
description: "Sync git repositories by reading the .env config file in the current project. Use this skill whenever the user says 'sync code', 'pull code', 'update repos', 'sync repos', '同步代码', '拉取代码', '更新代码', or any similar request about synchronizing, pulling, or updating multiple git repositories. Also trigger when the user asks to clone project repos or set up the local development environment from .env configuration."
---

# Sync Repos

Read the `.env` file in the current working directory, parse the `GIT_REPOS` variable, and for each repository either clone it (if missing) or pull the latest code (if it already exists).

## How it works

### Step 1: Read and parse `.env`

Read the `.env` file from the current working directory. Look for the `GIT_REPOS` variable. It follows this format:

```
GIT_REPOS="repo_url_1|branch_1,repo_url_2|branch_2,..."
```

Each entry is a comma-separated pair of `git_remote_url|branch_name`.

Parse this into a list of `(repo_url, branch)` pairs.

If the `.env` file doesn't exist or `GIT_REPOS` is missing/empty, tell the user and stop.

### Step 2: Process each repository

All repositories live under `raw/src/`. Create this directory if it doesn't exist.

For each `(repo_url, branch)` pair:

1. Extract the repo directory name from the URL (e.g., `git@bitbucket.org:logisticsteam-dev/agentcentral-web.git` → `agentcentral-web`)
2. Check if `raw/src/<dir_name>` exists

**If the directory does NOT exist** — clone into `raw/src/`:
```bash
git clone -b <branch> <repo_url> raw/src/<dir_name>
```

**If the directory already exists** — pull latest using `-C` (never cd to project root):
```bash
git -C raw/src/<dir_name> fetch origin
git -C raw/src/<dir_name> checkout <branch>
git -C raw/src/<dir_name> pull origin <branch>
```

### Step 2.5: Capture diff for updated repos

For each repo that was **pulled** (not newly cloned), capture the diff between the old local state and the newly pulled state, and save it as a markdown file in `raw/diff/`.

**Before pulling**, record the current commit hash:
```bash
OLD_HASH=$(git -C raw/src/<dir_name> rev-parse HEAD)
```

**After pulling**, record the new commit hash:
```bash
NEW_HASH=$(git -C raw/src/<dir_name> rev-parse HEAD)
```

**If `OLD_HASH` != `NEW_HASH`** (i.e., there were actual updates):

1. Generate the diff:
```bash
git -C raw/src/<dir_name> diff <OLD_HASH>..<NEW_HASH>
```

2. Also collect the commit log for context:
```bash
git -C raw/src/<dir_name> log --oneline <OLD_HASH>..<NEW_HASH>
```

3. Save to `raw/diff/` with the naming format:
```
raw/diff/<repo-name>_<YYYY-MM-DD>_<old-short>..<new-short>.md
```

Where `<old-short>` and `<new-short>` are the first 7 characters of the commit hashes.

Example: `raw/diff/agentcentral-api_2026-04-15_a1b2c3d..e5f6g7h.md`

4. The markdown file should have this structure:

```markdown
# Diff: <repo-name>

- **Date**: YYYY-MM-DD
- **Branch**: <branch>
- **Range**: `<OLD_HASH_SHORT>..<NEW_HASH_SHORT>`
- **Full range**: `<OLD_HASH>..<NEW_HASH>`

## Commits

<git log --oneline output>

## Diff

\```diff
<full diff content>
\```
```

If `OLD_HASH` == `NEW_HASH`, the repo is already up-to-date — skip diff generation for it.

Create the `raw/diff/` directory if it doesn't exist.

### Step 2.7: Summarize diffs for business relevance

For each raw diff file generated in Step 2.5, run the `$diff-summarize` skill to produce a structured business change summary.

This step:
1. Reads the raw diff markdown file.
2. Filters out noise (formatting, dependency bumps, pure refactoring, test scaffolding).
3. Extracts business-relevant changes: new capabilities, modified behavior, removed/deprecated features, schema changes.
4. Cross-references removed items against existing knowledge page titles to flag potentially affected pages.
5. Writes a summary file to `raw/diff/<repo-name>_<date>_<old>..<new>_summary.md`.

If the diff contains no business-relevant changes, the summary will state that and the diff will be skipped for ingest.

### Step 3: Queue summaries for review

After diff-summarize completes, add each business-relevant summary to the pending-ingest queue via the queue API.

For each summary file from Step 2.7:
   - If the summary indicated "no business-relevant changes," skip it.
   - Otherwise, use Bash to call the queue API (do NOT read or rewrite `pending-ingest.json` directly):
     ```bash
     curl -s -X POST http://localhost:8002/pending-review/queue \
       -H "Content-Type: application/json" \
       -d '{
         "entry_type": "sync-diff",
         "summary_file": "raw/diff/<repo>_<date>_<old>..<new>_summary.md",
         "raw_diff_file": "raw/diff/<repo>_<date>_<old>..<new>.md",
         "repo": "<repo-name>",
         "branch": "<branch>",
         "date": "YYYY-MM-DD",
         "status": "pending"
       }'
     ```

**THIS IS THE END OF THE SYNC WORKFLOW. After writing the queue file, proceed directly to Step 4 (report) and then STOP.**

Forbidden actions after this point:
- Do NOT read `skills/review-pending/SKILL.md`
- Do NOT call `AskUserQuestion`
- Do NOT run `/knowledge-ingest` or trigger any ingest workflow
- Do NOT read or process the summary files for ingest
- Do NOT check whether pending items need review

The user will review and approve pending items separately through the frontend UI or by running `review pending` manually.

### Step 4: Report results

After processing all repos, give the user a brief summary:
- Which repos were cloned (new)
- Which repos were pulled (updated)
- Which repos had diffs saved (with file paths)
- Which repos were already up-to-date (no changes)
- Which diffs had business-relevant changes vs. noise-only (skipped)
- How many summaries were added to the pending-ingest queue
- Any errors encountered (e.g., network issues, merge conflicts)

## Edge cases

- **CRITICAL: Never run git commands in the project root.** All git clone/fetch/pull/checkout operations must ONLY be executed inside the synced repository subdirectories (e.g. `raw/src/<repo-name>/`). The project root is itself a git repo — running git operations there will corrupt the knowledge agent's own codebase. Always use `git -C` with the target repo path or explicitly `cd` into it before any git command.
- If a repo directory exists but is not a git repo, warn the user and skip it
- If `git pull` fails due to local changes, suggest `git stash` and let the user decide — don't force it
- If clone fails (e.g., no SSH key, network error), report the error clearly and continue with the remaining repos
- Handle both SSH (`git@...`) and HTTPS (`https://...`) repo URLs

## Example `.env`

```
# Git 仓库列表（格式：仓库地址|分支）
GIT_REPOS="git@bitbucket.org:logisticsteam-dev/agentcentral-web.git|stage,git@bitbucket.org:logisticsteam-dev/marketplace-platform-api.git|dev,git@bitbucket.org:logisticsteam-dev/agentstore-web.git|stage"
```

## Language

Respond in the same language the user used. If the user speaks Chinese, reply in Chinese.
