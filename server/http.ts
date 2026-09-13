import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AuthError } from "./auth/requireTenantContext";

export function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  return path.length ? `${path.map(String).join(".")}: ` : "";
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  void _next;
  if (err instanceof AuthError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if (err instanceof ZodError) {
    const issue = err.issues[0];
    const detail = issue ? `${formatIssuePath(issue.path)}${issue.message}` : "";
    res.status(400).json({ error: detail ? `Validation failed: ${detail}` : "Validation failed", issues: err.issues });
    return;
  }
  const message = err instanceof Error ? err.message : "Internal server error";
  const status = typeof (err as { status?: unknown })?.status === "number" ? (err as { status: number }).status : undefined;
  if (status && status >= 400 && status < 600) {
    res.status(status).json({ error: message });
    return;
  }
  const badPath = ["Absolute paths are not allowed", "Parent paths are not allowed", "Path escapes ontology workspace"].includes(message);
  if (badPath) {
    res.status(400).json({ error: message });
    return;
  }
  console.error("[server] request failed", err);
  res.status(500).json({ error: process.env.NODE_ENV === "production" ? "Internal server error" : message });
}
