import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { OntologyAiSdkStreamProjector } from "../server/chat/ai-sdk-ui-stream.ts";
import { createWorkspaceRunTrace, validateWorkspaceToolUse } from "../server/chat/claude-runner.ts";
import { agentRunCancelledMessage, agentRunFailedMessage, type UiLocale } from "../server/chat/workflow-status-messages.ts";

test("retry events project to transient data-retry chunks", () => {
  const projector = new OntologyAiSdkStreamProjector("run-retry");

  assert.deepEqual(
    projector.project(
      {
        type: "retry",
        attempt: 2,
        maxRetries: 3,
        delayMs: 1_500,
        status: 502,
      },
      7,
    ),
    [
      {
        type: "data-retry",
        id: "run-retry:7:retry",
        data: {
          attempt: 2,
          maxRetries: 3,
          delayMs: 1_500,
          status: 502,
        },
        transient: true,
      },
    ],
  );
});

test("retry events preserve an open text block and errors remain error chunks", () => {
  const projector = new OntologyAiSdkStreamProjector("run-text");
  const firstText = projector.project({ type: "text-delta", delta: "before" }, 1);
  const retry = projector.project(
    { type: "retry", attempt: 1, maxRetries: 3, delayMs: 250, status: null },
    2,
  );
  const secondText = projector.project({ type: "text-delta", delta: "after" }, 3);
  const error = projector.project({ type: "error", error: "upstream failed" }, 4);

  assert.deepEqual(firstText, [
    { type: "text-start", id: "run-text:1:text" },
    { type: "text-delta", id: "run-text:1:text", delta: "before" },
  ]);
  assert.equal(retry.some((chunk) => chunk.type === "text-end"), false);
  assert.deepEqual(secondText, [
    { type: "text-delta", id: "run-text:1:text", delta: "after" },
  ]);
  assert.deepEqual(error, [{ type: "error", errorText: "upstream failed" }]);
});

test("failed-turn messages are localized and preserve the error detail", () => {
  const detail = "upstream-detail-marker";
  const locales: UiLocale[] = ["zh", "en", "ja"];

  for (const locale of locales) {
    const message = agentRunFailedMessage(locale, detail);
    assert.ok(message.trim(), `${locale} message should not be empty`);
    assert.ok(message.includes(detail), `${locale} message should include the detail`);
  }
});

test("cancelled-turn messages are localized and distinct from failures", () => {
  const locales: UiLocale[] = ["zh", "en", "ja"];
  const rendered = new Set<string>();

  for (const locale of locales) {
    const message = agentRunCancelledMessage(locale);
    assert.ok(message.trim(), `${locale} message should not be empty`);
    // Cancelling and failing are different outcomes; sharing copy would mislabel one of them.
    assert.notEqual(message, agentRunFailedMessage(locale, "detail"), `${locale} must not reuse the failure copy`);
    rendered.add(message);
  }

  assert.equal(rendered.size, locales.length, "each locale should render its own translation");
});

test("bash cannot create a sibling ingest draft while another pending draft is active", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "workspace-bash-sibling-gate-"));
  try {
    await mkdir(path.join(root, "pending_review", "drafts", "ingest-existing", "knowledge"), { recursive: true });
    await writeFile(path.join(root, "pending_review", "drafts", "ingest-existing", "knowledge", "index.md"), "# Existing\n", "utf-8");
    await mkdir(path.join(root, "ingest-plans"), { recursive: true });
    await writeFile(path.join(root, "ingest-plans", "new-source.json"), JSON.stringify({
      plan_id: "new-source",
      draft_id: "ingest-new-source",
      source_name: "New Source",
      created_at: "2026-08-18 12:01",
      target_directory: "raw/new-source",
      total_files: 1,
      total_batches: 1,
      status: "in_progress",
      batches: [
        { id: "batch-1", label: "New Source", files: ["raw/new-source/doc.md"], status: "pending" },
      ],
    }, null, 2), "utf-8");

    const result = await validateWorkspaceToolUse(root, "Bash", {
      command: "mkdir -p pending_review/drafts/ingest-new-source/knowledge/policies && printf '# Bypass\\n' > pending_review/drafts/ingest-new-source/knowledge/policies/bypass.md",
    }, undefined, createWorkspaceRunTrace());

    assert.ok(result?.message);
    assert.match(result.message, /An existing draft is already active at pending_review\/drafts\/ingest-existing/);
    assert.match(result.message, /Do not create or edit sibling draft ingest-new-source/);
    assert.match(result.message, /Continue the existing ingest workflow first for ingest-existing/);
    assert.match(result.message, /Re-read ingest-plans\/existing\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
