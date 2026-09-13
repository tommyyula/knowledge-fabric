import { apiJson } from "@/lib/api-client";

export interface TechnicalIssueReportRequest {
  reportRequestId: string;
  ontologyId: string;
  sessionId: string;
  clientContext?: {
    pageUrl?: string;
    userAgent?: string;
    locale?: string;
    timeZone?: string;
    appRelease?: string;
  };
}

interface TechnicalIssueReportResponse {
  data: {
    reportRequestId: string;
    status: "sent" | "in_progress" | "delivery_unknown";
    replayed?: boolean;
  };
}

export class TechnicalIssueReportDeliveryUnknownError extends Error {
  constructor() {
    super("Technical Issue Report delivery outcome is unknown");
    this.name = "TechnicalIssueReportDeliveryUnknownError";
  }
}

export async function submitTechnicalIssueReport(
  request: TechnicalIssueReportRequest,
): Promise<void> {
  const response = await apiJson<TechnicalIssueReportResponse>(
    "/api/v1/support/issue-reports",
    {
      method: "POST",
      body: JSON.stringify(request),
    },
  );
  if (response.data.status === "delivery_unknown")
    throw new TechnicalIssueReportDeliveryUnknownError();
  if (response.data.status !== "sent")
    throw new Error("Technical Issue Report delivery is still in progress");
}
