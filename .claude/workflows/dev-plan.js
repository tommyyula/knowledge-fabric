export const meta = {
  name: 'dev-plan',
  description: 'Draft plan (sonnet) → review (opus) → revise until approved → move issue Backlog → Ready — no code changes',
  phases: [
    { title: 'Plan',   detail: 'Read codebase, draft implementation plan', model: 'sonnet' },
    { title: 'Review', detail: 'Independent review; loop until approved',   model: 'opus'   },
    { title: 'Board',  detail: 'Move linked GitHub issue Backlog → Ready'                    },
  ],
}

const MAX_ITERATIONS = 3   // max plan→review cycles before giving up

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

const COMMENT_SCHEMA = {
  type: 'object',
  properties: {
    posted: { type: 'boolean' },
    url:    { type: 'string' },
    error:  { type: 'string' },
  },
  required: ['posted'],
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

const PLAN_SCHEMA = {
  type: 'object',
  properties: {
    approach: { type: 'string' },
    files_to_edit: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path:   { type: 'string' },
          change: { type: 'string' },
        },
        required: ['path', 'change'],
      },
    },
    files_to_create: {
      type: 'array',
      items: {
        type: 'object',
        properties: { path: { type: 'string' }, purpose: { type: 'string' } },
        required: ['path', 'purpose'],
      },
    },
    risks:             { type: 'array', items: { type: 'string' } },
    changelog_needed:  { type: 'boolean' },
    scope:             { type: 'string', enum: ['small', 'medium', 'large'] },
    project_root:      { type: 'string', description: 'Absolute path from git rev-parse --show-toplevel' },
  },
  required: ['approach', 'files_to_edit', 'files_to_create', 'risks', 'changelog_needed', 'scope'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict:     { type: 'string', enum: ['approved', 'needs_revision'] },
    issues:      { type: 'array', items: { type: 'string' } },
    suggestions: { type: 'array', items: { type: 'string' } },
    summary:     { type: 'string' },
  },
  required: ['verdict', 'issues', 'suggestions', 'summary'],
}

// ── Args ───────────────────────────────────────────────────────────────────

// Accept: plain string task, args.task, args.issue_url, or args.issue (GitHub URL or #number)
const rawInput = (typeof args === 'string')             ? args
               : (args && args.task)                    ? args.task
               : (args && (args.issue_url || args.issue)) ? String(args.issue_url || args.issue)
               : null

// Treat input as a GitHub issue when it is a full issue URL, OR a bare number /
// #number — whether passed as a plain STRING arg (how slash commands pass it) or
// via args.issue/args.issue_url. Anchored ^#?\d+$ ensures a free-text task is NOT
// mistaken for an issue number. (Previously only the object form was honored, so a
// bare "#26" string left issueNumber null and the board move was silently skipped.)
const bareIssueRef = ((args && (args.issue_url || args.issue)) ? String(args.issue_url || args.issue)
                     : (typeof rawInput === 'string') ? rawInput
                     : '').trim()
const isIssueUrl = rawInput && /github\.com\/.+\/issues\/\d+/.test(rawInput)
const isIssueNum = /^#?\d+$/.test(bareIssueRef)
const isGithubIssue = !!(isIssueUrl || isIssueNum)

