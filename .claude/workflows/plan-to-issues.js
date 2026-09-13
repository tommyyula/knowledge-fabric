export const meta = {
  name: 'plan-to-issues',
  description: 'Decompose a spec or epic into milestone/phase/step GitHub issues — dry-run by default, --create writes to GitHub',
  phases: [
    { title: 'Decompose', detail: '读规格或 epic issue，拆成 里程碑 → 阶段 → 步骤', model: 'sonnet' },
    { title: 'Review',    detail: '独立审查拆解：覆盖度、粒度、依赖顺序',              model: 'opus'   },
    { title: 'Fold',      detail: '把审查建议折进对应步骤的 issue 正文',            model: 'opus'   },
    { title: 'Persist',   detail: '把批准的拆解写入 .claude/plan-to-issues.json'                        },
    { title: 'Create',    detail: '创建 GitHub issue 并挂上看板（仅 --create）'                          },
  ],
}

// ─────────────────────────────────────────────────────────────────────────────
// plan-to-issues
//
// 用法：
//   /plan-to-issues docs/UI_SPEC.md              拆解 + 审查，只打印清单，不碰 GitHub
//   /plan-to-issues #12                          同上，输入换成一个 epic issue
//   /plan-to-issues "把库存模块拆一下"             同上，输入换成自由文本
//   /plan-to-issues --create                     读上次批准的拆解，真正建 issue
//   /plan-to-issues docs/UI_SPEC.md --create      重新拆 + 审查 + 直接建
//   /plan-to-issues --create --fresh              强制重拆，忽略已存的 json
//
// 设计取舍：
//   * 默认是 dry run。workflow 跑在后台，没法中途弹确认框，所以「先看后建」拆成两次调用。
//   * 批准的拆解落盘成 .claude/plan-to-issues.json，--create 读它而不是重拆 —— 否则
//     第二次拆出来的清单和你看过的那份会漂移，确认就失去意义了。
//   * 建 issue 按依赖顺序、逐个里程碑串行，issue 编号才和依赖顺序一致。
//   * 重复检测按标题里的 M?-*/P?-*/S? 键前缀，不按全标题 —— 短标题被人改过也不会重建。
// ─────────────────────────────────────────────────────────────────────────────

const MAX_ITERATIONS = 3        // 拆解 → 审查 的最大轮数
const PLAN_FILE = '.claude/plan-to-issues.json'

// ── Schemas ─────────────────────────────────────────────────────────────────

const STEP_SCHEMA = {
  type: 'object',
  properties: {
    key:        { type: 'string', description: '步骤键，形如 S1、S2（阶段内唯一）' },
    title:      { type: 'string', description: '短标题，不含任何前缀，≤ 30 字' },
    body:       { type: 'string', description: 'issue 正文：需求要点 + 验收标准 + 已知的坑' },
    labels:     { type: 'array', items: { type: 'string' } },
    depends_on: { type: 'array', items: { type: 'string' }, description: '依赖的步骤全键，形如 M1-P1-S2' },
  },
  required: ['key', 'title', 'body'],
}

const PHASE_SCHEMA = {
  type: 'object',
  properties: {
    key:   { type: 'string', description: '阶段键，形如 P1、P2（里程碑内唯一）' },
    name:  { type: 'string', description: '阶段名，2-4 个字，如 采购、盘点、菜谱' },
    goal:  { type: 'string' },
    steps: { type: 'array', items: STEP_SCHEMA },
  },
  required: ['key', 'name', 'steps'],
}

const MILESTONE_SCHEMA = {
  type: 'object',
  properties: {
    key:    { type: 'string', description: '里程碑键，形如 M1、M2' },
    name:   { type: 'string', description: '里程碑名，2-4 个字，如 可用、闭环、打磨' },
    goal:   { type: 'string', description: '做完这个里程碑，什么事情从做不到变成做得到' },
    phases: { type: 'array', items: PHASE_SCHEMA },
  },
  required: ['key', 'name', 'goal', 'phases'],
}

