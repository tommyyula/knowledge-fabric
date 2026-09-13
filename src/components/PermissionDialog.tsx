import { useCallback, useEffect, useMemo, useState } from "react";
import { Lock, RefreshCw, Trash2, UserPlus, Users, X } from "lucide-react";
import type { KnowledgeBaseShareRole, OntologyProject } from "@/contracts/ontology";
import {
  findKnowledgeBaseShareRecipient,
  getKnowledgeBaseSharing,
  revokeKnowledgeBaseInvitation,
  revokeKnowledgeBaseShare,
  setKnowledgeBaseTenantShare,
  shareKnowledgeBase,
  type KnowledgeBaseSharingState,
} from "@/services/api/ontology";
import CustomSelect from "./CustomSelect";
import { useUserStore } from "@/stores/useUserStore";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PermissionDialogProps {
  project: OntologyProject;
  onClose: () => void;
  t: (key: string, params?: Record<string, string>) => string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const emptyState: KnowledgeBaseSharingState = { shares: [], invitations: [] };

// ─── Component ───────────────────────────────────────────────────────────────

export default function PermissionDialog({ project, onClose, t }: PermissionDialogProps) {
  const [state, setState] = useState(emptyState);
  const [loading, setLoading] = useState(true);
  const [identifier, setIdentifier] = useState("");
  const [role, setRole] = useState<KnowledgeBaseShareRole>("viewer");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const canManageManagers = project.capabilities?.manageManagers === true;

  const roles = useMemo(
    () =>
      (canManageManagers
        ? ["viewer", "editor", "manager"]
        : ["viewer", "editor"]) as KnowledgeBaseShareRole[],
    [canManageManagers],
  );

  const tenantShare = state.shares.find((s) => s.scope === "tenant");

  const userInfo = useUserStore((s) => s.userInfo);
  const currentTenantName = useMemo(() => {
    if (!userInfo) return undefined;
    const companyNames = new Map((userInfo.companies ?? []).map((c) => [c.companyCode, c.companyName]));
    return companyNames.get(userInfo.tenantId) ?? userInfo.tenantId;
  }, [userInfo]);

  // ── Data loading ──────────────────────────────────────────────────────────

  const reload = useCallback(
    async () => setState(await getKnowledgeBaseSharing(project.id)),
    [project.id],
  );

  useEffect(() => {
    setLoading(true);
    void reload()
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, [reload]);

  // ── Actions ───────────────────────────────────────────────────────────────

  const resolveRecipient = async () => {
    if (!identifier.trim()) return;
    setBusy(true);
    setError("");
    try {
      const result = await findKnowledgeBaseShareRecipient(project.id, identifier.trim());
      if (result.kind === "iam") {
        // IAM 用户找到，直接提交，无需二次确认
        await shareKnowledgeBase(project.id, {
          identifier: result.recipient.id,
          tenantId: result.recipient.tenantIds[0],
          role,
        });
        setIdentifier("");
        await reload();
      } else {
        await shareKnowledgeBase(project.id, { identifier: result.email, role });
        setIdentifier("");
        await reload();
      }
    } catch (reason) {
      let message = reason instanceof Error ? reason.message : String(reason);
      // 尝试解析 JSON 格式的错误消息
      try {
        const parsed = JSON.parse(message) as { error?: string };
        if (parsed.error) message = parsed.error;
      } catch {
        // 非 JSON，保持原始消息
      }
      if (message === "user_not_found") {
        setError(t("permission.members.userNotFound"));
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  const mutate = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await action();
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  // ── Role label helper ─────────────────────────────────────────────────────

  const roleLabel = (r: string) => {
    const map: Record<string, string> = {
      viewer: t("permission.role.viewer"),
      editor: t("permission.role.editor"),
      manager: t("permission.role.manager"),
      none: t("permission.tenantAccess.none"),
    };
    return map[r] ?? r;
  };

  const roleOptions = roles.map((r) => ({ value: r, label: roleLabel(r) }));

  const tenantOptions = [
    { value: "none", label: t("permission.tenantAccess.none") },
    { value: "viewer", label: roleLabel("viewer") },
    { value: "editor", label: roleLabel("editor") },
  ];

  // ── Render ────────────────────────────────────────────────────────────────

  const userShares = state.shares.filter((s) => s.scope === "user");

  return (
    <div className="perm-overlay" onMouseDown={onClose}>
      <section
        className="perm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="perm-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="perm-header">
          <div className="perm-header-copy">
            <p className="perm-eyebrow">
              {project.emoji} {project.name}
            </p>
            <h2 id="perm-dialog-title" className="perm-title">
              {t("permission.title")}
            </h2>
            <p className="perm-subtitle">{t("permission.subtitle")}</p>
          </div>
          <button
            className="perm-close-btn"
            onClick={onClose}
            aria-label={t("permission.close")}
            type="button"
          >
            <X size={18} />
          </button>
        </div>

        {/* ── Error banner ── */}
        {error && (
          <p className="perm-error" role="alert">
            {error}
          </p>
        )}

        {/* ── 初始加载骨架 ── */}
        {loading ? (
          <div className="perm-loading">
            <div className="perm-skeleton perm-skeleton-wide" />
            <div className="perm-skeleton perm-skeleton-medium" />
            <div className="perm-skeleton perm-skeleton-wide" />
            <div className="perm-skeleton perm-skeleton-short" />
          </div>
        ) : (
          <>
        <section className="perm-section">
          <div className="perm-section-title">
            <Lock size={16} />
            <span>{t("permission.accessScope.title")}</span>
          </div>

          <div className="perm-tenant-row">
            <div className="perm-tenant-copy">
              <p className="perm-tenant-label">
                {t("permission.accessScope.tenantLabel")}
                <span className="perm-app-tag">{currentTenantName ?? "Knowledge Fabric"}</span>
              </p>
              <p className="perm-tenant-desc">{t("permission.accessScope.tenantDesc")}</p>
            </div>
            <CustomSelect
              className="perm-role-select"
              value={tenantShare?.role ?? "none"}
              disabled={busy}
              options={tenantOptions}
              onChange={(value) =>
                void mutate(() =>
                  setKnowledgeBaseTenantShare(
                    project.id,
                    value === "none" ? null : (value as "viewer" | "editor"),
                  ),
                )
              }
            />
          </div>
        </section>

        {/* ── Designated Members section ── */}
        <section className="perm-section">
          <div className="perm-section-title">
            <Users size={16} />
            <span>{t("permission.members.title")}</span>
          </div>

          {/* Search + Add row */}
          <div className="perm-add-row">
            <div className="perm-search-wrap">
              <input
                className="perm-search-input"
                value={identifier}
                onChange={(e) => {
                  setIdentifier(e.target.value);
                }}
                placeholder={t("permission.members.searchPlaceholder")}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void resolveRecipient();
                }}
              />
              <CustomSelect
                className="perm-inline-role-select"
                value={role}
                options={roleOptions}
                onChange={(value) => setRole(value as KnowledgeBaseShareRole)}
              />
            </div>
            <button
              className="perm-add-btn"
              type="button"
              disabled={busy || !identifier.trim()}
              onClick={() => void resolveRecipient()}
            >
              {busy ? (
                <span className="perm-add-spinner" aria-hidden="true" />
              ) : (
                <UserPlus size={15} />
              )}
              {t("permission.members.addBtn")}
            </button>
          </div>


          {/* Member list */}
          <div className="perm-member-list">
            {userShares.map((share) => {
              const displayName = share.subjectUsername || share.subjectUserId || "?";
              const avatarLetter = displayName.slice(0, 1).toUpperCase();
              const grantedBy = share.createdByUsername || share.createdByUserId;
              const isManager = share.role === "manager";
              const canEdit = !(isManager && !canManageManagers);

              return (
                <div className="perm-member" key={share.id}>
                  <div className="perm-avatar">{avatarLetter}</div>
                  <div className="perm-member-info">
                    <div className="perm-member-name-row">
                      <span className="perm-member-name">{displayName}</span>
                      {share.subjectUseremail && (
                        <span className="perm-member-email">{share.subjectUseremail}</span>
                      )}
                      {(share.subjectCompanyname || share.subjectTenantId) && (
                        <span className="perm-tenant-tag">{share.subjectCompanyname || share.subjectTenantId}</span>
                      )}
                    </div>
                  </div>
                  {grantedBy && (
                    <span className="perm-granted-by">
                      {t("permission.members.grantedBy", { name: grantedBy })}
                    </span>
                  )}
                  <CustomSelect
                    className="perm-role-select"
                    value={share.role}
                    disabled={busy || !canEdit}
                    options={
                      isManager && !canManageManagers
                        ? [{ value: "manager", label: roleLabel("manager") }]
                        : roleOptions
                    }
                    onChange={(nextRole) =>
                      void mutate(() =>
                        shareKnowledgeBase(project.id, {
                          identifier: share.subjectUserId!,
                          tenantId: share.subjectTenantId,
                          role: nextRole as KnowledgeBaseShareRole,
                        }),
                      )
                    }
                  />
                  <button
                    className="perm-remove-btn"
                    type="button"
                    disabled={busy || !canEdit}
                    onClick={() => void mutate(() => revokeKnowledgeBaseShare(project.id, share.id))}
                    aria-label={t("permission.members.remove")}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}

            {/* Pending invitations */}
            {state.invitations.map((inv) => {
              const canEdit = !(inv.role === "manager" && !canManageManagers);
              return (
                <div className="perm-member" key={inv.id}>
                  <div className="perm-avatar perm-avatar-invite">@</div>
                  <div className="perm-member-info">
                    <div className="perm-member-name-row">
                      <span className="perm-member-name">{inv.email}</span>
                      <span className="perm-tenant-tag perm-tenant-tag-pending">
                        {t("permission.members.pending")}
                      </span>
                      <span className="perm-member-email">{inv.deliveryStatus}</span>
                    </div>
                  </div>
                  {/* 重新发送并轮换 token */}
                  <button
                    className="perm-remove-btn"
                    type="button"
                    title={t("permission.members.resend")}
                    disabled={busy || !canEdit}
                    onClick={() =>
                      void mutate(() =>
                        shareKnowledgeBase(project.id, {
                          identifier: inv.email,
                          role: inv.role,
                        }),
                      )
                    }
                  >
                    <RefreshCw size={15} />
                  </button>
                  {/* 撤销邀请 */}
                  <button
                    className="perm-remove-btn"
                    type="button"
                    disabled={busy || !canEdit}
                    onClick={() =>
                      void mutate(() => revokeKnowledgeBaseInvitation(project.id, inv.id))
                    }
                    aria-label={t("permission.members.revokeInvite")}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
        </>
        )}
      </section>
    </div>
  );
}
