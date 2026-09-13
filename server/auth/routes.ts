import { Router } from "express";
import { z } from "zod";
import { env } from "../env";
import { asyncRoute } from "../http";
import { AuthError, clearIamUserCache, isAdminUserId, resolveIamUser, type IamUserInfo } from "./requireTenantContext";
import { fillMissingShareUserIds } from "../ontologies/repository";

interface TokenExchangeData {
  access_token: string;
  refresh_token?: string;
  exp?: number;
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

const codeExchangeSchema = z.object({
  code: z.string().min(1),
  redirect_uri: z.string().min(1),
  code_verifier: z.string().min(1).optional(),
});

const grantExchangeSchema = z.object({
  grant_type: z.string().min(1).optional(),
  grantType: z.string().min(1).optional(),
}).catchall(z.string()).refine((value) => Boolean(value.grant_type ?? value.grantType));

export const authRouter = Router();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numericClaim(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function tokenDataFrom(body: unknown): TokenExchangeData | null {
  const candidate = isRecord(body) && isRecord(body.data) ? body.data : body;
  if (!isRecord(candidate) || typeof candidate.access_token !== "string" || !candidate.access_token.trim()) return null;

  const expiresIn = numericClaim(candidate.expires_in);
  const exp = numericClaim(candidate.exp) ?? (expiresIn ? Math.floor(Date.now() / 1000) + expiresIn : undefined);
  const userId = typeof candidate.id === "string"
    ? candidate.id
    : typeof candidate.user_id === "string"
      ? candidate.user_id
      : undefined;
  const username = typeof candidate.userName === "string"
    ? candidate.userName
    : typeof candidate.username === "string"
      ? candidate.username
      : undefined;
  return {
    access_token: candidate.access_token,
    ...(typeof candidate.refresh_token === "string" && candidate.refresh_token ? { refresh_token: candidate.refresh_token } : {}),
    ...(exp ? { exp } : {}),
    ...(userId !== undefined ? { user_id: userId, is_admin: isAdminUserId(userId) } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(typeof candidate.name === "string" ? { name: candidate.name } : {}),
    ...(typeof candidate.tenant_id === "string" ? { tenant_id: candidate.tenant_id } : {}),
    ...(typeof candidate.tenantId === "string" ? { tenant_id: candidate.tenantId } : {}),
    ...(Array.isArray(candidate.tenants) ? { tenants: candidate.tenants.filter((item): item is string => typeof item === "string") } : {}),
    ...(typeof candidate.company_code === "string" ? { company_code: candidate.company_code } : {}),
    ...(typeof candidate.companyCode === "string" ? { company_code: candidate.companyCode } : {}),
    ...(Array.isArray(candidate.grantedAppCodes) ? { granted_app_codes: candidate.grantedAppCodes.filter((item): item is string => typeof item === "string") } : {}),
  };
}


function header(req: { header(name: string): string | undefined }, name: string): string | undefined {
  const value = req.header(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function currentUserDataFromIam(iam: IamUserInfo, requestedTenant?: string): Omit<TokenExchangeData, "access_token"> {
  const tenants = [iam.companyCode, iam.tenantId, iam.tenant_id, ...(iam.tenants ?? []), ...(iam.companyCodes ?? [])].filter((item): item is string => Boolean(item));
  const uniqueTenants = [...new Set(tenants)];
  const companies = (iam.companies ?? []).filter((company) =>
    typeof company.companyCode === "string" && typeof company.companyName === "string",
  );
  const tenantId = requestedTenant && uniqueTenants.includes(requestedTenant) ? requestedTenant : uniqueTenants[0] ?? requestedTenant ?? "";
  return {
    user_id: iam.id,
    username: iam.userName ?? iam.email,
    name: [iam.firstName, iam.lastName].filter(Boolean).join(" ") || iam.userName || iam.email,
    tenant_id: tenantId,
    tenants: uniqueTenants.length ? uniqueTenants : tenantId ? [tenantId] : [],
    company_code: iam.companyCode ?? tenantId,
    ...(companies.length ? { companies } : {}),
    ...(Array.isArray(iam.grantedAppCodes) ? { granted_app_codes: iam.grantedAppCodes } : {}),
    is_admin: isAdminUserId(iam.id),
  };
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function tokenErrorMessage(body: unknown, fallback: string): string {
  if (!isRecord(body)) return fallback;
  const errorDescription = body.error_description;
  if (typeof errorDescription === "string" && errorDescription.trim()) return errorDescription;
  const message = body.message;
  if (typeof message === "string" && message.trim()) return message;
  const msg = body.msg;
  if (typeof msg === "string" && msg.trim()) return msg;
  const error = body.error;
  if (typeof error === "string" && error.trim()) return error;
  return fallback;
}

authRouter.post("/exchange-token", asyncRoute(async (req, res) => {
  if (!env.iamEnabled) {
    res.json({
      data: {
        access_token: "dev-access-token",
        refresh_token: "dev-refresh-token",
        exp: Math.floor(Date.now() / 1000) + 60 * 60,
      },
    });
    return;
  }

  const clientId = process.env.IAM_CLIENT_ID ?? process.env.SSO_CLIENT_ID ?? process.env.VITE_SSO_CLIENT_ID;
  const clientSecret = process.env.IAM_CLIENT_SECRET ?? process.env.SSO_CLIENT_SECRET;
  if (!env.ssoUrl || !clientId || !clientSecret) {
    res.status(500).json({ data: null, message: "IAM token exchange requires SSO_URL, IAM_CLIENT_ID, and IAM_CLIENT_SECRET" });
    return;
  }

  let form: URLSearchParams;
  const grantParsed = grantExchangeSchema.safeParse(req.body ?? {});
  if (grantParsed.success) {
    const grantBody = { ...grantParsed.data };
    const grantType = grantBody.grant_type ?? grantBody.grantType;
    if (!grantType) {
      res.status(400).json({ data: null, message: "grant_type is required" });
      return;
    }
    delete grantBody.grantType;
    const normalizedGrantBody: Record<string, string> = {};
    for (const [key, value] of Object.entries(grantBody)) {
      if (typeof value === "string") normalizedGrantBody[key] = value;
    }
    normalizedGrantBody.grant_type = grantType;
    form = new URLSearchParams(normalizedGrantBody);
  } else {
    const parsed = codeExchangeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ data: null, message: "grant_type or code/redirect_uri is required" });
      return;
    }
    form = new URLSearchParams({
      grant_type: "authorization_code",
      code: parsed.data.code,
      redirect_uri: parsed.data.redirect_uri,
    });
    if (parsed.data.code_verifier) form.set("code_verifier", parsed.data.code_verifier);
  }
  const tokenUrl = process.env.SSO_TOKEN_URL ?? `${env.ssoUrl.replace(/\/?$/, "/")}oauth2/token`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const tokenResponse = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: form,
  });
  const tokenBody = await readJson(tokenResponse);

  if (!tokenResponse.ok) {
    res.status(tokenResponse.status).json({
      data: null,
      message: tokenErrorMessage(tokenBody, `Token exchange failed (SSO status ${tokenResponse.status})`),
      upstreamStatus: tokenResponse.status,
    });
    return;
  }

  const data = tokenDataFrom(tokenBody);
  if (!data) {
    res.status(502).json({ data: null, message: "Token exchange response did not include an access_token" });
    return;
  }

  res.json({ data });
}));

authRouter.put("/tenants/:tenantId/switch", asyncRoute(async (req, res) => {
  if (!env.iamEnabled) {
    res.json({ data: { tenant_id: req.params.tenantId } });
    return;
  }

  const tenantIdParam = req.params.tenantId;
  const tenantId = typeof tenantIdParam === "string" ? tenantIdParam.trim() : "";
  if (!tenantId) {
    res.status(400).json({ data: null, message: "tenantId is required" });
    return;
  }
  const auth = header(req, "authorization");
  if (!auth?.startsWith("Bearer ")) throw new AuthError(401, "Authentication required");
  const iam = await resolveIamUser(auth);
  if (!iam) throw new AuthError(401, "Invalid IAM token");
  const allowedTenants = new Set(
    [iam.companyCode, iam.tenantId, iam.tenant_id, ...(iam.tenants ?? []), ...(iam.companyCodes ?? [])]
      .filter((item): item is string => Boolean(item)),
  );
  if (allowedTenants.size > 0 && !allowedTenants.has(tenantId)) {
    throw new AuthError(403, "Tenant is not allowed for this user");
  }

  const switchResponse = await fetch(
    `${env.ssoUrl!.replace(/\/?$/, "/")}users/${encodeURIComponent(iam.id)}/tenants/${encodeURIComponent(tenantId)}/switch`,
    {
      method: "PUT",
      headers: { authorization: auth, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    },
  );
  const switchBody = await readJson(switchResponse);
  if (!switchResponse.ok) {
    res.status(switchResponse.status).json({
      data: null,
      message: tokenErrorMessage(switchBody, `IAM tenant switch failed (status ${switchResponse.status})`),
      upstreamStatus: switchResponse.status,
    });
    return;
  }

  clearIamUserCache(auth);
  res.json({ data: { tenant_id: tenantId } });
}));


authRouter.get("/me", asyncRoute(async (req, res) => {
  const requestedTenant = header(req, "TenantID") ?? header(req, "tenant-id") ?? header(req, "x-tenant-id");

  if (!env.iamEnabled) {
    const tenantId = requestedTenant ?? "dev-tenant";
    res.json({
      data: {
        user_id: header(req, "x-user-id") ?? "dev-user",
        username: header(req, "x-user-id") ?? "dev-user",
        name: "Development User",
        tenant_id: tenantId,
        tenants: [tenantId],
        company_code: tenantId,
        is_admin: isAdminUserId(header(req, "x-user-id") ?? "dev-user"),
      },
    });
    return;
  }

  const auth = header(req, "authorization");
  if (!auth?.startsWith("Bearer ")) throw new AuthError(401, "Authentication required");
  const iam = await resolveIamUser(auth);
  if (!iam) throw new AuthError(401, "Invalid IAM token");
  const data = currentUserDataFromIam(iam, requestedTenant);
  res.json({ data });

  // 异步补全：将登录用户 email 与已有的外部用户预授权记录关联
  if (iam.email && data.user_id) {
    fillMissingShareUserIds({
      userId: data.user_id,
      email: iam.email,
      tenantId: data.tenant_id ?? "",
      username: data.username,
    }).catch((err: unknown) => {
      console.warn("[auth] fillMissingShareUserIds failed", err);
    });
  }
}));
