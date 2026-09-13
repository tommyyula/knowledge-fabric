import type { JourneyState } from "../../src/contracts/ontology";
import { listPendingReviewDrafts, readReviewDraftDetail } from "../ontologies/workspace";

export type UiLocale = "zh" | "en" | "ja";

export interface ReviewReadyAnnouncementRequest {
  key: string;
  draftId?: string;
}

export function normalizeUiLocale(value: unknown, acceptLanguage?: string | null): UiLocale {
  if (value === "zh" || value === "en" || value === "ja") return value;
  const preferred = String(acceptLanguage ?? "").toLowerCase();
  if (preferred.startsWith("ja")) return "ja";
  if (preferred.startsWith("en")) return "en";
  return "zh";
}

export function workflowContinuationLimitMessage(locale: UiLocale): string {
  switch (locale) {
    case "en":
      return "\n\nThe agent ran into a workflow issue. Please contact technical support for help.";
    case "ja":
      return "\n\nエージェントでワークフローの問題が発生しました。技術サポートに連絡してください。";
    default:
      return "\n\nAgent 遇到工作流问题，请联系技术支持寻求帮助。";
  }
}

/** Closes a failed turn in the transcript so the user message never sits there without a reply. */
export function agentRunFailedMessage(locale: UiLocale, detail: string): string {
  switch (locale) {
    case "en":
      return `\n\n⚠️ This turn failed and was not completed — send it again to retry.\n\nDetail: ${detail}`;
    case "ja":
      return `\n\n⚠️ このターンは失敗し、完了しませんでした。もう一度送信して再試行してください。\n\n詳細: ${detail}`;
    default:
      return `\n\n⚠️ 本轮回答失败，未能完成，可以重新发送这条消息重试。\n\n错误详情：${detail}`;
  }
}

/**
 * Closes a cancelled turn. Cancelling is the escape hatch when a run stops making progress, so it
 * is exactly the path where a dangling user message reads as "the conversation is broken".
 */
export function agentRunCancelledMessage(locale: UiLocale): string {
  switch (locale) {
    case "en":
      return "\n\n⏹️ This turn was cancelled and did not finish — send it again to retry.";
    case "ja":
      return "\n\n⏹️ このターンはキャンセルされ、完了しませんでした。もう一度送信して再試行してください。";
    default:
      return "\n\n⏹️ 本轮已取消，未能完成，可以重新发送这条消息重试。";
  }
}

export function formatIngestBatchCompleted(locale: UiLocale, completed: number, total: number): string {
  switch (locale) {
    case "en":
      return `Batch ${completed}/${total} completed.`;
    case "ja":
      return `バッチ ${completed}/${total} が完了しました。`;
    default:
      return `批次 ${completed}/${total} 已完成。`;
  }
}

export function formatReviewReady(locale: UiLocale, fileCount: number): string {
  const countLabel = fileCount === 1 ? "file" : "files";
  switch (locale) {
    case "en":
      return `Changes verified and staged (${fileCount} ${countLabel}). Review them in the Review panel, then approve.`;
    case "ja":
      return `変更は検証され、ステージされました（${fileCount} 件のファイル）。Review パネルで確認して承認してください。`;
    default:
      return `变更已验证并暂存（${fileCount} 个文件），请在 Review 面板审阅并 approve。`;
  }
}

export function formatWorkflowLocked(locale: UiLocale, holderSessionId?: string): string {
  const holder = holderSessionId ? `（${holderSessionId}）` : "";
  switch (locale) {
    case "en":
      return `This knowledge base is already running a write workflow in another session${holderSessionId ? ` (${holderSessionId})` : ""}. Wait for the current Review to be approved or discarded before starting another ingest or edit.`;
    case "ja":
      return `このナレッジベースでは別のセッション${holderSessionId ? ` (${holderSessionId})` : ""}で書き込みワークフローが実行中です。現在の Review を承認または破棄してから、別のインポートや編集を開始してください。`;
    default:
      return `当前知识库正在另一个会话${holder}中执行写入工作流。请先完成当前 Review 的 approve 或 discard，再开始新的导入或编辑。`;
  }
}

export async function reviewReadyFileCount(root: string, state: JourneyState, draftId?: string): Promise<number> {
  const activeDraftId = draftId || state.review?.draftId;
  if (activeDraftId) {
    const detail = await readReviewDraftDetail(root, activeDraftId).catch(() => null);
    if (detail) return detail.fileCount;
  }

  const summaries = await listPendingReviewDrafts(root).catch(() => []);
  if (activeDraftId) {
    const activeSummary = summaries.find((summary) => summary.draftId === activeDraftId);
    if (activeSummary) return activeSummary.fileCount;
  }
  const withFiles = summaries.filter((summary) => summary.fileCount > 0);
  if (withFiles.length) return withFiles.reduce((sum, summary) => sum + summary.fileCount, 0);
  return state.review?.files.length ?? 0;
}

interface SuccessfulIngestBatch {
  key: string;
  ordinal: number;
}

function successfulIngestBatches(state: JourneyState): SuccessfulIngestBatch[] {
  const runKey = state.ingest.planId || state.ingest.targetDirectory || "active-ingest";
  return (state.ingest.batches ?? []).flatMap((batch, index) => {
    if (batch.status !== "success") return [];
    return [{ key: `${runKey}:${batch.id || index}`, ordinal: index + 1 }];
  });
}

function successfulIngestBatchKeys(state: JourneyState): string[] {
  return successfulIngestBatches(state).map((batch) => batch.key);
}

function reviewReadyKey(state: JourneyState): string | null {
  if (state.phase !== "review" || state.review?.status !== "pending") return null;
  return state.review.draftId || state.review.files.map((file) => file.path).sort().join("|") || "review";
}

export class WorkflowStatusAnnouncer {
  private readonly locale: UiLocale;
  private seenSuccessfulBatchKeys = new Set<string>();
  private announcedReviewReadyKeys = new Set<string>();

  constructor(locale: UiLocale) {
    this.locale = locale;
  }

  seed(state: JourneyState): void {
    this.seenSuccessfulBatchKeys = new Set(successfulIngestBatchKeys(state));
    const key = reviewReadyKey(state);
    if (key) this.announcedReviewReadyKeys.add(key);
  }

  ingestBatchMessages(state: JourneyState): string[] {
    const total = Math.max(state.ingest.totalBatches || 0, state.ingest.batches?.length ?? 0);
    if (total <= 0) return [];

    const successfulBatches = successfulIngestBatches(state);
    const newSuccessfulBatches = successfulBatches.filter((batch) => !this.seenSuccessfulBatchKeys.has(batch.key));
    successfulBatches.forEach((batch) => this.seenSuccessfulBatchKeys.add(batch.key));

    return newSuccessfulBatches.map((batch) => formatIngestBatchCompleted(this.locale, Math.min(total, batch.ordinal), total));
  }

  reviewReadyRequest(state: JourneyState): ReviewReadyAnnouncementRequest | null {
    const key = reviewReadyKey(state);
    if (!key || this.announcedReviewReadyKeys.has(key)) return null;
    return { key, draftId: state.review?.draftId };
  }

  markReviewReadyAnnounced(key: string): void {
    this.announcedReviewReadyKeys.add(key);
  }
}
