import { devTenantId, isIamAuthEnabled } from "@/lib/iam";
import { persistAuthToken, refreshTokenFromStorage } from "@/lib/auth-token";
import { refreshIamToken } from "@/services/api/auth";
import { useUserStore } from "@/stores/useUserStore";

const apiBase = import.meta.env.VITE_API_BASE_URL ?? "";
const TOKEN_REFRESH_WINDOW_MS = 60_000;
let refreshInFlight: Promise<void> | null = null;

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function tokenExpiresAt(): number | undefined {
  const stored = useUserStore.getState().tokenobj?.expiresAt
    ?? Number(localStorage.getItem("token_expires_at"));
  return typeof stored === "number" && Number.isFinite(stored) && stored > 0 ? stored : undefined;
}

export async function ensureFreshAccessToken(): Promise<void> {
  if (!isIamAuthEnabled()) return;
  const expiresAt = tokenExpiresAt();
  if (!expiresAt || expiresAt * 1_000 - Date.now() > TOKEN_REFRESH_WINDOW_MS) return;
  if (!refreshInFlight) {
    refreshInFlight = refreshIamToken(refreshTokenFromStorage())
      .then(persistAuthToken)
      .finally(() => {
        refreshInFlight = null;
      });
  }
  await refreshInFlight;
}

export function authHeaders(init?: RequestInit): HeadersInit {
  const token = localStorage.getItem("access_token") ?? useUserStore.getState().tokenobj?.accessToken;
  const tenantId = useUserStore.getState().userInfo?.tenantId ?? devTenantId;
  const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
  return {
    ...(isFormData ? {} : { "Content-Type": "application/json" }),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    TenantID: tenantId,
    ...init?.headers,
  };
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  try {
    await ensureFreshAccessToken();
  } catch (error) {
    window.dispatchEvent(new Event("auth:logout"));
    throw error;
  }
  const res = await fetch(`${apiBase}${path}`, { ...init, headers: authHeaders(init) });
  if (res.status === 401) window.dispatchEvent(new Event("auth:logout"));
  return res;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, init);
  if (!res.ok)
    throw new ApiRequestError(
      res.status,
      (await res.text()) || `Request failed: ${res.status}`,
    );
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}
