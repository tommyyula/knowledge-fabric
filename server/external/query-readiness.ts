import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import { listProjectsForReadinessProjection, upsertQueryReadinessProjection } from "../ontologies/repository";
import { readJourneyState, registerJourneyStateWriteListener, workspacePath } from "../ontologies/workspace";
import type { JourneyState } from "../../src/contracts/ontology";

export function isQueryReady(state: JourneyState): boolean {
  return state.flow === "maintenance" && state.phase === "ready";
}

export async function isWorkspaceQueryReady(root: string, state: JourneyState): Promise<boolean> {
  if (!isQueryReady(state)) return false;
  const baseline = ["index.md", "overview.md", "glossary.md", "log.md"];
  const files = await Promise.all(baseline.map(async (file) => {
    try {
      return (await fs.stat(path.join(root, "knowledge", file))).isFile();
    } catch {
      return false;
    }
  }));
  return files.every(Boolean);
}

export async function rebuildQueryReadinessProjection(): Promise<{ projected: number; queryReady: number }> {
  const projects = await listProjectsForReadinessProjection();
  let queryReady = 0;
  for (const project of projects) {
    const state = await readJourneyState(workspacePath(project.tenantId, project.ownerId, project.id));
    const ready = await isWorkspaceQueryReady(workspacePath(project.tenantId, project.ownerId, project.id), state);
    if (ready) queryReady += 1;
    await upsertQueryReadinessProjection({
      tenantId: project.tenantId,
      ownerId: project.ownerId,
      ontologyId: project.id,
      flow: state.flow,
      phase: state.phase,
      queryReady: ready,
    });
  }
  return { projected: projects.length, queryReady };
}

function workspaceScope(root: string): { tenantId: string; ownerId: string; ontologyId: string } | null {
  const parts = path.relative(env.workspaceRoot, root).split(path.sep);
  if (parts.length !== 6 || parts[0] !== "tenants" || parts[2] !== "users" || parts[4] !== "ontologies" || parts.some((part) => !part || part === "..")) return null;
  return { tenantId: parts[1], ownerId: parts[3], ontologyId: parts[5] };
}

let journeyStateProjectionRegistered = false;

export function registerQueryReadinessProjection(): void {
  if (journeyStateProjectionRegistered) return;
  journeyStateProjectionRegistered = true;
  registerJourneyStateWriteListener(async (root, state) => {
    const scope = workspaceScope(root);
    if (!scope) return;
    await upsertQueryReadinessProjection({
      ...scope,
      flow: state.flow,
      phase: state.phase,
      queryReady: await isWorkspaceQueryReady(root, state),
    });
  });
}
