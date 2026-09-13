## 改了什么

- `src/contracts/ontology.ts`：扩展 `OntologyStreamEvent`，让 SDK 上游重试成为后端可传递的协议事件。
- `server/chat/claude-runner.ts`：设置可覆盖的 CLI 重试/超时预算，记录并转发 `api_retry` 的 attempt、上限、退避时间和状态码。
- `server/chat/ai-sdk-ui-stream.ts`：把 retry 事件投影为 transient `data-retry` chunk，且不关闭正在进行的 text block。
- `server/chat/workflow-status-messages.ts`：新增 zh/en/ja 三语失败轮次提示，明确可重发重试并附原始详情。
- `server/chat/routes.ts`：在终结 SSE 前 best-effort 持久化失败 agent 回复和前进后的 Claude session id，补失败耗时日志，并兜底 batcher 写入/收尾失败。
- `src/components/OntologyStewardChatPanel.tsx`：消费 retry data part 显示 info toast，并通过 `onError` 显示错误、解锁恢复状态及刷新消息/运行状态。
- `src/i18n.ts`：补齐重试与失败 toast 的 zh/en/ja 文案及插值。
- `scripts/chat-upstream-failure.test.mts`：新增 retry 投影、text block 连续性、error 投影和三语失败文案回归测试。
- `package.json`：新增 `test:chat-failure`，并挂入 `test` 串联链。
- `docs/chat/upstream-failure-visibility-result.md`：记录本次改动、A1-A9 原始验收输出、偏离和遗留。

## 怎么验的

先按要求安装依赖：

```console
$ pnpm install --prefer-offline
Lockfile is up to date, resolution step is skipped
Already up to date

╭ Warning ─────────────────────────────────────────────────────────────────────╮
│                                                                              │
│   Ignored build scripts: esbuild@0.25.12, esbuild@0.28.1.                    │
│   Run "pnpm approve-builds" to pick which dependencies should be allowed     │
│   to run scripts.                                                            │
│                                                                              │
╰──────────────────────────────────────────────────────────────────────────────╯
Done in 404ms using pnpm v10.32.1
EXIT_CODE=0
```

- A1：运行指定的全量 TypeScript 命令；原始输出如下。

