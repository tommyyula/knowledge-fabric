# Knowledge Fabric

Knowledge Fabric turns source material into reviewed knowledge bases. The Resource Library is the user-scoped source-material collection that can be referenced by those knowledge bases.

## Language

**Bitbucket Cloud Connection**:
A user's authorization to access Bitbucket Cloud repositories through Knowledge Fabric.
_Avoid_: Bitbucket integration, Bitbucket account

**Repository Operation**:
An action against a repository performed through a Bitbucket Cloud Connection, including both read and write actions.
_Avoid_: import-only operation, read-only sync

**Operation Run**:
The history of one user-requested business operation within a Knowledge Base conversation. It belongs to both the Knowledge Base and its Conversation, and is removed when either owner is removed.
_Avoid_: agent run, run replay, audit event

**Operation Artifact**:
A user-visible report or generated file produced by an Operation Run.
_Avoid_: progress log, source material

**Knowledge Base Conversation**:
A user-visible dialogue within one Knowledge Base that groups its messages, Agent Runs, and Operation Runs.
_Avoid_: Claude session, message thread

**Repository Reference**:
A Resource Library entry that identifies one Bitbucket Cloud repository and its user-selected default branch, backed by a Repository Cache for browsing and preview.
_Avoid_: repository file upload, repository snapshot resource

**Repository Cache**:
The user-scoped local Git working directory of a Repository Reference's selected default branch, maintained by the Resource Library for file browsing, preview, and size reporting.
_Avoid_: ontology checkout, shared clone

**Repository Checkout**:
The local Git working directory materialized from a Repository Reference inside one knowledge base workspace.
_Avoid_: Resource Library cache, automatic repository mirror

**Resource Library**:
A tenant- and user-scoped collection of source materials that may be referenced by a knowledge base.
_Avoid_: shared file store, upload area

**Video SOP Job**:
A tenant- and user-scoped, short-lived process that transforms an ordered set of Source Recordings into one SOP Resource.
_Avoid_: video upload, mock SOP task, persistent video resource

**Source Recording**:
An ordered MP4 input used only by a Video SOP Job; it is temporary processing material and never a Resource Library entry.
_Avoid_: video resource, uploaded SOP

**SOP Resource**:
A Markdown Resource Library entry produced by a successful Video SOP Job and retained independently of the job and its Source Recordings.
_Avoid_: job record, source video, mock SOP

**Knowledge Base Owner**:
The single user who owns a Knowledge Base and retains exclusive authority to grant or revoke Manager access, change its profile, and delete it.
_Avoid_: administrator, controller, shared owner

**Share Role**:
One of Viewer, Editor, or Manager, granted independently of Knowledge Base ownership to describe a member's capabilities within a shared Knowledge Base.
_Avoid_: ownership role, controller

**Viewer**:
A Share Role that may use a Knowledge Base and keep private Conversations, but may not contribute changes or manage access.
_Avoid_: reader, consumer, Can Use

**Editor**:
A Share Role that adds source contribution and Knowledge Base change workflows to Viewer access, but does not include profile or access management.
_Avoid_: contributor, Can Edit

**Manager**:
A Share Role that includes Editor capabilities and may manage Tenant Grants and lower Share Roles, but cannot manage other Managers or the Knowledge Base Owner.
_Avoid_: controller, Can Manage, administrator

**Member Grant**:
Access granted to one identified user acting through one identified tenant membership, which may belong to a tenant other than the Knowledge Base's tenant.
_Avoid_: email-only grant, account grant, individual share

**Tenant Grant**:
Viewer or Editor access granted to every authenticated member of the tenant that owns a Knowledge Base, including members who join while the grant remains active.
_Avoid_: public access, organization share

**Effective Share Role**:
The highest Share Role a user receives from all active Member Grants and Tenant Grants for one Knowledge Base.
_Avoid_: most recent role, preferred role

**Pending Invitation**:
An email-addressed, revocable offer of a Member Grant that does not expire and has not yet been bound to an authenticated user and an explicit tenant membership.
_Avoid_: public-tenant user, provisional account

