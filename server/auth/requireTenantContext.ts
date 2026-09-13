import type { Request } from "express";
import { randomUUID } from "node:crypto";
import { env } from "../env";

export interface IamCompany {
  companyCode: string;
  companyName: string;
}

export interface IamUserInfo {
  id: string;
  userName: string;
  firstName?: string;
  lastName?: string;
  email: string;
  companyCode?: string;
  tenantId?: string;
  tenant_id?: string;
  tenants?: string[];
  companyCodes?: string[];
  companies?: IamCompany[];
  grantedAppCodes?: string[];
}

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
  iam: IamUserInfo;
}

export interface TenantContext {
  user: CurrentUser;
  ownerId: string;
  tenantId: string;
}

export interface IamShareRecipient {
  id: string;
  userName: string;
  displayName: string;
  email: string;
  tenantIds: string[];
  companies: Array<{ companyCode: string; companyName: string }>;
}

export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const IAM_CACHE_TTL_MS = 10 * 60 * 1000;
const iamUserCache = new Map<string, { expiresAt: number; user: IamUserInfo }>();

export function clearIamUserCache(authorization?: string): void {
  if (authorization) {
    iamUserCache.delete(authorization);
    return;
  }
  iamUserCache.clear();
}

function header(req: Request, name: string): string | undefined {
  const value = req.header(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function shareRecipientFromIam(value: unknown): IamShareRecipient | null {
  if (!isRecord(value)) return null;
  const nested = isRecord(value.data) ? value.data : value;
  const id = typeof nested.id === "string" ? nested.id : typeof nested.userId === "string" ? nested.userId : "";
  const userName = typeof nested.userName === "string" ? nested.userName : typeof nested.user_name === "string" ? nested.user_name : "";
  if (!id || !userName) return null;
  const companyCodes = Array.isArray(nested.companyCodes) ? nested.companyCodes : Array.isArray(nested.tenants) ? nested.tenants : [];
  const tenantIds = [...new Set([
    typeof nested.companyCode === "string" ? nested.companyCode : undefined,
    typeof nested.tenantId === "string" ? nested.tenantId : undefined,
    typeof nested.tenant_id === "string" ? nested.tenant_id : undefined,
    ...companyCodes,
  ].filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
  if (!tenantIds.length) return null;
  const firstName = typeof nested.firstName === "string" ? nested.firstName.trim() : "";
  const lastName = typeof nested.lastName === "string" ? nested.lastName.trim() : "";
  const companies = Array.isArray(nested.companies)
    ? (nested.companies as unknown[]).filter(
        (c): c is { companyCode: string; companyName: string } =>
          isRecord(c) && typeof c.companyCode === "string" && typeof c.companyName === "string",
      )
    : [];
  return {
    id,
    userName,
    displayName: [firstName, lastName].filter(Boolean).join(" ") || userName,
    email: typeof nested.email === "string" ? nested.email : "",
    tenantIds,
    companies,
  };
}

export async function lookupIamShareRecipient(authorization: string, identifier: string): Promise<IamShareRecipient> {
  if (!env.ssoUrl) throw Object.assign(new Error("SSO_URL is required to look up Knowledge Base recipients"), { status: 500 });
  const normalizedIdentifier = identifier.trim();
  if (!normalizedIdentifier) throw Object.assign(new Error("Recipient identifier is required"), { status: 400 });
  const url = new URL("platform/v1/users/full-info", env.ssoUrl.replace(/\/?$/, "/"));
  url.searchParams.set("identifier", normalizedIdentifier);
  const response = await fetch(url, {
    headers: { authorization, accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) throw Object.assign(new Error("IAM recipient was not found"), { status: 404 });
  if (!response.ok) throw Object.assign(new Error(`IAM recipient lookup failed (status ${response.status})`), { status: 502 });
  const body = await response.json() as { success?: boolean; data?: unknown };
  const recipient = body.success ? shareRecipientFromIam(body.data) : null;
  // IAM 返回 success=false 或数据解析失败，均视为未找到
  if (!recipient) throw Object.assign(new Error("IAM recipient was not found"), { status: 404 });
  return recipient;
}

// 按 userId 查询用户展示信息（用于 Resource Library 上传者显示），带短期内存缓存
const IAM_USER_DISPLAY_CACHE_TTL_MS = 5 * 60 * 1000;
const iamUserDisplayCache = new Map<string, { expiresAt: number; userName: string; companyName: string }>();

export async function lookupIamUserDisplay(
  authorization: string,
  userId: string,
  tenantId: string,
): Promise<{ userName: string; companyName: string }> {
  const cacheKey = `${userId}::${tenantId}`;
  const cached = iamUserDisplayCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { userName: cached.userName, companyName: cached.companyName };
  }

  if (!env.ssoUrl) return { userName: userId, companyName: tenantId };

  try {
    const url = new URL("platform/v1/users/full-info", env.ssoUrl.replace(/\/?$/, "/"));
    url.searchParams.set("identifier", userId);
    const response = await fetch(url, {
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return { userName: userId, companyName: tenantId };
    const body = await response.json() as { success?: boolean; data?: unknown };
    const recipient = body.success ? shareRecipientFromIam(body.data) : null;
    if (!recipient) return { userName: userId, companyName: tenantId };

    // 取 companyName：从 tenantIds 中匹配当前 tenantId 对应的公司名
    // full-info 接口返回的 data 里可能包含 companies 数组
    let companyName = tenantId;
    const raw = body.data;
    if (isRecord(raw)) {
      const nested = isRecord(raw.data) ? raw.data : raw;
      const companies = Array.isArray(nested.companies) ? nested.companies : [];
      const matched = companies.find(
        (c): c is { companyCode: string; companyName: string } =>
          isRecord(c) && c.companyCode === tenantId && typeof c.companyName === "string",
      );
      if (matched) companyName = matched.companyName;
    }

    const result = { userName: recipient.userName, companyName };
    iamUserDisplayCache.set(cacheKey, { expiresAt: Date.now() + IAM_USER_DISPLAY_CACHE_TTL_MS, ...result });
    return result;
  } catch {
    return { userName: userId, companyName: tenantId };
  }
}

function decodeJwtUser(authorization: string): IamUserInfo | null {
  const token = authorization.replace(/^Bearer\s+/i, "").trim();
  const [, payload] = token.split(".");
  if (!payload) return null;
  try {
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const claims = JSON.parse(json) as {
      sub?: string;
      email?: string;
      data?: {
        user_id?: string;
        user_name?: string;
        tenant_id?: string;
        tenants?: string[];
        company_code?: string;
        granted_app_codes?: string[];
      };
    };
    const data = claims.data ?? {};
    const id = data.user_id ?? claims.sub;
    if (!id) return null;
    return {
      id,
      userName: data.user_name ?? claims.email ?? id,
      email: claims.email ?? `${data.user_name ?? id}@iam.local`,
      companyCode: data.company_code ?? data.tenant_id,
      tenantId: data.tenant_id,
      tenant_id: data.tenant_id,
      tenants: data.tenants,
      companyCodes: data.company_code ? [data.company_code] : undefined,
      grantedAppCodes: data.granted_app_codes,
    };
  } catch {
    return null;
  }
}

async function tenantCodesFromIam(authorization: string, userId: string): Promise<string[] | null> {
  const response = await fetch(
    `${env.ssoUrl!.replace(/\/?$/, "/")}users/${encodeURIComponent(userId)}/tenants`,
    {
      headers: { authorization, accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!response.ok) return null;
  const body = await response.json() as { success?: boolean; data?: unknown };
  if (!body.success || !Array.isArray(body.data)) return null;
  return [...new Set(body.data.filter((item): item is string => typeof item === "string" && item.trim().length > 0))];
}

async function companiesFromIam(authorization: string, tenantCodes: string[]): Promise<IamCompany[] | null> {
  const response = await fetch(`${env.ssoUrl!.replace(/\/?$/, "/")}company/list-by-codes`, {
    method: "POST",
    headers: {
      authorization,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ codes: tenantCodes }),
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) return null;
  const body = await response.json() as { success?: boolean; data?: unknown };
  if (!body.success || !Array.isArray(body.data)) return null;
  return body.data.flatMap((item): IamCompany[] => {
    if (!isRecord(item) || typeof item.code !== "string" || typeof item.name !== "string") return [];
    return [{ companyCode: item.code, companyName: item.name }];
  });
}

async function enrichIamUserWithTenants(authorization: string, user: IamUserInfo): Promise<IamUserInfo> {
  try {
    const tenantCodes = await tenantCodesFromIam(authorization, user.id);
    if (!tenantCodes) return user;
    const companies = await companiesFromIam(authorization, tenantCodes);
    return {
      ...user,
      tenants: tenantCodes,
      companyCodes: tenantCodes,
      ...(companies ? { companies } : {}),
    };
  } catch (error) {
    console.warn("[auth] IAM tenant lookup failed, using user-info tenant data", error);
    return user;
  }
}

export async function resolveIamUser(authorization: string): Promise<IamUserInfo | null> {
  if (!env.ssoUrl) throw new AuthError(500, "SSO_URL is required when IAM is enabled");
  const cached = iamUserCache.get(authorization);
  if (cached && cached.expiresAt > Date.now()) return cached.user;

  const fallbackUser = decodeJwtUser(authorization);
  const res = await fetch(`${env.ssoUrl.replace(/\/?$/, "/")}user-info`, {
    headers: { authorization, accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return fallbackUser;
  const body = await res.json() as { success?: boolean; data?: unknown };
  if (!body?.success || !body.data) return fallbackUser;
  const data = body.data as { success?: boolean; data?: IamUserInfo } & IamUserInfo;
  const user = data.success === true && data.data ? data.data : data;
  const enrichedUser = await enrichIamUserWithTenants(authorization, user);
  iamUserCache.set(authorization, { expiresAt: Date.now() + IAM_CACHE_TTL_MS, user: enrichedUser });
  return enrichedUser;
}

export async function requireTenantContext(req: Request): Promise<TenantContext> {
  const auth = header(req, "authorization");
  const tenantId = header(req, "TenantID") ?? header(req, "tenant-id") ?? header(req, "x-tenant-id");

  if (env.iamEnabled) {
    if (!auth?.startsWith("Bearer ")) throw new AuthError(401, "Authentication required");
    if (!tenantId) throw new AuthError(403, "TenantID header required");
    const iam = await resolveIamUser(auth).catch((err) => {
      console.warn("[auth] IAM user-info lookup failed, using JWT claims fallback", err);
      return decodeJwtUser(auth);
    });
    if (!iam) throw new AuthError(401, "Invalid IAM token");
    const allowedTenants = new Set([iam.companyCode, iam.tenantId, iam.tenant_id, ...(iam.tenants ?? []), ...(iam.companyCodes ?? [])].filter(Boolean));
    if (allowedTenants.size > 0 && !allowedTenants.has(tenantId)) throw new AuthError(403, "Tenant is not allowed for this user");
    const userId = iam.id;
    const email = iam.email;
    return {
      user: { id: userId, email, displayName: iam.userName ?? email, iam },
      ownerId: userId,
      tenantId,
    };
  }

  const devUserId = header(req, "x-user-id") ?? "dev-user";
  const devTenantId = tenantId ?? "dev-tenant";
  return {
    user: {
      id: devUserId,
      email: `${devUserId}@local.dev`,
      displayName: "Development User",
      iam: { id: devUserId, userName: devUserId, email: `${devUserId}@local.dev`, companyCode: devTenantId },
    },
    ownerId: devUserId,
    tenantId: devTenantId,
  };
}

/**
 * Resolves the public integration scope after the deployment gateway has
 * already authenticated the bearer token. Unlike workbench routes, callers
 * cannot choose a tenant header for this boundary.
 */
export async function requireGatewayTenantContext(req: Request): Promise<TenantContext> {
  if (!env.iamEnabled) return requireTenantContext(req);

  const auth = header(req, "authorization");
  if (!auth?.startsWith("Bearer ")) throw new AuthError(401, "Authentication required");
  const iam = decodeJwtUser(auth);
  if (!iam?.id || !iam.tenantId) throw new AuthError(401, "A gateway-authenticated tenant and user are required");
  return {
    user: {
      id: iam.id,
      email: iam.email,
      displayName: iam.userName ?? iam.email,
      iam,
    },
    ownerId: iam.id,
    tenantId: iam.tenantId,
  };
}

export function isAdminUserId(userId: string): boolean {
  return env.adminUserIds.has(userId);
}

export async function requireAdminContext(req: Request): Promise<TenantContext> {
  const ctx = await requireTenantContext(req);
  if (!isAdminUserId(ctx.user.id)) throw new AuthError(403, "Admin access required");
  return ctx;
}

export function requestId(): string {
  return randomUUID();
}
