import { createElement, useEffect, useMemo, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { iamApplicationCode, isIamAuthEnabled } from "@/lib/iam";
import { createT, readUiLocale } from "@/i18n";
import { applyAuthUser, hasKnowledgeFabricAccess } from "@/lib/auth-user";
import { persistAuthToken } from "@/lib/auth-token";
import { exchangeCodeForToken, exchangeIamGrant, getCurrentAuthUser } from "@/services/api/auth";
import { useUserStore } from "@/stores/useUserStore";

function cleanReturnPath(value: string | null): string {
  if (!value) return "/";
  try {
    const url = new URL(value, window.location.origin);
    if (url.origin !== window.location.origin) return "/";
    url.searchParams.delete("code");
    url.searchParams.delete("state");
    return `${url.pathname}${url.search}${url.hash}` || "/";
  } catch {
    return value.startsWith("/") && !value.startsWith("//") ? value : "/";
  }
}

export function LoginPage() {
  const t = useMemo(() => createT(readUiLocale()), []);
  const location = useLocation();
  const navigate = useNavigate();
  const iamRef = useRef<HTMLElement | null>(null);
  const hydrated = useUserStore((s) => s._hasHydrated);
  const token = useUserStore((s) => s.tokenobj?.accessToken) ?? localStorage.getItem("access_token");
  const [status, setStatus] = useState("Loading IAM login...");
  const [error, setError] = useState<string | null>(null);
  const [donePath, setDonePath] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const params = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const next = cleanReturnPath(params.get("next") ?? params.get("state"));

  useEffect(() => {
    if (!isIamAuthEnabled()) {
      setDonePath("/");
      return;
    }
    if (!hydrated || accessDenied) return;

    const code = params.get("code");
    if (code) {
      setStatus("Completing IAM sign-in...");
      exchangeCodeForToken({ code, redirect_uri: `${window.location.origin}/login` })
        .then(async (res) => {
          const data = res.data;
          if (!data?.access_token) throw new Error(res.message ?? "IAM token exchange failed");
          persistAuthToken(data);
          const me = await getCurrentAuthUser(data.access_token);
          if (!hasKnowledgeFabricAccess(me.data)) {
            setStatus(t("auth.noApplicationAccess"));
            setAccessDenied(true);
            return;
          }
          if (!applyAuthUser(me.data)) throw new Error(me.message ?? "IAM user profile is unavailable");
          setDonePath(next);
        })
        .catch((err) => {
          useUserStore.getState().logout();
          setError(err instanceof Error ? err.message : String(err));
        });
      return;
    }

    if (token) {
      setStatus("Loading IAM profile...");
      getCurrentAuthUser(token)
        .then((me) => {
          if (!hasKnowledgeFabricAccess(me.data)) {
            setStatus(t("auth.noApplicationAccess"));
            setAccessDenied(true);
            return;
          }
          if (!applyAuthUser(me.data)) throw new Error(me.message ?? "IAM user profile is unavailable");
          setDonePath(next);
        })
        .catch((err) => {
          useUserStore.getState().logout();
          setError(err instanceof Error ? err.message : String(err));
        });
    }
  }, [accessDenied, hydrated, next, params, t, token]);

  useEffect(() => {
    if (!accessDenied) return;
    const timer = window.setTimeout(() => {
      useUserStore.getState().logout();
      setAccessDenied(false);
      setStatus("Loading IAM login...");
    }, 1_200);
    return () => window.clearTimeout(timer);
  }, [accessDenied]);

  useEffect(() => {
    if (!isIamAuthEnabled() || !hydrated || accessDenied || params.get("code") || token) return;
    const ssoUrl = import.meta.env.VITE_SSO_URL;
    if (!ssoUrl) {
      setError("VITE_SSO_URL is not configured");
      return;
    }

    const element = iamRef.current as (HTMLElement & { getOAuthToken?: (request: Record<string, string>) => Promise<unknown> }) | null;
    const script = document.createElement("script");

    const handleLoginSuccess = async (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const data = Array.isArray(detail) ? detail[0] : detail;
      try {
        persistAuthToken(data ?? {});
        const accessToken = data.access_token as string;
        const me = await getCurrentAuthUser(accessToken);
        if (!hasKnowledgeFabricAccess(me.data)) {
          setStatus(t("auth.noApplicationAccess"));
          setAccessDenied(true);
          return;
        }
        if (!applyAuthUser(me.data)) throw new Error(me.message ?? "IAM user profile is unavailable");
        navigate(next, { replace: true });
      } catch (err) {
        useUserStore.getState().logout();
        setError(err instanceof Error ? err.message : String(err));
      }
    };

    const handleLoginFailure = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      const data = Array.isArray(detail) ? detail[0] : detail;
      setError(data?.message ?? data?.error?.message ?? "IAM login failed");
    };

    script.src = `${ssoUrl.replace(/\/?$/, "/")}webcomponents/latest/iam-component.js`;
    script.async = true;
    script.onload = () => {
      if (!element) return;
      element.getOAuthToken = async (request) => {
        const grantType = request.grantType ?? request.grant_type;
        const body: Record<string, string> = { grant_type: grantType };
        if (request.username) body.username = request.username;
        if (request.password) body.password = request.password;
        if (request.userId) body.userId = request.userId;
        if (request.refresh_token) body.refresh_token = request.refresh_token;
        return exchangeIamGrant(body);
      };
      element.addEventListener("login-success", handleLoginSuccess);
      element.addEventListener("login-failure", handleLoginFailure);
      setStatus("Ready");
    };
    script.onerror = () => setError("Failed to load IAM login component");
    document.head.appendChild(script);

    return () => {
      element?.removeEventListener("login-success", handleLoginSuccess);
      element?.removeEventListener("login-failure", handleLoginFailure);
      if (document.head.contains(script)) document.head.removeChild(script);
    };
  }, [accessDenied, hydrated, navigate, next, params, t, token]);

  if (donePath) return <Navigate to={donePath} replace />;

  return (
    <div className="iam-login-shell">
      {createElement("iam-component", {
        ref: iamRef,
        source: iamApplicationCode,
        "iam-domain": import.meta.env.VITE_SSO_URL,
        "initial-component-type": "login",
      })}
      {status !== "Ready" && !error && <div className="iam-login-loading" role="status">{status}</div>}
      {error && (
        <div className="iam-login-notice" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label="Dismiss login error">&times;</button>
        </div>
      )}
    </div>
  );
}
