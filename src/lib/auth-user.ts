import { devTenantId, iamApplicationCode } from "@/lib/iam";
import { useUserStore } from "@/stores/useUserStore";

export interface AuthProfilePayload {
  user_id?: string;
  username?: string;
  name?: string;
  tenant_id?: string;
  tenants?: string[];
  companies?: Array<{
    companyCode: string;
    companyName: string;
  }>;
  granted_app_codes?: string[];
  is_admin?: boolean;
}

export function hasKnowledgeFabricAccess(data: AuthProfilePayload | null | undefined): boolean {
  return data?.granted_app_codes?.some(
    (code) => code.trim().toLowerCase() === iamApplicationCode.toLowerCase(),
  ) === true;
}

export function applyAuthUser(data: AuthProfilePayload | null | undefined): boolean {
  if (!data?.user_id) return false;
  const tenantId = data.tenant_id ?? data.tenants?.[0] ?? devTenantId;
  useUserStore.getState().setUserInfo({
    userId: data.user_id,
    userName: data.username ?? data.user_id,
    name: data.name ?? data.username ?? data.user_id,
    tenantId,
    tenants: data.tenants?.length ? data.tenants : [tenantId],
    companies: data.companies,
    isAdmin: data.is_admin === true,
  });
  return true;
}