```console
$ npx tsc --noEmit -p tsconfig.json
src/components/ChatPanel.tsx(6,1): error TS6133: 'Attachment' is declared but its value is never read.
src/components/ChatPanel.tsx(7,10): error TS6133: 'OntologyThread' is declared but its value is never read.
src/components/ChatPanel.tsx(8,1): error TS6133: 'TooltipIconButton' is declared but its value is never read.
src/components/ChatPanel.tsx(27,6): error TS6196: 'AttachedFile' is declared but never used.
src/components/ChatPanel.tsx(92,46): error TS6133: 'projects' is declared but its value is never read.
src/components/ChatPanel.tsx(92,107): error TS6133: 'onNewOntology' is declared but its value is never read.
src/components/ChatPanel.tsx(102,10): error TS6133: 'enteredFromHub' is declared but its value is never read.
src/components/ChatPanel.tsx(141,11): error TS6133: 'handler' is declared but its value is never read.
src/components/ChatPanel.tsx(148,52): error TS2304: Cannot find name 'onReference'.
src/components/ChatPanel.tsx(149,68): error TS2304: Cannot find name 'onReference'.
src/components/ChatPanel.tsx(191,9): error TS6133: 'handleFilesSelected' is declared but its value is never read.
src/components/ChatPanel.tsx(195,24): error TS2345: Argument of type '(prev: string[]) => (string | { id: string; name: string; status: "ready"; })[]' is not assignable to parameter of type 'SetStateAction<string[]>'.
  Type '(prev: string[]) => (string | { id: string; name: string; status: "ready"; })[]' is not assignable to type '(prevState: string[]) => string[]'.
    Type '(string | { id: string; name: string; status: "ready"; })[]' is not assignable to type 'string[]'.
      Type 'string | { id: string; name: string; status: "ready"; }' is not assignable to type 'string'.
        Type '{ id: string; name: string; status: "ready"; }' is not assignable to type 'string'.
src/components/ChatPanel.tsx(201,24): error TS2345: Argument of type '(prev: string[]) => (string | { id: string; name: string; status: string; })[]' is not assignable to parameter of type 'SetStateAction<string[]>'.
  Type '(prev: string[]) => (string | { id: string; name: string; status: string; })[]' is not assignable to type '(prevState: string[]) => string[]'.
    Type '(string | { id: string; name: string; status: string; })[]' is not assignable to type 'string[]'.
      Type 'string | { id: string; name: string; status: string; }' is not assignable to type 'string'.
        Type '{ id: string; name: string; status: string; }' is not assignable to type 'string'.
src/components/ChatPanel.tsx(205,60): error TS2339: Property 'id' does not exist on type 'string'.
src/components/ChatPanel.tsx(205,74): error TS2698: Spread types may only be created from object types.
src/components/ChatPanel.tsx(208,60): error TS2339: Property 'id' does not exist on type 'string'.
src/components/ChatPanel.tsx(208,74): error TS2698: Spread types may only be created from object types.
src/components/ChatPanel.tsx(246,22): error TS2304: Cannot find name 'projectSessions'.
src/components/ChatPanel.tsx(249,7): error TS2304: Cannot find name 'onNewSession'.
src/components/ChatPanel.tsx(258,48): error TS1308: 'await' expressions are only allowed within async functions and at the top levels of modules.
src/components/ChatPanel.tsx(278,9): error TS1308: 'await' expressions are only allowed within async functions and at the top levels of modules.
src/components/ChatPanel.tsx(281,20): error TS2304: Cannot find name 'backendPrompt'.
src/components/ChatPanel.tsx(308,9): error TS1308: 'await' expressions are only allowed within async functions and at the top levels of modules.
src/components/ChatPanel.tsx(341,11): error TS2304: Cannot find name 'onAutoTitle'.
src/components/ChatPanel.tsx(358,12): error TS2304: Cannot find name 'showBackBtn'.
src/components/ChatPanel.tsx(359,56): error TS2304: Cannot find name 'onBackToHub'.
src/components/ChatPanel.tsx(366,53): error TS2304: Cannot find name 'buildingName'.
src/components/ChatPanel.tsx(366,69): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(379,20): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(384,20): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(393,10): error TS2304: Cannot find name 'showHub'.
src/components/ChatPanel.tsx(395,47): error TS2304: Cannot find name 'hubSearchOpen'.
src/components/ChatPanel.tsx(396,16): error TS2304: Cannot find name 'hubSearchOpen'.
src/components/ChatPanel.tsx(402,30): error TS2304: Cannot find name 'hubSearch'.
src/components/ChatPanel.tsx(403,40): error TS2304: Cannot find name 'setHubSearch'.
src/components/ChatPanel.tsx(404,36): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(408,103): error TS2304: Cannot find name 'setHubSearchOpen'.
src/components/ChatPanel.tsx(408,128): error TS2304: Cannot find name 'setHubSearch'.
src/components/ChatPanel.tsx(408,164): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(412,24): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(415,36): error TS2304: Cannot find name 'setHubSearchOpen'.
src/components/ChatPanel.tsx(424,16): error TS2304: Cannot find name 'filteredSessions'.
src/components/ChatPanel.tsx(426,23): error TS2304: Cannot find name 'projectSessions'.
src/components/ChatPanel.tsx(430,20): error TS2304: Cannot find name 'filteredSessions'.
src/components/ChatPanel.tsx(430,42): error TS7006: Parameter 's' implicitly has an 'any' type.
src/components/ChatPanel.tsx(434,65): error TS2304: Cannot find name 'onSelectSession'.
src/components/ChatPanel.tsx(484,28): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(484,89): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(485,27): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(485,67): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(488,62): error TS2304: Cannot find name 'startJourney'.
src/components/ChatPanel.tsx(489,20): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(493,70): error TS2304: Cannot find name 'setPickerAction'.
src/components/ChatPanel.tsx(493,94): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(494,20): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(498,70): error TS2304: Cannot find name 'setPickerAction'.
src/components/ChatPanel.tsx(498,97): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(499,20): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(505,22): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(508,22): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(520,22): error TS2339: Property 'attachments' does not exist on type 'OntologyThreadMessage'.
src/components/ChatPanel.tsx(520,41): error TS2339: Property 'attachments' does not exist on type 'OntologyThreadMessage'.
src/components/ChatPanel.tsx(522,26): error TS2339: Property 'attachments' does not exist on type 'OntologyThreadMessage'.
src/components/ChatPanel.tsx(522,43): error TS7006: Parameter 'f' implicitly has an 'any' type.
src/components/ChatPanel.tsx(522,46): error TS7006: Parameter 'j' implicitly has an 'any' type.
src/components/ChatPanel.tsx(534,22): error TS2339: Property 'steps' does not exist on type 'OntologyThreadMessage'.
src/components/ChatPanel.tsx(534,35): error TS2339: Property 'steps' does not exist on type 'OntologyThreadMessage'.
src/components/ChatPanel.tsx(538,34): error TS2339: Property 'steps' does not exist on type 'OntologyThreadMessage'.
src/components/ChatPanel.tsx(543,30): error TS2339: Property 'steps' does not exist on type 'OntologyThreadMessage'.
src/components/ChatPanel.tsx(543,41): error TS7006: Parameter 'step' implicitly has an 'any' type.
src/components/ChatPanel.tsx(543,47): error TS7006: Parameter 'j' implicitly has an 'any' type.
src/components/ChatPanel.tsx(553,18): error TS2304: Cannot find name 'Markdown'.
src/components/ChatPanel.tsx(553,43): error TS2304: Cannot find name 'remarkGfm'.
src/components/ChatPanel.tsx(553,70): error TS2304: Cannot find name 'Markdown'.
src/components/ChatPanel.tsx(570,8): error TS2304: Cannot find name 'showHub'.
src/components/ChatPanel.tsx(573,14): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(576,14): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(595,34): error TS2304: Cannot find name 'getFileIcon'.
src/components/ChatPanel.tsx(595,49): error TS2304: Cannot find name 'folders'.
src/components/ChatPanel.tsx(611,36): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(611,71): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(617,104): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(620,35): error TS2304: Cannot find name 'showOntologyPicker'.
src/components/ChatPanel.tsx(621,96): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(621,126): error TS2304: Cannot find name 'setPickerAction'.
src/components/ChatPanel.tsx(625,130): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(627,30): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(629,128): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(631,30): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(634,75): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(634,98): error TS2304: Cannot find name 'showOntologyPicker'.
src/components/ChatPanel.tsx(636,30): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(641,18): error TS2304: Cannot find name 'showOntologyPicker'.
src/components/ChatPanel.tsx(643,22): error TS2304: Cannot find name 'mockProjects'.
src/components/ChatPanel.tsx(643,40): error TS7006: Parameter 'p' implicitly has an 'any' type.
src/components/ChatPanel.tsx(648,31): error TS2304: Cannot find name 'pickerAction'.
src/components/ChatPanel.tsx(651,43): error TS2304: Cannot find name 'pickerAction'.
src/components/ChatPanel.tsx(654,29): error TS2304: Cannot find name 'setPickerAction'.
src/components/ChatPanel.tsx(659,27): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(668,75): error TS2304: Cannot find name 'onNewOntologyDirect'.
src/components/ChatPanel.tsx(668,122): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(670,30): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(705,115): error TS2304: Cannot find name 'onOpenConnectors'.
src/components/ChatPanel.tsx(705,133): error TS2304: Cannot find name 'onOpenConnectors'.
src/components/ChatPanel.tsx(707,32): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(714,69): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(714,92): error TS2304: Cannot find name 'showOntologyPicker'.
src/components/ChatPanel.tsx(719,69): error TS2304: Cannot find name 'setShowOntologyPicker'.
src/components/ChatPanel.tsx(719,92): error TS2304: Cannot find name 'showOntologyPicker'.
src/components/ChatPanel.tsx(721,61): error TS2304: Cannot find name 'buildingName'.
src/components/ChatPanel.tsx(721,77): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(736,23): error TS2304: Cannot find name 'onAddResource'.
src/components/ChatPanel.tsx(740,38): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(741,37): error TS2304: Cannot find name 't'.
src/components/ChatPanel.tsx(770,10): error TS2304: Cannot find name 'ResourcePicker'.
src/components/ChatPanel.tsx(771,22): error TS2304: Cannot find name 'resources'.
src/components/ChatPanel.tsx(772,20): error TS2304: Cannot find name 'folders'.
src/components/ChatPanel.tsx(773,23): error TS7006: Parameter 'selected' implicitly has an 'any' type.
src/components/ChatPanel.tsx(775,31): error TS7006: Parameter 'r' implicitly has an 'any' type.
src/components/ChatPanel.tsx(781,30): error TS2304: Cannot find name 'folders'.
src/components/ChatPanel.tsx(781,44): error TS7006: Parameter 'f' implicitly has an 'any' type.
src/components/ChatPanel.tsx(782,35): error TS2304: Cannot find name 'resources'.
src/components/ChatPanel.tsx(782,53): error TS7006: Parameter 'r' implicitly has an 'any' type.
src/components/ChatPanel.tsx(783,54): error TS7006: Parameter 'r' implicitly has an 'any' type.
src/components/ChatPanel.tsx(783,75): error TS7006: Parameter 's' implicitly has an 'any' type.
src/components/ChatPanel.tsx(787,34): error TS7006: Parameter 'r' implicitly has an 'any' type.
src/components/ChatPanel.tsx(787,72): error TS7006: Parameter 'r' implicitly has an 'any' type.
src/components/ChatPanel.tsx(790,30): error TS7006: Parameter 'r' implicitly has an 'any' type.
src/components/ChatPanel.tsx(790,56): error TS7006: Parameter 'r' implicitly has an 'any' type.
src/components/ChatPanel.tsx(795,22): error TS7006: Parameter 'resource' implicitly has an 'any' type.
src/components/ChatPanel.tsx(796,13): error TS2304: Cannot find name 'onAddResource'.
src/components/ChatPanel.tsx(799,14): error TS2304: Cannot find name 't'.
src/components/RepositoryPreviewModal.tsx(149,41): error TS2550: Property 'at' does not exist on type 'string[]'. Do you need to change your target library? Try changing the 'lib' compiler option to 'es2022' or later.
src/mocks/data.ts(277,5): error TS2353: Object literal may only specify known properties, and 'steps' does not exist in type 'OntologyMessage'.
src/mocks/data.ts(327,5): error TS2353: Object literal may only specify known properties, and 'steps' does not exist in type 'OntologyMessage'.
src/mocks/data.ts(466,5): error TS2353: Object literal may only specify known properties, and 'steps' does not exist in type 'OntologyMessage'.
src/mocks/data.ts(644,5): error TS2353: Object literal may only specify known properties, and 'steps' does not exist in type 'OntologyMessage'.
EXIT_CODE=2
```

