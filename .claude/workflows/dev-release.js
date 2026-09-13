export const meta = {
  name: 'dev-release',
  description: 'Version bump + CHANGELOG promote, merge develop → main (GitHub Release auto-created by the repo\'s release-on-main Action), move issue In Review → Done',
  phases: [
    { title: 'Preflight',    detail: 'Git state check + project root discovery' },
    { title: 'Release Prep', detail: 'Promote CHANGELOG Unreleased → version, bump version, commit develop' },
    { title: 'Release',      detail: 'Merge develop → main, push main (triggers release-on-main Action)' },
    { title: 'Board',        detail: 'Move linked GitHub issue In Review → Done' },
  ],
}

// ── Board-move helper ──────────────────────────────────────────────────────
// Moves a GitHub issue to a target Projects (v2) "Status" option on whatever
// board it already belongs to. Auto-detects the board FROM THE ISSUE ITSELF.
const BOARD_SCHEMA = {
  type: 'object',
  properties: {
    issue_moved: { type: 'boolean' },
    notes:       { type: 'string' },
    error:       { type: 'string' },
  },
  required: ['issue_moved'],
}

function boardMovePrompt({ projectRoot, targetStatus, issueOwner, issueRepo, issueNumber }) {
  const ownerRepo = (issueOwner && issueRepo)
    ? `OWNER="${issueOwner}" ; REPO="${issueRepo}"   (parsed from the issue URL)`
    : `OWNER=$(gh repo view --json owner -q .owner.login) ; REPO=$(gh repo view --json name -q .name)`
  return `
Move GitHub issue #${issueNumber} to the "${targetStatus}" status on whatever Projects (v2)
board it ALREADY belongs to. Working directory: ${projectRoot}
The board is auto-detected FROM THE ISSUE ITSELF via GraphQL — do NOT list all projects or
guess which board belongs to the repo.

a. Determine owner and repo:
   ${ownerRepo}

b. Find the project item(s) the issue is linked to (its own board memberships):
   gh api graphql -f query='
     query($owner:String!,$repo:String!,$number:Int!){
       repository(owner:$owner,name:$repo){
         issue(number:$number){
           projectItems(first:20){ nodes{ id project{ id number title } } }
         }
       }
     }' -f owner="$OWNER" -f repo="$REPO" -F number=${issueNumber}
   If projectItems.nodes is EMPTY, the issue is not on any board yet — set issue_moved=false,
   note "issue not linked to any project", and stop. NON-FATAL.

c. For EACH returned item (usually exactly one), look up that project's "Status"
   single-select field id and its "${targetStatus}" option id:
   gh api graphql -f query='
     query($project:ID!){
       node(id:$project){ ... on ProjectV2{
         field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } }
       } }
     }' -f project="<project.id from step b>"
   Match the option whose name is "${targetStatus}" (case-insensitive).

d. Apply the status change:
   gh api graphql -f query='
     mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){
       updateProjectV2ItemFieldValue(input:{
         projectId:$project,itemId:$item,fieldId:$field,
         value:{singleSelectOptionId:$option}
       }){ projectV2Item{ id } }
     }' -f project="<project.id>" -f item="<item.id>" -f field="<status field id>" -f option="<${targetStatus} option id>"

Set issue_moved=true if at least one board was updated; in notes record which project was
changed (e.g. "#5 czDocs Kanban → ${targetStatus}").
If any step fails (common cause: gh token lacks the "project" scope — remedy:
gh auth refresh -s project), set issue_moved=false and explain in notes. NON-FATAL —
never fail the whole task over it.
`.trim()
}

// ── Schemas ────────────────────────────────────────────────────────────────

const PREFLIGHT_SCHEMA = {
  type: 'object',
  properties: {
    ok:              { type: 'boolean' },
    project_root:    { type: 'string', description: 'Absolute path from git rev-parse --show-toplevel' },
    has_uncommitted: { type: 'boolean', description: 'Modified or staged TRACKED files only — untracked do NOT count' },
    remote_exists:   { type: 'boolean' },
    main_branch:     { type: 'string', description: 'Name of the release branch that exists: "main" or "master"' },
    error:           { type: 'string' },
  },
  required: ['ok', 'project_root', 'has_uncommitted', 'remote_exists'],
}

const PREP_SCHEMA = {
  type: 'object',
  properties: {
    has_release_notes: { type: 'boolean', description: 'true if CHANGELOG had a non-empty ## Unreleased section to promote' },
    new_version:       { type: 'string',  description: 'Bare version e.g. "0.4.5" (empty if has_release_notes=false)' },
    version_tag:       { type: 'string',  description: 'Tag form e.g. "v0.4.5" (empty if has_release_notes=false)' },
    version_file:      { type: 'string',  description: 'Path to the package.json whose version was bumped, or empty if none found' },
    committed:         { type: 'boolean' },
    pushed:            { type: 'boolean' },
    notes:             { type: 'string' },
    error:             { type: 'string' },
  },
  required: ['has_release_notes'],
}

