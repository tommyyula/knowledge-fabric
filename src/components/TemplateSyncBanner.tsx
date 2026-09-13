import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApplyTemplateSync, useTemplateSyncStatus } from "@/hooks/useOntologies";

interface TemplateSyncBannerProps {
  ontologyId?: string;
  t?: (key: string, params?: Record<string, string>) => string;
}

/**
 * Shown only when the bundled knowledge-base template has a new version relative
 * to what this workspace last synced. Applying is user-initiated — nothing syncs
 * until the button is clicked (the server never auto-applies version updates).
 */
export function TemplateSyncBanner({ ontologyId, t }: TemplateSyncBannerProps) {
  const translate = t ?? ((key: string) => key);
  const { data } = useTemplateSyncStatus(ontologyId);
  const apply = useApplyTemplateSync();
  if (!ontologyId || !data?.updateAvailable) return null;
  return (
    <div className="template-sync-banner" role="status">
      <span className="template-sync-banner__text">{translate("templateSync.updateAvailable")}</span>
      <Button
        size="sm"
        variant="outline"
        className="template-sync-banner__button"
        disabled={apply.isPending}
        onClick={() => apply.mutate(ontologyId)}
      >
        <RefreshCw className={apply.isPending ? "template-sync-spin" : undefined} />
        {apply.isPending ? translate("templateSync.syncing") : translate("templateSync.action")}
      </Button>
    </div>
  );
}

export default TemplateSyncBanner;
