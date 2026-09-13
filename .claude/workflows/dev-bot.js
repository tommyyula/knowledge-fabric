export const meta = {
  name: 'dev-bot',
  description: 'dev-plan 出计划并自动过审后直接接 dev-pipeline 实现 — 跳过人工看计划这一步',
  phases: [
    { title: 'Plan',  detail: '调用 dev-plan：起草计划 → 复审 → Backlog → Ready' },
    { title: 'Build', detail: '计划已批准时，带着计划调用 dev-pipeline：实现 → 测试 → 校验 → 合并' },
  ],
}

// 单纯的编排：不重复 dev-plan / dev-pipeline 内部逻辑，只是省掉中间人工看计划再手动
// 敲第二条命令的步骤。dev-pipeline 必须收到 {task, issue, plan} 对象才会用上计划——
// 传裸的 issue 号会静默丢掉 plan（IMPL_SCHEMA 那段判断的是 args.plan 是否存在）。

phase('Plan')
log('调用 dev-plan...')

const planResult = await workflow('dev-plan', args)

if (!planResult) {
  return { status: 'aborted', reason: 'dev-plan 返回了 null' }
}

if (planResult.status !== 'plan_ready') {
  // 计划没有被复审通过（达到最大修订轮数仍有阻断性问题）——不带着一个已知有缺口的
  // 计划去实现，停在这里把原因交回去，好过 dev-pipeline 照着有问题的计划把代码写歪。
  log(`计划未通过复审（status: ${planResult.status}）— 不进入 dev-pipeline。`)
  return { status: 'stopped_at_plan', plan_result: planResult }
}

log('计划已批准 — 直接进入 dev-pipeline，不停下来等人看计划。')
phase('Build')

const pipelineArgs = {
  task: planResult.task,
  plan: planResult.plan,
  ...(planResult.issue_number ? { issue: planResult.issue_number } : {}),
}

const pipelineResult = await workflow('dev-pipeline', pipelineArgs)

return {
  status: 'done',
  plan_result: planResult,
  pipeline_result: pipelineResult,
}
