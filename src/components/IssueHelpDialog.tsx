import { ArrowUpRightIcon, BugIcon, CheckCircle2Icon, XIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { TechnicalIssueReportDeliveryUnknownError, type TechnicalIssueReportRequest } from "@/services/api/support";

export const ISSUE_SHORTCUTS = [
  { id: "review-unavailable", title: "\u5f85\u786e\u8ba4\u7684\u53d8\u66f4\u65e0\u6cd5\u6253\u5f00\u6216\u70b9\u51fb", description: "\u53f3\u4fa7\u9762\u677f\u663e\u793a\u6709\u5f85\u786e\u8ba4\u53d8\u66f4\uff0c\u4f46\u65e0\u6cd5\u67e5\u770b\u6216\u64cd\u4f5c\u3002", command: "pending review drafts \u7684\u5f85\u5ba1\u6838\u5185\u5bb9\u6ca1\u6709\u51fa\u6765\uff0c\u8bf7\u4fee\u590d\u3002" },
  { id: "review-count", title: "\u5f85\u786e\u8ba4\u53d8\u66f4\u7684\u6587\u4ef6\u6570\u91cf\u4e0d\u6b63\u786e", description: "\u6d41\u7a0b\u4e2d\u663e\u793a\u4e86\u591a\u4e2a\u6b65\u9aa4\uff0c\u4f46\u5ba1\u6838\u9762\u677f\u4e2d\u7684\u6587\u4ef6\u6570\u91cf\u660e\u663e\u4e0d\u5bf9\u3002", command: "\u8bf7\u68c0\u67e5 pending review drafts \u7684\u6587\u4ef6\u6570\u91cf\u4e0e\u672c\u6b21\u77e5\u8bc6\u68b3\u7406\u6b65\u9aa4\u662f\u5426\u4e00\u81f4\uff0c\u5e76\u4fee\u590d\u9057\u6f0f\u6216\u91cd\u590d\u7684\u5185\u5bb9\u3002" },
  { id: "journey-step", title: "\u53f3\u4fa7\u6d41\u7a0b\u9762\u677f\u52a0\u8f7d\u6216\u6b65\u9aa4\u663e\u793a\u9519\u8bef", description: "\u6d41\u7a0b\u72b6\u6001\u957f\u65f6\u95f4\u52a0\u8f7d\uff0c\u6216\u663e\u793a\u7684\u6b65\u9aa4\u4e0e\u5b9e\u9645\u5904\u7406\u8fdb\u5ea6\u4e0d\u4e00\u81f4\u3002", command: "\u8bf7\u68c0\u67e5\u53f3\u4fa7\u6d41\u7a0b\u9762\u677f\u7684\u72b6\u6001\u4e0e\u672c\u6b21\u77e5\u8bc6\u68b3\u7406\u5b9e\u9645\u8fdb\u5ea6\u662f\u5426\u4e00\u81f4\uff0c\u5e76\u4fee\u590d\u72b6\u6001\u52a0\u8f7d\u6216\u6b65\u9aa4\u663e\u793a\u95ee\u9898\u3002" },
] as const;

export type IssueShortcut = (typeof ISSUE_SHORTCUTS)[number];
export type IssueSupportContext = { ontologyId: string; sessionId: string };
export type IssueReportPayload = TechnicalIssueReportRequest;

const text = {
  title: "\u9047\u5230\u95ee\u9898\uff1f", intro: "\u9009\u62e9\u4e00\u4e2a\u5e38\u89c1\u95ee\u9898\uff0c\u6211\u4eec\u4f1a\u628a\u5bf9\u5e94\u7684\u4fee\u590d\u6307\u4ee4\u76f4\u63a5\u53d1\u9001\u7ed9 Agent\u3002", close: "\u5173\u95ed", commonIssues: "\u5e38\u89c1\u95ee\u9898", reportPrompt: "\u4ee5\u4e0a\u65e0\u6cd5\u89e3\u51b3\uff1f", reportAction: "\u63d0\u4ea4\u6280\u672f\u5de5\u5355", reportNote: "\u7cfb\u7edf\u4f1a\u81ea\u52a8\u9644\u4e0a\u5f53\u524d\u4f1a\u8bdd\u7684\u5fc5\u8981\u4fe1\u606f\u3002", cancel: "\u53d6\u6d88", processing: "\u5904\u7406\u4e2d...", confirm: "\u786e\u8ba4\u5e76\u53d1\u9001", error: "\u63d0\u4ea4\u5931\u8d25\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5\u3002", deliveryUnknown: "\u6295\u9012\u7ed3\u679c\u6682\u65f6\u65e0\u6cd5\u786e\u8ba4\uff1b\u4e3a\u907f\u514d\u91cd\u590d\u53d1\u9001\uff0c\u7cfb\u7edf\u4e0d\u4f1a\u91cd\u53d1\u540c\u4e00\u4efd\u62a5\u544a\u3002", successTitle: "\u6280\u672f\u5de5\u5355\u5df2\u63d0\u4ea4", successBody: "\u6211\u4eec\u5df2\u5c06\u5f53\u524d\u95ee\u9898\u4e0e\u5fc5\u8981\u4e0a\u4e0b\u6587\u63d0\u4ea4\u7ed9\u6280\u672f\u56e2\u961f\uff0c\u5de5\u4f5c\u4eba\u5458\u4f1a\u5c3d\u5feb\u8ddf\u8fdb\u3002", done: "\u5b8c\u6210" };

interface IssueHelpDialogProps { open: boolean; disabled?: boolean; context: IssueSupportContext; onClose: () => void; onConfirm: (issue: IssueShortcut) => Promise<void> | void; onSubmitReport: (report: IssueReportPayload) => Promise<void> | void; }

export function IssueHelpDialog({ open, disabled = false, context, onClose, onConfirm, onSubmitReport }: IssueHelpDialogProps) {
  const [selectedId, setSelectedId] = useState<IssueShortcut["id"] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [reportSubmitted, setReportSubmitted] = useState(false);
  const [reportRequest, setReportRequest] = useState<IssueReportPayload | null>(null);
  const selectedIssue = ISSUE_SHORTCUTS.find((issue) => issue.id === selectedId) ?? null;
  useEffect(() => {
    setReportRequest(null);
    setReportSubmitted(false);
    setOperationError(null);
  }, [context.ontologyId, context.sessionId]);
  if (!open) return null;

  const close = () => { if (!submitting) { if (!operationError) setReportRequest(null); setReportSubmitted(false); setOperationError(null); onClose(); } };
  const sendCommand = async () => { if (!selectedIssue || disabled || submitting) return; setSubmitting(true); setOperationError(null); try { await onConfirm(selectedIssue); onClose(); } catch { setOperationError(text.error); } finally { setSubmitting(false); } };
  const submitReport = async () => {
    if (submitting) return;
    setSubmitting(true);
    setOperationError(null);
    try {
      const nextReport = reportRequest ?? {
        reportRequestId: crypto.randomUUID(),
        ontologyId: context.ontologyId,
        sessionId: context.sessionId,
        clientContext: {
          pageUrl: window.location.href,
          userAgent: navigator.userAgent,
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          appRelease: import.meta.env.VITE_APP_RELEASE ?? undefined,
        },
      };
      setReportRequest(nextReport);
      await onSubmitReport(nextReport);
      setReportSubmitted(true);
    } catch (error) {
      setOperationError(error instanceof TechnicalIssueReportDeliveryUnknownError ? text.deliveryUnknown : text.error);
    } finally {
      setSubmitting(false);
    }
  };

  return <div className="issue-help-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><section className="issue-help-dialog" role="dialog" aria-modal="true" aria-labelledby="issue-help-title">
    {reportSubmitted ? <div className="issue-help-receipt"><span className="issue-help-receipt-icon"><CheckCircle2Icon /></span><h2 id="issue-help-title">{text.successTitle}</h2><p>{text.successBody}</p><button className="issue-help-receipt-done" type="button" onClick={close}>{text.done}</button></div> : <>
      <header className="issue-help-header"><div className="issue-help-title-wrap"><span className="issue-help-title-icon"><BugIcon /></span><div><h2 id="issue-help-title">{text.title}</h2><p>{text.intro}</p></div></div><button className="issue-help-close" type="button" onClick={close} aria-label={text.close}><XIcon /></button></header>
      <div className="issue-help-options" role="radiogroup" aria-label={text.commonIssues}>{ISSUE_SHORTCUTS.map((issue) => <button key={issue.id} className={`issue-help-option${selectedId === issue.id ? " is-selected" : ""}`} type="button" role="radio" aria-checked={selectedId === issue.id} onClick={() => { setSelectedId(issue.id); setOperationError(null); }}><span className="issue-help-option-indicator" /><span className="issue-help-option-copy"><strong>{issue.title}</strong><span>{issue.description}</span></span></button>)}</div>
      <div className="issue-help-ticket-row"><span>{text.reportPrompt}</span><button className="issue-help-ticket" type="button" disabled={submitting} onClick={submitReport}>{text.reportAction}<ArrowUpRightIcon /></button><small>{text.reportNote}</small></div>
      {operationError ? <p className="issue-help-error" role="alert">{operationError}</p> : null}
      <footer className="issue-help-footer"><button className="issue-help-cancel" type="button" disabled={submitting} onClick={close}>{text.cancel}</button><button className="issue-help-confirm" type="button" disabled={!selectedIssue || disabled || submitting} onClick={sendCommand}>{submitting ? text.processing : text.confirm}</button></footer>
    </>}
  </section></div>;
}