// What to hand to `gh issue view`: the URL as-is, or a bare number (current repo).
const issueFetchRef = isIssueUrl ? rawInput
                    : isIssueNum ? bareIssueRef.replace(/^#/, '')
                    : null

// Owner/repo/number for the board move (owner/repo only known from a full URL;
// a bare number resolves against the current repo at move time via gh repo view).
const issueUrlBoardMatch = isIssueUrl ? rawInput.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/) : null
const issueOwner  = issueUrlBoardMatch ? issueUrlBoardMatch[1] : null
const issueRepo   = issueUrlBoardMatch ? issueUrlBoardMatch[2] : null
const issueNumber = issueUrlBoardMatch ? issueUrlBoardMatch[3] : (isIssueNum ? bareIssueRef.replace(/^#/, '') : null)

const task = rawInput

const reviewModel = (args && args.review_model) ? args.review_model : 'opus'

if (!task) {
  log('No task provided.')
  return { status: 'aborted', reason: 'Missing task description' }
}

if (isGithubIssue) {
  log(`GitHub issue detected — planner will fetch: ${issueFetchRef}`)
} else {
  log(`Task: ${task}`)
}

// ── Plan → Review loop ─────────────────────────────────────────────────────

let plan   = null
let review = null

for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
  const isRevision = iter > 1
  const planLabel  = isRevision ? `Plan (revision ${iter})` : 'Plan'
  const revLabel   = isRevision ? `Review (round ${iter})`  : 'Review'

  // ── Plan phase ────────────────────────────────────────────────────────────
  log(isRevision
    ? `Revision ${iter}/${MAX_ITERATIONS} — replanning based on reviewer feedback...`
    : (isGithubIssue ? `Fetching GitHub issue and analysing...` : `Analysing task: ${task}`))

  const revisionSection = isRevision ? `
REVISION REQUIRED — the previous plan was rejected by the reviewer.

Blocking issues you MUST fix in this revision:
${review.issues.map(i => `  - ${i}`).join('\n')}

Suggestions to consider (non-blocking):
${review.suggestions.length ? review.suggestions.map(s => `  - ${s}`).join('\n') : '  (none)'}

Address every blocking issue. Do not change things unrelated to the feedback.
`.trim() : ''

  const issueSection = isGithubIssue ? `
IMPORTANT: The task refers to a GitHub issue. Before planning, run (from the current repo):
  gh issue view "${issueFetchRef}" --json title,body,labels,comments
Use the "title" as the task summary and "body" as the full requirements.
If the command fails (not authenticated or wrong ref), use the reference as-is for context.
` : ''

  plan = await agent(`
You are a senior engineer. Your job is to produce a detailed implementation plan. Do NOT modify any files.

LANGUAGE: Write ALL prose in Simplified Chinese (简体中文) — this includes the "approach"
text, every file "change" description, and every entry in "risks". Keep code identifiers,
file paths, function/variable names, API endpoints, and line-number references EXACTLY as they
appear in the code (do not translate or transliterate them). "scope" and "changelog_needed"
keep their required enum/boolean values.

Task: ${task}
${issueSection}
${revisionSection ? revisionSection + '\n' : ''}Steps:
1. Run: git rev-parse --show-toplevel  — to find the project root. Store this as your working base.
${isGithubIssue ? `1a. Fetch the GitHub issue: gh issue view "${issueFetchRef}" --json title,body,labels,comments\n    Use the title + body as the requirements to plan against.\n` : ''}2. Read CLAUDE.md from the project root if it exists (fall back to README.md) for conventions.
3. Explore the relevant source files from the project root.
4. Think through the minimal set of changes needed.
5. Identify risks, edge cases, and anything non-obvious.

Return a structured plan with project_root filled in.
`.trim(),
    { label: 'planner', phase: planLabel, schema: PLAN_SCHEMA, model: 'sonnet' },
  )

  if (!plan) {
    log('Planner returned null — aborting.')
    return { status: 'aborted', reason: 'Planner agent returned null' }
  }

  const projectRoot = plan.project_root || '(unknown)'

  // ── Review phase ──────────────────────────────────────────────────────────
  log(`Plan ready (iteration ${iter}) — sending to reviewer (${reviewModel})...`)

  review = await agent(`
You are a staff engineer doing an independent review of an implementation plan.

LANGUAGE: Write ALL prose in Simplified Chinese (简体中文) — this includes "summary", every
entry in "issues", and every entry in "suggestions". Keep code identifiers, file paths,
function/variable names, API endpoints, and line-number references EXACTLY as they appear.
"verdict" keeps its required enum value (approved / needs_revision).

Project root: ${projectRoot}
Task the plan is solving:
${task}

${isRevision ? `NOTE: This is revision ${iter}. The previous plan had these issues:\n${review.issues.map(i => `- ${i}`).join('\n')}\nVerify they are now addressed.\n` : ''}

Proposed plan:
Approach: ${plan.approach}

Files to edit:
${plan.files_to_edit.map(f => `- ${f.path}: ${f.change}`).join('\n')}

Files to create:
${plan.files_to_create.length ? plan.files_to_create.map(f => `- ${f.path}: ${f.purpose}`).join('\n') : '(none)'}

Risks identified by planner:
${plan.risks.length ? plan.risks.map(r => `- ${r}`).join('\n') : '(none)'}

Review the plan critically — read the actual files at ${projectRoot}:
1. Are any files missing? (models, migrations, i18n, tests, etc.)
2. Is the approach correct given the actual code? (circular imports, wrong abstractions, incorrect API assumptions)
3. Are there risks the planner missed?
4. Is anything over- or under-engineered?
5. Would this plan produce working code, or are there gaps?
${isRevision ? '6. Are the previous blocking issues now fully resolved?' : ''}

verdict: approved = solid enough to implement as-is.
         needs_revision = significant gaps that would cause bugs or missed work.
issues: blocking problems only.
suggestions: non-blocking improvements.
`.trim(),
    { label: 'reviewer', phase: revLabel, schema: REVIEW_SCHEMA, model: reviewModel },
  )

  if (!review) {
    log('Reviewer returned null — treating plan as approved.')
    break
  }

  log(`[Iteration ${iter}] Review verdict: ${review.verdict.toUpperCase()} — ${review.issues.length} issue(s)`)

  if (review.verdict === 'approved') break

  if (iter === MAX_ITERATIONS) {
    log(`Max iterations (${MAX_ITERATIONS}) reached without approval — returning plan with open issues.`)
  }
}

// ── Move linked issue Backlog → Ready (only once the plan is approved) ──────

const approved = !review || review.verdict === 'approved'

let issueMoved = false
if (isGithubIssue && issueNumber && approved) {
  phase('Board')
  log(`Plan approved — moving issue #${issueNumber} to "Ready"...`)
  const board = await agent(
    boardMovePrompt({
      projectRoot: plan.project_root || '.',
      targetStatus: 'Ready',
      issueOwner, issueRepo, issueNumber,
    }),
    { label: 'board-ready', phase: 'Board', schema: BOARD_SCHEMA },
  )
  issueMoved = !!(board && board.issue_moved)
  log(issueMoved
    ? `Issue #${issueNumber} → Ready`
    : `Issue move skipped (non-fatal): ${board ? (board.notes || board.error || 'unknown') : 'agent returned null'}`)
}

// ── Format output ──────────────────────────────────────────────────────────

const editLines   = plan.files_to_edit.map(f => `  • ${f.path}\n    ${f.change}`).join('\n')
const createLines = plan.files_to_create.length
  ? plan.files_to_create.map(f => `  • ${f.path} — ${f.purpose}`).join('\n')
  : '  （无）'
const riskLines = plan.risks.length
  ? plan.risks.map(r => `  ⚠ ${r}`).join('\n')
  : '  （无）'

const verdictLine = approved ? '✅ 已批准' : `⚠️  需要修订（已达最大迭代次数）`
const issueLines  = review && review.issues.length
  ? review.issues.map(i => `  ✗ ${i}`).join('\n')
  : '  （无）'
const suggLines   = review && review.suggestions.length
  ? review.suggestions.map(s => `  → ${s}`).join('\n')
  : '  （无）'

const display = `
## 计划：${task}

**规模：** ${plan.scope}  |  **需要更新 Changelog：** ${plan.changelog_needed}

### 方案
${plan.approach}

### 待修改文件
${editLines}

### 待新建文件
${createLines}

### 风险
${riskLines}

---

## ${verdictLine}（${reviewModel}）

${review ? review.summary : '（无审阅）'}

### 阻断性问题
${issueLines}

### 建议
${suggLines}
`.trim()

// ── Persist the approved plan as a comment on the issue ─────────────────────
// So the plan has a durable, reviewable home on the issue itself rather than
// living only in the workflow transcript. Only when we have a real issue and an
// approved plan. Best-effort: a comment failure never fails the task.
let planCommented = false
if (isGithubIssue && issueNumber && approved) {
  const issueRef = (issueOwner && issueRepo) ? `${issueOwner}/${issueRepo}#${issueNumber}` : `#${issueNumber}`
  const repoFlag = (issueOwner && issueRepo) ? ` --repo ${issueOwner}/${issueRepo}` : ''
  const comment = await agent(
    `Post the following plan as a comment on GitHub issue ${issueRef}. Working directory: ${plan.project_root || '.'}
Write the content VERBATIM (do not summarize, reword, or add anything) to a temp file, then run:
    gh issue comment ${issueFetchRef}${repoFlag} --body-file <tempfile>
Return {posted:true,url:<comment url>} on success, or {posted:false,error:<reason>} on failure.
This is non-fatal — if gh errors (e.g. auth), just report posted:false.

Content between the <<<PLAN>>> markers (exclusive):
<<<PLAN>>>
## 📋 实施计划 — 由 dev-plan 生成

${display}
<<<PLAN>>>`,
    { label: 'post-plan', phase: 'Board', schema: COMMENT_SCHEMA },
  )
  planCommented = !!(comment && comment.posted)
  log(planCommented
    ? `Plan posted to issue #${issueNumber}${comment.url ? `: ${comment.url}` : ''}`
    : `Plan comment skipped (non-fatal): ${comment ? (comment.error || 'unknown') : 'agent returned null'}`)
}

return {
  status: approved ? 'plan_ready' : 'plan_needs_revision',
  task,
  plan,
  review,
  issue_number: issueNumber,
  issue_in_ready: issueMoved,
  plan_commented: planCommented,
  display,
}
