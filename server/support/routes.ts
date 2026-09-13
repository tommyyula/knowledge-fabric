import { createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { requireTenantContext } from "../auth/requireTenantContext";
import { env } from "../env";
import { asyncRoute } from "../http";
import {
  getLatestRunStatus,
  getProject,
  getSession,
  listMessages,
  listRunEvents,
} from "../ontologies/repository";
import { readJourneyState, workspacePath } from "../ontologies/workspace";
import {
  recipientList,
  ReportDeliveryError,
  sendReportEmail,
} from "./email-client";
import {
  claimSupportReport,
  completeSupportReport,
  failSupportReport,
  markSupportReportUnknown,
} from "./idempotency-store";
import { buildCoreReport } from "./report-builder";

const clientContextSchema = z
  .object({
    pageUrl: z.string().max(2_000).optional(),
    userAgent: z.string().max(1_000).optional(),
    locale: z.string().max(100).optional(),
    timeZone: z.string().max(100).optional(),
    appRelease: z.string().max(200).optional(),
  })
  .strict()
  .optional();

const issueReportSchema = z
  .object({
    reportRequestId: z.string().uuid(),
    ontologyId: z.string().min(1).max(200),
    sessionId: z.string().min(1).max(200),
    clientContext: clientContextSchema,
  })
  .strict();

export interface SupportRouterOptions {
  emailApiUrl?: string;
  recipients?: string;
  timeoutMs?: number;
  appRelease?: string;
  now?: () => Date;
}

function httpError(
  status: number,
  message: string,
): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

function requestFingerprint(body: z.infer<typeof issueReportSchema>): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        ontologyId: body.ontologyId,
        sessionId: body.sessionId,
        clientContext: body.clientContext ?? null,
      }),
    )
    .digest("hex");
}

export function createSupportRouter(
  options: SupportRouterOptions = {},
): Router {
  const router = Router();
  const apiUrl = options.emailApiUrl ?? env.supportEmailApiUrl;
  const recipients = recipientList(
    options.recipients ?? env.supportReportRecipients,
  );
  const timeoutMs = options.timeoutMs ?? env.supportEmailTimeoutMs;
  const appRelease = options.appRelease ?? env.appRelease;
  const currentTime = options.now ?? (() => new Date());

  router.post(
    "/issue-reports",
    asyncRoute(async (req, res) => {
      const body = issueReportSchema.parse(req.body);
      const ctx = await requireTenantContext(req);
      const [project, session] = await Promise.all([
        getProject(ctx.tenantId, ctx.ownerId, body.ontologyId),
        getSession(ctx.tenantId, ctx.ownerId, body.ontologyId, body.sessionId),
      ]);
      if (!project || !session)
        throw httpError(404, "Knowledge Base conversation not found");

      const receivedAt = currentTime();
      const claim = await claimSupportReport({
        tenantId: ctx.tenantId,
        ownerId: ctx.ownerId,
        reportRequestId: body.reportRequestId,
        requestFingerprint: requestFingerprint(body),
        now: receivedAt,
        expiresAt: new Date(receivedAt.getTime() + 24 * 60 * 60 * 1_000),
      });
      if (claim === "conflict")
        throw httpError(
          409,
          "Report request ID was reused with different input",
        );
      if (claim === "replay") {
        res.json({
          data: {
            reportRequestId: body.reportRequestId,
            status: "sent",
            replayed: true,
          },
        });
        return;
      }
      if (claim === "in_progress" || claim === "unknown") {
        res.status(202).json({
          data: {
            reportRequestId: body.reportRequestId,
            status:
              claim === "unknown" ? "delivery_unknown" : "in_progress",
          },
        });
        return;
      }

      let deliveryAccepted = false;
      try {
        const messageContext = {
          tenantId: ctx.tenantId,
          ownerId: ctx.ownerId,
          ontologyId: project.id,
          sessionId: session.id,
        };
        const [messages, journeyState, runStatus] = await Promise.all([
          listMessages(messageContext),
          readJourneyState(
            workspacePath(ctx.tenantId, ctx.ownerId, project.id),
          ).catch(() => null),
          getLatestRunStatus(messageContext),
        ]);
        const runEvents = runStatus.runId
          ? await listRunEvents({ ...messageContext, runId: runStatus.runId })
          : [];
        const html = buildCoreReport({
          reportRequestId: body.reportRequestId,
          submittedAt: currentTime().toISOString(),
          tenantId: ctx.tenantId,
          user: ctx.user,
          project,
          session,
          messages,
          clientContext: body.clientContext,
          appRelease,
          journeyState,
          runStatus,
          runEvents,
        });
        await sendReportEmail({
          apiUrl,
          recipients,
          timeoutMs,
          reportRequestId: body.reportRequestId,
          knowledgeBaseName: project.name,
          html,
        });
        deliveryAccepted = true;
        await completeSupportReport({
          tenantId: ctx.tenantId,
          ownerId: ctx.ownerId,
          reportRequestId: body.reportRequestId,
          now: currentTime(),
        });
        res.status(201).json({
          data: { reportRequestId: body.reportRequestId, status: "sent" },
        });
      } catch (error) {
        const deliveryUnknown =
          deliveryAccepted ||
          (error instanceof ReportDeliveryError && error.outcome === "unknown");
        if (deliveryUnknown) {
          await markSupportReportUnknown({
            tenantId: ctx.tenantId,
            ownerId: ctx.ownerId,
            reportRequestId: body.reportRequestId,
            now: currentTime(),
          }).catch(() => undefined);
          res.status(202).json({
            data: {
              reportRequestId: body.reportRequestId,
              status: "delivery_unknown",
            },
          });
          return;
        }
        await failSupportReport({
          tenantId: ctx.tenantId,
          ownerId: ctx.ownerId,
          reportRequestId: body.reportRequestId,
          now: currentTime(),
        }).catch(() => undefined);
        throw error;
      }
    }),
  );
  return router;
}

export const supportRouter = createSupportRouter();
