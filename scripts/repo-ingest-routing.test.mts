import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildRepoIngestRoutingHint,
  classifyRawRepoPath,
  prepareRepoIngestPrompt,
  REPO_DOCUMENT_INGEST_GATE_MESSAGE,
  REPO_INGEST_PROMPT_HINT,
} from "../server/chat/repo-ingest-routing.ts";

async function workspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "repo-ingest-routing-"));
}

async function write(root: string, relativePath: string, content = ""): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

test("raw/repos target with source files and project marker is allowed as coding repo ingest", async () => {
  const root = await workspace();
  try {
    await write(root, "raw/repos/code/package.json", "{}");
    await write(root, "raw/repos/code/src/app.ts");
    await write(root, "raw/repos/code/src/routes.ts");
    await write(root, "raw/repos/code/src/service.ts");

    const classification = await classifyRawRepoPath(root, "raw/repos/code");
    assert.equal(classification?.isCodeRepo, true);

    const prepared = await prepareRepoIngestPrompt(root, "Please ingest raw/repos/code");
    assert.equal(prepared.allowedRepoPaths.has("raw/repos/code"), true);
    assert.match(prepared.prompt, new RegExp(REPO_INGEST_PROMPT_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("raw/repos target with document files is routed back to document ingest", async () => {
  const root = await workspace();
  try {
    await write(root, "raw/repos/docs/README.md", "# Docs");
    await write(root, "raw/repos/docs/policy.md", "# Policy");
    await write(root, "raw/repos/docs/process-notes.txt", "notes");

    const classification = await classifyRawRepoPath(root, "raw/repos/docs");
    assert.equal(classification?.isCodeRepo, false);

    const prepared = await prepareRepoIngestPrompt(root, "Please ingest raw/repos/docs");
    assert.equal(prepared.allowedRepoPaths.size, 0);
    assert.equal(prepared.documentRepoPaths.has("raw/repos/docs"), true);
    assert.match(prepared.prompt, new RegExp(REPO_DOCUMENT_INGEST_GATE_MESSAGE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("non raw/repos code-like folders do not receive coding repo ingest hints", async () => {
  const root = await workspace();
  try {
    await write(root, "raw/resources/code/package.json", "{}");
    await write(root, "raw/resources/code/src/app.ts");
    await write(root, "raw/resources/code/src/routes.ts");
    await write(root, "raw/resources/code/src/service.ts");

    const hint = await buildRepoIngestRoutingHint(root, ["raw/resources/code"]);
    assert.equal(hint, null);

    const prepared = await prepareRepoIngestPrompt(root, "Please ingest raw/resources/code");
    assert.equal(prepared.allowedRepoPaths.size, 0);
    assert.doesNotMatch(prepared.prompt, new RegExp(REPO_INGEST_PROMPT_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
