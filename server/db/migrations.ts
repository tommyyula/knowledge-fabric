import { pool } from "./client";

let migrated = false;

interface Migration {
  id: string;
  sql: string;
}

const migrations: Migration[] = [
  {
    id: "0001_ontology_core",
    sql: `
      create table if not exists ontology_projects (
        id text primary key,
        tenant_id text not null,
        owner_id text not null,
        name text not null,
        description text not null default '',
        page_count integer not null default 1,
        status text not null default 'active',
        color text not null default '#8ab4f8',
        emoji text not null default '📚',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists ontology_projects_tenant_idx on ontology_projects (tenant_id, owner_id);

      create table if not exists ontology_sessions (
        id text primary key,
        ontology_id text not null references ontology_projects(id) on delete cascade,
        tenant_id text not null,
        owner_id text not null,
        preview text not null default 'New ontology session',
        claude_session_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );
      create index if not exists ontology_sessions_lookup_idx on ontology_sessions (tenant_id, ontology_id);

      create table if not exists ontology_messages (
        id text primary key,
        ontology_id text not null references ontology_projects(id) on delete cascade,
        session_id text not null references ontology_sessions(id) on delete cascade,
        tenant_id text not null,
        owner_id text not null,
        role text not null,
        content text not null,
        created_at timestamptz not null default now()
      );

      create table if not exists ontology_run_events (
        id text primary key,
        ontology_id text not null references ontology_projects(id) on delete cascade,
        session_id text references ontology_sessions(id) on delete cascade,
        tenant_id text not null,
        event jsonb not null,
        created_at timestamptz not null default now()
      );

      create table if not exists claude_session_store_entries (
        tenant_id text not null,
        ontology_id text not null,
        app_session_id text not null,
        sdk_session_id text not null,
        subkey text not null default '',
        value jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (tenant_id, ontology_id, app_session_id, sdk_session_id, subkey)
      );
    `,
  },
  {
    id: "0002_session_store_indexes",
    sql: `
      create index if not exists ontology_messages_session_created_idx on ontology_messages (tenant_id, owner_id, ontology_id, session_id, created_at);
      create index if not exists ontology_run_events_session_created_idx on ontology_run_events (tenant_id, ontology_id, session_id, created_at);
      create index if not exists claude_session_store_lookup_idx on claude_session_store_entries (tenant_id, ontology_id, app_session_id, sdk_session_id, updated_at desc);
    `,
  },
  {
    id: "0003_project_favorites",
    sql: `
      alter table ontology_projects add column if not exists favorite boolean not null default false;
      create index if not exists ontology_projects_favorite_idx on ontology_projects (tenant_id, owner_id, favorite, updated_at desc);
    `,
  },
  {
    id: "0003_composio_connections",
    sql: `
      create table if not exists ontology_composio_connections (
        id text primary key,
        tenant_id text not null,
        user_id text not null,
        app text not null,
        composio_connection_id text not null,
        composio_user_id text not null,
        display_name text not null,
        status text not null default 'pending',
        auth_config_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (tenant_id, user_id, composio_connection_id)
      );
      create index if not exists ontology_composio_connections_lookup_idx
        on ontology_composio_connections (tenant_id, user_id, status, app);
    `,
  },
  {
    id: "0004_ontology_message_parts",
    sql: `
      alter table ontology_messages add column if not exists parts jsonb;
    `,
  },
  {
    id: "0005_run_event_reconnect",
    sql: `
      alter table ontology_run_events add column if not exists run_id text;
      alter table ontology_run_events add column if not exists sequence integer;
      create index if not exists ontology_run_events_run_sequence_idx
        on ontology_run_events (tenant_id, ontology_id, session_id, run_id, sequence)
        where run_id is not null;
      create unique index if not exists ontology_run_events_run_sequence_unique_idx
        on ontology_run_events (tenant_id, ontology_id, session_id, run_id, sequence)
        where run_id is not null and sequence is not null;
    `,
  },
  {
    id: "0006_session_last_active_at",
    sql: `
      alter table ontology_sessions add column if not exists last_active_at timestamptz;
      update ontology_sessions
      set last_active_at = coalesce(
        last_active_at,
        (
          select max(m.created_at)
          from ontology_messages m
          where m.tenant_id = ontology_sessions.tenant_id
            and m.owner_id = ontology_sessions.owner_id
            and m.ontology_id = ontology_sessions.ontology_id
            and m.session_id = ontology_sessions.id
            and m.role = 'user'
        ),
        created_at,
        updated_at,
        now()
      )
      where last_active_at is null;
      alter table ontology_sessions alter column last_active_at set default now();
      alter table ontology_sessions alter column last_active_at set not null;
      create index if not exists ontology_sessions_last_active_idx
        on ontology_sessions (tenant_id, owner_id, ontology_id, last_active_at desc);
    `,
  },
  {
    id: "0007_query_readiness_projection",
    sql: `
      create table if not exists ontology_query_readiness (
        ontology_id text primary key references ontology_projects(id) on delete cascade,
        tenant_id text not null,
        owner_id text not null,
        flow text not null,
        phase text not null,
        query_ready boolean not null,
        projected_at timestamptz not null default now()
      );
      create index if not exists ontology_query_readiness_catalog_idx
        on ontology_query_readiness (tenant_id, owner_id, query_ready, projected_at desc, ontology_id desc);
    `,
  },
  {
    id: "0008_external_query_idempotency",
    sql: `
      create table if not exists external_query_idempotency (
        tenant_id text not null,
        owner_id text not null,
        ontology_id text not null references ontology_projects(id) on delete cascade,
        idempotency_key_hash text not null,
        request_fingerprint text not null,
        conversation_id text not null references ontology_sessions(id) on delete cascade,
        status text not null default 'in_progress',
        run_id text,
        answer text,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null,
        primary key (tenant_id, owner_id, ontology_id, idempotency_key_hash)
      );
      create index if not exists external_query_idempotency_expiry_idx
        on external_query_idempotency (expires_at);
    `,
  },
  {
    id: "0009_external_access_audit_events",
    sql: `
      create table if not exists external_access_audit_events (
        id text primary key,
        request_id text not null,
        protocol text not null,
        operation text not null,
        tenant_id text not null,
        owner_id text not null,
        ontology_id text,
        idempotency_key_hash text,
        outcome text not null,
        error_code text,
        status integer not null,
        duration_ms integer not null,
        created_at timestamptz not null default now(),
        expires_at timestamptz not null
      );
      create index if not exists external_access_audit_events_lookup_idx
        on external_access_audit_events (tenant_id, owner_id, operation, created_at desc);
      create index if not exists external_access_audit_events_expiry_idx
        on external_access_audit_events (expires_at);
    `,
  },
  {
    id: "0010_external_access_audit_expiry",
    sql: `
      alter table external_access_audit_events add column if not exists expires_at timestamptz;
      update external_access_audit_events
      set expires_at = created_at + interval '180 days'
      where expires_at is null;
      alter table external_access_audit_events alter column expires_at set not null;
      create index if not exists external_access_audit_events_expiry_idx
        on external_access_audit_events (expires_at);
    `,
  },
  {
    id: "0011_ontology_session_origin",
    sql: `
      alter table ontology_sessions
        add column if not exists origin text not null default 'workbench'
        check (origin in ('workbench', 'external'));
    `,
  },
  {
    id: "0012_ontology_a2a_tasks",
    sql: `
      create table if not exists ontology_a2a_tasks (
        task_id text primary key,
        tenant_id text not null,
        owner_id text not null,
        context_id text not null,
        knowledge_base_id text not null,
        message_id text not null,
        request_fingerprint text not null,
        status integer not null,
        task_json jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        expires_at timestamptz not null,
        unique (tenant_id, owner_id, message_id)
      );
      create unique index if not exists ontology_a2a_tasks_active_context_idx
        on ontology_a2a_tasks (tenant_id, owner_id, context_id)
        where status in (1, 2, 6, 8);
      create index if not exists ontology_a2a_tasks_scope_updated_idx
        on ontology_a2a_tasks (tenant_id, owner_id, updated_at desc, task_id desc);
      create index if not exists ontology_a2a_tasks_expiry_idx on ontology_a2a_tasks (expires_at);
    `,
  },
  {
    id: "0013_support_report_idempotency",
    sql: `
      create table if not exists support_report_idempotency (
        tenant_id text not null,
        owner_id text not null,
        report_request_id text not null,
        request_fingerprint text not null,
        status text not null check (status in ('in_progress', 'completed', 'failed', 'unknown')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        expires_at timestamptz not null,
        primary key (tenant_id, owner_id, report_request_id)
      );
      create index if not exists support_report_idempotency_expiry_idx
        on support_report_idempotency (expires_at);
    `,
  },
  {
    id: "0013_video_sop_jobs",
    sql: `
      create table if not exists video_sop_jobs (
        id text primary key,
        tenant_id text not null,
        owner_id text not null,
        status text not null,
        record jsonb not null,
        created_at timestamptz not null,
        updated_at timestamptz not null,
        expires_at timestamptz not null
      );
      create index if not exists video_sop_jobs_scope_updated_idx
        on video_sop_jobs (tenant_id, owner_id, updated_at desc);
      create index if not exists video_sop_jobs_status_idx
        on video_sop_jobs (status, updated_at);
      create index if not exists video_sop_jobs_expiry_idx
        on video_sop_jobs (expires_at);
    `,
  },
  {
    id: "0014_operation_runs",
    sql: `
      create table if not exists ontology_operation_runs (
        id text not null,
        tenant_id text not null,
        owner_id text not null,
        knowledge_base_id text not null,
        conversation_id text not null,
        agent_run_id text not null,
        user_request text not null,
        status text not null check (status in ('running', 'succeeded', 'failed', 'cancelled')),
        title text,
        result_summary text,
        report_path text,
        error text,
        started_at timestamptz not null,
        finished_at timestamptz,
        updated_at timestamptz not null,
        primary key (tenant_id, owner_id, knowledge_base_id, id),
        unique (tenant_id, owner_id, knowledge_base_id, conversation_id, agent_run_id)
      );
      create index if not exists ontology_operation_runs_history_idx
        on ontology_operation_runs (tenant_id, owner_id, knowledge_base_id, started_at desc, id desc);
      create index if not exists ontology_operation_runs_conversation_idx
        on ontology_operation_runs (tenant_id, owner_id, knowledge_base_id, conversation_id, started_at desc, id desc);

      create table if not exists ontology_operation_logs (
        tenant_id text not null,
        owner_id text not null,
        knowledge_base_id text not null,
        operation_id text not null,
        sequence integer not null check (sequence > 0),
        at timestamptz not null,
        summary text not null,
        path text,
        primary key (tenant_id, owner_id, knowledge_base_id, operation_id, sequence)
      );

      create table if not exists ontology_operation_artifacts (
        tenant_id text not null,
        owner_id text not null,
        knowledge_base_id text not null,
        operation_id text not null,
        path text not null,
        description text,
        created_at timestamptz not null default now(),
        primary key (tenant_id, owner_id, knowledge_base_id, operation_id, path)
      );
    `,
  },
  {
    id: "0015_operation_run_error_code",
    sql: `
      alter table ontology_operation_runs
        add column if not exists error_code text;
    `,
  },
  {
    id: "0016_operation_run_finish_time_check",
    sql: `
      alter table ontology_operation_runs
        add constraint ontology_operation_runs_finish_time_check
        check (
          (status = 'running' and finished_at is null)
          or (status in ('succeeded', 'failed', 'cancelled') and finished_at is not null)
        );
    `,
  },
  {
    id: "0017_operation_run_error_code_check",
    sql: `
      alter table ontology_operation_runs
        add constraint ontology_operation_runs_error_code_check
        check (error_code is null or error_code in (
          'agent_run_cancelled',
          'agent_run_failed',
          'operation_finish_missing'
        ));
    `,
  },
  {
    id: "0014_knowledge_base_sharing",
    sql: `
      alter table ontology_projects add column if not exists deleted_at timestamptz;
      alter table ontology_projects add column if not exists deleted_by_user_id text;

      create table if not exists ontology_shares (
        id text primary key,
        ontology_id text not null references ontology_projects(id) on delete cascade,
        scope text not null check (scope in ('user', 'tenant')),
        subject_user_id text,
        subject_tenant_id text not null,
        role text not null check (role in ('viewer', 'editor', 'manager')),
        created_by_user_id text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        check ((scope = 'user' and subject_user_id is not null) or (scope = 'tenant' and subject_user_id is null)),
        check (scope <> 'tenant' or role <> 'manager')
      );
      create unique index if not exists ontology_shares_user_unique_idx
        on ontology_shares (ontology_id, subject_user_id, subject_tenant_id)
        where scope = 'user';
      create unique index if not exists ontology_shares_tenant_unique_idx
        on ontology_shares (ontology_id, subject_tenant_id)
        where scope = 'tenant';
      create index if not exists ontology_shares_subject_idx
        on ontology_shares (subject_tenant_id, subject_user_id, ontology_id);

      create table if not exists ontology_pending_invitations (
        id text primary key,
        ontology_id text not null references ontology_projects(id) on delete cascade,
        email text not null,
        role text not null check (role in ('viewer', 'editor', 'manager')),
        token_hash text not null unique,
        created_by_user_id text not null,
        delivery_status text not null default 'pending' check (delivery_status in ('pending', 'sent', 'failed')),
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        unique (ontology_id, email)
      );

      create table if not exists ontology_change_records (
        id text primary key,
        ontology_id text not null references ontology_projects(id) on delete cascade,
        workspace_tenant_id text not null,
        workspace_owner_id text not null,
        actor_tenant_id text not null,
        actor_user_id text not null,
        actor_display_name text not null,
        protocol text not null,
        authorization_role text not null,
        authorization_source text not null,
        action text not null,
        outcome text not null,
        correlation_id text,
        details jsonb,
        created_at timestamptz not null default now()
      );
      create index if not exists ontology_change_records_lookup_idx
        on ontology_change_records (ontology_id, created_at desc, id desc);

      create table if not exists ontology_conversation_snapshots (
        id text primary key,
        token text not null unique,
        source_session_id text not null unique,
        source_ontology_id text not null,
        owner_tenant_id text not null,
        owner_user_id text not null,
        messages jsonb not null,
        created_at timestamptz not null default now()
      );

      create table if not exists ontology_tombstone_preferences (
        ontology_id text not null references ontology_projects(id) on delete cascade,
        tenant_id text not null,
        user_id text not null,
        placeholder_removed_at timestamptz,
        keep_conversations boolean not null default true,
        updated_at timestamptz not null default now(),
        primary key (ontology_id, tenant_id, user_id)
      );

      alter table external_access_audit_events add column if not exists workspace_tenant_id text;
      alter table external_access_audit_events add column if not exists workspace_owner_id text;
      alter table external_access_audit_events add column if not exists authorization_role text;
      alter table external_access_audit_events add column if not exists authorization_source text;
    `,
  },
  {
    id: "0015_conversation_snapshot_tombstones",
    sql: `
      alter table ontology_conversation_snapshots
        add column if not exists revoked_at timestamptz;
    `,
  },
  {
    id: "0016_ontology_shares_user_info",
    sql: `
      alter table ontology_shares add column if not exists subject_username text;
      alter table ontology_shares add column if not exists subject_useremail text;
      alter table ontology_shares add column if not exists created_by_username text;
    `,
  },
  {
    id: "0017_ontology_shares_external_user",
    sql: `
      -- 新增公司名展示字段
      alter table ontology_shares add column if not exists subject_companyname text;

      -- 放宽 user scope 对 subject_user_id 的非空约束，支持外部用户（userId 待补全）
      alter table ontology_shares drop constraint if exists ontology_shares_check;
      alter table ontology_shares drop constraint if exists ontology_shares_check1;

      -- 为外部用户（subject_user_id 为空）的 scope='user' 记录建立唯一索引（按邮箱）
      create unique index if not exists ontology_shares_external_user_unique_idx
        on ontology_shares (ontology_id, subject_useremail, subject_tenant_id)
        where scope = 'user' and subject_user_id is null and subject_useremail is not null;
    `,
  },
];

async function ensureMigrationLedger(): Promise<void> {
  if (!pool) return;
  await pool.query(`
    create table if not exists ontology_schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);
}

export async function ensureMigrations(): Promise<void> {
  if (migrated || !pool) {
    migrated = true;
    return;
  }

  await ensureMigrationLedger();
  for (const migration of migrations) {
    const existing = await pool.query<{ id: string }>("select id from ontology_schema_migrations where id=$1", [migration.id]);
    if (existing.rows.length > 0) continue;

    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(migration.sql);
      await client.query("insert into ontology_schema_migrations (id) values ($1)", [migration.id]);
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
  }
  migrated = true;
}