const BREAKDOWN_SCHEMA = {
  type: 'object',
  properties: {
    milestones:   { type: 'array', items: MILESTONE_SCHEMA },
    notes:        { type: 'string', description: '拆解时的判断依据、刻意排除的东西' },
    project_root: { type: 'string', description: 'git rev-parse --show-toplevel 的绝对路径' },
  },
  required: ['milestones'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    verdict:     { type: 'string', enum: ['approved', 'needs_revision'] },
    issues:      { type: 'array', items: { type: 'string' },
                   description: '仅阻断性问题 —— 会导致漏活、返工或静默错误的，不含"可以更好"' },
    suggestions: { type: 'array', items: { type: 'string' },
                   description: '非阻断改进；这些会被折进 issue 正文，不触发重拆' },
    regressions: { type: 'array', items: { type: 'string' },
                   description: '上一版有、这一版丢了或被削弱的步骤（修订轮必填，无则空数组）' },
    resolved:    { type: 'array', items: { type: 'string' },
                   description: '上一轮的阻断性问题中，本版已确认解决的（修订轮必填）' },
    summary:     { type: 'string' },
  },
  required: ['verdict', 'issues', 'suggestions', 'summary'],
}

const WRITE_SCHEMA = {
  type: 'object',
  properties: {
    written: { type: 'boolean' },
    path:    { type: 'string' },
    error:   { type: 'string' },
  },
  required: ['written'],
}

const CREATE_SCHEMA = {
  type: 'object',
  properties: {
    created: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          full_key: { type: 'string' },
          number:   { type: 'number' },
          url:      { type: 'string' },
          title:    { type: 'string' },
        },
        required: ['full_key'],
      },
    },
    skipped:      { type: 'array', items: { type: 'string' }, description: '已存在而跳过的全键' },
    board_added:  { type: 'number', description: '成功挂上看板的条数' },
    board_note:   { type: 'string' },
    milestone_created: { type: 'boolean', description: '这个里程碑对应的 GitHub Milestone 是新建的还是复用已有的' },
    milestone_note:    { type: 'string' },
    error:        { type: 'string' },
  },
  required: ['created'],
}

// ── 标题与遍历 ───────────────────────────────────────────────────────────────

// M1-可用/P2-采购/S3 · 按店铺分组
const fullKey  = (m, p, s) => `${m.key}-${m.name}/${p.key}-${p.name}/${s.key}`
const fullTitle = (m, p, s) => `${fullKey(m, p, s)} · ${s.title}`

// 重复检测用的稳定前缀：短标题被改过也认得出来
const keyPrefix = (m, p, s) => `${m.key}-${m.name}/${p.key}-${p.name}/${s.key}`

function flatten(breakdown) {
  const out = []
  for (const m of breakdown.milestones || []) {
    for (const p of m.phases || []) {
      for (const s of p.steps || []) {
        out.push({ m, p, s, key: fullKey(m, p, s), title: fullTitle(m, p, s) })
      }
    }
  }
  return out
}

function renderBreakdown(breakdown) {
  const lines = []
  for (const m of breakdown.milestones || []) {
    const stepCount = (m.phases || []).reduce((n, p) => n + (p.steps || []).length, 0)
    lines.push(`\n### ${m.key}-${m.name} —— ${m.goal || ''}  （${stepCount} 条）`)
    for (const p of m.phases || []) {
      lines.push(`\n**${p.key}-${p.name}**${p.goal ? ` · ${p.goal}` : ''}`)
      for (const s of p.steps || []) {
        const dep = (s.depends_on && s.depends_on.length) ? `  ← ${s.depends_on.join(', ')}` : ''
        lines.push(`  ${fullTitle(m, p, s)}${dep}`)
      }
    }
  }
  return lines.join('\n')
}

// ── Args ────────────────────────────────────────────────────────────────────

const rawArg = (typeof args === 'string') ? args
             : (args && (args.source || args.spec || args.task)) ? String(args.source || args.spec || args.task)
             : ''

const argStr    = rawArg.trim()
const doCreate  = /(^|\s)--create(\s|$)/.test(argStr) || !!(args && args.create)
const forceFresh = /(^|\s)--fresh(\s|$)/.test(argStr) || !!(args && args.fresh)

// 去掉 flag 之后剩下的就是输入源（文件路径 / #issue / 自由文本）
const source = argStr.replace(/(^|\s)--(create|fresh|dry-run)(?=\s|$)/g, ' ').trim()

const projectName = (args && args.project) ? String(args.project) : null

// 有输入源就重拆；没有输入源且是 --create，就走「读上次批准的那份」
const shouldDecompose = !!source || forceFresh

