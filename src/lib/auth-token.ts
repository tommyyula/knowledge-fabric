import { useUserStore } from "@/stores/useUserStore";

export interface AuthTokenData {
  access_token?: string;
  refresh_token?: string;
  exp?: number;
  expires_in?: number;
}

export function persistAuthToken(data: AuthTokenData): void {
  if (!data.access_token) throw new Error("Missing IAM access token");
  const refreshToken = data.refresh_token
    ?? localStorage.getItem("refresh_token")
    ?? useUserStore.getState().tokenobj?.refreshToken;
  const exp = data.exp ?? (data.expires_in ? Math.floor(Date.now() / 1000) + data.expires_in : undefined);

  localStorage.setItem("access_token", data.access_token);
  if (refreshToken) localStorage.setItem("refresh_token", refreshToken);
  if (exp) localStorage.setItem("token_expires_at", String(exp));
  useUserStore.getState().setToken({
    accessToken: data.access_token,
    refreshToken,
    expiresAt: exp,
    tokenType: "Bearer",
  });
}

export function refreshTokenFromStorage(): string | undefined {
  return localStorage.getItem("refresh_token") ?? useUserStore.getState().tokenobj?.refreshToken;
}