再对输出按文件名核对是否命中本任务改动文件，原始输出如下：

```console
$ changed='package.json|server/chat/ai-sdk-ui-stream.ts|server/chat/claude-runner.ts|server/chat/routes.ts|server/chat/workflow-status-messages.ts|src/components/OntologyStewardChatPanel.tsx|src/contracts/ontology.ts|src/i18n.ts|scripts/chat-upstream-failure.test.mts'
$ echo "TSC_EXIT_CODE=$(tail -1 /tmp/kf-chat-failure-tsc-final.log | sed 's/EXIT_CODE=//')"
$ error_files=$(sed -n 's/^\([^(:]*\)([0-9].*/\1/p' /tmp/kf-chat-failure-tsc-final.log | sort -u | paste -sd, -)
$ echo "TSC_ERROR_FILES=$error_files"
$ if rg -n "^($changed)\(" /tmp/kf-chat-failure-tsc-final.log; then echo CHANGED_FILE_TSC_ERRORS=present; else echo CHANGED_FILE_TSC_ERRORS=0; fi
TSC_EXIT_CODE=2
TSC_ERROR_FILES=src/components/ChatPanel.tsx,src/components/RepositoryPreviewModal.tsx,src/mocks/data.ts
CHANGED_FILE_TSC_ERRORS=0
```

