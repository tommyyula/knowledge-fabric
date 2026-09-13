import { randomUUID } from "node:crypto";
import { query } from "../db/client";
import { getComposioAppMetadata } from "./apps";

export interface ComposioConnectionRecord {
  id: string;
  tenantId: string;
  userId: string;
  app: string;
  composioConnectionId: string;
  composioUserId: string;
  displayName: string;
  status: string;
  createdAt: Date;
}

function mapRow(row: any): ComposioConnectionRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    app: row.app,
    composioConnectionId: row.composio_connection_id,
    composioUserId: row.composio_user_id,
    displayName: row.display_name,
    status: row.status,
    createdAt: new Date(row.created_at),
  };
}

export async function saveComposioConnection(input: {
  tenantId: string;
  userId: string;
  app: string;
  composioConnectionId: string;
  authConfigId?: string;
  status?: "pending" | "active";
}): Promise<ComposioConnectionRecord> {
  const composioUserId = `${input.tenantId}__${input.userId}`;
  const displayName = getComposioAppMetadata(input.app)?.name ?? input.app;
  const id = `composio_${input.app}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const result = await query<any>(`
    insert into ontology_composio_connections
      (id, tenant_id, user_id, app, composio_connection_id, composio_user_id, display_name, status, auth_config_id)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    on conflict (tenant_id, user_id, composio_connection_id)
    do update set app=excluded.app, status=excluded.status, auth_config_id=excluded.auth_config_id, updated_at=now()
    returning *
  `, [id, input.tenantId, input.userId, input.app, input.composioConnectionId, composioUserId, displayName, input.status ?? "pending", input.authConfigId ?? null]);
  return mapRow(result.rows[0]);
}

export async function listComposioConnections(tenantId: string, userId: string): Promise<ComposioConnectionRecord[]> {
  const result = await query<any>(`
    select * from ontology_composio_connections
    where tenant_id=$1 and user_id=$2 and status='active'
    order by created_at desc
  `, [tenantId, userId]);
  return result.rows.map(mapRow);
}

export async function getConnectedApps(tenantId: string, userId: string): Promise<string[]> {
  const connections = await listComposioConnections(tenantId, userId);
  return [...new Set(connections.map((connection) => connection.app))];
}

export async function activateComposioConnection(composioConnectionId: string): Promise<void> {
  await query(`update ontology_composio_connections set status='active', updated_at=now() where composio_connection_id=$1`, [composioConnectionId]);
}

export async function disconnectComposioConnections(tenantId: string, userId: string, app: string): Promise<ComposioConnectionRecord[]> {
  const result = await query<any>(`
    update ontology_composio_connections
    set status='deleted', updated_at=now()
    where tenant_id=$1 and user_id=$2 and app=$3 and status='active'
    returning *
  `, [tenantId, userId, app]);
  return result.rows.map(mapRow);
}
