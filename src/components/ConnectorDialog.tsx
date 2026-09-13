import { type FC, useEffect, useMemo, useState } from "react";
import { CheckIcon, Loader2Icon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { connectComposioApp, disconnectComposioApp, listComposioApps, type ComposioApp } from "@/services/api/composio";
import { cn } from "@/lib/utils";

interface ConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  t?: (key: string, params?: Record<string, string>) => string;
}

const APP_LOGO_MAP: Record<string, string> = {
  github: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/github.svg",
  gmail: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/gmail.svg",
  outlook: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/microsoftoutlook.svg",
  slack: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/slack.svg",
  jira: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/jira.svg",
  notion: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/notion.svg",
  "google-calendar": "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/googlecalendar.svg",
  "google-drive": "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/googledrive.svg",
  "google-sheets": "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/googlesheets.svg",
  "google-docs": "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/googledocs.svg",
  linear: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/linear.svg",
  confluence: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/confluence.svg",
  trello: "https://cdn.jsdelivr.net/gh/simple-icons/simple-icons/icons/trello.svg",
};

export const ConnectorDialog: FC<ConnectorDialogProps> = ({ open, onOpenChange, t = (key) => key }) => {
  const [apps, setApps] = useState<ComposioApp[]>([]);
  const [loading, setLoading] = useState(false);
  const [processingApp, setProcessingApp] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [callbackUrl, setCallbackUrl] = useState<string | null>(null);

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setApps(await listComposioApps());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setQuery("");
      void refresh();
    }
  }, [open]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.data?.type !== "composio-oauth-callback") return;
      setProcessingApp(null);
      setCallbackUrl(null);
      if (!event.data.success) setError(event.data.error || "Connection failed");
      void refresh();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    if (!processingApp) return;
    const timer = window.setInterval(async () => {
      try {
        const nextApps = await listComposioApps();
        setApps(nextApps);
        if (nextApps.some((app) => app.app === processingApp && app.connected)) {
          setProcessingApp(null);
          setCallbackUrl(null);
        }
      } catch {
        // Keep the OAuth window as the primary signal; polling is only a fallback.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [processingApp]);

  const filteredApps = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return apps;
    return apps.filter((app) => app.name.toLowerCase().includes(needle) || app.description.toLowerCase().includes(needle));
  }, [apps, query]);

  const connect = async (app: string) => {
    setProcessingApp(app);
    setError(null);
    try {
      const { redirectUrl, callbackUrl } = await connectComposioApp(app);
      setCallbackUrl(callbackUrl);
      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;
      const popup = window.open(redirectUrl, `composio-oauth-${app}`, `width=${width},height=${height},left=${left},top=${top},scrollbars=yes`);
      if (!popup) throw new Error(t("connector.popupBlocked"));
    } catch (err) {
      setProcessingApp(null);
      setCallbackUrl(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const disconnect = async (app: string) => {
    setProcessingApp(app);
    setError(null);
    try {
      await disconnectComposioApp(app);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProcessingApp(null);
    }
  };

  if (!open) return null;

  return (
    <div className="connector-sheet-backdrop" onMouseDown={() => onOpenChange(false)}>
      <section className="connector-sheet" role="dialog" aria-modal="true" aria-labelledby="connector-sheet-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="connector-sheet-header">
          <div>
            <h2 id="connector-sheet-title" className="connector-sheet-title">{t("connector.title")}</h2>
            <p className="connector-sheet-subtitle">{t("connector.subtitle")}</p>
          </div>
          <button className="connector-sheet-close" onClick={() => onOpenChange(false)} aria-label={t("connector.title")}>
            <XIcon className="size-4" />
          </button>
        </header>

        <div className="connector-sheet-toolbar">
          <SearchIcon className="size-4" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("connector.search")} aria-label={t("connector.search")} />
          {query ? <button type="button" onClick={() => setQuery("")} aria-label="Clear search"><XIcon className="size-3" /></button> : null}
        </div>

        {error ? <div className="connector-sheet-error">{error}</div> : null}
        {processingApp && callbackUrl ? <div className="connector-sheet-hint">{t("connector.waitingAuth")} {callbackUrl}</div> : null}

        <div className="connector-sheet-body">
          {loading ? (
            <div className="connector-sheet-state"><Loader2Icon className="size-5 animate-spin" />{t("connector.loading")}</div>
          ) : filteredApps.length === 0 ? (
            <div className="connector-sheet-state">{query ? t("connector.noMatch") : t("connector.noAvailable")}</div>
          ) : (
            <div className="connector-app-grid">
              {filteredApps.map((app) => {
                const processing = processingApp === app.app;
                const logo = APP_LOGO_MAP[app.app] ?? app.logo;
                return (
                  <article key={app.app} className="connector-app-card">
                    <div className="connector-app-logo"><img src={logo} alt="" /></div>
                    <div className="connector-app-copy">
                      <div className="connector-app-name">{app.name}</div>
                      <p className="connector-app-desc">{app.description}</p>
                    </div>
                    {processing ? (
                      <div className="connector-app-action" aria-label="Connecting"><Loader2Icon className="size-4 animate-spin" /></div>
                    ) : app.connected ? (
                      <button className={cn("connector-app-action", "connected")} onClick={() => void disconnect(app.app)} title={t("connector.disconnect")}>
                        <CheckIcon className="size-4 connector-check" />
                        <XIcon className="size-4 connector-remove" />
                      </button>
                    ) : (
                      <button className="connector-app-action" onClick={() => void connect(app.app)} title={t("connector.connect")}>
                        <PlusIcon className="size-4" />
                      </button>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
};