A1 结论：本任务改动文件零错误；全量命令退出码 2 来自未改动的三个既有文件，未按规则修它们。

- A2：对全部改动文件运行 ESLint，退出码 0；JSON、MTS、Markdown 没有匹配仓库现有 ESLint 配置，因此 ESLint 原样给出 ignored warning。

```console
$ npx eslint package.json server/chat/ai-sdk-ui-stream.ts server/chat/claude-runner.ts server/chat/routes.ts server/chat/workflow-status-messages.ts src/components/OntologyStewardChatPanel.tsx src/contracts/ontology.ts src/i18n.ts scripts/chat-upstream-failure.test.mts docs/chat/upstream-failure-visibility-result.md

/Users/chy/workspace/item/dmd/knowledge-fabric/.worktrees/feature-delegate-chat-upstream-failure-t1/docs/chat/upstream-failure-visibility-result.md
  0:0  warning  File ignored because no matching configuration was supplied

/Users/chy/workspace/item/dmd/knowledge-fabric/.worktrees/feature-delegate-chat-upstream-failure-t1/package.json
  0:0  warning  File ignored because no matching configuration was supplied

/Users/chy/workspace/item/dmd/knowledge-fabric/.worktrees/feature-delegate-chat-upstream-failure-t1/scripts/chat-upstream-failure.test.mts
  0:0  warning  File ignored because no matching configuration was supplied

✖ 3 problems (0 errors, 3 warnings)

EXIT_CODE=0
```

