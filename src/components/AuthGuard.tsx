import { useEffect, useState } from "react";
import { isIamAuthEnabled } from "@/lib/iam";
import { createT, readUiLocale } from "@/i18n";
import { applyAuthUser, hasKnowledgeFabricAccess } from "@/lib/auth-user";
import { getCurrentAuthUser } from "@/services/api/auth";
import { redirectToLogin } from "@/services/auth";
import { useUserStore } from "@/stores/useUserStore";

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const t = createT(readUiLocale());
  const hydrated = useUserStore((s) => s._hasHydrated);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);

  useEffect(() => {
    if (!accessDenied) return;
    const timer = window.setTimeout(() => {
      useUserStore.getState().logout();
      redirectToLogin();
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [accessDenied]);

  useEffect(() => {
    if (!isIamAuthEnabled()) {
      setChecked(true);
      return;
    }

    const onLogout = () => { useUserStore.getState().logout(); redirectToLogin(); };
    window.addEventListener("auth:logout", onLogout);
    if (!hydrated) return () => window.removeEventListener("auth:logout", onLogout);

    const token = localStorage.getItem("access_token") ?? useUserStore.getState().tokenobj?.accessToken;
    if (!token) {
      useUserStore.getState().logout();
      redirectToLogin();
      return () => window.removeEventListener("auth:logout", onLogout);
    }

    // Do not trust a persisted profile here. It can belong to the tenant that
    // was active before a token refresh following a tenant switch.
    let cancelled = false;
    const currentAccessToken = () =>
      localStorage.getItem("access_token") ?? useUserStore.getState().tokenobj?.accessToken;
    setChecked(false);
    setError(null);
    getCurrentAuthUser(token)
      .then((me) => {
        if (cancelled) return;
        if (!hasKnowledgeFabricAccess(me.data)) {
          setAccessDenied(true);
          return;
        }
        if (!applyAuthUser(me.data)) throw new Error(me.message ?? "IAM user profile is unavailable");
        if (currentAccessToken() !== token) return;
        setChecked(true);
      })
      .catch((err) => {
        if (cancelled || currentAccessToken() !== token) return;
        useUserStore.getState().logout();
        setError(err instanceof Error ? err.message : String(err));
        redirectToLogin();
      });

    return () => {
      cancelled = true;
      window.removeEventListener("auth:logout", onLogout);
    };
  }, [hydrated]);

  if (error) return <div className="placeholder-page"><h2>Authentication failed</h2><p>{error}</p></div>;
  if (accessDenied) return <div className="placeholder-page"><p>{t("auth.noApplicationAccess")}</p></div>;
  if (!checked) return <div className="placeholder-page"><p>Checking IAM session...</p></div>;
  return <>{children}</>;
}