const RELEASE_SCHEMA = {
  type: 'object',
  properties: {
    merged:            { type: 'boolean', description: 'true if main now contains develop (merged, or already up to date)' },
    nothing_to_merge:  { type: 'boolean', description: 'true if develop was already fully merged into main' },
    pushed:            { type: 'boolean' },
    notes:             { type: 'string' },
    error:             { type: 'string' },
  },
  required: ['merged'],
}

// ── Args ───────────────────────────────────────────────────────────────────

// Optional GitHub issue reference: number (42), "#42", or full URL.
const issueArg = (typeof args === 'string') ? args
               : (args && typeof args === 'object') ? (args.issue || args.issue_url || null)
               : null
const issueStr = issueArg ? String(issueArg) : ''
const issueUrlMatch = issueStr.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/)
const issueNumMatch = issueStr.match(/^#?(\d+)$/)
const issueOwner  = issueUrlMatch ? issueUrlMatch[1] : null
const issueRepo   = issueUrlMatch ? issueUrlMatch[2] : null
const issueNumber = issueUrlMatch ? issueUrlMatch[3] : (issueNumMatch ? issueNumMatch[1] : null)

// ── Phase 0: Preflight ─────────────────────────────────────────────────────

phase('Preflight')
log('Checking git state before release...')

const preflight = await agent(`
Run the following checks and report results.

1. Project root:
     git rev-parse --show-toplevel
   Store this as project_root.

2. Uncommitted changes — run BOTH and check combined output:
     git diff --name-only HEAD
     git diff --cached --name-only
   has_uncommitted = true if EITHER produces output. (Untracked files do not count.)

3. Remote origin:
     git remote get-url origin
   remote_exists = true if the command succeeds.

4. Release branch name — check which exists:
     git show-ref --verify --quiet refs/heads/main   && echo main
     git show-ref --verify --quiet refs/heads/master && echo master
   Set main_branch to "main" if it exists, else "master" if it exists, else "main".

Set ok = true only if remote_exists is true AND has_uncommitted is false.
If has_uncommitted is true, set error to:
  "Uncommitted changes detected. Commit or stash before releasing."
If remote_exists is false, set error to:
  "No remote origin found. Cannot push."
`.trim(),
  { label: 'preflight', phase: 'Preflight', schema: PREFLIGHT_SCHEMA },
)

if (!preflight || !preflight.ok) {
  return {
    status: 'preflight_failed',
    error:  preflight ? preflight.error : 'Preflight agent returned null',
    has_uncommitted: preflight ? preflight.has_uncommitted : null,
  }
}

const projectRoot = preflight.project_root
const mainBranch  = preflight.main_branch || 'main'
log(`Preflight OK — releasing develop → ${mainBranch} | root: ${projectRoot}`)

// ── Phase 1: Release Prep — promote CHANGELOG + bump version on develop ─────

phase('Release Prep')
log('Preparing release notes on develop (CHANGELOG + version bump)...')

const prep = await agent(`
Prepare a release ON THE develop BRANCH. Working directory: ${projectRoot}
This runs BEFORE the merge to ${mainBranch}, so the version-bump commit gets carried into ${mainBranch}.

0. Locate where develop is actually checked out — it may be a different worktree than this
   one, sharing the same repository. Never run \`git checkout develop\` blind: if develop is
   checked out in another worktree, that fails outright with
   "fatal: 'develop' is already checked out at ...".
     git worktree list --porcelain | awk '/^worktree /{p=$0} /^branch refs\\/heads\\/develop$/{sub(/^worktree /,"",p); print p; exit}'
   - If that prints a path, call it DEVELOP_DIR and cd into it:
       cd "$DEVELOP_DIR"
   - If it prints nothing, develop is not checked out anywhere yet: stay put, run
     \`git checkout develop\`, and treat ${projectRoot} as DEVELOP_DIR.
   Either way, now bring it up to date: git pull --ff-only origin develop
   All steps below operate on DEVELOP_DIR's working tree (wherever you just cd'd to, or
   ${projectRoot} if you stayed put).

1. Locate CHANGELOG.md at the repo root. If it does NOT exist, set has_release_notes=false,
   note "no CHANGELOG.md", and STOP (non-fatal — release still proceeds without a GitHub Release).

2. Find the "## Unreleased" section (case-insensitive; also accept "## [Unreleased]").
   - If there is no such heading, OR it has NO entry lines beneath it before the next "## " heading
     (only blank lines), set has_release_notes=false, note "Unreleased empty — nothing to release",
     and STOP. Non-fatal.

3. Determine the CURRENT version and the NEXT version:
   - Find the primary version file: prefer a root package.json with a top-level "version"; otherwise
     search for package.json files containing a top-level "version" (e.g. an app/frontend one) and
     pick the most app-like. Record its path as version_file. If none found, version_file="" and take
     the current version from the latest "## vX.Y.Z" heading already in CHANGELOG.
   - Decide the bump from the Unreleased entries: bump MINOR (x.Y+1.0) if any entry describes a NEW
     feature (feat/新功能/新增功能); otherwise bump PATCH (x.y.Z+1). Never bump major automatically.
   - new_version = bare "X.Y.Z"; version_tag = "v" + new_version.

4. Rewrite CHANGELOG.md:
   - Rename the "## Unreleased" heading to "## ${'v'}<new_version> — <today>", where <today> is
     $(date +%F).
   - Insert a fresh empty "## Unreleased" section ABOVE the new version heading (heading + one blank line).
   - Preserve all other content exactly.

5. If version_file is non-empty, bump its "version" field to new_version (JSON edit, keep formatting).

6. Commit and push develop — stage ONLY the two files this step changed. Do NOT run "git add -A":
   the working tree may contain the user's unrelated in-progress edits that must NOT be swept
   into the release commit.
     git add CHANGELOG.md
     git add <version_file>            # only if version_file is non-empty
     git commit -m "chore(release): v<new_version>"
     git push origin develop
   Set committed=true, pushed=true on success. Do NOT use --no-verify. Do NOT force push.

The GitHub Release itself is NOT created here — the repo's release-on-main GitHub Action creates it
automatically once ${'main'} is pushed with the bumped package.json version. Your only job is to stage
the version bump + CHANGELOG promotion into develop so the merge carries them to main.

Return has_release_notes=true with new_version, version_tag, version_file, committed, pushed, notes.
If anything unexpected fails, put it in error but prefer non-fatal partial results so the merge can
still proceed.
`.trim(),
  { label: 'release-prep', phase: 'Release Prep', schema: PREP_SCHEMA },
  { label: 'release-prep', phase: 'Release Prep', schema: PREP_SCHEMA },
)

const hasNotes = !!(prep && prep.has_release_notes)
if (hasNotes) {
  log(`Release notes prepared → ${prep.version_tag}${prep.pushed ? ' · develop pushed' : ''}`)
} else {
  log(`No release notes to promote (non-fatal): ${prep ? (prep.notes || prep.error || 'Unreleased empty / no CHANGELOG') : 'prep agent returned null'}`)
}

// ── Phase 2: Release — merge develop → main ────────────────────────────────

phase('Release')
log(`Merging develop → ${mainBranch}...`)

const releaseMsg = `Release${hasNotes ? ` ${prep.version_tag}` : ''}: merge develop → ${mainBranch}${issueNumber ? ` (#${issueNumber})` : ''}`

const release = await agent(`
Release the current develop branch to ${mainBranch}. Working directory: ${projectRoot}
You may need to cd elsewhere during this phase (see steps 1-2) — that is expected.

Steps — run in order. STOP and report failure the moment a guard trips; never let a
silent "Already up to date" pass through when it should not.

0. Remember the branch checked out here right now, in case you end up staying in this
   same directory and need to restore it at the end:
     git branch --show-current
   Call this ORIGINAL_BRANCH.

1. Get the latest develop without checking it out anywhere (safe to run from any worktree):
     git fetch origin develop
   The merge below merges from origin/develop directly, not a local develop branch — Release
   Prep already pushed the version-bump commit there, so this has everything needed. This
   sidesteps needing a local develop checkout, which may belong to a different worktree.

2. Locate where ${mainBranch} is actually checked out — it may be a different worktree than
   this one. Never run \`git checkout ${mainBranch}\` blind: if it is checked out elsewhere,
   that fails outright with "fatal: '${mainBranch}' is already checked out at ...".
     git worktree list --porcelain | awk -v want="refs/heads/${mainBranch}" '/^worktree /{p=$0} $0=="branch "want{sub(/^worktree /,"",p); print p; exit}'
   - If that prints a path, call it MAIN_DIR and cd into it:
       cd "$MAIN_DIR"
   - If it prints nothing, ${mainBranch} is not checked out anywhere: stay put, run
     \`git checkout ${mainBranch}\`, and treat ${projectRoot} as MAIN_DIR.
   Then: git pull origin ${mainBranch}
   GUARD — confirm you actually landed on ${mainBranch}:
     git rev-parse --abbrev-ref HEAD
   If this is NOT "${mainBranch}", stop. Set merged=false and
   error="Failed to reach ${mainBranch}: <the git error>", then return.

3. GUARD — the working tree here must be clean before merging, or the merge could pick up
   unrelated changes:
     git status --porcelain --untracked-files=no
   If this prints ANY line (modified/staged TRACKED files), do NOT proceed. Set merged=false,
   nothing_to_merge=false, and error="Uncommitted tracked changes block the merge into
   ${mainBranch}; commit or stash them first", then return. (Untracked files are fine and do
   not count.)

4. Determine whether there is anything to merge:
     git rev-list --count HEAD..origin/develop
   Call this AHEAD. Then merge without fast-forward:
     git merge --no-ff origin/develop -m "${releaseMsg.replace(/"/g, '\\"')}"
   - If AHEAD is 0: origin/develop is already fully contained in ${mainBranch}. git will say
     "Already up to date" — set nothing_to_merge=true, merged=true, and continue.
   - If AHEAD is >0 but git STILL reports "Already up to date": this is the silent-failure
     bug — you are probably not on ${mainBranch}. Set merged=false and
     error="Merge reported up-to-date but origin/develop is ${'$'}{AHEAD} commits ahead of ${mainBranch} — aborted", return.
   - If the merge CONFLICTS: run  git merge --abort , set merged=false with the conflicting
     files in error, then return. Do NOT push. No need to switch branches back — you never
     left ${mainBranch} in a half-merged state once aborted.
   - Otherwise the merge commit was created: set merged=true, nothing_to_merge=false.

5. Push (skip only if nothing_to_merge AND ${mainBranch} is already level with origin/${mainBranch}):
     git push origin ${mainBranch}
   Set pushed=true on success. This push is what triggers the repo's release-on-main GitHub
   Action to create the GitHub Release from the bumped version + CHANGELOG.

6. Only if you stayed in the ORIGINAL directory for this whole phase (i.e. ${mainBranch} was
   not checked out in a separate worktree, so you never cd'd away), restore the branch that
   was checked out before this phase started:
     git checkout "$ORIGINAL_BRANCH"
   If you cd'd into a different worktree (MAIN_DIR from step 2), leave it resting on
   ${mainBranch} — that is correct for that worktree — and leave ${projectRoot} untouched;
   do not cd back and do not check anything out there.

Return merged, nothing_to_merge, pushed, notes (mention anything skipped or odd).
Do NOT use --no-verify. Do NOT force push.
`.trim(),
  { label: 'release', phase: 'Release', schema: RELEASE_SCHEMA },
  { label: 'release', phase: 'Release', schema: RELEASE_SCHEMA },
)

if (!release || !release.merged) {
  return {
    status: 'release_failed',
    error:  release ? (release.error || release.notes || 'merge did not complete') : 'release agent returned null',
    main_branch: mainBranch,
    hint:   `git status  (commit/stash any changes), then from wherever ${mainBranch} is checked out: git fetch origin develop && git merge --no-ff origin/develop && git push origin ${mainBranch}`,
  }
}

log(release.nothing_to_merge
  ? `${mainBranch} already up to date with develop — nothing to release`
  : `Released → ${mainBranch}${release.pushed ? ' · pushed' : ''}`)

if (hasNotes && !release.nothing_to_merge && release.pushed) {
  log(`release-on-main Action will create GitHub Release ${prep.version_tag} shortly`)
}

// ── Phase 3: Board — move linked issue In Review → Done ─────────────────────

let issueDone = false
if (issueNumber) {
  phase('Board')
  log(`Moving issue #${issueNumber} to "Done"...`)
  const board = await agent(
    boardMovePrompt({ projectRoot, targetStatus: 'Done', issueOwner, issueRepo, issueNumber }),
    { label: 'board-done', phase: 'Board', schema: BOARD_SCHEMA },
  )
  issueDone = !!(board && board.issue_moved)
  log(issueDone
    ? `Issue #${issueNumber} → Done`
    : `Issue move skipped (non-fatal): ${board ? (board.notes || board.error || 'unknown') : 'agent returned null'}`)
}

return {
  status:          'success',
  issue_number:    issueNumber,
  main_branch:     mainBranch,
  released:        true,
  nothing_to_merge: !!release.nothing_to_merge,
  pushed:          !!release.pushed,
  version:         hasNotes ? prep.new_version : null,
  version_tag:     hasNotes ? prep.version_tag : null,
  github_release:  (hasNotes && !release.nothing_to_merge && release.pushed)
    ? `release-on-main Action creates ${prep.version_tag} from the pushed CHANGELOG (verify: gh release view ${prep.version_tag})`
    : 'no new GitHub Release (nothing merged / no version bump)',
  issue_done:      issueDone,
  next_step:       'main updated (production release). develop and main are in sync.',
}