- A3：`test:azure-pool` 原始输出（28/28 pass）：

```console
$ pnpm test:azure-pool

> wiki-app@1.0.0 test:azure-pool /Users/chy/workspace/item/dmd/knowledge-fabric/.worktrees/feature-delegate-chat-upstream-failure-t1
> node --import tsx --test scripts/azure-openai-upstream-pool.test.mts

✔ legacy Azure credentials expose one chat-completion upstream (3.671291ms)
✔ an unconfigured Azure pool stays disabled with a safe caller error (0.295959ms)
✔ non-streaming Agent completions use the initialized Azure pool (0.955583ms)
✔ configured Azure upstreams follow equal and weighted capacity at low concurrency (2.113917ms)
✔ configured Azure upstreams prefer lower normalized in-flight load (0.488166ms)
✔ explicit Azure pool configuration is validated without echoing secrets (0.222916ms)
✔ a rate-limited non-streaming attempt fails over to a different upstream (0.436208ms)
✔ a stream that ends before visible content fails over without leaking buffered events (0.354125ms)
✔ a stream failure after visible content is surfaced without failover (0.316666ms)
✔ a stream ending after visible content without a terminal event fails safely (0.176833ms)
✔ content-filter termination without content is not replayed (0.148875ms)
✔ malformed non-streaming data fails over but a valid empty completion does not (0.249792ms)
✔ a caller request error is returned safely without failover (0.11725ms)
✔ all rate-limited upstreams cool down before one real request probes recovery (0.330125ms)
✔ fail-fast retry timing uses the earliest cooling upstream, including the attempted one (0.245625ms)
✔ only one request probes a half-open upstream while healthy traffic continues (0.458959ms)
✔ retry-after-ms wins over Retry-After and missing hints use jittered backoff (0.453625ms)
✔ upstream credential failures use the longer configuration cooldown (0.231125ms)
✔ a connection timeout fails over without extending the caller indefinitely (11.279625ms)
✔ a first-content timeout fails over before committing the downstream stream (11.6355ms)
✔ an idle timeout after commitment errors the stream without failover (10.427125ms)
✔ caller cancellation aborts the active stream without cooling the upstream (0.529875ms)
✔ the Anthropic proxy routes sequential requests by configured weight (45.967209ms)
[azure-pool] attempt failed {
  requestId: 'bbf0f3d1-656d-4e7d-856a-bbea74e4a779',
  upstreamId: 'azure-a',
  attempt: 1,
  model: 'gpt-test',
  status: undefined,
  latencyMs: 0,
  failoverReason: 'stream_after_commit',
  circuitState: 'cooling',
  cooldownMs: 5296
}
[proxy] stream translation failed {
  provider: 'azure',
  model: 'gpt-test',
  error: 'Azure OpenAI stream failed after response commitment'
}
✔ the Anthropic proxy emits one safe error for a committed Azure stream failure (6.764125ms)
[azure-pool] attempt failed {
  requestId: 'd79ba676-f6ea-4479-b64d-3bea36627c6d',
  upstreamId: 'azure-a',
  attempt: 1,
  model: 'gpt-test',
  status: undefined,
  latencyMs: 0,
  failoverReason: 'stream_before_commit',
  circuitState: 'cooling',
  cooldownMs: 5000
}
✔ the Anthropic proxy emits only the recovered Azure stream (2.660958ms)
[azure-pool] attempt failed {
  requestId: 'a7b269a2-09f1-4dc3-9f42-b6d241722939',
  upstreamId: 'azure-a',
  attempt: 1,
  model: 'gpt-test',
  status: 429,
  latencyMs: 0,
  failoverReason: 'http_429',
  circuitState: 'cooling',
  cooldownMs: 2500
}
[azure-pool] attempt failed {
  requestId: 'a7b269a2-09f1-4dc3-9f42-b6d241722939',
  upstreamId: 'azure-b',
  attempt: 2,
  model: 'gpt-test',
  status: 429,
  latencyMs: 0,
  failoverReason: 'http_429',
  circuitState: 'cooling',
  cooldownMs: 2500
}
[azure-pool] all attempts exhausted {
  requestId: 'a7b269a2-09f1-4dc3-9f42-b6d241722939',
  model: 'gpt-test',
  status: 429,
  retryAfterMs: 2500
}
✔ the Anthropic proxy returns a safe retry window when every Azure upstream is limited (4.396708ms)
✔ failure diagnostics are structured and exclude credentials and completion content (0.310167ms)
[direct-completion] request failed: Azure OpenAI request was cancelled
✔ non-streaming failover stays inside the caller's total timeout budget (20.871042ms)
ℹ tests 28
ℹ suites 0
ℹ pass 28
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 350.617667
EXIT_CODE=0
```

