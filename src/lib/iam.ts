export function isIamAuthEnabled(): boolean {
  return import.meta.env.VITE_IAM_ENABLED === "true";
}

export const devTenantId = import.meta.env.VITE_DEV_TENANT_ID ?? "dev-tenant";
export const iamApplicationCode = import.meta.env.VITE_IAM_APP_CODE?.trim() || "knowledge_fabric";