**Knowledge Source**:
Source material associated with a Knowledge Base and available to its authorized users while the original Resource Library entry remains owned by its uploader. The uploader may not remove that entry while any active Knowledge Base association remains.
_Avoid_: shared Resource Library ownership, copied resource

**Read-only Conversation**:
A user's private Conversation retained after their Knowledge Base access ends, whose existing messages and user-owned attachments remain visible but cannot be used to access or change the Knowledge Base.
_Avoid_: active conversation, shared knowledge snapshot

**Conversation Snapshot**:
The single immutable, read-only publication of the user-visible messages captured when the owner of a private Conversation first shares it. It outlives its source Knowledge Base but not its source Conversation or owner account.
_Avoid_: shared conversation, live conversation, conversation copy

**Conversation Share Link**:
A permanent public bearer link that grants access only to one Conversation Snapshot and never grants access to its source Knowledge Base, resources, files, or later messages.
_Avoid_: conversation permission, knowledge share, member share

**External Access Principal**:
A bearer-authenticated caller whose tenant and user claims identify one Knowledge Fabric identity. It may discover and query owned or shared Knowledge Bases allowed by that identity's Effective Share Role.
_Avoid_: caller-supplied tenant, caller-supplied user

**Query-ready Knowledge Base**:
A knowledge base in the maintenance flow at the ready phase, whose approved knowledge may be queried externally.
_Avoid_: initialized workspace, in-progress knowledge base

**Query Readiness Projection**:
A searchable representation of whether a Knowledge Base is Query-ready. It accelerates discovery but does not replace the workspace journey state as the source of truth.
_Avoid_: authoritative readiness state

**External Conversation**:
An External Access Principal's ongoing dialogue with one Query-ready Knowledge Base. It is represented externally by a server-issued `conversationId`, also used as the A2A `contextId`, backed by the knowledge base's existing scoped session, and retained outside the default workbench session list for later dedicated presentation. Within a live remote MCP session, the most recent conversation for each Knowledge Base is retained so later queries continue it by default.
_Avoid_: caller-managed transcript, caller-generated A2A context, Claude session ID

**Run Replay**:
The ordered reconstruction of one chat run after a client reconnects. It preserves the run's visible content, event order, and terminal outcome, but not the model provider's original token boundaries.
_Avoid_: token-exact replay, model-stream replay

**External Query**:
One natural-language request to a Query-ready Knowledge Base, optionally continuing an External Conversation. It returns the answer and the conversation identifier needed to continue it.
_Avoid_: session/message API, raw agent run

**A2A Query Task**:
The externally trackable A2A unit for one External Query. It progresses through a task lifecycle and delivers the completed knowledge answer as an artifact; catalog discovery is not a task.
_Avoid_: direct answer message, knowledge-base agent

**Query Attachment**:
A file supplied with one A2A Query Task as temporary query input. It belongs only to that task and does not become Resource Library source material or approved Knowledge Base content.
_Avoid_: knowledge source, Resource Library upload, knowledge-base addition

**Queryable Knowledge Base Catalog**:
The authenticated caller's searchable, paginated collection of Query-ready Knowledge Bases. Every item is eligible for an External Query.
_Avoid_: workbench knowledge-base list, all knowledge bases

**External Access Audit Event**:
An immutable record that an External Access Principal invoked catalog discovery or an External Query, including its scope and outcome but not its credentials or conversation content.
_Avoid_: chat transcript, agent event log

**A2A Remote Agent**:
The single externally discoverable agent role of one Knowledge Fabric deployment. It accepts A2A requests from other agents and serves discovery and query capabilities across the caller's Queryable Knowledge Base Catalog without initiating requests to other A2A agents.
_Avoid_: A2A client, bidirectional agent integration, one agent per knowledge base

**Technical Issue Report**:
A user's one-way report of a problem encountered in a Knowledge Base conversation, delivered to the support team by email without a ticket number, lifecycle, or user-visible status tracking.
_Avoid_: technical ticket, support ticket, work order