`test:support-reports` 原始输出（5/5 pass）：

```console
$ pnpm test:support-reports

> wiki-app@1.0.0 test:support-reports /Users/chy/workspace/item/dmd/knowledge-fabric/.worktrees/feature-delegate-chat-upstream-failure-t1
> node --import tsx --test scripts/technical-issue-reports.test.mts

✔ user can email a scoped Technical Issue Report with the latest conversation attached (294.302667ms)
✔ Run event details are constrained to the captured status cutoff (0.681917ms)
✔ email transport distinguishes unsent connection failures from ambiguous failures (0.490959ms)
✔ report builder labels missing, active, and completed Run state (0.547166ms)
✔ frontend submission resolves only after a sent response (663.331417ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1056.741791
EXIT_CODE=0
```

- A4：新增测试原始输出（3/3 pass）：

```console
$ pnpm test:chat-failure

> wiki-app@1.0.0 test:chat-failure /Users/chy/workspace/item/dmd/knowledge-fabric/.worktrees/feature-delegate-chat-upstream-failure-t1
> node --import tsx --test scripts/chat-upstream-failure.test.mts

✔ retry events project to transient data-retry chunks (1.036542ms)
✔ retry events preserve an open text block and errors remain error chunks (0.148208ms)
✔ failed-turn messages are localized and preserve the error detail (0.115875ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 106.7315
EXIT_CODE=0
```

- A5-A8：在当前最终代码上运行真实 server + mock Azure 三轮复现，并从完整日志提取验收证据。

```console
$ set -o pipefail
$ KF_ROOT=$(pwd) node "$HOME/.local/share/dlgx/fanout/kf-repro.mjs" 2>&1 | tee /tmp/kf-repro-final.log
$ cmd_exit=$?
$ echo "REPRO_EXIT_CODE=$cmd_exit" | tee -a /tmp/kf-repro-final.log
```

证据提取的原始输出：