if (!source && !doCreate) {
  log('没有输入。用法：/plan-to-issues docs/UI_SPEC.md  或  /plan-to-issues --create')
  return { status: 'aborted', reason: '缺少输入源' }
}

const isIssueRef = /^#?\d+$/.test(source) || /github\.com\/.+\/issues\/\d+/.test(source)
const issueFetchRef = isIssueRef ? source.replace(/^#/, '') : null

// ── 主流程 ───────────────────────────────────────────────────────────────────

let breakdown = null
let review    = null
let allSuggestions = []   // 历轮建议累积 —— 非阻断问题不该因为轮次推进而丢失

if (shouldDecompose) {
  for (let iter = 1; iter <= MAX_ITERATIONS; iter++) {
    const isRevision = iter > 1
    const prev = breakdown   // 上一版拆解，修订轮要原样传回去打补丁
    const decLabel = isRevision ? `Decompose (revision ${iter})` : 'Decompose'
    const revLabel = isRevision ? `Review (round ${iter})`       : 'Review'

    log(isRevision
      ? `修订 ${iter}/${MAX_ITERATIONS} —— 根据审查意见重拆…`
      : `拆解输入：${source}`)

    const revisionSection = isRevision ? `
本次是修订。**这是在上一版拆解上打补丁，不是重新拆一遍。**

上一版拆解的完整内容（JSON）：
\`\`\`json
${JSON.stringify({ milestones: prev.milestones, notes: prev.notes || '' }, null, 2)}
\`\`\`

必须修掉的阻断性问题：
${review.issues.map(i => `  - ${i}`).join('\n')}
${review.regressions && review.regressions.length ? `
上一轮还发现了这些**回归**（上上版有、上一版丢了），本次务必找回来：
${review.regressions.map(r => `  - ${r}`).join('\n')}
` : ''}
可以考虑的建议（非阻断，**折进相关步骤的 body 即可，不要为它们新增或重排步骤**）：
${allSuggestions.length ? allSuggestions.map(x => `  - ${x}`).join('\n') : '  （无）'}

修订规则 —— 违反任何一条都会造成回归，上一轮就是这么丢掉一条已修好的步骤的：

1. **返回完整的拆解**，未被点名的步骤连同 key / title / body **逐字原样保留**。
   你不是在写一份新的 WBS，你是在编辑一份已有的。
2. **禁止重新编号。** 已有步骤的 key（M1-P2-S3 这种）是稳定标识，后面要拿它去 GitHub 上
   做去重。不要因为插入新步骤就把后面的往后挪 —— 新步骤取该阶段的下一个可用序号。
3. **禁止合并、拆分或删除未被点名的步骤**，哪怕你觉得那样更整齐。
4. 只做三件事：(a) 修掉上面点名的阻断性问题；(b) 找回回归掉的步骤；
   (c) 把建议折进相关步骤的 body。
5. 改完自检一遍：上一版每一个 key 是否都还在？如果少了，就是回归，补回去。
`.trim() : ''

    const sourceSection = isIssueRef ? `
输入是一个 GitHub issue。先运行：
  gh issue view "${issueFetchRef}" --json title,body,labels,comments
用它的 title + body 作为要拆解的需求。
`.trim() : `
输入是仓库里的一份规格文档或一句自由描述：${source}
如果它看起来是个文件路径，先把整个文件读完再拆。
`.trim()

    breakdown = await agent(`
你是一位资深技术负责人。你的工作是把一份需求拆成可执行的 GitHub issue 清单。**不要修改任何文件。**

语言：所有散文用简体中文。代码标识符、文件路径、函数/变量名、API 路径、字段名**原样保留**，不要翻译。

${sourceSection}
${revisionSection ? '\n' + revisionSection + '\n' : ''}
步骤：
1. 运行 git rev-parse --show-toplevel 找到项目根目录，填进 project_root。
2. 读项目根目录的 CLAUDE.md（没有就读 README.md）—— 里面通常有「已定的设计决定」这类
   **不许被优化掉**的约束，拆解必须尊重它们，并把相关约束写进对应 issue 的正文。
3. 读输入源。如果它引用了别的文档（如 docs/ 下的规格），一并读完。
4. 探查现有代码，判断**哪些已经做完了** —— 已完成的部分不要再拆成 issue。
5. 运行 gh issue list --state all --limit 300 --json number,title,state 看**已经存在的 issue**。
   已经被某条 issue 覆盖的工作，不要再拆一条出来，哪怕那条 issue 的标题不符合本次命名规范。
   在 notes 里逐条写明「XXX 已由 #N 覆盖，跳过」。
6. 拆成三层：

   **里程碑（M）** —— 按「做完之后，什么事情从做不到变成做得到」切，不是按技术模块切。
   每个里程碑应当是一个能独立交付、能立刻验证价值的状态。通常 2-4 个。

   **阶段（P）** —— 里程碑内部的功能分组，名字 2-4 个字。通常每个里程碑 2-5 个阶段。

   **步骤（S）** —— 一个步骤 = 一个 issue = 一次能独立跑完 dev-pipeline 的工作量。
   太大（跨越多个页面和多个后端端点）就拆开；太小（改一行文案）就并进相邻步骤。

7. 排序按依赖来：被依赖的排前面。depends_on 填被依赖步骤的**全键**（形如 M1-P1-S2）。
   不要出现循环依赖，也不要依赖比自己晚的步骤。

每个步骤的 body 写成 issue 正文，包含：
  - 几行需求要点（做什么、在哪个路由/端点）
  - 3-5 条**验收标准**（可验证的，不是"实现得好"这种）
  - 这一步已知的坑或必须遵守的设计约束（从 CLAUDE.md / 规格里摘）
不要写实施方案和文件清单 —— 那是 dev-plan 的活，别抢。

notes 里写：你按什么切的里程碑、刻意排除了什么、以及你判断"已经做完"的依据。
`.trim(),
      { label: 'decomposer', phase: decLabel, schema: BREAKDOWN_SCHEMA, model: 'sonnet' },
    )

    if (!breakdown) {
      log('拆解 agent 返回 null —— 中止。')
      return { status: 'aborted', reason: 'decomposer returned null' }
    }

    const items = flatten(breakdown)
    log(`拆出 ${breakdown.milestones.length} 个里程碑 / ${items.length} 条 issue —— 送审（opus）…`)

    review = await agent(`
你是一位 staff engineer，独立审查一份工作分解（WBS）。

语言：所有散文用简体中文。代码标识符、文件路径、API 路径原样保留。

项目根目录：${breakdown.project_root || '(未知)'}
被拆解的输入：${source}

拆解结果：
${renderBreakdown(breakdown)}

拆解者的说明：
${breakdown.notes || '（无）'}

请**实际去读** ${breakdown.project_root || '.'} 下的 CLAUDE.md、相关规格文档和现有代码，然后审查：

1. **覆盖度** —— 规格里有没有成条的需求没被任何 issue 覆盖？特别注意规格中被标为"必须"、
   "关键"、"闭环"的部分，漏掉这些是阻断性问题。
2. **已完成判断** —— 有没有把已经实现的东西又拆成了 issue？有没有把没实现的当成已完成跳过了？
   有没有和仓库里**已存在的 issue** 重复？（自己跑一次 gh issue list --state all 核对。）
3. **粒度** —— 有没有大到一次跑不完的步骤？有没有碎到不值得单开一条的？粒度是否大致均匀？
4. **依赖顺序** —— depends_on 对吗？有没有循环依赖、或依赖了排在自己后面的步骤？
   主数据（排序、分类这类被别人依赖的东西）有没有排在依赖它的功能前面？
5. **设计约束** —— issue 正文有没有违反 CLAUDE.md 里那些"不许优化掉"的既定决定？
   有没有把关键约束漏掉，导致实施时会被"优化"掉？
6. **验收标准** —— 是可验证的，还是"实现得好"这种废话？

${isRevision ? `
## 这是第 ${iter} 轮，你正在审查一次修订

上一轮你（或前一位审查者）提出的阻断性问题：
${review.issues.map(i => `  - ${i}`).join('\n')}

上一版拆解的步骤键清单（用来查回归）：
${flatten(prev).map(it => `  ${it.key} · ${it.s.title}`).join('\n')}

除了常规审查，你必须额外做两件事：

- **resolved**：逐条核对上面的阻断性问题，把**确实已解决**的原样列进 resolved。
- **regressions**：把上一版有、这一版**丢了或被削弱**的步骤列进 regressions。
  上一轮真实发生过这种事：一条已修好的步骤在重拆时被弄丢了，于是同一个问题被报了两遍。
  逐个 key 比对，别凭印象。

` : ''}
## 什么算阻断（这条决定了这个流程会不会收敛）

**只有满足下面之一才算阻断性问题，写进 issues：**

- 规格里成条的需求**完全没有任何步骤认领**（不是"覆盖得不够细"，是压根没人管）
- 会导致**返工**：两条步骤的前提互相冲突，且靠后那条实施到一半才会发现
- 会导致**静默错误**：漏了某个字段或调用，功能不报错但永远不生效
- 违反 CLAUDE.md 里明确写着"不许优化掉"的既定设计决定
- 依赖成环，或依赖了排在自己后面的步骤

**下面这些一律写进 suggestions，不要写进 issues：**

- "这条 body 可以写得更详细 / 验收标准可以更具体"
- "这两条也许合并/拆开更好"、粒度不够均匀
- 实施细节上的取舍建议（存哪张表、用哪个库、字段叫什么）
- 任何**只要在 issue 正文里补一句话就能解决**的问题 —— 建到 issue 里就够了，
  不值得让整份拆解重来一轮

suggestions 不会触发重拆，但会被折进相关步骤的正文，所以放心写，不会丢。

**收敛要求：** 如果这一版已经没有上面那五类问题，就判 approved，**不要因为"还能更好"
而继续打回**。一份能开工的拆解，胜过一份永远在修订的拆解 —— 剩下的细节由 dev-plan
在实施前逐条补，那是它的职责。

verdict: approved = 没有上述五类阻断问题，可以照这个建 issue。
         needs_revision = 存在至少一条上述阻断问题。
issues: 只写阻断性问题，按上面的定义严格判断。
suggestions: 其余全部。
`.trim(),
      { label: 'wbs-reviewer', phase: revLabel, schema: REVIEW_SCHEMA, model: 'opus' },
    )

    if (!review) {
      log('审查 agent 返回 null —— 视为通过。')
      break
    }

    // 建议累积并去重 —— 非阻断问题不该因为轮次推进而丢失
    for (const sg of (review.suggestions || [])) {
      if (!allSuggestions.includes(sg)) allSuggestions.push(sg)
    }

    const regr = (review.regressions || []).length
    log(`[第 ${iter} 轮] 审查结论：${review.verdict.toUpperCase()} —— 阻断 ${review.issues.length}`
        + ` · 建议 ${(review.suggestions || []).length}`
        + (isRevision ? ` · 已解决 ${(review.resolved || []).length} · 回归 ${regr}` : ''))
    if (regr) log(`  ⚠ 检测到 ${regr} 处回归，下一轮会要求找回`)

    if (review.verdict === 'approved') break

    if (iter === MAX_ITERATIONS) {
      log(`已达最大轮数（${MAX_ITERATIONS}）仍未通过 —— 返回当前拆解并附上未解决的问题。`)
    }
  }
} else {
  // --create 且没给输入源：读上次批准的那份
  log(`读取上次批准的拆解：${PLAN_FILE}`)
  breakdown = await agent(`
读取本仓库中已批准的拆解文件，原样返回其内容。

1. 运行 git rev-parse --show-toplevel 得到项目根目录，填进 project_root。
2. 读 <项目根目录>/${PLAN_FILE}。
3. 把文件里的 JSON **原样**转成本次的返回结构 —— 不要重新拆解、不要增删改任何步骤、
   不要"顺手改进"标题或正文。你只是个搬运工。

如果文件不存在，返回 milestones 为空数组，并在 notes 里写明"文件不存在"。
`.trim(),
    { label: 'load-plan', phase: 'Decompose', schema: BREAKDOWN_SCHEMA },
  )

  if (!breakdown || !(breakdown.milestones || []).length) {
    log(`没有找到可用的 ${PLAN_FILE} —— 先跑一次不带 --create 的拆解。`)
    return { status: 'aborted', reason: `${PLAN_FILE} 不存在或为空；先运行 /plan-to-issues <输入源>` }
  }
}

const approved = !review || review.verdict === 'approved'

// ── Fold：把非阻断建议折进 issue 正文 ────────────────────────────────────────
// 修订轮会顺带折叠，但一轮就通过时不会 —— 那些建议就只留在输出里、进不了 issue。
// 而「闭环 A 漏了 last_purchased_on」这类静默失败恰恰是建议里最要命的：不写进
// 正文，实施者永远不会知道。所以通过之后单跑一次折叠。
if (shouldDecompose && approved) {
  phase('Fold')
  log(allSuggestions.length
    ? `把 ${allSuggestions.length} 条建议折进 issue 正文，并补充范围外边界…`
    : `补充范围外边界…`)
  const folded = await agent(`
把下面的审查建议折进这份已批准的工作分解里。**这是编辑，不是重写。**

已批准的拆解（JSON）：
\`\`\`json
${JSON.stringify({ milestones: breakdown.milestones, notes: breakdown.notes || '' }, null, 2)}
\`\`\`

审查者提出的建议（全部是非阻断的，但其中不乏「不写进正文实施者就会漏掉」的东西）：
${allSuggestions.length ? allSuggestions.map((x, i) => `${i + 1}. ${x}`).join('\n') : '（无）'}

规则：

1. **只改 body。** 每条建议折进它所针对的那个步骤的 body —— 通常是补进「验收标准」
   或「坑与约束」。放在最贴切的位置，不要在末尾堆一段「审查建议」。
2. **禁止改动 key、title、depends_on，禁止增删步骤、阶段或里程碑。**
   已批准的结构就是最终结构。
3. 建议若已经在正文里说过了，跳过，不要重复写一遍。
4. 若某条建议无法归属到任何单个步骤（是全局性的），写进 notes。
5. 语言与既有正文一致：简体中文，代码标识符 / 文件路径 / 字段名原样保留。
6. **返回完整的拆解**，未被建议触及的步骤连同 body 逐字原样保留。

7. **给每个步骤的 body 补一个「## 范围外」小节**（还没有的话）——这是退出条件，
   不是验收标准。验收标准回答「做没做对」，范围外回答「做到哪儿算完、别继续往下做」。
   一个 31 条互相挨得很近的 WBS 里，不写清楚退出条件，实施者很容易顺手把相邻步骤
   的活也干了。列 2-4 条，素材从这几处找：
     a. 明显会被牵连、但已经分给别的步骤的相邻功能（看 depends_on 图和同一 phase
        里的其他步骤——比如"编辑菜谱"旁边就是"导入菜谱"，两者用同一批表，很容易
        顺手把对方也做了）
     b. 规格里提到、但这份拆解已经指给了别的里程碑/阶段的东西
     c. 明显的"顺手多做一点"陷阱——改一个字段时把相邻字段也重构了、加一个接口时
        把相关接口也重写了
   格式与其余小节一致（\`## 范围外\` 三级标题 + 短句列表），跟在「坑与约束」后面。
   不要写"看情况再定"这类空话，每条都要能指向具体的步骤号或具体的功能名。

特别注意那些描述**静默失败**的建议（漏了某字段导致功能不报错但永远不生效）——
这类必须进对应步骤的验收标准，而不是只在「坑与约束」里提一句。

改完自检：原来每一个 key 是否都还在？步骤总数是否不变？
`.trim(),
    { label: 'folder', phase: 'Fold', schema: BREAKDOWN_SCHEMA, model: 'opus' },
  )

  const before = flatten(breakdown).map(it => it.key).join('|')
  const after  = folded ? flatten(folded).map(it => it.key).join('|') : ''
  if (folded && before === after) {
    breakdown = { ...folded, project_root: folded.project_root || breakdown.project_root }
    log('建议已折进正文，步骤结构未变')
  } else if (folded) {
    log('⚠ 折叠改动了步骤结构 —— 丢弃折叠结果，保留已批准的原版')
  } else {
    log('折叠 agent 返回 null —— 保留原版（非致命）')
  }
}

const items    = flatten(breakdown)
const projectRoot = breakdown.project_root || '.'

// ── 落盘：把批准的拆解存下来，让 --create 用的就是你看过的那份 ──────────────

let persisted = false
if (shouldDecompose && approved) {
  phase('Persist')
  const payload = JSON.stringify(
    { milestones: breakdown.milestones, notes: breakdown.notes || '', generated_from: source },
    null, 2,
  )
  const w = await agent(`
把下面 <<<JSON>>> 标记之间的内容（不含标记行）**逐字**写入 ${projectRoot}/${PLAN_FILE}。
不要重新格式化、不要修改任何字段、不要加注释。目录不存在就先创建。
写完运行 python3 -c "import json,sys; json.load(open('${projectRoot}/${PLAN_FILE}'))" 验证是合法 JSON。
成功返回 {written:true,path:...}，失败返回 {written:false,error:...}。这一步非致命。

<<<JSON>>>
${payload}
<<<JSON>>>`.trim(),
    { label: 'persist', phase: 'Persist', schema: WRITE_SCHEMA },
  )
  persisted = !!(w && w.written)
  log(persisted ? `拆解已存入 ${PLAN_FILE}` : `落盘失败（非致命）：${w ? (w.error || '未知') : 'agent 返回 null'}`)
}

// ── 建 issue：只在 --create 且拆解已批准时 ────────────────────────────────────

let created = []
let skipped = []
let boardNote = ''
let milestoneNote = ''

if (doCreate && approved) {
  phase('Create')
  log(`开始创建 ${items.length} 条 issue…`)

  // 按里程碑串行 —— issue 编号才跟依赖顺序一致，也避免并发建 issue 打架
  for (const m of breakdown.milestones) {
    const mItems = items.filter(it => it.m.key === m.key)
    if (!mItems.length) continue

    const specs = mItems.map(it => {
      const dep = (it.s.depends_on && it.s.depends_on.length)
        ? `\n\n**依赖：** ${it.s.depends_on.join('、')}`
        : ''
      const labels = (it.s.labels && it.s.labels.length) ? it.s.labels.join(',') : 'enhancement'
      return [
        `--- ISSUE ${it.key} ---`,
        `TITLE: ${it.title}`,
        `LABELS: ${labels}`,
        `BODY:`,
        it.s.body + dep,
        `\n> ${m.key}-${m.name}：${m.goal || ''}`,
      ].join('\n')
    }).join('\n\n')

    const milestoneTitle = `${m.key}-${m.name}`

    const res = await agent(`
在 GitHub 上创建下面列出的 issue。工作目录：${projectRoot}

**先做重复检测**（必须，否则重跑会建出一堆重复）：
  gh issue list --state all --limit 300 --json number,title
对每条待建 issue，取它 TITLE 里 " · " 之前的**键前缀**（形如 ${mItems[0].key}）。
如果已有 issue 的标题以这个前缀开头，就**跳过**这条，把键记进 skipped，不要重建、不要改它。

**确保这个里程碑有对应的 GitHub Milestone**（先于建 issue 做，一次即可）：
  gh api repos/{owner}/{repo}/milestones --paginate --jq '.[] | select(.title=="${milestoneTitle}") | .number'
用 \`gh repo view --json owner,name -q '.owner.login+"/"+.name'\` 拿 owner/repo 填进上面的路径。
  - 查到了：milestone_created = false，记下这个 milestone 已存在。
  - 没查到：创建一个 —— gh api repos/{owner}/{repo}/milestones -f title="${milestoneTitle}" -f state=open -f description="${(m.goal || '').replace(/"/g, '\\"')}"
    milestone_created = true。
  - 这一步失败（例如权限不足）**不算致命**：跳过 milestone 相关操作，在 milestone_note 里写明原因，
    照常继续建 issue——issue 本体不能因为 milestone 建不了而不建。
GitHub Milestone 是原生字段，用来在 issue 列表里按 \`milestone:"${milestoneTitle}"\` 筛选、
看自带的完成进度条，和标题里 P/S 那层细粒度是两回事，不要因为标题已经写了 "${milestoneTitle}"
就觉得这步可以省。

**逐条创建**（按下面给出的顺序，一条一条来，不要并发）：
  1. 把 BODY 原样写进临时文件（逐字，不要改写、不要润色、不要加内容）
  2. gh issue create --title "<TITLE>" --body-file <临时文件> --label "<LABELS>" --milestone "${milestoneTitle}"
     如果某个 label 不存在导致失败，去掉 --label 重试一次，并在 board_note 里记一句。
     如果 --milestone 因为上一步没能成功创建 milestone 而失败，去掉 --milestone 重试一次
     （milestone_note 里已经说明了原因），不要因此不建 issue。
  3. 记下返回的 issue 编号和 URL

**挂上项目看板**（尽力而为，失败不算致命）：
先找这个仓库关联的 Projects v2 看板：
  gh api graphql -f query='
    query($owner:String!,$repo:String!){
      repository(owner:$owner,name:$repo){
        projectsV2(first:10){ nodes{ id title number } }
      }
    }' -f owner="$(gh repo view --json owner -q .owner.login)" -f repo="$(gh repo view --json name -q .name)"
${projectName ? `使用标题为 "${projectName}" 的那个看板。` : `如果只有一个看板就用它；如果有多个又无法判断，跳过挂板，在 board_note 里说明。`}
对每条新建的 issue：
  a. 取 issue 的 node id：gh issue view <编号> --json id -q .id
  b. gh api graphql -f query='
       mutation($project:ID!,$content:ID!){
         addProjectV2ItemById(input:{projectId:$project,contentId:$content}){ item{ id } }
       }' -f project="<看板 id>" -f content="<issue node id>"
  c. 查该看板 Status 字段和 "Backlog" 选项的 id：
     gh api graphql -f query='
       query($project:ID!){ node(id:$project){ ... on ProjectV2{
         field(name:"Status"){ ... on ProjectV2SingleSelectField{ id options{ id name } } } } } }' -f project="<看板 id>"
  d. 用 updateProjectV2ItemFieldValue 把状态设为 Backlog。
如果 gh token 缺 project scope（提示 remedy: gh auth refresh -s project），跳过挂板并在
board_note 里写明 —— **不要因此不建 issue**。

board_added 填成功挂板的条数。

待创建的 issue（${mItems.length} 条）：

${specs}
`.trim(),
      { label: `create:${m.key}`, phase: 'Create', schema: CREATE_SCHEMA },
    )

    if (res) {
      created = created.concat(res.created || [])
      skipped = skipped.concat(res.skipped || [])
      if (res.board_note) boardNote += (boardNote ? ' | ' : '') + res.board_note
      if (res.milestone_note) milestoneNote += (milestoneNote ? ' | ' : '') + res.milestone_note
      const msLabel = res.milestone_created === true ? '新建' : res.milestone_created === false ? '复用' : '未处理'
      log(`${m.key}-${m.name}：新建 ${(res.created || []).length} 条，跳过 ${(res.skipped || []).length} 条`
          + ` · Milestone ${msLabel}`)
    } else {
      log(`${m.key}-${m.name}：创建 agent 返回 null —— 跳过该里程碑`)
    }
  }
} else if (doCreate && !approved) {
  log('拆解未通过审查 —— 拒绝创建 issue。先修掉阻断性问题。')
}

// ── 输出 ─────────────────────────────────────────────────────────────────────

const verdictLine = approved ? '✅ 拆解已批准' : '⚠️  拆解需要修订（已达最大轮数）'
const issueLines = review && review.issues.length
  ? review.issues.map(i => `  ✗ ${i}`).join('\n') : '  （无）'
const suggSource = allSuggestions.length ? allSuggestions : ((review && review.suggestions) || [])
const suggLines = suggSource.length
  ? suggSource.map(s => `  → ${s}`).join('\n') : '  （无）'

const createdLines = created.length
  ? created.map(c => `  #${c.number}  ${c.title || c.full_key}`).join('\n')
  : '  （无）'

const tail = doCreate
  ? `
## 创建结果

新建 ${created.length} 条${skipped.length ? `，跳过 ${skipped.length} 条（已存在）` : ''}
${createdLines}
${skipped.length ? `\n已存在而跳过：\n${skipped.map(k => `  · ${k}`).join('\n')}` : ''}
${boardNote ? `\n看板：${boardNote}` : ''}
${milestoneNote ? `\nMilestone：${milestoneNote}` : ''}
`.trim()
  : `
## 尚未创建任何 issue

这是 dry run。清单没问题的话，跑：

    /plan-to-issues --create

它会读 ${PLAN_FILE}（就是上面这份），不会重新拆解。
想重拆再建：/plan-to-issues ${source || '<输入源>'} --create
`.trim()

const display = `
## 工作分解：${source || `（读自 ${PLAN_FILE}）`}

共 ${breakdown.milestones.length} 个里程碑 · ${items.length} 条 issue
${renderBreakdown(breakdown)}

### 拆解说明
${breakdown.notes || '（无）'}

---

## ${verdictLine}

${review ? review.summary : '（未审查）'}

### 阻断性问题
${issueLines}

### 建议
${suggLines}

---

${tail}
`.trim()

return {
  status: !approved ? 'breakdown_needs_revision'
        : doCreate  ? 'issues_created'
        :             'breakdown_ready',
  source,
  breakdown,
  review,
  persisted,
  created,
  skipped,
  display,
}
