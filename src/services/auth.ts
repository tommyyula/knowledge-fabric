import { isIamAuthEnabled } from "@/lib/iam";
import { useUserStore } from "@/stores/useUserStore";

export function redirectToLogin(next = window.location.href): void {
  if (!isIamAuthEnabled()) return;
  const url = new URL("/login", window.location.origin);
  url.searchParams.set("next", next);
  window.location.href = url.toString();
}

export function redirectToIamProvider(next = "/"): void {
  const ssoUrl = import.meta.env.VITE_SSO_URL;
  const clientId = import.meta.env.VITE_SSO_CLIENT_ID;
  if (!ssoUrl || !clientId) return;
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: `${window.location.origin}/login`,
    state: next,
  });
  window.location.href = `${ssoUrl.replace(/\/?$/, "/")}oauth2/authorize?${params}`;
}

export function redirectToLogout(): void {
  useUserStore.getState().logout();
  redirectToLogin("/");
}