```console
===== TURN 1 (upstream OK — baseline) =====
[srv] [chat/timing] turn-complete runId=35ac2720-52e5-42cc-b8a3-0b701e008579 total_ms=2925 text_chars=40
HTTP 200 | stream chunk types: ["start","data-run-event","data-journey-state","data-run-event","text-start","data-run-event","data-journey-state","data-run-event","data-tree-updated","data-run-event","text-end","data-claude-session","finish","data-run-event","[DONE]"]
chat/status: {"runId":"35ac2720-52e5-42cc-b8a3-0b701e008579","active":false,"completed":true,"eventCount":6,"lastSequence":6,"updatedAt":"2026-08-13T09:50:12.414Z","local":false}
messages: [
 "user:Reply with the single word: hello. Do not use any tools.",
 "agent:Mock reply: seeded workspace looks fine."
]
===== TURN 2 (upstream 500 -> pool 502) =====
[srv] [chat] upstream api retry {
  runId: 'afc680ee-ebd9-48cf-81a1-01a7c7498ee3',
  attempt: 1,
  maxRetries: 3,
  delayMs: 592.9482921451386,
  status: 502
}
[srv] [chat] upstream api retry {
  runId: 'afc680ee-ebd9-48cf-81a1-01a7c7498ee3',
  attempt: 2,
  maxRetries: 3,
  delayMs: 1201.7236170731544,
  status: 429
}
[srv] [chat] upstream api retry {
  runId: 'afc680ee-ebd9-48cf-81a1-01a7c7498ee3',
  attempt: 3,
  maxRetries: 3,
  delayMs: 2423.3919542528647,
  status: 502
}
[srv] [chat] agent run failed {
  runId: 'afc680ee-ebd9-48cf-81a1-01a7c7498ee3',
  error: 'Claude Agent SDK execution failed: Claude Code returned an error result: API Error: 502 Azure OpenAI request failed. This is a server-side issue, usually temporary — try again in a moment. If it persists, check your inference gateway (127.0.0.1:19124).',
  elapsedMs: 6296
}
HTTP 200 | stream chunk types: ["start","data-run-event","data-journey-state","data-run-event","data-retry","data-run-event","data-retry","data-run-event","data-retry","data-run-event","text-start","data-run-event","error(Claude Agent SDK execution failed: Claude Code returned an error result: API Error: 502 Az)","[DONE]"]
chat/status: {"runId":"afc680ee-ebd9-48cf-81a1-01a7c7498ee3","active":false,"completed":true,"eventCount":7,"lastSequence":7,"updatedAt":"2026-08-13T09:50:18.724Z","local":false}
messages: [
 "user:Reply with the single word: hello. Do not use any tools.",
 "agent:Mock reply: seeded workspace looks fine.",
 "user:Reply with the single word: world. Do not use any tools.",
 "agent:API Error: 502 Azure OpenAI request failed. This is a server"
]
===== TURN 3 (upstream OK again — CAN WE CONTINUE?) =====
[srv] [chat] upstream api retry {
  runId: '31edca39-3261-4bf2-8155-88ec03c0d052',
  attempt: 1,
  maxRetries: 3,
  delayMs: 1000,
  status: 429
}
[srv] [chat/timing] turn-complete runId=31edca39-3261-4bf2-8155-88ec03c0d052 total_ms=2576 text_chars=40
HTTP 200 | stream chunk types: ["start","data-run-event","data-journey-state","data-run-event","data-retry","data-run-event","text-start","data-run-event","data-journey-state","data-run-event","data-tree-updated","data-run-event","text-end","data-claude-session","finish","data-run-event","[DONE]"]
chat/status: {"runId":"31edca39-3261-4bf2-8155-88ec03c0d052","active":false,"completed":true,"eventCount":7,"lastSequence":7,"updatedAt":"2026-08-13T09:50:21.304Z","local":false}
messages: [
 "user:Reply with the single word: hello. Do not use any tools.",
 "agent:Mock reply: seeded workspace looks fine.",
 "user:Reply with the single word: world. Do not use any tools.",
 "agent:API Error: 502 Azure OpenAI request failed. This is a server",
 "user:Reply with the single word: again. Do not use any tools.",
 "agent:Mock reply: seeded workspace looks fine."
]
REPRO_EXIT_CODE=0
```

A5：失败轮 `elapsedMs: 6296`，小于 30 秒。A6：同一失败轮有三次 `[chat] upstream api retry`、每次 `maxRetries: 3`，SSE 有三个 `data-retry`。A7：失败 user 后紧跟 `agent:API Error: 502...`，不再是孤儿。A8：第三轮 `turn-complete total_ms=2576`、HTTP 200、历史新增成功 agent 回复。复现最终 `REPRO_EXIT_CODE=0`。

- A9：原样运行既有 auth 测试，精确保持 5 pass / 1 fail，失败仍是 `auth-token-exchange.test.mts:191` 的 `undefined !== 'PUT'`；未修改该测试。

