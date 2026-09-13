import { randomUUID } from "node:crypto";
import type { JourneyState, OntologyProject, OntologySession, OntologyStreamEvent } from "../../src/contracts/ontology";
import { appendMessage, appendRunEvent, updateClaudeSessionId, type OntologyRunEventRecord } from "../ontologies/repository";
import { readJourneyState } from "../ontologies/workspace";
import { ontologyRunMessageId } from "./ai-sdk-ui-stream";
import { createWorkspaceRunTrace, streamOntologyAgent } from "./claude-runner";
import type { UiLocale } from "./workflow-status-messages";

const TEXT_DELTA_BATCH_MAX_BYTES = 4 * 1024;
const TEXT_DELTA_BATCH_MAX_DELAY_MS = 250;

export interface OntologySyncRunReference {
  status: "started";
  updateId: string;
  materialRoot: string;
  diffPath?: string;
  sessionId: string;
  runId: string;
}

export type OntologySyncMode = "initial_distill" | "incremental_edit";

interface StartOntologySyncRunInput {
  tenantId: string;
  ownerId: string;
  userId: string;
  project: OntologyProject;
  session: OntologySession;
  root: string;
  updateId: string;
  materialRoot: string;
  diffPath?: string;
  locale: UiLocale;
  mode: OntologySyncMode;
}

class TextDeltaBatcher {
  private readonly textParts: string[] = [];
  private textBytes = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writeTail: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  constructor(private readonly persist: (event: OntologyStreamEvent) => Promise<OntologyRunEventRecord>) {}

  async emit(event: OntologyStreamEvent): Promise<OntologyRunEventRecord | null> {
    this.throwIfFailed();
    if (event.type === "text-delta") return this.appendText(event.delta);
    await this.flushText();
    return this.persistEvent(event);
  }

  async flush(): Promise<void> {
    await this.flushText();
    await this.writeTail;
    this.throwIfFailed();
  }

  private async appendText(delta: string): Promise<OntologyRunEventRecord | null> {
    let persisted: OntologyRunEventRecord | null = null;
    for (const character of delta) {
      const characterBytes = Buffer.byteLength(character);
      if (this.textBytes + characterBytes > TEXT_DELTA_BATCH_MAX_BYTES) persisted = await this.flushText();
      this.textParts.push(character);
      this.textBytes += characterBytes;
      if (this.textBytes === TEXT_DELTA_BATCH_MAX_BYTES) persisted = await this.flushText();
    }
    if (this.textParts.length) this.scheduleFlush();
    return persisted;
  }

  private async flushText(): Promise<OntologyRunEventRecord | null> {
    this.clearTimer();
    if (!this.textParts.length) {
      await this.writeTail;
      this.throwIfFailed();
      return null;
    }
    const delta = this.textParts.join("");
    this.textParts.length = 0;
    this.textBytes = 0;
    return this.persistEvent({ type: "text-delta", delta });
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flushText().catch((error) => { this.failure ??= error; });
    }, TEXT_DELTA_BATCH_MAX_DELAY_MS);
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private persistEvent(event: OntologyStreamEvent): Promise<OntologyRunEventRecord> {
    this.throwIfFailed();
    const write = this.writeTail.then(() => {
      this.throwIfFailed();
      return this.persist(event);
    });
    this.writeTail = write.then(() => undefined, (error) => { this.failure ??= error; });
    return write;
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
  }
}

function ontologySyncStartedMessage(locale: UiLocale): string {
  switch (locale) {
    case "en":
      return "Knowledge has been written. Ontology sync has started from these changes.";
    case "ja":
      return "Knowledge の書き込みが完了し、今回の変更に基づく Ontology 同期を開始しました。";
    default:
      return "Knowledge 已写入，已根据本次变更启动 Ontology 同步。";
  }
}

