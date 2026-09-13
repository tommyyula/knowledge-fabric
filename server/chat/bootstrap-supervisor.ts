import fs from "node:fs/promises";
import path from "node:path";
import type { JourneyState } from "../../src/contracts/ontology";
import {
  acquireWorkflowLock,
  CONTENT_ROOT,
  readJourneyState,
  resolveWorkspaceFile,
  writeJourneyState,
  type WorkflowLockOwner,
} from "../ontologies/workspace";
import { ensureBootstrapHydrated, type BootstrapResult } from "./bootstrap-observer";

export type BootstrapContinuationResult =
  | { kind: "not_applicable" }
  | { kind: "no_raw_sources" }
  | { kind: "already_started" }
  | { kind: "workflow_locked" }
  | { kind: "initial_ingest_started"; hydrated: boolean };

interface BootstrapContinuationInput {
  root: string;
  owner: Pick<WorkflowLockOwner, "ontologyId" | "sessionId" | "runId">;
  runInitialIngest: () => Promise<void>;
}

const BASELINE_FILES = ["index.md", "overview.md", "glossary.md", "log.md"] as const;

function completeBootstrapResult(state: JourneyState): BootstrapResult | null {
  const result = state.bootstrap.result;
  if (!result?.name || !result.description || !result.emoji || !result.knowledge_subdirs?.length || !result.naming_conventions?.length) return null;
  return result;
}

function isConfirmedBootstrap(state: JourneyState): boolean {
  if (state.bootstrap.status !== "done" || state.bootstrap.awaitingUser !== false) return false;
  return Boolean(completeBootstrapResult(state));
}

async function directoryHasAnyFile(dir: string): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isFile()) return true;
    if (entry.isDirectory() && await directoryHasAnyFile(child)) return true;
  }
  return false;
}

async function hasInitialIngestArtifacts(root: string): Promise<boolean> {
  const [plans, drafts, verify] = await Promise.all([
    fs.readdir(resolveWorkspaceFile(root, "ingest-plans"), { withFileTypes: true }).catch(() => []),
    fs.readdir(resolveWorkspaceFile(root, "pending_review/drafts"), { withFileTypes: true }).catch(() => []),
    fs.readdir(resolveWorkspaceFile(root, "verify"), { withFileTypes: true }).catch(() => []),
  ]);
  return plans.some((entry) => entry.isFile() && entry.name.endsWith(".json")) ||
    drafts.some((entry) => entry.isDirectory()) ||
    verify.some((entry) => entry.name !== ".DS_Store");
}

async function hasKnowledgeBaseline(root: string): Promise<boolean> {
  const found = await Promise.all(BASELINE_FILES.map(async (file) => {
    try {
      return (await fs.stat(resolveWorkspaceFile(root, `${CONTENT_ROOT}/${file}`))).isFile();
    } catch {
      return false;
    }
  }));
  return found.every(Boolean);
}

export async function continueInitialBootstrapBuild(input: BootstrapContinuationInput): Promise<BootstrapContinuationResult> {
  const state = await readJourneyState(input.root);
  if (!isConfirmedBootstrap(state)) return { kind: "not_applicable" };
  const result = completeBootstrapResult(state);
  if (!result) return { kind: "not_applicable" };
  const hydratedBefore = await hasKnowledgeBaseline(input.root);
  const activeInitialBuild = state.flow === "build" && state.phase === "ingest";
  const malformedReadyHandoff = state.phase === "ready" && !hydratedBefore;
  if (!activeInitialBuild && !malformedReadyHandoff) return { kind: "not_applicable" };
  if (!await directoryHasAnyFile(resolveWorkspaceFile(input.root, "raw"))) return { kind: "no_raw_sources" };
  if (await hasInitialIngestArtifacts(input.root)) return { kind: "already_started" };

  const lock = await acquireWorkflowLock(input.root, {
    ...input.owner,
    workflow: "ingest",
    phase: "ingest",
  });
  if (!lock.acquired) return { kind: "workflow_locked" };

  // Recheck after taking the lock because another run may have created artifacts
  // between the first inspection and lock acquisition.
  if (await hasInitialIngestArtifacts(input.root)) return { kind: "already_started" };
  if (!activeInitialBuild) {
    await writeJourneyState(input.root, {
      ...state,
      flow: "build",
      phase: "ingest",
      review: undefined,
      updatedAt: new Date().toISOString(),
    });
  }
  await ensureBootstrapHydrated(input.root, result);
  await input.runInitialIngest();
  return { kind: "initial_ingest_started", hydrated: !hydratedBefore };
}
