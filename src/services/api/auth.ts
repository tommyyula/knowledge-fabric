export interface TokenExchangeData {
  access_token?: string;
  refresh_token?: string;
  exp?: number;
  expires_in?: number;
  user_id?: string;
  username?: string;
  name?: string;
  tenant_id?: string;
  tenants?: string[];
  company_code?: string;
  companies?: Array<{
    companyCode: string;
    companyName: string;
  }>;
  granted_app_codes?: string[];
  is_admin?: boolean;
}

interface TokenExchangeResponse {
  data: TokenExchangeData | null;
  message?: string;
}

export interface AuthUserResponse {
  data: {
    user_id: string;
    username: string;
    name: string;
    tenant_id: string;
    tenants: string[];
    company_code?: string;
    companies?: Array<{
      companyCode: string;
      companyName: string;
    }>;
    granted_app_codes?: string[];
    is_admin?: boolean;
  } | null;
  message?: string;
}

async function readTokenExchangeResponse(res: Response): Promise<TokenExchangeResponse> {
  const text = await res.text();
  if (!text.trim()) return { data: null };
  try {
    return JSON.parse(text) as TokenExchangeResponse;
  } catch {
    return { data: null, message: text };
  }
}

function iamGrantErrorMessage(payload: TokenExchangeResponse): string {
  const message = payload.message?.trim();
  if (message?.toLowerCase() === "password is incorrect") return "password is incorrect";
  if (message === "You are not allowed to access this application, please contact the Item Support team or the business BA") {
    return message;
  }
  return "Token exchange failed";
}

export async function exchangeCodeForToken(body: { code: string; redirect_uri: string }): Promise<TokenExchangeResponse> {
  const res = await fetch("/api/auth/exchange-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readTokenExchangeResponse(res);
  if (!res.ok) return { data: null, message: payload.message ?? "Token exchange failed" };
  return payload;
}

export async function exchangeIamGrant(body: Record<string, string>): Promise<TokenExchangeData> {
  const res = await fetch("/api/auth/exchange-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readTokenExchangeResponse(res);
  if (!res.ok) throw new Error(iamGrantErrorMessage(payload));
  if (!payload.data?.access_token) throw new Error("Token exchange failed");
  return payload.data;
}

export async function refreshIamToken(refreshToken: string | undefined): Promise<TokenExchangeData> {
  if (!refreshToken) throw new Error("IAM refresh token is unavailable");
  return exchangeIamGrant({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

export async function switchIamTenant(tenantId: string): Promise<void> {
  const accessToken = localStorage.getItem("access_token");
  if (!accessToken) throw new Error("IAM access token is unavailable");
  const res = await fetch(`/api/auth/tenants/${encodeURIComponent(tenantId)}/switch`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = await readTokenExchangeResponse(res);
  if (!res.ok) throw new Error(payload.message ?? "IAM tenant switch failed");
}

export async function getCurrentAuthUser(token?: string): Promise<AuthUserResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const accessToken = token ?? localStorage.getItem("access_token") ?? undefined;
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch("/api/auth/me", { headers });
  const payload = await readTokenExchangeResponse(res) as AuthUserResponse;
  if (!res.ok) return { data: null, message: payload.message ?? "Current user lookup failed" };
  return payload;
}