```console
$ pnpm test:auth

> wiki-app@1.0.0 test:auth /Users/chy/workspace/item/dmd/knowledge-fabric/.worktrees/feature-delegate-chat-upstream-failure-t1
> node --import tsx --test scripts/auth-token-exchange.test.mts

✔ password grant preserves the IAM incorrect-password message (2.349666ms)
✔ token exchange preserves the IAM application-access error (0.293167ms)
✔ password grant does not expose other IAM errors (0.265792ms)
✔ password grant uses a generic fallback when IAM returns no message (0.217208ms)
✔ refresh grant exchanges a refresh token (0.507625ms)
✖ tenant switch proxies the authenticated IAM user and target tenant (141.330292ms)
ℹ tests 6
ℹ suites 0
ℹ pass 5
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 231.437916

✖ failing tests:

test at scripts/auth-token-exchange.test.mts:1:3115
✖ tenant switch proxies the authenticated IAM user and target tenant (141.330292ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
  
  undefined !== 'PUT'
  
      at TestContext.<anonymous> (/Users/chy/workspace/item/dmd/knowledge-fabric/.worktrees/feature-delegate-chat-upstream-failure-t1/scripts/auth-token-exchange.test.mts:191:10)
      at process.processTicksAndRejections (node:internal/process/task_queues:104:5)
      at async Test.run (node:internal/test_runner/test:1404:7)
      at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) {
    generatedMessage: true,
    code: 'ERR_ASSERTION',
    actual: undefined,
    expected: 'PUT',
    operator: 'strictEqual',
    diff: 'simple'
  }
 ELIFECYCLE  Command failed with exit code 1.
EXIT_CODE=1
```

没有单独运行聚合的 `pnpm test`：它的第一项就是上述已知失败的 `test:auth`，会在 A3/A4 之前提前终止；A3、A4、A9 已逐项直接运行并保留原始输出。

## 偏离了计划哪里

- 参考 patch 的 message emit 失败回退会重复 push：`emit()` 在持久化前已把同一事件放进 `events`。改为用同一事件对象做幂等检查，只有事件确实不在数组时才 fallback push。
- 比参考 patch 更彻底地落实 best-effort：失败 agent 消息先于终结 error SSE 落库，避免前端错误回调抢先刷新历史；终结 error 的 run-event 写入失败不再阻断失败 agent 消息落库；Claude session id 更新失败也不会阻断 agent 消息落库。各步独立记录日志，原始上游错误仍是返回主因。
- A1 的全量命令无法整体退出 0：除任务已说明的 `src/components/ChatPanel.tsx` 外，还命中未改动的 `src/components/RepositoryPreviewModal.tsx` 和 `src/mocks/data.ts` 既有错误；本任务文件为零错误，未扩大范围修基线。
- A2 中 JSON、MTS、Markdown 被仓库 ESLint 配置忽略并产生 warning，但命令退出码为 0；没有为本任务扩大范围修改 ESLint 配置。
- 复现 harness 完成三轮并输出全部证据后，tsx 派生的监听进程未被 harness 自己回收；最终复现中仅按端口清理该次 harness 创建的 19124/19500 监听进程，随后主命令退出 0。没有触碰其他 worktree 的 server。
- 没有砍掉或简化计划中的功能与三项指定回归测试；没有修改 `.env`、部署配置、既有测试或分支指针，也没有 commit。

## 还剩什么

- 仓库仍有 A1 输出中列出的既有 TypeScript 错误，以及 A9 的既有 auth 单测失败；均超出本任务范围。
- `scripts/*.test.mts` 尚未被仓库 ESLint 配置覆盖；本次测试由 Node + tsx 实际执行通过，但 lint warning 仍存在。
- 复现 harness 的派生进程清理问题在仓库外的 `~/.local/share/dlgx/fanout/kf-repro.mjs`，本任务未修改外部脚本。
- 没有做浏览器级 toast 视觉自动化；协议投影由单测覆盖，真实 SSE、失败历史与恢复能力由三轮复现覆盖。
- 运维侧仍建议把生产 `AZURE_OPENAI_CONNECT_TIMEOUT_MS` 从 90000 调整到 20000-30000；按规则没有在代码或部署配置中硬改。