function ontologySyncPrompt(materialRoot: string, mode: OntologySyncMode): string {
  if (mode === "initial_distill") {
    return [
      "I have approved pending review changes in the app, and the Knowledge has already been written.",
      "",
      "This is the initial ontology sync for a newly created knowledge base, so ontology/ does not yet have usable ontology layer artifacts.",
      "",
      "Now read and follow skills/ontology-distill/SKILL.md to create the initial ontology from the approved Knowledge.",
      "",
      "Use knowledge/ as the primary modeling source. Read raw/ only when you need original-source evidence or when a Knowledge page points back to source material.",
      "",
      "Do not use skills/edit-ontology/SKILL.md in this run.",
      "Create or update only ontology/ artifacts, and follow ontology-distill's scenario queue, instance gleaning, and validation gates.",
    ].join("\n");
  }

  return [
    "I have approved pending review changes in the app, and the Knowledge has already been written.",
    "",
    "Now read and follow skills/edit-ontology/SKILL.md to update the ontology based on this round of changed Knowledge.",
    "",
    "The changed Knowledge files for this round are available under:",
    `${materialRoot}/knowledge/`,
    "",
    "Start by reading the files in that directory, then inspect the relevant current ontology/ artifacts and update only ontology/ files as needed.",
    "If ontology/ is missing, empty, or has no usable layer artifacts, do not stop after reporting that edit-ontology cannot run. Immediately read and follow skills/ontology-distill/SKILL.md in this same run.",
  ].join("\n");
}

export async function startAppInitiatedOntologySyncRun(input: StartOntologySyncRunInput): Promise<OntologySyncRunReference> {
  const runId = randomUUID();
  const messageCtx = { tenantId: input.tenantId, ownerId: input.ownerId, ontologyId: input.project.id, sessionId: input.session.id };
  await appendMessage(messageCtx, { role: "system", content: ontologySyncStartedMessage(input.locale) });

  let sequence = 0;
  const batcher = new TextDeltaBatcher(async (event) => {
    sequence += 1;
    return appendRunEvent({
      tenantId: input.tenantId,
      ontologyId: input.project.id,
      sessionId: input.session.id,
      runId,
      sequence,
      event,
    });
  });

  const initialState = await readJourneyState(input.root).catch((): JourneyState | null => null);
  if (initialState) await batcher.emit({ type: "journey-state", state: initialState });

  void (async () => {
    const textParts: string[] = [];
    let claudeSessionId = input.session.claudeSessionId ?? "";
    const syncRequest = ontologySyncPrompt(input.materialRoot, input.mode);
    try {
      for await (const event of streamOntologyAgent({
        prompt: syncRequest,
        cwd: input.root,
        resume: input.session.claudeSessionId,
        tenantId: input.tenantId,
        ownerId: input.ownerId,
        userId: input.userId,
        ontologyId: input.project.id,
        appSessionId: input.session.id,
        runId,
        userRequest: syncRequest,
        locale: input.locale,
        runTrace: createWorkspaceRunTrace(),
        ontologySync: {
          updateId: input.updateId,
          materialRoot: input.materialRoot,
        },
      })) {
        if (event.type === "finish") {
          if (event.claudeSessionId) claudeSessionId = event.claudeSessionId;
          continue;
        }
        if (event.type === "text-delta") textParts.push(event.delta);
        await batcher.emit(event);
      }
      await batcher.flush();
      if (claudeSessionId) await updateClaudeSessionId({ tenantId: input.tenantId, ontologyId: input.project.id, sessionId: input.session.id }, claudeSessionId);
      const assistant = await appendMessage(messageCtx, { id: ontologyRunMessageId(runId), role: "agent", content: textParts.join("") || "Done." });
      await batcher.emit({ type: "message", message: assistant });
      await batcher.flush();
    } catch (error) {
      await batcher.emit({ type: "error", error: error instanceof Error ? error.message : String(error) }).catch(() => undefined);
      await batcher.flush().catch(() => undefined);
    }
  })();

  return {
    status: "started",
    updateId: input.updateId,
    materialRoot: input.materialRoot,
    diffPath: input.diffPath,
    sessionId: input.session.id,
    runId,
  };
}
