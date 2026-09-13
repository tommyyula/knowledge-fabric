import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ensureBootstrapHydrated, type BootstrapResult } from "../server/chat/bootstrap-observer.ts";
import { continueInitialBootstrapBuild } from "../server/chat/bootstrap-supervisor.ts";
import { isWorkspaceQueryReady } from "../server/external/query-readiness.ts";
import { initialJourneyState, readJourneyState, writeJourneyState } from "../server/ontologies/workspace.ts";
import type { JourneyState } from "../src/contracts/ontology.ts";

const result: BootstrapResult = {
  name: "Recovery Test Knowledge Base",
  description: "Exercises the durable Bootstrap-to-Ingest handoff.",
  emoji: "🧪",
  content_language: "English",
  knowledge_subdirs: ["concepts"],
  naming_conventions: ["- concepts: TitleCase.md"],
};

async function workspace(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "bootstrap-recovery-"));
}

async function write(root: string, relativePath: string, content = ""): Promise<void> {
  const target = path.join(root, ...relativePath.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
}

function confirmedIngestState(): JourneyState {
  const state = initialJourneyState();
  return {
    ...state,
    flow: "build",
    phase: "ingest",
    bootstrap: {
      ...state.bootstrap,
      name: result.name,
      description: result.description,
      step: 6,
      status: "done",
      awaitingUser: false,
      result,
    },
    updatedAt: new Date().toISOString(),
  };
}

test("confirmed Bootstrap starts initial ingest from durable state even after the handoff event was missed", async () => {
  const root = await workspace();
  try {
    await write(root, "raw/source.md", "# Source\n");
    await write(root, "bootstrap-result.json", JSON.stringify(result));
    await writeJourneyState(root, confirmedIngestState());
    let starts = 0;

    const continuation = await continueInitialBootstrapBuild({
      root,
      owner: {
        ontologyId: "ontology-1",
        sessionId: "session-1",
        runId: "run-1",
      },
      runInitialIngest: async () => {
        starts += 1;
        await write(root, "ingest-plans/initial.json", "{}");
      },
    });

    assert.equal(continuation.kind, "initial_ingest_started");
    assert.equal(starts, 1);
    for (const file of ["index.md", "overview.md", "glossary.md", "log.md"]) {
      assert.ok(await readFile(path.join(root, "knowledge", file), "utf8"));
    }

    const repeated = await continueInitialBootstrapBuild({
      root,
      owner: {
        ontologyId: "ontology-1",
        sessionId: "session-1",
        runId: "run-2",
      },
      runInitialIngest: async () => { starts += 1; },
    });
    assert.equal(repeated.kind, "already_started");
    assert.equal(starts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an abnormal maintenance/ready handoff without a baseline is repaired before initial ingest", async () => {
  const root = await workspace();
  try {
    await write(root, "raw/source.md", "# Source\n");
    const malformed: JourneyState = {
      ...confirmedIngestState(),
      flow: "maintenance",
      phase: "ready",
      review: { description: "", files: [], status: "discarded" },
    };
    await writeJourneyState(root, malformed);
    let observedState: JourneyState | null = null;

    const continuation = await continueInitialBootstrapBuild({
      root,
      owner: {
        ontologyId: "ontology-1",
        sessionId: "session-1",
        runId: "run-ready-repair",
      },
      runInitialIngest: async () => {
        observedState = await readJourneyState(root);
        await write(root, "ingest-plans/initial.json", "{}");
      },
    });

    assert.equal(continuation.kind, "initial_ingest_started");
    assert.equal(observedState?.flow, "build");
    assert.equal(observedState?.phase, "ingest");
    assert.equal(observedState?.review, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Bootstrap hydration creates only missing baseline files", async () => {
  const root = await workspace();
  try {
    const customIndex = "# Existing index\n\nDo not replace me.\n";
    await write(root, "knowledge/index.md", customIndex);

    await ensureBootstrapHydrated(root, result);

    assert.equal(await readFile(path.join(root, "knowledge/index.md"), "utf8"), customIndex);
    for (const file of ["overview.md", "glossary.md", "log.md"]) {
      assert.ok(await readFile(path.join(root, "knowledge", file), "utf8"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stale initial ingest without artifacts remains recoverable and is not fabricated as discarded Review", async () => {
  const root = await workspace();
  try {
    await write(root, "raw/source.md", "# Source\n");
    await ensureBootstrapHydrated(root, result);
    const stale = {
      ...confirmedIngestState(),
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
    };
    await write(root, ".runtime/journey-state.json", JSON.stringify(stale));

    const recovered = await readJourneyState(root);

    assert.equal(recovered.flow, "build");
    assert.equal(recovered.phase, "ingest");
    assert.equal(recovered.review, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maintenance orphan recovery does not claim that the user discarded Review", async () => {
  const root = await workspace();
  try {
    await ensureBootstrapHydrated(root, result);
    const state = confirmedIngestState();
    const stale: JourneyState = {
      ...state,
      flow: "maintenance",
      updatedAt: new Date(Date.now() - 120_000).toISOString(),
    };
    await write(root, ".runtime/journey-state.json", JSON.stringify(stale));

    const recovered = await readJourneyState(root);

    assert.equal(recovered.flow, "maintenance");
    assert.equal(recovered.phase, "ready");
    assert.equal(recovered.review, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("maintenance/ready is query-ready only when the published knowledge baseline exists", async () => {
  const root = await workspace();
  try {
    const state: JourneyState = {
      ...confirmedIngestState(),
      flow: "maintenance",
      phase: "ready",
    };

    assert.equal(await isWorkspaceQueryReady(root, state), false);
    await ensureBootstrapHydrated(root, result);
    assert.equal(await isWorkspaceQueryReady(root, state), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
