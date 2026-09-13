export type AppToastType = "success" | "error" | "info";

export interface AppToastInput {
  type?: AppToastType;
  message: string;
  durationMs?: number;
}

export interface AppToast extends Required<AppToastInput> {
  id: string;
}

export const APP_TOAST_EVENT = "app:toast";

function formatIssuePath(path: Array<string | number> | undefined): string {
  return path?.length ? `${path.join(".")}: ` : "";
}

export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: unknown; message?: unknown; issues?: Array<{ path?: Array<string | number>; message?: string }> };
    if (Array.isArray(parsed.issues) && parsed.issues[0]?.message) return `${formatIssuePath(parsed.issues[0].path)}${parsed.issues[0].message}`;
    if (typeof parsed.error === "string") return parsed.error;
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // Keep the original error text when it is not a JSON API payload.
  }
  return raw;
}

export function showToast(input: AppToastInput): void {
  if (typeof window === "undefined") return;
  const toast: AppToast = {
    id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `toast-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    type: input.type ?? "info",
    message: input.message,
    durationMs: input.durationMs ?? 4000,
  };
  window.dispatchEvent(new CustomEvent<AppToast>(APP_TOAST_EVENT, { detail: toast }));
}
