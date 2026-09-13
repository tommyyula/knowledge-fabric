import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { acceptKnowledgeBaseInvitation } from "@/services/api/ontology";
import { useUserStore } from "@/stores/useUserStore";
import CustomSelect from "./CustomSelect";
import { switchIamTenant, refreshIamToken } from "@/services/api/auth";
import { ensureFreshAccessToken } from "@/lib/api-client";
import { persistAuthToken, refreshTokenFromStorage } from "@/lib/auth-token";
import { clearTenantScopedClientState } from "@/lib/tenant-switch";

export default function KnowledgeInviteAcceptPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const user = useUserStore((state) => state.userInfo);
  const tenants = user?.tenants ?? [];
  const [tenantId, setTenantId] = useState(user?.tenantId ?? tenants[0] ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const token = params.get("token") ?? "";
  const accept = async () => {
    setBusy(true); setError("");
    try {
      if (user && tenantId !== user.tenantId) {
        await ensureFreshAccessToken();
        await switchIamTenant(tenantId);
        persistAuthToken(await refreshIamToken(refreshTokenFromStorage()));
        useUserStore.getState().clearUserInfo();
        clearTenantScopedClientState();
        window.location.reload();
        return;
      }
      const result = await acceptKnowledgeBaseInvitation(token, tenantId);
      navigate(`/?ontologyId=${encodeURIComponent(result.project.id)}`);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };
  return <main className="knowledge-invite-page"><section className="modal-dialog"><h1>Accept Knowledge Base invitation</h1><p>Select the tenant identity that will receive this permission. If needed, the app will switch tenant and return to this invitation.</p>{error && <p role="alert" className="knowledge-sharing-error">{error}</p>}<label className="modal-label">Tenant identity</label><CustomSelect value={tenantId} options={tenants.map((value) => ({ value, label: value }))} onChange={setTenantId} /><div className="modal-actions"><button className="modal-btn modal-btn-primary" disabled={busy || !token || !tenantId} onClick={() => void accept()} type="button">Accept invitation</button></div></section></main>;
}
